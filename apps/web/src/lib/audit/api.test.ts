import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthApiError } from '../auth/types';
import { auditApi, auditQueryString } from './api';
import { AUDIT_ERROR_MESSAGES, auditErrorCode, auditErrorMessage } from './errors';

const apiRequest = vi.hoisted(() => vi.fn());

vi.mock('../auth/api-client', () => ({ apiRequest }));

beforeEach(() => {
  apiRequest.mockClear();
  apiRequest.mockResolvedValue({ items: [], nextCursor: null, range: { from: 'a', to: 'b' } });
});

describe('auditApi', () => {
  it('sends only the organization by default', async () => {
    await auditApi.list({ organizationId: 'org-1' });
    expect(apiRequest).toHaveBeenCalledWith('/audit?organizationId=org-1');
  });

  it('asks for the System view without an organization (Batch 2)', async () => {
    await auditApi.list({ organizationId: 'system', action: 'AUTH_LOGIN_FAILED' });
    expect(apiRequest).toHaveBeenCalledWith('/audit?scope=system&action=AUTH_LOGIN_FAILED');
  });

  it('maps every filter, the limit and the cursor (trimmed, empty values dropped)', async () => {
    await auditApi.list({
      organizationId: 'org 1',
      from: '2026-09-01T00:00:00.000Z',
      to: '2026-10-01T00:00:00.000Z',
      action: ' EMPLOYEE_CREATED ',
      entityType: 'Employee',
      entityId: '',
      actorUserId: '7b0c2f1e-7a5f-4c55-8f0e-3d9f3c1b2a10',
      limit: 50,
      cursor: 'abc_-',
    });
    expect(apiRequest).toHaveBeenCalledWith(
      '/audit?organizationId=org+1&from=2026-09-01T00%3A00%3A00.000Z&to=2026-10-01T00%3A00%3A00.000Z&action=EMPLOYEE_CREATED&entityType=Employee&actorUserId=7b0c2f1e-7a5f-4c55-8f0e-3d9f3c1b2a10&limit=50&cursor=abc_-',
    );
    expect(auditQueryString({ organizationId: 'o', cursor: null })).toBe('organizationId=o');
  });

  it('propagates API errors', async () => {
    apiRequest.mockRejectedValueOnce(new AuthApiError('forbidden', 403));
    await expect(auditApi.list({ organizationId: 'org-1' })).rejects.toMatchObject({
      status: 403,
    });
  });
});

describe('auditApi.actors (Batch R3.3)', () => {
  it('sends the organization, the window, the search and the cursor', async () => {
    apiRequest.mockResolvedValueOnce({ items: [], nextAfterId: null });
    await auditApi.actors({
      organizationId: 'org-1',
      from: '2026-09-01T00:00:00.000Z',
      query: ' ada ',
      afterId: '7b0c2f1e-7a5f-4c55-8f0e-3d9f3c1b2a10',
      limit: 20,
    });
    expect(apiRequest).toHaveBeenCalledWith(
      '/audit/actors?organizationId=org-1&from=2026-09-01T00%3A00%3A00.000Z&query=ada&afterId=7b0c2f1e-7a5f-4c55-8f0e-3d9f3c1b2a10&limit=20',
    );
  });

  it('uses the System view without an organization', async () => {
    apiRequest.mockResolvedValueOnce({ items: [], nextAfterId: null });
    await auditApi.actors({ organizationId: 'system', afterId: null });
    expect(apiRequest).toHaveBeenCalledWith('/audit/actors?scope=system');
  });
});

describe('auditErrorMessage', () => {
  const err = (status: number, code?: string) =>
    new AuthApiError('validation', status, undefined, code ? { code } : undefined);

  it('maps the domain codes', () => {
    expect(auditErrorCode(err(400, 'AUDIT_RANGE_TOO_WIDE'))).toBe('AUDIT_RANGE_TOO_WIDE');
    expect(auditErrorCode(new Error('x'))).toBeNull();
    for (const code of ['AUDIT_RANGE_INVALID', 'AUDIT_RANGE_TOO_WIDE', 'AUDIT_CURSOR_INVALID']) {
      expect(auditErrorMessage(err(400, code))).toBe(AUDIT_ERROR_MESSAGES[code]);
    }
    expect(auditErrorMessage(err(400, 'AUDIT_RANGE_TOO_WIDE'))).toMatch(/366 days/);
  });

  it('falls back by status', () => {
    expect(auditErrorMessage(new AuthApiError('forbidden', 403))).toMatch(/permission/);
    expect(auditErrorMessage(new AuthApiError('unexpected', 404))).toMatch(/not found/);
    expect(auditErrorMessage(new AuthApiError('unauthenticated', 401))).toMatch(/expired/);
    expect(auditErrorMessage(err(400))).toMatch(/Check the filters/);
    expect(auditErrorMessage(new AuthApiError('service-unavailable', 503))).toMatch(/unavailable/);
    expect(
      auditErrorMessage(new AuthApiError('rate-limited', 429, undefined, { code: 'RATE_LIMITED' })),
    ).toBe('Too many attempts — please wait and try again.');
    expect(auditErrorMessage(new Error('x'), 'Fallback.')).toBe('Fallback.');
  });
});
