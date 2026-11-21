import type { HttpException } from '@nestjs/common';
import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service.js';
import { d } from './support/payroll-fixtures.js';
import {
  activeTemplate,
  cycleInput,
  failure,
  FixedPerformanceClock,
  openReview,
  orgBAssignment,
  PERFORMANCE_USERS,
  performanceServices,
  type PerformanceServices,
} from './support/performance-fixtures.js';
import {
  cleanupSchedulingFixtures,
  createSchedulingFixtures,
  ctx,
  rollbackClient,
  type SchedulingFixtures,
  type Tx,
} from './support/scheduling-fixtures.js';

config({ path: '../../.env' });

class RollbackFixtures extends Error {}

describe('Performance review cycles (database)', () => {
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

  it('creates cycles with organization permission, an active template and consistent dates', async () => {
    await scenario(async (_tx, fx, svc) => {
      const { template } = await activeTemplate(svc, fx);
      const admin = ctx(fx.users.cycleAdmin!);
      for (const user of [
        'templateAdmin',
        'reader',
        'teamManager',
        'hr',
        'orgBAdmin',
      ]) {
        expect(
          await failure(
            svc.cycles.create(
              cycleInput(fx, template.id),
              ctx(fx.users[user]!),
            ),
          ),
        ).toMatchObject({ status: 403 });
      }
      expect(
        await failure(
          svc.cycles.create(
            cycleInput(fx, template.id, { selfReviewDueDate: '2026-10-01' }),
            admin,
          ),
        ),
      ).toEqual({ status: 400, code: 'PERFORMANCE_DATES_INVALID' });
      const draft = await svc.config.copyTemplate(
        template.id,
        { code: 'draft-copy' },
        ctx(fx.users.templateAdmin!),
      );
      expect(
        await failure(svc.cycles.create(cycleInput(fx, draft.id), admin)),
      ).toEqual({
        status: 409,
        code: 'PERFORMANCE_TEMPLATE_NOT_ACTIVE',
      });
      const cycle = await svc.cycles.create(cycleInput(fx, template.id), admin);
      expect(cycle).toMatchObject({
        code: 'ANNUAL-2026',
        status: 'DRAFT',
        reviewerModel: 'DIRECT_MANAGER',
      });
      expect(
        await failure(svc.cycles.create(cycleInput(fx, template.id), admin)),
      ).toEqual({
        status: 409,
        code: 'PERFORMANCE_CODE_EXISTS',
      });
    });
  });

  it('targets assignments in the period, resolves direct managers and stays idempotent', async () => {
    await scenario(async (tx, fx, svc) => {
      const { template } = await activeTemplate(svc, fx);
      const admin = ctx(fx.users.cycleAdmin!);
      // Employee 2 (otherTeamA) manages Employee 1's Team A assignment.
      await tx.employmentAssignment.update({
        where: { id: fx.assignmentTeamA },
        data: { managerAssignmentId: fx.otherTeamA },
      });
      // An assignment that ended before the period is never reviewed.
      await tx.employmentAssignment.update({
        where: { id: fx.orgLevel },
        data: {
          startDate: d('2025-01-01'),
          endDate: d('2025-12-31'),
          status: 'ENDED',
        },
      });
      const cycle = await svc.cycles.create(cycleInput(fx, template.id), admin);
      expect(
        await failure(
          svc.cycles.addReviews(
            cycle.id,
            { assignmentIds: [fx.orgLevel] },
            admin,
          ),
        ),
      ).toEqual({ status: 400, code: 'PERFORMANCE_ASSIGNMENT_NOT_ELIGIBLE' });
      const foreign = await orgBAssignment(tx, fx);
      expect(
        await failure(
          svc.cycles.addReviews(cycle.id, { assignmentIds: [foreign] }, admin),
        ),
      ).toEqual({ status: 400, code: 'PERFORMANCE_ASSIGNMENT_NOT_ELIGIBLE' });
      expect(
        await svc.cycles.addReviews(
          cycle.id,
          { allInOrganization: true, teamId: fx.teamA },
          admin,
        ),
      ).toEqual({ added: 2, skipped: 0, withoutReviewer: 1, excludedOwn: 0 });
      // Idempotent; the whole organization adds Employee 1's Dept B assignment only.
      expect(
        await svc.cycles.addReviews(
          cycle.id,
          { allInOrganization: true, assignmentIds: [fx.assignmentTeamA] },
          admin,
        ),
      ).toEqual({ added: 1, skipped: 2, withoutReviewer: 1, excludedOwn: 0 });
      const reviews = await tx.performanceReview.findMany({
        where: { cycleId: cycle.id },
      });
      expect(reviews).toHaveLength(3);
      expect(
        reviews.find((r) => r.employmentAssignmentId === fx.assignmentTeamA),
      ).toMatchObject({
        reviewerEmployeeId: fx.employee2,
        reviewerAssignmentId: fx.otherTeamA,
        reviewerSource: 'DIRECT_MANAGER',
      });
      // Draft reviews can be removed; nothing is evented before opening.
      const deptB = reviews.find(
        (r) => r.employmentAssignmentId === fx.assignmentDeptB,
      )!;
      await svc.cycles.removeReview(cycle.id, deptB.id, admin);
      expect(
        await tx.performanceReviewEvent.count({
          where: { review: { cycleId: cycle.id } },
        }),
      ).toBe(0);
      // HR_ASSIGNED cycles leave every reviewer to HR.
      const hrCycle = await svc.cycles.create(
        cycleInput(fx, template.id, {
          code: 'HR-ONLY',
          reviewerModel: 'HR_ASSIGNED',
        }),
        admin,
      );
      expect(
        await svc.cycles.addReviews(
          hrCycle.id,
          { assignmentIds: [fx.assignmentTeamA] },
          admin,
        ),
      ).toEqual({ added: 1, skipped: 0, withoutReviewer: 1, excludedOwn: 0 });
      await svc.cycles.discard(hrCycle.id, admin);
      expect(
        await tx.performanceCycle.count({ where: { id: hrCycle.id } }),
      ).toBe(0);
    });
  });

  it('freezes the template into the cycle when it opens', async () => {
    await scenario(async (tx, fx, svc) => {
      const {
        template,
        competency,
        admin: templateAdmin,
      } = await activeTemplate(svc, fx);
      const admin = ctx(fx.users.cycleAdmin!);
      const cycle = await svc.cycles.create(cycleInput(fx, template.id), admin);
      expect(await failure(svc.cycles.open(cycle.id, admin))).toEqual({
        status: 409,
        code: 'PERFORMANCE_CYCLE_EMPTY',
      });
      await svc.cycles.addReviews(
        cycle.id,
        { assignmentIds: [fx.assignmentTeamA] },
        admin,
      );
      const opened = await svc.cycles.open(cycle.id, admin);
      expect(opened).toMatchObject({
        status: 'OPEN',
        scoringMode: 'WEIGHTED_AVERAGE',
        overallRatingEnabled: true,
        overallScaleName: 'Five point',
      });
      // Later configuration changes never reach the opened cycle.
      await svc.config.updateCompetency(
        competency.id,
        { name: 'Renamed' },
        templateAdmin,
      );
      await svc.config.transitionTemplate(
        template.id,
        'ARCHIVED',
        templateAdmin,
      );
      const detail = await svc.cycles.detail(fx.users.reader!, cycle.id);
      expect(detail.form.map((s) => s.title)).toEqual([
        'Competencies',
        'Reflection',
      ]);
      expect(detail.form[0]!.items[0]).toMatchObject({
        prompt: 'Communication',
        weight: '60.00',
        competency: { name: 'Communication' },
        scaleLevels: expect.arrayContaining([
          { value: 3, label: 'Meets Expectations', description: null },
        ]),
      });
      const review = await tx.performanceReview.findFirstOrThrow({
        where: { cycleId: cycle.id },
      });
      expect(review).toMatchObject({
        status: 'NOT_STARTED',
        selfStatus: 'NOT_STARTED',
      });
      expect(
        await tx.performanceReviewEvent.findMany({
          where: { reviewId: review.id },
          select: { type: true },
        }),
      ).toEqual([{ type: 'ADDED' }]);
      // Opened: template, period and reviewer model are frozen; the window can move.
      expect(
        await failure(
          svc.cycles.update(cycle.id, { periodEnd: '2026-11-30' }, admin),
        ),
      ).toEqual({ status: 409, code: 'PERFORMANCE_CYCLE_FROZEN' });
      expect(
        await failure(
          svc.cycles.update(cycle.id, { windowEnd: '2026-11-30' }, admin),
        ),
      ).toEqual({ status: 400, code: 'PERFORMANCE_DATES_INVALID' });
      const extended = await svc.cycles.update(
        cycle.id,
        { windowEnd: '2026-12-31', reviewerDueDate: '2026-12-20' },
        admin,
      );
      expect(extended).toMatchObject({
        windowEnd: '2026-12-31',
        reviewerDueDate: '2026-12-20',
      });
      // Reviews added to an open cycle are evented right away.
      await svc.cycles.addReviews(
        cycle.id,
        { assignmentIds: [fx.otherTeamA] },
        admin,
      );
      expect(
        await tx.performanceReviewEvent.count({
          where: { review: { cycleId: cycle.id } },
        }),
      ).toBe(2);
    });
  });

  it('closes incomplete reviews only explicitly, then archives', async () => {
    await scenario(async (tx, fx, svc) => {
      const { template } = await activeTemplate(svc, fx);
      const admin = ctx(fx.users.cycleAdmin!);
      const cycle = await svc.cycles.create(
        cycleInput(fx, template.id, { selfReviewEnabled: false }),
        admin,
      );
      await svc.cycles.addReviews(
        cycle.id,
        { assignmentIds: [fx.assignmentTeamA] },
        admin,
      );
      await svc.cycles.open(cycle.id, admin);
      const review = await tx.performanceReview.findFirstOrThrow({
        where: { cycleId: cycle.id },
      });
      expect(review.selfStatus).toBe('NOT_REQUIRED');
      expect(await failure(svc.cycles.close(cycle.id, {}, admin))).toEqual({
        status: 409,
        code: 'PERFORMANCE_CYCLE_HAS_INCOMPLETE',
      });
      expect(
        await failure(
          svc.cycles.close(cycle.id, { closeIncomplete: true }, admin),
        ),
      ).toEqual({
        status: 400,
        code: 'PERFORMANCE_REASON_REQUIRED',
      });
      expect(await failure(svc.cycles.archive(cycle.id, admin))).toEqual({
        status: 409,
        code: 'PERFORMANCE_STATUS_INVALID',
      });
      await svc.cycles.close(
        cycle.id,
        { closeIncomplete: true, reason: 'Year-end deadline' },
        admin,
      );
      expect(
        await tx.performanceReview.findUniqueOrThrow({
          where: { id: review.id },
        }),
      ).toMatchObject({
        status: 'CLOSED',
        closeReason: 'INCOMPLETE',
        selfStatus: 'NOT_REQUIRED',
        reviewerStatus: 'NOT_SUBMITTED',
      });
      expect(
        await failure(
          svc.cycles.addReviews(
            cycle.id,
            { assignmentIds: [fx.otherTeamA] },
            admin,
          ),
        ),
      ).toEqual({
        status: 409,
        code: 'PERFORMANCE_CYCLE_NOT_ACCEPTING',
      });
      expect((await svc.cycles.archive(cycle.id, admin)).status).toBe(
        'ARCHIVED',
      );
      expect((await svc.cycles.list(fx.users.reader!, fx.orgA)).items).toEqual(
        [],
      );
      expect(
        (await svc.cycles.list(fx.users.reader!, fx.orgA, true)).items,
      ).toHaveLength(1);
    });
  });

  it('shows cycle monitoring only within scope, with overdue parts', async () => {
    await scenario(async (_tx, fx, svc) => {
      const { template } = await activeTemplate(svc, fx);
      const admin = ctx(fx.users.cycleAdmin!);
      const cycle = await svc.cycles.create(cycleInput(fx, template.id), admin);
      await svc.cycles.addReviews(cycle.id, { allInOrganization: true }, admin);
      await svc.cycles.open(cycle.id, admin);
      // The clock (2026-11-15) is past the self-review due date (2026-11-10).
      const all = await svc.cycles.reviews(fx.users.cycleAdmin!, cycle.id);
      expect(all.items).toHaveLength(4);
      expect(all.items.every((item) => item.overdue.includes('SELF'))).toBe(
        true,
      );
      expect(all.items.some((item) => item.overdue.includes('REVIEWER'))).toBe(
        false,
      );
      // A Team A manager sees Team A assignments only; HR access never implies it.
      const team = await svc.cycles.reviews(fx.users.teamManager!, cycle.id);
      expect(
        team.items.map((item) => item.employmentAssignment.id).sort(),
      ).toEqual([fx.assignmentTeamA, fx.otherTeamA].sort());
      expect(
        await failure(svc.cycles.reviews(fx.users.hr!, cycle.id)),
      ).toMatchObject({ status: 403 });
    });
  });
});

describe('Performance cycle concurrency (committed data)', () => {
  let prisma: PrismaService;
  let fx: SchedulingFixtures;
  let svc: PerformanceServices;

  beforeAll(async () => {
    prisma = new PrismaService(process.env.DATABASE_URL!);
    await prisma.$connect();
    fx = await prisma.$transaction(
      (tx) => createSchedulingFixtures(tx, PERFORMANCE_USERS),
      {
        timeout: 60_000,
      },
    );
    svc = performanceServices(prisma, new FixedPerformanceClock());
  });

  afterAll(async () => {
    if (fx) await cleanupSchedulingFixtures(prisma, fx);
    await prisma?.$disconnect();
  });

  it('keeps one review per assignment and never lets a submission slip past closing', async () => {
    const opened = await openReview(prisma as unknown as Tx, svc, fx);
    const admin = ctx(fx.users.cycleAdmin!);
    // The same assignment targeted twice at once: one review.
    const adds = await Promise.all(
      [0, 1].map(() =>
        svc.cycles.addReviews(
          opened.cycle.id,
          { assignmentIds: [fx.otherTeamA] },
          admin,
        ),
      ),
    );
    expect(adds.map((add) => add.added).sort((a, b) => a - b)).toEqual([0, 1]);
    expect(
      await prisma.performanceReview.count({
        where: {
          cycleId: opened.cycle.id,
          employmentAssignmentId: fx.otherTeamA,
        },
      }),
    ).toBe(1);
    // A reviewer submits while HR closes the cycle: either the submission lands first (and is
    // closed with the cycle) or it is refused — never written into a closed cycle.
    await svc.reviews.saveAnswers(
      opened.review.id,
      'REVIEWER',
      {
        answers: [
          { itemId: opened.items.communication, ratingValue: 4 },
          { itemId: opened.items.highlights, textValue: 'Good year' },
        ],
        overallRatingValue: 4,
      },
      opened.reviewer,
    );
    const [submit, close] = await Promise.allSettled([
      svc.reviews.submit(opened.review.id, 'REVIEWER', opened.reviewer),
      svc.cycles.close(
        opened.cycle.id,
        { closeIncomplete: true, reason: 'Deadline' },
        admin,
      ),
    ]);
    expect(close.status).toBe('fulfilled');
    const final = await prisma.performanceReview.findUniqueOrThrow({
      where: { id: opened.review.id },
    });
    expect(final.status).toBe('CLOSED');
    if (submit.status === 'fulfilled') {
      expect(final.reviewerStatus).toBe('SUBMITTED');
    } else {
      expect((submit.reason as HttpException).getResponse()).toMatchObject({
        code: 'PERFORMANCE_CYCLE_NOT_OPEN',
      });
      expect(final.reviewerStatus).toBe('NOT_SUBMITTED');
    }
  });
});
