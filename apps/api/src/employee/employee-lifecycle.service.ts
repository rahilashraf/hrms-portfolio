import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import type { AuthorizationScope } from '../authorization/authorization.types.js';
import { AuditService } from '../audit/audit.service.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import { isAssignmentEffective } from '../authorization/authorization.policy.js';
import { RoleManagementService } from '../authorization/role-management.service.js';
import { localDateOf } from '../common/domain-support.js';
import { assertCompensationFitsAssignment } from '../compensation/compensation-assignment.guard.js';
import { PrismaService } from '../database/prisma.service.js';
import { EmployeeAccessService } from './employee-access.service.js';
import {
  LIFECYCLE_UPCOMING_DEFAULT_DAYS,
  LIFECYCLE_UPCOMING_MAX_DAYS,
} from './employee.dto.js';
import {
  TerminationGrants,
  type GrantDecisionInput,
} from './termination-grants.js';
import {
  EmployeeDomainService,
  resolveAssignmentTimezone,
} from './employee-domain.service.js';
import {
  addDays,
  dateOnly,
  latestPossibleToday,
  lifecycleError,
  lockEmployeeLifecycle,
  lockEmployeeTimeForLifecycle,
  lockPositions,
  optionalStrictDay,
  strictDay,
} from './employee-lifecycle-support.js';
import type { EmploymentType } from '../generated/prisma/enums.js';

type Tx = Prisma.TransactionClient;

export interface LifecycleContext {
  actorUserId?: string;
  ipAddress?: string;
  userAgent?: string;
  correlationId?: string;
}

export type TerminationApplySource = 'IMMEDIATE' | 'MANUAL' | 'AUTOMATIC';

interface AssignmentRow {
  id: string;
  employeeId: string;
  positionId: string;
  status: 'PLANNED' | 'ACTIVE' | 'ENDED' | 'CANCELLED';
  startDate: Date;
  endDate: Date | null;
  position: {
    name: string;
    organizationId: string;
    organization: { name: string; timezone: string | null };
    workLocation: { timezone: string | null } | null;
  };
}

const ASSIGNMENT_INCLUDE = {
  position: {
    select: {
      name: true,
      organizationId: true,
      organization: { select: { name: true, timezone: true } },
      workLocation: { select: { timezone: true } },
    },
  },
} as const;

/** An assignment's business time zone (work location, else organization; UTC for legacy rows). */
function timezoneOf(a: AssignmentRow): string {
  try {
    return resolveAssignmentTimezone(a.position);
  } catch {
    return 'UTC';
  }
}

/** The assignment's business date now. */
function localToday(a: AssignmentRow, now: Date): Date {
  return localDateOf(now, timezoneOf(a));
}

function minDate(a: Date | null, b: Date): Date {
  return a === null || b.getTime() < a.getTime() ? b : a;
}

/**
 * Batch 5A — the employee lifecycle core: scheduled and immediate employee-wide termination with
 * its history, cancellation, rescheduling and (manual or automatic) application; rehire into a
 * new assignment; inactive and reactivation; the due-transition list; the termination impact
 * preview and the access review (grants are never revoked automatically: R2). Every operation
 * takes the lifecycle lock order (employee lifecycle → positions → employee time → rows), checks
 * K10 employee-wide authority and K12 self-targeting, refuses changes that would invalidate
 * finalized records, and writes one audit entry per change.
 */
/** M3 decision C: authorization refusals of a keep review that are audited. */
const KEEP_REVIEW_REFUSALS = new Set([
  'TERMINATION_KEEP_NOT_AUTHORIZED',
  'TERMINATION_SYSTEM_ACTOR_REQUIRED',
  'TERMINATION_KEEP_SELF_APPROVAL',
]);

@Injectable()
export class EmployeeLifecycleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly domain: EmployeeDomainService,
    private readonly access: EmployeeAccessService,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditService,
    @Optional() private readonly roles?: RoleManagementService,
  ) {
    this.grants = new TerminationGrants(prisma, access, authorization, audit);
  }

  /** Security remediation M3: role grants when a termination applies (one policy, every path). */
  private readonly grants: TerminationGrants;

  // ─── Termination ──────────────────────────────────────────────────────────

  /**
   * Terminates an employee on `terminationDate`, the last day of employment. A date still to come
   * in any affected assignment's time zone is SCHEDULED: the employee keeps their status and
   * access until then, assignments get the date as their end (status unchanged). Assignments end
   * one by one as their own time zone passes the date; the employee becomes TERMINATED (sessions
   * revoked; login disabled only if no authorization remains) once all have. A date already past
   * everywhere applies in the same request.
   */
  async terminate(
    employeeId: string,
    input: {
      terminationDate: string;
      reason?: string;
      /** Legacy (Batch 5A): accepted, but never a decision about SYSTEM grants (M3). */
      acknowledgeSystemGrants?: boolean;
      /** M3: REVOKE or KEEP (requested, to be approved by someone else) per grant. */
      grantDecisions?: GrantDecisionInput[];
    },
    context: LifecycleContext,
    now = new Date(),
  ) {
    const actor = this.requireActor(context);
    const date = strictDay(input.terminationDate, 'Termination date');
    const reason = this.optionalText(input.reason, 'Reason', 1000);
    return this.prisma.$transaction(async (tx) => {
      await lockEmployeeLifecycle(tx, employeeId);
      const authority = await this.access.authorizeEmployeeWide(
        actor,
        employeeId,
        { referenceDate: date },
        tx,
      );
      await this.access.assertNotSelfTarget(
        actor,
        employeeId,
        'TERMINATE',
        context,
        tx,
      );
      const existing = await tx.employeeTermination.findFirst({
        where: { employeeId, status: 'SCHEDULED' },
      });
      if (existing) {
        if (dateOnly(existing.terminationDate) === dateOnly(date)) {
          // A retried request: the same termination, never a second one.
          return this.terminationResult(tx, existing.id, now);
        }
        throw new ConflictException(
          lifecycleError(
            409,
            'TERMINATION_ALREADY_SCHEDULED',
            `A termination is already scheduled for ${dateOnly(existing.terminationDate)}; reschedule or cancel it instead.`,
            { terminationId: existing.id },
          ),
        );
      }
      const termination = await this.scheduleInTx(
        tx,
        actor,
        employeeId,
        date,
        {
          reason,
          acknowledgeSystemGrants: input.acknowledgeSystemGrants === true,
          grantDecisions: input.grantDecisions ?? [],
          now,
        },
        authority.authority,
        context,
      );
      await this.audit.write(
        this.auditInput(
          'EMPLOYEE_TERMINATION_SCHEDULED',
          'Employee',
          employeeId,
          context,
          {
            terminationId: termination.id,
            terminationDate: dateOnly(date),
            authority: authority.authority,
            withReason: reason !== null,
            systemGrantsAcknowledged: termination.systemGrantsAcknowledged,
            assignments: termination.effects,
          },
        ),
        tx,
      );
      await this.applyTerminationInTx(
        tx,
        termination.id,
        now,
        'IMMEDIATE',
        context,
        { onBlocked: 'defer' },
      );
      return this.terminationResult(tx, termination.id, now);
    });
  }

  /** Cancels a scheduled termination before any assignment has passed its date. */
  async cancelTermination(
    employeeId: string,
    terminationId: string,
    input: { reason?: string },
    context: LifecycleContext,
    now = new Date(),
  ) {
    const actor = this.requireActor(context);
    const reason = this.optionalText(input.reason, 'Reason', 1000);
    return this.prisma.$transaction(async (tx) => {
      await lockEmployeeLifecycle(tx, employeeId);
      const termination = await this.requireTermination(
        tx,
        employeeId,
        terminationId,
      );
      const authority = await this.access.authorizeEmployeeWide(
        actor,
        employeeId,
        { referenceDate: termination.terminationDate },
        tx,
      );
      await this.access.assertNotSelfTarget(
        actor,
        employeeId,
        'CANCEL_TERMINATION',
        context,
        tx,
      );
      await this.releaseScheduledInTx(tx, termination, {
        status: 'CANCELLED',
        actor,
        reason,
        now,
      });
      // M3: nothing was revoked; the open grant decisions end with the termination.
      await this.grants.closeOpen(tx, terminationId);
      await this.audit.write(
        this.auditInput(
          'EMPLOYEE_TERMINATION_CANCELLED',
          'Employee',
          employeeId,
          context,
          {
            terminationId,
            terminationDate: dateOnly(termination.terminationDate),
            authority: authority.authority,
            withReason: reason !== null,
          },
        ),
        tx,
      );
      return this.terminationResult(tx, terminationId, now);
    });
  }

  /** Moves a scheduled termination to another date, atomically (the old one is SUPERSEDED). */
  async rescheduleTermination(
    employeeId: string,
    terminationId: string,
    input: {
      terminationDate: string;
      reason?: string;
      acknowledgeSystemGrants?: boolean;
      grantDecisions?: GrantDecisionInput[];
    },
    context: LifecycleContext,
    now = new Date(),
  ) {
    const actor = this.requireActor(context);
    const date = strictDay(input.terminationDate, 'Termination date');
    const reason = this.optionalText(input.reason, 'Reason', 1000);
    return this.prisma.$transaction(async (tx) => {
      await lockEmployeeLifecycle(tx, employeeId);
      const termination = await this.requireTermination(
        tx,
        employeeId,
        terminationId,
      );
      const earliest =
        date.getTime() < termination.terminationDate.getTime()
          ? date
          : termination.terminationDate;
      const authority = await this.access.authorizeEmployeeWide(
        actor,
        employeeId,
        { referenceDate: earliest },
        tx,
      );
      await this.access.assertNotSelfTarget(
        actor,
        employeeId,
        'RESCHEDULE_TERMINATION',
        context,
        tx,
      );
      if (dateOnly(date) === dateOnly(termination.terminationDate)) {
        if (input.grantDecisions?.length) {
          const userId = await this.loginOf(tx, employeeId);
          await this.grants.record(tx, {
            terminationId,
            userId,
            actor,
            decisions: input.grantDecisions,
            now,
            requireSystemDecisions: true,
            context,
            employeeId,
          });
        }
        return this.terminationResult(tx, terminationId, now);
      }
      const replacementId = crypto.randomUUID();
      await this.releaseScheduledInTx(tx, termination, {
        status: 'SUPERSEDED',
        actor,
        reason,
        now,
        supersededById: replacementId,
      });
      const replacement = await this.scheduleInTx(
        tx,
        actor,
        employeeId,
        date,
        {
          reason: reason ?? termination.reason,
          acknowledgeSystemGrants:
            input.acknowledgeSystemGrants === true ||
            termination.systemGrantsAcknowledged,
          id: replacementId,
          // M3: decisions carry over (an approval must be given again for the new date).
          carryDecisionsFrom: terminationId,
          grantDecisions: input.grantDecisions ?? [],
          now,
        },
        authority.authority,
        context,
      );
      await this.audit.write(
        this.auditInput(
          'EMPLOYEE_TERMINATION_RESCHEDULED',
          'Employee',
          employeeId,
          context,
          {
            supersededTerminationId: terminationId,
            terminationId: replacement.id,
            previousTerminationDate: dateOnly(termination.terminationDate),
            terminationDate: dateOnly(date),
            authority: authority.authority,
            withReason: reason !== null,
            assignments: replacement.effects,
          },
        ),
        tx,
      );
      await this.grants.closeOpen(tx, terminationId);
      await this.applyTerminationInTx(
        tx,
        replacement.id,
        now,
        'IMMEDIATE',
        context,
        { onBlocked: 'defer' },
      );
      return this.terminationResult(tx, replacement.id, now);
    });
  }

  /**
   * R1: applies a due scheduled termination by hand (lifecycle automation off, or not waiting
   * for it): the same authority, locks, integrity checks and audit as the worker.
   */
  async applyTermination(
    employeeId: string,
    terminationId: string,
    context: LifecycleContext,
    now = new Date(),
  ) {
    const actor = this.requireActor(context);
    return this.prisma.$transaction(async (tx) => {
      await lockEmployeeLifecycle(tx, employeeId);
      const termination = await tx.employeeTermination.findFirst({
        where: { id: terminationId, employeeId },
      });
      if (!termination) throw new NotFoundException('Termination not found.');
      await this.access.authorizeEmployeeWide(
        actor,
        employeeId,
        { referenceDate: termination.terminationDate },
        tx,
      );
      await this.access.assertNotSelfTarget(
        actor,
        employeeId,
        'APPLY_TERMINATION',
        context,
        tx,
      );
      if (termination.status === 'APPLIED') {
        return this.terminationResult(tx, terminationId, now);
      }
      if (termination.status !== 'SCHEDULED') {
        throw new ConflictException(
          lifecycleError(
            409,
            'TERMINATION_NOT_SCHEDULED',
            'Only a scheduled termination can be applied.',
          ),
        );
      }
      const result = await this.applyTerminationInTx(
        tx,
        terminationId,
        now,
        'MANUAL',
        context,
        { onBlocked: 'throw' },
      );
      if (result.appliedAssignments === 0 && !result.completed) {
        throw new ConflictException(
          lifecycleError(
            409,
            'TERMINATION_NOT_DUE',
            `The termination takes effect after ${dateOnly(termination.terminationDate)} in each assignment's time zone; nothing is due yet.`,
          ),
        );
      }
      return this.terminationResult(tx, terminationId, now);
    });
  }

  /** The employee's termination history; reasons only for those who may manage the employee. */
  async terminations(employeeId: string, actorUserId: string) {
    const canSee =
      (await this.access.isSystem(actorUserId, 'employee.read')) ||
      (await this.access.canEmployee(actorUserId, employeeId, 'employee.read'));
    if (!canSee) throw new NotFoundException('Employee not found.');
    const showReason = await this.mayManage(actorUserId, employeeId);
    const rows = await this.prisma.employeeTermination.findMany({
      where: { employeeId },
      include: { assignments: true },
      orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }],
    });
    return {
      items: rows.map((row) => this.terminationShape(row, showReason)),
    };
  }

  /**
   * K8: what a termination on `date` would do and leave behind, before it is recorded: each
   * assignment's effect and when it takes effect, the finalized records that would block it, the
   * follow-up work other modules keep (nothing is changed there automatically), and access: the
   * sessions revoked, the grants that stay (R2: none revoked automatically) and whether the shared
   * login would be disabled.
   */
  async terminationPreview(
    employeeId: string,
    terminationDate: string,
    actorUserId: string,
    now = new Date(),
  ) {
    const date = strictDay(terminationDate, 'Termination date');
    await this.access.authorizeEmployeeWide(
      actorUserId,
      employeeId,
      { referenceDate: date },
      this.prisma,
    );
    const tx = this.prisma;
    const employee = await tx.employee.findUniqueOrThrow({
      where: { id: employeeId },
      include: {
        person: { select: { user: { select: { id: true, status: true } } } },
        assignments: { include: ASSIGNMENT_INCLUDE },
      },
    });
    const plan = this.planEffects(
      employee.assignments as AssignmentRow[],
      date,
    );
    const blockers: Array<Record<string, unknown>> = [];
    for (const effect of plan) {
      const found = await this.finalizedBlockers(
        tx as unknown as Tx,
        effect.assignment,
        effect.action === 'CANCEL'
          ? null
          : { start: effect.assignment.startDate, end: effect.newEndDate },
      );
      blockers.push(...found);
    }
    const after = addDays(date, 1);
    const assignmentIds = employee.assignments.map((a) => a.id);
    const [timeEntries, shifts, pendingLeave, futureLeave, benefits, reviews] =
      await Promise.all([
        tx.timeEntry.count({
          where: {
            employmentAssignmentId: { in: assignmentIds },
            archivedAt: null,
            status: 'OPEN',
          },
        }),
        tx.scheduledShift.count({
          where: {
            employmentAssignmentId: { in: assignmentIds },
            status: 'ACTIVE',
            workDate: { gte: after },
          },
        }),
        tx.leaveRequest.count({
          where: { employeeId, status: 'PENDING' },
        }),
        tx.leaveRequest.count({
          where: { employeeId, status: 'APPROVED', endDate: { gte: after } },
        }),
        // Batch 7C (B15): live elections only (a superseded or rescinded one is history), and
        // only for someone who reads benefits through one of the employee's assignments —
        // employee-wide authority never implies benefits access.
        (async () => {
          let canReadBenefits = false;
          for (const assignment of employee.assignments) {
            if (
              (await this.access.canPosition(
                actorUserId,
                assignment.positionId,
                'benefit.read',
              )) ||
              (await this.access.canPosition(
                actorUserId,
                assignment.positionId,
                'benefit.manage',
              ))
            ) {
              canReadBenefits = true;
              break;
            }
          }
          if (!canReadBenefits) return null;
          return tx.benefitEnrollment.count({
            where: {
              employeeId,
              supersededAt: null,
              OR: [{ coverageEnd: null }, { coverageEnd: { gte: after } }],
            },
          });
        })(),
        tx.performanceReview.count({
          where: {
            employeeId,
            status: { in: ['NOT_STARTED', 'IN_PROGRESS', 'SUBMITTED'] },
          },
        }),
      ]);
    const user = employee.person.user;
    const access = user
      ? await this.accessSummary(user.id, employee, actorUserId, now)
      : null;
    // M3: what the termination would do with the person's grants when it applies.
    const grantChanges = await this.grants.preview(
      tx as unknown as Tx,
      user?.id ?? null,
      {
        terminationDate: date,
        organizationIds: [
          ...new Set(plan.map((e) => e.assignment.position.organizationId)),
        ].sort(),
        timezones: [
          ...new Set(plan.map((e) => timezoneOf(e.assignment))),
        ].sort(),
      },
      now,
    );
    return {
      employeeId,
      terminationDate: dateOnly(date),
      grantChanges,
      scheduled: plan.some(
        (effect) =>
          localToday(effect.assignment, now).getTime() <= date.getTime(),
      ),
      assignments: plan.map((effect) => ({
        employmentAssignmentId: effect.assignment.id,
        positionName: effect.assignment.position.name,
        organizationId: effect.assignment.position.organizationId,
        organizationName: effect.assignment.position.organization.name,
        timezone: timezoneOf(effect.assignment),
        status: effect.assignment.status,
        startDate: dateOnly(effect.assignment.startDate),
        endDate: effect.assignment.endDate
          ? dateOnly(effect.assignment.endDate)
          : null,
        action: effect.action,
        newEndDate:
          effect.action === 'END' ? dateOnly(effect.newEndDate) : null,
        effectiveFrom: dateOnly(after),
      })),
      blockers,
      followUps: {
        openTimeEntries: timeEntries,
        futurePublishedShifts: shifts,
        pendingLeaveRequests: pendingLeave,
        approvedLeaveAfterTermination: futureLeave,
        openBenefitEnrollments: benefits,
        openPerformanceReviews: reviews,
      },
      access,
    };
  }

  // ─── Rehire, inactive, reactivation ───────────────────────────────────────

  /**
   * Rehires a TERMINATED employee into a NEW assignment (required), starting after the last
   * termination date. The original hire date and the termination history are kept; the
   * history links the termination to the rehire assignment. Permissions and the login are not
   * restored automatically.
   */
  async rehire(
    employeeId: string,
    input: {
      assignment: {
        positionId: string;
        employmentType: EmploymentType;
        startDate: string;
        endDate?: string | null;
        isPrimary?: boolean;
        managerAssignmentId?: string;
      };
      confirmEmployeeNumber?: string;
      reason?: string;
    },
    context: LifecycleContext,
  ) {
    const actor = this.requireActor(context);
    if (!input.assignment)
      throw new BadRequestException(
        lifecycleError(
          400,
          'REHIRE_ASSIGNMENT_REQUIRED',
          'A rehire needs the new assignment (position, employment type and start date).',
        ),
      );
    const startDate = strictDay(input.assignment.startDate, 'Start date');
    const endDate = optionalStrictDay(input.assignment.endDate, 'End date');
    const reason = this.optionalText(input.reason, 'Reason', 1000);
    return this.prisma.$transaction(async (tx) => {
      await lockEmployeeLifecycle(tx, employeeId);
      const employee = await tx.employee.findUnique({
        where: { id: employeeId },
        select: {
          id: true,
          employeeNumber: true,
          status: true,
          hireDate: true,
          terminationDate: true,
        },
      });
      if (!employee) throw new NotFoundException('Employee not found.');
      await this.access.assertPosition(
        actor,
        input.assignment.positionId,
        'employee.manage',
        tx,
      );
      const attach = await this.access.authorizeAttach(
        actor,
        employee,
        input.assignment.positionId,
        input.confirmEmployeeNumber,
        tx,
      );
      await this.access.assertNotSelfTarget(
        actor,
        employeeId,
        'REHIRE',
        context,
        tx,
      );
      if (employee.status !== 'TERMINATED') {
        throw new ConflictException(
          lifecycleError(
            409,
            'EMPLOYEE_NOT_TERMINATED',
            'Only a terminated employee can be rehired.',
          ),
        );
      }
      const last = await tx.employeeTermination.findFirst({
        where: { employeeId, status: 'APPLIED' },
        orderBy: [{ terminationDate: 'desc' }, { recordedAt: 'desc' }],
      });
      const lastDay = last?.terminationDate ?? employee.terminationDate;
      if (lastDay && startDate.getTime() <= lastDay.getTime()) {
        throw new BadRequestException(
          lifecycleError(
            400,
            'REHIRE_BEFORE_TERMINATION',
            `The new assignment must start after the last day of employment (${dateOnly(lastDay)}).`,
          ),
        );
      }
      await lockPositions(tx, [input.assignment.positionId]);
      await tx.employee.update({
        where: { id: employeeId },
        data: { status: 'ACTIVE', terminationDate: null },
      });
      const assignment = await this.domain.createAssignment(
        {
          employeeId,
          positionId: input.assignment.positionId,
          employmentType: input.assignment.employmentType,
          startDate,
          endDate,
          isPrimary: input.assignment.isPrimary,
          managerAssignmentId: input.assignment.managerAssignmentId,
        },
        context,
        tx,
      );
      if (last && last.rehireAssignmentId === null) {
        await tx.employeeTermination.update({
          where: { id: last.id },
          data: { rehireAssignmentId: assignment.id, rehiredAt: new Date() },
        });
      }
      await this.audit.write(
        this.auditInput('EMPLOYEE_REHIRED', 'Employee', employeeId, context, {
          rehireDate: dateOnly(startDate),
          employmentAssignmentId: assignment.id,
          terminationId: last?.id ?? null,
          previousTerminationDate: lastDay ? dateOnly(lastDay) : null,
          preservedHireDate: dateOnly(employee.hireDate),
          authority: attach.authority,
          withReason: reason !== null,
        }),
        tx,
      );
      return {
        employee: await tx.employee.findUniqueOrThrow({
          where: { id: employeeId },
          select: {
            id: true,
            employeeNumber: true,
            status: true,
            hireDate: true,
            terminationDate: true,
          },
        }),
        assignment: {
          ...assignment,
          startDate: dateOnly(assignment.startDate),
          endDate: assignment.endDate ? dateOnly(assignment.endDate) : null,
        },
        terminationId: last?.id ?? null,
      };
    });
  }

  /**
   * K3: sets an ACTIVE employee INACTIVE (leave of absence). Immediate and employee-wide. While
   * inactive: no time or kiosk capture (both require an ACTIVE employee), no new assignments,
   * transfers or rehire, and planned assignments wait (the activation job skips inactive
   * employees). Leave, payroll, scheduling, history, the login and grants are not touched.
   */
  async inactivate(
    employeeId: string,
    input: { reason: string },
    context: LifecycleContext,
  ) {
    const reason = this.optionalText(input.reason, 'Reason', 500);
    if (reason === null) throw new BadRequestException('A reason is required.');
    return this.setStatus(
      employeeId,
      'ACTIVE',
      'INACTIVE',
      'EMPLOYEE_INACTIVATED',
      reason,
      context,
    );
  }

  async reactivate(
    employeeId: string,
    input: { reason?: string },
    context: LifecycleContext,
  ) {
    return this.setStatus(
      employeeId,
      'INACTIVE',
      'ACTIVE',
      'EMPLOYEE_REACTIVATED',
      this.optionalText(input.reason, 'Reason', 500),
      context,
    );
  }

  private async setStatus(
    employeeId: string,
    from: 'ACTIVE' | 'INACTIVE',
    to: 'ACTIVE' | 'INACTIVE',
    action: string,
    reason: string | null,
    context: LifecycleContext,
  ) {
    const actor = this.requireActor(context);
    return this.prisma.$transaction(async (tx) => {
      await lockEmployeeLifecycle(tx, employeeId);
      const today = new Date();
      const authority = await this.access.authorizeEmployeeWide(
        actor,
        employeeId,
        { referenceDate: addDays(today, -1) },
        tx,
      );
      await this.access.assertNotSelfTarget(
        actor,
        employeeId,
        action,
        context,
        tx,
      );
      const employee = await tx.employee.findUniqueOrThrow({
        where: { id: employeeId },
        select: { status: true },
      });
      if (employee.status === to) {
        return { employeeId, status: to };
      }
      if (employee.status !== from) {
        throw new ConflictException(
          lifecycleError(
            409,
            to === 'INACTIVE' ? 'EMPLOYEE_NOT_ACTIVE' : 'EMPLOYEE_NOT_INACTIVE',
            to === 'INACTIVE'
              ? 'Only an active employee can be set inactive.'
              : 'Only an inactive employee can be reactivated.',
          ),
        );
      }
      const updated = await tx.employee.updateMany({
        where: { id: employeeId, status: from },
        data: { status: to },
      });
      if (updated.count !== 1) throw this.changedConcurrently();
      await this.audit.write(
        this.auditInput(action, 'Employee', employeeId, context, {
          before: { status: from },
          after: { status: to },
          reason,
          authority: authority.authority,
        }),
        tx,
      );
      return { employeeId, status: to };
    });
  }

  // ─── Access review (R2/R3: preview and explicit revocation only) ──────────

  /** The employee's login and role grants, classified, with what the caller may revoke. */
  async accessReview(
    employeeId: string,
    actorUserId: string,
    now = new Date(),
  ) {
    const canSee =
      (await this.access.isSystem(actorUserId, 'employee.read')) ||
      (await this.access.canEmployee(actorUserId, employeeId, 'employee.read'));
    if (!canSee) throw new NotFoundException('Employee not found.');
    const employee = await this.prisma.employee.findUniqueOrThrow({
      where: { id: employeeId },
      include: {
        person: { select: { user: { select: { id: true, status: true } } } },
        assignments: { include: ASSIGNMENT_INCLUDE },
      },
    });
    const user = employee.person.user;
    return {
      employeeId,
      employeeStatus: employee.status,
      access: user
        ? await this.accessSummary(user.id, employee, actorUserId, now)
        : null,
    };
  }

  /**
   * R2/R3: explicit, authorized revocation of selected grants (each through the role-management
   * rules: role.assign over its scope; System Owner assignments are never revoked here). When the
   * employee is TERMINATED and no authorization remains afterwards, the shared login is disabled
   * and its sessions revoked.
   *
   * Batch 5E: one transaction, all or nothing. Under the employee's lifecycle lock it applies the
   * lifecycle self-target rule (one's own employment only with System employee.manage, audited),
   * locks the grants in id order, authorizes every one on the transaction's view, revokes each
   * with a conditional update and its audit entry, then disables the login when nothing is left.
   * A refusal, a concurrent permission change seen by the checks, or any failure (an audit write,
   * the login step) rolls the whole request back. Grants someone else already revoked are left
   * as they are and reported in `alreadyRevoked`.
   */
  async revokeGrants(
    employeeId: string,
    input: { roleAssignmentIds: string[]; reason?: string },
    context: LifecycleContext,
  ) {
    const actor = this.requireActor(context);
    const roles = this.roles;
    if (!roles) throw new Error('Role management is not available.');
    const canSee =
      (await this.access.isSystem(actor, 'employee.read')) ||
      (await this.access.canEmployee(actor, employeeId, 'employee.read'));
    if (!canSee) throw new NotFoundException('Employee not found.');
    const user = await this.prisma.employee.findUniqueOrThrow({
      where: { id: employeeId },
      select: { person: { select: { user: { select: { id: true } } } } },
    });
    const userId = user.person.user?.id;
    if (!userId) throw new NotFoundException('The employee has no login.');
    const requested = [...new Set(input.roleAssignmentIds)];
    const owned = await this.prisma.roleAssignment.findMany({
      where: { id: { in: requested } },
      select: { id: true, userId: true },
    });
    if (
      owned.length !== requested.length ||
      owned.some((grant) => grant.userId !== userId)
    ) {
      throw new NotFoundException('Role assignment not found.');
    }
    return this.prisma.$transaction(async (tx) => {
      await lockEmployeeLifecycle(tx, employeeId);
      await this.access.assertNotSelfTarget(
        actor,
        employeeId,
        'REVOKE_GRANTS',
        context,
        tx,
      );
      const { revoked, alreadyRevoked } = await roles.revokeAssignmentsInTx(
        tx,
        actor,
        requested,
        input.reason,
        context,
      );
      const employee = await tx.employee.findUniqueOrThrow({
        where: { id: employeeId },
        select: { status: true },
      });
      const login =
        employee.status === 'TERMINATED'
          ? await this.disableLoginIfNoAuthorization(
              tx,
              employeeId,
              userId,
              'no_remaining_authorization',
              context,
            )
          : { disabled: false };
      return {
        employeeId,
        revoked,
        alreadyRevoked,
        loginDisabled: login.disabled,
      };
    });
  }

  // ─── Due transitions (R1) and automation (K11) ────────────────────────────

  /**
   * Due lifecycle transitions in an organization: scheduled terminations whose date has passed
   * in an affected time zone, and ACTIVE assignments past their end date — only those the caller
   * manages (employee.manage on the assignment's position).
   */
  async due(
    actorUserId: string,
    organizationId: string,
    now = new Date(),
    options: { upcomingDays?: number } = {},
  ) {
    const horizon = latestPossibleToday(now);
    const upcomingDays = Math.max(
      0,
      Math.min(
        LIFECYCLE_UPCOMING_MAX_DAYS,
        Math.trunc(options.upcomingDays ?? LIFECYCLE_UPCOMING_DEFAULT_DAYS),
      ),
    );
    const limit = 500;
    const manageable = new Map<string, boolean>();
    const canManage = async (positionId: string) => {
      if (!manageable.has(positionId)) {
        manageable.set(
          positionId,
          await this.access.canPosition(
            actorUserId,
            positionId,
            'employee.manage',
          ),
        );
      }
      return manageable.get(positionId)!;
    };
    const terminations = await this.prisma.employeeTermination.findMany({
      where: {
        status: 'SCHEDULED',
        terminationDate: { lt: horizon },
        assignments: {
          some: {
            employmentAssignment: { position: { organizationId } },
          },
        },
      },
      include: {
        employee: {
          select: {
            employeeNumber: true,
            person: {
              select: { firstName: true, lastName: true, preferredName: true },
            },
          },
        },
        assignments: {
          include: { employmentAssignment: { include: ASSIGNMENT_INCLUDE } },
        },
      },
      orderBy: [{ terminationDate: 'asc' }, { id: 'asc' }],
      take: limit + 1,
    });
    const dueTerminations = [];
    for (const termination of terminations.slice(0, limit)) {
      const effects = termination.assignments.filter(
        (e) =>
          e.employmentAssignment.position.organizationId === organizationId,
      );
      if (!(await this.everyManageable(effects, canManage))) continue;
      const dueNow = effects.some(
        (e) =>
          e.appliedAt === null &&
          localToday(e.employmentAssignment as AssignmentRow, now).getTime() >
            termination.terminationDate.getTime(),
      );
      if (!dueNow) continue;
      dueTerminations.push({
        terminationId: termination.id,
        employeeId: termination.employeeId,
        employeeNumber: termination.employee.employeeNumber,
        employeeName: this.displayName(termination.employee.person),
        terminationDate: dateOnly(termination.terminationDate),
      });
    }
    const ends = await this.prisma.employmentAssignment.findMany({
      where: {
        status: 'ACTIVE',
        endDate: { lt: horizon },
        position: { organizationId },
        terminationEffects: {
          none: { appliedAt: null, termination: { status: 'SCHEDULED' } },
        },
      },
      include: {
        ...ASSIGNMENT_INCLUDE,
        employee: {
          select: {
            employeeNumber: true,
            person: {
              select: { firstName: true, lastName: true, preferredName: true },
            },
          },
        },
      },
      orderBy: [{ endDate: 'asc' }, { id: 'asc' }],
      take: limit + 1,
    });
    // R4-A.1: what the HR panel shows for an assignment (the original fields first, unchanged).
    const describe = (a: (typeof ends)[number], today: Date) => ({
      employmentAssignmentId: a.id,
      employeeId: a.employeeId,
      employeeNumber: a.employee.employeeNumber,
      employeeName: this.displayName(a.employee.person),
      positionName: a.position.name,
      endDate: dateOnly(a.endDate!),
      timezone: timezoneOf(a as unknown as AssignmentRow),
      organizationId: a.position.organizationId,
      organizationName: a.position.organization.name,
      employmentType: a.employmentType,
      isPrimary: a.isPrimary,
      startDate: dateOnly(a.startDate),
      /** The assignment's business date now (in `timezone`). */
      localToday: dateOnly(today),
    });
    const dayDiff = (later: Date, earlier: Date) =>
      Math.round((later.getTime() - earlier.getTime()) / 86_400_000);
    const dueEnds = [];
    for (const a of ends.slice(0, limit)) {
      if (!(await canManage(a.positionId))) continue;
      const row = a as unknown as AssignmentRow;
      const today = localToday(row, now);
      if (today.getTime() <= a.endDate!.getTime()) continue;
      dueEnds.push({
        ...describe(a, today),
        /** Days since the last working day (the end date). */
        daysOverdue: dayDiff(today, a.endDate!),
      });
    }
    // R4-A.1: ACTIVE assignments ending soon (end date from local today to today + N days). One
    // that ends with a scheduled termination names it, so the panel can link there instead.
    const upcoming = await this.prisma.employmentAssignment.findMany({
      where: {
        status: 'ACTIVE',
        endDate: {
          gte: addDays(horizon, -2),
          // Local today is at most one day after UTC's (horizon is UTC tomorrow).
          lt: addDays(horizon, upcomingDays + 1),
        },
        position: { organizationId },
      },
      include: {
        ...ASSIGNMENT_INCLUDE,
        employee: {
          select: {
            employeeNumber: true,
            person: {
              select: { firstName: true, lastName: true, preferredName: true },
            },
          },
        },
        terminationEffects: {
          where: { appliedAt: null, termination: { status: 'SCHEDULED' } },
          select: { terminationId: true },
          take: 1,
        },
      },
      orderBy: [{ endDate: 'asc' }, { id: 'asc' }],
      take: limit + 1,
    });
    const upcomingEnds = [];
    for (const a of upcoming.slice(0, limit)) {
      const today = localToday(a as unknown as AssignmentRow, now);
      const until = dayDiff(a.endDate!, today);
      if (until < 0 || until > upcomingDays) continue;
      if (!(await canManage(a.positionId))) continue;
      upcomingEnds.push({
        ...describe(a, today),
        /** 0 when today is the last working day. */
        daysUntilEnd: until,
        scheduledTerminationId: a.terminationEffects[0]?.terminationId ?? null,
      });
    }
    return {
      organizationId,
      terminations: dueTerminations,
      assignmentEnds: dueEnds,
      upcomingAssignmentEnds: upcomingEnds,
      upcomingDays,
      truncated:
        terminations.length > limit ||
        ends.length > limit ||
        upcoming.length > limit,
      limit,
    };
  }

  /** R1: ends one ACTIVE assignment that is past its end date (manual counterpart of the job). */
  async applyAssignmentEnd(
    employeeId: string,
    assignmentId: string,
    context: LifecycleContext,
    now = new Date(),
  ) {
    const actor = this.requireActor(context);
    return this.prisma.$transaction(async (tx) => {
      await lockEmployeeLifecycle(tx, employeeId);
      const a = await tx.employmentAssignment.findFirst({
        where: { id: assignmentId, employeeId },
        include: ASSIGNMENT_INCLUDE,
      });
      if (!a) throw new NotFoundException('Assignment not found');
      await this.access.assertPosition(
        actor,
        a.positionId,
        'employee.manage',
        tx,
      );
      await this.access.assertNotSelfTarget(
        actor,
        employeeId,
        'APPLY_ASSIGNMENT_END',
        context,
        tx,
      );
      const outcome = await this.endDueAssignmentInTx(
        tx,
        a as unknown as AssignmentRow,
        now,
        'MANUAL',
        context,
      );
      if (outcome === 'NOT_DUE') {
        throw new ConflictException(
          lifecycleError(
            409,
            'ASSIGNMENT_END_NOT_DUE',
            'The assignment has no end date that has passed in its time zone.',
          ),
        );
      }
      if (outcome === 'IN_TERMINATION') {
        throw new ConflictException(
          lifecycleError(
            409,
            'ASSIGNMENT_IN_SCHEDULED_TERMINATION',
            'This assignment ends with a scheduled termination; apply the termination instead.',
          ),
        );
      }
      return tx.employmentAssignment.findUniqueOrThrow({
        where: { id: assignmentId },
      });
    });
  }

  /** K11 job: applies every due scheduled termination (each in its own transaction). */
  async processDueTerminations(now = new Date(), limit = 500) {
    const candidates = await this.prisma.employeeTermination.findMany({
      where: {
        status: 'SCHEDULED',
        terminationDate: { lt: latestPossibleToday(now) },
      },
      select: { id: true, employeeId: true },
      orderBy: [{ terminationDate: 'asc' }, { id: 'asc' }],
      take: limit,
    });
    const outcome = {
      scanned: candidates.length,
      completed: [] as string[],
      partiallyApplied: [] as string[],
      notDue: 0,
      /** M3: due, but waiting for SYSTEM grant decisions (nothing changed; see the due list). */
      blocked: [] as Array<{ terminationId: string; code: string }>,
      failed: [] as Array<{ terminationId: string; message: string }>,
      /** M3: employees whose last retained grant expired (login re-checked). */
      retentionsExpired: [] as string[],
      /** M3: employees whose retention check failed (retried by the next run). */
      retentionsFailed: [] as Array<{ employeeId: string; message: string }>,
    };
    for (const candidate of candidates) {
      try {
        const result = await this.prisma.$transaction(async (tx) => {
          await lockEmployeeLifecycle(tx, candidate.employeeId);
          return this.applyTerminationInTx(
            tx,
            candidate.id,
            now,
            'AUTOMATIC',
            { userAgent: 'hrms-worker' },
            { onBlocked: 'defer' },
          );
        });
        if (result.settledBefore) outcome.notDue += 1;
        else if (result.blocked)
          outcome.blocked.push({
            terminationId: candidate.id,
            code: result.blocked.code,
          });
        else if (result.completed) outcome.completed.push(candidate.id);
        else if (result.appliedAssignments > 0)
          outcome.partiallyApplied.push(candidate.id);
        else outcome.notDue += 1;
      } catch (error) {
        // Final M3 change: a SYSTEM keep whose approval failed revalidation under the locks
        // (after the gate) rolled the whole application back; it is blocked, not failed.
        const code =
          error instanceof ConflictException
            ? (error.getResponse() as { code?: string } | undefined)?.code
            : undefined;
        if (code === 'TERMINATION_KEEP_APPROVAL_INVALID')
          outcome.blocked.push({ terminationId: candidate.id, code });
        else
          outcome.failed.push({
            terminationId: candidate.id,
            message: error instanceof Error ? error.message : String(error),
          });
      }
    }
    const retentions = await this.processExpiredRetentions(now, limit);
    outcome.retentionsExpired = retentions.handled;
    outcome.retentionsFailed = retentions.failed;
    return outcome;
  }

  /**
   * M3: the lifecycle due job's retention check; the same reconciliation as the independent job
   * (`reconcileRetainedGrants`), kept here so a run with lifecycle automation on still covers it.
   */
  async processExpiredRetentions(now = new Date(), limit = 500) {
    const { handled, failed } = await this.reconcileRetainedGrants(now, limit);
    return { handled, failed };
  }

  /**
   * M3 decision A — retained-grant expiry reconciliation. Runs from its own worker job, whatever
   * EMPLOYEE_LIFECYCLE_AUTOMATION_ENABLED says, and does only this: for each employee with a
   * retained (KEEP) grant from an applied termination that is no longer effective (expired, or
   * revoked) and not yet reconciled, once none of their retained grants is still effective and
   * the employee is still TERMINATED, the login is disabled — sessions and account links ended —
   * if nothing else authorizes it. It never applies terminations, ends assignments, revokes
   * grants or touches payroll or time; grants and history are left as they are.
   *
   * "Effective" is the authorization rule itself (`isAssignmentEffective`, and the effective
   * grants of AuthorizationService), so a future-start, expired or revoked grant authorizes
   * nothing here either.
   *
   * Per employee, one transaction: lifecycle lock → Employee → User FOR UPDATE → the login's
   * unrevoked grants FOR SHARE (id order) → the authority check. A grant being created waits on
   * the User row (its foreign key takes KEY SHARE) or committed first and keeps the login; a grant
   * being revoked holds its row, so the check waits and sees the result. Two runs serialize on the
   * lifecycle lock and the second finds nothing left (`expiryHandledAt`, conditional). A failure
   * rolls back that employee only and is reported, so the job is retried; the others commit.
   * Bounded: at most `limit` due decisions per run, oldest application first.
   */
  async reconcileRetainedGrants(now = new Date(), limit = 200) {
    const due = await this.prisma.employeeTerminationGrantDecision.findMany({
      where: {
        outcome: 'RETAINED',
        expiryHandledAt: null,
        retainedRoleAssignment: {
          OR: [{ expiresAt: { lte: now } }, { revokedAt: { not: null } }],
        },
      },
      select: { termination: { select: { employeeId: true } } },
      orderBy: [{ appliedAt: 'asc' }, { id: 'asc' }],
      take: limit,
    });
    const employees = [
      ...new Set(due.map((d) => d.termination.employeeId)),
    ].sort();
    const handled: string[] = [];
    const failed: Array<{ employeeId: string; message: string }> = [];
    const context: LifecycleContext = { userAgent: 'hrms-worker' };
    for (const employeeId of employees) {
      // One employee's failure never stops the others (reported; the next run retries it).
      try {
        const done = await this.prisma.$transaction(async (tx) => {
          await lockEmployeeLifecycle(tx, employeeId);
          await tx.$queryRaw(
            Prisma.sql`SELECT "id" FROM "Employee" WHERE "id" = ${employeeId}::uuid FOR UPDATE`,
          );
          const decisions = await tx.employeeTerminationGrantDecision.findMany({
            where: {
              outcome: 'RETAINED',
              expiryHandledAt: null,
              termination: { employeeId },
            },
            include: {
              retainedRoleAssignment: {
                select: { startsAt: true, expiresAt: true, revokedAt: true },
              },
            },
            orderBy: { id: 'asc' },
          });
          const effective = (d: (typeof decisions)[number]) =>
            d.retainedRoleAssignment !== null &&
            isAssignmentEffective(d.retainedRoleAssignment, now);
          // Ended for good: revoked, or past its expiry. A retained grant that has not started
          // yet is not ended (re-review M1): it stays unhandled and is reconciled when it ends.
          const hasEnded = (d: (typeof decisions)[number]) =>
            d.retainedRoleAssignment === null ||
            d.retainedRoleAssignment.revokedAt !== null ||
            (d.retainedRoleAssignment.expiresAt !== null &&
              d.retainedRoleAssignment.expiresAt.getTime() <= now.getTime());
          const ended = decisions.filter(hasEnded);
          if (ended.length === 0) return false;
          const employee = await tx.employee.findUniqueOrThrow({
            where: { id: employeeId },
            select: {
              status: true,
              person: { select: { user: { select: { id: true } } } },
            },
          });
          const userId = employee.person.user?.id ?? null;
          // A retained grant still effective: wait for it. A not-yet-started one authorizes
          // nothing now (the authorization rule), so it does not hold the login open; it is
          // reconciled again when it ends. Rehired: employment authorizes the login.
          const stillRetained = decisions.some(effective);
          let loginDisabled = false;
          const checked =
            userId !== null &&
            employee.status === 'TERMINATED' &&
            !stillRetained;
          if (checked) {
            await tx.$queryRaw(
              Prisma.sql`SELECT "id" FROM "User" WHERE "id" = ${userId}::uuid FOR UPDATE`,
            );
            await tx.$queryRaw(
              Prisma.sql`SELECT "id" FROM "RoleAssignment" WHERE "userId" = ${userId}::uuid AND "revokedAt" IS NULL ORDER BY "id" FOR SHARE`,
            );
            loginDisabled = (
              await this.disableLoginIfNoAuthorization(
                tx,
                employeeId,
                userId,
                'retention_expired',
                context,
                now,
              )
            ).disabled;
          }
          const marked = await tx.employeeTerminationGrantDecision.updateMany({
            where: {
              id: { in: ended.map((d) => d.id) },
              expiryHandledAt: null,
            },
            data: { expiryHandledAt: now },
          });
          if (marked.count === 0) return false;
          await this.audit.write(
            this.auditInput(
              'EMPLOYEE_TERMINATION_RETENTION_EXPIRED',
              'Employee',
              employeeId,
              context,
              {
                source: 'AUTOMATIC',
                terminationIds: [...new Set(ended.map((d) => d.terminationId))],
                decisionIds: ended.map((d) => d.id),
                retainedRoleAssignmentIds: ended.map(
                  (d) => d.retainedRoleAssignmentId,
                ),
                stillRetained,
                loginChecked: checked,
                loginDisabled,
              },
            ),
            tx,
          );
          return true;
        });
        if (done) handled.push(employeeId);
      } catch (error) {
        failed.push({
          employeeId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { scanned: due.length, handled, failed };
  }

  /** The employee's login, if any. */
  private async loginOf(client: Tx | PrismaService, employeeId: string) {
    const employee = await client.employee.findUniqueOrThrow({
      where: { id: employeeId },
      select: { person: { select: { user: { select: { id: true } } } } },
    });
    return employee.person.user?.id ?? null;
  }

  // ─── M3: grant decisions on a termination ─────────────────────────────────

  /** The grants a termination concerns, their decisions and outcomes (employee managers only). */
  async terminationGrants(
    employeeId: string,
    terminationId: string,
    actorUserId: string,
    now = new Date(),
  ) {
    const termination = await this.prisma.employeeTermination.findFirst({
      where: { id: terminationId, employeeId },
    });
    if (!termination) throw new NotFoundException('Termination not found.');
    await this.access.authorizeEmployeeWide(
      actorUserId,
      employeeId,
      { referenceDate: termination.terminationDate },
      this.prisma,
    );
    return {
      terminationId,
      status: termination.status,
      ...(await this.grants.list(this.prisma, {
        terminationId,
        employeeId,
        status: termination.status,
        userId: await this.loginOf(this.prisma, employeeId),
        now,
      })),
    };
  }

  /** Records REVOKE decisions or KEEP requests on a scheduled termination. */
  async recordGrantDecisions(
    employeeId: string,
    terminationId: string,
    input: { decisions: GrantDecisionInput[] },
    context: LifecycleContext,
    now = new Date(),
  ) {
    const actor = this.requireActor(context);
    if (!Array.isArray(input.decisions) || input.decisions.length === 0)
      throw new BadRequestException('At least one decision is required.');
    await this.prisma.$transaction(async (tx) => {
      await lockEmployeeLifecycle(tx, employeeId);
      const termination = await this.scheduledTermination(
        tx,
        employeeId,
        terminationId,
      );
      await this.access.authorizeEmployeeWide(
        actor,
        employeeId,
        { referenceDate: termination.terminationDate },
        tx,
      );
      await this.access.assertNotSelfTarget(
        actor,
        employeeId,
        'RECORD_GRANT_DECISIONS',
        context,
        tx,
      );
      await this.grants.record(tx, {
        terminationId,
        userId: await this.loginOf(tx, employeeId),
        actor,
        decisions: input.decisions,
        now,
        requireSystemDecisions: false,
        context,
        employeeId,
      });
    });
    return this.terminationGrants(employeeId, terminationId, actor, now);
  }

  approveGrantKeep(
    employeeId: string,
    terminationId: string,
    decisionId: string,
    input: { note?: string },
    context: LifecycleContext,
    now = new Date(),
  ) {
    return this.reviewGrantKeep(
      employeeId,
      terminationId,
      decisionId,
      'APPROVE',
      input,
      context,
      now,
    );
  }

  rejectGrantKeep(
    employeeId: string,
    terminationId: string,
    decisionId: string,
    input: { note?: string },
    context: LifecycleContext,
    now = new Date(),
  ) {
    return this.reviewGrantKeep(
      employeeId,
      terminationId,
      decisionId,
      'REJECT',
      input,
      context,
      now,
    );
  }

  cancelGrantKeep(
    employeeId: string,
    terminationId: string,
    decisionId: string,
    context: LifecycleContext,
    now = new Date(),
  ) {
    return this.reviewGrantKeep(
      employeeId,
      terminationId,
      decisionId,
      'CANCEL',
      {},
      context,
      now,
    );
  }

  private async reviewGrantKeep(
    employeeId: string,
    terminationId: string,
    decisionId: string,
    action: 'APPROVE' | 'REJECT' | 'CANCEL',
    input: { note?: string },
    context: LifecycleContext,
    now: Date,
  ) {
    const actor = this.requireActor(context);
    const note = this.optionalText(input.note, 'Note', 500);
    try {
      await this.reviewGrantKeepInTx(
        employeeId,
        terminationId,
        decisionId,
        action,
        note,
        actor,
        context,
        now,
      );
    } catch (error) {
      // M3 decision C: an authorization refusal of an approval or rejection is audited after the
      // transaction rolled back (the decision is unchanged); no reason or note is recorded.
      const code =
        error instanceof ForbiddenException
          ? (error.getResponse() as { code?: string } | undefined)?.code
          : undefined;
      if (action !== 'CANCEL' && code && KEEP_REVIEW_REFUSALS.has(code)) {
        await this.audit.write(
          this.auditInput(
            'EMPLOYEE_TERMINATION_GRANT_KEEP_REVIEW_REFUSED',
            'Employee',
            employeeId,
            context,
            { terminationId, decisionId, action, code },
          ),
        );
      }
      throw error;
    }
    return this.terminationGrants(employeeId, terminationId, actor, now);
  }

  private async reviewGrantKeepInTx(
    employeeId: string,
    terminationId: string,
    decisionId: string,
    action: 'APPROVE' | 'REJECT' | 'CANCEL',
    note: string | null,
    actor: string,
    context: LifecycleContext,
    now: Date,
  ) {
    await this.prisma.$transaction(async (tx) => {
      // The lifecycle lock orders a review against the application: a late approval finds the
      // termination applied and is refused; it never brings a revoked grant back.
      await lockEmployeeLifecycle(tx, employeeId);
      const termination = await this.scheduledTermination(
        tx,
        employeeId,
        terminationId,
      );
      await this.access.authorizeEmployeeWide(
        actor,
        employeeId,
        { referenceDate: termination.terminationDate },
        tx,
      );
      await this.access.assertNotSelfTarget(
        actor,
        employeeId,
        `${action}_GRANT_KEEP`,
        context,
        tx,
      );
      await this.grants.review(tx, {
        terminationId,
        decisionId,
        employeeId,
        actor,
        action,
        note,
        now,
        context,
      });
    });
  }

  /** A termination of the employee that is still SCHEDULED (404 / 409 otherwise). */
  private async scheduledTermination(
    tx: Tx,
    employeeId: string,
    terminationId: string,
  ) {
    const termination = await tx.employeeTermination.findFirst({
      where: { id: terminationId, employeeId },
    });
    if (!termination) throw new NotFoundException('Termination not found.');
    if (termination.status !== 'SCHEDULED') {
      throw new ConflictException(
        lifecycleError(
          409,
          'TERMINATION_NOT_SCHEDULED',
          'Grant decisions can only change while the termination is scheduled.',
        ),
      );
    }
    return termination;
  }

  /** K11 job: ACTIVE → ENDED for assignments past their end date (each in its own transaction). */
  async processDueAssignmentEnds(now = new Date(), limit = 500) {
    const candidates = await this.prisma.employmentAssignment.findMany({
      where: {
        status: 'ACTIVE',
        endDate: { lt: latestPossibleToday(now) },
        terminationEffects: {
          none: { appliedAt: null, termination: { status: 'SCHEDULED' } },
        },
      },
      select: { id: true, employeeId: true },
      orderBy: [{ endDate: 'asc' }, { id: 'asc' }],
      take: limit,
    });
    const outcome = {
      scanned: candidates.length,
      ended: [] as string[],
      notDue: 0,
      failed: [] as Array<{ employmentAssignmentId: string; message: string }>,
    };
    for (const candidate of candidates) {
      try {
        const result = await this.prisma.$transaction(async (tx) => {
          await lockEmployeeLifecycle(tx, candidate.employeeId);
          const a = await tx.employmentAssignment.findUniqueOrThrow({
            where: { id: candidate.id },
            include: ASSIGNMENT_INCLUDE,
          });
          return this.endDueAssignmentInTx(
            tx,
            a as unknown as AssignmentRow,
            now,
            'AUTOMATIC',
            { userAgent: 'hrms-worker' },
          );
        });
        if (result === 'ENDED') outcome.ended.push(candidate.id);
        else outcome.notDue += 1;
      } catch (error) {
        outcome.failed.push({
          employmentAssignmentId: candidate.id,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return outcome;
  }

  // ─── Finalized-data guard (shared with assignment changes) ────────────────

  /**
   * Records that a change of an assignment's coverage would leave outside its kept dates
   * (`keep` null: the assignment keeps no dates at all): approved or locked timesheet segments,
   * finalized payroll runs of its organization, non-voided time entries and active sign-ins.
   */
  async finalizedBlockers(
    tx: Tx,
    a: { id: string; employeeId: string; positionId: string },
    keep: { start: Date; end: Date | null } | null,
  ) {
    const outsideDates = (field: string): Record<string, unknown> =>
      keep === null
        ? {}
        : {
            OR: [
              { [field]: { lt: keep.start } },
              ...(keep.end ? [{ [field]: { gt: keep.end } }] : []),
            ],
          };
    const position = await tx.position.findUnique({
      where: { id: a.positionId },
      select: { organizationId: true },
    });
    const [segments, payroll, entries, signIns] = await Promise.all([
      tx.timesheetSegment.findMany({
        where: {
          employmentAssignmentId: a.id,
          OR: [
            { status: 'APPROVED' },
            { timesheet: { status: { in: ['APPROVED', 'LOCKED'] } } },
          ],
          timesheet: {
            timePeriod:
              keep === null
                ? {}
                : {
                    OR: [
                      { startDate: { lt: keep.start } },
                      ...(keep.end ? [{ endDate: { gt: keep.end } }] : []),
                    ],
                  },
          },
        },
        select: {
          id: true,
          timesheet: {
            select: {
              timePeriod: { select: { startDate: true, endDate: true } },
            },
          },
        },
      }),
      tx.payrollRunEmployee.findMany({
        where: {
          employeeId: a.employeeId,
          run: {
            status: 'FINALIZED',
            organizationId: position?.organizationId,
            period:
              keep === null
                ? {}
                : {
                    OR: [
                      { periodStart: { lt: keep.start } },
                      ...(keep.end ? [{ periodEnd: { gt: keep.end } }] : []),
                    ],
                  },
          },
        },
        select: {
          run: {
            select: {
              id: true,
              period: { select: { periodStart: true, periodEnd: true } },
            },
          },
        },
      }),
      tx.timeEntry.count({
        where: {
          employmentAssignmentId: a.id,
          archivedAt: null,
          status: { not: 'VOIDED' },
          ...outsideDates('workDate'),
        },
      }),
      tx.attendanceSignIn.count({
        where: {
          employmentAssignmentId: a.id,
          status: 'ACTIVE',
          ...outsideDates('workDate'),
        },
      }),
    ]);
    const blockers: Array<Record<string, unknown>> = [];
    for (const segment of segments) {
      blockers.push({
        kind: 'APPROVED_TIMESHEET',
        employmentAssignmentId: a.id,
        periodStart: dateOnly(segment.timesheet.timePeriod.startDate),
        periodEnd: dateOnly(segment.timesheet.timePeriod.endDate),
      });
    }
    for (const row of payroll) {
      blockers.push({
        kind: 'FINALIZED_PAYROLL',
        employmentAssignmentId: a.id,
        payrollRunId: row.run.id,
        periodStart: dateOnly(row.run.period.periodStart),
        periodEnd: dateOnly(row.run.period.periodEnd),
      });
    }
    if (entries > 0)
      blockers.push({
        kind: 'TIME_RECORDED',
        employmentAssignmentId: a.id,
        count: entries,
      });
    if (signIns > 0)
      blockers.push({
        kind: 'SIGN_INS_RECORDED',
        employmentAssignmentId: a.id,
        count: signIns,
      });
    return blockers;
  }

  async assertNoFinalizedBlockers(
    tx: Tx,
    a: { id: string; employeeId: string; positionId: string },
    keep: { start: Date; end: Date | null } | null,
  ) {
    const blockers = await this.finalizedBlockers(tx, a, keep);
    if (blockers.length > 0) {
      throw new ConflictException(
        lifecycleError(
          409,
          'LIFECYCLE_FINALIZED_RECORDS',
          'This change would leave approved, finalized or recorded time outside the employment dates. Correct those records first, or choose other dates.',
          { blockers },
        ),
      );
    }
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  /** What a termination on `date` does to each assignment (ENDED and CANCELLED are untouched). */
  private planEffects(assignments: AssignmentRow[], date: Date) {
    const effects: Array<{
      assignment: AssignmentRow;
      action: 'END' | 'CANCEL';
      newEndDate: Date;
    }> = [];
    for (const a of assignments) {
      if (a.status !== 'ACTIVE' && a.status !== 'PLANNED') continue;
      if (a.startDate.getTime() > date.getTime()) {
        effects.push({ assignment: a, action: 'CANCEL', newEndDate: date });
      } else {
        effects.push({
          assignment: a,
          action: 'END',
          newEndDate: minDate(a.endDate, date),
        });
      }
    }
    return effects;
  }

  private async scheduleInTx(
    tx: Tx,
    actor: string,
    employeeId: string,
    date: Date,
    options: {
      reason: string | null;
      acknowledgeSystemGrants: boolean;
      id?: string;
      /** M3: the explicit grant decisions recorded with the termination. */
      grantDecisions: GrantDecisionInput[];
      /** M3: a rescheduled termination's decisions (approvals reset). */
      carryDecisionsFrom?: string;
      now: Date;
    },
    authority: 'ASSIGNMENTS' | 'SYSTEM',
    context: LifecycleContext,
  ) {
    const employee = await tx.employee.findUnique({
      where: { id: employeeId },
      include: {
        person: { select: { user: { select: { id: true } } } },
        assignments: { include: ASSIGNMENT_INCLUDE },
      },
    });
    if (!employee) throw new NotFoundException('Employee not found.');
    if (employee.status === 'TERMINATED') {
      throw new ConflictException(
        lifecycleError(
          409,
          'EMPLOYEE_ALREADY_TERMINATED',
          'The employee is already terminated.',
        ),
      );
    }
    if (date.getTime() < employee.hireDate.getTime()) {
      throw new BadRequestException(
        lifecycleError(
          400,
          'TERMINATION_BEFORE_HIRE',
          `The termination date cannot precede the hire date (${dateOnly(employee.hireDate)}).`,
        ),
      );
    }
    // R6: terminating the holder of SYSTEM grants needs a SYSTEM actor. M3: each SYSTEM grant
    // also needs an explicit decision (checked once the termination exists, below); the legacy
    // acknowledgement is stored but never keeps anything.
    const userId = employee.person.user?.id ?? null;
    if (userId) {
      const systemGrants = await tx.roleAssignment.count({
        where: {
          userId,
          scopeType: 'SYSTEM',
          revokedAt: null,
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
      });
      if (
        systemGrants > 0 &&
        !(await this.access.isSystem(actor, 'employee.manage', tx))
      ) {
        throw new ForbiddenException(
          lifecycleError(
            403,
            'TERMINATION_SYSTEM_ACTOR_REQUIRED',
            'This employee holds System-level roles; only a System administrator can terminate them.',
          ),
        );
      }
    }
    const plan = this.planEffects(
      employee.assignments as AssignmentRow[],
      date,
    );
    await lockPositions(
      tx,
      plan.map((effect) => effect.assignment.positionId),
    );
    // Time capture serializes on this lock: no time can be recorded between the check below and
    // the end of the employment it guards.
    await lockEmployeeTimeForLifecycle(tx, employeeId);
    for (const effect of plan) {
      await this.assertNoFinalizedBlockers(
        tx,
        effect.assignment,
        effect.action === 'CANCEL'
          ? null
          : { start: effect.assignment.startDate, end: effect.newEndDate },
      );
      await assertCompensationFitsAssignment(tx, effect.assignment.id, {
        status: effect.action === 'CANCEL' ? 'CANCELLED' : 'ENDED',
        startDate: effect.assignment.startDate,
        endDate:
          effect.action === 'CANCEL'
            ? effect.assignment.endDate
            : effect.newEndDate,
      });
    }
    const termination = await tx.employeeTermination.create({
      data: {
        ...(options.id ? { id: options.id } : {}),
        employeeId,
        terminationDate: date,
        reason: options.reason,
        systemGrantsAcknowledged: options.acknowledgeSystemGrants,
        recordedByUserId: actor,
      },
    });
    for (const effect of plan) {
      await tx.employeeTerminationAssignment.create({
        data: {
          terminationId: termination.id,
          employmentAssignmentId: effect.assignment.id,
          action: effect.action,
          previousStatus: effect.assignment.status,
          previousEndDate: effect.assignment.endDate,
        },
      });
      if (
        effect.action === 'END' &&
        (effect.assignment.endDate === null ||
          effect.assignment.endDate.getTime() !== effect.newEndDate.getTime())
      ) {
        // The planned last day; the status stays until the date has passed (K1).
        await tx.employmentAssignment.update({
          where: { id: effect.assignment.id },
          data: { endDate: effect.newEndDate },
        });
      }
    }
    await tx.employee.update({
      where: { id: employeeId },
      data: { terminationDate: date },
    });
    // M3: grant decisions (carried from a rescheduled termination, then the explicit ones), and
    // an explicit decision for every SYSTEM grant.
    if (options.carryDecisionsFrom) {
      await this.grants.carryOver(tx, {
        fromTerminationId: options.carryDecisionsFrom,
        toTerminationId: termination.id,
        now: options.now,
      });
    }
    await this.grants.record(tx, {
      terminationId: termination.id,
      userId,
      actor,
      decisions: options.grantDecisions,
      now: options.now,
      requireSystemDecisions: true,
      context,
      employeeId,
    });
    void authority;
    return {
      id: termination.id,
      systemGrantsAcknowledged: termination.systemGrantsAcknowledged,
      effects: plan.map((effect) => ({
        employmentAssignmentId: effect.assignment.id,
        action: effect.action,
        previousEndDate: effect.assignment.endDate
          ? dateOnly(effect.assignment.endDate)
          : null,
        endDate: effect.action === 'END' ? dateOnly(effect.newEndDate) : null,
      })),
    };
  }

  /**
   * Undoes a SCHEDULED termination exactly (CANCELLED, or SUPERSEDED by a reschedule): each
   * assignment gets its original end date back, provided nothing has taken effect and the
   * assignment is still exactly as the termination left it.
   */
  private async releaseScheduledInTx(
    tx: Tx,
    termination: {
      id: string;
      employeeId: string;
      terminationDate: Date;
      status: string;
    },
    options: {
      status: 'CANCELLED' | 'SUPERSEDED';
      actor: string;
      reason: string | null;
      now: Date;
      supersededById?: string;
    },
  ) {
    if (termination.status !== 'SCHEDULED') {
      throw new ConflictException(
        lifecycleError(
          409,
          termination.status === 'APPLIED'
            ? 'TERMINATION_ALREADY_EFFECTIVE'
            : 'TERMINATION_NOT_SCHEDULED',
          termination.status === 'APPLIED'
            ? 'This termination has taken effect; rehire the employee instead.'
            : 'Only a scheduled termination can be changed.',
        ),
      );
    }
    const effects = await tx.employeeTerminationAssignment.findMany({
      where: { terminationId: termination.id },
      include: { employmentAssignment: { include: ASSIGNMENT_INCLUDE } },
    });
    const started = effects.filter(
      (e) =>
        e.appliedAt !== null ||
        localToday(
          e.employmentAssignment as AssignmentRow,
          options.now,
        ).getTime() > termination.terminationDate.getTime(),
    );
    if (started.length > 0) {
      throw new ConflictException(
        lifecycleError(
          409,
          'TERMINATION_ALREADY_EFFECTIVE',
          'The termination has already taken effect for some assignments; it can no longer be cancelled or moved. Rehire the employee instead.',
          {
            employmentAssignmentIds: started.map(
              (e) => e.employmentAssignmentId,
            ),
          },
        ),
      );
    }
    const changed = effects.filter((e) => {
      const a = e.employmentAssignment;
      if (a.status !== e.previousStatus) return true;
      if (e.action === 'CANCEL') return false;
      const expected = minDate(e.previousEndDate, termination.terminationDate);
      return a.endDate === null || a.endDate.getTime() !== expected.getTime();
    });
    if (changed.length > 0) {
      throw new ConflictException(
        lifecycleError(
          409,
          'TERMINATION_ASSIGNMENT_CHANGED',
          'Some assignments changed after the termination was scheduled; review them before cancelling or moving it.',
          {
            employmentAssignmentIds: changed.map(
              (e) => e.employmentAssignmentId,
            ),
          },
        ),
      );
    }
    for (const e of effects) {
      if (e.action !== 'END') continue;
      const a = e.employmentAssignment;
      if (
        (a.endDate?.getTime() ?? null) !==
        (e.previousEndDate?.getTime() ?? null)
      ) {
        await tx.employmentAssignment.update({
          where: { id: a.id },
          data: { endDate: e.previousEndDate },
        });
      }
    }
    const closed = await tx.employeeTermination.updateMany({
      where: { id: termination.id, status: 'SCHEDULED' },
      data: {
        status: options.status,
        cancelledAt: options.now,
        cancelledByUserId: options.actor,
        cancellationReason: options.reason,
        supersededById: options.supersededById ?? null,
      },
    });
    if (closed.count !== 1) throw this.changedConcurrently();
    await tx.employee.update({
      where: { id: termination.employeeId },
      data: { terminationDate: null },
    });
  }

  /**
   * Applies what is due of a termination at `now`: each assignment whose own time zone has passed
   * the last day ends (or, starting after it, is cancelled). Once every affected assignment has,
   * the termination is APPLIED, the employee TERMINATED, the shared login's sessions revoked and
   * the login disabled only if no authorization remains (R2). Idempotent.
   */
  private async applyTerminationInTx(
    tx: Tx,
    terminationId: string,
    now: Date,
    source: TerminationApplySource,
    context: LifecycleContext,
    options: { onBlocked: 'throw' | 'defer' } = { onBlocked: 'throw' },
  ): Promise<{
    completed: boolean;
    appliedAssignments: number;
    blocked?: { code: string; roleAssignmentIds: string[] };
    settledBefore?: boolean;
  }> {
    const termination = await tx.employeeTermination.findUniqueOrThrow({
      where: { id: terminationId },
      include: {
        assignments: {
          include: { employmentAssignment: { include: ASSIGNMENT_INCLUDE } },
        },
      },
    });
    if (termination.status !== 'SCHEDULED') {
      return {
        completed: termination.status === 'APPLIED',
        appliedAssignments: 0,
        // Someone else applied (or cancelled) it first: nothing was done here.
        settledBefore: true,
      };
    }
    const date = termination.terminationDate;
    // M3: when this call would complete the termination, its SYSTEM grant decisions must be
    // resolved first — checked before anything changes, so a blocked application changes nothing.
    const open = termination.assignments.filter((e) => e.appliedAt === null);
    const completes =
      open.every(
        (e) =>
          localToday(e.employmentAssignment as AssignmentRow, now).getTime() >
          date.getTime(),
      ) &&
      (termination.assignments.length > 0 ||
        localDateOf(now, 'UTC').getTime() > date.getTime());
    if (completes) {
      const blocked = await this.grants.gate(
        tx,
        terminationId,
        await this.loginOf(tx, termination.employeeId),
        now,
      );
      if (blocked) {
        if (options.onBlocked === 'defer')
          return { completed: false, appliedAssignments: 0, blocked };
        throw this.grants.gateError(blocked);
      }
    }
    let appliedAssignments = 0;
    let timeLocked = false;
    for (const effect of termination.assignments) {
      if (effect.appliedAt !== null) continue;
      const a = effect.employmentAssignment as AssignmentRow;
      if (localToday(a, now).getTime() <= date.getTime()) continue;
      if (!timeLocked) {
        await lockEmployeeTimeForLifecycle(tx, termination.employeeId);
        timeLocked = true;
      }
      if (a.status === 'ACTIVE' || a.status === 'PLANNED') {
        const next = effect.action === 'CANCEL' ? 'CANCELLED' : 'ENDED';
        await assertCompensationFitsAssignment(tx, a.id, {
          status: next,
          startDate: a.startDate,
          endDate: a.endDate,
        });
        const updated = await tx.employmentAssignment.updateMany({
          where: { id: a.id, status: { in: ['ACTIVE', 'PLANNED'] } },
          data: { status: next },
        });
        if (updated.count === 1) {
          await this.audit.write(
            this.auditInput(
              next === 'ENDED'
                ? 'EMPLOYMENT_ASSIGNMENT_ENDED'
                : 'EMPLOYMENT_ASSIGNMENT_CANCELLED',
              'EmploymentAssignment',
              a.id,
              context,
              {
                employeeId: termination.employeeId,
                terminationId,
                source,
                timezone: timezoneOf(a),
                before: { status: a.status },
                after: { status: next },
                endDate: a.endDate ? dateOnly(a.endDate) : null,
              },
            ),
            tx,
          );
        }
      }
      await tx.employeeTerminationAssignment.update({
        where: { id: effect.id },
        data: { appliedAt: now },
      });
      appliedAssignments += 1;
    }
    const remaining = await tx.employeeTerminationAssignment.count({
      where: { terminationId, appliedAt: null },
    });
    if (remaining > 0) return { completed: false, appliedAssignments };
    // An employee with no open assignment has no business time zone: the date passes in UTC.
    if (
      termination.assignments.length === 0 &&
      localDateOf(now, 'UTC').getTime() <= date.getTime()
    ) {
      return { completed: false, appliedAssignments };
    }
    const completed = await tx.employeeTermination.updateMany({
      where: { id: terminationId, status: 'SCHEDULED' },
      data: { status: 'APPLIED', appliedAt: now, appliedSource: source },
    });
    if (completed.count !== 1) return { completed: false, appliedAssignments };
    await tx.employee.update({
      where: { id: termination.employeeId },
      data: { status: 'TERMINATED', terminationDate: date },
    });
    const employee = await tx.employee.findUniqueOrThrow({
      where: { id: termination.employeeId },
      select: { person: { select: { user: { select: { id: true } } } } },
    });
    const userId = employee.person.user?.id;
    let sessionsRevoked = 0;
    let loginDisabled = false;
    let grants = { revoked: 0, retained: 0, alreadyRevoked: 0 };
    if (userId) {
      // M3: the termination's grants are revoked (or retained as approved) in this transaction.
      grants = await this.grants.applyAtCompletion(tx, {
        terminationId,
        employeeId: termination.employeeId,
        userId,
        now,
        source,
        context,
        scheduledByUserId: termination.recordedByUserId,
      });
      sessionsRevoked = (
        await tx.authSession.updateMany({
          where: { userId, revokedAt: null },
          data: { revokedAt: now, revokedReason: 'employment_terminated' },
        })
      ).count;
      loginDisabled = (
        await this.disableLoginIfNoAuthorization(
          tx,
          termination.employeeId,
          userId,
          'employment_terminated',
          context,
          now,
        )
      ).disabled;
    }
    await this.audit.write(
      this.auditInput(
        'EMPLOYEE_TERMINATED',
        'Employee',
        termination.employeeId,
        context,
        {
          terminationId,
          terminationDate: dateOnly(date),
          source,
          sessionsRevoked,
          loginDisabled,
          grantsRevoked: grants.revoked,
          grantsRetained: grants.retained,
          grantsAlreadyRevoked: grants.alreadyRevoked,
          ...(source === 'AUTOMATIC'
            ? { scheduledByUserId: termination.recordedByUserId }
            : {}),
        },
      ),
      tx,
    );
    return { completed: true, appliedAssignments };
  }

  /** ACTIVE → ENDED once the end date has passed in the assignment's time zone. */
  private async endDueAssignmentInTx(
    tx: Tx,
    a: AssignmentRow,
    now: Date,
    source: 'MANUAL' | 'AUTOMATIC',
    context: LifecycleContext,
  ): Promise<'ENDED' | 'NOT_DUE' | 'IN_TERMINATION'> {
    if (a.status !== 'ACTIVE' || a.endDate === null) return 'NOT_DUE';
    if (localToday(a, now).getTime() <= a.endDate.getTime()) return 'NOT_DUE';
    const pending = await tx.employeeTerminationAssignment.count({
      where: {
        employmentAssignmentId: a.id,
        appliedAt: null,
        termination: { status: 'SCHEDULED' },
      },
    });
    if (pending > 0) return 'IN_TERMINATION';
    await lockEmployeeTimeForLifecycle(tx, a.employeeId);
    await assertCompensationFitsAssignment(tx, a.id, {
      status: 'ENDED',
      startDate: a.startDate,
      endDate: a.endDate,
    });
    const updated = await tx.employmentAssignment.updateMany({
      where: { id: a.id, status: 'ACTIVE', endDate: a.endDate },
      data: { status: 'ENDED' },
    });
    if (updated.count !== 1) return 'NOT_DUE';
    await this.audit.write(
      this.auditInput(
        'EMPLOYMENT_ASSIGNMENT_ENDED',
        'EmploymentAssignment',
        a.id,
        context,
        {
          employeeId: a.employeeId,
          positionId: a.positionId,
          organizationId: a.position.organizationId,
          source,
          timezone: timezoneOf(a),
          endDate: dateOnly(a.endDate),
          before: { status: 'ACTIVE' },
          after: { status: 'ENDED' },
        },
      ),
      tx,
    );
    return 'ENDED';
  }

  /**
   * R2: the shared login is disabled (and its sessions and pending links revoked) only when the
   * employee is terminated and no effective authorization remains for the account.
   */
  private async disableLoginIfNoAuthorization(
    tx: Tx,
    employeeId: string,
    userId: string,
    reason: string,
    context: LifecycleContext,
    now = new Date(),
  ): Promise<{ disabled: boolean }> {
    const grants = await this.authorization.effectiveGrants(userId, now, tx);
    if (grants.length > 0) return { disabled: false };
    const updated = await tx.user.updateMany({
      where: {
        id: userId,
        status: { in: ['ACTIVE', 'LOCKED'] },
        archivedAt: null,
      },
      data: { status: 'DISABLED' },
    });
    if (updated.count !== 1) return { disabled: false };
    await tx.authSession.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: now, revokedReason: reason },
    });
    await tx.accountToken.updateMany({
      where: { userId, usedAt: null },
      data: { usedAt: now },
    });
    await this.audit.write(
      this.auditInput(
        'EMPLOYEE_ACCOUNT_DISABLED',
        'Employee',
        employeeId,
        context,
        {
          userId,
          reason,
          automatic: true,
        },
      ),
      tx,
    );
    return { disabled: true };
  }

  private async accessSummary(
    userId: string,
    employee: {
      assignments: Array<{
        status: string;
        endDate: Date | null;
        position: { organizationId: string };
      }>;
    },
    actorUserId: string,
    now: Date,
  ) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { id: true, status: true },
    });
    const [sessions, grants, effective] = await Promise.all([
      this.prisma.authSession.count({
        where: { userId, revokedAt: null, expiresAt: { gt: now } },
      }),
      this.prisma.roleAssignment.findMany({
        where: {
          userId,
          revokedAt: null,
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        },
        include: {
          role: {
            select: {
              name: true,
              isSystemOwner: true,
              archivedAt: true,
              organization: { select: { archivedAt: true } },
            },
          },
          organization: { select: { name: true, archivedAt: true } },
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
      this.authorization.effectiveGrants(userId, now),
    ]);
    const current = new Set(
      employee.assignments
        .filter(
          (a) =>
            (a.status === 'ACTIVE' || a.status === 'PLANNED') &&
            (a.endDate === null ||
              a.endDate.getTime() >= addDays(now, -1).getTime()),
        )
        .map((a) => a.position.organizationId),
    );
    const employed = new Set(
      employee.assignments
        .filter((a) => a.status !== 'CANCELLED')
        .map((a) => a.position.organizationId),
    );
    // M3: grants kept after a termination (expiring replacements) and grants it revoked.
    const retained = new Map(
      (
        await this.prisma.employeeTerminationGrantDecision.findMany({
          where: {
            outcome: 'RETAINED',
            retainedRoleAssignmentId: { in: grants.map((g) => g.id) },
          },
          select: {
            terminationId: true,
            retainedRoleAssignmentId: true,
            keepUntil: true,
            status: true,
            requestedByUserId: true,
            reviewedByUserId: true,
          },
        })
      ).map((d) => [d.retainedRoleAssignmentId!, d]),
    );
    let hidden = 0;
    const items = [];
    for (const grant of grants) {
      const scope = this.grantScope(grant);
      const visible =
        (await this.authorization.canAccess(actorUserId, 'role.read', scope)) ||
        (await this.authorization.canAccess(actorUserId, 'role.assign', scope));
      if (!visible) {
        hidden += 1;
        continue;
      }
      const relation =
        grant.scopeType === 'SYSTEM'
          ? 'SYSTEM'
          : grant.organizationId && current.has(grant.organizationId)
            ? 'CURRENT_EMPLOYMENT'
            : grant.organizationId && employed.has(grant.organizationId)
              ? 'ENDED_EMPLOYMENT'
              : 'NO_EMPLOYMENT';
      items.push({
        roleAssignmentId: grant.id,
        roleName: grant.role.name,
        scopeType: grant.scopeType,
        organizationId: grant.organizationId,
        organizationName: grant.organization?.name ?? null,
        relation,
        // Batch 5E: a grant whose organization or role is archived authorizes nothing (K9); it is
        // still listed (and may be revoked) but marked, so it is never read as remaining access.
        inactiveReason:
          grant.organization?.archivedAt || grant.role.organization?.archivedAt
            ? ('ORGANIZATION_ARCHIVED' as const)
            : grant.role.archivedAt
              ? ('ROLE_ARCHIVED' as const)
              : null,
        revocable:
          !grant.role.isSystemOwner &&
          (await this.authorization.canAccess(
            actorUserId,
            'role.assign',
            scope,
          )),
        retention: retained.has(grant.id)
          ? {
              terminationId: retained.get(grant.id)!.terminationId,
              keepUntil: grant.expiresAt?.toISOString() ?? null,
              approvalStatus: retained.get(grant.id)!.status,
              requestedByUserId: retained.get(grant.id)!.requestedByUserId,
              approvedByUserId: retained.get(grant.id)!.reviewedByUserId,
            }
          : null,
      });
    }
    const revokedByTermination = [];
    for (const grant of await this.prisma.roleAssignment.findMany({
      where: { userId, revocationReason: 'employment_terminated' },
      include: {
        role: { select: { name: true } },
        organization: { select: { name: true } },
      },
      orderBy: [{ revokedAt: 'desc' }, { id: 'asc' }],
      take: 100,
    })) {
      const scope = this.grantScope(grant);
      if (
        !(await this.authorization.canAccess(
          actorUserId,
          'role.read',
          scope,
        )) &&
        !(await this.authorization.canAccess(actorUserId, 'role.assign', scope))
      )
        continue;
      revokedByTermination.push({
        roleAssignmentId: grant.id,
        roleName: grant.role.name,
        scopeType: grant.scopeType,
        organizationName: grant.organization?.name ?? null,
        revokedAt: grant.revokedAt?.toISOString() ?? null,
      });
    }
    return {
      userId,
      loginStatus: user.status,
      revokedByTermination,
      activeSessions: sessions,
      grants: items,
      hiddenGrants: hidden,
      systemGrants: grants.filter((g) => g.scopeType === 'SYSTEM').length,
      hasEffectiveAuthorization: effective.length > 0,
    };
  }

  private grantScope(grant: {
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

  private async everyManageable(
    effects: Array<{ employmentAssignment: { positionId: string } }>,
    canManage: (positionId: string) => Promise<boolean>,
  ) {
    for (const e of effects) {
      if (!(await canManage(e.employmentAssignment.positionId))) return false;
    }
    return true;
  }

  private async mayManage(actorUserId: string, employeeId: string) {
    try {
      await this.access.authorizeEmployeeWide(actorUserId, employeeId, {
        referenceDate: new Date('1900-01-01T00:00:00.000Z'),
      });
      return true;
    } catch {
      return false;
    }
  }

  private async requireTermination(tx: Tx, employeeId: string, id: string) {
    const termination = await tx.employeeTermination.findFirst({
      where: { id, employeeId },
    });
    if (!termination) throw new NotFoundException('Termination not found.');
    return termination;
  }

  private async terminationResult(tx: Tx, terminationId: string, now: Date) {
    const row = await tx.employeeTermination.findUniqueOrThrow({
      where: { id: terminationId },
      include: { assignments: true },
    });
    const employee = await tx.employee.findUniqueOrThrow({
      where: { id: row.employeeId },
      select: { id: true, status: true, terminationDate: true },
    });
    // M3: while scheduled, whether applying it is (or would be) blocked by a SYSTEM grant
    // without a decision or with a pending keep — the person keeps their access until resolved.
    const applyBlockedBy =
      row.status === 'SCHEDULED'
        ? await this.grants.gate(
            tx,
            terminationId,
            await this.loginOf(tx, row.employeeId),
            now,
          )
        : null;
    return {
      termination: this.terminationShape(row, true),
      // M3: what the application did with the termination's grants.
      grants: await this.grants.counts(tx, terminationId),
      applyBlockedBy,
      employee: {
        id: employee.id,
        status: employee.status,
        terminationDate: employee.terminationDate
          ? dateOnly(employee.terminationDate)
          : null,
      },
    };
  }

  private terminationShape(
    row: {
      id: string;
      employeeId: string;
      terminationDate: Date;
      status: string;
      reason: string | null;
      systemGrantsAcknowledged: boolean;
      recordedByUserId: string | null;
      recordedAt: Date;
      appliedAt: Date | null;
      appliedSource: string | null;
      cancelledAt: Date | null;
      cancelledByUserId: string | null;
      supersededById: string | null;
      rehireAssignmentId: string | null;
      rehiredAt: Date | null;
      assignments: Array<{
        employmentAssignmentId: string;
        action: string;
        previousStatus: string;
        previousEndDate: Date | null;
        appliedAt: Date | null;
      }>;
    },
    showReason: boolean,
  ) {
    return {
      id: row.id,
      employeeId: row.employeeId,
      terminationDate: dateOnly(row.terminationDate),
      status: row.status,
      // R7: the reason only for those who may manage the employee.
      ...(showReason ? { reason: row.reason } : {}),
      systemGrantsAcknowledged: row.systemGrantsAcknowledged,
      recordedByUserId: row.recordedByUserId,
      recordedAt: row.recordedAt.toISOString(),
      appliedAt: row.appliedAt?.toISOString() ?? null,
      appliedSource: row.appliedSource,
      cancelledAt: row.cancelledAt?.toISOString() ?? null,
      cancelledByUserId: row.cancelledByUserId,
      supersededById: row.supersededById,
      rehireAssignmentId: row.rehireAssignmentId,
      rehiredAt: row.rehiredAt?.toISOString() ?? null,
      assignments: row.assignments.map((a) => ({
        employmentAssignmentId: a.employmentAssignmentId,
        action: a.action,
        previousStatus: a.previousStatus,
        previousEndDate: a.previousEndDate ? dateOnly(a.previousEndDate) : null,
        appliedAt: a.appliedAt?.toISOString() ?? null,
      })),
    };
  }

  private displayName(person: {
    firstName: string | null;
    lastName: string | null;
    preferredName: string | null;
  }) {
    return (
      [person.preferredName ?? person.firstName, person.lastName]
        .filter(Boolean)
        .join(' ') || null
    );
  }

  private optionalText(value: string | undefined, label: string, max: number) {
    if (value === undefined || value === null) return null;
    const trimmed = String(value).trim();
    if (!trimmed) return null;
    if (trimmed.length > max)
      throw new BadRequestException(
        `${label} must be ${max} characters or fewer.`,
      );
    return trimmed;
  }

  private requireActor(context: LifecycleContext) {
    if (!context.actorUserId) throw new ForbiddenException();
    return context.actorUserId;
  }

  private changedConcurrently() {
    return new ConflictException(
      lifecycleError(
        409,
        'EMPLOYEE_CHANGED_CONCURRENTLY',
        'The employee changed at the same time; reload and try again.',
      ),
    );
  }

  private auditInput(
    action: string,
    entityType: string,
    entityId: string,
    context: LifecycleContext,
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
