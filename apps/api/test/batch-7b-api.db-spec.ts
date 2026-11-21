import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service.js';
import { PerformanceClock } from '../src/performance/performance-common.js';
import { FixedClock } from './support/leave-fixtures.js';
import {
  activeTemplate,
  cycleInput,
  FixedPerformanceClock,
  PERFORMANCE_USERS,
  performanceServices,
} from './support/performance-fixtures.js';
import {
  createSchedulingFixtures,
  rollbackClient,
} from './support/scheduling-fixtures.js';
import { withTimeHttp } from './support/time-http.js';

config({ path: '../../.env' });

class RollbackFixtures extends Error {}

const USERS = {
  ...PERFORMANCE_USERS,
  reportReader: [
    {
      permissions: ['performance.read', 'report.read'],
      scope: 'org' as const,
    },
  ],
};

type ReviewView = {
  id: string;
  viewer: string;
  status: string;
  overallRating: { value: number } | null;
  responses: Record<string, { self?: unknown; reviewer?: unknown }>;
  form: Array<{ items: Array<{ id: string; prompt: string }> }>;
  actions: Record<string, boolean>;
};

/**
 * Batch 7B — Performance Management over HTTP: the whole application (real guards, validation
 * pipe, controllers, services) on the scenario's rollback transaction. One review's lifecycle
 * (cycle from pickers → targeted add → open → self → reviewer → finalize → acknowledge →
 * correction) with the confidentiality matrix checked at each stage, evidence with notes and
 * history, manager-set goals, reporting, validation and organization isolation.
 */
describe('Performance API (HTTP, database)', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService(process.env.DATABASE_URL!);
    await prisma.$connect();
  });
  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it('lifecycle, confidentiality matrix, evidence, goals and reports over HTTP', async () => {
    await expect(
      prisma.$transaction(
        async (tx) => {
          const fx = await createSchedulingFixtures(tx, USERS);
          const performanceClock = new FixedPerformanceClock();
          const svc = performanceServices(rollbackClient(tx), performanceClock);
          const { template } = await activeTemplate(svc, fx);
          // Employee 2 manages Employee 1 (the DIRECT_MANAGER reviewer).
          await tx.employmentAssignment.update({
            where: { id: fx.assignmentTeamA },
            data: { managerAssignmentId: fx.otherTeamA },
          });
          await withTimeHttp(
            tx,
            new FixedClock(),
            async (http) => {
              const org = `organizationId=${fx.orgA}`;
              const cycleAdmin = await http.as(fx.users.cycleAdmin!);
              const hr = await http.as(fx.users.hrAdmin!);
              const reader = await http.as(fx.users.reader!);
              const outsider = await http.as(fx.users.orgBAdmin!);
              const coreHr = await http.as(fx.users.hr!);
              const self = await http.as(fx.selfUser1);
              const reviewer = await http.as(fx.selfUser2);
              const evidenceAdmin = await http.as(fx.users.evidenceAdmin!);

              await http
                .anonymous()
                .get(`/performance/options?${org}&kind=employee`)
                .expect(401);
              await cycleAdmin
                .get(`/performance/options?${org}&kind=everyone`)
                .expect(400);

              // ── The cycle, from pickers ──────────────────────────────────────
              const cycle = (
                await cycleAdmin
                  .post('/performance/cycles', cycleInput(fx, template.id))
                  .expect(201)
              ).body as { id: string };
              const picked = (
                await cycleAdmin
                  .get(
                    `/performance/options?${org}&kind=assignment&search=${fx.suffix}`,
                  )
                  .expect(200)
              ).body as { items: Array<{ id: string }> };
              expect(picked.items.map((o) => o.id)).toContain(
                fx.assignmentTeamA,
              );
              expect(
                (
                  await cycleAdmin
                    .post(`/performance/cycles/${cycle.id}/reviews`, {
                      assignmentIds: [fx.assignmentTeamA],
                    })
                    .expect(201)
                ).body,
              ).toMatchObject({ added: 1, excludedOwn: 0 });
              await cycleAdmin
                .patch(`/performance/cycles/${cycle.id}`, {
                  name: 'Annual review 2026 (teachers)',
                })
                .expect(200);
              await cycleAdmin
                .post(`/performance/cycles/${cycle.id}/open`, {})
                .expect(201);
              const reviewId = (
                await tx.performanceReview.findFirstOrThrow({
                  where: { cycleId: cycle.id },
                })
              ).id;
              const view = async (
                as: typeof hr,
                status = 200,
              ): Promise<ReviewView> =>
                (
                  await as
                    .get(`/performance/reviews/${reviewId}`)
                    .expect(status)
                ).body as ReviewView;
              const first = await view(hr);
              const item = (prompt: string) =>
                first.form
                  .flatMap((section) => section.items)
                  .find((i) => i.prompt === prompt)!.id;

              // ── Self review ──────────────────────────────────────────────────
              await self
                .post(`/performance/reviews/${reviewId}/self`, {
                  answers: [
                    { itemId: item('Communication'), ratingValue: 4 },
                    { itemId: item('Highlights'), textValue: 'Reading club' },
                  ],
                })
                .expect(201);
              // A self draft stays with the employee.
              expect(
                JSON.stringify((await view(reviewer)).responses),
              ).not.toContain('Reading club');
              await self
                .post(`/performance/reviews/${reviewId}/self/submit`, {})
                .expect(201);

              // ── Reviewer draft: the confidentiality matrix ───────────────────
              await reviewer
                .post(`/performance/reviews/${reviewId}/reviewer`, {
                  answers: [
                    { itemId: item('Communication'), ratingValue: 4 },
                    { itemId: item('Reliability'), ratingValue: 3 },
                    {
                      itemId: item('Highlights'),
                      textValue: 'Private draft remark',
                    },
                  ],
                  overallRatingValue: 4,
                })
                .expect(201);
              const asReader = await view(reader);
              expect(asReader.overallRating).toBeNull();
              expect(JSON.stringify(asReader)).not.toContain(
                'Private draft remark',
              );
              const asSelf = await view(self);
              expect(asSelf.overallRating).toBeNull();
              expect(JSON.stringify(asSelf)).not.toContain(
                'Private draft remark',
              );
              expect((await view(hr)).overallRating).toMatchObject({
                value: 4,
              });
              expect((await view(reviewer)).overallRating).toMatchObject({
                value: 4,
              });
              await view(outsider, 404);
              await view(coreHr, 403);
              await reviewer
                .post(`/performance/reviews/${reviewId}/reviewer/submit`, {})
                .expect(201);
              expect((await view(reader)).overallRating).toMatchObject({
                value: 4,
              });
              // The employee still sees no outcome before finalization.
              expect((await view(self)).overallRating).toBeNull();

              // ── Finalize, acknowledge, correct ───────────────────────────────
              await reviewer
                .post(`/performance/reviews/${reviewId}/finalize`, {})
                .expect(403);
              await hr
                .post(`/performance/reviews/${reviewId}/finalize`, {})
                .expect(201);
              expect((await view(self)).overallRating).toMatchObject({
                value: 4,
              });
              await self
                .post(`/performance/reviews/${reviewId}/acknowledge`, {
                  comment: 'Thank you',
                })
                .expect(201);
              const duplicate = await hr
                .post(`/performance/reviews/${reviewId}/correct`, {
                  answers: [
                    { itemId: item('Reliability'), ratingValue: 4 },
                    { itemId: item('Reliability'), ratingValue: 5 },
                  ],
                  reason: 'Calibration',
                })
                .expect(400);
              expect(duplicate.body).toMatchObject({
                code: 'PERFORMANCE_ANSWER_DUPLICATE',
              });
              await hr
                .post(`/performance/reviews/${reviewId}/correct`, {
                  answers: [{ itemId: item('Reliability'), ratingValue: 4 }],
                  overallRatingValue: 5,
                  reason: 'Calibration',
                })
                .expect(201);
              expect((await view(self)).overallRating).toMatchObject({
                value: 5,
              });

              // ── Evidence with confidential notes ─────────────────────────────
              const evidence = (
                await evidenceAdmin
                  .post('/performance/evidence', {
                    organizationId: fx.orgA,
                    employeeId: fx.employee1,
                    provider: 'CERTIFICATION',
                    kind: 'CERTIFICATION',
                    title: 'First Aid',
                    completedAt: '2026-05-20T12:00:00Z',
                    notes: 'Confidential HR note',
                  })
                  .expect(201)
              ).body as { id: string };
              const corrected = (
                await evidenceAdmin
                  .post(`/performance/evidence/${evidence.id}/correct`, {
                    title: 'First Aid (CPR)',
                    reason: 'Course name',
                  })
                  .expect(201)
              ).body as { id: string };
              for (const [as, notes] of [
                [reader, false],
                [self, false],
                [hr, true],
              ] as const) {
                const list = await as
                  .get(`/performance/employees/${fx.employee1}/evidence`)
                  .expect(200);
                const history = await as
                  .get(`/performance/evidence/${corrected.id}/history`)
                  .expect(200);
                expect(
                  JSON.stringify([list.body, history.body]).includes(
                    'Confidential HR note',
                  ),
                ).toBe(notes);
              }
              await outsider
                .get(`/performance/evidence/${corrected.id}/history`)
                .expect(404);

              // ── Manager-set goals ────────────────────────────────────────────
              // (The review is finalized, so HR — not the former reviewer — sets it now.)
              const goal = (
                await hr
                  .post('/performance/goals', {
                    employmentAssignmentId: fx.assignmentTeamA,
                    title: 'Mentor a new teacher',
                    startDate: '2026-01-15',
                  })
                  .expect(201)
              ).body as { id: string; setBy: string };
              expect(goal.setBy).toBe('MANAGER');
              const refused = await self
                .patch(`/performance/goals/${goal.id}`, { status: 'COMPLETED' })
                .expect(403);
              expect(refused.body).toMatchObject({
                code: 'PERFORMANCE_GOAL_MANAGER_SET',
              });
              await self
                .patch(`/performance/goals/${goal.id}`, { progressPercent: 30 })
                .expect(200);

              // ── Reporting keeps both permissions and its aggregation ─────────
              const reportReader = await http.as(fx.users.reportReader!);
              await reportReader
                .get(`/reports/performance.cycle_completion?${org}`)
                .expect(200);
              await reader
                .get(`/reports/performance.cycle_completion?${org}`)
                .expect(403);

              // ── Organization isolation of cycles and configuration ───────────
              await outsider.get(`/performance/cycles/${cycle.id}`).expect(404);
              await outsider
                .patch(`/performance/templates/${template.id}`, { name: 'X' })
                .expect(404);
              await reader
                .patch(`/performance/templates/${template.id}`, { name: 'X' })
                .expect(403);
            },
            [[PerformanceClock, performanceClock]],
          );
          throw new RollbackFixtures();
        },
        { timeout: 120_000 },
      ),
    ).rejects.toBeInstanceOf(RollbackFixtures);
  });

  it('paging, refused cursors, discard and isolation over HTTP', async () => {
    await expect(
      prisma.$transaction(
        async (tx) => {
          const fx = await createSchedulingFixtures(tx, USERS);
          const performanceClock = new FixedPerformanceClock();
          const svc = performanceServices(rollbackClient(tx), performanceClock);
          const { template } = await activeTemplate(svc, fx);
          await withTimeHttp(
            tx,
            new FixedClock(),
            async (http) => {
              const hr = await http.as(fx.users.hrAdmin!);
              const self = await http.as(fx.selfUser1);
              const outsider = await http.as(fx.users.orgBAdmin!);
              for (const title of ['One', 'Two', 'Three']) {
                await hr
                  .post('/performance/goals', {
                    employmentAssignmentId: fx.assignmentTeamA,
                    title,
                    startDate: '2026-01-15',
                  })
                  .expect(201);
              }
              const first = (
                await self.get('/performance/me/goals?limit=2').expect(200)
              ).body as {
                total: number;
                nextAfterId: string;
                items: unknown[];
              };
              expect(first).toMatchObject({ total: 3 });
              expect(first.items).toHaveLength(2);
              const second = (
                await hr
                  .get(
                    `/performance/employees/${fx.employee1}/goals?limit=2&afterId=${first.nextAfterId}`,
                  )
                  .expect(200)
              ).body as { nextAfterId: string | null; items: unknown[] };
              expect(second).toMatchObject({ nextAfterId: null });
              expect(second.items).toHaveLength(1);
              // An unknown cursor is refused rather than silently restarting the list.
              const refused = await hr
                .get(
                  `/performance/employees/${fx.employee1}/evidence?limit=2&afterId=00000000-0000-4000-8000-000000000000`,
                )
                .expect(400);
              expect(refused.body).toMatchObject({
                code: 'PERFORMANCE_CURSOR_INVALID',
              });
              await hr
                .get(`/performance/employees/${fx.employee1}/goals?limit=0`)
                .expect(400);
              // Another organization's assignment reads as missing.
              await outsider
                .post('/performance/goals', {
                  employmentAssignmentId: fx.assignmentTeamA,
                  title: 'Probe',
                  startDate: '2026-01-15',
                })
                .expect(404);
              // A draft cycle is discarded by its cycle manager; others are refused. (The D4
              // refusal for a cycle manager's own review is in batch-7b-backend.db-spec.)
              const cycleAdmin = await http.as(fx.users.cycleAdmin!);
              const cycle = (
                await cycleAdmin
                  .post('/performance/cycles', cycleInput(fx, template.id))
                  .expect(201)
              ).body as { id: string };
              await self.delete(`/performance/cycles/${cycle.id}`).expect(403);
              await outsider
                .delete(`/performance/cycles/${cycle.id}`)
                .expect(404);
              await cycleAdmin
                .delete(`/performance/cycles/${cycle.id}`)
                .expect(200);
            },
            [[PerformanceClock, performanceClock]],
          );
          throw new RollbackFixtures();
        },
        { timeout: 120_000 },
      ),
    ).rejects.toBeInstanceOf(RollbackFixtures);
  });
});
