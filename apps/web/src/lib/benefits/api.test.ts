import { beforeEach, describe, expect, it, vi } from 'vitest';
import { benefitsApi } from './api';
import { benefitOptionSource } from './pickers';

const apiRequest = vi.hoisted(() => vi.fn());

vi.mock('../auth/api-client', () => ({ apiRequest }));

beforeEach(() => {
  apiRequest.mockClear();
  apiRequest.mockResolvedValue({ items: [], nextAfterId: null });
});

const calls = () =>
  apiRequest.mock.calls.map((call) => [
    call[0],
    call[1]?.method ?? 'GET',
    call[1]?.body ? JSON.parse(call[1].body as string) : undefined,
  ]);

describe('benefitsApi (Batch 7C)', () => {
  it('maps plan, option, rate and rule edits', async () => {
    await benefitsApi.updatePlan('p/1', { name: 'Health', providerReference: 'GRP-1' });
    await benefitsApi.updateOption('o1', { name: 'Employee only' });
    await benefitsApi.correctRate('r1', { employeeAmount: '26', reason: 'Carrier invoice' });
    await benefitsApi.addRule('p1', {
      effectiveFrom: '2026-01-01',
      departmentId: 'd1',
      organizationalUnitId: 'u1',
      includeSubunits: false,
    });
    await benefitsApi.endRule('rule1', '2026-12-31');
    await benefitsApi.plans('org1', true);
    expect(calls()).toEqual([
      ['/benefits/plans/p%2F1', 'PATCH', { name: 'Health', providerReference: 'GRP-1' }],
      ['/benefits/options/o1', 'PATCH', { name: 'Employee only' }],
      ['/benefits/rates/r1/correct', 'POST', { employeeAmount: '26', reason: 'Carrier invoice' }],
      [
        '/benefits/plans/p1/eligibility-rules',
        'POST',
        {
          effectiveFrom: '2026-01-01',
          departmentId: 'd1',
          organizationalUnitId: 'u1',
          includeSubunits: false,
        },
      ],
      ['/benefits/eligibility-rules/rule1/end', 'POST', { effectiveTo: '2026-12-31' }],
      ['/benefits/plans?organizationId=org1&includeArchived=true', 'GET', undefined],
    ]);
  });

  it('maps elections: change, transfer, correct, with fresh override reasons', async () => {
    await benefitsApi.change('e1', {
      effectiveDate: '2026-06-01',
      optionId: 'o1',
      dependentIds: [],
      reason: 'Divorce',
      eligibilityOverrideReason: 'Committee',
    });
    await benefitsApi.transfer('e1', {
      employmentAssignmentId: 'a2',
      effectiveDate: '2026-06-01',
      eligibilityOverrideReason: 'Committee',
    });
    await benefitsApi.correct('e1', { reason: 'Wrong start', coverageStart: '2026-02-02' });
    await benefitsApi.employee('emp1', '2026-06-30');
    expect(calls()).toEqual([
      [
        '/benefits/elections/e1/change',
        'POST',
        {
          effectiveDate: '2026-06-01',
          optionId: 'o1',
          dependentIds: [],
          reason: 'Divorce',
          eligibilityOverrideReason: 'Committee',
        },
      ],
      [
        '/benefits/elections/e1/transfer',
        'POST',
        {
          employmentAssignmentId: 'a2',
          effectiveDate: '2026-06-01',
          eligibilityOverrideReason: 'Committee',
        },
      ],
      [
        '/benefits/elections/e1/correct',
        'POST',
        { reason: 'Wrong start', coverageStart: '2026-02-02' },
      ],
      ['/benefits/employees/emp1/elections?asOf=2026-06-30', 'GET', undefined],
    ]);
  });

  it('maps dependents with relationship dates and the archived list', async () => {
    await benefitsApi.addDependent('emp1', {
      firstName: 'Sam',
      lastName: 'Spouse',
      relationship: 'SPOUSE',
      relationshipStartDate: '2015-06-01',
    });
    await benefitsApi.updateDependent('d1', { relationshipEndDate: '2026-05-31' });
    await benefitsApi.dependents('emp1', true);
    await benefitsApi.dependents('emp1');
    expect(calls()).toEqual([
      [
        '/benefits/employees/emp1/dependents',
        'POST',
        {
          firstName: 'Sam',
          lastName: 'Spouse',
          relationship: 'SPOUSE',
          relationshipStartDate: '2015-06-01',
        },
      ],
      ['/benefits/dependents/d1', 'PATCH', { relationshipEndDate: '2026-05-31' }],
      ['/benefits/employees/emp1/dependents?includeArchived=true', 'GET', undefined],
      ['/benefits/employees/emp1/dependents', 'GET', undefined],
    ]);
  });

  it('pages module-scoped picker options', async () => {
    apiRequest.mockResolvedValueOnce({
      items: [{ id: 'a1', label: 'Ada Lovelace', employeeId: 'e1' }],
      nextAfterId: 'a1',
    });
    const page = await benefitOptionSource('o1', 'assignment', { employeeId: 'e1' }).search(
      'Ada',
      'a0',
    );
    expect(page).toEqual({
      items: [{ id: 'a1', label: 'Ada Lovelace', employeeId: 'e1' }],
      next: 'a1',
    });
    expect(calls()).toEqual([
      [
        '/benefits/options?organizationId=o1&kind=assignment&search=Ada&employeeId=e1&limit=20&afterId=a0',
        'GET',
        undefined,
      ],
    ]);
  });
});
