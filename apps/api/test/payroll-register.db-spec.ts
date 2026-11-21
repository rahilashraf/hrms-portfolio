import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service.js';
import type { ReportResult } from '../src/reporting/reporting-common.js';
import type { RawReportFilters } from '../src/reporting/reporting-domain.js';
import { LEAVE_USERS } from './support/leave-fixtures.js';
import {
  FixedPayrollClock,
  payrollServices,
} from './support/payroll-fixtures.js';
import {
  failure,
  PAYROLL_WORLD_USERS,
  world,
} from './support/payroll-world.js';
import {
  FixedGoogleClock,
  googleTestServices,
} from './support/google-fixtures.js';
import {
  FixedReportingClock,
  reportingServices,
} from './support/reporting-fixtures.js';
import {
  createSchedulingFixtures,
  ctx,
  rollbackClient,
} from './support/scheduling-fixtures.js';

config({ path: '../../.env' });

class RollbackFixtures extends Error {}

const REPORT = ['report.read', 'report.export'];
/** Payroll world users plus report readers at each scope. */
const USERS = {
  ...PAYROLL_WORLD_USERS,
  registerReader: [
    { permissions: ['payroll.read', ...REPORT], scope: 'org' as const },
  ],
  reportOnly: [{ permissions: REPORT, scope: 'org' as const }],
  teamRegisterReader: [
    { permissions: ['payroll.read', ...REPORT], scope: 'teamA' as const },
  ],
  orgBRegisterReader: [
    { permissions: ['payroll.read', ...REPORT], scope: 'orgB' as const },
  ],
  // Batch 6A (6A-1): an employee who also reads payroll for the organization sees their own row.
  self2: [
    ...LEAVE_USERS.self2,
    { permissions: ['payroll.read', ...REPORT], scope: 'org' as const },
  ],
};

const RANGE = { from: '2026-10-01', to: '2026-10-31' };

/**
 * Batch 6A — the payroll register against the real payroll engine: a run calculated with an
 * off-cycle earning and deduction adjustment (and a cancelled one), approved and finalized. The
 * register must equal the run detail and the payslip, without counting the adjustments twice.
 */
describe('Payroll register (database)', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService(process.env.DATABASE_URL!);
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it('reports finalized runs only, equal to run details and payslips, adjustments included once', async () => {
    await expect(
      prisma.$transaction(
        async (tx) => {
          const fx = await createSchedulingFixtures(tx, USERS);
          const client = rollbackClient(tx);
          const svc = payrollServices(client, new FixedPayrollClock());
          const reports = reportingServices(
            client,
            new FixedReportingClock(),
            googleTestServices(client, new FixedGoogleClock()).sheets,
          );
          const register = (
            user: string,
            filters: RawReportFilters = RANGE,
            organizationId = fx.orgA,
          ): Promise<ReportResult> =>
            reports.run(
              fx.users[user] ?? user,
              'payroll.register',
              organizationId,
              filters,
            );
          try {
            const { admin, periodId, payGroupId } = await world(tx, fx, svc);
            const adjust = (kind: 'EARNING' | 'DEDUCTION', amount: string) =>
              svc.adjustments.createAdjustment(
                {
                  payGroupId,
                  employmentAssignmentId: fx.otherTeamA,
                  currency: 'CAD',
                  kind,
                  amount,
                  description: `Off-cycle ${kind.toLowerCase()}`,
                  reason: 'Batch 6A register',
                },
                admin,
              );
            const bonus = await adjust('EARNING', '150.00');
            const recovery = await adjust('DEDUCTION', '40.00');
            const cancelled = await adjust('EARNING', '999.00');

            // Cancellation: only payroll.adjust; only once; the cancelled amount never pays.
            expect(
              await failure(
                svc.adjustments.cancelAdjustment(
                  cancelled.id,
                  'No',
                  ctx(fx.users.payrollReader!),
                ),
              ),
            ).toMatchObject({ status: 403 });
            expect(
              await failure(
                svc.adjustments.cancelAdjustment(
                  cancelled.id,
                  'No',
                  ctx(fx.users.orgBPayroll!),
                ),
              ),
            ).toMatchObject({ status: 403 });
            await svc.adjustments.cancelAdjustment(
              cancelled.id,
              'Entered twice',
              admin,
            );
            expect(
              await failure(
                svc.adjustments.cancelAdjustment(cancelled.id, 'Again', admin),
              ),
            ).toEqual({ status: 409, code: 'PAYROLL_ADJUSTMENT_NOT_PENDING' });
            expect(
              await tx.auditLog.count({
                where: {
                  entityId: cancelled.id,
                  action: 'PAYROLL_ADJUSTMENT_CANCELLED',
                },
              }),
            ).toBe(1);

            // A formula-like name, snapshotted by the run (checked in the CSV below).
            const person = await tx.employee.findUniqueOrThrow({
              where: { id: fx.employee2 },
              select: { personId: true },
            });
            await tx.person.update({
              where: { id: person.personId },
              data: { preferredName: '=HYPERLINK("http://x","y")' },
            });
            const run = await svc.runs.createRun(
              { payrollPeriodId: periodId, currency: 'CAD' },
              admin,
            );
            await svc.runs.calculate(run.id, admin);
            await svc.lifecycle.approve(run.id, ctx(fx.users.approver!));

            // Not finalized: nothing is reported.
            expect((await register('registerReader')).rows).toEqual([]);

            await svc.lifecycle.finalize(run.id, ctx(fx.users.finalizer!));
            const finalized = await tx.payrollRun.findUniqueOrThrow({
              where: { id: run.id },
            });

            const result = await register('registerReader');
            expect(result.columns.map((column) => column.label)).toEqual([
              'Pay date',
              'Period start',
              'Period end',
              'Pay group',
              'Employee number',
              'Employee',
              'Currency',
              'Gross',
              'Recorded deductions',
              'Adjustment earnings (included in gross)',
              'Adjustment deductions (included in recorded deductions)',
              'Employer contributions',
              'Gross less recorded deductions (NOT net pay)',
              'Net pay',
            ]);
            const runEmployees = await tx.payrollRunEmployee.findMany({
              where: { payrollRunId: run.id },
            });
            const employee2 = runEmployees.find(
              (row) => row.employeeId === fx.employee2,
            )!;
            const row = result.rows.find(
              (r) => r.employeeNumber === employee2.employeeNumber,
            )!;
            // Salary 2,000.00 + the 150.00 adjustment (once); the 999.00 cancelled one is absent.
            expect(row).toEqual({
              payDate: '2026-10-22',
              periodStart: '2026-10-04',
              periodEnd: '2026-10-17',
              payGroupCode: `PG-${fx.suffix}`,
              employeeNumber: employee2.employeeNumber,
              employeeName: employee2.displayName,
              currency: 'CAD',
              gross: 2150,
              deductions: 40,
              adjustmentEarnings: 150,
              adjustmentDeductions: 40,
              employerContributions: 0,
              grossLessRecordedDeductions: 2110,
              netPay: 'Not calculated',
            });
            expect(
              await tx.payrollAdjustment.findMany({
                where: { id: { in: [bonus.id, recovery.id, cancelled.id] } },
                orderBy: { amount: 'asc' },
                select: { status: true, payrollRunId: true },
              }),
            ).toEqual([
              { status: 'APPLIED', payrollRunId: run.id },
              { status: 'APPLIED', payrollRunId: run.id },
              { status: 'CANCELLED', payrollRunId: null },
            ]);

            // Equal to the run detail and to the employee's payslip.
            const detail = await svc.reads.runEmployee(
              fx.users.payrollReader!,
              run.id,
              employee2.id,
            );
            expect([
              detail.grossAmount,
              detail.deductionAmount,
              detail.employerContributionAmount,
            ]).toEqual(['2150.00', '40.00', '0.00']);
            const slip = await svc.self.payslip(fx.selfUser2, employee2.id);
            expect(slip.totals).toMatchObject({
              grossAmount: '2150.00',
              deductionAmount: '40.00',
              netAmount: null,
            });
            expect(
              slip.earnings.reduce((sum, line) => sum + Number(line.amount), 0),
            ).toBe(row.gross);
            expect(
              slip.deductions.reduce(
                (sum, line) => sum + Number(line.amount),
                0,
              ),
            ).toBe(row.deductions);

            // The rows add up to the finalized run's totals; the totals note says the same.
            const sum = (key: string) =>
              Math.round(
                result.rows.reduce((total, r) => total + Number(r[key]), 0) *
                  100,
              ) / 100;
            expect(result.rows).toHaveLength(runEmployees.length);
            expect([
              sum('gross'),
              sum('deductions'),
              sum('employerContributions'),
            ]).toEqual([
              Number(finalized.grossAmount),
              Number(finalized.deductionAmount),
              Number(finalized.employerContributionAmount),
            ]);
            expect(result.notes).toEqual(
              expect.arrayContaining([
                expect.stringMatching(/already included in Gross/),
                expect.stringMatching(/^Net pay is not calculated/),
                `Totals (CAD): gross ${sum('gross')}, recorded deductions ${sum('deductions')}, employer contributions ${sum('employerContributions')}, gross less recorded deductions ${sum('grossLessRecordedDeductions')}.`,
              ]),
            );

            // 6A-1: the viewer's own pay row, under the same organization-level payroll.read.
            expect(
              (await register('self2')).rows.map((r) => r.employeeNumber),
            ).toContain(employee2.employeeNumber);

            // Organization-level payroll.read only; never another organization's payroll.
            for (const user of ['reportOnly', 'teamRegisterReader', 'hr']) {
              expect(await failure(register(user))).toMatchObject({
                status: 403,
              });
            }
            expect(await failure(register('orgBRegisterReader'))).toMatchObject(
              { status: 403 },
            );
            expect(
              (await register('orgBRegisterReader', RANGE, fx.orgB)).rows,
            ).toEqual([]);
            // Outside the pay date range: nothing.
            expect(
              (
                await register('registerReader', {
                  from: '2026-10-23',
                  to: '2026-12-31',
                })
              ).rows,
            ).toEqual([]);

            // CSV: formula-like text is neutralized; the label says it is not net pay.
            const csv = await reports.exportCsv(
              'payroll.register',
              fx.orgA,
              RANGE,
              ctx(fx.users.registerReader!),
            );
            expect(csv.content.split('\r\n')[0]).toContain(
              'Gross less recorded deductions (NOT net pay)',
            );
            expect(employee2.displayName).toMatch(/^=HYPERLINK/);
            expect(csv.content).toContain(`'=HYPERLINK`);
            expect(csv.content).not.toMatch(/(^|,)"?=HYPERLINK/m);

            // Reporting reads only: the finalized run is unchanged, its adjustments stay applied.
            expect(
              await tx.payrollRun.findUniqueOrThrow({ where: { id: run.id } }),
            ).toEqual(finalized);
            expect(
              await failure(
                svc.adjustments.cancelAdjustment(bonus.id, 'Late', admin),
              ),
            ).toEqual({ status: 409, code: 'PAYROLL_ADJUSTMENT_NOT_PENDING' });
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
