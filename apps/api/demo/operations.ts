import {
  EMPLOYEES,
  ORGANIZATIONS,
  type DemoOrganizationKey,
} from './dataset.js';
import { seedDemoPeople } from './people.js';
import { addDays, dateColumn, tally, type DemoWorld } from './workflows.js';

/**
 * Batch 11 — the demo's operational records: compensation, attendance, timesheets and payroll.
 *
 * Story: at Harbourline Outdoor Centre, salaried staff are paid from the "Salaried staff" pay
 * group and hourly camp counsellors from "Program staff (hourly)", both bi-weekly. Payroll
 * administrator Priya Raman prepares and calculates the runs; with payroll dual control
 * (security remediation M2, on by default) she never approves her own work, so the System
 * Owner approves and finalizes the hourly runs. The salaried run, which pays both of them, is
 * left calculated, awaiting an independent approver; so is the studio's (the System Owner set
 * its compensation and calculated it). Counsellors' hours for the two completed periods were
 * entered by their manager Daniel Okafor (with a reason, as a correction of a missed clock),
 * submitted on their behalf and approved by him. Harbourline Studio is paid monthly in INR.
 */

const PAY_GROUPS: Record<
  DemoOrganizationKey,
  ReadonlyArray<{
    code: string;
    name: string;
    members: 'SALARY' | 'HOURLY' | 'ALL';
  }>
> = {
  centre: [
    { code: 'SAL', name: 'Salaried staff', members: 'SALARY' },
    { code: 'HRL', name: 'Program staff (hourly)', members: 'HOURLY' },
  ],
  studio: [{ code: 'MON', name: 'Studio monthly', members: 'ALL' }],
};

const moneyString = (value: number) => value.toFixed(2);

async function ensurePayGroups(world: DemoWorld) {
  const { prisma } = world.context;
  const ids = new Map<string, string>();
  for (const key of Object.keys(PAY_GROUPS) as DemoOrganizationKey[]) {
    const organizationId = world.organizationIds[key];
    // The centre's payroll administrator configures the centre; the System Owner the studio.
    const actor = await world.session(key === 'centre' ? 'payroll' : 'owner');
    for (const group of PAY_GROUPS[key]) {
      const existing = await prisma.payGroup.findFirst({
        where: { organizationId, code: group.code },
        select: { id: true },
      });
      const id =
        existing?.id ??
        (
          await actor.post<{ id: string }>('/pay-groups', {
            organizationId,
            code: group.code,
            name: group.name,
          })
        ).id;
      ids.set(`${key}:${group.code}`, id);
      tally(world.summary, 'payGroups', !existing);
    }
  }
  return ids;
}

function payGroupFor(employee: (typeof EMPLOYEES)[number]) {
  if (employee.organization === 'studio') return 'studio:MON';
  return employee.pay.type === 'SALARY' ? 'centre:SAL' : 'centre:HRL';
}

async function ensureCompensation(
  world: DemoWorld,
  payGroups: Map<string, string>,
) {
  const { prisma } = world.context;
  for (const [number, employee] of world.employees) {
    const existing = await prisma.compensationRecord.findFirst({
      where: { employmentAssignmentId: employee.assignmentId },
      select: { id: true },
    });
    tally(world.summary, 'compensationRecords', !existing);
    if (existing) continue;
    const spec = employee.spec;
    // Nobody manages their own pay: the payroll administrator sets everyone's at the centre
    // except her own, which the System Owner sets; the System Owner sets the studio's.
    const actor =
      spec.organization === 'centre' && spec.account !== 'payroll'
        ? await world.session('payroll')
        : await world.session('owner');
    await actor.post(
      `/employment-assignments/${employee.assignmentId}/compensation`,
      {
        payBasis: spec.pay.type,
        rateAmount: moneyString(
          spec.pay.type === 'SALARY' ? spec.pay.annual : spec.pay.hourly,
        ),
        currency: ORGANIZATIONS[spec.organization].currency,
        effectiveFrom: world.date(-spec.hiredDaysAgo),
        payGroupId: payGroups.get(payGroupFor(spec)),
      },
    );
    void number;
  }
}

/** The first day of the month `months` before the reference date's month. */
function monthStart(referenceDate: string, months: number) {
  const [year, month] = referenceDate.split('-').map(Number);
  return new Date(Date.UTC(year!, month! - 1 - months, 1))
    .toISOString()
    .slice(0, 10);
}

async function ensureCalendars(
  world: DemoWorld,
  payGroups: Map<string, string>,
) {
  const { prisma } = world.context;
  const calendars = [
    {
      group: 'centre:SAL',
      cadence: 'BIWEEKLY',
      anchor: world.date(-28),
      actor: 'payroll' as const,
    },
    {
      group: 'centre:HRL',
      cadence: 'BIWEEKLY',
      anchor: world.date(-28),
      actor: 'payroll' as const,
    },
    {
      group: 'studio:MON',
      cadence: 'MONTHLY',
      anchor: monthStart(world.context.referenceDate, 2),
      actor: 'owner' as const,
    },
  ];
  for (const calendar of calendars) {
    const payGroupId = payGroups.get(calendar.group)!;
    const organization = calendar.group.startsWith('centre')
      ? 'centre'
      : 'studio';
    const existing = await prisma.payrollCalendar.findFirst({
      where: { payGroupId },
      select: { id: true },
    });
    const actor = await world.session(calendar.actor);
    if (!existing) {
      await actor.post('/payroll/calendars', {
        payGroupId,
        cadence: calendar.cadence,
        timezone: ORGANIZATIONS[organization].timezone,
        anchorDate: calendar.anchor,
        payDateOffsetDays: 5,
        processingCutoffOffsetDays: 2,
        effectiveFrom: calendar.anchor,
      });
    }
    tally(world.summary, 'payrollCalendars', !existing);
    // Periods through the current one (idempotent: existing periods are kept).
    await actor.post('/payroll/periods/generate', {
      payGroupId,
      throughDate:
        organization === 'centre'
          ? world.date(13)
          : addDays(monthStart(world.context.referenceDate, -1), -1),
    });
  }
}

/** Weekdays (Mon–Fri) from `start` to `end` inclusive. */
function weekdays(start: string, end: string) {
  const days: string[] = [];
  for (let day = start; day <= end; day = addDays(day, 1)) {
    const weekday = new Date(`${day}T00:00:00.000Z`).getUTCDay();
    if (weekday >= 1 && weekday <= 5) days.push(day);
  }
  return days;
}

/** Counsellors' shifts in the two completed periods, entered by their manager. */
async function ensureCounsellorHours(world: DemoWorld) {
  const { prisma } = world.context;
  const manager = await world.session('manager');
  const counsellors = [...world.employees.values()].filter(
    (employee) =>
      employee.spec.organization === 'centre' &&
      employee.spec.pay.type === 'HOURLY',
  );
  // A slightly different day for each person, so timesheets aren't identical copies.
  const pattern: Record<string, [string, string]> = {
    'HL-1005': ['08:30', '16:30'],
    'HL-1007': ['09:00', '17:00'],
    'HL-1008': ['10:00', '17:30'],
  };
  for (const counsellor of counsellors) {
    const [from, to] = pattern[counsellor.spec.number] ?? ['09:00', '17:00'];
    for (const day of weekdays(world.date(-28), world.date(-1))) {
      const existing = await prisma.timeEntry.findFirst({
        where: {
          employmentAssignmentId: counsellor.assignmentId,
          workDate: dateColumn(day),
        },
        select: { id: true },
      });
      tally(world.summary, 'timeEntries', !existing);
      if (existing) continue;
      await manager.post(`/time/employees/${counsellor.id}/entries`, {
        employmentAssignmentId: counsellor.assignmentId,
        startAt: `${day}T${from}`,
        endAt: `${day}T${to}`,
        reason:
          'Camp day recorded from the sign-in sheet (demonstration data).',
      });
    }
  }
}

async function ensurePayrollRuns(
  world: DemoWorld,
  payGroups: Map<string, string>,
) {
  const { prisma } = world.context;
  const manager = await world.session('manager');
  const payroll = await world.session('payroll');
  const owner = await world.session('owner');

  const periodFor = (group: string, start: string) =>
    prisma.payrollPeriod.findFirst({
      where: {
        payGroupId: payGroups.get(group)!,
        periodStart: dateColumn(start),
      },
      select: {
        id: true,
        timePeriodId: true,
        status: true,
        timesheetsMaterializedAt: true,
      },
    });

  // Hourly runs for the two completed periods: timesheets, approval, then payroll.
  for (const start of [world.date(-28), world.date(-14)]) {
    const period = await periodFor('centre:HRL', start);
    if (!period) throw new Error(`No hourly payroll period starting ${start}.`);
    if (!period.timesheetsMaterializedAt) {
      await payroll.post(
        `/payroll/periods/${period.id}/materialize-timesheets`,
      );
    }
    let changed = false;
    const counsellorIds = [...world.employees.values()]
      .filter(
        (employee) =>
          employee.spec.organization === 'centre' &&
          employee.spec.pay.type === 'HOURLY',
      )
      .map((employee) => employee.id);
    const timesheets = await prisma.timesheet.findMany({
      where: {
        timePeriodId: period.timePeriodId,
        employeeId: { in: counsellorIds },
      },
      select: {
        id: true,
        status: true,
        segments: { select: { id: true, status: true } },
      },
    });
    for (const timesheet of timesheets) {
      if (
        timesheet.status === 'OPEN' ||
        timesheet.status === 'CHANGES_REQUESTED'
      ) {
        changed = true;
        await manager.post(
          `/time/timesheets/${timesheet.id}/submit-on-behalf`,
          {
            reason:
              'Submitted for the counsellor from the camp sign-in sheet (demonstration data).',
          },
        );
      }
      const segments = await prisma.timesheetSegment.findMany({
        where: { timesheetId: timesheet.id },
        select: { id: true, status: true },
      });
      for (const segment of segments) {
        if (segment.status === 'APPROVED') continue;
        changed = true;
        await manager.post(`/time/timesheet-segments/${segment.id}/approve`, {
          note: 'Hours match the sign-in sheet.',
        });
      }
    }
    tally(world.summary, 'approvedTimesheetPeriods', changed);
    // Security remediation M2 (dual control): the payroll administrator prepares the run;
    // the System Owner — not paid by it, and the author of none of its compensation —
    // approves and finalizes it.
    await advanceRun(world, period.id, 'CAD', payroll, 'FINALIZED', owner);
  }

  // The salaried run for the last completed period: calculated, awaiting an approver who is
  // not paid by it (the payroll administrator is).
  const salaried = await periodFor('centre:SAL', world.date(-14));
  if (!salaried)
    throw new Error(
      'No salaried payroll period for the last completed period.',
    );
  await advanceRun(world, salaried.id, 'CAD', payroll, 'CALCULATED');

  // The studio's last completed month: calculated by the System Owner, who also set the studio's
  // compensation, so dual control leaves it awaiting an independent approver (the studio has
  // no second payroll administrator in the demo).
  const studioPeriod = await prisma.payrollPeriod.findFirst({
    where: {
      payGroupId: payGroups.get('studio:MON')!,
      periodStart: dateColumn(monthStart(world.context.referenceDate, 1)),
    },
    select: { id: true },
  });
  if (!studioPeriod)
    throw new Error('No studio payroll period for last month.');
  await advanceRun(world, studioPeriod.id, 'INR', owner, 'CALCULATED');
}

type RunStatus = 'CALCULATED' | 'APPROVED' | 'FINALIZED';
const ORDER = ['DRAFT', 'CALCULATED', 'APPROVED', 'FINALIZED'];

async function advanceRun(
  world: DemoWorld,
  payrollPeriodId: string,
  currency: string,
  actor: Awaited<ReturnType<DemoWorld['session']>>,
  target: RunStatus,
  /** M2: approves and finalizes (dual control): never the preparer. */
  approver: Awaited<ReturnType<DemoWorld['session']>> = actor,
) {
  const { prisma } = world.context;
  let run = await prisma.payrollRun.findFirst({
    where: { payrollPeriodId, currency, voidedAt: null },
    select: { id: true, status: true },
  });
  tally(world.summary, 'payrollRuns', !run);
  if (!run) {
    const created = await actor.post<{ id: string }>('/payroll/runs', {
      payrollPeriodId,
      currency,
    });
    run = { id: created.id, status: 'DRAFT' as never };
  }
  const steps: Array<[string, string]> = [
    ['CALCULATED', 'calculate'],
    ['APPROVED', 'approve'],
    ['FINALIZED', 'finalize'],
  ];
  for (const [status, action] of steps) {
    if (ORDER.indexOf(String(run.status)) >= ORDER.indexOf(status)) continue;
    if (ORDER.indexOf(status) > ORDER.indexOf(target)) break;
    await (action === 'calculate' ? actor : approver).post(
      `/payroll/runs/${run.id}/${action}`,
    );
    run = { ...run, status: status as never };
  }
}

export async function seedDemoOperations(world: DemoWorld) {
  world.context.log('Compensation, attendance and payroll…');
  const payGroups = await ensurePayGroups(world);
  await ensureCompensation(world, payGroups);
  await ensureCalendars(world, payGroups);
  await ensureCounsellorHours(world);
  await ensurePayrollRuns(world, payGroups);
  await seedDemoPeople(world);
}
