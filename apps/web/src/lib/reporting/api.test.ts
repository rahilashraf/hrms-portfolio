import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthApiError } from '../auth/types';
import { csvFileName, reportingApi, saveBlob } from './api';

const apiRequest = vi.hoisted(() => vi.fn());
const refreshAccessToken = vi.hoisted(() => vi.fn());

vi.mock('../auth/api-client', () => ({ apiRequest, refreshAccessToken }));

const ORG = '11111111-1111-4111-8111-111111111111';
const DEPT = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  apiRequest.mockReset();
  apiRequest.mockResolvedValue({});
  refreshAccessToken.mockReset();
  refreshAccessToken.mockResolvedValue('fresh-token');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * Reads a downloaded Blob as text. Under Node 24 the jsdom environment's `Response.blob()`
 * returns jsdom's Blob, which has no `text()`; FileReader reads it in every runtime.
 */
function blobText(blob: Blob): Promise<string> {
  if (typeof blob.text === 'function') return blob.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

const calls = () =>
  apiRequest.mock.calls.map((call) => [call[0], call[1]?.method ?? 'GET', call[1]?.body]);

describe('reportingApi', () => {
  it('maps the organizations, catalog, run and Google Sheets routes', async () => {
    await reportingApi.organizations();
    await reportingApi.catalog(ORG);
    await reportingApi.run('workforce.distribution', ORG, {
      groupBy: 'team',
      asOf: '2026-10-06',
      departmentId: DEPT,
      teamId: '',
    });
    await reportingApi.run('time.hours', ORG, {});
    await reportingApi.exportGoogleSheets('payroll.by_group', ORG, {
      from: '2026-01-01',
      to: '2026-06-30',
      employmentType: 'FULL_TIME',
    });
    expect(calls()).toEqual([
      ['/reports/organizations', 'GET', undefined],
      [`/reports/catalog?organizationId=${ORG}`, 'GET', undefined],
      [
        `/reports/workforce.distribution?organizationId=${ORG}&asOf=2026-10-06&departmentId=${DEPT}&groupBy=team`,
        'GET',
        undefined,
      ],
      [`/reports/time.hours?organizationId=${ORG}`, 'GET', undefined],
      [
        '/reports/payroll.by_group/export/google-sheets',
        'POST',
        JSON.stringify({
          organizationId: ORG,
          from: '2026-01-01',
          to: '2026-06-30',
          employmentType: 'FULL_TIME',
        }),
      ],
    ]);
  });

  it('encodes the report key in the path', async () => {
    await reportingApi.run('a/b?c', ORG, {});
    expect(apiRequest.mock.calls[0]![0]).toBe(`/reports/a%2Fb%3Fc?organizationId=${ORG}`);
  });

  it('downloads the CSV with a current access token and the Content-Disposition name', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('Group,Employees\r\nSales,12\r\n', {
        status: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="workforce.distribution-2026-10-06.csv"',
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const file = await reportingApi.exportCsv('workforce.distribution', ORG, { groupBy: 'team' });
    expect(refreshAccessToken).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      `http://127.0.0.1:3001/reports/workforce.distribution/export.csv?organizationId=${ORG}&groupBy=team`,
      { headers: { Accept: 'text/csv', Authorization: 'Bearer fresh-token' } },
    );
    expect(file.fileName).toBe('workforce.distribution-2026-10-06.csv');
    expect(await blobText(file.blob)).toBe('Group,Employees\r\nSales,12\r\n');
    expect(file.truncated).toBe(false);
  });

  it('reads X-Report-Truncated from the CSV export (Batch 4F, Q9)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('Group\r\nTRUNCATED: capped\r\n', {
          status: 200,
          headers: { 'Content-Type': 'text/csv', 'X-Report-Truncated': 'true' },
        }),
      ),
    );
    const file = await reportingApi.exportCsv('time.sign-ins', ORG, {});
    expect(file.truncated).toBe(true);
  });

  it('reads the error body of every failed CSV export', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ statusCode: 404, code: 'REPORT_FILTER_NOT_FOUND', message: 'x' }),
            { status: 404, headers: { 'Content-Type': 'application/json' } },
          ),
        ),
    );
    const error = await reportingApi.exportCsv('time.hours', ORG, {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AuthApiError);
    expect((error as AuthApiError).status).toBe(404);
    expect((error as AuthApiError).details?.code).toBe('REPORT_FILTER_NOT_FOUND');
  });

  it('refuses the CSV export when no session can be refreshed', async () => {
    refreshAccessToken.mockResolvedValue(null);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const error = await reportingApi.exportCsv('time.hours', ORG, {}).catch((e: unknown) => e);
    expect((error as AuthApiError).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('csvFileName', () => {
  const today = new Date('2026-10-06T12:00:00Z');
  it('uses a safe Content-Disposition name', () => {
    expect(
      csvFileName('attachment; filename="time.hours-2026-10-06.csv"', 'time.hours', today),
    ).toBe('time.hours-2026-10-06.csv');
    expect(csvFileName('attachment; filename="x y.csv"', 'time.hours', today)).toBe('x-y.csv');
    expect(csvFileName('attachment; filename="../../etc/x.csv"', 'time.hours', today)).toBe(
      'time-hours-2026-10-06.csv',
    );
  });
  it("falls back to the API's own pattern when the header is unreadable", () => {
    expect(csvFileName(null, 'workforce.distribution', today)).toBe(
      'workforce-distribution-2026-10-06.csv',
    );
    expect(csvFileName('attachment; filename="evil.exe"', 'leave.usage', today)).toBe(
      'leave-usage-2026-10-06.csv',
    );
  });
});

describe('saveBlob', () => {
  it('clicks a temporary download link and revokes the object URL afterwards', () => {
    vi.useFakeTimers();
    const createObjectURL = vi.fn().mockReturnValue('blob:report');
    const revokeObjectURL = vi.fn();
    const original = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    saveBlob(new Blob(['a,b']), 'report.csv');
    expect(click).toHaveBeenCalledOnce();
    const anchor = click.mock.contexts[0] as HTMLAnchorElement;
    expect(anchor.download).toBe('report.csv');
    expect(anchor.getAttribute('href')).toBe('blob:report');
    expect(document.querySelector('a[download]')).toBeNull();
    expect(revokeObjectURL).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:report');
    vi.useRealTimers();
    URL.createObjectURL = original.create;
    URL.revokeObjectURL = original.revoke;
  });
});
