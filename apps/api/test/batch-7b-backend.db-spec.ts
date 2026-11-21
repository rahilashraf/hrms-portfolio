import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service.js';
import { PerformanceOptionsService } from '../src/performance/performance-options.service.js';
import {
  activeTemplate,
  cycleInput,
  failure,
  FixedPerformanceClock,
  openReview,
  PERFORMANCE_PERMISSION_KEYS,
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

const USERS = {
  ...PERFORMANCE_USERS,
  self1: [{ permissions: PERFORMANCE_PERMISSION_KEYS, scope: 'org' as const }],
};

/**
 * Batch 7B — functional fixes F1–F3, manager-set goals (D5), and the additive API (options,
 * names, filters and paging, error codes). Each fix's test failed on the previous code.
 */
describe('Batch 7B performance backend (database)', () => {
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
          const fx = await createSchedulingFixtures(tx, USERS);
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

  const submitBoth = async (
    svc: PerformanceServices,
    o: Awaited<ReturnType<typeof openReview>>,
  ) => {
    await svc.reviews.saveAnswers(
      o.review.id,
      'SELF',
      {
        answers: [
          { itemId: o.items.communication, ratingValue: 4 },
          { itemId: o.items.highlights, textValue: 'Led the reading club' },
        ],
      },
      o.self,
    );
    await svc.reviews.submit(o.review.id, 'SELF', o.self);
    await svc.reviews.saveAnswers(
      o.review.id,
      'REVIEWER',
      {
        answers: [
          { itemId: o.items.communication, ratingValue: 4 },
          { itemId: o.items.reliability, ratingValue: 3 },
          { itemId: o.items.highlights, textValue: 'Strong year' },
        ],
        overallRatingValue: 4,
      },
      o.reviewer,
    );
    await svc.reviews.submit(o.review.id, 'REVIEWER', o.reviewer);
  };

  it('F1: a correction naming an item twice is a 400, not a server error', async () => {
    await scenario(async (tx, fx, svc) => {
      const o = await openReview(tx, svc, fx);
      await submitBoth(svc, o);
      const hr = ctx(fx.users.hrAdmin!);
      await svc.lifecycle.finalize(o.review.id, hr);
      expect(
        await failure(
          svc.lifecycle.correct(
            o.review.id,
            {
              answers: [
                { itemId: o.items.reliability, ratingValue: 4 },
                { itemId: o.items.reliability, ratingValue: 5 },
              ],
              reason: 'Calibration',
            },
            hr,
          ),
        ),
      ).toEqual({ status: 400, code: 'PERFORMANCE_ANSWER_DUPLICATE' });
      // A valid correction of answers and rating still works.
      const corrected = await svc.lifecycle.correct(
        o.review.id,
        {
          answers: [{ itemId: o.items.reliability, ratingValue: 4 }],
          overallRatingValue: 5,
          reason: 'Calibration',
        },
        hr,
      );
      expect(corrected.overallRating).toMatchObject({ value: 5 });
    });
  });

  it('F2: a review of a draft cycle is removed, never closed (opening stays possible)', async () => {
    await scenario(async (tx, fx, svc) => {
      const { template } = await activeTemplate(svc, fx);
      const admin = ctx(fx.users.cycleAdmin!);
      const cycle = await svc.cycles.create(cycleInput(fx, template.id), admin);
      await svc.cycles.addReviews(
        cycle.id,
        { assignmentIds: [fx.assignmentTeamA, fx.otherTeamA] },
        admin,
      );
      const review = await tx.performanceReview.findFirstOrThrow({
        where: {
          cycleId: cycle.id,
          employmentAssignmentId: fx.assignmentTeamA,
        },
      });
      const hr = ctx(fx.users.hrAdmin!);
      expect(
        (await svc.reviews.detail(fx.users.hrAdmin!, review.id)).actions
          .canClose,
      ).toBe(false);
      expect(
        await failure(
          svc.lifecycle.close(review.id, { reason: 'Left the school' }, hr),
        ),
      ).toEqual({ status: 409, code: 'PERFORMANCE_CYCLE_NOT_OPEN' });
      await svc.cycles.open(cycle.id, admin);
      expect(
        await tx.performanceCycle.findUniqueOrThrow({
          where: { id: cycle.id },
        }),
      ).toMatchObject({ status: 'OPEN' });
    });
  });

  it('F3: an ended manager assignment never becomes the reviewer', async () => {
    await scenario(async (tx, fx, svc) => {
      const { template } = await activeTemplate(svc, fx);
      await tx.employmentAssignment.update({
        where: { id: fx.assignmentTeamA },
        data: { managerAssignmentId: fx.otherTeamA },
      });
      await tx.employmentAssignment.update({
        where: { id: fx.otherTeamA },
        data: { status: 'ENDED', endDate: new Date('2026-06-30T00:00:00Z') },
      });
      const admin = ctx(fx.users.cycleAdmin!);
      const cycle = await svc.cycles.create(cycleInput(fx, template.id), admin);
      expect(
        await svc.cycles.addReviews(
          cycle.id,
          { assignmentIds: [fx.assignmentTeamA] },
          admin,
        ),
      ).toMatchObject({ added: 1, withoutReviewer: 1 });
      expect(
        (
          await tx.performanceReview.findFirstOrThrow({
            where: { cycleId: cycle.id },
          })
        ).reviewerEmployeeId,
      ).toBeNull();
    });
  });

  it('D5: manager-set goals keep provenance; only the manager or HR completes or cancels them', async () => {
    await scenario(async (tx, fx, svc) => {
      const o = await openReview(tx, svc, fx);
      // The reviewer (Employee 2, the manager) sets a goal for Employee 1.
      const managerGoal = await svc.goals.create(
        {
          employmentAssignmentId: fx.assignmentTeamA,
          title: 'Mentor a new teacher',
          startDate: '2026-01-15',
        },
        o.reviewer,
      );
      const ownGoal = await svc.goals.create(
        {
          employmentAssignmentId: fx.assignmentTeamA,
          title: 'Read two books on pedagogy',
          startDate: '2026-01-15',
        },
        o.self,
      );
      const mine = (await svc.goals.mine(fx.selfUser1)).items;
      const byTitle = (title: string) => mine.find((g) => g.title === title)!;
      const managerName = `Employee2 ${fx.suffix}`;
      expect(byTitle('Mentor a new teacher')).toMatchObject({
        setBy: 'MANAGER',
        createdBy: { userId: fx.selfUser2, displayName: managerName },
      });
      expect(byTitle('Read two books on pedagogy')).toMatchObject({
        setBy: 'EMPLOYEE',
      });
      // The employee keeps editing it (progress, wording)…
      await svc.goals.update(
        managerGoal.id,
        { progressPercent: 40, measure: 'Weekly check-ins' },
        o.self,
      );
      // …but never completes or cancels it.
      for (const change of [
        { status: 'COMPLETED' as const },
        { status: 'CANCELLED' as const, cancellationReason: 'Not needed' },
      ]) {
        expect(
          await failure(svc.goals.update(managerGoal.id, change, o.self)),
        ).toEqual({ status: 403, code: 'PERFORMANCE_GOAL_MANAGER_SET' });
      }
      // Their own goal: they may.
      await svc.goals.update(ownGoal.id, { status: 'COMPLETED' }, o.self);
      // The manager (reviewer) or HR may complete the manager-set goal.
      expect(
        await svc.goals.update(
          managerGoal.id,
          { status: 'COMPLETED', completionNotes: 'Done' },
          o.reviewer,
        ),
      ).toMatchObject({ status: 'COMPLETED', setBy: 'MANAGER' });
      // Audit keeps who set and who changed it.
      // (one transaction: the audit rows share a timestamp, so compare them as a set)
      const audits = await tx.auditLog.findMany({
        where: { entityId: managerGoal.id },
        select: { action: true, actorUserId: true },
      });
      expect(audits.map((a) => `${a.action}:${a.actorUserId}`).sort()).toEqual(
        [
          `PERFORMANCE_GOAL_CREATED:${fx.selfUser2}`,
          `PERFORMANCE_GOAL_UPDATED:${fx.selfUser1}`,
          `PERFORMANCE_GOAL_UPDATED:${fx.selfUser2}`,
        ].sort(),
      );
    });
  });

  it('D5: an employee never changes a goal of a review awaiting finalization (the snapshot stays what was reviewed)', async () => {
    await scenario(async (tx, fx, svc) => {
      const o = await openReview(tx, svc, fx);
      const goal = await svc.goals.create(
        {
          employmentAssignmentId: fx.assignmentTeamA,
          title: 'Lead the science fair',
          startDate: '2026-01-15',
          progressPercent: 50,
        },
        o.self,
      );
      await svc.goals.link(o.review.id, goal.id, o.reviewer);
      await submitBoth(svc, o);
      // Submitted by the reviewer, not finalized: the employee's edits are refused.
      expect(
        await failure(
          svc.goals.update(goal.id, { progressPercent: 100 }, o.self),
        ),
      ).toEqual({ status: 409, code: 'PERFORMANCE_GOAL_UNDER_REVIEW' });
      const hr = ctx(fx.users.hrAdmin!);
      const finalized = await svc.lifecycle.finalize(o.review.id, hr);
      expect(finalized.goals[0]).toMatchObject({
        title: 'Lead the science fair',
        progressPercent: 50,
        snapshotted: true,
      });
      // After finalization the goal moves on; the finalized review keeps what was reviewed.
      await svc.goals.update(goal.id, { progressPercent: 100 }, o.self);
      expect(
        (await svc.reviews.detail(fx.selfUser1, o.review.id)).goals[0],
      ).toMatchObject({ progressPercent: 50 });
    });
  });

  it('D7: performance options need a performance permission, stay in scope and never offer oneself', async () => {
    await scenario(async (tx, fx, svc) => {
      const options = new PerformanceOptionsService(
        rollbackClient(tx),
        svc.access,
      );
      const q = (kind: string, extra: Record<string, unknown> = {}) => ({
        organizationId: fx.orgA,
        kind: kind as never,
        search: fx.suffix,
        ...extra,
      });
      const ids = (page: { items: Array<{ id: string }> }) =>
        page.items.map((o) => o.id).sort();
      // Employees for evidence managers: the organization, never oneself.
      expect(
        ids(await options.options(fx.users.evidenceAdmin!, q('employee'))),
      ).toEqual([fx.employee1, fx.employee2].sort());
      expect(ids(await options.options(fx.selfUser1, q('employee')))).toEqual([
        fx.employee2,
      ]);
      // Assignments for cycle managers: the organization; for Team A's HR: Team A only.
      expect(
        ids(await options.options(fx.users.cycleAdmin!, q('assignment'))),
      ).toEqual(
        [
          fx.assignmentTeamA,
          fx.assignmentDeptB,
          fx.otherTeamA,
          fx.orgLevel,
        ].sort(),
      );
      expect(
        ids(await options.options(fx.users.teamManager!, q('assignment'))),
      ).toEqual([fx.assignmentTeamA, fx.otherTeamA].sort());
      expect(
        ids(
          await options.options(
            fx.users.cycleAdmin!,
            q('assignment', { employeeId: fx.employee2 }),
          ),
        ),
      ).toEqual([fx.otherTeamA, fx.orgLevel].sort());
      // Reviewers for performance.manage holders.
      expect(
        ids(await options.options(fx.users.teamManager!, q('reviewer'))),
      ).toEqual([fx.employee1, fx.employee2].sort());
      // Structures for cycle managers.
      expect(
        ids(
          await options.options(
            fx.users.cycleAdmin!,
            q('team', { search: undefined }),
          ),
        ),
      ).toContain(fx.teamA);
      // Minimal fields only.
      const one = (
        await options.options(fx.users.evidenceAdmin!, q('employee'))
      ).items[0]!;
      expect(Object.keys(one).sort()).toEqual(['description', 'id', 'label']);
      // Refusals: read-only, configuration-only and another organization.
      for (const [user, kind] of [
        ['reader', 'employee'],
        ['templateAdmin', 'assignment'],
        ['evidenceAdmin', 'team'],
        ['orgBAdmin', 'employee'],
      ] as const) {
        expect([
          user,
          kind,
          await failure(options.options(fx.users[user]!, q(kind))),
        ]).toEqual([
          user,
          kind,
          { status: 403, code: 'PERFORMANCE_PERMISSION_REQUIRED' },
        ]);
      }
    });
  });

  it('names, filters and paging for the performance queues; domain error codes', async () => {
    await scenario(async (tx, fx, svc) => {
      const o = await openReview(tx, svc, fx);
      const admin = ctx(fx.users.cycleAdmin!);
      await svc.cycles.addReviews(
        o.cycle.id,
        { assignmentIds: [fx.otherTeamA, fx.orgLevel] },
        admin,
      );
      // Cycle reviews: filters and paging.
      const all = await svc.cycles.reviews(fx.users.hrAdmin!, o.cycle.id);
      expect(all.total).toBe(3);
      const withReviewer = await svc.cycles.reviews(
        fx.users.hrAdmin!,
        o.cycle.id,
        { reviewerEmployeeId: fx.employee2 },
      );
      expect(withReviewer.items.map((r) => r.id)).toEqual([o.review.id]);
      const first = await svc.cycles.reviews(fx.users.hrAdmin!, o.cycle.id, {
        limit: 2,
      });
      expect(first.items).toHaveLength(2);
      const second = await svc.cycles.reviews(fx.users.hrAdmin!, o.cycle.id, {
        limit: 2,
        afterId: first.nextAfterId!,
      });
      expect(second).toMatchObject({ nextAfterId: null });
      expect(second.items).toHaveLength(1);
      expect(
        (
          await svc.cycles.reviews(fx.users.hrAdmin!, o.cycle.id, {
            search: `Employee1 ${fx.suffix}`,
          })
        ).items.map((r) => r.id),
      ).toEqual([o.review.id]);
      // Attention: by flag.
      const noReviewer = await svc.history.attention(
        fx.users.hrAdmin!,
        fx.orgA,
        { flag: 'NO_REVIEWER', cycleId: o.cycle.id },
      );
      expect(
        noReviewer.items.every((i) => i.flags.includes('NO_REVIEWER')),
      ).toBe(true);
      // Names in history: reassigning records the people by name.
      await svc.reviews.reassignReviewer(
        o.review.id,
        {
          reviewerEmployeeId: fx.employee1 === fx.employee2 ? null : null,
          reason: 'Left',
        },
        ctx(fx.users.hrAdmin!),
      );
      const detail = await svc.reviews.detail(fx.users.hrAdmin!, o.review.id);
      const reassigned = detail.events.find(
        (e) => e.type === 'REVIEWER_CHANGED',
      )!;
      expect(reassigned).toMatchObject({
        fromEmployeeName: `Employee2 ${fx.suffix}`,
        actorName: expect.any(String),
      });
      // Evidence: employee by name, recorder by name in history, status filter.
      const evidenceAdmin = ctx(fx.users.evidenceAdmin!);
      const manual = await svc.evidence.recordManual(
        {
          organizationId: fx.orgA,
          employeeId: fx.employee2,
          provider: 'TRAINING',
          kind: 'TRAINING',
          title: 'Safety training',
          completedAt: '2026-05-20T12:00:00Z',
        },
        evidenceAdmin,
      );
      const listed = (
        await svc.evidence.forEmployee(fx.users.hrAdmin!, fx.employee2)
      ).items[0]!;
      expect(listed.employee).toMatchObject({
        id: fx.employee2,
        displayName: `Employee2 ${fx.suffix}`,
      });
      const history = await svc.evidence.history(fx.users.hrAdmin!, manual.id);
      expect(history.items[0]).toMatchObject({
        recordedBy: { userId: fx.users.evidenceAdmin },
      });
      await svc.evidence.withdraw(
        manual.id,
        { reason: 'Duplicate' },
        evidenceAdmin,
      );
      expect(
        (
          await svc.evidence.forEmployee(
            fx.users.hrAdmin!,
            fx.employee2,
            'ACTIVE',
          )
        ).items,
      ).toEqual([]);
      // Goals: status filter.
      await svc.goals.create(
        {
          employmentAssignmentId: fx.assignmentTeamA,
          title: 'Mentor',
          startDate: '2026-01-15',
        },
        o.self,
      );
      expect((await svc.goals.mine(fx.selfUser1, 'COMPLETED')).items).toEqual(
        [],
      );
      expect(
        (await svc.goals.mine(fx.selfUser1, 'NOT_STARTED')).items,
      ).toHaveLength(1);
      // Domain error codes on refusals.
      expect(
        await failure(svc.cycles.reviews(fx.users.hr!, o.cycle.id)),
      ).toEqual({ status: 403, code: 'PERFORMANCE_PERMISSION_REQUIRED' });
    });
  });

  it('review fixes: paging cursors, goal and evidence paging, discard of a cycle holding one’s own review', async () => {
    await scenario(async (tx, fx, svc) => {
      const o = await openReview(tx, svc, fx);
      // An unknown cursor is refused (never silently restarting the list).
      expect(
        await failure(
          svc.cycles.reviews(fx.users.hrAdmin!, o.cycle.id, {
            limit: 1,
            afterId: '00000000-0000-4000-8000-000000000000',
          }),
        ),
      ).toEqual({ status: 400, code: 'PERFORMANCE_CURSOR_INVALID' });
      expect(
        await failure(
          svc.history.attention(fx.users.hrAdmin!, fx.orgA, {
            limit: 1,
            afterId: '00000000-0000-4000-8000-000000000000',
          }),
        ),
      ).toEqual({ status: 400, code: 'PERFORMANCE_CURSOR_INVALID' });
      // Goal and evidence lists page.
      for (const title of ['A', 'B', 'C']) {
        await svc.goals.create(
          {
            employmentAssignmentId: fx.assignmentTeamA,
            title: `Goal ${title}`,
            startDate: '2026-01-15',
          },
          o.self,
        );
      }
      const page1 = await svc.goals.mine(fx.selfUser1, undefined, { limit: 2 });
      expect(page1.items).toHaveLength(2);
      const page2 = await svc.goals.mine(fx.selfUser1, undefined, {
        limit: 2,
        afterId: page1.nextAfterId!,
      });
      expect(page2).toMatchObject({ nextAfterId: null });
      expect(page2.items).toHaveLength(1);
      const evidenceAdmin = ctx(fx.users.evidenceAdmin!);
      for (const title of ['One', 'Two']) {
        await svc.evidence.recordManual(
          {
            organizationId: fx.orgA,
            employeeId: fx.employee2,
            provider: 'TRAINING',
            kind: 'TRAINING',
            title,
            completedAt: '2026-05-20T12:00:00Z',
          },
          evidenceAdmin,
        );
      }
      const e1 = await svc.evidence.forEmployee(
        fx.users.hrAdmin!,
        fx.employee2,
        undefined,
        { limit: 1 },
      );
      expect(e1.items).toHaveLength(1);
      expect(e1.nextAfterId).toBeTruthy();
      // Discarding a draft cycle that holds the actor's own review is refused (D4).
      const { template } = await activeTemplate(svc, fx, { code: 'DRAFT-D4' });
      const admin = ctx(fx.users.cycleAdmin!);
      const draft = await svc.cycles.create(
        cycleInput(fx, template.id, { code: 'draft-d4' }),
        admin,
      );
      await svc.cycles.addReviews(
        draft.id,
        { assignmentIds: [fx.assignmentTeamA] },
        admin,
      );
      expect(
        await failure(svc.cycles.discard(draft.id, ctx(fx.selfUser1))),
      ).toEqual({ status: 403, code: 'PERFORMANCE_SELF_MANAGEMENT' });
      await svc.cycles.discard(draft.id, admin);
    });
  });
});
