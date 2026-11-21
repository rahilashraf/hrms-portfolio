import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service.js';
import {
  FixedClock,
  grantMinutes,
  LEAVE_PERMISSIONS,
  LEAVE_USERS,
  leaveServices,
  seedLeaveConfig,
  TIME_PERMISSIONS,
} from './support/leave-fixtures.js';
import {
  createSchedulingFixtures,
  ctx,
  rollbackClient,
} from './support/scheduling-fixtures.js';
import { withTimeHttp } from './support/time-http.js';

config({ path: '../../.env' });

class RollbackFixtures extends Error {}

const MARCH = 'from=2027-03-01&to=2027-03-31';

/**
 * Batch 6B — the leave and holiday API end to end over HTTP: the whole application (real guards,
 * validation pipe, controllers, services) on the scenario's rollback transaction. Self-service
 * (overview, preview, submit, cancel, team calendar, holidays), management (on-behalf preview and
 * recording, queue and balance paging and employee filters, decisions, D5 self-decision
 * refusals for everyone), configuration (resolver, leave type edit), holidays, organization
 * isolation and the Leave switch.
 */
describe('Leave API (HTTP, database)', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService(process.env.DATABASE_URL!);
    await prisma.$connect();
  });
  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it('self-service, management, configuration and holidays over HTTP', async () => {
    await expect(
      prisma.$transaction(
        async (tx) => {
          const fx = await createSchedulingFixtures(tx, LEAVE_USERS, [
            ...LEAVE_PERMISSIONS,
            ...TIME_PERMISSIONS,
          ]);
          try {
            const clock = new FixedClock();
            const svc = leaveServices(rollbackClient(tx), clock);
            const types = await seedLeaveConfig(tx, fx, svc);
            await grantMinutes(
              svc,
              fx,
              fx.assignmentTeamA,
              types.vacation.id,
              4800,
            );
            const org = `organizationId=${fx.orgA}`;
            // Batch 6B (L7): an assignment-scoped policy is listed with names, in scope only.
            const assigned = await svc.config.createPolicy(
              {
                leaveTypeId: types.personal.id,
                organizationId: fx.orgA,
                scopeType: 'EMPLOYMENT_ASSIGNMENT',
                employmentAssignmentId: fx.assignmentTeamA,
                effectiveFrom: '2027-06-01',
              } as never,
              ctx(fx.users.hr!),
            );
            await withTimeHttp(tx, clock, async (http) => {
              const hr = await http.as(fx.users.hr!);
              const self1 = await http.as(fx.selfUser1);
              // self2: an employee who also approves leave for Team A (their own team).
              const self2 = await http.as(fx.selfUser2);
              const outsider = await http.as(fx.users.outsider!);
              const deptBReader = await http.as(fx.users.deptBReader!);

              await http.anonymous().get('/leave/me').expect(401);
              await http
                .anonymous()
                .get(`/leave/me/team-calendar?${MARCH}`)
                .expect(401);

              // ── Self-service ───────────────────────────────────────────────
              const overview = (await self1.get('/leave/me').expect(200))
                .body as {
                assignments: Array<{ employmentAssignmentId: string }>;
              };
              expect(
                overview.assignments.map((a) => a.employmentAssignmentId),
              ).toContain(fx.assignmentTeamA);
              const own = {
                employmentAssignmentId: fx.assignmentTeamA,
                leaveTypeId: types.vacation.id,
                startDate: '2027-03-03',
                endDate: '2027-03-04',
              };
              await self1
                .post('/leave/me/requests/preview', { ...own, extra: 1 })
                .expect(400);
              await self1
                .post('/leave/me/requests/preview', {
                  ...own,
                  startDate: '2027-3-3',
                })
                .expect(400);
              const preview = await self1
                .post('/leave/me/requests/preview', own)
                .expect(201);
              expect(preview.body.days).toHaveLength(2);
              const submitted = (
                await self1.post('/leave/me/requests', own).expect(201)
              ).body as { requestId: string; status: string };
              expect(submitted.status).toBe('PENDING');
              // (An employee without a read permission is checked below, on someone else's request.)

              // ── D5: no self-decision, whatever one holds ───────────────────
              const ownOfSelf2 = (
                await self2
                  .post('/leave/me/requests', {
                    employmentAssignmentId: fx.otherTeamA,
                    leaveTypeId: types.personal.id,
                    startDate: '2027-03-09',
                    endDate: '2027-03-09',
                  })
                  .expect(201)
              ).body as { requestId: string };
              // An employee without a leave read permission cannot read someone else's request.
              await self1
                .get(`/leave/me/requests/${ownOfSelf2.requestId}`)
                .expect(404);
              const refusal = await self2
                .post(`/leave/requests/${ownOfSelf2.requestId}/approve`, {})
                .expect(403);
              expect(refusal.body.code).toBe('LEAVE_SELF_APPROVAL');
              expect(
                (
                  await self2
                    .post('/leave/requests', {
                      employmentAssignmentId: fx.otherTeamA,
                      leaveTypeId: types.personal.id,
                      startDate: '2027-03-10',
                      endDate: '2027-03-10',
                      approve: true,
                    })
                    .expect(403)
                ).body.code,
              ).toBe('LEAVE_SELF_APPROVAL');
              // HR (organization-wide, every leave permission) decides it instead.
              await hr
                .post(`/leave/requests/${ownOfSelf2.requestId}/approve`, {})
                .expect(201);

              // A teammate approver decides someone else's leave.
              await self2
                .post(`/leave/requests/${submitted.requestId}/approve`, {})
                .expect(201);

              // ── On-behalf recording with preview ──────────────────────────
              const onBehalf = {
                employmentAssignmentId: fx.otherTeamA,
                leaveTypeId: types.personal.id,
                startDate: '2027-03-16',
                endDate: '2027-03-17',
              };
              await self1.post('/leave/requests/preview', onBehalf).expect(403);
              const managed = await hr
                .post('/leave/requests/preview', onBehalf)
                .expect(201);
              expect(managed.body.days).toHaveLength(2);
              await outsider.post('/leave/requests', onBehalf).expect(403);
              const recorded = (
                await hr
                  .post('/leave/requests', {
                    ...onBehalf,
                    approve: true,
                    note: 'Called in',
                  })
                  .expect(201)
              ).body as { requestId: string; status: string };
              expect(recorded.status).toBe('APPROVED');

              // ── Queue and balances: paging and employee filters ───────────
              const page1 = (
                await hr.get(`/leave/requests?${org}&limit=1`).expect(200)
              ).body as {
                items: Array<{ id: string }>;
                nextAfterId: string | null;
              };
              expect(page1.items).toHaveLength(1);
              expect(page1.nextAfterId).toEqual(expect.any(String));
              const page2 = (
                await hr
                  .get(
                    `/leave/requests?${org}&limit=1&afterId=${page1.nextAfterId}`,
                  )
                  .expect(200)
              ).body as { items: Array<{ id: string }> };
              expect(page2.items[0]!.id).not.toBe(page1.items[0]!.id);
              const forEmployee2 = (
                await hr
                  .get(`/leave/requests?${org}&employeeId=${fx.employee2}`)
                  .expect(200)
              ).body as { items: Array<{ employee: { id: string } }> };
              expect(forEmployee2.items.length).toBeGreaterThan(0);
              expect(
                forEmployee2.items.every((i) => i.employee.id === fx.employee2),
              ).toBe(true);
              await hr
                .get(`/leave/requests?${org}&employeeId=nope`)
                .expect(400);
              await hr.get(`/leave/requests?${org}&limit=500`).expect(400);
              const balances = (
                await hr
                  .get(
                    `/leave/balances?${org}&employeeId=${fx.employee1}&limit=1`,
                  )
                  .expect(200)
              ).body as { items: Array<{ employee: { id: string } }> };
              expect(
                balances.items.every((i) => i.employee.id === fx.employee1),
              ).toBe(true);
              // Another organization's administrator sees nothing of Org A.
              expect(
                (
                  (await outsider.get(`/leave/requests?${org}`).expect(200))
                    .body as {
                    items: unknown[];
                  }
                ).items,
              ).toEqual([]);
              await outsider
                .get(`/leave/requests/${recorded.requestId}`)
                .expect(404);
              await deptBReader
                .get(`/leave/requests/${recorded.requestId}`)
                .expect(404);

              // ── Configuration: resolver and leave type edit ───────────────
              const resolved = await hr
                .get(
                  `/leave/policies/resolve?employmentAssignmentId=${fx.assignmentTeamA}&leaveTypeId=${types.vacation.id}&date=2027-03-03`,
                )
                .expect(200);
              expect(resolved.body).toMatchObject({
                policy: expect.objectContaining({
                  id: types.vacationPolicy.id,
                }),
              });
              await self1
                .get(
                  `/leave/policies/resolve?employmentAssignmentId=${fx.assignmentTeamA}&leaveTypeId=${types.vacation.id}&date=2027-03-03`,
                )
                .expect(403);
              const edited = await hr
                .patch(`/leave/types/${types.vacation.id}`, {
                  name: 'Annual vacation',
                  description: 'Paid time away',
                  displayUnit: 'DAYS',
                })
                .expect(200);
              expect(edited.body).toMatchObject({
                name: 'Annual vacation',
                description: 'Paid time away',
                displayUnit: 'DAYS',
              });
              // Classification and balance tracking stay fixed.
              await hr
                .patch(`/leave/types/${types.vacation.id}`, {
                  classification: 'UNPAID',
                })
                .expect(400);
              await self1
                .patch(`/leave/types/${types.vacation.id}`, { name: 'X' })
                .expect(403);

              const listed = (
                (await hr.get(`/leave/policies?${org}`).expect(200)).body as {
                  items: Array<{ id: string; assignment: unknown }>;
                }
              ).items;
              expect(
                listed.find((p) => p.id === assigned.id)?.assignment,
              ).toEqual({
                employeeName: expect.any(String),
                employeeNumber: expect.any(String),
                positionName: expect.any(String),
              });
              expect(
                listed.find((p) => p.id === types.vacationPolicy.id)
                  ?.assignment,
              ).toBeNull();
              const outOfScope = (
                (await deptBReader.get(`/leave/policies?${org}`).expect(200))
                  .body as {
                  items: Array<{ id: string }>;
                }
              ).items;
              expect(outOfScope.map((p) => p.id)).not.toContain(assigned.id);

              // ── Holidays ──────────────────────────────────────────────────
              await self1
                .post('/holidays', {
                  organizationId: fx.orgA,
                  date: '2027-03-12',
                  name: 'Founders day',
                  kind: 'CLOSURE',
                })
                .expect(403);
              await hr
                .post('/holidays', {
                  organizationId: fx.orgA,
                  date: '2027-03-12',
                  name: 'Founders day',
                  kind: 'CLOSURE',
                })
                .expect(201);
              await self1.get(`/holidays?${org}&${MARCH}`).expect(403);
              const mine = (
                await self1.get(`/leave/me/holidays?${MARCH}`).expect(200)
              ).body as { items: Array<{ name: string }> };
              expect(mine.items.map((h) => h.name)).toEqual(['Founders day']);
              await self1.get('/leave/me/holidays?from=2027-03-01').expect(400);

              // ── Team calendar (D4) ────────────────────────────────────────
              const team = (
                await self1.get(`/leave/me/team-calendar?${MARCH}`).expect(200)
              ).body as {
                people: Array<{
                  displayName: string;
                  self: boolean;
                  absences: unknown[];
                }>;
              };
              expect(
                team.people.map((p) => [p.self, p.absences.length]),
              ).toEqual([
                [true, 2],
                [false, 3],
              ]);
              expect(JSON.stringify(team)).not.toMatch(
                /Personal|Vacation|PAID|APPROVED|Called in|requestId|minutes/,
              );
              await self1
                .get(`/leave/me/team-calendar?${MARCH}&teamId=${fx.teamA}`)
                .expect(400);
              await self1
                .get('/leave/me/team-calendar?from=2027-03-01&to=2027-06-01')
                .expect(400);
              await hr.get(`/leave/me/team-calendar?${MARCH}`).expect(403);

              // ── Own cancellation, then Leave switched off ─────────────────
              await self1
                .post(`/leave/me/requests/${submitted.requestId}/cancel`, {
                  reason: 'Plans changed',
                })
                .expect(201);
              // The approved future days are cancelled: they leave the team calendar.
              const after = (
                await self1.get(`/leave/me/team-calendar?${MARCH}`).expect(200)
              ).body as { people: Array<{ self: boolean }> };
              expect(after.people.filter((p) => p.self)).toEqual([]);
              await tx.organizationModuleSetting.create({
                data: {
                  organizationId: fx.orgA,
                  module: 'LEAVE',
                  enabled: false,
                },
              });
              await self1.get(`/leave/me/team-calendar?${MARCH}`).expect(403);
              await self1.get(`/leave/me/holidays?${MARCH}`).expect(403);
            });
          } catch (error) {
            console.error('SCENARIO FAILURE', error);
            throw error;
          }
          throw new RollbackFixtures();
        },
        { timeout: 120_000 },
      ),
    ).rejects.toBeInstanceOf(RollbackFixtures);
  });
});
