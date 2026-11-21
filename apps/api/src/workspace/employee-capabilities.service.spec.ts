import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { EmployeeCapabilitiesService } from './employee-capabilities.service.js';

function makeService() {
  const prisma: any = {
    employee: { findUnique: vi.fn() },
    organizationalUnit: { findMany: vi.fn().mockResolvedValue([]) },
    organizationModuleSetting: { findMany: vi.fn().mockResolvedValue([]) },
    user: { findUnique: vi.fn().mockResolvedValue(null) },
  };
  const authorization: any = {
    effectiveGrants: vi.fn().mockResolvedValue([]),
    resolveTarget: vi.fn(async (target: any) => target),
  };
  const targets: any = {
    scopeForPosition: vi.fn(),
  };
  const documents: any = {
    grants: vi.fn().mockResolvedValue([]),
    clearanceOver: vi.fn().mockReturnValue({ clearance: -1, canManage: false }),
  };
  const service = new EmployeeCapabilitiesService(
    prisma,
    authorization,
    targets,
    documents,
  );
  return { service, prisma, authorization, targets, documents };
}

const employee = (assignments: any[] = []) => ({
  id: 'employee-1',
  status: 'ACTIVE',
  assignments,
});

const activeAssignment = {
  id: 'assignment-1',
  status: 'ACTIVE',
  position: {
    id: 'position-1',
    organizationId: 'org-1',
    organizationalUnitId: null,
    departmentId: null,
    teamId: 'team-1',
  },
};

describe('EmployeeCapabilitiesService', () => {
  it('allows first-assignment bootstrap with SYSTEM employee.manage', async () => {
    const setup = makeService();
    setup.prisma.employee.findUnique.mockResolvedValue(employee());
    setup.authorization.effectiveGrants.mockResolvedValue([
      { permission: 'employee.manage', scope: { type: 'SYSTEM' } },
    ]);

    const result = await setup.service.capabilities('user-1', 'employee-1');

    expect(result.actions.changePosition).toBe(true);
    expect(result.actions.edit).toBe(true);
  });

  it('denies first-assignment bootstrap to narrow scoped employee.manage grants', async () => {
    const setup = makeService();
    setup.prisma.employee.findUnique.mockResolvedValue(employee());
    setup.authorization.effectiveGrants.mockResolvedValue([
      { permission: 'employee.read', scope: { type: 'SYSTEM' } },
      { permission: 'employee.manage', scope: { type: 'TEAM', id: 'team-1' } },
    ]);

    const result = await setup.service.capabilities('user-1', 'employee-1');

    expect(result.actions.changePosition).toBe(false);
    expect(result.actions.edit).toBe(false);
  });

  it('keeps existing assignment-scoped change-position behavior', async () => {
    const setup = makeService();
    setup.prisma.employee.findUnique.mockResolvedValue(
      employee([activeAssignment]),
    );
    setup.authorization.effectiveGrants.mockResolvedValue([
      { permission: 'employee.read', scope: { type: 'TEAM', id: 'team-1' } },
      { permission: 'employee.manage', scope: { type: 'TEAM', id: 'team-1' } },
    ]);
    setup.targets.scopeForPosition.mockResolvedValue({
      type: 'TEAM',
      organizationId: 'org-1',
      teamId: 'team-1',
      unitPathIds: [],
    });

    const result = await setup.service.capabilities('user-1', 'employee-1');

    expect(result.actions.changePosition).toBe(true);
    expect(result.actions.assignManager).toBe(true);
    expect(setup.targets.scopeForPosition).toHaveBeenCalledWith('position-1');
  });

  it('does not reveal zero-assignment employees to scoped-only callers', async () => {
    const setup = makeService();
    setup.prisma.employee.findUnique.mockResolvedValue(employee());
    setup.authorization.effectiveGrants.mockResolvedValue([
      { permission: 'employee.manage', scope: { type: 'TEAM', id: 'team-1' } },
    ]);

    await expect(
      setup.service.capabilities('user-1', 'employee-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  describe("Batch 5E (D1): assignment management on one's own employment", () => {
    const scoped = (setup: ReturnType<typeof makeService>) => {
      setup.prisma.employee.findUnique.mockResolvedValue(
        employee([activeAssignment]),
      );
      setup.targets.scopeForPosition.mockResolvedValue({
        type: 'TEAM',
        organizationId: 'org-1',
        teamId: 'team-1',
        unitPathIds: [],
      });
    };
    /** user-1 is the employee's own login. */
    const self = (setup: ReturnType<typeof makeService>) =>
      setup.prisma.user.findUnique.mockResolvedValue({
        person: { employee: { id: 'employee-1', archivedAt: null } },
      });

    it("is not offered on one's own record with scoped employee.manage (the API refuses it)", async () => {
      const setup = makeService();
      scoped(setup);
      self(setup);
      setup.authorization.effectiveGrants.mockResolvedValue([
        { permission: 'employee.read', scope: { type: 'TEAM', id: 'team-1' } },
        {
          permission: 'employee.manage',
          scope: { type: 'TEAM', id: 'team-1' },
        },
      ]);

      const result = await setup.service.capabilities('user-1', 'employee-1');

      expect(result.actions.changePosition).toBe(false);
      expect(result.actions.manageLifecycle).toBe(false);
    });

    it("is offered on one's own record with the System employee.manage override", async () => {
      const setup = makeService();
      scoped(setup);
      self(setup);
      setup.authorization.effectiveGrants.mockResolvedValue([
        { permission: 'employee.read', scope: { type: 'SYSTEM' } },
        { permission: 'employee.manage', scope: { type: 'SYSTEM' } },
      ]);

      const result = await setup.service.capabilities('user-1', 'employee-1');

      expect(result.actions.changePosition).toBe(true);
    });

    it("is unchanged for another employee's record", async () => {
      const setup = makeService();
      scoped(setup);
      setup.prisma.user.findUnique.mockResolvedValue({
        person: { employee: { id: 'employee-other', archivedAt: null } },
      });
      setup.authorization.effectiveGrants.mockResolvedValue([
        { permission: 'employee.read', scope: { type: 'TEAM', id: 'team-1' } },
        {
          permission: 'employee.manage',
          scope: { type: 'TEAM', id: 'team-1' },
        },
      ]);

      const result = await setup.service.capabilities('user-1', 'employee-1');

      expect(result.actions.changePosition).toBe(true);
    });
  });
});
