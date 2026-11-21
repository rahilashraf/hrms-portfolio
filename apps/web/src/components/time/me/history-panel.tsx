'use client';

import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { attendanceApi } from '../../../lib/attendance/api';
import type { SignInDetail } from '../../../lib/attendance/types';
import { todayIn } from '../../../lib/scheduling/time';
import { timeApi } from '../../../lib/time/api';
import { timeErrorMessage } from '../../../lib/time/errors';
import { formatDateOnly, formatInstant, formatMinutes, label } from '../../../lib/time/format';
import type { ExpectedAttendanceItem, TimeEntryRead, TimeStatus } from '../../../lib/time/types';
import { buttonClass } from '../../ui/button';
import { DataTable } from '../../ui/data-table';
import { EmptyState, ErrorState, LoadingState } from '../../ui/states';
import { inputClass } from '../../ui/tokens';
import { LoadMore, usePagedList } from '../review/review-shared';
import { isReadOnly, ReadOnlyBadge } from '../time-notices';
import { assignmentName, openMyTime, organizationsOf, Section, shiftDate, timeIn } from './shared';

/**
 * Batch 4E-3 — History: the employee's entries, paged, with breaks, the automatic deduction and
 * payable minutes (the calculation timesheets and payroll use), voided and corrected entries
 * labelled, and presence sign-ins with the occurrence each confirmed. The employee never edits a
 * record here: a change is a correction request, reviewed by a manager.
 */
export function HistoryPanel({
  status,
  date,
  attendanceOff = false,
}: {
  status: TimeStatus | null;
  date: string | null;
  /** Batch 4F (C10): every organization of the employee has Time & attendance turned off. */
  attendanceOff?: boolean;
}) {
  const organizations = organizationsOf(status);
  const [organizationId, setOrganizationId] = useState('');
  const [from, setFrom] = useState(date ?? '');
  const [to, setTo] = useState(date ?? '');
  const ids = { organization: useId(), from: useId(), to: useId() };
  const presence = (status?.assignmentCapabilities ?? []).some(
    (item) => item.trackingMode === 'SIGN_IN_ONLY',
  );

  const fetchPage = useCallback(
    (afterId?: string) =>
      timeApi.selfEntries({
        ...(organizationId ? { organizationId } : {}),
        ...(from ? { startDate: from } : {}),
        ...(to ? { endDate: to } : {}),
        limit: 25,
        ...(afterId ? { afterId } : {}),
      }),
    [organizationId, from, to],
  );
  const list = usePagedList(fetchPage, 'Unable to load your attendance history.');

  return (
    <div className="space-y-6">
      <Section
        title="Attendance history"
        description="Your recorded time. To change a record, request a correction: the original punches are always kept."
      >
        <div className="mb-4 grid gap-3 sm:grid-cols-3">
          {organizations.length > 1 && (
            <div>
              <label
                htmlFor={ids.organization}
                className="block text-sm font-medium text-slate-700"
              >
                Organization
              </label>
              <select
                id={ids.organization}
                value={organizationId}
                onChange={(event) => setOrganizationId(event.target.value)}
                className={inputClass}
              >
                <option value="">All organizations</option>
                {organizations.map((organization) => (
                  <option key={organization.id} value={organization.id}>
                    {organization.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div>
            <label htmlFor={ids.from} className="block text-sm font-medium text-slate-700">
              From
            </label>
            <input
              id={ids.from}
              type="date"
              value={from}
              onChange={(event) => setFrom(event.target.value)}
              className={inputClass}
            />
          </div>
          <div>
            <label htmlFor={ids.to} className="block text-sm font-medium text-slate-700">
              To
            </label>
            <input
              id={ids.to}
              type="date"
              value={to}
              onChange={(event) => setTo(event.target.value)}
              className={inputClass}
            />
          </div>
        </div>
        {list.loading ? (
          <LoadingState label="Loading your attendance history…" />
        ) : list.error ? (
          <ErrorState message={list.error} onRetry={() => void list.reload()} />
        ) : list.items.length === 0 ? (
          <EmptyState title="No attendance records for these dates." />
        ) : (
          <EntryTable entries={list.items} disabledOrganizationIds={list.disabledOrganizationIds} />
        )}
        <LoadMore list={list} noun={['entry', 'entries']} />
      </Section>
      {(presence || attendanceOff) && (
        <SignInHistorySection status={status} attendanceOff={attendanceOff} />
      )}
    </div>
  );
}

function entryState(entry: TimeEntryRead): string[] {
  const states: string[] = [];
  if (entry.status === 'VOIDED') states.push('Voided');
  else if (entry.status === 'OPEN') states.push('Open');
  if (entry.corrections.some((item) => item.status === 'APPROVED')) states.push('Corrected');
  if (entry.corrections.some((item) => item.status === 'PENDING'))
    states.push('Correction pending');
  return states;
}

function EntryTable({
  entries,
  disabledOrganizationIds,
}: {
  entries: TimeEntryRead[];
  disabledOrganizationIds: ReadonlySet<string>;
}) {
  return (
    <DataTable
      bare
      label="Attendance history"
      caption="Your attendance records: time worked, breaks, automatic deduction and payable minutes"
      minWidth="min-w-[920px]"
      rows={entries}
      rowKey={(entry) => entry.id}
      // DataTable cells set their own text colour, so a voided row dims its cells directly.
      rowClassName={(entry) => (entry.status === 'VOIDED' ? '[&>td]:text-slate-500' : undefined)}
      columns={[
        {
          key: 'workDate',
          header: 'Work date',
          rowHeader: true,
          className: 'text-slate-900',
          cell: (entry) => formatDateOnly(entry.workDate),
        },
        {
          key: 'assignment',
          header: 'Assignment',
          cell: (entry) => (
            <>
              {assignmentName(entry.assignment)}
              {(entry.coverage ?? []).filter((item) => !item.isPayrollOwner).length > 0 && (
                <span className="block text-xs text-slate-500">
                  Also covers:{' '}
                  {(entry.coverage ?? [])
                    .filter((item) => !item.isPayrollOwner)
                    .map((item) => item.assignment.position.name)
                    .join(', ')}
                </span>
              )}
            </>
          ),
        },
        {
          key: 'inOut',
          header: 'In – out',
          cell: (entry) => (
            <>
              {formatInstant(entry.clockInAt, entry.timezone)} –{' '}
              {entry.clockOutAt ? formatInstant(entry.clockOutAt, entry.timezone) : 'still open'}
              <span className="block text-xs text-slate-500">{entry.timezone}</span>
            </>
          ),
        },
        { key: 'gross', header: 'Gross', cell: (entry) => formatMinutes(entry.grossMinutes) },
        {
          key: 'breaks',
          header: 'Breaks',
          cell: (entry) => (
            <>
              {formatMinutes(entry.unpaidBreakMinutes)} unpaid
              {entry.paidBreakMinutes > 0 && (
                <span className="block text-xs text-slate-500">
                  {formatMinutes(entry.paidBreakMinutes)} paid
                </span>
              )}
            </>
          ),
        },
        {
          key: 'deduction',
          header: 'Auto deduction',
          cell: (entry) => formatMinutes(entry.policyDeductionMinutes),
        },
        {
          key: 'payable',
          header: 'Payable',
          className: 'font-semibold text-slate-900',
          cell: (entry) => formatMinutes(entry.payableMinutes),
        },
        {
          key: 'status',
          header: 'Status',
          cell: (entry) => {
            const states = entryState(entry);
            // Batch 4F (C10): history of an organization with attendance turned off.
            const readOnly = isReadOnly(disabledOrganizationIds, entry.assignment.organization?.id);
            return (
              <>
                {states.length === 0 ? '—' : states.join(', ')}
                {readOnly && (
                  <span className="mt-1 block">
                    <ReadOnlyBadge />
                  </span>
                )}
                {entry.exceptions.length > 0 && (
                  <span className="block text-xs text-amber-800">
                    {entry.exceptions.map((item) => label(item.type)).join(', ')}
                  </span>
                )}
              </>
            );
          },
        },
        {
          key: 'correction',
          header: <span className="sr-only">Request a correction</span>,
          align: 'right',
          cell: (entry) => {
            const readOnly = isReadOnly(disabledOrganizationIds, entry.assignment.organization?.id);
            return (
              entry.status !== 'VOIDED' &&
              !readOnly && (
                <button
                  type="button"
                  className={buttonClass('secondary', 'sm')}
                  onClick={() => openMyTime('requests', { entry: entry.id })}
                >
                  Request a correction{' '}
                  <span className="sr-only">
                    for {formatDateOnly(entry.workDate)}, {entry.assignment.position.name}
                  </span>
                </button>
              )
            );
          },
        },
      ]}
    />
  );
}

/**
 * Presence sign-ins, a month at a time, with the occurrence each confirmed. Batch 4F (C10): a
 * sign-in of an organization in the response's attendanceDisabledOrganizationIds is marked read
 * only (a sign-in names no organization: it is read from the assignment or the occurrence).
 */
function SignInHistorySection({
  status,
  attendanceOff,
}: {
  status: TimeStatus | null;
  attendanceOff: boolean;
}) {
  const [to, setTo] = useState(() => todayIn(null));
  const from = shiftDate(to, -30);
  const [signIns, setSignIns] = useState<SignInDetail[] | null>(null);
  const [disabledIds, setDisabledIds] = useState<ReadonlySet<string>>(new Set());
  const [occurrences, setOccurrences] = useState<Map<string, ExpectedAttendanceItem>>(new Map());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      setSignIns(null);
      Promise.all([
        attendanceApi.mySignIns({ from, to }),
        // Occurrences are listed by their own work date: a day either side.
        timeApi
          .expectedAttendance({ from: shiftDate(from, -1), to })
          .catch(() => ({ items: [] as ExpectedAttendanceItem[] })),
      ])
        .then(([result, expected]) => {
          if (!active) return;
          setSignIns(result.items);
          setDisabledIds(new Set(result.attendanceDisabledOrganizationIds ?? []));
          setOccurrences(new Map(expected.items.map((item) => [item.scheduledShiftId, item])));
          setError(null);
        })
        .catch((cause) => {
          if (!active) return;
          setSignIns([]);
          setError(timeErrorMessage(cause, 'Unable to load your sign-ins.'));
        });
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [from, to]);

  const sorted = useMemo(
    () => [...(signIns ?? [])].sort((a, b) => b.signedInAt.localeCompare(a.signedInAt)),
    [signIns],
  );

  return (
    <Section
      title="Presence sign-ins"
      description="Your presence confirmations, with any later manager correction. Presence is never payable time."
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={buttonClass('secondary', 'sm')}
          onClick={() => setTo(shiftDate(to, -31))}
        >
          Earlier
        </button>
        <p className="text-sm font-medium text-slate-700" aria-live="polite">
          {formatDateOnly(from)} – {formatDateOnly(to)}
        </p>
        <button
          type="button"
          className={buttonClass('secondary', 'sm')}
          disabled={to >= todayIn(null)}
          onClick={() => setTo(shiftDate(to, 31))}
        >
          Later
        </button>
      </div>
      {signIns === null ? (
        <LoadingState label="Loading your sign-ins…" />
      ) : error ? (
        <ErrorState message={error} />
      ) : sorted.length === 0 ? (
        <EmptyState title="No sign-ins in these dates." />
      ) : (
        <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
          {sorted.map((signIn) => {
            const occurrence = signIn.scheduledShiftId
              ? occurrences.get(signIn.scheduledShiftId)
              : undefined;
            const capability = (status?.assignmentCapabilities ?? []).find(
              (item) => item.employmentAssignmentId === signIn.employmentAssignmentId,
            );
            const organizationId = capability?.organization.id ?? occurrence?.organization.id;
            // The response's attendanceDisabledOrganizationIds decides; a sign-in names no
            // organization, so it is read from the assignment (or the occurrence it confirmed).
            const readOnly = attendanceOff || isReadOnly(disabledIds, organizationId);
            return (
              <li key={signIn.id} className="p-3 text-sm">
                <p className="font-medium text-slate-900">
                  {signIn.positionName} · {formatDateOnly(signIn.workDate)}
                  {signIn.status === 'VOIDED' && (
                    <span className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-700">
                      Voided
                    </span>
                  )}
                  {signIn.replacesSignInId && (
                    <span className="ml-2 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-900">
                      Corrected by a manager
                    </span>
                  )}
                  {readOnly && (
                    <span className="ml-2">
                      <ReadOnlyBadge />
                    </span>
                  )}
                </p>
                <p className="text-slate-700">
                  Signed in {formatInstant(signIn.signedInAt, signIn.timezone)} ·{' '}
                  {label(signIn.source)}
                  {signIn.device ? ` · ${signIn.device.name}` : ''}
                  {signIn.signOut && signIn.signOut.status === 'ACTIVE'
                    ? ` · signed out ${formatInstant(signIn.signOut.signedOutAt, signIn.timezone)}`
                    : ''}
                </p>
                <p className="text-slate-600">
                  {occurrence
                    ? `For the session ${timeIn(occurrence.startsAt, occurrence.timezone)}–${timeIn(
                        occurrence.endsAt,
                        occurrence.timezone,
                      )} on ${formatDateOnly(occurrence.workDate)}`
                    : signIn.scheduledShiftId
                      ? 'For a scheduled session'
                      : 'Unscheduled'}
                </p>
                {signIn.voidReason && <p className="text-slate-600">Reason: {signIn.voidReason}</p>}
                {signIn.exceptions.length > 0 && (
                  <p className="mt-1 text-amber-800">
                    {signIn.exceptions.map((exception) => label(exception.type)).join(', ')}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}
