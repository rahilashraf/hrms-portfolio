import type { SchedulingFixtures, Tx } from './scheduling-fixtures.js';
import { seedTimePolicy } from './time-fixtures.js';

/**
 * Batch 4 fixtures: a second employment of Employee 1 in Organization B, so one person works in
 * two organizations (both assignments ACTIVE since 2026-01-01). Organization B gets its own job
 * title, position and the same live-clock policy as Organization A.
 */
export async function addOrganizationBAssignment(
  tx: Tx,
  fx: SchedulingFixtures,
  employeeId = fx.employee1,
) {
  // Organization B has no work location: its timezone comes from the organization.
  await tx.organization.update({
    where: { id: fx.orgB },
    data: { timezone: 'America/Toronto' },
  });
  const jobTitle = await tx.jobTitle.create({
    data: {
      organizationId: fx.orgB,
      name: 'Org B Associate',
      code: `JB-${fx.suffix}`,
    },
  });
  const position = await tx.position.create({
    data: {
      organizationId: fx.orgB,
      jobTitleId: jobTitle.id,
      name: 'Org B Associate',
      code: `PB-${fx.suffix}`,
    },
  });
  const assignment = await tx.employmentAssignment.create({
    data: {
      employeeId,
      positionId: position.id,
      employmentType: 'PART_TIME',
      status: 'ACTIVE',
      isPrimary: false,
      startDate: new Date('2026-01-01T00:00:00.000Z'),
    },
  });
  await seedTimePolicy(tx, fx.orgB);
  return { positionId: position.id, assignmentId: assignment.id };
}

/** A closed entry written directly (no punches): enough for reads, paging and timesheets. */
export async function closedEntry(
  tx: Tx,
  input: {
    employeeId: string;
    employmentAssignmentId: string;
    clockInAt: Date;
    clockOutAt: Date;
    workDate: string;
  },
) {
  return tx.timeEntry.create({
    data: {
      employeeId: input.employeeId,
      employmentAssignmentId: input.employmentAssignmentId,
      clockInAt: input.clockInAt,
      clockOutAt: input.clockOutAt,
      timezone: 'America/Toronto',
      workDate: new Date(`${input.workDate}T00:00:00.000Z`),
      status: 'CLOSED',
      source: 'MANUAL',
    },
  });
}
