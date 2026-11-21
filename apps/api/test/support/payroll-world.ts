import type { HttpException } from '@nestjs/common';
import { LEAVE_USERS } from './leave-fixtures.js';
import {
  d,
  PAYROLL_USERS,
  payGroup,
  type PayrollServices,
} from './payroll-fixtures.js';
import {
  ctx,
  rejection,
  type SchedulingFixtures,
  type Tx,
} from './scheduling-fixtures.js';

/** A payroll world shared by the calculation, lifecycle and adjustment specs. */
export const PAYROLL_WORLD_USERS = {
  ...PAYROLL_USERS,
  self1: LEAVE_USERS.self1,
  self2: LEAVE_USERS.self2,
  hr: [...PAYROLL_USERS.hr!, ...LEAVE_USERS.hr],
};

export interface World {
  tx: Tx;
  fx: SchedulingFixtures;
  svc: PayrollServices;
  admin: ReturnType<typeof ctx>;
  payGroupId: string;
  calendarId: string;
  periodId: string;
}

export const failure = async (promise: Promise<unknown>) => {
  const error = (await rejection(promise)) as HttpException;
  const body = error.getResponse?.() as { code?: string } | undefined;
  return { status: error.getStatus?.(), code: body?.code };
};

export const compensation = (
  tx: Tx,
  fx: SchedulingFixtures,
  employmentAssignmentId: string,
  values: {
    payBasis: 'HOURLY' | 'SALARY';
    rateAmount: string;
    payGroupId: string | null;
    currency?: string;
  },
) =>
  tx.compensationRecord.create({
    data: {
      employmentAssignmentId,
      organizationId: fx.orgA,
      recordType: 'INITIAL',
      payBasis: values.payBasis,
      rateAmount: values.rateAmount,
      currency: values.currency ?? 'CAD',
      effectiveFrom: d('2026-01-01'),
      payGroupId: values.payGroupId,
    },
  });

/** Pay group with a bi-weekly calendar; employee 1 hourly ($24.50), employee 2 salaried ($52,000). */
export async function world(
  tx: Tx,
  fx: SchedulingFixtures,
  svc: PayrollServices,
): Promise<World> {
  const admin = ctx(fx.users.payrollAdmin!);
  await tx.organization.update({
    where: { id: fx.orgA },
    data: { timezone: 'America/Toronto' },
  });
  const group = await payGroup(tx, fx.orgA, `PG-${fx.suffix}`);
  await compensation(tx, fx, fx.assignmentTeamA, {
    payBasis: 'HOURLY',
    rateAmount: '24.5',
    payGroupId: group.id,
  });
  await compensation(tx, fx, fx.otherTeamA, {
    payBasis: 'SALARY',
    rateAmount: '52000',
    payGroupId: group.id,
  });
  const calendar = await svc.calendars.createCalendar(
    {
      payGroupId: group.id,
      cadence: 'BIWEEKLY',
      timezone: 'America/Toronto',
      anchorDate: '2026-10-04',
      payDateOffsetDays: 5,
      processingCutoffOffsetDays: 2,
      effectiveFrom: '2026-10-04',
    },
    admin,
  );
  await svc.calendars.generatePeriods(
    { payGroupId: group.id, throughDate: '2026-10-04' },
    admin,
  );
  const period = await tx.payrollPeriod.findFirstOrThrow({
    where: { payGroupId: group.id },
  });
  return {
    tx,
    fx,
    svc,
    admin,
    payGroupId: group.id,
    calendarId: calendar.id,
    periodId: period.id,
  };
}

export async function lines(tx: Tx, runId: string, employeeId: string) {
  return tx.payrollEarningLine.findMany({
    where: { payrollRunId: runId, runAssignment: { employeeId } },
    orderBy: [{ type: 'asc' }, { workDate: 'asc' }],
    include: {
      timeSnapshot: true,
      compensationSnapshot: true,
      leaveSnapshot: true,
    },
  });
}

export async function issueCodes(tx: Tx, runId: string, employeeId?: string) {
  const rows = await tx.payrollValidationIssue.findMany({
    where: {
      payrollRunId: runId,
      ...(employeeId ? { runEmployee: { employeeId } } : {}),
    },
    orderBy: { code: 'asc' },
  });
  return rows.map((row) => `${row.severity}:${row.code}`);
}
