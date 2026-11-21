import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../database/prisma.service.js';
import { AuthorizationService } from './authorization.service.js';
import { PERMISSION_CATALOG } from './authorization-catalog.js';
import { RoleManagementService } from './role-management.service.js';
import type { RoleRow, ScopeRef } from './authorization.types.js';

function makeAuditService(): AuditService {
  const write = vi.fn(
    (
      input: Parameters<AuditService['write']>[0],
      client?: Parameters<AuditService['write']>[1],
    ) => {
      if (!client) throw new Error('Expected a Prisma transaction client.');
      return client.auditLog.create({ data: input });
    },
  );
  return { write } as unknown as AuditService;
}

function makeService() {
  const futureAssignment = {
    id: 'assignment-future',
    userId: 'user-1',
    roleId: 'role-1',
    roleOrganizationId: 'org-1',
    scopeType: 'ORGANIZATION',
    organizationId: 'org-1',
    organizationalUnitId: null,
    departmentId: null,
    teamId: null,
    startsAt: new Date('2030-01-01T00:00:00.000Z'),
    expiresAt: null,
    revokedAt: null,
  };
  const expiredAssignment = {
    ...futureAssignment,
    id: 'assignment-expired',
    startsAt: new Date('2020-01-01T00:00:00.000Z'),
    expiresAt: new Date('2021-01-01T00:00:00.000Z'),
  };
  const tx = {
    role: {
      update: vi.fn().mockResolvedValue({ id: 'role-1' }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findUniqueOrThrow: vi.fn().mockResolvedValue({ id: 'role-1' }),
    },
    roleAssignment: {
      findMany: vi
        .fn()
        .mockResolvedValue([futureAssignment, expiredAssignment]),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    // Batch 6A (N1): the role row is locked first; Batch 5E: then the grants still live,
    // locked in id order (SELECT … FOR UPDATE).
    $queryRaw: vi
      .fn()
      .mockResolvedValueOnce([{ id: 'role-1' }])
      .mockResolvedValue([
        { id: expiredAssignment.id },
        { id: futureAssignment.id },
      ]),
    auditLog: { create: vi.fn().mockResolvedValue({ id: 'audit-1' }) },
  };
  const database = {
    role: {
      findUnique: vi.fn().mockResolvedValue({
        id: 'role-1',
        organizationId: 'org-1',
        code: 'HR_ADMIN',
        name: 'HR Admin',
        description: null,
        isSystemOwner: false,
        archivedAt: null,
      } satisfies RoleRow),
    },
    $transaction: vi.fn(
      (callback: (client: Prisma.TransactionClient) => Promise<unknown>) =>
        callback(tx as unknown as Prisma.TransactionClient),
    ),
  };
  const authorization = {
    assertCan: vi.fn().mockResolvedValue(undefined),
    assertCanDelegate: vi.fn().mockResolvedValue(undefined),
    resolveAssignmentScope: vi.fn(),
  };
  const service = new RoleManagementService(
    database as unknown as PrismaService,
    authorization as unknown as AuthorizationService,
    makeAuditService(),
  );
  return { service, tx, database, authorization };
}

function makeAssignmentService(
  scope: ScopeRef,
  hasDuplicate = false,
  targetOrganizationId = 'org-1',
) {
  const role = {
    id: 'role-1',
    organizationId: 'org-1',
    code: 'READER',
    name: 'Reader',
    description: null,
    isSystemOwner: false,
    archivedAt: null,
    permissions: [
      {
        permissionId: 'permission-read',
        permission: { key: 'organization.read' },
      },
    ],
  };
  const target = {
    type: scope.type,
    organizationId: targetOrganizationId,
    unitPathIds: scope.type === 'ORGANIZATIONAL_UNIT' ? [scope.id!] : [],
    departmentId: scope.type === 'DEPARTMENT' ? scope.id : null,
    teamId: scope.type === 'TEAM' ? scope.id : null,
  };
  const transaction = {
    role: { findUnique: vi.fn().mockResolvedValue(role) },
    user: {
      findUnique: vi.fn().mockResolvedValue({
        id: 'user-2',
        status: 'ACTIVE',
        archivedAt: null,
      }),
      // The account is connected to an organization the actor administers.
      count: vi.fn().mockResolvedValue(1),
    },
    roleAssignment: {
      findFirst: vi
        .fn()
        .mockResolvedValue(hasDuplicate ? { id: 'existing-assignment' } : null),
      create: vi.fn().mockResolvedValue({ id: 'assignment-1' }),
    },
    auditLog: { create: vi.fn().mockResolvedValue({ id: 'audit-1' }) },
  };
  const database = {
    $transaction: vi.fn(
      (callback: (client: Prisma.TransactionClient) => Promise<unknown>) =>
        callback(transaction as unknown as Prisma.TransactionClient),
    ),
  };
  const authorization = {
    resolveAssignmentScope: vi.fn().mockResolvedValue({
      organizationId: targetOrganizationId,
      target,
    }),
    assertCanDelegate: vi.fn().mockResolvedValue(undefined),
    effectiveGrants: vi.fn().mockResolvedValue([
      {
        permission: 'role.assign',
        scope: { type: 'ORGANIZATION', id: 'org-1' },
      },
    ]),
  };
  const service = new RoleManagementService(
    database as unknown as PrismaService,
    authorization as unknown as AuthorizationService,
    makeAuditService(),
  );
  return { service, transaction, database, authorization };
}

describe('RoleManagementService', () => {
  it('archive revokes every non-revoked assignment including future assignments transactionally', async () => {
    const { service, tx, database } = makeService();

    const result = await service.archiveRole('actor-1', 'role-1', {
      actorUserId: 'actor-1',
    });

    expect(result).toEqual({ success: true, role: { id: 'role-1' } });
    // Archived once (conditional), then every grant still live is revoked conditionally.
    expect(tx.role.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'role-1', archivedAt: null } }),
    );
    expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
    for (const id of ['assignment-expired', 'assignment-future'])
      expect(tx.roleAssignment.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id, revokedAt: null },
          data: expect.objectContaining({
            revokedByUserId: 'actor-1',
            revocationReason: 'Role archived',
          }),
        }),
      );
    expect(tx.auditLog.create).toHaveBeenCalledTimes(3);
    expect(database.$transaction).toHaveBeenCalledOnce();
  });

  it('Batch 5E: a role archived concurrently is not archived or revoked twice', async () => {
    const { service, tx } = makeService();
    tx.role.updateMany.mockResolvedValue({ count: 0 });

    const result = await service.archiveRole('actor-1', 'role-1');

    expect(result).toEqual({ success: true });
    expect(tx.roleAssignment.updateMany).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it('does not restore revoked assignments when a role is reactivated', async () => {
    const { service, tx, database } = makeService();
    database.role.findUnique.mockResolvedValue({
      id: 'role-1',
      organizationId: 'org-1',
      code: 'HR_ADMIN',
      name: 'HR Admin',
      description: null,
      isSystemOwner: false,
      archivedAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    await service.reactivateRole('actor-1', 'role-1');

    expect(tx.role.update).toHaveBeenCalledWith({
      where: { id: 'role-1' },
      data: { archivedAt: null },
    });
    expect(tx.roleAssignment.updateMany).not.toHaveBeenCalled();
    expect(tx.roleAssignment.findMany).not.toHaveBeenCalled();
  });

  it('does not mutate reserved System Owner roles', async () => {
    const { service, tx, database } = makeService();
    database.role.findUnique.mockResolvedValue({
      id: 'owner',
      organizationId: null,
      code: 'SYSTEM_OWNER',
      name: 'System Owner',
      description: null,
      isSystemOwner: true,
      archivedAt: null,
    });

    await expect(
      service.archiveRole('actor-1', 'owner'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(database.$transaction).not.toHaveBeenCalled();
    expect(tx.role.update).not.toHaveBeenCalled();
  });

  it('requires an explicit bootstrap email before touching persistence', async () => {
    const { service, database } = makeService();

    await expect(service.bootstrapSystemOwner('  ')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(database.role.findUnique).not.toHaveBeenCalled();
  });

  it('bootstraps only the explicitly selected active user and is idempotent', async () => {
    const user = {
      id: 'selected-user',
      email: 'owner@example.com',
      status: 'ACTIVE',
      archivedAt: null,
    };
    const systemOwner = {
      id: 'system-owner',
      organizationId: null,
      code: 'SYSTEM_OWNER',
      name: 'System Owner',
      description: null,
      isSystemOwner: true,
      archivedAt: null,
    };
    let roleExists = true;
    let assignmentExists = false;
    const grantedPermissions = new Set<string>();
    const transaction = {
      role: {
        findFirst: vi.fn(async () => (roleExists ? systemOwner : null)),
        create: vi.fn(async () => {
          roleExists = true;
          return systemOwner;
        }),
        update: vi.fn(),
      },
      rolePermission: {
        findFirst: vi.fn(
          async ({ where }: { where: { permissionId: string } }) =>
            grantedPermissions.has(where.permissionId) ? { id: 'grant' } : null,
        ),
        create: vi.fn(async ({ data }: { data: { permissionId: string } }) => {
          grantedPermissions.add(data.permissionId);
          return { id: 'grant' };
        }),
      },
      roleAssignment: {
        findFirst: vi.fn(async () =>
          assignmentExists ? { id: 'owner-assignment' } : null,
        ),
        create: vi.fn(async () => {
          assignmentExists = true;
          return { id: 'owner-assignment' };
        }),
      },
      auditLog: { create: vi.fn().mockResolvedValue({ id: 'audit-1' }) },
    };
    const database = {
      user: { findUnique: vi.fn().mockResolvedValue(user) },
      permission: {
        findMany: vi.fn().mockResolvedValue(
          PERMISSION_CATALOG.map(({ key, name, description }) => ({
            id: key,
            key,
            name,
            description,
            isActive: true,
          })),
        ),
      },
      $transaction: vi.fn(
        (callback: (client: Prisma.TransactionClient) => Promise<unknown>) =>
          callback(transaction as unknown as Prisma.TransactionClient),
      ),
    };
    const service = new RoleManagementService(
      database as unknown as PrismaService,
      {} as AuthorizationService,
      makeAuditService(),
    );

    await expect(
      service.bootstrapSystemOwner(' OWNER@EXAMPLE.COM '),
    ).resolves.toEqual({ userId: 'selected-user', roleId: 'system-owner' });
    await service.bootstrapSystemOwner('owner@example.com');

    expect(database.user.findUnique).toHaveBeenCalledWith({
      where: { email: 'owner@example.com' },
    });
    expect(transaction.role.findFirst).toHaveBeenCalledTimes(2);
    expect(transaction.role.create).not.toHaveBeenCalled();
    expect(transaction.rolePermission.create).toHaveBeenCalledTimes(
      PERMISSION_CATALOG.length,
    );
    expect(transaction.roleAssignment.create).toHaveBeenCalledOnce();
    expect(transaction.auditLog.create).toHaveBeenCalledOnce();
  });

  it.each([
    ['unknown', null],
    [
      'inactive',
      {
        id: 'inactive-user',
        email: 'owner@example.com',
        status: 'INACTIVE',
        archivedAt: null,
      },
    ],
    [
      'archived',
      {
        id: 'archived-user',
        email: 'owner@example.com',
        status: 'ACTIVE',
        archivedAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    ],
  ])('rejects bootstrap for an %s user', async (_case, user) => {
    const database = {
      user: { findUnique: vi.fn().mockResolvedValue(user) },
      $transaction: vi.fn(),
    };
    const service = new RoleManagementService(
      database as unknown as PrismaService,
      {} as AuthorizationService,
      makeAuditService(),
    );

    await expect(
      service.bootstrapSystemOwner('owner@example.com'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(database.$transaction).not.toHaveBeenCalled();
  });

  it('rejects assignment dates that do not end after they start', async () => {
    const { service, database } = makeService();

    await expect(
      service.createAssignment('actor-1', {
        userId: 'user-2',
        roleId: 'role-1',
        scope: { type: 'ORGANIZATION', id: 'org-1' },
        startsAt: new Date('2026-01-02T00:00:00.000Z'),
        expiresAt: new Date('2026-01-02T00:00:00.000Z'),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(database.$transaction).not.toHaveBeenCalled();
  });

  it('rejects adding a role permission the actor lacks at organization scope', async () => {
    const transaction = {
      role: { create: vi.fn() },
      permission: { findMany: vi.fn() },
      rolePermission: { deleteMany: vi.fn(), create: vi.fn() },
      auditLog: { create: vi.fn() },
    };
    const database = {
      organization: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'org-1',
          archivedAt: null,
        }),
      },
      $transaction: vi.fn(
        (callback: (client: Prisma.TransactionClient) => Promise<unknown>) =>
          callback(transaction as unknown as Prisma.TransactionClient),
      ),
    };
    const authorization = {
      assertCan: vi.fn(async (_userId: string, permission: string) => {
        if (permission === 'organization.read') {
          throw new ForbiddenException();
        }
      }),
    };
    const service = new RoleManagementService(
      database as unknown as PrismaService,
      authorization as unknown as AuthorizationService,
      makeAuditService(),
    );

    await expect(
      service.createRole('actor-1', 'org-1', {
        code: 'reader',
        name: 'Reader',
        permissionKeys: ['organization.read'],
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(authorization.assertCan).toHaveBeenCalledWith(
      'actor-1',
      'role.manage',
      { type: 'ORGANIZATION', id: 'org-1' },
    );
    expect(authorization.assertCan).toHaveBeenCalledWith(
      'actor-1',
      'organization.read',
      { type: 'ORGANIZATION', id: 'org-1' },
      expect.anything(),
    );
    expect(transaction.role.create).not.toHaveBeenCalled();
  });

  it('replaces role permissions atomically and audits the permission diff', async () => {
    const role = {
      id: 'role-1',
      organizationId: 'org-1',
      code: 'READER',
      name: 'Reader',
      description: null,
      isSystemOwner: false,
      archivedAt: null,
    };
    const tx = {
      role: {
        findUnique: vi
          .fn()
          .mockResolvedValueOnce({
            ...role,
            permissions: [
              { permission: { key: 'organization.read' } },
              { permission: { key: 'role.read' } },
            ],
          })
          .mockResolvedValueOnce({
            ...role,
            permissions: [{ permission: { key: 'organization.manage' } }],
          }),
      },
      permission: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            { id: 'permission-manage', key: 'organization.manage' },
          ]),
      },
      rolePermission: {
        deleteMany: vi.fn().mockResolvedValue({ count: 2 }),
        create: vi.fn().mockResolvedValue({ id: 'grant' }),
      },
      auditLog: { create: vi.fn().mockResolvedValue({ id: 'audit' }) },
    };
    const database = {
      role: { findUnique: vi.fn().mockResolvedValue(role) },
      $transaction: vi.fn(
        (callback: (client: Prisma.TransactionClient) => Promise<unknown>) =>
          callback(tx as unknown as Prisma.TransactionClient),
      ),
    };
    const authorization = {
      assertCan: vi.fn().mockResolvedValue(undefined),
    };
    const audit = makeAuditService();
    const service = new RoleManagementService(
      database as unknown as PrismaService,
      authorization as unknown as AuthorizationService,
      audit,
    );

    await service.replaceRolePermissions(
      'actor-1',
      'role-1',
      ['organization.manage'],
      { actorUserId: 'actor-1' },
    );

    // Batch 5E: role checks pass the client they read with (the transaction, when there is one).
    expect(authorization.assertCan).toHaveBeenCalledWith(
      'actor-1',
      'role.manage',
      { type: 'ORGANIZATION', id: 'org-1' },
      expect.anything(),
    );
    expect(authorization.assertCan).toHaveBeenCalledWith(
      'actor-1',
      'organization.manage',
      { type: 'ORGANIZATION', id: 'org-1' },
      tx,
    );
    expect(authorization.assertCan).toHaveBeenCalledTimes(2);
    expect(tx.rolePermission.deleteMany).toHaveBeenCalledOnce();
    expect(tx.rolePermission.create).toHaveBeenCalledWith({
      data: { roleId: 'role-1', permissionId: 'permission-manage' },
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'ROLE_PERMISSIONS_CHANGED',
        metadata: expect.objectContaining({
          before: ['organization.read', 'role.read'],
          after: ['organization.manage'],
          added: ['organization.manage'],
          removed: ['organization.read', 'role.read'],
        }),
      }),
    });
    expect(database.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'Serializable',
    });
  });

  it('rejects role assignments when the actor lacks a granted permission at scope', async () => {
    const role = {
      id: 'role-1',
      organizationId: 'org-1',
      code: 'READER',
      name: 'Reader',
      description: null,
      isSystemOwner: false,
      archivedAt: null,
      permissions: [
        {
          permissionId: 'permission-read',
          permission: { key: 'organization.read' },
        },
      ],
    };
    const transaction = {
      role: { findUnique: vi.fn().mockResolvedValue(role) },
      user: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'user-2',
          status: 'ACTIVE',
          archivedAt: null,
        }),
        count: vi.fn().mockResolvedValue(1),
      },
      roleAssignment: { findFirst: vi.fn(), create: vi.fn() },
      auditLog: { create: vi.fn() },
    };
    const database = {
      role: { findUnique: vi.fn().mockResolvedValue(role) },
      user: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'user-2',
          status: 'ACTIVE',
          archivedAt: null,
        }),
      },
      $transaction: vi.fn(
        (callback: (client: Prisma.TransactionClient) => Promise<unknown>) =>
          callback(transaction as unknown as Prisma.TransactionClient),
      ),
    };
    const authorization = {
      resolveAssignmentScope: vi.fn().mockResolvedValue({
        organizationId: 'org-1',
        target: {
          type: 'DEPARTMENT',
          organizationId: 'org-1',
          departmentId: 'department-1',
          unitPathIds: [],
        },
      }),
      assertCanDelegate: vi
        .fn()
        .mockRejectedValue(new ForbiddenException('Missing permission')),
    };
    const service = new RoleManagementService(
      database as unknown as PrismaService,
      authorization as unknown as AuthorizationService,
      makeAuditService(),
    );

    await expect(
      service.createAssignment('actor-1', {
        userId: 'user-2',
        roleId: 'role-1',
        scope: { type: 'DEPARTMENT', id: 'department-1' },
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(authorization.assertCanDelegate).toHaveBeenCalledWith(
      'actor-1',
      ['organization.read'],
      { type: 'DEPARTMENT', id: 'department-1' },
      expect.anything(),
    );
    expect(transaction.roleAssignment.create).not.toHaveBeenCalled();
  });

  it('creates a valid delegated assignment after scope and permission checks', async () => {
    const role = {
      id: 'role-1',
      organizationId: 'org-1',
      code: 'READER',
      name: 'Reader',
      description: null,
      isSystemOwner: false,
      archivedAt: null,
      permissions: [
        {
          permissionId: 'permission-read',
          permission: { key: 'organization.read' },
        },
      ],
    };
    const transaction = {
      role: { findUnique: vi.fn().mockResolvedValue(role) },
      user: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'user-2',
          status: 'ACTIVE',
          archivedAt: null,
        }),
        count: vi.fn().mockResolvedValue(1),
      },
      roleAssignment: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: 'assignment-1' }),
      },
      auditLog: { create: vi.fn().mockResolvedValue({ id: 'audit-1' }) },
    };
    const database = {
      role: { findUnique: vi.fn().mockResolvedValue(role) },
      user: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'user-2',
          status: 'ACTIVE',
          archivedAt: null,
        }),
      },
      $transaction: vi.fn(
        (callback: (client: Prisma.TransactionClient) => Promise<unknown>) =>
          callback(transaction as unknown as Prisma.TransactionClient),
      ),
    };
    const authorization = {
      resolveAssignmentScope: vi.fn().mockResolvedValue({
        organizationId: 'org-1',
        target: {
          type: 'DEPARTMENT',
          organizationId: 'org-1',
          departmentId: 'department-1',
          unitPathIds: [],
        },
      }),
      assertCanDelegate: vi.fn().mockResolvedValue(undefined),
      effectiveGrants: vi.fn().mockResolvedValue([]),
    };
    const service = new RoleManagementService(
      database as unknown as PrismaService,
      authorization as unknown as AuthorizationService,
      makeAuditService(),
    );

    await expect(
      service.createAssignment('actor-1', {
        userId: 'user-2',
        roleId: 'role-1',
        scope: { type: 'DEPARTMENT', id: 'department-1' },
      }),
    ).resolves.toEqual({ id: 'assignment-1' });
    expect(authorization.assertCanDelegate).toHaveBeenCalledWith(
      'actor-1',
      ['organization.read'],
      { type: 'DEPARTMENT', id: 'department-1' },
      expect.anything(),
    );
    expect(transaction.roleAssignment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          scopeType: 'DEPARTMENT',
          organizationId: 'org-1',
          departmentId: 'department-1',
        }),
      }),
    );
    expect(transaction.auditLog.create).toHaveBeenCalledOnce();
  });

  it.each([
    [{ type: 'ORGANIZATION', id: 'org-1' }, 'ORGANIZATION', 'org-1'],
    [
      { type: 'ORGANIZATIONAL_UNIT', id: 'unit-1' },
      'ORGANIZATIONAL_UNIT',
      'unit-1',
    ],
    [{ type: 'TEAM', id: 'team-1' }, 'TEAM', 'team-1'],
  ] as const)(
    'persists a %s assignment using its explicit scope FK',
    async (scope, scopeType, targetId) => {
      const { service, transaction } = makeAssignmentService(scope);

      await service.createAssignment('actor-1', {
        userId: 'user-2',
        roleId: 'role-1',
        scope,
      });

      expect(transaction.roleAssignment.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          scopeType,
          organizationId: 'org-1',
          organizationalUnitId:
            scopeType === 'ORGANIZATIONAL_UNIT' ? targetId : null,
          departmentId: null,
          teamId: scopeType === 'TEAM' ? targetId : null,
        }),
      });
    },
  );

  it('answers an account outside the actor’s organizations like an unknown account', async () => {
    const { service, transaction } = makeAssignmentService({
      type: 'DEPARTMENT',
      id: 'department-1',
    });
    transaction.user.count.mockResolvedValueOnce(0);

    await expect(
      service.createAssignment('actor-1', {
        userId: 'user-2',
        roleId: 'role-1',
        scope: { type: 'DEPARTMENT', id: 'department-1' },
      }),
    ).rejects.toThrow(
      new NotFoundException('Active or invited user not found'),
    );
    // Membership is checked in the actor's organizations plus the role's own organization.
    expect(JSON.stringify(transaction.user.count.mock.calls[0])).toContain(
      '"in":["org-1","org-1"]',
    );
    expect(transaction.roleAssignment.create).not.toHaveBeenCalled();
  });

  it('rejects a duplicate non-revoked user-role-scope assignment', async () => {
    const { service, transaction } = makeAssignmentService(
      { type: 'DEPARTMENT', id: 'department-1' },
      true,
    );

    await expect(
      service.createAssignment('actor-1', {
        userId: 'user-2',
        roleId: 'role-1',
        scope: { type: 'DEPARTMENT', id: 'department-1' },
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(transaction.roleAssignment.findFirst).toHaveBeenCalledWith({
      where: {
        userId: 'user-2',
        roleId: 'role-1',
        revokedAt: null,
        scopeType: 'DEPARTMENT',
        organizationId: 'org-1',
        organizationalUnitId: null,
        departmentId: 'department-1',
        teamId: null,
      },
    });
    expect(transaction.roleAssignment.create).not.toHaveBeenCalled();
  });

  it('rejects a Role assigned to a scope in a different Organization', async () => {
    const { service, transaction } = makeAssignmentService(
      { type: 'ORGANIZATION', id: 'org-2' },
      false,
      'org-2',
    );

    await expect(
      service.createAssignment('actor-1', {
        userId: 'user-2',
        roleId: 'role-1',
        scope: { type: 'ORGANIZATION', id: 'org-2' },
      }),
    ).rejects.toThrow(/share an organization/);
    expect(transaction.roleAssignment.create).not.toHaveBeenCalled();
  });
});
