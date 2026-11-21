'use client';

import { parseJsonArray } from '../../../lib/ui/json-import';
import { useCallback, useEffect, useState } from 'react';
import { recruitmentApi } from '../../../lib/recruitment/api';
import { recruitmentErrorMessage } from '../../../lib/recruitment/errors';
import type {
  IngestionReport,
  IntakeProvider,
  IntakeSource,
  IntakeStatus,
  IntakeSubmission,
  Opening,
} from '../../../lib/recruitment/types';
import {
  dateTimeText,
  EmptyState,
  Field,
  inputClass,
  label,
  primaryButton,
  secondaryButton,
} from '../recruitment-shared';
import { ConfirmButton } from '../../ui/confirm-button';
import { Loading, Mutate, appLink, useData } from './admin-shared';
import { DataTable } from '../../ui/data-table';

// Batch 10E-1: intake sources, imports and the submission queue (moved from
// recruitment-admin-page.tsx unchanged).
const INTAKE_PROVIDERS: Record<IntakeProvider, string> = {
  GOOGLE_FORMS: 'Google Forms',
  CAREERS_SITE: 'Careers site',
  MANUAL_IMPORT: 'Manual import',
  OTHER: 'Other',
};

export interface IntakeFilter {
  status: IntakeStatus;
  sourceId: string;
}
const INTAKE_STATUS_LABELS: Record<IntakeStatus, string> = {
  PENDING_OPENING: 'Waiting for an opening',
  REJECTED: 'Rejected',
  APPLIED: 'Applied',
};
const INTAKE_PAGE = 50;

/** Batch 7A: the import report, kept by the page so the refresh after an import keeps it. */
function ImportReport({
  report,
  sourceName,
  onDismiss,
}: {
  report: IngestionReport;
  sourceName: string;
  onDismiss(): void;
}) {
  const counts = Object.entries(report.counts).filter(([, count]) => count > 0);
  return (
    <section
      aria-label="Import report"
      className="space-y-2 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-950"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p role="status">
          {sourceName}: {report.received} received
          {counts.length > 0 ? ': ' : '.'}
          {counts.map(([outcome, count]) => `${count} ${label(outcome).toLowerCase()}`).join(', ')}
        </p>
        <button type="button" className={secondaryButton} onClick={onDismiss}>
          Dismiss report
        </button>
      </div>
      {report.outcomes.some((outcome) => outcome.reason) && (
        <ul className="space-y-1">
          {report.outcomes
            .filter((outcome) => outcome.reason)
            .map((outcome) => (
              <li key={outcome.externalResponseId}>
                {outcome.externalResponseId}: {label(outcome.outcome)} — {label(outcome.reason)}
              </li>
            ))}
        </ul>
      )}
    </section>
  );
}

export function IntakeTab({
  organizationId,
  report,
  onReport,
  filter,
  onFilter,
  busy,
  mutate,
  onError,
}: {
  organizationId: string;
  report: IngestionReport | null;
  onReport(report: IngestionReport | null): void;
  filter: IntakeFilter;
  onFilter(filter: IntakeFilter): void;
  busy: boolean;
  mutate: Mutate;
  onError(message: string): void;
}) {
  const load = useCallback(async () => {
    const [sources, openings] = await Promise.all([
      recruitmentApi.intakeSources(organizationId),
      recruitmentApi.openings(organizationId, { status: 'OPEN' }),
    ]);
    return { sources: sources.items, openings: openings.items };
  }, [organizationId]);
  const { data, loaded } = useData(load, onError);
  const [form, setForm] = useState({
    code: '',
    name: '',
    provider: 'GOOGLE_FORMS' as IntakeProvider,
    externalResourceId: '',
    resourceUrl: '',
    defaultOpeningId: '',
  });
  const [importing, setImporting] = useState<string | null>(null);
  const [editing, setEditing] = useState<IntakeSource | null>(null);
  const [payload, setPayload] = useState('');
  const [payloadError, setPayloadError] = useState<string | null>(null);
  if (!loaded) return <Loading />;
  const sources: IntakeSource[] = data?.sources ?? [];
  const openings: Opening[] = data?.openings ?? [];
  const openingName = (id: string | null) =>
    id ? (openings.find((o) => o.id === id)?.title ?? 'An opening that is not open') : '—';
  const sourceName = (id: string) => sources.find((source) => source.id === id)?.name ?? 'Source';
  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-600">
        An intake source is an external application form (for example the Google Form for staff
        applications). Its submissions are imported or synchronized, deduplicated per response and
        turned into applications; submissions without an open opening wait below.
      </p>
      {report && (
        <ImportReport
          report={report}
          sourceName={sourceName(report.sourceId)}
          onDismiss={() => onReport(null)}
        />
      )}
      <h2 className="text-base font-semibold text-slate-900">Sources</h2>
      {sources.length === 0 ? (
        <EmptyState>No intake sources yet.</EmptyState>
      ) : (
        <DataTable
          label="Intake sources"
          rows={sources}
          rowKey={(source) => source.id}
          columns={[
            {
              key: 'source',
              header: 'Source',
              rowHeader: true,
              cell: (source) => (
                <>
                  {source.name}
                  <span className="block text-xs font-normal text-slate-500">
                    {source.code}
                    {source.externalResourceId ? ` · ${source.externalResourceId}` : ''}
                    {source.archivedAt ? ' · Archived' : ''}
                  </span>
                </>
              ),
            },
            {
              key: 'provider',
              header: 'Provider',
              cell: (source) => <>{INTAKE_PROVIDERS[source.provider]}</>,
            },
            {
              key: 'opening',
              header: 'Default opening',
              cell: (source) => <>{openingName(source.defaultOpeningId)}</>,
            },
            {
              key: 'waiting',
              header: 'Waiting',
              cell: (source) => <>{source.pendingOpening ?? 0}</>,
            },
            {
              key: 'sync',
              header: 'Last sync',
              cell: (source) => (
                <>
                  {source.lastSyncedAt
                    ? `${dateTimeText(source.lastSyncedAt)} (${source.lastSyncStatus ?? ''})`
                    : 'Never'}
                </>
              ),
            },
            {
              key: 'actions',
              header: <span className="sr-only">Actions</span>,
              className: 'space-x-1 whitespace-nowrap',
              cell: (source) => (
                <>
                  {!source.archivedAt && (
                    <>
                      <button
                        type="button"
                        className={secondaryButton}
                        aria-label={`Import submissions into ${source.name}`}
                        onClick={() => {
                          setImporting(source.id);
                          setEditing(null);
                        }}
                      >
                        Import submissions
                      </button>
                      <button
                        type="button"
                        className={secondaryButton}
                        aria-label={`Edit ${source.name}`}
                        onClick={() => {
                          setEditing(source);
                          setImporting(null);
                        }}
                      >
                        Edit
                      </button>
                      <ConfirmButton
                        className={secondaryButton}
                        disabled={busy}
                        aria-label={`Archive ${source.name}`}
                        confirm={{
                          title: `Archive ${source.name}?`,
                          description:
                            'The source stops accepting new submissions. Submissions already received are kept.',
                          confirmLabel: 'Archive source',
                          destructive: true,
                        }}
                        onConfirm={() =>
                          void mutate(
                            () => recruitmentApi.archiveIntakeSource(source.id),
                            'Intake source archived.',
                          )
                        }
                      >
                        Archive
                      </ConfirmButton>
                    </>
                  )}
                </>
              ),
            },
          ]}
        />
      )}
      {editing && (
        <IntakeSourceEditor
          key={editing.id}
          source={editing}
          openings={openings}
          busy={busy}
          mutate={mutate}
          onDone={() => setEditing(null)}
        />
      )}
      {importing && (
        <form
          aria-label="Import submissions"
          className="space-y-2 rounded-xl border border-slate-200 bg-white p-4"
          onSubmit={(event) => {
            event.preventDefault();
            const parsed = parseJsonArray(payload);
            if (!parsed.ok) {
              setPayloadError(parsed.message);
              return;
            }
            setPayloadError(null);
            const submissions = parsed.items;
            onReport(null);
            void mutate(async () => {
              onReport(await recruitmentApi.importSubmissions(importing, submissions));
            }, 'Submissions imported.');
          }}
        >
          <h2 className="text-base font-semibold text-slate-900">
            Import submissions into {sourceName(importing)}
          </h2>
          <Field label="Submissions (JSON array of { externalResponseId, submittedAt, openingCode, candidate })">
            <textarea
              className={inputClass}
              rows={6}
              value={payload}
              aria-invalid={payloadError ? true : undefined}
              aria-describedby={payloadError ? 'import-payload-error' : undefined}
              onChange={(e) => {
                setPayload(e.currentTarget.value);
                setPayloadError(null);
              }}
            />
          </Field>
          {payloadError && (
            <p id="import-payload-error" role="alert" className="text-sm text-rose-800">
              {payloadError}
            </p>
          )}
          <div className="flex gap-2">
            <button type="submit" className={primaryButton} disabled={busy}>
              Import
            </button>
            <button type="button" className={secondaryButton} onClick={() => setImporting(null)}>
              Cancel import
            </button>
          </div>
        </form>
      )}
      <form
        aria-label="Add intake source"
        className="grid grid-cols-1 gap-3 rounded-xl border border-slate-200 bg-white p-4 sm:grid-cols-3"
        onSubmit={(event) => {
          event.preventDefault();
          void mutate(
            () =>
              recruitmentApi.createIntakeSource({
                organizationId,
                code: form.code.trim(),
                name: form.name.trim(),
                provider: form.provider,
                externalResourceId: form.externalResourceId.trim() || null,
                resourceUrl: form.resourceUrl.trim() || null,
                defaultOpeningId: form.defaultOpeningId || null,
              }),
            'Intake source added.',
          );
        }}
      >
        <Field label="Code">
          <input
            className={inputClass}
            required
            value={form.code}
            onChange={(e) => setForm({ ...form, code: e.currentTarget.value })}
          />
        </Field>
        <Field label="Source name">
          <input
            className={inputClass}
            required
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.currentTarget.value })}
          />
        </Field>
        <Field label="Provider">
          <select
            className={inputClass}
            value={form.provider}
            onChange={(e) =>
              setForm({ ...form, provider: e.currentTarget.value as IntakeProvider })
            }
          >
            {(Object.keys(INTAKE_PROVIDERS) as IntakeProvider[]).map((provider) => (
              <option key={provider} value={provider}>
                {INTAKE_PROVIDERS[provider]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="External resource ID (e.g. the Google Form ID)">
          <input
            className={inputClass}
            value={form.externalResourceId}
            onChange={(e) => setForm({ ...form, externalResourceId: e.currentTarget.value })}
          />
        </Field>
        <Field label="Form link (https)">
          <input
            className={inputClass}
            type="url"
            value={form.resourceUrl}
            onChange={(e) => setForm({ ...form, resourceUrl: e.currentTarget.value })}
          />
        </Field>
        <Field label="Default opening">
          <OpeningSelect
            openings={openings}
            value={form.defaultOpeningId}
            onChange={(defaultOpeningId) => setForm({ ...form, defaultOpeningId })}
          />
        </Field>
        <div>
          <button type="submit" className={primaryButton} disabled={busy}>
            Add source
          </button>
        </div>
      </form>
      <h2 className="text-base font-semibold text-slate-900">Submissions</h2>
      <IntakeSubmissions
        organizationId={organizationId}
        sources={sources}
        openings={openings}
        filter={filter}
        onFilter={onFilter}
        busy={busy}
        mutate={mutate}
        onError={onError}
      />
    </div>
  );
}

function OpeningSelect({
  openings,
  value,
  onChange,
}: {
  openings: Opening[];
  value: string;
  onChange(value: string): void;
}) {
  return (
    <select className={inputClass} value={value} onChange={(e) => onChange(e.currentTarget.value)}>
      <option value="">None (by requisition code)</option>
      {openings.map((opening) => (
        <option key={opening.id} value={opening.id}>
          {opening.title} ({opening.code})
        </option>
      ))}
    </select>
  );
}

/** Batch 7A — edit a source's name, form link and default opening (code and provider are fixed). */
function IntakeSourceEditor({
  source,
  openings,
  busy,
  mutate,
  onDone,
}: {
  source: IntakeSource;
  openings: Opening[];
  busy: boolean;
  mutate: Mutate;
  onDone(): void;
}) {
  const [form, setForm] = useState({
    name: source.name,
    resourceUrl: source.resourceUrl ?? '',
    defaultOpeningId: source.defaultOpeningId ?? '',
  });
  const urlInvalid =
    form.resourceUrl.trim() !== '' && !/^https:\/\//i.test(form.resourceUrl.trim());
  return (
    <form
      aria-label={`Edit ${source.name}`}
      className="grid grid-cols-1 gap-3 rounded-xl border border-slate-200 bg-white p-4 sm:grid-cols-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (urlInvalid) return;
        void mutate(
          () =>
            recruitmentApi.updateIntakeSource(source.id, {
              name: form.name.trim(),
              resourceUrl: form.resourceUrl.trim() || null,
              defaultOpeningId: form.defaultOpeningId || null,
            }),
          'Intake source updated.',
        ).then((ok) => ok && onDone());
      }}
    >
      <h2 className="text-base font-semibold text-slate-900 sm:col-span-3">
        Edit {source.name}
        <span className="block text-xs font-normal text-slate-500">
          {source.code} · {INTAKE_PROVIDERS[source.provider]} (fixed)
        </span>
      </h2>
      <Field label="Source name">
        <input
          className={inputClass}
          required
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.currentTarget.value })}
        />
      </Field>
      <Field label="Form link (https)">
        <input
          className={inputClass}
          type="url"
          value={form.resourceUrl}
          aria-invalid={urlInvalid ? true : undefined}
          onChange={(e) => setForm({ ...form, resourceUrl: e.currentTarget.value })}
        />
      </Field>
      <Field label="Default opening">
        <select
          className={inputClass}
          value={form.defaultOpeningId}
          onChange={(e) => setForm({ ...form, defaultOpeningId: e.currentTarget.value })}
        >
          <option value="">None (by requisition code)</option>
          {/* A default opening that is no longer open stays chosen until changed. */}
          {form.defaultOpeningId && !openings.some((o) => o.id === form.defaultOpeningId) && (
            <option value={form.defaultOpeningId}>Current opening (not open)</option>
          )}
          {openings.map((opening) => (
            <option key={opening.id} value={opening.id}>
              {opening.title} ({opening.code})
            </option>
          ))}
        </select>
      </Field>
      {urlInvalid && (
        <p role="alert" className="text-sm text-rose-800 sm:col-span-3">
          Form links must start with https://.
        </p>
      )}
      <div className="flex gap-2 sm:col-span-3">
        <button type="submit" className={primaryButton} disabled={busy || urlInvalid}>
          Save source
        </button>
        <button type="button" className={secondaryButton} onClick={onDone}>
          Cancel editing
        </button>
      </div>
    </form>
  );
}

/**
 * Batch 7A — the intake queue (waiting for an opening) and its history (rejected, applied),
 * filtered by status and source, a page at a time ("Load more").
 */
function IntakeSubmissions({
  organizationId,
  sources,
  openings,
  filter,
  onFilter,
  busy,
  mutate,
  onError,
}: {
  organizationId: string;
  sources: IntakeSource[];
  openings: Opening[];
  filter: IntakeFilter;
  onFilter(filter: IntakeFilter): void;
  busy: boolean;
  mutate: Mutate;
  onError(message: string): void;
}) {
  const [state, setState] = useState<{
    key: string;
    items: IntakeSubmission[];
    next: string | null;
    loaded: boolean;
  }>({ key: '', items: [], next: null, loaded: false });
  const [loadingMore, setLoadingMore] = useState(false);
  const key = `${organizationId}|${filter.status}|${filter.sourceId}`;
  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      recruitmentApi
        .intake(organizationId, {
          status: filter.status,
          sourceId: filter.sourceId || undefined,
          limit: INTAKE_PAGE,
        })
        .then((page) => {
          if (active) setState({ key, items: page.items, next: page.nextAfterId, loaded: true });
        })
        .catch((cause) => {
          if (!active) return;
          onError(recruitmentErrorMessage(cause));
          setState({ key, items: [], next: null, loaded: true });
        });
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [organizationId, filter.status, filter.sourceId, key, onError]);

  function loadMore() {
    const cursor = state.next;
    if (!cursor) return;
    const pageKey = state.key;
    setLoadingMore(true);
    recruitmentApi
      .intake(organizationId, {
        status: filter.status,
        sourceId: filter.sourceId || undefined,
        limit: INTAKE_PAGE,
        afterId: cursor,
      })
      .then((page) =>
        // A page of an earlier filter is never appended.
        setState((current) =>
          current.key === pageKey
            ? { ...current, items: [...current.items, ...page.items], next: page.nextAfterId }
            : current,
        ),
      )
      .catch((cause) => onError(recruitmentErrorMessage(cause)))
      .finally(() => setLoadingMore(false));
  }

  const ready = state.loaded && state.key === key;
  const sourceName = (id: string) => sources.find((source) => source.id === id)?.name ?? '—';
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Submission status">
          <select
            className={inputClass}
            value={filter.status}
            onChange={(e) => onFilter({ ...filter, status: e.currentTarget.value as IntakeStatus })}
          >
            {(Object.keys(INTAKE_STATUS_LABELS) as IntakeStatus[]).map((status) => (
              <option key={status} value={status}>
                {INTAKE_STATUS_LABELS[status]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Source">
          <select
            className={inputClass}
            value={filter.sourceId}
            onChange={(e) => onFilter({ ...filter, sourceId: e.currentTarget.value })}
          >
            <option value="">All sources</option>
            {sources.map((source) => (
              <option key={source.id} value={source.id}>
                {source.name}
                {source.archivedAt ? ' (archived)' : ''}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {!ready ? (
        <Loading />
      ) : state.items.length === 0 ? (
        <EmptyState>
          {filter.status === 'PENDING_OPENING'
            ? 'Every external submission has an opening.'
            : `No ${INTAKE_STATUS_LABELS[filter.status].toLowerCase()} submissions.`}
        </EmptyState>
      ) : filter.status === 'PENDING_OPENING' ? (
        <IntakeQueue queue={state.items} openings={openings} busy={busy} mutate={mutate} />
      ) : (
        <DataTable
          label="Intake submissions"
          minWidth="min-w-[760px]"
          rows={state.items}
          rowKey={(item) => item.id}
          columns={[
            {
              key: 'applicant',
              header: 'Applicant',
              rowHeader: true,
              cell: (item) => (
                <>
                  {applicantName(item)}
                  <span className="block text-xs font-normal text-slate-500">
                    {item.submission.candidate.email ?? '—'}
                  </span>
                </>
              ),
            },
            { key: 'source', header: 'Source', cell: (item) => sourceName(item.sourceId) },
            {
              key: 'opening',
              header: 'Requested opening',
              cell: (item) => item.submission.openingCode ?? '—',
            },
            {
              key: 'outcome',
              header: 'Outcome',
              cell: (item) =>
                item.applicationId
                  ? appLink(item.applicationId, 'Open application')
                  : item.reason
                    ? item.reason
                    : label(item.status),
            },
            {
              key: 'submitted',
              header: 'Submitted',
              cell: (item) => dateTimeText(item.submittedAt),
            },
            {
              key: 'resolved',
              header: 'Resolved',
              cell: (item) => (item.resolvedAt ? dateTimeText(item.resolvedAt) : '—'),
            },
          ]}
        />
      )}
      {ready && state.next && (
        <button type="button" className={secondaryButton} disabled={loadingMore} onClick={loadMore}>
          {loadingMore ? 'Loading…' : 'Load more submissions'}
        </button>
      )}
    </div>
  );
}

/** The applicant's name as submitted (the response id when the form had no name). */
function applicantName(item: IntakeSubmission) {
  const person = item.submission.candidate;
  return `${person.firstName} ${person.lastName}`.trim() || item.externalResponseId;
}

function IntakeQueue({
  queue,
  openings,
  busy,
  mutate,
}: {
  queue: IntakeSubmission[];
  openings: Opening[];
  busy: boolean;
  mutate: Mutate;
}) {
  const [assign, setAssign] = useState<Record<string, string>>({});
  return (
    <DataTable
      label="Submissions waiting for an opening"
      minWidth="min-w-[820px]"
      rows={queue}
      rowKey={(item) => item.id}
      columns={[
        {
          key: 'applicant',
          header: 'Applicant',
          rowHeader: true,
          cell: (item) => (
            <>
              {applicantName(item)}
              <span className="block text-xs font-normal text-slate-500">
                {item.submission.candidate.email ?? '—'}
              </span>
            </>
          ),
        },
        {
          key: 'opening',
          header: 'Requested opening',
          cell: (item) => item.submission.openingCode ?? '—',
        },
        { key: 'reason', header: 'Why waiting', cell: (item) => label(item.reason) },
        { key: 'submitted', header: 'Submitted', cell: (item) => dateTimeText(item.submittedAt) },
        {
          key: 'assign',
          header: 'Assign',
          className: 'whitespace-nowrap',
          cell: (item) => {
            const name = applicantName(item);
            return (
              <>
                <label className="relative text-xs text-slate-600">
                  <span className="sr-only">Opening for {name}</span>
                  <select
                    className="rounded border border-slate-300 px-2 py-1"
                    value={assign[item.id] ?? ''}
                    onChange={(e) => {
                      const value = e.currentTarget.value;
                      setAssign((current) => ({ ...current, [item.id]: value }));
                    }}
                  >
                    <option value="">Choose opening</option>
                    {openings.map((opening) => (
                      <option key={opening.id} value={opening.id}>
                        {opening.title} ({opening.code})
                      </option>
                    ))}
                  </select>
                </label>{' '}
                <button
                  type="button"
                  className={primaryButton}
                  disabled={busy || !assign[item.id]}
                  aria-label={`Assign ${name}`}
                  onClick={() =>
                    void mutate(
                      () => recruitmentApi.assignOpening(item.id, assign[item.id]!),
                      'Submission assigned to the opening.',
                    )
                  }
                >
                  Assign
                </button>
              </>
            );
          },
        },
        {
          key: 'reject',
          header: 'Reject',
          className: 'whitespace-nowrap',
          cell: (item) => {
            const name = applicantName(item);
            return (
              <>
                <ConfirmButton
                  className={secondaryButton}
                  disabled={busy}
                  aria-label={`Reject ${name}`}
                  confirm={{
                    title: `Reject the submission from ${name}?`,
                    description:
                      'No application is created from it. It stays in the intake history.',
                    confirmLabel: 'Reject submission',
                    destructive: true,
                    reason: { label: 'Reason', required: true, maxLength: 1000 },
                  }}
                  onConfirm={(reason) =>
                    void mutate(
                      () => recruitmentApi.rejectSubmission(item.id, reason),
                      'Submission rejected.',
                    )
                  }
                >
                  Reject
                </ConfirmButton>
              </>
            );
          },
        },
      ]}
    />
  );
}
