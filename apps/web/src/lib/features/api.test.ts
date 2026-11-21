import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthApiError } from '../auth/types';
import { featuresApi } from './api';

const apiRequest = vi.hoisted(() => vi.fn());

vi.mock('../auth/api-client', () => ({ apiRequest }));

beforeEach(() => {
  apiRequest.mockClear();
  apiRequest.mockResolvedValue({});
});

const calls = () =>
  apiRequest.mock.calls.map((call) => [call[0], call[1]?.method ?? 'GET', call[1]?.body]);

describe('featuresApi', () => {
  it('maps the read routes', async () => {
    await featuresApi.organizations();
    await featuresApi.overview('org 1');
    await featuresApi.history('org-1');
    await featuresApi.history('org-1', { limit: 20, before: '2026-10-06T10:00:00.000Z' });
    await featuresApi.history('org-1', { before: null });
    expect(calls()).toEqual([
      ['/admin/features/organizations', 'GET', undefined],
      ['/admin/features?organizationId=org+1', 'GET', undefined],
      ['/admin/features/history?organizationId=org-1', 'GET', undefined],
      [
        '/admin/features/history?organizationId=org-1&limit=20&before=2026-10-06T10%3A00%3A00.000Z',
        'GET',
        undefined,
      ],
      ['/admin/features/history?organizationId=org-1', 'GET', undefined],
    ]);
  });

  it('maps the change routes with their optimistic-concurrency version', async () => {
    await featuresApi.setModule('PAYROLL', {
      organizationId: 'org-1',
      enabled: false,
      expectedVersion: 0,
    });
    await featuresApi.setSetting('documents.selfServiceProvide', {
      organizationId: 'org-1',
      value: false,
      expectedVersion: 2,
    });
    await featuresApi.resetSetting('a/b', { organizationId: 'org-1', expectedVersion: 3 });
    expect(calls()).toEqual([
      [
        '/admin/features/modules/PAYROLL',
        'PUT',
        JSON.stringify({ organizationId: 'org-1', enabled: false, expectedVersion: 0 }),
      ],
      [
        '/admin/features/settings/documents.selfServiceProvide',
        'PUT',
        JSON.stringify({ organizationId: 'org-1', value: false, expectedVersion: 2 }),
      ],
      [
        '/admin/features/settings/a%2Fb/reset',
        'POST',
        JSON.stringify({ organizationId: 'org-1', expectedVersion: 3 }),
      ],
    ]);
  });

  it('propagates API errors', async () => {
    apiRequest.mockRejectedValueOnce(new AuthApiError('forbidden', 403));
    await expect(featuresApi.organizations()).rejects.toMatchObject({ status: 403 });
  });
});
