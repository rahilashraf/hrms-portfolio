'use client';

import { useCallback, useEffect, useState } from 'react';
import { timeApi } from '../../../lib/time/api';
import { timeErrorMessage } from '../../../lib/time/errors';
import { formatDateOnly, formatInstant, formatMinutes, label } from '../../../lib/time/format';
import type { TimeEntryRead, Timesheet, TimesheetSegment } from '../../../lib/time/types';
import { buttonClass } from '../../ui/button';
import { DataTable } from '../../ui/data-table';
import { EmptyState, ErrorState, LoadingState } from '../../ui/states';
import { useConfirm, useConfirmWithReason } from '../../ui/use-confirm';
import {
  DailyTimeTable,
  segmentName,
  SnapshotDays,
  TimesheetHistory as History,
  totalsOf,
} from '../timesheet-parts';
import { AddEntryDialog, CorrectEntryDialog } from './entry-dialogs';
import { LinkShiftDialog } from './link-shift-dialog';
import {
  actorLabel,
  FINALIZED_STATUSES,
  LoadMore,
  resolutionLabel,
  ReviewPanel,
  TimesheetStatusBadge,
  usePagedList,
  type ReviewOrganization,
  historyQuery,
} from './review-shared';
import { Feedback, addDays, periodLabel, useSegmentDecisions } from './timesheet-review-shared';

// Batch 10C: one timesheet in detail (moved from timesheet-review.tsx unchanged). Approval still
// sends the minutes and version the reviewer saw.
// ─── One timesheet ───────────────────────────────────────────────────────────

function DailyEntries({
  organization,
  sheet,
  onCorrect,
  onLinkShift,
  reloadKey,
}: {
  organization: ReviewOrganization;
  sheet: Timesheet;
  onCorrect(entry: TimeEntryRead): void;
  onLinkShift(entry: TimeEntryRead): void;
  reloadKey: number;
}) {
  const canCorrect = Boolean(organization.actions.canCorrectTime);
  const fetchPage = useCallback(
    (afterId?: string) =>
      timeApi.managementEntries({
        organizationId: organization.id,
        ...historyQuery(organization),
        employeeId: sheet.employeeId,
        startDate: sheet.period!.startDate,
        endDate: sheet.period!.endDate,
        limit: 100,
        ...(afterId ? { afterId } : {}),
      }),
    // reloadKey: reload after a correction.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [organization.id, sheet.employeeId, sheet.period?.startDate, sheet.period?.endDate, reloadKey],
  );
  const list = usePagedList(fetchPage, 'Unable to load daily time.');
  // A reload after a correction keeps the rows (and the focused row action) on screen.
  if (list.loading && list.items.length === 0) return <LoadingState label="Loading daily time…" />;
  if (list.error) {
    return (
      <ErrorState
        title="Daily time could not be loaded"
        message={list.error}
        onRetry={() => void list.reload()}
      />
    );
  }
  if (list.items.length === 0) return <EmptyState title="No time recorded in this period." />;
  return (
    <>
      <DailyTimeTable
        entries={list.items}
        onCorrect={canCorrect ? onCorrect : undefined}
        onLinkShift={canCorrect ? onLinkShift : undefined}
      />
      <LoadMore list={list} noun={['entry', 'entries']} />
    </>
  );
}

function PeriodExceptions({
  organization,
  sheet,
  currentUserId,
}: {
  organization: ReviewOrganization;
  sheet: Timesheet;
  currentUserId: string | null;
}) {
  const fetchPage = useCallback(
    (afterId?: string) =>
      timeApi.managementExceptions({
        organizationId: organization.id,
        ...historyQuery(organization),
        employeeId: sheet.employeeId,
        // Detected from the period's first day to a week after its last (a missed clock-out is
        // detected after the day it belongs to); shown by work date below.
        startDate: sheet.period!.startDate,
        endDate: addDays(sheet.period!.endDate, 7),
        limit: 50,
        ...(afterId ? { afterId } : {}),
      }),
    [organization, sheet.employeeId, sheet.period],
  );
  const list = usePagedList(fetchPage, 'Unable to load exceptions.');
  const end = sheet.period!.endDate;
  const start = sheet.period!.startDate;
  // Detected on or after the period start; only those whose work date is in the period.
  const inPeriod = list.items.filter(
    (exception) =>
      !exception.workDate || (exception.workDate >= start && exception.workDate <= end),
  );
  if (list.loading) return <LoadingState label="Loading exceptions…" />;
  if (list.error) return <ErrorState message={list.error} onRetry={() => void list.reload()} />;
  if (inPeriod.length === 0 && !list.hasMore) {
    return <EmptyState title="No exceptions in this period." />;
  }
  return (
    <>
      <ul className="space-y-2">
        {inPeriod.map((exception) => (
          <li key={exception.id} className="rounded-md border border-slate-200 p-3 text-sm">
            <p className="font-medium text-slate-900">
              {label(exception.type)} · {formatDateOnly(exception.workDate)} ·{' '}
              {label(exception.status)}
            </p>
            {exception.status !== 'OPEN' && (
              <p className="text-slate-700">
                {resolutionLabel(exception.status, exception.resolutionMethod)}
                {exception.resolvedByUserId &&
                  ` · ${actorLabel(exception.actors, exception.resolvedByUserId, currentUserId)}`}
                {exception.resolutionNote && ` · ${exception.resolutionNote}`}
              </p>
            )}
          </li>
        ))}
      </ul>
      <LoadMore list={list} noun={['exception', 'exceptions']} />
    </>
  );
}

export function TimesheetDetail({
  organization,
  periodId,
  employeeId,
  currentUserId,
  onBack,
}: {
  organization: ReviewOrganization;
  periodId: string;
  employeeId: string;
  currentUserId: string | null;
  onBack(): void;
}) {
  const { actions } = organization;
  const [sheet, setSheet] = useState<Timesheet | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [entriesKey, setEntriesKey] = useState(0);
  const [correcting, setCorrecting] = useState<TimeEntryRead | null>(null);
  const [linking, setLinking] = useState<TimeEntryRead | null>(null);
  const [adding, setAdding] = useState(false);
  const [confirm, confirmDialog] = useConfirm();
  const [confirmWithReason, reasonDialog] = useConfirmWithReason();

  const load = useCallback(async () => {
    try {
      const page = await timeApi.managementTimesheets({
        organizationId: organization.id,
        ...historyQuery(organization),
        timePeriodId: periodId,
        employeeId,
        limit: 1,
      });
      setSheet(page.items[0] ?? null);
      setLoadError(null);
    } catch (cause) {
      setSheet(null);
      setLoadError(timeErrorMessage(cause, 'Unable to load this timesheet.'));
    } finally {
      setLoading(false);
    }
  }, [organization, periodId, employeeId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const decisions = useSegmentDecisions(async (message) => {
    setSuccess(message || null);
    await load();
  });

  async function run(action: () => Promise<unknown>, message: string, fallback: string) {
    setBusy(true);
    setActionError(null);
    setSuccess(null);
    try {
      await action();
      setSuccess(message);
    } catch (cause) {
      setActionError(timeErrorMessage(cause, fallback));
    } finally {
      await load();
      setBusy(false);
    }
  }

  if (loading) return <LoadingState label="Loading timesheet…" />;
  const back = (
    <button type="button" onClick={onBack} className={buttonClass('ghost', 'sm')}>
      ← Back to timesheets
    </button>
  );
  if (loadError || !sheet) {
    return (
      <div className="space-y-3">
        {back}
        {loadError ? (
          <ErrorState message={loadError} onRetry={() => void load()} />
        ) : (
          <EmptyState
            title="No timesheet to review"
            description="There is no timesheet for this employee and period that you can review."
          />
        )}
      </div>
    );
  }

  const finalized = FINALIZED_STATUSES.has(sheet.status);
  const { limited } = totalsOf(sheet);
  const canApprove = Boolean(actions.canApproveTimesheets) && sheet.status === 'SUBMITTED';
  const canManage = Boolean(actions.canManageTimesheets);
  const who = (id: string | null) => actorLabel(sheet.actors, id, currentUserId);
  const audit: Array<[string, string | null, string | null]> = [
    ['Submitted', sheet.submittedByUserId, sheet.submittedAt],
    ['Approved', sheet.approvedByUserId, sheet.approvedAt],
    ['Locked', sheet.lockedByUserId, sheet.lockedAt],
    ['Reopened', sheet.reopenedByUserId, sheet.reopenedAt],
  ];

  return (
    <div className="space-y-4">
      {back}
      <ReviewPanel
        title={`${sheet.employee?.name ?? 'Employee'} · ${periodLabel(sheet.period)}`}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <TimesheetStatusBadge status={sheet.status} />
            {sheet.employee?.employeeNumber && (
              <span>Employee {sheet.employee.employeeNumber}</span>
            )}
            <span>Version {sheet.version}</span>
          </span>
        }
        actions={
          canManage ? (
            <>
              {(sheet.status === 'OPEN' || sheet.status === 'CHANGES_REQUESTED') && (
                <button
                  type="button"
                  disabled={busy}
                  className={buttonClass('secondary', 'sm')}
                  onClick={async () => {
                    const reason = await confirmWithReason({
                      title: 'Submit on the employee’s behalf?',
                      description:
                        'Use this when the employee can’t submit. Your reason is recorded.',
                      confirmLabel: 'Submit timesheet',
                      destructive: false,
                      reason: { label: 'Reason', required: true, maxLength: 1000 },
                    });
                    if (reason === null) return;
                    await run(
                      () => timeApi.submitTimesheetOnBehalf(sheet.id, reason),
                      'Timesheet submitted on the employee’s behalf.',
                      'Unable to submit this timesheet.',
                    );
                  }}
                >
                  Submit on behalf
                </button>
              )}
              {sheet.status === 'APPROVED' && (
                <button
                  type="button"
                  disabled={busy}
                  className={buttonClass('secondary', 'sm')}
                  onClick={async () => {
                    const go = await confirm({
                      title: 'Lock this timesheet?',
                      description:
                        'Locking keeps the approved totals as they are. It can be reopened later with a reason.',
                      confirmLabel: 'Lock timesheet',
                      destructive: false,
                    });
                    if (!go) return;
                    await run(
                      () => timeApi.lockTimesheet(sheet.id, sheet.version),
                      'Timesheet locked.',
                      'Unable to lock this timesheet.',
                    );
                  }}
                >
                  Lock
                </button>
              )}
              {finalized && (
                <button
                  type="button"
                  disabled={busy}
                  className={buttonClass('danger', 'sm')}
                  onClick={async () => {
                    const note = await confirmWithReason({
                      title: 'Reopen this timesheet?',
                      description:
                        'It returns for changes and must be approved again. Payroll that already used the approved totals is not changed.',
                      confirmLabel: 'Reopen timesheet',
                      reason: { label: 'Reason for reopening', required: true, maxLength: 1000 },
                    });
                    if (note === null) return;
                    await run(
                      () => timeApi.reopenTimesheet(sheet.id, note, sheet.version),
                      'Timesheet reopened.',
                      'Unable to reopen this timesheet.',
                    );
                  }}
                >
                  Reopen
                </button>
              )}
            </>
          ) : undefined
        }
      >
        <div className="space-y-3">
          <Feedback error={actionError ?? decisions.error} success={success} />
          {limited && (
            <p className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700">
              Totals cover only the assignments you can review in this organization.
            </p>
          )}
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
            {audit
              .filter(([, , at]) => at)
              .map(([what, by, at]) => (
                <div key={what}>
                  <dt className="text-slate-600">{what}</dt>
                  <dd className="font-medium text-slate-900">
                    {who(by)} · {formatInstant(at, null)}
                  </dd>
                </div>
              ))}
          </dl>
          {sheet.reviewerNote && (
            <p className="text-sm text-slate-800">Reviewer note: {sheet.reviewerNote}</p>
          )}
          <DataTable
            bare
            label="Assignments"
            caption="Assignments in this timesheet"
            minWidth="min-w-[900px]"
            rows={sheet.segments}
            rowKey={(segment) => segment.id}
            columns={[
              {
                key: 'assignment',
                header: 'Assignment',
                rowHeader: true,
                className: 'text-slate-900',
                cell: (segment) => segmentName(segment),
              },
              {
                key: 'status',
                header: 'Status',
                cell: (segment) => <TimesheetStatusBadge status={segment.status} />,
              },
              {
                key: 'gross',
                header: 'Gross',
                cell: (segment) => formatMinutes(segment.grossMinutes),
              },
              {
                key: 'paidBreaks',
                header: 'Paid breaks',
                cell: (segment) => formatMinutes(segment.paidBreakMinutes),
              },
              {
                key: 'unpaidBreaks',
                header: 'Unpaid breaks',
                cell: (segment) => formatMinutes(segment.unpaidBreakMinutes),
              },
              {
                key: 'deduction',
                header: 'Auto deduction',
                cell: (segment) => formatMinutes(segment.policyDeductionMinutes),
              },
              {
                key: 'net',
                header: 'Net',
                className: 'font-semibold',
                cell: (segment) => formatMinutes(segment.netWorkedMinutes),
              },
              {
                key: 'approved',
                header: 'Approved',
                cell: (segment) => formatMinutes(segment.approvedWorkedMinutes),
              },
              {
                key: 'reviewed',
                header: 'Reviewed',
                cell: (segment) =>
                  /* Batch 4F: a decision shows only while it stands (approved or returned);
                     a resubmitted segment is pending again and its earlier decision lives
                     in the approval history below. */
                  segment.reviewedAt &&
                  (segment.status === 'APPROVED' || segment.status === 'CHANGES_REQUESTED') ? (
                    <>
                      {who(segment.reviewedByUserId)} · {formatInstant(segment.reviewedAt, null)}
                      {segment.reviewerNote && (
                        <span className="block text-xs text-slate-600">
                          Note: {segment.reviewerNote}
                        </span>
                      )}
                    </>
                  ) : (
                    '—'
                  ),
              },
              ...(canApprove
                ? [
                    {
                      key: 'decision',
                      header: <span className="sr-only">Decision</span>,
                      cell: (segment: TimesheetSegment) =>
                        segment.status === 'PENDING' && (
                          <div className="flex justify-end gap-2">
                            <button
                              type="button"
                              disabled={decisions.busy !== null}
                              onClick={() => void decisions.approve(sheet, segment)}
                              className={buttonClass('primary', 'sm')}
                            >
                              Approve <span className="sr-only">{segmentName(segment)}</span>
                            </button>
                            <button
                              type="button"
                              disabled={decisions.busy !== null}
                              onClick={() => void decisions.requestChanges(segment)}
                              className={buttonClass('secondary', 'sm')}
                            >
                              Request changes{' '}
                              <span className="sr-only">for {segmentName(segment)}</span>
                            </button>
                          </div>
                        ),
                    },
                  ]
                : []),
            ]}
          />
        </div>
      </ReviewPanel>

      <ReviewPanel
        title="Daily time"
        headingLevel={3}
        description={
          finalized
            ? 'The approved snapshot: these stored totals are what payroll uses and they never change. Reopen the timesheet to correct time.'
            : actions.canViewAttendance
              ? 'Recorded entries with breaks, the automatic deduction and payable minutes, calculated as the timesheet totals are.'
              : undefined
        }
        actions={
          !finalized && actions.canCorrectTime ? (
            <button
              type="button"
              onClick={() => setAdding(true)}
              className={buttonClass('secondary', 'sm')}
            >
              Add missing entry
            </button>
          ) : undefined
        }
      >
        {finalized ? (
          <SnapshotDays sheet={sheet} />
        ) : actions.canViewAttendance ? (
          <DailyEntries
            organization={organization}
            sheet={sheet}
            reloadKey={entriesKey}
            onCorrect={setCorrecting}
            onLinkShift={setLinking}
          />
        ) : (
          <p className="rounded-lg bg-slate-50 px-3 py-3 text-sm text-slate-800">
            Daily entries are shown to people who can view attendance records in this organization.
            You can approve using the assignment totals above; once approved, the stored daily
            totals appear here.
          </p>
        )}
      </ReviewPanel>

      {actions.canViewAttendance && (
        <ReviewPanel title="Exceptions" headingLevel={3}>
          <PeriodExceptions
            organization={organization}
            sheet={sheet}
            currentUserId={currentUserId}
          />
        </ReviewPanel>
      )}

      <ReviewPanel title="Approval history" headingLevel={3}>
        <History sheet={sheet} currentUserId={currentUserId} />
      </ReviewPanel>

      <CorrectEntryDialog
        entry={correcting}
        coverageOptions={sheet.segments.map((segment) => ({
          id: segment.employmentAssignmentId,
          name: segmentName(segment),
        }))}
        onClose={() => setCorrecting(null)}
        onDone={(message) => {
          setCorrecting(null);
          setSuccess(message);
          setEntriesKey((key) => key + 1);
          void load();
        }}
      />
      <LinkShiftDialog
        entry={linking}
        organizationId={organization.id}
        onClose={() => setLinking(null)}
        onDone={(message) => {
          setLinking(null);
          setSuccess(message);
          setEntriesKey((key) => key + 1);
          void load();
        }}
      />
      <AddEntryDialog
        target={
          adding
            ? {
                employeeId: sheet.employeeId,
                employeeName: sheet.employee?.name ?? 'Employee',
                timezone: organization.timezone ?? 'UTC',
                assignments: sheet.segments.map((segment) => ({
                  id: segment.employmentAssignmentId,
                  name: segmentName(segment),
                })),
                defaultDate: sheet.period?.startDate ?? '',
              }
            : null
        }
        onClose={() => setAdding(false)}
        onDone={(message) => {
          setAdding(false);
          setSuccess(message);
          setEntriesKey((key) => key + 1);
          void load();
        }}
      />
      {confirmDialog}
      {reasonDialog}
      {decisions.reasonDialog}
    </div>
  );
}
