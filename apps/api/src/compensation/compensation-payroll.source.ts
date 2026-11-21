import { Injectable } from '@nestjs/common';
import { formatDate, parseDateOnly } from '../common/domain-support.js';
import { PrismaService } from '../database/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import type { CompensationRecord } from '../generated/prisma/client.js';
import {
  END_OF_TIME,
  formatRateAmount,
  recordEffectiveOn,
} from './compensation-domain.js';
import type {
  PayrollCompensationFact,
  PayrollCompensationSource,
} from './compensation-integration.contracts.js';

/**
 * Binds the payroll-facing Compensation contract. Trusted internal read (Payroll does its own
 * authorization): facts only, never a calculation. Inside an assignment's dates only; a cancelled
 * assignment has none.
 */
@Injectable()
export class CompensationPayrollSource implements PayrollCompensationSource {
  constructor(private readonly prisma: PrismaService) {}

  async compensationEffectiveOn(
    query: { employmentAssignmentId: string; date: string },
    client?: unknown,
  ): Promise<PayrollCompensationFact | null> {
    const date = parseDateOnly(query.date, 'date');
    const facts = await this.facts(
      query.employmentAssignmentId,
      date,
      date,
      client,
    );
    return facts[0] ?? null;
  }

  async compensationFactsBetween(
    query: { employmentAssignmentId: string; from: string; to: string },
    client?: unknown,
  ): Promise<PayrollCompensationFact[]> {
    return this.facts(
      query.employmentAssignmentId,
      parseDateOnly(query.from, 'from'),
      parseDateOnly(query.to, 'to'),
      client,
    );
  }

  async payGroupAssignmentsBetween(
    query: { payGroupId: string; from: string; to: string },
    client?: unknown,
  ): Promise<Array<{ employmentAssignmentId: string; employeeId: string }>> {
    const db = (client as Prisma.TransactionClient | undefined) ?? this.prisma;
    const from = parseDateOnly(query.from, 'from');
    const to = parseDateOnly(query.to, 'to');
    const rows = await db.compensationRecord.findMany({
      where: {
        payGroupId: query.payGroupId,
        supersededAt: null,
        effectiveFrom: { lte: to },
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: from } }],
        employmentAssignment: {
          status: { not: 'CANCELLED' },
          startDate: { lte: to },
          OR: [{ endDate: null }, { endDate: { gte: from } }],
        },
      },
      select: {
        employmentAssignmentId: true,
        employmentAssignment: { select: { employeeId: true } },
      },
      distinct: ['employmentAssignmentId'],
      orderBy: { employmentAssignmentId: 'asc' },
    });
    return rows.map((row) => ({
      employmentAssignmentId: row.employmentAssignmentId,
      employeeId: row.employmentAssignment.employeeId,
    }));
  }

  private async facts(
    assignmentId: string,
    from: Date,
    to: Date,
    client?: unknown,
  ) {
    const db = (client as Prisma.TransactionClient | undefined) ?? this.prisma;
    const assignment = await db.employmentAssignment.findUnique({
      where: { id: assignmentId },
      select: { id: true, status: true, startDate: true, endDate: true },
    });
    if (!assignment || assignment.status === 'CANCELLED' || to < from)
      return [];
    // Clip the request to the assignment: compensation never applies outside it.
    const start = from > assignment.startDate ? from : assignment.startDate;
    const end =
      assignment.endDate && assignment.endDate < to ? assignment.endDate : to;
    if (end < start) return [];
    const records = await db.compensationRecord.findMany({
      where: {
        employmentAssignmentId: assignmentId,
        supersededAt: null,
        effectiveFrom: { lte: end },
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: start } }],
      },
      orderBy: [{ effectiveFrom: 'asc' }, { id: 'asc' }],
    });
    if (start.getTime() === end.getTime()) {
      // A single date resolves to exactly zero or one record (never "the latest").
      const one = recordEffectiveOn(records, start);
      return one ? [this.fact(one, assignment.endDate)] : [];
    }
    return records.map((record) => this.fact(record, assignment.endDate));
  }

  private fact(
    record: CompensationRecord,
    assignmentEnd: Date | null,
  ): PayrollCompensationFact {
    const recordEnd = record.effectiveTo ?? END_OF_TIME;
    const end =
      assignmentEnd && assignmentEnd < recordEnd
        ? assignmentEnd
        : record.effectiveTo;
    return {
      compensationRecordId: record.id,
      employmentAssignmentId: record.employmentAssignmentId,
      payBasis: record.payBasis,
      rateAmount: formatRateAmount(record.rateAmount),
      salaryArrangement:
        record.salaryArrangement ??
        (record.payBasis === 'SALARY' ? 'ANNUAL' : null),
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
      effectiveTo: end && formatDate(end),
      payGroupId: record.payGroupId,
    };
  }
}
