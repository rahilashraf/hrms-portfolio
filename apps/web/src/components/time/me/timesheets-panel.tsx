'use client';

import { useCallback, useEffect, useState } from 'react';
import { timeApi } from '../../../lib/time/api';
import { timeErrorCode, timeErrorMessage } from '../../../lib/time/errors';
import { formatDateOnly, formatMinutes } from '../../../lib/time/format';
import type { TimeEntryRead, Timesheet, TimeStatus } from '../../../lib/time/types';
import { buttonClass } from '../../ui/button';
import { DataTable } from '../../ui/data-table';
import { EmptyState, ErrorState, LoadingState } from '../../ui/states';
import { useConfirm } from '../../ui/use-confirm';
import { FINALIZED_STATUSES, TimesheetStatusBadge } from '../review/review-shared';
import {
  DailyTimeTable,
  segmentName,
  SnapshotDays,
  TimesheetHistory,
  totalsOf,
} from '../timesheet-parts';
import { isReadOnly, ReadOnlyBadge } from '../time-notices';
import { openMyTime, organizationsOf, Section } from './shared';

/**
 * Batch 4E-3 — Timesheets: the employee's timesheets per period and organization, one in detail
 * (totals per assignment, daily time — live while it is open, the stored snapshot once approved
 * or locked — the reviewer's note and the history), and submission after reviewing the totals:
 * the totals and version seen are sent, so changed numbers are never submitted blind. Employees
 * never approve, lock, reopen or edit a timesheet.
 */
export function TimesheetsPanel({
  status,
  timesheetId,
}: {
  status: TimeStatus | null;
  timesheetId: string | null;
}) {
  if (timesheetId) {
    return <TimesheetView key={timesheetId} status={status} timesheetId={timesheetId} />;
  }
  return <TimesheetList status={status} />;
}

function organizationName(status: TimeStatus | null, id: string | undefined) {
  return organizationsOf(status).find((item) => item.id === id)?.name ?? 'Organization';
}

function netOf(sheet: Timesheet): number | null {
  const value = (sheet.totals ?? {})['netWorkedMinutes'];
  return typeof value === 'number' ? value : null;
}

function TimesheetList({ status }: { status: TimeStatus | null }) {
  const [sheets, setSheets] = useState<Timesheet[] | null>(null);
  const [disabledIds, setDisabledIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const result = await timeApi.selfTimesheets();
      setSheets(result.timesheets);
      setDisabledIds(result.attendanceDisabledOrganizationIds ?? []);
      setError(null);
    } catch (cause) {
      setSheets([]);
      setError(timeErrorMessage(cause, 'Unable to load your timesheets.'));
    }
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  return (
    <Section
      title="Timesheets"
      description="One timesheet per period and organization. Open one to review it and submit it."
    >
      {sheets === null ? (
        <LoadingState label="Loading your timesheets…" />
      ) : error ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : sheets.length === 0 ? (
        <EmptyState title="No timesheets yet." />
      ) : (
        <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
          {sheets.map((sheet) => {
            const dates = sheet.period
              ? `${formatDateOnly(sheet.period.startDate)} – ${formatDateOnly(sheet.period.endDate)}`
              : 'Period';
            return (
              <li
                key={sheet.id}
                className="flex flex-wrap items-center justify-between gap-3 p-3 text-sm"
              >
                <div>
                  <p className="font-medium text-slate-950">{dates}</p>
                  <p className="text-slate-600">
                    {organizationName(status, sheet.period?.organizationId)} · payable{' '}
                    {formatMinutes(netOf(sheet))}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  {isReadOnly(disabledIds, sheet.period?.organizationId) && <ReadOnlyBadge />}
                  <TimesheetStatusBadge status={sheet.status} />
                  <button
                    type="button"
                    className={buttonClass('secondary', 'sm')}
                    onClick={() => openMyTime('timesheets', { timesheet: sheet.id })}
                  >
                    Open <span className="sr-only">the timesheet for {dates}</span>
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

/** Every one of the employee's entries in the period's organization and dates. */
async function periodEntries(sheet: Timesheet): Promise<TimeEntryRead[]> {
  const entries: TimeEntryRead[] = [];
  let afterId: string | undefined;
  for (let page = 0; page < 20; page += 1) {
    const result = await timeApi.selfEntries({
      organizationId: sheet.period!.organizationId,
      startDate: sheet.period!.startDate,
      endDate: sheet.period!.endDate,
      limit: 100,
      ...(afterId ? { afterId } : {}),
    });
    entries.push(...result.items);
    if (!result.nextAfterId) break;
    afterId = result.nextAfterId;
  }
  return entries;
}

function TimesheetView({
  status,
  timesheetId,
}: {
  status: TimeStatus | null;
  timesheetId: string;
}) {
  const [sheet, setSheet] = useState<Timesheet | null>(null);
  const [entries, setEntries] = useState<TimeEntryRead[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, confirmDialog] = useConfirm();

  const load = useCallback(async () => {
    try {
      const next = await timeApi.selfTimesheet(timesheetId);
      setSheet(next);
      setError(null);
      if (!FINALIZED_STATUSES.has(next.status) && next.period) {
        setEntries(null);
        setEntries(await periodEntries(next));
      }
    } catch (cause) {
      setError(timeErrorMessage(cause, 'Unable to load this timesheet.'));
    }
  }, [timesheetId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function submit() {
    if (!sheet) return;
    const net = netOf(sheet);
    const ok = await confirm({
      title: 'Submit this timesheet?',
      description: `You are submitting ${formatMinutes(net)} payable for ${formatDateOnly(
        sheet.period?.startDate,
      )} – ${formatDateOnly(sheet.period?.endDate)}. Your manager reviews it next.`,
      confirmLabel: 'Submit timesheet',
      destructive: false,
    });
    if (!ok) return;
    setBusy(true);
    setNotice(null);
    try {
      await timeApi.submitTimesheet(sheet.id, {
        ...(net !== null ? { expectedNetWorkedMinutes: net } : {}),
        expectedVersion: sheet.version,
      });
      await load();
      setNotice({ kind: 'success', text: 'Timesheet submitted.' });
    } catch (cause) {
      if (timeErrorCode(cause) === 'TIMESHEET_TOTALS_CHANGED') await load();
      setNotice({
        kind: 'error',
        text: timeErrorMessage(cause, 'Unable to submit this timesheet.'),
      });
    } finally {
      setBusy(false);
    }
  }

  if (error) {
    return (
      <Section title="Timesheet">
        <ErrorState message={error} onRetry={() => void load()} />
        <BackToList />
      </Section>
    );
  }
  if (!sheet) {
    return (
      <Section title="Timesheet">
        <LoadingState label="Loading the timesheet…" />
      </Section>
    );
  }
  const dates = sheet.period
    ? `${formatDateOnly(sheet.period.startDate)} – ${formatDateOnly(sheet.period.endDate)}`
    : 'Timesheet';
  const final = FINALIZED_STATUSES.has(sheet.status);
  // Batch 4F (C10): attendance turned off: the timesheet is history, read only.
  const readOnly = sheet.attendanceEnabled === false;
  const canSubmit = !readOnly && (sheet.status === 'OPEN' || sheet.status === 'CHANGES_REQUESTED');
  const notes = [
    ...(sheet.reviewerNote ? [sheet.reviewerNote] : []),
    // Only the notes of the segments currently returned (Batch 4F: a resubmitted segment is
    // pending again; its earlier note stays in the history).
    ...sheet.segments
      .filter((segment) => segment.status === 'CHANGES_REQUESTED')
      .map((segment) => segment.reviewerNote)
      .filter((note): note is string => Boolean(note) && note !== sheet.reviewerNote),
  ];
  const { limited } = totalsOf(sheet);

  return (
    <div className="space-y-6">
      {confirmDialog}
      <Section title={`Timesheet ${dates}`}>
        <div className="flex flex-wrap items-center gap-3">
          <TimesheetStatusBadge status={sheet.status} />
          {readOnly && <ReadOnlyBadge />}
          <span className="text-sm text-slate-700">
            {organizationName(status, sheet.period?.organizationId)} · version {sheet.version}
          </span>
        </div>
        {readOnly && (
          <p className="mt-3 rounded-lg bg-slate-50 p-3 text-sm text-slate-800">
            Time &amp; attendance is turned off for this organization. This timesheet is shown as
            stored and cannot be submitted or changed.
          </p>
        )}
        {notice && (
          <p
            role={notice.kind === 'error' ? 'alert' : 'status'}
            className={`mt-3 rounded-lg px-3 py-2 text-sm ${
              notice.kind === 'error'
                ? 'bg-rose-50 text-rose-900'
                : 'bg-emerald-50 text-emerald-900'
            }`}
          >
            {notice.text}
          </p>
        )}
        {sheet.status === 'CHANGES_REQUESTED' && !readOnly && (
          <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
            <p className="font-semibold">Your manager asked for changes.</p>
            {notes.map((note) => (
              <p key={note}>“{note}”</p>
            ))}
            <p className="mt-1">
              Request any corrections needed, then submit again.{' '}
              <button
                type="button"
                className="font-semibold underline"
                onClick={() => openMyTime('requests')}
              >
                Go to requests
              </button>
            </p>
          </div>
        )}
        {final && (
          <p className="mt-3 rounded-lg bg-slate-50 p-3 text-sm text-slate-800">
            {sheet.status === 'LOCKED' ? 'Locked' : 'Approved'}: these are the stored, approved
            numbers. Later changes to attendance or policies never alter them.
          </p>
        )}
        <div className="mt-4">
          <DataTable
            bare
            label="Totals by assignment"
            minWidth="min-w-[640px]"
            rows={sheet.segments}
            rowKey={(segment) => segment.id}
            empty="No assignments in this timesheet."
            columns={[
              {
                key: 'assignment',
                header: 'Assignment',
                rowHeader: true,
                className: 'text-slate-900',
                cell: (segment) => segmentName(segment),
              },
              {
                key: 'gross',
                header: 'Gross',
                cell: (segment) => formatMinutes(segment.grossMinutes),
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
                key: 'payable',
                header: 'Payable',
                className: 'font-semibold',
                cell: (segment) => formatMinutes(segment.netWorkedMinutes),
              },
              {
                key: 'approved',
                header: 'Approved',
                cell: (segment) =>
                  segment.status === 'APPROVED'
                    ? formatMinutes(segment.approvedWorkedMinutes)
                    : '—',
              },
            ]}
          />
        </div>
        {limited && (
          <p className="mt-2 text-xs text-slate-600">Shows this organization’s assignments only.</p>
        )}
        {canSubmit && (
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button
              type="button"
              disabled={busy}
              onClick={() => void submit()}
              className={buttonClass('primary')}
            >
              {busy
                ? 'Submitting…'
                : sheet.status === 'CHANGES_REQUESTED'
                  ? 'Review and resubmit'
                  : 'Review and submit'}
            </button>
            <span className="text-sm text-slate-600">
              Payable {formatMinutes(netOf(sheet))}. You confirm these totals before submitting.
            </span>
          </div>
        )}
      </Section>
      <Section
        title={final ? 'Approved daily time' : 'Daily time'}
        description={
          final
            ? 'The stored snapshot of this timesheet.'
            : 'Your entries in this period, with the automatic deduction and payable minutes.'
        }
        headingLevel={3}
      >
        {final ? (
          <SnapshotDays sheet={sheet} />
        ) : entries === null ? (
          <LoadingState label="Loading daily time…" />
        ) : entries.length === 0 ? (
          <EmptyState title="No time recorded in this period." />
        ) : (
          <DailyTimeTable entries={entries} />
        )}
      </Section>
      <Section title="History" headingLevel={3}>
        <TimesheetHistory sheet={sheet} currentUserId={null} />
      </Section>
      <BackToList />
    </div>
  );
}

function BackToList() {
  return (
    <button
      type="button"
      className={buttonClass('ghost', 'sm')}
      onClick={() => openMyTime('timesheets')}
    >
      ← All timesheets
    </button>
  );
}
