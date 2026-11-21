import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthApiError } from '../auth/types';
import { leaveApi } from './api';
import { leaveErrorMessage } from './errors';

const apiRequest = vi.hoisted(() => vi.fn());

vi.mock('../auth/api-client', () => ({ apiRequest }));

beforeEach(() => {
  apiRequest.mockClear();
  apiRequest.mockResolvedValue({});
});

describe('leaveApi', () => {
  it('maps employee self-service routes', async () => {
    const input = {
      employmentAssignmentId: 'assignment-1',
      leaveTypeId: 'type-1',
      startDate: '2027-03-08',
      endDate: '2027-03-09',
    };
    await leaveApi.me();
    await leaveApi.myRequests({ status: 'PENDING', limit: 20 });
    await leaveApi.previewOwn(input);
    await leaveApi.submitOwn(input);
    await leaveApi.cancelOwn('request/1', 'Plans changed');
    await leaveApi.myLedger('account/1');

    expect(apiRequest).toHaveBeenNthCalledWith(1, '/leave/me');
    expect(apiRequest).toHaveBeenNthCalledWith(2, '/leave/me/requests?status=PENDING&limit=20');
    expect(apiRequest).toHaveBeenNthCalledWith(3, '/leave/me/requests/preview', {
      method: 'POST',
      body: JSON.stringify(input),
    });
    expect(apiRequest).toHaveBeenNthCalledWith(4, '/leave/me/requests', {
      method: 'POST',
      body: JSON.stringify(input),
    });
    expect(apiRequest).toHaveBeenNthCalledWith(5, '/leave/me/requests/request%2F1/cancel', {
      method: 'POST',
      body: JSON.stringify({ reason: 'Plans changed' }),
    });
    expect(apiRequest).toHaveBeenNthCalledWith(6, '/leave/me/accounts/account%2F1/ledger');
  });

  it('maps management, configuration and holiday routes', async () => {
    await leaveApi.queue({ organizationId: 'org-1', status: 'PENDING' });
    await leaveApi.approve('request-1', {
      note: 'OK',
      dayOverrides: [{ date: '2027-03-08', minutes: 240, reason: 'Half day' }],
    });
    await leaveApi.reject('request-1');
    await leaveApi.amend('request-1', { reason: 'Back early', cancelFrom: '2027-03-09' });
    await leaveApi.balances({ organizationId: 'org-1', asOf: '2027-01-01' });
    await leaveApi.adjust({
      employmentAssignmentId: 'a',
      leaveTypeId: 't',
      amountMinutes: 60,
      effectiveDate: '2027-01-01',
      reason: 'Fix',
    });
    await leaveApi.reverse('entry-1', 'Posted twice');
    await leaveApi.calendar({
      organizationId: 'org-1',
      from: '2027-03-01',
      to: '2027-03-31',
      includePending: true,
    });
    await leaveApi.types('org-1');
    await leaveApi.endPolicy('policy-1', '2027-12-31');
    await leaveApi.deletePolicy('policy-1');
    await leaveApi.holidays({ organizationId: 'org-1', from: '2027-01-01', to: '2027-12-31' });
    await leaveApi.archiveHoliday('holiday-1');

    const calls = apiRequest.mock.calls;
    expect(calls[0]).toEqual(['/leave/requests?organizationId=org-1&status=PENDING']);
    expect(calls[1]).toEqual([
      '/leave/requests/request-1/approve',
      {
        method: 'POST',
        body: JSON.stringify({
          note: 'OK',
          dayOverrides: [{ date: '2027-03-08', minutes: 240, reason: 'Half day' }],
        }),
      },
    ]);
    expect(calls[2]).toEqual(['/leave/requests/request-1/reject', { method: 'POST', body: '{}' }]);
    expect(calls[3]![0]).toBe('/leave/requests/request-1/amend');
    expect(calls[4]).toEqual(['/leave/balances?organizationId=org-1&asOf=2027-01-01']);
    expect(calls[5]![0]).toBe('/leave/adjustments');
    expect(calls[6]).toEqual([
      '/leave/ledger-entries/entry-1/reverse',
      { method: 'POST', body: JSON.stringify({ reason: 'Posted twice' }) },
    ]);
    expect(calls[7]).toEqual([
      '/leave/calendar?organizationId=org-1&from=2027-03-01&to=2027-03-31&includePending=true',
    ]);
    expect(calls[8]).toEqual(['/leave/types?organizationId=org-1']);
    expect(calls[9]).toEqual([
      '/leave/policies/policy-1/end',
      { method: 'POST', body: JSON.stringify({ effectiveTo: '2027-12-31' }) },
    ]);
    expect(calls[10]).toEqual(['/leave/policies/policy-1', { method: 'DELETE' }]);
    expect(calls[11]).toEqual(['/holidays?organizationId=org-1&from=2027-01-01&to=2027-12-31']);
    expect(calls[12]).toEqual(['/holidays/holiday-1/archive', { method: 'POST' }]);
  });
});

describe('leaveErrorMessage', () => {
  it('surfaces the server message for domain conflicts and validation', () => {
    expect(
      leaveErrorMessage(
        new AuthApiError(
          'conflict',
          409,
          'The leave exceeds the available balance allowed by the policy.',
        ),
      ),
    ).toBe('The leave exceeds the available balance allowed by the policy.');
    expect(leaveErrorMessage(new AuthApiError('validation', 400))).toBe(
      'Check the leave details and try again.',
    );
    expect(leaveErrorMessage(new AuthApiError('forbidden', 403))).toBe(
      'You do not have permission for this leave action.',
    );
    expect(leaveErrorMessage(new Error('boom'), 'Fallback')).toBe('Fallback');
  });
});
