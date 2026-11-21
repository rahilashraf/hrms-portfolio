import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthApiError } from '../auth/types';
import { compensationApi } from './api';
import { compensationErrorMessage, isCompensationForbidden } from './errors';

const apiRequest = vi.hoisted(() => vi.fn());

vi.mock('../auth/api-client', () => ({ apiRequest }));

beforeEach(() => {
  apiRequest.mockClear();
  apiRequest.mockResolvedValue({});
});

describe('compensationApi', () => {
  it('maps read routes', async () => {
    await compensationApi.me();
    await compensationApi.employee('employee/1');
    await compensationApi.history('assignment-1');
    await compensationApi.asOf('assignment-1', '2026-07-01');
    expect(apiRequest.mock.calls.map((call) => call[0])).toEqual([
      '/compensation/me',
      '/compensation/employees/employee%2F1',
      '/employment-assignments/assignment-1/compensation',
      '/employment-assignments/assignment-1/compensation/as-of?date=2026-07-01',
    ]);
  });

  it('maps write routes with string amounts and no DELETE', async () => {
    const values = { payBasis: 'HOURLY' as const, rateAmount: '24.50', currency: 'CAD' };
    await compensationApi.create('a1', { ...values, effectiveFrom: '2026-01-01' });
    await compensationApi.change('a1', { ...values, effectiveFrom: '2026-07-01', reason: 'Raise' });
    await compensationApi.correct('a1', 'r/1', { rateAmount: '24.75', reason: 'Typo' });
    await compensationApi.end('a1', 'r1', { effectiveTo: '2026-12-31' });
    expect(apiRequest).toHaveBeenNthCalledWith(1, '/employment-assignments/a1/compensation', {
      method: 'POST',
      body: JSON.stringify({ ...values, effectiveFrom: '2026-01-01' }),
    });
    expect(apiRequest).toHaveBeenNthCalledWith(
      2,
      '/employment-assignments/a1/compensation/change',
      {
        method: 'POST',
        body: JSON.stringify({ ...values, effectiveFrom: '2026-07-01', reason: 'Raise' }),
      },
    );
    expect(apiRequest).toHaveBeenNthCalledWith(
      3,
      '/employment-assignments/a1/compensation/r%2F1/correction',
      { method: 'PATCH', body: JSON.stringify({ rateAmount: '24.75', reason: 'Typo' }) },
    );
    expect(apiRequest).toHaveBeenNthCalledWith(
      4,
      '/employment-assignments/a1/compensation/r1/end',
      {
        method: 'POST',
        body: JSON.stringify({ effectiveTo: '2026-12-31' }),
      },
    );
    expect(apiRequest.mock.calls.some((call) => call[1]?.method === 'DELETE')).toBe(false);
  });

  it('maps pay-group routes', async () => {
    await compensationApi.payGroupOrganizations();
    await compensationApi.payGroups('org-1');
    await compensationApi.payGroups('org-1', true);
    await compensationApi.createPayGroup({ organizationId: 'org-1', code: 'BW', name: 'Biweekly' });
    await compensationApi.updatePayGroup('g1', { name: 'Bi-weekly' });
    await compensationApi.archivePayGroup('g1');
    expect(apiRequest.mock.calls.map((call) => [call[0], call[1]?.method ?? 'GET'])).toEqual([
      ['/pay-groups/organizations', 'GET'],
      ['/pay-groups?organizationId=org-1', 'GET'],
      ['/pay-groups?organizationId=org-1&includeArchived=true', 'GET'],
      ['/pay-groups', 'POST'],
      ['/pay-groups/g1', 'PATCH'],
      ['/pay-groups/g1/archive', 'POST'],
    ]);
  });
});

describe('compensation errors', () => {
  it('surfaces server messages for validation and conflicts', () => {
    expect(
      compensationErrorMessage(new AuthApiError('conflict', 409, 'Compensation periods overlap.')),
    ).toBe('Compensation periods overlap.');
    expect(compensationErrorMessage(new AuthApiError('validation', 400))).toBe(
      'Check the compensation details and try again.',
    );
    expect(isCompensationForbidden(new AuthApiError('forbidden', 403))).toBe(true);
    expect(compensationErrorMessage(new Error('x'), 'fallback')).toBe('fallback');
  });
});
