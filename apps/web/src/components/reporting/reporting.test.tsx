import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthApiError } from '../../lib/auth/types';
import { todayIn } from '../../lib/reporting/filters';
import type {
  CatalogArea,
  CatalogReport,
  ReportCatalog,
  ReportOrganization,
  ReportResult,
} from '../../lib/reporting/types';
import { ReportPage } from './report-page';
import { ReportsHomePage } from './reports-home-page';

const mocks = vi.hoisted(() => ({
  reporting: {
    organizations: vi.fn(),
    catalog: vi.fn(),
    run: vi.fn(),
    exportCsv: vi.fn(),
    exportGoogleSheets: vi.fn(),
  },
  saveBlob: vi.fn(),
  organization: {
    listUnits: vi.fn(),
    listDepartments: vi.fn(),
    listTeams: vi.fn(),
    listPositions: vi.fn(),
  },
  performance: { cycles: vi.fn() },
  recruitment: { openings: vi.fn() },
  useAuth: vi.fn(),
}));

vi.mock('../../lib/reporting/api', () => ({
  reportingApi: mocks.reporting,
  saveBlob: mocks.saveBlob,
}));
vi.mock('../../lib/organization/api', () => ({ organizationApi: mocks.organization }));
vi.mock('../../lib/performance/api', () => ({ performanceApi: mocks.performance }));
vi.mock('../../lib/recruitment/api', () => ({ recruitmentApi: mocks.recruitment }));
vi.mock('../../providers/auth-provider', () => ({ useAuth: mocks.useAuth }));

const api = mocks.reporting;
const ORG = '11111111-1111-4111-8111-111111111111';
const ORG2 = '33333333-3333-4333-8333-333333333333';
const DEPT = '22222222-2222-4222-8222-222222222222';

const auth = (keys: string[], loading = false) =>
  mocks.useAuth.mockReturnValue({
    authorizationLoading: loading,
    authorization: loading
      ? null
      : { permissions: keys.map((key) => ({ key, scopes: [{ type: 'ORGANIZATION', id: ORG }] })) },
  });

const organizations: ReportOrganization[] = [
  { id: ORG, name: 'Camp', code: 'CAMP', timezone: 'UTC' },
  { id: ORG2, name: 'Lodge', code: 'LODGE', timezone: null },
];

const distribution = (overrides: Partial<CatalogReport> = {}): CatalogReport => ({
  key: 'workforce.distribution',
  title: 'Headcount distribution',
  description: 'Headcount on a date by group.',
  sourcePermissions: ['employee.read'],
  organizationPermissions: [],
  dateMode: 'AS_OF',
  filters: [
    'asOf',
    'organizationalUnitId',
    'departmentId',
    'teamId',
    'positionId',
    'employmentType',
    'groupBy',
  ],
  groupBy: ['department', 'team', 'organizationalUnit', 'position', 'employmentType'],
  defaultGroupBy: 'department',
  sensitive: false,
  excludesSelf: false,
  columns: [
    { key: 'groupKey', label: 'Group key', type: 'string' },
    { key: 'groupLabel', label: 'Group', type: 'string' },
    { key: 'headcount', label: 'Employees', type: 'integer' },
    { key: 'assignments', label: 'Assignments', type: 'integer' },
  ],
  canExport: true,
  ...overrides,
});

const payByGroup = (overrides: Partial<CatalogReport> = {}): CatalogReport => ({
  ...distribution(),
  key: 'compensation.by_group',
  title: 'Pay by group',
  description: 'Average and median pay per group.',
  sensitive: true,
  excludesSelf: false,
  columns: [
    { key: 'groupKey', label: 'Group key', type: 'string' },
    { key: 'groupLabel', label: 'Group', type: 'string' },
    { key: 'currency', label: 'Currency', type: 'string' },
    { key: 'employees', label: 'Employees', type: 'integer' },
    { key: 'averageRate', label: 'Average rate', type: 'money' },
    { key: 'suppressed', label: 'Suppressed', type: 'boolean' },
  ],
  ...overrides,
});

const cycleCompletion = (): CatalogReport => ({
  ...distribution(),
  key: 'performance.cycle_completion',
  title: 'Review cycle completion',
  description: 'Reviews per cycle.',
  dateMode: 'RANGE',
  filters: ['from', 'to', 'departmentId', 'cycleId'],
  groupBy: null,
  defaultGroupBy: null,
  excludesSelf: true,
  canExport: false,
});

const catalog = (reports: CatalogReport[] = [distribution()]): ReportCatalog => ({
  organizationId: ORG,
  items: (
    [
      { area: 'workforce', reports: reports.filter((r) => r.key.startsWith('workforce')) },
      { area: 'compensation', reports: reports.filter((r) => r.key.startsWith('compensation')) },
      { area: 'performance', reports: reports.filter((r) => r.key.startsWith('performance')) },
    ] as CatalogArea[]
  ).filter((area) => area.reports.length > 0),
});

const result = (overrides: Partial<ReportResult> = {}): ReportResult => ({
  reportKey: 'workforce.distribution',
  area: 'workforce',
  title: 'Headcount distribution',
  generatedAt: '2026-10-06T12:00:00.000Z',
  filters: { organizationId: ORG, asOf: '2026-10-06', groupBy: 'team' },
  scopeSummary: {
    organizationId: ORG,
    placement: 'POSITION',
    organizationWide: true,
    scopes: [{ type: 'ORGANIZATION', id: ORG }],
    positions: 12,
    openings: null,
    selfExcluded: false,
  },
  columns: distribution().columns,
  rows: [
    { groupKey: 't-1', groupLabel: 'Sales', headcount: 1234, assignments: 1240 },
    { groupKey: 't-2', groupLabel: 'Support', headcount: 8, assignments: 8 },
  ],
  suppressed: 0,
  notes: [],
  ...overrides,
});

function setLocation(search: string) {
  window.history.replaceState(null, '', `/reports${search}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  auth(['report.read']);
  setLocation('');
  api.organizations.mockResolvedValue({ items: organizations });
  api.catalog.mockResolvedValue(catalog([distribution(), payByGroup(), cycleCompletion()]));
  mocks.organization.listUnits.mockResolvedValue([]);
  mocks.organization.listDepartments.mockResolvedValue([{ id: DEPT, name: 'Field', code: 'FLD' }]);
  mocks.organization.listTeams.mockRejectedValue(new AuthApiError('forbidden', 403));
  mocks.organization.listPositions.mockResolvedValue([]);
  mocks.performance.cycles.mockResolvedValue({ items: [] });
  mocks.recruitment.openings.mockResolvedValue({ items: [] });
});

afterEach(() => {
  cleanup();
});

describe('ReportsHomePage', () => {
  it('requires report.read', () => {
    auth(['report.export', 'employee.read']);
    render(<ReportsHomePage />);
    expect(screen.getByText('You do not have permission to view reports.')).toBeInTheDocument();
    expect(api.organizations).not.toHaveBeenCalled();
  });

  it('lists the runnable reports by area and switches organizations', async () => {
    render(<ReportsHomePage />);
    const workforce = await screen.findByRole('region', { name: 'Workforce' });
    const link = within(workforce).getByRole('link', { name: 'Headcount distribution' });
    expect(link).toHaveAttribute('href', `/reports/workforce.distribution?organizationId=${ORG}`);
    expect(within(workforce).getByText('Headcount on a date by group.')).toBeInTheDocument();
    const compensation = screen.getByRole('region', { name: 'Compensation' });
    expect(within(compensation).getByText('Small groups suppressed')).toBeInTheDocument();
    expect(
      within(screen.getByRole('region', { name: 'Performance' })).getByText(
        'Excludes your own records',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Payroll' })).not.toBeInTheDocument();
    expect(api.catalog).toHaveBeenCalledWith(ORG);

    api.catalog.mockResolvedValue({ organizationId: ORG2, items: [] });
    fireEvent.change(screen.getByLabelText('Organization'), { target: { value: ORG2 } });
    expect(await screen.findByText(/No reports are available to you in Lodge/)).toBeInTheDocument();
    expect(api.catalog).toHaveBeenLastCalledWith(ORG2);
    expect(window.location.search).toBe(`?organizationId=${ORG2}`);
  });

  it('preselects the organization from the URL and reports load errors', async () => {
    setLocation(`?organizationId=${ORG2}`);
    api.catalog.mockRejectedValue(new AuthApiError('service-unavailable', 503));
    render(<ReportsHomePage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Reporting is unavailable');
    expect(api.catalog).toHaveBeenCalledWith(ORG2);
  });
});

async function openReport(key = 'workforce.distribution') {
  setLocation(`/${key}?organizationId=${ORG}`);
  render(<ReportPage reportKey={key} />);
  await screen.findByRole('form', { name: 'Report filters' });
}

describe('ReportPage', () => {
  it('builds the filter bar from the report definition', async () => {
    await openReport();
    expect(screen.getByRole('heading', { name: 'Headcount distribution' })).toBeInTheDocument();
    expect(screen.getByLabelText('As of')).toHaveValue(todayIn('UTC'));
    expect(screen.queryByLabelText('From')).not.toBeInTheDocument();
    const department = await screen.findByRole('option', { name: 'Field (FLD)' });
    expect(department.closest('select')).toHaveAttribute('id', 'filter-departmentId');
    // The team list is not readable with this access: a UUID input instead.
    expect(await screen.findByLabelText('Team ID')).toHaveAttribute('type', 'text');
    expect(screen.getByLabelText('Employment type')).toHaveValue('');
    const groupBy = screen.getByLabelText('Group by');
    expect(groupBy).toHaveValue('department');
    expect(
      within(groupBy)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Department', 'Team', 'Business unit', 'Position', 'Employment type']);
    expect(screen.queryByLabelText(/Performance cycle/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Job opening/)).not.toBeInTheDocument();
    expect(mocks.performance.cycles).not.toHaveBeenCalled();
  });

  it('shows date ranges and the cycle filter where supported', async () => {
    await openReport('performance.cycle_completion');
    expect(screen.getByLabelText('From')).toBeInTheDocument();
    expect(screen.getByLabelText('To')).toHaveValue(todayIn('UTC'));
    expect(screen.queryByLabelText('As of')).not.toBeInTheDocument();
    expect(await screen.findByLabelText('Performance cycle')).toBeInTheDocument();
    expect(screen.queryByLabelText('Group by')).not.toBeInTheDocument();
    expect(screen.getByText('Your own records are excluded')).toBeInTheDocument();
  });

  it('runs the report with the chosen filters and renders typed results', async () => {
    api.run.mockResolvedValue(result());
    await openReport();
    await screen.findByRole('option', { name: 'Field (FLD)' });
    fireEvent.change(screen.getByLabelText('As of'), { target: { value: '2026-09-30' } });
    fireEvent.change(screen.getByLabelText('Department'), { target: { value: DEPT } });
    fireEvent.change(screen.getByLabelText('Employment type'), { target: { value: 'PART_TIME' } });
    fireEvent.change(screen.getByLabelText('Group by'), { target: { value: 'team' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run report' }));
    const table = await screen.findByRole('table', { name: 'Headcount distribution' });
    expect(api.run).toHaveBeenCalledWith('workforce.distribution', ORG, {
      asOf: '2026-09-30',
      departmentId: DEPT,
      employmentType: 'PART_TIME',
      groupBy: 'team',
    });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual(['Group', 'Employees', 'Assignments']);
    expect(within(table).getByRole('cell', { name: '1,234' })).toBeInTheDocument();
    expect(screen.getByTestId('scope-summary')).toHaveTextContent('Organization-wide');
    expect(screen.getByTestId('scope-summary')).toHaveTextContent('12 positions');
    expect(screen.getByText(/a visual summary of Headcount distribution/)).toBeInTheDocument();
  });

  it('checks filters before running and shows API filter errors', async () => {
    await openReport();
    fireEvent.change(await screen.findByLabelText('Team ID'), { target: { value: 'not-a-uuid' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run report' }));
    expect(await screen.findByText('Team must be a valid identifier (UUID).')).toBeInTheDocument();
    expect(api.run).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('Team ID'), { target: { value: '' } });
    api.run.mockRejectedValue(
      new AuthApiError('validation', 400, 'x', { code: 'REPORT_RANGE_TOO_LONG' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Run report' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/at most five years/);
    api.run.mockRejectedValue(new AuthApiError('unexpected', 404));
    fireEvent.click(screen.getByRole('button', { name: 'Run report' }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/not found in your reporting scope/),
    );
  });

  it('renders suppressed groups, the scope limits and notes', async () => {
    api.run.mockResolvedValue(
      result({
        reportKey: 'compensation.by_group',
        title: 'Pay by group',
        columns: payByGroup().columns,
        scopeSummary: {
          ...result().scopeSummary,
          organizationWide: false,
          scopes: [
            { type: 'DEPARTMENT', id: 'd-1' },
            { type: 'TEAM', id: 't-9' },
          ],
          selfExcluded: true,
        },
        rows: [
          {
            groupKey: 'd-1',
            groupLabel: 'Field',
            currency: 'CAD',
            employees: 9,
            averageRate: 25.5,
            suppressed: false,
          },
          {
            groupKey: 'd-2',
            groupLabel: 'Office',
            currency: 'CAD',
            employees: null,
            averageRate: null,
            suppressed: true,
          },
        ],
        suppressed: 1,
        notes: ['The result was capped at 5000 rows; narrow the filters to see the rest.'],
      }),
    );
    await openReport('compensation.by_group');
    expect(screen.getByText('Groups with fewer than 5 people are suppressed')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Run report' }));
    const table = await screen.findByRole('table', { name: 'Pay by group' });
    expect(within(table).getByRole('cell', { name: 'CAD 25.50' })).toBeInTheDocument();
    const hidden = within(table).getAllByText('Suppressed (fewer than 5)');
    expect(hidden).toHaveLength(2);
    expect(hidden[0]).toHaveAttribute('title', expect.stringMatching(/fewer than 5 people/));
    expect(screen.getByRole('note')).toHaveTextContent(
      '1 group with fewer than 5 people was suppressed to protect privacy.',
    );
    expect(screen.getByTestId('scope-summary')).toHaveTextContent('Limited to 2 scopes');
    expect(screen.getByTestId('scope-summary')).toHaveTextContent('Your own records are excluded');
    expect(screen.getByRole('list', { name: 'Report notes' })).toHaveTextContent(/capped at 5000/);
  });

  it('offers exports only when the report can be exported', async () => {
    api.catalog.mockResolvedValue(catalog([distribution({ canExport: false })]));
    api.run.mockResolvedValue(result());
    await openReport();
    fireEvent.click(screen.getByRole('button', { name: 'Run report' }));
    await screen.findByRole('table');
    expect(screen.queryByRole('button', { name: 'Export CSV' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Export to Google Sheets' }),
    ).not.toBeInTheDocument();
  });

  it('downloads the CSV of the displayed result', async () => {
    api.run.mockResolvedValue(result());
    const blob = new Blob(['Group,Employees\r\n']);
    api.exportCsv.mockResolvedValue({ fileName: 'workforce.distribution-2026-10-06.csv', blob });
    await openReport();
    fireEvent.change(screen.getByLabelText('Group by'), { target: { value: 'team' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run report' }));
    await screen.findByRole('table');
    // A later, un-run change does not leak into the export.
    fireEvent.change(screen.getByLabelText('Group by'), { target: { value: 'position' } });
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    expect(
      await screen.findByText('Downloaded workforce.distribution-2026-10-06.csv.'),
    ).toBeInTheDocument();
    expect(api.exportCsv).toHaveBeenCalledWith('workforce.distribution', ORG, {
      asOf: todayIn('UTC'),
      groupBy: 'team',
    });
    expect(mocks.saveBlob).toHaveBeenCalledWith(blob, 'workforce.distribution-2026-10-06.csv');
  });

  it('warns when a run or a downloaded CSV was capped (Batch 4F, Q9)', async () => {
    api.run.mockResolvedValue(result({ truncated: true }));
    const blob = new Blob(['Group,Employees\r\nTRUNCATED: capped\r\n']);
    api.exportCsv.mockResolvedValue({
      fileName: 'workforce.distribution-2026-10-06.csv',
      blob,
      truncated: true,
    });
    await openReport();
    fireEvent.click(screen.getByRole('button', { name: 'Run report' }));
    await screen.findByRole('table');
    expect(screen.getByText(/Partial result:/).closest('[role="status"]')).toHaveTextContent(
      /Narrow the filters/,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    expect(await screen.findByText('The export is capped:')).toBeInTheDocument();
  });

  it('explains that Sheets export needs a Google Workspace connection', async () => {
    api.run.mockResolvedValue(result());
    api.exportGoogleSheets.mockRejectedValue(
      new AuthApiError('conflict', 409, 'needs connection', {
        statusCode: 409,
        code: 'GOOGLE_CONNECTION_REQUIRED',
      }),
    );
    await openReport();
    fireEvent.click(screen.getByRole('button', { name: 'Run report' }));
    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('button', { name: 'Export to Google Sheets' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/needs an active Google Workspace connection with the Sheets/);
    expect(within(alert).getByRole('link', { name: 'Set up Google Workspace' })).toHaveAttribute(
      'href',
      '/settings/integrations/google',
    );

    api.exportGoogleSheets.mockResolvedValue({ spreadsheetId: 'sheet_ABC-1234567' });
    fireEvent.click(screen.getByRole('button', { name: 'Export to Google Sheets' }));
    expect(
      await screen.findByText(/Exported to Google Sheets. Spreadsheet ID: sheet_ABC-1234567/),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open in Google Sheets' })).toHaveAttribute(
      'href',
      'https://docs.google.com/spreadsheets/d/sheet_ABC-1234567',
    );
  });

  it('warns when a Google Sheets export was capped (Batch 4F, Q9)', async () => {
    api.run.mockResolvedValue(result());
    api.exportGoogleSheets.mockResolvedValue({
      spreadsheetId: 'sheet_ABC-1234567',
      truncated: true,
    });
    await openReport();
    fireEvent.click(screen.getByRole('button', { name: 'Run report' }));
    await screen.findByRole('table');
    fireEvent.click(screen.getByRole('button', { name: 'Export to Google Sheets' }));
    expect(await screen.findByText('The export is capped:')).toBeInTheDocument();
    // A complete export shows no warning.
    api.exportGoogleSheets.mockResolvedValue({
      spreadsheetId: 'sheet_ABC-1234567',
      truncated: false,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Export to Google Sheets' }));
    await waitFor(() =>
      expect(screen.queryByText('The export is capped:')).not.toBeInTheDocument(),
    );
  });

  it('says when the report is not available in the organization', async () => {
    api.catalog.mockResolvedValue(catalog([payByGroup()]));
    setLocation(`/workforce.distribution?organizationId=${ORG}`);
    render(<ReportPage reportKey="workforce.distribution" />);
    expect(
      await screen.findByText(/This report is not available to you in Camp/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Report filters' })).not.toBeInTheDocument();
  });

  it('requires report.read', () => {
    auth([]);
    render(<ReportPage reportKey="workforce.distribution" />);
    expect(screen.getByText('You do not have permission to view reports.')).toBeInTheDocument();
  });
});
