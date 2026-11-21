'use client';

import { useMemo } from 'react';
import { formatDateOnly, formatInstant, formatMinutes, label } from '../../lib/time/format';
import type { TimeEntryRead, Timesheet, TimesheetSegment } from '../../lib/time/types';
import { buttonClass } from '../ui/button';
import { DataTable } from '../ui/data-table';
import { EmptyState, TableScroll } from '../ui/states';
import { actorLabel } from './review/review-shared';

/**
 * Batch 4E-3 — timesheet building blocks shared by the manager's timesheet detail (4E-1) and
 * the employee's own (My Time): daily time from live entries, the approved snapshot, and the
 * approval history. Presentation only; the API decides every number and every action.
 */

export interface SnapshotRow {
  workDate: string;
  employmentAssignmentId: string;
  grossMinutes: number;
  paidBreakMinutes: number;
  unpaidBreakMinutes: number;
  policyDeductionMinutes: number;
  approvedWorkedMinutes: number;
}

export function totalsOf(sheet: Timesheet) {
  const totals = (sheet.totals ?? {}) as Record<string, unknown>;
  const rows = Array.isArray(totals.payrollWorkDates)
    ? (totals.payrollWorkDates as SnapshotRow[]).filter((row) => typeof row?.workDate === 'string')
    : [];
  return { snapshot: rows, limited: totals.limitedToShownSegments === true };
}

export function segmentName(segment: TimesheetSegment) {
  return segment.assignment?.position.name ?? 'Assignment';
}

/**
 * Daily time from live entries: each work date's entries and its totals (gross, breaks, the
 * automatic deduction and payable minutes from the calculation timesheets and payroll use).
 * Shared by the manager's timesheet detail (with corrections) and the employee's (read-only).
 */
export function DailyTimeTable({
  entries,
  onCorrect,
  onLinkShift,
}: {
  entries: TimeEntryRead[];
  onCorrect?(entry: TimeEntryRead): void;
  /** Batch 4F (Q8): link, re-link or unlink the entry's scheduled shift (with corrections). */
  onLinkShift?(entry: TimeEntryRead): void;
}) {
  const hasActions = Boolean(onCorrect) || Boolean(onLinkShift);
  const days = useMemo(() => {
    const byDate = new Map<string, TimeEntryRead[]>();
    for (const entry of [...entries].sort((a, b) => a.clockInAt.localeCompare(b.clockInAt))) {
      byDate.set(entry.workDate, [...(byDate.get(entry.workDate) ?? []), entry]);
    }
    return [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [entries]);
  // A voided entry stays listed (labelled) but never counts toward a day's totals.
  const sum = (
    entries: TimeEntryRead[],
    pick: (entry: TimeEntryRead) => number | null | undefined,
  ) =>
    entries
      .filter((entry) => entry.status !== 'VOIDED')
      .reduce((total, entry) => total + (pick(entry) ?? 0), 0);

  return (
    <>
      <TableScroll label="Daily time" bare>
        <table className="w-full min-w-[860px] text-left text-sm">
          <caption className="sr-only">
            Daily time: entries, breaks, automatic deductions and payable minutes
          </caption>
          <thead className="border-b border-slate-200 text-xs uppercase text-slate-600">
            <tr>
              <th scope="col" className="px-3 py-2">
                Work date
              </th>
              <th scope="col" className="px-3 py-2">
                Assignment
              </th>
              <th scope="col" className="px-3 py-2">
                In – out
              </th>
              <th scope="col" className="px-3 py-2">
                Gross
              </th>
              <th scope="col" className="px-3 py-2">
                Paid breaks
              </th>
              <th scope="col" className="px-3 py-2">
                Unpaid breaks
              </th>
              <th scope="col" className="px-3 py-2">
                Auto deduction
              </th>
              <th scope="col" className="px-3 py-2">
                Payable
              </th>
              <th scope="col" className="px-3 py-2">
                Exceptions
              </th>
              {hasActions && (
                <th scope="col" className="px-3 py-2">
                  <span className="sr-only">Actions</span>
                </th>
              )}
            </tr>
          </thead>
          {days.map(([workDate, entries]) => (
            <tbody key={workDate} className="border-b border-slate-200">
              {entries.map((entry, index) => (
                <tr
                  key={entry.id}
                  className={entry.status === 'VOIDED' ? 'text-slate-500' : undefined}
                >
                  {index === 0 ? (
                    <th
                      scope="rowgroup"
                      rowSpan={entries.length + 1}
                      className="px-3 py-3 align-top font-semibold text-slate-900"
                    >
                      {formatDateOnly(workDate)}
                    </th>
                  ) : null}
                  <td className="px-3 py-2">{entry.assignment.position.name}</td>
                  <td className="px-3 py-2">
                    {formatInstant(entry.clockInAt, entry.timezone)} –{' '}
                    {entry.clockOutAt
                      ? formatInstant(entry.clockOutAt, entry.timezone)
                      : 'still open'}
                    {entry.status === 'VOIDED' && (
                      <span className="ml-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-700">
                        Voided · not counted
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2">{formatMinutes(entry.grossMinutes)}</td>
                  <td className="px-3 py-2">{formatMinutes(entry.paidBreakMinutes)}</td>
                  <td className="px-3 py-2">{formatMinutes(entry.unpaidBreakMinutes)}</td>
                  <td className="px-3 py-2">{formatMinutes(entry.policyDeductionMinutes)}</td>
                  <td className="px-3 py-2 font-medium text-slate-900">
                    {formatMinutes(entry.payableMinutes)}
                  </td>
                  <td className="px-3 py-2">
                    {entry.exceptions.length === 0
                      ? '—'
                      : entry.exceptions
                          .map(
                            (exception) =>
                              `${label(exception.type)} (${label(exception.status).toLowerCase()})`,
                          )
                          .join(', ')}
                  </td>
                  {hasActions && (
                    <td className="px-3 py-2 text-right">
                      {entry.status !== 'VOIDED' && (
                        <div className="flex flex-wrap justify-end gap-2">
                          {onCorrect && (
                            <button
                              type="button"
                              onClick={() => onCorrect(entry)}
                              className={buttonClass('secondary', 'sm')}
                            >
                              Correct{' '}
                              <span className="sr-only">
                                the {formatDateOnly(workDate)} entry for{' '}
                                {entry.assignment.position.name}
                              </span>
                            </button>
                          )}
                          {onLinkShift && (
                            <button
                              type="button"
                              onClick={() => onLinkShift(entry)}
                              className={buttonClass('secondary', 'sm')}
                            >
                              {entry.scheduledShiftId ? 'Change shift link' : 'Link shift'}{' '}
                              <span className="sr-only">
                                for the {formatDateOnly(workDate)} entry for{' '}
                                {entry.assignment.position.name}
                              </span>
                            </button>
                          )}
                        </div>
                      )}
                    </td>
                  )}
                </tr>
              ))}
              <tr className="bg-slate-50 text-slate-800">
                <td className="px-3 py-2 text-xs font-semibold uppercase" colSpan={2}>
                  Day total
                </td>
                <td className="px-3 py-2 font-semibold">
                  {formatMinutes(sum(entries, (e) => e.grossMinutes))}
                </td>
                <td className="px-3 py-2">
                  {formatMinutes(sum(entries, (e) => e.paidBreakMinutes))}
                </td>
                <td className="px-3 py-2">
                  {formatMinutes(sum(entries, (e) => e.unpaidBreakMinutes))}
                </td>
                <td className="px-3 py-2">
                  {formatMinutes(sum(entries, (e) => e.policyDeductionMinutes))}
                </td>
                <td className="px-3 py-2 font-semibold">
                  {formatMinutes(sum(entries, (e) => e.payableMinutes))}
                </td>
                <td colSpan={hasActions ? 2 : 1} />
              </tr>
            </tbody>
          ))}
        </table>
      </TableScroll>
    </>
  );
}

export function SnapshotDays({ sheet }: { sheet: Timesheet }) {
  const { snapshot } = totalsOf(sheet);
  const names = new Map(
    sheet.segments.map((segment) => [segment.employmentAssignmentId, segmentName(segment)]),
  );
  if (snapshot.length === 0) return <EmptyState title="No approved time in this timesheet." />;
  return (
    <DataTable
      bare
      label="Approved daily time"
      caption="Approved daily time (stored snapshot)"
      minWidth="min-w-[720px]"
      rows={[...snapshot].sort((a, b) => a.workDate.localeCompare(b.workDate))}
      rowKey={(row) => `${row.workDate}-${row.employmentAssignmentId}`}
      columns={[
        {
          key: 'workDate',
          header: 'Work date',
          rowHeader: true,
          className: 'text-slate-900',
          cell: (row) => formatDateOnly(row.workDate),
        },
        {
          key: 'assignment',
          header: 'Assignment',
          cell: (row) => names.get(row.employmentAssignmentId) ?? 'Assignment',
        },
        { key: 'gross', header: 'Gross', cell: (row) => formatMinutes(row.grossMinutes) },
        {
          key: 'paidBreaks',
          header: 'Paid breaks',
          cell: (row) => formatMinutes(row.paidBreakMinutes),
        },
        {
          key: 'unpaidBreaks',
          header: 'Unpaid breaks',
          cell: (row) => formatMinutes(row.unpaidBreakMinutes),
        },
        {
          key: 'deduction',
          header: 'Auto deduction',
          cell: (row) => formatMinutes(row.policyDeductionMinutes),
        },
        {
          key: 'approved',
          header: 'Approved',
          className: 'font-semibold',
          cell: (row) => formatMinutes(row.approvedWorkedMinutes),
        },
      ]}
    />
  );
}

const EVENT_TEXT: Record<string, string> = {
  SUBMITTED: 'Submitted',
  SEGMENT_APPROVED: 'Assignment approved',
  CHANGES_REQUESTED: 'Changes requested',
  APPROVED: 'Timesheet approved',
  LOCKED: 'Locked',
  REOPENED: 'Reopened',
};

export function TimesheetHistory({
  sheet,
  currentUserId,
}: {
  sheet: Timesheet;
  currentUserId: string | null;
}) {
  const events = [...sheet.events].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  if (events.length === 0)
    return <EmptyState title="Nothing has happened to this timesheet yet." />;
  const segments = new Map(sheet.segments.map((segment) => [segment.id, segmentName(segment)]));
  return (
    <ol className="space-y-2 border-l-2 border-slate-200 pl-4">
      {events.map((event) => (
        <li key={event.id} className="text-sm">
          <p className="font-medium text-slate-900">
            {EVENT_TEXT[event.type] ?? label(event.type)}
            {event.segmentId && segments.get(event.segmentId)
              ? ` · ${segments.get(event.segmentId)}`
              : ''}
          </p>
          <p className="text-slate-700">
            {actorLabel(sheet.actors, event.actorUserId, currentUserId)} ·{' '}
            {formatInstant(event.occurredAt, null)}
          </p>
          {event.note && <p className="text-slate-700">Note: {event.note}</p>}
        </li>
      ))}
    </ol>
  );
}
