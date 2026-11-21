import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import {
  domainError,
  formatDate,
  jsonValue,
  localDateOf,
  parseDateOnly,
  requireActor,
  type DomainClient,
  type DomainRequestContext,
} from '../common/domain-support.js';
import { PrismaService } from '../database/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import type {
  CompensationRecord,
  PayGroup,
} from '../generated/prisma/client.js';
import { CompensationAccessService } from './compensation-access.service.js';
import {
  assertNoOverlap,
  assertSalaryArrangementPeriod,
  assertWithinAssignment,
  formatRateAmount,
  parseSalaryArrangement,
  parseCurrency,
  parsePayBasis,
  parseRateAmount,
  planChange,
  recordEffectiveOn,
} from './compensation-domain.js';
import type {
  ChangeCompensationDto,
  CorrectCompensationDto,
  CreateCompensationDto,
  EndCompensationDto,
} from './compensation.dto.js';

type Tx = Prisma.TransactionClient;
type RecordWithGroup = CompensationRecord & { payGroup: PayGroup | null };
type AssignmentContext = Awaited<
  ReturnType<CompensationAccessService['assignmentContext']>
>;

/**
 * Phase 9 — effective-dated compensation of an EmploymentAssignment.
 *
 * Every timeline write runs in one transaction that first locks the assignment row (FOR NO KEY
 * UPDATE: the same first lock as Leave, Scheduling and Time, so writers of one assignment
 * serialize), then loads the timeline, validates assignment bounds and overlaps, closes or
 * supersedes prior records, inserts the new record and writes the audit entry. The database
 * re-checks the same invariants (triggers), and history is never deleted or rewritten.
 */
@Injectable()
export class CompensationService {
  /** The clock for "today" (current compensation); tests replace it. */
  now: () => Date = () => new Date();

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: CompensationAccessService,
    private readonly audit: AuditService,
  ) {}

  // ─── Writes ────────────────────────────────────────────────────────────────

  /** The first period of a timeline, or one filling a gap. Never overlaps existing records. */
  /**
   * `client` runs the write in the caller's transaction (Phase 13 hire conversion initializes
   * the new assignment's compensation with the same rules, locks and authorization).
   */
  async create(
    assignmentId: string,
    input: CreateCompensationDto,
    context: DomainRequestContext,
    client?: Tx,
  ) {
    const actor = requireActor(context);
    const values = this.values(input);
    const effectiveFrom = parseDateOnly(input.effectiveFrom, 'effectiveFrom');
    const effectiveTo = input.effectiveTo
      ? parseDateOnly(input.effectiveTo, 'effectiveTo')
      : null;
    const operation = async (tx: Tx) => {
      const { assignment } = await this.lockedForManage(
        tx,
        actor,
        assignmentId,
      );
      const period = { effectiveFrom, effectiveTo };
      assertWithinAssignment(assignment, period);
      assertSalaryArrangementPeriod(values.salary, period);
      const timeline = await this.timeline(tx, assignmentId);
      assertNoOverlap(timeline, period);
      const payGroupId = await this.payGroupFor(
        tx,
        assignment.position.organizationId,
        values.payGroupId,
      );
      const created = await tx.compensationRecord.create({
        data: {
          employmentAssignmentId: assignmentId,
          organizationId: assignment.position.organizationId,
          recordType: 'INITIAL',
          payBasis: values.payBasis,
          rateAmount: values.rate.decimal,
          ...this.salaryData(values.salary),
          currency: values.currency,
          effectiveFrom,
          effectiveTo,
          payGroupId,
          reason: input.reason?.trim() || null,
          createdByUserId: actor,
        },
        include: { payGroup: true },
      });
      await this.writeAudit(tx, 'COMPENSATION_CREATED', created.id, context, {
        employmentAssignmentId: assignmentId,
        after: this.auditState(created),
        reason: created.reason,
      });
      return this.recordShape(created);
    };
    return client ? operation(client) : this.prisma.$transaction(operation);
  }

  /**
   * A real-world change (raise, salary change, hourly ↔ salary, pay group move) effective from a
   * date, possibly in the past (retroactive) or future (scheduled). The record in effect that
   * day is closed the day before and the new period follows it, up to where it would have ended.
   */
  async change(
    assignmentId: string,
    input: ChangeCompensationDto,
    context: DomainRequestContext,
  ) {
    const actor = requireActor(context);
    const values = this.values(input);
    const effectiveFrom = parseDateOnly(input.effectiveFrom, 'effectiveFrom');
    return this.prisma.$transaction(async (tx) => {
      const { assignment } = await this.lockedForManage(
        tx,
        actor,
        assignmentId,
      );
      // The change date itself must fall inside the assignment (an ended assignment takes nothing
      // after its end, even while its last record is open-ended).
      assertWithinAssignment(assignment, {
        effectiveFrom,
        effectiveTo: effectiveFrom,
      });
      const timeline = await this.timeline(tx, assignmentId);
      // A contracted salary's new period is its paid period, not the closed record's remainder.
      const plan = planChange(
        timeline,
        effectiveFrom,
        values.salary.salaryArrangement === 'FIXED_PERIOD' ||
          values.salary.salaryArrangement === 'CONTRACT_TOTAL'
          ? values.salary.salaryPeriodEnd
          : null,
      );
      assertWithinAssignment(assignment, plan.period);
      assertSalaryArrangementPeriod(values.salary, plan.period);
      const payGroupId = await this.payGroupFor(
        tx,
        assignment.position.organizationId,
        values.payGroupId === undefined
          ? plan.previous.payGroupId
          : values.payGroupId,
        plan.previous.payGroupId,
      );
      const previous = plan.previous;
      if (
        previous.payBasis === values.payBasis &&
        formatRateAmount(previous.rateAmount) === values.rate.canonical &&
        previous.currency === values.currency &&
        previous.payGroupId === payGroupId &&
        this.sameSalaryArrangement(previous, values.salary)
      ) {
        throw new BadRequestException(
          domainError(
            400,
            'COMPENSATION_CHANGE_UNCHANGED',
            'The change is identical to the compensation in effect.',
          ),
        );
      }
      await this.recordClosure(tx, previous, plan.previousNewEnd, actor);
      const closed = await tx.compensationRecord.update({
        where: { id: previous.id },
        data: { effectiveTo: plan.previousNewEnd },
        include: { payGroup: true },
      });
      const created = await tx.compensationRecord.create({
        data: {
          employmentAssignmentId: assignmentId,
          organizationId: assignment.position.organizationId,
          recordType: 'CHANGE',
          payBasis: values.payBasis,
          rateAmount: values.rate.decimal,
          ...this.salaryData(values.salary),
          currency: values.currency,
          effectiveFrom: plan.period.effectiveFrom,
          effectiveTo: plan.period.effectiveTo,
          payGroupId,
          reason: input.reason?.trim() || null,
          createdByUserId: actor,
        },
        include: { payGroup: true },
      });
      await this.writeAudit(tx, 'COMPENSATION_CHANGED', created.id, context, {
        employmentAssignmentId: assignmentId,
        previousRecordId: previous.id,
        previousEffectiveTo: {
          before: previous.effectiveTo && formatDate(previous.effectiveTo),
          after: formatDate(plan.previousNewEnd),
        },
        before: this.auditState(previous),
        after: this.auditState(created),
        reason: created.reason,
      });
      return {
        record: this.recordShape(created),
        previous: this.recordShape(closed),
      };
    });
  }

  /**
   * Fixes mis-entered information. The record is never edited: it is marked superseded and a
   * CORRECTION record replacing it (any field, its dates included) joins the timeline, with a
   * required reason and before/after audit. Works the same for past, current and future records.
   */
  async correct(
    assignmentId: string,
    recordId: string,
    input: CorrectCompensationDto,
    context: DomainRequestContext,
  ) {
    const actor = requireActor(context);
    const reason = input.reason.trim();
    if (!reason) {
      throw new BadRequestException(
        domainError(
          400,
          'COMPENSATION_REASON_REQUIRED',
          'A correction needs a reason.',
        ),
      );
    }
    return this.prisma.$transaction(async (tx) => {
      const { assignment } = await this.lockedForManage(
        tx,
        actor,
        assignmentId,
      );
      const original = await this.activeRecord(tx, assignmentId, recordId);
      const values = this.values(input, original);
      const effectiveFrom = input.effectiveFrom
        ? parseDateOnly(input.effectiveFrom, 'effectiveFrom')
        : original.effectiveFrom;
      const effectiveTo =
        input.effectiveTo === undefined
          ? original.effectiveTo
          : input.effectiveTo === null
            ? null
            : parseDateOnly(input.effectiveTo, 'effectiveTo');
      const period = { effectiveFrom, effectiveTo };
      assertWithinAssignment(assignment, period);
      assertSalaryArrangementPeriod(values.salary, period);
      assertNoOverlap(
        await this.timeline(tx, assignmentId),
        period,
        original.id,
      );
      const payGroupId = await this.payGroupFor(
        tx,
        assignment.position.organizationId,
        input.payGroupId === undefined ? original.payGroupId : input.payGroupId,
        original.payGroupId,
      );
      if (
        values.payBasis === original.payBasis &&
        formatRateAmount(values.rate.decimal) ===
          formatRateAmount(original.rateAmount) &&
        values.currency === original.currency &&
        payGroupId === original.payGroupId &&
        this.sameSalaryArrangement(original, values.salary) &&
        effectiveFrom.getTime() === original.effectiveFrom.getTime() &&
        (effectiveTo?.getTime() ?? null) ===
          (original.effectiveTo?.getTime() ?? null)
      ) {
        throw new BadRequestException(
          domainError(
            400,
            'COMPENSATION_CORRECTION_UNCHANGED',
            'The correction changes nothing.',
          ),
        );
      }
      await tx.compensationRecord.update({
        where: { id: original.id },
        data: { supersededAt: new Date() },
      });
      const replacement = await tx.compensationRecord.create({
        data: {
          employmentAssignmentId: assignmentId,
          organizationId: assignment.position.organizationId,
          recordType: 'CORRECTION',
          payBasis: values.payBasis,
          rateAmount: values.rate.decimal,
          ...this.salaryData(values.salary),
          currency: values.currency,
          effectiveFrom,
          effectiveTo,
          payGroupId,
          supersedesRecordId: original.id,
          reason,
          createdByUserId: actor,
        },
        include: { payGroup: true },
      });
      await this.writeAudit(
        tx,
        'COMPENSATION_CORRECTED',
        replacement.id,
        context,
        {
          employmentAssignmentId: assignmentId,
          correctedRecordId: original.id,
          replacementRecordId: replacement.id,
          before: this.auditState(original),
          after: this.auditState(replacement),
          reason,
        },
      );
      return this.recordShape(replacement);
    });
  }

  /** Ends a period earlier (leaving a gap after it). Only ever shortens; reopening is a correction. */
  async end(
    assignmentId: string,
    recordId: string,
    input: EndCompensationDto,
    context: DomainRequestContext,
  ) {
    const actor = requireActor(context);
    const effectiveTo = parseDateOnly(input.effectiveTo, 'effectiveTo');
    return this.prisma.$transaction(async (tx) => {
      await this.lockedForManage(tx, actor, assignmentId);
      const record = await this.activeRecord(tx, assignmentId, recordId);
      if (effectiveTo < record.effectiveFrom) {
        throw new BadRequestException(
          domainError(
            400,
            'COMPENSATION_PERIOD_INVALID',
            'effectiveTo must be on or after the record’s effectiveFrom.',
          ),
        );
      }
      if (record.effectiveTo && effectiveTo >= record.effectiveTo) {
        throw new ConflictException(
          domainError(
            409,
            'COMPENSATION_END_NOT_EARLIER',
            'Ending only moves a period’s end earlier; correct the record to extend it.',
          ),
        );
      }
      await this.recordClosure(tx, record, effectiveTo, actor);
      const ended = await tx.compensationRecord.update({
        where: { id: record.id },
        data: { effectiveTo },
        include: { payGroup: true },
      });
      await this.writeAudit(tx, 'COMPENSATION_ENDED', record.id, context, {
        employmentAssignmentId: assignmentId,
        effectiveTo: {
          before: record.effectiveTo && formatDate(record.effectiveTo),
          after: formatDate(effectiveTo),
        },
        reason: input.reason?.trim() || null,
      });
      return this.recordShape(ended);
    });
  }

  // ─── Reads ─────────────────────────────────────────────────────────────────

  /** The assignment's timeline, corrections history, current record and backend actions. */
  async history(userId: string, assignmentId: string) {
    const access = await this.access.requireRead(userId, assignmentId);
    return this.assignmentView(access);
  }

  async current(userId: string, assignmentId: string, date?: string) {
    const access = await this.access.requireRead(userId, assignmentId);
    const asOf = date ? parseDateOnly(date, 'date') : this.today(access);
    const timeline = await this.timeline(this.prisma, assignmentId);
    const record = this.inAssignment(access.assignment, asOf)
      ? recordEffectiveOn(timeline, asOf)
      : null;
    return {
      employmentAssignmentId: assignmentId,
      date: formatDate(asOf),
      record: record && this.recordShape(record),
    };
  }

  async asOf(userId: string, assignmentId: string, date: string) {
    return this.current(userId, assignmentId, date);
  }

  /**
   * An employee's compensation for the employee profile: every assignment whose compensation the
   * reader may see (compensation.read in scope, or their own). Nothing else about the employee is
   * returned, and employee.read alone never reaches this.
   */
  async employee(userId: string, employeeId: string) {
    const assignments = await this.prisma.employmentAssignment.findMany({
      where: { employeeId, status: { not: 'CANCELLED' } },
      select: { id: true },
      orderBy: [{ isPrimary: 'desc' }, { startDate: 'desc' }, { id: 'asc' }],
    });
    const views = [];
    let disabled: ForbiddenException | null = null;
    for (const assignment of assignments) {
      try {
        views.push(
          await this.assignmentView(
            await this.access.requireRead(userId, assignment.id),
          ),
        );
      } catch (error) {
        if (!(error instanceof ForbiddenException)) throw error;
        // Phase 18: organizations with Compensation disabled are left out.
        if (
          (error.getResponse() as { code?: string })?.code ===
          'FEATURE_DISABLED'
        )
          disabled = error;
      }
    }
    if (views.length === 0) {
      if (disabled) throw disabled;
      throw new ForbiddenException(
        'Missing permission compensation.read for the employee.',
      );
    }
    return { employeeId, assignments: views };
  }

  /** The signed-in employee's own compensation, read-only. */
  async me(userId: string) {
    const employeeId = await this.access.employeeIdOfUser(userId);
    if (!employeeId)
      throw new ForbiddenException('Authenticated user is not an employee.');
    const all = await this.prisma.employmentAssignment.findMany({
      where: { employeeId, status: { not: 'CANCELLED' } },
      select: { id: true, position: { select: { organizationId: true } } },
      orderBy: [{ isPrimary: 'desc' }, { startDate: 'desc' }, { id: 'asc' }],
    });
    // Phase 18: organizations with Compensation disabled are left out.
    const disabled = new Set(await this.access.disabledOrganizations());
    const assignments = all.filter(
      (row) => !disabled.has(row.position.organizationId),
    );
    if (all.length > 0 && assignments.length === 0)
      await this.access.requireEnabled(all[0]!.position.organizationId);
    const views = [];
    for (const assignment of assignments) {
      views.push(
        await this.assignmentView(
          await this.access.requireRead(userId, assignment.id),
        ),
      );
    }
    return { employeeId, assignments: views };
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private async assignmentView(
    access: Awaited<ReturnType<CompensationAccessService['requireRead']>>,
  ) {
    const { assignment, timezone, canManage } = access;
    const records = await this.prisma.compensationRecord.findMany({
      where: { employmentAssignmentId: assignment.id },
      include: { payGroup: true },
      orderBy: [{ effectiveFrom: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    });
    const timeline = records.filter((r) => r.supersededAt === null);
    const asOf = timezone ? localDateOf(this.now(), timezone) : null;
    const current =
      asOf && this.inAssignment(assignment, asOf)
        ? recordEffectiveOn(timeline, asOf)
        : null;
    const writable = canManage && assignment.status !== 'CANCELLED';
    return {
      assignment: {
        id: assignment.id,
        status: assignment.status,
        employmentType: assignment.employmentType,
        isPrimary: assignment.isPrimary,
        startDate: formatDate(assignment.startDate),
        endDate: assignment.endDate && formatDate(assignment.endDate),
        employee: {
          id: assignment.employee.id,
          employeeNumber: assignment.employee.employeeNumber,
          displayName:
            [
              assignment.employee.person.preferredName ??
                assignment.employee.person.firstName,
              assignment.employee.person.lastName,
            ]
              .filter(Boolean)
              .join(' ') || null,
        },
        position: {
          id: assignment.position.id,
          name: assignment.position.name,
          code: assignment.position.code,
        },
        organization: {
          id: assignment.position.organization.id,
          name: assignment.position.organization.name,
          code: assignment.position.organization.code,
        },
      },
      /** The assignment-local date "current" refers to; null when its timezone is unknown. */
      asOf: asOf && formatDate(asOf),
      current: current && this.recordShape(current),
      timeline: timeline.map((record) => ({
        ...this.recordShape(record),
        actions: { canCorrect: writable, canEnd: writable },
      })),
      /** Records replaced by corrections, kept for history. */
      superseded: records
        .filter((r) => r.supersededAt !== null)
        .map((record) => this.recordShape(record)),
      actions: {
        canCreate: writable,
        canChange: writable && timeline.length > 0,
      },
    };
  }

  private inAssignment(
    assignment: { startDate: Date; endDate: Date | null; status: string },
    date: Date,
  ) {
    return (
      assignment.status !== 'CANCELLED' &&
      date >= assignment.startDate &&
      (assignment.endDate === null || date <= assignment.endDate)
    );
  }

  private today(access: { timezone: string | null }) {
    if (!access.timezone) {
      throw new BadRequestException(
        domainError(
          400,
          'COMPENSATION_TIMEZONE_UNRESOLVED',
          'The assignment has no timezone (work location or organization); pass an explicit date.',
        ),
      );
    }
    return localDateOf(this.now(), access.timezone);
  }

  private values(
    input: {
      payBasis?: unknown;
      rateAmount?: unknown;
      salaryArrangement?: unknown;
      salaryMonthlyAmount?: unknown;
      salaryPaidMonths?: unknown;
      salaryContractAmount?: unknown;
      salaryPeriodStart?: unknown;
      salaryPeriodEnd?: unknown;
      currency?: unknown;
      payGroupId?: string | null;
    },
    original?: CompensationRecord,
  ) {
    const payBasis =
      input.payBasis === undefined
        ? original?.payBasis
        : parsePayBasis(input.payBasis);
    if (!payBasis) {
      throw new BadRequestException('payBasis is required.');
    }
    const rate =
      input.rateAmount === undefined
        ? original
          ? {
              decimal: original.rateAmount,
              canonical: formatRateAmount(original.rateAmount),
            }
          : parseRateAmount(input.rateAmount)
        : parseRateAmount(input.rateAmount);
    const currency =
      input.currency === undefined
        ? original?.currency
        : parseCurrency(input.currency);
    if (!currency) {
      throw new BadRequestException('currency is required.');
    }
    const salaryInput =
      original && input.payBasis === undefined && !this.hasSalaryInput(input)
        ? this.salaryInput(original)
        : original && payBasis === original.payBasis
          ? { ...this.salaryInput(original), ...input }
          : input;
    return {
      payBasis,
      rate,
      salary: parseSalaryArrangement(payBasis, salaryInput),
      currency,
      payGroupId: input.payGroupId,
    };
  }

  private hasSalaryInput(input: {
    salaryArrangement?: unknown;
    salaryMonthlyAmount?: unknown;
    salaryPaidMonths?: unknown;
    salaryContractAmount?: unknown;
    salaryPeriodStart?: unknown;
    salaryPeriodEnd?: unknown;
  }) {
    return (
      input.salaryArrangement !== undefined ||
      input.salaryMonthlyAmount !== undefined ||
      input.salaryPaidMonths !== undefined ||
      input.salaryContractAmount !== undefined ||
      input.salaryPeriodStart !== undefined ||
      input.salaryPeriodEnd !== undefined
    );
  }

  private salaryInput(record: CompensationRecord): Record<string, unknown> {
    return {
      salaryArrangement: record.salaryArrangement,
      salaryMonthlyAmount:
        record.salaryMonthlyAmount &&
        formatRateAmount(record.salaryMonthlyAmount),
      salaryPaidMonths: record.salaryPaidMonths,
      salaryContractAmount:
        record.salaryContractAmount &&
        formatRateAmount(record.salaryContractAmount),
      salaryPeriodStart:
        record.salaryPeriodStart && formatDate(record.salaryPeriodStart),
      salaryPeriodEnd:
        record.salaryPeriodEnd && formatDate(record.salaryPeriodEnd),
    };
  }

  private salaryData(
    salary: ReturnType<typeof parseSalaryArrangement>,
  ): Pick<
    CompensationRecord,
    | 'salaryArrangement'
    | 'salaryMonthlyAmount'
    | 'salaryPaidMonths'
    | 'salaryContractAmount'
    | 'salaryPeriodStart'
    | 'salaryPeriodEnd'
  > {
    return salary;
  }

  private sameSalaryArrangement(
    record: CompensationRecord,
    salary: ReturnType<typeof parseSalaryArrangement>,
  ) {
    return (
      record.salaryArrangement === salary.salaryArrangement &&
      (record.salaryMonthlyAmount?.toFixed(4) ?? null) ===
        (salary.salaryMonthlyAmount?.toFixed(4) ?? null) &&
      record.salaryPaidMonths === salary.salaryPaidMonths &&
      (record.salaryContractAmount?.toFixed(4) ?? null) ===
        (salary.salaryContractAmount?.toFixed(4) ?? null) &&
      (record.salaryPeriodStart?.getTime() ?? null) ===
        (salary.salaryPeriodStart?.getTime() ?? null) &&
      (record.salaryPeriodEnd?.getTime() ?? null) ===
        (salary.salaryPeriodEnd?.getTime() ?? null)
    );
  }

  /**
   * Locks the assignment (first lock of the shared order), then checks compensation.manage and
   * that the actor is not managing their own pay.
   */
  private async lockedForManage(
    tx: Tx,
    actor: string,
    assignmentId: string,
  ): Promise<AssignmentContext> {
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "EmploymentAssignment" WHERE "id" = ${assignmentId}::uuid FOR NO KEY UPDATE`,
    );
    return this.access.requireManage(actor, assignmentId, tx);
  }

  /** Active (not superseded) records of the assignment in date order. */
  private timeline(
    client: DomainClient,
    assignmentId: string,
  ): Promise<RecordWithGroup[]> {
    return client.compensationRecord.findMany({
      where: { employmentAssignmentId: assignmentId, supersededAt: null },
      include: { payGroup: true },
      orderBy: [{ effectiveFrom: 'asc' }, { id: 'asc' }],
    });
  }

  private async activeRecord(tx: Tx, assignmentId: string, recordId: string) {
    const record = await tx.compensationRecord.findFirst({
      where: { id: recordId, employmentAssignmentId: assignmentId },
      include: { payGroup: true },
    });
    if (!record) throw new NotFoundException('Compensation record not found');
    if (record.supersededAt) {
      throw new ConflictException(
        domainError(
          409,
          'COMPENSATION_RECORD_SUPERSEDED',
          'This record was replaced by a correction; act on its replacement.',
        ),
      );
    }
    return record;
  }

  /**
   * A pay group of the assignment's organization. A newly chosen one must be active; keeping
   * the pay group a record already has is always allowed (it may since have been archived).
   */
  private async payGroupFor(
    tx: Tx,
    organizationId: string,
    payGroupId: string | null | undefined,
    existingPayGroupId: string | null = null,
  ): Promise<string | null> {
    if (!payGroupId) return null;
    const group = await tx.payGroup.findUnique({ where: { id: payGroupId } });
    if (!group || group.organizationId !== organizationId) {
      throw new BadRequestException(
        domainError(
          400,
          'COMPENSATION_PAY_GROUP_INVALID',
          'The pay group does not belong to the assignment’s organization.',
        ),
      );
    }
    if (group.archivedAt && group.id !== existingPayGroupId) {
      throw new ConflictException(
        domainError(
          409,
          'COMPENSATION_PAY_GROUP_ARCHIVED',
          'The pay group is archived.',
        ),
      );
    }
    return group.id;
  }

  recordShape(record: RecordWithGroup) {
    return {
      id: record.id,
      employmentAssignmentId: record.employmentAssignmentId,
      recordType: record.recordType,
      payBasis: record.payBasis,
      /** Decimal string ("24.5000"); interpretation follows payBasis/salaryArrangement. */
      rateAmount: formatRateAmount(record.rateAmount),
      salaryArrangement: record.salaryArrangement,
      salaryMonthlyAmount:
        record.salaryMonthlyAmount &&
        formatRateAmount(record.salaryMonthlyAmount),
      salaryPaidMonths: record.salaryPaidMonths,
      salaryContractAmount:
        record.salaryContractAmount &&
        formatRateAmount(record.salaryContractAmount),
      salaryPeriodStart:
        record.salaryPeriodStart && formatDate(record.salaryPeriodStart),
      salaryPeriodEnd:
        record.salaryPeriodEnd && formatDate(record.salaryPeriodEnd),
      currency: record.currency,
      effectiveFrom: formatDate(record.effectiveFrom),
      effectiveTo: record.effectiveTo && formatDate(record.effectiveTo),
      payGroup: record.payGroup
        ? {
            id: record.payGroup.id,
            code: record.payGroup.code,
            name: record.payGroup.name,
          }
        : null,
      reason: record.reason,
      supersedesRecordId: record.supersedesRecordId,
      supersededAt: record.supersededAt?.toISOString() ?? null,
      createdAt: record.createdAt.toISOString(),
    };
  }

  private auditState(record: CompensationRecord) {
    return {
      recordId: record.id,
      payBasis: record.payBasis,
      rateAmount: formatRateAmount(record.rateAmount),
      salaryArrangement: record.salaryArrangement,
      salaryMonthlyAmount:
        record.salaryMonthlyAmount &&
        formatRateAmount(record.salaryMonthlyAmount),
      salaryPaidMonths: record.salaryPaidMonths,
      salaryContractAmount:
        record.salaryContractAmount &&
        formatRateAmount(record.salaryContractAmount),
      salaryPeriodStart:
        record.salaryPeriodStart && formatDate(record.salaryPeriodStart),
      salaryPeriodEnd:
        record.salaryPeriodEnd && formatDate(record.salaryPeriodEnd),
      currency: record.currency,
      effectiveFrom: formatDate(record.effectiveFrom),
      effectiveTo: record.effectiveTo && formatDate(record.effectiveTo),
      payGroupId: record.payGroupId,
    };
  }

  /**
   * Security remediation M2 — the closure ledger: who shortened a record's end date. Written
   * before the record changes (the database refuses the change without it, same transaction),
   * so payroll approval can bar the person who closed compensation a run pays.
   */
  private async recordClosure(
    tx: Tx,
    record: Pick<
      CompensationRecord,
      'id' | 'employmentAssignmentId' | 'organizationId' | 'effectiveTo'
    >,
    newEffectiveTo: Date,
    actor: string,
  ) {
    if (record.effectiveTo?.getTime() === newEffectiveTo.getTime()) return;
    await tx.compensationRecordClosure.create({
      data: {
        compensationRecordId: record.id,
        employmentAssignmentId: record.employmentAssignmentId,
        organizationId: record.organizationId,
        previousEffectiveTo: record.effectiveTo,
        newEffectiveTo,
        closedByUserId: actor,
        source: 'APPLICATION',
      },
    });
  }

  private writeAudit(
    tx: Tx,
    action: string,
    entityId: string,
    context: DomainRequestContext,
    metadata: Record<string, unknown>,
  ) {
    return this.audit.write(
      {
        action,
        actorUserId: context.actorUserId,
        entityType: 'CompensationRecord',
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
