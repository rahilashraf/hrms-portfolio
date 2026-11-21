import { ForbiddenException, Injectable } from '@nestjs/common';
import { AuthorizationService } from '../authorization/authorization.service.js';
import { localDateOf } from '../common/domain-support.js';
import { PrismaService } from '../database/prisma.service.js';
import { EmployeeDocumentService } from '../documents/employee-document.service.js';
import { PolicyDocumentService } from '../documents/policy-document.service.js';
import type { FeatureModule } from '../features/features-domain.js';
import { LeaveViewService } from '../leave/leave-view.service.js';
import { WRITABLE } from '../performance/performance-review.service.js';
import {
  placementFilter,
  placementWhere,
  resolvedPositionWhere,
  type UnitRow,
} from './workspace-domain.js';
import {
  disabledModules,
  requireOrganizationContext,
} from './workspace-scope.js';

export interface DashboardCard {
  key: string;
  label: string;
  value: number | null;
  href: string;
  area: string;
}

export interface QuickAction {
  key: string;
  label: string;
  href: string;
}

type Where = Record<string, unknown>;

/**
 * Phase 20 — the role-aware dashboard of one organization. A card appears only when the caller
 * holds the card's source permission somewhere in the organization AND the module is enabled;
 * its number counts only the records that permission reaches, with the same scope semantics
 * as the domain queue it links to (and never the caller's own records where that queue
 * refuses them). Counts are COUNT queries (or the domain's own bounded aggregate service), never
 * unbounded row loads. Nothing here grants access: the linked pages authorize on their own.
 */
@Injectable()
export class DashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService,
    private readonly leave: LeaveViewService,
    private readonly documents: EmployeeDocumentService,
    private readonly policies: PolicyDocumentService,
  ) {}

  async dashboard(userId: string, organizationId: string, now = new Date()) {
    const grants = await this.authorization.effectiveGrants(userId, now);
    const context = await requireOrganizationContext(
      this.prisma,
      grants,
      userId,
      organizationId,
    );
    const disabled =
      (await disabledModules(this.prisma, [organizationId])).get(
        organizationId,
      ) ?? new Set<FeatureModule>();
    const enabled = (module: FeatureModule) => !disabled.has(module);
    const units: UnitRow[] = grants.some(
      (grant) => grant.scope.type === 'ORGANIZATIONAL_UNIT',
    )
      ? await this.prisma.organizationalUnit.findMany({
          where: { organizationId },
          select: { id: true, parentUnitId: true },
        })
      : [];
    const filter = (permissions: readonly string[]) =>
      placementFilter(grants, permissions, organizationId, units);
    /** Positions under positionTargets semantics (leave, onboarding, performance, …). */
    const placed = (permissions: readonly string[]) => {
      const where = placementWhere(filter(permissions));
      return where && { organizationId, ...where };
    };
    /** Positions under resolver semantics (employee.*, time.*). */
    const resolved = (permissions: readonly string[]) => {
      const where = resolvedPositionWhere(filter(permissions));
      return where && { organizationId, ...where };
    };
    const selfId = context.employeeId;
    const notSelf: Where = selfId ? { employeeId: { not: selfId } } : {};

    const cards: DashboardCard[] = [];
    const add = async (
      card: Omit<DashboardCard, 'value'>,
      module: FeatureModule | null,
      position: Where | null,
      count: (position: Where) => Promise<number>,
    ) => {
      if (module && !enabled(module)) return;
      if (!position) return;
      cards.push({ ...card, value: await count(position) });
    };

    await add(
      {
        key: 'activeEmployees',
        label: 'Active employees',
        href: '/admin/employees',
        area: 'People',
      },
      null,
      resolved(['employee.read']),
      (position) =>
        this.prisma.employee.count({
          where: {
            archivedAt: null,
            status: 'ACTIVE',
            assignments: { some: { status: 'ACTIVE', position } },
          },
        }),
    );
    await add(
      {
        key: 'pendingLeaveApprovals',
        label: 'Leave requests to approve',
        href: '/admin/leave',
        area: 'Leave',
      },
      'LEAVE',
      placed(['leave.approve']),
      (position) =>
        this.prisma.leaveRequest.count({
          where: {
            status: 'PENDING',
            ...notSelf,
            employmentAssignment: { position },
          },
        }),
    );
    await add(
      {
        key: 'timesheetsAwaitingApproval',
        label: 'Timesheets awaiting approval',
        href: '/admin/time#timesheets',
        area: 'Time & attendance',
      },
      'ATTENDANCE',
      resolved(['time.timesheet.approve']),
      (position) =>
        this.prisma.timesheetSegment.count({
          where: {
            status: 'PENDING',
            timesheet: { status: 'SUBMITTED', ...notSelf },
            employmentAssignment: { position },
          },
        }),
    );
    await add(
      {
        key: 'openAttendanceExceptions',
        label: 'Open attendance exceptions',
        href: '/admin/time',
        area: 'Time & attendance',
      },
      'ATTENDANCE',
      resolved(['time.view']),
      (position) =>
        this.prisma.attendanceException.count({
          where: {
            status: 'OPEN',
            OR: [
              { employmentAssignment: { position } },
              {
                employmentAssignmentId: null,
                timeEntry: { employmentAssignment: { position } },
              },
            ],
          },
        }),
    );
    await add(
      {
        key: 'activeOnboarding',
        label: 'Active onboarding',
        href: '/admin/onboarding',
        area: 'Onboarding',
      },
      'ONBOARDING',
      placed(['onboarding.read', 'onboarding.manage']),
      (position) =>
        this.prisma.employeeWorkflow.count({
          where: {
            organizationId,
            kind: 'ONBOARDING',
            status: 'ACTIVE',
            ...notSelf,
            employmentAssignment: { position },
          },
        }),
    );
    // Openings are placed by their own placement columns (not a position).
    const openings = placementWhere(
      filter(['recruitment.read', 'recruitment.manage']),
    );
    await add(
      {
        key: 'openJobOpenings',
        label: 'Open job openings',
        href: '/admin/recruitment',
        area: 'Recruitment',
      },
      'RECRUITMENT',
      openings,
      (where) =>
        this.prisma.jobOpening.count({
          where: { organizationId, status: 'OPEN', ...where },
        }),
    );
    await add(
      {
        key: 'reviewsInProgress',
        label: 'Performance reviews in progress',
        href: '/admin/performance',
        area: 'Performance',
      },
      'PERFORMANCE',
      placed(['performance.read', 'performance.manage']),
      (position) =>
        this.prisma.performanceReview.count({
          where: {
            organizationId,
            status: { in: [...WRITABLE] },
            cycle: { status: 'OPEN' },
            ...notSelf,
            employmentAssignment: { position },
          },
        }),
    );
    // Documents: clearance differs per confidentiality level, so the domain's own (bounded)
    // expiry aggregate is reused rather than re-deriving its rules here.
    const documentReaders = [
      'document.read',
      'document.confidential.read',
      'document.restricted.read',
      'document.manage',
    ];
    if (
      enabled('DOCUMENTS') &&
      documentReaders.some((key) => context.permissions.has(key))
    ) {
      const expiring = await this.documents
        .expiryDashboard(userId, organizationId)
        .catch((error: unknown) => {
          if (error instanceof ForbiddenException) return null;
          throw error;
        });
      if (expiring)
        cards.push({
          key: 'documentsExpiring',
          label: 'Documents expired or expiring soon',
          value: expiring.items.length,
          href: '/admin/documents',
          area: 'Documents',
        });
    }

    return {
      organizationId,
      cards,
      self: context.isEmployee
        ? await this.self(
            userId,
            selfId!,
            organizationId,
            context,
            enabled,
            now,
          )
        : null,
      quickActions: this.quickActions(context, enabled),
    };
  }

  private async self(
    userId: string,
    employeeId: string,
    organizationId: string,
    context: { organization: { timezone: string | null } },
    enabled: (module: FeatureModule) => boolean,
    now: Date,
  ) {
    const today = localDateOf(now, context.organization.timezone ?? 'UTC');
    const openCycle = { status: 'OPEN' as const };
    const [todayShifts, leaveBalances, policyAcknowledgementsDue, performance] =
      await Promise.all([
        enabled('SCHEDULING')
          ? this.prisma.scheduledShift.count({
              where: {
                employmentAssignment: { employeeId },
                schedule: { status: 'PUBLISHED', organizationId },
                status: 'ACTIVE',
                workDate: today,
              },
            })
          : null,
        enabled('LEAVE') ? this.leaveSummary(userId, organizationId) : null,
        enabled('DOCUMENTS')
          ? this.policies
              .mine(userId)
              .then(
                (mine) =>
                  mine.items.filter(
                    (item) =>
                      item.organizationId === organizationId &&
                      item.needsAcknowledgement,
                  ).length,
              )
          : null,
        enabled('PERFORMANCE')
          ? Promise.all([
              this.prisma.performanceReview.count({
                where: {
                  organizationId,
                  employeeId,
                  status: { in: [...WRITABLE] },
                  selfStatus: { in: ['NOT_STARTED', 'IN_PROGRESS'] },
                  cycle: openCycle,
                },
              }),
              this.prisma.performanceReview.count({
                where: {
                  organizationId,
                  reviewerEmployeeId: employeeId,
                  status: { in: [...WRITABLE] },
                  reviewerStatus: { in: ['NOT_STARTED', 'IN_PROGRESS'] },
                  cycle: openCycle,
                },
              }),
              this.prisma.performanceGoal.count({
                where: {
                  organizationId,
                  employeeId,
                  status: { in: ['NOT_STARTED', 'IN_PROGRESS'] },
                },
              }),
            ])
          : null,
      ]);
    return {
      employeeId,
      todayShifts,
      leaveBalances,
      policyAcknowledgementsDue,
      selfReviewsDue: performance?.[0] ?? null,
      reviewsToWrite: performance?.[1] ?? null,
      openGoals: performance?.[2] ?? null,
    };
  }

  /** Balances of the caller's tracked leave types in the organization (self-service view). */
  private async leaveSummary(userId: string, organizationId: string) {
    const mine = await this.leave.me(userId).catch((error: unknown) => {
      if (error instanceof ForbiddenException) return null;
      throw error;
    });
    if (!mine) return null;
    const byType = new Map<
      string,
      {
        leaveTypeId: string;
        name: string;
        availableMinutes: number;
        pendingMinutes: number;
      }
    >();
    for (const assignment of mine.assignments) {
      if (assignment.organization.id !== organizationId) continue;
      for (const row of assignment.leaveTypes) {
        if (!row.balance) continue;
        const entry = byType.get(row.leaveType.id) ?? {
          leaveTypeId: row.leaveType.id,
          name: row.leaveType.name,
          availableMinutes: 0,
          pendingMinutes: 0,
        };
        entry.availableMinutes += row.balance.availableMinutes;
        entry.pendingMinutes += row.balance.pendingMinutes;
        byType.set(row.leaveType.id, entry);
      }
    }
    return [...byType.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Shortcuts to existing pages, offered only where the caller could perform the action. */
  private quickActions(
    context: {
      permissions: ReadonlySet<string>;
      atOrganization: (permission: string) => boolean;
    },
    enabled: (module: FeatureModule) => boolean,
  ): QuickAction[] {
    const has = (key: string) => context.permissions.has(key);
    const actions: QuickAction[] = [];
    if (has('employee.manage'))
      actions.push({
        key: 'addEmployee',
        label: 'Add employee',
        href: '/admin/employees/new',
      });
    if (enabled('LEAVE') && has('leave.approve'))
      actions.push({
        key: 'reviewLeave',
        label: 'Review leave requests',
        href: '/admin/leave',
      });
    if (
      enabled('ATTENDANCE') &&
      (has('time.timesheet.approve') || has('time.timesheet.manage'))
    )
      actions.push({
        key: 'reviewTimesheets',
        label: 'Review timesheets',
        href: '/admin/time#timesheets',
      });
    // Payroll is organization-scoped: only organization (or SYSTEM) grants count.
    if (
      enabled('PAYROLL') &&
      (context.atOrganization('payroll.calculate') ||
        context.atOrganization('payroll.manage'))
    )
      actions.push({
        key: 'runPayroll',
        label: 'Run payroll',
        href: '/admin/payroll',
      });
    if (enabled('RECRUITMENT') && has('recruitment.manage'))
      actions.push({
        key: 'postJob',
        label: 'Post a job',
        href: '/admin/recruitment',
      });
    if (enabled('ONBOARDING') && has('onboarding.manage'))
      actions.push({
        key: 'startOnboarding',
        label: 'Start onboarding',
        href: '/admin/onboarding',
      });
    return actions;
  }
}
