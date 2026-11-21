import { describe, expect, it } from 'vitest';
import { pageWidthFor } from './page-width';

describe('pageWidthFor (Batch 10F route skeleton widths)', () => {
  it.each([
    ['/notifications/preferences', 'narrow'],
    ['/account/security', 'narrow'],
    ['/admin/leave', 'full'],
    ['/admin/time', 'full'],
    ['/admin/scheduling', 'full'],
    ['/admin/scheduling/templates', 'full'],
    ['/dashboard', 'wide'],
    ['/admin/access-control/roles', 'wide'],
    ['/admin/access-control/roles/r1', 'wide'],
    ['/admin/access-control/assignments', 'wide'],
    ['/admin/audit', 'wide'],
    ['/admin/benefits', 'wide'],
    ['/admin/benefits/employees/e1', 'wide'],
    ['/admin/documents', 'wide'],
    ['/admin/employees', 'wide'],
    ['/admin/notifications', 'wide'],
    ['/admin/onboarding', 'wide'],
    ['/admin/payroll', 'wide'],
    ['/admin/payroll/runs/run-1', 'wide'],
    ['/admin/performance', 'wide'],
    ['/admin/recruitment', 'wide'],
    ['/admin/settings', 'wide'],
    ['/admin/settings/company', 'wide'],
    ['/admin/settings/branding', 'wide'],
    ['/admin/organizations/o1/departments', 'wide'],
    ['/leave', 'wide'],
    ['/time', 'wide'],
    ['/onboarding/workflows/w1', 'wide'],
    ['/reports', 'wide'],
    ['/reports/headcount', 'wide'],
    ['/settings/integrations/google', 'wide'],
    ['/admin', 'default'],
    ['/admin/organizations', 'default'],
    ['/admin/organizations/o1', 'default'],
    ['/admin/organizations/o1/physical-sites', 'default'],
    ['/admin/employees/new', 'default'],
    ['/admin/employees/e1', 'default'],
    ['/admin/compensation', 'default'],
    ['/benefits', 'default'],
    ['/compensation', 'default'],
    ['/documents', 'default'],
    ['/documents/records/d1', 'default'],
    ['/interviews', 'default'],
    ['/notifications', 'default'],
    ['/onboarding', 'default'],
    ['/pay', 'default'],
    ['/performance', 'default'],
    ['/performance/reviews/r1', 'default'],
    ['/profile', 'default'],
    ['/recruitment/applications/a1', 'default'],
    ['/recruitment/candidates/c1', 'default'],
    ['/schedule', 'default'],
  ] as const)('%s renders %s', (path, width) => {
    expect(pageWidthFor(path)).toBe(width);
  });

  it('ignores a query, a hash and a trailing slash', () => {
    expect(pageWidthFor('/admin/time?tab=exceptions')).toBe('full');
    expect(pageWidthFor('/leave#calendar')).toBe('wide');
    expect(pageWidthFor('/admin/audit/')).toBe('wide');
  });

  it('does not match a path that only shares a prefix', () => {
    expect(pageWidthFor('/leaves')).toBe('default');
    expect(pageWidthFor('/timeline')).toBe('default');
  });

  it('falls back to the default width without a path', () => {
    expect(pageWidthFor(null)).toBe('default');
    expect(pageWidthFor(undefined)).toBe('default');
    expect(pageWidthFor('')).toBe('default');
  });
});
