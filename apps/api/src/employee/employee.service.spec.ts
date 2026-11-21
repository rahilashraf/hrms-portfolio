import { describe, expect, it, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { EmployeeService } from './employee.service.js';

const context = { actorUserId: 'actor' };

function makeService(overrides: any = {}) {
  const tx: any = {
    person: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    employee: {
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    employmentAssignment: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
    },
    position: {
      findMany: vi.fn(),
      findUnique: vi.fn().mockResolvedValue({
        id: 'position',
        organizationId: 'org',
        archivedAt: null,
        workLocation: null,
        organization: { timezone: 'UTC' },
      }),
    },
    compensationRecord: { findMany: vi.fn().mockResolvedValue([]) },
    employeeTermination: { findFirst: vi.fn().mockResolvedValue(null) },
    employeeTerminationAssignment: { count: vi.fn().mockResolvedValue(0) },
    $queryRaw: vi.fn().mockResolvedValue([{ value: 1n }]),
    $executeRaw: vi.fn().mockResolvedValue(0),
  };
  const prisma: any = {
    ...tx,
    $transaction: vi.fn(async (fn: any) => fn(tx)),
  };
  const domain: any = {
    createAssignment: vi.fn().mockResolvedValue({ id: 'assignment' }),
    validateManagerRelationship: vi.fn().mockResolvedValue(undefined),
    assertManagerSameOrganization: vi.fn().mockResolvedValue(undefined),
  };
  const access: any = {
    assertPosition: vi.fn(),
    assertEmployee: vi.fn(),
    canPosition: vi.fn().mockResolvedValue(true),
    assertNotSelfTarget: vi.fn(),
    authorizeAttach: vi.fn().mockResolvedValue({ authority: 'VISIBLE' }),
    authorizeEmployeeWide: vi
      .fn()
      .mockResolvedValue({ authority: 'ASSIGNMENTS' }),
  };
  const authorization: any = {
    assertAccess: vi.fn(),
    can: vi.fn().mockResolvedValue(false),
    effectiveGrants: vi.fn().mockResolvedValue([]),
  };
  const targets: any = { resolvePosition: vi.fn() };
  const audit: any = { write: vi.fn().mockResolvedValue({}) };
  const lifecycle: any = {
    assertNoFinalizedBlockers: vi.fn(),
    finalizedBlockers: vi.fn().mockResolvedValue([]),
  };
  const service = new EmployeeService(
    prisma,
    domain,
    access,
    authorization,
    targets,
    audit,
    lifecycle,
  );
  return {
    service,
    prisma,
    tx,
    domain,
    access,
    authorization,
    targets,
    audit,
    ...overrides,
  };
}

describe('EmployeeService hardening', () => {
  it('rolls back person and employee creation when initial assignment fails', async () => {
    const setup = makeService();
    setup.tx.person.create.mockResolvedValue({ id: 'person' });
    setup.tx.employee.findUnique.mockResolvedValue(null);
    setup.tx.employee.create.mockResolvedValue({
      id: 'employee',
      employeeNumber: 'EMP-000001',
    });
    setup.domain.createAssignment.mockRejectedValue(
      new Error('invalid assignment'),
    );

    await expect(
      setup.service.create(
        {
          person: { firstName: 'A', lastName: 'B' },
          hireDate: '2026-01-01',
          initialPositionId: 'position',
          initialEmploymentType: 'FULL_TIME',
          initialStartDate: '2026-01-01',
        },
        context,
      ),
    ).rejects.toThrow('invalid assignment');
    expect(setup.prisma.$transaction).toHaveBeenCalledOnce();
  });

  it('allows scoped creation with an initial position without employee visibility lookup', async () => {
    const setup = makeService();
    setup.tx.person.create.mockResolvedValue({ id: 'person' });
    setup.tx.employee.findUnique.mockResolvedValue(null);
    setup.tx.employee.create.mockResolvedValue({
      id: 'employee',
      employeeNumber: 'EMP-000001',
    });
    setup.tx.employee.findUniqueOrThrow.mockResolvedValue({
      id: 'employee',
      employeeNumber: 'EMP-000001',
      status: 'ACTIVE',
      person: {},
    });
    await setup.service.create(
      {
        person: { firstName: 'A' },
        hireDate: '2026-01-01',
        initialPositionId: 'position',
        initialEmploymentType: 'FULL_TIME',
        initialStartDate: '2026-01-01',
      },
      context,
    );
    expect(setup.access.assertEmployee).not.toHaveBeenCalled();
    expect(setup.access.assertPosition).toHaveBeenCalledWith(
      'actor',
      'position',
    );
  });

  it('stores a normalized custom employee number on create', async () => {
    const setup = makeService();
    setup.tx.person.create.mockResolvedValue({ id: 'person' });
    setup.tx.employee.findUnique.mockResolvedValue(null);
    setup.tx.employee.create.mockResolvedValue({
      id: 'employee',
      employeeNumber: 'HBL-001',
    });
    setup.tx.employee.findUniqueOrThrow.mockResolvedValue({
      id: 'employee',
      employeeNumber: 'HBL-001',
      status: 'ACTIVE',
      person: {},
    });

    await setup.service.create(
      {
        person: { firstName: 'A' },
        employeeNumber: '  HBL-001  ',
        hireDate: '2026-01-01',
      },
      context,
    );

    expect(setup.tx.employee.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ employeeNumber: 'HBL-001' }),
      }),
    );
    expect(setup.tx.$queryRaw).not.toHaveBeenCalled();
  });

  it('rejects blank and duplicate custom employee numbers cleanly', async () => {
    const setup = makeService();
    await expect(
      setup.service.create(
        {
          person: { firstName: 'A' },
          employeeNumber: '   ',
          hireDate: '2026-01-01',
        },
        context,
      ),
    ).rejects.toThrow('Employee number is required when provided.');
    expect(setup.prisma.$transaction).not.toHaveBeenCalled();

    setup.tx.person.create.mockResolvedValue({ id: 'person' });
    setup.tx.employee.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'employee-existing' });
    await expect(
      setup.service.create(
        {
          person: { firstName: 'A' },
          employeeNumber: 'HBL-001',
          hireDate: '2026-01-01',
        },
        context,
      ),
    ).rejects.toThrow('Employee number is already in use.');
    expect(setup.tx.employee.create).not.toHaveBeenCalled();
  });

  it('reports employee number races from the database unique constraint', async () => {
    const setup = makeService();
    setup.tx.person.create.mockResolvedValue({ id: 'person' });
    setup.tx.employee.findUnique.mockResolvedValue(null);
    setup.tx.employee.create.mockRejectedValue({
      code: 'P2002',
      meta: { target: ['employeeNumber'] },
    });

    await expect(
      setup.service.create(
        {
          person: { firstName: 'A' },
          employeeNumber: 'HBL-001',
          hireDate: '2026-01-01',
        },
        context,
      ),
    ).rejects.toThrow('Employee number is already in use.');
  });

  it('uses approved safe directory display assignment ordering and cursor', async () => {
    const setup = makeService();
    setup.prisma.employee.findMany
      .mockResolvedValueOnce([
        {
          id: 'candidate-1',
          employeeNumber: 'E1',
          status: 'ACTIVE',
          person: {},
          assignments: [],
        },
      ])
      .mockResolvedValueOnce([]);
    setup.authorization.can.mockResolvedValue(true);
    const result = await setup.service.directory({ limit: 1 }, 'system');
    expect(result.items[0]).toMatchObject({
      id: 'candidate-1',
      terminationDate: null,
      displayAssignment: null,
    });
    expect(result.nextAfterId).toBeNull();
  });

  it('stops scanning once the page is full and points the cursor at the last returned row (Phase 19)', async () => {
    const setup = makeService();
    const row = (id: string) => ({
      id,
      employeeNumber: id,
      status: 'ACTIVE',
      person: {},
      assignments: [],
    });
    setup.prisma.employee.findMany.mockResolvedValueOnce(
      Array.from({ length: 50 }, (_, index) =>
        row(`e-${String(index).padStart(2, '0')}`),
      ),
    );
    setup.authorization.can.mockResolvedValue(true);
    const result = await setup.service.directory({ limit: 2 }, 'system');
    expect(result.items.map((item: { id: string }) => item.id)).toEqual([
      'e-00',
      'e-01',
    ]);
    expect(result.nextAfterId).toBe('e-01');
    // One batch only: the next page is proven by the third visible row, not by reading the table.
    expect(setup.prisma.employee.findMany).toHaveBeenCalledTimes(1);
  });

  it('applies organization filters for SYSTEM employee readers', async () => {
    const setup = makeService();
    setup.authorization.can.mockResolvedValue(true);
    setup.prisma.employee.findMany.mockResolvedValueOnce([
      rowWithAssignment('employee-1', { organizationId: 'org-1' }),
    ]);

    const result = await setup.service.directory(
      { organizationId: 'org-1' },
      'system',
    );

    expect(setup.prisma.employee.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          assignments: {
            some: {
              status: { not: 'CANCELLED' },
              position: { organizationId: 'org-1' },
            },
          },
        }),
      }),
    );
    expect(result.items.map((item: { id: string }) => item.id)).toEqual([
      'employee-1',
    ]);
  });

  it('applies job title filters for SYSTEM employee readers', async () => {
    const setup = makeService();
    setup.authorization.can.mockResolvedValue(true);
    setup.prisma.employee.findMany.mockResolvedValueOnce([
      rowWithAssignment('employee-1', { jobTitleId: 'job-1' }),
    ]);

    await setup.service.directory({ jobTitleId: 'job-1' }, 'system');

    expect(setup.prisma.employee.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          assignments: {
            some: {
              status: { not: 'CANCELLED' },
              position: { jobTitleId: 'job-1' },
            },
          },
        }),
      }),
    );
  });

  it('composes organization and job title filters for SYSTEM employee readers', async () => {
    const setup = makeService();
    setup.authorization.can.mockResolvedValue(true);
    setup.prisma.employee.findMany.mockResolvedValueOnce([
      rowWithAssignment('employee-1', {
        organizationId: 'org-1',
        jobTitleId: 'job-1',
      }),
    ]);

    await setup.service.directory(
      { organizationId: 'org-1', jobTitleId: 'job-1' },
      'system',
    );

    expect(setup.prisma.employee.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          assignments: {
            some: {
              status: { not: 'CANCELLED' },
              position: { organizationId: 'org-1', jobTitleId: 'job-1' },
            },
          },
        }),
      }),
    );
  });

  it('keeps scoped employee directory filters and excludes unauthorized matches', async () => {
    const setup = makeService();
    setup.authorization.can.mockResolvedValue(false);
    setup.prisma.employee.findMany.mockResolvedValueOnce([
      rowWithAssignment('hidden', {
        organizationId: 'org-1',
        jobTitleId: 'job-1',
      }),
      rowWithAssignment('visible', {
        organizationId: 'org-1',
        jobTitleId: 'job-1',
      }),
    ]);
    setup.access.canPosition
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    const result = await setup.service.directory(
      { organizationId: 'org-1', jobTitleId: 'job-1' },
      'scoped',
    );

    expect(setup.prisma.employee.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          assignments: {
            some: {
              status: { not: 'CANCELLED' },
              position: { organizationId: 'org-1', jobTitleId: 'job-1' },
            },
          },
        }),
      }),
    );
    expect(result.items.map((item: { id: string }) => item.id)).toEqual([
      'visible',
    ]);
  });

  it('keeps directory cursor pagination correct under filtering', async () => {
    const setup = makeService();
    setup.authorization.can.mockResolvedValue(true);
    setup.prisma.employee.findMany.mockResolvedValueOnce([
      rowWithAssignment('employee-1', { organizationId: 'org-1' }),
      rowWithAssignment('employee-2', { organizationId: 'org-1' }),
    ]);

    const result = await setup.service.directory(
      { organizationId: 'org-1', limit: 1 },
      'system',
    );

    expect(result.items.map((item: { id: string }) => item.id)).toEqual([
      'employee-1',
    ]);
    expect(result.nextAfterId).toBe('employee-1');
    expect(setup.prisma.employee.findMany).toHaveBeenCalledTimes(1);
  });

  it('returns a professional directory shape without contact information', async () => {
    const setup = makeService();
    setup.prisma.employee.findMany.mockResolvedValueOnce([
      {
        id: 'candidate-1',
        employeeNumber: 'E1',
        status: 'ACTIVE',
        person: {
          firstName: 'Ada',
          lastName: 'Lovelace',
          personalEmail: 'ada@example.com',
          phone: '555-0100',
        },
        assignments: [
          {
            id: 'assignment-1',
            positionId: 'position-1',
            employmentType: 'FULL_TIME',
            status: 'ACTIVE',
            startDate: new Date('2026-09-01T00:00:00.000Z'),
            endDate: null,
            isPrimary: true,
            position: {
              id: 'position-1',
              name: 'Platform Engineer',
              code: 'PE-1',
              organizationId: 'organization-1',
              jobTitleId: 'job-title-1',
              jobTitle: { id: 'job-title-1', name: 'Engineer', code: 'ENG' },
              organization: {
                id: 'organization-1',
                name: 'Acme',
                code: 'ACME',
              },
              team: { id: 'team-1', name: 'Platform', code: 'PLAT' },
            },
          },
        ],
      },
    ]);
    setup.prisma.employee.findMany.mockResolvedValueOnce([]);

    const result = await setup.service.directory({ limit: 1 }, 'user');

    expect(result.items[0]).toEqual(
      expect.objectContaining({
        person: {
          firstName: 'Ada',
          middleName: null,
          lastName: 'Lovelace',
          preferredName: null,
        },
        displayAssignment: expect.objectContaining({
          employmentType: 'FULL_TIME',
          startDate: '2026-09-01',
          position: {
            id: 'position-1',
            name: 'Platform Engineer',
            code: 'PE-1',
          },
          jobTitle: { id: 'job-title-1', name: 'Engineer', code: 'ENG' },
          organization: { id: 'organization-1', name: 'Acme', code: 'ACME' },
          placement: {
            type: 'TEAM',
            id: 'team-1',
            name: 'Platform',
            code: 'PLAT',
          },
        }),
      }),
    );
    expect(result.items[0]!.person).not.toHaveProperty('personalEmail');
    expect(result.items[0]!.person).not.toHaveProperty('phone');
  });

  it('returns NotFound for a profile with no readable non-cancelled assignment', async () => {
    const setup = makeService();
    setup.prisma.employee.findUnique.mockResolvedValue({
      id: 'employee',
      employeeNumber: 'E1',
      status: 'ACTIVE',
      person: {},
      assignments: [
        {
          id: 'cancelled',
          status: 'CANCELLED',
          positionId: 'position',
          position: {},
          manager: null,
        },
      ],
    });
    setup.access.canPosition.mockResolvedValue(false);
    await expect(
      setup.service.profile('employee', 'user'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('groups historical assignments by end date rather than lifecycle status', async () => {
    const setup = makeService();
    const yesterday = new Date(Date.now() - 86_400_000);
    setup.prisma.employee.findUnique.mockResolvedValue({
      id: 'employee',
      employeeNumber: 'E1',
      status: 'ACTIVE',
      person: {},
      assignments: [
        {
          id: 'old',
          status: 'ACTIVE',
          startDate: new Date('2020-01-01'),
          endDate: yesterday,
          positionId: 'position',
          position: {
            id: 'position',
            name: 'P',
            code: 'P',
            organizationId: 'org',
            jobTitleId: 'job',
            jobTitle: {},
          },
          manager: null,
        },
      ],
    });
    const result = await setup.service.profile('employee', 'user');
    expect(result.assignments.historical).toHaveLength(1);
  });

  it('groups assignments ending today as current with date-only inclusivity', async () => {
    const setup = makeService();
    const today = new Date().toISOString().slice(0, 10);
    const todayDate = new Date(`${today}T00:00:00.000Z`);
    setup.prisma.employee.findUnique.mockResolvedValue({
      id: 'employee',
      employeeNumber: 'E1',
      status: 'ACTIVE',
      hireDate: new Date('2026-01-01T00:00:00.000Z'),
      terminationDate: null,
      person: {},
      assignments: [
        {
          id: 'ending-today',
          status: 'ENDED',
          employmentType: 'FULL_TIME',
          startDate: new Date('2020-01-01T00:00:00.000Z'),
          endDate: todayDate,
          isPrimary: true,
          positionId: 'position',
          position: {
            id: 'position',
            name: 'P',
            code: 'P',
            organizationId: 'org',
            jobTitleId: 'job',
            jobTitle: {},
          },
          manager: null,
        },
      ],
    });

    const result = await setup.service.profile('employee', 'user');

    expect(result.assignments.current).toHaveLength(1);
    expect(result.assignments.historical).toHaveLength(0);
  });

  it('returns enriched profile assignments and date-only employee dates', async () => {
    const setup = makeService();
    const today = new Date();
    setup.prisma.employee.findUnique.mockResolvedValue({
      id: 'employee',
      employeeNumber: 'E1',
      status: 'ACTIVE',
      hireDate: new Date('2026-01-02T00:00:00.000Z'),
      terminationDate: null,
      person: {
        firstName: 'Ada',
        middleName: null,
        lastName: 'Lovelace',
        preferredName: 'Ada',
        personalEmail: 'ada@example.com',
        phone: '555-0100',
      },
      assignments: [
        {
          id: 'assignment',
          employeeId: 'employee',
          positionId: 'position',
          employmentType: 'FULL_TIME',
          status: 'ACTIVE',
          startDate: new Date(today.getTime() - 86_400_000),
          endDate: null,
          isPrimary: true,
          managerAssignmentId: 'manager-assignment',
          position: {
            id: 'position',
            name: 'Platform Engineer',
            code: 'PE-1',
            organizationId: 'organization',
            jobTitleId: 'job-title',
            jobTitle: { id: 'job-title', name: 'Engineer', code: 'ENG' },
            organization: { id: 'organization', name: 'Acme', code: 'ACME' },
            organizationalUnit: {
              id: 'unit',
              name: 'Technology',
              code: 'TECH',
            },
            workLocation: { id: 'location', name: 'HQ', code: 'HQ' },
          },
          manager: {
            id: 'manager-assignment',
            employeeId: 'manager-employee',
            positionId: 'manager-position',
            position: { name: 'Engineering Manager' },
            employee: {
              employeeNumber: 'E2',
              person: {
                firstName: 'Grace',
                lastName: 'Hopper',
                preferredName: null,
              },
            },
          },
        },
      ],
    });

    const result = await setup.service.profile('employee', 'user');
    const assignment = result.assignments.current[0];

    expect(result.hireDate).toBe('2026-01-02');
    expect(result.terminationDate).toBeNull();
    expect(result.person.personalEmail).toBe('ada@example.com');
    expect(assignment).toEqual(
      expect.objectContaining({
        employmentType: 'FULL_TIME',
        startDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        position: { id: 'position', name: 'Platform Engineer', code: 'PE-1' },
        jobTitle: { id: 'job-title', name: 'Engineer', code: 'ENG' },
        organization: { id: 'organization', name: 'Acme', code: 'ACME' },
        placement: {
          type: 'ORGANIZATIONAL_UNIT',
          id: 'unit',
          name: 'Technology',
          code: 'TECH',
        },
        workLocation: { id: 'location', name: 'HQ', code: 'HQ' },
        manager: {
          assignmentId: 'manager-assignment',
          employeeId: 'manager-employee',
          employeeNumber: 'E2',
          displayName: 'Grace Hopper',
          positionName: 'Engineering Manager',
        },
      }),
    );
    expect(assignment).not.toHaveProperty('managerAssignmentId');
  });

  it('redacts an unreadable manager without leaking manager identifiers', async () => {
    const setup = makeService();
    setup.access.canPosition
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    setup.prisma.employee.findUnique.mockResolvedValue({
      id: 'employee',
      employeeNumber: 'E1',
      status: 'ACTIVE',
      hireDate: new Date('2026-01-01T00:00:00.000Z'),
      terminationDate: null,
      person: { firstName: 'A', lastName: 'B' },
      assignments: [
        {
          id: 'assignment',
          employeeId: 'employee',
          positionId: 'position',
          employmentType: 'FULL_TIME',
          status: 'ACTIVE',
          startDate: new Date('2026-01-01T00:00:00.000Z'),
          endDate: null,
          isPrimary: false,
          manager: {
            id: 'hidden-manager-assignment',
            employeeId: 'hidden-manager-employee',
            positionId: 'hidden-manager-position',
            position: { name: 'Hidden manager position' },
            employee: {
              employeeNumber: 'E9',
              person: { firstName: 'Hidden', lastName: 'Manager' },
            },
          },
          position: {
            id: 'position',
            name: 'P',
            code: 'P',
            organizationId: 'org',
            jobTitleId: 'job',
            jobTitle: {},
          },
        },
      ],
    });

    const result = await setup.service.profile('employee', 'user');
    expect(result.assignments.current[0]!.manager).toBeNull();
    expect(JSON.stringify(result)).not.toContain('hidden-manager');
  });

  it('uses the approved assignment update audit action for correction', async () => {
    const setup = makeService();
    setup.tx.employmentAssignment.findFirst.mockResolvedValue({
      id: 'assignment',
      employeeId: 'employee',
      positionId: 'position',
      employmentType: 'FULL_TIME',
      startDate: new Date('2026-01-01'),
      endDate: null,
      isPrimary: false,
      managerAssignmentId: null,
      status: 'ACTIVE',
    });
    setup.tx.employmentAssignment.findMany.mockResolvedValue([]);
    setup.tx.employmentAssignment.update.mockResolvedValue({
      id: 'assignment',
    });
    await setup.service.correctAssignment(
      'employee',
      'assignment',
      { employmentType: 'PART_TIME', startDate: '2026-02-01' },
      context,
    );
    expect(setup.audit.write).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'EMPLOYMENT_ASSIGNMENT_UPDATED' }),
      setup.tx,
    );
  });

  it('rejects cancellation unless assignment is future planned', async () => {
    const setup = makeService();
    setup.tx.employmentAssignment.findFirst.mockResolvedValue({
      id: 'assignment',
      employeeId: 'employee',
      positionId: 'position',
      status: 'ACTIVE',
      startDate: new Date(),
    });
    await expect(
      setup.service.cancelAssignment('employee', 'assignment', context),
    ).rejects.toThrow('Only future planned');
  });

  it('requires manager position readability before linking a manager', async () => {
    const setup = makeService();
    setup.tx.employmentAssignment.findFirst.mockResolvedValue({
      id: 'assignment',
      employeeId: 'employee',
      positionId: 'position',
      startDate: new Date('2026-01-01'),
      endDate: null,
    });
    setup.tx.employmentAssignment.findUnique.mockResolvedValue({
      id: 'manager',
      employeeId: 'manager-employee',
      positionId: 'manager-position',
      status: 'ACTIVE',
      startDate: new Date('2026-01-01'),
      endDate: null,
      managerAssignmentId: null,
    });
    setup.access.assertPosition
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error('manager hidden');
      });
    await expect(
      setup.service.setManager('employee', 'assignment', 'manager', context),
    ).rejects.toThrow();
    expect(setup.access.assertPosition).toHaveBeenCalledWith(
      'actor',
      'position',
      'employee.manage',
      setup.tx,
    );
  });

  it('uses shared manager validation before linking a manager', async () => {
    const setup = makeService();
    const subordinate = {
      id: 'assignment',
      employeeId: 'employee',
      positionId: 'position',
      startDate: new Date('2026-01-01'),
      endDate: null,
      managerAssignmentId: null,
    };
    const manager = {
      id: 'manager',
      employeeId: 'manager-employee',
      positionId: 'manager-position',
      status: 'ACTIVE',
      startDate: new Date('2026-01-01'),
      endDate: null,
      managerAssignmentId: null,
    };
    setup.tx.employmentAssignment.findFirst.mockResolvedValue(subordinate);
    setup.tx.employmentAssignment.findUnique.mockResolvedValue(manager);
    setup.tx.employmentAssignment.update.mockResolvedValue({
      id: 'assignment',
      managerAssignmentId: 'manager',
    });

    await expect(
      setup.service.setManager('employee', 'assignment', 'manager', context),
    ).resolves.toEqual({ id: 'assignment', managerAssignmentId: 'manager' });

    expect(setup.access.assertPosition).toHaveBeenNthCalledWith(
      1,
      'actor',
      'position',
      'employee.manage',
      setup.tx,
    );
    expect(setup.access.assertPosition).toHaveBeenNthCalledWith(
      2,
      'actor',
      'manager-position',
      'employee.read',
      setup.tx,
    );
    expect(setup.domain.validateManagerRelationship).toHaveBeenCalledWith(
      setup.tx,
      subordinate,
      manager,
    );
    expect(setup.tx.employmentAssignment.update).toHaveBeenCalledWith({
      where: { id: 'assignment' },
      data: { managerAssignmentId: 'manager' },
    });
  });

  it('clears a manager without candidate validation', async () => {
    const setup = makeService();
    setup.tx.employmentAssignment.findFirst.mockResolvedValue({
      id: 'assignment',
      employeeId: 'employee',
      positionId: 'position',
      startDate: new Date('2026-01-01'),
      endDate: null,
      managerAssignmentId: 'manager',
    });
    setup.tx.employmentAssignment.update.mockResolvedValue({
      id: 'assignment',
      managerAssignmentId: null,
    });

    await expect(
      setup.service.setManager(
        'employee',
        'assignment',
        null as unknown as string,
        context,
      ),
    ).resolves.toEqual({ id: 'assignment', managerAssignmentId: null });

    expect(setup.domain.validateManagerRelationship).not.toHaveBeenCalled();
    expect(setup.tx.employmentAssignment.findUnique).not.toHaveBeenCalled();
    expect(setup.tx.employmentAssignment.update).toHaveBeenCalledWith({
      where: { id: 'assignment' },
      data: { managerAssignmentId: null },
    });
  });

  // Batch 5A: terminate and rehire moved to EmployeeLifecycleService (scheduled termination,
  // rehire with a new assignment); covered by test/employee-lifecycle.db-spec.ts.

  it('returns system-only people options with safe fields, flags, search, and cursor pagination', async () => {
    const setup = makeService();
    setup.tx.person.findMany.mockResolvedValueOnce([
      {
        id: 'person-1',
        firstName: 'Ada',
        middleName: null,
        lastName: 'Lovelace',
        preferredName: null,
        personalEmail: 'ada@example.com',
        phone: 'hidden',
        employee: null,
        user: { id: 'user-1' },
      },
      {
        id: 'person-2',
        firstName: 'Grace',
        middleName: 'B',
        lastName: 'Hopper',
        preferredName: 'Grace',
        personalEmail: null,
        employee: { id: 'employee-2' },
        user: null,
      },
    ]);

    const result = await setup.service.peopleOptions(
      { search: 'ada', limit: 1, afterId: 'cursor' },
      'system',
    );

    expect(setup.authorization.assertAccess).toHaveBeenCalledWith(
      'system',
      'employee.manage',
      { type: 'SYSTEM' },
    );
    expect(setup.tx.person.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          archivedAt: null,
          id: { gt: 'cursor' },
          OR: expect.arrayContaining([
            { firstName: { contains: 'ada', mode: 'insensitive' } },
            { personalEmail: { contains: 'ada', mode: 'insensitive' } },
          ]),
        }),
        select: expect.not.objectContaining({ phone: expect.anything() }),
      }),
    );
    expect(result).toEqual({
      items: [
        {
          id: 'person-1',
          firstName: 'Ada',
          middleName: null,
          lastName: 'Lovelace',
          preferredName: null,
          personalEmail: 'ada@example.com',
          hasEmployee: false,
          hasUser: true,
        },
      ],
      nextAfterId: 'person-1',
    });
    expect(JSON.stringify(result)).not.toContain('hidden');
  });

  it('rejects scoped-only people option lookup through the system authorization check', async () => {
    const setup = makeService();
    setup.authorization.assertAccess.mockRejectedValue(new Error('forbidden'));
    await expect(setup.service.peopleOptions({}, 'scoped')).rejects.toThrow(
      'forbidden',
    );
    expect(setup.tx.person.findMany).not.toHaveBeenCalled();
  });

  it('returns only positions covered by effective employee.manage grants with labels and placements', async () => {
    const setup = makeService();
    setup.authorization.effectiveGrants.mockResolvedValue([
      {
        permission: 'employee.manage',
        scope: { type: 'ORGANIZATION', id: 'org-1' },
      },
      {
        permission: 'employee.manage',
        scope: { type: 'ORGANIZATIONAL_UNIT', id: 'unit-parent' },
      },
      {
        permission: 'employee.manage',
        scope: { type: 'DEPARTMENT', id: 'dept-1' },
      },
      { permission: 'employee.manage', scope: { type: 'TEAM', id: 'team-1' } },
    ]);
    const rows = [
      makePosition({
        id: 'position-org',
        organization: { id: 'org-1', name: 'Acme', code: 'ACME' },
      }),
      makePosition({
        id: 'position-unit',
        organizationalUnit: {
          id: 'unit-child',
          name: 'Platform',
          code: 'PLAT',
        },
      }),
      makePosition({
        id: 'position-dept',
        department: { id: 'dept-1', name: 'Engineering', code: 'ENG' },
        workLocation: { id: 'loc-1', name: 'HQ', code: 'HQ' },
      }),
      makePosition({
        id: 'position-team',
        team: { id: 'team-1', name: 'Core', code: 'CORE' },
      }),
      makePosition({
        id: 'position-sibling',
        organization: { id: 'org-2', name: 'Other', code: 'OTHER' },
      }),
    ];
    setup.tx.position.findMany.mockResolvedValueOnce(rows);
    setup.targets.resolvePosition
      .mockResolvedValueOnce({ type: 'ORGANIZATION', organizationId: 'org-1' })
      .mockResolvedValueOnce({
        type: 'ORGANIZATIONAL_UNIT',
        organizationId: 'org-2',
        unitPathIds: ['unit-child', 'unit-parent'],
      })
      .mockResolvedValueOnce({
        type: 'DEPARTMENT',
        organizationId: 'org-2',
        departmentId: 'dept-1',
        unitPathIds: [],
      })
      .mockResolvedValueOnce({
        type: 'TEAM',
        organizationId: 'org-2',
        teamId: 'team-1',
        unitPathIds: [],
      })
      .mockResolvedValueOnce({ type: 'ORGANIZATION', organizationId: 'org-2' });

    const result = await setup.service.positionOptions(
      { organizationId: 'org-1', search: 'engineer' },
      'manager',
    );

    expect(setup.tx.position.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          archivedAt: null,
          organizationId: 'org-1',
          OR: expect.arrayContaining([
            { name: { contains: 'engineer', mode: 'insensitive' } },
            {
              jobTitle: { name: { contains: 'engineer', mode: 'insensitive' } },
            },
          ]),
        }),
        include: expect.objectContaining({
          jobTitle: true,
          organization: true,
          organizationalUnit: true,
          department: true,
          team: true,
          workLocation: true,
        }),
      }),
    );
    expect(result.items.map((item: any) => item.id)).toEqual([
      'position-org',
      'position-unit',
      'position-dept',
      'position-team',
    ]);
    expect(result.items[0]).toMatchObject({
      jobTitle: { id: 'job-1', name: 'Engineer', code: 'ENG' },
      organization: { id: 'org-1', name: 'Acme', code: 'ACME' },
      placement: null,
      workLocation: null,
    });
    expect(result.items[1].placement).toEqual({
      type: 'ORGANIZATIONAL_UNIT',
      id: 'unit-child',
      name: 'Platform',
      code: 'PLAT',
    });
    expect(result.items[2].placement).toEqual({
      type: 'DEPARTMENT',
      id: 'dept-1',
      name: 'Engineering',
      code: 'ENG',
    });
    expect(result.items[2].workLocation).toEqual({
      id: 'loc-1',
      name: 'HQ',
      code: 'HQ',
    });
    expect(result.items[3].placement).toEqual({
      type: 'TEAM',
      id: 'team-1',
      name: 'Core',
      code: 'CORE',
    });
  });

  it('rejects assignment creation before writing when the selected position is unauthorized', async () => {
    const setup = makeService();
    setup.access.assertPosition.mockRejectedValue(new Error('forbidden'));

    await expect(
      setup.service.createAssignment(
        'employee-1',
        {
          positionId: 'position-hidden',
          employmentType: 'FULL_TIME',
          startDate: '2026-10-01',
        },
        context,
      ),
    ).rejects.toThrow('forbidden');

    expect(setup.prisma.employee.findUnique).not.toHaveBeenCalled();
    expect(setup.domain.createAssignment).not.toHaveBeenCalled();
  });

  it('keeps authorization-filtered position pagination tied to the last examined source row', async () => {
    const setup = makeService();
    setup.authorization.effectiveGrants.mockResolvedValue([
      { permission: 'employee.manage', scope: { type: 'TEAM', id: 'team-2' } },
    ]);
    setup.tx.position.findMany.mockResolvedValueOnce([
      makePosition({ id: 'hidden' }),
      makePosition({
        id: 'visible',
        team: { id: 'team-2', name: 'Core', code: 'CORE' },
      }),
      makePosition({
        id: 'unexamined',
        team: { id: 'team-2', name: 'Core', code: 'CORE' },
      }),
    ]);
    setup.targets.resolvePosition
      .mockResolvedValueOnce({
        type: 'TEAM',
        organizationId: 'org-1',
        teamId: 'other-team',
        unitPathIds: [],
      })
      .mockResolvedValueOnce({
        type: 'TEAM',
        organizationId: 'org-1',
        teamId: 'team-2',
        unitPathIds: [],
      });

    const result = await setup.service.positionOptions({ limit: 1 }, 'manager');

    expect(result.items).toHaveLength(1);
    expect(result.items[0].id).toBe('visible');
    expect(result.nextAfterId).toBe('visible');
    expect(setup.targets.resolvePosition).toHaveBeenCalledTimes(2);
  });

  it('returns manager assignment options only after subordinate manage check and candidate read filtering', async () => {
    const setup = makeService();
    setup.tx.employmentAssignment.findUnique.mockResolvedValue({
      id: 'subordinate',
      positionId: 'sub-position',
      position: { organizationId: 'org' },
      startDate: new Date('2026-01-01T00:00:00.000Z'),
      endDate: new Date('2026-12-31T00:00:00.000Z'),
    });
    setup.authorization.effectiveGrants.mockResolvedValue([
      {
        permission: 'employee.read',
        scope: { type: 'ORGANIZATION', id: 'org-readable' },
      },
    ]);
    setup.tx.employmentAssignment.findMany.mockResolvedValueOnce([
      makeAssignmentOption({
        id: 'manager-readable',
        positionId: 'manager-position',
        organization: { id: 'org-readable', name: 'Readable', code: 'READ' },
      }),
      makeAssignmentOption({
        id: 'manager-hidden',
        positionId: 'hidden-position',
        organization: { id: 'hidden-org', name: 'Hidden', code: 'HID' },
      }),
    ]);
    setup.targets.resolvePosition
      .mockResolvedValueOnce({
        type: 'ORGANIZATION',
        organizationId: 'org-readable',
      })
      .mockResolvedValueOnce({
        type: 'ORGANIZATION',
        organizationId: 'hidden-org',
      });

    const result = await setup.service.managerAssignmentOptions(
      { subordinateAssignmentId: 'subordinate', search: 'grace' },
      'manager',
    );

    expect(setup.access.assertPosition).toHaveBeenCalledWith(
      'manager',
      'sub-position',
      'employee.manage',
    );
    expect(setup.tx.employmentAssignment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: { not: 'subordinate' },
          status: { not: 'CANCELLED' },
          startDate: { lte: new Date('2026-12-31T00:00:00.000Z') },
          OR: [
            { endDate: null },
            { endDate: { gte: new Date('2026-01-01T00:00:00.000Z') } },
          ],
          AND: expect.any(Array),
        }),
        include: expect.objectContaining({
          employee: { include: { person: true } },
          position: { include: { jobTitle: true, organization: true } },
        }),
      }),
    );
    expect(result).toEqual({
      items: [
        {
          assignmentId: 'manager-readable',
          employeeId: 'manager-employee',
          employeeNumber: 'EMP-000002',
          displayName: 'Grace Hopper',
          position: {
            id: 'manager-position',
            name: 'Engineering Manager',
            code: 'MGR',
          },
          jobTitle: { id: 'job-1', name: 'Manager', code: 'MGR' },
          organization: { id: 'org-readable', name: 'Readable', code: 'READ' },
          startDate: '2025-01-01',
          endDate: null,
          status: 'ACTIVE',
        },
      ],
      nextAfterId: null,
    });
    expect(JSON.stringify(result)).not.toContain('manager-hidden');
  });

  it('rejects manager options when subordinate is missing or unmanaged', async () => {
    const setup = makeService();
    setup.tx.employmentAssignment.findUnique.mockResolvedValueOnce(null);
    await expect(
      setup.service.managerAssignmentOptions(
        { subordinateAssignmentId: 'missing' },
        'manager',
      ),
    ).rejects.toBeInstanceOf(NotFoundException);

    setup.tx.employmentAssignment.findUnique.mockResolvedValueOnce({
      id: 'subordinate',
      positionId: 'position',
    });
    setup.access.assertPosition.mockRejectedValueOnce(new Error('forbidden'));
    await expect(
      setup.service.managerAssignmentOptions(
        { subordinateAssignmentId: 'subordinate' },
        'manager',
      ),
    ).rejects.toThrow('forbidden');
  });
});

function makePosition(overrides: any = {}) {
  return {
    id: 'position-1',
    name: 'Software Engineer',
    code: 'SE',
    jobTitle: { id: 'job-1', name: 'Engineer', code: 'ENG' },
    organization: { id: 'org-1', name: 'Acme', code: 'ACME' },
    organizationalUnit: null,
    department: null,
    team: null,
    workLocation: null,
    ...overrides,
  };
}

function rowWithAssignment(id: string, position: any = {}) {
  return {
    id,
    employeeNumber: id,
    status: 'ACTIVE',
    person: { firstName: id, lastName: 'Employee' },
    assignments: [
      {
        id: `${id}-assignment`,
        positionId: `${id}-position`,
        employmentType: 'FULL_TIME',
        status: 'ACTIVE',
        startDate: new Date('2026-09-01T00:00:00.000Z'),
        endDate: null,
        isPrimary: true,
        position: makePosition({
          id: `${id}-position`,
          organization: {
            id: position.organizationId ?? 'org-1',
            name: 'Acme',
            code: 'ACME',
          },
          jobTitle: {
            id: position.jobTitleId ?? 'job-1',
            name: 'Engineer',
            code: 'ENG',
          },
        }),
      },
    ],
  };
}

function makeAssignmentOption(overrides: any = {}) {
  return {
    id: 'manager-readable',
    employeeId: 'manager-employee',
    positionId: 'manager-position',
    status: 'ACTIVE',
    startDate: new Date('2025-01-01T00:00:00.000Z'),
    endDate: null,
    employee: {
      employeeNumber: 'EMP-000002',
      person: { firstName: 'Grace', lastName: 'Hopper', preferredName: null },
    },
    position: {
      id: 'manager-position',
      name: 'Engineering Manager',
      code: 'MGR',
      jobTitle: { id: 'job-1', name: 'Manager', code: 'MGR' },
      organization: { id: 'org-readable', name: 'Readable', code: 'READ' },
    },
    ...overrides,
  };
}

describe('EmployeeService compensation boundaries', () => {
  const record = {
    id: 'comp-1',
    effectiveFrom: new Date('2026-09-01T00:00:00.000Z'),
    effectiveTo: null,
  };

  it('refuses to re-date an assignment out from under its compensation, changing nothing', async () => {
    const setup = makeService();
    setup.tx.employmentAssignment.findFirst.mockResolvedValue({
      id: 'assignment',
      employeeId: 'employee',
      positionId: 'position',
      employmentType: 'FULL_TIME',
      startDate: new Date('2026-09-01T00:00:00.000Z'),
      endDate: null,
      isPrimary: false,
      managerAssignmentId: null,
      status: 'ACTIVE',
    });
    setup.tx.employmentAssignment.findMany.mockResolvedValue([]);
    setup.tx.compensationRecord.findMany.mockResolvedValue([record]);
    const error = await setup.service
      .correctAssignment(
        'employee',
        'assignment',
        { employmentType: 'FULL_TIME', startDate: '2026-10-01' },
        context,
      )
      .then(
        () => null,
        (e: any) => e,
      );
    expect(error?.getStatus?.()).toBe(409);
    expect(error.getResponse()).toMatchObject({
      code: 'COMPENSATION_OUTSIDE_ASSIGNMENT',
      compensationRecords: [{ id: 'comp-1' }],
    });
    expect(setup.tx.employmentAssignment.update).not.toHaveBeenCalled();
  });

  it('refuses to end or cancel an assignment that would leave compensation outside it', async () => {
    const setup = makeService();
    setup.tx.employmentAssignment.findFirst.mockResolvedValue({
      id: 'assignment',
      employeeId: 'employee',
      positionId: 'position',
      status: 'ACTIVE',
      startDate: new Date('2026-01-01T00:00:00.000Z'),
      endDate: null,
    });
    setup.tx.compensationRecord.findMany.mockResolvedValue([
      {
        id: 'raise',
        effectiveFrom: new Date('2026-12-01T00:00:00.000Z'),
        effectiveTo: null,
      },
    ]);
    await expect(
      setup.service.endAssignment(
        'employee',
        'assignment',
        { endDate: '2026-11-30' },
        context,
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(setup.tx.employmentAssignment.update).not.toHaveBeenCalled();
    // Open-ended compensation that started before the end simply ends with the assignment.
    setup.tx.compensationRecord.findMany.mockResolvedValue([
      {
        id: 'base',
        effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
        effectiveTo: null,
      },
    ]);
    setup.tx.employmentAssignment.update.mockResolvedValue({
      id: 'assignment',
    });
    await setup.service.endAssignment(
      'employee',
      'assignment',
      { endDate: '2026-11-30' },
      context,
    );
    expect(setup.tx.employmentAssignment.update).toHaveBeenCalledOnce();
  });
});
