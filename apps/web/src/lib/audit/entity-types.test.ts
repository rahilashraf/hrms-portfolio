import { describe, expect, it } from 'vitest';
import { AUDIT_ENTITY_TYPES, auditEntityTypeLabel } from './entity-types';

describe('audit entity types (Batch R3.3)', () => {
  it('reads codes as words', () => {
    expect(auditEntityTypeLabel('Employee')).toBe('Employee');
    expect(auditEntityTypeLabel('BenefitCoverageOption')).toBe('Benefit coverage option');
    expect(auditEntityTypeLabel('AuthSession')).toBe('Sign-in session');
    expect(auditEntityTypeLabel('PayrollRun')).toBe('Payroll run');
  });

  it('lists each code once, each a valid filter value', () => {
    expect(new Set(AUDIT_ENTITY_TYPES).size).toBe(AUDIT_ENTITY_TYPES.length);
    for (const type of AUDIT_ENTITY_TYPES) expect(type).toMatch(/^[A-Za-z][A-Za-z0-9]*$/);
  });
});
