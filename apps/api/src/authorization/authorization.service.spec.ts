import { describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../database/prisma.service.js';
import { AuthorizationService } from './authorization.service.js';
/* oxlint-disable typescript/unbound-method */
import type { RoleAssignmentRow } from './authorization.types.js';

describe('AuthorizationService', () => {
  it('builds effective grants only from active assignments, roles, and permissions', async () => {
    const now = new Date('2026-04-01T00:00:00.000Z');
    const assignments = [
      makeAssignment({
        id: 'valid',
        startsAt: new Date(now.getTime() - 1),
        expiresAt: new Date(now.getTime() + 1),
        revokedAt: null,
        role: {
          id: 'role-active',
          organizationId: 'org-1',
          code: 'HR',
          name: 'HR',
          description: null,
          isSystemOwner: false,
          archivedAt: null,
          permissions: [
            {
              permissionId: 'permission-read',
              permission: {
                id: 'permission-read',
                key: 'organization.read',
                name: 'Read',
                description: null,
                isActive: true,
              },
            },
            {
              permissionId: 'permission-retired',
              permission: {
                id: 'permission-retired',
                key: 'organization.retired',
                name: 'Retired',
                description: null,
                isActive: false,
              },
            },
          ],
        },
      }),
      makeAssignment({
        id: 'future',
        startsAt: new Date(now.getTime() + 1),
      }),
      makeAssignment({
        id: 'expired',
        expiresAt: new Date(now.getTime() - 1),
      }),
      makeAssignment({
        id: 'revoked',
        revokedAt: new Date(now.getTime() - 1),
      }),
    ];
    const findMany = vi.fn().mockResolvedValue(assignments);
    const database = {
      roleAssignment: { findMany },
    } as unknown as PrismaService;
    const service = new AuthorizationService(
      database as unknown as PrismaService,
    );

    await expect(service.effectiveGrants('user-1', now)).resolves.toEqual([
      {
        permission: 'organization.read',
        scope: { type: 'ORGANIZATION', id: 'org-1' },
      },
    ]);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId: 'user-1',
          revokedAt: null,
          // Batch 5B (K9): neither the scope organization nor the role's organization archived.
          OR: [
            { organizationId: null },
            { organization: { archivedAt: null } },
          ],
          role: {
            archivedAt: null,
            OR: [
              { organizationId: null },
              { organization: { archivedAt: null } },
            ],
          },
          user: { status: 'ACTIVE', archivedAt: null },
        },
      }),
    );
  });

  it('checks exact permission keys on a system-scoped grant', async () => {
    const database = {
      roleAssignment: {
        findMany: vi.fn().mockResolvedValue([
          makeAssignment({
            scopeType: 'SYSTEM',
            organizationId: null,
            role: {
              id: 'system',
              organizationId: null,
              code: 'SYSTEM_OWNER',
              name: 'System Owner',
              description: null,
              isSystemOwner: true,
              archivedAt: null,
              permissions: [
                {
                  permissionId: 'read',
                  permission: {
                    id: 'read',
                    key: 'organization.read',
                    name: 'Read',
                    description: null,
                    isActive: true,
                  },
                },
              ],
            },
          }),
        ]),
      },
    } as unknown as PrismaService;
    const service = new AuthorizationService(
      database as unknown as PrismaService,
    );

    await expect(
      service.can('user-1', 'organization.read', { type: 'SYSTEM' }),
    ).resolves.toBe(true);
    await expect(
      service.can('user-1', 'organization.manage', { type: 'SYSTEM' }),
    ).resolves.toBe(false);
  });

  it('requires exact delegated grants in addition to role.assign', async () => {
    const findManyPermissions = vi.fn().mockResolvedValue([
      {
        id: 'assign',
        key: 'role.assign',
        name: 'Assign',
        description: null,
        isActive: true,
      },
      {
        id: 'read',
        key: 'organization.read',
        name: 'Read',
        description: null,
        isActive: true,
      },
    ]);
    const database = {
      roleAssignment: {
        findMany: vi.fn().mockResolvedValue([
          makeAssignment({
            scopeType: 'SYSTEM',
            organizationId: null,
            role: {
              id: 'system',
              organizationId: null,
              code: 'SYSTEM_OWNER',
              name: 'System Owner',
              description: null,
              isSystemOwner: true,
              archivedAt: null,
              permissions: ['role.assign', 'organization.read'].map((key) => ({
                permissionId: key,
                permission: {
                  id: key,
                  key,
                  name: key,
                  description: null,
                  isActive: true,
                },
              })),
            },
          }),
        ]),
      },
      permission: { findMany: findManyPermissions },
    } as unknown as PrismaService;
    const service = new AuthorizationService(
      database as unknown as PrismaService,
    );

    await expect(
      service.assertCanDelegate('user-1', ['organization.read'], {
        type: 'SYSTEM',
      }),
    ).resolves.toBeUndefined();
    await expect(
      service.assertCanDelegate('user-1', ['organization.manage'], {
        type: 'SYSTEM',
      }),
    ).rejects.toThrow(/organization.manage/);
  });

  it('returns effective Permission records for the requested concrete target scope', async () => {
    const findManyAssignments = vi.fn().mockResolvedValue([
      makeAssignment({
        scopeType: 'SYSTEM',
        organizationId: null,
        role: {
          id: 'system',
          organizationId: null,
          code: 'SYSTEM_OWNER',
          name: 'System Owner',
          description: null,
          isSystemOwner: true,
          archivedAt: null,
          permissions: ['organization.read'].map((key) => ({
            permissionId: key,
            permission: {
              id: key,
              key,
              name: key,
              description: null,
              isActive: true,
            },
          })),
        },
      }),
      makeAssignment({
        id: 'role-grant',
        scopeType: 'ORGANIZATION',
        organizationId: 'org-1',
        role: {
          id: 'role-org',
          organizationId: 'org-1',
          code: 'ORG',
          name: 'Organization Role',
          description: null,
          isSystemOwner: false,
          archivedAt: null,
          permissions: ['organization.manage'].map((key) => ({
            permissionId: key,
            permission: {
              id: key,
              key,
              name: key,
              description: null,
              isActive: true,
            },
          })),
        },
      }),
    ]);
    const findManyPermissions = vi.fn().mockResolvedValue([
      {
        id: 'manage',
        key: 'organization.manage',
        name: 'Manage organization',
        description: null,
        isActive: true,
      },
      {
        id: 'read',
        key: 'organization.read',
        name: 'Read organization',
        description: null,
        isActive: true,
      },
    ]);
    const database = {
      roleAssignment: { findMany: findManyAssignments },
      permission: { findMany: findManyPermissions },
      organization: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'org-1',
          name: 'Org',
          archivedAt: null,
        }),
      },
    } as unknown as PrismaService;
    const service = new AuthorizationService(database);

    await expect(
      service.effectivePermissionKeys('user-1', {
        type: 'ORGANIZATION',
        organizationId: 'org-1',
      }),
    ).resolves.toEqual(['organization.manage', 'organization.read']);
    expect(findManyPermissions).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          key: {
            in: expect.arrayContaining([
              'organization.manage',
              'organization.read',
            ]),
          },
          isActive: true,
        }),
        orderBy: { key: 'asc' },
      }),
    );
  });

  it('rejects delegation outside the actor assignment scope', async () => {
    const permissions = ['role.assign', 'organization.read'];
    const database = {
      roleAssignment: {
        findMany: vi.fn().mockResolvedValue([
          makeAssignment({
            scopeType: 'DEPARTMENT',
            organizationalUnitId: null,
            departmentId: 'department-a',
            role: {
              id: 'role-1',
              organizationId: 'org-1',
              code: 'DEPT',
              name: 'Department',
              description: null,
              isSystemOwner: false,
              archivedAt: null,
              permissions: permissions.map((key) => ({
                permissionId: key,
                permission: {
                  id: key,
                  key,
                  name: key,
                  description: null,
                  isActive: true,
                },
              })),
            },
          }),
        ]),
      },
      department: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'department-b',
          organizationId: 'org-1',
          organizationalUnitId: null,
        }),
      },
      permission: { findMany: vi.fn() },
    } as unknown as PrismaService;
    const service = new AuthorizationService(database);

    await expect(
      service.assertCanDelegate('user-1', ['organization.read'], {
        type: 'DEPARTMENT',
        id: 'department-b',
      }),
    ).rejects.toThrow(/role.assign/);
    expect(database.permission.findMany).not.toHaveBeenCalled();
  });

  it('allows System Owner grants to delegate an organization role', async () => {
    const permissions = ['role.assign', 'organization.manage'];
    const database = {
      roleAssignment: {
        findMany: vi.fn().mockResolvedValue([
          makeAssignment({
            scopeType: 'SYSTEM',
            organizationId: null,
            roleOrganizationId: null,
            role: {
              id: 'system',
              organizationId: null,
              code: 'SYSTEM_OWNER',
              name: 'System Owner',
              description: null,
              isSystemOwner: true,
              archivedAt: null,
              permissions: permissions.map((key) => ({
                permissionId: key,
                permission: {
                  id: key,
                  key,
                  name: key,
                  description: null,
                  isActive: true,
                },
              })),
            },
          }),
        ]),
      },
      permission: {
        findMany: vi.fn().mockImplementation(({ where }) =>
          Promise.resolve(
            where.key.in.map((key: string) => ({
              id: key,
              key,
              name: key,
              description: null,
              isActive: true,
            })),
          ),
        ),
      },
      organization: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'org-1',
          name: 'Organization',
          archivedAt: null,
        }),
      },
    } as unknown as PrismaService;
    const service = new AuthorizationService(database);

    await expect(
      service.assertCanDelegate('owner-user', ['organization.manage'], {
        type: 'ORGANIZATION',
        id: 'org-1',
      }),
    ).resolves.toBeUndefined();
  });

  it('rejects SYSTEM scope through the ordinary assignment resolver', async () => {
    const service = new AuthorizationService({} as PrismaService);

    await expect(
      service.resolveAssignmentScope({ type: 'SYSTEM' }),
    ).rejects.toThrow(/reserved for bootstrap/);
  });

  it('collects permissions granted anywhere within one organization', async () => {
    const unitFind = vi.fn().mockResolvedValue([{ id: 'unit-a' }]);
    const departmentFind = vi.fn().mockResolvedValue([]);
    const teamFind = vi.fn().mockResolvedValue([{ id: 'team-a' }]);
    const database = {
      organizationalUnit: { findMany: unitFind },
      department: { findMany: departmentFind },
      team: { findMany: teamFind },
    } as unknown as PrismaService;
    const service = new AuthorizationService(database);
    const grants = vi.spyOn(service, 'effectiveGrants');

    grants.mockResolvedValueOnce([
      {
        permission: 'organization.manage',
        scope: { type: 'TEAM', id: 'team-a' },
      },
      {
        permission: 'organization.read',
        scope: { type: 'ORGANIZATIONAL_UNIT', id: 'unit-a' },
      },
      // A department of another organization (not returned by the in-organization lookup).
      {
        permission: 'employee.read',
        scope: { type: 'DEPARTMENT', id: 'dept-b' },
      },
      {
        permission: 'payroll.read',
        scope: { type: 'ORGANIZATION', id: 'org-b' },
      },
    ]);
    await expect(
      service.permissionKeysWithinOrganization('user-1', 'org-a'),
    ).resolves.toEqual(new Set(['organization.manage', 'organization.read']));
    expect(departmentFind).toHaveBeenCalledWith({
      where: { id: { in: ['dept-b'] }, organizationId: 'org-a' },
      select: { id: true },
    });

    grants.mockResolvedValueOnce([
      { permission: 'organization.manage', scope: { type: 'SYSTEM' } },
      {
        permission: 'organization.read',
        scope: { type: 'ORGANIZATION', id: 'org-a' },
      },
    ]);
    unitFind.mockClear();
    await expect(
      service.permissionKeysWithinOrganization('user-1', 'org-a'),
    ).resolves.toEqual(new Set(['organization.manage', 'organization.read']));
    expect(unitFind).not.toHaveBeenCalled();

    grants.mockResolvedValueOnce([]);
    await expect(
      service.permissionKeysWithinOrganization('user-1', 'org-a'),
    ).resolves.toEqual(new Set());
  });
});

function makeAssignment(
  overrides: Partial<RoleAssignmentRow>,
): RoleAssignmentRow {
  return {
    id: 'assignment-default',
    userId: 'user-1',
    roleId: 'role-1',
    roleOrganizationId: 'org-1',
    scopeType: 'ORGANIZATION',
    organizationId: 'org-1',
    organizationalUnitId: null,
    departmentId: null,
    teamId: null,
    startsAt: new Date('2020-01-01T00:00:00.000Z'),
    expiresAt: null,
    revokedAt: null,
    role: {
      id: 'role-1',
      organizationId: 'org-1',
      code: 'TEST',
      name: 'Test',
      description: null,
      isSystemOwner: false,
      archivedAt: null,
      permissions: [],
    },
    ...overrides,
  };
}
