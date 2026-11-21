'use client';

import { useState } from 'react';
import { performanceApi } from '../../../lib/performance/api';
import type {
  EvidenceKind,
  EvidenceProvider,
  EvidenceSource,
  IngestionReport,
} from '../../../lib/performance/types';
import { parseJsonArray } from '../../../lib/ui/json-import';
import { FormDialog } from '../../ui/form-dialog';
import { useConfirm } from '../../ui/use-confirm';
import {
  dateTimeText,
  EmptyState,
  inputClass,
  label,
  primaryButton,
  PROVIDER_LABELS,
  secondaryButton,
} from '../performance-shared';
import { Field, SectionState, useSectionData, type SectionProps } from './shared';
import { DataTable } from '../../ui/data-table';

const PROVIDERS: EvidenceProvider[] = ['GOOGLE_FORMS', 'TRAINING', 'CERTIFICATION', 'OTHER'];
export const EVIDENCE_KINDS: EvidenceKind[] = [
  'ASSESSMENT',
  'TRAINING',
  'CERTIFICATION',
  'POLICY_ACKNOWLEDGEMENT',
  'OTHER',
];

/** Evidence sources: list, add, edit, archive and result import. */
export function EvidenceSourcesTab({ organizationId, busy, mutate, version }: SectionProps) {
  const { data, error, loading, reload } = useSectionData(
    async () => (await performanceApi.evidenceSources(organizationId)).items,
    [organizationId, version],
  );
  const [form, setForm] = useState({
    code: '',
    name: '',
    provider: 'GOOGLE_FORMS' as EvidenceProvider,
    kind: 'ASSESSMENT' as EvidenceKind,
    externalResourceId: '',
    passThresholdPercent: '',
  });
  const [importing, setImporting] = useState<string | null>(null);
  const [editing, setEditing] = useState<EvidenceSource | null>(null);
  const [payload, setPayload] = useState('');
  const [payloadError, setPayloadError] = useState<string | null>(null);
  const [report, setReport] = useState<IngestionReport | null>(null);
  const [confirm, confirmDialog] = useConfirm();
  const sources = data ?? [];
  const importingSource = sources.find((s) => s.id === importing);
  return (
    <div className="space-y-4">
      {confirmDialog}
      <p className="text-sm text-slate-600">
        An evidence source is an external assessment (for example the Google Form used for the staff
        Code of Conduct quiz). Its results are imported or synchronized into the HRMS, matched to
        employees by their email, and deduplicated; unmatched results wait under “Unmatched
        results”.
      </p>
      <SectionState loading={loading} error={error} onRetry={reload} what="evidence sources">
        {sources.length === 0 ? (
          <EmptyState>No evidence sources yet.</EmptyState>
        ) : (
          <DataTable
            label="Evidence sources"
            minWidth="min-w-[880px]"
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
                    {source.archived && (
                      <span className="ml-1 rounded bg-slate-200 px-1.5 text-xs text-slate-700">
                        Archived
                      </span>
                    )}
                    <span className="block text-xs font-normal text-slate-500">
                      {source.resourceTitle ?? source.code}
                      {source.externalResourceId ? ` · ${source.externalResourceId}` : ''}
                    </span>
                  </>
                ),
              },
              {
                key: 'provider',
                header: 'Provider',
                cell: (source) => <>{PROVIDER_LABELS[source.provider]}</>,
              },
              {
                key: 'pass',
                header: 'Pass mark',
                cell: (source) => (
                  <>{source.passThresholdPercent ? `${source.passThresholdPercent}%` : '—'}</>
                ),
              },
              {
                key: 'results',
                header: 'Results',
                cell: (source) => <>{source.evidenceCount ?? 0}</>,
              },
              {
                key: 'unmatched',
                header: 'Unmatched',
                cell: (source) => <>{source.pendingMatches ?? 0}</>,
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
                className: 'space-x-1 space-y-1',
                cell: (source) => (
                  <>
                    {source.externalResourceId && !source.archived && (
                      <button
                        type="button"
                        className={secondaryButton}
                        onClick={() => {
                          setImporting(source.id);
                          setReport(null);
                        }}
                      >
                        Import results
                      </button>
                    )}
                    {!source.archived && (
                      <>
                        <button
                          type="button"
                          className={secondaryButton}
                          disabled={busy}
                          aria-label={`Edit ${source.name}`}
                          onClick={() => setEditing(source)}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className={secondaryButton}
                          disabled={busy}
                          aria-label={`Archive ${source.name}`}
                          onClick={async () => {
                            if (
                              await confirm({
                                title: `Archive ${source.name}?`,
                                description:
                                  'Its results are no longer imported or synchronized. Evidence already recorded from it stays on the employees.',
                                confirmLabel: 'Archive source',
                              })
                            )
                              void mutate(
                                () => performanceApi.archiveEvidenceSource(source.id),
                                'Evidence source archived.',
                              );
                          }}
                        >
                          Archive
                        </button>
                      </>
                    )}
                  </>
                ),
              },
            ]}
          />
        )}
      </SectionState>
      {importing && (
        <form
          aria-label="Import results"
          className="space-y-2 rounded-xl border border-slate-200 bg-white p-4"
          onSubmit={(event) => {
            event.preventDefault();
            const parsed = parseJsonArray(payload);
            if (!parsed.ok) {
              setPayloadError(parsed.message);
              return;
            }
            setPayloadError(null);
            const results = parsed.items;
            void mutate(async () => {
              setReport(await performanceApi.importResults(importing, results));
            }, 'Results imported.');
          }}
        >
          {importingSource && (
            <h2 className="text-base font-semibold text-slate-900">
              Import results into {importingSource.name}
            </h2>
          )}
          <Field label="Results (JSON array of { externalResultId, respondentEmail, completedAt, score, maxScore })">
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
          <div className="flex flex-wrap gap-2">
            <button type="submit" className={primaryButton} disabled={busy}>
              Import
            </button>
            <button type="button" className={secondaryButton} onClick={() => setImporting(null)}>
              Done
            </button>
          </div>
          {report && (
            <p role="status" className="text-sm text-slate-700">
              {report.received} received:{' '}
              {Object.entries(report.counts)
                .filter(([, count]) => count > 0)
                .map(([outcome, count]) => `${count} ${label(outcome).toLowerCase()}`)
                .join(', ')}
            </p>
          )}
        </form>
      )}
      {editing && (
        <EditSourceDialog
          source={editing}
          busy={busy}
          mutate={mutate}
          onClose={() => setEditing(null)}
        />
      )}
      <form
        aria-label="Add evidence source"
        className="grid grid-cols-1 gap-3 rounded-xl border border-slate-200 bg-white p-4 sm:grid-cols-3"
        onSubmit={async (event) => {
          event.preventDefault();
          const ok = await mutate(
            () =>
              performanceApi.createEvidenceSource({
                organizationId,
                code: form.code,
                name: form.name,
                provider: form.provider,
                kind: form.kind,
                externalResourceId: form.externalResourceId || null,
                passThresholdPercent: form.passThresholdPercent || null,
              }),
            'Evidence source added.',
          );
          if (ok)
            setForm((current) => ({ ...current, code: '', name: '', externalResourceId: '' }));
        }}
      >
        <h2 className="text-base font-semibold text-slate-900 sm:col-span-3">
          New evidence source
        </h2>
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
              setForm({ ...form, provider: e.currentTarget.value as EvidenceProvider })
            }
          >
            {PROVIDERS.map((provider) => (
              <option key={provider} value={provider}>
                {PROVIDER_LABELS[provider]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Kind">
          <select
            className={inputClass}
            value={form.kind}
            onChange={(e) => setForm({ ...form, kind: e.currentTarget.value as EvidenceKind })}
          >
            {EVIDENCE_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {label(kind)}
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
        <Field label="Pass mark %">
          <input
            className={inputClass}
            inputMode="decimal"
            value={form.passThresholdPercent}
            onChange={(e) => setForm({ ...form, passThresholdPercent: e.currentTarget.value })}
          />
        </Field>
        <div>
          <button type="submit" className={primaryButton} disabled={busy}>
            Add source
          </button>
        </div>
      </form>
    </div>
  );
}

function EditSourceDialog({
  source,
  busy,
  mutate,
  onClose,
}: {
  source: EvidenceSource;
  busy: boolean;
  mutate: SectionProps['mutate'];
  onClose(): void;
}) {
  const [form, setForm] = useState({
    name: source.name,
    resourceTitle: source.resourceTitle ?? '',
    resourceUrl: source.resourceUrl ?? '',
    passThresholdPercent: source.passThresholdPercent ?? '',
  });
  const [error, setError] = useState<string | null>(null);
  return (
    <FormDialog
      open
      title={`Edit ${source.name}`}
      description="The provider, kind and external resource never change (results are matched by them)."
      submitLabel="Save source"
      busy={busy}
      canSubmit={form.name.trim() !== ''}
      error={error}
      onClose={onClose}
      onSubmit={async () => {
        setError(null);
        const ok = await mutate(
          () =>
            performanceApi.updateEvidenceSource(source.id, {
              name: form.name.trim(),
              resourceTitle: form.resourceTitle.trim() || null,
              resourceUrl: form.resourceUrl.trim() || null,
              passThresholdPercent: form.passThresholdPercent.trim() || null,
            }),
          'Evidence source saved.',
          { onError: setError },
        );
        if (ok) onClose();
      }}
    >
      <div className="space-y-3">
        <Field label="Source name">
          <input
            className={inputClass}
            required
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.currentTarget.value })}
          />
        </Field>
        <Field label="Resource title">
          <input
            className={inputClass}
            value={form.resourceTitle}
            onChange={(e) => setForm({ ...form, resourceTitle: e.currentTarget.value })}
          />
        </Field>
        <Field label="Resource link">
          <input
            className={inputClass}
            type="url"
            value={form.resourceUrl}
            onChange={(e) => setForm({ ...form, resourceUrl: e.currentTarget.value })}
          />
        </Field>
        <Field label="Pass mark %" hint="Applies to results imported from now on.">
          <input
            className={inputClass}
            inputMode="decimal"
            value={form.passThresholdPercent}
            onChange={(e) => setForm({ ...form, passThresholdPercent: e.currentTarget.value })}
          />
        </Field>
      </div>
    </FormDialog>
  );
}
