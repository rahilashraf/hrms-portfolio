import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service.js';
import { PayrollClock } from '../src/payroll/payroll-common.js';
import { ReportingClock } from '../src/reporting/reporting-common.js';
import { LEAVE_USERS } from './support/leave-fixtures.js';
import { FixedPayrollClock, payGroup } from './support/payroll-fixtures.js';
import { compensation, PAYROLL_WORLD_USERS } from './support/payroll-world.js';
import { FixedReportingClock } from './support/reporting-fixtures.js';
import { FixedClock } from './support/time-fixtures.js';
import { withTimeHttp } from './support/time-http.js';
import { createSchedulingFixtures } from './support/scheduling-fixtures.js';

config({ path: '../../.env' });

class RollbackFixtures extends Error {}

const REPORT = ['report.read', 'report.export'];
const USERS = {
  ...PAYROLL_WORLD_USERS,
  registerReader: [
    { permissions: ['payroll.read', ...REPORT], scope: 'org' as const },
  ],
  self1: LEAVE_USERS.self1,
  self2: LEAVE_USERS.self2,
};

/**
 * Batch 6A — the payroll API end to end over HTTP: the whole application (real guards, pipes,
 * controllers and services) on the scenario's rollback transaction. Calendars (create, edit
 * until periods exist, end), periods, a run through calculate → approve → finalize with an
 * off-cycle adjustment created and another cancelled, My Pay, the payroll register report, and
 * authorization and organization isolation on every route used.
 */
describe('Payroll API (HTTP, database)', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService(process.env.DATABASE_URL!);
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it('calendars → periods → run → adjustments → approve → finalize → My Pay → register', async () => {
    await expect(
      prisma.$transaction(
        async (tx) => {
          const fx = await createSchedulingFixtures(tx, USERS);
          try {
            await tx.organization.update({
              where: { id: fx.orgA },
              data: { timezone: 'America/Toronto' },
            });
            const group = await payGroup(tx, fx.orgA, `PG-${fx.suffix}`);
            await compensation(tx, fx, fx.otherTeamA, {
              payBasis: 'SALARY',
              rateAmount: '52000',
              payGroupId: group.id,
            });
            await withTimeHttp(
              tx,
              new FixedClock(),
              async (http) => {
                const admin = await http.as(fx.users.payrollAdmin!);
                const reader = await http.as(fx.users.payrollReader!);
                const approver = await http.as(fx.users.approver!);
                const finalizer = await http.as(fx.users.finalizer!);
                const orgB = await http.as(fx.users.orgBPayroll!);
                const team = await http.as(fx.users.teamPayroll!);
                const hr = await http.as(fx.users.hr!);
                const self1 = await http.as(fx.selfUser1);
                const self2 = await http.as(fx.selfUser2);
                const org = `organizationId=${fx.orgA}`;

                // ── Calendars ─────────────────────────────────────────────
                await http
                  .anonymous()
                  .get(`/payroll/calendars?${org}`)
                  .expect(401);
                const rules = {
                  cadence: 'BIWEEKLY',
                  timezone: 'America/Toronto',
                  anchorDate: '2026-10-04',
                  payDateOffsetDays: 5,
                  processingCutoffOffsetDays: 2,
                };
                const calendarBody = {
                  ...rules,
                  payGroupId: group.id,
                  effectiveFrom: '2026-10-04',
                };
                await admin
                  .post('/payroll/calendars', {
                    ...calendarBody,
                    cadence: 'DAILY',
                  })
                  .expect(400);
                await admin
                  .post('/payroll/calendars', { ...calendarBody, extra: 1 })
                  .expect(400);
                for (const user of [reader, team, hr, orgB])
                  await user
                    .post('/payroll/calendars', calendarBody)
                    .expect(403);
                const calendar = (
                  await admin
                    .post('/payroll/calendars', calendarBody)
                    .expect(201)
                ).body as { id: string };

                const listed = (
                  await admin.get(`/payroll/calendars?${org}`).expect(200)
                ).body as {
                  items: Array<{
                    id: string;
                    actions: { canUpdate: boolean; canEnd: boolean };
                  }>;
                };
                expect(
                  listed.items.find((item) => item.id === calendar.id),
                ).toMatchObject({ actions: { canUpdate: true, canEnd: true } });
                const readerView = (
                  await reader.get(`/payroll/calendars?${org}`).expect(200)
                ).body as typeof listed;
                expect(
                  readerView.items.find((item) => item.id === calendar.id),
                ).toMatchObject({
                  actions: { canUpdate: false, canEnd: false },
                });
                await orgB.get(`/payroll/calendars?${org}`).expect(403);
                await self2.get(`/payroll/calendars?${org}`).expect(403);

                // Edited while it has no periods (not by a reader); strict dates.
                await reader
                  .patch(`/payroll/calendars/${calendar.id}`, {
                    ...rules,
                    effectiveFrom: '2026-10-04',
                  })
                  .expect(403);
                await admin
                  .patch(`/payroll/calendars/${calendar.id}`, {
                    ...rules,
                    effectiveFrom: '2026-10-4',
                  })
                  .expect(400);
                await admin
                  .patch(`/payroll/calendars/${calendar.id}`, {
                    ...rules,
                    processingCutoffOffsetDays: 3,
                    effectiveFrom: '2026-10-04',
                  })
                  .expect(200);

                // ── Pay group members (the adjustment picker) ─────────────
                const members = (
                  await reader
                    .get(`/payroll/pay-groups/${group.id}/members`)
                    .expect(200)
                ).body as {
                  items: Array<{
                    employmentAssignmentId: string;
                    employeeId: string;
                    currencies: string[];
                  }>;
                };
                expect(members.items).toEqual([
                  expect.objectContaining({
                    employmentAssignmentId: fx.otherTeamA,
                    employeeId: fx.employee2,
                    currencies: ['CAD'],
                  }),
                ]);
                await orgB
                  .get(`/payroll/pay-groups/${group.id}/members`)
                  .expect(403);
                await self2
                  .get(`/payroll/pay-groups/${group.id}/members`)
                  .expect(403);
                await reader
                  .get(
                    '/payroll/pay-groups/00000000-0000-4000-8000-000000000000/members',
                  )
                  .expect(404);
                await reader
                  .get('/payroll/pay-groups/nope/members')
                  .expect(400);

                // ── Periods ───────────────────────────────────────────────
                await reader
                  .post('/payroll/periods/generate', {
                    payGroupId: group.id,
                    throughDate: '2026-10-04',
                  })
                  .expect(403);
                await admin
                  .post('/payroll/periods/generate', {
                    payGroupId: group.id,
                    throughDate: '2026-10-04',
                  })
                  .expect(201);
                const periods = (
                  await reader
                    .get(`/payroll/periods?${org}&payGroupId=${group.id}`)
                    .expect(200)
                ).body as {
                  items: Array<{ id: string; payDate: string }>;
                };
                expect(periods.items).toEqual([
                  expect.objectContaining({ payDate: '2026-10-22' }),
                ]);
                const periodId = periods.items[0]!.id;
                // With periods, the calendar's rules no longer change (it can still be ended).
                const locked = await admin
                  .patch(`/payroll/calendars/${calendar.id}`, {
                    ...rules,
                    effectiveFrom: '2026-10-04',
                  })
                  .expect(409);
                expect(locked.body.code).toEqual(expect.any(String));
                const afterPeriods = (
                  await admin.get(`/payroll/calendars?${org}`).expect(200)
                ).body as typeof listed;
                expect(
                  afterPeriods.items.find((item) => item.id === calendar.id),
                ).toMatchObject({
                  actions: { canUpdate: false, canEnd: true },
                });
                await reader
                  .post(`/payroll/calendars/${calendar.id}/end`, {
                    effectiveTo: '2027-12-31',
                  })
                  .expect(403);
                await admin
                  .post(`/payroll/calendars/${calendar.id}/end`, {
                    effectiveTo: '31/12/2027',
                  })
                  .expect(400);

                // ── Run and adjustments ───────────────────────────────────
                await reader
                  .post('/payroll/runs', {
                    payrollPeriodId: periodId,
                    currency: 'CAD',
                  })
                  .expect(403);
                const run = (
                  await admin
                    .post('/payroll/runs', {
                      payrollPeriodId: periodId,
                      currency: 'CAD',
                    })
                    .expect(201)
                ).body as { id: string; status: string };
                await orgB.get(`/payroll/runs/${run.id}`).expect(403);
                await team.get(`/payroll/runs/${run.id}`).expect(403);

                const adjustment = (kind: string, amount: string) => ({
                  payGroupId: group.id,
                  employmentAssignmentId: fx.otherTeamA,
                  currency: 'CAD',
                  kind,
                  amount,
                  description: `Off-cycle ${kind.toLowerCase()}`,
                  reason: 'Batch 6A API',
                });
                await admin
                  .post('/payroll/adjustments', adjustment('BONUS', '1.00'))
                  .expect(400);
                await admin
                  .post('/payroll/adjustments', {
                    ...adjustment('EARNING', '1.00'),
                    employmentAssignmentId: 'not-a-uuid',
                  })
                  .expect(400);
                for (const user of [reader, orgB, self2])
                  await user
                    .post('/payroll/adjustments', adjustment('EARNING', '1.00'))
                    .expect(403);
                const bonus = (
                  await admin
                    .post(
                      '/payroll/adjustments',
                      adjustment('EARNING', '150.00'),
                    )
                    .expect(201)
                ).body as { id: string; status: string };
                expect(bonus.status).toBe('PENDING');
                const mistaken = (
                  await admin
                    .post(
                      '/payroll/adjustments',
                      adjustment('EARNING', '999.00'),
                    )
                    .expect(201)
                ).body as { id: string };
                await admin
                  .post(`/payroll/adjustments/${mistaken.id}/cancel`, {})
                  .expect(400);
                await reader
                  .post(`/payroll/adjustments/${mistaken.id}/cancel`, {
                    reason: 'No',
                  })
                  .expect(403);
                await orgB
                  .post(`/payroll/adjustments/${mistaken.id}/cancel`, {
                    reason: 'No',
                  })
                  .expect(403);
                const cancelled = await admin
                  .post(`/payroll/adjustments/${mistaken.id}/cancel`, {
                    reason: 'Entered twice',
                  })
                  .expect(201);
                expect(cancelled.body).toMatchObject({ status: 'CANCELLED' });
                const again = await admin
                  .post(`/payroll/adjustments/${mistaken.id}/cancel`, {
                    reason: 'Again',
                  })
                  .expect(409);
                expect(again.body.code).toBe('PAYROLL_ADJUSTMENT_NOT_PENDING');
                const pending = (
                  await reader
                    .get(`/payroll/adjustments?${org}&status=PENDING`)
                    .expect(200)
                ).body as { items: Array<{ id: string }> };
                expect(pending.items.map((item) => item.id)).toEqual([
                  bonus.id,
                ]);

                // ── Calculate → approve → finalize ───────────────────────
                await reader
                  .post(`/payroll/runs/${run.id}/calculate`)
                  .expect(403);
                const calculated = (
                  await admin
                    .post(`/payroll/runs/${run.id}/calculate`)
                    .expect(201)
                ).body as { status: string; totals: { grossAmount: string } };
                expect(calculated).toMatchObject({
                  status: 'CALCULATED',
                  totals: { grossAmount: '2150.00', netAmount: null },
                });
                // Not approved yet: nothing finalizes it.
                expect(
                  (
                    await admin
                      .post(`/payroll/runs/${run.id}/finalize`)
                      .expect(409)
                  ).body.code,
                ).toBe('PAYROLL_RUN_STATUS');
                await reader
                  .post(`/payroll/runs/${run.id}/approve`)
                  .expect(403);
                await approver
                  .post(`/payroll/runs/${run.id}/approve`)
                  .expect(201);
                await approver
                  .post(`/payroll/runs/${run.id}/finalize`)
                  .expect(403);
                // Nothing reaches My Pay before finalization.
                expect(
                  (
                    (await self2.get('/payroll/me/pay').expect(200)).body as {
                      items: unknown[];
                    }
                  ).items,
                ).toEqual([]);
                const finalized = (
                  await finalizer
                    .post(`/payroll/runs/${run.id}/finalize`)
                    .expect(201)
                ).body as { status: string };
                expect(finalized.status).toBe('FINALIZED');
                // Finalized payroll never changes.
                const recalc = await admin
                  .post(`/payroll/runs/${run.id}/calculate`)
                  .expect(409);
                expect(recalc.body.code).toEqual(expect.any(String));
                await admin
                  .post(`/payroll/adjustments/${bonus.id}/cancel`, {
                    reason: 'Late',
                  })
                  .expect(409);

                // ── My Pay ────────────────────────────────────────────────
                const mine = (await self2.get('/payroll/me/pay').expect(200))
                  .body as {
                  items: Array<{ id: string; grossAmount: string }>;
                };
                expect(mine.items).toEqual([
                  expect.objectContaining({ grossAmount: '2150.00' }),
                ]);
                const slipId = mine.items[0]!.id;
                const slip = (
                  await self2.get(`/payroll/me/pay/${slipId}`).expect(200)
                ).body as {
                  totals: Record<string, unknown>;
                  earnings: Array<{ type: string; amount: string }>;
                };
                expect(slip.totals).toMatchObject({
                  grossAmount: '2150.00',
                  netAmount: null,
                  netStatus: 'STATUTORY_NOT_CALCULATED',
                });
                expect(slip.earnings.map((line) => line.amount).sort()).toEqual(
                  ['150.00', '2000.00'],
                );
                await self1.get(`/payroll/me/pay/${slipId}`).expect(404);
                await self2.get('/payroll/me/pay/not-a-uuid').expect(400);
                await admin.get('/payroll/me/pay').expect(403);

                // Administrators read the same pay through the run (payroll.read only).
                const detail = (
                  await reader
                    .get(`/payroll/runs/${run.id}/employees/${slipId}`)
                    .expect(200)
                ).body as { grossAmount: string };
                expect(detail.grossAmount).toBe('2150.00');
                await orgB
                  .get(`/payroll/runs/${run.id}/employees/${slipId}`)
                  .expect(403);
                await self2
                  .get(`/payroll/runs/${run.id}/employees/${slipId}`)
                  .expect(403);

                // ── Payroll register ──────────────────────────────────────
                const range = `${org}&from=2026-10-01&to=2026-10-31`;
                const registerReader = await http.as(fx.users.registerReader!);
                const report = (
                  await registerReader
                    .get(`/reports/payroll.register?${range}`)
                    .expect(200)
                ).body as { rows: Array<Record<string, unknown>> };
                expect(report.rows).toEqual([
                  expect.objectContaining({
                    gross: 2150,
                    adjustmentEarnings: 150,
                    grossLessRecordedDeductions: 2150,
                    netPay: 'Not calculated',
                  }),
                ]);
                const csv = await registerReader
                  .get(`/reports/payroll.register/export.csv?${range}`)
                  .expect(200);
                expect(csv.headers['content-type']).toMatch(/^text\/csv/);
                expect(csv.headers['content-disposition']).toMatch(
                  /^attachment; filename="payroll-register-/,
                );
                expect(csv.text.split('\r\n')[0]).toContain(
                  'Gross less recorded deductions (NOT net pay)',
                );
                // payroll.read without report.read, and report readers without payroll.read: refused.
                await reader
                  .get(`/reports/payroll.register?${range}`)
                  .expect(403);
                await hr.get(`/reports/payroll.register?${range}`).expect(403);
              },
              [
                [PayrollClock, new FixedPayrollClock()],
                [ReportingClock, new FixedReportingClock()],
              ],
            );
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
