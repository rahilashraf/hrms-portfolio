import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
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
import { Prisma, type Schedule } from '../generated/prisma/client.js';
import {
  SchedulePolicyResolver,
  type SchedulePolicyContext,
} from './schedule-policy-resolver.js';
import { addDays, formatDateOnly } from './schedule-recurrence.js';
import {
  MAX_VIEW_RANGE_DAYS,
  type MyScheduleQueryDto,
  type ScheduledHoursDimension,
  type ScheduledHoursQueryDto,
  type ScheduleGridQueryDto,
  type ScheduleRangeQueryDto,
} from './scheduling-view.dto.js';
import type { SCHEDULE_STATUSES } from './scheduling.dto.js';
import { SchedulingDomainService } from './scheduling-domain.service.js';
import {
  holidaysForAssignments,
  holidaysForViews,
  type ScheduleHolidayMarker,
} from './schedule-holidays.js';

const VIEW_PERMISSIONS = [
  'schedule.read',
  'schedule.manage',
  'schedule.publish',
  'schedule.override_conflict',
  'schedule.manage_patterns',
] as const;

/** Report group keys: a fixed SQL expression per dimension over s/a/p (shift, assignment, position). */
const SCHEDULED_HOURS_KEYS: Record<ScheduledHoursDimension, Prisma.Sql> = {
  organization: Prisma.sql`p."organizationId"`,
  organizationalUnit: Prisma.sql`p."organizationalUnitId"`,
  department: Prisma.sql`p."departmentId"`,
  team: Prisma.sql`p."teamId"`,
  employee: Prisma.sql`a."employeeId"`,
  employmentAssignment: Prisma.sql`s."employmentAssignmentId"`,
  position: Prisma.sql`a."positionId"`,
  workLocation: Prisma.sql`s."workLocationId"`,
  workDate: Prisma.sql`to_char(s."workDate", 'YYYY-MM-DD')`,
  schedule: Prisma.sql`s."scheduleId"`,
  status: Prisma.sql`s."status"`,
  sourceType: Prisma.sql`s."sourceType"`,
};

/** One query loads a page of shifts with everything the views show: no per-row queries. */
const SHIFT_VIEW_INCLUDE = {
  schedule: true,
  workLocation: {
    select: { id: true, name: true, code: true, timezone: true },
  },
  employmentAssignment: {
    select: {
      id: true,
      employeeId: true,
      isPrimary: true,
      employmentType: true,
      employee: {
        select: {
          id: true,
          employeeNumber: true,
          person: {
            select: { firstName: true, lastName: true, preferredName: true },
          },
        },
      },
      position: {
        select: {
          id: true,
          name: true,
          code: true,
          organizationId: true,
          organizationalUnitId: true,
          departmentId: true,
          teamId: true,
          organization: { select: { id: true, name: true } },
        },
      },
    },
  },
  revisions: {
    orderBy: { revisionNumber: 'desc' },
    take: 1,
    select: { id: true, revisionNumber: true, revisionType: true },
  },
} satisfies Prisma.ScheduledShiftInclude;

type ViewShift = Prisma.ScheduledShiftGetPayload<{
  include: typeof SHIFT_VIEW_INCLUDE;
}>;

/**
 * Phase 7 Batch 8 — read models for the employee's own schedule and the manager/admin grid.
 * Backend only: shapes are normalized and carry backend-computed action flags so clients never
 * re-derive authorization or lifecycle rules. Both views read a bounded workDate range.
 */
@Injectable()
export class SchedulingViewService {
  private readonly policies: SchedulePolicyResolver;

  constructor(
    private readonly prisma: PrismaService,
    private readonly domain: SchedulingDomainService,
    private readonly authorization: AuthorizationService,
    private readonly targets: PositionAuthorizationTargetResolver,
    @Optional() policies?: SchedulePolicyResolver,
    @Optional() features?: FeatureGateService,
  ) {
    this.policies = policies ?? new SchedulePolicyResolver(prisma, targets);
    this.features = featureGateFor(prisma, features);
  }

  /** Phase 18: the SCHEDULING module gate. */
  readonly features: FeatureGateService;

  /**
   * The signed-in employee's PUBLISHED shifts across every one of their EmploymentAssignments,
   * in any organization. Draft planning is never shown; cancelled shifts only on request.
   */
  async mySchedule(userId: string, query: MyScheduleQueryDto) {
    const range = this.range(query);
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        person: {
          select: { employee: { select: { id: true, archivedAt: true } } },
        },
      },
    });
    const employee = user?.person?.employee;
    if (!employee || employee.archivedAt) {
      throw new ForbiddenException('Authenticated user is not an employee.');
    }
    const shifts = await this.prisma.scheduledShift.findMany({
      where: {
        employmentAssignment: { employeeId: employee.id },
        // Phase 18: organizations with Scheduling disabled are left out.
        schedule: {
          status: 'PUBLISHED',
          organizationId: {
            notIn: [
              ...(await this.features.disabledOrganizations('SCHEDULING')),
            ],
          },
        },
        status: query.includeCancelled ? undefined : 'ACTIVE',
        workDate: { gte: range.from, lte: range.to },
      },
      include: SHIFT_VIEW_INCLUDE,
      orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
    });
    return {
      employeeId: employee.id,
      range: this.rangeShape(range),
      holidays: await this.ownHolidays(employee.id, range),
      items: shifts.map((shift) => ({
        ...this.shiftShape(shift),
        // Self-service shift actions (clock-in eligibility) come from Time & Attendance.
        actions: {},
      })),
    };
  }

  /**
   * The scoped schedule grid of one organization. A shift is visible when the actor can read
   * its Schedule's scope (the Batch 2 rule); everything else is filtered out, never disclosed.
   */
  async grid(userId: string, query: ScheduleGridQueryDto) {
    const range = this.range(query);
    const max = Math.min(Math.max(query.limit ?? 100, 1), 200);
    const empty = {
      range: this.rangeShape(range),
      holidays: [] as ScheduleHolidayMarker[],
      items: [],
      nextAfterId: null,
    };
    const { grants, visible } = await this.visibleSchedules(
      userId,
      query,
      range,
    );
    if (visible.size === 0) return empty;

    const unitIds = query.organizationalUnitId
      ? await this.unitSubtree(query.organizationId, query.organizationalUnitId)
      : null;
    const shifts = await this.prisma.scheduledShift.findMany({
      where: {
        scheduleId: { in: [...visible.keys()] },
        workDate: { gte: range.from, lte: range.to },
        ...(query.status ? { status: query.status } : {}),
        ...(query.sourceType ? { sourceType: query.sourceType } : {}),
        ...(query.workLocationId
          ? { workLocationId: query.workLocationId }
          : {}),
        ...(query.employmentAssignmentId
          ? { employmentAssignmentId: query.employmentAssignmentId }
          : {}),
        employmentAssignment: {
          ...(query.employeeId ? { employeeId: query.employeeId } : {}),
          position: {
            ...(query.positionId ? { id: query.positionId } : {}),
            ...(query.teamId ? { teamId: query.teamId } : {}),
            ...(query.departmentId ? { departmentId: query.departmentId } : {}),
            ...(unitIds ? { organizationalUnitId: { in: unitIds } } : {}),
          },
        },
      },
      include: SHIFT_VIEW_INCLUDE,
      orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
      take: max + 1,
      ...(query.afterId ? { cursor: { id: query.afterId }, skip: 1 } : {}),
    });
    const page = shifts.slice(0, max);

    const positionTargets = new Map<string, AuthorizationTarget>();
    const policyContexts = new Map<string, SchedulePolicyContext>();
    const items = [];
    for (const shift of page) {
      const positionId = shift.employmentAssignment.position.id;
      if (!positionTargets.has(positionId)) {
        positionTargets.set(
          positionId,
          await this.targets.resolvePosition(
            positionId,
            undefined,
            this.prisma,
          ),
        );
        policyContexts.set(
          positionId,
          await this.policies.forPosition(positionId, this.prisma),
        );
      }
      items.push({
        ...this.shiftShape(shift),
        actions: this.actions(
          shift,
          grants,
          visible.get(shift.scheduleId)!,
          positionTargets.get(positionId)!,
          policyContexts.get(positionId)!,
        ),
      });
    }
    return {
      range: this.rangeShape(range),
      holidays: await this.viewHolidays(query.organizationId, range, [
        ...visible.values(),
      ]),
      items,
      nextAfterId: shifts.length > max ? (page.at(-1)?.id ?? null) : null,
    };
  }

  // ─── Holiday markers (R4-A.6) ───────────────────────────────────────────────

  private holidaysInRange(
    organizationIds: string[],
    range: { from: Date; to: Date },
  ) {
    return this.prisma.organizationHoliday.findMany({
      where: {
        organizationId: { in: organizationIds },
        archivedAt: null,
        date: { gte: range.from, lte: range.to },
      },
      orderBy: [{ date: 'asc' }, { name: 'asc' }, { id: 'asc' }],
    });
  }

  /** The grid: holidays that apply to, or lie inside, a schedule the reader may see. */
  private async viewHolidays(
    organizationId: string,
    range: { from: Date; to: Date },
    views: AuthorizationTarget[],
  ) {
    const holidays = await this.holidaysInRange([organizationId], range);
    const holidayTargets = new Map<string, AuthorizationTarget | null>();
    for (const holiday of holidays) {
      const scope = holiday.teamId
        ? ({ type: 'TEAM', id: holiday.teamId } as const)
        : holiday.departmentId
          ? ({ type: 'DEPARTMENT', id: holiday.departmentId } as const)
          : holiday.organizationalUnitId
            ? ({
                type: 'ORGANIZATIONAL_UNIT',
                id: holiday.organizationalUnitId,
              } as const)
            : null;
      holidayTargets.set(
        holiday.id,
        scope
          ? await this.authorization
              .resolveTarget(scope, this.prisma)
              .catch(() => null)
          : null,
      );
    }
    return holidaysForViews(holidays, holidayTargets, views);
  }

  /**
   * My Schedule: holidays of the employee's own assignments (not cancelled, in organizations
   * with Scheduling enabled) on the dates each assignment covers.
   */
  private async ownHolidays(
    employeeId: string,
    range: { from: Date; to: Date },
  ) {
    const disabled = [
      ...(await this.features.disabledOrganizations('SCHEDULING')),
    ];
    const assignments = await this.prisma.employmentAssignment.findMany({
      where: {
        employeeId,
        status: { not: 'CANCELLED' },
        startDate: { lte: range.to },
        OR: [{ endDate: null }, { endDate: { gte: range.from } }],
        position: { organizationId: { notIn: disabled } },
      },
      select: {
        startDate: true,
        endDate: true,
        positionId: true,
        position: { select: { organizationId: true } },
      },
    });
    if (assignments.length === 0) return [];
    const withTargets = [];
    for (const assignment of assignments) {
      withTargets.push({
        startDate: assignment.startDate,
        endDate: assignment.endDate,
        target: await this.targets.resolvePosition(
          assignment.positionId,
          undefined,
          this.prisma,
        ),
      });
    }
    const holidays = await this.holidaysInRange(
      [...new Set(assignments.map((a) => a.position.organizationId))],
      range,
    );
    return holidaysForAssignments(holidays, withTargets);
  }

  /**
   * Scheduled hours of one organization grouped by one dimension. Minutes are computed from the
   * stored startsAt/endsAt instants (so DST days and overnight shifts are exact), over the same
   * visible Schedules as the grid. Defaults to operational expected work: ACTIVE shifts of
   * PUBLISHED Schedules. Bounded by the view range and paged by group key.
   */
  async scheduledHours(userId: string, query: ScheduledHoursQueryDto) {
    const range = this.range(query);
    const limit = Math.min(Math.max(query.limit ?? 100, 1), 500);
    const filters = {
      organizationId: query.organizationId,
      scheduleId: query.scheduleId,
      scheduleStatus: query.scheduleStatus ?? 'PUBLISHED',
    };
    const result = {
      range: this.rangeShape(range),
      groupBy: query.groupBy,
      filters: {
        status: query.status ?? 'ACTIVE',
        scheduleStatus: filters.scheduleStatus,
      },
      groups: [] as Array<{
        key: string | null;
        shiftCount: number;
        scheduledMinutes: number;
      }>,
      nextAfterKey: null as string | null,
    };
    const { visible } = await this.visibleSchedules(userId, filters, range);
    if (visible.size === 0) return result;
    const unitIds = query.organizationalUnitId
      ? await this.unitSubtree(query.organizationId, query.organizationalUnitId)
      : null;
    const key = Prisma.sql`COALESCE((${SCHEDULED_HOURS_KEYS[query.groupBy]})::text, '')`;
    const conditions = [
      Prisma.sql`s."scheduleId" = ANY(${[...visible.keys()]}::uuid[])`,
      Prisma.sql`s."workDate" BETWEEN ${range.from}::date AND ${range.to}::date`,
      Prisma.sql`s."status" = ${query.status ?? 'ACTIVE'}::"ScheduledShiftStatus"`,
      ...(query.sourceType
        ? [
            Prisma.sql`s."sourceType" = ${query.sourceType}::"ScheduledShiftSourceType"`,
          ]
        : []),
      ...(query.workLocationId
        ? [Prisma.sql`s."workLocationId" = ${query.workLocationId}::uuid`]
        : []),
      ...(query.employmentAssignmentId
        ? [
            Prisma.sql`s."employmentAssignmentId" = ${query.employmentAssignmentId}::uuid`,
          ]
        : []),
      ...(query.employeeId
        ? [Prisma.sql`a."employeeId" = ${query.employeeId}::uuid`]
        : []),
      ...(query.positionId
        ? [Prisma.sql`p."id" = ${query.positionId}::uuid`]
        : []),
      ...(query.teamId ? [Prisma.sql`p."teamId" = ${query.teamId}::uuid`] : []),
      ...(query.departmentId
        ? [Prisma.sql`p."departmentId" = ${query.departmentId}::uuid`]
        : []),
      ...(unitIds
        ? [Prisma.sql`p."organizationalUnitId" = ANY(${unitIds}::uuid[])`]
        : []),
      ...(query.afterKey !== undefined
        ? [Prisma.sql`${key} > ${query.afterKey}`]
        : []),
    ];
    const rows = await this.prisma.$queryRaw<
      Array<{ key: string; shiftCount: number; scheduledMinutes: number }>
    >(Prisma.sql`
      SELECT ${key} AS "key",
             COUNT(*)::int AS "shiftCount",
             COALESCE(SUM(EXTRACT(EPOCH FROM (s."endsAt" - s."startsAt")) / 60), 0)::int AS "scheduledMinutes"
      FROM "ScheduledShift" s
      JOIN "EmploymentAssignment" a ON a."id" = s."employmentAssignmentId"
      JOIN "Position" p ON p."id" = a."positionId"
      WHERE ${Prisma.join(conditions, ' AND ')}
      GROUP BY 1
      ORDER BY 1
      LIMIT ${limit + 1}
    `);
    const page = rows.slice(0, limit);
    result.groups = page.map((row) => ({
      key: row.key === '' ? null : row.key,
      shiftCount: row.shiftCount,
      scheduledMinutes: row.scheduledMinutes,
    }));
    result.nextAfterKey =
      rows.length > limit ? (page.at(-1)?.key ?? null) : null;
    return result;
  }

  /** Schedules overlapping the range whose scope the actor can read (the Batch 2 rule). */
  private async visibleSchedules(
    userId: string,
    query: {
      organizationId: string;
      scheduleId?: string;
      scheduleStatus?: (typeof SCHEDULE_STATUSES)[number];
    },
    range: { from: Date; to: Date },
  ) {
    const grants = (
      await this.authorization.effectiveGrants(userId, new Date(), this.prisma)
    ).filter((grant) =>
      (VIEW_PERMISSIONS as readonly string[]).includes(grant.permission),
    );
    const visible = new Map<string, AuthorizationTarget>();
    if (grants.length === 0) return { grants, visible };
    const schedules = await this.prisma.schedule.findMany({
      where: {
        organizationId: query.organizationId,
        periodStart: { lte: range.to },
        periodEnd: { gte: range.from },
        ...(query.scheduleId ? { id: query.scheduleId } : {}),
        ...(query.scheduleStatus ? { status: query.scheduleStatus } : {}),
      },
    });
    const targetCache = new Map<string, AuthorizationTarget | null>();
    for (const schedule of schedules) {
      const target = await this.scheduleTarget(schedule, targetCache);
      if (target && this.canRead(grants, target))
        visible.set(schedule.id, target);
    }
    if (visible.size > 0)
      await this.features.require(query.organizationId, 'SCHEDULING');
    return { grants, visible };
  }

  // ─── Actions ────────────────────────────────────────────────────────────────

  /**
   * Each flag mirrors the checks of the endpoint it stands for, so a true flag means the call
   * would pass authorization and lifecycle rules (conflict and validation rules still apply).
   */
  private actions(
    shift: ViewShift,
    grants: EffectiveGrant[],
    scheduleTarget: AuthorizationTarget,
    assignmentTarget: AuthorizationTarget,
    policies: SchedulePolicyContext,
  ) {
    const on = (permission: string, target: AuthorizationTarget) =>
      permissionIsGranted(grants, permission, target);
    const draft = shift.schedule.status === 'DRAFT';
    const published = shift.schedule.status === 'PUBLISHED';
    const active = shift.status === 'ACTIVE';
    const manages =
      on('schedule.manage', scheduleTarget) &&
      on('schedule.manage', assignmentTarget);
    const publishes = on('schedule.publish', scheduleTarget);
    const editableDraft = draft && shift.sourceType === 'MANUAL' && manages;
    const changeablePublished = published && active && manages && publishes;
    return {
      canEditDraft: editableDraft,
      canDeleteDraft: editableDraft,
      canPublish: draft && on('schedule.manage', scheduleTarget) && publishes,
      canCorrect: changeablePublished,
      canCancel: changeablePublished,
      canOverrideConflict:
        active &&
        (editableDraft || changeablePublished) &&
        on('schedule.override_conflict', scheduleTarget) &&
        on('schedule.override_conflict', assignmentTarget) &&
        policies.resolve(shift.workDate).allowManagerConflictOverride,
      canManagePattern:
        shift.sourceType === 'PATTERN' &&
        on('schedule.manage_patterns', assignmentTarget),
    };
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  private range(query: ScheduleRangeQueryDto) {
    const from = this.domain.parseDateOnly(query.from, 'from');
    const to = this.domain.parseDateOnly(query.to, 'to');
    if (to < from)
      throw new BadRequestException('to must be on or after from.');
    if (to > addDays(from, MAX_VIEW_RANGE_DAYS - 1)) {
      throw new BadRequestException(
        `A schedule view may span at most ${MAX_VIEW_RANGE_DAYS} days.`,
      );
    }
    return { from, to };
  }

  private rangeShape(range: { from: Date; to: Date }) {
    return { from: formatDateOnly(range.from), to: formatDateOnly(range.to) };
  }

  private canRead(grants: EffectiveGrant[], target: AuthorizationTarget) {
    return (
      permissionIsGranted(grants, 'schedule.read', target) ||
      permissionIsGranted(grants, 'schedule.manage', target)
    );
  }

  private async scheduleTarget(
    schedule: Schedule,
    cache: Map<string, AuthorizationTarget | null>,
  ) {
    const scope = scheduleScope(schedule);
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

  /** A unit and all of its descendants. */
  private async unitSubtree(organizationId: string, unitId: string) {
    const units = await this.prisma.organizationalUnit.findMany({
      where: { organizationId },
      select: { id: true, parentUnitId: true },
    });
    const result = new Set([unitId]);
    for (let grew = true; grew;) {
      grew = false;
      for (const unit of units) {
        if (
          unit.parentUnitId &&
          result.has(unit.parentUnitId) &&
          !result.has(unit.id)
        ) {
          result.add(unit.id);
          grew = true;
        }
      }
    }
    return [...result];
  }

  private shiftShape(shift: ViewShift) {
    const assignment = shift.employmentAssignment;
    const person = assignment.employee.person;
    const revision = shift.revisions[0] ?? null;
    return {
      id: shift.id,
      scheduleId: shift.scheduleId,
      schedule: {
        id: shift.schedule.id,
        name: shift.schedule.name,
        status: shift.schedule.status,
        type: shift.schedule.type,
        scopeType: shift.schedule.scopeType,
        periodStart: formatDateOnly(shift.schedule.periodStart),
        periodEnd: formatDateOnly(shift.schedule.periodEnd),
      },
      employmentAssignmentId: assignment.id,
      employee: {
        id: assignment.employee.id,
        employeeNumber: assignment.employee.employeeNumber,
        displayName:
          [person.preferredName ?? person.firstName, person.lastName]
            .filter(Boolean)
            .join(' ') || null,
      },
      assignment: {
        id: assignment.id,
        isPrimary: assignment.isPrimary,
        employmentType: assignment.employmentType,
        position: {
          id: assignment.position.id,
          name: assignment.position.name,
          code: assignment.position.code,
          organizationalUnitId: assignment.position.organizationalUnitId,
          departmentId: assignment.position.departmentId,
          teamId: assignment.position.teamId,
        },
        organization: assignment.position.organization,
      },
      workLocation: shift.workLocation,
      workDate: formatDateOnly(shift.workDate),
      startsAt: shift.startsAt.toISOString(),
      endsAt: shift.endsAt.toISOString(),
      timezone: shift.timezone,
      durationMinutes: Math.round(
        (shift.endsAt.getTime() - shift.startsAt.getTime()) / 60_000,
      ),
      status: shift.status,
      sourceType: shift.sourceType,
      sourcePatternId: shift.sourcePatternId,
      currentRevision: revision && {
        id: revision.id,
        revisionNumber: revision.revisionNumber,
        revisionType: revision.revisionType,
      },
    };
  }
}

function scheduleScope(schedule: Schedule): AuthorizationScope {
  const organizationId = schedule.organizationId;
  switch (schedule.scopeType) {
    case 'ORGANIZATION':
      return { type: 'ORGANIZATION', id: organizationId, organizationId };
    case 'ORGANIZATIONAL_UNIT':
      return {
        type: 'ORGANIZATIONAL_UNIT',
        id: schedule.organizationalUnitId ?? undefined,
        organizationId,
      };
    case 'DEPARTMENT':
      return {
        type: 'DEPARTMENT',
        id: schedule.departmentId ?? undefined,
        organizationId,
      };
    case 'TEAM':
      return { type: 'TEAM', id: schedule.teamId ?? undefined, organizationId };
  }
}
