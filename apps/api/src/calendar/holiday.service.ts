import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { permissionIsGranted } from '../authorization/authorization.policy.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import type {
  AuthorizationScope,
  AuthorizationTarget,
} from '../authorization/authorization.types.js';
import { PrismaService } from '../database/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import type { OrganizationHoliday } from '../generated/prisma/client.js';
import {
  domainError,
  formatDate,
  jsonValue,
  parseDateOnly,
  requireActor,
  type DomainClient,
  type DomainRequestContext,
} from '../common/domain-support.js';
import type {
  CreateHolidayDto,
  HolidayListQueryDto,
  UpdateHolidayDto,
} from './calendar.dto.js';
import { holidayAppliesTo } from './holiday-calendar.js';

const MANAGE = 'holiday.manage';
/** Readers of the holiday list: organization-wide, or scoped to their area (see list). */
const LIST_PERMISSIONS = [MANAGE, 'leave.read', 'leave.approve'] as const;
const MAX_RANGE_DAYS = 400;

/**
 * Phase 8 — the minimal organization calendar: statutory holidays and closures, optionally
 * scoped to a unit (with descendants), department or team. Owned by its own module so that
 * Scheduling may consume it later without depending on Leave. Holidays never rewrite
 * published schedules or approved leave; they only inform future leave sizing.
 */
@Injectable()
export class HolidayService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditService,
  ) {}

  async list(userId: string, query: HolidayListQueryDto) {
    const from = parseDateOnly(query.from, 'from');
    const to = parseDateOnly(query.to, 'to');
    if (to < from)
      throw new BadRequestException('to must be on or after from.');
    if ((to.getTime() - from.getTime()) / 86_400_000 > MAX_RANGE_DAYS) {
      throw new BadRequestException(
        `A holiday list may span at most ${MAX_RANGE_DAYS} days.`,
      );
    }
    const target = await this.organizationTarget(query.organizationId);
    const grants = await this.authorization.effectiveGrants(
      userId,
      new Date(),
      this.prisma,
    );
    // Organization-level readers see the whole calendar. Scoped holders of a list permission
    // (e.g. holiday.manage on one department) see the holidays inside their scope and those that
    // apply to it (organization-wide, an enclosing unit's): the same scoped model as elsewhere.
    const organizationWide = LIST_PERMISSIONS.some((p) =>
      permissionIsGranted(grants, p, target),
    );
    const scopedTargets: AuthorizationTarget[] = [];
    if (!organizationWide) {
      for (const grant of grants) {
        if (
          !(LIST_PERMISSIONS as readonly string[]).includes(grant.permission) ||
          grant.scope.type === 'SYSTEM' ||
          grant.scope.type === 'ORGANIZATION' ||
          !grant.scope.id
        ) {
          continue;
        }
        const scoped = await this.authorization
          .resolveTarget(
            {
              type: grant.scope.type,
              id: grant.scope.id,
            } as AuthorizationScope,
            this.prisma,
          )
          .catch(() => null);
        if (scoped?.organizationId === query.organizationId)
          scopedTargets.push(scoped);
      }
      if (scopedTargets.length === 0) {
        throw new ForbiddenException(
          'Missing permission to read the organization holiday calendar.',
        );
      }
    }
    const rows = await this.prisma.organizationHoliday.findMany({
      where: {
        organizationId: query.organizationId,
        date: { gte: from, lte: to },
        ...(query.includeArchived ? {} : { archivedAt: null }),
      },
      orderBy: [{ date: 'asc' }, { name: 'asc' }, { id: 'asc' }],
    });
    // Each holiday's own scope target, resolved once per distinct scope (scoped holidays are few).
    const scopeTargets = new Map<string, AuthorizationTarget | null>();
    const scopeKey = (row: OrganizationHoliday) => {
      const scope = this.scopeOf(row);
      return `${scope.type}:${scope.id ?? row.organizationId}`;
    };
    for (const row of rows) {
      const key = scopeKey(row);
      if (scopeTargets.has(key)) continue;
      const scope = this.scopeOf(row);
      scopeTargets.set(
        key,
        scope.type === 'ORGANIZATION'
          ? target
          : await this.authorization
              .resolveTarget(scope, this.prisma)
              .catch(() => null),
      );
    }
    return {
      items: rows
        .filter((row) => {
          if (organizationWide) return true;
          const scopeTarget = scopeTargets.get(scopeKey(row));
          return (
            (!!scopeTarget &&
              LIST_PERMISSIONS.some((p) =>
                permissionIsGranted(grants, p, scopeTarget),
              )) ||
            scopedTargets.some((scoped) => holidayAppliesTo(row, scoped))
          );
        })
        .map((row) => {
          // Mirrors update/archive: holiday.manage on the holiday's own scope.
          const scopeTarget = scopeTargets.get(scopeKey(row));
          const canManage =
            !!scopeTarget && permissionIsGranted(grants, MANAGE, scopeTarget);
          return {
            ...this.shape(row),
            actions: {
              canEdit: canManage && !row.archivedAt,
              canArchive: canManage && !row.archivedAt,
            },
          };
        }),
    };
  }

  async create(input: CreateHolidayDto, context: DomainRequestContext) {
    const actor = requireActor(context);
    const scope = this.scopeOf(input);
    const date = parseDateOnly(input.date, 'date');
    return this.prisma.$transaction(async (tx) => {
      await this.assertManage(actor, scope, tx);
      try {
        const created = await tx.organizationHoliday.create({
          data: {
            organizationId: input.organizationId,
            organizationalUnitId: input.organizationalUnitId ?? null,
            departmentId: input.departmentId ?? null,
            teamId: input.teamId ?? null,
            date,
            name: input.name.trim(),
            kind: input.kind,
          },
        });
        await this.writeAudit(tx, 'HOLIDAY_CREATED', created.id, context, {
          holiday: this.shape(created),
        });
        return this.shape(created);
      } catch (error) {
        throw this.duplicate(error);
      }
    });
  }

  async update(
    holidayId: string,
    input: UpdateHolidayDto,
    context: DomainRequestContext,
  ) {
    const actor = requireActor(context);
    return this.prisma.$transaction(async (tx) => {
      const current = await this.lockHoliday(holidayId, tx);
      await this.assertManage(actor, this.scopeOf(current), tx);
      if (current.archivedAt) {
        throw new ConflictException('An archived holiday cannot be edited.');
      }
      const data: Prisma.OrganizationHolidayUpdateInput = {};
      if (input.date) data.date = parseDateOnly(input.date, 'date');
      if (input.name !== undefined) data.name = input.name.trim();
      if (input.kind) data.kind = input.kind;
      if (Object.keys(data).length === 0) return this.shape(current);
      try {
        const updated = await tx.organizationHoliday.update({
          where: { id: holidayId },
          data,
        });
        await this.writeAudit(tx, 'HOLIDAY_UPDATED', holidayId, context, {
          before: this.shape(current),
          after: this.shape(updated),
        });
        return this.shape(updated);
      } catch (error) {
        throw this.duplicate(error);
      }
    });
  }

  async archive(holidayId: string, context: DomainRequestContext) {
    const actor = requireActor(context);
    return this.prisma.$transaction(async (tx) => {
      const current = await this.lockHoliday(holidayId, tx);
      await this.assertManage(actor, this.scopeOf(current), tx);
      if (current.archivedAt) return this.shape(current);
      const archived = await tx.organizationHoliday.update({
        where: { id: holidayId },
        data: { archivedAt: new Date() },
      });
      await this.writeAudit(tx, 'HOLIDAY_ARCHIVED', holidayId, context, {
        holiday: this.shape(archived),
      });
      return this.shape(archived);
    });
  }

  /** Active holidays of one organization applicable to a position placement, in a date range. */
  async applicableHolidays(
    client: DomainClient,
    target: AuthorizationTarget,
    from: Date,
    to: Date,
  ) {
    const rows = await client.organizationHoliday.findMany({
      where: {
        organizationId: target.organizationId,
        archivedAt: null,
        date: { gte: from, lte: to },
      },
      orderBy: [{ date: 'asc' }, { id: 'asc' }],
    });
    return rows.filter((row) => holidayAppliesTo(row, target));
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  private scopeOf(input: {
    organizationId: string;
    organizationalUnitId?: string | null;
    departmentId?: string | null;
    teamId?: string | null;
  }): AuthorizationScope {
    const set = [
      input.organizationalUnitId,
      input.departmentId,
      input.teamId,
    ].filter(Boolean);
    if (set.length > 1) {
      throw new BadRequestException(
        'A holiday applies to the organization or to at most one unit, department or team.',
      );
    }
    if (input.organizationalUnitId) {
      return {
        type: 'ORGANIZATIONAL_UNIT',
        id: input.organizationalUnitId,
        organizationId: input.organizationId,
      };
    }
    if (input.departmentId) {
      return {
        type: 'DEPARTMENT',
        id: input.departmentId,
        organizationId: input.organizationId,
      };
    }
    if (input.teamId) {
      return {
        type: 'TEAM',
        id: input.teamId,
        organizationId: input.organizationId,
      };
    }
    return {
      type: 'ORGANIZATION',
      id: input.organizationId,
      organizationId: input.organizationId,
    };
  }

  private async organizationTarget(
    organizationId: string,
  ): Promise<AuthorizationTarget> {
    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { id: true },
    });
    if (!organization) throw new NotFoundException('Organization not found');
    return {
      type: 'ORGANIZATION',
      organizationId,
      unitPathIds: [],
      departmentId: null,
      teamId: null,
    };
  }

  private async assertManage(
    actor: string,
    scope: AuthorizationScope,
    tx: Prisma.TransactionClient,
  ) {
    let target: AuthorizationTarget;
    try {
      target = await this.authorization.resolveTarget(scope, tx);
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw new NotFoundException('Holiday scope target not found');
      }
      throw error;
    }
    if (target.organizationId !== scope.organizationId) {
      throw new BadRequestException(
        'The holiday scope must belong to its organization.',
      );
    }
    const grants = await this.authorization.effectiveGrants(
      actor,
      new Date(),
      tx,
    );
    if (!permissionIsGranted(grants, MANAGE, target)) {
      throw new ForbiddenException(
        'Missing permission holiday.manage for the holiday scope.',
      );
    }
  }

  private async lockHoliday(holidayId: string, tx: Prisma.TransactionClient) {
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "OrganizationHoliday" WHERE "id" = ${holidayId}::uuid FOR UPDATE`,
    );
    const holiday = await tx.organizationHoliday.findUnique({
      where: { id: holidayId },
    });
    if (!holiday) throw new NotFoundException('Holiday not found');
    return holiday;
  }

  private duplicate(error: unknown) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      return new ConflictException(
        domainError(
          409,
          'HOLIDAY_DUPLICATE',
          'A holiday already exists for this scope and date.',
        ),
      );
    }
    return error;
  }

  shape(row: OrganizationHoliday) {
    return {
      id: row.id,
      organizationId: row.organizationId,
      organizationalUnitId: row.organizationalUnitId,
      departmentId: row.departmentId,
      teamId: row.teamId,
      date: formatDate(row.date),
      name: row.name,
      kind: row.kind,
      archivedAt: row.archivedAt?.toISOString() ?? null,
    };
  }

  private writeAudit(
    tx: Prisma.TransactionClient,
    action: string,
    entityId: string,
    context: DomainRequestContext,
    metadata: Record<string, unknown>,
  ) {
    return this.audit.write(
      {
        action,
        actorUserId: context.actorUserId,
        entityType: 'OrganizationHoliday',
        entityId,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
        correlationId: context.correlationId,
        metadata: jsonValue(metadata),
      },
      tx,
    );
  }
}
