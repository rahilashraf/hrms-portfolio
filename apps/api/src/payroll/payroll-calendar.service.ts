import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import {
  addDays,
  domainError,
  formatDate,
  localDateOf,
  parseDateOnly,
} from '../common/domain-support.js';
import { PrismaService } from '../database/prisma.service.js';
import type {
  PayrollCalendar,
  PayrollPeriod,
  Prisma,
} from '../generated/prisma/client.js';
import {
  PAYROLL_TIME_SOURCE,
  type PayrollTimeSource,
} from '../time/time-integration.contracts.js';
import { PayrollAccessService } from './payroll-access.service.js';
import {
  assertCalendarSeries,
  periodsBetween,
  type PayrollCalendarRules,
} from './payroll-calendar.js';
import {
  assertPayGroupActive,
  lockPayGroup,
  PayrollClock,
  writePayrollAudit,
  type PayrollRequestContext,
} from './payroll-common.js';
import {
  assertCalendarEffectiveRange,
  assertCalendarRules,
  assertPayrollPeriodDates,
  parsePayrollTimezone,
} from './payroll-domain.js';
import type {
  CreatePayrollCalendarDto,
  EndPayrollCalendarDto,
  GeneratePayrollPeriodsDto,
  PayrollOrganizationQueryDto,
  PayrollPeriodListQueryDto,
  SalaryUnpaidLeaveRuleDto,
  UpdatePayrollCalendarDto,
} from './payroll.dto.js';

/** Generation never runs further ahead than this (a year and a bit). */
export const MAX_GENERATION_HORIZON_DAYS = 400;
/** Periods created by one generation call, at most. */
export const MAX_PERIODS_PER_GENERATION = 120;

type Tx = Prisma.TransactionClient;

/**
 * Phase 10 Batch 2 — payroll calendars (effective-dated pay-period rules of a pay group) and the
 * deterministic generation of their pay periods. Calendars of a pay group never overlap; a
 * calendar consists of whole periods of its series; once a calendar has generated a period its
 * rules are fixed (it can only be ended), and generated periods keep their own dates, pay date,
 * cutoff and timezone forever. Every write locks the pay group first (see payroll-common).
 *
 * Each period is created with the Time-owned TimePeriod of exactly its dates (Batch 3): Time
 * creates it in the same transaction, so a pay period never exists without its TimePeriod.
 */
@Injectable()
export class PayrollCalendarService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: PayrollAccessService,
    private readonly audit: AuditService,
    private readonly clock: PayrollClock,
    @Inject(PAYROLL_TIME_SOURCE) private readonly time: PayrollTimeSource,
  ) {}

  // ─── Reads ───────────────────────────────────────────────────────────────

  async payGroups(userId: string, organizationId: string) {
    await this.access.assert(userId, 'payroll.read', organizationId);
    const rows = await this.prisma.payGroup.findMany({
      where: { organizationId },
      include: {
        payrollCalendars: { orderBy: { effectiveFrom: 'asc' } },
        _count: { select: { payrollPeriods: true } },
      },
      orderBy: [{ archivedAt: 'asc' }, { name: 'asc' }, { code: 'asc' }],
    });
    const today = formatDate(this.clock.now());
    return {
      items: rows.map((row) => ({
        id: row.id,
        organizationId: row.organizationId,
        code: row.code,
        name: row.name,
        archived: row.archivedAt !== null,
        periodCount: row._count.payrollPeriods,
        currentCalendar:
          row.payrollCalendars
            .filter(
              (calendar) =>
                formatDate(calendar.effectiveFrom) <= today &&
                (!calendar.effectiveTo ||
                  formatDate(calendar.effectiveTo) >= today),
            )
            .map((calendar) => this.calendarShape(calendar, 0))[0] ?? null,
      })),
    };
  }

  /**
   * Batch 6A — who is paid through a pay group (for the off-cycle adjustment picker): every
   * assignment of the pay group's organization with a compensation record (not superseded) in
   * the pay group, with the currencies it is paid in. Read-only; payroll.read at the
   * organization, like the rest of payroll configuration.
   */
  async payGroupMembers(userId: string, payGroupId: string) {
    const payGroup = await this.prisma.payGroup.findUnique({
      where: { id: payGroupId },
      select: { id: true, organizationId: true },
    });
    if (!payGroup) throw new NotFoundException('Pay group not found.');
    await this.access.assert(userId, 'payroll.read', payGroup.organizationId);
    const records = await this.prisma.compensationRecord.findMany({
      where: {
        payGroupId: payGroup.id,
        supersededAt: null,
        employmentAssignment: {
          position: { organizationId: payGroup.organizationId },
        },
      },
      select: {
        currency: true,
        employmentAssignment: {
          select: {
            id: true,
            status: true,
            employeeId: true,
            position: { select: { name: true } },
            employee: {
              select: {
                employeeNumber: true,
                person: {
                  select: {
                    firstName: true,
                    lastName: true,
                    preferredName: true,
                  },
                },
              },
            },
          },
        },
      },
    });
    const members = new Map<
      string,
      {
        employmentAssignmentId: string;
        employeeId: string;
        employeeNumber: string;
        displayName: string;
        positionName: string;
        assignmentStatus: string;
        currencies: string[];
      }
    >();
    for (const record of records) {
      const assignment = record.employmentAssignment;
      const member = members.get(assignment.id);
      if (member) {
        if (!member.currencies.includes(record.currency))
          member.currencies.push(record.currency);
        continue;
      }
      const person = assignment.employee.person;
      members.set(assignment.id, {
        employmentAssignmentId: assignment.id,
        employeeId: assignment.employeeId,
        employeeNumber: assignment.employee.employeeNumber,
        displayName:
          [person.preferredName ?? person.firstName, person.lastName]
            .filter(Boolean)
            .join(' ') || assignment.employee.employeeNumber,
        positionName: assignment.position.name,
        assignmentStatus: assignment.status,
        currencies: [record.currency],
      });
    }
    return {
      items: [...members.values()]
        .map((member) => ({ ...member, currencies: member.currencies.sort() }))
        .sort(
          (a, b) =>
            a.displayName.localeCompare(b.displayName) ||
            a.employeeNumber.localeCompare(b.employeeNumber) ||
            a.positionName.localeCompare(b.positionName),
        ),
    };
  }

  async calendars(userId: string, query: PayrollOrganizationQueryDto) {
    await this.access.assert(userId, 'payroll.read', query.organizationId);
    const [rows, canManage] = await Promise.all([
      this.prisma.payrollCalendar.findMany({
        where: {
          organizationId: query.organizationId,
          ...(query.payGroupId ? { payGroupId: query.payGroupId } : {}),
        },
        include: {
          payGroup: { select: { code: true, name: true } },
          _count: { select: { periods: true } },
        },
        orderBy: [{ payGroupId: 'asc' }, { effectiveFrom: 'asc' }],
      }),
      this.access.can(userId, 'payroll.manage', query.organizationId),
    ]);
    return {
      items: rows.map((row) => ({
        ...this.calendarShape(row, row._count.periods),
        payGroup: row.payGroup,
        actions: {
          canUpdate: canManage && row._count.periods === 0,
          canEnd: canManage,
        },
      })),
    };
  }

  async periods(userId: string, query: PayrollPeriodListQueryDto) {
    await this.access.assert(userId, 'payroll.read', query.organizationId);
    const rows = await this.prisma.payrollPeriod.findMany({
      where: {
        organizationId: query.organizationId,
        ...(query.payGroupId ? { payGroupId: query.payGroupId } : {}),
        ...(query.from
          ? { periodEnd: { gte: parseDateOnly(query.from, 'from') } }
          : {}),
        ...(query.to
          ? { periodStart: { lte: parseDateOnly(query.to, 'to') } }
          : {}),
      },
      include: { payGroup: { select: { code: true, name: true } } },
      orderBy: [{ periodStart: 'desc' }, { payGroupId: 'asc' }],
      take: 500,
    });
    return {
      items: rows.map((row) => ({
        ...this.periodShape(row),
        payGroup: row.payGroup,
      })),
    };
  }

  // ─── Calendar writes ─────────────────────────────────────────────────────

  async createCalendar(
    dto: CreatePayrollCalendarDto,
    context: PayrollRequestContext,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const payGroup = await lockPayGroup(tx, dto.payGroupId);
      await this.access.assert(
        context.actorUserId,
        'payroll.manage',
        payGroup.organizationId,
        tx,
      );
      assertPayGroupActive(payGroup);
      const values = this.parseCalendar(dto);
      await this.assertNoCalendarOverlap(tx, dto.payGroupId, values, null);
      const calendar = await tx.payrollCalendar.create({
        data: {
          organizationId: payGroup.organizationId,
          payGroupId: dto.payGroupId,
          ...values,
        },
      });
      await writePayrollAudit(this.audit, tx, {
        action: 'PAYROLL_CALENDAR_CREATED',
        entityType: 'PayrollCalendar',
        entityId: calendar.id,
        context,
        metadata: this.calendarShape(calendar, 0),
      });
      return this.calendarShape(calendar, 0);
    });
  }

  /** Replaces the rules of a calendar that has generated no period (history stays untouched). */
  async updateCalendar(
    calendarId: string,
    dto: UpdatePayrollCalendarDto,
    context: PayrollRequestContext,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const existing = await this.calendarOrThrow(tx, calendarId);
      const payGroup = await lockPayGroup(tx, existing.payGroupId);
      await this.access.assert(
        context.actorUserId,
        'payroll.manage',
        payGroup.organizationId,
        tx,
      );
      assertPayGroupActive(payGroup);
      if (
        (await tx.payrollPeriod.count({
          where: { payrollCalendarId: calendarId },
        })) > 0
      ) {
        throw new ConflictException(
          domainError(
            409,
            'PAYROLL_CALENDAR_IN_USE',
            'This calendar has generated pay periods; its rules are fixed. End it and add a new calendar instead.',
          ),
        );
      }
      const values = this.parseCalendar(dto);
      await this.assertNoCalendarOverlap(
        tx,
        existing.payGroupId,
        values,
        calendarId,
      );
      const calendar = await tx.payrollCalendar.update({
        where: { id: calendarId },
        data: { ...values, effectiveTo: values.effectiveTo ?? null },
      });
      await writePayrollAudit(this.audit, tx, {
        action: 'PAYROLL_CALENDAR_UPDATED',
        entityType: 'PayrollCalendar',
        entityId: calendar.id,
        context,
        metadata: {
          before: this.calendarShape(existing, 0),
          after: this.calendarShape(calendar, 0),
        },
      });
      return this.calendarShape(calendar, 0);
    });
  }

  /** Sets the last day of a calendar: a period end, not before any period it generated. */
  async endCalendar(
    calendarId: string,
    dto: EndPayrollCalendarDto,
    context: PayrollRequestContext,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const existing = await this.calendarOrThrow(tx, calendarId);
      const payGroup = await lockPayGroup(tx, existing.payGroupId);
      await this.access.assert(
        context.actorUserId,
        'payroll.manage',
        payGroup.organizationId,
        tx,
      );
      const effectiveTo = parseDateOnly(dto.effectiveTo, 'effectiveTo');
      assertCalendarEffectiveRange(existing.effectiveFrom, effectiveTo);
      assertCalendarSeries(
        this.rulesOf(existing),
        existing.effectiveFrom,
        effectiveTo,
      );
      const last = await tx.payrollPeriod.findFirst({
        where: { payrollCalendarId: calendarId },
        orderBy: { periodEnd: 'desc' },
      });
      if (last && effectiveTo < last.periodEnd) {
        throw new ConflictException(
          domainError(
            409,
            'PAYROLL_CALENDAR_END_BEFORE_PERIODS',
            `Periods through ${formatDate(last.periodEnd)} already exist; the calendar cannot end earlier.`,
          ),
        );
      }
      await this.assertNoCalendarOverlap(
        tx,
        existing.payGroupId,
        { effectiveFrom: existing.effectiveFrom, effectiveTo },
        calendarId,
      );
      const calendar = await tx.payrollCalendar.update({
        where: { id: calendarId },
        data: { effectiveTo },
      });
      await writePayrollAudit(this.audit, tx, {
        action: 'PAYROLL_CALENDAR_ENDED',
        entityType: 'PayrollCalendar',
        entityId: calendar.id,
        context,
        metadata: {
          payGroupId: calendar.payGroupId,
          previousEffectiveTo: existing.effectiveTo
            ? formatDate(existing.effectiveTo)
            : null,
          effectiveTo: dto.effectiveTo,
        },
      });
      return this.calendarShape(calendar, 0);
    });
  }

  /**
   * How unpaid leave reduces salaries in this calendar's periods. Configuration, not history:
   * it may change while periods exist (each run snapshots the rule it was calculated with, so a
   * finalized run never changes).
   */
  async setSalaryUnpaidLeaveRule(
    calendarId: string,
    dto: SalaryUnpaidLeaveRuleDto,
    context: PayrollRequestContext,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const existing = await this.calendarOrThrow(tx, calendarId);
      const payGroup = await lockPayGroup(tx, existing.payGroupId);
      await this.access.assert(
        context.actorUserId,
        'payroll.manage',
        payGroup.organizationId,
        tx,
      );
      const hours =
        dto.rule === 'HOURLY_EQUIVALENT'
          ? (dto.standardAnnualHours ?? null)
          : null;
      if (
        dto.rule === 'HOURLY_EQUIVALENT' &&
        (!hours || Number(hours) < 1 || Number(hours) > 8784)
      ) {
        throw new BadRequestException(
          domainError(
            400,
            'PAYROLL_UNPAID_LEAVE_RULE_INVALID',
            'HOURLY_EQUIVALENT needs the standard annual hours of a salaried year (1 to 8784).',
          ),
        );
      }
      const calendar = await tx.payrollCalendar.update({
        where: { id: calendarId },
        data: {
          salaryUnpaidLeaveRule: dto.rule,
          salaryStandardAnnualHours: hours,
        },
      });
      await writePayrollAudit(this.audit, tx, {
        action: 'PAYROLL_CALENDAR_UNPAID_LEAVE_RULE_SET',
        entityType: 'PayrollCalendar',
        entityId: calendarId,
        context,
        metadata: {
          previousRule: existing.salaryUnpaidLeaveRule,
          previousStandardAnnualHours:
            existing.salaryStandardAnnualHours?.toFixed(2) ?? null,
          rule: dto.rule,
          standardAnnualHours: hours,
        },
      });
      return this.calendarShape(calendar, 0);
    });
  }

  // ─── Period generation ───────────────────────────────────────────────────

  async generatePeriods(
    dto: GeneratePayrollPeriodsDto,
    context: PayrollRequestContext,
  ) {
    const throughDate = parseDateOnly(dto.throughDate, 'throughDate');
    return this.prisma.$transaction(
      async (tx) => {
        const payGroup = await lockPayGroup(tx, dto.payGroupId);
        await this.access.assert(
          context.actorUserId,
          'payroll.manage',
          payGroup.organizationId,
          tx,
        );
        const created = await this.ensurePeriods(
          tx,
          dto.payGroupId,
          throughDate,
          context,
        );
        return { created: created.map((period) => this.periodShape(period)) };
      },
      { timeout: 60_000 },
    );
  }

  /**
   * Idempotently creates every period of the pay group's calendars starting on or before
   * `through`, in the caller's transaction, which must hold the pay-group lock. Existing
   * periods are never changed; one that disagrees with its calendar is reported, not rewritten.
   * Also opens UPCOMING periods that have started (in their own timezone).
   */
  async ensurePeriods(
    tx: Tx,
    payGroupId: string,
    through: Date,
    context: PayrollRequestContext,
  ): Promise<PayrollPeriod[]> {
    const payGroup = await lockPayGroup(tx, payGroupId);
    assertPayGroupActive(payGroup);
    const now = this.clock.now();
    const horizon = addDays(
      localDateOf(now, 'UTC'),
      MAX_GENERATION_HORIZON_DAYS,
    );
    if (through > horizon) {
      throw new BadRequestException(
        domainError(
          400,
          'PAYROLL_GENERATION_HORIZON',
          `Periods can be generated at most ${MAX_GENERATION_HORIZON_DAYS} days ahead.`,
        ),
      );
    }
    const calendars = await tx.payrollCalendar.findMany({
      where: { payGroupId, effectiveFrom: { lte: through } },
      orderBy: { effectiveFrom: 'asc' },
    });
    const existing = await tx.payrollPeriod.findMany({ where: { payGroupId } });
    const byStart = new Map(
      existing.map((period) => [formatDate(period.periodStart), period]),
    );
    const created: PayrollPeriod[] = [];
    for (const calendar of calendars) {
      const rules = this.rulesOf(calendar);
      // Continue after the calendar's last period (its series has no holes), so history never
      // counts against the per-call limit.
      const last = existing
        .filter((period) => period.payrollCalendarId === calendar.id)
        .reduce<Date | null>(
          (latest, period) =>
            !latest || period.periodEnd > latest ? period.periodEnd : latest,
          null,
        );
      const series = periodsBetween(rules, {
        from: last ? addDays(last, 1) : calendar.effectiveFrom,
        through,
        endBy: calendar.effectiveTo,
        limit: MAX_PERIODS_PER_GENERATION - created.length,
      });
      for (const generated of series) {
        const prior = byStart.get(formatDate(generated.periodStart));
        if (prior) {
          if (prior.periodEnd.getTime() !== generated.periodEnd.getTime()) {
            throw new ConflictException(
              domainError(
                409,
                'PAYROLL_PERIOD_CONFLICT',
                `An existing period starting ${formatDate(prior.periodStart)} ends ${formatDate(prior.periodEnd)}, not as its calendar now says; periods are never rewritten.`,
              ),
            );
          }
          continue;
        }
        const overlapping = existing.find(
          (period) =>
            period.periodStart <= generated.periodEnd &&
            period.periodEnd >= generated.periodStart,
        );
        if (overlapping) {
          throw new ConflictException(
            domainError(
              409,
              'PAYROLL_PERIOD_OVERLAP',
              `The period ${formatDate(generated.periodStart)}–${formatDate(generated.periodEnd)} would overlap ${formatDate(overlapping.periodStart)}–${formatDate(overlapping.periodEnd)}.`,
            ),
          );
        }
        assertPayrollPeriodDates({ ...generated, timezone: calendar.timezone });
        const started =
          generated.periodStart <= localDateOf(now, calendar.timezone);
        const { timePeriodId } = await this.time.ensureTimePeriod(
          tx,
          {
            organizationId: calendar.organizationId,
            startDate: formatDate(generated.periodStart),
            endDate: formatDate(generated.periodEnd),
            cadence: calendar.cadence,
            payrollPeriodId: null,
          },
          context,
        );
        const period = await tx.payrollPeriod.create({
          data: {
            organizationId: calendar.organizationId,
            payGroupId,
            payrollCalendarId: calendar.id,
            ...generated,
            timezone: calendar.timezone,
            status: started ? 'OPEN' : 'UPCOMING',
            timePeriodId,
          },
        });
        existing.push(period);
        byStart.set(formatDate(period.periodStart), period);
        created.push(period);
      }
    }
    await this.openStartedPeriods(tx, payGroupId, now);
    if (created.length > 0) {
      await writePayrollAudit(this.audit, tx, {
        action: 'PAYROLL_PERIODS_GENERATED',
        entityType: 'PayGroup',
        entityId: payGroupId,
        context,
        metadata: {
          payGroupId,
          count: created.length,
          throughDate: formatDate(through),
          first: formatDate(created[0]!.periodStart),
          last: formatDate(created[created.length - 1]!.periodEnd),
        },
      });
    }
    return created;
  }

  /** UPCOMING periods whose start date has arrived in their timezone become OPEN. */
  private async openStartedPeriods(tx: Tx, payGroupId: string, now: Date) {
    const upcoming = await tx.payrollPeriod.findMany({
      where: { payGroupId, status: 'UPCOMING' },
      select: { id: true, periodStart: true, timezone: true },
    });
    const started = upcoming.filter(
      (period) => period.periodStart <= localDateOf(now, period.timezone),
    );
    if (started.length > 0) {
      await tx.payrollPeriod.updateMany({
        where: {
          id: { in: started.map((period) => period.id) },
          status: 'UPCOMING',
        },
        data: { status: 'OPEN' },
      });
    }
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  private parseCalendar(
    dto: CreatePayrollCalendarDto | UpdatePayrollCalendarDto,
  ) {
    const timezone = parsePayrollTimezone(dto.timezone);
    const anchorDate = parseDateOnly(dto.anchorDate, 'anchorDate');
    const effectiveFrom = parseDateOnly(dto.effectiveFrom, 'effectiveFrom');
    const effectiveTo = dto.effectiveTo
      ? parseDateOnly(dto.effectiveTo, 'effectiveTo')
      : null;
    const rules: PayrollCalendarRules = {
      cadence: dto.cadence,
      anchorDate,
      payDateOffsetDays: dto.payDateOffsetDays,
      processingCutoffOffsetDays: dto.processingCutoffOffsetDays,
      timezone,
    };
    assertCalendarRules(rules);
    assertCalendarEffectiveRange(effectiveFrom, effectiveTo);
    assertCalendarSeries(rules, effectiveFrom, effectiveTo);
    return { ...rules, effectiveFrom, effectiveTo };
  }

  private async assertNoCalendarOverlap(
    tx: Tx,
    payGroupId: string,
    range: { effectiveFrom: Date; effectiveTo: Date | null },
    excludeId: string | null,
  ) {
    const overlapping = await tx.payrollCalendar.findFirst({
      where: {
        payGroupId,
        ...(excludeId ? { id: { not: excludeId } } : {}),
        ...(range.effectiveTo
          ? { effectiveFrom: { lte: range.effectiveTo } }
          : {}),
        OR: [
          { effectiveTo: null },
          { effectiveTo: { gte: range.effectiveFrom } },
        ],
      },
    });
    if (overlapping) {
      throw new ConflictException(
        domainError(
          409,
          'PAYROLL_CALENDAR_OVERLAP',
          `The pay group already has a calendar effective ${formatDate(overlapping.effectiveFrom)}${overlapping.effectiveTo ? ` to ${formatDate(overlapping.effectiveTo)}` : ' onward'}; end it first.`,
        ),
      );
    }
  }

  private async calendarOrThrow(tx: Tx, calendarId: string) {
    const calendar = await tx.payrollCalendar.findUnique({
      where: { id: calendarId },
    });
    if (!calendar) throw new NotFoundException('Payroll calendar not found.');
    return calendar;
  }

  rulesOf(calendar: PayrollCalendar): PayrollCalendarRules {
    return {
      cadence: calendar.cadence,
      anchorDate: calendar.anchorDate,
      payDateOffsetDays: calendar.payDateOffsetDays,
      processingCutoffOffsetDays: calendar.processingCutoffOffsetDays,
      timezone: calendar.timezone,
    };
  }

  calendarShape(calendar: PayrollCalendar, periodCount: number) {
    return {
      id: calendar.id,
      organizationId: calendar.organizationId,
      payGroupId: calendar.payGroupId,
      cadence: calendar.cadence,
      timezone: calendar.timezone,
      anchorDate: formatDate(calendar.anchorDate),
      payDateOffsetDays: calendar.payDateOffsetDays,
      processingCutoffOffsetDays: calendar.processingCutoffOffsetDays,
      effectiveFrom: formatDate(calendar.effectiveFrom),
      effectiveTo: calendar.effectiveTo
        ? formatDate(calendar.effectiveTo)
        : null,
      salaryUnpaidLeaveRule: calendar.salaryUnpaidLeaveRule,
      salaryStandardAnnualHours:
        calendar.salaryStandardAnnualHours?.toFixed(2) ?? null,
      periodCount,
    };
  }

  periodShape(period: PayrollPeriod) {
    return {
      id: period.id,
      organizationId: period.organizationId,
      payGroupId: period.payGroupId,
      payrollCalendarId: period.payrollCalendarId,
      periodStart: formatDate(period.periodStart),
      periodEnd: formatDate(period.periodEnd),
      payDate: formatDate(period.payDate),
      processingCutoffAt: period.processingCutoffAt.toISOString(),
      timezone: period.timezone,
      status: period.status,
      timePeriodId: period.timePeriodId,
      timesheetsMaterializedAt:
        period.timesheetsMaterializedAt?.toISOString() ?? null,
    };
  }
}
