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

describe('Performance reviews (database)', () => {
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
      clock: FixedPerformanceClock,
    ) => Promise<void>,
  ) {
    await expect(
      prisma.$transaction(
        async (tx) => {
          const fx = await createSchedulingFixtures(tx, PERFORMANCE_USERS);
          const clock = new FixedPerformanceClock();
          const svc = performanceServices(rollbackClient(tx), clock);
          await run(tx, fx, svc, clock).catch((error: unknown) => {
            console.error('SCENARIO FAILURE', error);
            throw error;
          });
          throw new RollbackFixtures();
        },
        { timeout: 120_000 },
      ),
    ).rejects.toBeInstanceOf(RollbackFixtures);
  }

  it('lets the employee draft and submit only their self review', async () => {
    await scenario(async (tx, fx, svc) => {
      const { review, items, self } = await openReview(tx, svc, fx);
      // Never the reviewer's items; only valid levels.
      expect(
        await failure(
          svc.reviews.saveAnswers(
            review.id,
            'SELF',
            { answers: [{ itemId: items.reliability, ratingValue: 5 }] },
            self,
          ),
        ),
      ).toEqual({ status: 403, code: 'PERFORMANCE_ITEM_NOT_YOURS' });
      expect(
        await failure(
          svc.reviews.saveAnswers(
            review.id,
            'SELF',
            { answers: [{ itemId: items.communication, ratingValue: 9 }] },
            self,
          ),
        ),
      ).toEqual({ status: 400, code: 'PERFORMANCE_ANSWER_INVALID' });
      // Others never write the self part.
      expect(
        await failure(
          svc.reviews.saveAnswers(
            review.id,
            'SELF',
            { answers: [] },
            ctx(fx.users.hrAdmin!),
          ),
        ),
      ).toEqual({ status: 403, code: 'PERFORMANCE_NOT_YOUR_REVIEW' });
      const draft = await svc.reviews.saveAnswers(
        review.id,
        'SELF',
        {
          answers: [
            {
              itemId: items.communication,
              ratingValue: 4,
              textValue: 'Clear updates to parents',
            },
            { itemId: items.training, booleanValue: true },
          ],
        },
        self,
      );
      expect(draft).toMatchObject({
        status: 'IN_PROGRESS',
        selfStatus: 'IN_PROGRESS',
        viewer: 'SELF',
      });
      expect(draft.responses[items.communication]).toMatchObject({
        self: {
          ratingValue: 4,
          ratingLabel: 'Exceeds Expectations',
          submitted: false,
        },
      });
      // The reviewer never sees self drafts.
      const asReviewer = await svc.reviews.detail(fx.selfUser2, review.id);
      expect(asReviewer.viewer).toBe('REVIEWER');
      expect(asReviewer.responses).toEqual({});
      expect(
        await failure(svc.reviews.submit(review.id, 'SELF', self)),
      ).toEqual({
        status: 400,
        code: 'PERFORMANCE_REQUIRED_UNANSWERED',
      });
      await svc.reviews.saveAnswers(
        review.id,
        'SELF',
        {
          answers: [
            { itemId: items.highlights, textValue: 'Led the robotics club' },
          ],
        },
        self,
      );
      const submitted = await svc.reviews.submit(review.id, 'SELF', self);
      expect(submitted).toMatchObject({
        selfStatus: 'SUBMITTED',
        actions: { canEditSelf: false },
      });
      expect(
        await failure(
          svc.reviews.saveAnswers(
            review.id,
            'SELF',
            { answers: [{ itemId: items.training, booleanValue: false }] },
            self,
          ),
        ),
      ).toEqual({ status: 409, code: 'PERFORMANCE_PART_SUBMITTED' });
      // Submitted self answers are visible to the reviewer and to readers in scope.
      expect(
        (await svc.reviews.detail(fx.selfUser2, review.id)).responses[
          items.highlights
        ],
      ).toMatchObject({
        self: { textValue: 'Led the robotics club', submitted: true },
      });
      expect(
        (await svc.reviews.detail(fx.users.reader!, review.id)).viewer,
      ).toBe('READER');
      // HR access never implies performance access.
      expect(
        await failure(svc.reviews.detail(fx.users.hr!, review.id)),
      ).toMatchObject({ status: 403 });
      expect(
        await tx.performanceReviewEvent.findMany({
          where: { reviewId: review.id },
          select: { type: true },
          orderBy: { createdAt: 'asc' },
        }),
      ).toEqual(expect.arrayContaining([{ type: 'SELF_SUBMITTED' }]));
    });
  });

  it('lets the reviewer rate, set the overall rating and submit with a backend score', async () => {
    await scenario(async (tx, fx, svc) => {
      const { review, items, reviewer } = await openReview(tx, svc, fx);
      const saved = await svc.reviews.saveAnswers(
        review.id,
        'REVIEWER',
        {
          answers: [
            { itemId: items.communication, ratingValue: 4 },
            { itemId: items.reliability, ratingValue: 3 },
          ],
        },
        reviewer,
      );
      // (60×4 + 40×3) / 100 = 3.60, advisory while drafting.
      expect(saved).toMatchObject({
        viewer: 'REVIEWER',
        calculatedScore: '3.60',
        status: 'IN_PROGRESS',
      });
      // The employee sees neither the reviewer's drafts nor the score.
      const asSelf = await svc.reviews.detail(fx.selfUser1, review.id);
      expect(asSelf.responses).toEqual({});
      expect(asSelf.calculatedScore).toBeNull();
      // The reviewer submits before the self review (allowed), once rated overall.
      await svc.reviews.saveAnswers(
        review.id,
        'REVIEWER',
        { answers: [{ itemId: items.highlights, textValue: 'Strong year' }] },
        reviewer,
      );
      expect(
        await failure(svc.reviews.submit(review.id, 'REVIEWER', reviewer)),
      ).toEqual({
        status: 400,
        code: 'PERFORMANCE_OVERALL_RATING_REQUIRED',
      });
      expect(
        await failure(
          svc.reviews.saveAnswers(
            review.id,
            'REVIEWER',
            { answers: [], overallRatingValue: 7 },
            reviewer,
          ),
        ),
      ).toEqual({ status: 400, code: 'PERFORMANCE_ANSWER_INVALID' });
      await svc.reviews.saveAnswers(
        review.id,
        'REVIEWER',
        { answers: [], overallRatingValue: 4 },
        reviewer,
      );
      const submitted = await svc.reviews.submit(
        review.id,
        'REVIEWER',
        reviewer,
      );
      expect(submitted).toMatchObject({
        status: 'SUBMITTED',
        reviewerStatus: 'SUBMITTED',
        selfStatus: 'NOT_STARTED',
        calculatedScore: '3.60',
        overallRating: { value: 4, label: 'Exceeds Expectations' },
      });
      expect(
        await tx.performanceReview.findUniqueOrThrow({
          where: { id: review.id },
        }),
      ).toMatchObject({
        reviewerSubmittedEmployeeId: fx.employee2,
        reviewerSubmittedByUserId: fx.selfUser2,
      });
      // The self review can still be written; the employee still sees no outcome.
      expect(
        (await svc.reviews.detail(fx.selfUser1, review.id)).overallRating,
      ).toBeNull();
      expect(
        (await svc.reviews.queue(fx.selfUser2)).items.map((item) => item.id),
      ).toEqual([review.id]);
      // A reporting line alone (Employee 2 managing Dept B too) grants nothing.
      expect(await failure(svc.reviews.queue(fx.users.reader!))).toEqual({
        status: 403,
        code: 'PERFORMANCE_NOT_AN_EMPLOYEE',
      });
    });
  });

  it('reassigns reviewers, reopens parts with history and enforces the window', async () => {
    await scenario(async (tx, fx, svc, clock) => {
      const { review, items, self, reviewer } = await openReview(tx, svc, fx);
      const hr = ctx(fx.users.teamManager!);
      // Only performance.manage reassigns; never to the employee themselves.
      expect(
        await failure(
          svc.reviews.reassignReviewer(
            review.id,
            { reviewerEmployeeId: null, reason: 'x' },
            reviewer,
          ),
        ),
      ).toMatchObject({ status: 403 });
      expect(
        await failure(
          svc.reviews.reassignReviewer(
            review.id,
            { reviewerEmployeeId: fx.employee1, reason: 'x' },
            hr,
          ),
        ),
      ).toEqual({ status: 400, code: 'PERFORMANCE_SELF_REVIEWER' });
      await svc.reviews.saveAnswers(
        review.id,
        'REVIEWER',
        { answers: [{ itemId: items.reliability, ratingValue: 2 }] },
        reviewer,
      );
      const cleared = await svc.reviews.reassignReviewer(
        review.id,
        { reviewerEmployeeId: null, reason: 'Manager on leave' },
        hr,
      );
      expect(cleared.reviewer).toBeNull();
      // The former reviewer loses access; the event keeps both identities.
      expect(
        await failure(svc.reviews.detail(fx.selfUser2, review.id)),
      ).toMatchObject({ status: 403 });
      expect(
        await tx.performanceReviewEvent.findFirstOrThrow({
          where: { reviewId: review.id, type: 'REVIEWER_CHANGED' },
        }),
      ).toMatchObject({
        fromEmployeeId: fx.employee2,
        toEmployeeId: null,
        reason: 'Manager on leave',
      });
      // HR completes the reviewer part itself.
      await svc.reviews.saveAnswers(
        review.id,
        'REVIEWER',
        {
          answers: [
            { itemId: items.communication, ratingValue: 5 },
            { itemId: items.highlights, textValue: 'Covered by HR' },
          ],
          overallRatingValue: 5,
        },
        hr,
      );
      await svc.reviews.submit(review.id, 'REVIEWER', hr);
      // Reopen keeps the submitted answers as history; edits supersede them.
      expect(
        await failure(
          svc.reviews.reopen(review.id, 'SELF', { reason: 'x' }, hr),
        ),
      ).toEqual({ status: 409, code: 'PERFORMANCE_PART_NOT_SUBMITTED' });
      const reopened = await svc.reviews.reopen(
        review.id,
        'REVIEWER',
        { reason: 'Wrong employee notes' },
        hr,
      );
      expect(reopened).toMatchObject({
        status: 'IN_PROGRESS',
        reviewerStatus: 'IN_PROGRESS',
        calculatedScore: '3.80',
      });
      await svc.reviews.saveAnswers(
        review.id,
        'REVIEWER',
        {
          answers: [{ itemId: items.highlights, textValue: 'Corrected notes' }],
        },
        hr,
      );
      const history = await tx.performanceReviewResponse.findMany({
        where: {
          reviewId: review.id,
          itemId: items.highlights,
          respondent: 'REVIEWER',
        },
        orderBy: { createdAt: 'asc' },
      });
      expect(
        history.map((row) => [row.textValue, row.supersededAt !== null]),
      ).toEqual([
        ['Covered by HR', true],
        ['Corrected notes', false],
      ]);
      // The window: before it opens nobody writes; after it ends only HR does.
      clock.value = new Date('2026-10-20T16:00:00.000Z');
      expect(
        await failure(
          svc.reviews.saveAnswers(review.id, 'SELF', { answers: [] }, self),
        ),
      ).toEqual({ status: 409, code: 'PERFORMANCE_WINDOW_NOT_OPEN' });
      clock.value = new Date('2026-12-20T16:00:00.000Z');
      expect(
        await failure(
          svc.reviews.saveAnswers(review.id, 'SELF', { answers: [] }, self),
        ),
      ).toEqual({ status: 409, code: 'PERFORMANCE_WINDOW_CLOSED' });
      await svc.reviews.submit(review.id, 'REVIEWER', hr);
    });
  });

  it('skips the self part when the cycle does not ask for it', async () => {
    await scenario(async (tx, fx, svc) => {
      const { review, self } = await openReview(tx, svc, fx, {
        selfReviewEnabled: false,
        scoringMode: 'NONE',
      });
      expect(review.selfStatus).toBe('NOT_REQUIRED');
      expect(
        await failure(
          svc.reviews.saveAnswers(review.id, 'SELF', { answers: [] }, self),
        ),
      ).toEqual({ status: 409, code: 'PERFORMANCE_SELF_NOT_REQUIRED' });
    });
  });
});
