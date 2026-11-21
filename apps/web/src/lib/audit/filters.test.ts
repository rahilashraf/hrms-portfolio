import { describe, expect, it } from 'vitest';
import {
  auditFilterQuery,
  auditMetadataText,
  auditOrganizationOptions,
  auditReadScopes,
  EMPTY_AUDIT_FILTERS,
  localDayStart,
} from './filters';

const form = (overrides: Partial<typeof EMPTY_AUDIT_FILTERS>) => ({
  ...EMPTY_AUDIT_FILTERS,
  ...overrides,
});

describe('auditFilterQuery', () => {
  it('sends nothing for an empty form (the API defaults to the last 30 days)', () => {
    expect(auditFilterQuery(EMPTY_AUDIT_FILTERS)).toEqual({ ok: true, query: {} });
  });

  it('turns local dates into an exclusive [from, to) range', () => {
    const result = auditFilterQuery(form({ fromDate: '2026-09-01', toDate: '2026-09-30' }));
    expect(result).toEqual({
      ok: true,
      query: {
        from: new Date(2026, 8, 1).toISOString(),
        to: new Date(2026, 9, 1).toISOString(),
      },
    });
    // A single day is a valid range.
    expect(auditFilterQuery(form({ fromDate: '2026-09-01', toDate: '2026-09-01' })).ok).toBe(true);
  });

  it('rejects invalid and reversed or too wide ranges', () => {
    expect(auditFilterQuery(form({ fromDate: '2026-02-30' }))).toEqual({
      ok: false,
      problem: 'Enter a valid start date.',
    });
    expect(auditFilterQuery(form({ toDate: 'soon' }))).toEqual({
      ok: false,
      problem: 'Enter a valid end date.',
    });
    expect(auditFilterQuery(form({ fromDate: '2026-09-02', toDate: '2026-09-01' }))).toEqual({
      ok: false,
      problem: 'The start date must be on or before the end date.',
    });
    expect(auditFilterQuery(form({ fromDate: '2025-01-01', toDate: '2026-01-01' })).ok).toBe(true);
    expect(auditFilterQuery(form({ fromDate: '2025-01-01', toDate: '2026-01-03' }))).toEqual({
      ok: false,
      problem: 'The date range may cover at most 366 days.',
    });
  });

  it('checks the code filters like the API does', () => {
    expect(
      auditFilterQuery(
        form({
          action: ' EMPLOYEE_CREATED ',
          entityType: 'Employee',
          entityId: 'abc:1-2.3_4',
          actorUserId: '7B0C2F1E-7A5F-4C55-8F0E-3D9F3C1B2A10',
        }),
      ),
    ).toEqual({
      ok: true,
      query: {
        action: 'EMPLOYEE_CREATED',
        entityType: 'Employee',
        entityId: 'abc:1-2.3_4',
        actorUserId: '7B0C2F1E-7A5F-4C55-8F0E-3D9F3C1B2A10',
      },
    });
    expect(auditFilterQuery(form({ action: 'employee created' })).ok).toBe(false);
    expect(auditFilterQuery(form({ action: '1ABC' })).ok).toBe(false);
    expect(auditFilterQuery(form({ entityType: 'Employee_Record' })).ok).toBe(false);
    expect(auditFilterQuery(form({ entityId: 'a/b' })).ok).toBe(false);
    expect(auditFilterQuery(form({ entityId: 'x'.repeat(101) })).ok).toBe(false);
    expect(auditFilterQuery(form({ actorUserId: 'user-1' }))).toEqual({
      ok: false,
      problem: 'The actor user id must be a UUID.',
    });
  });

  it('parses local days strictly', () => {
    expect(localDayStart('2026-10-06')?.getDate()).toBe(6);
    expect(localDayStart('2026-12-31', 1)?.getFullYear()).toBe(2027);
    expect(localDayStart('2026-13-01')).toBeNull();
    expect(localDayStart('06/10/2026')).toBeNull();
  });
});

describe('audit organizations', () => {
  const snapshot = (scopes: Array<{ type: string; id?: string }>, key = 'audit.read') =>
    ({ userId: 'u', permissions: [{ key, scopes }] }) as never;
  const organizations = [
    { id: 'org-b', name: 'Beta' },
    { id: 'org-a', name: 'Alpha' },
  ];

  it('uses organization-scope (and SYSTEM) audit.read grants only', () => {
    expect(
      auditReadScopes(
        snapshot([
          { type: 'ORGANIZATION', id: 'org-a' },
          { type: 'ORGANIZATION', id: 'org-a' },
          { type: 'TEAM', id: 'team-1' },
          { type: 'DEPARTMENT', id: 'dep-1' },
        ]),
      ),
    ).toEqual({ all: false, organizationIds: ['org-a'] });
    expect(auditReadScopes(snapshot([{ type: 'SYSTEM' }]))).toEqual({
      all: true,
      organizationIds: [],
    });
    expect(auditReadScopes(snapshot([{ type: 'SYSTEM' }], 'audit.export'))).toEqual({
      all: false,
      organizationIds: [],
    });
    expect(auditReadScopes(null)).toEqual({ all: false, organizationIds: [] });
  });

  it('names the organizations, falling back to the id', () => {
    expect(
      auditOrganizationOptions(snapshot([{ type: 'ORGANIZATION', id: 'org-b' }]), organizations),
    ).toEqual([{ id: 'org-b', name: 'Beta' }]);
    expect(auditOrganizationOptions(snapshot([{ type: 'ORGANIZATION', id: 'org-z' }]), [])).toEqual(
      [{ id: 'org-z', name: 'org-z' }],
    );
    expect(auditOrganizationOptions(snapshot([{ type: 'SYSTEM' }]), organizations)).toEqual([
      { id: 'org-a', name: 'Alpha' },
      { id: 'org-b', name: 'Beta' },
      // Batch 2: System-scope readers also get the System view.
      { id: 'system', name: 'System (no organization)' },
    ]);
    expect(
      auditOrganizationOptions(snapshot([{ type: 'TEAM', id: 'team-1' }]), organizations),
    ).toEqual([]);
  });

  it('renders metadata values as text', () => {
    expect(auditMetadataText(['a', 1, true])).toBe('a, 1, true');
    expect(auditMetadataText(false)).toBe('false');
    expect(auditMetadataText(3)).toBe('3');
    expect(auditMetadataText('<b>x</b>')).toBe('<b>x</b>');
  });
});
