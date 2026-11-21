import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import {
  addDays,
  domainError,
  formatDate,
  parseDateOnly,
  positionTargets,
} from '../common/domain-support.js';
import { PrismaService } from '../database/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { BenefitEligibilityService } from './benefit-eligibility.service.js';
import {
  BenefitsAccessService,
  permissionRequired,
} from './benefits-access.service.js';
import {
  BenefitsClock,
  benefitsToday,
  lockEmployee,
  lockPlan,
  sharePlan,
  writeBenefitsAudit,
  type BenefitsClient,
  type BenefitsRequestContext,
} from './benefits-common.js';
import {
  assertCoverageMatchesDependents,
  dependentEligibleOn,
  enrollmentStatusOn,
  isoDate,
  parseBenefitRange,
  rangeContains,
  rangesOverlap,
  type DateRange,
} from './benefits-domain.js';

type Tx = Prisma.TransactionClient;

export interface ElectionInput {
  employmentAssignmentId: string;
  planId: string;
  coverageStart: string;
  coverageEnd?: string | null;
  electedOn?: string | null;
  reason?: string | null;
  /** Records HR's decision to elect despite the eligibility rules, with why. */
  eligibilityOverrideReason?: string | null;
}

export interface EnrollInput extends ElectionInput {
  optionId: string;
  dependentIds?: string[];
}

export const ENROLLMENT_INCLUDE = {
  plan: true,
  option: true,
  dependents: { include: { dependent: true } },
  employmentAssignment: {
    include: {
      position: {
        select: {
          id: true,
          name: true,
          workLocation: { select: { timezone: true } },
          organization: { select: { id: true, name: true, timezone: true } },
        },
      },
    },
  },
} as const;

export type EnrollmentRow = Prisma.BenefitEnrollmentGetPayload<{
  include: typeof ENROLLMENT_INCLUDE;
}>;

const note = (value: string | null | undefined, field: string) => {
  const trimmed = value?.trim() || null;
  if (trimmed && trimmed.length > 2000) {
    throw new BadRequestException(`${field} must be at most 2000 characters.`);
  }
  return trimmed;
};

/** Phase 19: most attention items one request returns (the list says when it is cut). */
export const ATTENTION_LIMIT = 500;

/**
 * Phase 11 Batches 11.5–11.6 — employees' benefit elections (benefit.manage on the sponsoring
 * assignment, never one's own; HR records every election — self-service is read-only).
 *
 * An employee has one election timeline per plan, whatever their assignments: segments
 * (enrolled in an option with covered dependents, or waived) never overlap, so a benefit
 * applies once even with several assignments. The sponsoring assignment gives the
 * organization scope and the payroll context. Segments are never edited: changes end one and
 * start another, corrections supersede, and status (pending/active/ended/waived) is derived
 * from the dates. Every write locks the Employee row (the timeline trigger takes the same
 * lock), validates before writing, and is audited without dependent names.
 */
@Injectable()
export class BenefitEnrollmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: BenefitsAccessService,
    private readonly audit: AuditService,
    private readonly clock: BenefitsClock,
    private readonly eligibility: BenefitEligibilityService,
  ) {}

  // ─── Elections ─────────────────────────────────────────────────────────────

  async enroll(input: EnrollInput, context: BenefitsRequestContext) {
    const { assignment } = await this.access.requireManage(
      context.actorUserId!,
      input.employmentAssignmentId,
    );
    const range = parseBenefitRange(input.coverageStart, input.coverageEnd, {
      from: 'coverageStart',
      to: 'coverageEnd',
    });
    return this.prisma.$transaction(async (tx) => {
      await sharePlan(tx, input.planId);
      await lockEmployee(tx, assignment.employeeId);
      const plan = await this.electablePlan(
        tx,
        input.planId,
        assignment.position.organizationId,
        context.actorUserId,
      );
      const option = await this.electableOption(tx, plan.id, input.optionId);
      this.assertCoverageInside(plan, assignment, range);
      const override = await this.assertEligible(tx, input, range.from);
      const dependents = await this.validDependents(
        tx,
        assignment.employeeId,
        input.dependentIds ?? [],
        plan.dependentChildMaxAge,
        range.from,
      );
      assertCoverageMatchesDependents(
        option.coverageLevel,
        dependents.map((dependent) => dependent.relationship),
      );
      await this.assertRate(tx, option.id, range.from);
      await this.assertNoOverlap(
        tx,
        assignment.employeeId,
        plan.id,
        range,
        [],
        () =>
          this.readableAssignments(
            context.actorUserId,
            assignment.employeeId,
            tx,
          ),
      );
      const row = await tx.benefitEnrollment.create({
        data: {
          employeeId: assignment.employeeId,
          employmentAssignmentId: assignment.id,
          organizationId: plan.organizationId,
          planId: plan.id,
          optionId: option.id,
          electionType: 'ENROLLED',
          recordType: (await this.hasHistory(
            tx,
            assignment.employeeId,
            plan.id,
          ))
            ? 'CHANGE'
            : 'INITIAL',
          coverageStart: range.from,
          coverageEnd: range.to,
          electedOn: this.electedOn(input, assignment),
          reason: note(input.reason, 'reason'),
          eligibilityOverrideReason: override,
          createdByUserId: context.actorUserId ?? null,
        },
      });
      if (dependents.length > 0) {
        await tx.benefitEnrollmentDependent.createMany({
          data: dependents.map((dependent) => ({
            enrollmentId: row.id,
            employeeId: assignment.employeeId,
            dependentId: dependent.id,
          })),
        });
      }
      await writeBenefitsAudit(this.audit, tx, {
        action: 'BENEFIT_ENROLLED',
        entityType: 'BenefitEnrollment',
        entityId: row.id,
        context,
        metadata: this.auditOf(row, dependents.length),
      });
      return this.reload(tx, row.id);
    });
  }

  /** Records that an eligible employee declined a plan (distinct from never being offered it). */
  async waive(input: ElectionInput, context: BenefitsRequestContext) {
    const { assignment } = await this.access.requireManage(
      context.actorUserId!,
      input.employmentAssignmentId,
    );
    const range = parseBenefitRange(input.coverageStart, input.coverageEnd, {
      from: 'coverageStart',
      to: 'coverageEnd',
    });
    return this.prisma.$transaction(async (tx) => {
      await sharePlan(tx, input.planId);
      await lockEmployee(tx, assignment.employeeId);
      const plan = await this.electablePlan(
        tx,
        input.planId,
        assignment.position.organizationId,
        context.actorUserId,
      );
      this.assertCoverageInside(plan, assignment, range);
      const override = await this.assertEligible(tx, input, range.from);
      await this.assertNoOverlap(
        tx,
        assignment.employeeId,
        plan.id,
        range,
        [],
        () =>
          this.readableAssignments(
            context.actorUserId,
            assignment.employeeId,
            tx,
          ),
      );
      const row = await tx.benefitEnrollment.create({
        data: {
          employeeId: assignment.employeeId,
          employmentAssignmentId: assignment.id,
          organizationId: plan.organizationId,
          planId: plan.id,
          optionId: null,
          electionType: 'WAIVED',
          recordType: (await this.hasHistory(
            tx,
            assignment.employeeId,
            plan.id,
          ))
            ? 'CHANGE'
            : 'INITIAL',
          coverageStart: range.from,
          coverageEnd: range.to,
          electedOn: this.electedOn(input, assignment),
          reason: note(input.reason, 'reason'),
          eligibilityOverrideReason: override,
          createdByUserId: context.actorUserId ?? null,
        },
      });
      await writeBenefitsAudit(this.audit, tx, {
        action: 'BENEFIT_WAIVED',
        entityType: 'BenefitEnrollment',
        entityId: row.id,
        context,
        metadata: this.auditOf(row, 0),
      });
      return this.reload(tx, row.id);
    });
  }

  // ─── Lifecycle (Batch 11.6) ────────────────────────────────────────────────

  /**
   * Changes an enrolled segment from a date: the option and/or covered dependents. The segment
   * ends the day before and a CHANGE segment continues to its end; the past stays as it was.
   * A change on the segment's own start is a correction instead.
   */
  async change(
    enrollmentId: string,
    input: {
      effectiveDate: string;
      optionId?: string;
      dependentIds?: string[];
      reason?: string | null;
      eligibilityOverrideReason?: string | null;
    },
    context: BenefitsRequestContext,
  ) {
    const existing = await this.segmentOrThrow(enrollmentId);
    const { assignment } = await this.access.requireManage(
      context.actorUserId!,
      existing.employmentAssignmentId,
      this.prisma,
      'Benefit election not found.',
    );
    const from = parseDateOnly(input.effectiveDate, 'effectiveDate');
    return this.prisma.$transaction(async (tx) => {
      await sharePlan(tx, existing.planId);
      await lockEmployee(tx, existing.employeeId);
      const current = await this.liveSegment(tx, enrollmentId);
      if (current.electionType !== 'ENROLLED') {
        throw new ConflictException(
          domainError(
            409,
            'BENEFIT_ELECTION_WAIVED',
            'A waiver has no coverage to change; end it and enroll.',
          ),
        );
      }
      await this.assertCurrentOrFuture(tx, current);
      this.assertSplitDate(current, from);
      const plan = await this.liveRatePlan(tx, current.planId);
      const option = await this.electableOption(
        tx,
        plan.id,
        input.optionId ?? current.optionId!,
      );
      const dependentIds =
        input.dependentIds ??
        current.dependents.map((link) => link.dependentId);
      const dependents = await this.validDependents(
        tx,
        current.employeeId,
        dependentIds,
        plan.dependentChildMaxAge,
        from,
      );
      assertCoverageMatchesDependents(
        option.coverageLevel,
        dependents.map((dependent) => dependent.relationship),
      );
      await this.assertRate(tx, option.id, from);
      const override = await this.assertEligible(
        tx,
        {
          employmentAssignmentId: current.employmentAssignmentId,
          planId: current.planId,
          coverageStart: input.effectiveDate,
          // Batch 7C (C3): a fresh reason, never the previous segment's.
          eligibilityOverrideReason: input.eligibilityOverrideReason ?? null,
        },
        from,
      );
      await tx.benefitEnrollment.update({
        where: { id: current.id },
        // The recorded end (and its reason) moves to the continuation below.
        data: { coverageEnd: addDays(from, -1), endReason: null },
      });
      const row = await tx.benefitEnrollment.create({
        data: {
          employeeId: current.employeeId,
          employmentAssignmentId: current.employmentAssignmentId,
          organizationId: current.organizationId,
          planId: current.planId,
          optionId: option.id,
          electionType: 'ENROLLED',
          recordType: 'CHANGE',
          coverageStart: from,
          coverageEnd: current.coverageEnd,
          // The recorded end (and why) now belongs to this continuation.
          endReason: current.endReason,
          electedOn: this.electedOn({}, assignment),
          reason: note(input.reason, 'reason'),
          eligibilityOverrideReason: override,
          createdByUserId: context.actorUserId ?? null,
        },
      });
      if (dependents.length > 0) {
        await tx.benefitEnrollmentDependent.createMany({
          data: dependents.map((dependent) => ({
            enrollmentId: row.id,
            employeeId: current.employeeId,
            dependentId: dependent.id,
          })),
        });
      }
      await writeBenefitsAudit(this.audit, tx, {
        action: 'BENEFIT_ELECTION_CHANGED',
        entityType: 'BenefitEnrollment',
        entityId: row.id,
        context,
        metadata: {
          ...this.auditOf(row, dependents.length),
          previousEnrollmentId: current.id,
          previousOptionId: current.optionId,
          previousDependentCount: current.dependents.length,
        },
      });
      return this.reload(tx, row.id);
    });
  }

  /** Ends coverage (or a waiver) on a date: earlier only, never before it started. */
  async end(
    enrollmentId: string,
    input: { coverageEnd: string; reason?: string | null },
    context: BenefitsRequestContext,
  ) {
    const existing = await this.segmentOrThrow(enrollmentId);
    await this.access.requireManage(
      context.actorUserId!,
      existing.employmentAssignmentId,
      this.prisma,
      'Benefit election not found.',
    );
    const end = parseDateOnly(input.coverageEnd, 'coverageEnd');
    return this.prisma.$transaction(async (tx) => {
      // Batch 7C (B11): the plan (FOR SHARE) before the employee, as every election write: a
      // concurrent plan discontinuation is serialized instead of failing on the trigger.
      await sharePlan(tx, existing.planId);
      await lockEmployee(tx, existing.employeeId);
      const current = await this.liveSegment(tx, enrollmentId);
      await this.assertCurrentOrFuture(tx, current);
      if (end < current.coverageStart) {
        throw new ConflictException(
          domainError(
            409,
            'BENEFIT_END_BEFORE_START',
            'Coverage cannot end before it starts; rescind the election instead.',
          ),
        );
      }
      if (current.coverageEnd && end >= current.coverageEnd) {
        throw new ConflictException(
          domainError(
            409,
            'BENEFIT_END_NOT_EARLIER',
            'Coverage can only be ended earlier; extending it is a correction.',
          ),
        );
      }
      // Batch 7C (C8): coverage continuing this election (a change or transfer starting the day
      // after it ends) is never ended silently: HR resolves it explicitly first. An unrelated
      // later election after a gap is not a continuation.
      const later = current.coverageEnd
        ? await tx.benefitEnrollment.findMany({
            where: {
              employeeId: current.employeeId,
              planId: current.planId,
              supersededAt: null,
              id: { not: current.id },
              coverageStart: addDays(current.coverageEnd, 1),
            },
            orderBy: { coverageStart: 'asc' },
          })
        : [];
      if (later.length > 0) {
        const visible = await this.readableAssignments(
          context.actorUserId,
          current.employeeId,
          tx,
        );
        throw new ConflictException(
          domainError(
            409,
            'BENEFIT_LATER_COVERAGE',
            'Coverage of this plan continues in a later election; end or rescind that one first.',
            {
              laterElections: later.length,
              elections: later
                .filter((row) => visible.has(row.employmentAssignmentId))
                .map((row) => ({
                  id: row.id,
                  coverageStart: formatDate(row.coverageStart),
                  coverageEnd: isoDate(row.coverageEnd),
                })),
            },
          ),
        );
      }
      // Batch 7C (C1): the reason (often a life event) is kept on the election as an HR note,
      // never in audit metadata.
      // An earlier end without a new reason keeps the reason already recorded (never lost).
      const endReason = note(input.reason, 'reason') ?? current.endReason;
      await tx.benefitEnrollment.update({
        where: { id: current.id },
        data: { coverageEnd: end, endReason },
      });
      await writeBenefitsAudit(this.audit, tx, {
        action: 'BENEFIT_ELECTION_ENDED',
        entityType: 'BenefitEnrollment',
        entityId: current.id,
        context,
        metadata: {
          employeeId: current.employeeId,
          planId: current.planId,
          previousCoverageEnd: isoDate(current.coverageEnd),
          coverageEnd: formatDate(end),
          reasonProvided: note(input.reason, 'reason') !== null,
        },
      });
      return this.reload(tx, current.id);
    });
  }

  /**
   * Moves an election to another assignment of the same employee in the plan's organization
   * from a date (the sponsoring assignment is ending, or a transfer): coverage continues
   * unchanged through the new sponsor.
   */
  async transfer(
    enrollmentId: string,
    input: {
      employmentAssignmentId: string;
      effectiveDate: string;
      reason?: string | null;
      /** Batch 7C (C3): required when the new sponsor is not eligible on the date. */
      eligibilityOverrideReason?: string | null;
    },
    context: BenefitsRequestContext,
  ) {
    const existing = await this.segmentOrThrow(enrollmentId);
    await this.access.requireManage(
      context.actorUserId!,
      existing.employmentAssignmentId,
      this.prisma,
      'Benefit election not found.',
    );
    const { assignment } = await this.access.requireManage(
      context.actorUserId!,
      input.employmentAssignmentId,
    );
    if (assignment.employeeId !== existing.employeeId) {
      throw new BadRequestException(
        domainError(
          400,
          'BENEFIT_TRANSFER_OTHER_EMPLOYEE',
          'The new sponsor must be the same employee’s assignment.',
        ),
      );
    }
    if (assignment.id === existing.employmentAssignmentId) {
      throw new BadRequestException(
        domainError(
          400,
          'BENEFIT_TRANSFER_SAME_ASSIGNMENT',
          'The election is already sponsored by this assignment.',
        ),
      );
    }
    const from = parseDateOnly(input.effectiveDate, 'effectiveDate');
    return this.prisma.$transaction(async (tx) => {
      await sharePlan(tx, existing.planId);
      await lockEmployee(tx, existing.employeeId);
      const current = await this.liveSegment(tx, enrollmentId);
      await this.assertCurrentOrFuture(tx, current);
      this.assertSplitDate(current, from);
      const plan = await this.liveRatePlan(tx, current.planId);
      if (plan.organizationId !== assignment.position.organizationId) {
        throw new BadRequestException(
          domainError(
            400,
            'BENEFIT_PLAN_OTHER_ORGANIZATION',
            'The new sponsor is in another organization.',
          ),
        );
      }
      this.assertCoverageInside(plan, assignment, {
        from,
        to: current.coverageEnd,
      });
      // Batch 7C (C3): the new sponsor's own eligibility on the date (a fresh override).
      const override = await this.assertEligible(
        tx,
        {
          employmentAssignmentId: assignment.id,
          planId: current.planId,
          coverageStart: input.effectiveDate,
          eligibilityOverrideReason: input.eligibilityOverrideReason ?? null,
        },
        from,
      );
      await tx.benefitEnrollment.update({
        where: { id: current.id },
        // The recorded end (and its reason) moves to the continuation below.
        data: { coverageEnd: addDays(from, -1), endReason: null },
      });
      const row = await tx.benefitEnrollment.create({
        data: {
          employeeId: current.employeeId,
          employmentAssignmentId: assignment.id,
          organizationId: current.organizationId,
          planId: current.planId,
          optionId: current.optionId,
          electionType: current.electionType,
          recordType: 'CHANGE',
          coverageStart: from,
          coverageEnd: current.coverageEnd,
          endReason: current.endReason,
          electedOn: current.electedOn,
          reason: note(input.reason, 'reason'),
          eligibilityOverrideReason: override,
          createdByUserId: context.actorUserId ?? null,
        },
      });
      if (current.dependents.length > 0) {
        await tx.benefitEnrollmentDependent.createMany({
          data: current.dependents.map((link) => ({
            enrollmentId: row.id,
            employeeId: current.employeeId,
            dependentId: link.dependentId,
          })),
        });
      }
      await writeBenefitsAudit(this.audit, tx, {
        action: 'BENEFIT_ELECTION_TRANSFERRED',
        entityType: 'BenefitEnrollment',
        entityId: row.id,
        context,
        metadata: {
          ...this.auditOf(row, current.dependents.length),
          previousEnrollmentId: current.id,
          previousAssignmentId: current.employmentAssignmentId,
        },
      });
      return this.reload(tx, row.id);
    });
  }

  /**
   * Fixes a mis-recorded election (any of its terms): the segment is superseded and a
   * CORRECTION replaces it, with a required reason. Nothing is rewritten: the wrong record stays
   * readable. Payroll already finalized over these dates is never touched; it shows as stale.
   */
  async correct(
    enrollmentId: string,
    input: {
      reason: string;
      optionId?: string | null;
      dependentIds?: string[];
      coverageStart?: string;
      coverageEnd?: string | null;
      electedOn?: string;
      employmentAssignmentId?: string;
      eligibilityOverrideReason?: string | null;
    },
    context: BenefitsRequestContext,
  ) {
    const reason = note(input.reason, 'reason');
    if (!reason) {
      throw new BadRequestException(
        domainError(
          400,
          'BENEFIT_REASON_REQUIRED',
          'A correction needs a reason.',
        ),
      );
    }
    const existing = await this.segmentOrThrow(enrollmentId);
    await this.access.requireManage(
      context.actorUserId!,
      existing.employmentAssignmentId,
      this.prisma,
      'Benefit election not found.',
    );
    const sponsorId =
      input.employmentAssignmentId ?? existing.employmentAssignmentId;
    const { assignment } = await this.access.requireManage(
      context.actorUserId!,
      sponsorId,
    );
    if (assignment.employeeId !== existing.employeeId) {
      throw new BadRequestException(
        domainError(
          400,
          'BENEFIT_TRANSFER_OTHER_EMPLOYEE',
          'The sponsor must be the same employee’s assignment.',
        ),
      );
    }
    return this.prisma.$transaction(async (tx) => {
      await sharePlan(tx, existing.planId);
      await lockEmployee(tx, existing.employeeId);
      const current = await this.liveSegment(tx, enrollmentId);
      const plan = await this.liveRatePlan(tx, current.planId);
      const range = parseBenefitRange(
        input.coverageStart ?? formatDate(current.coverageStart),
        input.coverageEnd === undefined
          ? isoDate(current.coverageEnd)
          : input.coverageEnd,
        { from: 'coverageStart', to: 'coverageEnd' },
      );
      if (plan.organizationId !== assignment.position.organizationId) {
        throw new BadRequestException(
          domainError(
            400,
            'BENEFIT_PLAN_OTHER_ORGANIZATION',
            'The sponsor is in another organization.',
          ),
        );
      }
      this.assertCoverageInside(plan, assignment, range);
      const optionId =
        current.electionType === 'WAIVED'
          ? (input.optionId ?? null)
          : input.optionId === undefined
            ? current.optionId
            : input.optionId;
      let dependentIds: string[] = [];
      if (optionId) {
        const option = await this.electableOption(tx, plan.id, optionId);
        dependentIds =
          input.dependentIds ??
          current.dependents.map((link) => link.dependentId);
        const dependents = await this.validDependents(
          tx,
          current.employeeId,
          dependentIds,
          plan.dependentChildMaxAge,
          range.from,
        );
        assertCoverageMatchesDependents(
          option.coverageLevel,
          dependents.map((dependent) => dependent.relationship),
        );
        await this.assertRate(tx, option.id, range.from);
      } else if ((input.dependentIds ?? []).length > 0) {
        throw new BadRequestException(
          domainError(
            400,
            'BENEFIT_DEPENDENTS_MISMATCH',
            'A waiver covers no dependents.',
          ),
        );
      }
      const override = await this.assertEligible(
        tx,
        {
          employmentAssignmentId: assignment.id,
          planId: current.planId,
          coverageStart: formatDate(range.from),
          // Batch 7C (C3): a fresh reason, never the superseded record's.
          eligibilityOverrideReason: input.eligibilityOverrideReason ?? null,
        },
        range.from,
      );
      await this.assertNoOverlap(
        tx,
        current.employeeId,
        current.planId,
        range,
        [current.id],
        () =>
          this.readableAssignments(context.actorUserId, current.employeeId, tx),
      );
      await tx.benefitEnrollment.update({
        where: { id: current.id },
        data: { supersededAt: this.clock.now(), supersessionReason: reason },
      });
      const row = await tx.benefitEnrollment.create({
        data: {
          employeeId: current.employeeId,
          employmentAssignmentId: assignment.id,
          organizationId: current.organizationId,
          planId: current.planId,
          optionId,
          electionType: optionId ? 'ENROLLED' : 'WAIVED',
          recordType: 'CORRECTION',
          supersedesEnrollmentId: current.id,
          coverageStart: range.from,
          coverageEnd: range.to,
          // The same end keeps its recorded reason; a corrected end is explained by the reason.
          endReason:
            range.to &&
            current.coverageEnd &&
            range.to.getTime() === current.coverageEnd.getTime()
              ? current.endReason
              : null,
          electedOn: input.electedOn
            ? parseDateOnly(input.electedOn, 'electedOn')
            : current.electedOn,
          reason,
          eligibilityOverrideReason: override,
          createdByUserId: context.actorUserId ?? null,
        },
      });
      if (optionId && dependentIds.length > 0) {
        await tx.benefitEnrollmentDependent.createMany({
          data: [...new Set(dependentIds)].map((dependentId) => ({
            enrollmentId: row.id,
            employeeId: current.employeeId,
            dependentId,
          })),
        });
      }
      await writeBenefitsAudit(this.audit, tx, {
        action: 'BENEFIT_ELECTION_CORRECTED',
        entityType: 'BenefitEnrollment',
        entityId: row.id,
        context,
        metadata: {
          before: this.auditOf(current, current.dependents.length),
          after: this.auditOf(row, optionId ? new Set(dependentIds).size : 0),
          supersededEnrollmentId: current.id,
          // Batch 7C (C1): the reason stays on the records (reason, supersessionReason).
          reasonProvided: true,
        },
      });
      return this.reload(tx, row.id);
    });
  }

  /** Withdraws a mis-recorded election entirely (no replacement); it stays as history. */
  async rescind(
    enrollmentId: string,
    input: { reason: string },
    context: BenefitsRequestContext,
  ) {
    const reason = note(input.reason, 'reason');
    if (!reason) {
      throw new BadRequestException(
        domainError(
          400,
          'BENEFIT_REASON_REQUIRED',
          'Rescinding an election needs a reason.',
        ),
      );
    }
    const existing = await this.segmentOrThrow(enrollmentId);
    await this.access.requireManage(
      context.actorUserId!,
      existing.employmentAssignmentId,
      this.prisma,
      'Benefit election not found.',
    );
    return this.prisma.$transaction(async (tx) => {
      await sharePlan(tx, existing.planId);
      await lockEmployee(tx, existing.employeeId);
      const current = await this.liveSegment(tx, enrollmentId);
      await tx.benefitEnrollment.update({
        where: { id: current.id },
        data: { supersededAt: this.clock.now(), supersessionReason: reason },
      });
      await writeBenefitsAudit(this.audit, tx, {
        action: 'BENEFIT_ELECTION_RESCINDED',
        entityType: 'BenefitEnrollment',
        entityId: current.id,
        context,
        metadata: {
          ...this.auditOf(current, current.dependents.length),
          // Phase 19: the reason stays on the election (supersessionReason), not in the audit.
          withReason: true,
        },
      });
      return this.reload(tx, current.id);
    });
  }

  /**
   * Ends a plan on a date (benefit.plan.manage). Elections and rates reaching past the date
   * stop with the plan when `endElections` is set (elections starting after it are rescinded,
   * rates starting after it superseded); otherwise the end is refused while any remain.
   */
  async discontinuePlan(
    planId: string,
    input: { effectiveTo: string; endElections: boolean; reason: string },
    context: BenefitsRequestContext,
  ) {
    const reason = note(input.reason, 'reason');
    if (!reason) {
      throw new BadRequestException(
        domainError(
          400,
          'BENEFIT_REASON_REQUIRED',
          'Discontinuing a plan needs a reason.',
        ),
      );
    }
    const plan = await this.prisma.benefitPlan.findUnique({
      where: { id: planId },
    });
    if (!plan) throw new NotFoundException('Benefit plan not found.');
    await this.access.requirePlanManage(
      context.actorUserId,
      plan.organizationId,
      this.prisma,
      'Benefit plan not found.',
    );
    const end = parseDateOnly(input.effectiveTo, 'effectiveTo');
    return this.prisma.$transaction(
      async (tx) => {
        await lockPlan(tx, planId);
        const current = await tx.benefitPlan.findUniqueOrThrow({
          where: { id: planId },
        });
        if (
          end < current.effectiveFrom ||
          (current.effectiveTo && end >= current.effectiveTo)
        ) {
          throw new BadRequestException(
            domainError(
              400,
              'BENEFIT_PLAN_END_INVALID',
              'A plan can only be ended earlier, on or after its start.',
            ),
          );
        }
        const beyond = await tx.benefitEnrollment.findMany({
          where: {
            planId,
            supersededAt: null,
            OR: [{ coverageEnd: null }, { coverageEnd: { gt: end } }],
          },
          orderBy: [{ employeeId: 'asc' }, { coverageStart: 'asc' }],
        });
        if (beyond.length > 0 && !input.endElections) {
          throw new ConflictException(
            domainError(
              409,
              'BENEFIT_PLAN_HAS_COVERAGE',
              'Elections continue past the date; end them first or end them with the plan.',
              { elections: beyond.length },
            ),
          );
        }
        // Batch 7C (C6): nobody ends their own coverage through a plan-wide action; another
        // authorized administrator does it.
        const own = await this.access.employeeIdOfUser(
          context.actorUserId!,
          tx,
        );
        if (own && beyond.some((row) => row.employeeId === own)) {
          throw new ForbiddenException(
            domainError(
              403,
              'BENEFIT_SELF_MANAGEMENT',
              'This would end your own coverage; ask another benefits administrator.',
            ),
          );
        }
        let ended = 0;
        let rescinded = 0;
        for (const row of beyond) {
          await lockEmployee(tx, row.employeeId);
          if (row.coverageStart > end) {
            await tx.benefitEnrollment.update({
              where: { id: row.id },
              data: {
                supersededAt: this.clock.now(),
                supersessionReason: `Plan discontinued: ${reason}`,
              },
            });
            rescinded += 1;
            await this.discontinuedAudit(
              tx,
              row,
              planId,
              'RESCINDED',
              end,
              context,
            );
          } else {
            await tx.benefitEnrollment.update({
              where: { id: row.id },
              data: {
                coverageEnd: end,
                // A reason already recorded (e.g. a life event) is kept.
                endReason: row.endReason ?? `Plan discontinued: ${reason}`,
              },
            });
            ended += 1;
            await this.discontinuedAudit(
              tx,
              row,
              planId,
              'ENDED',
              end,
              context,
            );
          }
        }
        const rates = await tx.benefitRate.findMany({
          where: {
            planId,
            supersededAt: null,
            OR: [{ effectiveTo: null }, { effectiveTo: { gt: end } }],
          },
        });
        for (const rate of rates) {
          await tx.benefitRate.update({
            where: { id: rate.id },
            data:
              rate.effectiveFrom > end
                ? { supersededAt: this.clock.now() }
                : { effectiveTo: end },
          });
        }
        await tx.benefitEligibilityRule.updateMany({
          where: {
            planId,
            effectiveFrom: { lte: end },
            OR: [{ effectiveTo: null }, { effectiveTo: { gt: end } }],
          },
          data: { effectiveTo: end },
        });
        await tx.benefitPlan.update({
          where: { id: planId },
          data: { effectiveTo: end },
        });
        await writeBenefitsAudit(this.audit, tx, {
          action: 'BENEFIT_PLAN_DISCONTINUED',
          entityType: 'BenefitPlan',
          entityId: planId,
          context,
          metadata: {
            previousEffectiveTo: isoDate(current.effectiveTo),
            effectiveTo: formatDate(end),
            electionsEnded: ended,
            electionsRescinded: rescinded,
            ratesClosed: rates.length,
            // Batch 7C (C1): kept on the elections it ended or rescinded, not here.
            reasonProvided: true,
          },
        });
        return {
          planId,
          effectiveTo: formatDate(end),
          electionsEnded: ended,
          electionsRescinded: rescinded,
        };
      },
      { timeout: 120_000 },
    );
  }

  /**
   * Elections needing a person's attention in an organization (benefit.read scope): coverage
   * past the sponsoring assignment, lost eligibility, a dependent no longer eligible, no rate,
   * or a sponsor no pay group pays. Benefits never resolves these by itself.
   */
  async attention(userId: string, organizationId: string) {
    if (!(await this.access.hasAnyInOrganization(userId, organizationId))) {
      throw permissionRequired(
        'Missing benefit permissions for the organization.',
      );
    }
    await this.access.requireEnabled(organizationId);
    const grants = await this.access.grants(userId);
    const rows = await this.prisma.benefitEnrollment.findMany({
      where: { organizationId, supersededAt: null, electionType: 'ENROLLED' },
      include: {
        ...ENROLLMENT_INCLUDE,
        employmentAssignment: {
          include: {
            ...ENROLLMENT_INCLUDE.employmentAssignment.include,
            employee: {
              select: {
                id: true,
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
      orderBy: [{ coverageStart: 'asc' }],
    });
    const placements = await this.prisma.position.findMany({
      where: {
        id: {
          in: [
            ...new Set(rows.map((row) => row.employmentAssignment.position.id)),
          ],
        },
      },
    });
    const targets = await positionTargets(this.prisma, placements);
    const items = [];
    // Phase 19: a hard safety cap (each row evaluates eligibility); `truncated` tells the UI.
    let truncated = false;
    for (const row of rows) {
      if (items.length >= ATTENTION_LIMIT) {
        truncated = true;
        break;
      }
      const target = targets.get(row.employmentAssignment.position.id)!;
      if (
        !this.access.can(grants, 'benefit.read', target) &&
        !this.access.can(grants, 'benefit.manage', target)
      )
        continue;
      const today = this.todayOf(row);
      if (row.coverageEnd && row.coverageEnd < today) continue;
      const flags = await this.flags(this.prisma, row, today);
      if (flags.length === 0) continue;
      const person = row.employmentAssignment.employee.person;
      items.push({
        enrollmentId: row.id,
        employeeId: row.employeeId,
        employeeNumber: row.employmentAssignment.employee.employeeNumber,
        displayName: [person.preferredName ?? person.firstName, person.lastName]
          .filter(Boolean)
          .join(' '),
        plan: { id: row.plan.id, code: row.plan.code, name: row.plan.name },
        coverageStart: formatDate(row.coverageStart),
        coverageEnd: isoDate(row.coverageEnd),
        flags,
      });
    }
    return { items, truncated };
  }

  /** What needs a person's attention about a current or future enrolled segment. */
  async flags(client: BenefitsClient, row: EnrollmentRow, today: Date) {
    if (row.supersededAt || row.electionType !== 'ENROLLED') return [];
    if (row.coverageEnd && row.coverageEnd < today) return [];
    const on = row.coverageStart > today ? row.coverageStart : today;
    const flags: string[] = [];
    const assignment = row.employmentAssignment;
    if (
      assignment.status === 'CANCELLED' ||
      (assignment.endDate &&
        (!row.coverageEnd || row.coverageEnd > assignment.endDate))
    ) {
      flags.push('SPONSOR_ASSIGNMENT_ENDED');
    }
    if (!row.eligibilityOverrideReason) {
      const eligibility = await this.eligibility.evaluate(
        client,
        row.employmentAssignmentId,
        row.planId,
        on,
      );
      if (
        !eligibility.eligible &&
        !flags.includes('SPONSOR_ASSIGNMENT_ENDED')
      ) {
        flags.push('ELIGIBILITY_LOST');
      }
    }
    if (
      row.dependents.some(
        (link) =>
          link.dependent.archivedAt ||
          !dependentEligibleOn(
            link.dependent,
            on,
            row.plan.dependentChildMaxAge,
          ),
      )
    ) {
      flags.push('DEPENDENT_INELIGIBLE');
    }
    if (row.optionId && !(await this.rateOn(client, row.optionId, on))) {
      flags.push('RATE_MISSING');
    }
    // Payroll deducts a benefit only in the run paying its sponsoring assignment: a sponsor
    // without compensation in a pay group would never be charged.
    if (!flags.includes('SPONSOR_ASSIGNMENT_ENDED')) {
      const paid = await client.compensationRecord.count({
        where: {
          employmentAssignmentId: row.employmentAssignmentId,
          supersededAt: null,
          payGroupId: { not: null },
          effectiveFrom: { lte: on },
          OR: [{ effectiveTo: null }, { effectiveTo: { gte: on } }],
        },
      });
      if (paid === 0) flags.push('SPONSOR_NOT_ON_PAYROLL');
    }
    return flags;
  }

  private async segmentOrThrow(id: string) {
    const row = await this.prisma.benefitEnrollment.findUnique({
      where: { id },
    });
    if (!row) throw new NotFoundException('Benefit election not found.');
    return row;
  }

  private async liveSegment(tx: Tx, id: string) {
    const row = await tx.benefitEnrollment.findUniqueOrThrow({
      where: { id },
      include: { dependents: true },
    });
    if (row.supersededAt) {
      throw new ConflictException(
        domainError(
          409,
          'BENEFIT_ELECTION_SUPERSEDED',
          'The election was superseded; act on its replacement.',
        ),
      );
    }
    return row;
  }

  /**
   * Batch 7C (C5): change, end and transfer act on coverage that is current or in the future
   * (in the sponsor's local today). A segment that already ended is history: it is fixed only
   * through the correction workflow, with its reason.
   */
  private async assertCurrentOrFuture(
    tx: Tx,
    current: { coverageEnd: Date | null; employmentAssignmentId: string },
  ) {
    if (!current.coverageEnd) return;
    const sponsor = await tx.employmentAssignment.findUniqueOrThrow({
      where: { id: current.employmentAssignmentId },
      select: {
        position: {
          select: {
            workLocation: { select: { timezone: true } },
            organization: { select: { timezone: true } },
          },
        },
      },
    });
    const { today } = benefitsToday(
      this.clock.now(),
      sponsor.position.workLocation?.timezone,
      sponsor.position.organization.timezone,
    );
    if (current.coverageEnd < today) {
      throw new ConflictException(
        domainError(
          409,
          'BENEFIT_ELECTION_HISTORICAL',
          'This coverage has already ended; fix past coverage with a correction.',
        ),
      );
    }
  }

  /** A plan that may still change existing coverage (active or closed, not archived). */
  private async liveRatePlan(tx: Tx, planId: string) {
    const plan = await tx.benefitPlan.findUniqueOrThrow({
      where: { id: planId },
    });
    if (plan.archivedAt || plan.status === 'DRAFT') {
      throw new ConflictException(
        domainError(
          409,
          'BENEFIT_PLAN_NOT_ACCEPTING',
          // Batch 7C: say which (a draft was reported as archived).
          plan.archivedAt
            ? 'The plan is archived.'
            : 'The plan is still a draft.',
        ),
      );
    }
    return plan;
  }

  private assertSplitDate(
    current: { coverageStart: Date; coverageEnd: Date | null },
    from: Date,
  ) {
    if (from <= current.coverageStart) {
      throw new ConflictException(
        domainError(
          409,
          'BENEFIT_CHANGE_ON_START',
          'A change on or before the election’s start is a correction.',
        ),
      );
    }
    if (current.coverageEnd && from > current.coverageEnd) {
      throw new ConflictException(
        domainError(
          409,
          'BENEFIT_CHANGE_AFTER_END',
          'The election has ended by that date.',
        ),
      );
    }
  }

  // ─── Reads ─────────────────────────────────────────────────────────────────

  /**
   * An employee's elections visible to the reader (those sponsored by assignments in their
   * benefit.read scope), with costs on the reference date and the superseded history.
   */
  async employee(userId: string, employeeId: string, asOf?: string) {
    const access = await this.access.employeeAccess(userId, employeeId);
    const readable = new Map(
      access.assignments
        .filter((row) => row.canRead)
        .map((row) => [row.assignment.id, row]),
    );
    const rows = await this.prisma.benefitEnrollment.findMany({
      where: {
        employeeId,
        employmentAssignmentId: { in: [...readable.keys()] },
      },
      include: ENROLLMENT_INCLUDE,
      orderBy: [{ coverageStart: 'desc' }, { createdAt: 'desc' }],
    });
    const items = [];
    for (const row of rows) {
      const today = this.todayOf(row);
      const on = asOf ? parseDateOnly(asOf, 'asOf') : today;
      items.push({
        // Batch 7C (C6): someone reading their own elections through the administrative path
        // sees them as self-service does — no HR notes or reasons (they never administer them).
        ...(await this.shape(
          this.prisma,
          row,
          today,
          on,
          access.isSelf ? 'self' : 'admin',
        )),
        flags: await this.flags(this.prisma, row, today),
        actions: this.actions(
          row,
          today,
          readable.get(row.employmentAssignmentId)!.canManage,
          // Batch 7C (B13): another live assignment in the plan's organization to move to.
          access.assignments.some(
            (other) =>
              other.canManage &&
              other.assignment.id !== row.employmentAssignmentId &&
              other.assignment.status !== 'CANCELLED' &&
              other.target.organizationId === row.organizationId,
          ),
        ),
      });
    }
    const person = access.assignments[0]!.assignment.employee.person;
    return {
      employeeId,
      // Batch 7C: who this is (the Benefits employee page needs no employee.read).
      employee: {
        displayName: [person.preferredName ?? person.firstName, person.lastName]
          .filter(Boolean)
          .join(' '),
        employeeNumber:
          access.assignments[0]!.assignment.employee.employeeNumber,
      },
      canManage: access.assignments.some((row) => row.canManage),
      sponsoringAssignments: access.assignments
        .filter((row) => row.canManage)
        .map((row) => ({
          id: row.assignment.id,
          positionName: row.assignment.position.name,
          organizationId: row.assignment.position.organizationId,
          status: row.assignment.status,
          startDate: formatDate(row.assignment.startDate),
          endDate: isoDate(row.assignment.endDate),
        })),
      items,
    };
  }

  /** Self-service "My Benefits": one's own current, future and past elections (read-only). */
  async mine(userId: string) {
    const employeeId = await this.access.employeeIdOfUser(userId);
    if (!employeeId) {
      throw new ForbiddenException(
        domainError(
          403,
          'BENEFIT_NOT_AN_EMPLOYEE',
          'Your account is not linked to an employee.',
        ),
      );
    }
    const rows = await this.prisma.benefitEnrollment.findMany({
      where: {
        employeeId,
        supersededAt: null,
        organizationId: { notIn: await this.access.disabledOrganizations() },
      },
      include: ENROLLMENT_INCLUDE,
      orderBy: [{ coverageStart: 'desc' }, { createdAt: 'desc' }],
    });
    const items = [];
    for (const row of rows) {
      const today = this.todayOf(row);
      items.push(await this.shape(this.prisma, row, today, today, 'self'));
    }
    return { employeeId, items };
  }

  // ─── Shared helpers (used by the lifecycle operations too) ──────────────────

  async electablePlan(
    tx: Tx,
    planId: string,
    organizationId: string,
    userId?: string,
  ) {
    const plan = await tx.benefitPlan.findUnique({ where: { id: planId } });
    if (!plan) throw new NotFoundException('Benefit plan not found.');
    if (plan.organizationId !== organizationId) {
      // Batch 7C (B1): a plan of an organization the caller has nothing to do with is missing.
      if (userId)
        await this.access.notFoundOutside(
          userId,
          plan.organizationId,
          'Benefit plan not found.',
          tx,
        );
      throw new BadRequestException(
        domainError(
          400,
          'BENEFIT_PLAN_OTHER_ORGANIZATION',
          'The plan belongs to another organization than the sponsoring assignment.',
        ),
      );
    }
    if (plan.archivedAt || plan.status !== 'ACTIVE') {
      throw new ConflictException(
        domainError(
          409,
          'BENEFIT_PLAN_NOT_ACCEPTING',
          // Batch 7C: which state it is in.
          plan.archivedAt
            ? 'The plan is archived.'
            : plan.status === 'DRAFT'
              ? 'The plan is still a draft; activate it before recording elections.'
              : 'The plan is closed to new elections.',
        ),
      );
    }
    return plan;
  }

  async electableOption(tx: Tx, planId: string, optionId: string) {
    const option = await tx.benefitCoverageOption.findUnique({
      where: { id: optionId },
    });
    if (!option || option.planId !== planId) {
      throw new NotFoundException('Coverage option not found in the plan.');
    }
    if (option.archivedAt) {
      throw new ConflictException(
        domainError(
          409,
          'BENEFIT_ARCHIVED',
          'The coverage option is archived.',
        ),
      );
    }
    return option;
  }

  assertCoverageInside(
    plan: { effectiveFrom: Date; effectiveTo: Date | null },
    assignment: { status: string; startDate: Date; endDate: Date | null },
    range: DateRange,
  ) {
    if (
      !rangeContains({ from: plan.effectiveFrom, to: plan.effectiveTo }, range)
    ) {
      throw new ConflictException(
        domainError(
          409,
          'BENEFIT_COVERAGE_OUTSIDE_PLAN',
          'Coverage must stay within the plan’s effective dates (end it with the plan).',
        ),
      );
    }
    if (
      assignment.status === 'CANCELLED' ||
      !rangeContains(
        { from: assignment.startDate, to: assignment.endDate },
        range,
      )
    ) {
      throw new ConflictException(
        domainError(
          409,
          'BENEFIT_COVERAGE_OUTSIDE_ASSIGNMENT',
          'Coverage must stay within the sponsoring assignment’s dates.',
        ),
      );
    }
  }

  /** Returns the override reason to store (null when eligible). */
  async assertEligible(tx: Tx, input: ElectionInput, date: Date) {
    const override = note(
      input.eligibilityOverrideReason,
      'eligibilityOverrideReason',
    );
    const result = await this.eligibility.evaluate(
      tx,
      input.employmentAssignmentId,
      input.planId,
      date,
    );
    if (result.eligible) return null;
    if (!override) {
      throw new ConflictException(
        domainError(
          409,
          'BENEFIT_NOT_ELIGIBLE',
          'The assignment is not eligible for the plan on the coverage start; give an override reason to elect anyway.',
          { reasons: result.reasons, rules: result.rules },
        ),
      );
    }
    return override;
  }

  async validDependents(
    tx: Tx,
    employeeId: string,
    dependentIds: readonly string[],
    childMaxAge: number | null,
    date: Date,
  ) {
    const ids = [...new Set(dependentIds)];
    const rows = ids.length
      ? await tx.benefitDependent.findMany({ where: { id: { in: ids } } })
      : [];
    if (
      rows.length !== ids.length ||
      rows.some((row) => row.employeeId !== employeeId)
    ) {
      throw new BadRequestException(
        domainError(
          400,
          'BENEFIT_DEPENDENT_NOT_FOUND',
          "A dependent is not one of the employee's.",
        ),
      );
    }
    const archived = rows.filter((row) => row.archivedAt);
    const ineligible = rows.filter(
      (row) => !dependentEligibleOn(row, date, childMaxAge),
    );
    if (archived.length > 0 || ineligible.length > 0) {
      throw new ConflictException(
        domainError(
          409,
          'BENEFIT_DEPENDENT_INELIGIBLE',
          'A dependent cannot be covered on the coverage start (archived, relationship not in effect, or over the child age limit).',
          { dependentIds: [...archived, ...ineligible].map((row) => row.id) },
        ),
      );
    }
    return rows;
  }

  async assertRate(tx: Tx, optionId: string, date: Date) {
    const rate = await this.rateOn(tx, optionId, date);
    if (!rate) {
      throw new ConflictException(
        domainError(
          409,
          'BENEFIT_RATE_MISSING',
          'The coverage option has no rate on the coverage start; add one first.',
        ),
      );
    }
    return rate;
  }

  rateOn(client: BenefitsClient, optionId: string, date: Date) {
    return client.benefitRate.findFirst({
      where: {
        optionId,
        supersededAt: null,
        effectiveFrom: { lte: date },
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: date } }],
      },
    });
  }

  async assertNoOverlap(
    tx: Tx,
    employeeId: string,
    planId: string,
    range: DateRange,
    excludeIds: readonly string[],
    /** Batch 7C (B10): the conflicting election is named only to someone who may read it. */
    visible: () => Promise<ReadonlySet<string>> = async () => new Set(),
  ) {
    const others = await tx.benefitEnrollment.findMany({
      where: {
        employeeId,
        planId,
        supersededAt: null,
        id: { notIn: [...excludeIds] },
      },
    });
    const clash = others.find((other) =>
      rangesOverlap(
        { from: other.coverageStart, to: other.coverageEnd },
        range,
      ),
    );
    if (clash) {
      throw new ConflictException(
        domainError(
          409,
          'BENEFIT_ELECTION_OVERLAP',
          'The employee already has an election for this plan on these dates (through any assignment); change or end it instead.',
          (await visible()).has(clash.employmentAssignmentId)
            ? {
                enrollmentId: clash.id,
                coverageStart: formatDate(clash.coverageStart),
                coverageEnd: isoDate(clash.coverageEnd),
              }
            : {},
        ),
      );
    }
  }

  /** Batch 7C: a rescinded election (superseded with no replacement) is no history. */
  async hasHistory(tx: Tx, employeeId: string, planId: string) {
    return (
      (await tx.benefitEnrollment.count({
        where: { employeeId, planId, supersededAt: null },
      })) > 0
    );
  }

  /** The employee's assignments the user reads benefits through (none when refused). */
  async readableAssignments(
    userId: string | undefined,
    employeeId: string,
    client: BenefitsClient = this.prisma,
  ) {
    if (!userId) return new Set<string>();
    try {
      const access = await this.access.employeeAccess(
        userId,
        employeeId,
        client,
      );
      return new Set(
        access.assignments
          .filter((row) => row.canRead)
          .map((row) => row.assignment.id),
      );
    } catch {
      return new Set<string>();
    }
  }

  electedOn(
    input: { electedOn?: string | null },
    assignment: {
      position: {
        workLocation: { timezone: string | null } | null;
        organization: { timezone: string | null };
      };
    },
  ) {
    return input.electedOn
      ? parseDateOnly(input.electedOn, 'electedOn')
      : benefitsToday(
          this.clock.now(),
          assignment.position.workLocation?.timezone,
          assignment.position.organization.timezone,
        ).today;
  }

  todayOf(row: EnrollmentRow) {
    return benefitsToday(
      this.clock.now(),
      row.employmentAssignment.position.workLocation?.timezone,
      row.employmentAssignment.position.organization.timezone,
    ).today;
  }

  async reload(client: BenefitsClient, id: string) {
    const row = await client.benefitEnrollment.findUniqueOrThrow({
      where: { id },
      include: ENROLLMENT_INCLUDE,
    });
    const today = this.todayOf(row);
    return this.shape(client, row, today, today, 'admin');
  }

  /**
   * Batch 8: one audit entry per election a plan discontinuation ended or rescinded, so each
   * affected employee's change is a durable record the notification producer reads. Ids and
   * dates only (the reason stays on the election).
   */
  private discontinuedAudit(
    tx: Prisma.TransactionClient,
    row: { id: string; employeeId: string; employmentAssignmentId: string },
    planId: string,
    outcome: 'ENDED' | 'RESCINDED',
    end: Date,
    context: BenefitsRequestContext,
  ) {
    return writeBenefitsAudit(this.audit, tx, {
      action: 'BENEFIT_ELECTION_DISCONTINUED',
      entityType: 'BenefitEnrollment',
      entityId: row.id,
      context,
      metadata: {
        employeeId: row.employeeId,
        employmentAssignmentId: row.employmentAssignmentId,
        planId,
        outcome,
        effectiveTo: formatDate(end),
        reasonProvided: true,
      },
    });
  }

  auditOf(
    row: {
      employeeId: string;
      employmentAssignmentId: string;
      planId: string;
      optionId: string | null;
      electionType: string;
      recordType: string;
      coverageStart: Date;
      coverageEnd: Date | null;
      eligibilityOverrideReason: string | null;
    },
    dependentCount: number,
  ) {
    return {
      employeeId: row.employeeId,
      employmentAssignmentId: row.employmentAssignmentId,
      planId: row.planId,
      optionId: row.optionId,
      electionType: row.electionType,
      recordType: row.recordType,
      coverageStart: formatDate(row.coverageStart),
      coverageEnd: isoDate(row.coverageEnd),
      dependentCount,
      eligibilityOverride: row.eligibilityOverrideReason !== null,
    };
  }

  /**
   * What the reader may do, as the service accepts it (Batch 7C, B13): change, end and
   * transfer on current or future coverage of a plan still in use; correction while the plan,
   * option and covered dependents are not archived; transfer only when there is another
   * assignment to move to.
   */
  actions(
    row: EnrollmentRow,
    today: Date,
    canManage: boolean,
    hasTransferTarget = false,
  ) {
    const live = canManage && !row.supersededAt;
    const notEnded = !row.coverageEnd || row.coverageEnd >= today;
    const planInUse = !row.plan.archivedAt && row.plan.status !== 'DRAFT';
    const termsCurrent =
      planInUse &&
      !row.option?.archivedAt &&
      !row.dependents.some((link) => link.dependent.archivedAt);
    return {
      canChange:
        live &&
        row.electionType === 'ENROLLED' &&
        notEnded &&
        planInUse &&
        !row.option?.archivedAt,
      canEnd: live && notEnded,
      canTransfer: live && notEnded && planInUse && hasTransferTarget,
      canCorrect: live && termsCurrent,
      canRescind: live,
    };
  }

  /**
   * One segment as a reader sees it. The cost is the rate in effect on the reference date (or
   * on the coverage start for future coverage). Self-service hides HR notes and the employer
   * cost when the plan does not show it.
   */
  async shape(
    client: BenefitsClient,
    row: EnrollmentRow,
    today: Date,
    on: Date,
    audience: 'admin' | 'self',
  ) {
    const status = enrollmentStatusOn(row, today);
    const costDate = on < row.coverageStart ? row.coverageStart : on;
    const rate =
      row.optionId && (!row.coverageEnd || costDate <= row.coverageEnd)
        ? await this.rateOn(client, row.optionId, costDate)
        : null;
    const showEmployer =
      audience === 'admin' || row.plan.showEmployerCostToEmployee;
    return {
      id: row.id,
      status,
      electionType: row.electionType,
      recordType: row.recordType,
      plan: {
        id: row.plan.id,
        code: row.plan.code,
        name: row.plan.name,
        benefitType: row.plan.benefitType,
        providerName: row.plan.providerName,
        currency: row.plan.currency,
      },
      option: row.option
        ? {
            id: row.option.id,
            code: row.option.code,
            name: row.option.name,
            coverageLevel: row.option.coverageLevel,
          }
        : null,
      coverageStart: formatDate(row.coverageStart),
      coverageEnd: isoDate(row.coverageEnd),
      electedOn: formatDate(row.electedOn),
      sponsoringAssignment: {
        id: row.employmentAssignmentId,
        positionName: row.employmentAssignment.position.name,
        organizationName: row.employmentAssignment.position.organization.name,
      },
      dependents: row.dependents.map((link) => ({
        id: link.dependent.id,
        firstName: link.dependent.firstName,
        lastName: link.dependent.lastName,
        relationship: link.dependent.relationship,
      })),
      cost: rate
        ? {
            rateId: rate.id,
            asOf: formatDate(costDate),
            frequency: rate.frequency,
            currency: row.plan.currency,
            employeeAmount: rate.employeeAmount.toFixed(2),
            employerAmount: showEmployer
              ? rate.employerAmount.toFixed(2)
              : null,
          }
        : null,
      ...(audience === 'admin'
        ? {
            reason: row.reason,
            eligibilityOverrideReason: row.eligibilityOverrideReason,
            supersedesEnrollmentId: row.supersedesEnrollmentId,
            supersededAt: row.supersededAt?.toISOString() ?? null,
            supersessionReason: row.supersessionReason,
            endReason: row.endReason,
            createdAt: row.createdAt.toISOString(),
          }
        : {}),
    };
  }
}
