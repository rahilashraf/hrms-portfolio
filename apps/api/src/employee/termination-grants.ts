import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import type { AuditService } from '../audit/audit.service.js';
import type { AuthorizationService } from '../authorization/authorization.service.js';
import type { AuthorizationScope } from '../authorization/authorization.types.js';
import { localDayStart } from '../common/domain-support.js';
import type { PrismaService } from '../database/prisma.service.js';
import type { EmployeeAccessService } from './employee-access.service.js';
import { resolveAssignmentTimezone } from './employee-domain.service.js';
import { addDays, lifecycleError } from './employee-lifecycle-support.js';

/**
 * Security remediation M3 — role grants when a termination applies.
 *
 * When a termination APPLIES (never when it is scheduled, rescheduled, previewed or cancelled),
 * every live grant of the person's login inside the organizations whose assignments the
 * termination ends is revoked (`revocationReason = employment_terminated`), and so is every
 * SYSTEM (System Owner) grant — except grants with an approved, unexpired KEEP. A KEEP names the
 * grant, a reason and an expiry at most 30 days after the last day, and is approved by someone
 * other than its requester; it is honoured as a replacement grant expiring at the earlier of
 * that expiry and the original's (RoleAssignment.expiresAt is immutable). SYSTEM grants need an
 * explicit decision before the termination is scheduled and an approved one (or a revoke) before
 * it applies. Grants in other organizations are untouched.
 */

type Tx = Prisma.TransactionClient;

export const TERMINATION_KEEP_MAX_DAYS = 30;
export const EMPLOYMENT_TERMINATED = 'employment_terminated';
const KEEP_REASON_MIN = 10;
const KEEP_REASON_MAX = 500;
const ISO_INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/;

export interface GrantDecisionInput {
  roleAssignmentId: string;
  decision: 'REVOKE' | 'KEEP';
  reason?: string | null;
  keepUntil?: string | null;
}

export interface GrantContext {
  actorUserId?: string;
  ipAddress?: string;
  userAgent?: string;
  correlationId?: string;
}

/** The assignments a termination ends: their organizations and business time zones. */
export interface TerminationScope {
  terminationDate: Date;
  organizationIds: string[];
  timezones: string[];
}

interface LiveGrant {
  id: string;
  userId: string;
  roleId: string;
  roleOrganizationId: string | null;
  scopeType: string;
  organizationId: string | null;
  organizationalUnitId: string | null;
  departmentId: string | null;
  teamId: string | null;
  startsAt: Date;
  expiresAt: Date | null;
  revokedAt: Date | null;
  role: { name: string; archivedAt: Date | null };
  organization: { name: string } | null;
}

export type GrantOutcomePreview =
  | 'REVOKE'
  | 'KEEP'
  | 'KEEP_PENDING'
  | 'DECISION_REQUIRED'
  /** An approved keep that no longer passes revalidation (revoked; SYSTEM: blocks). */
  | 'KEEP_INVALID'
  | 'REVOKED'
  | 'RETAINED'
  | 'ALREADY_REVOKED';

/**
 * Why an approved keep no longer holds when the termination applies (a safe category; never a
 * role, organization or person name).
 */
export type KeepRevalidationFailure =
  | 'APPROVER_NOT_AUTHORIZED'
  | 'ROLE_INELIGIBLE'
  | 'KEEP_LIMIT_EXCEEDED'
  | 'SELF_APPROVAL';

const LIVE_GRANT_SELECT = {
  id: true,
  userId: true,
  roleId: true,
  roleOrganizationId: true,
  scopeType: true,
  organizationId: true,
  organizationalUnitId: true,
  departmentId: true,
  teamId: true,
  startsAt: true,
  expiresAt: true,
  revokedAt: true,
  role: { select: { name: true, archivedAt: true } },
  organization: { select: { name: true } },
} as const;

/** An assignment's business time zone (work location, else organization; UTC otherwise). */
export function timezoneOfPosition(position: {
  workLocation?: { timezone: string | null } | null;
  organization?: { timezone: string | null } | null;
}): string {
  try {
    return resolveAssignmentTimezone(position);
  } catch {
    return 'UTC';
  }
}

/**
 * The latest instant a KEEP may end: the end of the 30th day after the last day, in the
 * earliest-ending of the affected assignments' time zones (so it is never longer anywhere).
 */
export function keepLimit(scope: TerminationScope): Date {
  const zones = scope.timezones.length > 0 ? scope.timezones : ['UTC'];
  const end = addDays(scope.terminationDate, TERMINATION_KEEP_MAX_DAYS + 1);
  return new Date(
    Math.min(...zones.map((zone) => localDayStart(end, zone).getTime())),
  );
}

/** The first instant the termination can take effect anywhere (after the last day). */
export function earliestEffect(scope: TerminationScope): Date {
  const zones = scope.timezones.length > 0 ? scope.timezones : ['UTC'];
  const next = addDays(scope.terminationDate, 1);
  return new Date(
    Math.min(...zones.map((zone) => localDayStart(next, zone).getTime())),
  );
}

function keepInvalid(message: string, details: Record<string, unknown> = {}) {
  return new BadRequestException(
    lifecycleError(400, 'TERMINATION_KEEP_INVALID', message, details),
  );
}

export function grantScope(grant: {
  scopeType: string;
  organizationId: string | null;
  organizationalUnitId: string | null;
  departmentId: string | null;
  teamId: string | null;
}): AuthorizationScope {
  switch (grant.scopeType) {
    case 'SYSTEM':
      return { type: 'SYSTEM' };
    case 'ORGANIZATIONAL_UNIT':
      return { type: 'ORGANIZATIONAL_UNIT', id: grant.organizationalUnitId! };
    case 'DEPARTMENT':
      return { type: 'DEPARTMENT', id: grant.departmentId! };
    case 'TEAM':
      return { type: 'TEAM', id: grant.teamId! };
    default:
      return { type: 'ORGANIZATION', id: grant.organizationId! };
  }
}

export class TerminationGrants {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: EmployeeAccessService,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditService,
  ) {}

  /** Live (not revoked, not expired) grants of a login, oldest first. */
  liveGrants(client: Tx | PrismaService, userId: string, now: Date) {
    return client.roleAssignment.findMany({
      where: {
        userId,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      select: LIVE_GRANT_SELECT,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    }) as Promise<LiveGrant[]>;
  }

  inScope(
    grant: { scopeType: string; organizationId: string | null },
    scope: TerminationScope,
  ) {
    return (
      grant.scopeType === 'SYSTEM' ||
      (grant.organizationId !== null &&
        scope.organizationIds.includes(grant.organizationId))
    );
  }

  /** The termination's organizations and time zones, from the assignments it ends. */
  async scopeOf(
    client: Tx | PrismaService,
    terminationId: string,
  ): Promise<TerminationScope> {
    const termination = await client.employeeTermination.findUniqueOrThrow({
      where: { id: terminationId },
      select: {
        terminationDate: true,
        assignments: {
          select: {
            employmentAssignment: {
              select: {
                position: {
                  select: {
                    organizationId: true,
                    organization: { select: { timezone: true } },
                    workLocation: { select: { timezone: true } },
                  },
                },
              },
            },
          },
        },
      },
    });
    const positions = termination.assignments.map(
      (a) => a.employmentAssignment.position,
    );
    return {
      terminationDate: termination.terminationDate,
      organizationIds: [
        ...new Set(positions.map((p) => p.organizationId)),
      ].sort(),
      timezones: [
        ...new Set(positions.map((p) => timezoneOfPosition(p))),
      ].sort(),
    };
  }

  /** May the actor decide about (request a keep of, or review) this grant? */
  private async mayDecide(tx: Tx, actor: string, grant: LiveGrant) {
    if (grant.scopeType === 'SYSTEM')
      return this.access.isSystem(actor, 'employee.manage', tx);
    return this.authorization.canAccess(
      actor,
      'role.assign',
      grantScope(grant),
      tx,
    );
  }

  /**
   * M3 decision C — approving a keep needs the authority to grant that role at that scope through
   * the ordinary role-assignment workflow (AuthorizationService.assertCanDelegateRole: role.assign
   * plus every active permission of the role, each over a scope containing the grant's). A SYSTEM
   * grant also needs a System administrator, and delegation at SYSTEM scope. The role row is
   * locked FOR UPDATE first: a concurrent change of its permissions (whose inserts take KEY SHARE
   * on it) or its archiving either committed before — and is checked — or waits; so does a
   * revocation of the approver's own grants (locked FOR SHARE). Checked when the approval runs,
   * never from the capabilities a screen showed. (Only the System Owner role can be granted at
   * SYSTEM scope — a database constraint — so a SYSTEM approver is always a System Owner.)
   */
  private async assertMayApproveKeep(tx: Tx, actor: string, grant: LiveGrant) {
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "Role" WHERE "id" = ${grant.roleId}::uuid FOR UPDATE`,
    );
    const role = await tx.role.findUnique({
      where: { id: grant.roleId },
      select: { archivedAt: true },
    });
    if (!role || role.archivedAt !== null)
      throw new ConflictException(
        lifecycleError(
          409,
          'TERMINATION_KEEP_INVALID',
          'This role is archived and can no longer be granted or kept.',
        ),
      );
    const system = grant.scopeType === 'SYSTEM';
    const refuse = () =>
      new ForbiddenException(
        system
          ? lifecycleError(
              403,
              'TERMINATION_SYSTEM_ACTOR_REQUIRED',
              'Only a System administrator who could grant this System-level role can approve keeping it.',
            )
          : lifecycleError(
              403,
              'TERMINATION_KEEP_NOT_AUTHORIZED',
              'Approving needs the authority to grant this role at its scope.',
            ),
      );
    // The approver's own unrevoked grants, FOR SHARE (id order): a concurrent revocation of the
    // approver's authority either committed first (and is seen) or waits for the approval.
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "RoleAssignment" WHERE "userId" = ${actor}::uuid AND "revokedAt" IS NULL ORDER BY "id" FOR SHARE`,
    );
    if (system && !(await this.access.isSystem(actor, 'employee.manage', tx)))
      throw refuse();
    try {
      await this.authorization.assertCanDelegateRole(
        actor,
        grant.roleId,
        system ? { type: 'SYSTEM' } : grantScope(grant),
        tx,
      );
    } catch (error) {
      if (
        error instanceof ForbiddenException ||
        error instanceof NotFoundException
      )
        throw refuse();
      throw error;
    }
  }

  /**
   * Final M3 change — an approved keep is revalidated when the termination applies, against the
   * state at `now`: the approver must still be someone other than the requester and still hold
   * the authority to grant the role as it is now (AuthorizationService.assertCanDelegateRole:
   * role.assign plus every current active permission of the role, over a scope containing the
   * grant's; SYSTEM: also a System administrator, delegating at SYSTEM scope); the role must
   * still be eligible (not archived); the keep must still end within the 30-day limit. The
   * original approval is not trusted on its own. Read on the caller's client: under
   * applyAtCompletion's locks this is authoritative; elsewhere (gate, listing) it is a
   * read-only check. Returns null when the keep still holds.
   */
  async keepRevalidationFailure(
    client: Tx,
    decision: {
      reviewedByUserId: string | null;
      requestedByUserId: string | null;
      keepUntil: Date | null;
    },
    grant: LiveGrant,
    scope: TerminationScope,
    now: Date,
  ): Promise<KeepRevalidationFailure | null> {
    const approver = decision.reviewedByUserId;
    // Self-approval: the requester, or the person whose grant it is (review L2).
    if (
      !approver ||
      approver === decision.requestedByUserId ||
      approver === grant.userId
    )
      return 'SELF_APPROVAL';
    if (
      !decision.keepUntil ||
      decision.keepUntil.getTime() > keepLimit(scope).getTime()
    )
      return 'KEEP_LIMIT_EXCEEDED';
    const role = await client.role.findUnique({
      where: { id: grant.roleId },
      select: { archivedAt: true },
    });
    if (!role || role.archivedAt !== null) return 'ROLE_INELIGIBLE';
    const system = grant.scopeType === 'SYSTEM';
    if (
      system &&
      !(await this.access.isSystem(approver, 'employee.manage', client))
    )
      return 'APPROVER_NOT_AUTHORIZED';
    try {
      await this.authorization.assertCanDelegateRole(
        approver,
        grant.roleId,
        system ? { type: 'SYSTEM' } : grantScope(grant),
        client,
        now,
      );
    } catch (error) {
      if (
        error instanceof ForbiddenException ||
        error instanceof NotFoundException
      )
        return 'APPROVER_NOT_AUTHORIZED';
      throw error;
    }
    return null;
  }

  private async assertMayDecide(tx: Tx, actor: string, grant: LiveGrant) {
    if (await this.mayDecide(tx, actor, grant)) return;
    throw new ForbiddenException(
      grant.scopeType === 'SYSTEM'
        ? lifecycleError(
            403,
            'TERMINATION_SYSTEM_ACTOR_REQUIRED',
            'Only a System administrator can decide about System-level roles.',
          )
        : lifecycleError(
            403,
            'TERMINATION_KEEP_NOT_AUTHORIZED',
            'You cannot manage this role assignment.',
          ),
    );
  }

  /**
   * Validates and records grant decisions on a SCHEDULED termination (in the caller's
   * transaction, under the employee's lifecycle lock). A REVOKE is DECIDED; a KEEP is REQUESTED
   * by the actor and needs someone else's approval. Recording again replaces the earlier
   * decision (its approval included). With `requireSystemDecisions`, every live SYSTEM grant must
   * then have a decision.
   */
  async record(
    tx: Tx,
    input: {
      terminationId: string;
      userId: string | null;
      actor: string;
      decisions: readonly GrantDecisionInput[];
      now: Date;
      requireSystemDecisions: boolean;
      context: GrantContext;
      employeeId: string;
    },
  ) {
    const scope = await this.scopeOf(tx, input.terminationId);
    const grants = input.userId
      ? await this.liveGrants(tx, input.userId, input.now)
      : [];
    const byId = new Map(grants.map((g) => [g.id, g]));
    const seen = new Set<string>();
    for (const decision of input.decisions) {
      if (decision.decision !== 'REVOKE' && decision.decision !== 'KEEP')
        throw keepInvalid('Each decision is REVOKE or KEEP.');
      if (seen.has(decision.roleAssignmentId))
        throw keepInvalid('Each role assignment can have one decision.');
      seen.add(decision.roleAssignmentId);
      const grant = byId.get(decision.roleAssignmentId);
      if (!grant) throw new NotFoundException('Role assignment not found.');
      if (!this.inScope(grant, scope)) {
        throw new BadRequestException(
          lifecycleError(
            400,
            'TERMINATION_KEEP_OUTSIDE_SCOPE',
            'This role assignment is outside the organizations the termination ends; it is not affected.',
          ),
        );
      }
      if (decision.decision === 'KEEP' || grant.scopeType === 'SYSTEM')
        await this.assertMayDecide(tx, input.actor, grant);
      let reason: string | null = null;
      let keepUntil: Date | null = null;
      if (decision.decision === 'KEEP') {
        reason = (decision.reason ?? '').trim();
        if (reason.length < KEEP_REASON_MIN || reason.length > KEEP_REASON_MAX)
          throw keepInvalid(
            `Give a reason of ${KEEP_REASON_MIN} to ${KEEP_REASON_MAX} characters for keeping access.`,
          );
        keepUntil = this.parseKeepUntil(decision.keepUntil, scope, input.now);
      }
      const data = {
        decision: decision.decision,
        status:
          decision.decision === 'KEEP'
            ? ('REQUESTED' as const)
            : ('DECIDED' as const),
        reason,
        keepUntil,
        requestedByUserId: input.actor,
        requestedAt: input.now,
        reviewedByUserId: null,
        reviewedAt: null,
        reviewNote: null,
      };
      const saved = await tx.employeeTerminationGrantDecision.upsert({
        where: {
          terminationId_roleAssignmentId: {
            terminationId: input.terminationId,
            roleAssignmentId: grant.id,
          },
        },
        create: {
          terminationId: input.terminationId,
          roleAssignmentId: grant.id,
          ...data,
        },
        update: data,
      });
      await this.audit.write(
        this.auditInput(
          'EMPLOYEE_TERMINATION_GRANT_DECISION_RECORDED',
          'Employee',
          input.employeeId,
          input.context,
          {
            terminationId: input.terminationId,
            roleAssignmentId: grant.id,
            decisionId: saved.id,
            decision: decision.decision,
            keepUntil: keepUntil?.toISOString() ?? null,
            system: grant.scopeType === 'SYSTEM',
          },
        ),
        tx,
      );
    }
    if (input.requireSystemDecisions)
      await this.assertSystemDecided(tx, input.terminationId, grants);
  }

  private parseKeepUntil(
    value: string | null | undefined,
    scope: TerminationScope,
    now: Date,
  ) {
    if (typeof value !== 'string' || !ISO_INSTANT.test(value))
      throw keepInvalid(
        'Give the end of the kept access as a date and time with its offset.',
      );
    const keepUntil = new Date(value);
    if (Number.isNaN(keepUntil.getTime()))
      throw keepInvalid(
        'Give the end of the kept access as a valid date and time.',
      );
    const limit = keepLimit(scope);
    if (keepUntil.getTime() > limit.getTime())
      throw keepInvalid(
        `Kept access can last at most ${TERMINATION_KEEP_MAX_DAYS} days after the last day of employment.`,
        { latest: limit.toISOString() },
      );
    if (
      keepUntil.getTime() <= now.getTime() ||
      keepUntil.getTime() <= earliestEffect(scope).getTime()
    )
      throw keepInvalid(
        'Kept access must end after the termination takes effect.',
      );
    return keepUntil;
  }

  /** Every live SYSTEM grant has a (non-cancelled) decision on this termination. */
  private async assertSystemDecided(
    tx: Tx,
    terminationId: string,
    grants: LiveGrant[],
  ) {
    const system = grants.filter((g) => g.scopeType === 'SYSTEM');
    if (system.length === 0) return;
    const decided = new Set(
      (
        await tx.employeeTerminationGrantDecision.findMany({
          where: {
            terminationId,
            roleAssignmentId: { in: system.map((g) => g.id) },
            status: { not: 'CANCELLED' },
          },
          select: { roleAssignmentId: true },
        })
      ).map((row) => row.roleAssignmentId),
    );
    const missing = system.filter((g) => !decided.has(g.id)).map((g) => g.id);
    if (missing.length > 0) {
      throw new BadRequestException(
        lifecycleError(
          400,
          'TERMINATION_GRANT_DECISION_REQUIRED',
          'This employee holds System-level roles: decide explicitly, for each one, whether it is revoked or kept for a limited time (with someone else’s approval).',
          { roleAssignmentIds: missing },
        ),
      );
    }
  }

  /**
   * Whether the termination may complete now: every live SYSTEM grant has a REVOKE, a rejected
   * or expired KEEP (both revoke), or an approved unexpired KEEP. A pending KEEP or no decision
   * blocks. Non-SYSTEM decisions never block (an unapproved KEEP is revoked).
   */
  async gate(
    tx: Tx,
    terminationId: string,
    userId: string | null,
    now: Date,
  ): Promise<{ code: string; roleAssignmentIds: string[] } | null> {
    if (!userId) return null;
    const system = (await this.liveGrants(tx, userId, now)).filter(
      (g) => g.scopeType === 'SYSTEM',
    );
    if (system.length === 0) return null;
    const decisions = await tx.employeeTerminationGrantDecision.findMany({
      where: {
        terminationId,
        roleAssignmentId: { in: system.map((g) => g.id) },
        status: { not: 'CANCELLED' },
      },
    });
    const byGrant = new Map(decisions.map((d) => [d.roleAssignmentId, d]));
    const missing = system.filter((g) => !byGrant.has(g.id)).map((g) => g.id);
    if (missing.length > 0)
      return {
        code: 'TERMINATION_GRANT_DECISION_REQUIRED',
        roleAssignmentIds: missing,
      };
    const pending = decisions
      .filter((d) => d.decision === 'KEEP' && d.status === 'REQUESTED')
      .map((d) => d.roleAssignmentId);
    if (pending.length > 0)
      return {
        code: 'TERMINATION_KEEP_APPROVAL_REQUIRED',
        roleAssignmentIds: pending,
      };
    // Final M3 change: an approved SYSTEM keep that no longer passes revalidation blocks (fail
    // closed). Checked here before anything changes; applyAtCompletion checks again under locks.
    const scope = await this.scopeOf(tx, terminationId);
    const invalid: string[] = [];
    for (const grant of system) {
      const d = byGrant.get(grant.id)!;
      if (
        d.decision !== 'KEEP' ||
        d.status !== 'APPROVED' ||
        !d.keepUntil ||
        d.keepUntil.getTime() <= now.getTime()
      )
        continue;
      if (await this.keepRevalidationFailure(tx, d, grant, scope, now))
        invalid.push(grant.id);
    }
    if (invalid.length > 0)
      return {
        code: 'TERMINATION_KEEP_APPROVAL_INVALID',
        roleAssignmentIds: invalid,
      };
    return null;
  }

  gateError(blocked: { code: string; roleAssignmentIds: string[] }) {
    return new ConflictException(
      lifecycleError(
        409,
        blocked.code,
        blocked.code === 'TERMINATION_GRANT_DECISION_REQUIRED'
          ? 'The termination cannot take effect until each System-level role has an explicit decision.'
          : blocked.code === 'TERMINATION_KEEP_APPROVAL_INVALID'
            ? 'An approved exception for a System-level role is no longer valid (its approver can no longer grant that role, or the role changed). Record a new decision and have an eligible System administrator approve it.'
            : 'The termination cannot take effect until the requested exceptions for System-level roles are approved or rejected by another System administrator.',
        { roleAssignmentIds: blocked.roleAssignmentIds },
      ),
    );
  }

  /**
   * Applies the grant policy as the termination completes (inside its transaction, after the
   * Employee row is locked by the status change). Lock order: User (FOR UPDATE: a concurrent
   * grant insert takes its key-share lock, so it either committed before and is revoked here, or
   * waits), the roles of approved keeps (FOR UPDATE, in id order, before any grant: a role
   * archive and a permission change wait or committed first), then — in one id-ordered statement —
   * the target's grants and every approver's unrevoked grants (the order every revocation path
   * uses). Every approved keep is then revalidated (keepRevalidationFailure) before any change.
   */
  async applyAtCompletion(
    tx: Tx,
    input: {
      terminationId: string;
      employeeId: string;
      userId: string;
      now: Date;
      source: string;
      context: GrantContext;
      scheduledByUserId: string | null;
    },
  ) {
    const { now } = input;
    const actor = input.context.actorUserId ?? null;
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "User" WHERE "id" = ${input.userId}::uuid FOR UPDATE`,
    );
    const scope = await this.scopeOf(tx, input.terminationId);
    const grants = (await this.liveGrants(tx, input.userId, now)).filter((g) =>
      this.inScope(g, scope),
    );
    const decisions = await tx.employeeTerminationGrantDecision.findMany({
      where: {
        terminationId: input.terminationId,
        status: { not: 'CANCELLED' },
      },
    });
    const byGrant = new Map(decisions.map((d) => [d.roleAssignmentId, d]));
    // Approved, unexpired keeps: candidates, revalidated below under locks (final M3 change).
    const approved = (grant: LiveGrant) => {
      const d = byGrant.get(grant.id);
      return Boolean(
        d &&
        d.decision === 'KEEP' &&
        d.status === 'APPROVED' &&
        d.keepUntil &&
        d.keepUntil.getTime() > now.getTime(),
      );
    };
    const candidates = grants.filter(approved);
    // Lock order (after the target's User row): the kept roles FOR UPDATE, in id order — a
    // concurrent permission change (its RolePermission inserts take KEY SHARE on the role) or an
    // archive either committed first and is revalidated, or waits; then, in one id-ordered
    // statement, the target's grants and every approver's unrevoked grants FOR UPDATE — the
    // global row order every revocation path uses, so no cycle with role archiving (Role → its
    // grants) or revocation, and a concurrent change to an approver's authority either committed
    // first and is seen, or waits.
    const roles = [...new Set(candidates.map((g) => g.roleId))].sort();
    if (roles.length > 0) {
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "Role" WHERE "id" IN (${Prisma.join(
          roles.map((id) => Prisma.sql`${id}::uuid`),
        )}) ORDER BY "id" FOR UPDATE`,
      );
    }
    const approvers = [
      ...new Set(
        candidates
          .map((g) => byGrant.get(g.id)!.reviewedByUserId)
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    const approverGrants =
      approvers.length > 0
        ? await tx.roleAssignment.findMany({
            where: { userId: { in: approvers }, revokedAt: null },
            select: { id: true },
          })
        : [];
    const ids = [
      ...new Set([
        ...grants.map((g) => g.id),
        ...approverGrants.map((g) => g.id),
      ]),
    ].sort();
    if (ids.length > 0) {
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "RoleAssignment" WHERE "id" IN (${Prisma.join(
          ids.map((id) => Prisma.sql`${id}::uuid`),
        )}) ORDER BY "id" FOR UPDATE`,
      );
    }
    // Revalidate every approved keep before changing anything. An invalid SYSTEM keep fails the
    // whole application (the caller's transaction rolls back: nothing ended, revoked or
    // disabled); an invalid ordinary keep is not honoured — the grant is revoked.
    const invalid = new Map<string, KeepRevalidationFailure>();
    const blockedSystem: string[] = [];
    for (const grant of candidates) {
      const failure = await this.keepRevalidationFailure(
        tx,
        byGrant.get(grant.id)!,
        grant,
        scope,
        now,
      );
      if (!failure) continue;
      if (grant.scopeType === 'SYSTEM') blockedSystem.push(grant.id);
      else invalid.set(grant.id, failure);
    }
    if (blockedSystem.length > 0)
      throw this.gateError({
        code: 'TERMINATION_KEEP_APPROVAL_INVALID',
        roleAssignmentIds: blockedSystem,
      });
    const retainable = (grant: LiveGrant) =>
      approved(grant) && !invalid.has(grant.id);
    const auditBase = {
      terminationId: input.terminationId,
      source: input.source,
      reasonCode: 'EMPLOYMENT_TERMINATED',
      scheduledByUserId: input.scheduledByUserId,
    };
    const counts = { revoked: 0, retained: 0, alreadyRevoked: 0 };
    for (const grant of [...grants].sort((a, b) => a.id.localeCompare(b.id))) {
      const decision = byGrant.get(grant.id);
      const retain = retainable(grant);
      const revoked = await tx.roleAssignment.updateMany({
        where: { id: grant.id, revokedAt: null },
        data: {
          revokedAt: now,
          revokedByUserId: actor,
          revocationReason: EMPLOYMENT_TERMINATED,
        },
      });
      if (revoked.count !== 1) {
        // Someone revoked it first (their revocation and its audit entry stay).
        counts.alreadyRevoked += 1;
        await this.recordOutcome(tx, input.terminationId, grant.id, decision, {
          outcome: 'ALREADY_REVOKED',
          now,
        });
        continue;
      }
      await this.audit.write(
        this.auditInput(
          'ROLE_ASSIGNMENT_REVOKED',
          'RoleAssignment',
          grant.id,
          input.context,
          {
            ...auditBase,
            userId: grant.userId,
            roleId: grant.roleId,
            retained: retain,
          },
        ),
        tx,
      );
      const failure = invalid.get(grant.id);
      if (failure)
        await this.audit.write(
          this.auditInput(
            'EMPLOYEE_TERMINATION_GRANT_KEEP_REVALIDATION_FAILED',
            'Employee',
            input.employeeId,
            input.context,
            {
              terminationId: input.terminationId,
              decisionId: decision!.id,
              roleAssignmentId: grant.id,
              reason: failure,
              system: false,
              source: input.source,
            },
          ),
          tx,
        );
      if (!retain) {
        counts.revoked += 1;
        await this.recordOutcome(tx, input.terminationId, grant.id, decision, {
          outcome: 'REVOKED',
          now,
        });
        continue;
      }
      const keepUntil = decision!.keepUntil!;
      const expiresAt =
        grant.expiresAt && grant.expiresAt.getTime() < keepUntil.getTime()
          ? grant.expiresAt
          : keepUntil;
      const replacement = await tx.roleAssignment.create({
        data: {
          userId: grant.userId,
          roleId: grant.roleId,
          roleOrganizationId: grant.roleOrganizationId,
          scopeType:
            grant.scopeType as Prisma.RoleAssignmentCreateInput['scopeType'],
          organizationId: grant.organizationId,
          organizationalUnitId: grant.organizationalUnitId,
          departmentId: grant.departmentId,
          teamId: grant.teamId,
          startsAt:
            grant.startsAt.getTime() > now.getTime() ? grant.startsAt : now,
          expiresAt,
          createdByUserId: actor,
        },
        select: { id: true },
      });
      counts.retained += 1;
      await this.recordOutcome(tx, input.terminationId, grant.id, decision, {
        outcome: 'RETAINED',
        now,
        retainedRoleAssignmentId: replacement.id,
      });
      await this.audit.write(
        this.auditInput(
          'ROLE_ASSIGNMENT_RETAINED',
          'RoleAssignment',
          replacement.id,
          input.context,
          {
            ...auditBase,
            reasonCode: 'TERMINATION_KEEP_APPROVED',
            userId: grant.userId,
            roleId: grant.roleId,
            originalRoleAssignmentId: grant.id,
            decisionId: decision!.id,
            retainedUntil: expiresAt.toISOString(),
            requestedByUserId: decision!.requestedByUserId,
            approvedByUserId: decision!.reviewedByUserId,
          },
        ),
        tx,
      );
    }
    // Decisions about grants already gone before the application (revoked or expired by then).
    const handled = new Set(grants.map((g) => g.id));
    for (const decision of decisions) {
      if (handled.has(decision.roleAssignmentId) || decision.appliedAt)
        continue;
      counts.alreadyRevoked += 1;
      await this.recordOutcome(
        tx,
        input.terminationId,
        decision.roleAssignmentId,
        decision,
        {
          outcome: 'ALREADY_REVOKED',
          now,
        },
      );
    }
    return counts;
  }

  private async recordOutcome(
    tx: Tx,
    terminationId: string,
    roleAssignmentId: string,
    decision: { id: string } | undefined,
    result: {
      outcome: 'REVOKED' | 'RETAINED' | 'ALREADY_REVOKED';
      now: Date;
      retainedRoleAssignmentId?: string;
    },
  ) {
    const data = {
      appliedAt: result.now,
      outcome: result.outcome,
      retainedRoleAssignmentId: result.retainedRoleAssignmentId ?? null,
    };
    if (decision) {
      await tx.employeeTerminationGrantDecision.update({
        where: { id: decision.id },
        data,
      });
      return;
    }
    // A grant nobody decided about: the default (revoke), recorded with its outcome.
    await tx.employeeTerminationGrantDecision.create({
      data: {
        terminationId,
        roleAssignmentId,
        decision: 'REVOKE',
        status: 'DECIDED',
        requestedByUserId: null,
        requestedAt: result.now,
        ...data,
      },
    });
  }

  /** Copies a superseded termination's open decisions; an approval must be given again. */
  async carryOver(
    tx: Tx,
    input: {
      fromTerminationId: string;
      toTerminationId: string;
      now: Date;
    },
  ) {
    const scope = await this.scopeOf(tx, input.toTerminationId);
    const limit = keepLimit(scope);
    const effect = earliestEffect(scope);
    const decisions = await tx.employeeTerminationGrantDecision.findMany({
      where: {
        terminationId: input.fromTerminationId,
        appliedAt: null,
        status: { in: ['DECIDED', 'REQUESTED', 'APPROVED'] },
      },
    });
    for (const d of decisions) {
      if (d.decision === 'KEEP') {
        const until = d.keepUntil!;
        if (
          until.getTime() > limit.getTime() ||
          until.getTime() <= effect.getTime() ||
          until.getTime() <= input.now.getTime()
        )
          continue;
      }
      await tx.employeeTerminationGrantDecision.create({
        data: {
          terminationId: input.toTerminationId,
          roleAssignmentId: d.roleAssignmentId,
          decision: d.decision,
          status: d.decision === 'KEEP' ? 'REQUESTED' : 'DECIDED',
          reason: d.reason,
          keepUntil: d.keepUntil,
          requestedByUserId: d.requestedByUserId,
          requestedAt: d.requestedAt,
        },
      });
    }
  }

  /** A cancelled or superseded termination's open decisions end with it. */
  async closeOpen(tx: Tx, terminationId: string) {
    await tx.employeeTerminationGrantDecision.updateMany({
      where: {
        terminationId,
        appliedAt: null,
        status: { in: ['DECIDED', 'REQUESTED', 'APPROVED'] },
      },
      data: { status: 'CANCELLED' },
    });
  }

  /**
   * Approves, rejects or withdraws a KEEP request (in the caller's transaction, under the
   * lifecycle lock, on a SCHEDULED termination). Approval and rejection are someone else's than
   * the requester's, by an actor who may manage the grant (SYSTEM grants: a System
   * administrator); an expired request cannot be approved.
   */
  async review(
    tx: Tx,
    input: {
      terminationId: string;
      decisionId: string;
      employeeId: string;
      actor: string;
      action: 'APPROVE' | 'REJECT' | 'CANCEL';
      note: string | null;
      now: Date;
      context: GrantContext;
    },
  ) {
    const [row] = await tx.$queryRaw<Array<{ id: string }>>(
      Prisma.sql`SELECT "id" FROM "EmployeeTerminationGrantDecision" WHERE "id" = ${input.decisionId}::uuid AND "terminationId" = ${input.terminationId}::uuid FOR UPDATE`,
    );
    if (!row) throw new NotFoundException('Decision not found.');
    const decision =
      await tx.employeeTerminationGrantDecision.findUniqueOrThrow({
        where: { id: input.decisionId },
        include: { roleAssignment: { select: LIVE_GRANT_SELECT } },
      });
    const pendingStates =
      input.action === 'CANCEL' ? ['REQUESTED', 'APPROVED'] : ['REQUESTED'];
    if (
      decision.decision !== 'KEEP' ||
      !pendingStates.includes(decision.status)
    ) {
      throw new ConflictException(
        lifecycleError(
          409,
          'TERMINATION_KEEP_NOT_PENDING',
          'Only a requested exception can be approved or rejected (or a requested or approved one withdrawn).',
        ),
      );
    }
    const grant = decision.roleAssignment as unknown as LiveGrant;
    if (
      input.action !== 'CANCEL' &&
      decision.requestedByUserId === input.actor
    ) {
      throw new ForbiddenException(
        lifecycleError(
          403,
          'TERMINATION_KEEP_SELF_APPROVAL',
          'Someone other than the requester must approve or reject an exception.',
        ),
      );
    }
    if (input.action === 'APPROVE')
      await this.assertMayApproveKeep(tx, input.actor, grant);
    else await this.assertMayDecide(tx, input.actor, grant);
    if (input.action === 'APPROVE') {
      if (
        !decision.keepUntil ||
        decision.keepUntil.getTime() <= input.now.getTime()
      ) {
        throw new ConflictException(
          lifecycleError(
            409,
            'TERMINATION_KEEP_EXPIRED',
            'The requested access has already ended; request a new exception instead.',
          ),
        );
      }
      if (
        grant.revokedAt !== null ||
        (grant.expiresAt !== null &&
          grant.expiresAt.getTime() <= input.now.getTime())
      ) {
        throw new ConflictException(
          lifecycleError(
            409,
            'TERMINATION_KEEP_INVALID',
            'This role assignment is no longer active.',
          ),
        );
      }
    }
    const status =
      input.action === 'APPROVE'
        ? ('APPROVED' as const)
        : input.action === 'REJECT'
          ? ('REJECTED' as const)
          : ('CANCELLED' as const);
    await tx.employeeTerminationGrantDecision.update({
      where: { id: decision.id },
      data:
        input.action === 'CANCEL'
          ? { status }
          : {
              status,
              reviewedByUserId: input.actor,
              reviewedAt: input.now,
              reviewNote: input.note,
            },
    });
    await this.audit.write(
      this.auditInput(
        input.action === 'APPROVE'
          ? 'EMPLOYEE_TERMINATION_GRANT_KEEP_APPROVED'
          : input.action === 'REJECT'
            ? 'EMPLOYEE_TERMINATION_GRANT_KEEP_REJECTED'
            : 'EMPLOYEE_TERMINATION_GRANT_KEEP_CANCELLED',
        'Employee',
        input.employeeId,
        input.context,
        {
          terminationId: input.terminationId,
          decisionId: decision.id,
          roleAssignmentId: decision.roleAssignmentId,
          requestedByUserId: decision.requestedByUserId,
          system: grant.scopeType === 'SYSTEM',
          withNote: input.note !== null,
        },
      ),
      tx,
    );
  }

  /**
   * The grants a termination concerns, for someone who may manage the employee: before it applies,
   * the live in-scope grants with their decisions and what will happen; afterwards, what did. Only
   * grants inside the termination's organizations (and SYSTEM grants) are listed; whether other
   * access remains is a yes/no.
   */
  async list(
    client: Tx | PrismaService,
    input: {
      terminationId: string;
      employeeId: string;
      status: string;
      userId: string | null;
      now: Date;
    },
  ) {
    const scope = await this.scopeOf(client, input.terminationId);
    const decisions = await client.employeeTerminationGrantDecision.findMany({
      where: { terminationId: input.terminationId },
      include: {
        roleAssignment: { select: LIVE_GRANT_SELECT },
        retainedRoleAssignment: {
          select: { id: true, expiresAt: true, revokedAt: true },
        },
        requestedBy: {
          select: { person: { select: { firstName: true, lastName: true } } },
        },
        reviewedBy: {
          select: { person: { select: { firstName: true, lastName: true } } },
        },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const byGrant = new Map(decisions.map((d) => [d.roleAssignmentId, d]));
    const scheduled = input.status === 'SCHEDULED';
    // Final M3 change: why an approved keep was not honoured at application (audited reason).
    const failures = new Map<string, string>();
    if (!scheduled)
      for (const row of await client.auditLog.findMany({
        where: {
          entityType: 'Employee',
          entityId: input.employeeId,
          action: 'EMPLOYEE_TERMINATION_GRANT_KEEP_REVALIDATION_FAILED',
          metadata: { path: ['terminationId'], equals: input.terminationId },
        },
        select: { metadata: true },
      })) {
        const metadata = row.metadata as {
          decisionId?: string;
          reason?: string;
        };
        if (metadata.decisionId && metadata.reason)
          failures.set(metadata.decisionId, metadata.reason);
      }
    const live = input.userId
      ? await this.liveGrants(client, input.userId, input.now)
      : [];
    const subjects: LiveGrant[] = scheduled
      ? live.filter((g) => this.inScope(g, scope))
      : decisions.map((d) => d.roleAssignment as unknown as LiveGrant);
    const name = (
      user: {
        person: { firstName: string | null; lastName: string | null };
      } | null,
    ) =>
      user
        ? [user.person.firstName, user.person.lastName]
            .filter(Boolean)
            .join(' ') || null
        : null;
    const grants = [];
    for (const grant of subjects) {
      const d = byGrant.get(grant.id);
      const active = d && d.status !== 'CANCELLED' ? d : undefined;
      let outcome: GrantOutcomePreview;
      if (d?.outcome) outcome = d.outcome;
      else if (active?.decision === 'KEEP' && active.status === 'APPROVED')
        // Final M3 change: what the application would conclude now (read-only check).
        outcome =
          scheduled &&
          active.keepUntil &&
          active.keepUntil.getTime() > input.now.getTime() &&
          (await this.keepRevalidationFailure(
            client as Tx,
            active,
            grant,
            scope,
            input.now,
          ))
            ? 'KEEP_INVALID'
            : 'KEEP';
      else if (active?.decision === 'KEEP' && active.status === 'REQUESTED')
        outcome = 'KEEP_PENDING';
      else if (grant.scopeType === 'SYSTEM' && !active)
        outcome = 'DECISION_REQUIRED';
      else outcome = 'REVOKE';
      grants.push({
        roleAssignmentId: grant.id,
        roleName: grant.role.name,
        scopeType: grant.scopeType,
        system: grant.scopeType === 'SYSTEM',
        organizationId: grant.organizationId,
        organizationName: grant.organization?.name ?? null,
        expiresAt: grant.expiresAt?.toISOString() ?? null,
        outcome,
        decision: d
          ? {
              id: d.id,
              decision: d.decision,
              status: d.status,
              reason: d.reason,
              keepUntil: d.keepUntil?.toISOString() ?? null,
              requestedByUserId: d.requestedByUserId,
              requestedByName: name(d.requestedBy),
              requestedAt: d.requestedAt.toISOString(),
              reviewedByUserId: d.reviewedByUserId,
              reviewedByName: name(d.reviewedBy),
              reviewedAt: d.reviewedAt?.toISOString() ?? null,
              reviewNote: d.reviewNote,
              appliedAt: d.appliedAt?.toISOString() ?? null,
              outcome: d.outcome,
              retainedRoleAssignmentId: d.retainedRoleAssignmentId,
              retainedUntil:
                d.retainedRoleAssignment?.expiresAt?.toISOString() ?? null,
              revalidationFailure: failures.get(d.id) ?? null,
            }
          : null,
      });
    }
    const otherAccessRemains = live.some(
      (g) =>
        !this.inScope(g, scope) &&
        g.role.archivedAt === null &&
        g.startsAt <= input.now,
    );
    const blocking = scheduled
      ? grants
          .filter(
            (g) =>
              g.system &&
              (g.outcome === 'DECISION_REQUIRED' ||
                g.outcome === 'KEEP_PENDING' ||
                g.outcome === 'KEEP_INVALID'),
          )
          .map((g) => ({
            roleAssignmentId: g.roleAssignmentId,
            code:
              g.outcome === 'DECISION_REQUIRED'
                ? 'TERMINATION_GRANT_DECISION_REQUIRED'
                : g.outcome === 'KEEP_INVALID'
                  ? 'TERMINATION_KEEP_APPROVAL_INVALID'
                  : 'TERMINATION_KEEP_APPROVAL_REQUIRED',
          }))
      : [];
    const willKeep = grants.some((g) => g.outcome === 'KEEP');
    return {
      grants,
      otherAccessRemains,
      loginWillBeDisabled:
        scheduled && input.userId !== null
          ? !otherAccessRemains && !willKeep
          : null,
      blocking,
      keepLimit: keepLimit(scope).toISOString(),
    };
  }

  /**
   * Before a termination is recorded: the grants it would concern and their default outcome
   * (REVOKE; SYSTEM grants need a decision), whether other access remains (yes/no only) and
   * whether the login would be disabled.
   */
  async preview(
    client: Tx | PrismaService,
    userId: string | null,
    scope: TerminationScope,
    now: Date,
  ) {
    const live = userId ? await this.liveGrants(client, userId, now) : [];
    const grants = live
      .filter((g) => this.inScope(g, scope))
      .map((g) => ({
        roleAssignmentId: g.id,
        roleName: g.role.name,
        scopeType: g.scopeType,
        system: g.scopeType === 'SYSTEM',
        organizationId: g.organizationId,
        organizationName: g.organization?.name ?? null,
        expiresAt: g.expiresAt?.toISOString() ?? null,
        outcome: (g.scopeType === 'SYSTEM'
          ? 'DECISION_REQUIRED'
          : 'REVOKE') as GrantOutcomePreview,
      }));
    const otherAccessRemains = live.some(
      (g) =>
        !this.inScope(g, scope) &&
        g.role.archivedAt === null &&
        g.startsAt <= now,
    );
    return {
      grants,
      otherAccessRemains,
      loginWillBeDisabled: userId ? !otherAccessRemains : null,
      decisionsRequired: grants
        .filter((g) => g.system)
        .map((g) => g.roleAssignmentId),
      keepLimit: keepLimit(scope).toISOString(),
    };
  }

  /** Counts for a termination's result. */
  async counts(client: Tx | PrismaService, terminationId: string) {
    const rows = await client.employeeTerminationGrantDecision.groupBy({
      by: ['outcome'],
      where: { terminationId, outcome: { not: null } },
      _count: { _all: true },
    });
    const of = (outcome: string) =>
      rows.find((row) => row.outcome === outcome)?._count._all ?? 0;
    return {
      revoked: of('REVOKED'),
      retained: of('RETAINED'),
      alreadyRevoked: of('ALREADY_REVOKED'),
    };
  }

  private auditInput(
    action: string,
    entityType: string,
    entityId: string,
    context: GrantContext,
    metadata: Record<string, unknown>,
  ) {
    return {
      action,
      actorUserId: context.actorUserId ?? null,
      entityType,
      entityId,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
      correlationId: context.correlationId,
      metadata: JSON.parse(JSON.stringify(metadata)) as Prisma.InputJsonValue,
    };
  }
}
