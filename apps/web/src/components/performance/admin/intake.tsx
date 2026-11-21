'use client';

import { useMemo, useState } from 'react';
import { performanceApi } from '../../../lib/performance/api';
import { performanceOptionSource } from '../../../lib/performance/pickers';
import type { IntakeItem } from '../../../lib/performance/types';
import { FormDialog } from '../../ui/form-dialog';
import { RecordCombobox } from '../../ui/record-combobox';
import { useConfirmWithReason } from '../../ui/use-confirm';
import {
  dateTimeText,
  EmptyState,
  inputClass,
  label,
  primaryButton,
  secondaryButton,
} from '../performance-shared';
import {
  adminErrorMessage,
  Field,
  LoadMore,
  SectionState,
  useSectionData,
  type SectionProps,
} from './shared';
import { DataTable } from '../../ui/data-table';

type IntakeStatus = IntakeItem['status'];
const UNVERIFIED = 'Unverified email: ';

/**
 * Who answered: a verified email, or a claimed address the form provider did not verify
 * (quarantined — it is never matched automatically and must be checked before matching).
 */
export function Respondent({ item }: { item: IntakeItem }) {
  if (item.respondentEmail) return <>{item.respondentEmail}</>;
  const reference = item.respondentReference;
  if (reference?.startsWith(UNVERIFIED)) {
    return (
      <span>
        <span className="mr-1 rounded bg-amber-100 px-1.5 py-0.5 text-xs font-semibold text-amber-900">
          Unverified
        </span>
        {reference.slice(UNVERIFIED.length)}
        <span className="block text-xs text-amber-900">
          Claimed by the respondent, not verified by the form. Check who answered before matching.
        </span>
      </span>
    );
  }
  return <>{reference ?? '—'}</>;
}

/** Unmatched (and resolved) imported results: filters, paging, match and reject. */
export function IntakeTab({ organizationId, busy, mutate, version }: SectionProps) {
  const [filters, setFilters] = useState<{ status: IntakeStatus; sourceId: string }>({
    status: 'PENDING_MATCH',
    sourceId: '',
  });
  const sources = useSectionData(
    async () => (await performanceApi.evidenceSources(organizationId)).items,
    [organizationId],
  );
  const query = (afterId?: string) => ({
    status: filters.status,
    ...(filters.sourceId ? { sourceId: filters.sourceId } : {}),
    ...(afterId ? { afterId } : {}),
  });
  const [more, setMore] = useState<{ items: IntakeItem[]; next: string | null } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const { data, error, loading, reload } = useSectionData(async () => {
    setMore(null);
    return performanceApi.intake(organizationId, query());
  }, [organizationId, filters, version]);
  const [matching, setMatching] = useState<IntakeItem | null>(null);
  const [confirmWithReason, reasonDialog] = useConfirmWithReason();
  const items = [...(data?.items ?? []), ...(more?.items ?? [])];
  const next = more ? more.next : (data?.nextAfterId ?? null);
  const pending = filters.status === 'PENDING_MATCH';
  return (
    <div className="space-y-3">
      {reasonDialog}
      <div
        className="grid grid-cols-1 gap-2 sm:grid-cols-3"
        role="group"
        aria-label="Filter results"
      >
        <Field label="Status">
          <select
            className={inputClass}
            value={filters.status}
            onChange={(e) =>
              setFilters({ ...filters, status: e.currentTarget.value as IntakeStatus })
            }
          >
            <option value="PENDING_MATCH">Waiting for a match</option>
            <option value="MATCHED">Matched</option>
            <option value="REJECTED">Rejected</option>
          </select>
        </Field>
        <Field label="Source">
          <select
            className={inputClass}
            value={filters.sourceId}
            onChange={(e) => setFilters({ ...filters, sourceId: e.currentTarget.value })}
          >
            <option value="">All sources</option>
            {(sources.data ?? []).map((source) => (
              <option key={source.id} value={source.id}>
                {source.name}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {sources.error && (
        <p className="text-sm text-amber-800">
          Sources could not be loaded for the filter: {sources.error}
        </p>
      )}
      <SectionState loading={loading} error={error} onRetry={reload} what="imported results">
        {items.length === 0 ? (
          <EmptyState>
            {pending
              ? 'Every imported result is matched to an employee.'
              : 'No results match these filters.'}
          </EmptyState>
        ) : (
          <DataTable
            label="Imported results"
            minWidth="min-w-[760px]"
            rows={items}
            rowKey={(item) => item.id}
            columns={[
              {
                key: 'result',
                header: 'Result',
                rowHeader: true,
                cell: (item) => (
                  <>
                    {item.result.title ?? item.source.name}
                    <span className="block text-xs font-normal text-slate-500">
                      {item.source.name} · {item.externalResultId}
                    </span>
                    {item.result.score != null && (
                      <span className="block text-xs font-normal text-slate-600">
                        Score {item.result.score}
                        {item.result.maxScore != null ? ` / ${item.result.maxScore}` : ''}
                      </span>
                    )}
                  </>
                ),
              },
              {
                key: 'respondent',
                header: 'Respondent',
                cell: (item) => (
                  <>
                    <Respondent item={item} />
                  </>
                ),
              },
              {
                key: 'why',
                header: pending ? 'Why unmatched' : 'Resolution',
                cell: (item) => (
                  <>
                    {pending ? (
                      label(item.reason)
                    ) : (
                      <>
                        {label(item.status)}
                        {item.resolvedAt ? ` ${dateTimeText(item.resolvedAt)}` : ''}
                        {item.resolutionNote && (
                          <span className="block text-xs font-normal text-slate-600">
                            {item.resolutionNote}
                          </span>
                        )}
                      </>
                    )}
                  </>
                ),
              },
              {
                key: 'received',
                header: 'Received',
                cell: (item) => <>{dateTimeText(item.receivedAt)}</>,
              },
              {
                key: 'actions',
                header: <span className="sr-only">Actions</span>,
                className: 'space-x-1 space-y-1',
                cell: (item) => (
                  <>
                    {item.status === 'PENDING_MATCH' && (
                      <>
                        <button
                          type="button"
                          className={primaryButton}
                          disabled={busy}
                          aria-label={`Match ${item.externalResultId}`}
                          onClick={() => setMatching(item)}
                        >
                          Match
                        </button>
                        <button
                          type="button"
                          className={secondaryButton}
                          disabled={busy}
                          aria-label={`Reject ${item.externalResultId}`}
                          onClick={async () => {
                            const reason = await confirmWithReason({
                              title: `Reject ${item.externalResultId}?`,
                              description:
                                'The result is not recorded as evidence for anyone. It stays listed under “Rejected” with your reason.',
                              confirmLabel: 'Reject result',
                              reason: { label: 'Reason', required: true, maxLength: 500 },
                            });
                            if (reason)
                              void mutate(
                                () =>
                                  performanceApi.resolveIntake(item.id, {
                                    action: 'REJECT',
                                    note: reason,
                                  }),
                                'Result rejected.',
                              );
                          }}
                        >
                          Reject
                        </button>
                      </>
                    )}
                  </>
                ),
              },
            ]}
          />
        )}
        {moreError && (
          <p role="alert" className="text-sm text-rose-800">
            {moreError}
          </p>
        )}
        {next && (
          <LoadMore
            label="Load more results"
            busy={loadingMore}
            onClick={async () => {
              setLoadingMore(true);
              setMoreError(null);
              try {
                const page = await performanceApi.intake(organizationId, query(next));
                setMore((current) => ({
                  items: [...(current?.items ?? []), ...page.items],
                  next: page.nextAfterId,
                }));
              } catch (cause) {
                setMoreError(adminErrorMessage(cause, 'Unable to load more results.'));
              } finally {
                setLoadingMore(false);
              }
            }}
          />
        )}
      </SectionState>
      {matching && (
        <MatchDialog
          organizationId={organizationId}
          item={matching}
          busy={busy}
          mutate={mutate}
          onClose={() => setMatching(null)}
        />
      )}
    </div>
  );
}

function MatchDialog({
  organizationId,
  item,
  busy,
  mutate,
  onClose,
}: {
  organizationId: string;
  item: IntakeItem;
  busy: boolean;
  mutate: SectionProps['mutate'];
  onClose(): void;
}) {
  const [employeeId, setEmployeeId] = useState('');
  const [assignmentId, setAssignmentId] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const employees = useMemo(
    () => performanceOptionSource(organizationId, 'employee'),
    [organizationId],
  );
  const assignments = useMemo(
    () => performanceOptionSource(organizationId, 'assignment', { employeeId }),
    [organizationId, employeeId],
  );
  return (
    <FormDialog
      open
      title={`Match ${item.externalResultId}`}
      description={
        <>
          Respondent: <Respondent item={item} />
        </>
      }
      submitLabel="Match result"
      busy={busy}
      canSubmit={employeeId !== ''}
      error={error}
      onClose={onClose}
      onSubmit={async () => {
        setError(null);
        const ok = await mutate(
          () =>
            performanceApi.resolveIntake(item.id, {
              action: 'MATCH',
              employeeId,
              employmentAssignmentId: assignmentId || null,
              ...(note.trim() ? { note: note.trim() } : {}),
            }),
          'Result matched to the employee.',
          { onError: setError },
        );
        if (ok) onClose();
      }}
    >
      <div className="space-y-3">
        <RecordCombobox
          label="Employee"
          required
          source={employees}
          value={employeeId}
          onChange={(id) => {
            setEmployeeId(id);
            setAssignmentId('');
          }}
          placeholder="Name or employee number"
          noResultsText="No matching employees within your access."
        />
        {employeeId && (
          <RecordCombobox
            key={employeeId}
            label="Assignment (optional)"
            source={assignments}
            value={assignmentId}
            onChange={(id) => setAssignmentId(id)}
            placeholder="Position"
            noResultsText="No assignments of this employee."
          />
        )}
        <Field label="Note (optional)">
          <input
            className={inputClass}
            maxLength={500}
            value={note}
            onChange={(e) => setNote(e.currentTarget.value)}
          />
        </Field>
      </div>
    </FormDialog>
  );
}
