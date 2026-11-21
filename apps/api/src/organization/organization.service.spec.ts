/* oxlint-disable typescript/unbound-method */
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { OrganizationService } from './organization.service.js';
import { OrganizationIntegrityService } from './organization-integrity.service.js';
import { OrganizationArchivePolicyService } from './organization-archive-policy.service.js';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../database/prisma.service.js';
import { AuthorizationService } from '../authorization/authorization.service.js';

describe('OrganizationService', () => {
  const delegates = {
    organization: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    organizationalUnit: {
      findUnique: vi.fn(),
      findFirst: vi.fn().mockResolvedValue({ archivedAt: null }),
      create: vi.fn(),
      update: vi.fn(),
      count: vi.fn(),
    },
    department: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      count: vi.fn(),
    },
    team: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      count: vi.fn(),
    },
    jobTitle: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      count: vi.fn(),
    },
    position: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      count: vi.fn(),
    },
    workLocation: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      count: vi.fn(),
    },
    employmentAssignment: { count: vi.fn().mockResolvedValue(0) },
    // Batch 5B: the structure and position advisory locks.
    $executeRaw: vi.fn().mockResolvedValue(0),
  };
  const prisma = {
    ...delegates,
    $transaction: vi.fn(
      async (callback: (transaction: typeof delegates) => Promise<unknown>) =>
        callback(delegates),
    ),
  } as unknown as PrismaService;
  const audit = { write: vi.fn() } as unknown as AuditService;
  const integrity = {
    assertActiveParentUnit: vi.fn(),
    assertNoCycleForUnit: vi.fn(),
    validateTeamPlacement: vi.fn(),
    validatePositionPlacement: vi.fn(),
    assertPositionIdentityMutable: vi.fn(),
  } as unknown as OrganizationIntegrityService;
  const archivePolicy = {
    hasActiveOrganizationChildren: vi.fn(),
    hasActiveUnitChildren: vi.fn(),
    hasActiveDepartmentChildren: vi.fn(),
    hasActiveTeamPositions: vi.fn(),
    hasActiveJobTitlePositions: vi.fn(),
    hasActiveWorkLocationPositions: vi.fn(),
  } as unknown as OrganizationArchivePolicyService;
  const authorization = {
    assertCan: vi.fn().mockResolvedValue(undefined),
    permissionKeysWithinOrganization: vi.fn(),
  } as unknown as AuthorizationService;
  const service = new OrganizationService(
    prisma,
    audit,
    integrity,
    archivePolicy,
    authorization,
  );

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authorization.assertCan).mockResolvedValue(undefined);
    vi.mocked(audit.write).mockResolvedValue({} as never);
    vi.mocked(integrity.validateTeamPlacement).mockResolvedValue(undefined);
    vi.mocked(integrity.validatePositionPlacement).mockResolvedValue(undefined);
    vi.mocked(integrity.assertPositionIdentityMutable).mockResolvedValue(
      undefined,
    );
    vi.mocked(archivePolicy.hasActiveOrganizationChildren).mockResolvedValue(
      false,
    );
    vi.mocked(archivePolicy.hasActiveUnitChildren).mockResolvedValue(false);
    vi.mocked(archivePolicy.hasActiveDepartmentChildren).mockResolvedValue(
      false,
    );
    vi.mocked(archivePolicy.hasActiveTeamPositions).mockResolvedValue(0);
    vi.mocked(archivePolicy.hasActiveJobTitlePositions).mockResolvedValue(0);
    vi.mocked(archivePolicy.hasActiveWorkLocationPositions).mockResolvedValue(
      0,
    );
  });

  it('denies a direct mutation without an authenticated actor', async () => {
    vi.mocked(delegates.organization.findUnique).mockResolvedValue({
      id: 'org-1',
      archivedAt: null,
    } as never);

    await expect(
      service.updateOrganization('org-1', { name: 'Changed' }),
    ).rejects.toThrow('An authenticated actor is required');

    expect(delegates.organization.update).not.toHaveBeenCalled();
  });

  it('checks scoped destination authorization for direct child creation', async () => {
    vi.mocked(delegates.organization.findUnique).mockResolvedValue({
      id: 'org-1',
      archivedAt: null,
    } as never);
    vi.mocked(delegates.organizationalUnit.findUnique).mockResolvedValue({
      id: 'unit-1',
      organizationId: 'org-1',
      archivedAt: null,
    } as never);
    vi.mocked(delegates.department.create).mockResolvedValue({
      id: 'department-1',
      organizationId: 'org-1',
    } as never);

    await service.createDepartment(
      'org-1',
      {
        name: 'People',
        code: 'PEOPLE',
        organizationalUnitId: 'unit-1',
      },
      { actorUserId: 'actor-1' },
    );

    expect(authorization.assertCan).toHaveBeenCalledWith(
      'actor-1',
      'organization.manage',
      {
        type: 'ORGANIZATIONAL_UNIT',
        id: 'unit-1',
        organizationId: 'org-1',
      },
    );
    expect(delegates.department.create).toHaveBeenCalledOnce();
  });

  it('denies a direct move unless the actor is authorized at both source and destination', async () => {
    vi.mocked(delegates.organization.findUnique).mockResolvedValue({
      id: 'org-1',
      archivedAt: null,
    } as never);
    vi.mocked(delegates.team.findUnique).mockResolvedValue({
      id: 'team-1',
      organizationId: 'org-1',
      departmentId: 'department-1',
      organizationalUnitId: null,
      archivedAt: null,
    } as never);
    vi.mocked(authorization.assertCan).mockImplementation(
      async (_actorId, _permission, scope) => {
        if (scope.type === 'DEPARTMENT') throw new Error('destination denied');
      },
    );

    await expect(
      service.updateTeam(
        'org-1',
        'team-1',
        { departmentId: 'department-2', organizationalUnitId: null },
        { actorUserId: 'actor-1' },
      ),
    ).rejects.toThrow('destination denied');

    expect(authorization.assertCan).toHaveBeenNthCalledWith(
      1,
      'actor-1',
      'organization.manage',
      { type: 'TEAM', id: 'team-1', organizationId: 'org-1' },
    );
    expect(authorization.assertCan).toHaveBeenNthCalledWith(
      2,
      'actor-1',
      'organization.manage',
      { type: 'DEPARTMENT', id: 'department-2', organizationId: 'org-1' },
    );
    expect(delegates.team.update).not.toHaveBeenCalled();
  });

  it('allows a direct move when both source and destination are authorized', async () => {
    vi.mocked(delegates.organization.findUnique).mockResolvedValue({
      id: 'org-1',
      archivedAt: null,
    } as never);
    vi.mocked(delegates.team.findUnique).mockResolvedValue({
      id: 'team-1',
      organizationId: 'org-1',
      departmentId: 'department-1',
      organizationalUnitId: null,
      archivedAt: null,
    } as never);
    vi.mocked(delegates.team.update).mockResolvedValue({
      id: 'team-1',
      departmentId: 'department-2',
      organizationalUnitId: null,
    } as never);

    await service.updateTeam(
      'org-1',
      'team-1',
      { departmentId: 'department-2', organizationalUnitId: null },
      { actorUserId: 'actor-1' },
    );

    expect(delegates.team.update).toHaveBeenCalledOnce();
    expect(authorization.assertCan).toHaveBeenCalledTimes(2);
  });

  it('normalizes organization codes and records creation audit atomically', async () => {
    const organization = {
      id: 'organization-a',
      code: 'WEEKEND-SCHOOL',
      name: 'Weekend School',
      archivedAt: null,
    };
    vi.mocked(prisma.organization.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.organization.create).mockResolvedValue(
      organization as never,
    );

    await expect(
      service.createOrganization(
        {
          name: 'Weekend School',
          code: '  Weekend   School ',
        },
        {
          actorUserId: 'user-a',
          ipAddress: '127.0.0.1',
          userAgent: 'test-agent',
          correlationId: 'request-a',
        },
      ),
    ).resolves.toEqual(organization);

    expect(prisma.organization.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ code: 'WEEKEND-SCHOOL' }),
    });
    expect(audit.write).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'ORG_CREATED',
        actorUserId: 'user-a',
        ipAddress: '127.0.0.1',
        userAgent: 'test-agent',
        correlationId: 'request-a',
        entityType: 'Organization',
        entityId: organization.id,
        metadata: expect.objectContaining({
          before: null,
          after: organization,
        }),
      }),
      delegates,
    );
  });

  it('rejects active child creation under an archived organization', async () => {
    vi.mocked(prisma.organization.findUnique).mockResolvedValue({
      id: 'organization-a',
      archivedAt: new Date(),
    } as never);

    await expect(
      service.createJobTitle('organization-a', {
        code: 'LEAD',
        name: 'Lead',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.jobTitle.create).not.toHaveBeenCalled();
  });

  it('audits successful updates with before, after, and changed fields', async () => {
    const current = {
      id: 'organization-a',
      name: 'Old name',
      code: 'ORG',
      description: null,
      sortOrder: 0,
      archivedAt: null,
    };
    const updated = { ...current, name: 'New name' };
    vi.mocked(prisma.organization.findUnique).mockResolvedValue(
      current as never,
    );
    vi.mocked(prisma.organization.update).mockResolvedValue(updated as never);

    await service.updateOrganization(
      'organization-a',
      { name: 'New name' },
      { actorUserId: 'actor-1' },
    );

    expect(audit.write).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'ORG_UPDATED',
        metadata: expect.objectContaining({
          before: current,
          after: updated,
          changedFields: ['name'],
        }),
      }),
      delegates,
    );
  });

  it('refuses to update an archived organization rather than silently mutating it', async () => {
    vi.mocked(prisma.organization.findUnique).mockResolvedValue({
      id: 'organization-a',
      archivedAt: new Date(),
    } as never);

    await expect(
      service.updateOrganization('organization-a', { name: 'Changed' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.organization.update).not.toHaveBeenCalled();
  });

  it('does not archive an organization with active structural descendants', async () => {
    vi.mocked(prisma.organization.findUnique).mockResolvedValue({
      id: 'organization-a',
      archivedAt: null,
    } as never);
    vi.mocked(prisma.organizationalUnit.count).mockResolvedValue(1);
    vi.mocked(prisma.department.count).mockResolvedValue(0);
    vi.mocked(prisma.team.count).mockResolvedValue(0);
    vi.mocked(prisma.position.count).mockResolvedValue(0);
    vi.mocked(prisma.jobTitle.count).mockResolvedValue(0);
    vi.mocked(prisma.workLocation.count).mockResolvedValue(0);
    vi.mocked(archivePolicy.hasActiveOrganizationChildren).mockResolvedValue(
      true,
    );

    await expect(
      service.archiveOrganization('organization-a', { actorUserId: 'actor-1' }),
    ).rejects.toThrow('active structural records remain');
    expect(prisma.organization.update).not.toHaveBeenCalled();
  });

  it.each([
    [
      'unit child units',
      async () => {
        vi.mocked(prisma.organizationalUnit.findUnique).mockResolvedValue({
          id: 'unit-a',
          organizationId: 'organization-a',
          archivedAt: null,
        } as never);
        vi.mocked(prisma.organizationalUnit.count).mockResolvedValue(1);
        vi.mocked(prisma.department.count).mockResolvedValue(0);
        vi.mocked(prisma.team.count).mockResolvedValue(0);
        vi.mocked(prisma.position.count).mockResolvedValue(0);
        vi.mocked(archivePolicy.hasActiveUnitChildren).mockResolvedValue(true);
        await service.archiveOrganizationalUnit('organization-a', 'unit-a', {
          actorUserId: 'actor-1',
        });
      },
    ],
    [
      'department Teams',
      async () => {
        vi.mocked(prisma.department.findUnique).mockResolvedValue({
          id: 'department-a',
          organizationId: 'organization-a',
          archivedAt: null,
        } as never);
        vi.mocked(prisma.team.count).mockResolvedValue(1);
        vi.mocked(prisma.position.count).mockResolvedValue(0);
        vi.mocked(archivePolicy.hasActiveDepartmentChildren).mockResolvedValue(
          true,
        );
        await service.archiveDepartment('organization-a', 'department-a', {
          actorUserId: 'actor-1',
        });
      },
    ],
    [
      'team Positions',
      async () => {
        vi.mocked(prisma.team.findUnique).mockResolvedValue({
          id: 'team-a',
          organizationId: 'organization-a',
          archivedAt: null,
        } as never);
        vi.mocked(prisma.position.count).mockResolvedValue(1);
        vi.mocked(archivePolicy.hasActiveTeamPositions).mockResolvedValue(1);
        await service.archiveTeam('organization-a', 'team-a', {
          actorUserId: 'actor-1',
        });
      },
    ],
    [
      'job-title Positions',
      async () => {
        vi.mocked(prisma.jobTitle.findUnique).mockResolvedValue({
          id: 'job-title-a',
          organizationId: 'organization-a',
          archivedAt: null,
        } as never);
        vi.mocked(prisma.position.count).mockResolvedValue(1);
        vi.mocked(archivePolicy.hasActiveJobTitlePositions).mockResolvedValue(
          1,
        );
        await service.archiveJobTitle('organization-a', 'job-title-a', {
          actorUserId: 'actor-1',
        });
      },
    ],
    [
      'work-location Positions',
      async () => {
        vi.mocked(prisma.workLocation.findUnique).mockResolvedValue({
          id: 'location-a',
          organizationId: 'organization-a',
          archivedAt: null,
        } as never);
        vi.mocked(prisma.position.count).mockResolvedValue(1);
        vi.mocked(
          archivePolicy.hasActiveWorkLocationPositions,
        ).mockResolvedValue(1);
        await service.archiveWorkLocation('organization-a', 'location-a', {
          actorUserId: 'actor-1',
        });
      },
    ],
  ])('blocks archive while active %s remain', async (_dependency, archive) => {
    await expect(archive()).rejects.toThrow();
  });

  it('requires an active parent when reactivating an OrganizationalUnit', async () => {
    vi.mocked(prisma.organization.findUnique).mockResolvedValue({
      id: 'organization-a',
      archivedAt: null,
    } as never);
    vi.mocked(prisma.organizationalUnit.findUnique)
      .mockResolvedValueOnce({
        id: 'unit-a',
        organizationId: 'organization-a',
        parentUnitId: 'parent-a',
        archivedAt: new Date(),
      } as never)
      .mockResolvedValueOnce({
        id: 'parent-a',
        organizationId: 'organization-a',
        archivedAt: new Date(),
      } as never);

    await expect(
      service.reactivateOrganizationalUnit('organization-a', 'unit-a', {
        actorUserId: 'actor-1',
      }),
    ).rejects.toThrow('parent is archived or invalid');
    expect(prisma.organizationalUnit.update).not.toHaveBeenCalled();
  });

  it('audits successful archive and reactivation mutations with before/after state', async () => {
    const active = {
      id: 'organization-a',
      name: 'Example',
      code: 'EXAMPLE',
      archivedAt: null,
    };
    const archived = {
      ...active,
      archivedAt: new Date('2026-01-01T00:00:00Z'),
    };
    const reactivated = { ...active };
    vi.mocked(prisma.organization.findUnique)
      .mockResolvedValueOnce(active as never)
      .mockResolvedValueOnce(archived as never);
    vi.mocked(prisma.organizationalUnit.count).mockResolvedValue(0);
    vi.mocked(prisma.department.count).mockResolvedValue(0);
    vi.mocked(prisma.team.count).mockResolvedValue(0);
    vi.mocked(prisma.position.count).mockResolvedValue(0);
    vi.mocked(prisma.jobTitle.count).mockResolvedValue(0);
    vi.mocked(prisma.workLocation.count).mockResolvedValue(0);
    vi.mocked(prisma.organization.update)
      .mockResolvedValueOnce(archived as never)
      .mockResolvedValueOnce(reactivated as never);

    await service.archiveOrganization('organization-a', {
      actorUserId: 'user-a',
    });
    await service.reactivateOrganization('organization-a', {
      actorUserId: 'user-a',
    });

    expect(audit.write).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        action: 'ORG_ARCHIVED',
        actorUserId: 'user-a',
        metadata: expect.objectContaining({
          before: active,
          after: {
            ...archived,
            archivedAt: archived.archivedAt?.toISOString(),
          },
        }),
      }),
      delegates,
    );
    expect(audit.write).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        action: 'ORG_REACTIVATED',
        actorUserId: 'user-a',
        metadata: expect.objectContaining({
          before: {
            ...archived,
            archivedAt: archived.archivedAt?.toISOString(),
          },
          after: reactivated,
        }),
      }),
      delegates,
    );
  });

  it('preserves explicit null placement changes and audits moves', async () => {
    const current = {
      id: 'team-a',
      organizationId: 'organization-a',
      departmentId: 'department-a',
      organizationalUnitId: null,
      archivedAt: null,
    };
    const moved = {
      ...current,
      departmentId: null,
      organizationalUnitId: 'unit-a',
    };
    vi.mocked(prisma.organization.findUnique).mockResolvedValue({
      id: 'organization-a',
      archivedAt: null,
    } as never);
    vi.mocked(prisma.team.findUnique).mockResolvedValue(current as never);
    vi.mocked(prisma.team.update).mockResolvedValue(moved as never);

    await service.updateTeam(
      'organization-a',
      'team-a',
      {
        departmentId: null,
        organizationalUnitId: 'unit-a',
      },
      { actorUserId: 'actor-1' },
    );

    expect(integrity.validateTeamPlacement).toHaveBeenCalledWith(
      'organization-a',
      null,
      'unit-a',
    );
    expect(audit.write).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'TEAM_MOVED',
        metadata: expect.objectContaining({
          before: current,
          after: moved,
          changedFields: ['departmentId', 'organizationalUnitId'],
        }),
      }),
      delegates,
    );
  });

  it('replaces a Team placement when its anchor type changes', async () => {
    const current = {
      id: 'team-a',
      organizationId: 'organization-a',
      departmentId: 'department-a',
      organizationalUnitId: null,
      archivedAt: null,
    };
    const moved = {
      ...current,
      departmentId: null,
      organizationalUnitId: 'unit-a',
    };
    vi.mocked(prisma.organization.findUnique).mockResolvedValue({
      id: 'organization-a',
      archivedAt: null,
    } as never);
    vi.mocked(prisma.team.findUnique).mockResolvedValue(current as never);
    vi.mocked(prisma.team.update).mockResolvedValue(moved as never);

    await service.updateTeam(
      'organization-a',
      'team-a',
      { organizationalUnitId: 'unit-a' },
      { actorUserId: 'actor-1' },
    );

    expect(prisma.team.update).toHaveBeenCalledWith({
      where: { id: 'team-a' },
      data: { departmentId: null, organizationalUnitId: 'unit-a' },
    });
    expect(integrity.validateTeamPlacement).toHaveBeenCalledWith(
      'organization-a',
      null,
      'unit-a',
    );
  });

  it('does not audit an unchanged Team anchor as a placement move', async () => {
    const current = {
      id: 'team-a',
      organizationId: 'organization-a',
      departmentId: 'department-a',
      organizationalUnitId: null,
      archivedAt: null,
    };
    const updated = { ...current, name: 'Teaching Team' };
    vi.mocked(prisma.organization.findUnique).mockResolvedValue({
      id: 'organization-a',
      archivedAt: null,
    } as never);
    vi.mocked(prisma.team.findUnique).mockResolvedValue(current as never);
    vi.mocked(prisma.team.update).mockResolvedValue(updated as never);

    await service.updateTeam(
      'organization-a',
      'team-a',
      {
        name: 'Teaching Team',
        departmentId: 'department-a',
      },
      { actorUserId: 'actor-1' },
    );

    expect(prisma.team.update).toHaveBeenCalledWith({
      where: { id: 'team-a' },
      data: { name: 'Teaching Team' },
    });
    expect(audit.write).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'TEAM_UPDATED',
        metadata: expect.objectContaining({ changedFields: ['name'] }),
      }),
      delegates,
    );
  });

  it('moves an OrganizationalUnit through validated hierarchy checks and audits it', async () => {
    const current = {
      id: 'unit-a',
      organizationId: 'organization-a',
      parentUnitId: null,
      archivedAt: null,
    };
    const moved = { ...current, parentUnitId: 'parent-a' };
    vi.mocked(prisma.organization.findUnique).mockResolvedValue({
      id: 'organization-a',
      archivedAt: null,
    } as never);
    vi.mocked(prisma.organizationalUnit.findUnique).mockResolvedValue(
      current as never,
    );
    vi.mocked(prisma.organizationalUnit.update).mockResolvedValue(
      moved as never,
    );

    await service.updateOrganizationalUnit(
      'organization-a',
      'unit-a',
      { parentUnitId: 'parent-a' },
      { actorUserId: 'actor-1' },
    );

    expect(integrity.assertActiveParentUnit).toHaveBeenCalledWith(
      'organization-a',
      'parent-a',
      'unit-a',
    );
    expect(integrity.assertNoCycleForUnit).toHaveBeenCalledWith(
      'parent-a',
      'unit-a',
    );
    expect(audit.write).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'ORG_UNIT_MOVED',
        metadata: expect.objectContaining({
          before: current,
          after: moved,
          changedFields: ['parentUnitId'],
        }),
      }),
      delegates,
    );
  });

  it('allows moving a Position from a Team to organization scope', async () => {
    const current = {
      id: 'position-a',
      organizationId: 'organization-a',
      jobTitleId: 'job-title-a',
      organizationalUnitId: null,
      departmentId: null,
      teamId: 'team-a',
      workLocationId: null,
      archivedAt: null,
    };
    vi.mocked(prisma.organization.findUnique).mockResolvedValue({
      id: 'organization-a',
      archivedAt: null,
    } as never);
    vi.mocked(prisma.position.findUnique).mockResolvedValue(current as never);
    vi.mocked(prisma.position.update).mockResolvedValue({
      ...current,
      teamId: null,
    } as never);

    await service.updatePosition(
      'organization-a',
      'position-a',
      { teamId: null },
      { actorUserId: 'actor-1' },
    );

    expect(integrity.validatePositionPlacement).toHaveBeenCalledWith(
      'organization-a',
      expect.objectContaining({
        jobTitleId: 'job-title-a',
        teamId: null,
        organizationalUnitId: null,
        departmentId: null,
      }),
    );
    expect(integrity.assertPositionIdentityMutable).toHaveBeenCalledWith(
      'position-a',
    );
    expect(audit.write).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'POSITION_MOVED' }),
      delegates,
    );
  });

  it('blocks Position identity changes after assignment history exists', async () => {
    const current = {
      id: 'position-a',
      organizationId: 'organization-a',
      jobTitleId: 'job-title-a',
      organizationalUnitId: null,
      departmentId: null,
      teamId: null,
      workLocationId: null,
      archivedAt: null,
    };
    vi.mocked(prisma.organization.findUnique).mockResolvedValue({
      id: 'organization-a',
      archivedAt: null,
    } as never);
    vi.mocked(prisma.position.findUnique).mockResolvedValue(current as never);
    vi.mocked(integrity.assertPositionIdentityMutable).mockRejectedValueOnce(
      new BadRequestException('Position has employment history'),
    );

    await expect(
      service.updatePosition(
        'organization-a',
        'position-a',
        { jobTitleId: 'new-job-title' },
        { actorUserId: 'actor-1' },
      ),
    ).rejects.toThrow('Position has employment history');
    expect(prisma.position.update).not.toHaveBeenCalled();
  });

  describe('position reference options', () => {
    const options = (actor?: string) =>
      service.listPositionReferenceOptions('organization-a', actor);

    beforeEach(() => {
      vi.mocked(prisma.organization.findUnique).mockResolvedValue({
        id: 'organization-a',
        archivedAt: null,
      } as never);
      vi.mocked(delegates.jobTitle.findMany).mockResolvedValue([
        { id: 'jt-1', name: 'Analyst', code: 'AN' },
      ] as never);
      vi.mocked(delegates.workLocation.findMany).mockResolvedValue([
        { id: 'wl-1', name: 'Toronto', code: 'TOR' },
      ] as never);
    });

    it('returns only active id/name/code rows, sorted by name then code', async () => {
      vi.mocked(
        authorization.permissionKeysWithinOrganization,
      ).mockResolvedValue(new Set(['organization.manage']));

      await expect(options('actor-1')).resolves.toEqual({
        jobTitles: [{ id: 'jt-1', name: 'Analyst', code: 'AN' }],
        workLocations: [{ id: 'wl-1', name: 'Toronto', code: 'TOR' }],
      });
      const query = {
        where: { organizationId: 'organization-a', archivedAt: null },
        select: { id: true, name: true, code: true },
        orderBy: [{ name: 'asc' }, { code: 'asc' }],
      };
      expect(delegates.jobTitle.findMany).toHaveBeenCalledWith(query);
      expect(delegates.workLocation.findMany).toHaveBeenCalledWith(query);
      expect(
        authorization.permissionKeysWithinOrganization,
      ).toHaveBeenCalledWith('actor-1', 'organization-a');
    });

    it('answers 403 to a reader who may see but not manage the organization', async () => {
      vi.mocked(
        authorization.permissionKeysWithinOrganization,
      ).mockResolvedValue(new Set(['organization.read']));

      await expect(options('actor-1')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(delegates.jobTitle.findMany).not.toHaveBeenCalled();
    });

    it('answers 404 when the caller has nothing within the organization', async () => {
      vi.mocked(
        authorization.permissionKeysWithinOrganization,
      ).mockResolvedValue(new Set(['employee.read']));

      await expect(options('actor-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(delegates.jobTitle.findMany).not.toHaveBeenCalled();
    });

    it('answers 404 for an unknown or archived organization before checking grants', async () => {
      vi.mocked(prisma.organization.findUnique).mockResolvedValueOnce(null);
      await expect(options('actor-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      vi.mocked(prisma.organization.findUnique).mockResolvedValueOnce({
        id: 'organization-a',
        archivedAt: new Date(),
      } as never);
      await expect(options('actor-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(
        authorization.permissionKeysWithinOrganization,
      ).not.toHaveBeenCalled();
    });

    it('refuses a call without an authenticated actor', async () => {
      await expect(options(undefined)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });
  });

  it('renames a staffed Position without touching its identity', async () => {
    const current = {
      id: 'position-a',
      organizationId: 'organization-a',
      jobTitleId: 'job-title-a',
      organizationalUnitId: null,
      departmentId: null,
      teamId: null,
      workLocationId: 'work-location-a',
      archivedAt: null,
    };
    vi.mocked(prisma.organization.findUnique).mockResolvedValue({
      id: 'organization-a',
      archivedAt: null,
    } as never);
    vi.mocked(prisma.position.findUnique).mockResolvedValue(current as never);
    vi.mocked(prisma.position.update).mockResolvedValue({
      ...current,
      name: 'Renamed',
    } as never);
    vi.mocked(integrity.assertPositionIdentityMutable).mockRejectedValue(
      new BadRequestException('Position has employment history'),
    );

    await service.updatePosition(
      'organization-a',
      'position-a',
      { name: 'Renamed', description: 'Updated' },
      { actorUserId: 'actor-1' },
    );

    expect(integrity.assertPositionIdentityMutable).not.toHaveBeenCalled();
    expect(prisma.position.update).toHaveBeenCalledWith({
      where: { id: 'position-a' },
      data: { name: 'Renamed', description: 'Updated' },
    });
  });
});
