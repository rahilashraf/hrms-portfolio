'use client';

import type { ReactNode } from 'react';
import { useCallback } from 'react';
import { recruitmentApi } from '../../../lib/recruitment/api';
import type { Dashboard } from '../../../lib/recruitment/types';
import {
  dateTimeText,
  EmptyState,
  formatDateOnly,
  label,
  OfferStatusBadge,
} from '../recruitment-shared';
import { DataTable } from '../../ui/data-table';
import { Loading, appLink, useData } from './admin-shared';

// Batch 10E-1: moved from recruitment-admin-page.tsx unchanged.
function AttentionList({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: ReactNode;
}) {
  return (
    <section
      aria-label={title}
      className="space-y-2 rounded-xl border border-slate-200 bg-white p-4"
    >
      <h3 className="text-sm font-semibold text-slate-900">
        {title} ({count})
      </h3>
      {count === 0 ? (
        <p className="text-sm text-slate-500">Nothing here.</p>
      ) : (
        <ul className="space-y-1 text-sm text-slate-800">{children}</ul>
      )}
    </section>
  );
}

export function DashboardTab({
  organizationId,
  onError,
}: {
  organizationId: string;
  onError(message: string): void;
}) {
  const load = useCallback(() => recruitmentApi.dashboard(organizationId), [organizationId]);
  const { data, loaded } = useData<Dashboard>(load, onError);
  if (!loaded) return <Loading />;
  if (!data) return <EmptyState>The dashboard is unavailable.</EmptyState>;
  const { attention } = data;
  return (
    <div className="space-y-4">
      <dl className="grid grid-cols-1 gap-3 sm:grid-cols-4">
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <dt className="text-xs font-semibold uppercase text-slate-500">Openings</dt>
          <dd className="mt-1 text-2xl font-semibold text-slate-950">{data.openings.total}</dd>
        </div>
        {(['OPEN', 'ON_HOLD', 'DRAFT'] as const).map((status) => (
          <div key={status} className="rounded-xl border border-slate-200 bg-white p-4">
            <dt className="text-xs font-semibold uppercase text-slate-500">{label(status)}</dt>
            <dd className="mt-1 text-2xl font-semibold text-slate-950">
              {data.openings.byStatus[status] ?? 0}
            </dd>
          </div>
        ))}
      </dl>
      <h2 className="text-base font-semibold text-slate-900">Pipeline</h2>
      {data.pipeline.length === 0 ? (
        <EmptyState>No open openings.</EmptyState>
      ) : (
        <DataTable
          label="Pipeline by opening"
          rows={data.pipeline}
          rowKey={(row) => row.opening.id}
          columns={[
            {
              key: 'opening',
              header: 'Opening',
              rowHeader: true,
              cell: (row) => (
                <>
                  {row.opening.title}
                  <span className="block text-xs font-normal text-slate-500">
                    {row.opening.code} · {label(row.opening.status)}
                  </span>
                </>
              ),
            },
            {
              key: 'filled',
              header: 'Filled',
              cell: (row) => (
                <>
                  {row.opening.hiredCount} / {row.opening.openingCount}
                </>
              ),
            },
            // One column per stage, as the API orders them; each row's count is found by stage
            // id (counts are the API's, never recomputed).
            ...(data.pipeline[0]?.stages ?? []).map((stage) => ({
              key: `stage-${stage.stageId}`,
              header: stage.name,
              cell: (row: Dashboard['pipeline'][number]) =>
                row.stages.find((entry) => entry.stageId === stage.stageId)?.count,
            })),
          ]}
        />
      )}
      <h2 className="text-base font-semibold text-slate-900">Needs attention</h2>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <AttentionList title="Overdue interview feedback" count={attention.overdueFeedback.length}>
          {attention.overdueFeedback.map((item) => (
            <li key={item.interviewId}>
              {appLink(item.applicationId, `${item.candidate} — ${item.title}`)}{' '}
              <span className="text-xs text-amber-800">
                {item.missing} missing · due {dateTimeText(item.feedbackDueAt)}
              </span>
            </li>
          ))}
        </AttentionList>
        <AttentionList title="Upcoming interviews" count={attention.upcomingInterviews.length}>
          {attention.upcomingInterviews.map((item) => (
            <li key={item.interviewId}>
              {appLink(item.applicationId, `${item.candidate} — ${item.title}`)}{' '}
              <span className="text-xs text-slate-500">{dateTimeText(item.scheduledStart)}</span>
            </li>
          ))}
        </AttentionList>
        <AttentionList
          title="Offers awaiting approval"
          count={attention.offersAwaitingApproval.length}
        >
          {attention.offersAwaitingApproval.map((item) => (
            <li key={item.offerId}>
              {appLink(item.applicationId, `${item.candidate} — ${item.opening.title}`)}
            </li>
          ))}
        </AttentionList>
        <AttentionList title="Offers expiring soon" count={attention.offersExpiringSoon.length}>
          {attention.offersExpiringSoon.map((item) => (
            <li key={item.offerId}>
              {appLink(item.applicationId, `${item.candidate} — ${item.opening.title}`)}{' '}
              <span className="text-xs text-amber-800">
                {item.expired ? 'Expired' : `Expires ${formatDateOnly(item.expiresOn)}`}
              </span>
            </li>
          ))}
        </AttentionList>
        <AttentionList
          title="Accepted offers not yet hired"
          count={attention.acceptedNotHired.length}
        >
          {attention.acceptedNotHired.map((item) => (
            <li key={item.offerId}>
              {appLink(item.applicationId, `${item.candidate} — ${item.opening.title}`)}{' '}
              <OfferStatusBadge status={item.status} />
            </li>
          ))}
        </AttentionList>
        <AttentionList title="Stale applications" count={attention.staleApplications.length}>
          {attention.staleApplications.map((item) => (
            <li key={item.applicationId}>
              {appLink(item.applicationId, `${item.candidate} — ${item.opening.title}`)}{' '}
              <span className="text-xs text-slate-500">
                In {item.stage} since {dateTimeText(item.since)}
              </span>
            </li>
          ))}
        </AttentionList>
        <AttentionList
          title="Openings past their closing date"
          count={attention.openingsPastClose.length}
        >
          {attention.openingsPastClose.map((item) => (
            <li key={item.openingId}>
              {item.title} ({item.code}){' '}
              <span className="text-xs text-amber-800">closed {formatDateOnly(item.closesOn)}</span>
            </li>
          ))}
        </AttentionList>
        {attention.pendingIntake !== null && (
          <section
            aria-label="Pending intake"
            className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-800"
          >
            <h3 className="text-sm font-semibold text-slate-900">External applications</h3>
            <p className="mt-1">{attention.pendingIntake} submission(s) waiting for an opening.</p>
          </section>
        )}
      </div>
    </div>
  );
}
