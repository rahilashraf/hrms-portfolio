/* oxlint-disable typescript/unbound-method */
import { BadRequestException } from '@nestjs/common';
import { OrganizationIntegrityService } from './organization-integrity.service.js';
import { PrismaService } from '../database/prisma.service.js';

describe('OrganizationIntegrityService', () => {
  const prisma = {
    organizationalUnit: { findUnique: vi.fn() },
    department: { findUnique: vi.fn() },
    team: { findUnique: vi.fn() },
    jobTitle: { findUnique: vi.fn() },
    workLocation: { findUnique: vi.fn() },
  } as unknown as PrismaService;
  const integrity = new OrganizationIntegrityService(prisma);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('unit hierarchy', () => {
    it('rejects self-parenting', async () => {
      await expect(
        integrity.assertActiveParentUnit('org-a', 'unit-a', 'unit-a'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a cross-organization or archived parent', async () => {
      vi.mocked(prisma.organizationalUnit.findUnique)
        .mockResolvedValueOnce({
          id: 'parent',
          organizationId: 'org-b',
          archivedAt: null,
        } as never)
        .mockResolvedValueOnce({
          id: 'parent',
          organizationId: 'org-a',
          archivedAt: new Date(),
        } as never);

      await expect(
        integrity.assertActiveParentUnit('org-a', 'parent', null),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        integrity.assertActiveParentUnit('org-a', 'parent', null),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a deep cycle and permits a valid reparent', async () => {
      vi.mocked(prisma.organizationalUnit.findUnique)
        .mockResolvedValueOnce({ parentUnitId: 'unit-b' } as never)
        .mockResolvedValueOnce({ parentUnitId: 'unit-a' } as never);

      await expect(
        integrity.assertNoCycleForUnit('unit-c', 'unit-a'),
      ).rejects.toBeInstanceOf(BadRequestException);

      vi.mocked(prisma.organizationalUnit.findUnique).mockResolvedValueOnce({
        parentUnitId: null,
      } as never);
      await expect(
        integrity.assertNoCycleForUnit('unit-c', 'unit-a'),
      ).resolves.toBeUndefined();
    });
  });

  describe('team placement', () => {
    it('accepts exactly one active Department or Unit anchor', async () => {
      vi.mocked(prisma.department.findUnique).mockResolvedValue({
        organizationId: 'org-a',
        archivedAt: null,
      } as never);
      vi.mocked(prisma.organizationalUnit.findUnique).mockResolvedValue({
        organizationId: 'org-a',
        archivedAt: null,
      } as never);

      await expect(
        integrity.validateTeamPlacement('org-a', 'department-a', null),
      ).resolves.toBeUndefined();
      await expect(
        integrity.validateTeamPlacement('org-a', null, 'unit-a'),
      ).resolves.toBeUndefined();
    });

    it.each([
      ['neither anchor', null, null],
      ['both anchors', 'department-a', 'unit-a'],
    ])('rejects %s', async (_description, departmentId, unitId) => {
      await expect(
        integrity.validateTeamPlacement('org-a', departmentId, unitId),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects cross-organization and archived anchors', async () => {
      vi.mocked(prisma.department.findUnique)
        .mockResolvedValueOnce({
          organizationId: 'org-b',
          archivedAt: null,
        } as never)
        .mockResolvedValueOnce({
          organizationId: 'org-a',
          archivedAt: new Date(),
        } as never);

      await expect(
        integrity.validateTeamPlacement('org-a', 'department-a', null),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        integrity.validateTeamPlacement('org-a', 'department-a', null),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects cross-organization and archived direct Unit anchors', async () => {
      vi.mocked(prisma.organizationalUnit.findUnique)
        .mockResolvedValueOnce({
          organizationId: 'org-b',
          archivedAt: null,
        } as never)
        .mockResolvedValueOnce({
          organizationId: 'org-a',
          archivedAt: new Date(),
        } as never);

      await expect(
        integrity.validateTeamPlacement('org-a', null, 'unit-a'),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        integrity.validateTeamPlacement('org-a', null, 'unit-a'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('position placement', () => {
    const activeJobTitle = {
      organizationId: 'org-a',
      archivedAt: null,
    };

    beforeEach(() => {
      vi.mocked(prisma.jobTitle.findUnique).mockResolvedValue(
        activeJobTitle as never,
      );
    });

    it.each([
      ['organization-level', {}],
      ['unit-level', { organizationalUnitId: 'unit-a' }],
      ['department-level', { departmentId: 'department-a' }],
      ['team-level', { teamId: 'team-a' }],
    ])('accepts %s placement', async (_description, placement) => {
      vi.mocked(prisma.organizationalUnit.findUnique).mockResolvedValue({
        organizationId: 'org-a',
        archivedAt: null,
      } as never);
      vi.mocked(prisma.department.findUnique).mockResolvedValue({
        organizationId: 'org-a',
        archivedAt: null,
      } as never);
      vi.mocked(prisma.team.findUnique).mockResolvedValue({
        organizationId: 'org-a',
        archivedAt: null,
      } as never);

      await expect(
        integrity.validatePositionPlacement('org-a', {
          jobTitleId: 'job-title-a',
          ...placement,
        }),
      ).resolves.toBeUndefined();
    });

    it('rejects multiple anchors', async () => {
      await expect(
        integrity.validatePositionPlacement('org-a', {
          jobTitleId: 'job-title-a',
          organizationalUnitId: 'unit-a',
          teamId: 'team-a',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects cross-organization and archived references', async () => {
      vi.mocked(prisma.jobTitle.findUnique).mockResolvedValueOnce({
        organizationId: 'org-b',
        archivedAt: null,
      } as never);
      await expect(
        integrity.validatePositionPlacement('org-a', {
          jobTitleId: 'job-title-a',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      vi.mocked(prisma.jobTitle.findUnique).mockResolvedValue(
        activeJobTitle as never,
      );
      vi.mocked(prisma.organizationalUnit.findUnique).mockResolvedValueOnce({
        organizationId: 'org-b',
        archivedAt: null,
      } as never);
      await expect(
        integrity.validatePositionPlacement('org-a', {
          jobTitleId: 'job-title-a',
          organizationalUnitId: 'unit-a',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      vi.mocked(prisma.workLocation.findUnique).mockResolvedValueOnce({
        organizationId: 'org-a',
        archivedAt: new Date(),
      } as never);
      await expect(
        integrity.validatePositionPlacement('org-a', {
          jobTitleId: 'job-title-a',
          workLocationId: 'location-a',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects archived JobTitles, Departments, Teams, and foreign WorkLocations', async () => {
      vi.mocked(prisma.jobTitle.findUnique).mockResolvedValueOnce({
        organizationId: 'org-a',
        archivedAt: new Date(),
      } as never);
      await expect(
        integrity.validatePositionPlacement('org-a', {
          jobTitleId: 'job-title-a',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      vi.mocked(prisma.jobTitle.findUnique).mockResolvedValue(
        activeJobTitle as never,
      );
      vi.mocked(prisma.department.findUnique).mockResolvedValueOnce({
        organizationId: 'org-a',
        archivedAt: new Date(),
      } as never);
      await expect(
        integrity.validatePositionPlacement('org-a', {
          jobTitleId: 'job-title-a',
          departmentId: 'department-a',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      vi.mocked(prisma.jobTitle.findUnique).mockResolvedValue(
        activeJobTitle as never,
      );
      vi.mocked(prisma.team.findUnique).mockResolvedValueOnce({
        organizationId: 'org-a',
        archivedAt: new Date(),
      } as never);
      await expect(
        integrity.validatePositionPlacement('org-a', {
          jobTitleId: 'job-title-a',
          teamId: 'team-a',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      vi.mocked(prisma.jobTitle.findUnique).mockResolvedValue(
        activeJobTitle as never,
      );
      vi.mocked(prisma.workLocation.findUnique).mockResolvedValueOnce({
        organizationId: 'org-b',
        archivedAt: null,
      } as never);
      await expect(
        integrity.validatePositionPlacement('org-a', {
          jobTitleId: 'job-title-a',
          workLocationId: 'location-a',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
