'use client';

import { useCallback, useState } from 'react';
import { timeApi } from '../../../lib/time/api';
import type { Timesheet } from '../../../lib/time/types';
import { buttonClass } from '../../ui/button';
import { EmptyState, ErrorState, LoadingState } from '../../ui/states';
import { segmentName } from '../timesheet-parts';
import {
  LoadMore,
  ReviewPanel,
  TimesheetStatusBadge,
  usePagedList,
  type ReviewOrganization,
  historyQuery,
} from './review-shared';
import {
  Feedback,
  MinutesSummary,
  periodLabel,
  useSegmentDecisions,
} from './timesheet-review-shared';

// Batch 10C: moved from timesheet-review.tsx unchanged.
// ─── Approval queue ──────────────────────────────────────────────────────────

export function ApprovalQueue({
  organization,
  onOpen,
}: {
  organization: ReviewOrganization;
  onOpen(sheet: Timesheet): void;
}) {
  const canApprove = Boolean(organization.actions.canApproveTimesheets);
  const [success, setSuccess] = useState<string | null>(null);
  const fetchPage = useCallback(
    (afterId?: string) =>
      timeApi.managementTimesheets({
        organizationId: organization.id,
        ...historyQuery(organization),
        status: 'SUBMITTED',
        segmentStatus: 'PENDING',
        limit: 10,
        ...(afterId ? { afterId } : {}),
      }),
    [organization],
  );
  const list = usePagedList(fetchPage, 'Unable to load the approval queue.');
  const decisions = useSegmentDecisions(async (message) => {
    setSuccess(message || null);
    await list.reload();
  });

  return (
    <ReviewPanel
      title="Timesheet approval queue"
      description="Submitted timesheets with assignments waiting for your approval."
    >
      <div className="space-y-3">
        <Feedback error={decisions.error} success={success} />
        {list.loading ? (
          <LoadingState label="Loading the approval queue…" />
        ) : list.error ? (
          <ErrorState
            title="The approval queue could not be loaded"
            message={list.error}
            onRetry={() => void list.reload()}
          />
        ) : list.items.length === 0 ? (
          <EmptyState title="No timesheets are waiting for approval." />
        ) : (
          list.items.map((sheet) => (
            <div key={sheet.id} className="rounded-lg border border-slate-200 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-semibold text-slate-950">
                  {sheet.employee?.name ?? 'Employee'}
                  <span className="ml-2 text-sm font-normal text-slate-600">
                    {periodLabel(sheet.period)}
                  </span>
                </p>
                <div className="flex items-center gap-2">
                  <TimesheetStatusBadge status={sheet.status} />
                  <button
                    type="button"
                    onClick={() => onOpen(sheet)}
                    className={buttonClass('ghost', 'sm')}
                  >
                    Review timesheet <span className="sr-only">of {sheet.employee?.name}</span>
                  </button>
                </div>
              </div>
              <div className="mt-2 space-y-2">
                {sheet.segments
                  .filter((segment) => segment.status === 'PENDING')
                  .map((segment) => (
                    <div
                      key={segment.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-slate-50 p-3"
                    >
                      <div>
                        <p className="font-medium text-slate-900">{segmentName(segment)}</p>
                        <p className="text-sm text-slate-600">
                          <MinutesSummary segment={segment} />
                        </p>
                      </div>
                      {canApprove && (
                        <div className="flex gap-2">
                          <button
                            type="button"
                            disabled={decisions.busy !== null}
                            onClick={() => void decisions.approve(sheet, segment)}
                            className={buttonClass('primary', 'sm')}
                          >
                            Approve{' '}
                            <span className="sr-only">
                              {segmentName(segment)} of {sheet.employee?.name ?? 'employee'}
                            </span>
                          </button>
                          <button
                            type="button"
                            disabled={decisions.busy !== null}
                            onClick={() => void decisions.requestChanges(segment)}
                            className={buttonClass('secondary', 'sm')}
                          >
                            Request changes{' '}
                            <span className="sr-only">
                              to {segmentName(segment)} of {sheet.employee?.name ?? 'employee'}
                            </span>
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
              </div>
            </div>
          ))
        )}
        <LoadMore list={list} noun={['timesheet', 'timesheets']} />
      </div>
      {decisions.reasonDialog}
    </ReviewPanel>
  );
}
