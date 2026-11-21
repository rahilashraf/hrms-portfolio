import { describe, expect, it } from 'vitest';
import { linkedAuditFilters } from './audit-log-page';

describe('linkedAuditFilters', () => {
  it('reads the record a link points at, and nothing else', () => {
    expect(
      linkedAuditFilters('?organizationId=org-1&entityType=ScheduledShift&entityId=shift-1&x=1'),
    ).toEqual({ organizationId: 'org-1', entityType: 'ScheduledShift', entityId: 'shift-1' });
    expect(linkedAuditFilters('')).toEqual({ organizationId: '', entityType: '', entityId: '' });
  });
});
