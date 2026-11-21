import { describe, expect, it, vi } from 'vitest';
import { PositionAuthorizationTargetResolver } from './position-authorization-target.resolver.js';

describe('PositionAuthorizationTargetResolver', () => {
  it('resolves the most specific position anchor', async () => {
    const prisma: any = {
      position: {
        findFirst: vi.fn().mockResolvedValue({
          organizationId: 'org',
          organizationalUnitId: 'unit',
          departmentId: 'department',
          teamId: 'team',
        }),
      },
      team: {
        findFirst: vi.fn().mockResolvedValue({
          departmentId: 'department',
          organizationalUnitId: null,
        }),
      },
      department: {
        findFirst: vi.fn().mockResolvedValue({ organizationalUnitId: 'unit' }),
      },
      organizationalUnit: { findMany: vi.fn().mockResolvedValue([]) },
    };
    const result = await new PositionAuthorizationTargetResolver(
      prisma,
    ).scopeForPosition('position');
    expect(result).toEqual({ type: 'TEAM', id: 'team' });
  });

  it('Batch 5B (D19): a team-anchored position inherits its department and unit path', async () => {
    const prisma: any = {
      position: {
        findFirst: vi.fn().mockResolvedValue({
          organizationId: 'org',
          organizationalUnitId: null,
          departmentId: null,
          teamId: 'team',
        }),
      },
      team: {
        findFirst: vi.fn().mockResolvedValue({
          departmentId: 'department',
          organizationalUnitId: null,
        }),
      },
      department: {
        findFirst: vi.fn().mockResolvedValue({ organizationalUnitId: 'child' }),
      },
      organizationalUnit: {
        findMany: vi.fn().mockResolvedValue([
          { id: 'child', parentUnitId: 'root' },
          { id: 'root', parentUnitId: null },
        ]),
      },
    };
    await expect(
      new PositionAuthorizationTargetResolver(prisma).resolvePosition(
        'position',
      ),
    ).resolves.toEqual({
      type: 'TEAM',
      organizationId: 'org',
      teamId: 'team',
      departmentId: 'department',
      unitPathIds: ['child', 'root'],
    });
  });

  it('Batch 5B (D19): a department-anchored position inherits its unit path', async () => {
    const prisma: any = {
      position: {
        findFirst: vi.fn().mockResolvedValue({
          organizationId: 'org',
          organizationalUnitId: null,
          departmentId: 'department',
          teamId: null,
        }),
      },
      department: {
        findFirst: vi.fn().mockResolvedValue({ organizationalUnitId: 'child' }),
      },
      organizationalUnit: {
        findMany: vi.fn().mockResolvedValue([
          { id: 'child', parentUnitId: 'root' },
          { id: 'root', parentUnitId: null },
        ]),
      },
    };
    await expect(
      new PositionAuthorizationTargetResolver(prisma).resolvePosition(
        'position',
      ),
    ).resolves.toMatchObject({
      type: 'DEPARTMENT',
      departmentId: 'department',
      unitPathIds: ['child', 'root'],
    });
  });

  it('preserves organization scope for unanchored positions', async () => {
    const prisma: any = {
      position: {
        findFirst: vi.fn().mockResolvedValue({
          organizationId: 'org',
          organizationalUnitId: null,
          departmentId: null,
          teamId: null,
        }),
      },
    };
    await expect(
      new PositionAuthorizationTargetResolver(prisma).scopeForPosition(
        'position',
      ),
    ).resolves.toEqual({ type: 'ORGANIZATION', id: 'org' });
  });
});
