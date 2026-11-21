'use client';

import { useId } from 'react';
import {
  chartSpec,
  formatCell,
  generatedAtText,
  isNumericColumn,
  isSuppressedCell,
  MIN_GROUP_SIZE,
  SUPPRESSED_EXPLANATION,
  SUPPRESSED_TEXT,
  visibleColumns,
  type ChartSpec,
} from '../../lib/reporting/format';
import type { ReportResult, ScopeSummary } from '../../lib/reporting/types';
import { InlineMessage } from '../ui/inline-message';
import { DataTable } from '../ui/data-table';
import { EmptyState } from './reporting-shared';

const PLACEMENT_FILTERS = [
  'organizationalUnitId',
  'departmentId',
  'teamId',
  'positionId',
  'employmentType',
  'openingId',
  'cycleId',
];

function plural(count: number, one: string, many = `${one}s`) {
  return `${count.toLocaleString('en-US')} ${count === 1 ? one : many}`;
}

/** What the result covers: organization-wide or limited scopes, and whether self is excluded. */
export function ScopeSummaryText({
  summary,
  filters,
}: {
  summary: ScopeSummary;
  filters: Record<string, string>;
}) {
  const narrowed = PLACEMENT_FILTERS.some((key) => Boolean(filters[key]));
  const parts = [
    summary.organizationWide
      ? 'Organization-wide'
      : `Limited to ${plural(summary.scopes.length, 'scope')}`,
  ];
  if (narrowed) parts.push('narrowed by the selected filters');
  if (summary.placement === 'OPENING' && summary.openings !== null) {
    parts.push(plural(summary.openings, 'job opening'));
  } else if (summary.placement !== 'ORGANIZATION') {
    parts.push(plural(summary.positions, 'position'));
  }
  return (
    <div className="space-y-1 text-sm text-slate-700" data-testid="scope-summary">
      <p>
        <span className="font-medium text-slate-900">Scope:</span> {parts.join(' · ')}
      </p>
      {summary.selfExcluded && (
        <p>Your own records are excluded, as they are elsewhere in the HRMS.</p>
      )}
    </div>
  );
}

function BarChart({ spec, title }: { spec: ChartSpec; title: string }) {
  const captionId = useId();
  return (
    <figure aria-labelledby={captionId} className="rounded-xl border border-slate-200 bg-white p-4">
      <figcaption id={captionId} className="text-sm font-medium text-slate-900">
        {spec.column.label}{' '}
        <span className="font-normal text-slate-600">
          — a visual summary of {title}; the table below holds the exact values.
        </span>
      </figcaption>
      <ul className="mt-3 space-y-1.5" aria-hidden="true">
        {spec.bars.map((bar, index) => {
          const width =
            bar.value === null ? 0 : Math.max(0, Math.round((bar.value / spec.max) * 1000) / 10);
          return (
            <li key={index} className="grid grid-cols-[minmax(0,14rem)_1fr] items-center gap-3">
              <span className="truncate text-xs text-slate-700" title={bar.label}>
                {bar.label}
              </span>
              <span className="flex items-center gap-2">
                <span className="h-4 flex-1 rounded bg-slate-100">
                  <span
                    className={`block h-4 rounded ${bar.suppressed ? 'bg-amber-200' : 'bg-indigo-500'}`}
                    style={{ width: `${width}%` }}
                  />
                </span>
                <span className="w-40 shrink-0 text-right text-xs tabular-nums text-slate-700">
                  {bar.text}
                </span>
              </span>
            </li>
          );
        })}
      </ul>
    </figure>
  );
}

export function ReportResults({ result }: { result: ReportResult }) {
  const legendId = useId();
  const columns = visibleColumns(result.columns);
  const chart = chartSpec(result.columns, result.rows);
  const hasSuppressedCells = result.rows.some((row) =>
    columns.some((column) => isSuppressedCell(row, column)),
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <ScopeSummaryText summary={result.scopeSummary} filters={result.filters} />
        <p className="text-xs text-slate-500">Generated {generatedAtText(result.generatedAt)}</p>
      </div>
      {result.truncated && (
        <InlineMessage tone="warning">
          <strong className="font-semibold">Partial result:</strong> showing the first{' '}
          {plural(result.rows.length, 'row')} only. Narrow the filters (for example the date range)
          to see the rest.
        </InlineMessage>
      )}
      {result.suppressed > 0 && (
        <p
          role="note"
          className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
        >
          {plural(result.suppressed, 'group')} with fewer than {MIN_GROUP_SIZE} people{' '}
          {result.suppressed === 1 ? 'was' : 'were'} suppressed to protect privacy.
        </p>
      )}
      {result.notes.length > 0 && (
        <ul className="list-disc space-y-1 pl-5 text-sm text-slate-700" aria-label="Report notes">
          {result.notes.map((note, index) => (
            <li key={index}>{note}</li>
          ))}
        </ul>
      )}
      {result.rows.length === 0 ? (
        <EmptyState>No data matches these filters.</EmptyState>
      ) : (
        <>
          {chart && <BarChart spec={chart} title={result.title} />}
          <p className="text-sm text-slate-600">
            {plural(result.rows.length, 'row')}
            {result.truncated ? ' (capped: more rows match these filters)' : ''}
          </p>
          <DataTable
            label={result.title}
            columns={columns.map((column) => ({
              key: column.key,
              header: column.label,
              align: isNumericColumn(column) ? ('right' as const) : ('left' as const),
              cell: (row: (typeof result.rows)[number]) =>
                isSuppressedCell(row, column) ? (
                  <span
                    className="italic text-amber-800"
                    title={SUPPRESSED_EXPLANATION}
                    aria-describedby={legendId}
                  >
                    {SUPPRESSED_TEXT}
                  </span>
                ) : (
                  formatCell(column, row)
                ),
            }))}
            rows={result.rows}
            rowKey={(_row, index) => index}
            rowClassName={(row) => (row.suppressed === true ? 'bg-amber-50/40' : undefined)}
          />
          {hasSuppressedCells && (
            <p id={legendId} className="text-xs text-slate-600">
              <span className="font-medium italic text-amber-800">{SUPPRESSED_TEXT}</span>:{' '}
              {SUPPRESSED_EXPLANATION}
            </p>
          )}
        </>
      )}
    </div>
  );
}
