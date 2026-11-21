import { ForbiddenException, Injectable } from '@nestjs/common';
import { domainError, formatDate } from '../common/domain-support.js';
import { pageList } from '../common/option-paging.js';
import { PrismaService } from '../database/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PerformanceAccessService } from './performance-access.service.js';
import {
  isoDate,
  PerformanceClock,
  performanceToday,
} from './performance-common.js';
import { displayName, overdueParts } from './performance-cycle.service.js';

const PERSON = {
  select: { firstName: true, lastName: true, preferredName: true },
} as const;

const HISTORY_INCLUDE = {
  cycle: {
    select: {
      id: true,
      code: true,
      name: true,
      status: true,
      periodStart: true,
      periodEnd: true,
      acknowledgementEnabled: true,
    },
  },
  employmentAssignment: { select: { position: { select: { name: true } } } },
  reviewer: { select: { id: true, person: PERSON } },
} as const;

type HistoryRow = Prisma.PerformanceReviewGetPayload<{
  include: typeof HISTORY_INCLUDE;
}>;

/**
 * Phase 12 Batch 12.7 — review history and the HR attention list.
 *
 * - The employee sees their reviews of opened cycles (the outcome only once finalized).
 * - performance.read/manage readers see an employee's reviews on the assignments within their
 *   scope, with who actually submitted each (historical reviewer identity survives reporting
 *   changes, transfers, terminations and reviewer changes).
 * - The attention list flags what needs HR: no reviewer, a reviewer no longer working in the
 *   organization, overdue parts, reviews of ended assignments or departed employees, reviews
 *   waiting for finalization or acknowledgement.
 */
@Injectable()
export class PerformanceHistoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: PerformanceAccessService,
    private readonly clock: PerformanceClock,
  ) {}

  async mine(userId: string) {
    const employeeId = await this.access.requireEmployee(userId);
    const rows = await this.prisma.performanceReview.findMany({
      where: {
        employeeId,
        cycle: { status: { not: 'DRAFT' } },
        organizationId: { notIn: await this.access.disabledOrganizations() },
      },
      include: HISTORY_INCLUDE,
      orderBy: [{ cycle: { periodEnd: 'desc' } }, { createdAt: 'desc' }],
    });
    return { items: rows.map((row) => this.shape(row, true)) };
  }

  async forEmployee(userId: string, employeeId: string) {
    const employee = await this.access.employeeAccess(userId, employeeId);
    if (employee.isSelf) return this.mine(userId);
    const readable = employee.assignments
      .filter((row) => row.canRead)
      .map((row) => row.assignment.id);
    if (readable.length === 0) {
      throw new ForbiddenException(
        domainError(
          403,
          'PERFORMANCE_PERMISSION_REQUIRED',
          'Missing permission performance.read for the employee.',
        ),
      );
    }
    const rows = await this.prisma.performanceReview.findMany({
      where: {
        employeeId,
        employmentAssignmentId: { in: readable },
        cycle: { status: { not: 'DRAFT' } },
      },
      include: HISTORY_INCLUDE,
      orderBy: [{ cycle: { periodEnd: 'desc' } }, { createdAt: 'desc' }],
    });
    const submitters = await this.names(
      rows
        .map((row) => row.reviewerSubmittedEmployeeId)
        .filter((id): id is string => Boolean(id)),
    );
    return {
      items: rows.map((row) => ({
        ...this.shape(row, false),
        submittedBy: row.reviewerSubmittedEmployeeId
          ? {
              id: row.reviewerSubmittedEmployeeId,
              displayName:
                submitters.get(row.reviewerSubmittedEmployeeId) ?? null,
            }
          : null,
      })),
    };
  }

  /** Reviews of open cycles (and finalized ones awaiting closure) needing HR, within scope. */
  async attention(
    userId: string,
    organizationId: string,
    /** Batch 7B: by cycle and flag, with cursor paging (all of them without a limit). */
    filters: {
      cycleId?: string;
      flag?: string;
      limit?: number;
      afterId?: string;
    } = {},
  ) {
    if (!(await this.access.hasAnyInOrganization(userId, organizationId))) {
      throw new ForbiddenException(
        domainError(
          403,
          'PERFORMANCE_PERMISSION_REQUIRED',
          'Missing performance permissions for the organization.',
        ),
      );
    }
    await this.access.requireEnabled(organizationId);
    const grants = await this.access.grants(userId);
    const cycleManager = this.access.canInOrganization(
      grants,
      'performance.cycle.manage',
      organizationId,
    );
    const rows = await this.prisma.performanceReview.findMany({
      where: {
        organizationId,
        status: { not: 'CLOSED' },
        cycle: { status: { in: ['OPEN', 'CLOSED'] } },
        ...(filters.cycleId ? { cycleId: filters.cycleId } : {}),
      },
      include: {
        cycle: { include: { organization: { select: { timezone: true } } } },
        employmentAssignment: {
          include: {
            employee: {
              select: {
                id: true,
                employeeNumber: true,
                status: true,
                person: PERSON,
              },
            },
            position: { select: { name: true } },
          },
        },
        reviewer: {
          select: {
            id: true,
            person: PERSON,
            assignments: {
              where: {
                status: { notIn: ['CANCELLED', 'ENDED'] },
                position: { organizationId },
              },
              select: { id: true },
              take: 1,
            },
          },
        },
      },
      orderBy: [{ cycle: { windowEnd: 'asc' } }, { createdAt: 'asc' }],
    });
    const now = this.clock.now();
    const items = [];
    for (const row of rows) {
      if (!cycleManager) {
        // Scope by permission (being someone's reviewer alone never lists HR attention).
        const access = await this.access.reviewAccess(
          userId,
          row,
          this.prisma,
          true,
        );
        const permitted =
          access.canManage ||
          this.access.can(access.grants, 'performance.read', access.target);
        if (access.isSelf || !permitted) continue;
      }
      const today = performanceToday(now, row.cycle.organization.timezone);
      const flags: string[] = [];
      const active = ['NOT_STARTED', 'IN_PROGRESS', 'SUBMITTED'].includes(
        row.status,
      );
      if (active && !row.reviewerEmployeeId) flags.push('NO_REVIEWER');
      if (active && row.reviewer && row.reviewer.assignments.length === 0) {
        flags.push('REVIEWER_NOT_IN_ORGANIZATION');
      }
      for (const part of overdueParts(row.cycle, row, today))
        flags.push(`OVERDUE_${part}`);
      const assignment = row.employmentAssignment;
      if (
        active &&
        (assignment.status === 'ENDED' ||
          (assignment.endDate && assignment.endDate < today))
      ) {
        flags.push('ASSIGNMENT_ENDED');
      }
      if (active && assignment.employee.status === 'TERMINATED')
        flags.push('EMPLOYEE_TERMINATED');
      if (row.status === 'SUBMITTED') flags.push('AWAITING_FINALIZATION');
      if (row.status === 'FINALIZED' && row.cycle.acknowledgementEnabled) {
        flags.push('AWAITING_ACKNOWLEDGEMENT');
      }
      if (flags.length === 0) continue;
      if (filters.flag && !flags.includes(filters.flag)) continue;
      items.push({
        id: row.id,
        reviewId: row.id,
        cycle: {
          id: row.cycle.id,
          name: row.cycle.name,
          status: row.cycle.status,
        },
        employee: {
          id: assignment.employee.id,
          employeeNumber: assignment.employee.employeeNumber,
          displayName: displayName(assignment.employee.person),
        },
        positionName: assignment.position.name,
        reviewer: row.reviewer
          ? {
              id: row.reviewer.id,
              displayName: displayName(row.reviewer.person),
            }
          : null,
        status: row.status,
        flags,
      });
    }
    const page = pageList(items, filters.limit, filters.afterId);
    return {
      total: items.length,
      nextAfterId: page.nextAfterId,
      items: page.items,
    };
  }

  private shape(row: HistoryRow, self: boolean) {
    const finalized = row.finalizedAt !== null;
    // Batch 7B (S1): the employee sees the outcome once finalized; others once the reviewer
    // has submitted (never a draft rating).
    const outcome = self
      ? finalized
      : finalized || row.reviewerStatus === 'SUBMITTED';
    return {
      id: row.id,
      cycle: {
        id: row.cycle.id,
        code: row.cycle.code,
        name: row.cycle.name,
        status: row.cycle.status,
        periodStart: formatDate(row.cycle.periodStart),
        periodEnd: formatDate(row.cycle.periodEnd),
      },
      employmentAssignmentId: row.employmentAssignmentId,
      positionName: row.employmentAssignment.position.name,
      reviewer: row.reviewer
        ? { id: row.reviewer.id, displayName: displayName(row.reviewer.person) }
        : null,
      status: row.status,
      selfStatus: row.selfStatus,
      reviewerStatus: row.reviewerStatus,
      overallRating:
        outcome && row.overallRatingValue !== null
          ? { value: row.overallRatingValue, label: row.overallRatingLabel }
          : null,
      calculatedScore: outcome
        ? (row.calculatedScore?.toFixed(2) ?? null)
        : null,
      finalizedAt: row.finalizedAt?.toISOString() ?? null,
      acknowledgedAt: row.acknowledgedAt?.toISOString() ?? null,
      closedAt: row.closedAt?.toISOString() ?? null,
      closeReason: row.closeReason,
      awaitingAcknowledgement:
        row.status === 'FINALIZED' && row.cycle.acknowledgementEnabled,
      periodLabel: `${isoDate(row.cycle.periodStart)} – ${isoDate(row.cycle.periodEnd)}`,
    };
  }

  private async names(ids: string[]) {
    if (ids.length === 0) return new Map<string, string>();
    const rows = await this.prisma.employee.findMany({
      where: { id: { in: [...new Set(ids)] } },
      select: { id: true, person: PERSON },
    });
    return new Map(rows.map((row) => [row.id, displayName(row.person)]));
  }
}
