import { describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../database/prisma.service.js';
import { PERMISSION_CATALOG } from './authorization-catalog.js';
import { AuthorizationCatalogService } from './authorization-catalog.service.js';

describe('AuthorizationCatalogService', () => {
  it('idempotently synchronizes active keys and retires keys outside the catalog', async () => {
    const tx = {
      permission: {
        upsert: vi
          .fn()
          .mockImplementation(({ where }: { where: { key: string } }) =>
            Promise.resolve({
              id: where.key,
              key: where.key,
              name: where.key,
              description: null,
              isActive: true,
            }),
          ),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      role: { findFirst: vi.fn().mockResolvedValue(null) },
      rolePermission: {
        upsert: vi.fn(),
      },
    };
    const database = {
      $transaction: vi.fn((callback: (client: unknown) => Promise<void>) =>
        callback(tx),
      ),
    } as unknown as PrismaService;
    const service = new AuthorizationCatalogService(database);

    await service.sync();
    await service.sync();

    expect(tx.permission.upsert).toHaveBeenCalledTimes(
      PERMISSION_CATALOG.length * 2,
    );
    expect(tx.permission.updateMany).toHaveBeenNthCalledWith(1, {
      where: {
        key: { notIn: PERMISSION_CATALOG.map(({ key }) => key) },
      },
      data: { isActive: false },
    });
    expect(tx.permission.updateMany).toHaveBeenCalledTimes(2);
  });

  it('reconciles the reserved System Owner with every active permission', async () => {
    const permissionRows = PERMISSION_CATALOG.map(({ key }) => ({
      id: key,
      key,
      name: key,
      description: null,
      isActive: true,
    }));
    const tx = {
      permission: {
        upsert: vi.fn(),
        updateMany: vi.fn(),
        findMany: vi.fn().mockResolvedValue(permissionRows),
      },
      role: {
        findFirst: vi.fn().mockResolvedValue({ id: 'system-owner' }),
      },
      rolePermission: { upsert: vi.fn() },
    };
    const database = {
      $transaction: vi.fn((callback: (client: unknown) => Promise<void>) =>
        callback(tx),
      ),
    } as unknown as PrismaService;

    await new AuthorizationCatalogService(database).sync();

    expect(tx.rolePermission.upsert).toHaveBeenCalledTimes(
      PERMISSION_CATALOG.length,
    );
    expect(tx.rolePermission.upsert).toHaveBeenCalledWith({
      where: {
        roleId_permissionId: {
          roleId: 'system-owner',
          permissionId: 'organization.read',
        },
      },
      create: {
        roleId: 'system-owner',
        permissionId: 'organization.read',
      },
      update: {},
    });
  });

  it('includes the Batch 2 self-service time clock permission', () => {
    expect(PERMISSION_CATALOG).toContainEqual(
      expect.objectContaining({
        key: 'time.clock',
        name: 'Use employee time clock',
      }),
    );
  });

  it('includes the Batch 8 management time read permission', () => {
    expect(PERMISSION_CATALOG).toContainEqual(
      expect.objectContaining({
        key: 'time.view',
        name: 'View time records',
      }),
    );
  });

  it('includes Batch 5 correction approval permissions', () => {
    expect(PERMISSION_CATALOG).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'time.approve' }),
        expect.objectContaining({ key: 'time.correct' }),
      ]),
    );
  });

  it('includes only the Phase 7 scheduling permissions', () => {
    const schedulingKeys = PERMISSION_CATALOG.map(({ key }) => key).filter(
      (key) => key.startsWith('schedule.'),
    );
    expect(schedulingKeys).toEqual([
      'schedule.read',
      'schedule.manage',
      'schedule.override_conflict',
      'schedule.publish',
      'schedule.manage_templates',
      'schedule.manage_patterns',
      'schedule.manage_policy',
    ]);
  });

  it('includes only the Phase 8 leave and holiday permissions', () => {
    const leaveKeys = PERMISSION_CATALOG.map(({ key }) => key).filter(
      (key) => key.startsWith('leave.') || key.startsWith('holiday.'),
    );
    expect(leaveKeys).toEqual([
      'leave.request',
      'leave.read',
      'leave.approve',
      'leave.adjust',
      'leave.manage_policy',
      'holiday.manage',
    ]);
  });
  it('includes only the Phase 9 compensation permissions, separate from employee access', () => {
    const keys = PERMISSION_CATALOG.map(({ key }) => key);
    expect(keys.filter((key) => key.startsWith('compensation.'))).toEqual([
      'compensation.read',
      'compensation.manage',
    ]);
  });

  it('adds Phase 10 payroll permissions that no other access implies', () => {
    const keys = PERMISSION_CATALOG.map(({ key }) => key);
    expect(keys.filter((key) => key.startsWith('payroll.'))).toEqual([
      'payroll.read',
      'payroll.manage',
      'payroll.calculate',
      'payroll.approve',
      'payroll.finalize',
      'payroll.adjust',
    ]);
    for (const { key, description } of PERMISSION_CATALOG) {
      if (key.startsWith('payroll.')) {
        expect(description).toMatch(/sensitive/i);
      }
    }
    expect(
      PERMISSION_CATALOG.find(({ key }) => key === 'payroll.read')?.description,
    ).toMatch(/never implied by employee\.read, compensation\.read/);
  });

  it('adds Phase 11 benefit permissions that no other access implies', () => {
    const keys = PERMISSION_CATALOG.map(({ key }) => key);
    expect(keys.filter((key) => key.startsWith('benefit.'))).toEqual([
      'benefit.read',
      'benefit.manage',
      'benefit.plan.manage',
    ]);
    for (const { key, description } of PERMISSION_CATALOG) {
      if (key.startsWith('benefit.')) expect(description).toMatch(/sensitive/i);
    }
    expect(
      PERMISSION_CATALOG.find(({ key }) => key === 'benefit.read')?.description,
    ).toMatch(/never implied by employee\.read/);
  });

  it('adds Phase 12 performance permissions that no other access implies', () => {
    const keys = PERMISSION_CATALOG.map(({ key }) => key);
    expect(keys.filter((key) => key.startsWith('performance.'))).toEqual([
      'performance.read',
      'performance.manage',
      'performance.template.manage',
      'performance.cycle.manage',
      'performance.evidence.manage',
    ]);
    for (const { key, description } of PERMISSION_CATALOG) {
      if (key.startsWith('performance.'))
        expect(description).toMatch(/sensitive/i);
    }
    expect(
      PERMISSION_CATALOG.find(({ key }) => key === 'performance.read')
        ?.description,
    ).toMatch(
      /never implied by employee\.read, managing employees, a reporting line/,
    );
  });

  it('adds Phase 13 recruitment permissions that no other access implies', () => {
    const keys = PERMISSION_CATALOG.map(({ key }) => key);
    expect(keys.filter((key) => key.startsWith('recruitment.'))).toEqual([
      'recruitment.read',
      'recruitment.manage',
      'recruitment.offer.approve',
      'recruitment.hire',
      'recruitment.pipeline.manage',
      'recruitment.intake.manage',
    ]);
    for (const key of [
      'recruitment.read',
      'recruitment.manage',
      'recruitment.offer.approve',
      'recruitment.hire',
      'recruitment.intake.manage',
    ]) {
      expect(
        PERMISSION_CATALOG.find((entry) => entry.key === key)?.description,
      ).toMatch(/sensitive/i);
    }
    expect(
      PERMISSION_CATALOG.find(({ key }) => key === 'recruitment.read')
        ?.description,
    ).toMatch(
      /never implied by employee\.read, managing employees, a reporting line/,
    );
  });

  it('adds Phase 14 onboarding and offboarding permissions that no other access implies', () => {
    const keys = PERMISSION_CATALOG.map(({ key }) => key);
    expect(
      keys.filter(
        (key) =>
          key.startsWith('onboarding.') || key.startsWith('offboarding.'),
      ),
    ).toEqual([
      'onboarding.read',
      'onboarding.manage',
      'offboarding.read',
      'offboarding.manage',
      'onboarding.template.manage',
    ]);
    for (const { key, description } of PERMISSION_CATALOG) {
      if (key.startsWith('onboarding.') || key.startsWith('offboarding.'))
        expect(description).toMatch(/sensitive/i);
    }
    expect(
      PERMISSION_CATALOG.find(({ key }) => key === 'offboarding.read')
        ?.description,
    ).toMatch(/never implied by onboarding access/);
  });

  it('adds Phase 15 document permissions that no other access implies', () => {
    const keys = PERMISSION_CATALOG.map(({ key }) => key);
    expect(keys.filter((key) => key.startsWith('document.'))).toEqual([
      'document.read',
      'document.confidential.read',
      'document.restricted.read',
      'document.manage',
      'document.type.manage',
      'document.policy.manage',
    ]);
    for (const { key, description } of PERMISSION_CATALOG) {
      if (key.startsWith('document.'))
        expect(description).toMatch(/sensitive/i);
    }
    expect(
      PERMISSION_CATALOG.find(({ key }) => key === 'document.read')
        ?.description,
    ).toMatch(
      /never implied by employee\.read, managing employees, a reporting line, payroll/,
    );
  });

  it('adds Phase 16 notification administration permissions', () => {
    const keys = PERMISSION_CATALOG.map(({ key }) => key);
    expect(keys.filter((key) => key.startsWith('notification.'))).toEqual([
      'notification.template.manage',
      'notification.settings.manage',
      'notification.delivery.read',
    ]);
    for (const { key, description } of PERMISSION_CATALOG) {
      if (key.startsWith('notification.')) {
        expect(description).toMatch(/organization scope/);
        expect(description).toMatch(
          /never grants reading anyone's notifications/i,
        );
      }
    }
  });

  it('adds Phase 16.5 Google Workspace integration permissions', () => {
    const keys = PERMISSION_CATALOG.map(({ key }) => key);
    expect(keys.filter((key) => key.startsWith('integration.'))).toEqual([
      'integration.google.manage',
      'integration.google.read',
    ]);
    for (const { key, description } of PERMISSION_CATALOG) {
      if (key.startsWith('integration.')) {
        expect(description).toMatch(/organization scope/);
        expect(description).toMatch(/never grants access to any domain data/i);
      }
    }
  });

  it('adds Phase 17 reporting permissions that grant no domain data', () => {
    const keys = PERMISSION_CATALOG.map(({ key }) => key);
    expect(keys.filter((key) => key.startsWith('report.'))).toEqual([
      'report.read',
      'report.export',
    ]);
    for (const { key, description } of PERMISSION_CATALOG) {
      if (key.startsWith('report.'))
        expect(description).toMatch(/never grants access to any domain data/i);
    }
  });

  it('adds Phase 18 feature management permissions that grant no domain data', () => {
    const keys = PERMISSION_CATALOG.map(({ key }) => key);
    expect(keys.filter((key) => key.startsWith('feature.'))).toEqual([
      'feature.read',
      'feature.manage',
    ]);
    for (const { key, description } of PERMISSION_CATALOG) {
      if (key.startsWith('feature.')) {
        expect(description).toMatch(/organization scope/);
        expect(description).toMatch(/never grants access to any domain data/i);
      }
    }
  });

  it('adds the Phase 19 audit viewer permission, organization scope, no domain data', () => {
    const entry = PERMISSION_CATALOG.find(({ key }) => key === 'audit.read');
    expect(entry).toBeDefined();
    expect(entry!.description).toMatch(/organization scope/);
    expect(entry!.description).toMatch(
      /never grants access to any domain data/i,
    );
    expect(
      PERMISSION_CATALOG.filter(({ key }) => key.startsWith('audit.')).map(
        ({ key }) => key,
      ),
    ).toEqual(['audit.read']);
  });
});
