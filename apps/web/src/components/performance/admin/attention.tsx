'use client';

import Link from 'next/link';
import { useState } from 'react';
import { performanceApi } from '../../../lib/performance/api';
import type { AttentionItem } from '../../../lib/performance/types';
import {
  ATTENTION_LABELS,
  EmptyState,
  inputClass,
  label,
  ReviewStatusBadge,
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

/** Reviews needing attention (within the viewer's access): cycle and flag filters, paging. */
export function AttentionTab({
  organizationId,
  version,
}: Pick<SectionProps, 'organizationId' | 'version'>) {
  const [filters, setFilters] = useState({ cycleId: '', flag: '' });
  const cycles = useSectionData(
    async () => (await performanceApi.cycles(organizationId)).items,
    [organizationId],
  );
  const query = (afterId?: string) => ({
    ...(filters.cycleId ? { cycleId: filters.cycleId } : {}),
    ...(filters.flag ? { flag: filters.flag } : {}),
    ...(afterId ? { afterId } : {}),
  });
  const [more, setMore] = useState<{ items: AttentionItem[]; next: string | null } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const { data, error, loading, reload } = useSectionData(async () => {
    setMore(null);
    return performanceApi.attention(organizationId, query());
  }, [organizationId, filters, version]);
  const items = [...(data?.items ?? []), ...(more?.items ?? [])];
  const next = more ? more.next : (data?.nextAfterId ?? null);
  return (
    <div className="space-y-3">
      <div
        className="grid grid-cols-1 gap-2 sm:grid-cols-3"
        role="group"
        aria-label="Filter reviews needing attention"
      >
        <Field label="Cycle">
          <select
            className={inputClass}
            value={filters.cycleId}
            onChange={(e) => setFilters({ ...filters, cycleId: e.currentTarget.value })}
          >
            <option value="">All cycles</option>
            {(cycles.data ?? []).map((cycle) => (
              <option key={cycle.id} value={cycle.id}>
                {cycle.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Reason">
          <select
            className={inputClass}
            value={filters.flag}
            onChange={(e) => setFilters({ ...filters, flag: e.currentTarget.value })}
          >
            <option value="">Any reason</option>
            {Object.entries(ATTENTION_LABELS).map(([flag, text]) => (
              <option key={flag} value={flag}>
                {text}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <SectionState
        loading={loading}
        error={error}
        onRetry={reload}
        what="reviews needing attention"
      >
        {items.length === 0 ? (
          <EmptyState>No reviews need attention.</EmptyState>
        ) : (
          <DataTable
            label="Reviews needing attention"
            minWidth="min-w-[760px]"
            rows={items}
            rowKey={(item) => item.reviewId}
            columns={[
              {
                key: 'employee',
                header: 'Employee',
                rowHeader: true,
                cell: (item) => (
                  <>
                    {item.employee.displayName}
                    <span className="block text-xs font-normal text-slate-500">
                      {item.positionName}
                    </span>
                  </>
                ),
              },
              {
                key: 'cycle',
                header: 'Cycle',
                cell: (item) => <>{item.cycle.name}</>,
              },
              {
                key: 'reviewer',
                header: 'Reviewer',
                cell: (item) => <>{item.reviewer?.displayName ?? '—'}</>,
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
                key: 'flags',
                header: 'Needs attention',
                cell: (item) => (
                  <>
                    <ul className="space-y-0.5 text-xs text-amber-800">
                      {item.flags.map((flag) => (
                        <li key={flag}>⚠ {ATTENTION_LABELS[flag] ?? label(flag)}</li>
                      ))}
                    </ul>
                  </>
                ),
              },
              {
                key: 'open',
                header: <span className="sr-only">Actions</span>,
                cell: (item) => (
                  <>
                    <Link
                      className="text-indigo-700 underline"
                      href={`/performance/reviews/${item.reviewId}`}
                      aria-label={`Open the review of ${item.employee.displayName}`}
                    >
                      Open
                    </Link>
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
            label="Load more reviews"
            busy={loadingMore}
            onClick={async () => {
              setLoadingMore(true);
              setMoreError(null);
              try {
                const page = await performanceApi.attention(organizationId, query(next));
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
