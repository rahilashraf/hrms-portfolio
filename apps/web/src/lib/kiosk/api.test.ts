import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { kioskApi, KioskApiError } from './api';

vi.mock('../api-config', () => ({ getApiBaseUrl: () => 'https://api.test' }));

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('kioskApi', () => {
  it('sends device-cookie requests only, never a user token', async () => {
    fetchMock.mockResolvedValue(json(200, { token: 't', actions: [] }));

    await kioskApi.identify('E-1', '123456');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.test/kiosk/identify');
    expect(init).toMatchObject({ method: 'POST', credentials: 'include', cache: 'no-store' });
    expect(init.headers).not.toHaveProperty('Authorization');
    expect(JSON.parse(String(init.body))).toEqual({ employeeNumber: 'E-1', pin: '123456' });
  });

  it('maps routes for session, enrollment, actions and cancel', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(json(200, {})));

    await kioskApi.session();
    await kioskApi.enroll('ABCD-EFGH');
    await kioskApi.act({
      token: 't',
      action: 'SIGN_IN',
      employmentAssignmentId: 'a',
      idempotencyKey: 'k',
    });
    await kioskApi.cancel('t');

    const calls = fetchMock.mock.calls as Array<[string, RequestInit]>;
    expect(calls.map(([url, init]) => `${init.method} ${url}`)).toEqual([
      'GET https://api.test/kiosk/session',
      'POST https://api.test/kiosk/enroll',
      'POST https://api.test/kiosk/actions',
      'POST https://api.test/kiosk/cancel',
    ]);
    expect(calls.some(([url]) => url.includes('/auth/'))).toBe(false);
  });

  it('surfaces the server code and message, and maps network failures to offline', async () => {
    fetchMock.mockResolvedValueOnce(
      json(401, {
        code: 'KIOSK_DEVICE_UNAUTHENTICATED',
        message: 'This device is not an enrolled kiosk.',
      }),
    );
    const unauthenticated = await kioskApi.session().catch((error: unknown) => error);
    expect(unauthenticated).toBeInstanceOf(KioskApiError);
    expect(unauthenticated).toMatchObject({ status: 401, code: 'KIOSK_DEVICE_UNAUTHENTICATED' });

    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const offline = await kioskApi.session().catch((error: unknown) => error);
    expect(offline).toMatchObject({ status: 0, code: 'KIOSK_OFFLINE' });
  });
});
