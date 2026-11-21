'use client';

import { DataTable } from '../ui/data-table';
import { useCallback, useState } from 'react';
import { googleWorkspaceApi } from '../../lib/google-workspace/api';
import {
  FIELD_LABELS,
  FORM_ID,
  isMultiValuedField,
  MAPPING_FIELDS,
  mappingFromRows,
  mappingRowsProblem,
  REQUIRED_FIELDS,
  rowsFromMapping,
  SCORE_SOURCE_LABELS,
  TARGET_LABELS,
  TARGETS,
  type MappingRow,
} from '../../lib/google-workspace/domain';
import type {
  GoogleFormBinding,
  GoogleFormBindingTarget,
  GoogleFormSource,
  GoogleScoreSource,
  GoogleSources,
  SyncResult,
} from '../../lib/google-workspace/types';
import {
  checkbox,
  dangerButton,
  dateTimeText,
  EmptyState,
  EnabledBadge,
  ErrorCodeText,
  Field,
  inputClass,
  Loading,
  primaryButton,
  RunStatusBadge,
  secondaryButton,
  Section,
  useData,
  type Mutate,
} from './google-workspace-shared';
import { useConfirm } from '../ui/use-confirm';
import { ConfirmButton } from '../ui/confirm-button';

export const RUNS_PAGE_SIZE = 10;

const EMPTY_SOURCES: GoogleSources = { performanceSources: [], recruitmentSources: [] };

function sourcesFor(sources: GoogleSources, target: GoogleFormBindingTarget): GoogleFormSource[] {
  if (target === 'PERFORMANCE_EVIDENCE') return sources.performanceSources;
  if (target === 'RECRUITMENT_INTAKE') return sources.recruitmentSources;
  return [];
}

function sourceText(binding: GoogleFormBinding, sources: GoogleSources | null) {
  const id = binding.performanceSourceId ?? binding.recruitmentSourceId;
  if (!id) return binding.target === 'ONBOARDING_TASKS' ? 'Open onboarding tasks' : '—';
  const source = [
    ...(sources?.performanceSources ?? []),
    ...(sources?.recruitmentSources ?? []),
  ].find((s) => s.id === id);
  return source ? `${source.name} (${source.code})` : 'Configured source';
}

export function syncResultMessage(result: SyncResult): string {
  if (result.status === 'SKIPPED') return 'Synchronization skipped.';
  const counts = `${result.fetched} fetched, ${result.accepted} accepted, ${result.duplicates} duplicates, ${result.rejected} rejected`;
  if (result.status === 'SUCCEEDED') return `Synchronization finished: ${counts}.`;
  if (result.status === 'PARTIAL') return `Synchronization partially finished: ${counts}.`;
  if (result.status === 'RUNNING') return 'Synchronization started.';
  return `Synchronization failed (${counts}). See the run history for the error.`;
}

export function BindingsSection({
  organizationId,
  version,
  canManage,
  connected,
  busy,
  mutate,
  onError,
  onShowRuns,
}: {
  organizationId: string;
  version: number;
  canManage: boolean;
  connected: boolean;
  busy: boolean;
  mutate: Mutate;
  onError(message: string): void;
  onShowRuns(bindingId: string): void;
}) {
  const load = useCallback(
    async () => {
      const [bindings, sources] = await Promise.all([
        googleWorkspaceApi.bindings(organizationId),
        // Sources are configuration of the managing domains (manage only).
        canManage ? googleWorkspaceApi.sources(organizationId) : Promise.resolve(null),
      ]);
      return { bindings: bindings.items, sources };
    },
    // `version` reloads after every change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [organizationId, canManage, version],
  );
  const { data, loaded } = useData(load, onError);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const bindings = data?.bindings ?? [];
  const sources = data?.sources ?? null;
  return (
    <Section
      title="Form bindings"
      actions={
        canManage &&
        !creating && (
          <button
            type="button"
            className={secondaryButton}
            disabled={busy}
            onClick={() => setCreating(true)}
          >
            New form binding
          </button>
        )
      }
    >
      <p className="text-sm text-slate-600">
        A binding feeds a Google Form’s responses into one HRMS module through its own rules.
        Responses are synchronized on a schedule; integration administrators can also sync now.
      </p>
      {!connected && bindings.length > 0 && (
        <p className="text-sm text-amber-900">
          Synchronization is paused until the organization has an active connection with the Forms
          capability.
        </p>
      )}
      {creating && (
        <CreateBindingForm
          organizationId={organizationId}
          sources={sources ?? EMPTY_SOURCES}
          busy={busy}
          mutate={mutate}
          onDone={() => setCreating(false)}
        />
      )}
      {!loaded ? (
        <Loading>Loading form bindings…</Loading>
      ) : bindings.length === 0 ? (
        <EmptyState>No Google Forms are bound to this organization.</EmptyState>
      ) : (
        <ul className="space-y-3">
          {bindings.map((binding) => (
            <BindingCard
              key={binding.id}
              binding={binding}
              sources={sources}
              canManage={canManage}
              editing={editing === binding.id}
              onEdit={() => setEditing(binding.id)}
              onCancel={() => setEditing(null)}
              busy={busy}
              mutate={mutate}
              onShowRuns={() => onShowRuns(binding.id)}
            />
          ))}
        </ul>
      )}
    </Section>
  );
}

function bindingName(binding: GoogleFormBinding) {
  return binding.formTitle || binding.formId;
}

function BindingCard({
  binding,
  sources,
  canManage,
  editing,
  onEdit,
  onCancel,
  busy,
  mutate,
  onShowRuns,
}: {
  binding: GoogleFormBinding;
  sources: GoogleSources | null;
  canManage: boolean;
  editing: boolean;
  onEdit(): void;
  onCancel(): void;
  busy: boolean;
  mutate: Mutate;
  onShowRuns(): void;
}) {
  const name = bindingName(binding);
  const [confirm, confirmDialog] = useConfirm();
  return (
    <li aria-label={`Binding ${name}`} className="space-y-3 rounded-lg border border-slate-200 p-3">
      {confirmDialog}
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-medium text-slate-900">{name}</p>
          <p className="text-xs text-slate-600">
            Form id <code>{binding.formId}</code> · {TARGET_LABELS[binding.target]} ·{' '}
            {sourceText(binding, sources)}
          </p>
        </div>
        <EnabledBadge enabled={binding.enabled} />
      </div>
      <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
        <Detail term="Last sync">{dateTimeText(binding.lastSyncAt)}</Detail>
        <Detail term="Last success">{dateTimeText(binding.lastSuccessAt)}</Detail>
        <Detail term="Last failure">{dateTimeText(binding.lastFailureAt)}</Detail>
        <Detail term="Last error">
          <ErrorCodeText code={binding.lastErrorCode} />
        </Detail>
        <Detail term="Consecutive failures">{String(binding.consecutiveFailures)}</Detail>
        <Detail term="Next sync after">
          {binding.nextSyncAfter ? dateTimeText(binding.nextSyncAfter) : 'Next scheduled run'}
        </Detail>
      </dl>
      <MappingSummary binding={binding} />
      <div className="flex flex-wrap gap-2">
        {canManage && (
          <>
            <button
              type="button"
              className={primaryButton}
              disabled={busy || !binding.enabled}
              aria-label={`Sync now ${name}`}
              onClick={() =>
                void mutate(() => googleWorkspaceApi.syncBinding(binding.id), syncResultMessage)
              }
            >
              Sync now
            </button>
            {!editing && (
              <button
                type="button"
                className={secondaryButton}
                disabled={busy}
                aria-label={`Edit mapping ${name}`}
                onClick={onEdit}
              >
                Edit mapping
              </button>
            )}
            {binding.enabled ? (
              <ConfirmButton
                className={secondaryButton}
                disabled={busy}
                aria-label={`Disable ${name}`}
                confirm={{
                  title: `Disable ${name}?`,
                  description:
                    'Nothing is synchronized through this binding until it is enabled again. Its settings and history are kept.',
                  confirmLabel: 'Disable binding',
                }}
                onConfirm={() =>
                  void mutate(
                    () => googleWorkspaceApi.updateBinding(binding.id, { enabled: false }),
                    `Binding ${name} disabled.`,
                  )
                }
              >
                Disable
              </ConfirmButton>
            ) : (
              <button
                type="button"
                className={secondaryButton}
                disabled={busy}
                aria-label={`Enable ${name}`}
                onClick={() =>
                  void mutate(
                    () => googleWorkspaceApi.updateBinding(binding.id, { enabled: true }),
                    `Binding ${name} enabled.`,
                  )
                }
              >
                Enable
              </button>
            )}
            <button
              type="button"
              className={dangerButton}
              disabled={busy}
              aria-label={`Archive ${name}`}
              onClick={async () => {
                if (
                  !(await confirm({
                    title: `Archive the binding of ${name}?`,
                    description: 'Its responses are no longer synchronized. Run history is kept.',
                    confirmLabel: 'Archive binding',
                  }))
                )
                  return;
                void mutate(
                  () => googleWorkspaceApi.archiveBinding(binding.id),
                  `Binding ${name} archived.`,
                );
              }}
            >
              Archive
            </button>
          </>
        )}
        <button
          type="button"
          className={secondaryButton}
          aria-label={`Show runs ${name}`}
          onClick={onShowRuns}
        >
          Show runs
        </button>
      </div>
      {editing && (
        <EditMappingForm binding={binding} busy={busy} mutate={mutate} onDone={onCancel} />
      )}
    </li>
  );
}

function Detail({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-semibold uppercase text-slate-500">{term}</dt>
      <dd className="text-slate-800">{children}</dd>
    </div>
  );
}

function MappingSummary({ binding }: { binding: GoogleFormBinding }) {
  const fields = binding.mapping?.fields ?? [];
  return (
    <div className="text-sm text-slate-700">
      <p className="text-xs font-semibold uppercase text-slate-500">Field mapping</p>
      {fields.length === 0 ? (
        <p>
          No questions mapped
          {binding.target !== 'RECRUITMENT_INTAKE'
            ? ' (the respondent’s collected email is used)'
            : ''}
          .
        </p>
      ) : (
        <ul aria-label={`Mapping of ${bindingName(binding)}`} className="mt-1 space-y-0.5">
          {fields.map((entry) => (
            <li key={entry.questionId}>
              <code className="rounded bg-slate-100 px-1 text-xs">{entry.questionId}</code> →{' '}
              {FIELD_LABELS[entry.field] ?? entry.field}
              {entry.label ? ` (“${entry.label}”)` : ''}
            </li>
          ))}
        </ul>
      )}
      {binding.target === 'PERFORMANCE_EVIDENCE' && (
        <p className="mt-1">
          Score: {SCORE_SOURCE_LABELS[binding.mapping?.scoreSource ?? 'QUIZ_TOTAL']}
        </p>
      )}
    </div>
  );
}

function MappingEditor({
  target,
  rows,
  onRows,
  scoreSource,
  onScoreSource,
  disabled,
}: {
  target: GoogleFormBindingTarget;
  rows: MappingRow[];
  onRows(rows: MappingRow[]): void;
  scoreSource: GoogleScoreSource;
  onScoreSource(value: GoogleScoreSource): void;
  disabled: boolean;
}) {
  const fields = MAPPING_FIELDS[target];
  const update = (index: number, patch: Partial<MappingRow>) =>
    onRows(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  const required = REQUIRED_FIELDS[target];
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium text-slate-800">Field mapping</legend>
      <p className="text-xs text-slate-600">
        Map each form question (its question id, from the form’s structure) to a field of{' '}
        {TARGET_LABELS[target].toLowerCase()}.
        {required.length > 0 &&
          ` Required: ${required.map((f) => FIELD_LABELS[f] ?? f).join(', ')}.`}
      </p>
      {rows.length === 0 && <p className="text-sm text-slate-600">No questions mapped yet.</p>}
      <ol className="space-y-2">
        {rows.map((row, index) => (
          <li key={index} className="grid gap-2 sm:grid-cols-[1fr_1fr_1fr_auto] sm:items-end">
            <Field label={`Question id ${index + 1}`}>
              <input
                className={inputClass}
                value={row.questionId}
                disabled={disabled}
                maxLength={64}
                onChange={(event) => update(index, { questionId: event.currentTarget.value })}
              />
            </Field>
            <Field label={`Field ${index + 1}`}>
              <select
                className={inputClass}
                value={row.field}
                disabled={disabled}
                onChange={(event) => {
                  const field = event.currentTarget.value;
                  update(index, { field, ...(isMultiValuedField(field) ? {} : { label: '' }) });
                }}
              >
                <option value="">Choose a field</option>
                {fields.map((field) => (
                  <option key={field} value={field}>
                    {FIELD_LABELS[field] ?? field}
                  </option>
                ))}
              </select>
            </Field>
            {isMultiValuedField(row.field) ? (
              <Field label={`Label ${index + 1} (optional)`}>
                <input
                  className={inputClass}
                  value={row.label}
                  disabled={disabled}
                  maxLength={200}
                  onChange={(event) => update(index, { label: event.currentTarget.value })}
                />
              </Field>
            ) : (
              <span />
            )}
            <button
              type="button"
              className={secondaryButton}
              disabled={disabled}
              aria-label={`Remove question ${index + 1}`}
              onClick={() => onRows(rows.filter((_, i) => i !== index))}
            >
              Remove
            </button>
          </li>
        ))}
      </ol>
      <button
        type="button"
        className={secondaryButton}
        disabled={disabled || rows.length >= 100}
        onClick={() => onRows([...rows, { questionId: '', field: '', label: '' }])}
      >
        Add question
      </button>
      {target === 'PERFORMANCE_EVIDENCE' && (
        <Field label="Score">
          <select
            className={inputClass}
            value={scoreSource}
            disabled={disabled}
            onChange={(event) => onScoreSource(event.currentTarget.value as GoogleScoreSource)}
          >
            {(Object.keys(SCORE_SOURCE_LABELS) as GoogleScoreSource[]).map((value) => (
              <option key={value} value={value}>
                {SCORE_SOURCE_LABELS[value]}
              </option>
            ))}
          </select>
        </Field>
      )}
    </fieldset>
  );
}

function CreateBindingForm({
  organizationId,
  sources,
  busy,
  mutate,
  onDone,
}: {
  organizationId: string;
  sources: GoogleSources;
  busy: boolean;
  mutate: Mutate;
  onDone(): void;
}) {
  const [target, setTarget] = useState<GoogleFormBindingTarget>('PERFORMANCE_EVIDENCE');
  const [sourceId, setSourceId] = useState('');
  const [formId, setFormId] = useState('');
  const [rows, setRows] = useState<MappingRow[]>([]);
  const [scoreSource, setScoreSource] = useState<GoogleScoreSource>('QUIZ_TOTAL');
  const [enabled, setEnabled] = useState(true);
  const [submitted, setSubmitted] = useState(false);
  const options = sourcesFor(sources, target);
  const needsSource = target !== 'ONBOARDING_TASKS';
  const problem =
    (needsSource && !sourceId
      ? options.length === 0
        ? `No Google Forms source is configured for ${TARGET_LABELS[target].toLowerCase()}. Configure one in that module first.`
        : 'Choose the source this form feeds.'
      : null) ??
    (!FORM_ID.test(formId.trim())
      ? 'Enter the form id: 10–200 letters, digits, "_" or "-" (from the form’s edit link).'
      : null) ??
    mappingRowsProblem(target, rows);

  return (
    <form
      aria-label="New form binding"
      className="space-y-3 rounded-lg border border-indigo-200 bg-white p-4"
      onSubmit={async (event) => {
        event.preventDefault();
        setSubmitted(true);
        if (problem) return;
        const created = await mutate(
          () =>
            googleWorkspaceApi.createBinding({
              organizationId,
              formId: formId.trim(),
              target,
              ...(target === 'PERFORMANCE_EVIDENCE' ? { performanceSourceId: sourceId } : {}),
              ...(target === 'RECRUITMENT_INTAKE' ? { recruitmentSourceId: sourceId } : {}),
              mapping: mappingFromRows(target, rows, scoreSource),
              enabled,
            }),
          (binding: GoogleFormBinding) => `Form ${bindingName(binding)} bound.`,
        );
        if (created) onDone();
      }}
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Target">
          <select
            className={inputClass}
            value={target}
            disabled={busy}
            onChange={(event) => {
              const next = event.currentTarget.value as GoogleFormBindingTarget;
              setTarget(next);
              setSourceId('');
              // Fields of another target do not carry over.
              setRows((current) =>
                current.map((row) =>
                  MAPPING_FIELDS[next].includes(row.field) ? row : { ...row, field: '', label: '' },
                ),
              );
            }}
          >
            {TARGETS.map((value) => (
              <option key={value} value={value}>
                {TARGET_LABELS[value]}
              </option>
            ))}
          </select>
        </Field>
        {needsSource ? (
          <Field label="Source">
            <select
              className={inputClass}
              value={sourceId}
              disabled={busy}
              onChange={(event) => {
                const id = event.currentTarget.value;
                setSourceId(id);
                const source = options.find((s) => s.id === id);
                if (source?.formId) setFormId(source.formId);
              }}
            >
              <option value="">Choose a source</option>
              {options.map((source) => (
                <option key={source.id} value={source.id}>
                  {source.name} ({source.code})
                </option>
              ))}
            </select>
          </Field>
        ) : (
          <p className="text-sm text-slate-600 sm:pt-6">
            Responses complete the respondent’s open onboarding task linked to this form.
          </p>
        )}
        <Field label="Google Form id">
          <input
            className={inputClass}
            value={formId}
            disabled={busy}
            maxLength={200}
            onChange={(event) => setFormId(event.currentTarget.value)}
          />
        </Field>
      </div>
      <MappingEditor
        target={target}
        rows={rows}
        onRows={setRows}
        scoreSource={scoreSource}
        onScoreSource={setScoreSource}
        disabled={busy}
      />
      <label className="flex items-center gap-3 text-sm text-slate-800">
        <input
          type="checkbox"
          className={checkbox}
          checked={enabled}
          disabled={busy}
          onChange={(event) => setEnabled(event.currentTarget.checked)}
        />
        Enabled (synchronize on schedule)
      </label>
      {submitted && problem && (
        <p role="alert" className="text-sm text-rose-800">
          {problem}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button type="submit" className={primaryButton} disabled={busy}>
          Create binding
        </button>
        <button type="button" className={secondaryButton} disabled={busy} onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function EditMappingForm({
  binding,
  busy,
  mutate,
  onDone,
}: {
  binding: GoogleFormBinding;
  busy: boolean;
  mutate: Mutate;
  onDone(): void;
}) {
  const [rows, setRows] = useState<MappingRow[]>(() => rowsFromMapping(binding.mapping));
  const [scoreSource, setScoreSource] = useState<GoogleScoreSource>(
    binding.mapping?.scoreSource ?? 'QUIZ_TOTAL',
  );
  const [submitted, setSubmitted] = useState(false);
  const problem = mappingRowsProblem(binding.target, rows);
  const name = bindingName(binding);
  return (
    <form
      aria-label={`Edit mapping ${name}`}
      className="space-y-3 rounded-lg border border-indigo-200 bg-white p-4"
      onSubmit={async (event) => {
        event.preventDefault();
        setSubmitted(true);
        if (problem) return;
        const saved = await mutate(
          () =>
            googleWorkspaceApi.updateBinding(binding.id, {
              mapping: mappingFromRows(binding.target, rows, scoreSource),
            }),
          `Mapping of ${name} saved.`,
        );
        if (saved) onDone();
      }}
    >
      <MappingEditor
        target={binding.target}
        rows={rows}
        onRows={setRows}
        scoreSource={scoreSource}
        onScoreSource={setScoreSource}
        disabled={busy}
      />
      {submitted && problem && (
        <p role="alert" className="text-sm text-rose-800">
          {problem}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button type="submit" className={primaryButton} disabled={busy}>
          Save mapping
        </button>
        <button type="button" className={secondaryButton} disabled={busy} onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}

// ─── Sync runs ──────────────────────────────────────────────────────────────

export function SyncRunsSection({
  organizationId,
  version,
  bindingId,
  onBindingChange,
  onError,
}: {
  organizationId: string;
  version: number;
  bindingId: string | null;
  onBindingChange(bindingId: string | null): void;
  onError(message: string): void;
}) {
  const [page, setPage] = useState({ bindingId, offset: 0 });
  // A new filter starts from the first page.
  const offset = page.bindingId === bindingId ? page.offset : 0;
  const load = useCallback(
    async () => {
      const [runs, bindings] = await Promise.all([
        googleWorkspaceApi.syncRuns({
          organizationId,
          bindingId,
          limit: RUNS_PAGE_SIZE,
          offset,
        }),
        googleWorkspaceApi.bindings(organizationId, true),
      ]);
      return { runs, bindings: bindings.items };
    },
    // `version` reloads after every change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [organizationId, bindingId, offset, version],
  );
  const { data, loaded } = useData(load, onError);
  const names = new Map((data?.bindings ?? []).map((b) => [b.id, bindingName(b)]));
  const runs = data?.runs;
  const total = runs?.total ?? 0;
  const first = total === 0 ? 0 : offset + 1;
  const last = Math.min(offset + (runs?.items.length ?? 0), total);
  return (
    <Section title="Synchronization history">
      <label className="block max-w-sm text-sm font-medium text-slate-800">
        Form
        <select
          className={inputClass}
          value={bindingId ?? ''}
          onChange={(event) => onBindingChange(event.currentTarget.value || null)}
        >
          <option value="">All forms</option>
          {(data?.bindings ?? []).map((binding) => (
            <option key={binding.id} value={binding.id}>
              {bindingName(binding)}
              {binding.archivedAt ? ' (archived)' : ''}
            </option>
          ))}
        </select>
      </label>
      {!loaded ? (
        <Loading>Loading synchronization history…</Loading>
      ) : !runs || runs.items.length === 0 ? (
        <EmptyState>No synchronizations yet.</EmptyState>
      ) : (
        <>
          <DataTable
            label="Synchronization runs"
            rows={runs.items}
            rowKey={(run) => run.id}
            columns={[
              {
                key: 'started',
                header: 'Started',
                cell: (run) => <>{dateTimeText(run.startedAt)}</>,
              },
              {
                key: 'form',
                header: 'Form',
                cell: (run) => <>{names.get(run.bindingId) ?? 'Form binding'}</>,
              },
              {
                key: 'trigger',
                header: 'Trigger',
                cell: (run) => <>{run.trigger === 'MANUAL' ? 'Manual' : 'Scheduled'}</>,
              },
              {
                key: 'status',
                header: 'Status',
                cell: (run) => (
                  <>
                    <RunStatusBadge status={run.status} />
                  </>
                ),
              },
              {
                key: 'fetched',
                header: 'Fetched',
                cell: (run) => <>{run.fetched}</>,
              },
              {
                key: 'accepted',
                header: 'Accepted',
                cell: (run) => <>{run.accepted}</>,
              },
              {
                key: 'duplicates',
                header: 'Duplicates',
                cell: (run) => <>{run.duplicates}</>,
              },
              {
                key: 'rejected',
                header: 'Rejected',
                cell: (run) => <>{run.rejected}</>,
              },
              {
                key: 'error',
                header: 'Error',
                cell: (run) => (
                  <>
                    <ErrorCodeText code={run.errorCode} />
                  </>
                ),
              },
            ]}
          />
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-slate-700">
            <span>
              Showing {first}–{last} of {total}
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                className={secondaryButton}
                disabled={offset === 0}
                onClick={() => setPage({ bindingId, offset: Math.max(offset - RUNS_PAGE_SIZE, 0) })}
              >
                Previous
              </button>
              <button
                type="button"
                className={secondaryButton}
                disabled={offset + RUNS_PAGE_SIZE >= total}
                onClick={() => setPage({ bindingId, offset: offset + RUNS_PAGE_SIZE })}
              >
                Next
              </button>
            </div>
          </div>
        </>
      )}
    </Section>
  );
}
