import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
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
  EffectiveGrant,
} from '../authorization/authorization.types.js';
import { PositionAuthorizationTargetResolver } from '../authorization/position-authorization-target.resolver.js';
import {
  featureGateFor,
  FeatureGateService,
} from '../features/feature-gate.service.js';
import { PrismaService } from '../database/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import type {
  Schedule,
  ScheduledShift,
  ScheduledShiftRevision,
  ScheduledShiftRevisionType,
} from '../generated/prisma/client.js';
import {
  conflictPolicyOf,
  conflictSearchMarginMinutes,
  type ConflictPolicy,
} from './schedule-policy.js';
import { SchedulePolicyResolver } from './schedule-policy-resolver.js';
import { raiseScheduleRevisionReviewSignals } from '../time/schedule-revision-review.js';
import {
  SchedulingDomainService,
  type ScheduleConflict,
  type ShiftConflictSubject,
} from './scheduling-domain.service.js';
import type {
  AddPublishedScheduledShiftDto,
  CancelScheduledShiftDto,
  CorrectScheduledShiftDto,
  CreateScheduledShiftDto,
  CreateScheduleDto,
  ScheduleConflictOverrideDto,
  ScheduledShiftFieldsDto,
  ScheduledShiftListQueryDto,
  ScheduleListQueryDto,
  UpdateScheduledShiftDto,
  UpdateScheduledShiftFieldsDto,
  UpdateScheduleDto,
} from './scheduling.dto.js';

type SchedulingClient = Prisma.TransactionClient;
type SchedulePermission = 'schedule.read' | 'schedule.manage';
const OVERRIDE_PERMISSION = 'schedule.override_conflict';
const PUBLISH_PERMISSION = 'schedule.publish';
type ScopeColumns = Pick<
  Schedule,
  | 'scopeType'
  | 'organizationId'
  | 'organizationalUnitId'
  | 'departmentId'
  | 'teamId'
>;

interface ShiftCandidate {
  employmentAssignmentId: string;
  workLocationId: string | null;
  workDate: Date;
  startsAt: Date;
  endsAt: Date;
  explicitTimezone: string | null;
}

type ResolvedShiftData = Pick<
  ScheduledShift,
  | 'employmentAssignmentId'
  | 'workLocationId'
  | 'workDate'
  | 'startsAt'
  | 'endsAt'
  | 'timezone'
>;

interface ResolvedShift {
  data: ResolvedShiftData;
  employeeId: string;
  assignmentTarget: AuthorizationTarget;
  /** The conflict rules of the SchedulePolicy in effect for the assignment on the workDate. */
  conflictPolicy: ConflictPolicy;
}

interface ScheduleAccess {
  schedule: Schedule;
  grants: EffectiveGrant[];
  target: AuthorizationTarget;
}

/** A computed conflict plus the server-side context needed to authorize and explain it. */
interface EvaluatedConflict extends ScheduleConflict {
  conflictingTarget: AuthorizationTarget;
  /** A persisted override that still matches this exact conflict state. */
  overrideId: string | null;
}

interface AcceptedOverride {
  conflict: EvaluatedConflict;
  reason: string;
}

type ConflictErrorCode =
  | 'SCHEDULE_CONFLICT_ERROR'
  | 'SCHEDULE_CONFLICT_OVERRIDE_REQUIRED'
  | 'SCHEDULE_CONFLICT_OVERRIDE_STALE';

/**
 * Row locks, always taken in this order so no two scheduling transactions can deadlock:
 * Schedule → ScheduledShift → Employee (id order). Draft mutations and publication hold the
 * Schedule FOR UPDATE; published changes hold it FOR SHARE (it cannot be published or edited
 * meanwhile) and serialize per shift on the ScheduledShift row instead.
 */
type ScheduleLock = 'update' | 'share';

export interface SchedulingRequestContext {
  actorUserId?: string;
  ipAddress?: string;
  userAgent?: string;
  correlationId?: string;
}

const SCAN_BATCH_SIZE = 100;
const SCHEDULE_EDITABLE_FIELDS = [
  'scopeType',
  'organizationalUnitId',
  'departmentId',
  'teamId',
  'name',
  'periodStart',
  'periodEnd',
  'type',
] as const;
const SHIFT_EDITABLE_FIELDS = [
  'employmentAssignmentId',
  'workLocationId',
  'workDate',
  'startsAt',
  'endsAt',
  'timezone',
] as const;

/**
 * Phase 7 Batches 2–4 — draft Schedule and one-off ScheduledShift management with computed
 * conflict detection and explicit, audited overrides of WARNING conflicts; publication of a
 * DRAFT Schedule as operational expected work; and explicit, revision-recorded corrections,
 * additions, and cancellations of published shifts.
 * Authorization is the Phase 4 scoped model: a Schedule's scope is its authorization target.
 * ScheduledShift is the current operational state and ScheduledShiftRevision its immutable
 * published history; AuditLog remains action accountability, not the revision store.
 * Patterns, policy-driven warnings, and attendance integration are intentionally out of scope.
 */
@Injectable()
export class SchedulingService {
  private readonly policies: SchedulePolicyResolver;

  constructor(
    private readonly prisma: PrismaService,
    private readonly domain: SchedulingDomainService,
    private readonly authorization: AuthorizationService,
    private readonly targets: PositionAuthorizationTargetResolver,
    private readonly audit: AuditService,
    @Optional() policies?: SchedulePolicyResolver,
    @Optional() features?: FeatureGateService,
  ) {
    this.policies = policies ?? new SchedulePolicyResolver(prisma, targets);
    this.features = featureGateFor(prisma, features);
  }

  /** Phase 18: the SCHEDULING module gate. */
  readonly features: FeatureGateService;

  // ─── Schedules ──────────────────────────────────────────────────────────────

  async listSchedules(userId: string, query: ScheduleListQueryDto = {}) {
    const from = query.from
      ? this.domain.parseDateOnly(query.from, 'from')
      : undefined;
    const to = query.to ? this.domain.parseDateOnly(query.to, 'to') : undefined;
    if (from && to && from.getTime() > to.getTime()) {
      throw new BadRequestException('from must be on or before to.');
    }

    const grants = await this.scheduleGrants(userId, this.prisma);
    if (grants.length === 0) return { items: [], nextAfterId: null };

    const where: Prisma.ScheduleWhereInput = {
      // Phase 18: schedules of organizations with Scheduling disabled are left out.
      AND: [
        {
          organizationId: {
            notIn: [
              ...(await this.features.disabledOrganizations('SCHEDULING')),
            ],
          },
        },
      ],
      ...(query.organizationId ? { organizationId: query.organizationId } : {}),
      ...(query.scopeType ? { scopeType: query.scopeType } : {}),
      ...(query.organizationalUnitId
        ? { organizationalUnitId: query.organizationalUnitId }
        : {}),
      ...(query.departmentId ? { departmentId: query.departmentId } : {}),
      ...(query.teamId ? { teamId: query.teamId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.type ? { type: query.type } : {}),
      ...(from ? { periodEnd: { gte: from } } : {}),
      ...(to ? { periodStart: { lte: to } } : {}),
    };

    const max = this.pageLimit(query.limit);
    const visible: Schedule[] = [];
    const targetCache = new Map<string, AuthorizationTarget | null>();
    let cursor = query.afterId;
    let exhausted = false;
    while (visible.length <= max && !exhausted) {
      const batch = await this.prisma.schedule.findMany({
        where,
        orderBy: [{ periodStart: 'desc' }, { id: 'desc' }],
        take: SCAN_BATCH_SIZE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      for (const row of batch) {
        const target = await this.cachedTarget(row, targetCache);
        if (target && this.grantsAny(grants, target)) visible.push(row);
        if (visible.length > max) break;
      }
      exhausted = batch.length < SCAN_BATCH_SIZE;
      cursor = batch.at(-1)?.id;
    }

    const items = visible.slice(0, max);
    return {
      items: items.map((row) => this.scheduleShape(row)),
      nextAfterId: visible.length > max ? (items.at(-1)?.id ?? null) : null,
    };
  }

  async getSchedule(userId: string, scheduleId: string) {
    const { schedule } = await this.requireSchedule(
      userId,
      scheduleId,
      'schedule.read',
      this.prisma,
    );
    return this.scheduleShape(schedule);
  }

  async createSchedule(
    input: CreateScheduleDto,
    context: SchedulingRequestContext,
  ) {
    const actor = this.requireActor(context);
    const periodStart = this.domain.parseDateOnly(
      input.periodStart,
      'periodStart',
    );
    const periodEnd = this.domain.parseDateOnly(input.periodEnd, 'periodEnd');
    this.domain.assertSchedulePeriod(periodStart, periodEnd);
    const scope: ScopeColumns = {
      scopeType: input.scopeType,
      organizationId: input.organizationId,
      organizationalUnitId: input.organizationalUnitId ?? null,
      departmentId: input.departmentId ?? null,
      teamId: input.teamId ?? null,
    };
    this.domain.assertScheduleScopeShape(scope);
    const name = this.scheduleName(input.name);

    return this.prisma.$transaction(async (tx) => {
      await this.assertScopeTarget(scope, tx);
      await this.authorization.assertCan(
        actor,
        'schedule.manage',
        this.authorizationScope(scope),
        tx,
      );
      await this.features.require(scope.organizationId, 'SCHEDULING', tx);
      const schedule = await tx.schedule.create({
        data: {
          scopeType: scope.scopeType,
          organizationId: scope.organizationId,
          organizationalUnitId: scope.organizationalUnitId,
          departmentId: scope.departmentId,
          teamId: scope.teamId,
          name,
          periodStart,
          periodEnd,
          type: input.type,
          status: 'DRAFT',
        },
      });
      const shaped = this.scheduleShape(schedule);
      await this.writeAudit(
        tx,
        'SCHEDULE_CREATED',
        'Schedule',
        schedule.id,
        context,
        { schedule: shaped },
      );
      return shaped;
    });
  }

  async updateSchedule(
    scheduleId: string,
    input: UpdateScheduleDto,
    context: SchedulingRequestContext,
  ) {
    const actor = this.requireActor(context);
    if (
      input.scopeType === undefined &&
      (input.organizationalUnitId || input.departmentId || input.teamId)
    ) {
      throw new BadRequestException(
        'scopeType is required when changing the Schedule scope target.',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const { schedule } = await this.requireSchedule(
        actor,
        scheduleId,
        'schedule.manage',
        tx,
        { lock: 'update' },
      );
      this.assertDraft(schedule);

      const scope: ScopeColumns = input.scopeType
        ? {
            scopeType: input.scopeType,
            organizationId: schedule.organizationId,
            organizationalUnitId: input.organizationalUnitId ?? null,
            departmentId: input.departmentId ?? null,
            teamId: input.teamId ?? null,
          }
        : schedule;
      const scopeChanged =
        scope.scopeType !== schedule.scopeType ||
        scope.organizationalUnitId !== schedule.organizationalUnitId ||
        scope.departmentId !== schedule.departmentId ||
        scope.teamId !== schedule.teamId;
      if (scopeChanged) {
        this.domain.assertScheduleScopeShape(scope);
        await this.assertScopeTarget(scope, tx);
        await this.authorization.assertCan(
          actor,
          'schedule.manage',
          this.authorizationScope(scope),
          tx,
        );
      }

      const periodStart = input.periodStart
        ? this.domain.parseDateOnly(input.periodStart, 'periodStart')
        : schedule.periodStart;
      const periodEnd = input.periodEnd
        ? this.domain.parseDateOnly(input.periodEnd, 'periodEnd')
        : schedule.periodEnd;
      this.domain.assertSchedulePeriod(periodStart, periodEnd);
      const periodChanged =
        periodStart.getTime() !== schedule.periodStart.getTime() ||
        periodEnd.getTime() !== schedule.periodEnd.getTime();
      if (periodChanged) {
        const excluded = await tx.scheduledShift.count({
          where: {
            scheduleId,
            OR: [
              { workDate: { lt: periodStart } },
              { workDate: { gt: periodEnd } },
            ],
          },
        });
        if (excluded > 0) {
          throw new ConflictException(
            `The new Schedule period would exclude ${excluded} existing shift(s); move or remove them first.`,
          );
        }
      }

      const next = {
        ...scope,
        name:
          input.name === undefined
            ? schedule.name
            : this.scheduleName(input.name),
        periodStart,
        periodEnd,
        type: input.type ?? schedule.type,
      };
      const changes = this.changes(
        this.scheduleShape(schedule),
        this.scheduleShape({ ...schedule, ...next }),
        SCHEDULE_EDITABLE_FIELDS,
      );
      if (Object.keys(changes).length === 0) {
        return this.scheduleShape(schedule);
      }

      const updated = await tx.schedule.update({
        where: { id: scheduleId },
        data: {
          scopeType: next.scopeType,
          organizationalUnitId: next.organizationalUnitId,
          departmentId: next.departmentId,
          teamId: next.teamId,
          name: next.name,
          periodStart: next.periodStart,
          periodEnd: next.periodEnd,
          type: next.type,
        },
      });
      await this.writeAudit(
        tx,
        'SCHEDULE_UPDATED',
        'Schedule',
        scheduleId,
        context,
        { changes },
      );
      return this.scheduleShape(updated);
    });
  }

  async deleteSchedule(scheduleId: string, context: SchedulingRequestContext) {
    const actor = this.requireActor(context);
    return this.prisma.$transaction(async (tx) => {
      const { schedule } = await this.requireSchedule(
        actor,
        scheduleId,
        'schedule.manage',
        tx,
        { lock: 'update' },
      );
      this.assertDraft(schedule);
      const shiftCount = await tx.scheduledShift.count({
        where: { scheduleId },
      });
      if (shiftCount > 0) {
        throw new ConflictException(
          `Draft Schedule still has ${shiftCount} shift(s); remove them before deleting the Schedule.`,
        );
      }
      await tx.schedule.delete({ where: { id: scheduleId } });
      await this.writeAudit(
        tx,
        'SCHEDULE_DELETED',
        'Schedule',
        scheduleId,
        context,
        { schedule: this.scheduleShape(schedule) },
      );
      return { success: true };
    });
  }

  // ─── Scheduled shifts ───────────────────────────────────────────────────────

  async listShifts(
    userId: string,
    scheduleId: string,
    query: ScheduledShiftListQueryDto = {},
  ) {
    const from = query.from
      ? this.domain.parseDateOnly(query.from, 'from')
      : undefined;
    const to = query.to ? this.domain.parseDateOnly(query.to, 'to') : undefined;
    if (from && to && from.getTime() > to.getTime()) {
      throw new BadRequestException('from must be on or before to.');
    }
    await this.requireSchedule(
      userId,
      scheduleId,
      'schedule.read',
      this.prisma,
    );

    const max = this.pageLimit(query.limit);
    const rows = await this.prisma.scheduledShift.findMany({
      where: {
        scheduleId,
        ...(query.employmentAssignmentId
          ? { employmentAssignmentId: query.employmentAssignmentId }
          : {}),
        ...(query.status ? { status: query.status } : {}),
        ...(from || to
          ? {
              workDate: {
                ...(from ? { gte: from } : {}),
                ...(to ? { lte: to } : {}),
              },
            }
          : {}),
      },
      orderBy: [{ workDate: 'asc' }, { startsAt: 'asc' }, { id: 'asc' }],
      take: max + 1,
      ...(query.afterId ? { cursor: { id: query.afterId }, skip: 1 } : {}),
    });
    const items = rows.slice(0, max);
    return {
      items: items.map((row) => this.shiftShape(row)),
      nextAfterId: rows.length > max ? (items.at(-1)?.id ?? null) : null,
    };
  }

  async getShift(userId: string, scheduleId: string, shiftId: string) {
    await this.requireSchedule(
      userId,
      scheduleId,
      'schedule.read',
      this.prisma,
    );
    const shift = await this.requireShift(scheduleId, shiftId, this.prisma);
    return this.shiftShape(shift);
  }

  async createShift(
    scheduleId: string,
    input: CreateScheduledShiftDto,
    context: SchedulingRequestContext,
  ) {
    const actor = this.requireActor(context);
    const candidate = this.newShiftCandidate(input);
    const overrides = this.overrideInputs(input.conflictOverrides);

    return this.prisma.$transaction(async (tx) => {
      const access = await this.requireSchedule(
        actor,
        scheduleId,
        'schedule.manage',
        tx,
        { lock: 'update' },
      );
      this.assertDraft(access.schedule);
      const resolved = await this.resolveShift(
        access.schedule,
        access.grants,
        candidate,
        tx,
      );
      const accepted = await this.checkNewShift(
        access,
        resolved,
        overrides,
        tx,
      );
      const shift = await tx.scheduledShift.create({
        data: {
          scheduleId,
          ...resolved.data,
          status: 'ACTIVE',
          sourceType: 'MANUAL',
        },
      });
      const shaped = this.shiftShape(shift);
      await this.writeAudit(
        tx,
        'SCHEDULED_SHIFT_CREATED',
        'ScheduledShift',
        shift.id,
        context,
        { scheduleId, shift: shaped },
      );
      await this.recordOverrides(shift, resolved, accepted, context, tx);
      return shaped;
    });
  }

  async updateShift(
    scheduleId: string,
    shiftId: string,
    input: UpdateScheduledShiftDto,
    context: SchedulingRequestContext,
  ) {
    const actor = this.requireActor(context);
    const patch = this.parseShiftPatch(input);
    const overrides = this.overrideInputs(input.conflictOverrides);

    return this.prisma.$transaction(async (tx) => {
      const access = await this.requireSchedule(
        actor,
        scheduleId,
        'schedule.manage',
        tx,
        { lock: 'update' },
      );
      const shift = await this.requireShift(scheduleId, shiftId, tx);
      this.assertDraft(access.schedule);
      this.assertManualShift(shift);

      const resolved = await this.resolveShift(
        access.schedule,
        access.grants,
        this.mergedShiftCandidate(shift, input, patch),
        tx,
      );
      const changes = this.changes(
        this.shiftShape(shift),
        this.shiftShape({ ...shift, ...resolved.data }),
        SHIFT_EDITABLE_FIELDS,
      );
      if (Object.keys(changes).length === 0) {
        if (overrides.length > 0) {
          throw new BadRequestException(
            'conflictOverrides can only accompany a change to the shift.',
          );
        }
        return this.shiftShape(shift);
      }

      const accepted = await this.checkShiftChange(
        access,
        shift,
        resolved,
        overrides,
        tx,
      );
      const updated = await tx.scheduledShift.update({
        where: { id: shiftId },
        data: resolved.data,
      });
      await this.writeAudit(
        tx,
        'SCHEDULED_SHIFT_UPDATED',
        'ScheduledShift',
        shiftId,
        context,
        { scheduleId, changes },
      );
      await this.recordOverrides(updated, resolved, accepted, context, tx);
      return this.shiftShape(updated);
    });
  }

  /**
   * Read-only conflict evaluation of a prospective shift (create) or of the merged final
   * state of an existing shift (update). Runs every validation the save would run, so a
   * client can render conflicts and request overrides before saving. Nothing is written.
   */
  async previewShiftConflicts(
    userId: string,
    scheduleId: string,
    shiftId: string | null,
    input: ScheduledShiftFieldsDto | UpdateScheduledShiftFieldsDto,
  ) {
    const access = await this.requireSchedule(
      userId,
      scheduleId,
      'schedule.manage',
      this.prisma,
    );
    this.assertDraft(access.schedule);
    let candidate: ShiftCandidate;
    if (shiftId) {
      const shift = await this.requireShift(scheduleId, shiftId, this.prisma);
      this.assertManualShift(shift);
      candidate = this.mergedShiftCandidate(
        shift,
        input,
        this.parseShiftPatch(input),
      );
    } else {
      candidate = this.newShiftCandidate(input as ScheduledShiftFieldsDto);
    }
    const resolved = await this.resolveShift(
      access.schedule,
      access.grants,
      candidate,
      this.prisma,
    );
    const conflicts = await this.evaluateConflicts(
      access.grants,
      {
        ...(shiftId ? { id: shiftId } : {}),
        employeeId: resolved.employeeId,
        ...resolved.data,
      },
      resolved.assignmentTarget,
      resolved.conflictPolicy,
      this.prisma,
    );
    const blocking = conflicts.some(
      (conflict) => conflict.severity === 'ERROR',
    );
    const overrideRequired = conflicts.some((conflict) =>
      this.requiresOverride(conflict),
    );
    return {
      valid: !blocking && !overrideRequired,
      overrideRequired: !blocking && overrideRequired,
      conflicts: conflicts.map((conflict) =>
        this.conflictShape(conflict, access.grants),
      ),
    };
  }

  /** Draft shifts were never operational, so removal is a hard delete. */
  async deleteShift(
    scheduleId: string,
    shiftId: string,
    context: SchedulingRequestContext,
  ) {
    const actor = this.requireActor(context);
    return this.prisma.$transaction(async (tx) => {
      const { schedule } = await this.requireSchedule(
        actor,
        scheduleId,
        'schedule.manage',
        tx,
        { lock: 'update' },
      );
      const shift = await this.requireShift(scheduleId, shiftId, tx);
      this.assertDraft(schedule);
      this.assertManualShift(shift);
      // The draft shift's own accepted overrides go with it; AuditLog keeps their history.
      // Overrides elsewhere that name this shift as the conflicting one keep their snapshot
      // and lose the reference (ON DELETE SET NULL), so they can never match again.
      const removedOverrides = await tx.scheduleConflictOverride.deleteMany({
        where: { scheduledShiftId: shiftId },
      });
      await tx.scheduledShift.delete({ where: { id: shiftId } });
      await this.writeAudit(
        tx,
        'SCHEDULED_SHIFT_DELETED',
        'ScheduledShift',
        shiftId,
        context,
        {
          scheduleId,
          shift: this.shiftShape(shift),
          ...(removedOverrides.count > 0
            ? { removedConflictOverrides: removedOverrides.count }
            : {}),
        },
      );
      return { success: true };
    });
  }

  // ─── Publication ────────────────────────────────────────────────────────────

  /**
   * DRAFT → PUBLISHED, one way. Re-validates the Schedule and every shift against current
   * organizational and employment data and re-runs conflict detection, then atomically marks
   * the Schedule published and records a PUBLISHED_BASELINE revision (revision 1) for every
   * shift. Nothing is fixed silently: any invalid shift or unresolved conflict rejects the
   * whole publication and nothing changes. New overrides are not accepted here; WARNING
   * conflicts must already carry a persisted override that matches their exact current state.
   */
  async publishSchedule(scheduleId: string, context: SchedulingRequestContext) {
    const actor = this.requireActor(context);
    return this.prisma.$transaction(async (tx) => {
      const access = await this.requireSchedule(
        actor,
        scheduleId,
        'schedule.manage',
        tx,
        { lock: 'update' },
      );
      this.assertPublishPermission(access);
      const { schedule } = access;
      if (schedule.status !== 'DRAFT') {
        throw new ConflictException('Only DRAFT schedules can be published.');
      }
      this.domain.assertSchedulePeriod(
        schedule.periodStart,
        schedule.periodEnd,
      );
      this.domain.assertScheduleScopeShape(schedule);
      await this.assertScopeTarget(schedule, tx);

      const shifts = await tx.scheduledShift.findMany({
        where: { scheduleId },
        orderBy: [{ workDate: 'asc' }, { startsAt: 'asc' }, { id: 'asc' }],
      });
      // An empty publication would announce expected work that does not exist.
      if (shifts.length === 0) {
        throw new ConflictException({
          statusCode: 409,
          error: 'Conflict',
          code: 'SCHEDULE_PUBLICATION_EMPTY',
          message:
            'A Schedule must contain at least one shift to be published.',
        });
      }

      const invalidShifts: Array<{ shiftId: string; message: string }> = [];
      const valid: Array<{ shift: ScheduledShift; resolved: ResolvedShift }> =
        [];
      for (const shift of shifts) {
        if (shift.status !== 'ACTIVE') {
          invalidShifts.push({
            shiftId: shift.id,
            message: 'Only ACTIVE draft shifts can be published.',
          });
          continue;
        }
        try {
          const resolved = await this.resolveShift(
            schedule,
            access.grants,
            this.storedShiftCandidate(shift),
            tx,
          );
          if (resolved.data.timezone !== shift.timezone) {
            invalidShifts.push({
              shiftId: shift.id,
              message:
                "The shift's timezone no longer matches its WorkLocation timezone.",
            });
            continue;
          }
          valid.push({ shift, resolved });
        } catch (error) {
          // Missing authority over an assignment's scope forbids publication outright.
          if (
            error instanceof ForbiddenException ||
            !(error instanceof HttpException)
          ) {
            throw error;
          }
          invalidShifts.push({
            shiftId: shift.id,
            message: exceptionMessage(error),
          });
        }
      }
      if (invalidShifts.length > 0) {
        throw new ConflictException({
          statusCode: 409,
          error: 'Conflict',
          code: 'SCHEDULE_PUBLICATION_INVALID',
          message:
            'The Schedule has shifts that are no longer valid; correct or remove them before publishing.',
          invalidShifts,
        });
      }

      await this.lockEmployees(
        valid.map(({ resolved }) => resolved.employeeId),
        tx,
      );
      const blocked: Array<{
        shiftId: string;
        conflicts: EvaluatedConflict[];
      }> = [];
      for (const { shift, resolved } of valid) {
        const conflicts = await this.evaluateConflicts(
          access.grants,
          { id: shift.id, employeeId: resolved.employeeId, ...resolved.data },
          resolved.assignmentTarget,
          resolved.conflictPolicy,
          tx,
        );
        if (
          conflicts.some(
            (conflict) =>
              conflict.severity === 'ERROR' || this.requiresOverride(conflict),
          )
        ) {
          blocked.push({ shiftId: shift.id, conflicts });
        }
      }
      if (blocked.length > 0) {
        const hasError = blocked.some(({ conflicts }) =>
          conflicts.some((conflict) => conflict.severity === 'ERROR'),
        );
        throw new ConflictException({
          statusCode: 409,
          error: 'Conflict',
          code: hasError
            ? 'SCHEDULE_CONFLICT_ERROR'
            : 'SCHEDULE_CONFLICT_OVERRIDE_REQUIRED',
          message:
            'The Schedule has unresolved scheduling conflicts and cannot be published.',
          shifts: blocked.map(({ shiftId, conflicts }) => ({
            shiftId,
            conflicts: conflicts.map((conflict) =>
              this.conflictShape(conflict, access.grants),
            ),
          })),
        });
      }

      const publishedAt = new Date();
      const published = await tx.schedule.update({
        where: { id: scheduleId },
        data: { status: 'PUBLISHED', publishedAt, publishedByUserId: actor },
      });
      const baselines = await tx.scheduledShiftRevision.createMany({
        data: shifts.map((shift) => ({
          ...this.revisionSnapshot(shift),
          revisionNumber: 1,
          revisionType: 'PUBLISHED_BASELINE' as const,
          reason: null,
          changedByUserId: actor,
          changedAt: publishedAt,
        })),
      });
      const shaped = this.scheduleShape(published);
      await this.writeAudit(
        tx,
        'SCHEDULE_PUBLISHED',
        'Schedule',
        scheduleId,
        context,
        {
          schedule: shaped,
          shiftCount: shifts.length,
          baselineRevisionCount: baselines.count,
        },
      );
      return shaped;
    });
  }

  /**
   * Corrects a published ACTIVE shift. Runs the full shift validation and conflict rules on
   * the merged final state, updates the current ScheduledShift, and appends a CORRECTED
   * revision holding the complete resulting state. Earlier revisions are never rewritten.
   * Any source type may be corrected: a future PATTERN-generated shift is corrected as a
   * concrete shift without touching its pattern.
   */
  async correctShift(
    scheduleId: string,
    shiftId: string,
    input: CorrectScheduledShiftDto,
    context: SchedulingRequestContext,
  ) {
    const actor = this.requireActor(context);
    const reason = this.changeReason(input.reason);
    const patch = this.parseShiftPatch(input);
    const overrides = this.overrideInputs(input.conflictOverrides);

    return this.prisma.$transaction(async (tx) => {
      const access = await this.requirePublishedChange(actor, scheduleId, tx);
      const shift = await this.lockShift(scheduleId, shiftId, tx);
      this.assertActiveShift(shift);
      if (
        input.employmentAssignmentId &&
        input.employmentAssignmentId !== shift.employmentAssignmentId
      ) {
        await this.assertSameEmployee(
          shift.employmentAssignmentId,
          input.employmentAssignmentId,
          tx,
        );
      }

      const resolved = await this.resolveShift(
        access.schedule,
        access.grants,
        this.mergedShiftCandidate(shift, input, patch),
        tx,
      );
      const changes = this.changes(
        this.shiftShape(shift),
        this.shiftShape({ ...shift, ...resolved.data }),
        SHIFT_EDITABLE_FIELDS,
      );
      if (Object.keys(changes).length === 0) {
        throw new BadRequestException(
          'A correction must change at least one field of the shift.',
        );
      }
      const accepted = await this.checkShiftChange(
        access,
        shift,
        resolved,
        overrides,
        tx,
      );

      const updated = await tx.scheduledShift.update({
        where: { id: shiftId },
        data: resolved.data,
      });
      const revision = await this.appendRevision(
        updated,
        'CORRECTED',
        reason,
        actor,
        tx,
      );
      const attendanceReviews = await this.raiseAttendanceReviews(
        revision,
        context,
        tx,
      );
      await this.writeAudit(
        tx,
        'SCHEDULED_SHIFT_CORRECTED',
        'ScheduledShift',
        shiftId,
        context,
        {
          scheduleId,
          reason,
          revisionId: revision.id,
          revisionNumber: revision.revisionNumber,
          attendanceReviewCount: attendanceReviews.length,
          changes,
          before: this.shiftShape(shift),
          after: this.shiftShape(updated),
        },
      );
      await this.recordOverrides(updated, resolved, accepted, context, tx);
      return {
        shift: this.shiftShape(updated),
        revision: this.revisionShape(revision),
      };
    });
  }

  /**
   * Cancels a published shift (ACTIVE → CANCELLED) and appends a CANCELLED revision. Published
   * shifts are never hard-deleted. Cancellation is final in V1 and idempotent: cancelling a
   * CANCELLED shift returns its existing cancellation without recording anything new. The shift
   * is not re-validated, since an ended assignment is a common reason to cancel.
   */
  async cancelShift(
    scheduleId: string,
    shiftId: string,
    input: CancelScheduledShiftDto,
    context: SchedulingRequestContext,
  ) {
    const actor = this.requireActor(context);
    const reason = this.changeReason(input.reason);

    return this.prisma.$transaction(async (tx) => {
      const access = await this.requirePublishedChange(actor, scheduleId, tx);
      const shift = await this.lockShift(scheduleId, shiftId, tx);
      await this.assertManagesShiftAssignment(access.grants, shift, tx);
      if (shift.status === 'CANCELLED') {
        const cancellation = await tx.scheduledShiftRevision.findFirst({
          where: { scheduledShiftId: shiftId, revisionType: 'CANCELLED' },
        });
        return {
          shift: this.shiftShape(shift),
          revision: cancellation ? this.revisionShape(cancellation) : null,
        };
      }

      const updated = await tx.scheduledShift.update({
        where: { id: shiftId },
        data: { status: 'CANCELLED' },
      });
      const revision = await this.appendRevision(
        updated,
        'CANCELLED',
        reason,
        actor,
        tx,
      );
      const attendanceReviews = await this.raiseAttendanceReviews(
        revision,
        context,
        tx,
      );
      await this.writeAudit(
        tx,
        'SCHEDULED_SHIFT_CANCELLED',
        'ScheduledShift',
        shiftId,
        context,
        {
          scheduleId,
          reason,
          revisionId: revision.id,
          revisionNumber: revision.revisionNumber,
          attendanceReviewCount: attendanceReviews.length,
          shift: this.shiftShape(updated),
        },
      );
      return {
        shift: this.shiftShape(updated),
        revision: this.revisionShape(revision),
      };
    });
  }

  /**
   * Adds a shift to a PUBLISHED Schedule through an explicit published-change workflow (never
   * the draft create route). The shift is validated and conflict-checked like any other and is
   * operational immediately; its first revision is its PUBLISHED_BASELINE, carrying the reason.
   */
  async addPublishedShift(
    scheduleId: string,
    input: AddPublishedScheduledShiftDto,
    context: SchedulingRequestContext,
  ) {
    const actor = this.requireActor(context);
    const reason = this.changeReason(input.reason);
    const candidate = this.newShiftCandidate(input);
    const overrides = this.overrideInputs(input.conflictOverrides);

    return this.prisma.$transaction(async (tx) => {
      const access = await this.requirePublishedChange(actor, scheduleId, tx);
      const resolved = await this.resolveShift(
        access.schedule,
        access.grants,
        candidate,
        tx,
      );
      const accepted = await this.checkNewShift(
        access,
        resolved,
        overrides,
        tx,
      );
      const shift = await tx.scheduledShift.create({
        data: {
          scheduleId,
          ...resolved.data,
          status: 'ACTIVE',
          sourceType: 'MANUAL',
        },
      });
      const revision = await this.appendRevision(
        shift,
        'PUBLISHED_BASELINE',
        reason,
        actor,
        tx,
      );
      await this.writeAudit(
        tx,
        'SCHEDULED_SHIFT_ADDED',
        'ScheduledShift',
        shift.id,
        context,
        {
          scheduleId,
          reason,
          revisionId: revision.id,
          revisionNumber: revision.revisionNumber,
          shift: this.shiftShape(shift),
        },
      );
      await this.recordOverrides(shift, resolved, accepted, context, tx);
      return {
        shift: this.shiftShape(shift),
        revision: this.revisionShape(revision),
      };
    });
  }

  /** The shift's immutable published history, oldest first. Draft shifts have none. */
  async listShiftRevisions(
    userId: string,
    scheduleId: string,
    shiftId: string,
  ) {
    await this.requireSchedule(
      userId,
      scheduleId,
      'schedule.read',
      this.prisma,
    );
    await this.requireShift(scheduleId, shiftId, this.prisma);
    const rows = await this.prisma.scheduledShiftRevision.findMany({
      where: { scheduledShiftId: shiftId },
      orderBy: { revisionNumber: 'asc' },
    });
    return { items: rows.map((row) => this.revisionShape(row)) };
  }

  // ─── Validation ─────────────────────────────────────────────────────────────

  /**
   * Applies every Batch 1 shift rule to a full candidate and resolves server-derived values.
   * The actor must also be able to manage schedules for the assignment's own position scope,
   * so a scoped manager cannot place employees from unrelated hierarchy branches.
   */
  private async resolveShift(
    schedule: Schedule,
    grants: EffectiveGrant[],
    candidate: ShiftCandidate,
    tx: SchedulingClient,
  ): Promise<ResolvedShift> {
    this.domain.assertShiftInterval(candidate.startsAt, candidate.endsAt);
    this.domain.assertWorkDateInSchedule(
      candidate.workDate,
      schedule.periodStart,
      schedule.periodEnd,
    );

    const assignment = await tx.employmentAssignment.findUnique({
      where: { id: candidate.employmentAssignmentId },
      select: {
        id: true,
        employeeId: true,
        status: true,
        startDate: true,
        endDate: true,
        positionId: true,
        position: { select: { organizationId: true } },
      },
    });
    if (!assignment) {
      throw new NotFoundException('EmploymentAssignment not found');
    }
    this.domain.assertOrganizationBoundary(
      schedule.organizationId,
      assignment.position.organizationId,
    );
    this.domain.assertAssignmentEffective(assignment, candidate.workDate);
    const assignmentTarget = await this.targets.resolvePosition(
      assignment.positionId,
      undefined,
      tx,
    );
    if (!permissionIsGranted(grants, 'schedule.manage', assignmentTarget)) {
      throw new ForbiddenException(
        'Missing permission schedule.manage for the employment assignment scope.',
      );
    }

    const policy = (
      await this.policies.forPosition(assignment.positionId, tx)
    ).resolve(candidate.workDate);
    if (policy.requireWorkLocation && !candidate.workLocationId) {
      throw new BadRequestException(
        'The scheduling policy requires a WorkLocation for this shift.',
      );
    }

    let workLocationTimezone: string | null = null;
    if (candidate.workLocationId) {
      const workLocation = await tx.workLocation.findUnique({
        where: { id: candidate.workLocationId },
      });
      if (!workLocation) throw new NotFoundException('WorkLocation not found');
      this.domain.assertWorkLocationOrganization(
        schedule.organizationId,
        workLocation.organizationId,
      );
      if (workLocation.archivedAt) {
        throw new BadRequestException(
          'Shifts cannot be scheduled at an archived WorkLocation.',
        );
      }
      workLocationTimezone = workLocation.timezone;
    }
    const timezone = this.domain.resolveShiftTimezone(
      workLocationTimezone,
      candidate.explicitTimezone,
    );
    this.domain.assertWorkDateMatchesShiftStart(
      candidate.workDate,
      candidate.startsAt,
      timezone,
    );

    return {
      data: {
        employmentAssignmentId: assignment.id,
        workLocationId: candidate.workLocationId,
        workDate: candidate.workDate,
        startsAt: candidate.startsAt,
        endsAt: candidate.endsAt,
        timezone,
      },
      employeeId: assignment.employeeId,
      assignmentTarget,
      conflictPolicy: conflictPolicyOf(policy),
    };
  }

  // ─── Conflicts ──────────────────────────────────────────────────────────────

  /**
   * Serializes conflict evaluation and the following write per Employee. The Schedule row
   * lock only covers one container, but conflicts span every Schedule and every assignment
   * of the Employee, so concurrent saves for the same Employee must queue here. FOR NO KEY
   * UPDATE does not block foreign-key checks from other modules referencing the Employee.
   * Rows are locked in id order so multi-Employee saves cannot deadlock each other.
   */
  private async lockEmployees(
    employeeIds: readonly (string | null | undefined)[],
    tx: SchedulingClient,
  ) {
    const ids = [...new Set(employeeIds.filter((id): id is string => !!id))];
    if (ids.length === 0) return;
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "Employee" WHERE "id" IN (${Prisma.join(
        ids.map((id) => Prisma.sql`${id}::uuid`),
      )}) ORDER BY "id" FOR NO KEY UPDATE`,
    );
  }

  /** Conflict rules for a shift that does not exist yet. */
  private async checkNewShift(
    access: ScheduleAccess,
    resolved: ResolvedShift,
    overrides: ScheduleConflictOverrideDto[],
    tx: SchedulingClient,
  ) {
    await this.lockEmployees([resolved.employeeId], tx);
    const conflicts = await this.evaluateConflicts(
      access.grants,
      { employeeId: resolved.employeeId, ...resolved.data },
      resolved.assignmentTarget,
      resolved.conflictPolicy,
      tx,
    );
    return this.acceptConflicts(
      access,
      resolved.assignmentTarget,
      conflicts,
      overrides,
    );
  }

  /** Conflict rules for the merged final state of an existing shift. */
  private async checkShiftChange(
    access: ScheduleAccess,
    shift: ScheduledShift,
    resolved: ResolvedShift,
    overrides: ScheduleConflictOverrideDto[],
    tx: SchedulingClient,
  ) {
    // Lock both the new and the previous Employee so a reassignment serializes with both.
    const previousEmployeeId =
      shift.employmentAssignmentId === resolved.data.employmentAssignmentId
        ? resolved.employeeId
        : (
            await tx.employmentAssignment.findUnique({
              where: { id: shift.employmentAssignmentId },
              select: { employeeId: true },
            })
          )?.employeeId;
    await this.lockEmployees([resolved.employeeId, previousEmployeeId], tx);
    const conflicts = await this.evaluateConflicts(
      access.grants,
      { id: shift.id, employeeId: resolved.employeeId, ...resolved.data },
      resolved.assignmentTarget,
      resolved.conflictPolicy,
      tx,
    );
    return this.acceptConflicts(
      access,
      resolved.assignmentTarget,
      conflicts,
      overrides,
    );
  }

  /**
   * Recomputes conflicts from the database across every Schedule container: ACTIVE shifts
   * of the same Employee, on any assignment, whose interval overlaps the subject. Persisted
   * overrides are honored only when they match the exact current conflict state.
   */
  private async evaluateConflicts(
    grants: EffectiveGrant[],
    subject: ShiftConflictSubject,
    subjectTarget: AuthorizationTarget,
    conflictPolicy: ConflictPolicy,
    client: SchedulingClient,
  ): Promise<EvaluatedConflict[]> {
    // Minimum rest looks beyond the subject's own interval.
    const margin = conflictSearchMarginMinutes(conflictPolicy) * 60_000;
    const rows = await client.scheduledShift.findMany({
      where: {
        status: 'ACTIVE',
        ...(subject.id ? { id: { not: subject.id } } : {}),
        startsAt: { lt: new Date(subject.endsAt.getTime() + margin) },
        endsAt: { gt: new Date(subject.startsAt.getTime() - margin) },
        employmentAssignment: { employeeId: subject.employeeId },
      },
      select: {
        id: true,
        scheduleId: true,
        employmentAssignmentId: true,
        workDate: true,
        startsAt: true,
        endsAt: true,
        status: true,
        employmentAssignment: {
          select: { employeeId: true, positionId: true },
        },
      },
      orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
    });
    const positionByShift = new Map(
      rows.map((row) => [row.id, row.employmentAssignment.positionId]),
    );
    const conflicts = this.domain.detectShiftConflicts(
      subject,
      rows.map(({ employmentAssignment, ...row }) => ({
        ...row,
        employeeId: employmentAssignment.employeeId,
      })),
      conflictPolicy,
    );

    const targetCache = new Map<string, AuthorizationTarget>();
    const evaluated: EvaluatedConflict[] = [];
    for (const conflict of conflicts) {
      let conflictingTarget = subjectTarget;
      if (
        conflict.conflictingShift &&
        conflict.conflictingShift.employmentAssignmentId !==
          subject.employmentAssignmentId
      ) {
        const positionId = positionByShift.get(conflict.conflictingShift.id)!;
        if (!targetCache.has(positionId)) {
          targetCache.set(
            positionId,
            await this.targets.resolvePosition(positionId, undefined, client),
          );
        }
        conflictingTarget = targetCache.get(positionId)!;
      }
      evaluated.push({ ...conflict, conflictingTarget, overrideId: null });
    }
    if (!subject.id) return evaluated;

    // An override may have been recorded from either side of the pair; match both orientations.
    const subjectId = subject.id;
    const overrideable = evaluated.filter(
      (conflict) => conflict.overrideAllowed,
    );
    if (overrideable.length === 0) return evaluated;
    // Pair conflicts are fingerprinted from the subject's side; the reverse key is the same
    // conflict seen from the other shift. Rest keys also carry the policy threshold.
    const threshold = (conflict: EvaluatedConflict) =>
      conflict.type === 'MINIMUM_REST_VIOLATION'
        ? (conflictPolicy.minimumRestMinutes ?? undefined)
        : undefined;
    const reverseKey = (conflict: EvaluatedConflict) =>
      conflict.conflictingShift
        ? this.domain.conflictKey(
            conflict.type,
            conflict.conflictingShift,
            { ...subject, id: subjectId },
            threshold(conflict),
          )
        : conflict.key;
    const persisted = await client.scheduleConflictOverride.findMany({
      where: {
        OR: overrideable.flatMap(
          (conflict): Prisma.ScheduleConflictOverrideWhereInput[] =>
            conflict.conflictingShift
              ? [
                  {
                    scheduledShiftId: subjectId,
                    conflictingShiftId: conflict.conflictingShift.id,
                    conflictType: conflict.type,
                    conflictKey: conflict.key,
                  },
                  {
                    scheduledShiftId: conflict.conflictingShift.id,
                    conflictingShiftId: subjectId,
                    conflictType: conflict.type,
                    conflictKey: reverseKey(conflict),
                  },
                ]
              : [
                  {
                    scheduledShiftId: subjectId,
                    conflictingShiftId: null,
                    conflictType: conflict.type,
                    conflictKey: conflict.key,
                  },
                ],
        ),
      },
      select: { id: true, conflictKey: true },
      orderBy: [{ overriddenAt: 'desc' }, { id: 'asc' }],
    });
    for (const conflict of overrideable) {
      const keys = new Set([conflict.key, reverseKey(conflict)]);
      conflict.overrideId =
        persisted.find((row) => keys.has(row.conflictKey))?.id ?? null;
    }
    return evaluated;
  }

  /**
   * Applies the blocking rules to freshly recomputed conflicts:
   * - any ERROR blocks the save; no permission can override it;
   * - every override must name a conflict that exists now, with the same type and key, so a
   *   client cannot invent a conflict and a stale approval cannot carry over to new state;
   * - overriding requires schedule.override_conflict, in addition to schedule.manage, on the
   *   Schedule and the shift's assignment, and both permissions on each conflicting
   *   assignment's scope, so controlling one schedule never decides another context's work;
   * - any remaining WARNING without a matching override blocks the save.
   * Resubmitting an override for a conflict state that a persisted override already covers is
   * still validated and authorized, but is idempotent: nothing new is recorded.
   */
  private acceptConflicts(
    access: ScheduleAccess,
    assignmentTarget: AuthorizationTarget,
    conflicts: EvaluatedConflict[],
    overrides: ScheduleConflictOverrideDto[],
  ): AcceptedOverride[] {
    if (conflicts.some((conflict) => conflict.severity === 'ERROR')) {
      throw this.conflictException(
        'SCHEDULE_CONFLICT_ERROR',
        'The shift conflicts with existing scheduled work and cannot be saved.',
        conflicts,
        access.grants,
      );
    }

    const accepted: AcceptedOverride[] = [];
    if (overrides.length > 0) {
      if (
        !permissionIsGranted(
          access.grants,
          OVERRIDE_PERMISSION,
          access.target,
        ) ||
        !permissionIsGranted(
          access.grants,
          OVERRIDE_PERMISSION,
          assignmentTarget,
        )
      ) {
        throw new ForbiddenException(
          'Missing permission schedule.override_conflict for the requested scope.',
        );
      }
      const byKey = new Map(
        conflicts.map((conflict) => [conflict.key, conflict]),
      );
      for (const override of overrides) {
        const conflict = byKey.get(override.conflictKey);
        if (
          !conflict ||
          conflict.type !== override.conflictType ||
          !conflict.overrideAllowed
        ) {
          throw this.conflictException(
            'SCHEDULE_CONFLICT_OVERRIDE_STALE',
            'A conflict override does not match a current overrideable conflict; re-evaluate the shift and try again.',
            conflicts,
            access.grants,
          );
        }
        if (
          !permissionIsGranted(
            access.grants,
            'schedule.manage',
            conflict.conflictingTarget,
          ) ||
          !permissionIsGranted(
            access.grants,
            OVERRIDE_PERMISSION,
            conflict.conflictingTarget,
          )
        ) {
          throw new ForbiddenException(
            'Missing permission schedule.manage and schedule.override_conflict for the conflicting assignment scope.',
          );
        }
        if (!conflict.overrideId) {
          accepted.push({ conflict, reason: override.reason });
        }
      }
    }

    const approved = new Set(overrides.map((override) => override.conflictKey));
    if (
      conflicts.some(
        (conflict) =>
          this.requiresOverride(conflict) && !approved.has(conflict.key),
      )
    ) {
      throw this.conflictException(
        'SCHEDULE_CONFLICT_OVERRIDE_REQUIRED',
        'The shift has scheduling conflicts that require an explicit override with a reason.',
        conflicts,
        access.grants,
      );
    }
    return accepted;
  }

  private requiresOverride(conflict: EvaluatedConflict) {
    return (
      conflict.severity === 'WARNING' &&
      conflict.overrideAllowed &&
      !conflict.overrideId
    );
  }

  private async recordOverrides(
    shift: ScheduledShift,
    resolved: ResolvedShift,
    accepted: AcceptedOverride[],
    context: SchedulingRequestContext,
    tx: SchedulingClient,
  ) {
    const actor = this.requireActor(context);
    for (const { conflict, reason } of accepted) {
      const snapshot = {
        employeeId: conflict.employeeId,
        shift: {
          id: shift.id,
          scheduleId: shift.scheduleId,
          employmentAssignmentId: resolved.data.employmentAssignmentId,
          workDate: dateOnly(resolved.data.workDate),
          startsAt: resolved.data.startsAt.toISOString(),
          endsAt: resolved.data.endsAt.toISOString(),
        },
        conflictingShift: conflict.conflictingShift
          ? {
              id: conflict.conflictingShift.id,
              scheduleId: conflict.conflictingShift.scheduleId,
              employmentAssignmentId:
                conflict.conflictingShift.employmentAssignmentId,
              workDate: dateOnly(conflict.conflictingShift.workDate),
              startsAt: conflict.conflictingShift.startsAt.toISOString(),
              endsAt: conflict.conflictingShift.endsAt.toISOString(),
            }
          : null,
        overlap: {
          startsAt: conflict.overlap.startsAt.toISOString(),
          endsAt: conflict.overlap.endsAt.toISOString(),
        },
        severity: conflict.severity,
      };
      const row = await tx.scheduleConflictOverride.create({
        data: {
          scheduledShiftId: shift.id,
          conflictingShiftId: conflict.conflictingShift?.id ?? null,
          conflictType: conflict.type,
          conflictKey: conflict.key,
          reason,
          metadata: snapshot,
          overriddenByUserId: actor,
        },
      });
      await this.writeAudit(
        tx,
        'SCHEDULE_CONFLICT_OVERRIDDEN',
        'ScheduledShift',
        shift.id,
        context,
        {
          overrideId: row.id,
          conflictType: conflict.type,
          conflictKey: conflict.key,
          conflictingShiftId: conflict.conflictingShift?.id ?? null,
          reason,
          ...snapshot,
        },
      );
    }
  }

  private conflictException(
    code: ConflictErrorCode,
    message: string,
    conflicts: EvaluatedConflict[],
    grants: EffectiveGrant[],
  ) {
    return new ConflictException({
      statusCode: 409,
      error: 'Conflict',
      code,
      message,
      conflicts: conflicts.map((conflict) =>
        this.conflictShape(conflict, grants),
      ),
    });
  }

  /**
   * The conflicting shift's schedule and assignment are disclosed only when the actor can
   * see that work context; its id and interval are always returned so the conflict can be
   * understood and, where allowed, overridden by key.
   */
  private conflictShape(conflict: EvaluatedConflict, grants: EffectiveGrant[]) {
    const visible = this.grantsAny(grants, conflict.conflictingTarget);
    const other = conflict.conflictingShift;
    return {
      key: conflict.key,
      type: conflict.type,
      severity: conflict.severity,
      overrideAllowed: conflict.overrideAllowed,
      overridden: conflict.overrideId !== null,
      overrideId: conflict.overrideId,
      message: conflict.message,
      employeeId: conflict.employeeId,
      employmentAssignmentId: conflict.employmentAssignmentId,
      conflictingShift: other
        ? {
            id: other.id,
            scheduleId: visible ? other.scheduleId : null,
            employmentAssignmentId: visible
              ? other.employmentAssignmentId
              : null,
            workDate: dateOnly(other.workDate),
            startsAt: other.startsAt.toISOString(),
            endsAt: other.endsAt.toISOString(),
          }
        : null,
      overlap: {
        startsAt: conflict.overlap.startsAt.toISOString(),
        endsAt: conflict.overlap.endsAt.toISOString(),
      },
    };
  }

  /** The scope target must exist, belong to the Schedule's organization, and be active. */
  private async assertScopeTarget(scope: ScopeColumns, tx: SchedulingClient) {
    const organization = await tx.organization.findUnique({
      where: { id: scope.organizationId },
    });
    if (!organization) throw new NotFoundException('Organization not found');
    if (organization.archivedAt) {
      throw new BadRequestException(
        'Schedules cannot be scoped to an archived organization.',
      );
    }

    const target = scope.organizationalUnitId
      ? await tx.organizationalUnit.findUnique({
          where: { id: scope.organizationalUnitId },
        })
      : scope.departmentId
        ? await tx.department.findUnique({ where: { id: scope.departmentId } })
        : scope.teamId
          ? await tx.team.findUnique({ where: { id: scope.teamId } })
          : null;
    if (scope.scopeType === 'ORGANIZATION') return;
    if (!target) throw new NotFoundException('Schedule scope target not found');
    this.domain.assertScopeTargetOrganization(
      scope.organizationId,
      target.organizationId,
    );
    if (target.archivedAt) {
      throw new BadRequestException(
        'Schedules cannot be scoped to an archived organizational target.',
      );
    }
  }

  // ─── Access ─────────────────────────────────────────────────────────────────

  /**
   * Loads a Schedule the actor may see. Schedules outside the actor's read scope are
   * reported as not found so other organizations' data is never exposed; visible
   * Schedules the actor cannot manage are forbidden. With lock, the row is held FOR UPDATE
   * or FOR SHARE so status, period, and child-shift checks stay consistent until commit.
   */
  private async requireSchedule(
    actor: string,
    scheduleId: string,
    permission: SchedulePermission,
    client: SchedulingClient,
    options: { lock?: ScheduleLock } = {},
  ): Promise<ScheduleAccess> {
    if (options.lock === 'update') {
      await client.$queryRaw(
        Prisma.sql`SELECT "id" FROM "Schedule" WHERE "id" = ${scheduleId}::uuid FOR UPDATE`,
      );
    } else if (options.lock === 'share') {
      await client.$queryRaw(
        Prisma.sql`SELECT "id" FROM "Schedule" WHERE "id" = ${scheduleId}::uuid FOR SHARE`,
      );
    }
    const schedule = await client.schedule.findUnique({
      where: { id: scheduleId },
    });
    if (!schedule) throw new NotFoundException('Schedule not found');
    const grants = await this.scheduleGrants(actor, client);
    const target = await this.authorization.resolveTarget(
      this.authorizationScope(schedule),
      client,
    );
    if (!this.grantsAny(grants, target)) {
      throw new NotFoundException('Schedule not found');
    }
    if (
      permission === 'schedule.manage' &&
      !permissionIsGranted(grants, 'schedule.manage', target)
    ) {
      throw new ForbiddenException(
        'Missing permission schedule.manage for the requested scope.',
      );
    }
    // Phase 18: every schedule (and shift) route loads its schedule here.
    await this.features.require(schedule.organizationId, 'SCHEDULING', client);
    return { schedule, grants, target };
  }

  /**
   * Published changes need schedule.manage and schedule.publish on the Schedule scope: changing
   * operational expected work carries the same authority as publishing it.
   */
  private async requirePublishedChange(
    actor: string,
    scheduleId: string,
    tx: SchedulingClient,
  ) {
    const access = await this.requireSchedule(
      actor,
      scheduleId,
      'schedule.manage',
      tx,
      { lock: 'share' },
    );
    this.assertPublishPermission(access);
    if (access.schedule.status !== 'PUBLISHED') {
      throw new ConflictException(
        'Only PUBLISHED schedules accept corrections, additions, and cancellations; change DRAFT schedules directly.',
      );
    }
    return access;
  }

  private assertPublishPermission(access: ScheduleAccess) {
    if (
      !permissionIsGranted(access.grants, PUBLISH_PERMISSION, access.target)
    ) {
      throw new ForbiddenException(
        'Missing permission schedule.publish for the requested scope.',
      );
    }
  }

  /**
   * Holds the shift so published changes to it serialize. FOR NO KEY UPDATE, like the Employee
   * lock, still lets other transactions insert overrides that reference this shift by key.
   */
  private async lockShift(
    scheduleId: string,
    shiftId: string,
    tx: SchedulingClient,
  ) {
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "ScheduledShift" WHERE "id" = ${shiftId}::uuid AND "scheduleId" = ${scheduleId}::uuid FOR NO KEY UPDATE`,
    );
    return this.requireShift(scheduleId, shiftId, tx);
  }

  /**
   * A published shift is never invisibly reassigned to another employee: a correction may move
   * it between the same employee's assignments, while coverage is cancel-A + add-B.
   */
  private async assertSameEmployee(
    currentAssignmentId: string,
    nextAssignmentId: string,
    tx: SchedulingClient,
  ) {
    const assignments = await tx.employmentAssignment.findMany({
      where: { id: { in: [currentAssignmentId, nextAssignmentId] } },
      select: { id: true, employeeId: true },
    });
    const current = assignments.find((row) => row.id === currentAssignmentId);
    const next = assignments.find((row) => row.id === nextAssignmentId);
    if (!next) throw new NotFoundException('EmploymentAssignment not found');
    if (current?.employeeId !== next.employeeId) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        code: 'PUBLISHED_SHIFT_REASSIGNMENT_NOT_ALLOWED',
        message:
          'A published shift cannot be moved to another employee. Cancel it and add a shift for the covering assignment.',
      });
    }
  }

  /** Matches resolveShift: changing a shift requires authority over its assignment's scope. */
  private async assertManagesShiftAssignment(
    grants: EffectiveGrant[],
    shift: ScheduledShift,
    tx: SchedulingClient,
  ) {
    const assignment = await tx.employmentAssignment.findUnique({
      where: { id: shift.employmentAssignmentId },
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
    if (!permissionIsGranted(grants, 'schedule.manage', target)) {
      throw new ForbiddenException(
        'Missing permission schedule.manage for the employment assignment scope.',
      );
    }
  }

  private async requireShift(
    scheduleId: string,
    shiftId: string,
    client: SchedulingClient,
  ) {
    const shift = await client.scheduledShift.findFirst({
      where: { id: shiftId, scheduleId },
    });
    if (!shift) throw new NotFoundException('Scheduled shift not found');
    return shift;
  }

  private async scheduleGrants(userId: string, client: SchedulingClient) {
    return (
      await this.authorization.effectiveGrants(userId, new Date(), client)
    ).filter(
      (grant) =>
        grant.permission === 'schedule.read' ||
        grant.permission === 'schedule.manage' ||
        grant.permission === OVERRIDE_PERMISSION ||
        grant.permission === PUBLISH_PERMISSION,
    );
  }

  /** schedule.manage implies visibility, matching how management permissions read in Phase 6. */
  private grantsAny(grants: EffectiveGrant[], target: AuthorizationTarget) {
    return (
      permissionIsGranted(grants, 'schedule.read', target) ||
      permissionIsGranted(grants, 'schedule.manage', target)
    );
  }

  private async cachedTarget(
    schedule: ScopeColumns,
    cache: Map<string, AuthorizationTarget | null>,
  ) {
    const scope = this.authorizationScope(schedule);
    const key = `${scope.type}:${scope.id}`;
    if (!cache.has(key)) {
      try {
        cache.set(
          key,
          await this.authorization.resolveTarget(scope, this.prisma),
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

  private newShiftCandidate(input: ScheduledShiftFieldsDto): ShiftCandidate {
    return {
      employmentAssignmentId: input.employmentAssignmentId,
      workLocationId: input.workLocationId ?? null,
      workDate: this.domain.parseDateOnly(input.workDate, 'workDate'),
      startsAt: this.domain.parseInstant(input.startsAt, 'startsAt'),
      endsAt: this.domain.parseInstant(input.endsAt, 'endsAt'),
      explicitTimezone: input.timezone ?? null,
    };
  }

  private parseShiftPatch(input: UpdateScheduledShiftFieldsDto) {
    return {
      workDate: input.workDate
        ? this.domain.parseDateOnly(input.workDate, 'workDate')
        : undefined,
      startsAt: input.startsAt
        ? this.domain.parseInstant(input.startsAt, 'startsAt')
        : undefined,
      endsAt: input.endsAt
        ? this.domain.parseInstant(input.endsAt, 'endsAt')
        : undefined,
    };
  }

  /** The merged final state of an update: unspecified fields keep their stored values. */
  private mergedShiftCandidate(
    shift: ScheduledShift,
    input: UpdateScheduledShiftFieldsDto,
    patch: ReturnType<SchedulingService['parseShiftPatch']>,
  ): ShiftCandidate {
    return {
      employmentAssignmentId:
        input.employmentAssignmentId ?? shift.employmentAssignmentId,
      workLocationId:
        input.workLocationId === undefined
          ? shift.workLocationId
          : input.workLocationId,
      workDate: patch.workDate ?? shift.workDate,
      startsAt: patch.startsAt ?? shift.startsAt,
      endsAt: patch.endsAt ?? shift.endsAt,
      // Without a new explicit timezone, the shift keeps its current one as the fallback.
      explicitTimezone: input.timezone ?? shift.timezone,
    };
  }

  /** A stored shift as a candidate, so publication re-validates exactly what is stored. */
  private storedShiftCandidate(shift: ScheduledShift): ShiftCandidate {
    return {
      employmentAssignmentId: shift.employmentAssignmentId,
      workLocationId: shift.workLocationId,
      workDate: shift.workDate,
      startsAt: shift.startsAt,
      endsAt: shift.endsAt,
      explicitTimezone: shift.timezone,
    };
  }

  private changeReason(value: string | undefined) {
    const reason = value?.trim();
    if (!reason) {
      throw new BadRequestException(
        'A reason is required to change a published shift.',
      );
    }
    return reason;
  }

  private assertActiveShift(shift: Pick<ScheduledShift, 'status'>) {
    if (shift.status !== 'ACTIVE') {
      throw new ConflictException(
        'A CANCELLED shift is final and cannot be corrected.',
      );
    }
  }

  /** The full expected-work state of a shift, as recorded on every revision. */
  private revisionSnapshot(shift: ScheduledShift) {
    return {
      scheduledShiftId: shift.id,
      employmentAssignmentId: shift.employmentAssignmentId,
      workLocationId: shift.workLocationId,
      workDate: shift.workDate,
      startsAt: shift.startsAt,
      endsAt: shift.endsAt,
      timezone: shift.timezone,
      status: shift.status,
      sourceType: shift.sourceType,
    };
  }

  /**
   * A correction or cancellation of a published shift never rewrites attendance already
   * interpreted against it: Time & Attendance raises a review signal per linked TimeEntry.
   */
  private async raiseAttendanceReviews(
    revision: Parameters<typeof raiseScheduleRevisionReviewSignals>[1],
    context: SchedulingRequestContext,
    tx: Prisma.TransactionClient,
  ) {
    const signals = await raiseScheduleRevisionReviewSignals(
      tx,
      revision,
      new Date(),
    );
    for (const signal of signals) {
      await this.writeAudit(
        tx,
        signal.created
          ? 'TIME_SCHEDULE_CHANGE_REVIEW_CREATED'
          : 'TIME_SCHEDULE_CHANGE_REVIEW_UPDATED',
        'AttendanceException',
        signal.exceptionId,
        context,
        {
          employeeId: signal.employeeId,
          timeEntryId: signal.timeEntryId,
          attendanceSignInId: signal.attendanceSignInId,
          scheduledShiftId: revision.scheduledShiftId,
          interpretedRevisionId: signal.interpretedRevisionId,
          interpretedRevisionNumber: signal.interpretedRevisionNumber,
          currentRevisionId: revision.id,
          currentRevisionNumber: revision.revisionNumber,
        },
      );
    }
    return signals;
  }

  /**
   * Appends the next revision of a shift whose row is locked by the caller. The unique
   * (scheduledShiftId, revisionNumber) index backstops the numbering.
   */
  private async appendRevision(
    shift: ScheduledShift,
    revisionType: ScheduledShiftRevisionType,
    reason: string,
    actor: string,
    tx: SchedulingClient,
  ) {
    const latest = await tx.scheduledShiftRevision.findFirst({
      where: { scheduledShiftId: shift.id },
      orderBy: { revisionNumber: 'desc' },
      select: { revisionNumber: true },
    });
    if (!latest && revisionType !== 'PUBLISHED_BASELINE') {
      throw new ConflictException(
        'The published shift has no baseline revision; its history cannot be extended.',
      );
    }
    return tx.scheduledShiftRevision.create({
      data: {
        ...this.revisionSnapshot(shift),
        revisionNumber: (latest?.revisionNumber ?? 0) + 1,
        revisionType,
        reason,
        changedByUserId: actor,
      },
    });
  }

  /** Overrides are explicit and accountable: one per conflict, each with a non-blank reason. */
  private overrideInputs(
    overrides: ScheduleConflictOverrideDto[] | undefined,
  ): ScheduleConflictOverrideDto[] {
    const seen = new Set<string>();
    return (overrides ?? []).map((override) => {
      const reason = override.reason?.trim();
      if (!reason) {
        throw new BadRequestException(
          'A reason is required to override a scheduling conflict.',
        );
      }
      if (seen.has(override.conflictKey)) {
        throw new BadRequestException(
          'Each conflict can be overridden only once per request.',
        );
      }
      seen.add(override.conflictKey);
      return {
        conflictType: override.conflictType,
        conflictKey: override.conflictKey,
        reason,
      };
    });
  }

  private assertDraft(schedule: Pick<Schedule, 'status'>) {
    if (schedule.status !== 'DRAFT') {
      throw new ConflictException(
        'Only DRAFT schedules can be changed here; published shifts change only through the explicit correction, addition, and cancellation workflows.',
      );
    }
  }

  private assertManualShift(shift: Pick<ScheduledShift, 'sourceType'>) {
    if (shift.sourceType !== 'MANUAL') {
      throw new ConflictException('Only MANUAL shifts can be changed here.');
    }
  }

  private scheduleName(value: string) {
    const name = value.trim();
    if (!name) throw new BadRequestException('Schedule name is required.');
    return name;
  }

  private requireActor(context: SchedulingRequestContext) {
    if (!context.actorUserId) throw new ForbiddenException();
    return context.actorUserId;
  }

  private pageLimit(limit?: number) {
    return Math.min(Math.max(limit ?? 25, 1), 100);
  }

  private changes<T extends Record<string, unknown>>(
    before: T,
    after: T,
    fields: readonly (keyof T & string)[],
  ) {
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const field of fields) {
      if (before[field] !== after[field]) {
        changes[field] = { from: before[field], to: after[field] };
      }
    }
    return changes;
  }

  private scheduleShape(schedule: Schedule) {
    return {
      id: schedule.id,
      scopeType: schedule.scopeType,
      organizationId: schedule.organizationId,
      organizationalUnitId: schedule.organizationalUnitId,
      departmentId: schedule.departmentId,
      teamId: schedule.teamId,
      name: schedule.name,
      periodStart: dateOnly(schedule.periodStart),
      periodEnd: dateOnly(schedule.periodEnd),
      type: schedule.type,
      status: schedule.status,
      publishedAt: schedule.publishedAt?.toISOString() ?? null,
      publishedByUserId: schedule.publishedByUserId,
      createdAt: schedule.createdAt.toISOString(),
      updatedAt: schedule.updatedAt.toISOString(),
    };
  }

  private shiftShape(shift: ScheduledShift) {
    return {
      id: shift.id,
      scheduleId: shift.scheduleId,
      employmentAssignmentId: shift.employmentAssignmentId,
      workLocationId: shift.workLocationId,
      workDate: dateOnly(shift.workDate),
      startsAt: shift.startsAt.toISOString(),
      endsAt: shift.endsAt.toISOString(),
      timezone: shift.timezone,
      status: shift.status,
      sourceType: shift.sourceType,
      createdAt: shift.createdAt.toISOString(),
      updatedAt: shift.updatedAt.toISOString(),
    };
  }

  private revisionShape(revision: ScheduledShiftRevision) {
    return {
      id: revision.id,
      scheduledShiftId: revision.scheduledShiftId,
      revisionNumber: revision.revisionNumber,
      revisionType: revision.revisionType,
      employmentAssignmentId: revision.employmentAssignmentId,
      workLocationId: revision.workLocationId,
      workDate: dateOnly(revision.workDate),
      startsAt: revision.startsAt.toISOString(),
      endsAt: revision.endsAt.toISOString(),
      timezone: revision.timezone,
      status: revision.status,
      sourceType: revision.sourceType,
      reason: revision.reason,
      changedByUserId: revision.changedByUserId,
      changedAt: revision.changedAt.toISOString(),
    };
  }

  private writeAudit(
    client: SchedulingClient,
    action: string,
    entityType: 'Schedule' | 'ScheduledShift' | 'AttendanceException',
    entityId: string,
    context: SchedulingRequestContext,
    metadata: Record<string, unknown>,
  ) {
    return this.audit.write(
      {
        action,
        actorUserId: context.actorUserId,
        entityType,
        entityId,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
        correlationId: context.correlationId,
        metadata: JSON.parse(JSON.stringify(metadata)) as Prisma.InputJsonValue,
      },
      client,
    );
  }
}

function dateOnly(value: Date) {
  return value.toISOString().slice(0, 10);
}

function exceptionMessage(error: HttpException) {
  const response = error.getResponse();
  if (typeof response === 'string') return response;
  const message = (response as { message?: unknown }).message;
  if (Array.isArray(message)) return message.join('; ');
  return typeof message === 'string' ? message : error.message;
}
