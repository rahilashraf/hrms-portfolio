import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { addDays, domainError, formatDate } from '../common/domain-support.js';
import { PrismaService } from '../database/prisma.service.js';
import type {
  BenefitRate,
  BenefitRateFrequency,
} from '../generated/prisma/client.js';
import { BenefitPlanService } from './benefit-plan.service.js';
import { BenefitsAccessService } from './benefits-access.service.js';
import {
  lockPlan,
  writeBenefitsAudit,
  type BenefitsRequestContext,
} from './benefits-common.js';
import {
  isoDate,
  parseBenefitAmount,
  parseBenefitRange,
  rangeContains,
} from './benefits-domain.js';

export const BENEFIT_RATE_FREQUENCIES: readonly BenefitRateFrequency[] = [
  'PER_PAY_PERIOD',
  'MONTHLY',
  'ANNUAL',
];

export interface RateInput {
  effectiveFrom: string;
  effectiveTo?: string | null;
  frequency: BenefitRateFrequency;
  employeeAmount: string;
  employerAmount: string;
  reason?: string | null;
}

/**
 * Phase 11 Batch 11.3 — effective-dated costs of coverage options (benefit.plan.manage).
 *
 * A rate is never edited. A new rate starting after the current one closes it the day before
 * (CHANGE), so history keeps the amount that applied on every date; a mistake is fixed by a
 * CORRECTION that supersedes the wrong rate (it leaves the timeline, still readable). Rates are
 * in the plan's currency and stay inside the plan's dates; a gap (no rate) is allowed and
 * reported downstream rather than guessed. Writes lock the plan, then the option (the timeline
 * trigger), so concurrent rate writers serialize.
 */
@Injectable()
export class BenefitRateService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: BenefitsAccessService,
    private readonly audit: AuditService,
    private readonly plans: BenefitPlanService,
  ) {}

  async addRate(
    optionId: string,
    input: RateInput,
    context: BenefitsRequestContext,
  ) {
    const option = await this.plans.optionOrThrow(optionId);
    await this.access.requirePlanManage(
      context.actorUserId,
      option.plan.organizationId,
      this.prisma,
      'Coverage option not found.',
    );
    const values = this.parse(input);
    return this.prisma.$transaction(async (tx) => {
      await lockPlan(tx, option.planId);
      const plan = await tx.benefitPlan.findUniqueOrThrow({
        where: { id: option.planId },
      });
      const current = await tx.benefitCoverageOption.findUniqueOrThrow({
        where: { id: optionId },
      });
      if (plan.archivedAt || current.archivedAt) {
        throw new ConflictException(
          domainError(
            409,
            'BENEFIT_ARCHIVED',
            'The plan or option is archived.',
          ),
        );
      }
      // An open-ended rate of a plan with an end date ends with the plan.
      if (!values.range.to && plan.effectiveTo)
        values.range.to = plan.effectiveTo;
      this.assertInsidePlan(plan, values.range);
      const rates = await tx.benefitRate.findMany({
        where: { optionId, supersededAt: null },
        orderBy: { effectiveFrom: 'asc' },
      });
      const later = rates.find(
        (rate) => rate.effectiveFrom >= values.range.from,
      );
      // Batch 7C (B17): a gap with no rate (before the first rate or between two) is filled by
      // a rate that fits in it — never by moving or overlapping a neighbour.
      const covering = rates.find(
        (rate) =>
          rate.effectiveFrom <= values.range.from &&
          (!rate.effectiveTo || rate.effectiveTo >= values.range.from),
      );
      if (
        later &&
        !covering &&
        later.effectiveFrom.getTime() !== values.range.from.getTime()
      ) {
        const gapEnd = addDays(later.effectiveFrom, -1);
        if (!values.range.to || values.range.to > gapEnd) {
          throw new ConflictException(
            domainError(
              409,
              'BENEFIT_RATE_GAP_EXCEEDED',
              'A later rate starts before this one would end; end it by the day before that rate.',
              { rateId: later.id, gapEnd: formatDate(gapEnd) },
            ),
          );
        }
        const rate = await tx.benefitRate.create({
          data: {
            planId: option.planId,
            optionId,
            effectiveFrom: values.range.from,
            effectiveTo: values.range.to,
            frequency: values.frequency,
            employeeAmount: values.employeeAmount,
            employerAmount: values.employerAmount,
            recordType: 'CHANGE',
            reason: values.reason,
            createdByUserId: context.actorUserId ?? null,
          },
        });
        await writeBenefitsAudit(this.audit, tx, {
          action: 'BENEFIT_RATE_ADDED',
          entityType: 'BenefitRate',
          entityId: rate.id,
          context,
          metadata: {
            planId: option.planId,
            optionId,
            ...this.auditValues(rate),
            closedRateId: null,
            filledGap: true,
          },
        });
        return this.rateShape(rate, plan.currency);
      }
      if (later) {
        throw new ConflictException(
          domainError(
            409,
            later.effectiveFrom.getTime() === values.range.from.getTime()
              ? 'BENEFIT_RATE_EXISTS'
              : 'BENEFIT_RATE_FUTURE_EXISTS',
            'A rate already starts on or after this date; correct that rate instead.',
            { rateId: later.id },
          ),
        );
      }
      // The rate in effect on the new start is closed the day before.
      const previous = rates.find(
        (rate) => !rate.effectiveTo || rate.effectiveTo >= values.range.from,
      );
      if (previous) {
        await tx.benefitRate.update({
          where: { id: previous.id },
          data: { effectiveTo: addDays(values.range.from, -1) },
        });
      }
      const rate = await tx.benefitRate.create({
        data: {
          planId: option.planId,
          optionId,
          effectiveFrom: values.range.from,
          effectiveTo: values.range.to,
          frequency: values.frequency,
          employeeAmount: values.employeeAmount,
          employerAmount: values.employerAmount,
          recordType: rates.length === 0 ? 'INITIAL' : 'CHANGE',
          reason: values.reason,
          createdByUserId: context.actorUserId ?? null,
        },
      });
      await writeBenefitsAudit(this.audit, tx, {
        action: 'BENEFIT_RATE_ADDED',
        entityType: 'BenefitRate',
        entityId: rate.id,
        context,
        metadata: {
          planId: option.planId,
          optionId,
          ...this.auditValues(rate),
          closedRateId: previous?.id ?? null,
        },
      });
      return this.rateShape(rate, plan.currency);
    });
  }

  /** Supersedes a rate with corrected values (any of them); the old rate stays as history. */
  async correctRate(
    rateId: string,
    input: Partial<RateInput> & { reason: string },
    context: BenefitsRequestContext,
  ) {
    const reason = input.reason?.trim();
    if (!reason) {
      throw new BadRequestException(
        domainError(
          400,
          'BENEFIT_REASON_REQUIRED',
          'A correction needs a reason.',
        ),
      );
    }
    const original = await this.prisma.benefitRate.findUnique({
      where: { id: rateId },
      include: { plan: true },
    });
    if (!original) throw new NotFoundException('Benefit rate not found.');
    await this.access.requirePlanManage(
      context.actorUserId,
      original.plan.organizationId,
      this.prisma,
      'Benefit rate not found.',
    );
    // Batch 7C (B5, B11): the plan is locked first; the plan, option and rate are then read
    // under the lock (a concurrent discontinuation or archive is seen, never a stale copy).
    return this.prisma.$transaction(async (tx) => {
      await lockPlan(tx, original.planId);
      const plan = await tx.benefitPlan.findUniqueOrThrow({
        where: { id: original.planId },
      });
      const current = await tx.benefitRate.findUniqueOrThrow({
        where: { id: rateId },
        include: { option: { select: { archivedAt: true } } },
      });
      if (current.supersededAt) {
        throw new ConflictException(
          domainError(
            409,
            'BENEFIT_RATE_SUPERSEDED',
            'This rate was already corrected; correct its replacement.',
          ),
        );
      }
      if (plan.archivedAt || current.option.archivedAt) {
        throw new ConflictException(
          domainError(
            409,
            'BENEFIT_ARCHIVED',
            'The plan or option is archived; its rates are history.',
          ),
        );
      }
      const values = this.parse({
        effectiveFrom: input.effectiveFrom ?? formatDate(current.effectiveFrom),
        effectiveTo:
          input.effectiveTo === undefined
            ? isoDate(current.effectiveTo)
            : input.effectiveTo,
        frequency: input.frequency ?? current.frequency,
        employeeAmount:
          input.employeeAmount ?? current.employeeAmount.toFixed(2),
        employerAmount:
          input.employerAmount ?? current.employerAmount.toFixed(2),
        reason,
      });
      // Batch 7C (B17): an open-ended correction of a plan with an end date ends with the plan
      // (as when adding a rate).
      if (!values.range.to && plan.effectiveTo)
        values.range.to = plan.effectiveTo;
      this.assertInsidePlan(plan, values.range);
      const overlapping = await tx.benefitRate.findFirst({
        where: {
          optionId: current.optionId,
          id: { not: rateId },
          supersededAt: null,
          effectiveFrom: { lte: values.range.to ?? new Date('9999-12-31') },
          OR: [
            { effectiveTo: null },
            { effectiveTo: { gte: values.range.from } },
          ],
        },
      });
      if (overlapping) {
        throw new ConflictException(
          domainError(
            409,
            'BENEFIT_RATE_OVERLAP',
            'The corrected dates overlap another rate of the option.',
            { rateId: overlapping.id },
          ),
        );
      }
      await tx.benefitRate.update({
        where: { id: rateId },
        data: { supersededAt: new Date() },
      });
      const rate = await tx.benefitRate.create({
        data: {
          planId: current.planId,
          optionId: current.optionId,
          effectiveFrom: values.range.from,
          effectiveTo: values.range.to,
          frequency: values.frequency,
          employeeAmount: values.employeeAmount,
          employerAmount: values.employerAmount,
          recordType: 'CORRECTION',
          supersedesRateId: rateId,
          reason,
          createdByUserId: context.actorUserId ?? null,
        },
      });
      await writeBenefitsAudit(this.audit, tx, {
        action: 'BENEFIT_RATE_CORRECTED',
        entityType: 'BenefitRate',
        entityId: rate.id,
        context,
        metadata: {
          planId: current.planId,
          optionId: current.optionId,
          supersededRateId: rateId,
          before: this.auditValues(current),
          after: this.auditValues(rate),
          // Batch 7C (C1): the reason stays on the CORRECTION rate.
          reasonProvided: true,
        },
      });
      return this.rateShape(rate, plan.currency);
    });
  }

  private parse(input: RateInput) {
    if (!BENEFIT_RATE_FREQUENCIES.includes(input.frequency)) {
      throw new BadRequestException('frequency is not supported.');
    }
    const reason = input.reason?.trim() || null;
    if (reason && reason.length > 2000) {
      throw new BadRequestException('reason must be at most 2000 characters.');
    }
    return {
      range: parseBenefitRange(input.effectiveFrom, input.effectiveTo),
      frequency: input.frequency,
      employeeAmount: parseBenefitAmount(
        input.employeeAmount,
        'employeeAmount',
      ),
      employerAmount: parseBenefitAmount(
        input.employerAmount,
        'employerAmount',
      ),
      reason,
    };
  }

  private assertInsidePlan(
    plan: { effectiveFrom: Date; effectiveTo: Date | null },
    range: { from: Date; to: Date | null },
  ) {
    if (
      !rangeContains({ from: plan.effectiveFrom, to: plan.effectiveTo }, range)
    ) {
      throw new ConflictException(
        domainError(
          409,
          'BENEFIT_RATE_OUTSIDE_PLAN',
          'A rate must stay within the plan’s effective dates.',
        ),
      );
    }
  }

  private auditValues(rate: BenefitRate) {
    return {
      effectiveFrom: formatDate(rate.effectiveFrom),
      effectiveTo: isoDate(rate.effectiveTo),
      frequency: rate.frequency,
      employeeAmount: rate.employeeAmount.toFixed(2),
      employerAmount: rate.employerAmount.toFixed(2),
      recordType: rate.recordType,
    };
  }

  rateShape(rate: BenefitRate, currency: string) {
    return {
      id: rate.id,
      planId: rate.planId,
      optionId: rate.optionId,
      ...this.auditValues(rate),
      currency,
      supersedesRateId: rate.supersedesRateId,
      supersededAt: rate.supersededAt?.toISOString() ?? null,
      reason: rate.reason,
    };
  }
}
