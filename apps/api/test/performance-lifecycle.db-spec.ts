import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service.js';
import {
  failure,
  FixedPerformanceClock,
  openReview,
  PERFORMANCE_USERS,
  performanceServices,
  type PerformanceServices,
} from './support/performance-fixtures.js';
import {
  createSchedulingFixtures,
  ctx,
  rollbackClient,
  type SchedulingFixtures,
  type Tx,
} from './support/scheduling-fixtures.js';

config({ path: '../../.env' });

class RollbackFixtures extends Error {}

type Opened = Awaited<ReturnType<typeof openReview>>;

/** Self and reviewer submit (Communication 4/3 → score 3.60, overall 4). */
async function submitBoth(
  svc: PerformanceServices,
  opened: Opened,
  options = { self: true },
) {
  const { review, items, self, reviewer } = opened;
  if (options.self) {
    await svc.reviews.saveAnswers(
      review.id,
      'SELF',
      {
        answers: [
          { itemId: items.communication, ratingValue: 4 },
          { itemId: items.highlights, textValue: 'Proud of the robotics club' },
        ],
      },
      self,
    );
    await svc.reviews.submit(review.id, 'SELF', self);
  }
  await svc.reviews.saveAnswers(
    review.id,
    'REVIEWER',
    {
      answers: [
        { itemId: items.communication, ratingValue: 4 },
        { itemId: items.reliability, ratingValue: 3 },
        { itemId: items.highlights, textValue: 'A dependable colleague' },
      ],
      overallRatingValue: 4,
    },
    reviewer,
  );
  await svc.reviews.submit(review.id, 'REVIEWER', reviewer);
}

describe('Performance review finalization, acknowledgement and history (database)', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService(process.env.DATABASE_URL!);
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  async function scenario(
    run: (
      tx: Tx,
      fx: SchedulingFixtures,
      svc: PerformanceServices,
    ) => Promise<void>,
  ) {
    await expect(
      prisma.$transaction(
        async (tx) => {
          const fx = await createSchedulingFixtures(tx, PERFORMANCE_USERS);
          const svc = performanceServices(
            rollbackClient(tx),
            new FixedPerformanceClock(),
          );
          await run(tx, fx, svc).catch((error: unknown) => {
            console.error('SCENARIO FAILURE', error);
            throw error;
          });
          throw new RollbackFixtures();
        },
        { timeout: 120_000 },
      ),
    ).rejects.toBeInstanceOf(RollbackFixtures);
  }

  it('finalizes by HR, then the employee sees and acknowledges the outcome', async () => {
    await scenario(async (tx, fx, svc) => {
      const opened = await openReview(tx, svc, fx);
      const { review, items, self, reviewer } = opened;
      const hr = ctx(fx.users.teamManager!);
      const goal = await svc.goals.create(
        {
          employmentAssignmentId: fx.assignmentTeamA,
          title: 'Mentor two new teachers',
          startDate: '2026-01-15',
          progressPercent: 50,
        },
        self,
      );
      await svc.goals.link(review.id, goal.id, reviewer);
      expect(await failure(svc.lifecycle.finalize(review.id, hr))).toEqual({
        status: 409,
        code: 'PERFORMANCE_REVIEW_NOT_SUBMITTED',
      });
      await submitBoth(svc, opened);
      // Before finalization the employee sees no outcome.
      expect((await svc.history.mine(fx.selfUser1)).items[0]).toMatchObject({
        status: 'SUBMITTED',
        overallRating: null,
        calculatedScore: null,
      });
      // The reviewer alone does not finalize.
      expect(
        await failure(svc.lifecycle.finalize(review.id, reviewer)),
      ).toMatchObject({ status: 403 });
      const finalized = await svc.lifecycle.finalize(review.id, hr);
      expect(finalized).toMatchObject({
        status: 'FINALIZED',
        actions: { canCorrect: true, canFinalize: false },
      });
      // Goals freeze as they stood; later progress does not change the review.
      await svc.goals.update(goal.id, { progressPercent: 90 }, self);
      const asSelf = await svc.reviews.detail(fx.selfUser1, review.id);
      expect(asSelf).toMatchObject({
        viewer: 'SELF',
        calculatedScore: '3.60',
        overallRating: { value: 4, label: 'Exceeds Expectations' },
        actions: { canAcknowledge: true, canEditSelf: false },
        events: [],
      });
      expect(asSelf.goals[0]).toMatchObject({
        progressPercent: 50,
        snapshotted: true,
      });
      expect(asSelf.responses[items.highlights]).toMatchObject({
        self: { textValue: 'Proud of the robotics club' },
        reviewer: { textValue: 'A dependable colleague' },
      });
      // Content is locked.
      expect(
        await failure(
          svc.reviews.saveAnswers(
            review.id,
            'REVIEWER',
            { answers: [] },
            reviewer,
          ),
        ),
      ).toEqual({ status: 409, code: 'PERFORMANCE_REVIEW_FINAL' });
      expect(
        await failure(svc.lifecycle.acknowledge(review.id, {}, reviewer)),
      ).toEqual({
        status: 403,
        code: 'PERFORMANCE_NOT_YOUR_REVIEW',
      });
      const acknowledged = await svc.lifecycle.acknowledge(
        review.id,
        { comment: 'I disagree with the reliability rating.' },
        self,
      );
      expect(acknowledged).toMatchObject({
        status: 'ACKNOWLEDGED',
        acknowledgement: { comment: 'I disagree with the reliability rating.' },
      });
      expect(
        await failure(svc.lifecycle.acknowledge(review.id, {}, self)),
      ).toEqual({
        status: 409,
        code: 'PERFORMANCE_REVIEW_NOT_FINALIZED',
      });
      // Free text never reaches the audit trail.
      const audit = await tx.auditLog.findMany({
        where: { entityId: review.id },
      });
      expect(JSON.stringify(audit.map((row) => row.metadata))).not.toMatch(
        /disagree|robotics|dependable/,
      );
      // HR sees the whole timeline.
      const timeline = (
        await svc.reviews.detail(fx.users.teamManager!, review.id)
      ).events;
      // (One test transaction gives every event the same timestamp: compare as a set.)
      expect(
        timeline.map((event) => event.type).sort((a, b) => a.localeCompare(b)),
      ).toEqual([
        'ACKNOWLEDGED',
        'ADDED',
        'FINALIZED',
        'REVIEWER_SUBMITTED',
        'SELF_SUBMITTED',
      ]);
    });
  });

  it('corrects finalized reviews explicitly and asks for a new acknowledgement', async () => {
    await scenario(async (tx, fx, svc) => {
      const opened = await openReview(tx, svc, fx);
      const { review, items, self } = opened;
      const hr = ctx(fx.users.teamManager!);
      expect(
        await failure(
          svc.lifecycle.correct(
            review.id,
            { overallRatingValue: 3, reason: 'x' },
            hr,
          ),
        ),
      ).toEqual({ status: 409, code: 'PERFORMANCE_REVIEW_NOT_FINALIZED' });
      // The reviewer submits before the employee: finalization records the missing self part.
      await submitBoth(svc, opened, { self: false });
      await svc.lifecycle.finalize(review.id, hr);
      expect(
        await tx.performanceReview.findUniqueOrThrow({
          where: { id: review.id },
        }),
      ).toMatchObject({
        selfStatus: 'NOT_SUBMITTED',
      });
      await svc.lifecycle.acknowledge(review.id, {}, self);
      // The employee's words and unanswered items are never "corrected".
      expect(
        await failure(
          svc.lifecycle.correct(
            review.id,
            {
              answers: [{ itemId: items.training, booleanValue: true }],
              reason: 'x',
            },
            hr,
          ),
        ),
      ).toEqual({ status: 400, code: 'PERFORMANCE_ITEM_NOT_CORRECTABLE' });
      expect(
        await failure(
          svc.lifecycle.correct(
            review.id,
            {
              answers: [{ itemId: items.goals, textValue: 'Late' }],
              reason: 'x',
            },
            hr,
          ),
        ),
      ).toEqual({ status: 400, code: 'PERFORMANCE_CORRECTION_NO_ANSWER' });
      const corrected = await svc.lifecycle.correct(
        review.id,
        {
          answers: [{ itemId: items.reliability, ratingValue: 5 }],
          overallRatingValue: 5,
          reason: "Rated the wrong teacher's attendance record",
        },
        hr,
      );
      // (60×4 + 40×5) / 100 = 4.40; acknowledgement asked again.
      expect(corrected).toMatchObject({
        status: 'FINALIZED',
        calculatedScore: '4.40',
        overallRating: { value: 5, label: 'Exceptional' },
        acknowledgement: null,
        actions: { canAcknowledge: false },
      });
      expect(corrected.responses[items.reliability]).toMatchObject({
        reviewer: { ratingValue: 5, recordType: 'CORRECTION' },
      });
      const versions = await tx.performanceReviewResponse.findMany({
        where: { reviewId: review.id, itemId: items.reliability },
        orderBy: { createdAt: 'asc' },
      });
      expect(
        versions.map((row) => [
          row.ratingValue,
          row.recordType,
          row.supersededAt !== null,
        ]),
      ).toEqual([
        [3, 'ORIGINAL', true],
        [5, 'CORRECTION', false],
      ]);
      expect(
        await tx.performanceReviewAcknowledgement.count({
          where: { reviewId: review.id },
        }),
      ).toBe(1);
      await svc.lifecycle.acknowledge(
        review.id,
        { comment: 'Thanks for fixing it' },
        self,
      );
      expect(
        await tx.performanceReviewAcknowledgement.count({
          where: { reviewId: review.id },
        }),
      ).toBe(2);
      // Closed reviews can still be corrected (an error found later), without re-acknowledgement.
      await svc.lifecycle.close(review.id, {}, hr);
      const closed = await svc.lifecycle.correct(
        review.id,
        { overallRatingValue: 4, reason: 'Calibration error' },
        hr,
      );
      expect(closed).toMatchObject({
        status: 'CLOSED',
        closeReason: 'COMPLETED',
        overallRating: { value: 4 },
      });
    });
  });

  it('closes reviews with or without acknowledgement, and unfinished ones with a reason', async () => {
    await scenario(async (tx, fx, svc) => {
      const opened = await openReview(tx, svc, fx);
      const { review } = opened;
      const hr = ctx(fx.users.teamManager!);
      // The employee left before the review was written: HR closes it as incomplete.
      await tx.employee.update({
        where: { id: fx.employee1 },
        data: { status: 'TERMINATED' },
      });
      const attention = await svc.history.attention(
        fx.users.teamManager!,
        fx.orgA,
      );
      expect(
        attention.items.find((item) => item.reviewId === review.id)?.flags,
      ).toEqual(
        expect.arrayContaining(['EMPLOYEE_TERMINATED', 'OVERDUE_SELF']),
      );
      expect(await failure(svc.lifecycle.close(review.id, {}, hr))).toEqual({
        status: 400,
        code: 'PERFORMANCE_REASON_REQUIRED',
      });
      const closed = await svc.lifecycle.close(
        review.id,
        { reason: 'Employee left the school' },
        hr,
      );
      expect(closed).toMatchObject({
        status: 'CLOSED',
        closeReason: 'INCOMPLETE',
        selfStatus: 'NOT_SUBMITTED',
        reviewerStatus: 'NOT_SUBMITTED',
      });
      expect(
        await failure(svc.lifecycle.close(review.id, { reason: 'x' }, hr)),
      ).toEqual({
        status: 409,
        code: 'PERFORMANCE_REVIEW_CLOSED',
      });
      // A finalized review never acknowledged is closed as such.
      await svc.cycles.addReviews(
        opened.cycle.id,
        { assignmentIds: [fx.otherTeamA] },
        ctx(fx.users.cycleAdmin!),
      );
      const second = await tx.performanceReview.findFirstOrThrow({
        where: {
          cycleId: opened.cycle.id,
          employmentAssignmentId: fx.otherTeamA,
        },
      });
      await svc.reviews.reassignReviewer(
        second.id,
        { reviewerEmployeeId: fx.employee1, reason: 'Peer lead' },
        hr,
      );
      await svc.reviews.saveAnswers(
        second.id,
        'REVIEWER',
        {
          answers: [
            { itemId: opened.items.communication, ratingValue: 3 },
            { itemId: opened.items.highlights, textValue: 'Solid' },
          ],
          overallRatingValue: 3,
        },
        hr,
      );
      await svc.reviews.submit(second.id, 'REVIEWER', hr);
      await svc.lifecycle.finalize(second.id, hr);
      expect((await svc.lifecycle.close(second.id, {}, hr)).closeReason).toBe(
        'NOT_ACKNOWLEDGED',
      );
    });
  });

  it('keeps review history and the historical reviewer through reporting changes', async () => {
    await scenario(async (tx, fx, svc) => {
      const opened = await openReview(tx, svc, fx);
      const { review } = opened;
      const hr = ctx(fx.users.teamManager!);
      await submitBoth(svc, opened);
      await svc.lifecycle.finalize(review.id, hr);
      // The reporting line changes and the reviewer leaves the organization afterwards.
      await tx.employmentAssignment.update({
        where: { id: fx.assignmentTeamA },
        data: { managerAssignmentId: null },
      });
      await tx.employmentAssignment.updateMany({
        where: { employeeId: fx.employee2 },
        data: {
          status: 'ENDED',
          endDate: new Date('2026-11-30T00:00:00.000Z'),
        },
      });
      const history = await svc.history.forEmployee(
        fx.users.teamManager!,
        fx.employee1,
      );
      expect(history.items).toEqual([
        expect.objectContaining({
          id: review.id,
          status: 'FINALIZED',
          submittedBy: {
            id: fx.employee2,
            displayName: expect.stringContaining('Employee2'),
          },
          overallRating: { value: 4, label: 'Exceeds Expectations' },
        }),
      ]);
      // Reading needs performance access; HR access is not enough.
      expect(
        await failure(svc.history.forEmployee(fx.users.hr!, fx.employee1)),
      ).toMatchObject({
        status: 403,
      });
      expect((await svc.history.mine(fx.selfUser1)).items[0]).toMatchObject({
        overallRating: { value: 4 },
        awaitingAcknowledgement: true,
      });
    });
  });

  it('lists what needs HR attention within scope', async () => {
    await scenario(async (tx, fx, svc) => {
      const opened = await openReview(tx, svc, fx);
      const admin = ctx(fx.users.cycleAdmin!);
      await svc.cycles.addReviews(
        opened.cycle.id,
        { assignmentIds: [fx.assignmentDeptB] },
        admin,
      );
      // The Team A reviewer no longer works in the organization.
      await tx.employmentAssignment.updateMany({
        where: { employeeId: fx.employee2 },
        data: {
          status: 'ENDED',
          endDate: new Date('2026-11-01T00:00:00.000Z'),
        },
      });
      const all = await svc.history.attention(fx.users.cycleAdmin!, fx.orgA);
      expect(
        all.items.find((item) => item.reviewId === opened.review.id)?.flags,
      ).toEqual(
        expect.arrayContaining([
          'REVIEWER_NOT_IN_ORGANIZATION',
          'OVERDUE_SELF',
        ]),
      );
      expect(all.items.find((item) => item.reviewer === null)?.flags).toEqual(
        expect.arrayContaining(['NO_REVIEWER']),
      );
      // A Team A manager sees Team A only; HR access alone sees nothing.
      expect(
        (await svc.history.attention(fx.users.teamManager!, fx.orgA)).items.map(
          (item) => item.reviewId,
        ),
      ).toEqual([opened.review.id]);
      expect(
        await failure(svc.history.attention(fx.users.hr!, fx.orgA)),
      ).toMatchObject({ status: 403 });
    });
  });
});
