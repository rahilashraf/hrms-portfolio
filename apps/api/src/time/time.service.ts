import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { advisoryLock, domainError } from '../common/domain-support.js';
import { isIanaTimezone } from '../common/timezone.js';
import {
  attendanceModes,
  captureAllows,
  type AttendanceTrackingMode,
} from './time-policy.js';
import { AuditService } from '../audit/audit.service.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import { PositionAuthorizationTargetResolver } from '../authorization/position-authorization-target.resolver.js';
import { PrismaService } from '../database/prisma.service.js';
import {
  featureGateFor,
  FeatureGateService,
} from '../features/feature-gate.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { grantOrganizations } from './organization-visibility.js';
import { policyScopeNames } from './time-policy-scope-names.js';
import type {
  AttendanceExceptionType,
  UnscheduledWorkMode,
} from '../generated/prisma/client.js';
import {
  ScheduleAttendanceService,
  type ClockInShiftCandidate,
} from '../scheduling/schedule-attendance.service.js';
import type {
  CreateTimeCorrectionRequestDto,
  AddTimeEntryDto,
  DirectTimeCorrectionDto,
  GenerateTimePeriodsDto,
  LinkScheduledShiftDto,
  TimeCorrectionsQueryDto,
  TimeCurrentQueryDto,
  TimeEntriesQueryDto,
  TimeExceptionsQueryDto,
  TimePeriodsQueryDto,
  TimeTimesheetsQueryDto,
  AssignmentAttendanceQueryDto,
  EffectivePolicyQueryDto,
  SelfCorrectionsQueryDto,
  SelfExceptionsQueryDto,
} from './time.dto.js';
import type { TimeAttendancePolicyConfig } from './time-domain.service.js';
import { TimeDomainService } from './time-domain.service.js';
import {
  additionalCoverage,
  coveredAssignments,
  sameAssignmentSet,
  secondaryCoverageIds,
} from './time-coverage.js';
import {
  APPROVED_ABSENCE_SOURCE,
  trimExpectedWorkForAbsences,
  type ApprovedAbsenceSource,
  type ExpectedWorkSourceType,
  type PayrollApprovedTimeOutput,
  type PayrollAssignmentTimeFact,
  type PayrollTimePeriodCadence,
  type PayrollTimesheetFact,
  type PayrollTimeSource,
} from './time-integration.contracts.js';

type TimeClient = Prisma.TransactionClient | PrismaService;
/** Why a kiosk offers an identified employee nothing to record (kioskUnavailableReason). */
export type KioskUnavailableCode =
  | 'OPEN_ENTRY_NOT_AT_KIOSK'
  | 'EMPLOYEE_NOT_ACTIVE'
  | 'NO_ASSIGNMENT'
  | 'ASSIGNMENT_NOT_STARTED'
  | 'TIMEZONE_MISSING'
  | 'ASSIGNMENT_NOT_EFFECTIVE'
  | 'ATTENDANCE_DISABLED'
  | 'CAPTURE_NOT_AT_KIOSK'
  | 'KIOSK_SITE_NOT_ALLOWED'
  | 'CLOCK_DISABLED'
  | 'UNAVAILABLE';
type TimeAction =
  | 'CLOCK_IN'
  | 'CLOCK_OUT'
  | 'SWITCH_ASSIGNMENT'
  | 'START_BREAK'
  | 'END_BREAK'
  | 'RESOLVE_MISSED_CLOCK_OUT'
  | 'SIGN_IN'
  | 'SIGN_OUT';
type ClockState = 'OFF_CLOCK' | 'CLOCKED_IN' | 'ON_BREAK';
type TimeCorrectionType =
  | 'ADD_MISSING_CLOCK_IN'
  | 'ADD_MISSING_CLOCK_OUT'
  | 'CHANGE_CLOCK_IN'
  | 'CHANGE_CLOCK_OUT'
  | 'CHANGE_BREAK_START'
  | 'CHANGE_BREAK_END'
  | 'ADD_BREAK'
  | 'REMOVE_BREAK'
  | 'CHANGE_ASSIGNMENT'
  | 'ADD_MISSING_TIME_ENTRY'
  | 'CHANGE_COVERAGE';
type TimeAdjustmentSource =
  | 'EMPLOYEE_APPROVED'
  | 'EMPLOYEE_AUTO_APPROVED'
  | 'MANAGER_DIRECT'
  | 'ADMIN_DIRECT';
type TimePeriodCadence = 'WEEKLY' | 'BIWEEKLY' | 'MONTHLY';
type TimeReadPermission =
  | 'time.manage_policy'
  | 'time.view'
  | 'time.approve'
  | 'time.correct'
  | 'time.timesheet.approve'
  | 'time.timesheet.manage';
type AttendanceExceptionShape = {
  id: string;
  type: string;
  severity: string;
  workflowImpact: string;
  status: string;
  timeEntryId: string | null;
  employmentAssignmentId: string | null;
  detectedAt: Date;
  resolvedAt: Date | null;
  reason: string | null;
  metadata: unknown;
};
interface ExpectedWorkSource {
  sourceType: ExpectedWorkSourceType;
  scheduledShiftId?: string | null;
  scheduledShiftRevisionId?: string | null;
  revisionNumber?: number | null;
}
interface ScheduledShiftLink {
  scheduledShiftId: string;
  revisionId: string;
  revisionNumber: number;
}
interface ScheduledWorkSelection {
  assignment: NonNullable<Awaited<ReturnType<TimeService['assignmentById']>>>;
  link: ScheduledShiftLink | null;
  unscheduledWorkMode: UnscheduledWorkMode | null;
  method:
    | 'ASSIGNMENT'
    | 'PRESELECTED_ASSIGNMENT'
    | 'MATCHED_SHIFT'
    | 'PRESELECTED_SHIFT'
    | 'EXPLICIT_SHIFT';
}
type InterpretationExceptionType = Extract<
  AttendanceExceptionType,
  'LATE_ARRIVAL' | 'EARLY_DEPARTURE'
>;

export interface TimeRequestContext {
  actorUserId?: string;
  ipAddress?: string;
  userAgent?: string;
  correlationId?: string;
  /** Phase 9.5: set for kiosk capture; recorded on every audit entry it causes. */
  capture?: { channel: 'KIOSK'; attendanceDeviceId: string };
}

/** Phase 9.5 — a trusted kiosk as the capturing device (see AttendanceDevice). */
export interface KioskDevice {
  id: string;
  organizationId: string;
  physicalSiteId: string;
}

/**
 * Who captures live attendance: the employee through authenticated self-service (their
 * time.clock grant applies), or a trusted kiosk on behalf of the employee identified there
 * (device trust, the employee's credential and the policy apply; no user grant is involved).
 */
export type ClockActor =
  | { channel: 'SELF_SERVICE'; userId: string }
  | { channel: 'KIOSK'; device: KioskDevice };

const selfServiceActor = (userId: string): ClockActor => ({
  channel: 'SELF_SERVICE',
  userId,
});

const asActor = (actor: ClockActor | string): ClockActor =>
  typeof actor === 'string' ? selfServiceActor(actor) : actor;

const kioskContext = (
  context: TimeRequestContext,
  device: KioskDevice,
): TimeRequestContext => ({
  ...context,
  actorUserId: undefined,
  capture: { channel: 'KIOSK', attendanceDeviceId: device.id },
});

/** Batch 4E-3 (C1): why an assignment has no self-service attendance action, in words. */
const CAPABILITY_EXPLANATIONS = {
  NONE: null,
  ATTENDANCE_DISABLED:
    'Time & attendance is switched off for this organization. Earlier records stay visible.',
  NO_TIMEZONE:
    'This assignment has no time zone yet, so attendance cannot be recorded. Ask an administrator to set one on its work location or organization.',
  CLOCK_DISABLED: 'Attendance is not recorded for this assignment.',
  NO_PERMISSION: 'You are not set up to record attendance for this assignment.',
  KIOSK_ONLY:
    'Attendance for this assignment is recorded at the onsite kiosk only, with your employee number and attendance PIN.',
} as const;

/** The scopes a policy chain is collected from (Batch 4E-2: shared by every resolution). */
interface PolicyChainScope {
  organizationId: string | null;
  unitPath: string[];
  departmentId: string | null;
  teamId: string | null;
  employmentAssignmentId: string | null;
}

@Injectable()
export class SystemClock {
  now(): Date {
    return new Date();
  }
}

@Injectable()
export class TimeService implements PayrollTimeSource {
  constructor(
    private readonly prisma: PrismaService,
    private readonly domain: TimeDomainService,
    private readonly authorization: AuthorizationService,
    private readonly targets: PositionAuthorizationTargetResolver,
    private readonly audit: AuditService,
    private readonly clock: SystemClock,
    /**
     * Phase 7 Batch 9 — published expected work. Absent (as in Phase 6 unit composition), time
     * entries are never linked to schedules and clock-in keeps its Phase 6 rules exactly.
     */
    @Optional() private readonly schedules?: ScheduleAttendanceService,
    /** Future Leave/PTO hook: approved absence suppresses expected-work interpretation. */
    @Optional()
    @Inject(APPROVED_ABSENCE_SOURCE)
    private readonly absences?: ApprovedAbsenceSource,
    /** Phase 18: the ATTENDANCE module gate (every authorization helper below uses it). */
    @Optional() features?: FeatureGateService,
  ) {
    this.features = featureGateFor(prisma, features);
  }

  readonly features: FeatureGateService;

  // ─── Phase 18: the ATTENDANCE module gate ──────────────────────────────────

  /** Whether Time & attendance is enabled for the organization of a position. */
  private attendanceEnabledForPosition(
    positionId: string,
    client: TimeClient = this.prisma,
  ) {
    return this.features.isEnabledForPosition(positionId, 'ATTENDANCE', client);
  }

  /** 403 FEATURE_DISABLED when Time & attendance is disabled for the position's organization. */
  private requireAttendanceForPosition(
    positionId: string,
    client: TimeClient = this.prisma,
  ) {
    return this.features.requireForPosition(positionId, 'ATTENDANCE', client);
  }

  /**
   * Employee self-service (reads of one's own time, and capture without an assignment): refused
   * when Time & attendance is disabled in every organization the employee works in.
   */
  private requireAttendanceForEmployee(
    employeeId: string,
    client: TimeClient = this.prisma,
  ) {
    return this.features.requireForEmployee(employeeId, 'ATTENDANCE', client);
  }

  async status(userId: string) {
    const now = this.clock.now();
    const employee = await this.requireSelfEmployee(userId);
    return this.statusForEmployee(userId, employee, now, this.prisma);
  }

  /**
   * The caller's own exceptions, paged (Batch 4E-3, C4: `exceptions` stays the key, 50 by
   * default as before; `nextAfterId` continues). Each one says its work date, time zone and
   * assignment, and how and by whom it was closed, never the manager's internal note (D5).
   */
  async exceptions(userId: string, query: SelfExceptionsQueryDto = {}) {
    const employee = await this.requireSelfEmployee(userId, this.prisma, {
      purpose: 'read',
    });
    const limit = query.limit ?? 50;
    const rows = await this.prisma.attendanceException.findMany({
      where: {
        employeeId: employee.id,
        ...(query.status ? { status: query.status } : {}),
      },
      include: {
        employee: { include: { person: true } },
        employmentAssignment: {
          include: { position: { include: positionInclude() } },
        },
        timeEntry: {
          include: {
            employmentAssignment: {
              include: { position: { include: positionInclude() } },
            },
          },
        },
      },
      orderBy: [{ status: 'asc' }, { detectedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(query.afterId ? { cursor: { id: query.afterId }, skip: 1 } : {}),
    });
    const page = await this.withActorNames(
      this.page(
        rows,
        (row) => {
          const shaped = this.managementExceptionShape(row);
          return {
            ...shaped,
            // D5: how and by whom, not the reviewer's internal note.
            resolutionNote: undefined,
            attendanceSignInId: row.attendanceSignInId ?? null,
          };
        },
        limit,
      ),
      (item) => [item.resolvedByUserId],
    );
    return {
      exceptions: page.items.map((item) => {
        const { resolutionNote: _note, ...rest } = item;
        return rest;
      }),
      nextAfterId: page.nextAfterId,
      attendanceDisabledOrganizationIds:
        await this.disabledOrganizationsOfEmployee(employee.id),
    };
  }

  /**
   * The caller's own correction requests, paged (Batch 4E-3, C4: `corrections` stays the key, 50
   * by default as before). Each one has its work date, time zone, assignment (and target), the
   * requested and recorded values, the reviewer's note, and who requested and reviewed it.
   */
  async corrections(userId: string, query: SelfCorrectionsQueryDto = {}) {
    const employee = await this.requireSelfEmployee(userId, this.prisma, {
      purpose: 'read',
    });
    const limit = query.limit ?? 50;
    const assignmentInclude = {
      include: { position: { include: positionInclude() } },
    };
    const rows = await this.prisma.timeCorrectionRequest.findMany({
      where: {
        employeeId: employee.id,
        ...(query.status ? { status: query.status } : {}),
      },
      include: {
        employee: { include: { person: true } },
        timeEntry: { include: { employmentAssignment: assignmentInclude } },
        employmentAssignment: assignmentInclude,
        targetEmploymentAssignment: assignmentInclude,
        breakEntry: {
          include: {
            timeEntry: { include: { employmentAssignment: assignmentInclude } },
          },
        },
        adjustment: true,
      },
      orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(query.afterId ? { cursor: { id: query.afterId }, skip: 1 } : {}),
    });
    const page = await this.withActorNames(
      this.page(
        rows,
        (row) => {
          const shaped = this.managementCorrectionShape(row);
          const entry = row.timeEntry ?? row.breakEntry?.timeEntry ?? null;
          const requested = jsonObject(row.requestedValues);
          // A missing entry has no entry yet: its work date is its requested local start date.
          const requestedStart =
            typeof requested.startAt === 'string' ? requested.startAt : null;
          return {
            ...shaped,
            workDate: entry
              ? dateOnly(entry.workDate)
              : (requestedStart?.slice(0, 10) ?? null),
            timezone:
              entry?.timezone ??
              (row.employmentAssignment
                ? this.resolvedTimezone(row.employmentAssignment)
                : null),
          };
        },
        limit,
      ),
      (item) => [item.requestorUserId, item.reviewerUserId],
    );
    return {
      corrections: page.items,
      nextAfterId: page.nextAfterId,
      attendanceDisabledOrganizationIds:
        await this.disabledOrganizationsOfEmployee(employee.id),
    };
  }

  async selfEntries(userId: string, query: TimeEntriesQueryDto = {}) {
    const employee = await this.requireSelfEmployee(userId, this.prisma, {
      purpose: 'read',
    });
    const rows = await this.prisma.timeEntry.findMany({
      // The caller's own employee always wins over any query field (Batch 4E-1: the query DTO
      // now carries management filters such as employeeId).
      where: {
        AND: [
          this.entryWhere(
            Object.assign({}, query, { employeeId: employee.id }),
          ),
          // Batch 4E-3 (C2): the organization filter narrows the caller's own entries only.
          query.organizationId
            ? {
                employmentAssignment: {
                  position: { organizationId: query.organizationId },
                },
              }
            : {},
        ],
      },
      include: this.entryReadInclude(),
      orderBy: [{ workDate: 'desc' }, { clockInAt: 'desc' }, { id: 'desc' }],
      take: this.pageTake(query.limit),
      ...(query.afterId ? { cursor: { id: query.afterId }, skip: 1 } : {}),
    });
    // Batch 4E-3 (C2): the automatic deduction and payable minutes of each closed entry, from
    // the calculation timesheets and payroll use (one day calculation per request and day).
    const dayCache = new Map<string, Promise<Map<string, number>>>();
    const page = this.page(rows, (row) => row, query.limit);
    const items = [];
    for (const row of page.items) {
      items.push(await this.managementEntryShape(row, dayCache));
    }
    return {
      ...page,
      items,
      attendanceDisabledOrganizationIds:
        await this.disabledOrganizationsOfEmployee(employee.id),
    };
  }

  async managementCurrent(userId: string, query: TimeCurrentQueryDto = {}) {
    const organizations = this.narrowOrganizations(
      await this.timeOrganizations(userId, ['time.view']),
      query.organizationId,
    );
    if (!organizations) return { items: [], nextAfterId: null };
    const rows = await this.prisma.timeEntry.findMany({
      where: {
        AND: [
          {
            status: 'OPEN',
            archivedAt: null,
            ...(query.employeeId ? { employeeId: query.employeeId } : {}),
            ...this.searchWhere(query.search),
          },
          this.entryOrganizationWhere(organizations),
        ],
      },
      include: this.entryReadInclude(),
      orderBy: [{ clockInAt: 'desc' }, { id: 'desc' }],
      take: this.scanTake(query.limit),
      ...(query.afterId ? { cursor: { id: query.afterId }, skip: 1 } : {}),
    });
    return this.authorizedPage(rows, query.limit, async (row) =>
      (await this.canReadPosition(userId, row.employmentAssignment.positionId, [
        'time.view',
      ]))
        ? this.entryReadShape(row)
        : null,
    );
  }

  async managementEntries(userId: string, query: TimeEntriesQueryDto = {}) {
    const organizations = this.narrowOrganizations(
      await this.timeOrganizations(userId, ['time.view', 'time.correct']),
      query.organizationId,
    );
    if (!organizations) return { items: [], nextAfterId: null };
    const rows = await this.prisma.timeEntry.findMany({
      where: {
        AND: [
          this.entryWhere(query),
          this.entryOrganizationWhere(organizations),
        ],
      },
      include: this.entryReadInclude(),
      orderBy: [{ workDate: 'desc' }, { clockInAt: 'desc' }, { id: 'desc' }],
      take: this.scanTake(query.limit),
      ...(query.afterId ? { cursor: { id: query.afterId }, skip: 1 } : {}),
    });
    const dayCache = new Map<string, Promise<Map<string, number>>>();
    const historical = { historical: query.includeDisabledOrganizations };
    const shown = new Set<string>();
    const page = await this.authorizedPage(rows, query.limit, async (row) => {
      const positionId = row.employmentAssignment.positionId;
      if (
        !(await this.canReadPosition(
          userId,
          positionId,
          ['time.view', 'time.correct'],
          historical,
        ))
      ) {
        return null;
      }
      shown.add(positionId);
      return this.managementEntryShape(row, dayCache);
    });
    return {
      ...page,
      attendanceDisabledOrganizationIds:
        await this.disabledOrganizationsOfPositions(shown),
    };
  }

  /**
   * Batch 4F (C10): which of the organizations of these positions have Time & attendance
   * disabled, so a history view can mark their records read-only. Only organizations of
   * records the caller was shown: nothing about any other organization is revealed.
   */
  private async disabledOrganizationsOfPositions(
    positionIds: Iterable<string>,
  ) {
    const ids = [...new Set(positionIds)];
    if (ids.length === 0) return [];
    const positions = await this.prisma.position.findMany({
      where: { id: { in: ids } },
      select: { organizationId: true },
    });
    const organizations = [...new Set(positions.map((p) => p.organizationId))];
    return [
      ...(await this.features.disabledAmong('ATTENDANCE', organizations)),
    ].sort();
  }

  /** Batch 4F (C10): the same marker for the caller's own records (their own organizations). */
  async disabledOrganizationsOfEmployee(employeeId: string) {
    const assignments = await this.prisma.employmentAssignment.findMany({
      where: { employeeId },
      select: { positionId: true },
    });
    return this.disabledOrganizationsOfPositions(
      assignments.map((a) => a.positionId),
    );
  }

  /**
   * Batch 4E-1 (G3): a management entry row adds the automatic deduction allocated to it and
   * its payable minutes, from the one Batch 4D calculation timesheets and payroll use
   * (workedMinutesForEntry). Only CLOSED entries have them (open and voided entries are null).
   * They are the current calculation: an approved or locked timesheet's own stored rows stay
   * its record and are never recomputed from these.
   */
  private async managementEntryShape(
    row: Parameters<TimeService['entryReadShape']>[0] & {
      status: string;
      breaks: Array<{
        startAt: Date;
        endAt: Date | null;
        payType: string | null;
      }>;
      employmentAssignment: NonNullable<
        Awaited<ReturnType<TimeService['assignmentById']>>
      >;
    },
    dayCache: Map<string, Promise<Map<string, number>>>,
  ) {
    const shaped = this.entryReadShape(row);
    if (row.status !== 'CLOSED' || !row.clockOutAt) {
      return { ...shaped, policyDeductionMinutes: null, payableMinutes: null };
    }
    const minutes = await this.workedMinutesForEntry(
      { ...row, clockOutAt: row.clockOutAt },
      this.prisma,
      dayCache,
    );
    return {
      ...shaped,
      policyDeductionMinutes: minutes.policyDeductionMinutes,
      payableMinutes: minutes.netWorkedMinutes,
    };
  }

  async managementExceptions(
    userId: string,
    query: TimeExceptionsQueryDto = {},
  ) {
    const organizations = this.narrowOrganizations(
      await this.timeOrganizations(userId, ['time.view']),
      query.organizationId,
    );
    if (!organizations) return { items: [], nextAfterId: null };
    const rows = await this.prisma.attendanceException.findMany({
      where: {
        AND: [
          this.exceptionWhere(query),
          organizations === 'ALL'
            ? {}
            : {
                OR: [
                  {
                    employmentAssignment: {
                      position: { organizationId: { in: organizations } },
                    },
                  },
                  {
                    timeEntry: {
                      employmentAssignment: {
                        position: { organizationId: { in: organizations } },
                      },
                    },
                  },
                ],
              },
        ],
      },
      include: {
        employee: { include: { person: true } },
        employmentAssignment: {
          include: { position: { include: positionInclude() } },
        },
        timeEntry: {
          include: {
            employmentAssignment: {
              include: { position: { include: positionInclude() } },
            },
          },
        },
      },
      orderBy: [{ detectedAt: 'desc' }, { id: 'desc' }],
      take: this.scanTake(query.limit),
      ...(query.afterId ? { cursor: { id: query.afterId }, skip: 1 } : {}),
    });
    const shown = new Set<string>();
    const page = await this.authorizedPage(rows, query.limit, async (row) => {
      const positionId =
        row.employmentAssignment?.positionId ??
        row.timeEntry?.employmentAssignment.positionId;
      if (
        !positionId ||
        !(await this.canReadPosition(userId, positionId, ['time.view'], {
          historical: query.includeDisabledOrganizations,
        }))
      ) {
        return null;
      }
      shown.add(positionId);
      return this.managementExceptionShape(row);
    });
    return {
      ...(await this.withActorNames(
        await this.withChangedShiftSchedules(page),
        (item) => [item.resolvedByUserId],
      )),
      attendanceDisabledOrganizationIds:
        await this.disabledOrganizationsOfPositions(shown),
    };
  }

  async managementCorrections(
    userId: string,
    query: TimeCorrectionsQueryDto = {},
  ) {
    const organizations = this.narrowOrganizations(
      await this.timeOrganizations(userId, ['time.approve', 'time.correct']),
      query.organizationId,
    );
    if (!organizations) return { items: [], nextAfterId: null };
    const inOrganizations = {
      position: {
        organizationId: { in: organizations === 'ALL' ? [] : organizations },
      },
    };
    const rows = await this.prisma.timeCorrectionRequest.findMany({
      where: {
        AND: [
          this.correctionWhere(query),
          organizations === 'ALL'
            ? {}
            : {
                OR: [
                  { employmentAssignment: inOrganizations },
                  { targetEmploymentAssignment: inOrganizations },
                  { timeEntry: { employmentAssignment: inOrganizations } },
                  {
                    breakEntry: {
                      timeEntry: { employmentAssignment: inOrganizations },
                    },
                  },
                ],
              },
        ],
      },
      include: {
        employee: { include: { person: true } },
        timeEntry: {
          include: {
            employmentAssignment: {
              include: { position: { include: positionInclude() } },
            },
          },
        },
        employmentAssignment: {
          include: { position: { include: positionInclude() } },
        },
        targetEmploymentAssignment: {
          include: { position: { include: positionInclude() } },
        },
        breakEntry: {
          include: {
            timeEntry: {
              include: {
                employmentAssignment: {
                  include: { position: { include: positionInclude() } },
                },
              },
            },
          },
        },
        adjustment: true,
      },
      orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
      take: this.scanTake(query.limit),
      ...(query.afterId ? { cursor: { id: query.afterId }, skip: 1 } : {}),
    });
    const shown = new Set<string>();
    const page = await this.authorizedPage(rows, query.limit, async (row) => {
      const positionIds = this.correctionPositionIds(row);
      if (
        positionIds.length === 0 ||
        !(await this.canReadAnyPosition(
          userId,
          positionIds,
          ['time.approve', 'time.correct'],
          { historical: query.includeDisabledOrganizations },
        ))
      ) {
        return null;
      }
      for (const positionId of positionIds) shown.add(positionId);
      return this.managementCorrectionShape(row);
    });
    return {
      ...(await this.withActorNames(page, (item) => [
        item.requestorUserId,
        item.reviewerUserId,
      ])),
      attendanceDisabledOrganizationIds:
        await this.disabledOrganizationsOfPositions(shown),
    };
  }

  async managementTimesheets(
    userId: string,
    query: TimeTimesheetsQueryDto = {},
  ) {
    const organizations = this.narrowOrganizations(
      await this.timeOrganizations(userId, [
        'time.timesheet.approve',
        'time.timesheet.manage',
      ]),
      query.organizationId,
    );
    if (!organizations) return { items: [], nextAfterId: null };
    const found = await this.prisma.timesheet.findMany({
      where: {
        AND: [
          this.timesheetWhere(query),
          organizations === 'ALL'
            ? {}
            : { timePeriod: { organizationId: { in: organizations } } },
        ],
      },
      include: this.timesheetInclude(),
      orderBy: [
        { timePeriod: { startDate: 'desc' } },
        { createdAt: 'desc' },
        { id: 'desc' },
      ],
      take: this.scanTake(query.limit),
      ...(query.afterId ? { cursor: { id: query.afterId }, skip: 1 } : {}),
    });
    // Batch 4B (D3): a timesheet shows only its period's organization's segments.
    const rows = found.map((row) => this.scopedTimesheet(row));
    const shown = new Set<string>();
    const page = await this.authorizedPage(rows, query.limit, async (row) => {
      const segments = [];
      for (const segment of row.segments) {
        if (query.segmentStatus && segment.status !== query.segmentStatus) {
          continue;
        }
        if (
          await this.canReadPosition(
            userId,
            segment.employmentAssignment.positionId,
            ['time.timesheet.approve', 'time.timesheet.manage'],
            { historical: query.includeDisabledOrganizations },
          )
        ) {
          segments.push(segment);
          shown.add(segment.employmentAssignment.positionId);
        }
      }
      if (segments.length === 0) return null;
      // Totals, payroll rows and segment events only for the segments shown (Batch 4B).
      return this.managementTimesheetShape({
        ...row,
        segments,
        outOfScopeSegments:
          row.outOfScopeSegments + (row.segments.length - segments.length),
      });
    });
    return {
      ...(await this.withActorNames(page, (item) => [
        item.submittedByUserId,
        item.approvedByUserId,
        item.lockedByUserId,
        item.reopenedByUserId,
        ...item.segments.map((segment) => segment.reviewedByUserId),
        ...item.events.map((event) => event.actorUserId),
      ])),
      attendanceDisabledOrganizationIds:
        await this.disabledOrganizationsOfPositions(shown),
    };
  }

  async requestCorrection(
    userId: string,
    dto: CreateTimeCorrectionRequestDto,
    context: TimeRequestContext,
  ) {
    const now = this.clock.now();
    const employee = await this.requireSelfEmployee(userId);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const draft = await this.buildCorrectionDraft(
          employee.id,
          dto,
          now,
          tx,
          { selfService: true },
        );
        // Batch 4E-3 (C5): a request that could never be approved is refused when it is filed,
        // not left pending (where it would block the timesheet): Time & attendance must be on
        // for the assignment's organization, the policy is the one of the affected work date,
        // and the time must not be in an approved or locked timesheet or on sign-in-only work.
        await this.requireAttendanceForPosition(
          draft.policyAssignment.positionId,
          tx,
        );
        const policy = await this.effectivePolicyForAssignmentOnWorkDate(
          draft.policyAssignment,
          this.correctionWorkDate(draft),
          tx,
        );
        if (!this.employeeCorrectionRequestsEnabled(policy)) {
          throw new ForbiddenException(
            domainError(
              403,
              'TIME_CORRECTION_REQUESTS_DISABLED',
              'Employee correction requests are not enabled for this assignment.',
            ),
          );
        }
        await this.assertCorrectionNotFinalized(draft, tx);
        const autoApprove = this.correctionCanAutoApprove(
          dto.type,
          draft,
          policy,
        );
        const request = await tx.timeCorrectionRequest.create({
          data: {
            employeeId: employee.id,
            requestorUserId: userId,
            reviewerUserId: autoApprove ? userId : null,
            timeEntryId: draft.timeEntryId,
            breakEntryId: draft.breakEntryId,
            employmentAssignmentId: draft.employmentAssignmentId,
            targetEmploymentAssignmentId: draft.targetEmploymentAssignmentId,
            type: dto.type,
            status: autoApprove ? 'APPROVED' : 'PENDING',
            reason: normalizedReason(dto.reason),
            reviewerNote: autoApprove
              ? 'Automatically approved by policy.'
              : null,
            requestedValues: jsonMetadata(draft.requestedValues),
            currentValues: jsonMetadata(draft.currentValues),
            reviewedAt: autoApprove ? now : null,
          },
        });
        let adjustment = null;
        if (autoApprove) {
          adjustment = await this.applyCorrection(
            tx,
            request,
            draft,
            userId,
            'EMPLOYEE_AUTO_APPROVED',
            context,
          );
        }
        await this.writeAudit(
          tx,
          autoApprove
            ? 'TIME_CORRECTION_AUTO_APPROVED'
            : 'TIME_CORRECTION_REQUESTED',
          request.id,
          context,
          {
            employeeId: employee.id,
            type: dto.type,
            timeEntryId: draft.timeEntryId,
            breakEntryId: draft.breakEntryId,
            autoApprove,
          },
          'TimeCorrectionRequest',
        );
        return this.correctionShape({ ...request, adjustment });
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new ConflictException(
          'A pending correction request already exists for this attendance record.',
        );
      }
      throw error;
    }
  }

  async cancelCorrection(
    userId: string,
    correctionId: string,
    context: TimeRequestContext,
  ) {
    const now = this.clock.now();
    const employee = await this.requireSelfEmployee(userId);
    return this.prisma.$transaction(async (tx) => {
      const request = await tx.timeCorrectionRequest.findUnique({
        where: { id: correctionId },
        include: { adjustment: true },
      });
      if (!request || request.employeeId !== employee.id) {
        throw new NotFoundException('Time correction request not found.');
      }
      if (request.requestorUserId !== userId) {
        throw new ForbiddenException(
          'Only the requestor can cancel this correction request.',
        );
      }
      if (request.status === 'CANCELLED') {
        return this.correctionShape(request);
      }
      if (request.status !== 'PENDING') {
        throw new ConflictException(
          'Only pending correction requests can be cancelled.',
        );
      }
      const cancelled = await tx.timeCorrectionRequest.update({
        where: { id: correctionId },
        data: { status: 'CANCELLED', cancelledAt: now },
        include: { adjustment: true },
      });
      await this.writeAudit(
        tx,
        'TIME_CORRECTION_CANCELLED',
        correctionId,
        context,
        { employeeId: employee.id, type: request.type },
        'TimeCorrectionRequest',
      );
      return this.correctionShape(cancelled);
    });
  }

  async approveCorrection(
    actorUserId: string,
    correctionId: string,
    reviewerNote: string | undefined,
    context: TimeRequestContext,
  ) {
    return this.prisma.$transaction(async (tx) => {
      // Batch 8 (review M2): the decision time is taken inside the transaction, so the
      // notification horizon (behind open transactions) always covers it.
      const now = this.clock.now();
      const request = await this.correctionById(correctionId, tx);
      if (!request)
        throw new NotFoundException('Time correction request not found.');
      // Batch 4F (D1): authorize before revealing anything, its status included.
      await this.assertCorrectionDecisionAuthority(
        actorUserId,
        request,
        'approve',
        'TIME_CORRECTION_APPROVE',
        context,
        tx,
      );
      if (request.status === 'APPROVED') {
        return this.correctionShape(request);
      }
      if (request.status !== 'PENDING') {
        throw new ConflictException(
          'Only pending correction requests can be approved.',
        );
      }
      await this.lockEmployeeTime(request.employeeId, tx);
      const draft = await this.buildCorrectionDraft(
        request.employeeId,
        {
          type: request.type,
          reason: request.reason,
          timeEntryId: request.timeEntryId ?? undefined,
          breakEntryId: request.breakEntryId ?? undefined,
          employmentAssignmentId: request.employmentAssignmentId ?? undefined,
          targetEmploymentAssignmentId:
            request.targetEmploymentAssignmentId ?? undefined,
          ...jsonObject(request.requestedValues),
        } as CreateTimeCorrectionRequestDto,
        now,
        tx,
        { selfService: false },
      );
      await this.assertCorrectionAccess(actorUserId, draft, 'time.approve', tx);
      // Refuse before deciding: a request touching finalized time stays pending.
      await this.assertCorrectionNotFinalized(draft, tx);
      const updated = await tx.timeCorrectionRequest.updateMany({
        where: { id: request.id, status: 'PENDING' },
        data: {
          status: 'APPROVED',
          reviewerUserId: actorUserId,
          reviewerNote: reviewerNote?.trim() || null,
          reviewedAt: now,
          currentValues: jsonMetadata(draft.currentValues),
        },
      });
      if (updated.count === 0) {
        const current = await this.correctionById(correctionId, tx);
        if (current?.status === 'APPROVED') {
          return this.correctionShape(current);
        }
        throw new ConflictException(
          'Only pending correction requests can be approved.',
        );
      }
      const approved = await this.correctionById(correctionId, tx);
      if (!approved)
        throw new NotFoundException('Time correction request not found.');
      const adjustment = await this.applyCorrection(
        tx,
        approved,
        draft,
        actorUserId,
        'EMPLOYEE_APPROVED',
        context,
      );
      await this.writeAudit(
        tx,
        'TIME_CORRECTION_APPROVED',
        request.id,
        context,
        { employeeId: request.employeeId, type: request.type },
        'TimeCorrectionRequest',
      );
      return this.correctionShape({ ...approved, adjustment });
    });
  }

  async rejectCorrection(
    actorUserId: string,
    correctionId: string,
    reviewerNote: string | undefined,
    context: TimeRequestContext,
  ) {
    return this.prisma.$transaction(async (tx) => {
      // Batch 8 (review M2): the decision time is taken inside the transaction, so the
      // notification horizon (behind open transactions) always covers it.
      const now = this.clock.now();
      const request = await this.correctionById(correctionId, tx);
      if (!request)
        throw new NotFoundException('Time correction request not found.');
      // Batch 4F (D1): authorize before revealing anything, its status included.
      await this.assertCorrectionDecisionAuthority(
        actorUserId,
        request,
        'reject',
        'TIME_CORRECTION_REJECT',
        context,
        tx,
      );
      if (request.status === 'REJECTED') return this.correctionShape(request);
      if (request.status !== 'PENDING') {
        throw new ConflictException(
          'Only pending correction requests can be rejected.',
        );
      }
      const draft = await this.buildCorrectionDraft(
        request.employeeId,
        {
          type: request.type,
          reason: request.reason,
          timeEntryId: request.timeEntryId ?? undefined,
          breakEntryId: request.breakEntryId ?? undefined,
          employmentAssignmentId: request.employmentAssignmentId ?? undefined,
          targetEmploymentAssignmentId:
            request.targetEmploymentAssignmentId ?? undefined,
          ...jsonObject(request.requestedValues),
        } as CreateTimeCorrectionRequestDto,
        now,
        tx,
        { selfService: false },
      );
      await this.assertCorrectionAccess(actorUserId, draft, 'time.approve', tx);
      const updated = await tx.timeCorrectionRequest.updateMany({
        where: { id: request.id, status: 'PENDING' },
        data: {
          status: 'REJECTED',
          reviewerUserId: actorUserId,
          reviewerNote: reviewerNote?.trim() || null,
          reviewedAt: now,
        },
      });
      if (updated.count === 0) {
        const current = await this.correctionById(correctionId, tx);
        if (current?.status === 'REJECTED')
          return this.correctionShape(current);
        throw new ConflictException(
          'Only pending correction requests can be rejected.',
        );
      }
      const rejected = await tx.timeCorrectionRequest.findUnique({
        where: { id: request.id },
        include: { adjustment: true },
      });
      if (!rejected)
        throw new NotFoundException('Time correction request not found.');
      await this.writeAudit(
        tx,
        'TIME_CORRECTION_REJECTED',
        request.id,
        context,
        { employeeId: request.employeeId, type: request.type },
        'TimeCorrectionRequest',
      );
      return this.correctionShape(rejected);
    });
  }

  /**
   * Phase 9.5 — a manager or administrator records a missing time entry directly (e.g. the
   * employee forgot the kiosk or it was unavailable): a MANUAL entry with no punches, a reason
   * and a MANAGER_DIRECT adjustment, never mistaken for live or kiosk capture.
   */
  async addEntry(
    actorUserId: string,
    employeeId: string,
    dto: AddTimeEntryDto,
    context: TimeRequestContext,
  ) {
    const now = this.clock.now();
    return this.prisma.$transaction(async (tx) => {
      const employee = await tx.employee.findUnique({
        where: { id: employeeId },
        select: { id: true },
      });
      if (!employee) throw new NotFoundException('Employee not found.');
      await this.assertEmployeeVisible(
        actorUserId,
        employeeId,
        // Batch 4F (D4/Q2): time.view makes the employee's time visible (403 below, not 404).
        ['time.view', 'time.correct', 'time.approve'],
        tx,
      );
      const named = await tx.employmentAssignment.findFirst({
        where: { id: dto.employmentAssignmentId, employeeId },
        select: { positionId: true },
      });
      if (named) {
        await this.preauthorizeCorrection(
          actorUserId,
          named.positionId,
          tx,
          'Employee not found.',
          employeeId,
        );
      }
      await this.lockEmployeeTime(employeeId, tx);
      const draft = await this.buildCorrectionDraft(
        employeeId,
        {
          type: 'ADD_MISSING_TIME_ENTRY',
          reason: dto.reason,
          employmentAssignmentId: dto.employmentAssignmentId,
          startAt: dto.startAt,
          endAt: dto.endAt,
        } as CreateTimeCorrectionRequestDto,
        now,
        tx,
        { selfService: false },
      );
      await this.assertCorrectionAccess(actorUserId, draft, 'time.correct', tx);
      await this.assertNotSelfTarget(
        actorUserId,
        employeeId,
        'time.correct',
        'TIME_DIRECT_ENTRY_ADD',
        context,
        tx,
        { allowSystemOverride: true },
      );
      const adjustment = await this.applyCorrection(
        tx,
        null,
        draft,
        actorUserId,
        'MANAGER_DIRECT',
        context,
      );
      await this.writeAudit(
        tx,
        'TIME_DIRECT_ENTRY_ADDED',
        adjustment.id,
        context,
        {
          employeeId,
          employmentAssignmentId: dto.employmentAssignmentId,
          timeEntryId: adjustment.timeEntryId,
        },
        'TimeAdjustment',
      );
      return this.adjustmentShape(adjustment);
    });
  }

  async correctEntry(
    actorUserId: string,
    timeEntryId: string,
    dto: DirectTimeCorrectionDto,
    context: TimeRequestContext,
  ) {
    const now = this.clock.now();
    return this.prisma.$transaction(async (tx) => {
      const found = await this.timeEntryById(timeEntryId, tx);
      if (!found) throw new NotFoundException('Time entry not found.');
      await this.preauthorizeCorrection(
        actorUserId,
        found.employmentAssignment.positionId,
        tx,
        'Time entry not found.',
        found.employeeId,
      );
      await this.lockEmployeeTime(found.employeeId, tx);
      const entry = (await this.timeEntryById(timeEntryId, tx)) ?? found;
      const draft = await this.buildCorrectionDraft(
        entry.employeeId,
        this.directCorrectionDtoForEntry(dto, timeEntryId),
        now,
        tx,
        { selfService: false },
      );
      await this.assertCorrectionAccess(actorUserId, draft, 'time.correct', tx);
      await this.assertNotSelfTarget(
        actorUserId,
        entry.employeeId,
        'time.correct',
        'TIME_DIRECT_CORRECTION',
        context,
        tx,
        { allowSystemOverride: true },
      );
      const adjustment = await this.applyCorrection(
        tx,
        null,
        draft,
        actorUserId,
        'MANAGER_DIRECT',
        context,
      );
      await this.writeAudit(
        tx,
        'TIME_DIRECT_CORRECTION_APPLIED',
        adjustment.id,
        context,
        {
          employeeId: entry.employeeId,
          timeEntryId,
          type: dto.type,
        },
        'TimeAdjustment',
      );
      return this.adjustmentShape(adjustment);
    });
  }

  /**
   * Manager decision on an entry's expected-work link (time.correct). Naming the entry's current
   * shift reinterprets it against that shift's latest published revision; naming another
   * published ACTIVE shift of the same assignment links it; null unlinks it. Open schedule-change
   * and unscheduled-work signals the decision answers are resolved. Entries on an APPROVED or
   * LOCKED timesheet (or an APPROVED segment) are payroll-sensitive history and are refused.
   */
  async linkScheduledShift(
    actorUserId: string,
    timeEntryId: string,
    dto: LinkScheduledShiftDto,
    context: TimeRequestContext,
  ) {
    const schedules = this.schedules;
    if (!schedules) {
      throw new BadRequestException(
        'Scheduled shift linking is not available.',
      );
    }
    const reason = normalizedReason(dto.reason);
    if (!reason) throw new BadRequestException('A reason is required.');
    return this.prisma.$transaction(async (tx) => {
      // Batch 4F (D4, D9): authorize on an unlocked read before taking the row lock; the full
      // checks run again on the locked entry below.
      const unlocked = await this.timeEntryById(timeEntryId, tx);
      if (!unlocked || unlocked.archivedAt) {
        throw new NotFoundException('Time entry not found.');
      }
      await this.preauthorizeCorrection(
        actorUserId,
        unlocked.employmentAssignment.positionId,
        tx,
        'Time entry not found.',
        unlocked.employeeId,
      );
      // NO KEY UPDATE serializes decisions on the entry without blocking the FK key-share a
      // concurrent shift correction takes when it raises a review signal for this entry; it
      // holds the shift lock this transaction waits on next, so FOR UPDATE could deadlock.
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "TimeEntry" WHERE "id" = ${timeEntryId}::uuid FOR NO KEY UPDATE`,
      );
      const entry = await this.timeEntryById(timeEntryId, tx);
      if (!entry || entry.archivedAt) {
        throw new NotFoundException('Time entry not found.');
      }
      const scope = await this.targets.scopeForPosition(
        entry.employmentAssignment.positionId,
        undefined,
        tx,
      );
      if (
        !(await this.authorization.canAccess(
          actorUserId,
          'time.correct',
          scope,
          tx,
        ))
      ) {
        throw new ForbiddenException(
          'Missing permission time.correct for the requested assignment.',
        );
      }
      await this.requireAttendanceForPosition(
        entry.employmentAssignment.positionId,
        tx,
      );
      await this.assertNotSelfTarget(
        actorUserId,
        entry.employeeId,
        'time.correct',
        'TIME_ENTRY_SCHEDULE_LINK',
        context,
        tx,
        { allowSystemOverride: true },
      );
      await this.assertEntryNotFinalized(entry, tx);

      let next: ScheduledShiftLink | null = null;
      if (dto.scheduledShiftId) {
        const locked = await schedules.lockPublishedShift(
          dto.scheduledShiftId,
          tx,
        );
        if (!locked) throw new NotFoundException('Scheduled shift not found.');
        if (
          locked.shift.employmentAssignmentId !== entry.employmentAssignmentId
        ) {
          throw new BadRequestException(
            'The scheduled shift belongs to a different assignment than the time entry.',
          );
        }
        const reinterpreting = locked.shift.id === entry.scheduledShiftId;
        if (!reinterpreting && locked.revision.status !== 'ACTIVE') {
          throw new BadRequestException(
            'Only an ACTIVE published shift can be linked to a time entry.',
          );
        }
        next = {
          scheduledShiftId: locked.shift.id,
          revisionId: locked.revision.id,
          revisionNumber: locked.revision.revisionNumber,
        };
      }
      const before = entry.scheduledShiftRevisionId
        ? {
            scheduledShiftId: entry.scheduledShiftId,
            scheduledShiftRevisionId: entry.scheduledShiftRevisionId,
          }
        : null;
      const unchanged =
        (next?.revisionId ?? null) === (entry.scheduledShiftRevisionId ?? null);
      if (!unchanged) {
        await tx.timeEntry.update({
          where: { id: entry.id },
          data: {
            scheduledShiftId: next?.scheduledShiftId ?? null,
            scheduledShiftRevisionId: next?.revisionId ?? null,
          },
        });
      }
      const resolvedTypes: AttendanceExceptionType[] = next
        ? ['SCHEDULE_CHANGED_AFTER_ATTENDANCE', 'UNSCHEDULED_WORK']
        : ['SCHEDULE_CHANGED_AFTER_ATTENDANCE'];
      const now = this.clock.now();
      const signals = await tx.attendanceException.findMany({
        where: {
          timeEntryId: entry.id,
          status: 'OPEN',
          type: { in: resolvedTypes },
        },
      });
      for (const signal of signals) {
        await tx.attendanceException.update({
          where: { id: signal.id },
          data: {
            status: 'RESOLVED',
            resolutionMethod: 'MANAGER_RESOLUTION',
            resolvedAt: now,
            metadata: this.mergeExceptionMetadata(signal.metadata, {
              resolvedReason: reason,
              resolvedByUserId: actorUserId,
              resolvedScheduledShiftRevisionId: next?.revisionId ?? null,
            }),
          },
        });
      }
      if (unchanged && signals.length === 0) {
        return this.scheduleLinkShape(entry.id, next, false);
      }
      await this.writeAudit(
        tx,
        'TIME_ENTRY_SCHEDULE_LINK_CHANGED',
        entry.id,
        context,
        {
          employeeId: entry.employeeId,
          reason,
          before,
          after: next
            ? {
                scheduledShiftId: next.scheduledShiftId,
                scheduledShiftRevisionId: next.revisionId,
                revisionNumber: next.revisionNumber,
              }
            : null,
          resolvedExceptionIds: signals.map((signal) => signal.id),
        },
      );
      await this.recalculateAttendanceInterpretation(entry.id, tx, context);
      await this.refreshTimesheetsForTimeEntry(entry.id, tx);
      return this.scheduleLinkShape(entry.id, next, true);
    });
  }

  private scheduleLinkShape(
    timeEntryId: string,
    link: ScheduledShiftLink | null,
    changed: boolean,
  ) {
    return {
      timeEntryId,
      scheduledShiftId: link?.scheduledShiftId ?? null,
      scheduledShiftRevisionId: link?.revisionId ?? null,
      revisionNumber: link?.revisionNumber ?? null,
      changed,
    };
  }

  /** Approved or locked time is payroll-sensitive; its interpretation is never rewritten. */
  private async assertEntryNotFinalized(
    entry: {
      employeeId: string;
      employmentAssignmentId: string;
      workDate: Date;
    },
    client: TimeClient,
    purpose: 'interpretation' | 'correction' = 'interpretation',
  ) {
    const finalized = await this.finalizedTimesheetOf(entry, client);
    if (finalized) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        code: 'TIME_ENTRY_FINALIZED',
        message:
          purpose === 'correction'
            ? 'The correction affects approved or locked time. Reopen the timesheet first.'
            : 'The time entry is on approved or locked time; its schedule interpretation cannot change. Reopen the timesheet first.',
        timesheetId: finalized.id,
      });
    }
  }

  /** Batch 4E-3 (C5): the work date a correction request is about (its policy's date). */
  private correctionWorkDate(
    draft: Awaited<ReturnType<TimeService['buildCorrectionDraft']>>,
  ): Date {
    if (draft.type === 'ADD_MISSING_TIME_ENTRY') {
      const { startAt, assignment } = draft.effective as {
        startAt: Date;
        assignment: NonNullable<
          Awaited<ReturnType<TimeService['assignmentById']>>
        >;
      };
      return this.domain.parseDateOnly(
        this.domain.deriveWorkDate(
          startAt,
          this.assignmentTimezone(assignment),
        ),
      );
    }
    return (
      draft.effective as {
        entry: NonNullable<Awaited<ReturnType<TimeService['timeEntryById']>>>;
      }
    ).entry.workDate;
  }

  /**
   * A correction never changes approved or locked (payroll-sensitive) time: neither the entry's
   * current work date and assignment nor the ones it would move to may be finalized. Reopen the
   * timesheet first.
   */
  private async assertCorrectionNotFinalized(
    draft: Awaited<ReturnType<TimeService['buildCorrectionDraft']>>,
    client: TimeClient,
  ) {
    const targets: Array<{
      employeeId: string;
      employmentAssignmentId: string;
      workDate: Date;
    }> = [];
    if (draft.type === 'ADD_MISSING_TIME_ENTRY') {
      const { startAt, assignment } = draft.effective as {
        startAt: Date;
        assignment: NonNullable<
          Awaited<ReturnType<TimeService['assignmentById']>>
        >;
      };
      targets.push({
        employeeId: draft.employeeId,
        employmentAssignmentId: assignment.id,
        workDate: this.domain.parseDateOnly(
          this.domain.deriveWorkDate(
            startAt,
            this.assignmentTimezone(assignment),
          ),
        ),
      });
    } else {
      const effective = draft.effective as {
        entry: NonNullable<Awaited<ReturnType<TimeService['timeEntryById']>>>;
        clockInAt: Date;
        targetAssignment: NonNullable<
          Awaited<ReturnType<TimeService['assignmentById']>>
        >;
      };
      targets.push(effective.entry, {
        employeeId: effective.entry.employeeId,
        employmentAssignmentId: effective.targetAssignment.id,
        workDate: this.domain.parseDateOnly(
          this.domain.deriveWorkDate(
            effective.clockInAt,
            this.correctedTimezone(effective.entry, effective.targetAssignment),
          ),
        ),
      });
    }
    for (const target of targets) {
      await this.assertEntryNotFinalized(target, client, 'correction');
    }
    // A correction never creates payable time on a SIGN_IN_ONLY assignment: adding an entry,
    // or moving one onto another assignment, needs TIME_CLOCK tracking on that work date.
    const resulting = targets[targets.length - 1];
    const moves =
      draft.type === 'ADD_MISSING_TIME_ENTRY' ||
      (draft.type === 'CHANGE_ASSIGNMENT' &&
        targets[0].employmentAssignmentId !== resulting.employmentAssignmentId);
    if (moves) {
      const assignment = await this.assignmentById(
        resulting.employmentAssignmentId,
        client,
      );
      if (
        assignment &&
        attendanceModes(
          await this.effectivePolicyForAssignmentOnWorkDate(
            assignment,
            resulting.workDate,
            client,
          ),
        ).trackingMode !== 'TIME_CLOCK'
      ) {
        throw new ConflictException({
          statusCode: 409,
          error: 'Conflict',
          code: 'ATTENDANCE_TRACKING_MODE_MISMATCH',
          message:
            'The assignment records attendance by sign-in on that date; it cannot hold time entries.',
        });
      }
    }
  }

  /** The APPROVED or LOCKED timesheet (or approved segment) the entry's time belongs to. */
  private async finalizedTimesheetOf(
    entry: {
      employeeId: string;
      employmentAssignmentId: string;
      workDate: Date;
    },
    client: TimeClient,
  ) {
    // Batch 4B (D3, O1): only a timesheet of the entry's own organization finalizes its time.
    const organizationId = await this.assignmentOrganizationId(
      entry.employmentAssignmentId,
      client,
    );
    // Batch 4A: share-lock the timesheets covering the date first, so this check and a
    // concurrent approval, lock or reopen (which lock the timesheet FOR UPDATE) are serialized:
    // whichever commits first, the other sees its result.
    await client.$queryRaw(Prisma.sql`
      SELECT t."id" FROM "Timesheet" t
      JOIN "TimePeriod" p ON p."id" = t."timePeriodId"
      WHERE t."employeeId" = ${entry.employeeId}::uuid
        AND p."organizationId" = ${organizationId}::uuid
        AND p."startDate" <= ${entry.workDate}::date
        AND p."endDate" >= ${entry.workDate}::date
      FOR SHARE OF t`);
    return client.timesheet.findFirst({
      where: {
        employeeId: entry.employeeId,
        timePeriod: {
          organizationId,
          startDate: { lte: entry.workDate },
          endDate: { gte: entry.workDate },
        },
        OR: [
          { status: { in: ['APPROVED', 'LOCKED'] } },
          {
            segments: {
              some: {
                employmentAssignmentId: entry.employmentAssignmentId,
                status: 'APPROVED',
              },
            },
          },
        ],
      },
      select: { id: true, status: true },
    });
  }

  async scanOpenTimeEntriesForExceptions(
    context: TimeRequestContext = {},
  ): Promise<{
    scanned: number;
    detected: number;
    autoResolved: number;
    escalated: number;
    failed: Array<{ timeEntryId: string; message: string }>;
    /** Phase 18: organizations skipped because Time & attendance is disabled for them. */
    skippedOrganizations: string[];
  }> {
    const now = this.clock.now();
    const skippedOrganizations = [
      ...(await this.features.disabledOrganizations('ATTENDANCE')),
    ].sort();
    const openEntries = await this.prisma.timeEntry.findMany({
      where: {
        status: 'OPEN',
        archivedAt: null,
        employmentAssignment: {
          position: { organizationId: { notIn: skippedOrganizations } },
        },
      },
      include: {
        employmentAssignment: {
          include: {
            position: {
              include: {
                jobTitle: true,
                organization: true,
                organizationalUnit: true,
                department: true,
                team: true,
                workLocation: true,
              },
            },
          },
        },
      },
      orderBy: { clockInAt: 'asc' },
    });
    const result = {
      scanned: openEntries.length,
      detected: 0,
      autoResolved: 0,
      escalated: 0,
      failed: [] as Array<{ timeEntryId: string; message: string }>,
      skippedOrganizations,
    };
    // Each entry is scanned in its own transaction; one failing entry never stops the rest
    // (the background job reports the failures and is retried).
    for (const entry of openEntries) {
      try {
        const scanResult = await this.scanOpenTimeEntry(entry, now, context);
        if (scanResult.detected) result.detected += 1;
        if (scanResult.autoResolved) result.autoResolved += 1;
        if (scanResult.escalated) result.escalated += 1;
      } catch (error) {
        result.failed.push({
          timeEntryId: entry.id,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return result;
  }

  // ─── Batch 4C: exception review ────────────────────────────────────────────

  /**
   * Batch 4C — a manager resolves (the exception was addressed) or dismisses (it needs no
   * action) an OPEN attendance exception, with a required note. time.approve over the
   * exception's assignment; never one's own (403, no override); another organization's answers
   * 404. Repeating the same review returns the exception unchanged; any other status (another
   * review, or a system resolution) is 409 TIME_EXCEPTION_NOT_OPEN. A review never changes punches, entries or hours: a blocking
   * missed clock-out can't be reviewed while its entry is still open (409
   * TIME_EXCEPTION_CONDITION_PRESENT); the entry is corrected instead.
   */
  async reviewException(
    actorUserId: string,
    exceptionId: string,
    action: 'RESOLVE' | 'DISMISS',
    note: string,
    context: TimeRequestContext,
  ) {
    const trimmed = normalizedReason(note ?? '');
    if (!trimmed) {
      throw new BadRequestException(
        timeError(
          400,
          'TIME_EXCEPTION_NOTE_REQUIRED',
          'A note is required to resolve or dismiss an exception.',
        ),
      );
    }
    const target = action === 'RESOLVE' ? 'RESOLVED' : 'DISMISSED';
    const now = this.clock.now();
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "AttendanceException" WHERE "id" = ${exceptionId}::uuid FOR UPDATE`,
      );
      const exception = await this.reviewedExceptionById(exceptionId, tx);
      if (!exception) {
        throw new NotFoundException('Attendance exception not found.');
      }
      const assignment =
        exception.employmentAssignment ??
        exception.timeEntry?.employmentAssignment ??
        null;
      if (!assignment) {
        throw new NotFoundException('Attendance exception not found.');
      }
      await this.assertNotSelfTarget(
        actorUserId,
        exception.employeeId,
        'time.approve',
        action === 'RESOLVE'
          ? 'TIME_EXCEPTION_RESOLVE'
          : 'TIME_EXCEPTION_DISMISS',
        context,
        tx,
      );
      await this.assertOrganizationVisible(
        actorUserId,
        assignment.position.organizationId,
        ['time.view', 'time.approve', 'time.correct'],
        tx,
        'Attendance exception not found.',
      );
      const scope = await this.targets.scopeForPosition(
        assignment.positionId,
        undefined,
        tx,
      );
      if (
        !(await this.authorization.canAccess(
          actorUserId,
          'time.approve',
          scope,
          tx,
        ))
      ) {
        throw new ForbiddenException(
          'Missing permission time.approve for the exception.',
        );
      }
      await this.requireAttendanceForPosition(assignment.positionId, tx);
      // The same review again (by a person) returns it unchanged. Anything else that is no
      // longer OPEN (another review, or resolved or superseded by the system) is a conflict, so
      // a reviewer never believes their note was recorded when it wasn't.
      if (exception.status === target && exception.resolvedByUserId !== null) {
        return this.managementExceptionShape(exception);
      }
      if (exception.status !== 'OPEN') {
        throw new ConflictException(
          timeError(
            409,
            'TIME_EXCEPTION_NOT_OPEN',
            'Only an open exception can be resolved or dismissed.',
            {
              status: exception.status,
              resolutionMethod: exception.resolutionMethod,
            },
          ),
        );
      }
      if (
        exception.workflowImpact === 'SUBMISSION_BLOCKING' &&
        exception.timeEntry?.status === 'OPEN'
      ) {
        throw new ConflictException(
          timeError(
            409,
            'TIME_EXCEPTION_CONDITION_PRESENT',
            'The time entry is still open. Correct the entry (add its clock-out) instead.',
          ),
        );
      }
      const updated = await tx.attendanceException.updateMany({
        where: { id: exception.id, status: 'OPEN' },
        data: {
          status: target,
          resolutionMethod: 'MANAGER_RESOLUTION',
          resolvedAt: now,
          resolvedByUserId: actorUserId,
          resolutionNote: trimmed,
        },
      });
      if (updated.count !== 1) {
        throw new ConflictException(
          timeError(
            409,
            'TIME_EXCEPTION_NOT_OPEN',
            'Only an open exception can be resolved or dismissed.',
          ),
        );
      }
      await this.writeAudit(
        tx,
        action === 'RESOLVE'
          ? 'TIME_EXCEPTION_RESOLVED'
          : 'TIME_EXCEPTION_DISMISSED',
        exception.id,
        context,
        {
          employeeId: exception.employeeId,
          employmentAssignmentId: assignment.id,
          type: exception.type,
          // Phase 19 rule: the note stays on the exception, never in the audit log.
          withNote: true,
        },
        'AttendanceException',
      );
      const reviewed = await this.reviewedExceptionById(exception.id, tx);
      return this.managementExceptionShape(reviewed!);
    });
  }

  private reviewedExceptionById(id: string, client: TimeClient) {
    return client.attendanceException.findUnique({
      where: { id },
      include: {
        employee: { include: { person: true } },
        employmentAssignment: {
          include: { position: { include: positionInclude() } },
        },
        timeEntry: {
          include: {
            employmentAssignment: {
              include: { position: { include: positionInclude() } },
            },
          },
        },
      },
    });
  }

  // ─── Batch 4C: no-show detection ───────────────────────────────────────────

  /**
   * Batch 4C — NO_SHOW review exceptions for published shifts without attendance.
   *
   * A shift is checked when it is ACTIVE in a PUBLISHED schedule, started within the lookback
   * window (default 48 hours) and has been running for the assignment's noShow.graceMinutes
   * (policy noShow.enabled, TIME_CLOCK tracking and a live clock on the shift's work date; off
   * by default). It is a no-show when the assignment has no time entry overlapping the shift,
   * no coverage of an entry overlapping it, no approved leave overlapping it, and the shift's
   * date isn't in approved or locked time. Shifts are instants, so overnight shifts and every
   * timezone are handled as such.
   *
   * One exception per shift revision, ever (a unique index): a retry adds nothing, and a
   * dismissed no-show is raised again only if the published shift changes. An OPEN no-show is
   * SUPERSEDED when its shift is cancelled, unpublished or changed, or when attendance or
   * approved leave now covers it. Nothing else changes: no punches, entries, timesheets or pay.
   */
  async detectNoShows(
    options: { lookbackHours?: number } = {},
    context: TimeRequestContext = {},
  ) {
    // Without Leave's approved absences (or published schedules) a no-show can't be told from
    // an approved absence: detect nothing rather than raise false no-shows.
    if (!this.absences || !this.schedules) {
      throw new Error(
        'No-show detection needs the schedule and approved-absence sources.',
      );
    }
    const now = this.clock.now();
    const lookbackMs = (options.lookbackHours ?? 48) * 3_600_000;
    const disabled = [
      ...(await this.features.disabledOrganizations('ATTENDANCE')),
    ];
    const result = {
      scanned: 0,
      detected: 0,
      superseded: 0,
      failed: [] as Array<{ scheduledShiftId: string; message: string }>,
    };
    const shifts = await this.prisma.scheduledShift.findMany({
      where: {
        status: 'ACTIVE',
        schedule: { status: 'PUBLISHED' },
        startsAt: { gte: new Date(now.getTime() - lookbackMs), lte: now },
        employmentAssignment: {
          status: 'ACTIVE',
          position: { organizationId: { notIn: disabled } },
        },
      },
      include: {
        revisions: {
          orderBy: { revisionNumber: 'desc' },
          take: 1,
          select: { id: true, revisionNumber: true },
        },
        employmentAssignment: {
          include: { position: { include: positionInclude() } },
        },
      },
      orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
    });
    for (const shift of shifts) {
      result.scanned += 1;
      try {
        if (await this.detectNoShow(shift, now, context)) result.detected += 1;
      } catch (error) {
        result.failed.push({
          scheduledShiftId: shift.id,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    // Re-check open no-shows (up to 31 days back) whose facts may have changed since.
    const open = await this.prisma.attendanceException.findMany({
      where: {
        type: 'NO_SHOW',
        status: 'OPEN',
        detectedAt: { gte: new Date(now.getTime() - 31 * 86_400_000) },
      },
      select: { id: true },
    });
    for (const exception of open) {
      try {
        if (await this.supersedeNoShowIfStale(exception.id, now)) {
          result.superseded += 1;
        }
      } catch (error) {
        result.failed.push({
          scheduledShiftId: exception.id,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return result;
  }

  private async detectNoShow(
    shift: {
      id: string;
      employmentAssignmentId: string;
      workDate: Date;
      startsAt: Date;
      endsAt: Date;
      timezone: string;
      revisions: Array<{ id: string; revisionNumber: number }>;
      employmentAssignment: NonNullable<
        Awaited<ReturnType<TimeService['assignmentById']>>
      >;
    },
    now: Date,
    context: TimeRequestContext,
  ) {
    const revision = shift.revisions[0];
    if (!revision) return false;
    const assignment = shift.employmentAssignment;
    // Batch 5A: employment is bounded by its dates, whatever the stored status says (an
    // assignment past its end date may still read ACTIVE until it is processed).
    if (
      assignment.startDate.getTime() > shift.workDate.getTime() ||
      (assignment.endDate !== null &&
        assignment.endDate.getTime() < shift.workDate.getTime())
    ) {
      return false;
    }
    const policy = await this.effectivePolicyForAssignmentOnWorkDate(
      assignment,
      shift.workDate,
      this.prisma,
    );
    if (policy.noShow?.enabled !== true) return false;
    // Batch 4F (D7): presence-only assignments (SIGN_IN_ONLY) too, on the same opt-in, grace,
    // excused-absence, cancellation and finalized-time rules. A presence no-show is only a
    // review flag: it never records, deducts or pays minutes.
    const trackingMode = attendanceModes(policy).trackingMode;
    const presence = trackingMode === 'SIGN_IN_ONLY';
    if (!presence) {
      if (trackingMode !== 'TIME_CLOCK') return false;
      if (policy.clock?.mode !== 'LIVE_CLOCK') return false;
    }
    const graceMinutes =
      typeof policy.noShow.graceMinutes === 'number'
        ? policy.noShow.graceMinutes
        : 30;
    if (now.getTime() < shift.startsAt.getTime() + graceMinutes * 60_000) {
      return false;
    }
    return this.prisma.$transaction(async (tx) => {
      // Serialized with capture and corrections of the employee's time (and, for presence,
      // with sign-in capture, which holds the presence lock).
      await this.lockEmployeeTime(assignment.employeeId, tx);
      if (presence) {
        await advisoryLock(tx, `attendance:presence:${assignment.employeeId}`);
      }
      const already = await tx.attendanceException.findFirst({
        where: { type: 'NO_SHOW', scheduledShiftRevisionId: revision.id },
        select: { id: true },
      });
      if (already) return false;
      if (
        await this.shiftIsAttendedOrExcused(shift, assignment.employeeId, tx)
      ) {
        return false;
      }
      if (
        await this.finalizedTimesheetOf(
          {
            employeeId: assignment.employeeId,
            employmentAssignmentId: assignment.id,
            workDate: shift.workDate,
          },
          tx,
        )
      ) {
        return false;
      }
      const created = await tx.attendanceException.createManyAndReturn({
        data: [
          {
            employeeId: assignment.employeeId,
            employmentAssignmentId: assignment.id,
            scheduledShiftId: shift.id,
            scheduledShiftRevisionId: revision.id,
            type: 'NO_SHOW',
            severity: 'REVIEW',
            workflowImpact: 'NON_BLOCKING',
            detectedAt: now,
            reason: presence
              ? 'No sign-in was recorded for a published shift. Review it: nothing was recorded automatically.'
              : 'No attendance was recorded for a published shift. Review it: nothing was deducted or recorded automatically.',
            metadata: jsonMetadata({
              trackingMode: presence ? 'SIGN_IN_ONLY' : 'TIME_CLOCK',
              workDate: dateOnly(shift.workDate),
              startsAt: shift.startsAt.toISOString(),
              endsAt: shift.endsAt.toISOString(),
              timezone: shift.timezone,
              revisionNumber: revision.revisionNumber,
              graceMinutes,
            }),
          },
        ],
        skipDuplicates: true,
        select: { id: true },
      });
      if (created.length === 0) return false;
      await this.writeAudit(
        tx,
        'TIME_NO_SHOW_DETECTED',
        created[0]!.id,
        context,
        {
          employeeId: assignment.employeeId,
          employmentAssignmentId: assignment.id,
          scheduledShiftId: shift.id,
          revisionNumber: revision.revisionNumber,
        },
        'AttendanceException',
      );
      return true;
    });
  }

  /**
   * Attendance on the shift's assignment (an entry overlapping it, coverage of one, a sign-in
   * confirming it or an unlinked sign-in inside its window), or approved leave overlapping it
   * (any part of the shift: never a false no-show for leave).
   */
  private async shiftIsAttendedOrExcused(
    shift: {
      id: string;
      employmentAssignmentId: string;
      startsAt: Date;
      endsAt: Date;
      workDate: Date;
    },
    employeeId: string,
    client: TimeClient,
  ) {
    // Batch 4F (D7): presence is judged per occurrence. A sign-in confirming this shift counts;
    // so does an UNLINKED sign-in of the assignment inside this occurrence's attendance window
    // (from the schedule policy's early bound before its start until its end, compared as
    // instants, so overnight shifts and time zones need no special case). A sign-in linked to
    // another occurrence never counts for this one, even when their windows overlap.
    const linked = await client.attendanceSignIn.findFirst({
      where: { status: 'ACTIVE', scheduledShiftId: shift.id },
      select: { id: true },
    });
    if (linked) return true;
    const earlyMinutes = this.schedules
      ? await this.schedules.earlyAttendanceMinutes(
          shift.employmentAssignmentId,
          shift.workDate,
          client,
        )
      : 0;
    const unlinked = await client.attendanceSignIn.findFirst({
      where: {
        status: 'ACTIVE',
        scheduledShiftId: null,
        employmentAssignmentId: shift.employmentAssignmentId,
        signedInAt: {
          gte: new Date(shift.startsAt.getTime() - earlyMinutes * 60_000),
          lte: shift.endsAt,
        },
      },
      select: { id: true },
    });
    if (unlinked) return true;
    const overlapping = {
      archivedAt: null,
      clockInAt: { lt: shift.endsAt },
      OR: [{ clockOutAt: null }, { clockOutAt: { gt: shift.startsAt } }],
    } satisfies Prisma.TimeEntryWhereInput;
    const entry = await client.timeEntry.findFirst({
      where: {
        OR: [
          {
            employmentAssignmentId: shift.employmentAssignmentId,
            ...overlapping,
          },
          { scheduledShiftId: shift.id, archivedAt: null },
          {
            ...overlapping,
            assignmentCoverages: {
              some: {
                employmentAssignmentId: shift.employmentAssignmentId,
                removedAt: null,
              },
            },
          },
        ],
      },
      select: { id: true },
    });
    if (entry) return true;
    const absences = this.absences
      ? await this.absences.approvedAbsences(
          {
            employeeId,
            start: shift.startsAt.toISOString(),
            end: shift.endsAt.toISOString(),
          },
          client,
        )
      : [];
    return absences.some(
      (absence) =>
        !absence.employmentAssignmentId ||
        absence.employmentAssignmentId === shift.employmentAssignmentId,
    );
  }

  /** Supersedes an OPEN no-show whose shift changed or is now attended or excused. */
  private async supersedeNoShowIfStale(exceptionId: string, now: Date) {
    return this.prisma.$transaction(async (tx) => {
      const exception = await tx.attendanceException.findUnique({
        where: { id: exceptionId },
        include: {
          scheduledShift: {
            include: {
              schedule: { select: { status: true } },
              revisions: {
                orderBy: { revisionNumber: 'desc' },
                take: 1,
                select: { id: true },
              },
            },
          },
        },
      });
      const shift = exception?.scheduledShift;
      if (!exception || exception.status !== 'OPEN' || !shift) return false;
      const stale =
        shift.status !== 'ACTIVE' ||
        shift.schedule.status !== 'PUBLISHED' ||
        shift.revisions[0]?.id !== exception.scheduledShiftRevisionId ||
        (await this.shiftIsAttendedOrExcused(shift, exception.employeeId, tx));
      if (!stale) return false;
      const updated = await tx.attendanceException.updateMany({
        where: { id: exception.id, status: 'OPEN' },
        data: {
          status: 'SUPERSEDED',
          resolutionMethod: 'SYSTEM_AUTO_RESOLUTION',
          resolvedAt: now,
        },
      });
      return updated.count === 1;
    });
  }

  // ─── Batch 4C: attendance-only period automation ───────────────────────────

  /**
   * Batch 4C — period generation (and optionally timesheet materialization) for organizations
   * that opt in through their ORGANIZATION (or SYSTEM) time policy: periods.autoGenerate with a
   * cadence and an anchorDate (the first day of one period; every other period follows from it).
   * Each run creates the period containing today and those starting within leadDays, never
   * earlier ones. Organizations whose periods payroll prepares (any pay group with a payroll
   * calendar) are skipped: payroll owns their periods. With periods.autoMaterialize, the
   * organization's periods overlapping the last 35 days get their timesheets (idempotent).
   */
  async prepareAttendancePeriods(context: TimeRequestContext = {}) {
    const now = this.clock.now();
    const disabled = await this.features.disabledOrganizations('ATTENDANCE');
    const organizations = await this.prisma.organization.findMany({
      where: { archivedAt: null, id: { notIn: [...disabled] } },
      select: { id: true, timezone: true },
      orderBy: { id: 'asc' },
    });
    const result = {
      organizations: 0,
      periodsCreated: 0,
      timesheetsCreated: 0,
      skippedPayrollManaged: [] as string[],
      failed: [] as Array<{ organizationId: string; message: string }>,
    };
    for (const organization of organizations) {
      try {
        const today = this.domain.parseDateOnly(
          this.domain.deriveWorkDate(now, organization.timezone ?? 'UTC'),
        );
        const policy = await this.organizationPolicyOn(organization.id, today);
        const periods = policy.periods ?? {};
        if (periods.autoGenerate !== true) continue;
        const cadence = periods.cadence as TimePeriodCadence | undefined;
        const anchor =
          typeof periods.anchorDate === 'string'
            ? this.domain.parseDateOnly(periods.anchorDate)
            : null;
        if (!cadence || !anchor) {
          throw new Error(
            'periods.autoGenerate needs periods.cadence and periods.anchorDate.',
          );
        }
        assertPeriodStartFitsCadence(anchor, cadence);
        if (
          (await this.prisma.payrollCalendar.count({
            where: { payGroup: { organizationId: organization.id } },
          })) > 0
        ) {
          result.skippedPayrollManaged.push(organization.id);
          continue;
        }
        result.organizations += 1;
        const leadDays =
          typeof periods.leadDays === 'number' ? periods.leadDays : 7;
        const horizon = addDateOnlyDays(today, leadDays);
        const bounds: Array<{ startDate: Date; endDate: Date }> = [];
        for (let index = 0; index < 5_000; index += 1) {
          const next = periodBounds(anchor, cadence, index);
          if (next.startDate > horizon) break;
          if (next.endDate >= today) bounds.push(next);
        }
        const { created } = await this.prisma.$transaction((tx) =>
          this.createPeriods(tx, organization.id, cadence, bounds),
        );
        result.periodsCreated += created;
        if (created > 0) {
          await this.writeAudit(
            this.prisma,
            'TIME_PERIODS_GENERATED',
            organization.id,
            context,
            {
              organizationId: organization.id,
              cadence,
              count: created,
              automatic: true,
            },
            'TimePeriod',
          );
        }
        if (periods.autoMaterialize === true) {
          const recent = await this.prisma.timePeriod.findMany({
            where: {
              organizationId: organization.id,
              startDate: { lte: today },
              endDate: { gte: addDateOnlyDays(today, -35) },
            },
          });
          for (const period of recent) {
            const outcome = await this.materializePeriodTimesheets(period);
            result.timesheetsCreated += outcome.created;
          }
        }
      } catch (error) {
        result.failed.push({
          organizationId: organization.id,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return result;
  }

  /** The SYSTEM and ORGANIZATION policy layers in effect on a date (organization settings). */
  private async organizationPolicyOn(organizationId: string, date: Date) {
    const layers = [];
    const system = await this.findPolicy(
      this.prisma,
      { scopeType: 'SYSTEM' },
      date,
    );
    if (system) layers.push(system);
    const organization = await this.findPolicy(
      this.prisma,
      { scopeType: 'ORGANIZATION', organizationId },
      date,
    );
    if (organization) layers.push(organization);
    return this.domain.resolvePolicyConfig(layers);
  }

  /**
   * Generates `count` consecutive periods of a cadence from `startDate` (time.timesheet.manage on
   * the organization). An existing period with exactly the same dates is reused; a period that
   * overlaps one of different dates is refused (409 TIME_PERIOD_OVERLAP) and nothing is created.
   * Batch 4C: one transaction under the organization's period lock, so concurrent requests
   * (and payroll's ensureTimePeriod, which takes the same lock) are serialized.
   */
  async generateTimePeriods(
    actorUserId: string,
    dto: GenerateTimePeriodsDto,
    context: TimeRequestContext,
  ) {
    const startDate = this.domain.parseDateOnly(dto.startDate);
    const count = dto.count ?? 1;
    await this.authorization.assertCan(
      actorUserId,
      'time.timesheet.manage',
      { type: 'ORGANIZATION', id: dto.organizationId },
      this.prisma,
    );
    await this.features.require(dto.organizationId, 'ATTENDANCE');
    assertPeriodStartFitsCadence(startDate, dto.cadence);
    const result = await this.prisma.$transaction((tx) =>
      this.createPeriods(
        tx,
        dto.organizationId,
        dto.cadence,
        Array.from({ length: count }, (_, index) =>
          periodBounds(startDate, dto.cadence, index),
        ),
      ),
    );
    if (result.created > 0) {
      await this.writeAudit(
        this.prisma,
        'TIME_PERIODS_GENERATED',
        dto.organizationId,
        context,
        {
          organizationId: dto.organizationId,
          cadence: dto.cadence,
          count: result.created,
          requestedCount: count,
          startDate: dateOnly(startDate),
        },
        'TimePeriod',
      );
    }
    return {
      periods: result.periods.map((period) => this.periodShape(period)),
    };
  }

  /**
   * Creates the given periods of one organization under its period lock: exact matches are
   * reused, overlaps refused (409 TIME_PERIOD_OVERLAP, naming the existing period).
   */
  private async createPeriods(
    tx: Prisma.TransactionClient,
    organizationId: string,
    cadence: TimePeriodCadence,
    bounds: Array<{ startDate: Date; endDate: Date }>,
  ) {
    await advisoryLock(tx, `time-periods:${organizationId}`);
    const periods = [];
    let created = 0;
    for (const { startDate, endDate } of bounds) {
      const existing = await tx.timePeriod.findUnique({
        where: {
          organizationId_startDate_endDate: {
            organizationId,
            startDate,
            endDate,
          },
        },
      });
      if (existing) {
        periods.push(existing);
        continue;
      }
      const overlapping = await tx.timePeriod.findFirst({
        where: {
          organizationId,
          startDate: { lte: endDate },
          endDate: { gte: startDate },
        },
        orderBy: { startDate: 'asc' },
      });
      if (overlapping) {
        throw this.periodOverlap(startDate, endDate, overlapping);
      }
      periods.push(
        await tx.timePeriod.create({
          data: {
            organizationId,
            startDate,
            endDate,
            status: 'OPEN',
            cadence,
            openedAt: this.clock.now(),
          },
        }),
      );
      created += 1;
    }
    return { periods, created };
  }

  /** 409 TIME_PERIOD_OVERLAP, naming the existing period (attendance and payroll alike). */
  private periodOverlap(
    startDate: Date,
    endDate: Date,
    existing: Parameters<TimeService['periodShape']>[0],
  ) {
    return new ConflictException(
      timeError(
        409,
        'TIME_PERIOD_OVERLAP',
        'The period overlaps an existing time period of the organization with different dates.',
        {
          startDate: dateOnly(startDate),
          endDate: dateOnly(endDate),
          conflictingPeriod: this.periodShape(existing),
        },
      ),
    );
  }

  /**
   * Batch 4C — the time periods a reader may see: organizations where they hold any time read or
   * timesheet permission (System: all), optionally one organization, periods overlapping
   * [from, to], a status. Newest first, cursor-paged. `payrollManaged` marks periods a payroll
   * calendar uses (created by payroll preparation, or shared with it).
   */
  async listTimePeriods(userId: string, query: TimePeriodsQueryDto = {}) {
    const organizations = await this.timeOrganizations(userId, [
      'time.view',
      'time.timesheet.approve',
      'time.timesheet.manage',
    ]);
    if (
      !organizations ||
      (query.organizationId &&
        organizations !== 'ALL' &&
        !organizations.includes(query.organizationId))
    ) {
      return { items: [], nextAfterId: null };
    }
    const disabled = await this.features.disabledOrganizations('ATTENDANCE');
    const rows = await this.prisma.timePeriod.findMany({
      where: {
        AND: [
          query.organizationId
            ? { organizationId: query.organizationId }
            : organizations === 'ALL'
              ? {}
              : { organizationId: { in: organizations } },
          // Batch 4F (C10): disabled organizations' periods only when history is asked for.
          query.includeDisabledOrganizations
            ? {}
            : { organizationId: { notIn: [...disabled] } },
          query.status ? { status: query.status } : {},
          query.to
            ? { startDate: { lte: this.domain.parseDateOnly(query.to) } }
            : {},
          query.from
            ? { endDate: { gte: this.domain.parseDateOnly(query.from) } }
            : {},
        ],
      },
      include: {
        _count: { select: { payrollPeriods: true, timesheets: true } },
      },
      orderBy: [{ startDate: 'desc' }, { id: 'desc' }],
      take: this.pageTake(query.limit),
      ...(query.afterId ? { cursor: { id: query.afterId }, skip: 1 } : {}),
    });
    return {
      ...this.page(
        rows,
        (row) => ({
          ...this.periodShape(row),
          payrollManaged: row._count.payrollPeriods > 0,
          timesheetCount: row._count.timesheets,
          attendanceEnabled: !disabled.has(row.organizationId),
        }),
        query.limit,
      ),
      attendanceDisabledOrganizationIds: [
        ...new Set(
          rows
            .map((row) => row.organizationId)
            .filter((id) => disabled.has(id)),
        ),
      ].sort(),
    };
  }

  /**
   * Batch 4C — creates the period's timesheets without payroll (time.timesheet.manage on the
   * organization). Every employee with a non-cancelled assignment of the period's organization
   * overlapping the period gets one, when that assignment records time by clock (TIME_CLOCK on
   * its first day in the period) or already has time entries in the period. Idempotent: an
   * existing timesheet is reused (its refresh never changes an APPROVED or LOCKED one); each
   * timesheet is created under its own lock and the (employee, period) uniqueness.
   */
  async materializeTimesheets(
    actorUserId: string,
    timePeriodId: string,
    context: TimeRequestContext,
  ) {
    const period = await this.prisma.timePeriod.findUnique({
      where: { id: timePeriodId },
    });
    if (!period) throw new NotFoundException('Time period not found.');
    await this.assertOrganizationVisible(
      actorUserId,
      period.organizationId,
      ['time.timesheet.manage', 'time.timesheet.approve', 'time.view'],
      this.prisma,
      'Time period not found.',
    );
    await this.authorization.assertCan(
      actorUserId,
      'time.timesheet.manage',
      { type: 'ORGANIZATION', id: period.organizationId },
      this.prisma,
    );
    await this.features.require(period.organizationId, 'ATTENDANCE');
    const outcome = await this.materializePeriodTimesheets(period);
    await this.writeAudit(
      this.prisma,
      'TIME_TIMESHEETS_MATERIALIZED',
      period.id,
      context,
      {
        organizationId: period.organizationId,
        timePeriodId: period.id,
        created: outcome.created,
        existing: outcome.existing,
        finalized: outcome.finalized,
      },
      'TimePeriod',
    );
    return { period: this.periodShape(period), ...outcome };
  }

  /** The materialization itself (also used by the attendance-only automation job). */
  private async materializePeriodTimesheets(period: {
    id: string;
    organizationId: string;
    startDate: Date;
    endDate: Date;
  }) {
    const assignments = await this.prisma.employmentAssignment.findMany({
      where: {
        status: { not: 'CANCELLED' },
        startDate: { lte: period.endDate },
        OR: [{ endDate: null }, { endDate: { gte: period.startDate } }],
        position: { organizationId: period.organizationId },
        employee: { archivedAt: null },
      },
      include: { position: { include: positionInclude() } },
      orderBy: [{ employeeId: 'asc' }, { id: 'asc' }],
    });
    const employees = new Set<string>();
    for (const assignment of assignments) {
      if (employees.has(assignment.employeeId)) continue;
      const firstDay =
        assignment.startDate > period.startDate
          ? assignment.startDate
          : period.startDate;
      let clocked = false;
      try {
        clocked =
          attendanceModes(
            await this.effectivePolicyForAssignmentOnWorkDate(
              assignment as NonNullable<
                Awaited<ReturnType<TimeService['assignmentById']>>
              >,
              firstDay,
              this.prisma,
            ),
          ).trackingMode === 'TIME_CLOCK';
      } catch {
        clocked = false;
      }
      const recorded =
        clocked ||
        (await this.prisma.timeEntry.count({
          where: {
            employmentAssignmentId: assignment.id,
            archivedAt: null,
            workDate: { gte: period.startDate, lte: period.endDate },
          },
        })) > 0;
      if (recorded) employees.add(assignment.employeeId);
    }
    let created = 0;
    let existing = 0;
    let finalized = 0;
    const timesheetIds: string[] = [];
    for (const employeeId of employees) {
      const sheet = await this.ensureTimesheet({
        employeeId,
        timePeriodId: period.id,
      });
      timesheetIds.push(sheet.timesheetId);
      if (sheet.created) created += 1;
      else existing += 1;
      if (sheet.status === 'APPROVED' || sheet.status === 'LOCKED') {
        finalized += 1;
      }
    }
    return { created, existing, finalized, timesheetIds };
  }

  async selfTimesheets(userId: string) {
    const employee = await this.requireSelfEmployee(userId, this.prisma, {
      purpose: 'read',
    });
    const rows = await this.prisma.timesheet.findMany({
      where: { employeeId: employee.id },
      include: this.timesheetInclude(),
      orderBy: { createdAt: 'desc' },
    });
    // Batch 4E-3 (C3): who acted, by display name (only the users these timesheets reference).
    const named = await this.withActorNames(
      {
        items: rows.map((row) =>
          this.timesheetShape(this.scopedTimesheet(row)),
        ),
        nextAfterId: null,
      },
      (item) => this.timesheetActorIds(item),
    );
    return {
      timesheets: named.items,
      attendanceDisabledOrganizationIds:
        await this.disabledOrganizationsOfEmployee(employee.id),
    };
  }

  async selfTimesheet(userId: string, timesheetId: string) {
    const employee = await this.requireSelfEmployee(userId, this.prisma, {
      purpose: 'read',
    });
    const sheet = await this.timesheetById(timesheetId, this.prisma);
    if (!sheet || sheet.employeeId !== employee.id) {
      throw new NotFoundException('Timesheet not found.');
    }
    // Batch 4F (C10): a disabled organization's timesheet is history: read as stored, never
    // refreshed (that recalculation is a write, and Time & attendance is off there).
    const historical = (
      await this.features.disabledAmong('ATTENDANCE', [
        sheet.timePeriod.organizationId,
      ])
    ).has(sheet.timePeriod.organizationId);
    const named = await this.withActorNames(
      {
        items: [
          // Already scoped to the period's organization by the refresh (as before).
          this.timesheetShape(
            historical
              ? this.scopedTimesheet(sheet)
              : await this.refreshTimesheetIfMutable(sheet.id, this.prisma),
          ),
        ],
        nextAfterId: null,
      },
      (item) => this.timesheetActorIds(item),
    );
    return { ...named.items[0]!, attendanceEnabled: !historical };
  }

  /** The users a timesheet names: who submitted, approved, locked, reopened and reviewed. */
  private timesheetActorIds(item: ReturnType<TimeService['timesheetShape']>) {
    return [
      item.submittedByUserId,
      item.approvedByUserId,
      item.lockedByUserId,
      item.reopenedByUserId,
      ...item.segments.map((segment) => segment.reviewedByUserId),
      ...(item.events ?? []).map((event) => event.actorUserId),
    ];
  }

  // ─── Phase 10: PayrollTimeSource (Payroll requests, Time owns) ────────────

  async ensureTimePeriod(
    client: unknown,
    input: {
      organizationId: string;
      startDate: string;
      endDate: string;
      cadence: PayrollTimePeriodCadence;
      payrollPeriodId: string | null;
    },
    context: TimeRequestContext,
  ): Promise<{ timePeriodId: string; created: boolean }> {
    const tx = client as Prisma.TransactionClient;
    const startDate = this.domain.parseDateOnly(input.startDate);
    const endDate = this.domain.parseDateOnly(input.endDate);
    const now = this.clock.now();
    // Batch 4C: the organization's period lock, shared with attendance-only generation, so the
    // two never interleave. It is held until the caller's transaction commits, and the caller
    // links its PayrollPeriod in that same transaction, so the ownership read below always
    // sees every committed link.
    await advisoryLock(tx, `time-periods:${input.organizationId}`);
    // Batch 4C (option B): a period with exactly these dates is reused, whoever created it
    // (an attendance-owned one becomes payroll-owned once linked). Otherwise payroll may not
    // create a period that overlaps an ATTENDANCE-OWNED period (no PayrollPeriod uses it):
    // 409 TIME_PERIOD_OVERLAP. Payroll-owned periods of other pay groups may overlap, as
    // multiple pay groups with different calendars require; within one pay group the payroll
    // calendar already refuses overlaps before calling here.
    const exact = await tx.timePeriod.findUnique({
      where: {
        organizationId_startDate_endDate: {
          organizationId: input.organizationId,
          startDate,
          endDate,
        },
      },
      select: { id: true },
    });
    if (exact) return { timePeriodId: exact.id, created: false };
    const attendanceOwned = await tx.timePeriod.findFirst({
      where: {
        organizationId: input.organizationId,
        startDate: { lte: endDate },
        endDate: { gte: startDate },
        payrollPeriods: { none: {} },
      },
      orderBy: { startDate: 'asc' },
    });
    if (attendanceOwned) {
      throw this.periodOverlap(startDate, endDate, attendanceOwned);
    }
    // ON CONFLICT DO NOTHING: a concurrent creator never aborts the caller's transaction.
    const inserted = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      INSERT INTO "TimePeriod" ("id", "organizationId", "startDate", "endDate", "status", "cadence", "openedAt", "updatedAt")
      VALUES (gen_random_uuid(), ${input.organizationId}::uuid, ${startDate}::date, ${endDate}::date,
              'OPEN', ${input.cadence}::"TimePeriodCadence", ${now}, ${now})
      ON CONFLICT ("organizationId", "startDate", "endDate") DO NOTHING
      RETURNING "id"`);
    if (inserted[0]) {
      await this.writeAudit(
        tx,
        'TIME_PERIOD_ENSURED_FOR_PAYROLL',
        inserted[0].id,
        context,
        {
          organizationId: input.organizationId,
          startDate: input.startDate,
          endDate: input.endDate,
          cadence: input.cadence,
          payrollPeriodId: input.payrollPeriodId,
        },
        'TimePeriod',
      );
      return { timePeriodId: inserted[0].id, created: true };
    }
    const existing = await tx.timePeriod.findUniqueOrThrow({
      where: {
        organizationId_startDate_endDate: {
          organizationId: input.organizationId,
          startDate,
          endDate,
        },
      },
      select: { id: true },
    });
    return { timePeriodId: existing.id, created: false };
  }

  async ensureTimesheet(input: {
    employeeId: string;
    timePeriodId: string;
  }): Promise<{ timesheetId: string; status: string; created: boolean }> {
    return this.prisma.$transaction(async (tx) => {
      // Serializes materialization of one timesheet (refresh writes its segments).
      await tx.$executeRaw(
        Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`timesheet:${input.employeeId}:${input.timePeriodId}`}, 0))`,
      );
      const inserted = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        INSERT INTO "Timesheet" ("id", "employeeId", "timePeriodId", "updatedAt")
        VALUES (gen_random_uuid(), ${input.employeeId}::uuid, ${input.timePeriodId}::uuid, now())
        ON CONFLICT ("employeeId", "timePeriodId") DO NOTHING
        RETURNING "id"`);
      const sheet = await tx.timesheet.findUniqueOrThrow({
        where: {
          employeeId_timePeriodId: {
            employeeId: input.employeeId,
            timePeriodId: input.timePeriodId,
          },
        },
        select: { id: true },
      });
      const refreshed = await this.refreshTimesheetIfMutable(sheet.id, tx);
      return {
        timesheetId: sheet.id,
        status: refreshed.status,
        created: inserted.length > 0,
      };
    });
  }

  async payrollTimesheet(
    query: { employeeId: string; timePeriodId: string },
    client?: unknown,
  ): Promise<PayrollTimesheetFact | null> {
    const db = (client as TimeClient | undefined) ?? this.prisma;
    const sheet = await db.timesheet.findUnique({
      where: {
        employeeId_timePeriodId: {
          employeeId: query.employeeId,
          timePeriodId: query.timePeriodId,
        },
      },
      include: {
        timePeriod: { select: { organizationId: true } },
        segments: {
          select: {
            id: true,
            employmentAssignmentId: true,
            status: true,
            employmentAssignment: {
              select: { position: { select: { organizationId: true } } },
            },
          },
          orderBy: { employmentAssignmentId: 'asc' },
        },
      },
    });
    if (!sheet) return null;
    // Batch 4B (D3): only the period's organization's segments (payroll also keeps only its own
    // assignment's, so the payroll fingerprint is unchanged).
    const segments = sheet.segments.filter(
      (segment) =>
        segment.employmentAssignment.position.organizationId ===
        sheet.timePeriod.organizationId,
    );
    const final = sheet.status === 'APPROVED' || sheet.status === 'LOCKED';
    return {
      timesheetId: sheet.id,
      employeeId: sheet.employeeId,
      timePeriodId: sheet.timePeriodId,
      status: sheet.status,
      version: sheet.version,
      finalizationStatus: final
        ? (sheet.status as 'APPROVED' | 'LOCKED')
        : null,
      workDates: final ? payrollWorkDateOutputsFromTotals(sheet.totals) : [],
      segments: segments.map((segment) => ({
        timesheetSegmentId: segment.id,
        employmentAssignmentId: segment.employmentAssignmentId,
        status: segment.status,
      })),
    };
  }

  async payrollAssignmentTime(
    query: { employmentAssignmentId: string; from: string; to: string },
    client?: unknown,
  ): Promise<PayrollAssignmentTimeFact> {
    const db = (client as TimeClient | undefined) ?? this.prisma;
    const from = this.domain.parseDateOnly(query.from);
    const to = this.domain.parseDateOnly(query.to);
    const assignment = await this.assignmentById(
      query.employmentAssignmentId,
      db,
    );
    if (!assignment) throw new NotFoundException('Assignment not found.');
    const days: PayrollAssignmentTimeFact['days'] = [];
    for (
      let day = from;
      day <= to;
      day = new Date(day.getTime() + 86_400_000)
    ) {
      let trackingMode: 'TIME_CLOCK' | 'SIGN_IN_ONLY' | null = null;
      try {
        trackingMode = attendanceModes(
          await this.effectivePolicyForAssignmentOnWorkDate(
            assignment,
            day,
            db,
          ),
        ).trackingMode;
      } catch {
        trackingMode = null;
      }
      days.push({ date: dateOnly(day) ?? '', trackingMode });
    }
    const [closedEntries, openEntries] = await Promise.all([
      db.timeEntry.count({
        where: {
          employmentAssignmentId: query.employmentAssignmentId,
          archivedAt: null,
          status: 'CLOSED',
          workDate: { gte: from, lte: to },
        },
      }),
      db.timeEntry.count({
        where: {
          employmentAssignmentId: query.employmentAssignmentId,
          archivedAt: null,
          status: 'OPEN',
          workDate: { gte: from, lte: to },
        },
      }),
    ]);
    return {
      timezone: this.resolvedTimezone(assignment),
      days,
      closedEntries,
      openEntries,
    };
  }

  async materializeTimesheetForEmployeePeriod(
    employeeId: string,
    timePeriodId: string,
    client: TimeClient = this.prisma,
  ) {
    const period = await client.timePeriod.findUnique({
      where: { id: timePeriodId },
    });
    if (!period) throw new NotFoundException('Time period not found.');
    const sheet = await client.timesheet.upsert({
      where: { employeeId_timePeriodId: { employeeId, timePeriodId } },
      create: { employeeId, timePeriodId, status: 'OPEN' },
      update: {},
    });
    return this.refreshTimesheetIfMutable(sheet.id, client);
  }

  /**
   * The timesheet lifecycle:
   *
   *   OPEN | CHANGES_REQUESTED --submit--> SUBMITTED
   *     (the employee; or a manager with time.timesheet.manage and a reason, on their behalf)
   *   SUBMITTED --approve every segment (time.timesheet.approve)--> APPROVED
   *     (the payroll snapshot is frozen at that moment)
   *   APPROVED --lock (time.timesheet.manage)--> LOCKED (the same snapshot)
   *   APPROVED | LOCKED --reopen (time.timesheet.manage, reason)--> OPEN, version + 1
   *   APPROVED --request changes (time.timesheet.manage, reason)--> reopen, then CHANGES_REQUESTED
   *   SUBMITTED --request changes (time.timesheet.approve)--> CHANGES_REQUESTED
   *
   * Submission and approval need the period to have ended (unless the policy allows early
   * submission) and no open entry, blocking exception or pending correction in it. Every
   * transition locks the timesheet row, so concurrent reviews are serialized.
   */
  async submitTimesheet(
    userId: string,
    timesheetId: string,
    context: TimeRequestContext,
    expected: {
      expectedNetWorkedMinutes?: number;
      expectedVersion?: number;
    } = {},
  ) {
    const now = this.clock.now();
    const employee = await this.requireSelfEmployee(userId);
    return this.prisma.$transaction(async (tx) => {
      await this.lockTimesheetRow(timesheetId, tx);
      const sheet = await this.timesheetById(timesheetId, tx);
      if (!sheet || sheet.employeeId !== employee.id) {
        throw new NotFoundException('Timesheet not found.');
      }
      // Batch 4E-3 (C10): submitting is an operational action of the period's organization;
      // with Time & attendance switched off there it is refused (the timesheet stays readable).
      await this.features.require(
        sheet.timePeriod.organizationId,
        'ATTENDANCE',
        tx,
      );
      return this.submitLockedTimesheet(
        tx,
        sheet,
        userId,
        now,
        context,
        null,
        expected,
      );
    });
  }

  /**
   * Submits for an employee who cannot submit their own timesheet: explicit, needs
   * time.timesheet.manage over every segment and a reason, never one's own timesheet, and is
   * audited (TIMESHEET_SUBMITTED_ON_BEHALF). Every submission rule still applies.
   */
  async submitTimesheetOnBehalf(
    actorUserId: string,
    timesheetId: string,
    reason: string | undefined,
    context: TimeRequestContext,
  ) {
    const now = this.clock.now();
    const trimmed = normalizedReason(reason ?? '');
    if (!trimmed) {
      throw new BadRequestException(
        timeError(
          400,
          'TIMESHEET_REASON_REQUIRED',
          'A reason is required to submit a timesheet on behalf of an employee.',
        ),
      );
    }
    return this.prisma.$transaction(async (tx) => {
      await this.lockTimesheetRow(timesheetId, tx);
      const sheet = await this.timesheetById(timesheetId, tx);
      if (!sheet) throw new NotFoundException('Timesheet not found.');
      await this.assertTimesheetVisible(actorUserId, sheet, tx);
      await this.assertTimesheetWideAccess(
        actorUserId,
        sheet,
        'time.timesheet.manage',
        tx,
      );
      await this.assertNotSelfTarget(
        actorUserId,
        sheet.employeeId,
        'time.timesheet.manage',
        'TIMESHEET_SUBMIT_ON_BEHALF',
        context,
        tx,
      );
      return this.submitLockedTimesheet(
        tx,
        sheet,
        actorUserId,
        now,
        context,
        trimmed,
      );
    });
  }

  private async submitLockedTimesheet(
    tx: Prisma.TransactionClient,
    sheet: NonNullable<Awaited<ReturnType<TimeService['timesheetById']>>>,
    actorUserId: string,
    now: Date,
    context: TimeRequestContext,
    onBehalfReason: string | null,
    expected: {
      expectedNetWorkedMinutes?: number;
      expectedVersion?: number;
    } = {},
  ) {
    if (
      sheet.status === 'SUBMITTED' ||
      sheet.status === 'APPROVED' ||
      sheet.status === 'LOCKED'
    ) {
      return this.timesheetShape(sheet);
    }
    if (sheet.status !== 'OPEN' && sheet.status !== 'CHANGES_REQUESTED') {
      throw new ConflictException('Timesheet cannot be submitted.');
    }
    const refreshed = await this.refreshTimesheetIfMutable(sheet.id, tx);
    // Batch 4E-3 (C3): never submit numbers the employee didn't see. The refresh above is
    // rolled back with the refusal; the next read recalculates the same way.
    if (
      expected.expectedNetWorkedMinutes !== undefined ||
      expected.expectedVersion !== undefined
    ) {
      // The refresh already scoped it to the period's organization: the totals the employee saw.
      const current = this.timesheetShape(refreshed);
      const netWorkedMinutes = (
        current.totals as { netWorkedMinutes?: number } | null
      )?.netWorkedMinutes;
      if (
        (expected.expectedVersion !== undefined &&
          expected.expectedVersion !== current.version) ||
        (expected.expectedNetWorkedMinutes !== undefined &&
          expected.expectedNetWorkedMinutes !== netWorkedMinutes)
      ) {
        throw new ConflictException(
          domainError(
            409,
            'TIMESHEET_TOTALS_CHANGED',
            'This timesheet changed since you reviewed it. Review the updated totals, then submit again.',
            {
              version: current.version,
              netWorkedMinutes: netWorkedMinutes ?? null,
            },
          ),
        );
      }
    }
    await this.assertTimesheetSubmittable(refreshed, tx, 'submitted');
    await this.assertTimesheetPeriodEnded(refreshed, now, tx);
    // Batch 4F: submitting answers a request for changes, so the returned segments are waiting
    // for a decision again (back in the approval queue). The request and its note stay in the
    // timesheet's history (events); nothing approved is touched.
    const returned = refreshed.segments
      .filter((segment) => segment.status === 'CHANGES_REQUESTED')
      .map((segment) => segment.id);
    if (returned.length > 0) {
      await tx.timesheetSegment.updateMany({
        where: { id: { in: returned }, status: 'CHANGES_REQUESTED' },
        data: { status: 'PENDING', approvedWorkedMinutes: 0 },
      });
    }
    const submittedRow = await tx.timesheet.update({
      where: { id: sheet.id },
      data: {
        status: 'SUBMITTED',
        submittedByUserId: actorUserId,
        submittedAt: now,
        reviewerNote: null,
      },
      include: this.timesheetInclude(),
    });
    const submitted = this.scopedTimesheet(submittedRow);
    await this.createTimesheetEvent(
      tx,
      submitted.id,
      null,
      actorUserId,
      'SUBMITTED',
      onBehalfReason,
      onBehalfReason ? { onBehalf: true } : {},
    );
    await this.writeAudit(
      tx,
      onBehalfReason ? 'TIMESHEET_SUBMITTED_ON_BEHALF' : 'TIMESHEET_SUBMITTED',
      submitted.id,
      context,
      {
        employeeId: submitted.employeeId,
        timePeriodId: submitted.timePeriodId,
        ...(onBehalfReason ? { reason: onBehalfReason } : {}),
      },
      'Timesheet',
    );
    return this.timesheetShape(submitted);
  }

  /**
   * Approves one segment of a SUBMITTED timesheet. The submission rules are checked again; a
   * reviewer who sends the minutes they reviewed (`expectedNetWorkedMinutes`) gets 409
   * TIMESHEET_SEGMENT_CHANGED instead of approving numbers that changed since.
   */
  async approveTimesheetSegment(
    actorUserId: string,
    segmentId: string,
    note: string | undefined,
    context: TimeRequestContext,
    options: {
      expectedNetWorkedMinutes?: number;
      expectedVersion?: number;
    } = {},
  ) {
    const now = this.clock.now();
    return this.prisma.$transaction(async (tx) => {
      const found = await this.timesheetSegmentById(segmentId, tx);
      if (!found) throw new NotFoundException('Timesheet segment not found.');
      await this.lockTimesheetRow(found.timesheetId, tx);
      const segment = (await this.timesheetSegmentById(segmentId, tx)) ?? found;
      if (segment.timesheet.employee.person.user?.id === actorUserId) {
        throw new ForbiddenException(
          timeError(
            403,
            'TIME_SELF_TARGET_FORBIDDEN',
            'Users cannot approve their own timesheet segment.',
            { action: 'TIMESHEET_SEGMENT_APPROVE' },
          ),
        );
      }
      await this.assertOrganizationVisible(
        actorUserId,
        found.timesheet.timePeriod.organizationId,
        ['time.timesheet.approve', 'time.timesheet.manage'],
        tx,
        'Timesheet segment not found.',
      );
      await this.assertTimesheetSegmentAccess(
        actorUserId,
        segment.employmentAssignment.positionId,
        'time.timesheet.approve',
        tx,
      );
      if (segment.status === 'APPROVED')
        return this.timesheetShape(segment.timesheet);
      if (segment.timesheet.status === 'LOCKED') {
        throw new ConflictException('Locked timesheets cannot be approved.');
      }
      // Batch 4C: a reviewer working from another version of the timesheet is refused.
      this.assertExpectedVersion(segment.timesheet, options.expectedVersion);
      if (segment.timesheet.status !== 'SUBMITTED') {
        throw new ConflictException(
          timeError(
            409,
            'TIMESHEET_NOT_SUBMITTED',
            'Only a submitted timesheet can be approved. The employee submits it, or a manager submits it on their behalf.',
            { status: segment.timesheet.status },
          ),
        );
      }
      const refreshed = await this.refreshTimesheetIfMutable(
        segment.timesheetId,
        tx,
      );
      await this.assertTimesheetSubmittable(refreshed, tx, 'approved');
      await this.assertTimesheetPeriodEnded(refreshed, now, tx);
      const freshSegment = refreshed.segments.find(
        (item) => item.id === segment.id,
      );
      if (!freshSegment)
        throw new NotFoundException('Timesheet segment not found.');
      if (
        options.expectedNetWorkedMinutes !== undefined &&
        options.expectedNetWorkedMinutes !== freshSegment.netWorkedMinutes
      ) {
        throw new ConflictException(
          timeError(
            409,
            'TIMESHEET_SEGMENT_CHANGED',
            'The segment’s worked time changed since it was reviewed. Review it again.',
            { netWorkedMinutes: freshSegment.netWorkedMinutes },
          ),
        );
      }
      const updated = await tx.timesheetSegment.updateMany({
        where: {
          id: segment.id,
          status: { in: ['PENDING', 'CHANGES_REQUESTED'] },
        },
        data: {
          status: 'APPROVED',
          reviewedByUserId: actorUserId,
          reviewedAt: now,
          reviewerNote: note?.trim() || null,
          approvedWorkedMinutes: freshSegment.netWorkedMinutes,
        },
      });
      if (updated.count === 0) {
        const current = await this.timesheetSegmentById(segmentId, tx);
        if (current?.status === 'APPROVED')
          return this.timesheetShape(current.timesheet);
        throw new ConflictException('Timesheet segment cannot be approved.');
      }
      await this.createTimesheetEvent(
        tx,
        segment.timesheetId,
        segment.id,
        actorUserId,
        'SEGMENT_APPROVED',
        note,
      );
      await this.writeAudit(
        tx,
        'TIMESHEET_SEGMENT_APPROVED',
        segment.id,
        context,
        {
          timesheetId: segment.timesheetId,
          employmentAssignmentId: segment.employmentAssignmentId,
          approvedWorkedMinutes: freshSegment.netWorkedMinutes,
        },
        'TimesheetSegment',
      );
      return this.finalizeTimesheetAfterSegmentReview(
        segment.timesheetId,
        actorUserId,
        context,
        tx,
      );
    });
  }

  /**
   * Sends a segment back. On a SUBMITTED timesheet: time.timesheet.approve, as before. On an
   * APPROVED one this undoes an approval, so it needs what reopening needs
   * (time.timesheet.manage and a reason) and goes through the same reopen (new version, payroll
   * claims recorded) before the segment is marked CHANGES_REQUESTED.
   */
  async requestTimesheetChanges(
    actorUserId: string,
    segmentId: string,
    note: string | undefined,
    context: TimeRequestContext,
  ) {
    const now = this.clock.now();
    return this.prisma.$transaction(async (tx) => {
      const found = await this.timesheetSegmentById(segmentId, tx);
      if (!found) throw new NotFoundException('Timesheet segment not found.');
      await this.assertOrganizationVisible(
        actorUserId,
        found.timesheet.timePeriod.organizationId,
        ['time.timesheet.approve', 'time.timesheet.manage'],
        tx,
        'Timesheet segment not found.',
      );
      await this.lockTimesheetRow(found.timesheetId, tx);
      const segment = (await this.timesheetSegmentById(segmentId, tx)) ?? found;
      await this.assertTimesheetSegmentAccess(
        actorUserId,
        segment.employmentAssignment.positionId,
        'time.timesheet.approve',
        tx,
      );
      await this.assertNotSelfTarget(
        actorUserId,
        segment.timesheet.employeeId,
        'time.timesheet.approve',
        'TIMESHEET_REQUEST_CHANGES',
        context,
        tx,
      );
      if (segment.status === 'CHANGES_REQUESTED')
        return this.timesheetShape(segment.timesheet);
      if (segment.timesheet.status === 'LOCKED') {
        throw new ConflictException(
          'Locked timesheets cannot request changes.',
        );
      }
      if (segment.timesheet.status === 'APPROVED') {
        const reason = normalizedReason(note ?? '');
        if (!reason) {
          throw new BadRequestException(
            timeError(
              400,
              'TIMESHEET_REASON_REQUIRED',
              'A reason is required to send an approved timesheet back.',
            ),
          );
        }
        const sheet = await this.timesheetById(segment.timesheetId, tx);
        if (!sheet) throw new NotFoundException('Timesheet not found.');
        await this.assertTimesheetWideAccess(
          actorUserId,
          sheet,
          'time.timesheet.manage',
          tx,
        );
        await this.reopenLockedTimesheet(
          tx,
          sheet,
          actorUserId,
          reason,
          now,
          context,
        );
      }
      const updated = await tx.timesheetSegment.updateMany({
        where: { id: segment.id, status: { not: 'CHANGES_REQUESTED' } },
        data: {
          status: 'CHANGES_REQUESTED',
          reviewedByUserId: actorUserId,
          reviewedAt: now,
          reviewerNote: note?.trim() || null,
          approvedWorkedMinutes: 0,
        },
      });
      if (updated.count === 0) {
        const current = await this.timesheetById(segment.timesheetId, tx);
        if (!current) throw new NotFoundException('Timesheet not found.');
        return this.timesheetShape(current);
      }
      const sheet = this.scopedTimesheet(
        await tx.timesheet.update({
          where: { id: segment.timesheetId },
          data: {
            status: 'CHANGES_REQUESTED',
            reviewerNote: note?.trim() || null,
          },
          include: this.timesheetInclude(),
        }),
      );
      await this.createTimesheetEvent(
        tx,
        sheet.id,
        segment.id,
        actorUserId,
        'CHANGES_REQUESTED',
        note,
      );
      await this.writeAudit(
        tx,
        'TIMESHEET_CHANGES_REQUESTED',
        segment.id,
        context,
        {
          timesheetId: sheet.id,
          employmentAssignmentId: segment.employmentAssignmentId,
          fromStatus: segment.timesheet.status,
        },
        'TimesheetSegment',
      );
      return this.timesheetShape(sheet);
    });
  }

  /**
   * Locks an APPROVED timesheet, keeping its approved payroll snapshot exactly (only the
   * snapshot's finalizationStatus becomes LOCKED). Optional `expectedVersion` refuses a lock
   * based on a stale view (409 TIMESHEET_VERSION_CONFLICT).
   */
  async lockTimesheet(
    actorUserId: string,
    timesheetId: string,
    context: TimeRequestContext,
    options: { expectedVersion?: number } = {},
  ) {
    return this.prisma.$transaction(async (tx) => {
      await this.lockTimesheetRow(timesheetId, tx);
      return this.lockTimesheetInternal(actorUserId, timesheetId, context, tx, {
        expectedVersion: options.expectedVersion,
      });
    });
  }

  /**
   * Reopens APPROVED or LOCKED time as a new version (time.timesheet.manage, a reason). Every
   * FINALIZED payroll run that claimed the reopened time is listed and gets a durable
   * retroactive-adjustment requirement; finalized runs and claims are never changed.
   */
  async reopenTimesheet(
    actorUserId: string,
    timesheetId: string,
    note: string | undefined,
    context: TimeRequestContext,
    options: { expectedVersion?: number } = {},
  ) {
    const now = this.clock.now();
    return this.prisma.$transaction(async (tx) => {
      await this.lockTimesheetRow(timesheetId, tx);
      const sheet = await this.timesheetById(timesheetId, tx);
      if (!sheet) throw new NotFoundException('Timesheet not found.');
      await this.assertTimesheetVisible(actorUserId, sheet, tx);
      await this.assertTimesheetWideAccess(
        actorUserId,
        sheet,
        'time.timesheet.manage',
        tx,
      );
      // Approved or locked time is finalized; reopening it (a new version) is the only way to
      // correct it, since corrections never change finalized time.
      if (sheet.status !== 'LOCKED' && sheet.status !== 'APPROVED') {
        return this.timesheetShape(sheet);
      }
      this.assertExpectedVersion(sheet, options.expectedVersion);
      const reason = normalizedReason(note ?? '');
      if (!reason) {
        throw new BadRequestException(
          timeError(
            400,
            'TIMESHEET_REASON_REQUIRED',
            'A reason is required to reopen a timesheet.',
          ),
        );
      }
      const finalizedRuns = await this.reopenLockedTimesheet(
        tx,
        sheet,
        actorUserId,
        reason,
        now,
        context,
      );
      return {
        ...this.timesheetShape(
          await this.refreshTimesheetIfMutable(sheet.id, tx),
        ),
        retroAdjustment: {
          required: finalizedRuns.length > 0,
          finalizedPayrollRunIds: finalizedRuns,
        },
      };
    });
  }

  /**
   * The reopen itself, on a timesheet row the caller has locked: refuses self-targeting
   * (System-scope override audited), records a retro requirement for every FINALIZED payroll
   * run that claimed the period's time, resolves the period's RECORDED_AFTER_APPROVAL signals
   * (their time is now under review again) and opens a new version.
   */
  private async reopenLockedTimesheet(
    tx: Prisma.TransactionClient,
    sheet: NonNullable<Awaited<ReturnType<TimeService['timesheetById']>>>,
    actorUserId: string,
    reason: string,
    now: Date,
    context: TimeRequestContext,
  ) {
    await this.assertNotSelfTarget(
      actorUserId,
      sheet.employeeId,
      'time.timesheet.manage',
      'TIMESHEET_REOPEN',
      context,
      tx,
      { allowSystemOverride: true },
    );
    const finalizedRuns = await this.recordPayrollRetroRequirements(
      tx,
      sheet,
      actorUserId,
      reason,
    );
    await tx.timesheet.update({
      where: { id: sheet.id },
      data: {
        status: 'OPEN',
        reopenedByUserId: actorUserId,
        reopenedAt: now,
        approvedByUserId: null,
        approvedAt: null,
        lockedByUserId: null,
        lockedAt: null,
        version: { increment: 1 },
        reviewerNote: reason,
      },
    });
    // Batch 4B (D3): only this organization's segments reopen; another organization's
    // (written before 4B) keep their state.
    await tx.timesheetSegment.updateMany({
      where: {
        timesheetId: sheet.id,
        id: { in: sheet.segments.map((segment) => segment.id) },
      },
      data: { status: 'PENDING', approvedWorkedMinutes: 0 },
    });
    // Batch 4B (O2): only this organization's RECORDED_AFTER_APPROVAL signals are resolved.
    const resolved = await tx.attendanceException.updateMany({
      where: {
        employeeId: sheet.employeeId,
        type: 'RECORDED_AFTER_APPROVAL',
        status: 'OPEN',
        timeEntry: {
          workDate: {
            gte: sheet.timePeriod.startDate,
            lte: sheet.timePeriod.endDate,
          },
          employmentAssignment: {
            position: { organizationId: sheet.timePeriod.organizationId },
          },
        },
      },
      data: {
        status: 'RESOLVED',
        resolutionMethod: 'SYSTEM_AUTO_RESOLUTION',
        resolvedAt: now,
      },
    });
    await this.createTimesheetEvent(
      tx,
      sheet.id,
      null,
      actorUserId,
      'REOPENED',
      reason,
      {
        fromStatus: sheet.status,
        version: sheet.version + 1,
        finalizedPayrollRunIds: finalizedRuns,
      },
    );
    await this.writeAudit(
      tx,
      'TIMESHEET_REOPENED',
      sheet.id,
      context,
      {
        employeeId: sheet.employeeId,
        timePeriodId: sheet.timePeriodId,
        fromStatus: sheet.status,
        version: sheet.version + 1,
        reason,
        finalizedPayrollRunIds: finalizedRuns,
        retroAdjustmentRequired: finalizedRuns.length > 0,
        recordedAfterApprovalResolved: resolved.count,
      },
      'Timesheet',
    );
    return finalizedRuns;
  }

  /**
   * Every FINALIZED payroll run holding a WORKED_TIME claim on this timesheet's assignments and
   * dates (not only the latest run) gets one PayrollRetroRequirement per assignment, for the
   * version it paid (from the run's PayrollTimeSnapshot rows). Reopening the same paid time
   * again adds nothing (unique per run, timesheet, assignment and paid version). Returns the
   * run ids.
   */
  private async recordPayrollRetroRequirements(
    tx: Prisma.TransactionClient,
    sheet: NonNullable<Awaited<ReturnType<TimeService['timesheetById']>>>,
    actorUserId: string,
    reason: string,
  ) {
    // Batch 4B (R4): the sheet's segments are its period's organization's only (scopedTimesheet),
    // so another organization's runs are never named.
    const assignmentIds = sheet.segments.map(
      (segment) => segment.employmentAssignmentId,
    );
    if (assignmentIds.length === 0) return [];
    const claims = await tx.payrollSourceClaim.findMany({
      where: {
        kind: 'WORKED_TIME',
        employmentAssignmentId: { in: assignmentIds },
        workDate: {
          gte: sheet.timePeriod.startDate,
          lte: sheet.timePeriod.endDate,
        },
        run: { status: 'FINALIZED' },
      },
      select: {
        payrollRunId: true,
        employmentAssignmentId: true,
        workDate: true,
      },
      orderBy: [{ payrollRunId: 'asc' }, { workDate: 'asc' }],
    });
    const groups = new Map<
      string,
      {
        payrollRunId: string;
        employmentAssignmentId: string;
        first: Date;
        last: Date;
      }
    >();
    for (const claim of claims) {
      const key = `${claim.payrollRunId}:${claim.employmentAssignmentId}`;
      const group = groups.get(key);
      if (!group) {
        groups.set(key, {
          payrollRunId: claim.payrollRunId,
          employmentAssignmentId: claim.employmentAssignmentId,
          first: claim.workDate,
          last: claim.workDate,
        });
      } else {
        if (claim.workDate < group.first) group.first = claim.workDate;
        if (claim.workDate > group.last) group.last = claim.workDate;
      }
    }
    const paidFromThisTimesheet: string[] = [];
    for (const group of groups.values()) {
      // The version the finalized run actually paid, from its own immutable time snapshots (not
      // the timesheet's current version, which a previous reopen may already have moved on).
      // Exactly one version of this timesheet for this assignment, or it is not recorded.
      const paid = await tx.payrollTimeSnapshot.findMany({
        where: {
          payrollRunId: group.payrollRunId,
          timesheetId: sheet.id,
          runAssignment: {
            employmentAssignmentId: group.employmentAssignmentId,
          },
        },
        select: { timesheetVersion: true },
        distinct: ['timesheetVersion'],
      });
      // Batch 4B (R4): a run that paid this assignment's dates from ANOTHER timesheet (its
      // snapshots name only that one) did not pay from this one. A run without any snapshot for
      // the assignment (before snapshots existed) is still recorded, with an unknown version.
      if (
        paid.length === 0 &&
        (await tx.payrollTimeSnapshot.count({
          where: {
            payrollRunId: group.payrollRunId,
            runAssignment: {
              employmentAssignmentId: group.employmentAssignmentId,
            },
          },
        })) > 0
      ) {
        continue;
      }
      paidFromThisTimesheet.push(group.payrollRunId);
      await tx.payrollRetroRequirement.createMany({
        data: [
          {
            payrollRunId: group.payrollRunId,
            timesheetId: sheet.id,
            employeeId: sheet.employeeId,
            employmentAssignmentId: group.employmentAssignmentId,
            timesheetVersion:
              paid.length === 1 ? paid[0]!.timesheetVersion : null,
            firstWorkDate: group.first,
            lastWorkDate: group.last,
            reason,
            createdByUserId: actorUserId,
          },
        ],
        skipDuplicates: true,
      });
    }
    return [...new Set(paidFromThisTimesheet)];
  }

  private async lockTimesheetRow(timesheetId: string, client: TimeClient) {
    await client.$queryRaw(
      Prisma.sql`SELECT "id" FROM "Timesheet" WHERE "id" = ${timesheetId}::uuid FOR UPDATE`,
    );
  }

  private assertExpectedVersion(
    sheet: { version: number },
    expectedVersion: number | undefined,
  ) {
    if (expectedVersion !== undefined && expectedVersion !== sheet.version) {
      throw new ConflictException(
        timeError(
          409,
          'TIMESHEET_VERSION_CONFLICT',
          'The timesheet changed since it was viewed. Reload it and try again.',
          { version: sheet.version },
        ),
      );
    }
  }

  /**
   * Submission and approval wait for the period to end: the day after its end date has begun in
   * the organization's timezone and in every assignment's (unknown everywhere: the latest
   * timezone on Earth). A policy may allow early submission (timesheet.allowEarlySubmission, on
   * every segment's assignment; off by default).
   */
  private async assertTimesheetPeriodEnded(
    sheet: NonNullable<Awaited<ReturnType<TimeService['timesheetById']>>>,
    now: Date,
    client: TimeClient,
  ) {
    const endDate = dateOnly(sheet.timePeriod.endDate) ?? '';
    const organization = await client.organization.findUnique({
      where: { id: sheet.timePeriod.organizationId },
      select: { timezone: true },
    });
    const timezones = new Set<string>();
    if (organization?.timezone && isIanaTimezone(organization.timezone)) {
      timezones.add(organization.timezone.trim());
    }
    for (const segment of sheet.segments) {
      const timezone = this.resolvedTimezone(segment.employmentAssignment);
      if (timezone) timezones.add(timezone);
    }
    if (timezones.size === 0) timezones.add('Etc/GMT+12');
    const ended = [...timezones].every(
      (timezone) => this.domain.deriveWorkDate(now, timezone) > endDate,
    );
    if (ended) return;
    if (await this.earlySubmissionAllowed(sheet, client)) return;
    throw new ConflictException(
      timeError(
        409,
        'TIMESHEET_PERIOD_NOT_ENDED',
        'The timesheet period has not ended yet.',
        { periodEndDate: endDate },
      ),
    );
  }

  private async earlySubmissionAllowed(
    sheet: NonNullable<Awaited<ReturnType<TimeService['timesheetById']>>>,
    client: TimeClient,
  ) {
    if (sheet.segments.length === 0) return false;
    for (const segment of sheet.segments) {
      const policy = await this.effectivePolicyForAssignmentOnWorkDate(
        segment.employmentAssignment,
        sheet.timePeriod.startDate,
        client,
      );
      if (policy.timesheet.allowEarlySubmission !== true) return false;
    }
    return true;
  }

  /**
   * Self clock-in. With published schedules integrated (Phase 7 Batch 9) the request may name
   * an assignment, a scheduled shift, both, or neither: exactly one eligible published shift is
   * linked (and preselects its assignment when none was given), several require an explicit
   * choice, and none applies the SchedulePolicy unscheduled-work mode. An explicit assignment is
   * never overridden.
   */
  async clockIn(
    userId: string,
    employmentAssignmentId: string | undefined,
    context: TimeRequestContext,
    scheduledShiftId?: string,
    additionalEmploymentAssignmentIds?: string[],
  ) {
    const employee = await this.requireSelfEmployee(userId);
    return this.clockInAs(
      selfServiceActor(userId),
      employee,
      employmentAssignmentId,
      context,
      scheduledShiftId,
      additionalEmploymentAssignmentIds,
    );
  }

  // ─── Phase 9.5: hooks for presence (SIGN_IN_ONLY) capture ─────────────────

  /** The signed-in user's employee (self-service capture). */
  /** Batch 4F (C10): the caller's own employee for reading their own history (no gate). */
  selfEmployeeForRead(userId: string) {
    return this.requireSelfEmployee(userId, this.prisma, { purpose: 'read' });
  }

  selfEmployee(userId: string) {
    return this.requireSelfEmployee(userId);
  }

  /** The employee identified at a kiosk (kiosk capture). */
  kioskEmployee(employeeId: string) {
    return this.requireKioskEmployee(employeeId);
  }

  /**
   * Everything a sign-in needs to be captured now by the actor, with the same gates as clocking:
   * an active device (share-locked) for kiosks, the employee and assignment effective on the
   * local date, capture enabled, SIGN_IN_ONLY tracking, a channel the capture mode allows, and
   * the kiosk location rule. Returns the assignment, its timezone and work date, and policy.
   */
  async signInEligibility(
    actor: ClockActor,
    employee: Awaited<ReturnType<TimeService['requireSelfEmployee']>>,
    employmentAssignmentId: string,
    at: Date,
    client: Prisma.TransactionClient,
  ) {
    await this.lockCaptureDevice(actor, client);
    if (employee.status !== 'ACTIVE') {
      throw new ForbiddenException(
        'Employee is not eligible to record attendance.',
      );
    }
    const assignment = await this.assignmentById(
      employmentAssignmentId,
      client,
    );
    if (!assignment) throw new NotFoundException('Assignment not found.');
    if (assignment.employeeId !== employee.id) {
      throw new ForbiddenException('Assignment does not belong to employee.');
    }
    await this.assertClockAccess(actor, assignment.positionId, client);
    const timezone = this.assignmentTimezone(assignment);
    const workDate = this.domain.parseDateOnly(
      this.domain.deriveWorkDate(at, timezone),
    );
    if (!this.employeeEffectiveOn(employee, workDate)) {
      throw new ForbiddenException(
        'Employee is not eligible to record attendance.',
      );
    }
    if (!this.assignmentEffectiveOn(assignment, workDate)) {
      throw new BadRequestException('Assignment is not active on that date.');
    }
    const policy = await this.effectivePolicyForAssignmentOnWorkDate(
      assignment,
      workDate,
      client,
    );
    if (!this.liveClockEnabled(policy)) {
      throw new ForbiddenException(
        domainError(
          403,
          'TIME_CAPTURE_DISABLED',
          'Attendance capture is not enabled for this assignment.',
        ),
      );
    }
    const refusal = this.captureRefusal(actor, assignment, policy, {
      tracking: 'SIGN_IN_ONLY',
    });
    if (refusal) throw refusal;
    return {
      assignment,
      timezone,
      workDate,
      lateArrivalEnabled: this.lateArrivalEnabled(policy),
      lateGraceMinutes: this.lateGraceMinutes(policy),
      duplicateWindowMinutes:
        attendanceModes(policy).signInDuplicateWindowMinutes,
      // Batch 4D (D-H): optional sign-out, off unless the policy enables it.
      signOutEnabled: policy.attendance.signOutEnabled === true,
    };
  }

  /**
   * Batch 4D (D-H) — the assignments the actor may sign out of now: sign-in-only assignments the
   * actor may capture on (the same channel rules as signing in, so KIOSK_ONLY still holds), whose
   * policy enables sign-out, with an ACTIVE sign-in of the last 24 hours not yet signed out.
   */
  async signOutAssignments(
    actor: ClockActor,
    employee: Awaited<ReturnType<TimeService['requireSelfEmployee']>>,
    now: Date,
    client: TimeClient = this.prisma,
  ) {
    const result = [];
    for (const shaped of await this.signInAssignments(
      actor,
      employee,
      now,
      client,
    )) {
      const assignment = await this.assignmentById(shaped.id, client);
      if (!assignment) continue;
      const policy = await this.effectivePolicyForAssignmentOnWorkDate(
        assignment,
        this.domain.parseDateOnly(
          this.domain.deriveWorkDate(now, this.assignmentTimezone(assignment)),
        ),
        client,
      );
      if (policy.attendance.signOutEnabled !== true) continue;
      // Batch 4F (D3): exactly the sign-in the sign-out action closes (the latest of the last
      // 24 hours), so the offer never leads to "already signed out" for an older open one.
      const latest = await client.attendanceSignIn.findFirst({
        where: {
          employmentAssignmentId: assignment.id,
          status: 'ACTIVE',
          signedInAt: { gt: new Date(now.getTime() - 86_400_000), lt: now },
        },
        select: {
          id: true,
          signOuts: { where: { status: 'ACTIVE' }, select: { id: true } },
        },
        orderBy: { signedInAt: 'desc' },
      });
      if (latest && latest.signOuts.length === 0) result.push(shaped);
    }
    return result;
  }

  /**
   * The employee's assignments the actor may record a sign-in for now (SIGN_IN_ONLY tracking,
   * capture allowed on the channel), for status views and the kiosk.
   */
  async signInAssignments(
    actor: ClockActor,
    employee: Awaited<ReturnType<TimeService['requireSelfEmployee']>>,
    now: Date,
    client: TimeClient = this.prisma,
  ) {
    if (employee.status !== 'ACTIVE') return [];
    const result = [];
    for (const assignment of await this.assignmentsForEmployee(
      employee.id,
      client,
    )) {
      const timezone = this.resolvedTimezone(assignment);
      if (!timezone) continue;
      const date = this.domain.parseDateOnly(
        this.domain.deriveWorkDate(now, timezone),
      );
      if (
        !this.employeeEffectiveOn(employee, date) ||
        !this.assignmentEffectiveOn(assignment, date) ||
        !(await this.canClockAssignment(actor, assignment.positionId, client))
      ) {
        continue;
      }
      const policy = await this.effectivePolicyForAssignmentOnWorkDate(
        assignment,
        date,
        client,
      );
      if (!this.liveClockEnabled(policy)) continue;
      if (
        this.captureRefusal(actor, assignment, policy, {
          tracking: 'SIGN_IN_ONLY',
        })
      )
        continue;
      result.push(this.assignmentShape(assignment));
    }
    return result;
  }

  /** Late-arrival settings in force for an assignment on a work date (presence signals). */
  async interpretationSettingsOn(
    employmentAssignmentId: string,
    workDate: Date,
    client: TimeClient = this.prisma,
  ) {
    const assignment = await this.assignmentById(
      employmentAssignmentId,
      client,
    );
    if (!assignment) throw new NotFoundException('Assignment not found.');
    const policy = await this.effectivePolicyForAssignmentOnWorkDate(
      assignment,
      workDate,
      client,
    );
    return {
      lateArrivalEnabled: this.lateArrivalEnabled(policy),
      lateGraceMinutes: this.lateGraceMinutes(policy),
    };
  }

  /** The tracking mode of an assignment on a work date (manager sign-in records and reports). */
  async trackingModeOn(
    employmentAssignmentId: string,
    workDate: Date,
    client: TimeClient = this.prisma,
  ): Promise<AttendanceTrackingMode | null> {
    const assignment = await this.assignmentById(
      employmentAssignmentId,
      client,
    );
    if (!assignment) return null;
    return attendanceModes(
      await this.effectivePolicyForAssignmentOnWorkDate(
        assignment,
        workDate,
        client,
      ),
    ).trackingMode;
  }

  /** The timezone attendance of the assignment is dated in (never a silent UTC). */
  async timezoneOf(
    employmentAssignmentId: string,
    client: TimeClient = this.prisma,
  ) {
    const assignment = await this.assignmentById(
      employmentAssignmentId,
      client,
    );
    if (!assignment) throw new NotFoundException('Assignment not found.');
    return { assignment, timezone: this.assignmentTimezone(assignment) };
  }

  /** time.correct (or another Time permission) on the assignment's position, for sign-in admin. */
  async canOnAssignment(
    userId: string,
    permission: 'time.view' | 'time.correct',
    positionId: string,
    client: TimeClient = this.prisma,
  ) {
    const scope = await this.targets.scopeForPosition(
      positionId,
      undefined,
      client,
    );
    const allowed = await this.authorization.canAccess(
      userId,
      permission,
      scope,
      client,
    );
    if (allowed) await this.requireAttendanceForPosition(positionId, client);
    return allowed;
  }

  /**
   * Phase 9.5 — what the employee identified at a kiosk may do there now (TIME_CLOCK capture),
   * with the same rules as every other channel. The kiosk shows only a minimal view of it.
   */
  async kioskStatus(device: KioskDevice, employeeId: string) {
    const employee = await this.requireKioskEmployee(employeeId);
    return this.statusForEmployee(
      { channel: 'KIOSK', device },
      employee,
      this.clock.now(),
      this.prisma,
    );
  }

  /**
   * Why an employee identified at a kiosk has nothing to record there. Read-only: it mirrors
   * the eligibility rules of statusForEmployee for the device's organization only and reports
   * the furthest point reached, so an administrator can fix the configuration (e.g. a policy
   * with `attendance.trackingMode: TIME_CLOCK` whose `clock.mode` is still DISABLED).
   */
  async kioskUnavailableReason(
    device: KioskDevice,
    employeeId: string,
  ): Promise<KioskUnavailableCode> {
    const client = this.prisma;
    const now = this.clock.now();
    const actor: ClockActor = { channel: 'KIOSK', device };
    const employee = await this.requireKioskEmployee(employeeId, client);
    const current = await this.openEntry(employee.id, client);
    if (current) {
      const policy = await this.effectivePolicyForAssignment(
        current.employmentAssignment,
        now,
        client,
      );
      return this.captureRefusal(actor, current.employmentAssignment, policy, {
        closingOnly: true,
      })
        ? 'OPEN_ENTRY_NOT_AT_KIOSK'
        : 'UNAVAILABLE';
    }
    if (employee.status !== 'ACTIVE') return 'EMPLOYEE_NOT_ACTIVE';
    const inOrganization = (
      await this.assignmentsForEmployee(employee.id, client)
    ).filter(
      (assignment) =>
        assignment.position.organizationId === device.organizationId,
    );
    if (inOrganization.length === 0) {
      const planned = await client.employmentAssignment.count({
        where: {
          employeeId: employee.id,
          status: 'PLANNED',
          position: { organizationId: device.organizationId },
        },
      });
      return planned > 0 ? 'ASSIGNMENT_NOT_STARTED' : 'NO_ASSIGNMENT';
    }
    // Each check passed moves the reason one step closer to "eligible".
    const STAGES: KioskUnavailableCode[] = [
      'TIMEZONE_MISSING',
      'ASSIGNMENT_NOT_EFFECTIVE',
      'ATTENDANCE_DISABLED',
      'CAPTURE_NOT_AT_KIOSK',
      'KIOSK_SITE_NOT_ALLOWED',
      'CLOCK_DISABLED',
      'UNAVAILABLE',
    ];
    let furthest = 0;
    for (const assignment of inOrganization) {
      furthest = Math.max(
        furthest,
        await this.kioskStage(device, employee, assignment, now),
      );
    }
    return STAGES[furthest]!;
  }

  /** How far one assignment gets through the kiosk clock-in checks (see above). */
  private async kioskStage(
    device: KioskDevice,
    employee: Awaited<ReturnType<TimeService['requireKioskEmployee']>>,
    assignment: Awaited<
      ReturnType<TimeService['assignmentsForEmployee']>
    >[number],
    now: Date,
  ): Promise<number> {
    const timezone = this.resolvedTimezone(assignment);
    if (!timezone) return 0;
    const date = this.domain.parseDateOnly(
      this.domain.deriveWorkDate(now, timezone),
    );
    if (
      !this.employeeEffectiveOn(employee, date) ||
      !this.assignmentEffectiveOn(assignment, date)
    ) {
      return 1;
    }
    if (!(await this.attendanceEnabledForPosition(assignment.positionId))) {
      return 2;
    }
    const policy = await this.effectivePolicyForAssignment(
      assignment,
      now,
      this.prisma,
    );
    const modes = attendanceModes(policy);
    if (!captureAllows(modes.captureMode, 'KIOSK')) return 3;
    if (
      modes.kioskLocationRule === 'ASSIGNMENT_WORK_LOCATION' &&
      assignment.position.workLocation?.physicalSiteId !== device.physicalSiteId
    ) {
      return 4;
    }
    if (modes.trackingMode === 'TIME_CLOCK' && !this.liveClockEnabled(policy)) {
      return 5;
    }
    return 6;
  }

  /** Clock-in at a trusted kiosk for the employee identified there (AttendanceKioskService). */
  async kioskClockIn(
    device: KioskDevice,
    employeeId: string,
    employmentAssignmentId: string | undefined,
    context: TimeRequestContext,
    additionalEmploymentAssignmentIds?: string[],
    scheduledShiftId?: string,
  ) {
    const employee = await this.requireKioskEmployee(employeeId);
    return this.clockInAs(
      { channel: 'KIOSK', device },
      employee,
      employmentAssignmentId,
      kioskContext(context, device),
      scheduledShiftId,
      additionalEmploymentAssignmentIds,
    );
  }

  private async clockInAs(
    actor: ClockActor,
    employee: Awaited<ReturnType<TimeService['requireSelfEmployee']>>,
    employmentAssignmentId: string | undefined,
    context: TimeRequestContext,
    scheduledShiftId?: string,
    additionalEmploymentAssignmentIds?: string[],
  ) {
    const now = this.clock.now();
    // Several assignments covered by one physical interval: the named assignment is the payroll
    // owner (the TimeEntry's assignment); the others are coverage only and never add time.
    if (
      (additionalEmploymentAssignmentIds?.length ?? 0) > 0 &&
      employmentAssignmentId === undefined
    ) {
      throw new BadRequestException(
        'employmentAssignmentId (the payroll assignment) is required when covering several assignments.',
      );
    }
    const additionalIds = employmentAssignmentId
      ? additionalCoverage(
          employmentAssignmentId,
          additionalEmploymentAssignmentIds,
        )
      : [];
    const repeatsCurrent = (current: {
      employmentAssignmentId: string;
      scheduledShiftId: string | null;
      assignmentCoverages: Array<{
        employmentAssignmentId: string;
        removedAt: Date | null;
      }>;
    }) =>
      (employmentAssignmentId === undefined ||
        (current.employmentAssignmentId === employmentAssignmentId &&
          sameAssignmentSet(secondaryCoverageIds(current), additionalIds))) &&
      (scheduledShiftId === undefined ||
        current.scheduledShiftId === scheduledShiftId);
    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.lockCaptureDevice(actor, tx);
        await this.lockEmployeeTime(employee.id, tx);
        const current = await this.openEntry(employee.id, tx);
        if (current) {
          if (
            repeatsCurrent({
              ...current,
              assignmentCoverages: await this.entryCoverage(current.id, tx),
            })
          ) {
            return this.statusForEmployee(actor, employee, now, tx);
          }
          throw new ConflictException(
            'Employee is already clocked in. Use switch assignment to change assignments.',
          );
        }
        if (employmentAssignmentId === undefined) {
          await this.assertSomeAssignmentCapturable(actor, employee, now, tx);
        }
        const selection = await this.selectScheduledWork(
          actor,
          employee,
          { employmentAssignmentId, scheduledShiftId },
          now,
          tx,
        );
        const assignment = selection.assignment;
        // Every covered assignment passes exactly the owner's capture gate (employee, channel
        // access, effective dates, TIME_CLOCK tracking, capture mode, kiosk physical site).
        const additional = [];
        for (const id of additionalIds) {
          const covered = await this.requireEligibleAssignment(
            actor,
            employee,
            id,
            now,
            tx,
          );
          this.assertSameCoverageOrganization(assignment, covered);
          additional.push(covered);
        }
        const timezone = this.assignmentTimezone(assignment);
        const workDate = await this.liveEntryWorkDate(
          selection.link,
          now,
          timezone,
          tx,
        );
        const entry = await tx.timeEntry.create({
          data: {
            employeeId: employee.id,
            employmentAssignmentId: assignment.id,
            clockInAt: now,
            timezone,
            workDate: this.domain.parseDateOnly(workDate),
            status: 'OPEN',
            source: this.liveSource(actor),
            scheduledShiftId: selection.link?.scheduledShiftId ?? null,
            scheduledShiftRevisionId: selection.link?.revisionId ?? null,
          },
        });
        await this.addCoverage(tx, entry, [
          assignment.id,
          ...additional.map((covered) => covered.id),
        ]);
        await tx.timePunch.create({
          data: {
            employeeId: employee.id,
            employmentAssignmentId: assignment.id,
            timeEntryId: entry.id,
            type: 'CLOCK_IN',
            occurredAt: now,
            timezone,
            source: this.liveSource(actor),
            attendanceDeviceId: this.captureDeviceId(actor),
          },
        });
        await this.writeAudit(tx, 'TIME_CLOCKED_IN', entry.id, context, {
          employeeId: employee.id,
          employmentAssignmentId: assignment.id,
          coveredEmploymentAssignmentIds: [
            assignment.id,
            ...additional.map((covered) => covered.id),
          ],
          occurredAt: now,
          ...this.scheduleSelectionAudit(selection),
        });
        const warnings = await this.flagUnscheduledWork(
          tx,
          entry,
          selection,
          context,
        );
        await this.recalculateAttendanceInterpretation(entry.id, tx, context);
        const status = await this.statusForEmployee(actor, employee, now, tx);
        return warnings.length > 0 ? { ...status, warnings } : status;
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        const current = await this.openEntry(employee.id, this.prisma);
        if (
          current &&
          repeatsCurrent({
            ...current,
            assignmentCoverages: await this.entryCoverage(
              current.id,
              this.prisma,
            ),
          })
        ) {
          return this.statusForEmployee(actor, employee, now, this.prisma);
        }
        throw new ConflictException(
          'Employee is already clocked in. Use switch assignment to change assignments.',
        );
      }
      throw error;
    }
  }

  async clockOut(userId: string, context: TimeRequestContext) {
    const employee = await this.requireSelfEmployee(userId);
    return this.clockOutAs(selfServiceActor(userId), employee, context);
  }

  async kioskClockOut(
    device: KioskDevice,
    employeeId: string,
    context: TimeRequestContext,
  ) {
    const employee = await this.requireKioskEmployee(employeeId);
    return this.clockOutAs(
      { channel: 'KIOSK', device },
      employee,
      kioskContext(context, device),
    );
  }

  private async clockOutAs(
    actor: ClockActor,
    employee: Awaited<ReturnType<TimeService['requireSelfEmployee']>>,
    context: TimeRequestContext,
  ) {
    const now = this.clock.now();
    return this.prisma.$transaction(async (tx) => {
      await this.lockCaptureDevice(actor, tx);
      await this.lockEmployeeTime(employee.id, tx);
      const current = await this.openEntry(employee.id, tx);
      if (!current) {
        return this.statusForEmployee(actor, employee, now, tx);
      }
      // Closing open work is allowed whatever the tracking mode, on an allowed channel only.
      await this.assertCaptureOnEntry(
        actor,
        current.employmentAssignment,
        now,
        tx,
        { closingOnly: true },
      );
      const openBreak = await this.openBreakForEntry(current.id, tx);
      if (openBreak) {
        await this.closeBreak(tx, employee.id, current, openBreak, now, {
          source: this.liveSource(actor),
          attendanceDeviceId: this.captureDeviceId(actor),
        });
        const policy = await this.effectivePolicyForAssignment(
          current.employmentAssignment,
          now,
          tx,
        );
        if (this.openBreakAutoCloseExceptionEnabled(policy)) {
          await this.createResolvedException(
            tx,
            {
              employeeId: employee.id,
              employmentAssignmentId: current.employmentAssignmentId,
              timeEntryId: current.id,
              type: 'OPEN_BREAK_AUTO_CLOSED',
              detectedAt: now,
              resolvedAt: now,
              reason: 'Open break was automatically closed during clock-out.',
              metadata: {
                breakEntryId: openBreak.id,
                closedAt: now.toISOString(),
                source: 'LIVE_CLOCK_OUT',
              },
            },
            context,
          );
        }
      }
      await tx.timePunch.create({
        data: {
          employeeId: employee.id,
          employmentAssignmentId: current.employmentAssignmentId,
          timeEntryId: current.id,
          type: 'CLOCK_OUT',
          occurredAt: now,
          timezone: current.timezone,
          source: this.liveSource(actor),
          attendanceDeviceId: this.captureDeviceId(actor),
        },
      });
      await this.closeOpenEntry(tx, current.id, now);
      await this.writeAudit(
        tx,
        openBreak ? 'TIME_CLOCKED_OUT_ON_BREAK' : 'TIME_CLOCKED_OUT',
        current.id,
        context,
        {
          employeeId: employee.id,
          employmentAssignmentId: current.employmentAssignmentId,
          breakEntryId: openBreak?.id ?? null,
          occurredAt: now,
        },
      );
      await this.recalculateAttendanceInterpretation(current.id, tx, context);
      await this.flagTimeRecordedAfterApproval(tx, current.id, now, context);
      return this.statusForEmployee(actor, employee, now, tx);
    });
  }

  async startBreak(userId: string, context: TimeRequestContext) {
    const employee = await this.requireSelfEmployee(userId);
    return this.startBreakAs(selfServiceActor(userId), employee, context);
  }

  async kioskStartBreak(
    device: KioskDevice,
    employeeId: string,
    context: TimeRequestContext,
  ) {
    const employee = await this.requireKioskEmployee(employeeId);
    return this.startBreakAs(
      { channel: 'KIOSK', device },
      employee,
      kioskContext(context, device),
    );
  }

  private async startBreakAs(
    actor: ClockActor,
    employee: Awaited<ReturnType<TimeService['requireSelfEmployee']>>,
    context: TimeRequestContext,
  ) {
    const now = this.clock.now();
    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.lockCaptureDevice(actor, tx);
        await this.lockEmployeeTime(employee.id, tx);
        const current = await this.openEntry(employee.id, tx);
        if (!current)
          throw new BadRequestException('Employee is not clocked in.');
        if (await this.openBreakForEntry(current.id, tx)) {
          return this.statusForEmployee(actor, employee, now, tx);
        }
        await this.assertCaptureOnEntry(
          actor,
          current.employmentAssignment,
          now,
          tx,
          { closingOnly: false },
        );
        const policy = await this.effectivePolicyForAssignment(
          current.employmentAssignment,
          now,
          tx,
        );
        if (!this.manualBreakEnabled(policy)) {
          throw new ForbiddenException(
            domainError(
              403,
              'TIME_BREAKS_NOT_MANUAL',
              'Manual break punching is not enabled for this assignment.',
            ),
          );
        }
        const breakEntry = await tx.breakEntry.create({
          data: {
            timeEntryId: current.id,
            startAt: now,
            payType: this.breakPayType(policy),
          },
        });
        await tx.timePunch.create({
          data: {
            employeeId: employee.id,
            employmentAssignmentId: current.employmentAssignmentId,
            timeEntryId: current.id,
            type: 'BREAK_START',
            occurredAt: now,
            timezone: current.timezone,
            source: this.liveSource(actor),
            attendanceDeviceId: this.captureDeviceId(actor),
          },
        });
        await this.writeAudit(
          tx,
          'TIME_BREAK_STARTED',
          breakEntry.id,
          context,
          {
            employeeId: employee.id,
            timeEntryId: current.id,
            employmentAssignmentId: current.employmentAssignmentId,
            payType: breakEntry.payType,
            occurredAt: now,
          },
        );
        return this.statusForEmployee(actor, employee, now, tx);
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        return this.statusForEmployee(actor, employee, now, this.prisma);
      }
      throw error;
    }
  }

  async endBreak(userId: string, context: TimeRequestContext) {
    const employee = await this.requireSelfEmployee(userId);
    return this.endBreakAs(selfServiceActor(userId), employee, context);
  }

  async kioskEndBreak(
    device: KioskDevice,
    employeeId: string,
    context: TimeRequestContext,
  ) {
    const employee = await this.requireKioskEmployee(employeeId);
    return this.endBreakAs(
      { channel: 'KIOSK', device },
      employee,
      kioskContext(context, device),
    );
  }

  private async endBreakAs(
    actor: ClockActor,
    employee: Awaited<ReturnType<TimeService['requireSelfEmployee']>>,
    context: TimeRequestContext,
  ) {
    const now = this.clock.now();
    return this.prisma.$transaction(async (tx) => {
      await this.lockCaptureDevice(actor, tx);
      await this.lockEmployeeTime(employee.id, tx);
      const current = await this.openEntry(employee.id, tx);
      if (!current)
        throw new BadRequestException('Employee is not clocked in.');
      const openBreak = await this.openBreakForEntry(current.id, tx);
      if (!openBreak) {
        return this.statusForEmployee(actor, employee, now, tx);
      }
      await this.assertCaptureOnEntry(
        actor,
        current.employmentAssignment,
        now,
        tx,
        { closingOnly: true },
      );
      await this.closeBreak(tx, employee.id, current, openBreak, now, {
        source: this.liveSource(actor),
        attendanceDeviceId: this.captureDeviceId(actor),
      });
      await this.writeAudit(tx, 'TIME_BREAK_ENDED', openBreak.id, context, {
        employeeId: employee.id,
        timeEntryId: current.id,
        employmentAssignmentId: current.employmentAssignmentId,
        occurredAt: now,
      });
      return this.statusForEmployee(actor, employee, now, tx);
    });
  }

  async resolveMissedClockOut(
    userId: string,
    exceptionId: string,
    clockOutAtLocal: string,
    context: TimeRequestContext,
  ) {
    const now = this.clock.now();
    const employee = await this.requireSelfEmployee(userId);
    return this.prisma.$transaction(async (tx) => {
      // Serialized with live capture and the open-entry scan: the entry is read after the lock.
      await this.lockEmployeeTime(employee.id, tx);
      const exception = await tx.attendanceException.findUnique({
        where: { id: exceptionId },
        include: {
          timeEntry: {
            include: {
              employmentAssignment: {
                include: {
                  position: {
                    include: {
                      jobTitle: true,
                      organization: true,
                      organizationalUnit: true,
                      department: true,
                      team: true,
                      workLocation: true,
                    },
                  },
                },
              },
            },
          },
        },
      });
      if (!exception || exception.employeeId !== employee.id) {
        throw new NotFoundException('Attendance exception not found.');
      }
      if (exception.type !== 'MISSING_CLOCK_OUT') {
        throw new BadRequestException(
          'Only missed clock-out exceptions can be self-resolved.',
        );
      }
      if (exception.status !== 'OPEN') {
        throw new ConflictException('Attendance exception is already closed.');
      }
      const entry = exception.timeEntry;
      if (!entry || entry.status !== 'OPEN') {
        throw new ConflictException(
          'Missed clock-out exception no longer has an open TimeEntry.',
        );
      }
      await this.assertClockAccess(
        userId,
        entry.employmentAssignment.positionId,
        tx,
      );
      const policy = await this.effectivePolicyForAssignment(
        entry.employmentAssignment,
        now,
        tx,
      );
      if (!this.employeeMissedPunchResolutionEnabled(policy)) {
        throw new ForbiddenException(
          domainError(
            403,
            'TIME_MISSED_PUNCH_SELF_RESOLUTION_DISABLED',
            'Employee missed punch resolution is not enabled for this assignment.',
          ),
        );
      }
      // Closing remotely is self-service capture: kiosk-only work is resolved by a manager.
      const refusal = this.captureRefusal(
        { channel: 'SELF_SERVICE', userId },
        entry.employmentAssignment,
        policy,
        { closingOnly: true },
      );
      if (refusal) throw refusal;
      const clockOutAt = this.domain.parseLocalDateTime(
        clockOutAtLocal,
        entry.timezone,
      );
      if (clockOutAt.getTime() <= entry.clockInAt.getTime()) {
        throw new BadRequestException(
          'clockOutAt must be after the clock-in time.',
        );
      }
      // Batch 4A: never a clock-out later than now, longer than the policy allows, or before
      // anything already recorded on the entry (a break start, a later punch).
      this.assertNotInFuture(clockOutAt, now, 'clockOutAt');
      this.assertEntryDuration(entry.clockInAt, clockOutAt, policy);
      await this.assertAfterRecordedActivity(entry.id, clockOutAt, tx);
      await this.assertNoTimeEntryOverlap(
        employee.id,
        entry.clockInAt,
        clockOutAt,
        entry.id,
        tx,
      );
      const openBreak = await this.openBreakForEntry(entry.id, tx);
      if (openBreak) {
        await this.closeBreak(tx, employee.id, entry, openBreak, clockOutAt, {
          source: 'SYSTEM',
        });
        await this.createResolvedException(
          tx,
          {
            employeeId: employee.id,
            employmentAssignmentId: entry.employmentAssignmentId,
            timeEntryId: entry.id,
            type: 'OPEN_BREAK_AUTO_CLOSED',
            detectedAt: now,
            resolvedAt: now,
            reason:
              'Open break was automatically closed during employee missed clock-out resolution.',
            metadata: {
              breakEntryId: openBreak.id,
              closedAt: clockOutAt.toISOString(),
              source: 'EMPLOYEE_RESOLUTION',
            },
          },
          context,
        );
      }
      await tx.timePunch.create({
        data: {
          employeeId: employee.id,
          employmentAssignmentId: entry.employmentAssignmentId,
          timeEntryId: entry.id,
          type: 'CLOCK_OUT',
          occurredAt: clockOutAt,
          timezone: entry.timezone,
          source: 'SYSTEM',
          metadata: {
            source: 'EMPLOYEE_RESOLUTION',
            attendanceExceptionId: exception.id,
          },
        },
      });
      await this.closeOpenEntry(tx, entry.id, clockOutAt);
      await this.recalculateAttendanceInterpretation(entry.id, tx, context);
      await this.flagTimeRecordedAfterApproval(tx, entry.id, now, context);
      await tx.attendanceException.update({
        where: { id: exception.id },
        data: {
          status: 'RESOLVED',
          resolutionMethod: 'EMPLOYEE_RESOLUTION',
          resolvedAt: now,
          metadata: this.mergeExceptionMetadata(exception.metadata, {
            resolvedClockOutAt: clockOutAt.toISOString(),
          }),
        },
      });
      await this.writeAudit(
        tx,
        'TIME_EXCEPTION_EMPLOYEE_RESOLVED',
        exception.id,
        context,
        {
          employeeId: employee.id,
          timeEntryId: entry.id,
          employmentAssignmentId: entry.employmentAssignmentId,
          type: exception.type,
          clockOutAt,
        },
        'AttendanceException',
      );
      return this.statusForEmployee(userId, employee, now, tx);
    });
  }

  async switchAssignment(
    userId: string,
    targetEmploymentAssignmentId: string,
    context: TimeRequestContext,
    scheduledShiftId?: string,
  ) {
    const employee = await this.requireSelfEmployee(userId);
    return this.switchAssignmentAs(
      selfServiceActor(userId),
      employee,
      targetEmploymentAssignmentId,
      context,
      scheduledShiftId,
    );
  }

  async kioskSwitchAssignment(
    device: KioskDevice,
    employeeId: string,
    targetEmploymentAssignmentId: string,
    context: TimeRequestContext,
    scheduledShiftId?: string,
  ) {
    const employee = await this.requireKioskEmployee(employeeId);
    return this.switchAssignmentAs(
      { channel: 'KIOSK', device },
      employee,
      targetEmploymentAssignmentId,
      kioskContext(context, device),
      scheduledShiftId,
    );
  }

  private async switchAssignmentAs(
    actor: ClockActor,
    employee: Awaited<ReturnType<TimeService['requireSelfEmployee']>>,
    targetEmploymentAssignmentId: string,
    context: TimeRequestContext,
    scheduledShiftId?: string,
  ) {
    const now = this.clock.now();
    try {
      return await this.prisma.$transaction(async (tx) => {
        await this.lockCaptureDevice(actor, tx);
        await this.lockEmployeeTime(employee.id, tx);
        const current = await this.openEntry(employee.id, tx);
        if (!current) {
          throw new BadRequestException('Employee is not clocked in.');
        }
        await this.assertCaptureOnEntry(
          actor,
          current.employmentAssignment,
          now,
          tx,
          { closingOnly: true },
        );
        if (await this.openBreakForEntry(current.id, tx)) {
          throw new BadRequestException(
            'End the current break before switching assignments.',
          );
        }
        if (current.employmentAssignmentId === targetEmploymentAssignmentId) {
          return this.statusForEmployee(actor, employee, now, tx);
        }
        const target = await this.requireEligibleAssignment(
          actor,
          employee,
          targetEmploymentAssignmentId,
          now,
          tx,
        );
        const targetPolicy = await this.effectivePolicyForAssignment(
          target,
          now,
          tx,
        );
        if (!this.assignmentSwitchingEnabled(targetPolicy)) {
          throw new ForbiddenException(
            domainError(
              403,
              'TIME_ASSIGNMENT_SWITCHING_DISABLED',
              'Assignment switching is not enabled for this assignment.',
            ),
          );
        }
        const selection = await this.selectScheduledWork(
          actor,
          employee,
          { scheduledShiftId },
          now,
          tx,
          target,
        );
        await tx.timePunch.create({
          data: {
            employeeId: employee.id,
            employmentAssignmentId: current.employmentAssignmentId,
            timeEntryId: current.id,
            type: 'CLOCK_OUT',
            occurredAt: now,
            timezone: current.timezone,
            source: this.liveSource(actor),
            attendanceDeviceId: this.captureDeviceId(actor),
          },
        });
        await this.closeOpenEntry(tx, current.id, now);
        await this.flagTimeRecordedAfterApproval(tx, current.id, now, context);
        const targetTimezone = this.assignmentTimezone(target);
        const targetWorkDate = await this.liveEntryWorkDate(
          selection.link,
          now,
          targetTimezone,
          tx,
        );
        const next = await tx.timeEntry.create({
          data: {
            employeeId: employee.id,
            employmentAssignmentId: target.id,
            clockInAt: now,
            timezone: targetTimezone,
            workDate: this.domain.parseDateOnly(targetWorkDate),
            status: 'OPEN',
            source: this.liveSource(actor),
            scheduledShiftId: selection.link?.scheduledShiftId ?? null,
            scheduledShiftRevisionId: selection.link?.revisionId ?? null,
          },
        });
        // Switching is a new physical interval covering the target alone.
        await this.addCoverage(tx, next, [target.id]);
        await tx.timePunch.create({
          data: {
            employeeId: employee.id,
            employmentAssignmentId: target.id,
            timeEntryId: next.id,
            type: 'CLOCK_IN',
            occurredAt: now,
            timezone: targetTimezone,
            source: this.liveSource(actor),
            attendanceDeviceId: this.captureDeviceId(actor),
          },
        });
        await this.writeAudit(
          tx,
          'TIME_ASSIGNMENT_SWITCHED',
          next.id,
          context,
          {
            employeeId: employee.id,
            fromEmploymentAssignmentId: current.employmentAssignmentId,
            toEmploymentAssignmentId: target.id,
            occurredAt: now,
            ...this.scheduleSelectionAudit(selection),
          },
        );
        const warnings = await this.flagUnscheduledWork(
          tx,
          next,
          selection,
          context,
        );
        if (selection.link) {
          await this.recalculateAttendanceInterpretation(next.id, tx, context);
        }
        const status = await this.statusForEmployee(actor, employee, now, tx);
        return warnings.length > 0 ? { ...status, warnings } : status;
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        const current = await this.openEntry(employee.id, this.prisma);
        if (current?.employmentAssignmentId === targetEmploymentAssignmentId) {
          return this.statusForEmployee(actor, employee, now, this.prisma);
        }
        throw new ConflictException('Unable to switch assignments safely.');
      }
      throw error;
    }
  }

  /**
   * Chooses the assignment and published shift a live clock event belongs to. Without schedule
   * integration this is the Phase 6 rule: the named assignment, unlinked.
   */
  private async selectScheduledWork(
    actorOrUserId: ClockActor | string,
    employee: Awaited<ReturnType<TimeService['requireSelfEmployee']>>,
    requested: { employmentAssignmentId?: string; scheduledShiftId?: string },
    now: Date,
    tx: Prisma.TransactionClient,
    resolvedAssignment?: NonNullable<
      Awaited<ReturnType<TimeService['assignmentById']>>
    >,
  ): Promise<ScheduledWorkSelection> {
    const actor = asActor(actorOrUserId);
    if (!this.schedules) {
      if (requested.scheduledShiftId) {
        throw new BadRequestException(
          'Scheduled shift selection is not available.',
        );
      }
      if (!resolvedAssignment && !requested.employmentAssignmentId) {
        throw new BadRequestException('employmentAssignmentId is required.');
      }
      return {
        assignment:
          resolvedAssignment ??
          (await this.requireEligibleAssignment(
            actor,
            employee,
            requested.employmentAssignmentId!,
            now,
            tx,
          )),
        link: null,
        unscheduledWorkMode: null,
        method: 'ASSIGNMENT',
      };
    }
    const explicit =
      resolvedAssignment ??
      (requested.employmentAssignmentId
        ? await this.requireEligibleAssignment(
            actor,
            employee,
            requested.employmentAssignmentId,
            now,
            tx,
          )
        : null);
    const pool = explicit
      ? [explicit]
      : await this.clockInAssignments(actor, employee, now, tx);
    const candidates = await this.schedules.clockInCandidates(
      {
        employeeId: employee.id,
        employmentAssignmentIds: pool.map((assignment) => assignment.id),
        at: now,
      },
      tx,
    );

    let chosen: ClockInShiftCandidate | undefined;
    let method: ScheduledWorkSelection['method'] = 'ASSIGNMENT';
    if (requested.scheduledShiftId) {
      chosen = candidates.find(
        (candidate) =>
          candidate.scheduledShiftId === requested.scheduledShiftId,
      );
      if (!chosen) {
        throw new BadRequestException({
          statusCode: 400,
          error: 'Bad Request',
          code: 'SCHEDULED_SHIFT_NOT_ELIGIBLE',
          message:
            'The scheduled shift is not open for clock-in for this employee and assignment.',
        });
      }
      method = 'EXPLICIT_SHIFT';
    } else if (candidates.length > 1) {
      // Never guess between overlapping eligibility windows.
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        code: 'SCHEDULED_SHIFT_SELECTION_REQUIRED',
        message:
          'Several scheduled shifts are open for clock-in; choose one explicitly.',
        options: candidates.map((candidate) =>
          this.shiftOptionShape(candidate),
        ),
      });
    } else if (candidates.length === 1) {
      chosen = candidates[0];
      method = explicit ? 'MATCHED_SHIFT' : 'PRESELECTED_SHIFT';
    }
    if (chosen) {
      const assignment = pool.find(
        (candidate) => candidate.id === chosen.employmentAssignmentId,
      );
      if (!assignment) {
        throw new ConflictException(
          'Unable to resolve the scheduled assignment.',
        );
      }
      return {
        assignment,
        link: await this.lockScheduledShiftLink(chosen, employee.id, now, tx),
        unscheduledWorkMode: null,
        method,
      };
    }

    let assignment = explicit;
    if (!assignment) {
      if (pool.length === 0) {
        throw new ForbiddenException('No assignment is eligible for clocking.');
      }
      if (pool.length > 1) {
        throw new BadRequestException({
          statusCode: 400,
          error: 'Bad Request',
          code: 'ASSIGNMENT_SELECTION_REQUIRED',
          message:
            'No scheduled shift is open for clock-in; choose an assignment.',
          eligibleAssignmentIds: pool.map((candidate) => candidate.id),
        });
      }
      assignment = pool[0];
    }
    const mode = await this.unscheduledWorkModeFor(assignment, now, tx);
    if (mode === 'REQUIRE_SCHEDULED_SHIFT') {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        code: 'SCHEDULED_SHIFT_REQUIRED',
        message:
          'A published scheduled shift is required to clock in for this assignment. A manager can record the attendance through a time correction.',
      });
    }
    return {
      assignment,
      link: null,
      unscheduledWorkMode: mode,
      method: explicit ? 'ASSIGNMENT' : 'PRESELECTED_ASSIGNMENT',
    };
  }

  /**
   * Share-locks the chosen shift and re-reads its eligibility, so the link always names the
   * latest published revision: a correction committed first is seen here, and one waiting on
   * the lock sees this entry afterwards and raises a review signal.
   */
  private async lockScheduledShiftLink(
    chosen: ClockInShiftCandidate,
    employeeId: string,
    now: Date,
    tx: Prisma.TransactionClient,
  ): Promise<ScheduledShiftLink> {
    const locked = await this.schedules!.lockPublishedShift(
      chosen.scheduledShiftId,
      tx,
    );
    const fresh =
      locked &&
      locked.shift.status === 'ACTIVE' &&
      locked.revision.status === 'ACTIVE'
        ? (
            await this.schedules!.clockInCandidates(
              {
                employeeId,
                employmentAssignmentIds: [chosen.employmentAssignmentId],
                at: now,
              },
              tx,
            )
          ).find(
            (candidate) =>
              candidate.scheduledShiftId === chosen.scheduledShiftId,
          )
        : undefined;
    if (!fresh) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        code: 'SCHEDULED_SHIFT_CHANGED',
        message:
          'The scheduled shift changed while clocking in; review the schedule and try again.',
      });
    }
    return {
      scheduledShiftId: fresh.scheduledShiftId,
      revisionId: fresh.revisionId,
      revisionNumber: fresh.revisionNumber,
    };
  }

  private async unscheduledWorkModeFor(
    assignment: NonNullable<Awaited<ReturnType<TimeService['assignmentById']>>>,
    now: Date,
    client: TimeClient,
  ): Promise<UnscheduledWorkMode | null> {
    if (!this.schedules) return null;
    const localDate = this.domain.parseDateOnly(
      this.domain.deriveWorkDate(now, this.assignmentTimezone(assignment)),
    );
    return this.schedules.unscheduledWorkMode(assignment.id, localDate, client);
  }

  private scheduleSelectionAudit(selection: ScheduledWorkSelection) {
    if (!this.schedules) return {};
    return {
      scheduleSelection: selection.method,
      scheduledShiftId: selection.link?.scheduledShiftId ?? null,
      scheduledShiftRevisionId: selection.link?.revisionId ?? null,
      scheduledShiftRevisionNumber: selection.link?.revisionNumber ?? null,
      unscheduledWorkMode: selection.unscheduledWorkMode,
    };
  }

  /** WARN_UNSCHEDULED: the entry stands and carries a non-blocking review signal. */
  private async flagUnscheduledWork(
    tx: Prisma.TransactionClient,
    entry: {
      id: string;
      employeeId: string;
      employmentAssignmentId: string;
      clockInAt: Date;
      timezone: string;
      workDate: Date;
    },
    selection: ScheduledWorkSelection,
    context: TimeRequestContext,
  ) {
    if (
      selection.link ||
      selection.unscheduledWorkMode !== 'WARN_UNSCHEDULED'
    ) {
      return [];
    }
    const exception = await tx.attendanceException.create({
      data: {
        employeeId: entry.employeeId,
        employmentAssignmentId: entry.employmentAssignmentId,
        timeEntryId: entry.id,
        type: 'UNSCHEDULED_WORK',
        severity: 'REVIEW',
        workflowImpact: 'NON_BLOCKING',
        status: 'OPEN',
        detectedAt: this.clock.now(),
        reason: 'Clock-in did not match a published scheduled shift.',
        metadata: jsonMetadata({
          unscheduledWorkMode: selection.unscheduledWorkMode,
          clockInAt: entry.clockInAt.toISOString(),
          timezone: entry.timezone,
          workDate: dateOnly(entry.workDate),
        }),
      },
    });
    await this.writeAudit(
      tx,
      'TIME_UNSCHEDULED_WORK_FLAGGED',
      exception.id,
      context,
      {
        employeeId: entry.employeeId,
        timeEntryId: entry.id,
        employmentAssignmentId: entry.employmentAssignmentId,
      },
      'AttendanceException',
    );
    return [
      {
        code: 'UNSCHEDULED_WORK',
        message:
          'No published scheduled shift matched this clock-in; it was recorded and flagged for review.',
        attendanceExceptionId: exception.id,
      },
    ];
  }

  private shiftOptionShape(candidate: ClockInShiftCandidate) {
    return {
      scheduledShiftId: candidate.scheduledShiftId,
      scheduleId: candidate.scheduleId,
      employmentAssignmentId: candidate.employmentAssignmentId,
      workLocationId: candidate.workLocationId,
      workDate: dateOnly(candidate.workDate),
      startsAt: candidate.startsAt.toISOString(),
      endsAt: candidate.endsAt.toISOString(),
      timezone: candidate.timezone,
      scheduledShiftRevisionId: candidate.revisionId,
      revisionNumber: candidate.revisionNumber,
      clockInOpensAt: candidate.eligibleFrom.toISOString(),
      clockInClosesAt: candidate.eligibleUntil.toISOString(),
    };
  }

  private async scanOpenTimeEntry(
    entry: NonNullable<Awaited<ReturnType<TimeService['openEntry']>>>,
    now: Date,
    context: TimeRequestContext,
  ) {
    return this.prisma.$transaction(async (tx) => {
      // Serialized with the employee's live clock-out (Batch 4A): whichever runs second sees the
      // other's result, so an auto-close never overwrites a real clock-out.
      await this.lockEmployeeTime(entry.employeeId, tx);
      const current = await tx.timeEntry.findFirst({
        where: { id: entry.id, status: 'OPEN', archivedAt: null },
        include: {
          employmentAssignment: {
            include: {
              position: {
                include: {
                  jobTitle: true,
                  organization: true,
                  organizationalUnit: true,
                  department: true,
                  team: true,
                  workLocation: true,
                },
              },
            },
          },
        },
      });
      if (!current) {
        return { detected: false, autoResolved: false, escalated: false };
      }
      const policy = await this.effectivePolicyForAssignment(
        current.employmentAssignment,
        now,
        tx,
      );
      if (!this.missedPunchDetectionEnabled(policy)) {
        return { detected: false, autoResolved: false, escalated: false };
      }
      const thresholdMinutes =
        this.missedPunchDetectionThresholdMinutes(policy);
      if (
        thresholdMinutes === null ||
        now.getTime() - current.clockInAt.getTime() < thresholdMinutes * 60_000
      ) {
        return { detected: false, autoResolved: false, escalated: false };
      }
      const existing = await tx.attendanceException.findFirst({
        where: {
          timeEntryId: current.id,
          status: 'OPEN',
          type: 'MISSING_CLOCK_OUT',
        },
      });
      if (existing) {
        return { detected: false, autoResolved: false, escalated: false };
      }
      const expectedEnd = await this.trustedExpectedEnd(current, policy, tx);
      if (
        expectedEnd &&
        this.autoCloseFromExpectedEndEnabled(policy) &&
        expectedEnd.getTime() > current.clockInAt.getTime() &&
        expectedEnd.getTime() <= now.getTime()
      ) {
        await this.autoCloseMissedClockOut(
          tx,
          current,
          expectedEnd,
          now,
          context,
        );
        return { detected: true, autoResolved: true, escalated: false };
      }
      const employeeResolution =
        this.employeeMissedPunchResolutionEnabled(policy);
      const exception = await tx.attendanceException.create({
        data: {
          employeeId: current.employeeId,
          employmentAssignmentId: current.employmentAssignmentId,
          timeEntryId: current.id,
          type: 'MISSING_CLOCK_OUT',
          severity: 'ACTION_REQUIRED',
          workflowImpact: 'SUBMISSION_BLOCKING',
          status: 'OPEN',
          detectedAt: now,
          reason: employeeResolution
            ? 'Open TimeEntry exceeded the missed clock-out threshold and needs employee resolution.'
            : 'Open TimeEntry exceeded the missed clock-out threshold and needs manager or admin review.',
          metadata: jsonMetadata({
            clockInAt: current.clockInAt.toISOString(),
            detectedAt: now.toISOString(),
            maxOpenDurationMinutes:
              numericPolicyValue(policy.missedPunch.maxOpenDurationMinutes) ??
              null,
            detectionGraceMinutes:
              numericPolicyValue(policy.missedPunch.detectionGraceMinutes) ??
              null,
            employeeResolutionEnabled: employeeResolution,
          }),
        },
      });
      await this.writeAudit(
        tx,
        employeeResolution
          ? 'TIME_EXCEPTION_DETECTED'
          : 'TIME_EXCEPTION_ESCALATED',
        exception.id,
        context,
        {
          employeeId: current.employeeId,
          timeEntryId: current.id,
          employmentAssignmentId: current.employmentAssignmentId,
          type: exception.type,
          employeeResolutionEnabled: employeeResolution,
        },
        'AttendanceException',
      );
      return {
        detected: true,
        autoResolved: false,
        escalated: !employeeResolution,
      };
    });
  }

  private directCorrectionDtoForEntry(
    dto: DirectTimeCorrectionDto,
    timeEntryId: string,
  ): CreateTimeCorrectionRequestDto {
    return {
      type: dto.type,
      reason: dto.reason,
      timeEntryId,
      breakEntryId: dto.breakEntryId,
      employmentAssignmentId: dto.employmentAssignmentId,
      targetEmploymentAssignmentId: dto.targetEmploymentAssignmentId,
      additionalEmploymentAssignmentIds: dto.additionalEmploymentAssignmentIds,
      clockInAt: dto.clockInAt,
      clockOutAt: dto.clockOutAt,
      breakStartAt: dto.breakStartAt,
      breakEndAt: dto.breakEndAt,
      startAt: dto.startAt,
      endAt: dto.endAt,
    };
  }

  private async autoCloseMissedClockOut(
    tx: Prisma.TransactionClient,
    entry: NonNullable<Awaited<ReturnType<TimeService['openEntry']>>>,
    clockOutAt: Date,
    detectedAt: Date,
    context: TimeRequestContext,
  ) {
    const openBreak = await this.openBreakForEntry(entry.id, tx);
    if (openBreak) {
      await this.closeBreak(
        tx,
        entry.employeeId,
        entry,
        openBreak,
        clockOutAt,
        {
          source: 'SYSTEM',
        },
      );
      await this.createResolvedException(
        tx,
        {
          employeeId: entry.employeeId,
          employmentAssignmentId: entry.employmentAssignmentId,
          timeEntryId: entry.id,
          type: 'OPEN_BREAK_AUTO_CLOSED',
          detectedAt,
          resolvedAt: detectedAt,
          reason:
            'Open break was automatically closed during missed clock-out auto-resolution.',
          metadata: {
            breakEntryId: openBreak.id,
            closedAt: clockOutAt.toISOString(),
            source: 'SYSTEM_AUTO_RESOLUTION',
          },
        },
        context,
      );
    }
    await tx.timePunch.create({
      data: {
        employeeId: entry.employeeId,
        employmentAssignmentId: entry.employmentAssignmentId,
        timeEntryId: entry.id,
        type: 'CLOCK_OUT',
        occurredAt: clockOutAt,
        timezone: entry.timezone,
        source: 'SYSTEM',
        metadata: {
          source: 'SYSTEM_AUTO_RESOLUTION',
          detectedAt: detectedAt.toISOString(),
        },
      },
    });
    await this.closeOpenEntry(tx, entry.id, clockOutAt);
    await this.recalculateAttendanceInterpretation(entry.id, tx, context);
    await this.flagTimeRecordedAfterApproval(tx, entry.id, detectedAt, context);
    const exception = await this.createResolvedException(
      tx,
      {
        employeeId: entry.employeeId,
        employmentAssignmentId: entry.employmentAssignmentId,
        timeEntryId: entry.id,
        type: 'AUTO_CLOSED_CLOCK_OUT',
        detectedAt,
        resolvedAt: detectedAt,
        reason:
          'Open TimeEntry exceeded the missed clock-out threshold and was auto-closed from trusted expected end.',
        metadata: {
          clockInAt: entry.clockInAt.toISOString(),
          clockOutAt: clockOutAt.toISOString(),
          source: 'EXPECTED_END',
        },
      },
      context,
    );
    await this.writeAudit(
      tx,
      'TIME_EXCEPTION_SYSTEM_AUTO_RESOLVED',
      exception.id,
      context,
      {
        employeeId: entry.employeeId,
        timeEntryId: entry.id,
        employmentAssignmentId: entry.employmentAssignmentId,
        type: exception.type,
        clockOutAt,
      },
      'AttendanceException',
    );
  }

  async recalculateAttendanceInterpretationForEntry(
    timeEntryId: string,
    context: TimeRequestContext = {},
  ) {
    return this.prisma.$transaction((tx) =>
      this.recalculateAttendanceInterpretation(timeEntryId, tx, context),
    );
  }

  /**
   * Phase 8 — re-interprets attendance near changed approved-absence intervals (leave approved,
   * cancelled or shortened), inside the caller's transaction. Only interpretation exceptions
   * change; time entries, punches and timesheets are never touched.
   */
  /**
   * Phase 8: re-interprets attendance after approved leave changes. Only the leave's own
   * assignment is touched, and only its entries on the leave's local dates or whose actual time
   * overlaps an absence interval (an overnight shift). Entries on finalized time (an APPROVED
   * or LOCKED timesheet, or an approved segment) are never re-interpreted, as everywhere else in
   * Time; they are counted as skipped.
   */
  async recalculateAttendanceForAbsences(
    client: Prisma.TransactionClient,
    input: {
      employeeId: string;
      employmentAssignmentId: string;
      dates: readonly Date[];
      intervals: readonly { start: Date; end: Date }[];
    },
    context: TimeRequestContext,
  ) {
    if (input.intervals.length === 0 && input.dates.length === 0) {
      return { entries: 0, skippedFinalized: 0 };
    }
    const entries = await client.timeEntry.findMany({
      where: {
        employeeId: input.employeeId,
        employmentAssignmentId: input.employmentAssignmentId,
        archivedAt: null,
        OR: [
          ...(input.dates.length
            ? [{ workDate: { in: [...input.dates] } }]
            : []),
          ...input.intervals.flatMap((interval) => [
            {
              clockInAt: { lt: interval.end },
              clockOutAt: { gt: interval.start },
            },
            {
              // An open entry overlaps when it started within reach of the absence.
              clockInAt: {
                lt: interval.end,
                gte: new Date(interval.start.getTime() - 2 * 86_400_000),
              },
              clockOutAt: null,
            },
          ]),
        ],
      },
      select: {
        id: true,
        employeeId: true,
        employmentAssignmentId: true,
        workDate: true,
      },
      orderBy: { clockInAt: 'asc' },
    });
    let recalculated = 0;
    let skippedFinalized = 0;
    for (const entry of entries) {
      if (await this.finalizedTimesheetOf(entry, client)) {
        skippedFinalized += 1;
        continue;
      }
      await this.recalculateAttendanceInterpretation(entry.id, client, context);
      recalculated += 1;
    }
    return { entries: recalculated, skippedFinalized };
  }

  private async recalculateAttendanceInterpretation(
    timeEntryId: string,
    client: Prisma.TransactionClient,
    context: TimeRequestContext,
  ) {
    const entry = await this.timeEntryById(timeEntryId, client);
    if (!entry || entry.archivedAt) return { created: 0, resolved: 0 };
    const policy = await this.effectivePolicyForAssignmentOnWorkDate(
      entry.employmentAssignment,
      entry.workDate,
      client,
    );
    const expectedWindow = await this.expectedWorkWindow(entry, policy, client);
    let created = 0;
    let resolved = 0;

    const lateCondition =
      this.lateArrivalEnabled(policy) && expectedWindow.expectedStart
        ? this.interpretLateArrival(
            entry.clockInAt,
            expectedWindow.expectedStart,
            this.lateGraceMinutes(policy),
          )
        : null;
    const lateResult = await this.syncInterpretationException(
      client,
      entry,
      'LATE_ARRIVAL',
      lateCondition,
      context,
      expectedWindow.source,
    );
    created += lateResult.created;
    resolved += lateResult.resolved;

    const earlyCondition =
      this.earlyDepartureEnabled(policy) &&
      expectedWindow.expectedEnd &&
      entry.clockOutAt
        ? this.interpretEarlyDeparture(
            entry.clockOutAt,
            expectedWindow.expectedEnd,
            this.earlyDepartureGraceMinutes(policy),
          )
        : null;
    const earlyResult = await this.syncInterpretationException(
      client,
      entry,
      'EARLY_DEPARTURE',
      earlyCondition,
      context,
      expectedWindow.source,
    );
    created += earlyResult.created;
    resolved += earlyResult.resolved;

    return { created, resolved };
  }

  /**
   * The expected work an entry is interpreted against. A schedule-linked entry uses exactly the
   * immutable published revision it references (a CANCELLED revision means no expectation);
   * otherwise the Phase 6 policy expected window applies. Approved absence overlapping the
   * expectation (future Leave/PTO) removes it. Clock-in eligibility is never lateness: only
   * these expected instants and the attendance grace rules decide LATE/EARLY.
   */
  private async expectedWorkWindow(
    entry: {
      employeeId: string;
      employmentAssignmentId: string;
      workDate: Date;
      timezone: string;
      scheduledShiftId: string | null;
      scheduledShiftRevisionId: string | null;
    },
    policy: TimeAttendancePolicyConfig,
    client: TimeClient,
  ): Promise<{
    expectedStart: Date | null;
    expectedEnd: Date | null;
    source: ExpectedWorkSource;
  }> {
    let window: { expectedStart: Date | null; expectedEnd: Date | null };
    let source: ExpectedWorkSource;
    if (entry.scheduledShiftRevisionId) {
      const revision = await client.scheduledShiftRevision.findUnique({
        where: { id: entry.scheduledShiftRevisionId },
        select: {
          id: true,
          revisionNumber: true,
          status: true,
          startsAt: true,
          endsAt: true,
        },
      });
      source = {
        sourceType: 'SCHEDULE',
        scheduledShiftId: entry.scheduledShiftId,
        scheduledShiftRevisionId: entry.scheduledShiftRevisionId,
        revisionNumber: revision?.revisionNumber ?? null,
      };
      window =
        revision && revision.status === 'ACTIVE'
          ? { expectedStart: revision.startsAt, expectedEnd: revision.endsAt }
          : { expectedStart: null, expectedEnd: null };
    } else {
      source = { sourceType: 'POLICY' };
      window = this.expectedInterpretationWindow(entry, policy);
    }
    if (
      this.absences &&
      window.expectedStart &&
      window.expectedEnd &&
      window.expectedEnd.getTime() > window.expectedStart.getTime()
    ) {
      const expected = {
        employmentAssignmentId: entry.employmentAssignmentId,
        expectedStart: window.expectedStart.toISOString(),
        expectedEnd: window.expectedEnd.toISOString(),
        sourceType: source.sourceType,
        sourceId: source.scheduledShiftRevisionId ?? null,
      };
      const absences = await this.absences.approvedAbsences(
        {
          employeeId: entry.employeeId,
          start: expected.expectedStart,
          end: expected.expectedEnd,
        },
        client,
      );
      // Only the portion of expected work that approved absence does not cover is interpreted.
      const trimmed = trimExpectedWorkForAbsences(expected, absences);
      return trimmed
        ? {
            expectedStart: new Date(trimmed.expectedStart),
            expectedEnd: new Date(trimmed.expectedEnd),
            source,
          }
        : { expectedStart: null, expectedEnd: null, source };
    }
    return { ...window, source };
  }

  private expectedInterpretationWindow(
    entry: { workDate: Date; timezone: string },
    policy: TimeAttendancePolicyConfig,
  ) {
    const start = this.expectedLocalTimeInstant(
      entry.workDate,
      entry.timezone,
      policy.attendanceInterpretation.expectedStartLocalTime,
      0,
    );
    let end = this.expectedLocalTimeInstant(
      entry.workDate,
      entry.timezone,
      policy.attendanceInterpretation.expectedEndLocalTime,
      0,
    );
    if (start && end && end.getTime() <= start.getTime()) {
      end = this.expectedLocalTimeInstant(
        entry.workDate,
        entry.timezone,
        policy.attendanceInterpretation.expectedEndLocalTime,
        1,
      );
    }
    return { expectedStart: start, expectedEnd: end };
  }

  private expectedLocalTimeInstant(
    workDate: Date,
    timezone: string,
    localTime: unknown,
    localDayOffset: number,
  ): Date | null {
    if (!isLocalTimeValue(localTime)) return null;
    // Batch 4D (D-B): a policy time resolves deterministically across daylight saving and
    // never throws, so it can never refuse a clock-in or clock-out.
    return this.domain.resolvePolicyLocalDateTime(
      dateOnly(addDateOnlyDays(workDate, localDayOffset)) ?? '',
      localTime,
      timezone,
    );
  }

  private interpretLateArrival(
    actualStart: Date,
    expectedStart: Date,
    graceMinutes: number,
  ) {
    const graceBoundary = new Date(
      expectedStart.getTime() + graceMinutes * 60_000,
    );
    if (actualStart.getTime() <= graceBoundary.getTime()) return null;
    return {
      actualAt: actualStart,
      expectedAt: expectedStart,
      graceMinutes,
      varianceMinutes: positiveCeilMinutes(
        actualStart.getTime() - expectedStart.getTime(),
      ),
    };
  }

  private interpretEarlyDeparture(
    actualEnd: Date,
    expectedEnd: Date,
    graceMinutes: number,
  ) {
    const graceBoundary = new Date(
      expectedEnd.getTime() - graceMinutes * 60_000,
    );
    if (actualEnd.getTime() >= graceBoundary.getTime()) return null;
    return {
      actualAt: actualEnd,
      expectedAt: expectedEnd,
      graceMinutes,
      varianceMinutes: positiveCeilMinutes(
        expectedEnd.getTime() - actualEnd.getTime(),
      ),
    };
  }

  private async syncInterpretationException(
    client: Prisma.TransactionClient,
    entry: NonNullable<Awaited<ReturnType<TimeService['timeEntryById']>>>,
    type: InterpretationExceptionType,
    condition: {
      actualAt: Date;
      expectedAt: Date;
      graceMinutes: number;
      varianceMinutes: number;
    } | null,
    context: TimeRequestContext,
    source: ExpectedWorkSource = { sourceType: 'POLICY' },
  ) {
    const open = await client.attendanceException.findFirst({
      where: { timeEntryId: entry.id, type, status: 'OPEN' },
    });
    if (!condition) {
      if (!open) return { created: 0, resolved: 0 };
      await client.attendanceException.update({
        where: { id: open.id },
        data: {
          status: 'RESOLVED',
          resolutionMethod: 'SYSTEM_AUTO_RESOLUTION',
          resolvedAt: this.clock.now(),
          metadata: this.mergeExceptionMetadata(open.metadata, {
            resolvedReason: 'Attendance interpretation no longer applies.',
          }),
        },
      });
      await this.writeAudit(
        client,
        'TIME_INTERPRETATION_EXCEPTION_RESOLVED',
        open.id,
        context,
        { employeeId: entry.employeeId, timeEntryId: entry.id, type },
        'AttendanceException',
      );
      return { created: 0, resolved: 1 };
    }
    const metadata = {
      actualAt: condition.actualAt.toISOString(),
      expectedAt: condition.expectedAt.toISOString(),
      graceMinutes: condition.graceMinutes,
      varianceMinutes: condition.varianceMinutes,
      timezone: entry.timezone,
      workDate: dateOnly(entry.workDate),
      ...(source.sourceType === 'SCHEDULE'
        ? {
            expectedSourceType: source.sourceType,
            scheduledShiftId: source.scheduledShiftId,
            scheduledShiftRevisionId: source.scheduledShiftRevisionId,
            scheduledShiftRevisionNumber: source.revisionNumber,
          }
        : {}),
    };
    if (open) {
      await client.attendanceException.update({
        where: { id: open.id },
        data: { metadata: jsonMetadata(metadata) },
      });
      return { created: 0, resolved: 0 };
    }
    const exception = await client.attendanceException.create({
      data: {
        employeeId: entry.employeeId,
        employmentAssignmentId: entry.employmentAssignmentId,
        timeEntryId: entry.id,
        type,
        severity: 'REVIEW',
        workflowImpact: 'NON_BLOCKING',
        status: 'OPEN',
        detectedAt: this.clock.now(),
        reason:
          type === 'LATE_ARRIVAL'
            ? 'TimeEntry clock-in exceeded the expected start grace period.'
            : 'TimeEntry clock-out occurred before the expected end grace period.',
        metadata: jsonMetadata(metadata),
      },
    });
    await this.writeAudit(
      client,
      'TIME_INTERPRETATION_EXCEPTION_CREATED',
      exception.id,
      context,
      { employeeId: entry.employeeId, timeEntryId: entry.id, type },
      'AttendanceException',
    );
    return { created: 1, resolved: 0 };
  }

  private entryReadInclude() {
    return {
      employee: { include: { person: true } },
      employmentAssignment: {
        include: { position: { include: positionInclude() } },
      },
      assignmentCoverages: activeCoverageInclude(),
      breaks: { where: { removedAt: null }, orderBy: { startAt: 'asc' } },
      exceptions: { orderBy: { detectedAt: 'desc' } },
      correctionRequests: {
        include: { adjustment: true },
        orderBy: { requestedAt: 'desc' },
      },
    } as const;
  }

  private entryWhere(
    query: TimeEntriesQueryDto & { employeeId?: string },
  ): Prisma.TimeEntryWhereInput {
    return {
      ...(query.employeeId ? { employeeId: query.employeeId } : {}),
      ...(query.status ? { status: query.status } : {}),
      archivedAt: null,
      ...this.workDateRange(query),
      ...this.searchWhere(query.search),
    };
  }

  private exceptionWhere(
    query: TimeExceptionsQueryDto,
  ): Prisma.AttendanceExceptionWhereInput {
    return {
      ...(query.employeeId ? { employeeId: query.employeeId } : {}),
      ...(query.type ? { type: query.type } : {}),
      ...(query.severity ? { severity: query.severity } : {}),
      ...(query.workflowImpact ? { workflowImpact: query.workflowImpact } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...this.detectedDateRange(query),
      ...this.exceptionSearchWhere(query.search),
    };
  }

  private correctionWhere(
    query: TimeCorrectionsQueryDto,
  ): Prisma.TimeCorrectionRequestWhereInput {
    return {
      ...(query.employeeId ? { employeeId: query.employeeId } : {}),
      ...(query.type ? { type: query.type } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...this.requestedDateRange(query),
      ...this.correctionSearchWhere(query.search),
    };
  }

  private timesheetWhere(
    query: TimeTimesheetsQueryDto,
  ): Prisma.TimesheetWhereInput {
    return {
      ...(query.employeeId ? { employeeId: query.employeeId } : {}),
      ...(query.timePeriodId ? { timePeriodId: query.timePeriodId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...this.periodDateRange(query),
      ...this.timesheetSearchWhere(query.search),
    };
  }

  private workDateRange(query: { startDate?: string; endDate?: string }) {
    const range: Prisma.DateTimeFilter = {};
    if (query.startDate) range.gte = this.domain.parseDateOnly(query.startDate);
    if (query.endDate) range.lte = this.domain.parseDateOnly(query.endDate);
    return Object.keys(range).length > 0 ? { workDate: range } : {};
  }

  private detectedDateRange(query: { startDate?: string; endDate?: string }) {
    const range: Prisma.DateTimeFilter = {};
    if (query.startDate) range.gte = this.domain.parseDateOnly(query.startDate);
    if (query.endDate) {
      range.lt = addDateOnlyDays(this.domain.parseDateOnly(query.endDate), 1);
    }
    return Object.keys(range).length > 0 ? { detectedAt: range } : {};
  }

  private requestedDateRange(query: { startDate?: string; endDate?: string }) {
    const range: Prisma.DateTimeFilter = {};
    if (query.startDate) range.gte = this.domain.parseDateOnly(query.startDate);
    if (query.endDate) {
      range.lt = addDateOnlyDays(this.domain.parseDateOnly(query.endDate), 1);
    }
    return Object.keys(range).length > 0 ? { requestedAt: range } : {};
  }

  private periodDateRange(query: { startDate?: string; endDate?: string }) {
    const timePeriod: Prisma.TimePeriodWhereInput = {};
    if (query.startDate) {
      timePeriod.endDate = { gte: this.domain.parseDateOnly(query.startDate) };
    }
    if (query.endDate) {
      timePeriod.startDate = { lte: this.domain.parseDateOnly(query.endDate) };
    }
    return Object.keys(timePeriod).length > 0 ? { timePeriod } : {};
  }

  private searchWhere(search?: string): Prisma.TimeEntryWhereInput {
    const term = search?.trim();
    if (!term) return {};
    return {
      OR: [
        {
          employee: { employeeNumber: { contains: term, mode: 'insensitive' } },
        },
        {
          employee: {
            person: { firstName: { contains: term, mode: 'insensitive' } },
          },
        },
        {
          employee: {
            person: { lastName: { contains: term, mode: 'insensitive' } },
          },
        },
        {
          employmentAssignment: {
            position: { name: { contains: term, mode: 'insensitive' } },
          },
        },
        {
          employmentAssignment: {
            position: { code: { contains: term, mode: 'insensitive' } },
          },
        },
      ],
    };
  }

  private exceptionSearchWhere(
    search?: string,
  ): Prisma.AttendanceExceptionWhereInput {
    const term = search?.trim();
    if (!term) return {};
    return {
      OR: [
        {
          employee: { employeeNumber: { contains: term, mode: 'insensitive' } },
        },
        {
          employee: {
            person: { firstName: { contains: term, mode: 'insensitive' } },
          },
        },
        {
          employee: {
            person: { lastName: { contains: term, mode: 'insensitive' } },
          },
        },
        {
          employmentAssignment: {
            position: { name: { contains: term, mode: 'insensitive' } },
          },
        },
      ],
    };
  }

  private correctionSearchWhere(
    search?: string,
  ): Prisma.TimeCorrectionRequestWhereInput {
    const term = search?.trim();
    if (!term) return {};
    return {
      OR: [
        {
          employee: { employeeNumber: { contains: term, mode: 'insensitive' } },
        },
        {
          employee: {
            person: { firstName: { contains: term, mode: 'insensitive' } },
          },
        },
        {
          employee: {
            person: { lastName: { contains: term, mode: 'insensitive' } },
          },
        },
        { reason: { contains: term, mode: 'insensitive' } },
      ],
    };
  }

  private timesheetSearchWhere(search?: string): Prisma.TimesheetWhereInput {
    const term = search?.trim();
    if (!term) return {};
    return {
      OR: [
        {
          employee: { employeeNumber: { contains: term, mode: 'insensitive' } },
        },
        {
          employee: {
            person: { firstName: { contains: term, mode: 'insensitive' } },
          },
        },
        {
          employee: {
            person: { lastName: { contains: term, mode: 'insensitive' } },
          },
        },
        {
          segments: {
            some: {
              employmentAssignment: {
                position: { name: { contains: term, mode: 'insensitive' } },
              },
            },
          },
        },
      ],
    };
  }

  private pageTake(limit?: number) {
    return this.pageLimit(limit) + 1;
  }

  private scanTake(limit?: number) {
    return this.pageLimit(limit) * 4 + 1;
  }

  private pageLimit(limit?: number) {
    return Math.min(Math.max(limit ?? 25, 1), 100);
  }

  private page<T extends { id: string }, R>(
    rows: T[],
    shape: (row: T) => R,
    limit?: number,
  ) {
    const max = this.pageLimit(limit);
    const slice = rows.slice(0, max);
    return {
      items: slice.map(shape),
      nextAfterId: rows.length > max ? (slice.at(-1)?.id ?? null) : null,
    };
  }

  private async authorizedPage<T extends { id: string }, R>(
    rows: T[],
    limit: number | undefined,
    shape: (row: T) => Promise<R | null>,
  ) {
    // Batch 4B: the cursor is the last row EXAMINED, never the last row scanned, so rows after
    // a full page are read by the next page: every readable record appears exactly once.
    const max = this.pageLimit(limit);
    const scanFull = rows.length === this.scanTake(limit);
    const items: R[] = [];
    for (let index = 0; index < rows.length; index += 1) {
      const item = await shape(rows[index]!);
      if (item) items.push(item);
      if (items.length >= max) {
        const more = index < rows.length - 1 || scanFull;
        return { items, nextAfterId: more ? rows[index]!.id : null };
      }
    }
    return {
      items,
      nextAfterId: scanFull ? (rows.at(-1)?.id ?? null) : null,
    };
  }

  private async canReadPosition(
    userId: string,
    positionId: string,
    permissions: TimeReadPermission[],
    options: { historical?: boolean } = {},
  ) {
    const scope = await this.targets.scopeForPosition(
      positionId,
      undefined,
      this.prisma,
    );
    for (const permission of permissions) {
      if (
        await this.authorization.canAccess(
          userId,
          permission,
          scope,
          this.prisma,
        )
      ) {
        // Phase 18: records of organizations with Time & attendance disabled are left out,
        // unless the caller asked for history (Batch 4F, C10): the grant above is still
        // required, so nothing is readable that the caller's current permissions don't cover.
        if (options.historical) return true;
        return this.attendanceEnabledForPosition(positionId);
      }
    }
    return false;
  }

  private async canReadAnyPosition(
    userId: string,
    positionIds: string[],
    permissions: TimeReadPermission[],
    options: { historical?: boolean } = {},
  ) {
    for (const positionId of new Set(positionIds)) {
      if (await this.canReadPosition(userId, positionId, permissions, options))
        return true;
    }
    return false;
  }

  private entryReadShape(entry: {
    id: string;
    employeeId: string;
    employmentAssignmentId: string;
    clockInAt: Date;
    clockOutAt: Date | null;
    timezone: string;
    workDate: Date;
    status: string;
    source: string;
    scheduledShiftId?: string | null;
    scheduledShiftRevisionId?: string | null;
    employee: {
      employeeNumber: string;
      person: {
        firstName: string | null;
        middleName: string | null;
        lastName: string | null;
        preferredName: string | null;
      };
    };
    employmentAssignment: NonNullable<
      Awaited<ReturnType<TimeService['assignmentById']>>
    >;
    breaks: Array<{
      id: string;
      startAt: Date;
      endAt: Date | null;
      payType: string | null;
    }>;
    exceptions: AttendanceExceptionShape[];
    correctionRequests: Array<{
      id: string;
      type: string;
      status: string;
      requestedAt: Date;
      reviewedAt: Date | null;
      adjustment?: { id: string } | null;
    }>;
    assignmentCoverages?: Array<{
      employmentAssignmentId: string;
      removedAt: Date | null;
      employmentAssignment: NonNullable<
        Awaited<ReturnType<TimeService['assignmentById']>>
      >;
    }>;
  }) {
    const breakTotals = this.breakTotals(entry.breaks);
    const grossMinutes = entry.clockOutAt
      ? positiveFloorMinutes(
          entry.clockOutAt.getTime() - entry.clockInAt.getTime(),
        )
      : null;
    return {
      id: entry.id,
      employeeId: entry.employeeId,
      employeeNumber: entry.employee.employeeNumber,
      employeeName: personDisplayName(entry.employee.person),
      employmentAssignmentId: entry.employmentAssignmentId,
      assignment: this.assignmentShape(entry.employmentAssignment),
      // Every assignment this one physical interval covers, payroll owner first. Its minutes
      // below are counted once and paid to the owner only.
      coverage: coveredAssignments(entry).map((covered) => ({
        employmentAssignmentId: covered.employmentAssignmentId,
        assignment: this.assignmentShape(covered.assignment),
        isPayrollOwner: covered.isPayrollOwner,
      })),
      workDate: dateOnly(entry.workDate),
      clockInAt: entry.clockInAt.toISOString(),
      clockOutAt: entry.clockOutAt?.toISOString() ?? null,
      timezone: entry.timezone,
      status: entry.status,
      source: entry.source,
      scheduledShiftId: entry.scheduledShiftId ?? null,
      scheduledShiftRevisionId: entry.scheduledShiftRevisionId ?? null,
      grossMinutes,
      paidBreakMinutes: breakTotals.paid,
      unpaidBreakMinutes: breakTotals.unpaid,
      breakMinutes: breakTotals.total,
      netWorkedMinutes:
        grossMinutes === null
          ? null
          : Math.max(0, grossMinutes - breakTotals.unpaid),
      breaks: entry.breaks.map((breakEntry) => ({
        id: breakEntry.id,
        startAt: breakEntry.startAt.toISOString(),
        endAt: breakEntry.endAt?.toISOString() ?? null,
        payType: breakEntry.payType,
      })),
      exceptions: entry.exceptions.map((exception) =>
        this.exceptionShape(exception),
      ),
      corrections: entry.correctionRequests.map((request) => ({
        id: request.id,
        type: request.type,
        status: request.status,
        requestedAt: request.requestedAt.toISOString(),
        reviewedAt: request.reviewedAt?.toISOString() ?? null,
        adjustmentId: request.adjustment?.id ?? null,
      })),
    };
  }

  private breakTotals(
    breaks: Array<{
      startAt: Date;
      endAt: Date | null;
      payType: string | null;
    }>,
  ) {
    return breaks.reduce(
      (total, breakEntry) => {
        if (!breakEntry.endAt) return total;
        const minutes = positiveFloorMinutes(
          breakEntry.endAt.getTime() - breakEntry.startAt.getTime(),
        );
        return {
          paid: total.paid + (breakEntry.payType === 'PAID' ? minutes : 0),
          unpaid:
            total.unpaid + (breakEntry.payType === 'UNPAID' ? minutes : 0),
          total: total.total + minutes,
        };
      },
      { paid: 0, unpaid: 0, total: 0 },
    );
  }

  /**
   * R4-A.5: a SCHEDULE_CHANGED_AFTER_ATTENDANCE signal names its shift in its metadata; the
   * shift's schedule (needed to open its revisions) is looked up for the page in one query, so
   * earlier signals get it too. Any other exception gets null.
   */
  private async withChangedShiftSchedules<
    P extends { items: Array<{ type: string; metadata: unknown }> },
  >(
    page: P,
  ): Promise<
    Omit<P, 'items'> & {
      items: Array<
        P['items'][number] & { changedShiftScheduleId: string | null }
      >;
    }
  > {
    type T = P['items'][number];
    const shiftIdOf = (item: T) => {
      if (item.type !== 'SCHEDULE_CHANGED_AFTER_ATTENDANCE') return null;
      const id = jsonObject(item.metadata).scheduledShiftId;
      return typeof id === 'string' ? id : null;
    };
    const ids = [
      ...new Set(page.items.map(shiftIdOf).filter((id) => id !== null)),
    ];
    const schedules = new Map(
      ids.length === 0
        ? []
        : (
            await this.prisma.scheduledShift.findMany({
              where: { id: { in: ids } },
              select: { id: true, scheduleId: true },
            })
          ).map((shift) => [shift.id, shift.scheduleId]),
    );
    return {
      ...page,
      items: page.items.map((item) => {
        const shiftId = shiftIdOf(item);
        return {
          ...item,
          changedShiftScheduleId: shiftId
            ? (schedules.get(shiftId) ?? null)
            : null,
        };
      }),
    };
  }

  private managementExceptionShape(exception: {
    id: string;
    employeeId: string;
    employmentAssignmentId: string | null;
    timeEntryId: string | null;
    type: string;
    severity: string;
    workflowImpact: string;
    status: string;
    detectedAt: Date;
    resolvedAt: Date | null;
    reason: string | null;
    metadata: unknown;
    resolutionMethod?: string | null;
    resolvedByUserId?: string | null;
    resolutionNote?: string | null;
    scheduledShiftId?: string | null;
    employee: {
      employeeNumber: string;
      person: {
        firstName: string | null;
        middleName: string | null;
        lastName: string | null;
        preferredName: string | null;
      };
    };
    employmentAssignment?: NonNullable<
      Awaited<ReturnType<TimeService['assignmentById']>>
    > | null;
    timeEntry?: {
      workDate: Date;
      timezone: string;
      employmentAssignment: NonNullable<
        Awaited<ReturnType<TimeService['assignmentById']>>
      >;
    } | null;
  }) {
    const assignment =
      exception.employmentAssignment ??
      exception.timeEntry?.employmentAssignment ??
      null;
    return {
      ...this.exceptionShape(exception),
      // Batch 4E-1: links the exception to the employee's timesheet.
      employeeId: exception.employeeId,
      employeeNumber: exception.employee.employeeNumber,
      employeeName: personDisplayName(exception.employee.person),
      workDate: exception.timeEntry?.workDate
        ? dateOnly(exception.timeEntry.workDate)
        : exception.type === 'NO_SHOW'
          ? ((jsonObject(exception.metadata).workDate as string | undefined) ??
            null)
          : null,
      timezone:
        exception.timeEntry?.timezone ??
        (exception.type === 'NO_SHOW'
          ? ((jsonObject(exception.metadata).timezone as string | undefined) ??
            null)
          : null),
      assignment: assignment ? this.assignmentShape(assignment) : null,
      // Batch 4C: the review (managers only; employees see the status).
      scheduledShiftId: exception.scheduledShiftId ?? null,
      resolutionMethod: exception.resolutionMethod ?? null,
      resolvedByUserId: exception.resolvedByUserId ?? null,
      resolutionNote: exception.resolutionNote ?? null,
    };
  }

  private managementCorrectionShape(request: {
    id: string;
    employeeId: string;
    requestorUserId: string;
    reviewerUserId: string | null;
    timeEntryId: string | null;
    breakEntryId: string | null;
    employmentAssignmentId: string | null;
    targetEmploymentAssignmentId: string | null;
    type: string;
    status: string;
    reason: string;
    reviewerNote: string | null;
    requestedValues: unknown;
    currentValues: unknown;
    requestedAt: Date;
    reviewedAt: Date | null;
    cancelledAt: Date | null;
    employee: {
      employeeNumber: string;
      person: {
        firstName: string | null;
        middleName: string | null;
        lastName: string | null;
        preferredName: string | null;
      };
    };
    timeEntry?: {
      workDate: Date;
      timezone: string;
      employmentAssignment: NonNullable<
        Awaited<ReturnType<TimeService['assignmentById']>>
      >;
    } | null;
    employmentAssignment?: NonNullable<
      Awaited<ReturnType<TimeService['assignmentById']>>
    > | null;
    targetEmploymentAssignment?: NonNullable<
      Awaited<ReturnType<TimeService['assignmentById']>>
    > | null;
    breakEntry?: {
      timeEntry?: {
        workDate: Date;
        timezone: string;
        employmentAssignment: NonNullable<
          Awaited<ReturnType<TimeService['assignmentById']>>
        >;
      } | null;
    } | null;
    adjustment?: { id: string } | null;
  }) {
    const assignment =
      request.employmentAssignment ??
      request.timeEntry?.employmentAssignment ??
      request.breakEntry?.timeEntry?.employmentAssignment ??
      null;
    return {
      ...this.correctionShape(request),
      employeeNumber: request.employee.employeeNumber,
      employeeName: personDisplayName(request.employee.person),
      workDate: request.timeEntry?.workDate
        ? dateOnly(request.timeEntry.workDate)
        : null,
      timezone: request.timeEntry?.timezone ?? null,
      assignment: assignment ? this.assignmentShape(assignment) : null,
      targetAssignment: request.targetEmploymentAssignment
        ? this.assignmentShape(request.targetEmploymentAssignment)
        : null,
    };
  }

  /** Batch 4C: managers also see the employee's number and name (never to employees). */
  private managementTimesheetShape(
    sheet: NonNullable<Awaited<ReturnType<TimeService['timesheetById']>>>,
  ) {
    return {
      ...this.timesheetShape(sheet),
      employee: {
        id: sheet.employeeId,
        employeeNumber: sheet.employee.employeeNumber,
        name: personDisplayName(sheet.employee.person),
      },
    };
  }

  private correctionPositionIds(request: {
    timeEntry?: { employmentAssignment: { positionId: string } } | null;
    employmentAssignment?: { positionId: string } | null;
    targetEmploymentAssignment?: { positionId: string } | null;
    breakEntry?: {
      timeEntry?: { employmentAssignment: { positionId: string } } | null;
    } | null;
  }) {
    return [
      request.timeEntry?.employmentAssignment.positionId,
      request.employmentAssignment?.positionId,
      request.targetEmploymentAssignment?.positionId,
      request.breakEntry?.timeEntry?.employmentAssignment.positionId,
    ].filter((value): value is string => Boolean(value));
  }

  private timesheetInclude() {
    return {
      timePeriod: true,
      // Phase 19: only the linked user's id (self-approval check); never the full user row.
      employee: {
        include: { person: { include: { user: { select: { id: true } } } } },
      },
      segments: {
        include: {
          employmentAssignment: {
            include: { position: { include: positionInclude() } },
          },
        },
        orderBy: { id: 'asc' },
      },
      events: { orderBy: { occurredAt: 'asc' } },
    } as const;
  }

  /** The timesheet with only its period's organization's segments (scopedTimesheet). */
  private async timesheetById(id: string, client: TimeClient) {
    const sheet = await client.timesheet.findUnique({
      where: { id },
      include: this.timesheetInclude(),
    });
    return sheet ? this.scopedTimesheet(sheet) : null;
  }

  /**
   * Batch 4B (D3): a timesheet belongs to one organization's time period, so it holds only that
   * organization's assignments. Segments of another organization (written before 4B, when the
   * refresh read every organization's entries) are left untouched in the database, never
   * deleted or recalculated, but take no part in anything: totals, approval, locking, reopening,
   * payroll rows, authorization or what any reader sees. `outOfScopeSegments` counts what was
   * left out (the shape then shows totals of the remaining segments only).
   */
  private scopedTimesheet<
    T extends {
      timePeriod: { organizationId: string };
      segments: Array<{
        employmentAssignment: { position: { organizationId: string } };
      }>;
    },
  >(sheet: T): T & { outOfScopeSegments: number } {
    const segments = sheet.segments.filter(
      (segment) =>
        segment.employmentAssignment.position.organizationId ===
        sheet.timePeriod.organizationId,
    );
    return {
      ...sheet,
      segments,
      outOfScopeSegments: sheet.segments.length - segments.length,
    };
  }

  /** A segment of another organization than its timesheet's period is not found (Batch 4B). */
  private async timesheetSegmentById(id: string, client: TimeClient) {
    const segment = await client.timesheetSegment.findUnique({
      where: { id },
      include: {
        employmentAssignment: {
          include: { position: { include: positionInclude() } },
        },
        timesheet: { include: this.timesheetInclude() },
      },
    });
    if (
      !segment ||
      segment.employmentAssignment.position.organizationId !==
        segment.timesheet.timePeriod.organizationId
    ) {
      return null;
    }
    return { ...segment, timesheet: this.scopedTimesheet(segment.timesheet) };
  }

  /** The organization of an employment assignment (its position's). */
  private async assignmentOrganizationId(
    employmentAssignmentId: string,
    client: TimeClient,
  ) {
    const assignment = await this.assignmentById(
      employmentAssignmentId,
      client,
    );
    if (!assignment) throw new NotFoundException('Assignment not found.');
    return assignment.position.organizationId;
  }

  /**
   * Batch 4B: the organizations where the user holds any of the permissions, for a database
   * pre-filter of management lists ('ALL' for System scope; null for none). Row-level checks
   * still decide each record (team and department scopes are narrower than an organization).
   */
  private timeOrganizations(
    userId: string,
    permissions: readonly string[],
    client: TimeClient = this.prisma,
  ): Promise<'ALL' | string[] | null> {
    return grantOrganizations(this.authorization, userId, permissions, client);
  }

  /**
   * Batch 4E-1 (G2): each authorized management item gets `actors`, the display names of the
   * users it already references (reviewers, approvers, event actors), and nothing more: no
   * email or other user data. A user who no longer exists, or has no name on record, is null.
   */
  private async withActorNames<T>(
    page: { items: T[]; nextAfterId: string | null },
    referenced: (item: T) => Array<string | null | undefined>,
  ) {
    const ids = [
      ...new Set(
        page.items
          .flatMap(referenced)
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    const users =
      ids.length === 0
        ? []
        : await this.prisma.user.findMany({
            where: { id: { in: ids } },
            select: {
              id: true,
              person: {
                select: {
                  firstName: true,
                  middleName: true,
                  lastName: true,
                  preferredName: true,
                },
              },
            },
          });
    const names = new Map(
      users.map((user) => [
        user.id,
        user.person.preferredName ||
          [user.person.firstName, user.person.middleName, user.person.lastName]
            .filter(Boolean)
            .join(' ') ||
          null,
      ]),
    );
    return {
      ...page,
      items: page.items.map((item) => ({
        ...item,
        actors: Object.fromEntries(
          referenced(item)
            .filter((id): id is string => Boolean(id))
            .map((id) => [id, names.get(id) ?? null]),
        ) as Record<string, string | null>,
      })),
    };
  }

  /**
   * Batch 4E-1 (G1): narrows the reader's authorized organizations to one requested
   * organization. Never widens them: an organization the reader holds none of the permissions
   * in answers null (an empty page), before any row is read.
   */
  private narrowOrganizations(
    organizations: 'ALL' | string[] | null,
    organizationId: string | undefined,
  ): 'ALL' | string[] | null {
    if (!organizations || !organizationId) return organizations;
    return organizations === 'ALL' || organizations.includes(organizationId)
      ? [organizationId]
      : null;
  }

  private entryOrganizationWhere(
    organizations: 'ALL' | string[],
  ): Prisma.TimeEntryWhereInput {
    return organizations === 'ALL'
      ? {}
      : {
          employmentAssignment: {
            position: { organizationId: { in: organizations } },
          },
        };
  }

  /**
   * Batch 4B: a record of an organization where the actor holds none of the permissions is
   * answered 404, exactly as if it did not exist (its existence is not revealed across
   * organizations). Within an organization the actor works in, a record outside their scope
   * stays 403.
   */
  private async assertOrganizationVisible(
    userId: string,
    organizationId: string,
    permissions: readonly string[],
    client: TimeClient,
    message: string,
  ) {
    const organizations = await this.timeOrganizations(
      userId,
      permissions,
      client,
    );
    if (organizations === 'ALL' || organizations?.includes(organizationId)) {
      return;
    }
    throw new NotFoundException(message);
  }

  /** Whether the employee is the caller's own (their records are visible to them). */
  async isOwnEmployee(
    userId: string,
    employeeId: string,
    client: TimeClient = this.prisma,
  ) {
    const user = await client.user.findUnique({
      where: { id: userId },
      select: { person: { select: { employee: { select: { id: true } } } } },
    });
    return user?.person?.employee?.id === employeeId;
  }

  /**
   * Batch 4F (D4): 404 (with the given message) when the position's organization is one in
   * which the caller holds none of the permissions; callers then apply their own 403 checks.
   * A record of the caller's own employee is always visible to them (their 403 rules apply).
   */
  async assertPositionVisible(
    userId: string,
    positionId: string,
    permissions: readonly string[],
    message: string,
    client: TimeClient = this.prisma,
    subjectEmployeeId?: string,
  ) {
    if (
      subjectEmployeeId &&
      (await this.isOwnEmployee(userId, subjectEmployeeId, client))
    ) {
      return;
    }
    await this.assertOrganizationVisible(
      userId,
      await this.positionOrganizationId(positionId, client),
      permissions,
      client,
      message,
    );
  }

  /**
   * Batch 4F (D5): the positions of an organization on which the caller holds the permission,
   * for list queries that must apply authorization in the database before any row limit:
   * 'ALL' when a SYSTEM or organization-wide grant covers the whole organization, otherwise the
   * explicit list (possibly empty). null when the caller holds the permission nowhere in the
   * organization (the organization is not visible to them). Each position is checked with the
   * same canAccess rule as single records, so the list never drifts from it.
   */
  async readablePositionIds(
    userId: string,
    permission: string,
    organizationId: string,
    client: TimeClient = this.prisma,
  ): Promise<'ALL' | string[] | null> {
    const visible = await this.timeOrganizations(userId, [permission], client);
    if (!visible) return null;
    if (visible !== 'ALL' && !visible.includes(organizationId)) return null;
    if (
      await this.authorization.canAccess(
        userId,
        permission,
        { type: 'ORGANIZATION', id: organizationId },
        client,
      )
    ) {
      return 'ALL';
    }
    const positions = await client.position.findMany({
      where: { organizationId },
      select: { id: true },
    });
    const allowed: string[] = [];
    for (const position of positions) {
      const scope = await this.targets.scopeForPosition(
        position.id,
        organizationId,
        client,
      );
      if (
        await this.authorization.canAccess(userId, permission, scope, client)
      ) {
        allowed.push(position.id);
      }
    }
    return allowed;
  }

  private async positionOrganizationId(positionId: string, client: TimeClient) {
    const position = await client.position.findUnique({
      where: { id: positionId },
      select: { organizationId: true },
    });
    return position?.organizationId ?? '';
  }

  /**
   * Batch 4F (D4): an employee none of whose non-cancelled assignments is in an organization
   * where the caller holds one of the permissions is answered 404, like a missing employee.
   */
  private async assertEmployeeVisible(
    userId: string,
    employeeId: string,
    permissions: readonly string[],
    client: TimeClient,
  ) {
    if (await this.isOwnEmployee(userId, employeeId, client)) return;
    const visible = await this.timeOrganizations(userId, permissions, client);
    if (visible === 'ALL') return;
    const assignments = await client.employmentAssignment.findMany({
      where: { employeeId, status: { not: 'CANCELLED' } },
      select: { position: { select: { organizationId: true } } },
    });
    if (
      !visible ||
      !assignments.some((a) => visible.includes(a.position.organizationId))
    ) {
      throw new NotFoundException('Employee not found.');
    }
  }

  private async assertCorrectionVisible(
    actorUserId: string,
    request: {
      employmentAssignmentId: string | null;
      timeEntryId: string | null;
      targetEmploymentAssignmentId: string | null;
    },
    client: TimeClient,
  ) {
    const organizationId = await this.correctionOrganizationId(request, client);
    if (!organizationId) return;
    await this.assertOrganizationVisible(
      actorUserId,
      organizationId,
      ['time.approve', 'time.correct'],
      client,
      'Time correction request not found.',
    );
  }

  /**
   * Batch 4F (D1): who may decide (or replay a decision on) a correction request, checked
   * before its state is revealed. A request of an organization where the actor holds neither
   * time.approve nor time.correct is answered 404 (unless the actor is its requestor or
   * subject, who can see it in My Time: 403); anyone else without time.approve on every
   * assignment the request touches gets 403. The full draft
   * checks (feature gate, coverage assignments, finalized time) still run for a pending one.
   */
  private async assertCorrectionDecisionAuthority(
    actorUserId: string,
    request: {
      employeeId: string;
      requestorUserId: string;
      employmentAssignmentId: string | null;
      timeEntryId: string | null;
      targetEmploymentAssignmentId: string | null;
    },
    verb: 'approve' | 'reject',
    action: string,
    context: TimeRequestContext,
    client: TimeClient,
  ) {
    // The requestor and the employee it is about can see the request (My Time), so these
    // stay 403; they reveal nothing to anyone else.
    if (request.requestorUserId === actorUserId) {
      throw new ForbiddenException(
        `Users cannot ${verb} their own correction request.`,
      );
    }
    // Never a decision on one's own time, whoever filed the request (no override).
    await this.assertNotSelfTarget(
      actorUserId,
      request.employeeId,
      'time.approve',
      action,
      context,
      client,
    );
    const organizationId = await this.correctionOrganizationId(request, client);
    if (!organizationId) {
      throw new NotFoundException('Time correction request not found.');
    }
    await this.assertCorrectionVisible(actorUserId, request, client);
    const assignmentIds = new Set<string>();
    if (request.employmentAssignmentId)
      assignmentIds.add(request.employmentAssignmentId);
    if (request.targetEmploymentAssignmentId)
      assignmentIds.add(request.targetEmploymentAssignmentId);
    if (request.timeEntryId) {
      const entry = await client.timeEntry.findUnique({
        where: { id: request.timeEntryId },
        select: { employmentAssignmentId: true },
      });
      if (entry) assignmentIds.add(entry.employmentAssignmentId);
    }
    const assignments = await client.employmentAssignment.findMany({
      where: { id: { in: [...assignmentIds] } },
      select: { positionId: true },
    });
    for (const positionId of new Set(assignments.map((a) => a.positionId))) {
      const scope = await this.targets.scopeForPosition(
        positionId,
        undefined,
        client,
      );
      if (
        !(await this.authorization.canAccess(
          actorUserId,
          'time.approve',
          scope,
          client,
        ))
      ) {
        throw new ForbiddenException(
          'Missing permission time.approve for the requested assignment.',
        );
      }
    }
  }

  private assertTimesheetVisible(
    actorUserId: string,
    sheet: { timePeriod: { organizationId: string } },
    client: TimeClient,
  ) {
    return this.assertOrganizationVisible(
      actorUserId,
      sheet.timePeriod.organizationId,
      ['time.timesheet.approve', 'time.timesheet.manage'],
      client,
      'Timesheet not found.',
    );
  }

  /** The organization a correction request is about (its entry's or assignment's). */
  private async correctionOrganizationId(
    request: {
      employmentAssignmentId: string | null;
      timeEntryId: string | null;
      targetEmploymentAssignmentId: string | null;
    },
    client: TimeClient,
  ) {
    let assignmentId =
      request.employmentAssignmentId ?? request.targetEmploymentAssignmentId;
    if (!assignmentId && request.timeEntryId) {
      assignmentId =
        (
          await client.timeEntry.findUnique({
            where: { id: request.timeEntryId },
            select: { employmentAssignmentId: true },
          })
        )?.employmentAssignmentId ?? null;
    }
    return assignmentId
      ? this.assignmentOrganizationId(assignmentId, client)
      : null;
  }

  private async refreshTimesheetIfMutable(
    timesheetId: string,
    client: TimeClient,
  ) {
    const sheet = await this.timesheetById(timesheetId, client);
    if (!sheet) throw new NotFoundException('Timesheet not found.');
    if (sheet.status === 'APPROVED' || sheet.status === 'LOCKED') return sheet;
    const now = this.clock.now();
    const organizationId = sheet.timePeriod.organizationId;
    // Batch 4B (D3): only entries of the period's organization.
    const entries = await client.timeEntry.findMany({
      where: {
        employeeId: sheet.employeeId,
        status: 'CLOSED',
        archivedAt: null,
        workDate: {
          gte: sheet.timePeriod.startDate,
          lte: sheet.timePeriod.endDate,
        },
        employmentAssignment: { position: { organizationId } },
      },
      include: {
        breaks: { where: { removedAt: null }, orderBy: { startAt: 'asc' } },
        employmentAssignment: {
          include: { position: { include: positionInclude() } },
        },
      },
      orderBy: [{ workDate: 'asc' }, { clockInAt: 'asc' }],
    });
    const totalsByAssignment = new Map<
      string,
      {
        employmentAssignment: NonNullable<
          Awaited<ReturnType<TimeService['assignmentById']>>
        >;
        grossMinutes: number;
        paidBreakMinutes: number;
        unpaidBreakMinutes: number;
        policyDeductionMinutes: number;
        netWorkedMinutes: number;
      }
    >();

    for (const entry of entries) {
      if (!entry.clockOutAt) continue;
      const current = totalsByAssignment.get(entry.employmentAssignmentId) ?? {
        employmentAssignment: entry.employmentAssignment,
        grossMinutes: 0,
        paidBreakMinutes: 0,
        unpaidBreakMinutes: 0,
        policyDeductionMinutes: 0,
        netWorkedMinutes: 0,
      };
      const minutes = await this.workedMinutesForEntry(
        { ...entry, clockOutAt: entry.clockOutAt },
        client,
      );
      current.grossMinutes += minutes.grossMinutes;
      current.paidBreakMinutes += minutes.paidBreakMinutes;
      current.unpaidBreakMinutes += minutes.unpaidBreakMinutes;
      current.policyDeductionMinutes += minutes.policyDeductionMinutes;
      current.netWorkedMinutes += minutes.netWorkedMinutes;
      totalsByAssignment.set(entry.employmentAssignmentId, current);
    }

    // Another organization's segments (from before 4B) are left exactly as they are.
    const existing = await client.timesheetSegment.findMany({
      where: {
        timesheetId: sheet.id,
        employmentAssignment: { position: { organizationId } },
      },
    });
    const seenAssignmentIds = new Set<string>();
    for (const [employmentAssignmentId, totals] of totalsByAssignment) {
      seenAssignmentIds.add(employmentAssignmentId);
      const previous = existing.find(
        (segment) => segment.employmentAssignmentId === employmentAssignmentId,
      );
      const segmentData = {
        grossMinutes: totals.grossMinutes,
        paidBreakMinutes: totals.paidBreakMinutes,
        unpaidBreakMinutes: totals.unpaidBreakMinutes,
        policyDeductionMinutes: totals.policyDeductionMinutes,
        netWorkedMinutes: totals.netWorkedMinutes,
        calculatedAt: now,
      };
      if (!previous) {
        await client.timesheetSegment.create({
          data: {
            timesheetId: sheet.id,
            employmentAssignmentId,
            status: 'PENDING',
            ...segmentData,
          },
        });
        continue;
      }
      if (previous.status === 'APPROVED') continue;
      await client.timesheetSegment.update({
        where: { id: previous.id },
        data: {
          status:
            previous.status === 'CHANGES_REQUESTED'
              ? 'CHANGES_REQUESTED'
              : 'PENDING',
          approvedWorkedMinutes: 0,
          ...segmentData,
        },
      });
    }

    for (const stale of existing) {
      if (seenAssignmentIds.has(stale.employmentAssignmentId)) continue;
      if (stale.status === 'APPROVED') continue;
      await client.timesheetSegment.update({
        where: { id: stale.id },
        data: {
          grossMinutes: 0,
          paidBreakMinutes: 0,
          unpaidBreakMinutes: 0,
          policyDeductionMinutes: 0,
          netWorkedMinutes: 0,
          approvedWorkedMinutes: 0,
          calculatedAt: now,
        },
      });
    }

    const refreshed = await this.timesheetById(sheet.id, client);
    if (!refreshed) throw new NotFoundException('Timesheet not found.');
    const totals = {
      ...this.timesheetTotals(refreshed.segments),
      secondaryCoverage: await this.secondaryCoverageSummary(refreshed, client),
    };
    return this.scopedTimesheet(
      await client.timesheet.update({
        where: { id: sheet.id },
        data: { totals: jsonMetadata(totals) },
        include: this.timesheetInclude(),
      }),
    );
  }

  /**
   * The authoritative worked-time computation of one closed TimeEntry, shared by timesheets and
   * attendance reporting: gross minus unpaid breaks minus the policy auto-deduction.
   */
  async workedMinutesForEntry(
    entry: {
      id: string;
      employeeId: string;
      clockInAt: Date;
      clockOutAt: Date;
      workDate: Date;
      breaks: Array<{
        startAt: Date;
        endAt: Date | null;
        payType: string | null;
      }>;
      employmentAssignment: NonNullable<
        Awaited<ReturnType<TimeService['assignmentById']>>
      >;
    },
    client: TimeClient = this.prisma,
    /** Batch 4E-1: reuse each (employee, organization, work date) day across a page of reads. */
    dayCache?: Map<string, Promise<Map<string, number>>>,
  ) {
    const { grossMinutes, paidBreakMinutes, unpaidBreakMinutes } =
      entryBreakMinutes(entry);
    const organizationId = entry.employmentAssignment.position.organizationId;
    const dayKey = `${entry.employeeId}|${organizationId}|${entry.workDate.toISOString()}`;
    let day = dayCache?.get(dayKey);
    if (!day) {
      day = this.dayAutoDeductions(
        entry.employeeId,
        organizationId,
        entry.workDate,
        client,
      );
      dayCache?.set(dayKey, day);
    }
    const deductions = await day;
    const policyDeductionMinutes = deductions.get(entry.id) ?? 0;
    return {
      grossMinutes,
      paidBreakMinutes,
      unpaidBreakMinutes,
      policyDeductionMinutes,
      netWorkedMinutes: Math.max(
        0,
        grossMinutes - unpaidBreakMinutes - policyDeductionMinutes,
      ),
    };
  }

  /**
   * Batch 4D (decision D-G) — the automatic unpaid break deduction of one employee, in one
   * organization, on one work date, allocated to that day's closed entries (entry id → minutes).
   *
   * - Only assignments whose policy on that date is breaks.mode AUTO_DEDUCT are eligible. The
   *   eligible assignment with the most gross minutes that day (ties: the earliest clock-in,
   *   then the assignment id) decides the amount (breaks.autoDeductMinutes) and the threshold
   *   (breaks.autoDeductAfterMinutes; unset is 0, so layers written before 4D keep deducting).
   * - It applies once, when the day's gross minutes in the organization reach the threshold.
   * - Recorded unpaid breaks that day count toward it: only the rest is deducted.
   * - The rest goes to that assignment's entries, then to the other eligible assignments (most
   *   gross first, same ties), each entry only up to its gross minus its unpaid breaks, so no
   *   entry or assignment goes negative and the total never exceeds gross worked time.
   * Timesheet totals and payroll snapshot rows both read it (workedMinutesForEntry), so the
   * deduction is never counted twice. Approved and locked snapshots are stored; never recomputed.
   */
  private async dayAutoDeductions(
    employeeId: string,
    organizationId: string,
    workDate: Date,
    client: TimeClient,
  ): Promise<Map<string, number>> {
    const allocation = new Map<string, number>();
    const entries = await client.timeEntry.findMany({
      where: {
        employeeId,
        workDate,
        status: 'CLOSED',
        archivedAt: null,
        clockOutAt: { not: null },
        employmentAssignment: { position: { organizationId } },
      },
      include: {
        breaks: { where: { removedAt: null } },
        employmentAssignment: {
          include: { position: { include: positionInclude() } },
        },
      },
      orderBy: [{ clockInAt: 'asc' }, { id: 'asc' }],
    });
    if (entries.length === 0) return allocation;
    type Day = {
      assignment: (typeof entries)[number]['employmentAssignment'];
      gross: number;
      firstClockIn: number;
      entries: Array<{ id: string; capacity: number }>;
    };
    const byAssignment = new Map<string, Day>();
    let dayGross = 0;
    let dayUnpaid = 0;
    for (const entry of entries) {
      const minutes = entryBreakMinutes({
        ...entry,
        clockOutAt: entry.clockOutAt!,
      });
      dayGross += minutes.grossMinutes;
      dayUnpaid += minutes.unpaidBreakMinutes;
      const day = byAssignment.get(entry.employmentAssignmentId) ?? {
        assignment: entry.employmentAssignment,
        gross: 0,
        firstClockIn: entry.clockInAt.getTime(),
        entries: [],
      };
      day.gross += minutes.grossMinutes;
      day.entries.push({
        id: entry.id,
        capacity: Math.max(
          0,
          minutes.grossMinutes - minutes.unpaidBreakMinutes,
        ),
      });
      byAssignment.set(entry.employmentAssignmentId, day);
    }
    const eligible: Array<
      Day & { policy: TimeAttendancePolicyConfig; assignmentId: string }
    > = [];
    for (const [assignmentId, day] of byAssignment) {
      const policy = await this.effectivePolicyForAssignmentOnWorkDate(
        day.assignment,
        workDate,
        client,
      );
      if (policy.breaks.mode === 'AUTO_DEDUCT') {
        eligible.push({ ...day, policy, assignmentId });
      }
    }
    if (eligible.length === 0) return allocation;
    eligible.sort(
      (a, b) =>
        b.gross - a.gross ||
        a.firstClockIn - b.firstClockIn ||
        a.assignmentId.localeCompare(b.assignmentId),
    );
    const deciding = eligible[0]!.policy.breaks;
    const amount = numericPolicyValue(deciding.autoDeductMinutes) ?? 0;
    const threshold = numericPolicyValue(deciding.autoDeductAfterMinutes) ?? 0;
    if (amount <= 0 || dayGross < threshold) return allocation;
    let remaining = Math.min(Math.max(0, amount - dayUnpaid), dayGross);
    for (const day of eligible) {
      for (const entry of day.entries) {
        if (remaining <= 0) break;
        const taken = Math.min(entry.capacity, remaining);
        if (taken > 0) allocation.set(entry.id, taken);
        remaining -= taken;
      }
      if (remaining <= 0) break;
    }
    return allocation;
  }

  /**
   * Multi-assignment attendance on a timesheet: per assignment, the closed intervals it also
   * covered without owning them, and their net minutes. Informational only — those minutes are
   * already counted (once) in the payroll owner's segment and are never added to any total.
   */
  private async secondaryCoverageSummary(
    sheet: {
      employeeId: string;
      timePeriod: { startDate: Date; endDate: Date; organizationId: string };
    },
    client: TimeClient,
  ) {
    const rows = await client.timeEntryAssignmentCoverage.findMany({
      where: {
        removedAt: null,
        employeeId: sheet.employeeId,
        timeEntry: {
          status: 'CLOSED',
          archivedAt: null,
          workDate: {
            gte: sheet.timePeriod.startDate,
            lte: sheet.timePeriod.endDate,
          },
          // Batch 4B (D3): coverage is same-organization; only the period's organization.
          employmentAssignment: {
            position: { organizationId: sheet.timePeriod.organizationId },
          },
        },
      },
      include: {
        timeEntry: {
          include: {
            breaks: { where: { removedAt: null }, orderBy: { startAt: 'asc' } },
            employmentAssignment: {
              include: { position: { include: positionInclude() } },
            },
          },
        },
      },
      orderBy: [{ employmentAssignmentId: 'asc' }, { createdAt: 'asc' }],
    });
    const summary = new Map<
      string,
      {
        employmentAssignmentId: string;
        entries: number;
        netWorkedMinutes: number;
      }
    >();
    for (const row of rows) {
      const entry = row.timeEntry;
      if (!entry.clockOutAt) continue;
      if (row.employmentAssignmentId === entry.employmentAssignmentId) continue;
      const minutes = await this.workedMinutesForEntry(
        { ...entry, clockOutAt: entry.clockOutAt },
        client,
      );
      const current = summary.get(row.employmentAssignmentId) ?? {
        employmentAssignmentId: row.employmentAssignmentId,
        entries: 0,
        netWorkedMinutes: 0,
      };
      current.entries += 1;
      current.netWorkedMinutes += minutes.netWorkedMinutes;
      summary.set(row.employmentAssignmentId, current);
    }
    return [...summary.values()];
  }

  private async refreshTimesheetsForTimeEntry(
    timeEntryId: string,
    client: Prisma.TransactionClient,
  ) {
    const entry = await client.timeEntry.findUnique({
      where: { id: timeEntryId },
      select: {
        employeeId: true,
        workDate: true,
        employmentAssignment: {
          select: { position: { select: { organizationId: true } } },
        },
      },
    });
    if (!entry) return;
    const sheets = await client.timesheet.findMany({
      where: {
        employeeId: entry.employeeId,
        status: { in: ['OPEN', 'SUBMITTED', 'CHANGES_REQUESTED'] },
        timePeriod: {
          organizationId: entry.employmentAssignment.position.organizationId,
          startDate: { lte: entry.workDate },
          endDate: { gte: entry.workDate },
        },
      },
      select: { id: true },
    });
    for (const sheet of sheets) {
      await this.refreshTimesheetIfMutable(sheet.id, client);
    }
  }

  private async assertTimesheetSubmittable(
    sheet: NonNullable<Awaited<ReturnType<TimeService['timesheetById']>>>,
    client: TimeClient,
    action: 'submitted' | 'approved' = 'submitted',
  ) {
    const dateRange = {
      gte: sheet.timePeriod.startDate,
      lte: sheet.timePeriod.endDate,
    };
    // Batch 4B (D3): only the period's organization's open time, exceptions and corrections.
    const organizationId = sheet.timePeriod.organizationId;
    const inOrganization = { position: { organizationId } };
    const openEntry = await client.timeEntry.findFirst({
      where: {
        employeeId: sheet.employeeId,
        status: 'OPEN',
        archivedAt: null,
        workDate: dateRange,
        employmentAssignment: inOrganization,
      },
      select: { id: true },
    });
    if (openEntry) {
      throw new ConflictException(
        timeError(
          409,
          'TIMESHEET_OPEN_ENTRY',
          `Timesheet cannot be ${action} while a TimeEntry is open.`,
        ),
      );
    }
    const blockingException = await client.attendanceException.findFirst({
      where: {
        employeeId: sheet.employeeId,
        status: 'OPEN',
        workflowImpact: 'SUBMISSION_BLOCKING',
        timeEntry: {
          workDate: dateRange,
          employmentAssignment: inOrganization,
        },
      },
      select: { id: true },
    });
    if (blockingException) {
      throw new ConflictException(
        timeError(
          409,
          'TIMESHEET_BLOCKING_EXCEPTIONS',
          `Timesheet cannot be ${action} with unresolved blocking exceptions.`,
        ),
      );
    }
    const pendingCorrections = await client.timeCorrectionRequest.findMany({
      where: {
        employeeId: sheet.employeeId,
        status: 'PENDING',
      },
      include: {
        timeEntry: {
          include: {
            employmentAssignment: {
              select: { position: { select: { organizationId: true } } },
            },
          },
        },
        employmentAssignment: {
          select: { position: { select: { organizationId: true } } },
        },
        targetEmploymentAssignment: {
          select: { position: { select: { organizationId: true } } },
        },
      },
    });
    // A request naming no organization (none of its assignments is known) still counts.
    const correctionOrganizations = (
      correction: (typeof pendingCorrections)[number],
    ) =>
      [
        correction.timeEntry?.employmentAssignment.position.organizationId,
        correction.employmentAssignment?.position.organizationId,
        correction.targetEmploymentAssignment?.position.organizationId,
      ].filter((id): id is string => id !== undefined);
    if (
      pendingCorrections.some((correction) => {
        const organizations = correctionOrganizations(correction);
        return (
          (organizations.length === 0 ||
            organizations.includes(organizationId)) &&
          this.correctionAffectsTimesheetPeriod(correction, sheet.timePeriod)
        );
      })
    ) {
      throw new ConflictException(
        timeError(
          409,
          'TIMESHEET_PENDING_CORRECTIONS',
          `Timesheet cannot be ${action} with pending correction requests.`,
        ),
      );
    }
  }

  private correctionAffectsTimesheetPeriod(
    correction: {
      timeEntry: { workDate: Date } | null;
      requestedValues: unknown;
    },
    period: { startDate: Date; endDate: Date },
  ) {
    const workDate =
      correction.timeEntry?.workDate ??
      this.requestedWorkDate(correction.requestedValues);
    if (!workDate) return true;
    return (
      period.startDate.getTime() <= workDate.getTime() &&
      workDate.getTime() <= period.endDate.getTime()
    );
  }

  private requestedWorkDate(requestedValues: unknown): Date | null {
    const startAt = jsonObject(requestedValues).startAt;
    if (typeof startAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(startAt)) {
      return null;
    }
    return this.domain.parseDateOnly(startAt.slice(0, 10));
  }

  private async assertTimesheetSegmentAccess(
    userId: string,
    positionId: string,
    permission: 'time.timesheet.approve',
    client: TimeClient,
  ) {
    const scope = await this.targets.scopeForPosition(
      positionId,
      undefined,
      client,
    );
    if (
      !(await this.authorization.canAccess(userId, permission, scope, client))
    ) {
      throw new ForbiddenException(
        `Missing permission ${permission} for the requested timesheet segment.`,
      );
    }
    await this.requireAttendanceForPosition(positionId, client);
  }

  private async assertTimesheetWideAccess(
    userId: string,
    sheet: NonNullable<Awaited<ReturnType<TimeService['timesheetById']>>>,
    permission: 'time.timesheet.approve' | 'time.timesheet.manage',
    client: TimeClient,
  ) {
    if (sheet.segments.length === 0) {
      await this.authorization.assertCan(
        userId,
        permission,
        { type: 'ORGANIZATION', id: sheet.timePeriod.organizationId },
        client,
      );
      await this.features.require(
        sheet.timePeriod.organizationId,
        'ATTENDANCE',
        client,
      );
      return;
    }
    for (const segment of sheet.segments) {
      const scope = await this.targets.scopeForPosition(
        segment.employmentAssignment.positionId,
        undefined,
        client,
      );
      if (
        !(await this.authorization.canAccess(userId, permission, scope, client))
      ) {
        throw new ForbiddenException(
          `Missing permission ${permission} for the requested timesheet.`,
        );
      }
    }
    await this.features.require(
      sheet.timePeriod.organizationId,
      'ATTENDANCE',
      client,
    );
  }

  private async finalizeTimesheetAfterSegmentReview(
    timesheetId: string,
    actorUserId: string,
    context: TimeRequestContext,
    client: Prisma.TransactionClient,
  ) {
    const now = this.clock.now();
    const sheet = await this.timesheetById(timesheetId, client);
    if (!sheet) throw new NotFoundException('Timesheet not found.');
    if (
      sheet.segments.length === 0 ||
      sheet.segments.some((segment) => segment.status !== 'APPROVED')
    ) {
      return this.timesheetShape(sheet);
    }
    const totals = await this.finalizedTimesheetTotals(
      sheet,
      'APPROVED',
      client,
    );
    // The snapshot is computed now; every segment approved earlier must still match what its
    // reviewer approved, or time changed after that approval and must be reviewed again.
    for (const segment of sheet.segments) {
      const snapshotMinutes = totals.payrollWorkDates
        .filter(
          (output) =>
            output.employmentAssignmentId === segment.employmentAssignmentId,
        )
        .reduce((sum, output) => sum + output.approvedWorkedMinutes, 0);
      if (snapshotMinutes !== segment.approvedWorkedMinutes) {
        throw new ConflictException(
          timeError(
            409,
            'TIMESHEET_SEGMENT_CHANGED',
            'Time on an approved segment changed after it was approved. Request changes on it and review it again.',
            {
              timesheetSegmentId: segment.id,
              approvedWorkedMinutes: segment.approvedWorkedMinutes,
              currentWorkedMinutes: snapshotMinutes,
            },
          ),
        );
      }
    }
    const approved = this.scopedTimesheet(
      await client.timesheet.update({
        where: { id: sheet.id },
        data: {
          status: 'APPROVED',
          approvedByUserId: actorUserId,
          approvedAt: now,
          totals: jsonMetadata(totals),
        },
        include: this.timesheetInclude(),
      }),
    );
    // Batch 4C: the timesheet-level approval is an event and an audit of its own.
    await this.createTimesheetEvent(
      client,
      approved.id,
      null,
      actorUserId,
      'APPROVED',
      null,
      { version: approved.version },
    );
    await this.writeAudit(
      client,
      'TIMESHEET_APPROVED',
      approved.id,
      context,
      {
        employeeId: approved.employeeId,
        timePeriodId: approved.timePeriodId,
        version: approved.version,
        approvedWorkedMinutes: totals.approvedWorkedMinutes,
      },
      'Timesheet',
    );
    if (await this.autoLockOnApprovalEnabled(approved, client)) {
      return this.lockTimesheetInternal(
        actorUserId,
        approved.id,
        context,
        client,
        {
          skipAuthorization: true,
        },
      );
    }
    return this.timesheetShape(approved);
  }

  private async lockTimesheetInternal(
    actorUserId: string,
    timesheetId: string,
    context: TimeRequestContext,
    client: Prisma.TransactionClient,
    options: { skipAuthorization?: boolean; expectedVersion?: number } = {},
  ) {
    const now = this.clock.now();
    const sheet = await this.timesheetById(timesheetId, client);
    if (!sheet) throw new NotFoundException('Timesheet not found.');
    if (!options.skipAuthorization) {
      await this.assertTimesheetVisible(actorUserId, sheet, client);
      await this.assertTimesheetWideAccess(
        actorUserId,
        sheet,
        'time.timesheet.manage',
        client,
      );
      await this.assertNotSelfTarget(
        actorUserId,
        sheet.employeeId,
        'time.timesheet.manage',
        'TIMESHEET_LOCK',
        context,
        client,
        { allowSystemOverride: true },
      );
    }
    if (sheet.status === 'LOCKED') return this.timesheetShape(sheet);
    this.assertExpectedVersion(sheet, options.expectedVersion);
    // Only an approved timesheet is locked; its segments were all approved with it.
    if (sheet.status !== 'APPROVED') {
      throw new ConflictException(
        timeError(
          409,
          'TIMESHEET_NOT_APPROVED',
          'Timesheet cannot be locked until all segments are approved.',
          { status: sheet.status },
        ),
      );
    }
    // Batch 4A: the lock keeps the approved payroll snapshot exactly. Nothing is recalculated
    // from live entries; only each row's finalizationStatus becomes LOCKED.
    const approvedTotals = jsonObject(sheet.totals);
    const approvedRows = approvedTotals.payrollWorkDates;
    if (!Array.isArray(approvedRows)) {
      throw new ConflictException(
        timeError(
          409,
          'TIMESHEET_SNAPSHOT_MISSING',
          'This approved timesheet has no payroll snapshot. Reopen it and approve it again.',
        ),
      );
    }
    const updated = await client.timesheet.updateMany({
      where: { id: sheet.id, status: 'APPROVED' },
      data: {
        status: 'LOCKED',
        lockedByUserId: actorUserId,
        lockedAt: now,
        totals: jsonMetadata({
          ...approvedTotals,
          payrollWorkDates: approvedRows.map((row: unknown) =>
            isPlainRecord(row) ? { ...row, finalizationStatus: 'LOCKED' } : row,
          ),
        }),
      },
    });
    if (updated.count === 0) {
      const current = await this.timesheetById(timesheetId, client);
      if (current?.status === 'LOCKED') return this.timesheetShape(current);
      throw new ConflictException('Timesheet cannot be locked.');
    }
    const locked = await this.timesheetById(timesheetId, client);
    if (!locked) throw new NotFoundException('Timesheet not found.');
    await this.createTimesheetEvent(
      client,
      sheet.id,
      null,
      actorUserId,
      'LOCKED',
      null,
    );
    await this.writeAudit(
      client,
      'TIMESHEET_LOCKED',
      sheet.id,
      context,
      {
        employeeId: sheet.employeeId,
        timePeriodId: sheet.timePeriodId,
        version: sheet.version,
      },
      'Timesheet',
    );
    return this.timesheetShape(locked);
  }

  private async createTimesheetEvent(
    client: Prisma.TransactionClient,
    timesheetId: string,
    segmentId: string | null,
    actorUserId: string | null,
    type:
      | 'SUBMITTED'
      | 'SEGMENT_APPROVED'
      | 'CHANGES_REQUESTED'
      | 'LOCKED'
      | 'REOPENED'
      | 'APPROVED',
    note: string | null | undefined,
    metadata: Record<string, unknown> = {},
  ) {
    await client.timesheetEvent.create({
      data: {
        timesheetId,
        segmentId,
        actorUserId,
        type,
        note: note?.trim() || null,
        metadata: jsonMetadata(metadata),
      },
    });
  }

  async approvedPayrollTimeOutputs(
    timesheetId: string,
    client: TimeClient = this.prisma,
  ) {
    const sheet = await this.timesheetById(timesheetId, client);
    if (!sheet) throw new NotFoundException('Timesheet not found.');
    if (sheet.status !== 'APPROVED' && sheet.status !== 'LOCKED') {
      throw new ConflictException(
        'Only approved or locked timesheets can be exported for payroll.',
      );
    }
    return {
      timesheetId: sheet.id,
      employeeId: sheet.employeeId,
      timePeriodId: sheet.timePeriodId,
      status: sheet.status,
      version: sheet.version,
      totals: sheet.totals,
      // Batch 4B: only the period's organization's assignments.
      workDateOutputs: payrollWorkDateOutputsFromTotals(sheet.totals).filter(
        (output) =>
          sheet.segments.some(
            (segment) =>
              segment.employmentAssignmentId === output.employmentAssignmentId,
          ),
      ),
      segments: sheet.segments.map((segment) => ({
        id: segment.id,
        employmentAssignmentId: segment.employmentAssignmentId,
        approvedWorkedMinutes: segment.approvedWorkedMinutes,
        grossMinutes: segment.grossMinutes,
        paidBreakMinutes: segment.paidBreakMinutes,
        unpaidBreakMinutes: segment.unpaidBreakMinutes,
        policyDeductionMinutes: segment.policyDeductionMinutes,
        netWorkedMinutes: segment.netWorkedMinutes,
      })),
    };
  }

  private async autoLockOnApprovalEnabled(
    sheet: NonNullable<Awaited<ReturnType<TimeService['timesheetById']>>>,
    client: TimeClient,
  ) {
    const segment = sheet.segments[0];
    if (!segment) return false;
    const policy = await this.effectivePolicyForAssignmentOnWorkDate(
      segment.employmentAssignment,
      sheet.timePeriod.startDate,
      client,
    );
    return policy.timesheet.autoLockOnApproval === true;
  }

  private timesheetTotals(
    segments: Array<{
      grossMinutes: number;
      paidBreakMinutes: number;
      unpaidBreakMinutes: number;
      policyDeductionMinutes: number;
      netWorkedMinutes: number;
      approvedWorkedMinutes: number;
    }>,
  ) {
    return segments.reduce(
      (total, segment) => ({
        grossMinutes: total.grossMinutes + segment.grossMinutes,
        paidBreakMinutes: total.paidBreakMinutes + segment.paidBreakMinutes,
        unpaidBreakMinutes:
          total.unpaidBreakMinutes + segment.unpaidBreakMinutes,
        policyDeductionMinutes:
          total.policyDeductionMinutes + segment.policyDeductionMinutes,
        netWorkedMinutes: total.netWorkedMinutes + segment.netWorkedMinutes,
        approvedWorkedMinutes:
          total.approvedWorkedMinutes + segment.approvedWorkedMinutes,
      }),
      {
        grossMinutes: 0,
        paidBreakMinutes: 0,
        unpaidBreakMinutes: 0,
        policyDeductionMinutes: 0,
        netWorkedMinutes: 0,
        approvedWorkedMinutes: 0,
      },
    );
  }

  private async finalizedTimesheetTotals(
    sheet: NonNullable<Awaited<ReturnType<TimeService['timesheetById']>>>,
    finalizationStatus: 'APPROVED' | 'LOCKED',
    client: TimeClient,
  ) {
    return {
      ...this.timesheetTotals(sheet.segments),
      secondaryCoverage: await this.secondaryCoverageSummary(sheet, client),
      payrollWorkDates: await this.payrollWorkDateOutputs(
        sheet,
        finalizationStatus,
        client,
      ),
    };
  }

  private async payrollWorkDateOutputs(
    sheet: NonNullable<Awaited<ReturnType<TimeService['timesheetById']>>>,
    finalizationStatus: 'APPROVED' | 'LOCKED',
    client: TimeClient,
  ): Promise<PayrollApprovedTimeOutput[]> {
    const segmentByAssignment = new Map(
      sheet.segments.map((segment) => [
        segment.employmentAssignmentId,
        segment,
      ]),
    );
    const rows = await client.timeEntry.findMany({
      where: {
        employeeId: sheet.employeeId,
        status: 'CLOSED',
        archivedAt: null,
        employmentAssignmentId: { in: [...segmentByAssignment.keys()] },
        workDate: {
          gte: sheet.timePeriod.startDate,
          lte: sheet.timePeriod.endDate,
        },
      },
      include: {
        breaks: { where: { removedAt: null }, orderBy: { startAt: 'asc' } },
        employmentAssignment: {
          include: { position: { include: positionInclude() } },
        },
      },
      orderBy: [{ workDate: 'asc' }, { clockInAt: 'asc' }],
    });
    const outputs = new Map<string, PayrollApprovedTimeOutput>();
    for (const entry of rows) {
      if (!entry.clockOutAt) continue;
      const segment = segmentByAssignment.get(entry.employmentAssignmentId);
      if (!segment) continue;
      const key = `${entry.employmentAssignmentId}:${dateOnly(entry.workDate)}`;
      const previous = outputs.get(key);
      // Batch 4D (D-G): the same calculation as the timesheet totals (workedMinutesForEntry),
      // including the day's automatic deduction allocated to this entry.
      const {
        grossMinutes,
        paidBreakMinutes,
        unpaidBreakMinutes,
        policyDeductionMinutes,
        netWorkedMinutes,
      } = await this.workedMinutesForEntry(
        { ...entry, clockOutAt: entry.clockOutAt },
        client,
      );
      outputs.set(key, {
        employeeId: sheet.employeeId,
        employmentAssignmentId: entry.employmentAssignmentId,
        timePeriodId: sheet.timePeriodId,
        workDate: dateOnly(entry.workDate) ?? '',
        grossMinutes: (previous?.grossMinutes ?? 0) + grossMinutes,
        paidBreakMinutes: (previous?.paidBreakMinutes ?? 0) + paidBreakMinutes,
        unpaidBreakMinutes:
          (previous?.unpaidBreakMinutes ?? 0) + unpaidBreakMinutes,
        policyDeductionMinutes:
          (previous?.policyDeductionMinutes ?? 0) + policyDeductionMinutes,
        approvedWorkedMinutes:
          (previous?.approvedWorkedMinutes ?? 0) + netWorkedMinutes,
        finalizationStatus,
        timesheetId: sheet.id,
        timesheetSegmentId: segment.id,
        timesheetVersion: sheet.version,
      });
    }
    return [...outputs.values()];
  }

  private periodShape(period: {
    id: string;
    organizationId: string;
    startDate: Date;
    endDate: Date;
    status: string;
    cadence: string;
    openedAt: Date | null;
    closedAt: Date | null;
    lockedAt: Date | null;
  }) {
    return {
      id: period.id,
      organizationId: period.organizationId,
      startDate: dateOnly(period.startDate),
      endDate: dateOnly(period.endDate),
      status: period.status,
      cadence: period.cadence,
      openedAt: period.openedAt?.toISOString() ?? null,
      closedAt: period.closedAt?.toISOString() ?? null,
      lockedAt: period.lockedAt?.toISOString() ?? null,
    };
  }

  private timesheetShape(sheet: {
    id: string;
    employeeId: string;
    timePeriodId: string;
    status: string;
    submittedByUserId: string | null;
    submittedAt: Date | null;
    approvedByUserId: string | null;
    approvedAt: Date | null;
    lockedByUserId: string | null;
    lockedAt: Date | null;
    reopenedByUserId: string | null;
    reopenedAt: Date | null;
    reviewerNote: string | null;
    version: number;
    totals: unknown;
    /** Segments left out of this view (another organization's, or not readable): Batch 4B. */
    outOfScopeSegments?: number;
    timePeriod?: {
      id: string;
      organizationId: string;
      startDate: Date;
      endDate: Date;
      status: string;
      cadence: string;
      openedAt: Date | null;
      closedAt: Date | null;
      lockedAt: Date | null;
    };
    segments?: Array<{
      id: string;
      timesheetId: string;
      employmentAssignmentId: string;
      status: string;
      reviewedByUserId: string | null;
      reviewedAt: Date | null;
      reviewerNote: string | null;
      grossMinutes: number;
      paidBreakMinutes: number;
      unpaidBreakMinutes: number;
      policyDeductionMinutes: number;
      netWorkedMinutes: number;
      approvedWorkedMinutes: number;
      calculatedAt: Date | null;
      employmentAssignment?: NonNullable<
        Awaited<ReturnType<TimeService['assignmentById']>>
      >;
    }>;
    events?: Array<{
      id: string;
      segmentId: string | null;
      actorUserId: string | null;
      type: string;
      note: string | null;
      metadata: unknown;
      occurredAt: Date;
    }>;
  }) {
    return {
      id: sheet.id,
      employeeId: sheet.employeeId,
      timePeriodId: sheet.timePeriodId,
      status: sheet.status,
      submittedByUserId: sheet.submittedByUserId,
      submittedAt: sheet.submittedAt?.toISOString() ?? null,
      approvedByUserId: sheet.approvedByUserId,
      approvedAt: sheet.approvedAt?.toISOString() ?? null,
      lockedByUserId: sheet.lockedByUserId,
      lockedAt: sheet.lockedAt?.toISOString() ?? null,
      reopenedByUserId: sheet.reopenedByUserId,
      reopenedAt: sheet.reopenedAt?.toISOString() ?? null,
      reviewerNote: sheet.reviewerNote,
      version: sheet.version,
      totals: this.shownTotals(sheet),
      period: sheet.timePeriod ? this.periodShape(sheet.timePeriod) : null,
      segments: (sheet.segments ?? []).map((segment) => ({
        id: segment.id,
        employmentAssignmentId: segment.employmentAssignmentId,
        status: segment.status,
        reviewedByUserId: segment.reviewedByUserId,
        reviewedAt: segment.reviewedAt?.toISOString() ?? null,
        reviewerNote: segment.reviewerNote,
        grossMinutes: segment.grossMinutes,
        paidBreakMinutes: segment.paidBreakMinutes,
        unpaidBreakMinutes: segment.unpaidBreakMinutes,
        policyDeductionMinutes: segment.policyDeductionMinutes,
        netWorkedMinutes: segment.netWorkedMinutes,
        approvedWorkedMinutes: segment.approvedWorkedMinutes,
        calculatedAt: segment.calculatedAt?.toISOString() ?? null,
        assignment: segment.employmentAssignment
          ? this.assignmentShape(segment.employmentAssignment)
          : null,
      })),
      events: (sheet.events ?? [])
        .filter(
          (event) =>
            !sheet.outOfScopeSegments ||
            event.segmentId === null ||
            (sheet.segments ?? []).some(
              (segment) => segment.id === event.segmentId,
            ),
        )
        .map((event) => ({
          id: event.id,
          segmentId: event.segmentId,
          actorUserId: event.actorUserId,
          type: event.type,
          note: event.note,
          metadata: event.metadata,
          occurredAt: event.occurredAt.toISOString(),
        })),
    };
  }

  /**
   * The totals a reader sees. When segments were left out of the view (another organization's,
   * Batch 4B, or a manager's unreadable ones), the stored totals are never shown as they are:
   * the minute sums come from the shown segments and the payroll and coverage rows are limited
   * to their assignments (`limitedToShownSegments`). The stored totals themselves (an approved
   * payroll snapshot) are never changed.
   */
  private shownTotals(sheet: {
    totals: unknown;
    outOfScopeSegments?: number;
    segments?: Array<{
      employmentAssignmentId: string;
      grossMinutes: number;
      paidBreakMinutes: number;
      unpaidBreakMinutes: number;
      policyDeductionMinutes: number;
      netWorkedMinutes: number;
      approvedWorkedMinutes: number;
    }>;
  }) {
    const segments = sheet.segments ?? [];
    if (sheet.totals === null || sheet.totals === undefined) {
      return this.timesheetTotals(segments);
    }
    if (!sheet.outOfScopeSegments) return sheet.totals;
    const stored = jsonObject(sheet.totals);
    const shown = new Set(
      segments.map((segment) => segment.employmentAssignmentId),
    );
    const limit = (value: unknown) =>
      Array.isArray(value)
        ? value.filter(
            (row) =>
              isPlainRecord(row) &&
              shown.has(String(row.employmentAssignmentId)),
          )
        : value;
    return {
      ...stored,
      ...this.timesheetTotals(segments),
      ...('payrollWorkDates' in stored
        ? { payrollWorkDates: limit(stored.payrollWorkDates) }
        : {}),
      ...('secondaryCoverage' in stored
        ? { secondaryCoverage: limit(stored.secondaryCoverage) }
        : {}),
      limitedToShownSegments: true,
    };
  }

  private correctionById(id: string, client: TimeClient) {
    return client.timeCorrectionRequest.findUnique({
      where: { id },
      include: { adjustment: true },
    });
  }

  private timeEntryById(id: string, client: TimeClient) {
    return client.timeEntry.findUnique({
      where: { id },
      include: {
        assignmentCoverages: activeCoverageInclude(),
        breaks: { where: { removedAt: null }, orderBy: { startAt: 'asc' } },
        employmentAssignment: {
          include: {
            position: {
              include: {
                jobTitle: true,
                organization: true,
                organizationalUnit: true,
                department: true,
                team: true,
                workLocation: true,
              },
            },
          },
        },
      },
    });
  }

  private async buildCorrectionDraft(
    employeeId: string,
    dto: CreateTimeCorrectionRequestDto,
    now: Date,
    client: TimeClient,
    options: { selfService: boolean },
  ) {
    const reason = normalizedReason(dto.reason);
    if (!reason) throw new BadRequestException('reason is required.');
    if (dto.type === 'ADD_MISSING_TIME_ENTRY') {
      if (!dto.employmentAssignmentId || !dto.startAt || !dto.endAt) {
        throw new BadRequestException(
          'employmentAssignmentId, startAt, and endAt are required.',
        );
      }
      const assignment = await this.requireCorrectionAssignment(
        employeeId,
        dto.employmentAssignmentId,
        client,
      );
      const timezone = this.assignmentTimezone(assignment);
      const startAt = this.domain.parseLocalDateTime(dto.startAt, timezone);
      const endAt = this.domain.parseLocalDateTime(dto.endAt, timezone);
      this.assertInterval(startAt, endAt, 'endAt');
      this.assertNotInFuture(endAt, now, 'endAt');
      this.assertEntryDuration(
        startAt,
        endAt,
        await this.effectivePolicyForAssignmentOnWorkDate(
          assignment,
          this.domain.parseDateOnly(
            this.domain.deriveWorkDate(startAt, timezone),
          ),
          client,
        ),
      );
      this.assertAssignmentCoversInterval(assignment, startAt, timezone);
      await this.assertNoTimeEntryOverlap(
        employeeId,
        startAt,
        endAt,
        null,
        client,
      );
      return {
        type: dto.type,
        employeeId,
        timeEntryId: null,
        breakEntryId: null,
        employmentAssignmentId: assignment.id,
        targetEmploymentAssignmentId: null,
        policyAssignment: assignment,
        requestedValues: { startAt: dto.startAt, endAt: dto.endAt },
        currentValues: {},
        effective: { startAt, endAt, assignment },
        reason,
      };
    }

    if (!dto.timeEntryId) {
      throw new BadRequestException('timeEntryId is required.');
    }
    const entry = await this.timeEntryById(dto.timeEntryId, client);
    if (!entry || entry.employeeId !== employeeId) {
      throw new NotFoundException('Time entry not found.');
    }
    if (
      options.selfService &&
      entry.status === 'OPEN' &&
      dto.type !== 'ADD_MISSING_CLOCK_OUT'
    ) {
      throw new BadRequestException(
        'Open TimeEntry corrections require direct manager or admin correction.',
      );
    }
    const currentValues = this.timeEntrySnapshot(entry);
    const baseClockInAt = entry.clockInAt;
    const baseClockOutAt = entry.clockOutAt;
    let clockInAt = baseClockInAt;
    let clockOutAt = baseClockOutAt;
    let targetAssignment = entry.employmentAssignment;
    const coverageAssignments: Array<
      NonNullable<Awaited<ReturnType<TimeService['assignmentById']>>>
    > = [];
    let breakEntry = null as null | {
      id: string;
      timeEntryId: string;
      startAt: Date;
      endAt: Date | null;
      payType: 'PAID' | 'UNPAID' | null;
      removedAt: Date | null;
    };
    let requestedValues: Record<string, unknown> = {};

    if (dto.type === 'CHANGE_CLOCK_IN') {
      if (!dto.clockInAt)
        throw new BadRequestException('clockInAt is required.');
      clockInAt = this.domain.parseLocalDateTime(dto.clockInAt, entry.timezone);
      requestedValues = { clockInAt: dto.clockInAt };
    } else if (
      dto.type === 'CHANGE_CLOCK_OUT' ||
      dto.type === 'ADD_MISSING_CLOCK_OUT'
    ) {
      if (!dto.clockOutAt)
        throw new BadRequestException('clockOutAt is required.');
      clockOutAt = this.domain.parseLocalDateTime(
        dto.clockOutAt,
        entry.timezone,
      );
      requestedValues = { clockOutAt: dto.clockOutAt };
    } else if (dto.type === 'CHANGE_ASSIGNMENT') {
      if (!dto.targetEmploymentAssignmentId) {
        throw new BadRequestException(
          'targetEmploymentAssignmentId is required.',
        );
      }
      targetAssignment = await this.requireCorrectionAssignment(
        employeeId,
        dto.targetEmploymentAssignmentId,
        client,
      );
      // The payroll owner moves; the interval's other coverage stays and must still share the
      // new owner's organization.
      for (const covered of coveredAssignments(entry)) {
        if (
          covered.isPayrollOwner ||
          covered.employmentAssignmentId === targetAssignment.id
        ) {
          continue;
        }
        this.assertSameCoverageOrganization(
          targetAssignment,
          covered.assignment,
        );
      }
      requestedValues = {
        targetEmploymentAssignmentId: dto.targetEmploymentAssignmentId,
      };
    } else if (dto.type === 'CHANGE_COVERAGE') {
      // Which other assignments the physical interval also covers. Its time and payroll owner
      // are unchanged (the owner moves by CHANGE_ASSIGNMENT); coverage never adds minutes.
      if (options.selfService) {
        throw new BadRequestException(
          'Assignment coverage is corrected directly by a manager or administrator.',
        );
      }
      const additionalIds = additionalCoverage(
        entry.employmentAssignmentId,
        dto.additionalEmploymentAssignmentIds,
      );
      if (sameAssignmentSet(additionalIds, secondaryCoverageIds(entry))) {
        throw new BadRequestException({
          statusCode: 400,
          error: 'Bad Request',
          code: 'TIME_COVERAGE_UNCHANGED',
          message: 'The time entry already covers exactly these assignments.',
        });
      }
      for (const id of additionalIds) {
        const covered = await this.requireCorrectionAssignment(
          employeeId,
          id,
          client,
        );
        this.assertSameCoverageOrganization(
          entry.employmentAssignment,
          covered,
        );
        this.assertAssignmentCoversInterval(
          covered,
          entry.clockInAt,
          entry.timezone,
        );
        // Clocked time never covers a SIGN_IN_ONLY assignment (presence has no duration).
        if (
          attendanceModes(
            await this.effectivePolicyForAssignmentOnWorkDate(
              covered,
              entry.workDate,
              client,
            ),
          ).trackingMode !== 'TIME_CLOCK'
        ) {
          throw new ConflictException({
            statusCode: 409,
            error: 'Conflict',
            code: 'ATTENDANCE_TRACKING_MODE_MISMATCH',
            message:
              'The assignment records attendance by sign-in on that date; it cannot be covered by a time entry.',
          });
        }
        coverageAssignments.push(covered);
      }
      requestedValues = { additionalEmploymentAssignmentIds: additionalIds };
    } else if (
      dto.type === 'CHANGE_BREAK_START' ||
      dto.type === 'CHANGE_BREAK_END' ||
      dto.type === 'REMOVE_BREAK'
    ) {
      if (!dto.breakEntryId)
        throw new BadRequestException('breakEntryId is required.');
      breakEntry = await this.requireBreakForEntry(
        dto.breakEntryId,
        entry.id,
        client,
      );
      if (dto.type === 'CHANGE_BREAK_START') {
        if (!dto.breakStartAt) {
          throw new BadRequestException('breakStartAt is required.');
        }
        requestedValues = { breakStartAt: dto.breakStartAt };
      } else if (dto.type === 'CHANGE_BREAK_END') {
        if (!dto.breakEndAt) {
          throw new BadRequestException('breakEndAt is required.');
        }
        requestedValues = { breakEndAt: dto.breakEndAt };
      } else {
        requestedValues = { removed: true };
      }
    } else if (dto.type === 'ADD_BREAK') {
      if (!dto.breakStartAt || !dto.breakEndAt) {
        throw new BadRequestException(
          'breakStartAt and breakEndAt are required.',
        );
      }
      requestedValues = {
        breakStartAt: dto.breakStartAt,
        breakEndAt: dto.breakEndAt,
      };
    } else if (dto.type === 'ADD_MISSING_CLOCK_IN') {
      throw new BadRequestException(
        'ADD_MISSING_CLOCK_IN is represented by ADD_MISSING_TIME_ENTRY in this batch.',
      );
    }

    this.assertNotInFuture(clockInAt, now, 'clockInAt');
    if (clockOutAt) {
      this.assertInterval(clockInAt, clockOutAt, 'clockOutAt');
      this.assertNotInFuture(clockOutAt, now, 'clockOutAt');
      this.assertEntryDuration(
        clockInAt,
        clockOutAt,
        await this.effectivePolicyForAssignmentOnWorkDate(
          targetAssignment,
          entry.workDate,
          client,
        ),
      );
      await this.assertNoTimeEntryOverlap(
        employeeId,
        clockInAt,
        clockOutAt,
        entry.id,
        client,
      );
      // Batch 5E: the work date is judged in the time zone the corrected entry is stored with
      // (the entry's own, unless the correction moves it to another assignment), exactly as
      // applyCorrection derives the stored work date — not the assignment's current zone, which
      // may have changed since the time was recorded.
      this.assertAssignmentCoversInterval(
        targetAssignment,
        clockInAt,
        this.correctedTimezone(entry, targetAssignment),
      );
    }

    const breakChange = this.effectiveBreakChange(dto, entry, breakEntry);
    if (breakChange) {
      this.assertBreakWithinEntry(breakChange.startAt, breakChange.endAt, {
        clockInAt,
        clockOutAt,
      });
      await this.assertNoBreakOverlap(
        entry.id,
        breakChange.startAt,
        breakChange.endAt,
        breakChange.excludingBreakEntryId,
        client,
      );
    }

    return {
      type: dto.type,
      employeeId,
      timeEntryId: entry.id,
      breakEntryId: breakEntry?.id ?? null,
      employmentAssignmentId: entry.employmentAssignmentId,
      targetEmploymentAssignmentId:
        dto.type === 'CHANGE_ASSIGNMENT' ? targetAssignment.id : null,
      policyAssignment: entry.employmentAssignment,
      requestedValues,
      currentValues,
      effective: {
        entry,
        clockInAt,
        clockOutAt,
        targetAssignment,
        coverageAssignments,
        breakEntry,
        breakChange,
      },
      reason,
    };
  }

  private async applyCorrection(
    client: Prisma.TransactionClient,
    request: { id: string; reason: string; type: TimeCorrectionType } | null,
    draft: Awaited<ReturnType<TimeService['buildCorrectionDraft']>>,
    actorUserId: string,
    source: TimeAdjustmentSource,
    context: TimeRequestContext,
  ) {
    const now = this.clock.now();
    await this.assertCorrectionNotFinalized(draft, client);
    let timeEntryId = draft.timeEntryId;
    let breakEntryId = draft.breakEntryId;
    let employmentAssignmentId = draft.employmentAssignmentId;
    let clearedScheduleLink: {
      scheduledShiftId: string;
      scheduledShiftRevisionId: string | null;
    } | null = null;

    if (draft.type === 'ADD_MISSING_TIME_ENTRY') {
      const { startAt, endAt, assignment } = draft.effective as {
        startAt: Date;
        endAt: Date;
        assignment: NonNullable<
          Awaited<ReturnType<TimeService['assignmentById']>>
        >;
      };
      const timezone = this.assignmentTimezone(assignment);
      const entry = await client.timeEntry.create({
        data: {
          employeeId: draft.employeeId,
          employmentAssignmentId: assignment.id,
          clockInAt: startAt,
          clockOutAt: endAt,
          timezone,
          workDate: this.domain.parseDateOnly(
            this.domain.deriveWorkDate(startAt, timezone),
          ),
          status: 'CLOSED',
          source: 'MANUAL',
        },
      });
      await this.addCoverage(client, entry, [assignment.id]);
      timeEntryId = entry.id;
      employmentAssignmentId = assignment.id;
    } else {
      const effective = draft.effective as {
        entry: NonNullable<Awaited<ReturnType<TimeService['timeEntryById']>>>;
        clockInAt: Date;
        clockOutAt: Date | null;
        targetAssignment: NonNullable<
          Awaited<ReturnType<TimeService['assignmentById']>>
        >;
        coverageAssignments: Array<{ id: string }>;
        breakEntry: { id: string } | null;
        breakChange: {
          startAt: Date;
          endAt: Date;
          excludingBreakEntryId: string | null;
        } | null;
      };
      if (
        draft.type === 'CHANGE_CLOCK_IN' ||
        draft.type === 'CHANGE_CLOCK_OUT' ||
        draft.type === 'ADD_MISSING_CLOCK_OUT' ||
        draft.type === 'CHANGE_ASSIGNMENT'
      ) {
        const timezone = this.correctedTimezone(
          effective.entry,
          effective.targetAssignment,
        );
        // A scheduled shift belongs to one assignment: moving the entry to another assignment
        // ends its expected-work link rather than interpreting it against another job's shift.
        if (
          effective.entry.scheduledShiftId &&
          effective.targetAssignment.id !==
            effective.entry.employmentAssignmentId
        ) {
          clearedScheduleLink = {
            scheduledShiftId: effective.entry.scheduledShiftId,
            scheduledShiftRevisionId: effective.entry.scheduledShiftRevisionId,
          };
        }
        await client.timeEntry.update({
          where: { id: effective.entry.id },
          data: {
            ...(clearedScheduleLink
              ? { scheduledShiftId: null, scheduledShiftRevisionId: null }
              : {}),
            employmentAssignmentId: effective.targetAssignment.id,
            clockInAt: effective.clockInAt,
            clockOutAt: effective.clockOutAt,
            timezone,
            workDate: this.domain.parseDateOnly(
              this.domain.deriveWorkDate(effective.clockInAt, timezone),
            ),
            status: effective.clockOutAt ? 'CLOSED' : 'OPEN',
            // A corrected live entry keeps how it was captured (self-service or kiosk); the
            // correction itself is recorded by its TimeAdjustment.
            source:
              effective.entry.source === 'LIVE_CLOCK' ||
              effective.entry.source === 'KIOSK'
                ? effective.entry.source
                : 'MANUAL',
          },
        });
        if (
          effective.targetAssignment.id !==
          effective.entry.employmentAssignmentId
        ) {
          // The payroll owner moved: the old owner no longer covers the interval, the new one
          // does (after the entry update, so the organization guard sees the new owner).
          await this.removeCoverage(
            client,
            effective.entry.id,
            [effective.entry.employmentAssignmentId],
            now,
          );
          await this.addCoverage(client, effective.entry, [
            effective.targetAssignment.id,
          ]);
        }
        employmentAssignmentId = effective.targetAssignment.id;
      } else if (draft.type === 'CHANGE_COVERAGE') {
        const next = effective.coverageAssignments.map((covered) => covered.id);
        await this.removeCoverage(
          client,
          effective.entry.id,
          secondaryCoverageIds(effective.entry).filter(
            (id) => !next.includes(id),
          ),
          now,
        );
        await this.addCoverage(client, effective.entry, [
          effective.entry.employmentAssignmentId,
          ...next,
        ]);
      } else if (draft.type === 'ADD_BREAK' && effective.breakChange) {
        const policy = await this.effectivePolicyForAssignment(
          effective.entry.employmentAssignment,
          now,
          client,
        );
        const breakEntry = await client.breakEntry.create({
          data: {
            timeEntryId: effective.entry.id,
            startAt: effective.breakChange.startAt,
            endAt: effective.breakChange.endAt,
            payType: this.breakPayType(policy),
          },
        });
        breakEntryId = breakEntry.id;
      } else if (
        (draft.type === 'CHANGE_BREAK_START' ||
          draft.type === 'CHANGE_BREAK_END') &&
        effective.breakChange &&
        effective.breakEntry
      ) {
        await client.breakEntry.update({
          where: { id: effective.breakEntry.id },
          data: {
            startAt: effective.breakChange.startAt,
            endAt: effective.breakChange.endAt,
          },
        });
      } else if (draft.type === 'REMOVE_BREAK' && effective.breakEntry) {
        await client.breakEntry.update({
          where: { id: effective.breakEntry.id },
          data: { removedAt: now },
        });
      }
    }

    const adjustment = await client.timeAdjustment.create({
      data: {
        correctionRequestId: request?.id ?? null,
        employeeId: draft.employeeId,
        actorUserId,
        timeEntryId,
        breakEntryId,
        employmentAssignmentId,
        type: draft.type,
        source,
        reason: request?.reason ?? draft.reason,
        previousValues: jsonMetadata(draft.currentValues),
        newValues: jsonMetadata({
          ...draft.requestedValues,
          timeEntryId,
          breakEntryId,
          employmentAssignmentId,
          ...(clearedScheduleLink ? { clearedScheduleLink } : {}),
        }),
        appliedAt: now,
      },
    });
    await this.resolveCorrectionExceptions(
      client,
      draft,
      source === 'EMPLOYEE_AUTO_APPROVED' || source === 'EMPLOYEE_APPROVED'
        ? 'EMPLOYEE_RESOLUTION'
        : source === 'MANAGER_DIRECT'
          ? 'MANAGER_RESOLUTION'
          : 'ADMIN_RESOLUTION',
      now,
    );
    if (timeEntryId) {
      await this.recalculateAttendanceInterpretation(
        timeEntryId,
        client,
        context,
      );
      await this.refreshTimesheetsForTimeEntry(timeEntryId, client);
    }
    await this.writeAudit(
      client,
      request ? 'TIME_ADJUSTMENT_APPLIED' : 'TIME_DIRECT_ADJUSTMENT_APPLIED',
      adjustment.id,
      context,
      {
        employeeId: draft.employeeId,
        correctionRequestId: request?.id ?? null,
        timeEntryId,
        breakEntryId,
        type: draft.type,
        source,
      },
      'TimeAdjustment',
    );
    return adjustment;
  }

  /**
   * The caller's own employee record. Every action requires Time & attendance enabled
   * (Phase 18). Batch 4F (C10): `purpose: 'read'` is for the caller's own history only (My
   * Time reads): it skips that feature gate, never the identity check, so it gives no one
   * access to anything but their own existing records, and every action stays gated.
   */
  private async requireSelfEmployee(
    userId: string,
    client: TimeClient = this.prisma,
    options: { purpose?: 'read' } = {},
  ) {
    const user = await client.user.findUnique({
      where: { id: userId },
      include: { person: { include: { employee: true } } },
    });
    const employee = user?.person?.employee;
    if (!employee || employee.archivedAt) {
      throw new ForbiddenException('Authenticated user is not an employee.');
    }
    if (options.purpose !== 'read') {
      await this.requireAttendanceForEmployee(employee.id, client);
    }
    return employee;
  }

  /** The employee a kiosk identified (by credential); never another employee's data. */
  private async requireKioskEmployee(
    employeeId: string,
    client: TimeClient = this.prisma,
  ) {
    const employee = await client.employee.findUnique({
      where: { id: employeeId },
    });
    if (!employee || employee.archivedAt) {
      throw new ForbiddenException('The employee cannot record attendance.');
    }
    return employee;
  }

  private async requireCorrectionAssignment(
    employeeId: string,
    assignmentId: string,
    client: TimeClient,
  ) {
    const assignment = await this.assignmentById(assignmentId, client);
    if (!assignment) throw new NotFoundException('Assignment not found.');
    if (assignment.employeeId !== employeeId) {
      throw new ForbiddenException('Assignment does not belong to employee.');
    }
    await this.requireAttendanceForPosition(assignment.positionId, client);
    return assignment;
  }

  private async requireBreakForEntry(
    breakEntryId: string,
    timeEntryId: string,
    client: TimeClient,
  ) {
    const breakEntry = await client.breakEntry.findUnique({
      where: { id: breakEntryId },
    });
    if (
      !breakEntry ||
      breakEntry.timeEntryId !== timeEntryId ||
      breakEntry.removedAt
    ) {
      throw new NotFoundException('Break entry not found.');
    }
    return breakEntry;
  }

  private assertInterval(startAt: Date, endAt: Date, endField: string) {
    if (endAt.getTime() <= startAt.getTime()) {
      throw new BadRequestException(`${endField} must be after start time.`);
    }
  }

  private assertAssignmentCoversInterval(
    assignment: {
      status: string;
      startDate: Date;
      endDate: Date | null;
    },
    startAt: Date,
    timezone: string,
  ) {
    // Batch 5E: time belongs to its work date — the local date it starts on (Batch 4D) — so
    // the work date must fall inside the assignment's dates. An overnight shift that starts on
    // an assignment's last day and ends after midnight is covered, exactly as live clock-out
    // records it; its length stays bounded by the entry-duration rule. Before, the end's local
    // date also had to be inside the dates, so a manager could never close (or record) such a
    // shift once the assignment had ended, e.g. after a termination.
    // Batch 5A: a correction may fix the past of an assignment that has since ENDED, for dates
    // it actually covered (never beyond its dates, never a cancelled or planned one). The
    // finalized-time checks of each correction still apply.
    const workDate = this.domain.parseDateOnly(
      this.domain.deriveWorkDate(startAt, timezone),
    );
    const covered = (date: Date) =>
      (assignment.status === 'ACTIVE' || assignment.status === 'ENDED') &&
      assignment.startDate.getTime() <= date.getTime() &&
      (assignment.endDate === null ||
        date.getTime() <= assignment.endDate.getTime());
    if (!covered(workDate)) {
      throw new BadRequestException(
        'Assignment is not active for the requested correction period.',
      );
    }
  }

  private async assertNoTimeEntryOverlap(
    employeeId: string,
    startAt: Date,
    endAt: Date,
    excludingTimeEntryId: string | null,
    client: TimeClient,
  ) {
    const overlapping = await client.timeEntry.findFirst({
      where: {
        employeeId,
        archivedAt: null,
        ...(excludingTimeEntryId ? { id: { not: excludingTimeEntryId } } : {}),
        clockInAt: { lt: endAt },
        // An open entry (no clock-out yet) runs until now: it overlaps anything after its start.
        OR: [{ clockOutAt: { gt: startAt } }, { clockOutAt: null }],
      },
      select: { id: true, status: true },
    });
    if (overlapping) {
      throw new ConflictException(
        timeError(
          409,
          'TIME_ENTRY_OVERLAP',
          overlapping.status === 'OPEN'
            ? 'The time overlaps the employee’s open time entry.'
            : 'Correction would overlap an existing TimeEntry.',
          { timeEntryId: overlapping.id },
        ),
      );
    }
  }

  private effectiveBreakChange(
    dto: CreateTimeCorrectionRequestDto,
    entry: NonNullable<Awaited<ReturnType<TimeService['timeEntryById']>>>,
    breakEntry: {
      id: string;
      startAt: Date;
      endAt: Date | null;
    } | null,
  ) {
    if (dto.type === 'ADD_BREAK') {
      return {
        startAt: this.domain.parseLocalDateTime(
          dto.breakStartAt!,
          entry.timezone,
        ),
        endAt: this.domain.parseLocalDateTime(dto.breakEndAt!, entry.timezone),
        excludingBreakEntryId: null,
      };
    }
    if (!breakEntry || dto.type === 'REMOVE_BREAK') return null;
    const startAt =
      dto.type === 'CHANGE_BREAK_START'
        ? this.domain.parseLocalDateTime(dto.breakStartAt!, entry.timezone)
        : breakEntry.startAt;
    const endAt =
      dto.type === 'CHANGE_BREAK_END'
        ? this.domain.parseLocalDateTime(dto.breakEndAt!, entry.timezone)
        : breakEntry.endAt;
    if (!endAt) {
      throw new BadRequestException('Open breaks cannot be corrected here.');
    }
    return { startAt, endAt, excludingBreakEntryId: breakEntry.id };
  }

  private assertBreakWithinEntry(
    startAt: Date,
    endAt: Date,
    entry: { clockInAt: Date; clockOutAt: Date | null },
  ) {
    this.assertInterval(startAt, endAt, 'breakEndAt');
    if (!entry.clockOutAt) {
      throw new BadRequestException(
        'Break corrections require a closed TimeEntry.',
      );
    }
    if (
      startAt.getTime() < entry.clockInAt.getTime() ||
      endAt.getTime() > entry.clockOutAt.getTime()
    ) {
      throw new BadRequestException(
        'Break correction must stay within the TimeEntry interval.',
      );
    }
  }

  private async assertNoBreakOverlap(
    timeEntryId: string,
    startAt: Date,
    endAt: Date,
    excludingBreakEntryId: string | null,
    client: TimeClient,
  ) {
    const overlapping = await client.breakEntry.findFirst({
      where: {
        timeEntryId,
        removedAt: null,
        endAt: { gt: startAt },
        startAt: { lt: endAt },
        ...(excludingBreakEntryId
          ? { id: { not: excludingBreakEntryId } }
          : {}),
      },
      select: { id: true },
    });
    if (overlapping) {
      throw new ConflictException(
        'Break correction would overlap an existing break.',
      );
    }
  }

  /**
   * Permission on the position a direct correction starts from, checked before the request is
   * validated, so an account without it learns nothing from validation errors (403 first). The
   * full check on the draft (target and coverage assignments) still follows.
   */
  private async preauthorizeCorrection(
    userId: string,
    positionId: string,
    client: TimeClient,
    notFoundMessage = 'Time entry not found.',
    subjectEmployeeId?: string,
  ) {
    // Batch 4F (D4): a record of an organization the caller cannot see at all is answered
    // 404, exactly like a missing one; inside a visible organization, out of scope is 403.
    // The caller's own records are visible to them (My Time): those stay 403.
    if (
      !subjectEmployeeId ||
      !(await this.isOwnEmployee(userId, subjectEmployeeId, client))
    ) {
      await this.assertOrganizationVisible(
        userId,
        await this.positionOrganizationId(positionId, client),
        // time.view makes entries visible (management lists): such a reader gets 403.
        ['time.view', 'time.correct', 'time.approve'],
        client,
        notFoundMessage,
      );
    }
    const scope = await this.targets.scopeForPosition(
      positionId,
      undefined,
      client,
    );
    if (
      !(await this.authorization.canAccess(
        userId,
        'time.correct',
        scope,
        client,
      ))
    ) {
      throw new ForbiddenException(
        'Missing permission time.correct for the requested assignment.',
      );
    }
  }

  private async assertCorrectionAccess(
    userId: string,
    draft: Awaited<ReturnType<TimeService['buildCorrectionDraft']>>,
    permission: 'time.approve' | 'time.correct',
    client: TimeClient,
  ) {
    const positionIds = new Set<string>();
    const effective = draft.effective as Record<string, unknown>;
    const assignment = effective.assignment ?? effective.targetAssignment;
    if (isAssignmentWithPosition(assignment))
      positionIds.add(assignment.positionId);
    const entry = effective.entry;
    if (isEntryWithAssignment(entry)) {
      positionIds.add(entry.employmentAssignment.positionId);
    }
    // A coverage correction needs the permission on every assignment it adds.
    if (Array.isArray(effective.coverageAssignments)) {
      for (const covered of effective.coverageAssignments) {
        if (isAssignmentWithPosition(covered))
          positionIds.add(covered.positionId);
      }
    }
    for (const positionId of positionIds) {
      const scope = await this.targets.scopeForPosition(
        positionId,
        undefined,
        client,
      );
      if (
        !(await this.authorization.canAccess(userId, permission, scope, client))
      ) {
        throw new ForbiddenException(
          `Missing permission ${permission} for the requested assignment.`,
        );
      }
    }
    for (const positionId of positionIds)
      await this.requireAttendanceForPosition(positionId, client);
  }

  private correctionCanAutoApprove(
    type: TimeCorrectionType,
    draft: Awaited<ReturnType<TimeService['buildCorrectionDraft']>>,
    config: TimeAttendancePolicyConfig,
  ): boolean {
    // Kiosk-only attendance is never moved remotely without a manager's review.
    if (attendanceModes(config).captureMode === 'KIOSK_ONLY') return false;
    if (config.correction.approvalMode === 'NO_APPROVAL_REQUIRED') {
      return type === 'CHANGE_CLOCK_IN' || type === 'CHANGE_CLOCK_OUT';
    }
    if (config.correction.approvalMode !== 'AUTO_APPROVE_SAFE') return false;
    if (type !== 'CHANGE_CLOCK_IN' && type !== 'CHANGE_CLOCK_OUT') return false;
    const tolerance = numericPolicyValue(
      config.correction.autoApprovalToleranceMinutes,
    );
    if (tolerance === null) return false;
    const effective = draft.effective as {
      entry: { clockInAt: Date; clockOutAt: Date | null };
      clockInAt: Date;
      clockOutAt: Date | null;
    };
    if (!effective.entry.clockOutAt || !effective.clockOutAt) return false;
    const deltaMinutes =
      Math.abs(
        effective.clockInAt.getTime() - effective.entry.clockInAt.getTime(),
      ) /
        60_000 +
      Math.abs(
        effective.clockOutAt.getTime() - effective.entry.clockOutAt.getTime(),
      ) /
        60_000;
    return deltaMinutes <= tolerance;
  }

  private employeeCorrectionRequestsEnabled(
    config: TimeAttendancePolicyConfig,
  ): boolean {
    return config.correction.employeeRequestsEnabled === true;
  }

  private async resolveCorrectionExceptions(
    client: Prisma.TransactionClient,
    draft: Awaited<ReturnType<TimeService['buildCorrectionDraft']>>,
    resolutionMethod:
      'EMPLOYEE_RESOLUTION' | 'MANAGER_RESOLUTION' | 'ADMIN_RESOLUTION',
    resolvedAt: Date,
  ) {
    if (
      draft.type !== 'ADD_MISSING_CLOCK_OUT' &&
      draft.type !== 'CHANGE_CLOCK_OUT'
    ) {
      return;
    }
    if (!draft.timeEntryId) return;
    await client.attendanceException.updateMany({
      where: {
        timeEntryId: draft.timeEntryId,
        status: 'OPEN',
        type: 'MISSING_CLOCK_OUT',
      },
      data: {
        status: 'RESOLVED',
        resolutionMethod,
        resolvedAt,
      },
    });
  }

  /** Records coverage rows for assignments the interval does not actively cover yet. */
  private async addCoverage(
    client: Prisma.TransactionClient,
    entry: { id: string; employeeId: string },
    employmentAssignmentIds: readonly string[],
  ) {
    if (employmentAssignmentIds.length === 0) return;
    const active = await client.timeEntryAssignmentCoverage.findMany({
      where: { timeEntryId: entry.id, removedAt: null },
      select: { employmentAssignmentId: true },
    });
    const covered = new Set(active.map((row) => row.employmentAssignmentId));
    for (const employmentAssignmentId of employmentAssignmentIds) {
      if (covered.has(employmentAssignmentId)) continue;
      covered.add(employmentAssignmentId);
      await client.timeEntryAssignmentCoverage.create({
        data: {
          timeEntryId: entry.id,
          employeeId: entry.employeeId,
          employmentAssignmentId,
        },
      });
    }
  }

  /** Ends the interval's active coverage of the given assignments (rows are never deleted). */
  private async removeCoverage(
    client: Prisma.TransactionClient,
    timeEntryId: string,
    employmentAssignmentIds: readonly string[],
    now: Date,
  ) {
    if (employmentAssignmentIds.length === 0) return;
    await client.timeEntryAssignmentCoverage.updateMany({
      where: {
        timeEntryId,
        removedAt: null,
        employmentAssignmentId: { in: [...employmentAssignmentIds] },
      },
      data: { removedAt: now },
    });
  }

  /**
   * One interval belongs to one organization: every covered assignment is in the payroll
   * owner's organization (its kiosk, policy and pay group). The database enforces it too.
   */
  private assertSameCoverageOrganization(
    owner: { position: { organizationId: string } },
    covered: { position: { organizationId: string } },
  ) {
    if (covered.position.organizationId !== owner.position.organizationId) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        code: 'TIME_COVERAGE_ORGANIZATION_MISMATCH',
        message:
          'One time entry only covers assignments of the same organization.',
      });
    }
  }

  private async requireEligibleAssignment(
    actorOrUserId: ClockActor | string,
    employee: Awaited<ReturnType<TimeService['requireSelfEmployee']>>,
    assignmentId: string,
    now: Date,
    client: TimeClient,
  ) {
    const actor = asActor(actorOrUserId);
    if (employee.status !== 'ACTIVE') {
      throw new ForbiddenException('Employee is not eligible to clock time.');
    }
    const assignment = await this.assignmentById(assignmentId, client);
    if (!assignment) throw new NotFoundException('Assignment not found.');
    if (assignment.employeeId !== employee.id) {
      throw new ForbiddenException('Assignment does not belong to employee.');
    }
    await this.assertClockAccess(actor, assignment.positionId, client);
    const timezone = this.assignmentTimezone(assignment);
    const localDate = this.domain.deriveWorkDate(now, timezone);
    const date = this.domain.parseDateOnly(localDate);
    if (!this.employeeEffectiveOn(employee, date)) {
      throw new ForbiddenException('Employee is not eligible to clock time.');
    }
    if (!this.assignmentEffectiveOn(assignment, date)) {
      throw new BadRequestException('Assignment is not active for clocking.');
    }
    const policy = await this.effectivePolicyForAssignment(
      assignment,
      now,
      client,
    );
    if (!this.liveClockEnabled(policy)) {
      throw new ForbiddenException(
        domainError(
          403,
          'TIME_CAPTURE_DISABLED',
          'Live clocking is not enabled for this assignment.',
        ),
      );
    }
    const refusal = this.captureRefusal(actor, assignment, policy);
    if (refusal) throw refusal;
    return assignment;
  }

  private async statusForEmployee(
    actorOrUserId: ClockActor | string,
    employee: Awaited<ReturnType<TimeService['requireSelfEmployee']>>,
    now: Date,
    client: TimeClient,
  ) {
    const actor = asActor(actorOrUserId);
    const current = await this.openEntry(employee.id, client);
    const openBreak = current
      ? await this.openBreakForEntry(current.id, client)
      : null;
    const state: ClockState = openBreak
      ? 'ON_BREAK'
      : current
        ? 'CLOCKED_IN'
        : 'OFF_CLOCK';
    const eligibleAssignments =
      current && !openBreak
        ? await this.switchTargets(
            actor,
            employee,
            current.employmentAssignmentId,
            now,
            client,
          )
        : current
          ? []
          : await this.clockInAssignments(actor, employee, now, client);
    const currentPolicy = current
      ? await this.effectivePolicyForAssignment(
          current.employmentAssignment,
          now,
          client,
        )
      : null;
    // Open work is only offered to a channel its capture mode allows (a KIOSK_ONLY entry is
    // closed at the kiosk, not remotely); breaks also need TIME_CLOCK tracking.
    const currentClosable =
      current !== null &&
      currentPolicy !== null &&
      this.captureRefusal(actor, current.employmentAssignment, currentPolicy, {
        closingOnly: true,
      }) === null;
    const breakStartable =
      currentClosable &&
      this.manualBreakEnabled(currentPolicy!) &&
      this.captureRefusal(
        actor,
        current!.employmentAssignment,
        currentPolicy!,
      ) === null;
    const availableActions: TimeAction[] = openBreak
      ? currentClosable
        ? ['END_BREAK', 'CLOCK_OUT']
        : []
      : current
        ? currentClosable
          ? [
              ...(breakStartable ? (['START_BREAK'] as const) : []),
              'CLOCK_OUT',
              ...(eligibleAssignments.length > 0
                ? (['SWITCH_ASSIGNMENT'] as const)
                : []),
            ]
          : []
        : eligibleAssignments.length > 0
          ? ['CLOCK_IN']
          : [];
    const activeExceptions = await this.activeExceptionsForEmployee(
      employee.id,
      client,
    );
    const missedClockOut = activeExceptions.filter(
      (exception) =>
        exception.type === 'MISSING_CLOCK_OUT' &&
        exception.workflowImpact === 'SUBMISSION_BLOCKING',
    );
    if (
      actor.channel === 'KIOSK'
        ? // The kiosk never resolves; it only explains the missed clock-out (its notice).
          (current === null || currentClosable) && missedClockOut.length > 0
        : // Batch 4E-3 (C1): self-service offers it only where the endpoint accepts it: an open
          // entry with the exception, closable from here, whose policy lets employees resolve.
          current !== null &&
          currentClosable &&
          currentPolicy !== null &&
          this.employeeMissedPunchResolutionEnabled(currentPolicy) &&
          missedClockOut.some(
            (exception) => exception.timeEntryId === current.id,
          )
    ) {
      availableActions.push('RESOLVE_MISSED_CLOCK_OUT');
    }
    const schedule = !openBreak
      ? await this.scheduleStatus(employee.id, eligibleAssignments, now, client)
      : null;
    // Phase 9.5: presence (SIGN_IN_ONLY) assignments the actor may sign in for now.
    const signInAssignments = await this.signInAssignments(
      actor,
      employee,
      now,
      client,
    );
    if (signInAssignments.length > 0) availableActions.push('SIGN_IN');
    // Batch 4D (D-H): optional sign-out of an open sign-in (off unless the policy enables it).
    const signOutAssignments = await this.signOutAssignments(
      actor,
      employee,
      now,
      client,
    );
    if (signOutAssignments.length > 0) availableActions.push('SIGN_OUT');

    return {
      state,
      serverTime: now.toISOString(),
      currentTimeEntry: current
        ? {
            id: current.id,
            employmentAssignmentId: current.employmentAssignmentId,
            clockedInAt: current.clockInAt.toISOString(),
            timezone: current.timezone,
            workDate: dateOnly(current.workDate),
            ...(this.schedules
              ? {
                  scheduledShiftId: current.scheduledShiftId,
                  scheduledShiftRevisionId: current.scheduledShiftRevisionId,
                }
              : {}),
          }
        : null,
      currentAssignment: current
        ? this.assignmentShape(current.employmentAssignment)
        : null,
      // Every assignment the open interval covers (payroll owner first); one elapsed time.
      currentCoverage: current
        ? coveredAssignments({
            ...current,
            assignmentCoverages: await this.entryCoverage(current.id, client),
          }).map((covered) => ({
            employmentAssignmentId: covered.employmentAssignmentId,
            assignment: this.assignmentShape(covered.assignment),
            isPayrollOwner: covered.isPayrollOwner,
          }))
        : [],
      currentBreakEntry: openBreak
        ? {
            id: openBreak.id,
            timeEntryId: openBreak.timeEntryId,
            startedAt: openBreak.startAt.toISOString(),
            payType: openBreak.payType,
          }
        : null,
      breakStartedAt: openBreak?.startAt.toISOString() ?? null,
      clockedInAt: current?.clockInAt.toISOString() ?? null,
      eligibleAssignments: eligibleAssignments.map((assignment) =>
        this.assignmentShape(assignment),
      ),
      activeExceptions: activeExceptions.map((exception) =>
        this.exceptionShape(exception),
      ),
      availableActions,
      ...schedule,
      signInAssignments,
      signOutAssignments,
      attendanceModes: await this.attendanceModesForEmployee(
        employee,
        now,
        client,
      ),
      // Batch 4E-3 (C7) / 4F (D2): the occurrences open for sign-in, on every channel (the
      // kiosk offers one choice per occurrence when there are several).
      signInOptions: await this.signInOptions(
        employee.id,
        signInAssignments,
        now,
        client,
      ),
      // Batch 4E-3 (C1): self-service only (the kiosk has its own session view).
      ...(actor.channel === 'SELF_SERVICE'
        ? {
            assignmentCapabilities: await this.assignmentCapabilities(
              actor,
              employee,
              now,
              client,
            ),
          }
        : {}),
    };
  }

  /**
   * Batch 4E-3 (C7) — the published occurrences the employee may confirm presence for now, on
   * the assignments they may sign in for here (never KIOSK_ONLY ones): the same windows as
   * automatic matching, each with the sign-in already confirming it, if any.
   */
  private async signInOptions(
    employeeId: string,
    assignments: Array<{ id: string }>,
    now: Date,
    client: TimeClient,
  ) {
    if (!this.schedules || assignments.length === 0) return [];
    const candidates = await this.schedules.clockInCandidates(
      {
        employeeId,
        employmentAssignmentIds: assignments.map((assignment) => assignment.id),
        at: now,
      },
      client,
    );
    if (candidates.length === 0) return [];
    const active = await client.attendanceSignIn.findMany({
      where: {
        scheduledShiftId: {
          in: candidates.map((candidate) => candidate.scheduledShiftId),
        },
        status: 'ACTIVE',
      },
      select: { id: true, scheduledShiftId: true, signedInAt: true },
    });
    return [...candidates]
      .sort(
        (a, b) =>
          a.startsAt.getTime() - b.startsAt.getTime() ||
          a.scheduledShiftId.localeCompare(b.scheduledShiftId),
      )
      .map((candidate) => {
        const signIn = active.find(
          (row) => row.scheduledShiftId === candidate.scheduledShiftId,
        );
        return {
          ...this.shiftOptionShape(candidate),
          signIn: signIn
            ? { id: signIn.id, signedInAt: signIn.signedInAt.toISOString() }
            : null,
        };
      });
  }

  /**
   * Batch 4E-3 (C1) — every active assignment of the employee, with how attendance is recorded
   * there today and the policy settings that decide which self-service actions exist, so the
   * employee interface can explain an assignment with nothing to do (Attendance switched off,
   * no time zone, no permission, the clock disabled, or kiosk only) instead of hiding it.
   * Informational: every action is still authorized and refused by its own endpoint.
   */
  private async assignmentCapabilities(
    actor: ClockActor,
    employee: Awaited<ReturnType<TimeService['requireSelfEmployee']>>,
    now: Date,
    client: TimeClient,
  ) {
    const result = [];
    for (const assignment of await this.assignmentsForEmployee(
      employee.id,
      client,
    )) {
      const timezone = this.resolvedTimezone(assignment);
      const attendanceEnabled = await this.attendanceEnabledForPosition(
        assignment.positionId,
        client,
      );
      const permitted = await this.canClockAssignmentRaw(
        actor,
        assignment.positionId,
        client,
      );
      const policy = timezone
        ? await this.effectivePolicyForAssignment(assignment, now, client)
        : null;
      const modes = policy ? attendanceModes(policy) : null;
      const clockEnabled = policy ? this.liveClockEnabled(policy) : false;
      const selfService = modes
        ? captureAllows(modes.captureMode, 'SELF_SERVICE')
        : false;
      const unavailableReason = !attendanceEnabled
        ? ('ATTENDANCE_DISABLED' as const)
        : !timezone
          ? ('NO_TIMEZONE' as const)
          : !clockEnabled
            ? ('CLOCK_DISABLED' as const)
            : !permitted
              ? ('NO_PERMISSION' as const)
              : !selfService
                ? ('KIOSK_ONLY' as const)
                : null;
      result.push({
        employmentAssignmentId: assignment.id,
        position: {
          id: assignment.position.id,
          name: assignment.position.name,
        },
        organization: {
          id: assignment.position.organization.id,
          name: assignment.position.organization.name,
        },
        timezone,
        attendanceEnabled,
        clockEnabled,
        canCapture: permitted && attendanceEnabled,
        trackingMode: modes?.trackingMode ?? null,
        captureMode: modes?.captureMode ?? null,
        selfServiceCapture: selfService,
        kioskLocationRule: modes?.kioskLocationRule ?? null,
        signOutEnabled: policy?.attendance?.signOutEnabled === true,
        breakMode: policy?.breaks.mode ?? null,
        assignmentSwitching: policy
          ? this.assignmentSwitchingEnabled(policy)
          : false,
        correctionRequestsEnabled: policy
          ? this.employeeCorrectionRequestsEnabled(policy)
          : false,
        missedPunchSelfResolutionEnabled: policy
          ? this.employeeMissedPunchResolutionEnabled(policy)
          : false,
        allowEarlySubmission: policy?.timesheet.allowEarlySubmission === true,
        unavailableReason,
        explanation: CAPABILITY_EXPLANATIONS[unavailableReason ?? 'NONE'],
      });
    }
    return result;
  }

  /**
   * Phase 9.5 — how each of the employee's active assignments captures attendance today, so a
   * client can explain why there is nothing to clock (kiosk-only, or sign-in tracking).
   */
  private async attendanceModesForEmployee(
    employee: Awaited<ReturnType<TimeService['requireSelfEmployee']>>,
    now: Date,
    client: TimeClient,
  ) {
    const result = [];
    for (const assignment of await this.assignmentsForEmployee(
      employee.id,
      client,
    )) {
      if (!this.resolvedTimezone(assignment)) continue;
      const policy = await this.effectivePolicyForAssignment(
        assignment,
        now,
        client,
      );
      if (!this.liveClockEnabled(policy)) continue;
      const modes = attendanceModes(policy);
      result.push({
        employmentAssignmentId: assignment.id,
        trackingMode: modes.trackingMode,
        captureMode: modes.captureMode,
      });
    }
    return result;
  }

  /**
   * Published shifts open for clock-in (or switching) across the eligible assignments, the
   * unambiguous preselection if there is one, and each assignment's unscheduled-work mode.
   */
  private async scheduleStatus(
    employeeId: string,
    eligibleAssignments: Array<
      NonNullable<Awaited<ReturnType<TimeService['assignmentById']>>>
    >,
    now: Date,
    client: TimeClient,
  ) {
    if (!this.schedules) return null;
    const candidates = await this.schedules.clockInCandidates(
      {
        employeeId,
        employmentAssignmentIds: eligibleAssignments.map(
          (assignment) => assignment.id,
        ),
        at: now,
      },
      client,
    );
    const unscheduledWorkModes = [];
    for (const assignment of eligibleAssignments) {
      unscheduledWorkModes.push({
        employmentAssignmentId: assignment.id,
        mode: await this.unscheduledWorkModeFor(assignment, now, client),
      });
    }
    const preselected = candidates.length === 1 ? candidates[0] : null;
    return {
      scheduledShiftOptions: candidates.map((candidate) =>
        this.shiftOptionShape(candidate),
      ),
      scheduledShiftSelectionRequired: candidates.length > 1,
      preselectedScheduledShiftId: preselected?.scheduledShiftId ?? null,
      preselectedEmploymentAssignmentId:
        preselected?.employmentAssignmentId ??
        (candidates.length === 0 && eligibleAssignments.length === 1
          ? eligibleAssignments[0].id
          : null),
      unscheduledWorkModes,
    };
  }

  private async clockInAssignments(
    actorOrUserId: ClockActor | string,
    employee: Awaited<ReturnType<TimeService['requireSelfEmployee']>>,
    now: Date,
    client: TimeClient,
  ) {
    const actor = asActor(actorOrUserId);
    if (employee.status !== 'ACTIVE') return [];
    const assignments = await this.assignmentsForEmployee(employee.id, client);
    const result = [];
    for (const assignment of assignments) {
      if (
        !(await this.assignmentCanClock(
          actor,
          employee,
          assignment,
          now,
          client,
        ))
      ) {
        continue;
      }
      result.push(assignment);
    }
    return result;
  }

  private async switchTargets(
    actorOrUserId: ClockActor | string,
    employee: Awaited<ReturnType<TimeService['requireSelfEmployee']>>,
    currentAssignmentId: string,
    now: Date,
    client: TimeClient,
  ) {
    const actor = asActor(actorOrUserId);
    const assignments = await this.clockInAssignments(
      actor,
      employee,
      now,
      client,
    );
    const result = [];
    for (const assignment of assignments) {
      if (assignment.id === currentAssignmentId) continue;
      const policy = await this.effectivePolicyForAssignment(
        assignment,
        now,
        client,
      );
      if (this.assignmentSwitchingEnabled(policy)) result.push(assignment);
    }
    return result;
  }

  private async assignmentCanClock(
    actorOrUserId: ClockActor | string,
    employee: Awaited<ReturnType<TimeService['requireSelfEmployee']>>,
    assignment: Awaited<ReturnType<TimeService['assignmentById']>>,
    now: Date,
    client: TimeClient,
  ): Promise<boolean> {
    const actor = asActor(actorOrUserId);
    if (!assignment) return false;
    if (assignment.employeeId !== employee.id) return false;
    // An assignment without a resolvable timezone cannot be clocked (and is not offered).
    const timezone = this.resolvedTimezone(assignment);
    if (!timezone) return false;
    const date = this.domain.parseDateOnly(
      this.domain.deriveWorkDate(now, timezone),
    );
    if (!this.employeeEffectiveOn(employee, date)) return false;
    if (!this.assignmentEffectiveOn(assignment, date)) return false;
    if (
      !(await this.canClockAssignment(actor, assignment.positionId, client))
    ) {
      return false;
    }
    const policy = await this.effectivePolicyForAssignment(
      assignment,
      now,
      client,
    );
    return (
      this.liveClockEnabled(policy) &&
      this.captureRefusal(actor, assignment, policy) === null
    );
  }

  /** The active coverage rows of one entry (with their assignments). */
  private entryCoverage(timeEntryId: string, client: TimeClient) {
    const { include, orderBy } = activeCoverageInclude();
    return client.timeEntryAssignmentCoverage.findMany({
      where: { timeEntryId, removedAt: null },
      include,
      orderBy,
    });
  }

  // ─── Batch 4A: time integrity ──────────────────────────────────────────────

  /**
   * Serializes every write to one employee's time (live capture, the open-entry scan, missed
   * clock-out resolution and corrections) for the rest of the transaction. A transaction
   * advisory lock, not a row lock: it also orders operations against an entry that another
   * transaction is about to insert (an assignment switch), and makes overlap checks race-free.
   * Statements after it see everything the previous holder committed (READ COMMITTED).
   */
  private async lockEmployeeTime(employeeId: string, client: TimeClient) {
    await advisoryLock(
      client as Prisma.TransactionClient,
      `time-employee:${employeeId}`,
    );
  }

  /** Closes an entry that must still be open; the second of two racing closers gets a 409. */
  private async closeOpenEntry(
    client: Prisma.TransactionClient,
    timeEntryId: string,
    clockOutAt: Date,
  ) {
    const closed = await client.timeEntry.updateMany({
      where: { id: timeEntryId, status: 'OPEN', archivedAt: null },
      data: { clockOutAt, status: 'CLOSED' },
    });
    if (closed.count !== 1) {
      throw new ConflictException(
        timeError(
          409,
          'TIME_ENTRY_ALREADY_CLOSED',
          'The time entry is already closed.',
        ),
      );
    }
  }

  /**
   * Live capture is never refused because a timesheet is approved. A closed entry whose work
   * date lies in approved or locked time is instead flagged for review (RECORDED_AFTER_APPROVAL,
   * non-blocking) and audited; the approved payroll snapshot is never recalculated from it. It
   * reaches payroll only through an explicit reopen and re-approval.
   */
  private async flagTimeRecordedAfterApproval(
    client: Prisma.TransactionClient,
    timeEntryId: string,
    detectedAt: Date,
    context: TimeRequestContext,
  ) {
    const entry = await client.timeEntry.findUnique({
      where: { id: timeEntryId },
      select: {
        id: true,
        employeeId: true,
        employmentAssignmentId: true,
        workDate: true,
        clockInAt: true,
        clockOutAt: true,
      },
    });
    if (!entry) return;
    const finalized = await this.finalizedTimesheetOf(entry, client);
    if (!finalized) return;
    const existing = await client.attendanceException.findFirst({
      where: {
        timeEntryId: entry.id,
        type: 'RECORDED_AFTER_APPROVAL',
        status: 'OPEN',
      },
      select: { id: true },
    });
    if (existing) return;
    const exception = await client.attendanceException.create({
      data: {
        employeeId: entry.employeeId,
        employmentAssignmentId: entry.employmentAssignmentId,
        timeEntryId: entry.id,
        type: 'RECORDED_AFTER_APPROVAL',
        severity: 'REVIEW',
        workflowImpact: 'NON_BLOCKING',
        detectedAt,
        reason:
          'Time was recorded in an approved period; it is not in the approved payroll snapshot until the timesheet is reopened and approved again.',
        metadata: jsonMetadata({
          timesheetId: finalized.id,
          timesheetStatus: finalized.status,
          clockInAt: entry.clockInAt.toISOString(),
          clockOutAt: entry.clockOutAt?.toISOString() ?? null,
        }),
      },
    });
    await this.writeAudit(
      client,
      'TIME_RECORDED_AFTER_APPROVAL',
      exception.id,
      context,
      {
        employeeId: entry.employeeId,
        employmentAssignmentId: entry.employmentAssignmentId,
        timeEntryId: entry.id,
        timesheetId: finalized.id,
      },
      'AttendanceException',
    );
  }

  /**
   * Privileged time actions never target the actor's own time (403 TIME_SELF_TARGET_FORBIDDEN).
   * Maintenance actions (direct correction, manual entry, shift relink, lock, reopen) may pass
   * `allowSystemOverride`: an account holding the permission at System scope may then act, and
   * the override is audited. Approvals and reviews never allow it.
   */
  private async assertNotSelfTarget(
    actorUserId: string,
    employeeId: string,
    permission: string,
    action: string,
    context: TimeRequestContext,
    client: TimeClient,
    options: { allowSystemOverride?: boolean } = {},
  ) {
    const employee = await client.employee.findUnique({
      where: { id: employeeId },
      select: { person: { select: { user: { select: { id: true } } } } },
    });
    if (employee?.person.user?.id !== actorUserId) return;
    if (
      options.allowSystemOverride &&
      (await this.authorization.canAccess(
        actorUserId,
        permission,
        { type: 'SYSTEM' },
        client,
      ))
    ) {
      await this.writeAudit(
        client as Prisma.TransactionClient,
        'TIME_SELF_TARGET_OVERRIDE',
        employeeId,
        context,
        { action, permission, employeeId },
        'Employee',
      );
      return;
    }
    throw new ForbiddenException(
      timeError(
        403,
        'TIME_SELF_TARGET_FORBIDDEN',
        'This action cannot be used on your own time or timesheet.',
        { action },
      ),
    );
  }

  private assertNotInFuture(instant: Date, now: Date, field: string) {
    if (instant.getTime() > now.getTime()) {
      throw new BadRequestException(
        timeError(400, 'TIME_IN_FUTURE', `${field} cannot be in the future.`, {
          field,
        }),
      );
    }
  }

  /**
   * An entry may last at most the policy's missed-punch threshold (maximum open duration plus
   * grace) when missed-punch detection is enabled, and never more than MAX_TIME_ENTRY_MINUTES.
   */
  private assertEntryDuration(
    startAt: Date,
    endAt: Date,
    policy: TimeAttendancePolicyConfig,
  ) {
    const threshold = this.missedPunchDetectionEnabled(policy)
      ? this.missedPunchDetectionThresholdMinutes(policy)
      : null;
    const maxMinutes = Math.min(
      threshold ?? MAX_TIME_ENTRY_MINUTES,
      MAX_TIME_ENTRY_MINUTES,
    );
    if (endAt.getTime() - startAt.getTime() > maxMinutes * 60_000) {
      throw new BadRequestException(
        timeError(
          400,
          'TIME_ENTRY_TOO_LONG',
          `A time entry cannot last more than ${maxMinutes} minutes.`,
          { maxMinutes },
        ),
      );
    }
  }

  /** A clock-out can't precede anything already recorded on the entry (punches, break starts). */
  private async assertAfterRecordedActivity(
    timeEntryId: string,
    clockOutAt: Date,
    client: TimeClient,
  ) {
    const [punch, breakEntry] = await Promise.all([
      client.timePunch.findFirst({
        where: { timeEntryId, occurredAt: { gte: clockOutAt } },
        select: { id: true },
      }),
      client.breakEntry.findFirst({
        where: {
          timeEntryId,
          removedAt: null,
          OR: [{ startAt: { gte: clockOutAt } }, { endAt: { gt: clockOutAt } }],
        },
        select: { id: true },
      }),
    ]);
    if (punch || breakEntry) {
      throw new BadRequestException(
        timeError(
          400,
          'TIME_BEFORE_RECORDED_ACTIVITY',
          'clockOutAt cannot be before activity already recorded on the time entry.',
        ),
      );
    }
  }

  private async openEntry(employeeId: string, client: TimeClient) {
    return client.timeEntry.findFirst({
      where: { employeeId, status: 'OPEN', archivedAt: null },
      include: {
        employmentAssignment: {
          include: {
            position: {
              include: {
                jobTitle: true,
                organization: true,
                organizationalUnit: true,
                department: true,
                team: true,
                workLocation: true,
              },
            },
          },
        },
      },
      orderBy: { clockInAt: 'desc' },
    });
  }

  private async assignmentById(id: string, client: TimeClient) {
    return client.employmentAssignment.findUnique({
      where: { id },
      include: {
        position: {
          include: {
            jobTitle: true,
            organization: true,
            organizationalUnit: true,
            department: true,
            team: true,
            workLocation: true,
          },
        },
      },
    });
  }

  private async assignmentsForEmployee(employeeId: string, client: TimeClient) {
    return client.employmentAssignment.findMany({
      where: { employeeId, status: 'ACTIVE' },
      include: {
        position: {
          include: {
            jobTitle: true,
            organization: true,
            organizationalUnit: true,
            department: true,
            team: true,
            workLocation: true,
          },
        },
      },
      orderBy: [{ isPrimary: 'desc' }, { startDate: 'asc' }, { id: 'asc' }],
    });
  }

  private async effectivePolicyForAssignment(
    assignment: NonNullable<Awaited<ReturnType<TimeService['assignmentById']>>>,
    now: Date,
    client: TimeClient,
  ): Promise<TimeAttendancePolicyConfig> {
    const timezone = this.assignmentTimezone(assignment);
    const workDate = this.domain.parseDateOnly(
      this.domain.deriveWorkDate(now, timezone),
    );
    return this.effectivePolicyForAssignmentOnWorkDate(
      assignment,
      workDate,
      client,
    );
  }

  private async effectivePolicyForAssignmentOnWorkDate(
    assignment: NonNullable<Awaited<ReturnType<TimeService['assignmentById']>>>,
    workDate: Date,
    client: TimeClient,
  ): Promise<TimeAttendancePolicyConfig> {
    return this.domain.resolvePolicyConfig(
      await this.policyLayersForAssignmentOnWorkDate(
        assignment,
        workDate,
        client,
      ),
    );
  }

  /**
   * Batch 4E-2 (B1) — an assignment's resolved attendance policy on a date, explained: every
   * setting with its source (a layer, the default, or the default restored by an OVERRIDE
   * layer), the layers in inheritance order with their scope names and dates, and the
   * resulting tracking and capture modes. Resolved by the very function the attendance runtime
   * uses. Readable with time.manage_policy or time.view on the assignment's position; any other
   * assignment answers 404, so nothing about it (or its organization) is disclosed.
   */
  async effectivePolicyView(userId: string, query: EffectivePolicyQueryDto) {
    const assignment = await this.assignmentById(
      query.employmentAssignmentId,
      this.prisma,
    );
    if (
      !assignment ||
      !(await this.canReadPosition(userId, assignment.positionId, [
        'time.manage_policy',
        'time.view',
      ]))
    ) {
      throw new NotFoundException('Employment assignment not found.');
    }
    await this.features.require(
      assignment.position.organizationId,
      'ATTENDANCE',
    );
    const timezone = this.assignmentTimezone(assignment);
    const date =
      query.date ?? this.domain.deriveWorkDate(this.clock.now(), timezone);
    return this.explainedPolicy(assignment, date, timezone);
  }

  /** Layers resolved by the runtime's function, each setting with its source (B1). */
  private async explainLayers(
    layers: Awaited<ReturnType<TimeService['policyLayersForChain']>>,
  ) {
    const { config, sources } = this.domain.resolvePolicyWithSources(layers);
    const names = await policyScopeNames(this.prisma, layers);
    const chain = layers.map((layer) => ({
      id: layer.id,
      scopeType: layer.scopeType,
      scopeName: names.get(layer.id) ?? 'Unknown',
      inheritanceMode: layer.inheritanceMode,
      effectiveFrom: dateOnly(layer.effectiveFrom),
      effectiveTo: layer.effectiveTo ? dateOnly(layer.effectiveTo) : null,
      config: layer.config,
    }));
    const settings: Record<string, Record<string, unknown>> = {};
    for (const [section, keys] of Object.entries(sources)) {
      settings[section] = {};
      for (const [key, source] of Object.entries(keys)) {
        const value = (config as Record<string, Record<string, unknown>>)[
          section
        ]?.[key];
        settings[section]![key] =
          source.kind === 'LAYER'
            ? { value, source: 'LAYER', layerId: chain[source.layerIndex]!.id }
            : {
                value,
                source: 'DEFAULT',
                ...(source.resetByLayerIndex === undefined
                  ? {}
                  : { resetByLayerId: chain[source.resetByLayerIndex]!.id }),
              };
      }
    }
    return { config, settings, chain };
  }

  /**
   * Batch 4E-2 review — what a new or replacement layer at a scope inherits on a date: the
   * layers strictly broader than the scope, collected and resolved exactly as the runtime does
   * (blank settings of an INHERIT layer take these values). The caller is authorized for the
   * scope beforehand (TimePolicyService.inheritanceTarget).
   *
   * A department's or team's broader layers depend on each position (its unit path, and for a
   * team its department), so they are only exact when no such layer is in effect anywhere in
   * the organization on the date; otherwise `determinable` is false and nothing is guessed.
   */
  async inheritedPolicyView(
    target: {
      scopeType:
        | 'ORGANIZATION'
        | 'ORGANIZATIONAL_UNIT'
        | 'DEPARTMENT'
        | 'TEAM'
        | 'EMPLOYMENT_ASSIGNMENT';
      id: string;
      organizationId: string;
    },
    date: string,
  ) {
    const workDate = this.domain.parseDateOnly(date);
    const base: PolicyChainScope = {
      organizationId: target.organizationId,
      unitPath: [],
      departmentId: null,
      teamId: null,
      employmentAssignmentId: null,
    };
    let scope: PolicyChainScope = base;
    if (target.scopeType === 'ORGANIZATION') {
      // Above an organization there is only the system layer.
      scope = { ...base, organizationId: null };
    } else if (target.scopeType === 'ORGANIZATIONAL_UNIT') {
      const path = await this.unitPathRootFirst(
        target.organizationId,
        target.id,
        this.prisma,
      );
      scope = { ...base, unitPath: path.slice(0, -1) };
    } else if (target.scopeType === 'EMPLOYMENT_ASSIGNMENT') {
      const assignment = await this.assignmentById(target.id, this.prisma);
      if (!assignment) {
        throw new NotFoundException('Employment assignment not found.');
      }
      scope = {
        ...(await this.assignmentChainScope(assignment, this.prisma)),
        employmentAssignmentId: null,
      };
    } else {
      const varying: Array<'ORGANIZATIONAL_UNIT' | 'DEPARTMENT'> =
        target.scopeType === 'TEAM'
          ? ['ORGANIZATIONAL_UNIT', 'DEPARTMENT']
          : ['ORGANIZATIONAL_UNIT'];
      const inEffect = await this.prisma.timeAttendancePolicy.findMany({
        where: {
          archivedAt: null,
          organizationId: target.organizationId,
          scopeType: { in: varying },
          effectiveFrom: { lte: workDate },
          OR: [{ effectiveTo: null }, { effectiveTo: { gte: workDate } }],
        },
        select: { scopeType: true },
        distinct: ['scopeType'],
      });
      if (inEffect.length > 0) {
        return {
          date,
          determinable: false as const,
          reason: 'VARIES_BY_POSITION' as const,
          varyingScopes: inEffect.map((row) => row.scopeType),
        };
      }
    }
    const layers = await this.policyLayersForChain(
      scope,
      workDate,
      this.prisma,
    );
    return {
      date,
      determinable: true as const,
      ...(await this.explainLayers(layers)),
    };
  }

  private async explainedPolicy(
    assignment: NonNullable<Awaited<ReturnType<TimeService['assignmentById']>>>,
    date: string,
    timezone: string | null,
  ) {
    const layers = await this.policyLayersForAssignmentOnWorkDate(
      assignment,
      this.domain.parseDateOnly(date),
      this.prisma,
    );
    const { config, settings, chain } = await this.explainLayers(layers);
    return {
      date,
      timezone,
      assignment: {
        id: assignment.id,
        employeeId: assignment.employeeId,
        status: assignment.status,
        position: {
          id: assignment.position.id,
          name: assignment.position.name,
        },
        organization: {
          id: assignment.position.organization.id,
          name: assignment.position.organization.name,
        },
      },
      config,
      settings,
      chain,
      attendance: {
        ...attendanceModes(config),
        signOutEnabled: config.attendance?.signOutEnabled === true,
      },
    };
  }

  /**
   * Batch 4E-2 (B4) — how each assignment the reader may see captures attendance, across every
   * organization they hold time.view or time.manage_policy in (an employee may work for several):
   * organization, position, status, the effective tracking and capture modes, clock and break
   * modes, and the layers behind them. Assignments of other organizations, or positions the
   * reader can't see, are never listed or counted. Organizations with Time & attendance turned
   * off are left out.
   */
  async assignmentAttendance(
    userId: string,
    query: AssignmentAttendanceQueryDto,
  ) {
    const organizations = await this.timeOrganizations(userId, [
      'time.view',
      'time.manage_policy',
    ]);
    if (!organizations) return { items: [], nextAfterId: null };
    const disabled = await this.features.disabledOrganizations('ATTENDANCE');
    const term = query.search?.trim();
    const rows = await this.prisma.employmentAssignment.findMany({
      where: {
        status: { not: 'CANCELLED' },
        ...(query.employeeId ? { employeeId: query.employeeId } : {}),
        position: {
          organizationId: {
            ...(organizations === 'ALL' ? {} : { in: organizations }),
            notIn: [...disabled],
          },
        },
        ...(term
          ? {
              OR: [
                {
                  employee: {
                    employeeNumber: { contains: term, mode: 'insensitive' },
                  },
                },
                {
                  employee: {
                    person: {
                      firstName: { contains: term, mode: 'insensitive' },
                    },
                  },
                },
                {
                  employee: {
                    person: {
                      lastName: { contains: term, mode: 'insensitive' },
                    },
                  },
                },
                {
                  employee: {
                    person: {
                      preferredName: { contains: term, mode: 'insensitive' },
                    },
                  },
                },
                { position: { name: { contains: term, mode: 'insensitive' } } },
              ],
            }
          : {}),
      },
      include: {
        employee: { include: { person: true } },
        position: {
          include: {
            jobTitle: true,
            organization: true,
            organizationalUnit: true,
            department: true,
            team: true,
            workLocation: true,
          },
        },
      },
      orderBy: [{ employeeId: 'asc' }, { id: 'asc' }],
      take: this.scanTake(query.limit),
      ...(query.afterId ? { cursor: { id: query.afterId }, skip: 1 } : {}),
    });
    return this.authorizedPage(rows, query.limit, async (row) => {
      if (
        !(await this.canReadPosition(userId, row.positionId, [
          'time.view',
          'time.manage_policy',
        ]))
      ) {
        return null;
      }
      const timezone = this.assignmentTimezone(row);
      const date =
        query.date ??
        this.domain.deriveWorkDate(this.clock.now(), timezone ?? 'UTC');
      const explained = await this.explainedPolicy(row, date, timezone);
      return {
        id: row.id,
        employee: {
          id: row.employeeId,
          employeeNumber: row.employee.employeeNumber,
          name: personDisplayName(row.employee.person),
        },
        assignment: this.assignmentShape(row),
        date,
        timezone,
        attendance: explained.attendance,
        clock: { mode: explained.config.clock.mode ?? 'DISABLED' },
        breaks: {
          mode: explained.config.breaks.mode ?? 'NONE',
          autoDeductMinutes: explained.config.breaks.autoDeductMinutes ?? null,
          autoDeductAfterMinutes:
            explained.config.breaks.autoDeductAfterMinutes ?? null,
        },
        chain: explained.chain.map(({ config: _config, ...layer }) => layer),
      };
    });
  }

  /**
   * The policy layers that apply to an assignment on a work date, broadest first: SYSTEM, the
   * organization, its units root first, the department, the team, the assignment. The attendance
   * runtime and the Batch 4E-2 effective-policy view both resolve exactly these.
   */
  async policyLayersForAssignmentOnWorkDate(
    assignment: NonNullable<Awaited<ReturnType<TimeService['assignmentById']>>>,
    workDate: Date,
    client: TimeClient = this.prisma,
  ) {
    return this.policyLayersForChain(
      await this.assignmentChainScope(assignment, client),
      workDate,
      client,
    );
  }

  /** The scopes an assignment's policy chain is collected from, broadest first. */
  private async assignmentChainScope(
    assignment: NonNullable<Awaited<ReturnType<TimeService['assignmentById']>>>,
    client: TimeClient,
  ): Promise<PolicyChainScope> {
    return {
      organizationId: assignment.position.organizationId,
      unitPath: await this.unitPathRootFirst(
        assignment.position.organizationId,
        assignment.position.organizationalUnitId,
        client,
      ),
      departmentId: assignment.position.departmentId,
      teamId: assignment.position.teamId,
      employmentAssignmentId: assignment.id,
    };
  }

  /**
   * The layers in effect on a date for a chain of scopes, broadest first: system, organization,
   * units (root first), department, team, assignment. The one collection the attendance runtime,
   * the effective-policy view (B1) and the inherited values (Batch 4E-2 review) all use.
   */
  private async policyLayersForChain(
    scope: PolicyChainScope,
    workDate: Date,
    client: TimeClient,
  ) {
    const policyLayers = [];
    const system = await this.findPolicy(
      client,
      { scopeType: 'SYSTEM' },
      workDate,
    );
    if (system) policyLayers.push(system);
    if (scope.organizationId) {
      const organization = await this.findPolicy(
        client,
        { scopeType: 'ORGANIZATION', organizationId: scope.organizationId },
        workDate,
      );
      if (organization) policyLayers.push(organization);
      for (const unitId of scope.unitPath) {
        const unit = await this.findPolicy(
          client,
          {
            scopeType: 'ORGANIZATIONAL_UNIT',
            organizationId: scope.organizationId,
            organizationalUnitId: unitId,
          },
          workDate,
        );
        if (unit) policyLayers.push(unit);
      }
      if (scope.departmentId) {
        const department = await this.findPolicy(
          client,
          {
            scopeType: 'DEPARTMENT',
            organizationId: scope.organizationId,
            departmentId: scope.departmentId,
          },
          workDate,
        );
        if (department) policyLayers.push(department);
      }
      if (scope.teamId) {
        const team = await this.findPolicy(
          client,
          {
            scopeType: 'TEAM',
            organizationId: scope.organizationId,
            teamId: scope.teamId,
          },
          workDate,
        );
        if (team) policyLayers.push(team);
      }
    }
    if (scope.employmentAssignmentId) {
      const assignmentPolicy = await this.findPolicy(
        client,
        {
          scopeType: 'EMPLOYMENT_ASSIGNMENT',
          employmentAssignmentId: scope.employmentAssignmentId,
        },
        workDate,
      );
      if (assignmentPolicy) policyLayers.push(assignmentPolicy);
    }
    return policyLayers;
  }

  private findPolicy(
    client: TimeClient,
    scope: Prisma.TimeAttendancePolicyWhereInput,
    workDate: Date,
  ) {
    return client.timeAttendancePolicy.findFirst({
      where: {
        archivedAt: null,
        ...scope,
        effectiveFrom: { lte: workDate },
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: workDate } }],
      },
      orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
      select: {
        id: true,
        scopeType: true,
        organizationId: true,
        organizationalUnitId: true,
        departmentId: true,
        teamId: true,
        employmentAssignmentId: true,
        effectiveFrom: true,
        effectiveTo: true,
        inheritanceMode: true,
        config: true,
      },
    });
  }

  private async unitPathRootFirst(
    organizationId: string,
    unitId: string | null,
    client: TimeClient,
  ): Promise<string[]> {
    if (!unitId) return [];
    const rows = await client.organizationalUnit.findMany({
      where: { organizationId },
      select: { id: true, parentUnitId: true },
    });
    const parents = new Map(rows.map((row) => [row.id, row.parentUnitId]));
    const path: string[] = [];
    let current: string | null | undefined = unitId;
    while (current && !path.includes(current)) {
      path.push(current);
      current = parents.get(current);
    }
    return path.reverse();
  }

  private async assertClockAccess(
    actorOrUserId: ClockActor | string,
    positionId: string,
    client: TimeClient,
  ) {
    const actor = asActor(actorOrUserId);
    if (!(await this.canClockAssignmentRaw(actor, positionId, client))) {
      throw new ForbiddenException(
        actor.channel === 'KIOSK'
          ? 'This kiosk does not record attendance for the assignment.'
          : 'Missing permission time.clock for the requested assignment.',
      );
    }
    await this.requireAttendanceForPosition(positionId, client);
  }

  /**
   * Self-service capture needs the employee's time.clock grant on the position. A kiosk acts on
   * behalf of the employee who identified there: it needs no user grant (device trust, the
   * credential and the policy's capture mode govern it), only its own organization.
   */
  private async canClockAssignment(
    actor: ClockActor,
    positionId: string,
    client: TimeClient,
  ) {
    // Phase 18: assignments of organizations with Time & attendance disabled are not capturable.
    return (
      (await this.canClockAssignmentRaw(actor, positionId, client)) &&
      (await this.attendanceEnabledForPosition(positionId, client))
    );
  }

  private async canClockAssignmentRaw(
    actor: ClockActor,
    positionId: string,
    client: TimeClient,
  ) {
    if (actor.channel === 'KIOSK') {
      const position = await client.position.findUnique({
        where: { id: positionId },
        select: { organizationId: true },
      });
      return position?.organizationId === actor.device.organizationId;
    }
    const scope = await this.targets.scopeForPosition(
      positionId,
      undefined,
      client,
    );
    return this.authorization.canAccess(
      actor.userId,
      'time.clock',
      scope,
      client,
    );
  }

  /**
   * Without an explicit assignment, clock-in picks among the capturable ones. When none is, but
   * some assignment would be except for its capture or tracking mode, say why (rather than a
   * generic "nothing eligible"), so a KIOSK_ONLY employee learns to use the kiosk.
   */
  private async assertSomeAssignmentCapturable(
    actor: ClockActor,
    employee: Awaited<ReturnType<TimeService['requireSelfEmployee']>>,
    now: Date,
    client: TimeClient,
  ) {
    if (
      (await this.clockInAssignments(actor, employee, now, client)).length > 0
    ) {
      return;
    }
    for (const assignment of await this.assignmentsForEmployee(
      employee.id,
      client,
    )) {
      const timezone = this.resolvedTimezone(assignment);
      if (!timezone) continue;
      const date = this.domain.parseDateOnly(
        this.domain.deriveWorkDate(now, timezone),
      );
      if (
        !this.employeeEffectiveOn(employee, date) ||
        !this.assignmentEffectiveOn(assignment, date) ||
        !(await this.canClockAssignment(actor, assignment.positionId, client))
      ) {
        continue;
      }
      const policy = await this.effectivePolicyForAssignment(
        assignment,
        now,
        client,
      );
      if (!this.liveClockEnabled(policy)) continue;
      const refusal = this.captureRefusal(actor, assignment, policy);
      if (refusal) throw refusal;
    }
  }

  /**
   * Why the actor may not capture TIME_CLOCK attendance for the assignment under its policy
   * (null if it may): the tracking mode must be TIME_CLOCK (unless only closing open work), the
   * capture mode must allow the channel, and a kiosk must satisfy the location rule.
   */
  private captureRefusal(
    actor: ClockActor,
    assignment: {
      position: {
        workLocation: { physicalSiteId: string | null } | null;
      };
    },
    policy: TimeAttendancePolicyConfig,
    options: { closingOnly?: boolean; tracking?: AttendanceTrackingMode } = {},
  ): HttpException | null {
    const modes = attendanceModes(policy);
    const tracking = options.tracking ?? 'TIME_CLOCK';
    if (!options.closingOnly && modes.trackingMode !== tracking) {
      return new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        code: 'ATTENDANCE_TRACKING_MODE_MISMATCH',
        message:
          tracking === 'TIME_CLOCK'
            ? 'This assignment records attendance by sign-in, not by clocking in and out.'
            : 'This assignment records attendance by clocking in and out, not by sign-in.',
      });
    }
    if (!captureAllows(modes.captureMode, actor.channel)) {
      return actor.channel === 'KIOSK'
        ? new ForbiddenException({
            statusCode: 403,
            error: 'Forbidden',
            code: 'ATTENDANCE_CAPTURE_SELF_SERVICE_ONLY',
            message:
              'Attendance for this assignment is not recorded at kiosks.',
          })
        : new ForbiddenException({
            statusCode: 403,
            error: 'Forbidden',
            code: 'ATTENDANCE_CAPTURE_KIOSK_ONLY',
            message:
              'Attendance for this assignment is recorded at the onsite kiosk only.',
          });
    }
    if (
      actor.channel === 'KIOSK' &&
      modes.kioskLocationRule === 'ASSIGNMENT_WORK_LOCATION' &&
      assignment.position.workLocation?.physicalSiteId !==
        actor.device.physicalSiteId
    ) {
      return new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        code: 'ATTENDANCE_KIOSK_LOCATION_NOT_ALLOWED',
        message:
          'Attendance for this assignment is recorded at a kiosk of its own physical site.',
      });
    }
    return null;
  }

  /** The capture gate for acting on an open entry (closing it, or starting a break in it). */
  private async assertCaptureOnEntry(
    actor: ClockActor,
    assignment: NonNullable<Awaited<ReturnType<TimeService['assignmentById']>>>,
    now: Date,
    client: TimeClient,
    options: { closingOnly: boolean },
  ) {
    await this.assertClockAccess(actor, assignment.positionId, client);
    const refusal = this.captureRefusal(
      actor,
      assignment,
      await this.effectivePolicyForAssignment(assignment, now, client),
      options,
    );
    if (refusal) throw refusal;
  }

  /**
   * Holds the capturing kiosk for the transaction (FOR SHARE: a revocation or disable, which
   * updates the row, waits for or precedes it) and refuses a device that is no longer ACTIVE.
   */
  private async lockCaptureDevice(actor: ClockActor, client: TimeClient) {
    if (actor.channel !== 'KIOSK') return;
    await client.$queryRaw(
      Prisma.sql`SELECT "id" FROM "AttendanceDevice" WHERE "id" = ${actor.device.id}::uuid FOR SHARE`,
    );
    const device = await client.attendanceDevice.findUnique({
      where: { id: actor.device.id },
      select: { status: true },
    });
    if (device?.status !== 'ACTIVE') {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'Forbidden',
        code: 'KIOSK_DEVICE_INACTIVE',
        message: 'This kiosk is not active.',
      });
    }
  }

  private liveSource(actor: ClockActor): 'KIOSK' | 'LIVE_CLOCK' {
    return actor.channel === 'KIOSK' ? 'KIOSK' : 'LIVE_CLOCK';
  }

  private captureDeviceId(actor: ClockActor): string | null {
    return actor.channel === 'KIOSK' ? actor.device.id : null;
  }

  private liveClockEnabled(config: TimeAttendancePolicyConfig): boolean {
    return config.clock.mode === 'LIVE_CLOCK';
  }

  private assignmentSwitchingEnabled(
    config: TimeAttendancePolicyConfig,
  ): boolean {
    return (
      config.clock.mode === 'LIVE_CLOCK' &&
      config.clock.assignmentSwitching === true
    );
  }

  private manualBreakEnabled(config: TimeAttendancePolicyConfig): boolean {
    return config.breaks.mode === 'MANUAL_PUNCH';
  }

  private breakPayType(
    config: TimeAttendancePolicyConfig,
  ): 'PAID' | 'UNPAID' | null {
    if (config.breaks.paidUnpaidClassification !== true) return null;
    return config.breaks.defaultPayType === 'PAID' ? 'PAID' : 'UNPAID';
  }

  private missedPunchDetectionEnabled(
    config: TimeAttendancePolicyConfig,
  ): boolean {
    return config.missedPunch.enabled === true;
  }

  private missedPunchDetectionThresholdMinutes(
    config: TimeAttendancePolicyConfig,
  ): number | null {
    const maxOpenDurationMinutes = numericPolicyValue(
      config.missedPunch.maxOpenDurationMinutes,
    );
    if (maxOpenDurationMinutes === null) return null;
    return (
      maxOpenDurationMinutes +
      (numericPolicyValue(config.missedPunch.detectionGraceMinutes) ?? 0)
    );
  }

  private autoCloseFromExpectedEndEnabled(
    config: TimeAttendancePolicyConfig,
  ): boolean {
    return config.missedPunch.allowAutoCloseFromExpectedEnd === true;
  }

  private employeeMissedPunchResolutionEnabled(
    config: TimeAttendancePolicyConfig,
  ): boolean {
    return config.missedPunch.employeeResolutionEnabled === true;
  }

  private openBreakAutoCloseExceptionEnabled(
    config: TimeAttendancePolicyConfig,
  ): boolean {
    return config.breaks.openBreakAutoCloseExceptionEnabled === true;
  }

  private lateArrivalEnabled(config: TimeAttendancePolicyConfig): boolean {
    return config.attendanceInterpretation.lateArrivalEnabled === true;
  }

  private earlyDepartureEnabled(config: TimeAttendancePolicyConfig): boolean {
    return config.attendanceInterpretation.earlyDepartureEnabled === true;
  }

  private lateGraceMinutes(config: TimeAttendancePolicyConfig): number {
    return (
      numericPolicyValue(config.attendanceInterpretation.lateGraceMinutes) ?? 0
    );
  }

  private earlyDepartureGraceMinutes(
    config: TimeAttendancePolicyConfig,
  ): number {
    return (
      numericPolicyValue(
        config.attendanceInterpretation.earlyDepartureGraceMinutes,
      ) ?? 0
    );
  }

  /**
   * Batch 4D (decision D-E): the work date of a NEW live entry. Linked to a published shift
   * (the selection only links ACTIVE shifts of PUBLISHED schedules, at their current revision),
   * it is that shift's work date, so clocking in at 00:10 for a 22:00 shift stays on the
   * shift's day, timesheet row and period. Otherwise the clock-in's local date, as before.
   * Existing entries are never re-dated.
   */
  private async liveEntryWorkDate(
    link: ScheduledShiftLink | null,
    now: Date,
    timezone: string,
    client: TimeClient,
  ): Promise<string> {
    const local = this.domain.deriveWorkDate(now, timezone);
    if (!link) return local;
    const revision = await client.scheduledShiftRevision.findUnique({
      where: { id: link.revisionId },
      select: { workDate: true, status: true, scheduledShiftId: true },
    });
    if (
      !revision ||
      revision.status !== 'ACTIVE' ||
      revision.scheduledShiftId !== link.scheduledShiftId
    ) {
      return local;
    }
    return dateOnly(revision.workDate) ?? local;
  }

  /**
   * The end an open entry is trusted to have had, for the missed clock-out auto-close.
   * Batch 4D (decision D-B): an entry linked to a published shift ends with that shift (its
   * ACTIVE revision; a cancelled one gives none), so overnight shifts close on the right day.
   * Otherwise the policy's missedPunch.expectedEndLocalTime on the entry's work date, moved to
   * the next day only when the configured window crosses midnight (the expected end is at or
   * before attendanceInterpretation.expectedStartLocalTime). It is never inferred from the
   * clock-in: a late daytime arrival is not an overnight shift. Daylight saving resolves
   * deterministically (resolvePolicyLocalDateTime) and never throws.
   */
  private async trustedExpectedEnd(
    entry: {
      workDate: Date;
      timezone: string;
      scheduledShiftRevisionId?: string | null;
    },
    config: TimeAttendancePolicyConfig,
    client: TimeClient,
  ): Promise<Date | null> {
    if (entry.scheduledShiftRevisionId) {
      const revision = await client.scheduledShiftRevision.findUnique({
        where: { id: entry.scheduledShiftRevisionId },
        select: { endsAt: true, status: true },
      });
      if (revision)
        return revision.status === 'ACTIVE' ? revision.endsAt : null;
    }
    const expectedEndLocalTime = config.missedPunch.expectedEndLocalTime;
    if (!isLocalTimeValue(expectedEndLocalTime)) return null;
    const expectedStartLocalTime =
      config.attendanceInterpretation.expectedStartLocalTime;
    const overnight =
      isLocalTimeValue(expectedStartLocalTime) &&
      expectedEndLocalTime <= expectedStartLocalTime;
    return this.domain.resolvePolicyLocalDateTime(
      dateOnly(addDateOnlyDays(entry.workDate, overnight ? 1 : 0)) ?? '',
      expectedEndLocalTime,
      entry.timezone,
    );
  }

  private activeExceptionsForEmployee(employeeId: string, client: TimeClient) {
    return client.attendanceException.findMany({
      where: { employeeId, status: 'OPEN' },
      orderBy: { detectedAt: 'desc' },
    });
  }

  private exceptionShape(exception: AttendanceExceptionShape) {
    return {
      id: exception.id,
      type: exception.type,
      severity: exception.severity,
      workflowImpact: exception.workflowImpact,
      status: exception.status,
      timeEntryId: exception.timeEntryId,
      employmentAssignmentId: exception.employmentAssignmentId,
      detectedAt: exception.detectedAt.toISOString(),
      resolvedAt: exception.resolvedAt?.toISOString() ?? null,
      reason: exception.reason,
      metadata: exception.metadata,
    };
  }

  private correctionShape(request: {
    id: string;
    employeeId: string;
    requestorUserId: string;
    reviewerUserId: string | null;
    timeEntryId: string | null;
    breakEntryId: string | null;
    employmentAssignmentId: string | null;
    targetEmploymentAssignmentId: string | null;
    type: string;
    status: string;
    reason: string;
    reviewerNote: string | null;
    requestedValues: unknown;
    currentValues: unknown;
    requestedAt: Date;
    reviewedAt: Date | null;
    cancelledAt: Date | null;
    adjustment?: { id: string } | null;
  }) {
    return {
      id: request.id,
      employeeId: request.employeeId,
      requestorUserId: request.requestorUserId,
      reviewerUserId: request.reviewerUserId,
      timeEntryId: request.timeEntryId,
      breakEntryId: request.breakEntryId,
      employmentAssignmentId: request.employmentAssignmentId,
      targetEmploymentAssignmentId: request.targetEmploymentAssignmentId,
      type: request.type,
      status: request.status,
      reason: request.reason,
      reviewerNote: request.reviewerNote,
      requestedValues: request.requestedValues,
      currentValues: request.currentValues,
      requestedAt: request.requestedAt.toISOString(),
      reviewedAt: request.reviewedAt?.toISOString() ?? null,
      cancelledAt: request.cancelledAt?.toISOString() ?? null,
      adjustmentId: request.adjustment?.id ?? null,
    };
  }

  private adjustmentShape(adjustment: {
    id: string;
    correctionRequestId: string | null;
    employeeId: string;
    actorUserId: string;
    timeEntryId: string | null;
    breakEntryId: string | null;
    employmentAssignmentId: string | null;
    type: string;
    source: string;
    reason: string;
    previousValues: unknown;
    newValues: unknown;
    appliedAt: Date;
  }) {
    return {
      id: adjustment.id,
      correctionRequestId: adjustment.correctionRequestId,
      employeeId: adjustment.employeeId,
      actorUserId: adjustment.actorUserId,
      timeEntryId: adjustment.timeEntryId,
      breakEntryId: adjustment.breakEntryId,
      employmentAssignmentId: adjustment.employmentAssignmentId,
      type: adjustment.type,
      source: adjustment.source,
      reason: adjustment.reason,
      previousValues: adjustment.previousValues,
      newValues: adjustment.newValues,
      appliedAt: adjustment.appliedAt.toISOString(),
    };
  }

  private timeEntrySnapshot(entry: {
    id: string;
    employmentAssignmentId: string;
    clockInAt: Date;
    clockOutAt: Date | null;
    timezone: string;
    workDate: Date;
    status: string;
    assignmentCoverages?: Array<{
      employmentAssignmentId: string;
      removedAt: Date | null;
    }>;
  }) {
    return {
      id: entry.id,
      employmentAssignmentId: entry.employmentAssignmentId,
      additionalEmploymentAssignmentIds: secondaryCoverageIds(entry),
      clockInAt: entry.clockInAt.toISOString(),
      clockOutAt: entry.clockOutAt?.toISOString() ?? null,
      timezone: entry.timezone,
      workDate: dateOnly(entry.workDate),
      status: entry.status,
    };
  }

  private async createResolvedException(
    client: Prisma.TransactionClient,
    data: {
      employeeId: string;
      employmentAssignmentId: string;
      timeEntryId: string;
      type: 'AUTO_CLOSED_CLOCK_OUT' | 'OPEN_BREAK_AUTO_CLOSED';
      detectedAt: Date;
      resolvedAt: Date;
      reason: string;
      metadata: Record<string, unknown>;
    },
    context: TimeRequestContext,
  ) {
    const existing = await client.attendanceException.findFirst({
      where: { timeEntryId: data.timeEntryId, type: data.type },
    });
    if (existing) return existing;
    const exception = await client.attendanceException.create({
      data: {
        employeeId: data.employeeId,
        employmentAssignmentId: data.employmentAssignmentId,
        timeEntryId: data.timeEntryId,
        type: data.type,
        severity: 'INFO',
        workflowImpact: 'NON_BLOCKING',
        status: 'RESOLVED',
        resolutionMethod: 'SYSTEM_AUTO_RESOLUTION',
        detectedAt: data.detectedAt,
        resolvedAt: data.resolvedAt,
        reason: data.reason,
        metadata: jsonMetadata(data.metadata),
      },
    });
    await this.writeAudit(
      client,
      'TIME_EXCEPTION_RECORDED',
      exception.id,
      context,
      {
        employeeId: data.employeeId,
        timeEntryId: data.timeEntryId,
        employmentAssignmentId: data.employmentAssignmentId,
        type: data.type,
      },
      'AttendanceException',
    );
    return exception;
  }

  private mergeExceptionMetadata(
    existing: unknown,
    update: Record<string, unknown>,
  ): Prisma.InputJsonObject {
    return {
      ...(isPlainRecord(existing) ? existing : {}),
      ...update,
    } as Prisma.InputJsonObject;
  }

  private openBreakForEntry(timeEntryId: string, client: TimeClient) {
    return client.breakEntry.findFirst({
      where: { timeEntryId, endAt: null, removedAt: null },
      orderBy: { startAt: 'desc' },
    });
  }

  private async closeBreak(
    client: Prisma.TransactionClient,
    employeeId: string,
    entry: {
      id: string;
      employmentAssignmentId: string;
      timezone: string;
    },
    breakEntry: { id: string },
    now: Date,
    options: {
      source?: 'LIVE_CLOCK' | 'SYSTEM' | 'KIOSK';
      attendanceDeviceId?: string | null;
    } = {},
  ) {
    const source = options.source ?? 'LIVE_CLOCK';
    await client.breakEntry.update({
      where: { id: breakEntry.id },
      data: { endAt: now },
    });
    await client.timePunch.create({
      data: {
        employeeId,
        employmentAssignmentId: entry.employmentAssignmentId,
        timeEntryId: entry.id,
        type: 'BREAK_END',
        occurredAt: now,
        timezone: entry.timezone,
        source,
        attendanceDeviceId: options.attendanceDeviceId ?? null,
      },
    });
  }

  private assignmentEffectiveOn(
    assignment: {
      status: string;
      startDate: Date;
      endDate: Date | null;
    },
    date: Date,
  ): boolean {
    return (
      assignment.status === 'ACTIVE' &&
      assignment.startDate.getTime() <= date.getTime() &&
      (assignment.endDate === null ||
        date.getTime() <= assignment.endDate.getTime())
    );
  }

  private employeeEffectiveOn(
    employee: {
      status: string;
      hireDate: Date;
      terminationDate: Date | null;
    },
    date: Date,
  ): boolean {
    return (
      employee.status === 'ACTIVE' &&
      employee.hireDate.getTime() <= date.getTime() &&
      (employee.terminationDate === null ||
        date.getTime() <= employee.terminationDate.getTime())
    );
  }

  /** WorkLocation, then Organization, like Scheduling and Leave; never a silent UTC. */
  private resolvedTimezone(
    assignment: NonNullable<Awaited<ReturnType<TimeService['assignmentById']>>>,
  ): string | null {
    for (const candidate of [
      assignment.position.workLocation?.timezone,
      assignment.position.organization.timezone,
    ]) {
      if (candidate && isIanaTimezone(candidate)) return candidate.trim();
    }
    return null;
  }

  /**
   * The timezone of a corrected entry: its own stored one (in which the corrected local times
   * were read) unless the correction moves it to another assignment. A correction never re-dates
   * an entry just because its assignment's timezone resolution has changed since it was recorded.
   */
  private correctedTimezone(
    entry: { employmentAssignmentId: string; timezone: string },
    targetAssignment: NonNullable<
      Awaited<ReturnType<TimeService['assignmentById']>>
    >,
  ): string {
    return targetAssignment.id === entry.employmentAssignmentId
      ? entry.timezone
      : this.assignmentTimezone(targetAssignment);
  }

  private assignmentTimezone(
    assignment: NonNullable<Awaited<ReturnType<TimeService['assignmentById']>>>,
  ): string {
    const timezone = this.resolvedTimezone(assignment);
    if (!timezone) {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        code: 'TIME_TIMEZONE_UNRESOLVED',
        message:
          'The assignment has no timezone: set one on its work location or organization.',
        employmentAssignmentId: assignment.id,
      });
    }
    return timezone;
  }

  private assignmentShape(
    assignment: NonNullable<Awaited<ReturnType<TimeService['assignmentById']>>>,
  ) {
    const position = assignment.position;
    const placement = position.team
      ? {
          type: 'TEAM',
          id: position.team.id,
          name: position.team.name,
          code: position.team.code,
        }
      : position.department
        ? {
            type: 'DEPARTMENT',
            id: position.department.id,
            name: position.department.name,
            code: position.department.code,
          }
        : position.organizationalUnit
          ? {
              type: 'ORGANIZATIONAL_UNIT',
              id: position.organizationalUnit.id,
              name: position.organizationalUnit.name,
              code: position.organizationalUnit.code,
            }
          : null;
    return {
      id: assignment.id,
      employmentType: assignment.employmentType,
      status: assignment.status,
      startDate: dateOnly(assignment.startDate),
      endDate: dateOnly(assignment.endDate),
      isPrimary: assignment.isPrimary,
      position: { id: position.id, name: position.name, code: position.code },
      jobTitle: {
        id: position.jobTitle.id,
        name: position.jobTitle.name,
        code: position.jobTitle.code,
      },
      organization: {
        id: position.organization.id,
        name: position.organization.name,
        code: position.organization.code,
      },
      placement,
      workLocation: position.workLocation
        ? {
            id: position.workLocation.id,
            name: position.workLocation.name,
            code: position.workLocation.code,
            timezone: position.workLocation.timezone,
          }
        : null,
    };
  }

  private writeAudit(
    client: TimeClient,
    action: string,
    entityId: string,
    context: TimeRequestContext,
    metadata: Record<string, unknown>,
    entityType = 'TimeEntry',
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
        metadata: JSON.parse(
          JSON.stringify(
            context.capture
              ? { ...metadata, capture: context.capture }
              : metadata,
          ),
        ) as Prisma.InputJsonValue,
      },
      client,
    );
  }
}

function dateOnly(value: Date | null): string | null {
  return value ? value.toISOString().slice(0, 10) : null;
}

function addDateOnlyDays(value: Date, days: number): Date {
  return new Date(value.getTime() + days * 24 * 60 * 60 * 1000);
}

function periodBounds(
  firstStartDate: Date,
  cadence: TimePeriodCadence,
  index: number,
) {
  if (cadence === 'WEEKLY') {
    const startDate = addDateOnlyDays(firstStartDate, index * 7);
    return { startDate, endDate: addDateOnlyDays(startDate, 6) };
  }
  if (cadence === 'BIWEEKLY') {
    const startDate = addDateOnlyDays(firstStartDate, index * 14);
    return { startDate, endDate: addDateOnlyDays(startDate, 13) };
  }
  const startDate = addDateOnlyMonths(firstStartDate, index);
  return {
    startDate,
    endDate: addDateOnlyDays(addDateOnlyMonths(startDate, 1), -1),
  };
}

/**
 * Batch 4C: a monthly cadence starts on day 1–28, so every month has the period's start day
 * (from the 29th, month arithmetic would skip into the following month).
 */
function assertPeriodStartFitsCadence(
  startDate: Date,
  cadence: TimePeriodCadence,
) {
  if (cadence === 'MONTHLY' && startDate.getUTCDate() > 28) {
    throw new BadRequestException(
      timeError(
        400,
        'TIME_PERIOD_START_INVALID',
        'A monthly period starts on day 1 to 28 of a month.',
      ),
    );
  }
}

/** A policy local time "HH:mm" or "HH:mm:ss" (comparable as text). */
function isLocalTimeValue(value: unknown): value is string {
  return typeof value === 'string' && /^\d{2}:\d{2}(?::\d{2})?$/.test(value);
}

/** Gross minutes of a closed entry and its recorded paid and unpaid break minutes. */
function entryBreakMinutes(entry: {
  clockInAt: Date;
  clockOutAt: Date;
  breaks: Array<{ startAt: Date; endAt: Date | null; payType: string | null }>;
}) {
  const grossMinutes = positiveFloorMinutes(
    entry.clockOutAt.getTime() - entry.clockInAt.getTime(),
  );
  let paidBreakMinutes = 0;
  let unpaidBreakMinutes = 0;
  for (const breakEntry of entry.breaks) {
    if (!breakEntry.endAt) continue;
    const minutes = positiveFloorMinutes(
      breakEntry.endAt.getTime() - breakEntry.startAt.getTime(),
    );
    if (breakEntry.payType === 'PAID') paidBreakMinutes += minutes;
    if (breakEntry.payType === 'UNPAID') unpaidBreakMinutes += minutes;
  }
  return { grossMinutes, paidBreakMinutes, unpaidBreakMinutes };
}

function addDateOnlyMonths(value: Date, months: number): Date {
  return new Date(
    Date.UTC(
      value.getUTCFullYear(),
      value.getUTCMonth() + months,
      value.getUTCDate(),
    ),
  );
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}

function numericPolicyValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : null;
}

function positiveCeilMinutes(milliseconds: number): number {
  return Math.max(0, Math.ceil(milliseconds / 60_000));
}

function positiveFloorMinutes(milliseconds: number): number {
  return Math.max(0, Math.floor(milliseconds / 60_000));
}

function personDisplayName(person: {
  firstName: string | null;
  middleName: string | null;
  lastName: string | null;
  preferredName: string | null;
}): string {
  return (
    person.preferredName ||
    [person.firstName, person.middleName, person.lastName]
      .filter(Boolean)
      .join(' ') ||
    'Unnamed employee'
  );
}

function payrollWorkDateOutputsFromTotals(
  totals: unknown,
): PayrollApprovedTimeOutput[] {
  const rows = jsonObject(totals).payrollWorkDates;
  if (!Array.isArray(rows)) return [];
  return rows.filter(isPayrollApprovedTimeOutput);
}

function isPayrollApprovedTimeOutput(
  value: unknown,
): value is PayrollApprovedTimeOutput {
  if (!isPlainRecord(value)) return false;
  return (
    typeof value.employeeId === 'string' &&
    typeof value.employmentAssignmentId === 'string' &&
    typeof value.timePeriodId === 'string' &&
    typeof value.workDate === 'string' &&
    typeof value.approvedWorkedMinutes === 'number' &&
    typeof value.grossMinutes === 'number' &&
    typeof value.paidBreakMinutes === 'number' &&
    typeof value.unpaidBreakMinutes === 'number' &&
    typeof value.policyDeductionMinutes === 'number' &&
    (value.finalizationStatus === 'APPROVED' ||
      value.finalizationStatus === 'LOCKED') &&
    typeof value.timesheetId === 'string' &&
    typeof value.timesheetSegmentId === 'string' &&
    typeof value.timesheetVersion === 'number'
  );
}

/** Active coverage rows with their assignment, in recorded order. */
function activeCoverageInclude() {
  return {
    where: { removedAt: null },
    include: {
      employmentAssignment: {
        include: { position: { include: positionInclude() } },
      },
    },
    orderBy: { createdAt: 'asc' },
  } as const;
}

function positionInclude() {
  return {
    jobTitle: true,
    organization: true,
    organizationalUnit: true,
    department: true,
    team: true,
    workLocation: true,
  } as const;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function jsonMetadata(value: Record<string, unknown>): Prisma.InputJsonObject {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonObject;
}

function jsonObject(value: unknown): Record<string, unknown> {
  return isPlainRecord(value) ? value : {};
}

function normalizedReason(value: string): string {
  return value.trim();
}

function isAssignmentWithPosition(
  value: unknown,
): value is { positionId: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'positionId' in value &&
    typeof (value as { positionId?: unknown }).positionId === 'string'
  );
}

function isEntryWithAssignment(
  value: unknown,
): value is { employmentAssignment: { positionId: string } } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'employmentAssignment' in value &&
    isAssignmentWithPosition(
      (value as { employmentAssignment?: unknown }).employmentAssignment,
    )
  );
}

/** The absolute ceiling for one time entry (the largest missed-punch threshold a policy allows). */
const MAX_TIME_ENTRY_MINUTES = 2880;

/** A coded Time error body, the shape every Time 4xx with a code uses. */
function timeError(
  statusCode: 400 | 403 | 404 | 409,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
) {
  return {
    statusCode,
    error:
      statusCode === 400
        ? 'Bad Request'
        : statusCode === 403
          ? 'Forbidden'
          : statusCode === 404
            ? 'Not Found'
            : 'Conflict',
    code,
    message,
    ...extra,
  };
}
