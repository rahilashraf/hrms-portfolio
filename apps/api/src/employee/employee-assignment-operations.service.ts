import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import type { EmploymentType } from '../generated/prisma/enums.js';
import { AuditService } from '../audit/audit.service.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import { localDateOf } from '../common/domain-support.js';
import { assertCompensationFitsAssignment } from '../compensation/compensation-assignment.guard.js';
import { PrismaService } from '../database/prisma.service.js';
import { EmployeeAccessService } from './employee-access.service.js';
import {
  EmployeeDomainService,
  resolveAssignmentTimezone,
} from './employee-domain.service.js';
import { EmployeeLifecycleService } from './employee-lifecycle.service.js';
import {
  addDays,
  assertManagerVisible,
  dateOnly,
  deriveAssignmentStatus,
  lifecycleError,
  lockEmployeeLifecycle,
  lockEmployeeTimeForLifecycle,
  lockPositions,
  optionalStrictDay,
  strictDay,
} from './employee-lifecycle-support.js';

type Tx = Prisma.TransactionClient;

/** Batch 4F convention: bounded lists with exact totals and `truncated`. */
const IMPACT_LIMIT = 50;
const IMPACT_REPORT_LIMIT = 200;

export interface OperationContext {
  actorUserId?: string;
  ipAddress?: string;
  userAgent?: string;
  correlationId?: string;
}

const POSITION_ZONE = {
  position: {
    select: {
      name: true,
      organizationId: true,
      archivedAt: true,
      organization: { select: { name: true, timezone: true } },
      workLocation: { select: { timezone: true } },
    },
  },
} as const;

function timezoneOf(position: {
  workLocation?: { timezone: string | null } | null;
  organization?: { timezone: string | null } | null;
}) {
  try {
    return resolveAssignmentTimezone(position);
  } catch {
    return 'UTC';
  }
}

/**
 * Batch 5B — per-assignment operations that span more than one record: the atomic transfer
 * (K6) and the assignment-impact preview (K8) with the offboarding prefill. Both are
 * per-assignment actions (never employee-wide): authority comes from the positions involved,
 * 404 for what the caller cannot see, 403 for what they see but may not change. Nothing here
 * cancels leave, schedules, benefits, workflows or access.
 */
@Injectable()
export class EmployeeAssignmentOperationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly domain: EmployeeDomainService,
    private readonly access: EmployeeAccessService,
    private readonly lifecycle: EmployeeLifecycleService,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditService,
  ) {}

  // ─── Transfer (K6) ─────────────────────────────────────────────────────────

  /**
   * Moves an employee from one assignment to a new one in another position, in one transaction:
   * the source ends on the day before `effectiveDate` (T−1) and the new assignment starts on T,
   * each judged in its own position's time zone (a source whose T−1 has passed ends now; a
   * future T leaves it ACTIVE with its end date set). Primary status and the manager carry over
   * only when still valid; compensation is never copied (`compensationRequired`). A repeated
   * request for the same transfer replays it.
   */
  async transfer(
    employeeId: string,
    assignmentId: string,
    input: {
      positionId: string;
      effectiveDate: string;
      employmentType?: EmploymentType;
      endDate?: string | null;
      isPrimary?: boolean;
      managerAssignmentId?: string | null;
      reason?: string;
    },
    context: OperationContext,
    now = new Date(),
  ) {
    const actor = this.requireActor(context);
    const effective = strictDay(input.effectiveDate, 'Effective date');
    const destinationEnd = optionalStrictDay(input.endDate, 'End date');
    const lastSourceDay = addDays(effective, -1);
    if (destinationEnd && destinationEnd.getTime() < effective.getTime())
      throw new BadRequestException('End date precedes the effective date.');
    // Authorization on unlocked reads first (Batch 4F D9 order): never lock for a refusal.
    const preview = await this.authorizeAssignment(
      actor,
      employeeId,
      assignmentId,
    );
    await this.authorizeDestination(actor, input.positionId);
    // An explicitly chosen manager needs the visibility set-manager requires (404 unknown, 403
    // unreadable), checked before any lock or write.
    if (input.managerAssignmentId)
      await assertManagerVisible(
        this.prisma as unknown as Tx,
        this.access,
        actor,
        input.managerAssignmentId,
      );

    return this.prisma.$transaction(async (tx) => {
      await lockEmployeeLifecycle(tx, employeeId);
      await this.access.assertNotSelfTarget(
        actor,
        employeeId,
        'TRANSFER_ASSIGNMENT',
        context,
        tx,
      );
      await lockPositions(tx, [preview.positionId, input.positionId]);
      await lockEmployeeTimeForLifecycle(tx, employeeId);

      const source = await tx.employmentAssignment.findFirstOrThrow({
        where: { id: assignmentId, employeeId },
        include: POSITION_ZONE,
      });
      if (source.positionId !== preview.positionId) {
        throw new ConflictException(
          lifecycleError(
            409,
            'TRANSFER_SOURCE_CHANGED',
            'The assignment changed at the same time; reload and try again.',
          ),
        );
      }
      const replay = await this.replayedTransfer(
        tx,
        employeeId,
        source,
        input.positionId,
        effective,
      );
      if (replay) return replay;

      const employee = await tx.employee.findUniqueOrThrow({
        where: { id: employeeId },
        select: { status: true },
      });
      if (employee.status !== 'ACTIVE')
        throw new ConflictException(
          lifecycleError(
            409,
            'EMPLOYEE_NOT_ACTIVE',
            'Only an active employee can be transferred.',
          ),
        );
      const scheduled = await tx.employeeTermination.findFirst({
        where: { employeeId, status: 'SCHEDULED' },
        select: { id: true, terminationDate: true },
      });
      if (scheduled)
        throw new ConflictException(
          lifecycleError(
            409,
            'TERMINATION_SCHEDULED',
            `A termination is scheduled for ${dateOnly(scheduled.terminationDate)}; cancel or reschedule it first.`,
            { terminationId: scheduled.id },
          ),
        );
      if (input.positionId === source.positionId)
        throw new ConflictException(
          lifecycleError(
            409,
            'TRANSFER_SAME_POSITION',
            'A transfer moves the employee to another position.',
          ),
        );
      const sourceZone = timezoneOf(source.position);
      const sourceToday = localDateOf(now, sourceZone);
      const started = source.startDate.getTime() <= sourceToday.getTime();
      if (!(
        source.status === 'ACTIVE' ||
        (source.status === 'PLANNED' && started)
      ))
        throw new ConflictException(
          lifecycleError(
            409,
            'TRANSFER_SOURCE_NOT_ACTIVE',
            'Only an active assignment (or a planned one that has started) can be transferred.',
            { status: source.status },
          ),
        );
      if (
        effective.getTime() <= source.startDate.getTime() ||
        (source.endDate !== null &&
          effective.getTime() > source.endDate.getTime())
      )
        throw new BadRequestException(
          lifecycleError(
            400,
            'TRANSFER_DATE_OUTSIDE_ASSIGNMENT',
            `The new position must start after ${dateOnly(source.startDate)}${source.endDate ? ` and no later than ${dateOnly(source.endDate)}` : ''}, while the current assignment runs.`,
          ),
        );

      // The shortened source keeps every approved, finalized or recorded record inside it.
      await this.lifecycle.assertNoFinalizedBlockers(tx, source, {
        start: source.startDate,
        end: lastSourceDay,
      });
      const endsNow = lastSourceDay.getTime() < sourceToday.getTime();
      const sourceStatus = endsNow ? 'ENDED' : source.status;
      await assertCompensationFitsAssignment(tx, source.id, {
        status: sourceStatus,
        startDate: source.startDate,
        endDate: lastSourceDay,
      });
      await tx.employmentAssignment.update({
        where: { id: source.id },
        data: { endDate: lastSourceDay, status: sourceStatus },
      });

      // Manager: an explicit choice is validated as for any new link (same organization, K7);
      // otherwise the current manager carries over only if still valid for the new assignment.
      const manager = await this.carriedManager(
        tx,
        actor,
        source.managerAssignmentId,
        input,
        {
          employeeId,
          positionId: input.positionId,
          startDate: effective,
          endDate: destinationEnd,
        },
      );
      const isPrimary = input.isPrimary ?? source.isPrimary;
      // The new assignment's status from its own position's time zone, on the same clock as the
      // source's (R5: never a client choice).
      const destinationZone = await tx.position.findUniqueOrThrow({
        where: { id: input.positionId },
        select: {
          workLocation: { select: { timezone: true } },
          organization: { select: { timezone: true } },
        },
      });
      const destinationStatus = deriveAssignmentStatus(
        effective,
        destinationEnd,
        localDateOf(now, timezoneOf(destinationZone)),
      );
      const destination = await this.domain.createAssignment(
        {
          employeeId,
          positionId: input.positionId,
          employmentType: input.employmentType ?? source.employmentType,
          status: destinationStatus,
          startDate: effective,
          endDate: destinationEnd,
          isPrimary,
          managerAssignmentId: manager.managerAssignmentId ?? undefined,
        },
        context,
        tx,
      );
      const compensationRecords = await tx.compensationRecord.count({
        where: { employmentAssignmentId: source.id, supersededAt: null },
      });
      const destinationPosition = await tx.position.findUniqueOrThrow({
        where: { id: input.positionId },
        select: { organizationId: true },
      });
      await this.audit.write(
        {
          action: 'EMPLOYMENT_ASSIGNMENT_TRANSFERRED',
          actorUserId: actor,
          entityType: 'EmploymentAssignment',
          entityId: source.id,
          ipAddress: context.ipAddress,
          userAgent: context.userAgent,
          correlationId: context.correlationId,
          metadata: JSON.parse(
            JSON.stringify({
              employeeId,
              sourceAssignmentId: source.id,
              destinationAssignmentId: destination.id,
              effectiveDate: dateOnly(effective),
              source: {
                positionId: source.positionId,
                organizationId: source.position.organizationId,
                timezone: sourceZone,
                before: {
                  status: source.status,
                  endDate: source.endDate ? dateOnly(source.endDate) : null,
                },
                after: {
                  status: sourceStatus,
                  endDate: dateOnly(lastSourceDay),
                },
              },
              destination: {
                positionId: input.positionId,
                organizationId: destinationPosition.organizationId,
                status: destination.status,
                startDate: dateOnly(effective),
                endDate: destinationEnd ? dateOnly(destinationEnd) : null,
                isPrimary,
                managerAssignmentId: manager.managerAssignmentId,
              },
              crossOrganization:
                destinationPosition.organizationId !==
                source.position.organizationId,
              manager: {
                carried: manager.carried,
                droppedReason: manager.droppedReason,
              },
              compensationRequired: true,
              sourceCompensationRecords: compensationRecords,
              withReason: Boolean(input.reason?.trim()),
            }),
          ) as Prisma.InputJsonValue,
        },
        tx,
      );
      return {
        replayed: false,
        sourceAssignment: this.shape(
          await tx.employmentAssignment.findUniqueOrThrow({
            where: { id: source.id },
          }),
        ),
        destinationAssignment: this.shape(destination),
        // Compensation is never copied: the new assignment needs its own record.
        compensationRequired: true,
        sourceHadCompensation: compensationRecords > 0,
        primaryCarried: isPrimary,
        manager: {
          managerAssignmentId: manager.managerAssignmentId,
          carried: manager.carried,
          droppedReason: manager.droppedReason,
        },
      };
    });
  }

  // ─── Assignment impact (K8) ────────────────────────────────────────────────

  /**
   * What ending (or transferring away from) an assignment on `endDate` would leave behind,
   * before it happens. Nothing is changed or cancelled.
   *
   * Every section belongs to a module and is returned only when the caller holds that module's
   * read permission over the assignment's position (otherwise `null`): attendance `time.view`,
   * scheduling `schedule.read`, leave `leave.read`, compensation `compensation.read`, payroll
   * `payroll.read`, benefits `benefit.read`, access `role.read`, offboarding `offboarding.read` or `offboarding.manage` (Batch 7A Q7 —
   * previously `onboarding.read`).
   * Finalized-record blockers are listed by the same rule; `blocked` alone says whether the end
   * would be refused. Other assignments and direct reports are listed only where the caller can
   * read them (as the profile does); employee-wide and organization-wide conclusions are given
   * only to callers who can see that whole picture. Lists are bounded with exact totals and
   * `truncated` (Batch 4F convention).
   */
  async impact(
    employeeId: string,
    assignmentId: string,
    actorUserId: string,
    query: { endDate?: string },
    now = new Date(),
  ) {
    await this.authorizeAssignment(actorUserId, employeeId, assignmentId);
    const a = await this.prisma.employmentAssignment.findFirstOrThrow({
      where: { id: assignmentId, employeeId },
      include: {
        ...POSITION_ZONE,
        employee: {
          select: {
            person: {
              select: { user: { select: { id: true, status: true } } },
            },
          },
        },
      },
    });
    const zone = timezoneOf(a.position);
    const end = query.endDate
      ? strictDay(query.endDate, 'End date')
      : localDateOf(now, zone);
    if (end.getTime() < a.startDate.getTime())
      throw new BadRequestException('End date precedes the assignment start.');
    const after = addDays(end, 1);
    const organizationId = a.position.organizationId;
    const userId = a.employee.person.user?.id ?? null;
    const may = async (permission: string) =>
      this.access.canPosition(actorUserId, a.positionId, permission);
    const [
      timeView,
      scheduleRead,
      leaveRead,
      compensationRead,
      payrollRead,
      benefitRead,
      roleRead,
      offboardingRead,
      offboardingManage,
    ] = await Promise.all(
      [
        'time.view',
        'schedule.read',
        'leave.read',
        'compensation.read',
        'payroll.read',
        'benefit.read',
        'role.read',
        'offboarding.read',
        'offboarding.manage',
      ].map(may),
    );

    // Finalized-record blockers, each listed only under its module's permission.
    const allBlockers = await this.lifecycle.finalizedBlockers(
      this.prisma as unknown as Tx,
      a,
      { start: a.startDate, end },
    );
    const blockerVisible = (kind: unknown) =>
      kind === 'FINALIZED_PAYROLL' ? payrollRead : timeView;
    const blockers = allBlockers.filter((b) => blockerVisible(b.kind));

    const bounded = async <T>(
      total: Promise<number>,
      items: Promise<T[]>,
      limit: number,
    ) => {
      const [count, rows] = await Promise.all([total, items]);
      return {
        total: count,
        items: rows.slice(0, limit),
        truncated: count > limit,
        limit,
      };
    };

    const openEntriesWhere = {
      employmentAssignmentId: a.id,
      status: 'OPEN' as const,
      archivedAt: null,
    };
    const shiftsWhere = {
      employmentAssignmentId: a.id,
      status: 'ACTIVE' as const,
      workDate: { gte: after },
      schedule: { status: 'PUBLISHED' as const },
    };
    const pendingWhere = {
      employmentAssignmentId: a.id,
      status: 'PENDING' as const,
    };
    const approvedWhere = {
      employmentAssignmentId: a.id,
      status: 'APPROVED' as const,
      endDate: { gte: after },
    };
    const compensationWhere = {
      employmentAssignmentId: a.id,
      supersededAt: null,
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: end } }],
    };
    const benefitsWhere = {
      employmentAssignmentId: a.id,
      // Batch 7C (B15): superseded and rescinded elections are history, not open coverage.
      supersededAt: null,
      OR: [{ coverageEnd: null }, { coverageEnd: { gte: after } }],
    };

    const attendance = timeView
      ? {
          openTimeEntries: await bounded(
            this.prisma.timeEntry.count({ where: openEntriesWhere }),
            this.prisma.timeEntry
              .findMany({
                where: openEntriesWhere,
                select: { id: true, workDate: true, clockInAt: true },
                orderBy: [{ clockInAt: 'asc' }, { id: 'asc' }],
                take: IMPACT_LIMIT + 1,
              })
              .then((rows) =>
                rows.map((e) => ({
                  id: e.id,
                  workDate: dateOnly(e.workDate),
                  clockInAt: e.clockInAt.toISOString(),
                })),
              ),
            IMPACT_LIMIT,
          ),
        }
      : null;
    const scheduling = scheduleRead
      ? {
          futurePublishedShifts: await bounded(
            this.prisma.scheduledShift.count({ where: shiftsWhere }),
            this.prisma.scheduledShift
              .findMany({
                where: shiftsWhere,
                select: { id: true, workDate: true },
                orderBy: [{ workDate: 'asc' }, { id: 'asc' }],
                take: IMPACT_LIMIT + 1,
              })
              .then((rows) =>
                rows.map((s) => ({ id: s.id, workDate: dateOnly(s.workDate) })),
              ),
            IMPACT_LIMIT,
          ),
        }
      : null;
    const leaveRange = {
      select: { id: true, startDate: true, endDate: true },
      orderBy: [{ startDate: 'asc' as const }, { id: 'asc' as const }],
      take: IMPACT_LIMIT + 1,
    };
    const leave = leaveRead
      ? {
          pending: await bounded(
            this.prisma.leaveRequest.count({ where: pendingWhere }),
            this.prisma.leaveRequest
              .findMany({ where: pendingWhere, ...leaveRange })
              .then((rows) => rows.map((l) => this.range(l))),
            IMPACT_LIMIT,
          ),
          approvedAfterEnd: await bounded(
            this.prisma.leaveRequest.count({ where: approvedWhere }),
            this.prisma.leaveRequest
              .findMany({ where: approvedWhere, ...leaveRange })
              .then((rows) => rows.map((l) => this.range(l))),
            IMPACT_LIMIT,
          ),
        }
      : null;
    const compensation = compensationRead
      ? {
          recordsBeyondEnd: await bounded(
            this.prisma.compensationRecord.count({ where: compensationWhere }),
            this.prisma.compensationRecord
              .findMany({
                where: compensationWhere,
                select: {
                  id: true,
                  effectiveFrom: true,
                  effectiveTo: true,
                  payGroupId: true,
                },
                orderBy: [{ effectiveFrom: 'asc' }, { id: 'asc' }],
                take: IMPACT_LIMIT + 1,
              })
              .then((rows) =>
                rows.map((c) => ({
                  id: c.id,
                  effectiveFrom: dateOnly(c.effectiveFrom),
                  effectiveTo: c.effectiveTo ? dateOnly(c.effectiveTo) : null,
                  payGroupId: c.payGroupId,
                })),
              ),
            IMPACT_LIMIT,
          ),
        }
      : null;
    const payroll = payrollRead
      ? {
          openPayrollRuns: await this.prisma.payrollRunEmployee.count({
            where: {
              employeeId,
              run: {
                organizationId,
                status: { in: ['DRAFT', 'CALCULATED', 'APPROVED'] },
                period: { periodEnd: { gte: end } },
              },
            },
          }),
        }
      : null;
    const benefits = benefitRead
      ? {
          enrollmentsBeyondEnd: await bounded(
            this.prisma.benefitEnrollment.count({ where: benefitsWhere }),
            this.prisma.benefitEnrollment
              .findMany({
                where: benefitsWhere,
                select: { id: true, coverageStart: true, coverageEnd: true },
                orderBy: [{ coverageStart: 'asc' }, { id: 'asc' }],
                take: IMPACT_LIMIT + 1,
              })
              .then((rows) =>
                rows.map((b) => ({
                  id: b.id,
                  coverageStart: dateOnly(b.coverageStart),
                  coverageEnd: b.coverageEnd ? dateOnly(b.coverageEnd) : null,
                })),
              ),
            IMPACT_LIMIT,
          ),
        }
      : null;

    // Direct reports: only the ones the caller can read are counted and listed (K7: the links
    // stay when this assignment ends).
    const reports = await this.prisma.employmentAssignment.findMany({
      where: {
        managerAssignmentId: a.id,
        status: { in: ['ACTIVE', 'PLANNED'] },
      },
      select: { id: true, employeeId: true, positionId: true },
      orderBy: { id: 'asc' },
    });
    const visibleReports: Array<{
      employmentAssignmentId: string;
      employeeId: string;
    }> = [];
    for (const report of reports) {
      if (
        await this.access.canPosition(
          actorUserId,
          report.positionId,
          'employee.read',
        )
      )
        visibleReports.push({
          employmentAssignmentId: report.id,
          employeeId: report.employeeId,
        });
    }

    // Other current assignments: listed only where readable (as the employee profile does).
    // The conclusions use every assignment but are given only to callers who see the whole
    // picture (organization-wide for the organization, SYSTEM for the employee).
    const others = await this.prisma.employmentAssignment.findMany({
      where: {
        employeeId,
        id: { not: a.id },
        status: { in: ['ACTIVE', 'PLANNED'] },
      },
      select: {
        id: true,
        status: true,
        endDate: true,
        positionId: true,
        position: { select: { name: true, organizationId: true } },
      },
      orderBy: { id: 'asc' },
    });
    const continuing = others.filter(
      (o) => o.endDate === null || o.endDate.getTime() > end.getTime(),
    );
    const visibleOthers = [];
    for (const o of continuing) {
      if (
        await this.access.canPosition(
          actorUserId,
          o.positionId,
          'employee.read',
        )
      )
        visibleOthers.push({
          employmentAssignmentId: o.id,
          status: o.status,
          positionName: o.position.name,
          organizationId: o.position.organizationId,
        });
    }
    const [organizationWide, systemWide] = await Promise.all([
      this.authorization.canAccess(actorUserId, 'employee.read', {
        type: 'ORGANIZATION',
        id: organizationId,
      }),
      this.access.isSystem(actorUserId, 'employee.read'),
    ]);

    const access =
      roleRead && userId
        ? {
            loginStatus: a.employee.person.user?.status ?? null,
            grantsInOrganization: await this.prisma.roleAssignment.count({
              where: {
                userId,
                organizationId,
                revokedAt: null,
                OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
              },
            }),
            // R3: ending an assignment never changes access.
            changesAccess: false,
          }
        : roleRead
          ? { loginStatus: null, grantsInOrganization: 0, changesAccess: false }
          : null;

    const offboarding =
      offboardingRead || offboardingManage
        ? {
            employeeId,
            employmentAssignmentId: a.id,
            plannedEndDate: dateOnly(end),
            defaultTemplate: await this.prisma.workflowTemplate.findFirst({
              where: {
                organizationId,
                kind: 'OFFBOARDING',
                status: 'ACTIVE',
                isDefault: true,
              },
              select: { id: true, name: true },
            }),
            openWorkflowId:
              (
                await this.prisma.employeeWorkflow.findFirst({
                  where: {
                    employmentAssignmentId: a.id,
                    kind: 'OFFBOARDING',
                    status: 'ACTIVE',
                  },
                  select: { id: true },
                })
              )?.id ?? null,
          }
        : null;

    return {
      employeeId,
      employmentAssignmentId: a.id,
      organizationId,
      timezone: zone,
      endDate: dateOnly(end),
      blocked: allBlockers.length > 0,
      blockers,
      attendance,
      scheduling,
      leave,
      compensation,
      payroll,
      benefits,
      managerRelationships: {
        visibleDirectReports: visibleReports.slice(0, IMPACT_REPORT_LIMIT),
        visibleDirectReportCount: visibleReports.length,
        truncated: visibleReports.length > IMPACT_REPORT_LIMIT,
        limit: IMPACT_REPORT_LIMIT,
      },
      employment: {
        otherCurrentAssignments: visibleOthers,
        remainsEmployedInOrganization:
          organizationWide || systemWide
            ? continuing.some(
                (o) => o.position.organizationId === organizationId,
              )
            : null,
        // Edge case 2: the last current assignment — use the termination workflow instead.
        endsLastCurrentEmployment: systemWide ? continuing.length === 0 : null,
      },
      access,
      offboarding,
    };
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  /** 404 unless the caller can see the assignment's employment; 403 unless they may manage it. */
  private async authorizeAssignment(
    actor: string,
    employeeId: string,
    assignmentId: string,
  ) {
    const a = await this.prisma.employmentAssignment.findFirst({
      where: { id: assignmentId, employeeId },
      select: { id: true, positionId: true },
    });
    if (
      !a ||
      !(await this.access.canPosition(actor, a.positionId, 'employee.read'))
    ) {
      if (!a || !(await this.access.isSystem(actor, 'employee.read')))
        throw new NotFoundException('Assignment not found');
    }
    if (
      !(await this.access.canPosition(actor, a.positionId, 'employee.manage'))
    )
      throw new ForbiddenException(
        'Changing this assignment needs employee.manage on its position.',
      );
    return a;
  }

  private async authorizeDestination(actor: string, positionId: string) {
    const position = await this.prisma.position.findUnique({
      where: { id: positionId },
      select: { id: true },
    });
    if (
      !position ||
      !(
        (await this.access.canPosition(actor, positionId, 'employee.read')) ||
        (await this.access.isSystem(actor, 'employee.read'))
      )
    )
      throw new NotFoundException('Position not found');
    if (!(await this.access.canPosition(actor, positionId, 'employee.manage')))
      throw new ForbiddenException(
        'Transferring into this position needs employee.manage on it.',
      );
  }

  /** A transfer already done by an identical request: report it again. */
  private async replayedTransfer(
    tx: Tx,
    employeeId: string,
    source: { id: string; endDate: Date | null; positionId: string },
    positionId: string,
    effective: Date,
  ) {
    if (
      source.endDate === null ||
      source.endDate.getTime() !== addDays(effective, -1).getTime()
    )
      return null;
    const destination = await tx.employmentAssignment.findFirst({
      where: {
        employeeId,
        positionId,
        startDate: effective,
        status: { not: 'CANCELLED' },
      },
    });
    if (!destination) return null;
    const audit = await tx.auditLog.findFirst({
      where: {
        action: 'EMPLOYMENT_ASSIGNMENT_TRANSFERRED',
        entityId: source.id,
        metadata: { path: ['destinationAssignmentId'], equals: destination.id },
      },
      select: { id: true },
    });
    if (!audit) return null;
    return {
      replayed: true,
      sourceAssignment: this.shape(
        await tx.employmentAssignment.findUniqueOrThrow({
          where: { id: source.id },
        }),
      ),
      destinationAssignment: this.shape(destination),
      compensationRequired: true,
      sourceHadCompensation:
        (await tx.compensationRecord.count({
          where: { employmentAssignmentId: source.id, supersededAt: null },
        })) > 0,
      primaryCarried: destination.isPrimary,
      manager: {
        managerAssignmentId: destination.managerAssignmentId,
        carried: destination.managerAssignmentId !== null,
        droppedReason: null,
      },
    };
  }

  private async carriedManager(
    tx: Tx,
    actor: string,
    sourceManagerId: string | null,
    input: { managerAssignmentId?: string | null },
    destination: {
      employeeId: string;
      positionId: string;
      startDate: Date;
      endDate: Date | null;
    },
  ): Promise<{
    managerAssignmentId: string | null;
    carried: boolean;
    droppedReason: string | null;
  }> {
    if (input.managerAssignmentId !== undefined) {
      // Visibility was checked before the transaction; the domain checks the rest.
      return {
        managerAssignmentId: input.managerAssignmentId,
        carried: false,
        droppedReason: null,
      };
    }
    if (!sourceManagerId)
      return { managerAssignmentId: null, carried: false, droppedReason: null };
    const manager = await tx.employmentAssignment.findUnique({
      where: { id: sourceManagerId },
      select: {
        id: true,
        employeeId: true,
        positionId: true,
        status: true,
        startDate: true,
        endDate: true,
        managerAssignmentId: true,
      },
    });
    if (
      !manager ||
      manager.status === 'ENDED' ||
      manager.status === 'CANCELLED'
    )
      return {
        managerAssignmentId: null,
        carried: false,
        droppedReason: 'MANAGER_ASSIGNMENT_ENDED',
      };
    try {
      await this.domain.assertManagerSameOrganization(
        tx,
        destination.positionId,
        manager.positionId,
      );
    } catch {
      return {
        managerAssignmentId: null,
        carried: false,
        droppedReason: 'MANAGER_ORGANIZATION_MISMATCH',
      };
    }
    try {
      await this.domain.validateManagerRelationship(
        tx,
        { id: 'new', ...destination, managerAssignmentId: manager.id } as never,
        manager,
      );
    } catch {
      return {
        managerAssignmentId: null,
        carried: false,
        droppedReason: 'MANAGER_NOT_VALID_FOR_NEW_ASSIGNMENT',
      };
    }
    return {
      managerAssignmentId: manager.id,
      carried: true,
      droppedReason: null,
    };
  }

  private range(row: { id: string; startDate: Date; endDate: Date }) {
    return {
      id: row.id,
      startDate: dateOnly(row.startDate),
      endDate: dateOnly(row.endDate),
    };
  }

  private shape(row: {
    id: string;
    positionId: string;
    status: string;
    startDate: Date;
    endDate: Date | null;
    isPrimary: boolean;
    managerAssignmentId: string | null;
    employmentType: string;
  }) {
    return {
      id: row.id,
      positionId: row.positionId,
      status: row.status,
      employmentType: row.employmentType,
      startDate: dateOnly(row.startDate),
      endDate: row.endDate ? dateOnly(row.endDate) : null,
      isPrimary: row.isPrimary,
      managerAssignmentId: row.managerAssignmentId,
    };
  }

  private requireActor(context: OperationContext) {
    if (!context.actorUserId) throw new ForbiddenException();
    return context.actorUserId;
  }
}
