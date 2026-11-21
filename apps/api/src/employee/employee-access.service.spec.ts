import { describe, expect, it, vi } from 'vitest';
import { EmployeeAccessService } from './employee-access.service.js';

describe('EmployeeAccessService', () => {
  it('hides employees with no non-cancelled assignments', async () => {
    const prisma = {
      employee: { findUnique: vi.fn().mockResolvedValue({ assignments: [] }) },
    } as any;
    const targets = { scopeForPosition: vi.fn() } as any;
    const authorization = {
      can: vi.fn().mockResolvedValue(false),
      canAccess: vi.fn(),
    } as any;
    const service = new EmployeeAccessService(prisma, authorization, targets);
    await expect(service.canEmployee('user', 'employee')).resolves.toBe(false);
    expect(targets.scopeForPosition).not.toHaveBeenCalled();
  });

  it('checks position authorization through the shared resolver', async () => {
    const prisma = {} as any;
    const targets = {
      scopeForPosition: vi.fn().mockResolvedValue({ type: 'TEAM', id: 'team' }),
    } as any;
    const authorization = { canAccess: vi.fn().mockResolvedValue(true) } as any;
    const service = new EmployeeAccessService(prisma, authorization, targets);
    await expect(service.canPosition('user', 'position')).resolves.toBe(true);
    expect(authorization.canAccess).toHaveBeenCalledWith(
      'user',
      'employee.read',
      { type: 'TEAM', id: 'team' },
      prisma,
    );
  });

  it('allows a system reader to see an unassigned employee', async () => {
    const prisma = {
      employee: {
        findUnique: vi
          .fn()
          .mockResolvedValue({ id: 'employee', assignments: [] }),
      },
    } as any;
    const targets = { scopeForPosition: vi.fn() } as any;
    const authorization = {
      can: vi.fn().mockResolvedValue(true),
      canAccess: vi.fn(),
    } as any;
    const service = new EmployeeAccessService(prisma, authorization, targets);
    await expect(
      service.canEmployee('system-reader', 'employee'),
    ).resolves.toBe(true);
    expect(authorization.can).toHaveBeenCalledWith(
      'system-reader',
      'employee.read',
      { type: 'SYSTEM' },
      expect.any(Date),
      prisma,
    );
  });
});
