import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { isIanaTimezone } from '../common/timezone.js';
import { permissionIsGranted } from '../authorization/authorization.policy.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import type {
  AuthorizationScope,
  EffectiveGrant,
} from '../authorization/authorization.types.js';
import { PositionAuthorizationTargetResolver } from '../authorization/position-authorization-target.resolver.js';
import {
  featureGateFor,
  FeatureGateService,
} from '../features/feature-gate.service.js';
import { PrismaService } from '../database/prisma.service.js';
import { EmployeeDomainService } from '../employee/employee-domain.service.js';
import { Prisma } from '../generated/prisma/client.js';
import type {
  EmployeeSchedulePatternRule,
  ScheduleScopeType,
} from '../generated/prisma/client.js';
import {
  addDays,
  dayOfWeekOf,
  formatDateOnly,
  LocalTimeError,
  occurrenceKey,
  resolveOccurrence,
  rotationWeekOf,
  timeColumnToMinute,
  weekStartOf,
} from './schedule-recurrence.js';
import { SchedulingDomainService } from './scheduling-domain.service.js';
import {
  conflictPolicyOf,
  DEFAULT_SCHEDULE_POLICY,
  type ResolvedSchedulePolicy,
} from './schedule-policy.js';
import { SchedulePolicyResolver } from './schedule-policy-resolver.js';
import type { SchedulePeriodType } from '../generated/prisma/enums.js';
import type { SchedulingRequestContext } from './scheduling.service.js';

type Client = Prisma.TransactionClient;

/**
 * Built-in rolling horizon, used only when no effective SchedulePolicy sets
 * generationHorizonDays (Batch 7).
 */
export const DEFAULT_GENERATION_HORIZON_DAYS =
  DEFAULT_SCHEDULE_POLICY.generationHorizonDays;
/** Upper bound for an explicit range, keeping one generation transaction bounded. */
export const MAX_GENERATION_RANGE_DAYS = 366;

export type GenerationIssueCode =
  /** Blocked: Batch 3 and policy conflict rules; generation never creates overrides. */
  | 'SAME_ASSIGNMENT_OVERLAP'
  | 'EMPLOYEE_ASSIGNMENT_OVERLAP'
  | 'MINIMUM_REST_VIOLATION'
  | 'MAXIMUM_SHIFT_DURATION_EXCEEDED'
  /** Blocked: no open container exists and the policy does not auto-create Schedules. */
  | 'SCHEDULE_CONTAINER_MISSING'
  /** Blocked: the week's Schedule is already published; use the published add workflow. */
  | 'SCHEDULE_PERIOD_PUBLISHED'
  /** Errors: the occurrence cannot be resolved to a valid concrete shift. */
  | 'LOCAL_TIME_NONEXISTENT'
  | 'WORK_LOCATION_ARCHIVED'
  | 'TIMEZONE_UNRESOLVABLE'
  | 'SCHEDULE_SCOPE_UNAVAILABLE'
  /** Error: the policy requires a WorkLocation and the rule has none. */
  | 'WORK_LOCATION_REQUIRED'
  /** Notice: a fall-back repeated wall-clock time resolved to its earlier instant. */
  | 'LOCAL_TIME_AMBIGUOUS';

export interface GenerationIssue {
  patternId: string;
  ruleId: string;
  workDate: string;
  occurrenceKey: string;
  code: GenerationIssueCode;
  message: string;
  conflictingShiftId?: string;
}

export interface PatternGenerationResult {
  patternId: string;
  employmentAssignmentId: string;
  range: { from: string; to: string };
  created: number;
  updated: number;
  unchanged: number;
  removed: number;
  /** Generated shifts left untouched because they are published, cancelled, or have history. */
  protected: number;
  schedulesCreated: string[];
  blocked: GenerationIssue[];
  errors: GenerationIssue[];
  notices: GenerationIssue[];
}

export interface GenerationRange {
  from: Date;
  /** null: the resolved policy's generationHorizonDays from `from`. */
  to: Date | null;
}

/** Container scope chosen from the assignment's position: its narrowest placement. */
interface ContainerScope {
  scopeType: ScheduleScopeType;
  organizationId: string;
  organizationalUnitId: string | null;
  departmentId: string | null;
  teamId: string | null;
}

interface Occurrence {
  key: string;
  rule: EmployeeSchedulePatternRule;
  localDate: Date;
}

interface DesiredShift {
  scheduleId: string;
  employmentAssignmentId: string;
  workLocationId: string | null;
  workDate: Date;
  startsAt: Date;
  endsAt: Date;
  timezone: string;
}

/** A week's container: an open DRAFT Schedule, or why the week cannot take new shifts. */
type ContainerSlot =
  { scheduleId: string } | { blocked: 'PUBLISHED' | 'UNAVAILABLE' | 'MISSING' };

interface Actor {
  /** Absent for trusted internal (worker) execution. */
  userId?: string;
  grants?: EffectiveGrant[];
}

/**
 * Phase 7 Batch 6 — materializes EmployeeSchedulePatterns into concrete PATTERN ScheduledShift
 * rows in DRAFT Schedules. After generation the ScheduledShift is the operational expected-work
 * record; the pattern and rule are provenance only.
 *
 * Generation is deterministic and idempotent: every occurrence has a stable key (pattern, rule,
 * local date) that is unique in the database, so re-running a range converges to the same set.
 * Reconciliation only ever touches generator-owned shifts: PATTERN, ACTIVE, in a DRAFT Schedule,
 * with no revision history. Generated drafts cannot be edited through the MANUAL draft routes,
 * so such a shift is by construction untouched. Published, cancelled, or corrected shifts are
 * never modified or removed, and MANUAL shifts are never touched.
 *
 * Containers: each occurrence lands in the STANDARD DRAFT Schedule for its Monday–Sunday week,
 * scoped to the assignment position's narrowest placement (team, department, unit, else
 * organization). The weekly convention is isolated in containerPeriod() for Batch 7 policy.
 * If that week's Schedule is already PUBLISHED, the occurrence is blocked rather than placed in
 * a new draft; additions to published weeks go through the explicit Batch 4 workflow.
 *
 * Locks, in this order: EmploymentAssignment (serializes generation with pattern changes and
 * with other generation of the same assignment) → per-week container advisory lock (sorted) →
 * Schedule rows FOR UPDATE (id order) → Employee FOR NO KEY UPDATE (Batch 3 conflict lock).
 */
@Injectable()
export class ShiftGenerationService {
  private readonly logger = new Logger(ShiftGenerationService.name);
  private readonly policies: SchedulePolicyResolver;

  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService,
    private readonly targets: PositionAuthorizationTargetResolver,
    private readonly domain: SchedulingDomainService,
    private readonly audit: AuditService,
    @Optional() policies?: SchedulePolicyResolver,
    @Optional() features?: FeatureGateService,
  ) {
    this.policies = policies ?? new SchedulePolicyResolver(prisma, targets);
    this.features = featureGateFor(prisma, features);
  }

  /** Phase 18: the SCHEDULING module gate. */
  readonly features: FeatureGateService;

  /**
   * Manual generation for one pattern. Requires schedule.manage_patterns on the assignment and
   * schedule.manage on the Schedule scope its shifts land in. Atomic and audited.
   */
  async generateForPattern(
    assignmentId: string,
    patternId: string,
    input: { from?: string; to?: string },
    context: SchedulingRequestContext,
  ) {
    const actorUserId = context.actorUserId;
    if (!actorUserId) throw new ForbiddenException();
    const range = this.parseRange(input);

    return this.prisma.$transaction(
      async (tx) => {
        await this.lockAssignment(assignmentId, tx);
        const grants = (
          await this.authorization.effectiveGrants(actorUserId, new Date(), tx)
        ).filter((grant) =>
          [
            'schedule.read',
            'schedule.manage',
            'schedule.manage_patterns',
          ].includes(grant.permission),
        );
        const assignment = await tx.employmentAssignment.findUnique({
          where: { id: assignmentId },
          select: { positionId: true },
        });
        if (!assignment) {
          throw new NotFoundException('EmploymentAssignment not found');
        }
        const target = await this.targets.resolvePosition(
          assignment.positionId,
          undefined,
          tx,
        );
        if (
          !permissionIsGranted(grants, 'schedule.read', target) &&
          !permissionIsGranted(grants, 'schedule.manage_patterns', target)
        ) {
          throw new NotFoundException('EmploymentAssignment not found');
        }
        if (!permissionIsGranted(grants, 'schedule.manage_patterns', target)) {
          throw new ForbiddenException(
            'Missing permission schedule.manage_patterns for the employment assignment scope.',
          );
        }
        await this.features.require(target.organizationId, 'SCHEDULING', tx);
        const pattern = await tx.employeeSchedulePattern.findFirst({
          where: { id: patternId, employmentAssignmentId: assignmentId },
          select: { id: true },
        });
        if (!pattern) throw new NotFoundException('Schedule pattern not found');

        const result = await this.generate(
          patternId,
          range,
          { userId: actorUserId, grants },
          context,
          tx,
        );
        await this.audit.write(
          {
            action: 'SCHEDULE_PATTERN_GENERATED',
            actorUserId,
            entityType: 'EmployeeSchedulePattern',
            entityId: patternId,
            ipAddress: context.ipAddress,
            userAgent: context.userAgent,
            correlationId: context.correlationId,
            metadata: summary(result) as Prisma.InputJsonValue,
          },
          tx,
        );
        return result;
      },
      { timeout: 60_000 },
    );
  }

  /**
   * Background extension: generates every pattern that is effective in the rolling horizon, or
   * still has generated drafts to reconcile, up to asOf + horizonDays. Each pattern runs in its
   * own transaction as trusted internal work, so one failure never affects another. Idempotent
   * however often it runs; no-op runs write nothing.
   */
  async extendGeneratedShifts(
    options: {
      asOf?: Date;
      horizonDays?: number;
      organizationId?: string;
    } = {},
  ) {
    const from = earliestCurrentDate(options.asOf ?? new Date());
    // An explicit horizon applies to every pattern; otherwise each pattern's own resolved
    // policy decides, so candidates are selected over the longest possible horizon.
    const to =
      options.horizonDays === undefined
        ? null
        : addDays(from, options.horizonDays);
    const selectTo = to ?? addDays(from, MAX_GENERATION_RANGE_DAYS);
    const outcome = {
      range: { from: formatDateOnly(from), to: to && formatDateOnly(to) },
      patterns: 0,
      succeeded: 0,
      failed: [] as Array<{ patternId: string; message: string }>,
      totals: {
        created: 0,
        updated: 0,
        removed: 0,
        blocked: 0,
        errors: 0,
      },
      /** Phase 18: organizations skipped because Scheduling is disabled for them. */
      skippedOrganizations: [
        ...(await this.features.disabledOrganizations('SCHEDULING')),
      ]
        .filter(
          (id) => !options.organizationId || id === options.organizationId,
        )
        .sort(),
    };
    const disabled = [
      ...(await this.features.disabledOrganizations('SCHEDULING')),
    ];
    let cursor: string | undefined;
    for (;;) {
      const batch = await this.prisma.employeeSchedulePattern.findMany({
        where: {
          AND: [
            {
              employmentAssignment: {
                position: { organizationId: { notIn: disabled } },
              },
            },
          ],
          ...(options.organizationId
            ? {
                employmentAssignment: {
                  position: { organizationId: options.organizationId },
                },
              }
            : {}),
          OR: [
            {
              effectiveFrom: { lte: selectTo },
              OR: [{ effectiveTo: null }, { effectiveTo: { gte: from } }],
              employmentAssignment: { status: { not: 'CANCELLED' } },
            },
            {
              generatedShifts: {
                some: {
                  workDate: { gte: from },
                  schedule: { status: 'DRAFT' },
                },
              },
            },
          ],
        },
        select: { id: true },
        orderBy: { id: 'asc' },
        take: 200,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      for (const { id } of batch) {
        outcome.patterns += 1;
        try {
          const result = await this.prisma.$transaction(
            async (tx) => {
              const row = await tx.employeeSchedulePattern.findUnique({
                where: { id },
                select: { employmentAssignmentId: true },
              });
              if (!row) return null;
              await this.lockAssignment(row.employmentAssignmentId, tx);
              return this.generate(id, { from, to }, {}, {}, tx);
            },
            { timeout: 60_000 },
          );
          outcome.succeeded += 1;
          if (!result) continue;
          outcome.totals.created += result.created;
          outcome.totals.updated += result.updated;
          outcome.totals.removed += result.removed;
          outcome.totals.blocked += result.blocked.length;
          outcome.totals.errors += result.errors.length;
          if (result.blocked.length > 0 || result.errors.length > 0) {
            this.logger.warn(
              `Pattern ${id}: ${result.blocked.length} blocked and ${result.errors.length} failed occurrence(s).`,
            );
          }
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          outcome.failed.push({ patternId: id, message });
          this.logger.error(`Generation failed for pattern ${id}: ${message}`);
        }
      }
      if (batch.length < 200) break;
      cursor = batch.at(-1)!.id;
    }
    return outcome;
  }

  // ─── Generation ─────────────────────────────────────────────────────────────

  /** Generates and reconciles one pattern's occurrences. The caller holds the assignment lock. */
  private async generate(
    patternId: string,
    range: GenerationRange,
    actor: Actor,
    context: SchedulingRequestContext,
    tx: Client,
  ): Promise<PatternGenerationResult> {
    const pattern = await tx.employeeSchedulePattern.findUniqueOrThrow({
      where: { id: patternId },
      include: {
        rules: true,
        employmentAssignment: {
          select: {
            id: true,
            employeeId: true,
            status: true,
            startDate: true,
            endDate: true,
            positionId: true,
            position: {
              select: {
                organizationId: true,
                organizationalUnitId: true,
                departmentId: true,
                teamId: true,
              },
            },
          },
        },
      },
    });
    const assignment = pattern.employmentAssignment;
    const policies = await this.policies.forPosition(assignment.positionId, tx);
    const rangeTo =
      range.to ??
      addDays(range.from, policies.resolve(range.from).generationHorizonDays);
    const result: PatternGenerationResult = {
      patternId,
      employmentAssignmentId: assignment.id,
      range: { from: formatDateOnly(range.from), to: formatDateOnly(rangeTo) },
      created: 0,
      updated: 0,
      unchanged: 0,
      removed: 0,
      protected: 0,
      schedulesCreated: [],
      blocked: [],
      errors: [],
      notices: [],
    };

    // Generated shifts of this pattern from the range start on; earlier ones are history.
    const existing = await tx.scheduledShift.findMany({
      where: { sourcePatternId: patternId, workDate: { gte: range.from } },
      include: {
        schedule: { select: { status: true } },
        _count: { select: { revisions: true } },
      },
    });
    // Reconcile beyond the requested end too, so drafts left by an earlier, longer run or by a
    // pattern that has since ended are cleaned up.
    const reconcileTo = existing.reduce(
      (latest, row) => (row.workDate > latest ? row.workDate : latest),
      rangeTo,
    );

    const occurrences = this.expand(
      pattern,
      assignment,
      range.from,
      reconcileTo,
    );
    const scope = containerScope(assignment.position);
    if (actor.userId) await this.assertCanManageScope(actor, scope, tx);

    // Resolve each occurrence to its concrete interval; failures are per occurrence.
    const locations = new Map(
      (
        await tx.workLocation.findMany({
          where: {
            id: {
              in: [
                ...new Set(
                  pattern.rules
                    .map((rule) => rule.workLocationId)
                    .filter((id): id is string => !!id),
                ),
              ],
            },
          },
          select: { id: true, timezone: true, archivedAt: true },
        })
      ).map((row) => [row.id, row]),
    );
    const resolved: Array<{
      occurrence: Occurrence;
      desired: Omit<DesiredShift, 'scheduleId'>;
      policy: ResolvedSchedulePolicy;
    }> = [];
    const failed = new Map<string, GenerationIssue>();
    for (const occurrence of occurrences) {
      const issue = (code: GenerationIssueCode, message: string) =>
        this.issue(pattern.id, occurrence, code, message);
      const policy = policies.resolve(occurrence.localDate);
      if (policy.requireWorkLocation && !occurrence.rule.workLocationId) {
        failed.set(
          occurrence.key,
          issue(
            'WORK_LOCATION_REQUIRED',
            'The scheduling policy requires a WorkLocation and the rule has none.',
          ),
        );
        continue;
      }
      const location = occurrence.rule.workLocationId
        ? locations.get(occurrence.rule.workLocationId)
        : null;
      if (location?.archivedAt) {
        failed.set(
          occurrence.key,
          issue('WORK_LOCATION_ARCHIVED', 'The rule WorkLocation is archived.'),
        );
        continue;
      }
      const timezone = location?.timezone || occurrence.rule.timezone;
      if (!timezone || !isIanaTimezone(timezone)) {
        failed.set(
          occurrence.key,
          issue(
            'TIMEZONE_UNRESOLVABLE',
            'The rule has no valid IANA timezone from its WorkLocation or explicit fallback.',
          ),
        );
        continue;
      }
      try {
        const interval = resolveOccurrence(
          occurrence.localDate,
          {
            startMinute: timeColumnToMinute(occurrence.rule.startLocalTime),
            endMinute: timeColumnToMinute(occurrence.rule.endLocalTime),
          },
          timezone.trim(),
        );
        if (interval.ambiguous) {
          result.notices.push(
            issue(
              'LOCAL_TIME_AMBIGUOUS',
              'A repeated fall-back local time was resolved to its earlier instant.',
            ),
          );
        }
        resolved.push({
          occurrence,
          policy,
          desired: {
            employmentAssignmentId: assignment.id,
            workLocationId: occurrence.rule.workLocationId,
            workDate: interval.workDate,
            startsAt: interval.startsAt,
            endsAt: interval.endsAt,
            timezone: timezone.trim(),
          },
        });
      } catch (error) {
        if (!(error instanceof LocalTimeError)) throw error;
        failed.set(occurrence.key, issue(error.code, error.message));
      }
    }

    // Containers: one STANDARD DRAFT Schedule per policy period (weekly), found or created
    // under a per-period lock. The period and auto-creation come from the occurrence's policy.
    const periods = new Map<
      string,
      { start: Date; period: SchedulePeriodType; autoCreate: boolean }
    >();
    for (const { desired, policy } of resolved) {
      const { periodStart } = containerPeriod(
        desired.workDate,
        policy.defaultSchedulePeriod,
      );
      const key = formatDateOnly(periodStart);
      if (!periods.has(key)) {
        periods.set(key, {
          start: periodStart,
          period: policy.defaultSchedulePeriod,
          autoCreate: policy.autoCreateSchedules,
        });
      }
    }
    const containers = new Map<string, ContainerSlot>();
    if (periods.size > 0) {
      const scopeAvailable = await this.scopeAvailable(scope, tx);
      for (const [key, period] of [...periods].sort(([a], [b]) =>
        a.localeCompare(b),
      )) {
        containers.set(
          key,
          scopeAvailable
            ? await this.container(scope, period, context, result, tx)
            : { blocked: 'UNAVAILABLE' },
        );
      }
    }

    // Hold every Schedule this run writes to, then the Employee, in the shared lock order.
    const scheduleIds = [
      ...new Set([
        ...[...containers.values()].flatMap((slot) =>
          'scheduleId' in slot ? [slot.scheduleId] : [],
        ),
        ...existing.map((row) => row.scheduleId),
      ]),
    ].sort();
    const statuses = new Map<string, string>();
    if (scheduleIds.length > 0) {
      const locked = await tx.$queryRaw<Array<{ id: string; status: string }>>(
        Prisma.sql`SELECT "id", "status"::text AS "status" FROM "Schedule" WHERE "id" IN (${Prisma.join(
          scheduleIds.map((id) => Prisma.sql`${id}::uuid`),
        )}) ORDER BY "id" FOR UPDATE`,
      );
      for (const row of locked) statuses.set(row.id, row.status);
    }
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "Employee" WHERE "id" = ${assignment.employeeId}::uuid FOR NO KEY UPDATE`,
    );

    // Re-read generated shifts under the locks: state may have changed since the first read.
    const current = await tx.scheduledShift.findMany({
      where: { sourcePatternId: patternId, workDate: { gte: range.from } },
      include: { _count: { select: { revisions: true } } },
    });
    const isProtected = (row: (typeof current)[number]) =>
      statuses.get(row.scheduleId) !== 'DRAFT' ||
      row.status !== 'ACTIVE' ||
      row._count.revisions > 0;
    const byKey = new Map(
      current.map((row) => [row.sourceOccurrenceKey!, row]),
    );
    const expectedKeys = new Set(
      occurrences.map((occurrence) => occurrence.key),
    );

    // The Employee's active expected work around the window, kept current as this run writes.
    const windowStart = addDays(range.from, -2);
    const windowEnd = addDays(reconcileTo, 3);
    const active = await tx.scheduledShift.findMany({
      where: {
        status: 'ACTIVE',
        startsAt: { lt: windowEnd },
        endsAt: { gt: windowStart },
        employmentAssignment: { employeeId: assignment.employeeId },
      },
      select: {
        id: true,
        scheduleId: true,
        employmentAssignmentId: true,
        workDate: true,
        startsAt: true,
        endsAt: true,
        status: true,
      },
    });
    const activeById = new Map(active.map((row) => [row.id, row]));

    const remove = async (row: (typeof current)[number]) => {
      await tx.scheduleConflictOverride.deleteMany({
        where: { scheduledShiftId: row.id },
      });
      await tx.scheduledShift.delete({ where: { id: row.id } });
      activeById.delete(row.id);
      byKey.delete(row.sourceOccurrenceKey!);
      result.removed += 1;
    };

    // 1. Generated shifts whose occurrence no longer exists: remove untouched drafts only.
    for (const row of current) {
      if (expectedKeys.has(row.sourceOccurrenceKey!)) continue;
      if (isProtected(row)) result.protected += 1;
      else await remove(row);
    }

    // 2. Occurrences that cannot be materialized: report, and drop a stale untouched draft.
    for (const occurrence of occurrences) {
      const issue = failed.get(occurrence.key);
      if (!issue) continue;
      result.errors.push(issue);
      const row = byKey.get(occurrence.key);
      if (row && isProtected(row)) result.protected += 1;
      else if (row) await remove(row);
    }

    // 3. Create, update, or keep each resolvable occurrence, in time order.
    resolved.sort(
      (a, b) => a.desired.startsAt.getTime() - b.desired.startsAt.getTime(),
    );
    for (const { occurrence, desired, policy } of resolved) {
      const row = byKey.get(occurrence.key);
      if (row && isProtected(row)) {
        result.protected += 1;
        continue;
      }
      // Past the requested range, existing drafts are reconciled but nothing new is created.
      if (!row && desired.workDate > rangeTo) continue;
      const block = (
        code: GenerationIssueCode,
        message: string,
        id?: string,
      ) => {
        result.blocked.push({
          ...this.issue(pattern.id, occurrence, code, message),
          ...(id ? { conflictingShiftId: id } : {}),
        });
      };

      const week = formatDateOnly(
        containerPeriod(desired.workDate, policy.defaultSchedulePeriod)
          .periodStart,
      );
      const container = containers.get(week);
      let issue: [GenerationIssueCode, string, string?] | null = null;
      const scheduleId =
        container && 'scheduleId' in container ? container.scheduleId : null;
      if (
        container &&
        'blocked' in container &&
        container.blocked === 'UNAVAILABLE'
      ) {
        result.errors.push(
          this.issue(
            pattern.id,
            occurrence,
            'SCHEDULE_SCOPE_UNAVAILABLE',
            "The Schedule scope for the assignment's position is archived or missing.",
          ),
        );
        if (row) await remove(row);
        continue;
      }
      if (
        container &&
        'blocked' in container &&
        container.blocked === 'MISSING'
      ) {
        issue = [
          'SCHEDULE_CONTAINER_MISSING',
          `No draft Schedule exists for the period starting ${week} and the scheduling policy does not auto-create Schedules.`,
        ];
      } else if (!scheduleId || statuses.get(scheduleId) !== 'DRAFT') {
        issue = [
          'SCHEDULE_PERIOD_PUBLISHED',
          `The Schedule for the week of ${week} is published or no longer an open draft; add shifts to a published week explicitly.`,
        ];
      }
      const target: DesiredShift | null = issue
        ? null
        : { ...desired, scheduleId: scheduleId! };
      if (row && target && sameShift(row, target)) {
        result.unchanged += 1;
        continue;
      }
      if (target) {
        const conflict = this.domain.detectShiftConflicts(
          {
            ...(row ? { id: row.id } : {}),
            employeeId: assignment.employeeId,
            employmentAssignmentId: target.employmentAssignmentId,
            startsAt: target.startsAt,
            endsAt: target.endsAt,
          },
          [...activeById.values()].map((shift) => ({
            ...shift,
            employeeId: assignment.employeeId,
          })),
          conflictPolicyOf(policy),
        )[0];
        if (conflict) {
          issue = [
            conflict.type,
            conflict.message,
            conflict.conflictingShift?.id,
          ];
        }
      }
      if (issue) {
        block(...issue);
        if (row) await remove(row);
        continue;
      }

      const generatedAt = new Date();
      if (row) {
        const updated = await tx.scheduledShift.update({
          where: { id: row.id },
          data: { ...target!, generatedAt },
        });
        activeById.set(updated.id, updated);
        result.updated += 1;
      } else {
        const created = await tx.scheduledShift.create({
          data: {
            ...target!,
            status: 'ACTIVE',
            sourceType: 'PATTERN',
            sourcePatternId: pattern.id,
            sourcePatternRuleId: occurrence.rule.id,
            sourceOccurrenceKey: occurrence.key,
            generatedAt,
          },
        });
        activeById.set(created.id, created);
        result.created += 1;
      }
    }
    return result;
  }

  /**
   * Occurrences of the pattern on each local date in [from, to] that is inside the pattern's
   * effective period and the assignment's lifecycle: the rules whose 0-based weekIndex is the
   * date's rotation week (whole weeks from the Monday anchor) and whose weekday matches.
   */
  private expand(
    pattern: {
      id: string;
      effectiveFrom: Date;
      effectiveTo: Date | null;
      rotationWeeks: number;
      anchorDate: Date;
      rules: EmployeeSchedulePatternRule[];
    },
    assignment: {
      status: 'PLANNED' | 'ACTIVE' | 'ENDED' | 'CANCELLED';
      startDate: Date;
      endDate: Date | null;
    },
    from: Date,
    to: Date,
  ): Occurrence[] {
    const start = max(from, pattern.effectiveFrom);
    const end = pattern.effectiveTo ? min(to, pattern.effectiveTo) : to;
    const occurrences: Occurrence[] = [];
    for (let date = start; date <= end; date = addDays(date, 1)) {
      if (!EmployeeDomainService.isEffectiveOn(assignment, date)) continue;
      const week = rotationWeekOf(
        pattern.anchorDate,
        date,
        pattern.rotationWeeks,
      );
      const day = dayOfWeekOf(date);
      for (const rule of pattern.rules) {
        if (rule.weekIndex !== week || rule.dayOfWeek !== day) continue;
        occurrences.push({
          key: occurrenceKey(pattern.id, rule.id, date),
          rule,
          localDate: date,
        });
      }
    }
    return occurrences;
  }

  // ─── Containers ─────────────────────────────────────────────────────────────

  /**
   * The STANDARD Schedule for one week and scope. A per-week transaction advisory lock makes
   * find-or-create race-free (Schedules have no natural unique key: users may also create
   * drafts). An existing DRAFT is reused (oldest first); a PUBLISHED one blocks the week.
   */
  private async container(
    scope: ContainerScope,
    slot: { start: Date; period: SchedulePeriodType; autoCreate: boolean },
    context: SchedulingRequestContext,
    result: PatternGenerationResult,
    tx: Client,
  ): Promise<ContainerSlot> {
    const period = containerPeriod(slot.start, slot.period);
    const scopeId =
      scope.teamId ??
      scope.departmentId ??
      scope.organizationalUnitId ??
      scope.organizationId;
    const lockKey = `schedule-container:${scope.scopeType}:${scopeId}:${formatDateOnly(period.periodStart)}`;
    await tx.$executeRaw(
      Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`,
    );
    const schedules = await tx.schedule.findMany({
      where: {
        ...scope,
        type: 'STANDARD',
        periodStart: period.periodStart,
        periodEnd: period.periodEnd,
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true, status: true },
    });
    if (schedules.some((row) => row.status === 'PUBLISHED')) {
      return { blocked: 'PUBLISHED' };
    }
    if (schedules[0]) return { scheduleId: schedules[0].id };
    if (!slot.autoCreate) return { blocked: 'MISSING' };

    const schedule = await tx.schedule.create({
      data: {
        ...scope,
        name: `Week of ${formatDateOnly(period.periodStart)}`,
        ...period,
        type: 'STANDARD',
        status: 'DRAFT',
      },
    });
    result.schedulesCreated.push(schedule.id);
    await this.audit.write(
      {
        action: 'SCHEDULE_CREATED',
        actorUserId: context.actorUserId,
        entityType: 'Schedule',
        entityId: schedule.id,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
        correlationId: context.correlationId,
        metadata: {
          generated: true,
          patternId: result.patternId,
          schedule: {
            id: schedule.id,
            ...scope,
            name: schedule.name,
            periodStart: formatDateOnly(schedule.periodStart),
            periodEnd: formatDateOnly(schedule.periodEnd),
            type: schedule.type,
            status: schedule.status,
          },
        },
      },
      tx,
    );
    return { scheduleId: schedule.id };
  }

  /** The organization and scope target must exist and be active, as for any new Schedule. */
  private async scopeAvailable(scope: ContainerScope, tx: Client) {
    const organization = await tx.organization.findUnique({
      where: { id: scope.organizationId },
      select: { archivedAt: true },
    });
    if (!organization || organization.archivedAt) return false;
    const select = { archivedAt: true, organizationId: true };
    const target = scope.teamId
      ? await tx.team.findUnique({ where: { id: scope.teamId }, select })
      : scope.departmentId
        ? await tx.department.findUnique({
            where: { id: scope.departmentId },
            select,
          })
        : scope.organizationalUnitId
          ? await tx.organizationalUnit.findUnique({
              where: { id: scope.organizationalUnitId },
              select,
            })
          : null;
    if (scope.scopeType === 'ORGANIZATION') return true;
    return (
      !!target &&
      !target.archivedAt &&
      target.organizationId === scope.organizationId
    );
  }

  /** Writing shifts into a Schedule requires schedule.manage on its scope (Batch 2 rule). */
  private async assertCanManageScope(
    actor: Actor,
    scope: ContainerScope,
    tx: Client,
  ) {
    const authorizationScope: AuthorizationScope = {
      type: scope.scopeType,
      id:
        scope.teamId ??
        scope.departmentId ??
        scope.organizationalUnitId ??
        scope.organizationId,
      organizationId: scope.organizationId,
    };
    const target = await this.authorization.resolveTarget(
      authorizationScope,
      tx,
    );
    if (!permissionIsGranted(actor.grants ?? [], 'schedule.manage', target)) {
      throw new ForbiddenException(
        'Missing permission schedule.manage for the Schedule scope generated shifts belong to.',
      );
    }
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  /** Serializes generation with pattern changes and other generation for the assignment. */
  private async lockAssignment(assignmentId: string, tx: Client) {
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "EmploymentAssignment" WHERE "id" = ${assignmentId}::uuid FOR NO KEY UPDATE`,
    );
  }

  /**
   * Explicit DATE range, defaulting to the rolling horizon. Generation never starts in the past
   * (judged against the earliest current calendar date anywhere), so past drafts are history.
   */
  private parseRange(input: { from?: string; to?: string }): GenerationRange {
    const earliest = earliestCurrentDate(new Date());
    const from = input.from
      ? this.domain.parseDateOnly(input.from, 'from')
      : earliest;
    const to = input.to ? this.domain.parseDateOnly(input.to, 'to') : null;
    if (from < earliest) {
      throw new BadRequestException('Generation cannot start in the past.');
    }
    if (!to) return { from, to: null };
    if (to < from) {
      throw new BadRequestException('to must be on or after from.');
    }
    if (
      to.getTime() - from.getTime() >
      MAX_GENERATION_RANGE_DAYS * 86_400_000
    ) {
      throw new BadRequestException(
        `A generation range may span at most ${MAX_GENERATION_RANGE_DAYS} days.`,
      );
    }
    return { from, to };
  }

  private issue(
    patternId: string,
    occurrence: Occurrence,
    code: GenerationIssueCode,
    message: string,
  ): GenerationIssue {
    return {
      patternId,
      ruleId: occurrence.rule.id,
      workDate: formatDateOnly(occurrence.localDate),
      occurrenceKey: occurrence.key,
      code,
      message,
    };
  }
}

/**
 * Removes the untouched generated drafts of a pattern or rule that is being deleted, so the
 * provenance foreign keys never dangle. Protected generated shifts (published, cancelled, or
 * with revision history) block the deletion. The caller holds the assignment lock.
 */
export async function removeGeneratedDrafts(
  tx: Client,
  where: { sourcePatternId: string } | { sourcePatternRuleId: string },
) {
  const rows = await tx.scheduledShift.findMany({
    where,
    select: { id: true, scheduleId: true, status: true },
  });
  if (rows.length === 0) return 0;
  const scheduleIds = [...new Set(rows.map((row) => row.scheduleId))].sort();
  const statuses = new Map(
    (
      await tx.$queryRaw<Array<{ id: string; status: string }>>(
        Prisma.sql`SELECT "id", "status"::text AS "status" FROM "Schedule" WHERE "id" IN (${Prisma.join(
          scheduleIds.map((id) => Prisma.sql`${id}::uuid`),
        )}) ORDER BY "id" FOR UPDATE`,
      )
    ).map((row) => [row.id, row.status]),
  );
  const ids = rows.map((row) => row.id);
  const revisions = await tx.scheduledShiftRevision.count({
    where: { scheduledShiftId: { in: ids } },
  });
  if (
    revisions > 0 ||
    rows.some(
      (row) =>
        row.status !== 'ACTIVE' || statuses.get(row.scheduleId) !== 'DRAFT',
    )
  ) {
    throw new ConflictException(
      'Generated shifts from this pattern are published or have history; end the pattern instead of removing it.',
    );
  }
  await tx.scheduleConflictOverride.deleteMany({
    where: { scheduledShiftId: { in: ids } },
  });
  return (await tx.scheduledShift.deleteMany({ where: { id: { in: ids } } }))
    .count;
}

/** The narrowest placement of the assignment's position, as a Schedule scope. */
export function containerScope(position: {
  organizationId: string;
  organizationalUnitId: string | null;
  departmentId: string | null;
  teamId: string | null;
}): ContainerScope {
  const base = {
    organizationId: position.organizationId,
    organizationalUnitId: null,
    departmentId: null,
    teamId: null,
  };
  if (position.teamId) {
    return { ...base, scopeType: 'TEAM', teamId: position.teamId };
  }
  if (position.departmentId) {
    return {
      ...base,
      scopeType: 'DEPARTMENT',
      departmentId: position.departmentId,
    };
  }
  if (position.organizationalUnitId) {
    return {
      ...base,
      scopeType: 'ORGANIZATIONAL_UNIT',
      organizationalUnitId: position.organizationalUnitId,
    };
  }
  return { ...base, scopeType: 'ORGANIZATION' };
}

/**
 * The generation container period containing a date, per the policy's defaultSchedulePeriod.
 * WEEKLY (Monday–Sunday) is the only period type today.
 */
export function containerPeriod(
  date: Date,
  period: SchedulePeriodType = DEFAULT_SCHEDULE_POLICY.defaultSchedulePeriod,
) {
  switch (period) {
    case 'WEEKLY': {
      const periodStart = weekStartOf(date);
      return { periodStart, periodEnd: addDays(periodStart, 6) };
    }
  }
}

/** The earliest calendar date currently in effect anywhere (UTC−12). */
export function earliestCurrentDate(now: Date): Date {
  return new Date(
    new Date(now.getTime() - 12 * 3_600_000).toISOString().slice(0, 10),
  );
}

function sameShift(
  row: {
    scheduleId: string;
    employmentAssignmentId: string;
    workLocationId: string | null;
    workDate: Date;
    startsAt: Date;
    endsAt: Date;
    timezone: string;
  },
  desired: DesiredShift,
) {
  return (
    row.scheduleId === desired.scheduleId &&
    row.employmentAssignmentId === desired.employmentAssignmentId &&
    row.workLocationId === desired.workLocationId &&
    row.workDate.getTime() === desired.workDate.getTime() &&
    row.startsAt.getTime() === desired.startsAt.getTime() &&
    row.endsAt.getTime() === desired.endsAt.getTime() &&
    row.timezone === desired.timezone
  );
}

function summary(result: PatternGenerationResult) {
  return {
    patternId: result.patternId,
    employmentAssignmentId: result.employmentAssignmentId,
    range: result.range,
    created: result.created,
    updated: result.updated,
    unchanged: result.unchanged,
    removed: result.removed,
    protected: result.protected,
    blocked: result.blocked.length,
    errors: result.errors.length,
    notices: result.notices.length,
    schedulesCreated: result.schedulesCreated,
  };
}

function max(a: Date, b: Date) {
  return a > b ? a : b;
}

function min(a: Date, b: Date) {
  return a < b ? a : b;
}
