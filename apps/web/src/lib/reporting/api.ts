import { getApiBaseUrl } from '../api-config';
import { apiRequest, refreshAccessToken } from '../auth/api-client';
import { AuthApiError, type AuthErrorCategory } from '../auth/types';
import {
  REPORT_FILTER_KEYS,
  type CsvExport,
  type ReportCatalog,
  type ReportFilters,
  type ReportOrganization,
  type ReportResult,
  type SheetsExportResult,
} from './types';

const enc = encodeURIComponent;

/** The organization plus the defined, non-empty filters, in a stable order. */
function reportParams(organizationId: string, filters: ReportFilters) {
  const params = new URLSearchParams({ organizationId });
  for (const key of REPORT_FILTER_KEYS) {
    const value = filters[key];
    if (value !== undefined && value !== '') params.set(key, value);
  }
  return params;
}

function reportBody(organizationId: string, filters: ReportFilters) {
  return Object.fromEntries(reportParams(organizationId, filters));
}

/**
 * A safe download file name: the API's Content-Disposition name when it is readable (the API
 * must expose the header to cross-origin pages), else the API's own pattern
 * `<report-key>-<YYYY-MM-DD>.csv`. Only [A-Za-z0-9._-] survives.
 */
export function csvFileName(
  contentDisposition: string | null,
  reportKey: string,
  today = new Date(),
): string {
  const match = contentDisposition?.match(/filename="?([^";]+)"?/i);
  const fromHeader = match?.[1]?.trim().replace(/[^A-Za-z0-9._-]+/g, '-');
  if (fromHeader && /\.csv$/i.test(fromHeader) && !fromHeader.startsWith('.')) return fromHeader;
  const base =
    reportKey
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'report';
  return `${base}-${today.toISOString().slice(0, 10)}.csv`;
}

function category(status: number): AuthErrorCategory {
  if (status === 401) return 'unauthenticated';
  if (status === 403) return 'forbidden';
  if (status === 409) return 'conflict';
  if (status === 400 || status === 422) return 'validation';
  if (status === 429) return 'rate-limited';
  if (status >= 500) return 'service-unavailable';
  return 'unexpected';
}

/** An AuthApiError carrying the error body (domain `code`) for every status. */
async function exportError(response: Response): Promise<AuthApiError> {
  let body: Record<string, unknown> | undefined;
  try {
    const parsed: unknown = await response.json();
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      body = parsed as Record<string, unknown>;
    }
  } catch {
    body = undefined;
  }
  const message = typeof body?.message === 'string' ? body.message : undefined;
  return new AuthApiError(category(response.status), response.status, message, body);
}

export const reportingApi = {
  organizations(): Promise<{ items: ReportOrganization[] }> {
    return apiRequest('/reports/organizations');
  },
  catalog(organizationId: string): Promise<ReportCatalog> {
    return apiRequest(`/reports/catalog?${new URLSearchParams({ organizationId })}`);
  },
  run(reportKey: string, organizationId: string, filters: ReportFilters): Promise<ReportResult> {
    return apiRequest(`/reports/${enc(reportKey)}?${reportParams(organizationId, filters)}`);
  },
  /**
   * Downloads the CSV export as a Blob. The shared JSON client cannot read a file body, so this
   * authenticates the request itself with a current access token (obtained through the same
   * refresh flow the client uses, which also keeps the client's token current).
   */
  async exportCsv(
    reportKey: string,
    organizationId: string,
    filters: ReportFilters,
  ): Promise<CsvExport> {
    const token = await refreshAccessToken();
    if (!token) throw new AuthApiError('unauthenticated', 401);
    const response = await fetch(
      `${getApiBaseUrl()}/reports/${enc(reportKey)}/export.csv?${reportParams(organizationId, filters)}`,
      { headers: { Accept: 'text/csv', Authorization: `Bearer ${token}` } },
    );
    if (!response.ok) throw await exportError(response);
    return {
      fileName: csvFileName(response.headers.get('Content-Disposition'), reportKey),
      blob: await response.blob(),
      truncated: response.headers.get('X-Report-Truncated') === 'true',
    };
  },
  exportGoogleSheets(
    reportKey: string,
    organizationId: string,
    filters: ReportFilters,
  ): Promise<SheetsExportResult> {
    return apiRequest(`/reports/${enc(reportKey)}/export/google-sheets`, {
      method: 'POST',
      body: JSON.stringify(reportBody(organizationId, filters)),
    });
  },
};

/** Saves a Blob as a download through a temporary object URL (revoked afterwards). */
export function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.rel = 'noopener';
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    // Revoke after the click has been dispatched so the download can start.
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}
