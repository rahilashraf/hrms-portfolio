'use client';

import { checkboxClass } from '../../ui/tokens';
import Link from 'next/link';
import type { FormEvent } from 'react';
import { useMemo, useState } from 'react';
import { performanceApi } from '../../../lib/performance/api';
import { performanceOptionSource } from '../../../lib/performance/pickers';
import type { Cycle, CycleReview, TemplateSummary } from '../../../lib/performance/types';
import { FormDialog } from '../../ui/form-dialog';
import { RecordCombobox } from '../../ui/record-combobox';
import { useConfirm, useConfirmWithReason } from '../../ui/use-confirm';
import {
  datePeriod,
  EmptyState,
  formatDateOnly,
  inputClass,
  label,
  partText,
  primaryButton,
  ReviewStatusBadge,
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

const reviewTotal = (cycle: Cycle) =>
  Object.values(cycle.reviewCounts ?? {}).reduce((sum, n) => sum + (n ?? 0), 0);

/** Review cycles: list, create, detail, edit, discard, targeted add, open, close, archive. */
export function CyclesTab({
  organizationId,
  busy,
  mutate,
  version,
  canManage,
}: SectionProps & {
  canManage: boolean;
}) {
  const { data, error, loading, reload } = useSectionData(async () => {
    const [cycles, templates] = await Promise.allSettled([
      performanceApi.cycles(organizationId),
      performanceApi.templates(organizationId),
    ]);
    if (cycles.status === 'rejected') throw cycles.reason;
    return {
      cycles: cycles.value.items,
      // Cycles use ACTIVE templates only; the form still works if templates fail to load.
      templates:
        templates.status === 'fulfilled'
          ? templates.value.items.filter((t) => t.status === 'ACTIVE')
          : [],
      templatesFailed: templates.status === 'rejected',
    };
  }, [organizationId, version]);
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<Cycle | null>(null);
  const [adding, setAdding] = useState<Cycle | null>(null);
  const [confirm, confirmDialog] = useConfirm();
  const [confirmWithReason, reasonDialog] = useConfirmWithReason();
  const cycles = data?.cycles ?? [];
  const current = cycles.find((c) => c.id === selected) ?? null;

  return (
    <div className="space-y-4">
      {confirmDialog}
      {reasonDialog}
      <SectionState loading={loading} error={error} onRetry={reload} what="review cycles">
        {cycles.length === 0 ? (
          <EmptyState>No review cycles yet.</EmptyState>
        ) : (
          <DataTable
            label="Review cycles"
            minWidth="min-w-[760px]"
            rows={cycles}
            rowKey={(cycle) => cycle.id}
            columns={[
              {
                key: 'cycle',
                header: 'Cycle',
                rowHeader: true,
                cell: (cycle) => (
                  <>
                    {cycle.name}
                    <span className="block text-xs font-normal text-slate-500">
                      {cycle.code} · {cycle.template?.name}
                    </span>
                  </>
                ),
              },
              {
                key: 'status',
                header: 'Status',
                cell: (cycle) => <>{label(cycle.status)}</>,
              },
              {
                key: 'period',
                header: 'Review period',
                cell: (cycle) => <>{datePeriod(cycle.periodStart, cycle.periodEnd)}</>,
              },
              {
                key: 'window',
                header: 'Window',
                cell: (cycle) => <>{datePeriod(cycle.windowStart, cycle.windowEnd)}</>,
              },
              {
                key: 'reviews',
                header: 'Reviews',
                cell: (cycle) => <>{reviewTotal(cycle)}</>,
              },
              {
                key: 'actions',
                header: <span className="sr-only">Actions</span>,
                className: 'space-x-1 space-y-1',
                cell: (cycle) => (
                  <>
                    <button
                      type="button"
                      className={secondaryButton}
                      aria-label={`Show ${cycle.name}`}
                      aria-expanded={selected === cycle.id}
                      onClick={() => setSelected(selected === cycle.id ? null : cycle.id)}
                    >
                      {selected === cycle.id ? 'Hide' : 'Details'}
                    </button>
                    {cycle.actions?.canAddReviews && (
                      <button
                        type="button"
                        className={secondaryButton}
                        disabled={busy}
                        onClick={() => setAdding(cycle)}
                      >
                        Add reviews
                      </button>
                    )}
                    {cycle.actions?.canOpen && (
                      <button
                        type="button"
                        className={primaryButton}
                        disabled={busy}
                        onClick={async () => {
                          if (
                            await confirm({
                              title: `Open ${cycle.name}?`,
                              description:
                                'Opening freezes the template into the cycle and starts the review window: employees and reviewers can write their parts. The template, period and reviewer model can no longer change.',
                              confirmLabel: 'Open cycle',
                              destructive: false,
                            })
                          )
                            void mutate(
                              () => performanceApi.transitionCycle(cycle.id, 'open'),
                              'Cycle opened.',
                            );
                        }}
                      >
                        Open
                      </button>
                    )}
                    {cycle.actions?.canClose && (
                      <button
                        type="button"
                        className={secondaryButton}
                        disabled={busy}
                        onClick={async () => {
                          const reason = await confirmWithReason({
                            title: `Close ${cycle.name}?`,
                            description:
                              'Closing ends the review window. Reviews still in progress are closed as incomplete, with their unsubmitted parts marked not submitted; finalized reviews keep their result. Your own review is never closed by you.',
                            confirmLabel: 'Close cycle',
                            reason: {
                              label: 'Reason',
                              defaultValue: 'Review window ended',
                              maxLength: 500,
                              hint: 'Recorded with the closed reviews (required when reviews are still open).',
                            },
                          });
                          if (reason === null) return;
                          void mutate(
                            () =>
                              performanceApi.closeCycle(cycle.id, {
                                closeIncomplete: true,
                                reason: reason || null,
                              }),
                            'Cycle closed.',
                          );
                        }}
                      >
                        Close
                      </button>
                    )}
                    {cycle.actions?.canArchive && (
                      <button
                        type="button"
                        className={secondaryButton}
                        disabled={busy}
                        onClick={async () => {
                          if (
                            await confirm({
                              title: `Archive ${cycle.name}?`,
                              description:
                                'The cycle and its reviews leave the active lists; they stay available for records and reporting.',
                              confirmLabel: 'Archive cycle',
                            })
                          )
                            void mutate(
                              () => performanceApi.transitionCycle(cycle.id, 'archive'),
                              'Cycle archived.',
                            );
                        }}
                      >
                        Archive
                      </button>
                    )}
                  </>
                ),
              },
            ]}
          />
        )}
        {current && (
          <CycleDetail
            cycle={current}
            busy={busy}
            mutate={mutate}
            version={version}
            onEdit={() => setEditing(current)}
            onDiscard={async () => {
              if (
                await confirm({
                  title: `Discard ${current.name}?`,
                  description:
                    'The draft cycle and the reviews added to it are deleted. Nothing was written in them yet. This cannot be undone.',
                  confirmLabel: 'Discard cycle',
                })
              ) {
                const ok = await mutate(
                  () => performanceApi.discardCycle(current.id),
                  'Draft cycle discarded.',
                );
                if (ok) setSelected(null);
              }
            }}
          />
        )}
        {data?.templatesFailed && (
          <p role="alert" className="text-sm text-amber-800">
            Templates could not be loaded; creating a cycle needs an active template.
          </p>
        )}
      </SectionState>
      {editing && (
        <EditCycleDialog
          cycle={editing}
          busy={busy}
          mutate={mutate}
          onClose={() => setEditing(null)}
        />
      )}
      {adding && (
        <AddReviewsDialog
          cycle={adding}
          organizationId={organizationId}
          busy={busy}
          mutate={mutate}
          onClose={() => setAdding(null)}
        />
      )}
      {canManage && (
        <CreateCycleForm
          organizationId={organizationId}
          templates={data?.templates ?? []}
          busy={busy}
          mutate={mutate}
        />
      )}
    </div>
  );
}

function CycleDetail({
  cycle,
  busy,
  mutate,
  version,
  onEdit,
  onDiscard,
}: {
  cycle: Cycle;
  busy: boolean;
  mutate: SectionProps['mutate'];
  version: number;
  onEdit(): void;
  onDiscard(): void;
}) {
  const rows: Array<[string, string]> = [
    ['Code', cycle.code],
    ['Status', label(cycle.status)],
    ['Template', cycle.template ? `${cycle.template.name} (${cycle.template.code})` : '—'],
    ['Reviewer', cycle.reviewerModel === 'DIRECT_MANAGER' ? 'Direct manager' : 'Assigned by HR'],
    ['Self review', cycle.selfReviewEnabled ? 'Yes' : 'No'],
    ['Acknowledgement', cycle.acknowledgementEnabled ? 'Asked of the employee' : 'Not asked'],
    ['Review period', datePeriod(cycle.periodStart, cycle.periodEnd)],
    ['Window', datePeriod(cycle.windowStart, cycle.windowEnd)],
    ['Self review due', cycle.selfReviewDueDate ? formatDateOnly(cycle.selfReviewDueDate) : '—'],
    ['Reviewer due', cycle.reviewerDueDate ? formatDateOnly(cycle.reviewerDueDate) : '—'],
    [
      'Reviews',
      Object.entries(cycle.reviewCounts ?? {})
        .map(([status, n]) => `${n} ${label(status).toLowerCase()}`)
        .join(', ') || 'None yet',
    ],
  ];
  return (
    <section
      aria-label={`Details of ${cycle.name}`}
      className="space-y-3 rounded-xl border border-slate-200 bg-white p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold text-slate-900">{cycle.name}</h2>
          {cycle.description && <p className="text-sm text-slate-600">{cycle.description}</p>}
        </div>
        <div className="flex flex-wrap gap-2">
          {cycle.actions?.canEdit && (
            <button type="button" className={secondaryButton} disabled={busy} onClick={onEdit}>
              Edit cycle
            </button>
          )}
          {cycle.actions?.canDiscard && (
            <button type="button" className={secondaryButton} disabled={busy} onClick={onDiscard}>
              Discard draft
            </button>
          )}
        </div>
      </div>
      <dl className="grid grid-cols-1 gap-x-4 gap-y-2 text-sm sm:grid-cols-2">
        {rows.map(([term, value]) => (
          <div key={term}>
            <dt className="text-xs font-medium uppercase text-slate-500">{term}</dt>
            <dd className="text-slate-800">{value}</dd>
          </div>
        ))}
      </dl>
      <CycleReviews cycle={cycle} busy={busy} mutate={mutate} version={version} />
    </section>
  );
}

type Filters = { status: string; search: string; withoutReviewer: boolean };
const REVIEW_STATUSES = [
  'NOT_STARTED',
  'IN_PROGRESS',
  'SUBMITTED',
  'FINALIZED',
  'ACKNOWLEDGED',
  'CLOSED',
];
const PAGE = 50;

/** The cycle's reviews (within the viewer's access): filters, "Load more", removal in drafts. */
export function CycleReviews({
  cycle,
  busy,
  mutate,
  version,
}: {
  cycle: Cycle;
  busy: boolean;
  mutate: SectionProps['mutate'];
  version: number;
}) {
  const [filters, setFilters] = useState<Filters>({
    status: '',
    search: '',
    withoutReviewer: false,
  });
  const [applied, setApplied] = useState<Filters>(filters);
  const [more, setMore] = useState<{ items: CycleReview[]; next: string | null } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [confirm, confirmDialog] = useConfirm();
  const query = (afterId?: string) => ({
    ...(applied.status ? { status: applied.status } : {}),
    ...(applied.search.trim() ? { search: applied.search.trim() } : {}),
    ...(applied.withoutReviewer ? { withoutReviewer: true } : {}),
    limit: PAGE,
    ...(afterId ? { afterId } : {}),
  });
  const { data, error, loading, reload } = useSectionData(async () => {
    setMore(null);
    return performanceApi.cycleReviews(cycle.id, query());
  }, [cycle.id, applied, version]);
  const items = [...(data?.items ?? []), ...(more?.items ?? [])];
  const next = more ? more.next : (data?.nextAfterId ?? null);
  return (
    <div className="space-y-2">
      {confirmDialog}
      <h3 className="text-sm font-semibold text-slate-900">Reviews</h3>
      <form
        aria-label={`Filter reviews of ${cycle.name}`}
        className="grid grid-cols-1 gap-2 sm:grid-cols-4"
        onSubmit={(event) => {
          event.preventDefault();
          setApplied(filters);
        }}
      >
        <Field label="Status">
          <select
            className={inputClass}
            value={filters.status}
            onChange={(e) => setFilters({ ...filters, status: e.currentTarget.value })}
          >
            <option value="">All</option>
            {REVIEW_STATUSES.map((status) => (
              <option key={status} value={status}>
                {label(status)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Employee">
          <input
            className={inputClass}
            value={filters.search}
            placeholder="Name or employee number"
            onChange={(e) => setFilters({ ...filters, search: e.currentTarget.value })}
          />
        </Field>
        <label className="inline-flex items-end gap-2 text-sm text-slate-800">
          <input
            type="checkbox"
            className={checkboxClass}
            checked={filters.withoutReviewer}
            onChange={(e) => setFilters({ ...filters, withoutReviewer: e.currentTarget.checked })}
          />
          Without a reviewer
        </label>
        <div className="flex items-end">
          <button type="submit" className={secondaryButton}>
            Apply filters
          </button>
        </div>
      </form>
      <SectionState loading={loading} error={error} onRetry={reload} what="the cycle's reviews">
        {items.length === 0 ? (
          <EmptyState>No reviews match (within your access).</EmptyState>
        ) : (
          <>
            {data?.total !== undefined && (
              <p className="text-xs text-slate-600">
                Showing {items.length} of {data.total}
              </p>
            )}
            <DataTable
              label={`Reviews of ${cycle.name}`}
              minWidth="min-w-[880px]"
              rows={items}
              rowKey={(item) => item.id}
              columns={[
                {
                  key: 'employee',
                  header: 'Employee',
                  rowHeader: true,
                  cell: (item) => (
                    <>
                      {item.employee.displayName}
                      <span className="block text-xs font-normal text-slate-500">
                        {item.employee.employeeNumber}
                      </span>
                    </>
                  ),
                },
                {
                  key: 'position',
                  header: 'Position',
                  cell: (item) => <>{item.employmentAssignment.positionName}</>,
                },
                {
                  key: 'reviewer',
                  header: 'Reviewer',
                  cell: (item) => <>{item.reviewer?.displayName ?? 'Not assigned'}</>,
                },
                {
                  key: 'status',
                  header: 'Status',
                  cell: (item) => (
                    <>
                      <ReviewStatusBadge status={item.status} />
                    </>
                  ),
                },
                {
                  key: 'self',
                  header: 'Self',
                  cell: (item) => <>{partText(item.selfStatus)}</>,
                },
                {
                  key: 'reviewerPart',
                  header: 'Reviewer part',
                  cell: (item) => <>{partText(item.reviewerStatus)}</>,
                },
                {
                  key: 'overdue',
                  header: 'Overdue',
                  cell: (item) => <>{item.overdue.map((part) => label(part)).join(', ') || '—'}</>,
                },
                {
                  key: 'actions',
                  header: <span className="sr-only">Actions</span>,
                  className: 'space-x-1 space-y-1',
                  cell: (item) => (
                    <>
                      <Link
                        className="text-indigo-700 underline"
                        href={`/performance/reviews/${item.id}`}
                        aria-label={`Open review of ${item.employee.displayName}`}
                      >
                        Open
                      </Link>
                      {cycle.status === 'DRAFT' && cycle.actions?.canAddReviews && (
                        <button
                          type="button"
                          className={secondaryButton}
                          disabled={busy}
                          aria-label={`Remove ${item.employee.displayName} from ${cycle.name}`}
                          onClick={async () => {
                            if (
                              await confirm({
                                title: `Remove ${item.employee.displayName}?`,
                                description:
                                  'The review is removed from this draft cycle. Nothing was written in it yet.',
                                confirmLabel: 'Remove review',
                              })
                            )
                              void mutate(
                                () => performanceApi.removeReview(cycle.id, item.id),
                                'Review removed from the cycle.',
                              );
                          }}
                        >
                          Remove
                        </button>
                      )}
                    </>
                  ),
                },
              ]}
            />
          </>
        )}
        {moreError && (
          <p role="alert" className="text-sm text-rose-800">
            {moreError}
          </p>
        )}
        {next && (
          <LoadMore
            label="Load more reviews"
            busy={loadingMore}
            onClick={async () => {
              setLoadingMore(true);
              setMoreError(null);
              try {
                const page = await performanceApi.cycleReviews(cycle.id, query(next));
                setMore((current) => ({
                  items: [...(current?.items ?? []), ...page.items],
                  next: page.nextAfterId,
                }));
              } catch (cause) {
                setMoreError(adminErrorMessage(cause, 'Unable to load more reviews.'));
              } finally {
                setLoadingMore(false);
              }
            }}
          />
        )}
      </SectionState>
    </div>
  );
}

/** Edit a cycle: what its status allows (the API refuses the rest with an explanation). */
function EditCycleDialog({
  cycle,
  busy,
  mutate,
  onClose,
}: {
  cycle: Cycle;
  busy: boolean;
  mutate: SectionProps['mutate'];
  onClose(): void;
}) {
  const draft = cycle.status === 'DRAFT';
  const open = cycle.status === 'OPEN';
  const [form, setForm] = useState({
    name: cycle.name,
    description: cycle.description ?? '',
    periodStart: cycle.periodStart,
    periodEnd: cycle.periodEnd,
    windowStart: cycle.windowStart,
    windowEnd: cycle.windowEnd,
    selfReviewDueDate: cycle.selfReviewDueDate ?? '',
    reviewerDueDate: cycle.reviewerDueDate ?? '',
  });
  const [error, setError] = useState<string | null>(null);
  const set = (key: keyof typeof form) => (value: string) =>
    setForm((current) => ({ ...current, [key]: value }));
  const dates: Array<[keyof typeof form, string, boolean]> = [
    ['periodStart', 'Review period start', draft],
    ['periodEnd', 'Review period end', draft],
    ['windowStart', 'Window opens', draft],
    ['windowEnd', 'Window closes', draft || open],
    ['selfReviewDueDate', 'Self review due', draft || open],
    ['reviewerDueDate', 'Reviewer due', draft || open],
  ];
  return (
    <FormDialog
      open
      title={`Edit ${cycle.name}`}
      description={
        draft
          ? 'A draft cycle can change everything.'
          : open
            ? 'An open cycle can change its name, description, window end and due dates.'
            : 'A closed cycle can change its name and description only.'
      }
      submitLabel="Save cycle"
      busy={busy}
      canSubmit={form.name.trim() !== ''}
      error={error}
      onClose={onClose}
      onSubmit={async () => {
        setError(null);
        const input: Record<string, unknown> = {
          name: form.name.trim(),
          description: form.description.trim() || null,
        };
        for (const [key, , editable] of dates) {
          if (!editable) continue;
          const value = form[key];
          input[key] = key.endsWith('DueDate') ? value || null : value;
        }
        const ok = await mutate(
          async () => {
            return await performanceApi.updateCycle(cycle.id, input);
          },
          'Cycle saved.',
          { onError: setError },
        );
        if (ok) onClose();
      }}
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Cycle name">
          <input
            className={inputClass}
            required
            value={form.name}
            onChange={(e) => set('name')(e.currentTarget.value)}
          />
        </Field>
        <Field label="Description">
          <input
            className={inputClass}
            value={form.description}
            onChange={(e) => set('description')(e.currentTarget.value)}
          />
        </Field>
        {dates
          .filter(([, , editable]) => editable)
          .map(([key, text]) => (
            <Field key={key} label={text}>
              <input
                type="date"
                className={inputClass}
                value={form[key]}
                onChange={(e) => set(key)(e.currentTarget.value)}
              />
            </Field>
          ))}
      </div>
    </FormDialog>
  );
}

type Narrow = 'organizationalUnitId' | 'departmentId' | 'teamId';

/**
 * Targeted review addition: chosen assignments (picker), or everyone of the organization —
 * optionally narrowed to a unit, department or team (pickers). The actor's own assignments are
 * never added (reported by the API).
 */
function AddReviewsDialog({
  cycle,
  organizationId,
  busy,
  mutate,
  onClose,
}: {
  cycle: Cycle;
  organizationId: string;
  busy: boolean;
  mutate: SectionProps['mutate'];
  onClose(): void;
}) {
  const [mode, setMode] = useState<'assignments' | 'everyone'>('assignments');
  const [assignmentId, setAssignmentId] = useState('');
  const [chosen, setChosen] = useState<Array<{ id: string; label: string }>>([]);
  const [narrow, setNarrow] = useState<Narrow | ''>('');
  const [structureId, setStructureId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  // Adding everyone is confirmed in a second step that says what it will do.
  const [confirming, setConfirming] = useState(false);
  const assignments = useMemo(
    () => performanceOptionSource(organizationId, 'assignment'),
    [organizationId],
  );
  const kind =
    narrow === 'organizationalUnitId' ? 'unit' : narrow === 'departmentId' ? 'department' : 'team';
  const structures = useMemo(
    () => performanceOptionSource(organizationId, kind),
    [organizationId, kind],
  );
  const canSubmit =
    mode === 'assignments' ? chosen.length > 0 : narrow === '' || structureId !== '';
  return (
    <FormDialog
      open
      size="lg"
      title={`Add reviews to ${cycle.name}`}
      description="Your own assignments are never added to a cycle you manage."
      submitLabel={
        mode === 'assignments'
          ? 'Add chosen reviews'
          : confirming
            ? 'Yes, add everyone'
            : 'Add everyone'
      }
      busy={busy}
      canSubmit={canSubmit}
      error={error}
      onClose={onClose}
      onSubmit={async () => {
        setError(null);
        setResult(null);
        if (mode === 'everyone' && !confirming) {
          setConfirming(true);
          return;
        }
        setConfirming(false);
        const input =
          mode === 'assignments'
            ? { assignmentIds: chosen.map((c) => c.id) }
            : {
                allInOrganization: true,
                ...(narrow && structureId ? { [narrow]: structureId } : {}),
              };
        let summary = '';
        const ok = await mutate(
          async () => {
            const outcome = await performanceApi.addReviews(cycle.id, input);
            summary = `${outcome.added} added, ${outcome.skipped} already in the cycle, ${outcome.withoutReviewer} without a reviewer${
              outcome.excludedOwn ? `, ${outcome.excludedOwn} of your own left out` : ''
            }.`;
          },
          'Reviews added to the cycle.',
          { onError: setError },
        );
        if (ok) {
          setResult(summary);
          setChosen([]);
        }
      }}
    >
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-slate-800">Who to add</legend>
        <label className="mr-4 inline-flex items-center gap-2 text-sm">
          <input
            type="radio"
            name="add-mode"
            checked={mode === 'assignments'}
            onChange={() => {
              setMode('assignments');
              setConfirming(false);
            }}
          />
          Chosen employees
        </label>
        <label className="inline-flex items-center gap-2 text-sm">
          <input
            type="radio"
            name="add-mode"
            checked={mode === 'everyone'}
            onChange={() => {
              setMode('everyone');
              setConfirming(false);
            }}
          />
          Everyone of the organization (optionally narrowed)
        </label>
      </fieldset>
      {mode === 'assignments' ? (
        <div className="mt-3 space-y-2">
          <RecordCombobox
            label="Employee assignment"
            source={assignments}
            value={assignmentId}
            onChange={(id, option) => {
              setAssignmentId('');
              if (id && !chosen.some((c) => c.id === id))
                setChosen((current) => [
                  ...current,
                  {
                    id,
                    label: option
                      ? `${option.label}${option.description ? ` — ${option.description}` : ''}`
                      : id,
                  },
                ]);
            }}
            placeholder="Name or employee number"
            noResultsText="No matching assignments within your access."
          />
          {chosen.length > 0 && (
            <ul aria-label="Chosen employees" className="space-y-1 text-sm">
              {chosen.map((c) => (
                <li key={c.id} className="flex items-center justify-between gap-2">
                  <span>{c.label}</span>
                  <button
                    type="button"
                    className={secondaryButton}
                    aria-label={`Remove ${c.label} from the list`}
                    onClick={() => setChosen((current) => current.filter((x) => x.id !== c.id))}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Field label="Narrow to">
            <select
              className={inputClass}
              value={narrow}
              onChange={(e) => {
                setNarrow(e.currentTarget.value as Narrow | '');
                setStructureId('');
                setConfirming(false);
              }}
            >
              <option value="">The whole organization</option>
              <option value="organizationalUnitId">A business unit</option>
              <option value="departmentId">A department</option>
              <option value="teamId">A team</option>
            </select>
          </Field>
          {narrow && (
            <RecordCombobox
              key={narrow}
              label={
                narrow === 'organizationalUnitId'
                  ? 'Business unit'
                  : narrow === 'departmentId'
                    ? 'Department'
                    : 'Team'
              }
              source={structures}
              value={structureId}
              onChange={(id) => {
                setStructureId(id);
                setConfirming(false);
              }}
              placeholder="Name or code"
              noResultsText="Nothing matches."
            />
          )}
        </div>
      )}
      {confirming && (
        <p
          role="alert"
          className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"
        >
          Every employee with an active assignment in{' '}
          {narrow
            ? 'the chosen ' +
              (narrow === 'organizationalUnitId'
                ? 'business unit'
                : narrow === 'departmentId'
                  ? 'department'
                  : 'team')
            : 'the organization'}{' '}
          will get a review in {cycle.name} (people already in the cycle are skipped, and your own
          assignments are left out). Select “Yes, add everyone” to continue.
        </p>
      )}
      {result && (
        <p role="status" className="mt-3 text-sm text-emerald-800">
          {result}
        </p>
      )}
    </FormDialog>
  );
}

function CreateCycleForm({
  organizationId,
  templates,
  busy,
  mutate,
}: {
  organizationId: string;
  templates: TemplateSummary[];
  busy: boolean;
  mutate: SectionProps['mutate'];
}) {
  const [form, setForm] = useState({
    code: '',
    name: '',
    templateId: '',
    reviewerModel: 'DIRECT_MANAGER' as 'DIRECT_MANAGER' | 'HR_ASSIGNED',
    selfReviewEnabled: true,
    periodStart: '',
    periodEnd: '',
    windowStart: '',
    windowEnd: '',
    selfReviewDueDate: '',
    reviewerDueDate: '',
  });
  const set = (key: keyof typeof form) => (value: string | boolean) =>
    setForm((current) => ({ ...current, [key]: value }));
  async function submit(event: FormEvent) {
    event.preventDefault();
    await mutate(
      () =>
        performanceApi.createCycle({
          organizationId,
          code: form.code,
          name: form.name,
          templateId: form.templateId || templates[0]?.id || '',
          reviewerModel: form.reviewerModel,
          selfReviewEnabled: form.selfReviewEnabled,
          periodStart: form.periodStart,
          periodEnd: form.periodEnd,
          windowStart: form.windowStart,
          windowEnd: form.windowEnd,
          selfReviewDueDate: form.selfReviewDueDate || null,
          reviewerDueDate: form.reviewerDueDate || null,
        }),
      'Review cycle created.',
    );
  }
  return (
    <form
      aria-label="Create review cycle"
      className="grid grid-cols-1 gap-3 rounded-xl border border-slate-200 bg-white p-4 sm:grid-cols-4"
      onSubmit={(event) => void submit(event)}
    >
      <h2 className="text-base font-semibold text-slate-900 sm:col-span-4">New review cycle</h2>
      <Field label="Code">
        <input
          className={inputClass}
          required
          value={form.code}
          onChange={(e) => set('code')(e.currentTarget.value)}
        />
      </Field>
      <Field label="Name">
        <input
          className={inputClass}
          required
          value={form.name}
          onChange={(e) => set('name')(e.currentTarget.value)}
        />
      </Field>
      <Field label="Template" hint="Active templates only.">
        <select
          className={inputClass}
          value={form.templateId}
          onChange={(e) => set('templateId')(e.currentTarget.value)}
        >
          {templates.length === 0 && <option value="">No active template</option>}
          {templates.map((template) => (
            <option key={template.id} value={template.id}>
              {template.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Reviewer">
        <select
          className={inputClass}
          value={form.reviewerModel}
          onChange={(e) => set('reviewerModel')(e.currentTarget.value)}
        >
          <option value="DIRECT_MANAGER">Direct manager</option>
          <option value="HR_ASSIGNED">Assigned by HR</option>
        </select>
      </Field>
      {(
        [
          ['periodStart', 'Review period start'],
          ['periodEnd', 'Review period end'],
          ['windowStart', 'Window opens'],
          ['windowEnd', 'Window closes'],
          ['selfReviewDueDate', 'Self review due'],
          ['reviewerDueDate', 'Reviewer due'],
        ] as const
      ).map(([key, text]) => (
        <Field key={key} label={text}>
          <input
            type="date"
            className={inputClass}
            required={!key.endsWith('DueDate')}
            value={form[key]}
            onChange={(e) => set(key)(e.currentTarget.value)}
          />
        </Field>
      ))}
      <label className="inline-flex items-end gap-2 text-sm text-slate-800">
        <input
          type="checkbox"
          className={checkboxClass}
          checked={form.selfReviewEnabled}
          onChange={(e) => set('selfReviewEnabled')(e.currentTarget.checked)}
        />
        Employees write a self review
      </label>
      <div className="flex items-end">
        <button type="submit" className={primaryButton} disabled={busy || templates.length === 0}>
          Create cycle
        </button>
      </div>
    </form>
  );
}
