import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service.js';
import { d } from './support/payroll-fixtures.js';
import {
  cycle,
  evidence,
  openCycle,
  orgBAssignment,
  ratingScale,
  review,
  template,
} from './support/performance-fixtures.js';
import {
  createSchedulingFixtures,
  violation,
  type SchedulingFixtures,
  type Tx,
} from './support/scheduling-fixtures.js';

config({ path: '../../.env' });

class RollbackFixtures extends Error {}

/** The database half of the Performance invariants (Phase 12 foundation migration). */
describe('Performance foundation constraints (database)', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService(process.env.DATABASE_URL!);
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  async function scenario(
    run: (tx: Tx, fx: SchedulingFixtures) => Promise<void>,
  ) {
    await expect(
      prisma.$transaction(
        async (tx) => {
          const fx = await createSchedulingFixtures(tx, {});
          await run(tx, fx).catch((error: unknown) => {
            console.error('SCENARIO FAILURE', error);
            throw error;
          });
          throw new RollbackFixtures();
        },
        { timeout: 120_000 },
      ),
    ).rejects.toBeInstanceOf(RollbackFixtures);
  }

  it('freezes active rating scales and templates', async () => {
    await scenario(async (tx, fx) => {
      // A scale needs two levels to activate; active levels never change.
      const thin = await tx.performanceRatingScale.create({
        data: { organizationId: fx.orgA, code: 'THIN', name: 'Thin' },
      });
      await tx.performanceRatingScaleLevel.create({
        data: { scaleId: thin.id, value: 1, label: 'Only' },
      });
      await violation(tx, () =>
        tx.performanceRatingScale.update({
          where: { id: thin.id },
          data: { status: 'ACTIVE' },
        }),
      );
      const scale = await ratingScale(tx, fx);
      await violation(tx, () =>
        tx.performanceRatingScaleLevel.updateMany({
          where: { scaleId: scale.id, value: 3 },
          data: { label: 'Solid' },
        }),
      );
      await violation(tx, () =>
        tx.performanceRatingScaleLevel.create({
          data: { scaleId: scale.id, value: 6, label: 'x' },
        }),
      );
      await violation(tx, () =>
        tx.performanceRatingScale.update({
          where: { id: scale.id },
          data: { status: 'DRAFT' },
        }),
      );
      await violation(tx, () =>
        tx.performanceRatingScale.update({
          where: { id: scale.id },
          data: { code: 'OTHER' },
        }),
      );
      // A template activates only with an active scale and is frozen once active.
      const draftScale = await ratingScale(tx, fx, {
        code: 'DRAFTY',
        activate: false,
      });
      const pending = await template(tx, fx, draftScale.id, {
        code: 'PENDING',
        activate: false,
      });
      await violation(tx, () =>
        tx.performanceTemplate.update({
          where: { id: pending.template.id },
          data: { status: 'ACTIVE' },
        }),
      );
      const {
        template: active,
        section,
        textItem,
      } = await template(tx, fx, scale.id);
      await violation(tx, () =>
        tx.performanceTemplateItem.update({
          where: { id: textItem.id },
          data: { prompt: 'Edited' },
        }),
      );
      await violation(tx, () =>
        tx.performanceTemplateSection.create({
          data: { templateId: active.id, title: 'More', sortOrder: 2 },
        }),
      );
      await violation(tx, () =>
        tx.performanceTemplateItem.delete({ where: { id: textItem.id } }),
      );
      await violation(tx, () =>
        tx.performanceTemplate.update({
          where: { id: active.id },
          data: { scoringMode: 'WEIGHTED_AVERAGE' },
        }),
      );
      await violation(tx, () =>
        tx.performanceTemplate.delete({ where: { id: active.id } }),
      );
      // Item shape: ratings need a scale; weights only on reviewer ratings.
      await violation(tx, () =>
        tx.performanceTemplateItem.create({
          data: {
            templateId: pending.template.id,
            sectionId: pending.section.id,
            organizationId: fx.orgA,
            sortOrder: 9,
            itemType: 'TEXT',
            prompt: 'Weighted text',
            respondent: 'REVIEWER',
            weight: '10',
          },
        }),
      );
      expect(section.title).toBe('Competencies');
      // Archived competencies stay; nothing is deleted.
      const competency = await tx.performanceCompetency.create({
        data: { organizationId: fx.orgA, code: 'COMM', name: 'Communication' },
      });
      await violation(tx, () =>
        tx.performanceCompetency.delete({ where: { id: competency.id } }),
      );
    });
  });

  it('runs cycles forward only and freezes the opened form snapshot', async () => {
    await scenario(async (tx, fx) => {
      const scale = await ratingScale(tx, fx);
      const { template: tpl } = await template(tx, fx, scale.id);
      await violation(tx, () =>
        tx.performanceCycle.create({
          data: {
            organizationId: fx.orgA,
            code: 'BAD-DUE',
            name: 'Bad',
            templateId: tpl.id,
            periodStart: d('2026-01-01'),
            periodEnd: d('2026-12-31'),
            windowStart: d('2026-11-01'),
            windowEnd: d('2026-12-15'),
            // Due before the window opens.
            selfReviewDueDate: d('2026-10-01'),
          },
        }),
      );
      const row = await cycle(tx, fx, tpl.id);
      // Opening requires the snapshot fields.
      await violation(tx, () =>
        tx.performanceCycle.update({
          where: { id: row.id },
          data: { status: 'OPEN', openedAt: new Date() },
        }),
      );
      const { ratingItem } = await openCycle(tx, row.id);
      await violation(tx, () =>
        tx.performanceFormItem.update({
          where: { id: ratingItem.id },
          data: { prompt: 'Edited' },
        }),
      );
      await violation(tx, () =>
        tx.performanceFormSection.create({
          data: { cycleId: row.id, sortOrder: 2, title: 'Late' },
        }),
      );
      await violation(tx, () =>
        tx.performanceCycle.update({
          where: { id: row.id },
          data: { periodEnd: d('2026-11-30') },
        }),
      );
      await violation(tx, () =>
        tx.performanceCycle.update({
          where: { id: row.id },
          data: { status: 'DRAFT' },
        }),
      );
      await violation(tx, () =>
        tx.performanceCycle.delete({ where: { id: row.id } }),
      );
      // Compatible changes while open: extend the window, move due dates within it.
      await tx.performanceCycle.update({
        where: { id: row.id },
        data: { windowEnd: d('2026-12-31'), reviewerDueDate: d('2026-12-20') },
      });
      await tx.performanceCycle.update({
        where: { id: row.id },
        data: { status: 'CLOSED', closedAt: new Date() },
      });
      await violation(tx, () =>
        tx.performanceCycle.update({
          where: { id: row.id },
          data: { windowEnd: d('2027-01-31') },
        }),
      );
    });
  });

  it('keeps one review per cycle and assignment inside the organization', async () => {
    await scenario(async (tx, fx) => {
      const scale = await ratingScale(tx, fx);
      const { template: tpl } = await template(tx, fx, scale.id);
      const row = await cycle(tx, fx, tpl.id);
      const first = await review(tx, fx, row.id);
      await violation(tx, () => review(tx, fx, row.id));
      // The employee's other assignment gets its own review.
      await review(tx, fx, row.id, { assignmentId: fx.assignmentDeptB });
      // Never one's own reviewer; never an assignment of another organization.
      await violation(tx, () =>
        review(tx, fx, row.id, {
          employeeId: fx.employee2,
          assignmentId: fx.otherTeamA,
          reviewerEmployeeId: fx.employee2,
        }),
      );
      const foreign = await orgBAssignment(tx, fx);
      await violation(tx, () =>
        review(tx, fx, row.id, {
          employeeId: fx.employee2,
          assignmentId: foreign,
        }),
      );
      // Removing a review is only possible while the cycle is a draft.
      await tx.performanceReview.delete({ where: { id: first.id } });
      const kept = await review(tx, fx, row.id);
      await openCycle(tx, row.id);
      await violation(tx, () =>
        tx.performanceReview.delete({ where: { id: kept.id } }),
      );
      // Lifecycle is validated.
      await violation(tx, () =>
        tx.performanceReview.update({
          where: { id: kept.id },
          data: { status: 'FINALIZED' },
        }),
      );
      await violation(tx, () =>
        tx.performanceReview.update({
          where: { id: kept.id },
          data: { employmentAssignmentId: fx.assignmentDeptB },
        }),
      );
    });
  });

  it('locks submitted answers and finalized reviews', async () => {
    await scenario(async (tx, fx) => {
      const scale = await ratingScale(tx, fx);
      const { template: tpl } = await template(tx, fx, scale.id);
      const row = await cycle(tx, fx, tpl.id);
      const { ratingItem, textItem } = await openCycle(tx, row.id);
      const rev = await review(tx, fx, row.id);
      // A reviewer-only item is never answered by the employee.
      await violation(tx, () =>
        tx.performanceReviewResponse.create({
          data: {
            reviewId: rev.id,
            cycleId: row.id,
            itemId: ratingItem.id,
            respondent: 'SELF',
          },
        }),
      );
      const draft = await tx.performanceReviewResponse.create({
        data: {
          reviewId: rev.id,
          cycleId: row.id,
          itemId: ratingItem.id,
          respondent: 'REVIEWER',
          ratingValue: 5,
          ratingLabel: 'High',
        },
      });
      // Drafts are edited in place; one current answer per item and respondent.
      await tx.performanceReviewResponse.update({
        where: { id: draft.id },
        data: { ratingValue: 1, ratingLabel: 'Low' },
      });
      await violation(tx, () =>
        tx.performanceReviewResponse.create({
          data: {
            reviewId: rev.id,
            cycleId: row.id,
            itemId: ratingItem.id,
            respondent: 'REVIEWER',
          },
        }),
      );
      const locked = await tx.performanceReviewResponse.update({
        where: { id: draft.id },
        data: { lockedAt: new Date() },
      });
      await violation(tx, () =>
        tx.performanceReviewResponse.update({
          where: { id: locked.id },
          data: { ratingValue: 5 },
        }),
      );
      await violation(tx, () =>
        tx.performanceReviewResponse.delete({ where: { id: locked.id } }),
      );
      const now = new Date();
      await tx.performanceReview.update({
        where: { id: rev.id },
        data: {
          status: 'SUBMITTED',
          reviewerStatus: 'SUBMITTED',
          reviewerSubmittedAt: now,
          selfStatus: 'NOT_SUBMITTED',
        },
      });
      await tx.performanceReview.update({
        where: { id: rev.id },
        data: { status: 'FINALIZED', finalizedAt: now },
      });
      // Finalized: no new original answers, no reviewer change, no draft edits.
      await violation(tx, () =>
        tx.performanceReviewResponse.create({
          data: {
            reviewId: rev.id,
            cycleId: row.id,
            itemId: textItem.id,
            respondent: 'SELF',
            textValue: 'x',
          },
        }),
      );
      await violation(tx, () =>
        tx.performanceReview.update({
          where: { id: rev.id },
          data: { reviewerEmployeeId: null, reviewerSource: null },
        }),
      );
      // A correction supersedes the locked answer.
      await tx.performanceReviewResponse.update({
        where: { id: locked.id },
        data: { supersededAt: now },
      });
      await tx.performanceReviewResponse.create({
        data: {
          reviewId: rev.id,
          cycleId: row.id,
          itemId: ratingItem.id,
          respondent: 'REVIEWER',
          ratingValue: 5,
          ratingLabel: 'High',
          recordType: 'CORRECTION',
          correctionReason: 'Recorded on the wrong level',
          supersedesResponseId: locked.id,
          lockedAt: now,
        },
      });
      // Events are append-only; one current acknowledgement.
      const event = await tx.performanceReviewEvent.create({
        data: { reviewId: rev.id, type: 'CORRECTED', reason: 'Wrong level' },
      });
      await violation(tx, () =>
        tx.performanceReviewEvent.delete({ where: { id: event.id } }),
      );
      const user = await tx.user.findFirstOrThrow({
        where: { id: fx.selfUser1 },
      });
      await tx.performanceReviewAcknowledgement.create({
        data: { reviewId: rev.id, employeeId: fx.employee1, userId: user.id },
      });
      await violation(tx, () =>
        tx.performanceReviewAcknowledgement.create({
          data: { reviewId: rev.id, employeeId: fx.employee1, userId: user.id },
        }),
      );
    });
  });

  it('keeps goals in their assignment and links only same-assignment goals', async () => {
    await scenario(async (tx, fx) => {
      const scale = await ratingScale(tx, fx);
      const { template: tpl } = await template(tx, fx, scale.id);
      const row = await cycle(tx, fx, tpl.id);
      await openCycle(tx, row.id);
      const rev = await review(tx, fx, row.id);
      const goal = (assignmentId: string) =>
        tx.performanceGoal.create({
          data: {
            organizationId: fx.orgA,
            employeeId: fx.employee1,
            employmentAssignmentId: assignmentId,
            title: 'Lead the science fair',
            startDate: d('2026-01-01'),
          },
        });
      const own = await goal(fx.assignmentTeamA);
      const other = await goal(fx.assignmentDeptB);
      await tx.performanceReviewGoal.create({
        data: { reviewId: rev.id, goalId: own.id, employeeId: fx.employee1 },
      });
      await violation(tx, () =>
        tx.performanceReviewGoal.create({
          data: {
            reviewId: rev.id,
            goalId: other.id,
            employeeId: fx.employee1,
          },
        }),
      );
      await violation(tx, () =>
        tx.performanceGoal.update({
          where: { id: own.id },
          data: { progressPercent: 101 },
        }),
      );
      await tx.performanceGoal.update({
        where: { id: own.id },
        data: {
          status: 'COMPLETED',
          completedAt: new Date(),
          progressPercent: 100,
        },
      });
      await violation(tx, () =>
        tx.performanceGoal.update({
          where: { id: own.id },
          data: { title: 'Rewritten' },
        }),
      );
      await violation(tx, () =>
        tx.performanceGoal.delete({ where: { id: other.id } }),
      );
      const foreign = await orgBAssignment(tx, fx);
      await violation(tx, () =>
        tx.performanceGoal.create({
          data: {
            organizationId: fx.orgA,
            employeeId: fx.employee2,
            employmentAssignmentId: foreign,
            title: 'Cross-org',
            startDate: d('2026-01-01'),
          },
        }),
      );
    });
  });

  it('deduplicates external evidence, keeps it immutable and inside its organization', async () => {
    await scenario(async (tx, fx) => {
      const first = await evidence(tx, fx);
      // The same external response twice is one current revision.
      await violation(tx, () => evidence(tx, fx));
      await violation(tx, () =>
        tx.performanceEvidence.update({
          where: { id: first.id },
          data: { score: '18' },
        }),
      );
      await violation(tx, () =>
        tx.performanceEvidence.delete({ where: { id: first.id } }),
      );
      // A correction supersedes the current revision.
      await tx.performanceEvidence.update({
        where: { id: first.id },
        data: { supersededAt: new Date() },
      });
      const corrected = await tx.performanceEvidence.create({
        data: {
          organizationId: fx.orgA,
          employeeId: fx.employee1,
          provider: 'GOOGLE_FORMS',
          kind: 'ASSESSMENT',
          channel: 'SYNC',
          title: 'Code of Conduct quiz',
          externalResourceId: 'form-1',
          externalResultId: 'response-1',
          completedAt: new Date('2026-09-01T10:00:00Z'),
          score: '18',
          maxScore: '20',
          revision: 2,
          supersedesEvidenceId: first.id,
          correctionReason: 'Regraded at the source',
        },
      });
      await violation(tx, () =>
        tx.performanceEvidence.update({
          where: { id: first.id },
          data: { supersededAt: new Date('2030-01-01T00:00:00Z') },
        }),
      );
      // Withdrawal is one-way.
      await tx.performanceEvidence.update({
        where: { id: corrected.id },
        data: {
          status: 'WITHDRAWN',
          withdrawnAt: new Date(),
          withdrawalReason: 'Form deleted',
        },
      });
      await violation(tx, () =>
        tx.performanceEvidence.update({
          where: { id: corrected.id },
          data: { status: 'ACTIVE', withdrawnAt: null, withdrawalReason: null },
        }),
      );
      // Employee 1 has no assignment in organization B.
      await violation(tx, () =>
        evidence(tx, fx, {
          organizationId: fx.orgB,
          externalResultId: 'response-b',
        }),
      );
      await violation(tx, () =>
        evidence(tx, fx, { externalResultId: 'r', score: '21' }),
      );
      // Evidence of organization B never links into an organization A review.
      const foreign = await orgBAssignment(tx, fx);
      const foreignEvidence = await evidence(tx, fx, {
        organizationId: fx.orgB,
        employeeId: fx.employee2,
        assignmentId: foreign,
        externalResultId: 'response-2',
      });
      const scale = await ratingScale(tx, fx);
      const { template: tpl } = await template(tx, fx, scale.id);
      const row = await cycle(tx, fx, tpl.id);
      const { textItem, evidenceItem } = await openCycle(tx, row.id);
      const rev = await review(tx, fx, row.id, {
        employeeId: fx.employee2,
        assignmentId: fx.otherTeamA,
        reviewerEmployeeId: fx.employee1,
      });
      await violation(tx, () =>
        tx.performanceReviewEvidence.create({
          data: {
            reviewId: rev.id,
            evidenceId: foreignEvidence.id,
            employeeId: fx.employee2,
            cycleId: row.id,
          },
        }),
      );
      const own = await evidence(tx, fx, {
        employeeId: fx.employee2,
        externalResultId: 'response-3',
      });
      await violation(tx, () =>
        tx.performanceReviewEvidence.create({
          data: {
            reviewId: rev.id,
            evidenceId: own.id,
            employeeId: fx.employee2,
            cycleId: row.id,
            formItemId: textItem.id,
          },
        }),
      );
      const link = await tx.performanceReviewEvidence.create({
        data: {
          reviewId: rev.id,
          evidenceId: own.id,
          employeeId: fx.employee2,
          cycleId: row.id,
          formItemId: evidenceItem.id,
        },
      });
      await violation(tx, () =>
        tx.performanceReviewEvidence.create({
          data: {
            reviewId: rev.id,
            evidenceId: own.id,
            employeeId: fx.employee2,
            cycleId: row.id,
          },
        }),
      );
      await violation(tx, () =>
        tx.performanceReviewEvidence.delete({ where: { id: link.id } }),
      );
    });
  });

  it('holds unmatched results once per source result and freezes them once resolved', async () => {
    await scenario(async (tx, fx) => {
      const source = await tx.performanceEvidenceSource.create({
        data: {
          organizationId: fx.orgA,
          code: 'COC-QUIZ',
          name: 'Code of Conduct quiz',
          provider: 'GOOGLE_FORMS',
          kind: 'ASSESSMENT',
          externalResourceId: 'form-1',
          passThresholdPercent: '80',
        },
      });
      // One source per external resource in an organization.
      await violation(tx, () =>
        tx.performanceEvidenceSource.create({
          data: {
            organizationId: fx.orgA,
            code: 'COC-AGAIN',
            name: 'Again',
            provider: 'GOOGLE_FORMS',
            kind: 'ASSESSMENT',
            externalResourceId: 'form-1',
          },
        }),
      );
      await violation(tx, () =>
        tx.performanceEvidenceSource.update({
          where: { id: source.id },
          data: { externalResourceId: 'form-2' },
        }),
      );
      const intake = await tx.performanceEvidenceIntake.create({
        data: {
          organizationId: fx.orgA,
          sourceId: source.id,
          externalResultId: 'response-9',
          respondentEmail: 'unknown@example.org',
          result: { title: 'Code of Conduct quiz' },
          reason: 'NO_MATCHING_EMPLOYEE',
        },
      });
      await violation(tx, () =>
        tx.performanceEvidenceIntake.create({
          data: {
            organizationId: fx.orgA,
            sourceId: source.id,
            externalResultId: 'response-9',
            result: {},
            reason: 'NO_MATCHING_EMPLOYEE',
          },
        }),
      );
      await tx.performanceEvidenceIntake.update({
        where: { id: intake.id },
        data: { status: 'REJECTED', resolvedAt: new Date() },
      });
      await violation(tx, () =>
        tx.performanceEvidenceIntake.update({
          where: { id: intake.id },
          data: { status: 'PENDING_MATCH', resolvedAt: null },
        }),
      );
    });
  });
});
