'use client';

import { PageContainer } from '../ui/page-container';
import Link from 'next/link';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Forbidden } from '../auth/forbidden';
import { PageHeader, ErrorBanner, FeedbackMessage } from '../organization/shared';
import { organizationApi } from '../../lib/organization/api';
import { performanceApi } from '../../lib/performance/api';
import { recruitmentApi } from '../../lib/recruitment/api';
import { reportingApi, saveBlob } from '../../lib/reporting/api';
import { isGoogleConnectionRequired, reportingErrorMessage } from '../../lib/reporting/errors';
import {
  defaultFilterValues,
  requestFilters,
  supports,
  todayIn,
  validateFilters,
  type FilterValues,
} from '../../lib/reporting/filters';
import {
  AREA_LABELS,
  EMPLOYMENT_TYPE_LABELS,
  GROUP_BY_LABELS,
  MIN_GROUP_SIZE,
} from '../../lib/reporting/format';
import {
  EMPLOYMENT_TYPES,
  type CatalogArea,
  type CatalogReport,
  type ReportFilterKey,
  type ReportFilters,
  type ReportOrganization,
  type ReportResult,
} from '../../lib/reporting/types';
import { useAuth } from '../../providers/auth-provider';
import { InlineMessage } from '../ui/inline-message';
import { ReportResults } from './report-results';
import {
  Badge,
  canSeeReports,
  EmptyState,
  inputClass,
  Loading,
  organizationFromLocation,
  primaryButton,
  reportHref,
  secondaryButton,
  Section,
} from './reporting-shared';

/**
 * One report (/reports/[reportKey]?organizationId=…): a filter bar built from the report's
 * catalog definition, the result table (with a simple bar summary where it helps), and CSV /
 * Google Sheets exports when the caller may export. Needs report.read; the API authorizes.
 */
export function ReportPage({ reportKey }: { reportKey: string }) {
  const { authorization, authorizationLoading } = useAuth();
  if (authorizationLoading) {
    return (
      <PageContainer width="wide">
        <Loading />
      </PageContainer>
    );
  }
  if (!canSeeReports(authorization)) {
    return (
      <PageContainer width="wide" padded={false}>
        <Forbidden message="You do not have permission to view reports." />
      </PageContainer>
    );
  }
  return <ReportLoader reportKey={reportKey} />;
}

interface Located {
  report: CatalogReport;
  area: CatalogArea['area'];
}

function ReportLoader({ reportKey }: { reportKey: string }) {
  const [organizations, setOrganizations] = useState<ReportOrganization[]>([]);
  const [organizationId, setOrganizationId] = useState('');
  const [located, setLocated] = useState<Located | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const preferred = organizationFromLocation();
      reportingApi
        .organizations()
        .then(({ items }) => {
          setOrganizations(items);
          const chosen = items.some((o) => o.id === preferred) ? preferred : (items[0]?.id ?? '');
          setOrganizationId(chosen);
          if (!chosen) setLoading(false);
        })
        .catch((cause) => {
          setError(reportingErrorMessage(cause, 'Unable to load organizations.'));
          setLoading(false);
        });
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!organizationId) return;
    let active = true;
    const timer = window.setTimeout(() => {
      setLoading(true);
      setError(null);
      reportingApi
        .catalog(organizationId)
        .then((catalog) => {
          if (!active) return;
          let found: Located | null = null;
          for (const area of catalog.items) {
            const report = area.reports.find((candidate) => candidate.key === reportKey);
            if (report) found = { report, area: area.area };
          }
          setLocated(found);
        })
        .catch((cause) => {
          if (active) setError(reportingErrorMessage(cause, 'Unable to load the report.'));
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [organizationId, reportKey]);

  const organization = organizations.find((o) => o.id === organizationId);
  const report = located?.report;

  return (
    <PageContainer width="wide">
      <nav aria-label="Breadcrumb" className="mb-4 text-sm">
        <Link href={reportHref(null, organizationId)} className="text-indigo-700 hover:underline">
          ← All reports
        </Link>
      </nav>
      <PageHeader
        eyebrow={located ? `Reports · ${AREA_LABELS[located.area] ?? located.area}` : 'Reports'}
        title={report?.title ?? 'Report'}
        description={report?.description}
      >
        {organizations.length > 1 && (
          <label className="text-sm font-medium text-slate-800" htmlFor="report-organization">
            Organization
            <select
              id="report-organization"
              className={inputClass}
              value={organizationId}
              onChange={(event) => {
                const next = event.currentTarget.value;
                setOrganizationId(next);
                window.history.replaceState(window.history.state, '', reportHref(reportKey, next));
              }}
            >
              {organizations.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </PageHeader>
      <div className="mt-6 space-y-4">
        {error && <ErrorBanner>{error}</ErrorBanner>}
        {loading ? (
          <Loading>Loading report…</Loading>
        ) : !organization ? (
          !error && <EmptyState>No organizations are within your reporting access.</EmptyState>
        ) : !report ? (
          !error && (
            <EmptyState>
              This report is not available to you in {organization.name}.{' '}
              <Link href={reportHref(null, organization.id)} className="text-indigo-700 underline">
                See the reports you can run
              </Link>
              .
            </EmptyState>
          )
        ) : (
          <ReportWorkspace
            key={`${organization.id}:${report.key}`}
            organization={organization}
            report={report}
          />
        )}
      </div>
    </PageContainer>
  );
}

interface Option {
  id: string;
  label: string;
}

type OptionKey =
  'organizationalUnitId' | 'departmentId' | 'teamId' | 'positionId' | 'cycleId' | 'openingId';

/** Option lists per id filter; null when the list could not be loaded (a UUID input is shown). */
type FilterOptions = Partial<Record<OptionKey, Option[] | null>>;

const named = (items: Array<{ id: string; name: string; code: string }>): Option[] =>
  items.map((item) => ({ id: item.id, label: `${item.name} (${item.code})` }));

const OPTION_LOADERS: Record<OptionKey, (organizationId: string) => Promise<Option[]>> = {
  organizationalUnitId: async (id) => named(await organizationApi.listUnits(id)),
  departmentId: async (id) => named(await organizationApi.listDepartments(id)),
  teamId: async (id) => named(await organizationApi.listTeams(id)),
  positionId: async (id) => named(await organizationApi.listPositions(id)),
  cycleId: async (id) => named((await performanceApi.cycles(id)).items),
  openingId: async (id) =>
    (await recruitmentApi.openings(id)).items.map((opening) => ({
      id: opening.id,
      label: `${opening.title} (${opening.code})`,
    })),
};

const ID_FILTERS: Array<{ key: OptionKey; label: string; all: string }> = [
  { key: 'organizationalUnitId', label: 'Business unit', all: 'All units' },
  { key: 'departmentId', label: 'Department', all: 'All departments' },
  { key: 'teamId', label: 'Team', all: 'All teams' },
  { key: 'positionId', label: 'Position', all: 'All positions' },
  { key: 'cycleId', label: 'Performance cycle', all: 'All cycles' },
  { key: 'openingId', label: 'Job opening', all: 'All openings' },
];

/**
 * Loads the selectable options of the report's id filters from the existing organization,
 * performance and recruitment endpoints. Those need their own read permissions; a list that
 * cannot be loaded falls back to a UUID input (the reporting API still checks the scope).
 */
function useFilterOptions(report: CatalogReport, organizationId: string) {
  const [options, setOptions] = useState<FilterOptions>({});
  useEffect(() => {
    let active = true;
    const keys = ID_FILTERS.map((filter) => filter.key).filter((key) => supports(report, key));
    const timer = window.setTimeout(() => {
      void Promise.allSettled(keys.map((key) => OPTION_LOADERS[key](organizationId))).then(
        (results) => {
          if (!active) return;
          const next: FilterOptions = {};
          results.forEach((result, index) => {
            next[keys[index]!] = result.status === 'fulfilled' ? result.value : null;
          });
          setOptions(next);
        },
      );
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [report, organizationId]);
  return options;
}

type ExportState =
  | { kind: 'idle' }
  | { kind: 'success'; message: string; spreadsheetId?: string; truncated?: boolean }
  | { kind: 'error'; message: string }
  | { kind: 'google-connection' };

const SPREADSHEET_ID = /^[A-Za-z0-9_-]{10,200}$/;

function ReportWorkspace({
  organization,
  report,
}: {
  organization: ReportOrganization;
  report: CatalogReport;
}) {
  const today = todayIn(organization.timezone);
  const [values, setValues] = useState<FilterValues>(() => defaultFilterValues(report, today));
  const [formError, setFormError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [result, setResult] = useState<ReportResult | null>(null);
  const [ranWith, setRanWith] = useState<ReportFilters>({});
  const [exporting, setExporting] = useState<'csv' | 'sheets' | null>(null);
  const [exportState, setExportState] = useState<ExportState>({ kind: 'idle' });
  const options = useFilterOptions(report, organization.id);

  const set = (key: ReportFilterKey, value: string) =>
    setValues((current) => ({ ...current, [key]: value }));

  async function run(event: FormEvent) {
    event.preventDefault();
    const filters = requestFilters(report, values);
    const invalid = validateFilters(report, filters);
    setFormError(invalid);
    if (invalid) return;
    setRunning(true);
    setRunError(null);
    setExportState({ kind: 'idle' });
    try {
      const next = await reportingApi.run(report.key, organization.id, filters);
      setResult(next);
      setRanWith(filters);
    } catch (cause) {
      setResult(null);
      setRunError(reportingErrorMessage(cause, 'Unable to run the report.'));
    } finally {
      setRunning(false);
    }
  }

  async function exportCsv() {
    setExporting('csv');
    setExportState({ kind: 'idle' });
    try {
      const file = await reportingApi.exportCsv(report.key, organization.id, ranWith);
      saveBlob(file.blob, file.fileName);
      setExportState({
        kind: 'success',
        message: `Downloaded ${file.fileName}.`,
        truncated: file.truncated,
      });
    } catch (cause) {
      setExportState({
        kind: 'error',
        message: reportingErrorMessage(cause, 'Unable to export the report.'),
      });
    } finally {
      setExporting(null);
    }
  }

  async function exportSheets() {
    setExporting('sheets');
    setExportState({ kind: 'idle' });
    try {
      const { spreadsheetId, truncated } = await reportingApi.exportGoogleSheets(
        report.key,
        organization.id,
        ranWith,
      );
      setExportState({
        kind: 'success',
        message: `Exported to Google Sheets. Spreadsheet ID: ${spreadsheetId}`,
        spreadsheetId,
        truncated: truncated === true,
      });
    } catch (cause) {
      setExportState(
        isGoogleConnectionRequired(cause)
          ? { kind: 'google-connection' }
          : {
              kind: 'error',
              message: reportingErrorMessage(cause, 'Unable to export to Google Sheets.'),
            },
      );
    } finally {
      setExporting(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {report.sensitive && (
          <Badge tone="amber">Groups with fewer than {MIN_GROUP_SIZE} people are suppressed</Badge>
        )}
        {report.excludesSelf && <Badge>Your own records are excluded</Badge>}
      </div>
      <Section title="Filters">
        <form onSubmit={(event) => void run(event)} aria-label="Report filters" noValidate>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {report.dateMode === 'RANGE' && (
              <>
                <DateField
                  id="filter-from"
                  label="From"
                  value={values.from}
                  onChange={(v) => set('from', v)}
                />
                <DateField
                  id="filter-to"
                  label="To"
                  value={values.to}
                  onChange={(v) => set('to', v)}
                />
              </>
            )}
            {report.dateMode === 'AS_OF' && (
              <DateField
                id="filter-asOf"
                label="As of"
                value={values.asOf}
                onChange={(v) => set('asOf', v)}
              />
            )}
            {ID_FILTERS.filter((filter) => supports(report, filter.key)).map((filter) => (
              <IdFilter
                key={filter.key}
                id={`filter-${filter.key}`}
                label={filter.label}
                all={filter.all}
                options={options[filter.key]}
                value={values[filter.key]}
                onChange={(v) => set(filter.key, v)}
              />
            ))}
            {supports(report, 'employmentType') && (
              <SelectField
                id="filter-employmentType"
                label="Employment type"
                value={values.employmentType}
                onChange={(v) => set('employmentType', v)}
              >
                <option value="">All employment types</option>
                {EMPLOYMENT_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {EMPLOYMENT_TYPE_LABELS[type]}
                  </option>
                ))}
              </SelectField>
            )}
            {supports(report, 'groupBy') && report.groupBy && report.groupBy.length > 0 && (
              <SelectField
                id="filter-groupBy"
                label="Group by"
                value={values.groupBy}
                onChange={(v) => set('groupBy', v)}
              >
                {report.groupBy.map((group) => (
                  <option key={group} value={group}>
                    {GROUP_BY_LABELS[group] ?? group}
                  </option>
                ))}
              </SelectField>
            )}
          </div>
          {formError && (
            <p role="alert" className="mt-3 text-sm text-rose-800">
              {formError}
            </p>
          )}
          <div className="mt-4 flex flex-wrap gap-2">
            <button type="submit" className={primaryButton} disabled={running}>
              {running ? 'Running…' : 'Run report'}
            </button>
            <button
              type="button"
              className={secondaryButton}
              disabled={running}
              onClick={() => {
                setValues(defaultFilterValues(report, today));
                setFormError(null);
              }}
            >
              Reset filters
            </button>
          </div>
        </form>
      </Section>
      {runError && <ErrorBanner>{runError}</ErrorBanner>}
      {result && (
        <Section
          title="Results"
          actions={
            report.canExport ? (
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className={secondaryButton}
                  disabled={exporting !== null}
                  onClick={() => void exportCsv()}
                >
                  {exporting === 'csv' ? 'Exporting…' : 'Export CSV'}
                </button>
                <button
                  type="button"
                  className={secondaryButton}
                  disabled={exporting !== null}
                  onClick={() => void exportSheets()}
                >
                  {exporting === 'sheets' ? 'Exporting…' : 'Export to Google Sheets'}
                </button>
              </div>
            ) : undefined
          }
        >
          <ExportFeedback state={exportState} />
          <ReportResults result={result} />
        </Section>
      )}
    </div>
  );
}

function ExportFeedback({ state }: { state: ExportState }) {
  if (state.kind === 'idle') return null;
  if (state.kind === 'error') return <ErrorBanner>{state.message}</ErrorBanner>;
  if (state.kind === 'google-connection') {
    return (
      <div
        role="alert"
        className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
      >
        Exporting to Google Sheets needs an active Google Workspace connection with the Sheets
        export capability for this organization.{' '}
        <Link href="/settings/integrations/google" className="font-medium underline">
          Set up Google Workspace
        </Link>
        .
      </div>
    );
  }
  return (
    <>
      <FeedbackMessage>
        {state.message}
        {state.spreadsheetId && SPREADSHEET_ID.test(state.spreadsheetId) && (
          <>
            {' '}
            <a
              className="font-medium underline"
              href={`https://docs.google.com/spreadsheets/d/${state.spreadsheetId}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open in Google Sheets
            </a>
          </>
        )}
      </FeedbackMessage>
      {state.truncated && (
        <InlineMessage tone="warning" className="mt-2">
          <strong className="font-semibold">The export is capped:</strong> it holds only the first
          rows, and its last row says so. Narrow the filters (for example the date range) and export
          again to get the rest.
        </InlineMessage>
      )}
    </>
  );
}

function DateField({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange(value: string): void;
}) {
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-slate-800">
        {label}
      </label>
      <input
        id={id}
        type="date"
        className={inputClass}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
    </div>
  );
}

function SelectField({
  id,
  label,
  value,
  onChange,
  children,
  disabled = false,
}: {
  id: string;
  label: string;
  value: string;
  onChange(value: string): void;
  children: ReactNode;
  disabled?: boolean;
}) {
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-slate-800">
        {label}
      </label>
      <select
        id={id}
        className={inputClass}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.value)}
      >
        {children}
      </select>
    </div>
  );
}

function IdFilter({
  id,
  label,
  all,
  options,
  value,
  onChange,
}: {
  id: string;
  label: string;
  all: string;
  options: Option[] | null | undefined;
  value: string;
  onChange(value: string): void;
}) {
  if (options === undefined) {
    return (
      <SelectField id={id} label={label} value="" onChange={onChange} disabled>
        <option value="">Loading…</option>
      </SelectField>
    );
  }
  if (options) {
    return (
      <SelectField id={id} label={label} value={value} onChange={onChange}>
        <option value="">{all}</option>
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </SelectField>
    );
  }
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-slate-800">
        {label} ID
      </label>
      <input
        id={id}
        type="text"
        inputMode="text"
        autoComplete="off"
        spellCheck={false}
        placeholder="UUID (leave empty for all)"
        className={`${inputClass} font-mono text-xs`}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        aria-describedby={`${id}-hint`}
      />
      <p id={`${id}-hint`} className="mt-1 text-xs text-slate-500">
        The list is not available with your access; enter an identifier or leave it empty.
      </p>
    </div>
  );
}
