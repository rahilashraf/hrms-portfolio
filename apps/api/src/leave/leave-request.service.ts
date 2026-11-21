import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { HolidayService } from '../calendar/holiday.service.js';
import { PrismaService } from '../database/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import type {
  LeavePolicy,
  LeaveRequestDay,
} from '../generated/prisma/client.js';
import { ScheduleAttendanceService } from '../scheduling/schedule-attendance.service.js';
import type { PublishedExpectedWorkFact } from '../scheduling/scheduling-integration.contracts.js';
import {
  LEAVE_PERMISSIONS,
  LeaveAccessService,
} from './leave-access.service.js';
import {
  addDays,
  eachDate,
  formatDate,
  jsonValue,
  leaveError,
  localDateOf,
  localDayStart,
  minDate,
  parseDateOnly,
  requireActor,
  type LeaveClient,
  type LeaveRequestContext,
} from './leave-common.js';
import { LeaveConfigService } from './leave-config.service.js';
import { DEFAULT_ENTITLEMENT_LOOKBACK_DAYS } from './leave-entitlement.service.js';
import { LeaveIntegrationRegistry } from './leave-integration.js';
import { LeaveLedgerService } from './leave-ledger.service.js';
import { leaveYearBalanceCheck } from './leave-ledger.js';
import { leaveYearStartOf, resolveLeavePolicy } from './leave-policy.js';
import {
  applyDayOverrides,
  sizeLeaveDays,
  windowsOverlap,
  type SizedLeaveDay,
} from './leave-sizing.js';
import {
  MAX_LEAVE_REQUEST_DAYS,
  type AmendLeaveDto,
  type ApproveLeaveDto,
  type CancelOwnLeaveDto,
  type CreateLeaveOnBehalfDto,
  type LeaveRequestInputDto,
  type RejectLeaveDto,
} from './leave.dto.js';

type Tx = Prisma.TransactionClient;
type SizedRequest = Awaited<ReturnType<LeaveRequestService['size']>>;
type AssignmentContext = Awaited<
  ReturnType<LeaveAccessService['assignmentContext']>
>;
const EXPECTED_WORK_CHUNK_DAYS = 90;

/**
 * Phase 8 — leave requests: server-side sizing, submission, single-step scoped approval,
 * rejection, on-behalf recording, and amendments (cancel/shorten) of approved leave.
 *
 * Lock order (shared with entitlement jobs): EmploymentAssignment (FOR NO KEY UPDATE, the same
 * first lock as Phase 7 generation) → LeaveAccount (FOR UPDATE) → LeaveRequest (FOR UPDATE).
 * The assignment lock serializes overlap checks across leave types; the account lock
 * serializes balance checks and ledger posting.
 */
@Injectable()
export class LeaveRequestService {
  /** The clock for "today" in balance checks and self-cancellation; tests replace it. */
  now: () => Date = () => new Date();

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: LeaveAccessService,
    private readonly config: LeaveConfigService,
    private readonly ledger: LeaveLedgerService,
    private readonly holidays: HolidayService,
    private readonly schedules: ScheduleAttendanceService,
    private readonly integration: LeaveIntegrationRegistry,
    private readonly audit: AuditService,
  ) {}

  // ─── Self-service ──────────────────────────────────────────────────────────

  async previewOwn(userId: string, input: LeaveRequestInputDto) {
    const context = await this.selfAssignment(
      userId,
      input.employmentAssignmentId,
      this.prisma,
    );
    return this.preview(context, input, this.prisma);
  }

  async submitOwn(
    userId: string,
    input: LeaveRequestInputDto,
    context: LeaveRequestContext,
  ) {
    const actor = requireActor(context);
    return this.prisma.$transaction(async (tx) => {
      const assignment = await this.selfAssignment(
        actor,
        input.employmentAssignmentId,
        tx,
      );
      const request = await this.createRequest(
        tx,
        actor,
        assignment,
        input,
        context,
      );
      return { requestId: request.id, status: request.status };
    });
  }

  /**
   * The employee cancels their own request: a PENDING request is withdrawn; APPROVED leave is
   * cancelled from tomorrow (assignment-local) onwards when the policy allows it, posting
   * reversals for exactly the cancelled days. Past days stay as taken.
   */
  async cancelOwn(
    userId: string,
    requestId: string,
    input: CancelOwnLeaveDto,
    context: LeaveRequestContext,
  ) {
    const actor = requireActor(context);
    return this.prisma.$transaction(async (tx) => {
      const self = await this.access.selfEmployee(actor, tx);
      const found = await tx.leaveRequest.findUnique({
        where: { id: requestId },
      });
      if (!found || found.employeeId !== self.id)
        throw new NotFoundException('Leave request not found');
      const locked = await this.lockRequest(tx, found);
      await this.access.requireEnabled(
        locked.assignmentContext.target.organizationId,
        tx,
      );
      if (locked.request.status === 'PENDING') {
        return this.withdrawPending(
          tx,
          actor,
          locked.request.id,
          input.reason ?? null,
          context,
        );
      }
      if (locked.request.status !== 'APPROVED') {
        throw new ConflictException(
          leaveError(
            409,
            'LEAVE_REQUEST_NOT_CANCELLABLE',
            'Only pending or approved leave can be cancelled.',
          ),
        );
      }
      const policy = await this.policyAt(
        tx,
        locked.assignmentContext,
        locked.request.leaveTypeId,
        locked.request.startDate,
      );
      if (!policy?.employeeMayCancelApprovedFuture) {
        throw new ForbiddenException(
          leaveError(
            403,
            'LEAVE_SELF_CANCEL_NOT_ALLOWED',
            'Approved leave can only be changed by an approver under this policy.',
          ),
        );
      }
      const today = localDateOf(this.now(), locked.request.timezone);
      const days = locked.days.filter(
        (day) => !day.cancelledByAmendmentId && day.date > today,
      );
      if (days.length === 0) {
        throw new ConflictException(
          leaveError(
            409,
            'LEAVE_NOTHING_TO_CANCEL',
            'There are no future days of this leave left to cancel.',
          ),
        );
      }
      return this.amendInTx(
        tx,
        actor,
        locked,
        days,
        (input.reason ?? '').trim() || 'Cancelled by employee',
        context,
      );
    });
  }

  // ─── Approver operations ───────────────────────────────────────────────────

  async previewForAssignment(userId: string, input: LeaveRequestInputDto) {
    const context = await this.access.requireAssignmentPermission(
      userId,
      input.employmentAssignmentId,
      'leave.approve',
    );
    return this.preview(context, input, this.prisma);
  }

  /** Records leave for an employee (e.g. called in sick), optionally approving it at once. */
  async createOnBehalf(
    userId: string,
    input: CreateLeaveOnBehalfDto,
    context: LeaveRequestContext,
  ) {
    const actor = requireActor(context);
    return this.prisma.$transaction(async (tx) => {
      const assignment = await this.access.requireAssignmentPermission(
        actor,
        input.employmentAssignmentId,
        'leave.approve',
        tx,
      );
      await this.assertNotSelf(tx, actor, assignment.assignment.employeeId);
      const request = await this.createRequest(
        tx,
        actor,
        assignment,
        input,
        context,
      );
      if (input.approve) {
        await this.approveInTx(
          tx,
          actor,
          request.id,
          { note: input.note },
          context,
        );
      }
      const final = await tx.leaveRequest.findUniqueOrThrow({
        where: { id: request.id },
      });
      return { requestId: final.id, status: final.status };
    });
  }

  async approve(
    userId: string,
    requestId: string,
    input: ApproveLeaveDto,
    context: LeaveRequestContext,
  ) {
    const actor = requireActor(context);
    return this.prisma.$transaction(async (tx) => {
      await this.approveInTx(tx, actor, requestId, input, context);
      const final = await tx.leaveRequest.findUniqueOrThrow({
        where: { id: requestId },
      });
      return {
        requestId,
        status: final.status,
        approvedMinutes: final.approvedMinutes,
      };
    });
  }

  async reject(
    userId: string,
    requestId: string,
    input: RejectLeaveDto,
    context: LeaveRequestContext,
  ) {
    const actor = requireActor(context);
    return this.prisma.$transaction(async (tx) => {
      const found = await tx.leaveRequest.findUnique({
        where: { id: requestId },
      });
      if (!found) throw new NotFoundException('Leave request not found');
      const locked = await this.lockRequest(tx, found);
      await this.assertDecider(tx, actor, locked.assignmentContext);
      if (locked.request.status !== 'PENDING') {
        throw new ConflictException(
          leaveError(
            409,
            'LEAVE_REQUEST_NOT_PENDING',
            'Only a pending request can be rejected.',
            {
              status: locked.request.status,
            },
          ),
        );
      }
      const note = input.note?.trim() || null;
      await tx.leaveRequest.update({
        where: { id: requestId },
        data: {
          status: 'REJECTED',
          decidedByUserId: actor,
          decidedAt: new Date(),
          decisionNote: note,
        },
      });
      await this.event(tx, requestId, 'REJECTED', actor, note);
      // Phase 19: the note stays on the request (access-controlled); never in the audit log.
      await this.writeAudit(tx, 'LEAVE_REQUEST_REJECTED', requestId, context, {
        employeeId: found.employeeId,
        withNote: note !== null,
      });
      return { requestId, status: 'REJECTED' as const };
    });
  }

  /** Cancels or shortens APPROVED leave by explicit reversal; locked periods are refused. */
  async amend(
    userId: string,
    requestId: string,
    input: AmendLeaveDto,
    context: LeaveRequestContext,
  ) {
    const actor = requireActor(context);
    const reason = input.reason.trim();
    if (!reason) throw new BadRequestException('A reason is required.');
    if (input.cancelDates && input.cancelFrom) {
      throw new BadRequestException(
        'Use either cancelDates or cancelFrom, not both.',
      );
    }
    return this.prisma.$transaction(async (tx) => {
      const found = await tx.leaveRequest.findUnique({
        where: { id: requestId },
      });
      if (!found) throw new NotFoundException('Leave request not found');
      const locked = await this.lockRequest(tx, found);
      await this.assertDecider(tx, actor, locked.assignmentContext);
      if (locked.request.status !== 'APPROVED') {
        throw new ConflictException(
          leaveError(
            409,
            'LEAVE_REQUEST_NOT_APPROVED',
            'Only approved leave can be cancelled or shortened.',
            {
              status: locked.request.status,
            },
          ),
        );
      }
      const active = locked.days.filter((day) => !day.cancelledByAmendmentId);
      let days = active;
      if (input.cancelDates) {
        const wanted = new Set(input.cancelDates);
        days = active.filter((day) => wanted.has(formatDate(day.date)));
        if (days.length !== wanted.size) {
          throw new BadRequestException(
            leaveError(
              400,
              'LEAVE_AMEND_DATES_INVALID',
              'Every date to cancel must be an active day of this leave.',
            ),
          );
        }
      } else if (input.cancelFrom) {
        const from = parseDateOnly(input.cancelFrom, 'cancelFrom');
        days = active.filter((day) => day.date >= from);
      }
      if (days.length === 0) {
        throw new ConflictException(
          leaveError(
            409,
            'LEAVE_NOTHING_TO_CANCEL',
            'There are no active days of this leave to cancel.',
          ),
        );
      }
      return this.amendInTx(tx, actor, locked, days, reason, context);
    });
  }

  // ─── Core ──────────────────────────────────────────────────────────────────

  private async preview(
    context: AssignmentContext,
    input: LeaveRequestInputDto,
    client: LeaveClient,
  ) {
    const type = await this.leaveTypeFor(client, context, input.leaveTypeId);
    const sizing = await this.size(client, context, type.id, input);
    const totalMinutes = sizing.days.reduce((sum, day) => sum + day.minutes, 0);
    let balance = null;
    if (type.tracksBalance) {
      const account = await client.leaveAccount.findUnique({
        where: {
          employmentAssignmentId_leaveTypeId: {
            employmentAssignmentId: context.assignment.id,
            leaveTypeId: type.id,
          },
        },
      });
      const asOf = localDateOf(this.now(), sizing.timezone);
      const current = account
        ? await this.ledger.balanceOf(client, account.id, asOf)
        : { currentMinutes: 0, scheduledMinutes: 0, availableMinutes: 0 };
      const pending = account
        ? ((await this.ledger.pendingMinutes(client, [account.id])).get(
            account.id,
          ) ?? 0)
        : 0;
      const check = await this.balanceCheck(
        client,
        account?.id ?? null,
        sizing,
      );
      balance = {
        ...current,
        pendingMinutes: pending,
        leaveYear: {
          start: formatDate(check.leaveYear.start),
          end: formatDate(check.leaveYear.end),
        },
        /** Projected end-of-leave-year balance of the request's leave year, before and after. */
        availableForLeaveYearMinutes: check.availableMinutes,
        availableAfterMinutes: check.availableAfterMinutes,
        negativeBalanceLimitMinutes: check.negativeBalanceLimitMinutes,
        sufficient: check.sufficient,
      };
    }
    return {
      employmentAssignmentId: context.assignment.id,
      leaveType: this.config.typeShape(type),
      timezone: sizing.timezone,
      startDate: input.startDate,
      endDate: input.endDate,
      partial: sizing.partial,
      totalMinutes,
      days: sizing.days.map((day) => this.dayShape(day)),
      balance,
    };
  }

  private async createRequest(
    tx: Tx,
    actor: string,
    context: AssignmentContext,
    input: LeaveRequestInputDto,
    audit: LeaveRequestContext,
  ) {
    await this.lockAssignment(tx, context.assignment.id);
    const type = await this.leaveTypeFor(tx, context, input.leaveTypeId);
    const sizing = await this.size(tx, context, type.id, input);
    const total = sizing.days.reduce((sum, day) => sum + day.minutes, 0);
    if (total <= 0) {
      throw new BadRequestException(
        leaveError(
          400,
          'LEAVE_REQUEST_EMPTY',
          'The requested dates contain no working time to take as leave.',
        ),
      );
    }
    await this.assertNoOverlap(tx, context.assignment.id, sizing.days, null);
    await this.assertNotLocked(
      tx,
      context,
      sizing.days.map((d) => d.date),
      type.tracksBalance,
    );
    const account = await this.ledger.ensureAccount(tx, {
      employeeId: context.assignment.employeeId,
      employmentAssignmentId: context.assignment.id,
      leaveTypeId: type.id,
    });
    await this.ledger.lockAccount(tx, account.id);
    if (type.tracksBalance) {
      await this.assertBalance(tx, account.id, sizing);
    }
    const request = await tx.leaveRequest.create({
      data: {
        employeeId: context.assignment.employeeId,
        employmentAssignmentId: context.assignment.id,
        leaveTypeId: type.id,
        accountId: account.id,
        startDate: sizing.from,
        endDate: sizing.to,
        startLocalTime: sizing.partial?.startLocalTime ?? null,
        endLocalTime: sizing.partial?.endLocalTime ?? null,
        timezone: sizing.timezone,
        reason: input.reason?.trim() || null,
        requestedMinutes: total,
        requestedByUserId: actor,
      },
    });
    await tx.leaveRequestDay.createMany({
      data: sizing.days.map((day) => this.dayRow(request.id, day)),
    });
    await this.event(tx, request.id, 'SUBMITTED', actor, request.reason, {
      requestedMinutes: total,
      onBehalf:
        actor !==
        (await this.userOfEmployee(tx, context.assignment.employeeId)),
    });
    await this.writeAudit(tx, 'LEAVE_REQUEST_SUBMITTED', request.id, audit, {
      employeeId: request.employeeId,
      employmentAssignmentId: request.employmentAssignmentId,
      leaveTypeId: request.leaveTypeId,
      startDate: formatDate(request.startDate),
      endDate: formatDate(request.endDate),
      requestedMinutes: total,
    });
    return request;
  }

  private async approveInTx(
    tx: Tx,
    actor: string,
    requestId: string,
    input: ApproveLeaveDto,
    context: LeaveRequestContext,
  ) {
    const found = await tx.leaveRequest.findUnique({
      where: { id: requestId },
    });
    if (!found) throw new NotFoundException('Leave request not found');
    const locked = await this.lockRequest(tx, found);
    await this.assertDecider(tx, actor, locked.assignmentContext);
    const request = locked.request;
    if (request.status !== 'PENDING') {
      throw new ConflictException(
        leaveError(
          409,
          'LEAVE_REQUEST_NOT_PENDING',
          'Only a pending request can be approved.',
          {
            status: request.status,
          },
        ),
      );
    }
    const type = await this.leaveTypeFor(
      tx,
      locked.assignmentContext,
      request.leaveTypeId,
    );
    // Re-size against today's published schedule and calendar, then freeze.
    const sizing = await this.size(tx, locked.assignmentContext, type.id, {
      startDate: formatDate(request.startDate),
      endDate: formatDate(request.endDate),
      startLocalTime: request.startLocalTime ?? undefined,
      endLocalTime: request.endLocalTime ?? undefined,
    });
    const overrides = input.dayOverrides ?? [];
    const dates = new Set(sizing.days.map((d) => formatDate(d.date)));
    for (const override of overrides) {
      if (!dates.has(override.date) || !override.reason.trim()) {
        throw new BadRequestException(
          leaveError(
            400,
            'LEAVE_OVERRIDE_INVALID',
            'Each override must name a date of the request and give a reason.',
          ),
        );
      }
    }
    const days = applyDayOverrides(sizing.days, overrides);
    const total = days.reduce((sum, day) => sum + day.minutes, 0);
    if (total <= 0) {
      throw new BadRequestException(
        leaveError(
          400,
          'LEAVE_REQUEST_EMPTY',
          'Approved leave must contain working time.',
        ),
      );
    }
    await this.assertNoOverlap(
      tx,
      request.employmentAssignmentId,
      days,
      request.id,
    );
    await this.assertNotLocked(
      tx,
      locked.assignmentContext,
      days.map((d) => d.date),
      type.tracksBalance,
    );
    if (type.tracksBalance) {
      await this.assertBalance(tx, request.accountId, { ...sizing, days });
    }
    // Days may change only while the request is PENDING (database trigger).
    await tx.leaveRequestDay.deleteMany({ where: { requestId } });
    await tx.leaveRequestDay.createMany({
      data: days.map((day) => this.dayRow(requestId, day)),
    });
    const stored = await tx.leaveRequestDay.findMany({
      where: { requestId },
      orderBy: { date: 'asc' },
    });
    const policyByDate = new Map(
      days.map((d) => [formatDate(d.date), d.policyId]),
    );
    await tx.leaveRequest.update({
      where: { id: requestId },
      data: {
        status: 'APPROVED',
        approvedMinutes: total,
        decidedByUserId: actor,
        decidedAt: new Date(),
        decisionNote: input.note?.trim() || null,
      },
    });
    if (type.tracksBalance) {
      const account = await tx.leaveAccount.findUniqueOrThrow({
        where: { id: request.accountId },
      });
      for (const day of stored) {
        if (day.minutes <= 0) continue;
        await this.ledger.post(tx, {
          account,
          entryType: 'USAGE',
          amountMinutes: -day.minutes,
          effectiveDate: day.date,
          sourceType: 'LEAVE_REQUEST',
          idempotencyKey: `usage:${day.id}`,
          policyId: policyByDate.get(formatDate(day.date)) ?? null,
          leaveRequestId: requestId,
          leaveRequestDayId: day.id,
          createdByUserId: actor,
        });
      }
    }
    await this.event(
      tx,
      requestId,
      'APPROVED',
      actor,
      input.note?.trim() || null,
      {
        approvedMinutes: total,
        requestedMinutes: request.requestedMinutes,
        overrides: overrides.map((o) => ({
          date: o.date,
          minutes: o.minutes,
          reason: o.reason.trim(),
        })),
      },
    );
    await this.writeAudit(tx, 'LEAVE_REQUEST_APPROVED', requestId, context, {
      employeeId: request.employeeId,
      approvedMinutes: total,
      requestedMinutes: request.requestedMinutes,
      overrideCount: overrides.length,
    });
    await this.integration.absenceChanged(
      tx,
      {
        employeeId: request.employeeId,
        employmentAssignmentId: request.employmentAssignmentId,
        dates: stored.map((day) => day.date),
        intervals: stored.map((day) => ({
          start: day.absenceStart,
          end: day.absenceEnd,
        })),
      },
      context,
    );
  }

  private async withdrawPending(
    tx: Tx,
    actor: string,
    requestId: string,
    reason: string | null,
    context: LeaveRequestContext,
  ) {
    await tx.leaveRequest.update({
      where: { id: requestId },
      data: { status: 'CANCELLED' },
    });
    await this.event(tx, requestId, 'CANCELLED', actor, reason);
    await this.writeAudit(tx, 'LEAVE_REQUEST_CANCELLED', requestId, context, {
      wasStatus: 'PENDING',
      withReason: Boolean(reason),
    });
    return { requestId, status: 'CANCELLED' as const, cancelledMinutes: 0 };
  }

  private async amendInTx(
    tx: Tx,
    actor: string,
    locked: Awaited<ReturnType<LeaveRequestService['lockRequest']>>,
    days: LeaveRequestDay[],
    reason: string,
    context: LeaveRequestContext,
  ) {
    const request = locked.request;
    const { tracksBalance } = await tx.leaveType.findUniqueOrThrow({
      where: { id: request.leaveTypeId },
      select: { tracksBalance: true },
    });
    await this.assertNotLocked(
      tx,
      locked.assignmentContext,
      days.map((d) => d.date),
      tracksBalance,
    );
    const remaining = locked.days.filter(
      (day) =>
        !day.cancelledByAmendmentId && !days.some((d) => d.id === day.id),
    );
    const cancelledMinutes = days.reduce((sum, day) => sum + day.minutes, 0);
    const amendment = await tx.leaveRequestAmendment.create({
      data: {
        requestId: request.id,
        type: remaining.length === 0 ? 'CANCEL' : 'SHORTEN',
        reason,
        cancelledMinutes,
        actorUserId: actor,
      },
    });
    for (const day of days) {
      await tx.leaveRequestDay.update({
        where: { id: day.id },
        data: { cancelledByAmendmentId: amendment.id },
      });
    }
    const usage = await tx.leaveLedgerEntry.findMany({
      where: {
        leaveRequestDayId: { in: days.map((d) => d.id) },
        entryType: 'USAGE',
        reversedBy: null,
      },
    });
    for (const entry of usage) {
      await this.ledger.postReversal(tx, entry, {
        reason: `Leave amended: ${reason}`,
        sourceType: 'LEAVE_REQUEST',
        createdByUserId: actor,
      });
    }
    if (remaining.length === 0) {
      await tx.leaveRequest.update({
        where: { id: request.id },
        data: { status: 'CANCELLED' },
      });
    }
    await this.event(tx, request.id, 'AMENDED', actor, reason, {
      amendmentId: amendment.id,
      type: amendment.type,
      cancelledDates: days.map((d) => formatDate(d.date)),
      cancelledMinutes,
    });
    if (remaining.length === 0)
      await this.event(tx, request.id, 'CANCELLED', actor, reason);
    await this.writeAudit(tx, 'LEAVE_REQUEST_AMENDED', request.id, context, {
      employeeId: request.employeeId,
      amendmentId: amendment.id,
      type: amendment.type,
      cancelledDates: days.map((d) => formatDate(d.date)),
      cancelledMinutes,
      reversedEntryIds: usage.map((e) => e.id),
    });
    await this.integration.absenceChanged(
      tx,
      {
        employeeId: request.employeeId,
        employmentAssignmentId: request.employmentAssignmentId,
        dates: days.map((day) => day.date),
        intervals: days.map((day) => ({
          start: day.absenceStart,
          end: day.absenceEnd,
        })),
      },
      context,
    );
    return {
      requestId: request.id,
      status:
        remaining.length === 0 ? ('CANCELLED' as const) : ('APPROVED' as const),
      amendmentId: amendment.id,
      cancelledMinutes,
    };
  }

  // ─── Sizing ────────────────────────────────────────────────────────────────

  async size(
    client: LeaveClient,
    context: AssignmentContext,
    leaveTypeId: string,
    input: Pick<
      LeaveRequestInputDto,
      'startDate' | 'endDate' | 'startLocalTime' | 'endLocalTime'
    >,
  ) {
    const from = parseDateOnly(input.startDate, 'startDate');
    const to = parseDateOnly(input.endDate, 'endDate');
    if (to < from)
      throw new BadRequestException('endDate must be on or after startDate.');
    const dates = eachDate(from, to);
    if (dates.length > MAX_LEAVE_REQUEST_DAYS) {
      throw new BadRequestException(
        `A leave request may span at most ${MAX_LEAVE_REQUEST_DAYS} days.`,
      );
    }
    const partial =
      input.startLocalTime || input.endLocalTime
        ? {
            startLocalTime: input.startLocalTime ?? '',
            endLocalTime: input.endLocalTime ?? '',
          }
        : null;
    if (partial) {
      if (
        !partial.startLocalTime ||
        !partial.endLocalTime ||
        dates.length !== 1
      ) {
        throw new BadRequestException(
          leaveError(
            400,
            'LEAVE_PARTIAL_DAY_INVALID',
            'A partial day needs both times on a single-date request.',
          ),
        );
      }
      if (partial.startLocalTime >= partial.endLocalTime) {
        throw new BadRequestException(
          leaveError(
            400,
            'LEAVE_PARTIAL_DAY_INVALID',
            'The partial-day end time must be after its start time.',
          ),
        );
      }
    }
    const timezone = context.timezone();
    const { assignment } = context;
    if (assignment.status === 'CANCELLED') {
      throw new BadRequestException(
        leaveError(400, 'LEAVE_NOT_ELIGIBLE', 'The assignment was cancelled.'),
      );
    }
    const policies = await this.config.policiesOf(leaveTypeId, client);
    const subject = {
      employmentAssignmentId: assignment.id,
      employmentType: assignment.employmentType,
      target: context.target,
    };
    const policyByDate = new Map<string, LeavePolicy>();
    for (const date of dates) {
      const policy = resolveLeavePolicy(policies, subject, date);
      const outside =
        date < assignment.startDate ||
        (assignment.endDate !== null && date > assignment.endDate) ||
        (assignment.employee.terminationDate !== null &&
          date > assignment.employee.terminationDate);
      if (outside) {
        throw new BadRequestException(
          leaveError(
            400,
            'LEAVE_OUTSIDE_ASSIGNMENT',
            `${formatDate(date)} is outside the assignment's dates.`,
            {
              date: formatDate(date),
            },
          ),
        );
      }
      if (
        !policy ||
        !policy.eligible ||
        date < addDays(assignment.startDate, policy.waitingPeriodDays)
      ) {
        throw new BadRequestException(
          leaveError(
            400,
            'LEAVE_NOT_ELIGIBLE',
            `The assignment is not eligible for this leave type on ${formatDate(date)}.`,
            {
              date: formatDate(date),
            },
          ),
        );
      }
      if (partial && !policy.allowPartialDay) {
        throw new BadRequestException(
          leaveError(
            400,
            'LEAVE_PARTIAL_DAY_NOT_ALLOWED',
            'This leave policy only allows full days.',
          ),
        );
      }
      policyByDate.set(formatDate(date), policy);
    }
    // A request belongs to exactly one leave year, so its balance is checked against the
    // right year's entitlement (see leaveYearBalanceCheck); longer leave is split by year.
    const startPolicy = policyByDate.get(formatDate(from))!;
    if (
      leaveYearStartOf(to, startPolicy).getTime() !==
      leaveYearStartOf(from, startPolicy).getTime()
    ) {
      const boundary = leaveYearStartOf(to, startPolicy);
      throw new BadRequestException(
        leaveError(
          400,
          'LEAVE_REQUEST_SPANS_LEAVE_YEARS',
          `The leave crosses the start of a new leave year on ${formatDate(boundary)}; submit one request per leave year.`,
          { leaveYearStart: formatDate(boundary) },
        ),
      );
    }
    const holidays = new Map(
      (
        await this.holidays.applicableHolidays(client, context.target, from, to)
      ).map((h) => [formatDate(h.date), h.name]),
    );
    const scheduleDriven = [...policyByDate.values()].some(
      (p) => p.amountSource === 'SCHEDULE_THEN_STANDARD',
    );
    const scheduleDates = scheduleDriven
      ? await this.schedules.publishedScheduleDates(
          { employmentAssignmentId: assignment.id, from, to },
          client,
        )
      : new Set<string>();
    const expectedWork =
      scheduleDates.size > 0
        ? await this.expectedWork(
            client,
            assignment.employeeId,
            assignment.id,
            from,
            to,
            timezone,
          )
        : [];
    const days = sizeLeaveDays({
      dates,
      timezone,
      partial,
      policyFor: (date) => policyByDate.get(formatDate(date))!,
      holidays,
      scheduleDates,
      expectedWork,
    });
    return {
      from,
      to,
      timezone,
      partial,
      days,
      startPolicy,
      /** The policy for this assignment and type on any date (for leave-year projections). */
      policyAt: (date: Date) => resolveLeavePolicy(policies, subject, date),
    };
  }

  /** Published expected work around [from, to], read in Scheduling's bounded chunks. */
  private async expectedWork(
    client: LeaveClient,
    employeeId: string,
    employmentAssignmentId: string,
    from: Date,
    to: Date,
    timezone: string,
  ): Promise<PublishedExpectedWorkFact[]> {
    const facts: PublishedExpectedWorkFact[] = [];
    for (
      let chunk = addDays(from, -1);
      chunk <= addDays(to, 1);
      chunk = addDays(chunk, EXPECTED_WORK_CHUNK_DAYS)
    ) {
      const chunkEnd = minDate(
        addDays(chunk, EXPECTED_WORK_CHUNK_DAYS),
        addDays(to, 2),
      );
      facts.push(
        ...(await this.schedules.publishedExpectedWork(
          {
            employeeId,
            employmentAssignmentId,
            start: localDayStart(chunk, timezone).toISOString(),
            end: localDayStart(chunkEnd, timezone).toISOString(),
          },
          client,
        )),
      );
    }
    const unique = new Map(facts.map((f) => [f.scheduledShiftId, f]));
    return [...unique.values()];
  }

  // ─── Guards ────────────────────────────────────────────────────────────────

  private async selfAssignment(
    userId: string,
    assignmentId: string,
    client: LeaveClient,
  ) {
    const self = await this.access.selfEmployee(userId, client);
    const context = await this.access.assignmentContext(assignmentId, client);
    if (context.assignment.employeeId !== self.id) {
      throw new NotFoundException('Employment assignment not found');
    }
    const grants = await this.access.grants(userId, client);
    if (!this.access.can(grants, 'leave.request', context.target)) {
      throw new ForbiddenException(
        'Missing permission leave.request for the assignment.',
      );
    }
    await this.access.requireEnabled(context.target.organizationId, client);
    return context;
  }

  private async leaveTypeFor(
    client: LeaveClient,
    context: AssignmentContext,
    leaveTypeId: string,
  ) {
    const type = await client.leaveType.findUnique({
      where: { id: leaveTypeId },
    });
    if (
      !type ||
      type.organizationId !== context.assignment.position.organizationId
    ) {
      throw new NotFoundException(
        'Leave type not found for the assignment organization',
      );
    }
    if (type.archivedAt) {
      throw new BadRequestException(
        leaveError(400, 'LEAVE_TYPE_ARCHIVED', 'The leave type is archived.'),
      );
    }
    return type;
  }

  private async policyAt(
    client: LeaveClient,
    context: AssignmentContext,
    leaveTypeId: string,
    date: Date,
  ) {
    return this.config.resolveFor(
      {
        employmentAssignmentId: context.assignment.id,
        employmentType: context.assignment.employmentType,
        target: context.target,
      },
      leaveTypeId,
      date,
      client,
    );
  }

  /** Active (pending/approved, uncancelled) days of the same assignment never overlap. */
  private async assertNoOverlap(
    tx: Tx,
    assignmentId: string,
    days: readonly SizedLeaveDay[],
    excludeRequestId: string | null,
  ) {
    const dates = days.map((d) => d.date);
    const existing = await tx.leaveRequestDay.findMany({
      where: {
        date: { in: dates },
        cancelledByAmendmentId: null,
        request: {
          employmentAssignmentId: assignmentId,
          status: { in: ['PENDING', 'APPROVED'] },
          ...(excludeRequestId ? { id: { not: excludeRequestId } } : {}),
        },
      },
      select: {
        requestId: true,
        date: true,
        windowStart: true,
        windowEnd: true,
      },
    });
    const clashes = existing.filter((other) =>
      days.some((day) => windowsOverlap(day, other)),
    );
    if (clashes.length > 0) {
      throw new ConflictException(
        leaveError(
          409,
          'LEAVE_REQUEST_OVERLAP',
          'The leave overlaps another pending or approved leave of this assignment.',
          {
            conflictingRequestIds: [
              ...new Set(clashes.map((c) => c.requestId)),
            ],
            dates: [...new Set(clashes.map((c) => formatDate(c.date)))],
          },
        ),
      );
    }
  }

  /**
   * Leave may not change on dates inside a locked time period. For balance-tracking types it
   * also may not change before the entitlement window: year-end settlement (forfeiture,
   * expiry, caps) only revisits that window, so an older change could leave a closed year
   * unsettled. Older corrections are made by a manual adjustment.
   */
  private async assertNotLocked(
    tx: Tx,
    context: AssignmentContext,
    dates: readonly Date[],
    tracksBalance: boolean,
  ) {
    if (tracksBalance && dates.length > 0) {
      const earliest = addDays(
        localDateOf(this.now(), context.timezone()),
        -DEFAULT_ENTITLEMENT_LOOKBACK_DAYS,
      );
      const tooOld = dates.filter((date) => date < earliest);
      if (tooOld.length > 0) {
        throw new ConflictException(
          leaveError(
            409,
            'LEAVE_OUTSIDE_ENTITLEMENT_WINDOW',
            `Leave of a balance-tracking type cannot change before ${formatDate(earliest)}; correct older balances with a manual adjustment.`,
            {
              earliestDate: formatDate(earliest),
              dates: tooOld.map(formatDate),
            },
          ),
        );
      }
    }
    const employeeId = context.assignment.employeeId;
    const locked =
      (
        await this.integration.lockedDates(
          tx,
          {
            organizationId: context.assignment.position.organizationId,
            employeeDates: new Map([[employeeId, dates]]),
          },
          { lock: true },
        )
      ).get(employeeId) ?? new Set<string>();
    if (locked.size > 0) {
      throw new ConflictException(
        leaveError(
          409,
          'LEAVE_PERIOD_LOCKED',
          'Leave cannot change on dates inside a locked time period.',
          {
            dates: [...locked].sort(),
          },
        ),
      );
    }
  }

  /** Leave-year-aware balance check of sized days against the account's posted ledger. */
  private async balanceCheck(
    client: LeaveClient,
    accountId: string | null,
    sizing: Pick<SizedRequest, 'days' | 'timezone' | 'policyAt'>,
  ) {
    const entries = accountId
      ? await client.leaveLedgerEntry.findMany({
          where: { accountId },
          select: {
            amountMinutes: true,
            effectiveDate: true,
            leaveRequestDayId: true,
            idempotencyKey: true,
            entryType: true,
            sourceType: true,
          },
        })
      : [];
    return leaveYearBalanceCheck({
      accountId: accountId ?? '',
      entries,
      candidate: sizing.days
        .filter((day) => day.minutes > 0)
        .map((day) => ({
          amountMinutes: -day.minutes,
          effectiveDate: day.date,
          leaveRequestDayId: 'candidate',
        })),
      today: localDateOf(this.now(), sizing.timezone),
      policyAt: sizing.policyAt,
    });
  }

  private async assertBalance(
    tx: Tx,
    accountId: string,
    sizing: Pick<SizedRequest, 'days' | 'timezone' | 'policyAt'>,
  ) {
    const check = await this.balanceCheck(tx, accountId, sizing);
    if (!check.sufficient) {
      throw new ConflictException(
        leaveError(
          409,
          'LEAVE_INSUFFICIENT_BALANCE',
          'The leave exceeds the balance available for its leave year under the policy.',
          {
            leaveYearStart: formatDate(check.leaveYear.start),
            leaveYearEnd: formatDate(check.leaveYear.end),
            availableMinutes: check.availableMinutes,
            requestedMinutes: sizing.days.reduce(
              (sum, day) => sum + day.minutes,
              0,
            ),
            negativeBalanceLimitMinutes: check.negativeBalanceLimitMinutes,
            shortLeaveYearStart:
              check.shortLeaveYear && formatDate(check.shortLeaveYear.start),
          },
        ),
      );
    }
  }

  /** leave.approve on the assignment and never one's own leave. */
  private async assertDecider(
    tx: Tx,
    actor: string,
    context: AssignmentContext,
  ) {
    const grants = await this.access.grants(actor, tx);
    if (!this.access.can(grants, 'leave.approve', context.target)) {
      // Phase 19: a caller without any Leave grant in the request's organization gets the
      // same 404 as for a missing id (no cross-organization existence oracle); in-organization
      // approvers outside the scope keep the 403.
      if (
        !(await this.access.grantedInOrganization(
          grants,
          LEAVE_PERMISSIONS,
          context.target.organizationId,
          tx,
        ))
      )
        throw new NotFoundException('Leave request not found');
      throw new ForbiddenException(
        'Missing permission leave.approve for the assignment.',
      );
    }
    await this.assertNotSelf(tx, actor, context.assignment.employeeId);
    await this.access.requireEnabled(context.target.organizationId, tx);
  }

  private async assertNotSelf(tx: Tx, actor: string, employeeId: string) {
    if ((await this.access.employeeIdOfUser(actor, tx)) === employeeId) {
      throw new ForbiddenException(
        leaveError(
          403,
          'LEAVE_SELF_APPROVAL',
          'You cannot decide or record your own leave.',
        ),
      );
    }
  }

  // ─── Locking ───────────────────────────────────────────────────────────────

  private lockAssignment(tx: Tx, assignmentId: string) {
    return this.ledger.lockAssignment(tx, assignmentId);
  }

  /** Assignment → account → request, then a fresh read of the request and its days. */
  private async lockRequest(
    tx: Tx,
    found: { id: string; employmentAssignmentId: string; accountId: string },
  ) {
    await this.lockAssignment(tx, found.employmentAssignmentId);
    await this.ledger.lockAccount(tx, found.accountId);
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "LeaveRequest" WHERE "id" = ${found.id}::uuid FOR UPDATE`,
    );
    const request = await tx.leaveRequest.findUniqueOrThrow({
      where: { id: found.id },
    });
    const days = await tx.leaveRequestDay.findMany({
      where: { requestId: found.id },
      orderBy: { date: 'asc' },
    });
    const assignmentContext = await this.access.assignmentContext(
      found.employmentAssignmentId,
      tx,
    );
    return { request, days, assignmentContext };
  }

  // ─── Shapes / writes ───────────────────────────────────────────────────────

  private dayRow(
    requestId: string,
    day: SizedLeaveDay,
  ): Prisma.LeaveRequestDayCreateManyInput {
    return {
      requestId,
      date: day.date,
      minutes: day.minutes,
      amountSource: day.amountSource,
      windowStart: day.windowStart,
      windowEnd: day.windowEnd,
      absenceStart: day.absenceStart,
      absenceEnd: day.absenceEnd,
      scheduledShiftRevisionIds: day.scheduledShiftRevisionIds,
      holidayName: day.holidayName,
      overrideReason: day.overrideReason,
    };
  }

  dayShape(day: SizedLeaveDay | LeaveRequestDay) {
    return {
      date: formatDate(day.date),
      minutes: day.minutes,
      amountSource: day.amountSource,
      windowStart: day.windowStart.toISOString(),
      windowEnd: day.windowEnd.toISOString(),
      absenceStart: day.absenceStart.toISOString(),
      absenceEnd: day.absenceEnd.toISOString(),
      scheduledShiftRevisionIds: day.scheduledShiftRevisionIds,
      holidayName: day.holidayName,
      overrideReason: day.overrideReason,
      cancelled:
        'cancelledByAmendmentId' in day
          ? day.cancelledByAmendmentId !== null
          : false,
    };
  }

  private async userOfEmployee(tx: Tx, employeeId: string) {
    const employee = await tx.employee.findUnique({
      where: { id: employeeId },
      select: { person: { select: { user: { select: { id: true } } } } },
    });
    return employee?.person?.user?.id ?? null;
  }

  private event(
    tx: Tx,
    requestId: string,
    type: 'SUBMITTED' | 'APPROVED' | 'REJECTED' | 'CANCELLED' | 'AMENDED',
    actorUserId: string,
    note: string | null | undefined,
    metadata?: Record<string, unknown>,
  ) {
    return tx.leaveRequestEvent.create({
      data: {
        requestId,
        type,
        actorUserId,
        note: note ?? null,
        ...(metadata ? { metadata: jsonValue(metadata) } : {}),
      },
    });
  }

  private writeAudit(
    tx: Tx,
    action: string,
    entityId: string,
    context: LeaveRequestContext,
    metadata: Record<string, unknown>,
  ) {
    return this.audit.write(
      {
        action,
        actorUserId: context.actorUserId,
        entityType: 'LeaveRequest',
        entityId,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
        correlationId: context.correlationId,
        metadata: jsonValue(metadata),
      },
      tx,
    );
  }
}
