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

const goal = (assignmentId: string, overrides = {}) => ({
  employmentAssignmentId: assignmentId,
  title: 'Launch the reading programme',
  measure: 'Every Grade 3 student reads 10 books',
  startDate: '2026-01-15',
  dueDate: '2026-06-30',
  ...overrides,
});

describe('Performance goals (database)', () => {
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

  it('lets the employee and scoped HR manage goals of an assignment', async () => {
    await scenario(async (_tx, fx, svc) => {
      const self = ctx(fx.selfUser1);
      const own = await svc.goals.create(goal(fx.assignmentTeamA), self);
      expect(own).toMatchObject({
        status: 'NOT_STARTED',
        employeeId: fx.employee1,
      });
      // HR, payroll or benefits access never manages goals; readers only read.
      for (const user of ['hr', 'reader']) {
        expect(
          await failure(
            svc.goals.create(goal(fx.assignmentTeamA), ctx(fx.users[user]!)),
          ),
        ).toMatchObject({ status: 403 });
      }
      // Batch 7B (D8): another organization's assignment reads as missing.
      expect(
        await failure(
          svc.goals.create(goal(fx.assignmentTeamA), ctx(fx.users.orgBAdmin!)),
        ),
      ).toMatchObject({ status: 404 });
      // A Team A manager manages Team A goals, not the employee's Dept B assignment.
      const manager = ctx(fx.users.teamManager!);
      await svc.goals.create(
        goal(fx.assignmentTeamA, { title: 'Mentor a new teacher' }),
        manager,
      );
      expect(
        await failure(svc.goals.create(goal(fx.assignmentDeptB), manager)),
      ).toMatchObject({ status: 403 });
      const deptB = await svc.goals.create(
        goal(fx.assignmentDeptB, { title: 'Dept B goal' }),
        self,
      );
      expect(
        await failure(
          svc.goals.create(
            goal(fx.assignmentTeamA, { dueDate: '2026-01-01' }),
            self,
          ),
        ),
      ).toEqual({ status: 400, code: 'PERFORMANCE_DATES_INVALID' });
      expect(
        await failure(svc.goals.update(own.id, { progressPercent: 101 }, self)),
      ).toEqual({ status: 400, code: 'PERFORMANCE_PROGRESS_INVALID' });
      expect(
        (await svc.goals.me(fx.selfUser1)).assignments
          .map((a) => a.id)
          .sort((a, b) => a.localeCompare(b)),
      ).toEqual(
        [fx.assignmentTeamA, fx.assignmentDeptB].sort((a, b) =>
          a.localeCompare(b),
        ),
      );
      // Reads: the employee sees all their goals, the Team A manager only Team A's.
      expect((await svc.goals.mine(fx.selfUser1)).items).toHaveLength(3);
      expect(
        (await svc.goals.forEmployee(fx.users.teamManager!, fx.employee1)).items
          .map((g) => g.title)
          .sort(),
      ).toEqual(['Launch the reading programme', 'Mentor a new teacher']);
      expect(
        (await svc.goals.forEmployee(fx.users.reader!, fx.employee1)).items,
      ).toHaveLength(3);
      expect(
        await failure(svc.goals.forEmployee(fx.users.hr!, fx.employee1)),
      ).toMatchObject({
        status: 403,
      });
      expect(deptB.employmentAssignmentId).toBe(fx.assignmentDeptB);
    });
  });

  it('tracks progress, then freezes completed and cancelled goals', async () => {
    await scenario(async (_tx, fx, svc) => {
      const self = ctx(fx.selfUser1);
      const row = await svc.goals.create(goal(fx.assignmentTeamA), self);
      expect(
        await svc.goals.update(
          row.id,
          { progressPercent: 40, status: 'IN_PROGRESS' },
          self,
        ),
      ).toMatchObject({ status: 'IN_PROGRESS', progressPercent: 40 });
      const done = await svc.goals.update(
        row.id,
        {
          status: 'COMPLETED',
          completionNotes: 'All students reached 10 books',
        },
        self,
      );
      expect(done).toMatchObject({ status: 'COMPLETED', progressPercent: 100 });
      expect(
        await failure(svc.goals.update(row.id, { title: 'Changed' }, self)),
      ).toEqual({
        status: 409,
        code: 'PERFORMANCE_GOAL_CLOSED',
      });
      const other = await svc.goals.create(
        goal(fx.assignmentTeamA, { title: 'Second' }),
        self,
      );
      expect(
        await failure(
          svc.goals.update(other.id, { status: 'CANCELLED' }, self),
        ),
      ).toEqual({
        status: 400,
        code: 'PERFORMANCE_REASON_REQUIRED',
      });
      expect(
        await svc.goals.update(
          other.id,
          { status: 'CANCELLED', cancellationReason: 'Programme replaced' },
          ctx(fx.users.teamManager!),
        ),
      ).toMatchObject({ status: 'CANCELLED' });
    });
  });

  it('links goals of the reviewed assignment only, by the reviewer or HR', async () => {
    await scenario(async (_tx, fx, svc) => {
      const { review, self, reviewer } = await openReview(_tx, svc, fx);
      const teamGoal = await svc.goals.create(goal(fx.assignmentTeamA), self);
      const deptGoal = await svc.goals.create(goal(fx.assignmentDeptB), self);
      expect(
        await failure(svc.goals.link(review.id, teamGoal.id, self)),
      ).toMatchObject({
        status: 403,
      });
      expect(
        await failure(svc.goals.link(review.id, deptGoal.id, reviewer)),
      ).toEqual({
        status: 400,
        code: 'PERFORMANCE_GOAL_OTHER_ASSIGNMENT',
      });
      // The active reviewer lists the reviewed assignment's goals only (not Dept B's).
      expect(
        (await svc.goals.forEmployee(fx.selfUser2, fx.employee1)).items.map(
          (g) => g.id,
        ),
      ).toEqual([teamGoal.id]);
      await svc.goals.link(review.id, teamGoal.id, reviewer);
      // Linking twice is a no-op.
      await svc.goals.link(review.id, teamGoal.id, reviewer);
      // The active reviewer can update progress of the assignment's goals.
      await svc.goals.update(
        teamGoal.id,
        { progressPercent: 70, status: 'IN_PROGRESS' },
        reviewer,
      );
      const detail = await svc.reviews.detail(fx.selfUser1, review.id);
      expect(detail.goals).toEqual([
        expect.objectContaining({
          goalId: teamGoal.id,
          progressPercent: 70,
          snapshotted: false,
        }),
      ]);
      await svc.goals.unlink(
        review.id,
        teamGoal.id,
        ctx(fx.users.teamManager!),
      );
      expect((await svc.reviews.detail(fx.selfUser1, review.id)).goals).toEqual(
        [],
      );
      // Once reassigned away, the former reviewer no longer touches the goals.
      await svc.reviews.reassignReviewer(
        review.id,
        { reviewerEmployeeId: null, reason: 'Left the school' },
        ctx(fx.users.teamManager!),
      );
      expect(
        await failure(
          svc.goals.update(teamGoal.id, { progressPercent: 80 }, reviewer),
        ),
      ).toMatchObject({ status: 403 });
    });
  });
});
