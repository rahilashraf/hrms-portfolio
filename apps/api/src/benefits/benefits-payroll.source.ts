import { Injectable } from '@nestjs/common';
import {
  addDays,
  formatDate,
  parseDateOnly,
} from '../common/domain-support.js';
import { PrismaService } from '../database/prisma.service.js';
import type {
  BenefitCoverageLevel,
  BenefitRateFrequency,
  BenefitType,
} from '../generated/prisma/client.js';
import type { BenefitsClient } from './benefits-common.js';
import { clipRange, type DateRange } from './benefits-domain.js';

/**
 * Phase 11 Batch 11.7 — the Benefits → Payroll contract. Benefits publishes facts; Payroll
 * consumes them and alone calculates, snapshots and finalizes pay. Benefits never reads or
 * writes payroll records.
 */
export const PAYROLL_BENEFIT_SOURCE = Symbol('PAYROLL_BENEFIT_SOURCE');

/** One enrolled stretch of a sponsored election at one rate: amounts as rated, not prorated. */
export interface PayrollBenefitFact {
  enrollmentId: string;
  employeeId: string;
  employmentAssignmentId: string;
  planId: string;
  planCode: string;
  planName: string;
  benefitType: BenefitType;
  optionId: string;
  optionCode: string;
  coverageLevel: BenefitCoverageLevel;
  currency: string;
  employerContributionTaxable: boolean;
  rateId: string;
  frequency: BenefitRateFrequency;
  /** Decimal strings (2 places) per `frequency`. */
  employeeAmount: string;
  employerAmount: string;
  /** YYYY-MM-DD, inclusive: coverage ∩ rate ∩ the sponsoring assignment ∩ the query range. */
  from: string;
  to: string;
}

/** Covered dates without any rate: Payroll must not guess a cost. */
export interface PayrollBenefitGap {
  enrollmentId: string;
  planCode: string;
  from: string;
  to: string;
}

export interface PayrollBenefitFacts {
  facts: PayrollBenefitFact[];
  gaps: PayrollBenefitGap[];
}

export interface PayrollBenefitSource {
  /**
   * The enrolled (not waived, not superseded) elections an assignment sponsors over
   * [from, to], clipped to the assignment's active dates (nothing after termination), split by
   * rate. An election belongs to exactly one sponsoring assignment at a time, so an employee's
   * benefit is never reported twice across their assignments.
   */
  benefitFactsBetween(
    query: { employmentAssignmentId: string; from: string; to: string },
    client?: unknown,
  ): Promise<PayrollBenefitFacts>;
}

@Injectable()
export class BenefitsPayrollSource implements PayrollBenefitSource {
  constructor(private readonly prisma: PrismaService) {}

  async benefitFactsBetween(
    query: { employmentAssignmentId: string; from: string; to: string },
    client?: unknown,
  ): Promise<PayrollBenefitFacts> {
    const db = (client as BenefitsClient | undefined) ?? this.prisma;
    const window: DateRange = {
      from: parseDateOnly(query.from, 'from'),
      to: parseDateOnly(query.to, 'to'),
    };
    const assignment = await db.employmentAssignment.findUnique({
      where: { id: query.employmentAssignmentId },
      select: { status: true, startDate: true, endDate: true },
    });
    if (!assignment || assignment.status === 'CANCELLED')
      return { facts: [], gaps: [] };
    const sponsored = clipRange(
      { from: assignment.startDate, to: assignment.endDate },
      window,
    );
    if (!sponsored) return { facts: [], gaps: [] };
    const rows = await db.benefitEnrollment.findMany({
      where: {
        employmentAssignmentId: query.employmentAssignmentId,
        electionType: 'ENROLLED',
        supersededAt: null,
        coverageStart: { lte: sponsored.to! },
        OR: [{ coverageEnd: null }, { coverageEnd: { gte: sponsored.from } }],
      },
      include: { plan: true, option: true },
      orderBy: [{ planId: 'asc' }, { coverageStart: 'asc' }],
    });
    const facts: PayrollBenefitFact[] = [];
    const gaps: PayrollBenefitGap[] = [];
    for (const row of rows) {
      const covered = clipRange(
        { from: row.coverageStart, to: row.coverageEnd },
        sponsored,
      );
      if (!covered || !row.option) continue;
      const rates = await db.benefitRate.findMany({
        where: {
          optionId: row.option.id,
          supersededAt: null,
          effectiveFrom: { lte: covered.to! },
          OR: [{ effectiveTo: null }, { effectiveTo: { gte: covered.from } }],
        },
        orderBy: { effectiveFrom: 'asc' },
      });
      let cursor = covered.from;
      for (const rate of rates) {
        const piece = clipRange(
          { from: rate.effectiveFrom, to: rate.effectiveTo },
          covered,
        );
        if (!piece) continue;
        if (piece.from > cursor) {
          gaps.push({
            enrollmentId: row.id,
            planCode: row.plan.code,
            from: formatDate(cursor),
            to: formatDate(addDays(piece.from, -1)),
          });
        }
        facts.push({
          enrollmentId: row.id,
          employeeId: row.employeeId,
          employmentAssignmentId: row.employmentAssignmentId,
          planId: row.planId,
          planCode: row.plan.code,
          planName: row.plan.name,
          benefitType: row.plan.benefitType,
          optionId: row.option.id,
          optionCode: row.option.code,
          coverageLevel: row.option.coverageLevel,
          currency: row.plan.currency,
          employerContributionTaxable: row.plan.employerContributionTaxable,
          rateId: rate.id,
          frequency: rate.frequency,
          employeeAmount: rate.employeeAmount.toFixed(2),
          employerAmount: rate.employerAmount.toFixed(2),
          from: formatDate(piece.from),
          to: formatDate(piece.to!),
        });
        cursor = addDays(piece.to!, 1);
      }
      if (cursor <= covered.to!) {
        gaps.push({
          enrollmentId: row.id,
          planCode: row.plan.code,
          from: formatDate(cursor),
          to: formatDate(covered.to!),
        });
      }
    }
    return { facts, gaps };
  }
}
