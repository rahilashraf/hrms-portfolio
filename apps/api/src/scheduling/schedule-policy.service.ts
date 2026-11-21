import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { permissionIsGranted } from '../authorization/authorization.policy.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import type {
  AuthorizationScope,
  AuthorizationTarget,
} from '../authorization/authorization.types.js';
import { PositionAuthorizationTargetResolver } from '../authorization/position-authorization-target.resolver.js';
import {
  featureGateFor,
  FeatureGateService,
} from '../features/feature-gate.service.js';
import { PrismaService } from '../database/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import type { SchedulePolicy } from '../generated/prisma/client.js';
import {
  SCHEDULE_POLICY_FIELDS,
  type SchedulePolicyField,
} from './schedule-policy.js';
import type {
  CreateSchedulePolicyDto,
  EndSchedulePolicyDto,
  ResolveSchedulePolicyQueryDto,
  SchedulePolicyListQueryDto,
  SchedulePolicySettingsDto,
  UpdateSchedulePolicyDto,
} from './schedule-policy.dto.js';
import { SchedulePolicyResolver } from './schedule-policy-resolver.js';
import { addDays, formatDateOnly } from './schedule-recurrence.js';
import { SchedulingDomainService } from './scheduling-domain.service.js';
import type { SchedulingRequestContext } from './scheduling.service.js';

type Client = Prisma.TransactionClient;
type ScopeColumns = Pick<
  SchedulePolicy,
  | 'scopeType'
  | 'organizationId'
  | 'organizationalUnitId'
  | 'departmentId'
  | 'teamId'
>;

const MANAGE_POLICY = 'schedule.manage_policy';
const READ_PERMISSIONS = ['schedule.read', MANAGE_POLICY] as const;

/**
 * Phase 7 Batch 7 — effective-dated SchedulePolicy management. A policy belongs to one exact
 * organizational scope (organization, unit, department, or team; never a WorkLocation). Periods
 * of the same exact scope never overlap; inclusive DATE semantics, so one ending Mar 31 and the
 * next starting Apr 1 touch without overlapping.
 *
 * Policy rows are history, like schedule patterns: a policy that has not taken effect may be
 * edited or deleted; once in effect it can only be ended (its end moved earlier, never into
 * days already past). "In effect" and "past" are judged conservatively against the latest
 * (UTC+14) and earliest (UTC−12) calendar dates current anywhere.
 *
 * Mutations need schedule.manage_policy on the policy scope; reads need schedule.read or
 * schedule.manage_policy there.
 */
@Injectable()
export class SchedulePolicyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly domain: SchedulingDomainService,
    private readonly authorization: AuthorizationService,
    private readonly targets: PositionAuthorizationTargetResolver,
    private readonly resolver: SchedulePolicyResolver,
    private readonly audit: AuditService,
    @Optional() features?: FeatureGateService,
  ) {
    this.features = featureGateFor(prisma, features);
  }

  /** Phase 18: the SCHEDULING module gate. */
  readonly features: FeatureGateService;

  async listPolicies(userId: string, query: SchedulePolicyListQueryDto) {
    const grants = await this.grants(userId, this.prisma);
    const max = Math.min(Math.max(query.limit ?? 25, 1), 100);
    const where: Prisma.SchedulePolicyWhereInput = {
      organizationId: query.organizationId,
      ...(query.scopeType ? { scopeType: query.scopeType } : {}),
      ...(query.organizationalUnitId
        ? { organizationalUnitId: query.organizationalUnitId }
        : {}),
      ...(query.departmentId ? { departmentId: query.departmentId } : {}),
      ...(query.teamId ? { teamId: query.teamId } : {}),
    };
    const visible: SchedulePolicy[] = [];
    const cache = new Map<string, AuthorizationTarget | null>();
    let cursor = query.afterId;
    for (;;) {
      const batch = await this.prisma.schedulePolicy.findMany({
        where,
        orderBy: [{ effectiveFrom: 'desc' }, { id: 'desc' }],
        take: 100,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      for (const row of batch) {
        const target = await this.cachedTarget(row, cache);
        if (target && this.canRead(grants, target)) visible.push(row);
        if (visible.length > max) break;
      }
      if (visible.length > max || batch.length < 100) break;
      cursor = batch.at(-1)!.id;
    }
    const items = visible.slice(0, max);
    if (items.length > 0)
      await this.features.require(query.organizationId, 'SCHEDULING');
    return {
      items: items.map((row) => this.shape(row)),
      nextAfterId: visible.length > max ? (items.at(-1)?.id ?? null) : null,
    };
  }

  async getPolicy(userId: string, policyId: string) {
    const policy = await this.prisma.schedulePolicy.findUnique({
      where: { id: policyId },
    });
    if (!policy) throw new NotFoundException('Schedule policy not found');
    const target = await this.cachedTarget(policy, new Map());
    if (
      !target ||
      !this.canRead(await this.grants(userId, this.prisma), target)
    ) {
      throw new NotFoundException('Schedule policy not found');
    }
    await this.features.require(policy.organizationId, 'SCHEDULING');
    return this.shape(policy);
  }

  /**
   * The policy in effect for an assignment on a date, field by field, with the policy (or the
   * built-in default) each value came from.
   */
  async resolvePolicy(userId: string, query: ResolveSchedulePolicyQueryDto) {
    const date = this.domain.parseDateOnly(query.date, 'date');
    const assignment = await this.prisma.employmentAssignment.findUnique({
      where: { id: query.employmentAssignmentId },
      select: { positionId: true },
    });
    if (!assignment) {
      throw new NotFoundException('EmploymentAssignment not found');
    }
    const target = await this.targets.resolvePosition(
      assignment.positionId,
      undefined,
      this.prisma,
    );
    const grants = await this.grants(userId, this.prisma, true);
    if (
      !this.canRead(grants, target) &&
      !permissionIsGranted(grants, 'schedule.manage', target)
    ) {
      throw new NotFoundException('EmploymentAssignment not found');
    }
    await this.features.require(target.organizationId, 'SCHEDULING');
    const resolved = (
      await this.resolver.forPosition(assignment.positionId, this.prisma)
    ).resolve(date);
    return {
      employmentAssignmentId: query.employmentAssignmentId,
      date: formatDateOnly(date),
      ...resolved,
    };
  }

  async createPolicy(
    input: CreateSchedulePolicyDto,
    context: SchedulingRequestContext,
  ) {
    const actor = this.requireActor(context);
    const scope: ScopeColumns = {
      scopeType: input.scopeType,
      organizationId: input.organizationId,
      organizationalUnitId: input.organizationalUnitId ?? null,
      departmentId: input.departmentId ?? null,
      teamId: input.teamId ?? null,
    };
    this.domain.assertScheduleScopeShape(scope);
    const period = this.parsePeriod(input.effectiveFrom, input.effectiveTo);
    const settings = this.settings(input);
    this.assertHasSetting(settings);

    return this.prisma.$transaction(async (tx) => {
      await this.assertScopeTarget(scope, tx);
      await this.assertCanManage(actor, scope, tx);
      await this.lockScope(scope, tx);
      await this.assertPeriodAvailable(scope, period, null, tx);
      const policy = await tx.schedulePolicy.create({
        data: {
          ...scope,
          name: input.name?.trim() || null,
          ...period,
          ...settings,
        },
      });
      const shaped = this.shape(policy);
      await this.writeAudit(tx, 'SCHEDULE_POLICY_CREATED', policy.id, context, {
        policy: shaped,
      });
      return shaped;
    });
  }

  /** Edits a policy that has not taken effect yet. */
  async updatePolicy(
    policyId: string,
    input: UpdateSchedulePolicyDto,
    context: SchedulingRequestContext,
  ) {
    const actor = this.requireActor(context);
    return this.prisma.$transaction(async (tx) => {
      const policy = await this.lockPolicy(actor, policyId, tx);
      this.assertNotStarted(policy);
      const period = this.parsePeriod(
        input.effectiveFrom ?? formatDateOnly(policy.effectiveFrom),
        input.effectiveTo === undefined
          ? policy.effectiveTo && formatDateOnly(policy.effectiveTo)
          : input.effectiveTo,
      );
      const next = {
        name:
          input.name === undefined ? policy.name : input.name?.trim() || null,
        ...period,
        ...Object.fromEntries(
          SCHEDULE_POLICY_FIELDS.map((field) => [
            field,
            input[field] === undefined ? policy[field] : input[field],
          ]),
        ),
      } as Partial<SchedulePolicy>;
      this.assertHasSetting(next);
      const before = this.shape(policy);
      const after = this.shape({ ...policy, ...next } as SchedulePolicy);
      const changes = Object.fromEntries(
        (
          [
            'name',
            'effectiveFrom',
            'effectiveTo',
            ...SCHEDULE_POLICY_FIELDS,
          ] as const
        )
          .filter((field) => before[field] !== after[field])
          .map((field) => [field, { from: before[field], to: after[field] }]),
      );
      if (Object.keys(changes).length === 0) return before;
      // Moving the start into effect would create history by editing.
      this.assertNotStarted(period);
      if (changes.effectiveFrom || changes.effectiveTo) {
        await this.assertPeriodAvailable(policy, period, policyId, tx);
      }
      const updated = await tx.schedulePolicy.update({
        where: { id: policyId },
        data: next,
      });
      await this.writeAudit(tx, 'SCHEDULE_POLICY_UPDATED', policyId, context, {
        changes,
      });
      return this.shape(updated);
    });
  }

  /**
   * Sets or moves earlier the last day a policy applies; never before yesterday anywhere, and
   * never later than an existing end (a longer policy is a new policy). Idempotent.
   */
  async endPolicy(
    policyId: string,
    input: EndSchedulePolicyDto,
    context: SchedulingRequestContext,
  ) {
    const actor = this.requireActor(context);
    const effectiveTo = this.domain.parseDateOnly(
      input.effectiveTo,
      'effectiveTo',
    );
    return this.prisma.$transaction(async (tx) => {
      const policy = await this.lockPolicy(actor, policyId, tx);
      if (policy.effectiveTo?.getTime() === effectiveTo.getTime()) {
        return this.shape(policy);
      }
      const { earliest } = currentDates();
      if (policy.effectiveTo && policy.effectiveTo < earliest) {
        throw new ConflictException(
          'The policy has already ended; its history cannot be changed.',
        );
      }
      if (policy.effectiveTo && effectiveTo > policy.effectiveTo) {
        throw new BadRequestException(
          'Ending can only shorten a policy; create a new policy to extend it.',
        );
      }
      if (effectiveTo < policy.effectiveFrom) {
        throw new BadRequestException(
          'effectiveTo must be on or after effectiveFrom.',
        );
      }
      if (effectiveTo < addDays(earliest, -1)) {
        throw new BadRequestException(
          'A policy cannot be ended before yesterday; past policy is history.',
        );
      }
      const updated = await tx.schedulePolicy.update({
        where: { id: policyId },
        data: { effectiveTo },
      });
      await this.writeAudit(tx, 'SCHEDULE_POLICY_ENDED', policyId, context, {
        previousEffectiveTo:
          policy.effectiveTo && formatDateOnly(policy.effectiveTo),
        effectiveTo: formatDateOnly(effectiveTo),
      });
      return this.shape(updated);
    });
  }

  /** Only a policy that never took effect can be removed. */
  async deletePolicy(policyId: string, context: SchedulingRequestContext) {
    const actor = this.requireActor(context);
    return this.prisma.$transaction(async (tx) => {
      const policy = await this.lockPolicy(actor, policyId, tx);
      this.assertNotStarted(policy);
      await tx.schedulePolicy.delete({ where: { id: policyId } });
      await this.writeAudit(tx, 'SCHEDULE_POLICY_DELETED', policyId, context, {
        policy: this.shape(policy),
      });
      return { success: true };
    });
  }

  // ─── Validation ─────────────────────────────────────────────────────────────

  private settings(input: SchedulePolicySettingsDto) {
    return Object.fromEntries(
      SCHEDULE_POLICY_FIELDS.map((field) => [field, input[field] ?? null]),
    ) as { [K in SchedulePolicyField]: SchedulePolicy[K] };
  }

  private assertHasSetting(
    values: Partial<Record<SchedulePolicyField, unknown>>,
  ) {
    if (SCHEDULE_POLICY_FIELDS.every((field) => values[field] == null)) {
      throw new BadRequestException(
        'A schedule policy must set at least one setting.',
      );
    }
  }

  private parsePeriod(from: string, to: string | null | undefined) {
    const effectiveFrom = this.domain.parseDateOnly(from, 'effectiveFrom');
    const effectiveTo = to
      ? this.domain.parseDateOnly(to, 'effectiveTo')
      : null;
    if (effectiveTo && effectiveTo < effectiveFrom) {
      throw new BadRequestException(
        'effectiveTo must be on or after effectiveFrom.',
      );
    }
    return { effectiveFrom, effectiveTo };
  }

  /** The caller holds the scope lock, so the check and the write cannot race. */
  private async assertPeriodAvailable(
    scope: ScopeColumns,
    period: { effectiveFrom: Date; effectiveTo: Date | null },
    excludeId: string | null,
    tx: Client,
  ) {
    const overlapping = await tx.schedulePolicy.findFirst({
      where: {
        scopeType: scope.scopeType,
        organizationId: scope.organizationId,
        organizationalUnitId: scope.organizationalUnitId,
        departmentId: scope.departmentId,
        teamId: scope.teamId,
        ...(excludeId ? { id: { not: excludeId } } : {}),
        ...(period.effectiveTo
          ? { effectiveFrom: { lte: period.effectiveTo } }
          : {}),
        OR: [
          { effectiveTo: null },
          { effectiveTo: { gte: period.effectiveFrom } },
        ],
      },
      select: { id: true, effectiveFrom: true, effectiveTo: true },
    });
    if (overlapping) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        code: 'SCHEDULE_POLICY_PERIOD_OVERLAP',
        message:
          'The policy period overlaps another policy for the same scope; end that policy first.',
        overlappingPolicy: {
          id: overlapping.id,
          effectiveFrom: formatDateOnly(overlapping.effectiveFrom),
          effectiveTo:
            overlapping.effectiveTo && formatDateOnly(overlapping.effectiveTo),
        },
      });
    }
  }

  private assertNotStarted(policy: { effectiveFrom: Date }) {
    if (policy.effectiveFrom <= currentDates().latest) {
      throw new ConflictException(
        'The policy is in effect; it can only be ended. Create a new policy to change settings.',
      );
    }
  }

  private async assertScopeTarget(scope: ScopeColumns, tx: Client) {
    const organization = await tx.organization.findUnique({
      where: { id: scope.organizationId },
    });
    if (!organization) throw new NotFoundException('Organization not found');
    if (organization.archivedAt) {
      throw new BadRequestException(
        'Policies cannot be scoped to an archived organization.',
      );
    }
    if (scope.scopeType === 'ORGANIZATION') return;
    const target = scope.organizationalUnitId
      ? await tx.organizationalUnit.findUnique({
          where: { id: scope.organizationalUnitId },
        })
      : scope.departmentId
        ? await tx.department.findUnique({ where: { id: scope.departmentId } })
        : await tx.team.findUnique({ where: { id: scope.teamId! } });
    if (!target) throw new NotFoundException('Policy scope target not found');
    this.domain.assertScopeTargetOrganization(
      scope.organizationId,
      target.organizationId,
    );
    if (target.archivedAt) {
      throw new BadRequestException(
        'Policies cannot be scoped to an archived organizational target.',
      );
    }
  }

  // ─── Access ─────────────────────────────────────────────────────────────────

  /** Serializes period checks per exact scope (policies have no natural unique key). */
  private async lockScope(scope: ScopeColumns, tx: Client) {
    const key = `schedule-policy:${scope.scopeType}:${
      scope.teamId ??
      scope.departmentId ??
      scope.organizationalUnitId ??
      scope.organizationId
    }`;
    await tx.$executeRaw(
      Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`,
    );
  }

  /** Loads a policy for change under its scope lock and its own row lock. */
  private async lockPolicy(actor: string, policyId: string, tx: Client) {
    const found = await tx.schedulePolicy.findUnique({
      where: { id: policyId },
    });
    if (!found) throw new NotFoundException('Schedule policy not found');
    const target = await this.cachedTarget(found, new Map(), tx);
    if (!target || !this.canRead(await this.grants(actor, tx), target)) {
      throw new NotFoundException('Schedule policy not found');
    }
    await this.assertCanManage(actor, found, tx);
    await this.lockScope(found, tx);
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "SchedulePolicy" WHERE "id" = ${policyId}::uuid FOR UPDATE`,
    );
    const policy = await tx.schedulePolicy.findUnique({
      where: { id: policyId },
    });
    if (!policy) throw new NotFoundException('Schedule policy not found');
    return policy;
  }

  private async assertCanManage(
    actor: string,
    scope: ScopeColumns,
    tx: Client,
  ) {
    const grants = await this.grants(actor, tx);
    const target = await this.authorization.resolveTarget(
      this.authorizationScope(scope),
      tx,
    );
    if (!permissionIsGranted(grants, MANAGE_POLICY, target)) {
      throw new ForbiddenException(
        'Missing permission schedule.manage_policy for the policy scope.',
      );
    }
    await this.features.require(scope.organizationId, 'SCHEDULING', tx);
  }

  private async grants(
    userId: string,
    client: Client | PrismaService,
    includeManage = false,
  ) {
    return (
      await this.authorization.effectiveGrants(userId, new Date(), client)
    ).filter(
      (grant) =>
        (READ_PERMISSIONS as readonly string[]).includes(grant.permission) ||
        (includeManage && grant.permission === 'schedule.manage'),
    );
  }

  private canRead(
    grants: Awaited<ReturnType<SchedulePolicyService['grants']>>,
    target: AuthorizationTarget,
  ) {
    return READ_PERMISSIONS.some((permission) =>
      permissionIsGranted(grants, permission, target),
    );
  }

  private async cachedTarget(
    scope: ScopeColumns,
    cache: Map<string, AuthorizationTarget | null>,
    client: Client | PrismaService = this.prisma,
  ) {
    const authorizationScope = this.authorizationScope(scope);
    const key = `${authorizationScope.type}:${authorizationScope.id}`;
    if (!cache.has(key)) {
      try {
        cache.set(
          key,
          await this.authorization.resolveTarget(authorizationScope, client),
        );
      } catch (error) {
        if (!(error instanceof NotFoundException)) throw error;
        cache.set(key, null);
      }
    }
    return cache.get(key) ?? null;
  }

  private authorizationScope(scope: ScopeColumns): AuthorizationScope {
    const organizationId = scope.organizationId;
    switch (scope.scopeType) {
      case 'ORGANIZATION':
        return { type: 'ORGANIZATION', id: organizationId, organizationId };
      case 'ORGANIZATIONAL_UNIT':
        return {
          type: 'ORGANIZATIONAL_UNIT',
          id: scope.organizationalUnitId ?? undefined,
          organizationId,
        };
      case 'DEPARTMENT':
        return {
          type: 'DEPARTMENT',
          id: scope.departmentId ?? undefined,
          organizationId,
        };
      case 'TEAM':
        return { type: 'TEAM', id: scope.teamId ?? undefined, organizationId };
    }
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  private requireActor(context: SchedulingRequestContext) {
    if (!context.actorUserId) throw new ForbiddenException();
    return context.actorUserId;
  }

  private shape(policy: SchedulePolicy) {
    return {
      id: policy.id,
      scopeType: policy.scopeType,
      organizationId: policy.organizationId,
      organizationalUnitId: policy.organizationalUnitId,
      departmentId: policy.departmentId,
      teamId: policy.teamId,
      name: policy.name,
      effectiveFrom: formatDateOnly(policy.effectiveFrom),
      effectiveTo: policy.effectiveTo && formatDateOnly(policy.effectiveTo),
      ...(Object.fromEntries(
        SCHEDULE_POLICY_FIELDS.map((field) => [field, policy[field]]),
      ) as Pick<SchedulePolicy, SchedulePolicyField>),
      createdAt: policy.createdAt.toISOString(),
      updatedAt: policy.updatedAt.toISOString(),
    };
  }

  private writeAudit(
    client: Client,
    action: string,
    policyId: string,
    context: SchedulingRequestContext,
    metadata: Record<string, unknown>,
  ) {
    return this.audit.write(
      {
        action,
        actorUserId: context.actorUserId,
        entityType: 'SchedulePolicy',
        entityId: policyId,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
        correlationId: context.correlationId,
        metadata: JSON.parse(JSON.stringify(metadata)) as Prisma.InputJsonValue,
      },
      client,
    );
  }
}

/** The earliest (UTC−12) and latest (UTC+14) calendar dates currently in effect anywhere. */
function currentDates(now = Date.now()) {
  const date = (offsetHours: number) =>
    new Date(
      new Date(now + offsetHours * 3_600_000).toISOString().slice(0, 10),
    );
  return { earliest: date(-12), latest: date(14) };
}
