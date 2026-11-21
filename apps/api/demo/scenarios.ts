import {
  CLOCK_POLICY,
  EXTRA_ASSIGNMENTS,
  OPERATIONS_TEAMS,
  ORGANIZATIONS,
  SCHEDULED_TERMINATION,
  SEASONAL_EMPLOYEE,
  type DemoExtraAssignment,
} from './dataset.js';
import { dateColumn, tally, type DemoWorld } from './workflows.js';

/**
 * R5-A — records that demonstrate three existing features, created through the HTTP API like the
 * rest of the demo (read-only lookups for idempotence; nothing written to the database directly):
 *
 * - Employee lifecycle due panel: an overdue assignment end (Grace Mwangi), an upcoming one
 *   (Marcus Bell) and an assignment that ends with a scheduled — never applied — termination
 *   (Leo Brandt, a seasonal hire created here without compensation or time, so no payroll run
 *   includes him).
 * - Multi-assignment clock-in: Sofia Martins's second, non-primary assignment in the same
 *   organization, and a Programs attendance policy with live clocking so both are offered.
 * - Scoped structure management: two teams under the Operations department, created by the
 *   facilities coordinator, whose `organization.manage` covers that department only.
 *
 * Runs after the operational seed, so payroll runs, timesheets and schedules are created exactly
 * as before; none of these records carries compensation or time.
 */

const centreId = (world: DemoWorld) => world.organizationIds.centre;

/** Today's date (YYYY-MM-DD) in a time zone. */
export function localToday(timezone: string, now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

function employeeOf(world: DemoWorld, number: string) {
  const found = world.employees.get(number);
  if (!found) throw new Error(`Demo employee ${number} is missing.`);
  return found;
}

/** A job title and a position of that title (owner: organization.manage). */
async function ensurePosition(
  world: DemoWorld,
  spec: {
    positionCode: string;
    jobTitle: { code: string; name: string };
    department: string;
  },
) {
  const { prisma } = world.context;
  const owner = await world.session('owner');
  const organizationId = centreId(world);
  const base = `/organizations/${organizationId}`;
  const title = await prisma.jobTitle.findFirst({
    where: { organizationId, code: spec.jobTitle.code },
    select: { id: true },
  });
  const jobTitleId =
    title?.id ??
    (await owner.post<{ id: string }>(`${base}/job-titles`, spec.jobTitle)).id;
  tally(world.summary, 'jobTitles', !title);
  const found = await prisma.position.findFirst({
    where: { organizationId, code: spec.positionCode },
    select: { id: true },
  });
  const id =
    found?.id ??
    (
      await owner.post<{ id: string }>(`${base}/positions`, {
        code: spec.positionCode,
        name: spec.jobTitle.name,
        jobTitleId,
        departmentId: world.departmentIds.get(`centre:${spec.department}`),
      })
    ).id;
  tally(world.summary, 'positions', !found);
  return id;
}

/**
 * The seasonal hire, through the same employee-creation call as the demo's other employees
 * (System Owner), and nothing else: no compensation, no time, no account.
 */
async function ensureSeasonalEmployee(world: DemoWorld) {
  const { prisma } = world.context;
  const positionId = await ensurePosition(world, SEASONAL_EMPLOYEE);
  const existing = await prisma.employee.findUnique({
    where: { employeeNumber: SEASONAL_EMPLOYEE.number },
    select: { id: true },
  });
  tally(world.summary, 'employees', !existing);
  if (existing) return existing.id;
  const hireDate = world.date(SEASONAL_EMPLOYEE.hireOffset);
  await (
    await world.session('owner')
  ).post('/employees', {
    person: {
      firstName: SEASONAL_EMPLOYEE.firstName,
      lastName: SEASONAL_EMPLOYEE.lastName,
    },
    employeeNumber: SEASONAL_EMPLOYEE.number,
    hireDate,
    initialPositionId: positionId,
    initialEmploymentType: SEASONAL_EMPLOYEE.employmentType,
    initialStartDate: hireDate,
    initialPrimary: true,
  });
  return (
    await prisma.employee.findUniqueOrThrow({
      where: { employeeNumber: SEASONAL_EMPLOYEE.number },
      select: { id: true },
    })
  ).id;
}

/** Creates the assignment (HR administrator: employee.manage), then sets a past end if needed. */
async function ensureExtraAssignment(
  world: DemoWorld,
  spec: DemoExtraAssignment,
  positionId: string,
) {
  const { prisma } = world.context;
  const hr = await world.session('hr');
  const person = employeeOf(world, spec.employee);
  const startDate = world.date(spec.startOffset);
  const endDate = spec.endOffset === null ? null : world.date(spec.endOffset);
  let assignment = await prisma.employmentAssignment.findFirst({
    where: {
      employeeId: person.id,
      positionId,
      status: { not: 'CANCELLED' },
    },
    select: { id: true, endDate: true },
  });
  tally(world.summary, 'extraAssignments', !assignment);
  if (!assignment) {
    const created = await hr.post<{ id: string }>(
      `/employees/${person.id}/assignments`,
      {
        positionId,
        employmentType: spec.employmentType,
        startDate,
        ...(endDate && spec.endVia === 'create' ? { endDate } : {}),
        isPrimary: false,
        ...(spec.manager
          ? {
              managerAssignmentId: employeeOf(world, spec.manager).assignmentId,
            }
          : {}),
      },
    );
    assignment = {
      id: created.id,
      endDate: endDate && spec.endVia === 'create' ? dateColumn(endDate) : null,
    };
  }
  if (endDate && spec.endVia === 'correct' && assignment.endDate === null) {
    // The correction keeps the stored status: an ACTIVE assignment with a past end date is due
    // (shown as overdue) until someone applies the end. It never ends it here.
    await hr.patch(`/employees/${person.id}/assignments/${assignment.id}`, {
      employmentType: spec.employmentType,
      startDate,
      endDate,
    });
    tally(world.summary, 'assignmentEndsRecorded', true);
  } else if (spec.endVia === 'correct') {
    tally(world.summary, 'assignmentEndsRecorded', false);
  }
}

/**
 * Schedules (never applies) the seasonal hire's termination. The API applies a termination in the same
 * request when its date has already passed, so a date that is not still to come in the centre's
 * time zone is skipped instead: nobody is ever terminated by the seed.
 */
async function ensureScheduledTermination(
  world: DemoWorld,
  employeeId: string,
) {
  const { prisma } = world.context;
  const existing = await prisma.employeeTermination.findFirst({
    where: { employeeId },
    select: { id: true },
  });
  if (existing) {
    tally(world.summary, 'scheduledTerminations', false);
    return;
  }
  const terminationDate = world.date(SCHEDULED_TERMINATION.dateOffset);
  const today = localToday(ORGANIZATIONS.centre.timezone);
  if (terminationDate <= today) {
    world.summary.skipped.push(
      `Scheduled termination for ${SCHEDULED_TERMINATION.employee}: ${terminationDate} is not in the future (it would apply at once).`,
    );
    return;
  }
  const hr = await world.session('hr');
  await hr.post(`/employees/${employeeId}/terminate`, {
    terminationDate,
    reason: SCHEDULED_TERMINATION.reason,
  });
  tally(world.summary, 'scheduledTerminations', true);
}

/** The Programs attendance policy with live clocking (System Owner: time.manage_policy). */
async function ensureClockPolicy(world: DemoWorld) {
  const { prisma } = world.context;
  const departmentId = world.departmentIds.get(
    `${CLOCK_POLICY.organization}:${CLOCK_POLICY.department}`,
  )!;
  const existing = await prisma.timeAttendancePolicy.findFirst({
    where: { scopeType: 'DEPARTMENT', departmentId, archivedAt: null },
    select: { id: true },
  });
  tally(world.summary, 'timePolicies', !existing);
  if (existing) return;
  // Never retroactive (the API refuses a start in the past): the reference date, or the centre's
  // local today when the demo is first seeded later in the reference week.
  const today = localToday(ORGANIZATIONS[CLOCK_POLICY.organization].timezone);
  const effectiveFrom = today > world.date(0) ? today : world.date(0);
  await (
    await world.session('owner')
  ).post('/time/policies', {
    scopeType: 'DEPARTMENT',
    organizationId: world.organizationIds[CLOCK_POLICY.organization],
    departmentId,
    effectiveFrom,
    config: CLOCK_POLICY.config,
  });
}

/** Two teams under Operations, created by the facilities coordinator within her own scope. */
async function ensureOperationsTeams(world: DemoWorld) {
  const { prisma } = world.context;
  const organizationId = centreId(world);
  const departmentId = world.departmentIds.get('centre:OPS')!;
  for (const team of OPERATIONS_TEAMS) {
    const existing = await prisma.team.findFirst({
      where: { organizationId, code: team.code },
      select: { id: true },
    });
    tally(world.summary, 'teams', !existing);
    if (existing) continue;
    await (
      await world.session('facilities')
    ).post(`/organizations/${organizationId}/teams`, {
      ...team,
      departmentId,
    });
  }
}

export async function seedDemoScenarios(world: DemoWorld) {
  world.context.log('Lifecycle, multi-assignment and structure scenarios…');
  for (const spec of EXTRA_ASSIGNMENTS) {
    await ensureExtraAssignment(world, spec, await ensurePosition(world, spec));
  }
  await ensureScheduledTermination(world, await ensureSeasonalEmployee(world));
  await ensureClockPolicy(world);
  await ensureOperationsTeams(world);
}
