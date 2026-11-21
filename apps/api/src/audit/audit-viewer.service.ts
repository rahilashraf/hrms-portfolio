import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { permissionIsGranted } from '../authorization/authorization.policy.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import { PrismaService } from '../database/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import {
  auditLimit,
  decodeAuditCursor,
  encodeAuditCursor,
  projectAuditMetadata,
  resolveAuditRange,
} from './audit-viewer-domain.js';

export const AUDIT_READ = 'audit.read';

export interface AuditQuery {
  scope?: 'organization' | 'system';
  organizationId?: string;
  from?: string;
  to?: string;
  action?: string;
  entityType?: string;
  entityId?: string;
  actorUserId?: string;
  limit?: number;
  cursor?: string;
}

export interface AuditActorQuery {
  scope?: 'organization' | 'system';
  organizationId?: string;
  from?: string;
  to?: string;
  query?: string;
  limit?: number;
  afterId?: string;
}

const UUID_TEXT =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Batch R4-A.7: the actor list's sort key — the displayed name (as `personDisplayName` builds it),
 * case-insensitive; NULL for a person with no name. Pages are ordered by (no name last, key, id),
 * so equal names are still in a stable order.
 */
function actorSortKey(person: string) {
  const col = (name: string) => Prisma.raw(`${person}."${name}"`);
  return Prisma.sql`lower(nullif(btrim(concat_ws(' ',
    coalesce(nullif(${col('preferredName')}, ''), nullif(${col('firstName')}, '')),
    nullif(${col('lastName')}, ''))), ''))`;
}

/** "Ada Lovelace" from a person (preferred name first); null when the person has no name. */
function personDisplayName(
  person: {
    firstName: string | null;
    lastName: string | null;
    preferredName: string | null;
  } | null,
): string | null {
  if (!person) return null;
  const name = [person.preferredName || person.firstName, person.lastName]
    .filter(Boolean)
    .join(' ')
    .trim();
  return name || null;
}

interface AuditRow {
  id: string;
  occurredAt: Date;
  action: string;
  entityType: string | null;
  entityId: string | null;
  actorUserId: string | null;
  correlationId: string | null;
  metadata: unknown;
}

/**
 * Phase 19 — read-only audit viewer. `audit.read` (organization scope) shows the audit trail
 * of entries tagged with that organization (`metadata.organizationId`), newest first, as a
 * safe projection: identifiers, the action, the actor, the request id and a whitelisted,
 * value-checked subset of the metadata. It never returns IP addresses, user agents, emails or
 * arbitrary metadata, and grants no domain data.
 *
 * Viewing is not audited per row (it would flood the log it reads); an export would be.
 */
@Injectable()
export class AuditViewerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService,
  ) {}

  /** 403 without audit.read on the organization; 404 for an unknown one (SYSTEM readers). */
  async requireRead(userId: string, organizationId: string) {
    const grants = (
      await this.authorization.effectiveGrants(userId, new Date(), this.prisma)
    ).filter((grant) => grant.permission === AUDIT_READ);
    if (
      !permissionIsGranted(grants, AUDIT_READ, {
        type: 'ORGANIZATION',
        organizationId,
      })
    )
      throw new ForbiddenException(
        `Missing permission ${AUDIT_READ} for the organization.`,
      );
    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { id: true },
    });
    if (!organization) throw new NotFoundException('Organization not found.');
  }

  /** 403 without audit.read at System scope (organization-scoped readers included). */
  async requireSystemRead(userId: string) {
    const grants = await this.authorization.effectiveGrants(
      userId,
      new Date(),
      this.prisma,
    );
    if (
      !grants.some(
        (grant) =>
          grant.permission === AUDIT_READ && grant.scope.type === 'SYSTEM',
      )
    )
      throw new ForbiddenException(
        `Missing permission ${AUDIT_READ} at System scope.`,
      );
  }

  /** The same authorization as the list: System view or audit.read on the organization. */
  private async requireListRead(
    userId: string,
    query: { scope?: 'organization' | 'system'; organizationId?: string },
  ) {
    const system = query.scope === 'system';
    if (system) await this.requireSystemRead(userId);
    else if (!query.organizationId)
      throw new BadRequestException('organizationId is required.');
    else await this.requireRead(userId, query.organizationId);
    return system;
  }

  /** The entries a view covers: no organization (System view), or one organization's. */
  private scopeFilter(
    system: boolean,
    organizationId: string | undefined,
    alias = '',
  ) {
    const column = (name: string) =>
      Prisma.raw(`${alias ? `${alias}.` : ''}"${name}"`);
    return system
      ? // Batch 2: entries tied to no organization (NULL metadata included).
        Prisma.sql`(${column('metadata')} IS NULL OR NOT (${column('metadata')} ? 'organizationId'))`
      : // Matches AuditLog_metadata_organizationId_occurredAt_idx (partial expression index).
        Prisma.sql`${column('metadata')} ? 'organizationId' AND (${column('metadata')}->>'organizationId') = ${organizationId!}`;
  }

  /**
   * Batch R3.3 — the actor filter's lookup. Only users who are the actor of at least one entry
   * the caller may read (same authorization, scope and date window as the list) are returned,
   * so it reveals no one outside that audit trail; archived and former users are included
   * because their entries remain. Names only (never emails), like the list. Search by name, or
   * by exact user id; paged by user id.
   */
  async actors(userId: string, query: AuditActorQuery, now = new Date()) {
    const system = await this.requireListRead(userId, query);
    const { from, to } = resolveAuditRange(query, now);
    const limit = Math.max(
      1,
      Math.min(50, Math.trunc(query.limit ?? 20) || 20),
    );
    const term = (query.query ?? '').trim();
    const filters: Prisma.Sql[] = [
      Prisma.sql`EXISTS (
        SELECT 1 FROM "AuditLog" a
        WHERE a."actorUserId" = u."id"
          AND ${this.scopeFilter(system, query.organizationId, 'a')}
          AND a."occurredAt" >= ${from}
          AND a."occurredAt" < ${to}
      )`,
    ];
    if (term && UUID_TEXT.test(term)) {
      filters.push(Prisma.sql`u."id" = ${term}::uuid`);
    } else if (term) {
      const like = `%${term.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
      filters.push(Prisma.sql`(
        p."firstName" ILIKE ${like} OR p."lastName" ILIKE ${like}
        OR p."preferredName" ILIKE ${like}
        OR concat_ws(' ', coalesce(nullif(p."preferredName", ''), p."firstName"), p."lastName") ILIKE ${like}
      )`);
    }
    // R4-A.7: ordered by name. The cursor is still the last user id; that user's own sort key
    // (looked up here) continues the page, so the contract is unchanged.
    const key = actorSortKey('p');
    if (query.afterId)
      filters.push(Prisma.sql`((${key}) IS NULL, coalesce(${key}, ''), u."id") > (
        SELECT (${actorSortKey('cp')}) IS NULL, coalesce(${actorSortKey('cp')}, ''), cu."id"
        FROM "User" cu
        LEFT JOIN "Person" cp ON cp."id" = cu."personId"
        WHERE cu."id" = ${query.afterId}::uuid
          -- Only an actor this caller may list: another user's id reveals nothing about where
          -- their name sorts (an id outside the list answers an empty page, as before).
          AND EXISTS (
            SELECT 1 FROM "AuditLog" ca
            WHERE ca."actorUserId" = cu."id"
              AND ${this.scopeFilter(system, query.organizationId, 'ca')}
              AND ca."occurredAt" >= ${from}
              AND ca."occurredAt" < ${to}
          )
      )`);
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        firstName: string | null;
        lastName: string | null;
        preferredName: string | null;
      }>
    >`
      SELECT u."id", p."firstName", p."lastName", p."preferredName"
      FROM "User" u
      LEFT JOIN "Person" p ON p."id" = u."personId"
      WHERE ${Prisma.join(filters, ' AND ')}
      ORDER BY (${key}) IS NULL, coalesce(${key}, ''), u."id"
      LIMIT ${limit + 1}`;
    const page = rows.slice(0, limit);
    return {
      items: page.map((row) => ({
        userId: row.id,
        displayName: personDisplayName(row),
      })),
      nextAfterId: rows.length > limit ? page.at(-1)!.id : null,
    };
  }

  async list(userId: string, query: AuditQuery, now = new Date()) {
    const system = await this.requireListRead(userId, query);
    const { from, to } = resolveAuditRange(query, now);
    const limit = auditLimit(query.limit);
    const cursor = query.cursor ? decodeAuditCursor(query.cursor) : null;
    const filters: Prisma.Sql[] = [
      this.scopeFilter(system, query.organizationId),
      Prisma.sql`"occurredAt" >= ${from}`,
      Prisma.sql`"occurredAt" < ${to}`,
    ];
    if (query.action) filters.push(Prisma.sql`"action" = ${query.action}`);
    if (query.entityType)
      filters.push(Prisma.sql`"entityType" = ${query.entityType}`);
    if (query.entityId)
      filters.push(Prisma.sql`"entityId" = ${query.entityId}`);
    if (query.actorUserId)
      filters.push(Prisma.sql`"actorUserId" = ${query.actorUserId}::uuid`);
    if (cursor)
      filters.push(
        Prisma.sql`("occurredAt", "id") < (${cursor.occurredAt}, ${cursor.id}::uuid)`,
      );
    const rows = await this.prisma.$queryRaw<AuditRow[]>`
      SELECT "id", "occurredAt", "action", "entityType", "entityId", "actorUserId",
             "correlationId", "metadata"
      FROM "AuditLog"
      WHERE ${Prisma.join(filters, ' AND ')}
      ORDER BY "occurredAt" DESC, "id" DESC
      LIMIT ${limit + 1}`;
    const page = rows.slice(0, limit);
    const actors = await this.actorNames(page);
    const last = page.at(-1);
    return {
      items: page.map((row) => ({
        id: row.id,
        occurredAt: row.occurredAt.toISOString(),
        action: row.action,
        entityType: row.entityType,
        entityId: row.entityId,
        actor: row.actorUserId
          ? {
              userId: row.actorUserId,
              displayName: actors.get(row.actorUserId) ?? null,
            }
          : null,
        requestId: row.correlationId,
        metadata: projectAuditMetadata(row.metadata),
      })),
      nextCursor:
        rows.length > limit && last
          ? encodeAuditCursor({ occurredAt: last.occurredAt, id: last.id })
          : null,
      range: { from: from.toISOString(), to: to.toISOString() },
    };
  }

  /** Display names of the actors (person name; never the email). */
  private async actorNames(rows: readonly AuditRow[]) {
    const ids = [
      ...new Set(
        rows
          .map((row) => row.actorUserId)
          .filter((id): id is string => id !== null),
      ),
    ];
    if (ids.length === 0) return new Map<string, string>();
    const users = await this.prisma.user.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        person: {
          select: { firstName: true, lastName: true, preferredName: true },
        },
      },
    });
    const names = new Map<string, string>();
    for (const user of users) {
      const name = personDisplayName(user.person);
      if (name) names.set(user.id, name);
    }
    return names;
  }
}
