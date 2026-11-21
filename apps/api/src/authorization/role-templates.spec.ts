import {
  PERMISSION_CATALOG,
  SYSTEM_OWNER_ROLE_CODE,
} from './authorization-catalog.js';
import { ROLE_TEMPLATE_KEYS, ROLE_TEMPLATES } from './role-templates.js';

const CATALOG = new Set<string>(PERMISSION_CATALOG.map(({ key }) => key));
const byKey = (key: string) =>
  ROLE_TEMPLATES.find((template) => template.key === key)!;

describe('role templates', () => {
  it('offers exactly the contract templates, once each', () => {
    expect(ROLE_TEMPLATES.map((t) => t.key)).toEqual([...ROLE_TEMPLATE_KEYS]);
    expect(new Set(ROLE_TEMPLATES.map((t) => t.key)).size).toBe(
      ROLE_TEMPLATES.length,
    );
  });

  it('uses only existing catalog keys, without duplicates', () => {
    for (const template of ROLE_TEMPLATES) {
      expect(template.permissions.length, template.key).toBeGreaterThan(0);
      expect(new Set(template.permissions).size, template.key).toBe(
        template.permissions.length,
      );
      for (const key of template.permissions)
        expect(CATALOG.has(key), `${template.key}: ${key}`).toBe(true);
      expect(template.name.trim()).not.toBe('');
      expect(template.description.trim()).not.toBe('');
    }
  });

  it('never reproduces the reserved System Owner', () => {
    for (const template of ROLE_TEMPLATES) {
      expect(template.key).not.toBe(SYSTEM_OWNER_ROLE_CODE);
      expect(template.key).not.toMatch(/SYSTEM/);
      // No template is "everything": the System Owner is the only all-permission role.
      expect(template.permissions.length).toBeLessThan(CATALOG.size / 2);
    }
  });

  it('keeps the employee template minimal and self-service only', () => {
    expect([...byKey('EMPLOYEE').permissions].sort()).toEqual([
      'leave.request',
      'time.clock',
    ]);
  });

  it('keeps the manager template to team supervision (no administration, pay or records)', () => {
    const manager = byKey('MANAGER').permissions;
    for (const key of manager) {
      expect(key).not.toMatch(/\.manage(_|$)|\.manage\b/);
      expect(key).not.toMatch(
        /^(role|organization|feature|audit|payroll|compensation|document|benefit|recruitment|offboarding|integration|notification)\./,
      );
    }
    expect(manager).toEqual(
      expect.arrayContaining(['employee.read', 'leave.approve']),
    );
    expect(manager.length).toBeLessThanOrEqual(10);
  });

  it('lets the scheduler read the organization structure but never override conflicts', () => {
    const scheduler = ROLE_TEMPLATES.find((t) => t.key === 'SCHEDULER')!;
    expect(scheduler.permissions).toContain('organization.read');
    expect(scheduler.permissions).not.toContain('schedule.override_conflict');
    expect(scheduler.permissions).not.toContain('organization.manage');
  });

  it('keeps the auditor template read-only', () => {
    for (const key of byKey('AUDITOR').permissions)
      expect(key, key).toMatch(/\.(read|view)$/);
    expect(byKey('AUDITOR').permissions).toEqual(
      expect.arrayContaining(['audit.read', 'report.read']),
    );
  });

  it('lets only the organization administrator manage roles, features and branding', () => {
    const administrative = [
      'role.manage',
      'role.assign',
      'feature.manage',
      'organization.manage',
      'organization.branding.manage',
    ];
    for (const template of ROLE_TEMPLATES) {
      if (template.key === 'ORGANIZATION_ADMINISTRATOR') continue;
      for (const key of administrative)
        expect(template.permissions, template.key).not.toContain(key);
    }
  });
});
