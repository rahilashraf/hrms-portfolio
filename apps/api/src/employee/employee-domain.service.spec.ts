import { describe, expect, it, vi } from 'vitest';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../database/prisma.service.js';
import { EmployeeDomainService } from './employee-domain.service.js';

function makeService() {
  const tx = {
    person: { findUnique: vi.fn() },
    employee: { findUnique: vi.fn(), create: vi.fn() },
    position: { findUnique: vi.fn() },
    employmentAssignment: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
    },
    employeeTermination: { findFirst: vi.fn().mockResolvedValue(null) },
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn().mockResolvedValue(0),
  };
  const prisma = {
    $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) =>
      callback(tx),
    ),
  } as unknown as PrismaService;
  const audit = {
    write: vi.fn().mockResolvedValue({}),
  } as unknown as AuditService;
  return { service: new EmployeeDomainService(prisma, audit), tx, audit };
}

function availablePosition(overrides: any = {}) {
  return {
    id: 'position-1',
    archivedAt: null,
    workLocation: null,
    organization: { timezone: 'America/Toronto' },
    ...overrides,
  };
}

describe('EmployeeDomainService', () => {
  it('Batch 5B (K7): a manager link must stay inside the subordinate position organization', async () => {
    const { service, tx } = makeService();
    tx.position.findUnique
      .mockResolvedValueOnce({ organizationId: 'org-a' })
      .mockResolvedValueOnce({ organizationId: 'org-b' });
    const error = await service
      .assertManagerSameOrganization(tx as never, 'subordinate', 'manager')
      .catch((e: any) => e);
    expect(error.getStatus()).toBe(409);
    expect(error.getResponse()).toMatchObject({
      code: 'MANAGER_ORGANIZATION_MISMATCH',
    });
    tx.position.findUnique
      .mockResolvedValueOnce({ organizationId: 'org-a' })
      .mockResolvedValueOnce({ organizationId: 'org-a' });
    await expect(
      service.assertManagerSameOrganization(
        tx as never,
        'subordinate',
        'manager',
      ),
    ).resolves.toBeUndefined();
  });

  it('Batch 5A: creates assignments only for ACTIVE employees without a scheduled termination', async () => {
    for (const status of ['INACTIVE', 'TERMINATED']) {
      const { service, tx } = makeService();
      tx.employee.findUnique.mockResolvedValue({ id: 'employee-1', status });
      const error = await service
        .createAssignment({
          employeeId: 'employee-1',
          positionId: 'position-1',
          employmentType: 'FULL_TIME',
          startDate: new Date('2026-12-01T00:00:00.000Z'),
        })
        .catch((e: any) => e);
      expect(error.getResponse()).toMatchObject({
        code: 'EMPLOYEE_NOT_ACTIVE',
      });
      expect(tx.$executeRaw).toHaveBeenCalled(); // the lifecycle lock comes first
      expect(tx.employmentAssignment.create).not.toHaveBeenCalled();
    }
    const { service, tx } = makeService();
    tx.employee.findUnique.mockResolvedValue({
      id: 'employee-1',
      status: 'ACTIVE',
    });
    tx.employeeTermination.findFirst.mockResolvedValue({
      id: 'termination-1',
      terminationDate: new Date('2026-11-20T00:00:00.000Z'),
    });
    const error = await service
      .createAssignment({
        employeeId: 'employee-1',
        positionId: 'position-1',
        employmentType: 'FULL_TIME',
        startDate: new Date('2026-12-01T00:00:00.000Z'),
      })
      .catch((e: any) => e);
    expect(error.getResponse()).toMatchObject({
      code: 'TERMINATION_SCHEDULED',
      terminationId: 'termination-1',
    });
    expect(tx.employmentAssignment.create).not.toHaveBeenCalled();
  });

  it('determines inclusive effective dates independently of lifecycle scheduling', () => {
    const startDate = new Date('2026-09-01T00:00:00.000Z');
    const endDate = new Date('2027-06-30T00:00:00.000Z');
    expect(
      EmployeeDomainService.isEffectiveOn(
        {
          status: 'ENDED',
          startDate,
          endDate,
        },
        startDate,
      ),
    ).toBe(true);
    expect(
      EmployeeDomainService.isEffectiveOn(
        { status: 'ENDED', startDate, endDate },
        endDate,
      ),
    ).toBe(true);
    expect(
      EmployeeDomainService.isEffectiveOn(
        { status: 'ENDED', startDate, endDate },
        new Date('2027-03-01T00:00:00.000Z'),
      ),
    ).toBe(true);
    expect(
      EmployeeDomainService.isEffectiveOn(
        { status: 'ENDED', startDate, endDate },
        new Date('2027-07-01T00:00:00.000Z'),
      ),
    ).toBe(false);
    expect(
      EmployeeDomainService.isEffectiveOn(
        {
          status: 'CANCELLED',
          startDate,
          endDate: null,
        },
        startDate,
      ),
    ).toBe(false);
  });

  it('allocates employee numbers from the database sequence', async () => {
    const { service, tx } = makeService();
    tx.person.findUnique.mockResolvedValue({ id: 'person-1' });
    tx.employee.findUnique.mockResolvedValue(null);
    tx.$queryRaw.mockResolvedValue([{ value: 42n }]);
    tx.employee.create.mockResolvedValue({
      id: 'employee-1',
      employeeNumber: 'EMP-000042',
    });

    await service.createEmployee({
      personId: 'person-1',
      hireDate: new Date('2026-10-01'),
    });

    expect(tx.$queryRaw).toHaveBeenCalledOnce();
    expect(tx.employee.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ employeeNumber: 'EMP-000042' }),
      }),
    );
  });

  it('rejects invalid employee date ranges and terminated employees without dates', async () => {
    const { service } = makeService();
    await expect(
      service.createEmployee({
        personId: 'person-1',
        hireDate: new Date('2026-10-02'),
        terminationDate: new Date('2026-10-01'),
      }),
    ).rejects.toThrow('End date must be on or after start date.');
    await expect(
      service.createEmployee({
        personId: 'person-1',
        hireDate: new Date('2026-10-01'),
        status: 'TERMINATED',
      }),
    ).rejects.toThrow('terminated employee must have a termination date');
  });

  it('allows concurrent assignments for one employee in different positions', async () => {
    const { service, tx } = makeService();
    tx.employee.findUnique.mockResolvedValue({
      id: 'employee-1',
      status: 'ACTIVE',
    });
    tx.position.findUnique.mockResolvedValue(availablePosition());
    tx.employmentAssignment.findMany.mockResolvedValue([]);
    tx.employmentAssignment.create.mockResolvedValue({ id: 'assignment-1' });

    await expect(
      service.createAssignment({
        employeeId: 'employee-1',
        positionId: 'position-1',
        employmentType: 'FULL_TIME',
        startDate: new Date('2026-10-01'),
        endDate: null,
      }),
    ).resolves.toEqual({ id: 'assignment-1' });
  });

  it('defaults future assignment start dates to planned', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 7, 12));
    try {
      const { service, tx } = makeService();
      tx.employee.findUnique.mockResolvedValue({
        id: 'employee-1',
        status: 'ACTIVE',
      });
      tx.position.findUnique.mockResolvedValue(availablePosition());
      tx.employmentAssignment.findMany.mockResolvedValue([]);
      tx.employmentAssignment.create.mockResolvedValue({ id: 'assignment-1' });

      await service.createAssignment({
        employeeId: 'employee-1',
        positionId: 'position-1',
        employmentType: 'FULL_TIME',
        startDate: new Date('2026-10-08T00:00:00.000Z'),
      });

      expect(tx.employmentAssignment.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'PLANNED' }),
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('defaults by the assignment business timezone at a UTC/local date boundary', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-08T02:30:00.000Z'));
    try {
      const { service, tx } = makeService();
      tx.employee.findUnique.mockResolvedValue({
        id: 'employee-1',
        status: 'ACTIVE',
      });
      tx.position.findUnique.mockResolvedValue(
        availablePosition({
          workLocation: { timezone: 'America/Toronto' },
          organization: { timezone: 'UTC' },
        }),
      );
      tx.employmentAssignment.findMany.mockResolvedValue([]);
      tx.employmentAssignment.create.mockResolvedValue({ id: 'assignment-1' });

      await service.createAssignment({
        employeeId: 'employee-1',
        positionId: 'position-1',
        employmentType: 'FULL_TIME',
        startDate: new Date('2026-10-08T00:00:00.000Z'),
      });

      expect(tx.employmentAssignment.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'PLANNED' }),
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('defaults today and past assignment start dates to active using date-only semantics', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 7, 23, 30));
    try {
      const { service, tx } = makeService();
      tx.employee.findUnique.mockResolvedValue({
        id: 'employee-1',
        status: 'ACTIVE',
      });
      tx.position.findUnique.mockResolvedValue(availablePosition());
      tx.employmentAssignment.findMany.mockResolvedValue([]);
      tx.employmentAssignment.create
        .mockResolvedValueOnce({ id: 'today' })
        .mockResolvedValueOnce({ id: 'past' });

      await service.createAssignment({
        employeeId: 'employee-1',
        positionId: 'position-1',
        employmentType: 'FULL_TIME',
        startDate: new Date('2026-10-07T00:00:00.000Z'),
      });
      await service.createAssignment({
        employeeId: 'employee-1',
        positionId: 'position-2',
        employmentType: 'FULL_TIME',
        startDate: new Date('2026-10-06T00:00:00.000Z'),
      });

      expect(tx.employmentAssignment.create).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          data: expect.objectContaining({ status: 'ACTIVE' }),
        }),
      );
      expect(tx.employmentAssignment.create).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          data: expect.objectContaining({ status: 'ACTIVE' }),
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves explicit assignment status values', async () => {
    const { service, tx } = makeService();
    tx.employee.findUnique.mockResolvedValue({
      id: 'employee-1',
      status: 'ACTIVE',
    });
    tx.position.findUnique.mockResolvedValue(availablePosition());
    tx.employmentAssignment.findMany.mockResolvedValue([]);
    tx.employmentAssignment.create.mockResolvedValue({ id: 'assignment-1' });

    await service.createAssignment({
      employeeId: 'employee-1',
      positionId: 'position-1',
      employmentType: 'FULL_TIME',
      status: 'CANCELLED',
      startDate: new Date('2026-10-01T00:00:00.000Z'),
    });

    expect(tx.employmentAssignment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'CANCELLED' }),
      }),
    );
    expect(tx.employmentAssignment.findMany).not.toHaveBeenCalled();
  });

  it('rejects overlapping ended position occupancy', async () => {
    const { service, tx } = makeService();
    tx.employee.findUnique.mockResolvedValue({
      id: 'employee-1',
      status: 'ACTIVE',
    });
    tx.position.findUnique.mockResolvedValue(availablePosition());
    tx.employmentAssignment.findMany.mockResolvedValue([
      {
        startDate: new Date('2026-09-01'),
        endDate: new Date('2027-06-30'),
      },
    ]);

    await expect(
      service.createAssignment({
        employeeId: 'employee-1',
        positionId: 'position-1',
        employmentType: 'FULL_TIME',
        startDate: new Date('2027-01-01'),
        endDate: new Date('2027-05-01'),
      }),
    ).rejects.toThrow('Position is occupied');
  });

  it('permits sequential position occupancy and ignores cancelled history', async () => {
    const { service, tx } = makeService();
    tx.employee.findUnique.mockResolvedValue({
      id: 'employee-1',
      status: 'ACTIVE',
    });
    tx.position.findUnique.mockResolvedValue(availablePosition());
    tx.employmentAssignment.findMany.mockResolvedValue([
      {
        startDate: new Date('2026-09-01'),
        endDate: new Date('2027-06-30'),
      },
    ]);
    tx.employmentAssignment.create.mockResolvedValue({ id: 'assignment-2' });

    await expect(
      service.createAssignment({
        employeeId: 'employee-1',
        positionId: 'position-1',
        employmentType: 'CONTRACT',
        status: 'ACTIVE',
        startDate: new Date('2027-07-01'),
        endDate: null,
      }),
    ).resolves.toEqual({ id: 'assignment-2' });

    tx.employmentAssignment.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          startDate: new Date('2026-09-01'),
          endDate: new Date('2027-06-30'),
        },
      ]);
    await expect(
      service.createAssignment({
        employeeId: 'employee-1',
        positionId: 'position-1',
        employmentType: 'CONTRACT',
        status: 'CANCELLED',
        startDate: new Date('2027-01-01'),
        endDate: new Date('2027-05-01'),
      }),
    ).resolves.toEqual({ id: 'assignment-2' });
  });

  it('validates ended primary intervals while ignoring cancelled primaries', async () => {
    const { service, tx } = makeService();
    tx.employee.findUnique.mockResolvedValue({
      id: 'employee-1',
      status: 'ACTIVE',
    });
    tx.position.findUnique.mockResolvedValue(availablePosition());
    tx.employmentAssignment.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          startDate: new Date('2026-09-01'),
          endDate: new Date('2027-06-30'),
        },
      ]);

    await expect(
      service.createAssignment({
        employeeId: 'employee-1',
        positionId: 'position-1',
        employmentType: 'FULL_TIME',
        startDate: new Date('2027-01-01'),
        endDate: new Date('2027-12-31'),
        isPrimary: true,
      }),
    ).rejects.toThrow('Primary assignments may not overlap.');

    tx.employmentAssignment.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    tx.employmentAssignment.create.mockResolvedValue({ id: 'primary-2' });
    await expect(
      service.createAssignment({
        employeeId: 'employee-1',
        positionId: 'position-1',
        employmentType: 'FULL_TIME',
        startDate: new Date('2027-07-01'),
        isPrimary: true,
      }),
    ).resolves.toEqual({ id: 'primary-2' });

    tx.employmentAssignment.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    await expect(
      service.createAssignment({
        employeeId: 'employee-1',
        positionId: 'position-1',
        employmentType: 'FULL_TIME',
        status: 'CANCELLED',
        startDate: new Date('2027-01-01'),
        endDate: new Date('2027-12-31'),
        isPrimary: true,
      }),
    ).resolves.toEqual({ id: 'primary-2' });
  });

  it('rejects invalid manager relationships', async () => {
    const { service, tx } = makeService();
    tx.employee.findUnique.mockResolvedValue({
      id: 'employee-1',
      status: 'ACTIVE',
    });
    tx.position.findUnique.mockResolvedValue(availablePosition());
    tx.employmentAssignment.findUnique.mockResolvedValue({
      id: 'manager-1',
      status: 'CANCELLED',
      startDate: new Date('2026-10-01'),
      endDate: null,
      managerAssignmentId: null,
    });

    await expect(
      service.createAssignment({
        employeeId: 'employee-1',
        positionId: 'position-1',
        employmentType: 'FULL_TIME',
        startDate: new Date('2026-10-01'),
        managerAssignmentId: 'manager-1',
      }),
    ).rejects.toThrow('Manager assignment must be active');
  });

  it('allows assignment creation with a valid different-employee manager', async () => {
    const { service, tx } = makeService();
    tx.employee.findUnique.mockResolvedValue({
      id: 'employee-1',
      status: 'ACTIVE',
    });
    tx.position.findUnique.mockResolvedValue(availablePosition());
    tx.employmentAssignment.findUnique.mockResolvedValue({
      id: 'manager-1',
      employeeId: 'employee-2',
      status: 'ENDED',
      startDate: new Date('2026-01-01'),
      endDate: new Date('2026-12-31'),
      managerAssignmentId: null,
    });
    tx.employmentAssignment.findMany.mockResolvedValue([]);
    tx.employmentAssignment.create.mockResolvedValue({ id: 'assignment-1' });

    await expect(
      service.createAssignment({
        employeeId: 'employee-1',
        positionId: 'position-1',
        employmentType: 'FULL_TIME',
        startDate: new Date('2026-10-01'),
        managerAssignmentId: 'manager-1',
      }),
    ).resolves.toEqual({ id: 'assignment-1' });
  });

  it('rejects same-employee manager relationships', async () => {
    const { service, tx } = makeService();
    const startDate = new Date('2026-10-01');
    const subordinate = {
      id: 'assignment-a',
      employeeId: 'employee-1',
      status: 'ACTIVE',
      startDate,
      endDate: null,
      managerAssignmentId: null,
    };

    await expect(
      service.validateManagerRelationship(tx as any, subordinate, {
        id: 'assignment-a',
        employeeId: 'employee-1',
        status: 'ACTIVE',
        startDate,
        endDate: null,
        managerAssignmentId: null,
      }),
    ).rejects.toThrow('An employee cannot be their own manager.');
    await expect(
      service.validateManagerRelationship(tx as any, subordinate, {
        id: 'assignment-b',
        employeeId: 'employee-1',
        status: 'ACTIVE',
        startDate,
        endDate: null,
        managerAssignmentId: null,
      }),
    ).rejects.toThrow('An employee cannot be their own manager.');
  });

  it('detects direct, longer, and corrupted manager cycles', async () => {
    const { service, tx } = makeService();
    const startDate = new Date('2026-10-01');
    const assignment = (id: string, managerAssignmentId: string | null) => ({
      id,
      employeeId: `employee-${id}`,
      status: 'ACTIVE',
      startDate,
      endDate: null,
      managerAssignmentId,
    });

    await expect(
      service.validateManagerRelationship(
        tx as any,
        assignment('b', null),
        assignment('a', 'b'),
      ),
    ).rejects.toThrow('Manager relationship would create a cycle.');

    tx.employmentAssignment.findUnique.mockResolvedValueOnce({
      managerAssignmentId: 'c',
    });
    await expect(
      service.validateManagerRelationship(
        tx as any,
        assignment('c', null),
        assignment('a', 'b'),
      ),
    ).rejects.toThrow('Manager relationship would create a cycle.');

    tx.employmentAssignment.findUnique
      .mockResolvedValueOnce({ managerAssignmentId: 'c' })
      .mockResolvedValueOnce({ managerAssignmentId: 'b' });
    await expect(
      service.validateManagerRelationship(
        tx as any,
        assignment('d', null),
        assignment('a', 'b'),
      ),
    ).rejects.toThrow('Manager relationship would create a cycle.');
  });

  it('allows a different employee manager chain that does not cycle', async () => {
    const { service, tx } = makeService();
    const startDate = new Date('2026-10-01');
    tx.employmentAssignment.findUnique.mockResolvedValueOnce({
      managerAssignmentId: null,
    });

    await expect(
      service.validateManagerRelationship(
        tx as any,
        {
          id: 'assignment-a',
          employeeId: 'employee-a',
          status: 'ACTIVE',
          startDate,
          endDate: null,
          managerAssignmentId: 'manager-b',
        },
        {
          id: 'manager-b',
          employeeId: 'employee-b',
          status: 'ACTIVE',
          startDate,
          endDate: null,
          managerAssignmentId: 'manager-c',
        },
      ),
    ).resolves.toBeUndefined();
  });
});
