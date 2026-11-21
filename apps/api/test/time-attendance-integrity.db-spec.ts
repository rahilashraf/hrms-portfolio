import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  Prisma,
  type EmploymentAssignment,
} from '../src/generated/prisma/client.js';
import { PrismaService } from '../src/database/prisma.service.js';

config({ path: '../../.env' });

class RollbackFixtures extends Error {}

interface TimeFixtures {
  employeeId: string;
  otherEmployeeId: string;
  userId: string;
  otherUserId: string;
  assignment: EmploymentAssignment;
  secondAssignment: EmploymentAssignment;
  otherAssignment: EmploymentAssignment;
  organizationId: string;
  organizationalUnitId: string;
}

describe('Time attendance database integrity constraints', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error('DATABASE_URL is required.');
    prisma = new PrismaService(databaseUrl);
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it('enforces assignment-to-employee ownership on time entries', async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        const fixtures = await createTimeFixtures(tx);
        await tx.timeEntry.create({
          data: {
            employeeId: fixtures.employeeId,
            employmentAssignmentId: fixtures.otherAssignment.id,
            clockInAt: new Date('2026-10-02T13:00:00.000Z'),
            timezone: 'America/Toronto',
            workDate: new Date('2026-10-02T00:00:00.000Z'),
          },
        });
      }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/^P(2003|2010)$/) });
  });

  it('allows at most one open time entry per employee across assignments', async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        const fixtures = await createTimeFixtures(tx);
        await tx.timeEntry.create({
          data: {
            employeeId: fixtures.employeeId,
            employmentAssignmentId: fixtures.assignment.id,
            clockInAt: new Date('2026-10-02T13:00:00.000Z'),
            timezone: 'America/Toronto',
            workDate: new Date('2026-10-02T00:00:00.000Z'),
          },
        });
        await tx.timeEntry.create({
          data: {
            employeeId: fixtures.employeeId,
            employmentAssignmentId: fixtures.secondAssignment.id,
            clockInAt: new Date('2026-10-02T14:00:00.000Z'),
            timezone: 'America/Toronto',
            workDate: new Date('2026-10-02T00:00:00.000Z'),
          },
        });
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('rejects invalid time entry intervals and status shapes', async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        const fixtures = await createTimeFixtures(tx);
        await tx.timeEntry.create({
          data: {
            employeeId: fixtures.employeeId,
            employmentAssignmentId: fixtures.assignment.id,
            clockInAt: new Date('2026-10-02T13:00:00.000Z'),
            clockOutAt: new Date('2026-10-02T13:00:00.000Z'),
            status: 'CLOSED',
            timezone: 'America/Toronto',
            workDate: new Date('2026-10-02T00:00:00.000Z'),
          },
        });
      }),
    ).rejects.toMatchObject({
      code: expect.stringMatching(/^P(2004|2010|2039)$/),
    });

    await expect(
      prisma.$transaction(async (tx) => {
        const fixtures = await createTimeFixtures(tx);
        await tx.timeEntry.create({
          data: {
            employeeId: fixtures.employeeId,
            employmentAssignmentId: fixtures.assignment.id,
            clockInAt: new Date('2026-10-02T13:00:00.000Z'),
            clockOutAt: new Date('2026-10-02T17:00:00.000Z'),
            timezone: 'America/Toronto',
            workDate: new Date('2026-10-02T00:00:00.000Z'),
          },
        });
      }),
    ).rejects.toMatchObject({
      code: expect.stringMatching(/^P(2004|2010|2039)$/),
    });
  });

  it('keeps raw time punches immutable', async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        const fixtures = await createTimeFixtures(tx);
        const punch = await tx.timePunch.create({
          data: {
            employeeId: fixtures.employeeId,
            employmentAssignmentId: fixtures.assignment.id,
            type: 'CLOCK_IN',
            occurredAt: new Date('2026-10-02T13:00:00.000Z'),
            timezone: 'America/Toronto',
          },
        });
        await tx.timePunch.update({
          where: { id: punch.id },
          data: { timezone: 'America/Vancouver' },
        });
      }),
    ).rejects.toMatchObject({
      code: expect.stringMatching(/^P(2004|2010|2039)$/),
    });
  });

  it('enforces time policy scope shape and effective dates', async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        const fixtures = await createTimeFixtures(tx);
        await tx.timeAttendancePolicy.create({
          data: {
            scopeType: 'ORGANIZATIONAL_UNIT',
            organizationId: fixtures.organizationId,
            effectiveFrom: new Date('2026-10-02T00:00:00.000Z'),
            effectiveTo: new Date('2026-10-01T00:00:00.000Z'),
          },
        });
      }),
    ).rejects.toMatchObject({
      code: expect.stringMatching(/^P(2004|2010|2039)$/),
    });

    await expect(
      prisma.$transaction(async (tx) => {
        const fixtures = await createTimeFixtures(tx);
        await tx.timeAttendancePolicy.create({
          data: {
            scopeType: 'ORGANIZATIONAL_UNIT',
            organizationId: fixtures.organizationId,
            organizationalUnitId: fixtures.organizationalUnitId,
            effectiveFrom: new Date('2026-10-02T00:00:00.000Z'),
            config: { clock: { enabled: true } },
          },
        });
        throw new RollbackFixtures();
      }),
    ).rejects.toBeInstanceOf(RollbackFixtures);
  });

  it('allows at most one open break per time entry', async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        const fixtures = await createTimeFixtures(tx);
        const entry = await tx.timeEntry.create({
          data: {
            employeeId: fixtures.employeeId,
            employmentAssignmentId: fixtures.assignment.id,
            clockInAt: new Date('2026-10-02T13:00:00.000Z'),
            timezone: 'America/Toronto',
            workDate: new Date('2026-10-02T00:00:00.000Z'),
          },
        });
        await tx.breakEntry.create({
          data: {
            timeEntryId: entry.id,
            startAt: new Date('2026-10-02T15:00:00.000Z'),
          },
        });
        await tx.breakEntry.create({
          data: {
            timeEntryId: entry.id,
            startAt: new Date('2026-10-02T16:00:00.000Z'),
          },
        });
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('rejects invalid break intervals at the database boundary', async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        const fixtures = await createTimeFixtures(tx);
        const entry = await tx.timeEntry.create({
          data: {
            employeeId: fixtures.employeeId,
            employmentAssignmentId: fixtures.assignment.id,
            clockInAt: new Date('2026-10-02T13:00:00.000Z'),
            timezone: 'America/Toronto',
            workDate: new Date('2026-10-02T00:00:00.000Z'),
          },
        });
        await tx.breakEntry.create({
          data: {
            timeEntryId: entry.id,
            startAt: new Date('2026-10-02T15:00:00.000Z'),
            endAt: new Date('2026-10-02T15:00:00.000Z'),
          },
        });
      }),
    ).rejects.toMatchObject({
      code: expect.stringMatching(/^P(2004|2010|2039)$/),
    });
  });

  it('enforces attendance exception ownership and idempotent open exceptions', async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        const fixtures = await createTimeFixtures(tx);
        const entry = await tx.timeEntry.create({
          data: {
            employeeId: fixtures.employeeId,
            employmentAssignmentId: fixtures.assignment.id,
            clockInAt: new Date('2026-10-02T13:00:00.000Z'),
            timezone: 'America/Toronto',
            workDate: new Date('2026-10-02T00:00:00.000Z'),
          },
        });
        await tx.attendanceException.create({
          data: {
            employeeId: fixtures.employeeId,
            employmentAssignmentId: fixtures.assignment.id,
            timeEntryId: entry.id,
            type: 'MISSING_CLOCK_OUT',
            severity: 'ACTION_REQUIRED',
            workflowImpact: 'SUBMISSION_BLOCKING',
            status: 'OPEN',
          },
        });
        await tx.attendanceException.create({
          data: {
            employeeId: fixtures.employeeId,
            employmentAssignmentId: fixtures.assignment.id,
            timeEntryId: entry.id,
            type: 'MISSING_CLOCK_OUT',
            severity: 'ACTION_REQUIRED',
            workflowImpact: 'SUBMISSION_BLOCKING',
            status: 'OPEN',
          },
        });
      }),
    ).rejects.toMatchObject({ code: 'P2002' });

    await expect(
      prisma.$transaction(async (tx) => {
        const fixtures = await createTimeFixtures(tx);
        const entry = await tx.timeEntry.create({
          data: {
            employeeId: fixtures.employeeId,
            employmentAssignmentId: fixtures.assignment.id,
            clockInAt: new Date('2026-10-02T13:00:00.000Z'),
            timezone: 'America/Toronto',
            workDate: new Date('2026-10-02T00:00:00.000Z'),
          },
        });
        await tx.attendanceException.create({
          data: {
            employeeId: fixtures.otherEmployeeId,
            employmentAssignmentId: fixtures.assignment.id,
            timeEntryId: entry.id,
            type: 'MISSING_CLOCK_OUT',
            severity: 'ACTION_REQUIRED',
            workflowImpact: 'SUBMISSION_BLOCKING',
            status: 'OPEN',
          },
        });
      }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/^P(2003|2010)$/) });
  });

  it('enforces time correction request lifecycle and pending uniqueness', async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        const fixtures = await createTimeFixtures(tx);
        const entry = await tx.timeEntry.create({
          data: {
            employeeId: fixtures.employeeId,
            employmentAssignmentId: fixtures.assignment.id,
            clockInAt: new Date('2026-10-02T13:00:00.000Z'),
            clockOutAt: new Date('2026-10-02T21:00:00.000Z'),
            status: 'CLOSED',
            timezone: 'America/Toronto',
            workDate: new Date('2026-10-02T00:00:00.000Z'),
          },
        });
        await tx.timeCorrectionRequest.create({
          data: {
            employeeId: fixtures.employeeId,
            requestorUserId: fixtures.userId,
            timeEntryId: entry.id,
            employmentAssignmentId: fixtures.assignment.id,
            type: 'CHANGE_CLOCK_OUT',
            reason: 'Forgot actual end time',
            requestedValues: { clockOutAt: '2026-10-02T17:30' },
          },
        });
        await tx.timeCorrectionRequest.create({
          data: {
            employeeId: fixtures.employeeId,
            requestorUserId: fixtures.userId,
            timeEntryId: entry.id,
            employmentAssignmentId: fixtures.assignment.id,
            type: 'CHANGE_CLOCK_OUT',
            reason: 'Duplicate pending request',
            requestedValues: { clockOutAt: '2026-10-02T17:45' },
          },
        });
      }),
    ).rejects.toMatchObject({ code: 'P2002' });

    await expect(
      prisma.$transaction(async (tx) => {
        const fixtures = await createTimeFixtures(tx);
        await tx.timeCorrectionRequest.create({
          data: {
            employeeId: fixtures.employeeId,
            requestorUserId: fixtures.userId,
            reviewerUserId: fixtures.otherUserId,
            employmentAssignmentId: fixtures.assignment.id,
            type: 'ADD_MISSING_TIME_ENTRY',
            status: 'APPROVED',
            reason: 'Missing record',
            requestedValues: {
              startAt: '2026-10-02T08:00',
              endAt: '2026-10-02T12:00',
            },
          },
        });
      }),
    ).rejects.toMatchObject({
      code: expect.stringMatching(/^P(2004|2010|2039)$/),
    });
  });

  it('enforces time adjustment request uniqueness and target shape', async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        const fixtures = await createTimeFixtures(tx);
        const entry = await tx.timeEntry.create({
          data: {
            employeeId: fixtures.employeeId,
            employmentAssignmentId: fixtures.assignment.id,
            clockInAt: new Date('2026-10-02T13:00:00.000Z'),
            clockOutAt: new Date('2026-10-02T21:00:00.000Z'),
            status: 'CLOSED',
            timezone: 'America/Toronto',
            workDate: new Date('2026-10-02T00:00:00.000Z'),
          },
        });
        const request = await tx.timeCorrectionRequest.create({
          data: {
            employeeId: fixtures.employeeId,
            requestorUserId: fixtures.userId,
            reviewerUserId: fixtures.otherUserId,
            timeEntryId: entry.id,
            employmentAssignmentId: fixtures.assignment.id,
            type: 'CHANGE_CLOCK_OUT',
            status: 'APPROVED',
            reason: 'Correction',
            requestedValues: { clockOutAt: '2026-10-02T17:30' },
            reviewedAt: new Date('2026-10-03T00:00:00.000Z'),
          },
        });
        await tx.timeAdjustment.create({
          data: {
            correctionRequestId: request.id,
            employeeId: fixtures.employeeId,
            actorUserId: fixtures.otherUserId,
            timeEntryId: entry.id,
            employmentAssignmentId: fixtures.assignment.id,
            type: 'CHANGE_CLOCK_OUT',
            source: 'EMPLOYEE_APPROVED',
            reason: 'Approved',
            previousValues: { clockOutAt: '2026-10-02T17:00' },
            newValues: { clockOutAt: '2026-10-02T17:30' },
          },
        });
        await tx.timeAdjustment.create({
          data: {
            correctionRequestId: request.id,
            employeeId: fixtures.employeeId,
            actorUserId: fixtures.otherUserId,
            timeEntryId: entry.id,
            employmentAssignmentId: fixtures.assignment.id,
            type: 'CHANGE_CLOCK_OUT',
            source: 'EMPLOYEE_APPROVED',
            reason: 'Duplicate',
            previousValues: { clockOutAt: '2026-10-02T17:00' },
            newValues: { clockOutAt: '2026-10-02T17:30' },
          },
        });
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });
});

async function createTimeFixtures(
  tx: Prisma.TransactionClient,
): Promise<TimeFixtures> {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase();
  const organization = await tx.organization.create({
    data: { name: 'Time Test Org', code: `TIME-${suffix}` },
  });
  const unit = await tx.organizationalUnit.create({
    data: {
      organizationId: organization.id,
      name: 'Time Unit',
      code: `UNIT-${suffix}`,
    },
  });
  const jobTitle = await tx.jobTitle.create({
    data: {
      organizationId: organization.id,
      name: 'Time Test Title',
      code: `TITLE-${suffix}`,
    },
  });
  const firstPosition = await tx.position.create({
    data: {
      organizationId: organization.id,
      jobTitleId: jobTitle.id,
      organizationalUnitId: unit.id,
      name: 'Time Test Position',
      code: `POS-A-${suffix}`,
    },
  });
  const secondPosition = await tx.position.create({
    data: {
      organizationId: organization.id,
      jobTitleId: jobTitle.id,
      organizationalUnitId: unit.id,
      name: 'Time Test Secondary Position',
      code: `POS-B-${suffix}`,
    },
  });
  const otherPosition = await tx.position.create({
    data: {
      organizationId: organization.id,
      jobTitleId: jobTitle.id,
      organizationalUnitId: unit.id,
      name: 'Time Test Other Position',
      code: `POS-C-${suffix}`,
    },
  });
  const person = await tx.person.create({ data: {} });
  const otherPerson = await tx.person.create({ data: {} });
  const employee = await tx.employee.create({
    data: {
      personId: person.id,
      employeeNumber: `TIME-${suffix}`,
      hireDate: new Date('2026-10-01T00:00:00.000Z'),
    },
  });
  const otherEmployee = await tx.employee.create({
    data: {
      personId: otherPerson.id,
      employeeNumber: `TIME-OTHER-${suffix}`,
      hireDate: new Date('2026-10-01T00:00:00.000Z'),
    },
  });
  const user = await tx.user.create({
    data: {
      personId: person.id,
      email: `time-${suffix.toLowerCase()}@example.com`,
      status: 'ACTIVE',
    },
  });
  const otherUser = await tx.user.create({
    data: {
      personId: otherPerson.id,
      email: `time-other-${suffix.toLowerCase()}@example.com`,
      status: 'ACTIVE',
    },
  });
  const assignment = await tx.employmentAssignment.create({
    data: {
      employeeId: employee.id,
      positionId: firstPosition.id,
      employmentType: 'FULL_TIME',
      status: 'ACTIVE',
      startDate: new Date('2026-10-01T00:00:00.000Z'),
    },
  });
  const secondAssignment = await tx.employmentAssignment.create({
    data: {
      employeeId: employee.id,
      positionId: secondPosition.id,
      employmentType: 'PART_TIME',
      status: 'ACTIVE',
      startDate: new Date('2026-10-01T00:00:00.000Z'),
    },
  });
  const otherAssignment = await tx.employmentAssignment.create({
    data: {
      employeeId: otherEmployee.id,
      positionId: otherPosition.id,
      employmentType: 'FULL_TIME',
      status: 'ACTIVE',
      startDate: new Date('2026-10-01T00:00:00.000Z'),
    },
  });
  return {
    employeeId: employee.id,
    otherEmployeeId: otherEmployee.id,
    userId: user.id,
    otherUserId: otherUser.id,
    assignment,
    secondAssignment,
    otherAssignment,
    organizationId: organization.id,
    organizationalUnitId: unit.id,
  };
}
