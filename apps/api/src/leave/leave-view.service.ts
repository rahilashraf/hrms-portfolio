import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  AuthorizationTarget,
  EffectiveGrant,
} from '../authorization/authorization.types.js';
import { holidayAppliesTo } from '../calendar/holiday-calendar.js';
import { PrismaService } from '../database/prisma.service.js';
import type { LeavePolicy, Prisma } from '../generated/prisma/client.js';
import { ScheduleAttendanceService } from '../scheduling/schedule-attendance.service.js';
import type { LeaveExpectedWorkCoverage } from '../scheduling/scheduling-integration.contracts.js';
import {
  LeaveAccessService,
  type LeavePermission,
} from './leave-access.service.js';
import {
  addDays,
  formatDate,
  localDateOf,
  overlapMinutesOf,
  parseDateOnly,
  positionTargets,
  resolveLeaveTimezone,
} from './leave-common.js';
import { LeaveIntegrationRegistry } from './leave-integration.js';
import { LeaveLedgerService } from './leave-ledger.service.js';
import { resolveLeavePolicy } from './leave-policy.js';
import {
  MAX_LEAVE_VIEW_DAYS,
  type LeaveBalanceQueryDto,
  type LeaveCalendarQueryDto,
  type LeaveRequestListQueryDto,
  type MyLeaveRequestsQueryDto,
} from './leave.dto.js';

const READERS: LeavePermission[] = ['leave.read', 'leave.approve'];
const BALANCE_READERS: LeavePermission[] = [
  'leave.read',
  'leave.approve',
  'leave.adjust',
];
const CONFIG_READERS = [
  'leave.manage_policy',
  'leave.read',
  'leave.approve',
] as const;
/** Permissions that open the leave management UI for an organization. */
const MANAGEMENT_PERMISSIONS = [
  'leave.read',
  'leave.approve',
  'leave.adjust',
  'leave.manage_policy',
  'holiday.manage',
] as const;

const REQUEST_LIST_INCLUDE = {
  employee: {
    select: {
      id: true,
      employeeNumber: true,
      person: {
        select: { firstName: true, lastName: true, preferredName: true },
      },
    },
  },
  employmentAssignment: {
    select: {
      id: true,
      employmentType: true,
      position: {
        select: {
          id: true,
          name: true,
          code: true,
          organizationId: true,
          organizationalUnitId: true,
          departmentId: true,
          teamId: true,
        },
      },
    },
  },
  account: { select: { leaveType: true } },
  days: { orderBy: { date: 'asc' } },
} as const satisfies Prisma.LeaveRequestInclude;

type ListedRequest = Prisma.LeaveRequestGetPayload<{
  include: typeof REQUEST_LIST_INCLUDE;
}>;

/**
 * Phase 8 — Leave read models. Backend-computed `actions` mirror the checks of the endpoints
 * they stand for; clients never re-derive authorization or lifecycle rules. Scoped lists
 * resolve visible positions once (positions + units, no per-row authorization queries).
 */
@Injectable()
export class LeaveViewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: LeaveAccessService,
    private readonly ledger: LeaveLedgerService,
    private readonly schedules: ScheduleAttendanceService,
    private readonly integration: LeaveIntegrationRegistry,
  ) {}

  // ─── Employee self-service ─────────────────────────────────────────────────

  async me(userId: string) {
    const employee = await this.access.selfEmployee(userId);
    const today = new Date();
    const assignments = await this.prisma.employmentAssignment.findMany({
      where: {
        employeeId: employee.id,
        // Phase 18: organizations with Leave disabled are left out.
        position: {
          organizationId: { notIn: await this.access.disabledOrganizations() },
        },
        OR: [
          { status: { in: ['ACTIVE', 'PLANNED'] } },
          {
            status: 'ENDED',
            endDate: {
              gte: addDays(new Date(today.toISOString().slice(0, 10)), -366),
            },
          },
        ],
      },
      include: {
        position: {
          select: {
            id: true,
            name: true,
            code: true,
            organizationId: true,
            organizationalUnitId: true,
            departmentId: true,
            teamId: true,
            workLocation: { select: { timezone: true } },
            organization: { select: { id: true, name: true, timezone: true } },
          },
        },
      },
      orderBy: [{ isPrimary: 'desc' }, { startDate: 'asc' }, { id: 'asc' }],
    });
    const grants = await this.access.grants(userId);
    const targets = await positionTargets(
      this.prisma,
      assignments.map((a) => a.position),
    );
    const organizationIds = [
      ...new Set(assignments.map((a) => a.position.organizationId)),
    ];
    const [types, accounts] = await Promise.all([
      this.prisma.leaveType.findMany({
        where: { organizationId: { in: organizationIds }, archivedAt: null },
        include: { policies: true },
        orderBy: [{ name: 'asc' }, { code: 'asc' }],
      }),
      this.prisma.leaveAccount.findMany({ where: { employeeId: employee.id } }),
    ]);
    const asOfByAccount: { id: string; asOf: Date }[] = [];
    const prepared = assignments.map((assignment) => {
      let timezone: string | null = null;
      try {
        timezone = resolveLeaveTimezone(assignment.position);
      } catch {
        timezone = null;
      }
      const asOf = timezone ? localDateOf(today, timezone) : null;
      for (const account of accounts.filter(
        (a) => a.employmentAssignmentId === assignment.id,
      )) {
        if (asOf) asOfByAccount.push({ id: account.id, asOf });
      }
      return { assignment, timezone, asOf };
    });
    const [balances, pending] = await Promise.all([
      this.ledger.balances(this.prisma, asOfByAccount),
      this.ledger.pendingMinutes(
        this.prisma,
        accounts.map((a) => a.id),
      ),
    ]);
    return {
      employeeId: employee.id,
      assignments: prepared.map(({ assignment, timezone, asOf }) => {
        const target = targets.get(assignment.position.id)!;
        const canRequest =
          this.access.can(grants, 'leave.request', target) && timezone !== null;
        const subject = {
          employmentAssignmentId: assignment.id,
          employmentType: assignment.employmentType,
          target,
        };
        return {
          employmentAssignmentId: assignment.id,
          isPrimary: assignment.isPrimary,
          employmentType: assignment.employmentType,
          status: assignment.status,
          startDate: formatDate(assignment.startDate),
          endDate: assignment.endDate && formatDate(assignment.endDate),
          position: {
            id: assignment.position.id,
            name: assignment.position.name,
            code: assignment.position.code,
          },
          organization: {
            id: assignment.position.organization.id,
            name: assignment.position.organization.name,
          },
          timezone,
          asOf: asOf && formatDate(asOf),
          leaveTypes: types
            .filter(
              (type) =>
                type.organizationId === assignment.position.organizationId,
            )
            .map((type) => {
              const policy = asOf
                ? resolveLeavePolicy(type.policies, subject, asOf)
                : null;
              const account = accounts.find(
                (a) =>
                  a.employmentAssignmentId === assignment.id &&
                  a.leaveTypeId === type.id,
              );
              const eligible = !!policy?.eligible;
              if (!eligible && !account) return null;
              return {
                leaveType: this.typeSummary(type),
                eligible,
                policy: policy && this.policySummary(policy),
                accountId: account?.id ?? null,
                balance: type.tracksBalance
                  ? {
                      ...(account
                        ? balances.get(account.id)!
                        : {
                            currentMinutes: 0,
                            scheduledMinutes: 0,
                            availableMinutes: 0,
                          }),
                      pendingMinutes: account
                        ? (pending.get(account.id) ?? 0)
                        : 0,
                    }
                  : null,
                actions: { canRequest: canRequest && eligible },
              };
            })
            .filter((row) => row !== null),
          actions: { canRequest },
        };
      }),
    };
  }

  async myRequests(userId: string, query: MyLeaveRequestsQueryDto) {
    const employee = await this.access.selfEmployee(userId);
    const max = Math.min(Math.max(query.limit ?? 50, 1), 200);
    const rows = await this.prisma.leaveRequest.findMany({
      where: {
        employeeId: employee.id,
        employmentAssignment: {
          position: {
            organizationId: {
              notIn: await this.access.disabledOrganizations(),
            },
          },
        },
        ...(query.status ? { status: query.status } : {}),
      },
      include: REQUEST_LIST_INCLUDE,
      orderBy: [{ startDate: 'desc' }, { id: 'desc' }],
      take: max + 1,
      ...(query.afterId ? { cursor: { id: query.afterId }, skip: 1 } : {}),
    });
    const page = rows.slice(0, max);
    const policies = await this.policiesByType(page.map((r) => r.leaveTypeId));
    const targets = await positionTargets(
      this.prisma,
      page.map((r) => r.employmentAssignment.position),
    );
    const locked = await this.lockedDaysOf(page);
    return {
      items: page.map((row) => ({
        ...this.requestSummary(row),
        actions: {
          canCancel: this.ownCancellable(
            row,
            policies,
            targets.get(row.employmentAssignment.position.id)!,
            locked.get(row.id) ?? new Set(),
          ),
        },
      })),
      nextAfterId: rows.length > max ? (page.at(-1)?.id ?? null) : null,
    };
  }

  // ─── Request detail (self or scoped reader) ────────────────────────────────

  async requestDetail(userId: string, requestId: string) {
    const request = await this.prisma.leaveRequest.findUnique({
      where: { id: requestId },
      include: {
        ...REQUEST_LIST_INCLUDE,
        events: { orderBy: { occurredAt: 'asc' } },
        amendments: { orderBy: { createdAt: 'asc' } },
        ledgerEntries: {
          orderBy: [{ effectiveDate: 'asc' }, { postedAt: 'asc' }],
        },
      },
    });
    if (!request) throw new NotFoundException('Leave request not found');
    const target = (
      await positionTargets(this.prisma, [
        request.employmentAssignment.position,
      ])
    ).get(request.employmentAssignment.position.id)!;
    const grants = await this.access.grants(userId);
    const selfEmployeeId = await this.access.employeeIdOfUser(userId);
    const isSelf = selfEmployeeId === request.employeeId;
    if (!isSelf && !this.access.canAny(grants, READERS, target)) {
      throw new NotFoundException('Leave request not found');
    }
    await this.access.requireEnabled(target.organizationId);
    const decider = !isSelf && this.access.can(grants, 'leave.approve', target);
    const policies = await this.policiesByType([request.leaveTypeId]);
    const asOf = localDateOf(new Date(), request.timezone);
    // Amendments and cancellations are refused on dates inside locked time periods.
    const locked =
      (await this.lockedDaysOf([request])).get(request.id) ?? new Set<string>();
    const balance = request.account.leaveType.tracksBalance
      ? await this.ledger.balanceOf(this.prisma, request.accountId, asOf)
      : null;
    return {
      ...this.requestSummary(request),
      reason: request.reason,
      decisionNote: request.decisionNote,
      decidedByUserId: request.decidedByUserId,
      decidedAt: request.decidedAt?.toISOString() ?? null,
      requestedByUserId: request.requestedByUserId,
      submittedAt: request.submittedAt.toISOString(),
      days: request.days.map((day) => ({
        id: day.id,
        date: formatDate(day.date),
        minutes: day.minutes,
        amountSource: day.amountSource,
        windowStart: day.windowStart.toISOString(),
        windowEnd: day.windowEnd.toISOString(),
        absenceStart: day.absenceStart.toISOString(),
        absenceEnd: day.absenceEnd.toISOString(),
        holidayName: day.holidayName,
        overrideReason: day.overrideReason,
        scheduledShiftRevisionIds: day.scheduledShiftRevisionIds,
        cancelled: day.cancelledByAmendmentId !== null,
        cancelledByAmendmentId: day.cancelledByAmendmentId,
        /** Inside a locked time period: this day can no longer be cancelled. */
        locked: locked.has(formatDate(day.date)),
      })),
      events: request.events.map((event) => ({
        id: event.id,
        type: event.type,
        actorUserId: event.actorUserId,
        note: event.note,
        metadata: event.metadata,
        occurredAt: event.occurredAt.toISOString(),
      })),
      amendments: request.amendments.map((amendment) => ({
        id: amendment.id,
        type: amendment.type,
        reason: amendment.reason,
        cancelledMinutes: amendment.cancelledMinutes,
        actorUserId: amendment.actorUserId,
        createdAt: amendment.createdAt.toISOString(),
      })),
      ledgerEntries: request.ledgerEntries.map((entry) =>
        this.ledger.entryShape(entry),
      ),
      balance,
      coverage: await this.coverage(request),
      actions: {
        // Batch 6B (L1): approval re-checks the leave type, which must not be archived.
        canApprove:
          decider &&
          request.status === 'PENDING' &&
          request.account.leaveType.archivedAt === null,
        canReject: decider && request.status === 'PENDING',
        canAmend: decider && this.amendable(request, locked),
        canCancel:
          isSelf && this.ownCancellable(request, policies, target, locked),
      },
    };
  }

  /**
   * Published shifts the leave overlaps today (Phase 7 LeaveExpectedWorkCoverage). Leave never
   * cancels them; a manager decides explicitly through Scheduling's published workflow.
   */
  private async coverage(
    request: ListedRequest,
  ): Promise<LeaveExpectedWorkCoverage> {
    const active = request.days.filter(
      (day) => day.cancelledByAmendmentId === null,
    );
    const empty = {
      leaveRequestId: request.id,
      coveredShifts: [],
      totalOverlapMinutes: 0,
    };
    if (
      active.length === 0 ||
      request.status === 'REJECTED' ||
      request.status === 'CANCELLED'
    ) {
      return empty;
    }
    const start = new Date(
      Math.min(...active.map((d) => d.absenceStart.getTime())),
    );
    const end = new Date(
      Math.max(...active.map((d) => d.absenceEnd.getTime())),
    );
    const facts = [];
    for (
      let chunk = start;
      chunk < end;
      chunk = new Date(chunk.getTime() + 90 * 86_400_000)
    ) {
      const chunkEnd = new Date(
        Math.min(end.getTime(), chunk.getTime() + 90 * 86_400_000),
      );
      facts.push(
        ...(await this.schedules.publishedExpectedWork({
          employeeId: request.employeeId,
          employmentAssignmentId: request.employmentAssignmentId,
          start: chunk.toISOString(),
          end: chunkEnd.toISOString(),
        })),
      );
    }
    const unique = [
      ...new Map(facts.map((f) => [f.scheduledShiftId, f])).values(),
    ];
    const coveredShifts = unique
      .map((fact) => ({
        ...fact,
        overlapMinutes: active.reduce(
          (sum, day) =>
            sum +
            overlapMinutesOf(
              { start: new Date(fact.startsAt), end: new Date(fact.endsAt) },
              { start: day.absenceStart, end: day.absenceEnd },
            ),
          0,
        ),
      }))
      .filter((shift) => shift.overlapMinutes > 0);
    return {
      leaveRequestId: request.id,
      coveredShifts,
      totalOverlapMinutes: coveredShifts.reduce(
        (sum, s) => sum + s.overlapMinutes,
        0,
      ),
    };
  }

  // ─── Manager / admin ───────────────────────────────────────────────────────

  async queue(userId: string, query: LeaveRequestListQueryDto) {
    const grants = await this.access.grants(userId);
    const max = Math.min(Math.max(query.limit ?? 50, 1), 200);
    const visible = await this.visiblePositions(
      query.organizationId,
      grants,
      READERS,
    );
    if (visible.size === 0) return { items: [], nextAfterId: null };
    const from = query.from ? parseDateOnly(query.from, 'from') : null;
    const to = query.to ? parseDateOnly(query.to, 'to') : null;
    const rows = await this.prisma.leaveRequest.findMany({
      where: {
        employmentAssignment: { positionId: { in: [...visible.keys()] } },
        ...(query.status ? { status: query.status } : {}),
        ...(query.employeeId ? { employeeId: query.employeeId } : {}),
        ...(query.leaveTypeId ? { leaveTypeId: query.leaveTypeId } : {}),
        ...(from ? { endDate: { gte: from } } : {}),
        ...(to ? { startDate: { lte: to } } : {}),
      },
      include: REQUEST_LIST_INCLUDE,
      orderBy: [{ startDate: 'asc' }, { id: 'asc' }],
      take: max + 1,
      ...(query.afterId ? { cursor: { id: query.afterId }, skip: 1 } : {}),
    });
    const page = rows.slice(0, max);
    const selfEmployeeId = await this.access.employeeIdOfUser(userId);
    const locked = await this.lockedDaysOf(page);
    return {
      items: page.map((row) => {
        const target = visible.get(row.employmentAssignment.position.id)!;
        const decider =
          row.employeeId !== selfEmployeeId &&
          this.access.can(grants, 'leave.approve', target);
        return {
          ...this.requestSummary(row),
          actions: {
            // Batch 6B (L1): an archived leave type cannot be approved (reject still can).
            canApprove:
              decider &&
              row.status === 'PENDING' &&
              row.account.leaveType.archivedAt === null,
            canReject: decider && row.status === 'PENDING',
            canAmend:
              decider && this.amendable(row, locked.get(row.id) ?? new Set()),
          },
        };
      }),
      nextAfterId: rows.length > max ? (page.at(-1)?.id ?? null) : null,
    };
  }

  async balances(userId: string, query: LeaveBalanceQueryDto) {
    const grants = await this.access.grants(userId);
    const max = Math.min(Math.max(query.limit ?? 100, 1), 500);
    const visible = await this.visiblePositions(
      query.organizationId,
      grants,
      BALANCE_READERS,
    );
    if (visible.size === 0)
      return { asOf: query.asOf ?? null, items: [], nextAfterId: null };
    const accounts = await this.prisma.leaveAccount.findMany({
      where: {
        employmentAssignment: { positionId: { in: [...visible.keys()] } },
        // Untracked leave types have accounts (requests anchor on them) but no balance.
        leaveType: {
          organizationId: query.organizationId,
          tracksBalance: true,
        },
        ...(query.leaveTypeId ? { leaveTypeId: query.leaveTypeId } : {}),
        ...(query.employeeId ? { employeeId: query.employeeId } : {}),
      },
      include: {
        leaveType: true,
        employee: {
          select: {
            id: true,
            employeeNumber: true,
            person: {
              select: { firstName: true, lastName: true, preferredName: true },
            },
          },
        },
        employmentAssignment: {
          select: {
            id: true,
            positionId: true,
            position: {
              select: {
                name: true,
                workLocation: { select: { timezone: true } },
                organization: { select: { timezone: true } },
              },
            },
          },
        },
      },
      orderBy: { id: 'asc' },
      take: max + 1,
      ...(query.afterId ? { cursor: { id: query.afterId }, skip: 1 } : {}),
    });
    const page = accounts.slice(0, max);
    const fixed = query.asOf ? parseDateOnly(query.asOf, 'asOf') : null;
    // Never a silent UTC "today": an account whose timezone does not resolve has no balance
    // unless the caller fixes asOf.
    const asOfs = page.map((account) => {
      let asOf = fixed;
      if (!asOf) {
        try {
          asOf = localDateOf(
            new Date(),
            resolveLeaveTimezone(account.employmentAssignment.position),
          );
        } catch {
          asOf = null;
        }
      }
      return { id: account.id, asOf };
    });
    const selfEmployeeId = await this.access.employeeIdOfUser(userId);
    const [balances, pending] = await Promise.all([
      this.ledger.balances(
        this.prisma,
        asOfs.filter(
          (row): row is { id: string; asOf: Date } => row.asOf !== null,
        ),
      ),
      this.ledger.pendingMinutes(
        this.prisma,
        page.map((a) => a.id),
      ),
    ]);
    return {
      asOf: query.asOf ?? null,
      items: page.map((account, index) => ({
        accountId: account.id,
        employee: this.employeeSummary(account.employee),
        employmentAssignmentId: account.employmentAssignmentId,
        positionName: account.employmentAssignment.position.name,
        leaveType: this.typeSummary(account.leaveType),
        asOf: asOfs[index]!.asOf && formatDate(asOfs[index]!.asOf!),
        timezoneUnresolved: asOfs[index]!.asOf === null,
        balance: asOfs[index]!.asOf
          ? {
              ...balances.get(account.id)!,
              pendingMinutes: pending.get(account.id) ?? 0,
            }
          : null,
        actions: {
          // Mirrors adjust: never one's own balance.
          canAdjust:
            account.employeeId !== selfEmployeeId &&
            this.access.can(
              grants,
              'leave.adjust',
              visible.get(account.employmentAssignment.positionId)!,
            ),
        },
      })),
      nextAfterId: accounts.length > max ? (page.at(-1)?.id ?? null) : null,
    };
  }

  /** Team absence calendar: leave days (and applicable holidays) in a bounded range. */
  async calendar(userId: string, query: LeaveCalendarQueryDto) {
    const from = parseDateOnly(query.from, 'from');
    const to = parseDateOnly(query.to, 'to');
    if (to < from)
      throw new BadRequestException('to must be on or after from.');
    if (to > addDays(from, MAX_LEAVE_VIEW_DAYS - 1)) {
      throw new BadRequestException(
        `A leave calendar may span at most ${MAX_LEAVE_VIEW_DAYS} days.`,
      );
    }
    const grants = await this.access.grants(userId);
    const visible = await this.visiblePositions(
      query.organizationId,
      grants,
      READERS,
    );
    const range = { from: formatDate(from), to: formatDate(to) };
    if (visible.size === 0) return { range, entries: [], holidays: [] };
    const positionIds = [...visible.entries()]
      .filter(
        ([, target]) =>
          (!query.departmentId || target.departmentId === query.departmentId) &&
          (!query.teamId || target.teamId === query.teamId),
      )
      .map(([id]) => id);
    const [requests, holidays] = await Promise.all([
      this.prisma.leaveRequest.findMany({
        where: {
          employmentAssignment: { positionId: { in: positionIds } },
          status: {
            in: query.includePending ? ['APPROVED', 'PENDING'] : ['APPROVED'],
          },
          startDate: { lte: to },
          endDate: { gte: from },
        },
        include: {
          ...REQUEST_LIST_INCLUDE,
          days: {
            where: {
              date: { gte: from, lte: to },
              cancelledByAmendmentId: null,
            },
            orderBy: { date: 'asc' },
          },
        },
        orderBy: [{ startDate: 'asc' }, { id: 'asc' }],
      }),
      this.prisma.organizationHoliday.findMany({
        where: {
          organizationId: query.organizationId,
          archivedAt: null,
          date: { gte: from, lte: to },
        },
        orderBy: [{ date: 'asc' }, { id: 'asc' }],
      }),
    ]);
    const targets = positionIds.map((id) => visible.get(id)!);
    return {
      range,
      entries: requests
        .filter((request) => request.days.length > 0)
        .map((request) => ({
          requestId: request.id,
          status: request.status,
          employee: this.employeeSummary(request.employee),
          employmentAssignmentId: request.employmentAssignmentId,
          positionName: request.employmentAssignment.position.name,
          leaveType: this.typeSummary(request.account.leaveType),
          days: request.days.map((day) => ({
            date: formatDate(day.date),
            minutes: day.minutes,
            partial: request.startLocalTime !== null,
            windowStart: day.windowStart.toISOString(),
            windowEnd: day.windowEnd.toISOString(),
          })),
        })),
      holidays: holidays
        .filter((holiday) =>
          targets.some((target) => holidayAppliesTo(holiday, target)),
        )
        .map((holiday) => ({
          id: holiday.id,
          date: formatDate(holiday.date),
          name: holiday.name,
          kind: holiday.kind,
          organizationalUnitId: holiday.organizationalUnitId,
          departmentId: holiday.departmentId,
          teamId: holiday.teamId,
        })),
    };
  }

  /**
   * Organizations in which the actor holds any leave-operations or holiday permission, at any
   * scope, with what they may do there. Lets the management UI pick an organization without
   * organization.read (a team approver usually lacks it).
   */
  async organizations(userId: string) {
    const grants = (await this.access.grants(userId)).filter((g) =>
      (MANAGEMENT_PERMISSIONS as readonly string[]).includes(g.permission),
    );
    if (grants.length === 0) return { items: [] };
    const system = grants.some((g) => g.scope.type === 'SYSTEM');
    const ids = (type: string) => [
      ...new Set(
        grants
          .filter((g) => g.scope.type === type)
          .map((g) => g.scope.id!)
          .filter(Boolean),
      ),
    ];
    const [units, departments, teams] = await Promise.all([
      this.prisma.organizationalUnit.findMany({
        where: { id: { in: ids('ORGANIZATIONAL_UNIT') } },
        select: { id: true, organizationId: true, name: true },
      }),
      this.prisma.department.findMany({
        where: { id: { in: ids('DEPARTMENT') } },
        select: { id: true, organizationId: true, name: true },
      }),
      this.prisma.team.findMany({
        where: { id: { in: ids('TEAM') } },
        select: { id: true, organizationId: true, name: true },
      }),
    ]);
    const organizationOf = new Map<string, string>(
      [...units, ...departments, ...teams].map((row) => [
        row.id,
        row.organizationId,
      ]),
    );
    const scopedOrganization = (g: EffectiveGrant) =>
      g.scope.type === 'ORGANIZATION'
        ? g.scope.id
        : organizationOf.get(g.scope.id ?? '');
    const disabled = await this.access.disabledOrganizations();
    const organizations = await this.prisma.organization.findMany({
      where: {
        archivedAt: null,
        AND: [{ id: { notIn: disabled } }],
        ...(system
          ? {}
          : {
              id: {
                in: [
                  ...new Set(
                    grants
                      .map(scopedOrganization)
                      .filter((id): id is string => !!id),
                  ),
                ],
              },
            }),
      },
      select: { id: true, name: true, timezone: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
    return {
      items: organizations.map((organization) => {
        const anywhere = (permissions: readonly string[]) =>
          grants.some(
            (g) =>
              permissions.includes(g.permission) &&
              (g.scope.type === 'SYSTEM' ||
                scopedOrganization(g) === organization.id),
          );
        const atOrganization = (permission: string) =>
          grants.some(
            (g) =>
              g.permission === permission &&
              (g.scope.type === 'SYSTEM' ||
                (g.scope.type === 'ORGANIZATION' &&
                  g.scope.id === organization.id)),
          );
        return {
          ...organization,
          actions: {
            canReadRequests: anywhere(READERS),
            canApprove: anywhere(['leave.approve']),
            canViewBalances: anywhere(BALANCE_READERS),
            canAdjust: anywhere(['leave.adjust']),
            canReadConfiguration: anywhere(CONFIG_READERS),
            canManageTypes: atOrganization('leave.manage_policy'),
            canManagePolicies: anywhere(['leave.manage_policy']),
            // Mirrors the holiday endpoints: listing is scoped (see HolidayService.list),
            // creating needs holiday.manage on the new holiday's own scope.
            canReadHolidays: anywhere([
              'holiday.manage',
              'leave.read',
              'leave.approve',
            ]),
            canManageHolidays: anywhere(['holiday.manage']),
            canManageOrganizationHolidays: atOrganization('holiday.manage'),
          },
          /** Scopes the actor may add holidays to below the organization (direct grants). */
          holidayScopes: grants
            .filter(
              (g) =>
                g.permission === 'holiday.manage' &&
                g.scope.type !== 'SYSTEM' &&
                g.scope.type !== 'ORGANIZATION' &&
                scopedOrganization(g) === organization.id,
            )
            .map((g) => ({
              type: g.scope.type as
                'ORGANIZATIONAL_UNIT' | 'DEPARTMENT' | 'TEAM',
              id: g.scope.id!,
              name:
                [...units, ...departments, ...teams].find(
                  (row) => row.id === g.scope.id,
                )?.name ?? g.scope.id!,
            }))
            .filter(
              (scope, index, all) =>
                all.findIndex((other) => other.id === scope.id) === index,
            ),
        };
      }),
    };
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  /** Positions of an organization on which the actor holds any of the permissions. */
  private async visiblePositions(
    organizationId: string,
    grants: EffectiveGrant[],
    permissions: LeavePermission[],
  ): Promise<Map<string, AuthorizationTarget>> {
    if (!grants.some((g) => (permissions as string[]).includes(g.permission)))
      return new Map();
    const positions = await this.prisma.position.findMany({
      where: { organizationId },
      select: {
        id: true,
        organizationId: true,
        organizationalUnitId: true,
        departmentId: true,
        teamId: true,
      },
    });
    const targets = await positionTargets(this.prisma, positions);
    const visible = new Map(
      [...targets].filter(([, target]) =>
        this.access.canAny(grants, permissions, target),
      ),
    );
    // Phase 18: queue, balances and calendar of one organization need Leave enabled.
    if (visible.size > 0) await this.access.requireEnabled(organizationId);
    return visible;
  }

  private async policiesByType(typeIds: string[]) {
    const unique = [...new Set(typeIds)];
    const rows = unique.length
      ? await this.prisma.leavePolicy.findMany({
          where: { leaveTypeId: { in: unique } },
        })
      : [];
    const map = new Map<string, LeavePolicy[]>();
    for (const row of rows)
      map.set(row.leaveTypeId, [...(map.get(row.leaveTypeId) ?? []), row]);
    return map;
  }

  /**
   * Locked dates (YYYY-MM-DD) among the active days of each APPROVED request, by request id.
   * One read per organization on the page (no row locks: this is a read model).
   */
  private async lockedDaysOf(
    rows: readonly ListedRequest[],
  ): Promise<Map<string, Set<string>>> {
    const result = new Map<string, Set<string>>();
    const byOrganization = new Map<string, Map<string, Date[]>>();
    for (const row of rows) {
      if (row.status !== 'APPROVED') continue;
      const organizationId = row.employmentAssignment.position.organizationId;
      const employees =
        byOrganization.get(organizationId) ?? new Map<string, Date[]>();
      byOrganization.set(organizationId, employees);
      employees.set(row.employeeId, [
        ...(employees.get(row.employeeId) ?? []),
        ...row.days
          .filter((d) => d.cancelledByAmendmentId === null)
          .map((d) => d.date),
      ]);
    }
    const lockedByOrganization = new Map<string, Map<string, Set<string>>>();
    for (const [organizationId, employeeDates] of byOrganization) {
      lockedByOrganization.set(
        organizationId,
        await this.integration.lockedDates(
          this.prisma,
          { organizationId, employeeDates },
          { lock: false },
        ),
      );
    }
    for (const row of rows) {
      const employeeLocked =
        lockedByOrganization
          .get(row.employmentAssignment.position.organizationId)
          ?.get(row.employeeId) ?? new Set<string>();
      result.set(
        row.id,
        new Set(
          row.days
            .filter((d) => d.cancelledByAmendmentId === null)
            .map((d) => formatDate(d.date))
            .filter((date) => employeeLocked.has(date)),
        ),
      );
    }
    return result;
  }

  /** Mirrors amend: approved, with at least one active day outside locked time periods. */
  private amendable(row: ListedRequest, locked: ReadonlySet<string>) {
    return (
      row.status === 'APPROVED' &&
      row.days.some(
        (d) =>
          d.cancelledByAmendmentId === null && !locked.has(formatDate(d.date)),
      )
    );
  }

  /**
   * Mirrors cancelOwn: pending always; approved only when the policy allows and there are
   * future days, none of them locked (cancelOwn cancels every remaining future day at once).
   */
  private ownCancellable(
    row: ListedRequest,
    policies: Map<string, LeavePolicy[]>,
    target: AuthorizationTarget,
    locked: ReadonlySet<string>,
  ) {
    if (row.status === 'PENDING') return true;
    if (row.status !== 'APPROVED') return false;
    const policy = resolveLeavePolicy(
      policies.get(row.leaveTypeId) ?? [],
      {
        employmentAssignmentId: row.employmentAssignmentId,
        employmentType: row.employmentAssignment.employmentType,
        target,
      },
      row.startDate,
    );
    const today = localDateOf(new Date(), row.timezone);
    const future = row.days.filter(
      (day) => day.cancelledByAmendmentId === null && day.date > today,
    );
    return (
      !!policy?.employeeMayCancelApprovedFuture &&
      future.length > 0 &&
      future.every((day) => !locked.has(formatDate(day.date)))
    );
  }

  private requestSummary(row: ListedRequest) {
    const active = row.days.filter(
      (day) => day.cancelledByAmendmentId === null,
    );
    return {
      id: row.id,
      status: row.status,
      employee: this.employeeSummary(row.employee),
      employmentAssignmentId: row.employmentAssignmentId,
      positionName: row.employmentAssignment.position.name,
      leaveType: this.typeSummary(row.account.leaveType),
      startDate: formatDate(row.startDate),
      endDate: formatDate(row.endDate),
      startLocalTime: row.startLocalTime,
      endLocalTime: row.endLocalTime,
      timezone: row.timezone,
      requestedMinutes: row.requestedMinutes,
      approvedMinutes: row.approvedMinutes,
      activeMinutes:
        row.status === 'APPROVED'
          ? active.reduce((sum, d) => sum + d.minutes, 0)
          : null,
      cancelledDayCount: row.days.length - active.length,
      submittedAt: row.submittedAt.toISOString(),
    };
  }

  private employeeSummary(employee: {
    id: string;
    employeeNumber: string;
    person: {
      firstName: string | null;
      lastName: string | null;
      preferredName: string | null;
    };
  }) {
    return {
      id: employee.id,
      employeeNumber: employee.employeeNumber,
      displayName:
        [
          employee.person.preferredName ?? employee.person.firstName,
          employee.person.lastName,
        ]
          .filter(Boolean)
          .join(' ') || null,
    };
  }

  private typeSummary(type: {
    id: string;
    code: string;
    name: string;
    classification: string;
    tracksBalance: boolean;
    displayUnit: string;
    archivedAt?: Date | null;
  }) {
    return {
      id: type.id,
      code: type.code,
      name: type.name,
      classification: type.classification,
      tracksBalance: type.tracksBalance,
      displayUnit: type.displayUnit,
      // Batch 6B (L1): lets the UI explain why a pending request cannot be approved.
      archived: Boolean(type.archivedAt),
    };
  }

  private policySummary(policy: LeavePolicy) {
    return {
      id: policy.id,
      standardWorkdayMinutes: policy.standardWorkdayMinutes,
      allowPartialDay: policy.allowPartialDay,
      amountSource: policy.amountSource,
      negativeBalanceLimitMinutes: policy.negativeBalanceLimitMinutes,
      employeeMayCancelApprovedFuture: policy.employeeMayCancelApprovedFuture,
    };
  }
}
