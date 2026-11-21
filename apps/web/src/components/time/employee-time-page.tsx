'use client';

import { useCallback, useEffect, useState } from 'react';
import { useLocationSearch } from '../../lib/navigation/use-location-hash';
import { useTabParam } from '../../lib/navigation/use-tab-param';
import { timeApi } from '../../lib/time/api';
import { isAttendanceTurnedOff, timeErrorMessage } from '../../lib/time/errors';
import { formatDateOnly, formatInstant, formatMinutes, label } from '../../lib/time/format';
import type { TimeEntryRead, TimeStatus } from '../../lib/time/types';
import { PageHeader } from '../organization/shared';
import { ErrorState } from '../ui/states';
import { DataTable } from '../ui/data-table';
import { TabList, TabPanel, useTabIdBase } from '../ui/tabs';
import { HistoryPanel } from './me/history-panel';
import { RequestsPanel } from './me/requests-panel';
import { MY_TIME_TABS, openMyTime, type MyTimeTab } from './me/shared';
import { TimesheetsPanel } from './me/timesheets-panel';
import { TodayPanel } from './me/today-panel';
import { AttendanceTurnedOffNotice } from './time-notices';
import { PageContainer } from '../ui/page-container';
import { StatusBadge } from '../ui/status-badge';

/**
 * My Time (/time) — Batch 4E-3: the employee's attendance in four tabs with stable deep links
 * (/time?tab=history&date=…, ?tab=timesheets&timesheet=…, ?tab=requests&entry=…): Today (what
 * can be recorded now, per assignment), History, Timesheets and Requests. Each tab loads its own
 * data, so one failure never blanks the page. The API authorizes every read and action.
 */
export function EmployeeTimePage() {
  // Batch 10C: the shared useTabParam in query mode (/time?tab=history&date=…): the URL is the
  // source of truth; opening a tab goes through openMyTime, which also clears the previous tab's
  // own parameters. Back/Forward and same-page links re-read the URL.
  const [tab] = useTabParam<MyTimeTab>(
    MY_TIME_TABS.map((item) => item.id),
    'today',
    { mode: 'query' },
  );
  // The tab's own parameters (date, timesheet, entry).
  const params = new URLSearchParams(useLocationSearch());
  const idBase = useTabIdBase('my-time');
  const [status, setStatus] = useState<TimeStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  // Batch 4F (C10): Time & attendance is turned off in every organization of the employee: the
  // status (what can be recorded now) is refused, the history stays readable.
  const [attendanceOff, setAttendanceOff] = useState(false);
  const [loading, setLoading] = useState(true);

  const loadStatus = useCallback(async () => {
    try {
      setStatus(await timeApi.status());
      setStatusError(null);
      setAttendanceOff(false);
    } catch (cause) {
      const off = isAttendanceTurnedOff(cause);
      setAttendanceOff(off);
      setStatusError(off ? null : timeErrorMessage(cause));
    }
  }, []);

  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      void loadStatus().finally(() => {
        if (active) setLoading(false);
      });
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [loadStatus]);

  return (
    <PageContainer width="wide">
      <PageHeader
        eyebrow="Self service"
        title="Time & Attendance"
        description="Record attendance where it applies to you, see your history and timesheets, and request corrections."
      />
      <div className="mt-6">
        <TabList
          tabs={MY_TIME_TABS}
          active={tab}
          onChange={(next) => openMyTime(next)}
          label="My Time"
          idBase={idBase}
        />
        <TabPanel idBase={idBase} id={tab}>
          {attendanceOff && tab === 'today' && <AttendanceTurnedOffNotice />}
          {statusError && tab === 'today' && (
            <ErrorState
              title="Your attendance status could not be loaded"
              message={statusError}
              onRetry={() => void loadStatus()}
            />
          )}
          {tab === 'today' &&
            (loading ? (
              <p role="status" className="text-sm text-slate-600">
                Loading time and attendance…
              </p>
            ) : status ? (
              <TodayPanel status={status} onChanged={loadStatus} />
            ) : null)}
          {tab === 'history' && (
            <HistoryPanel status={status} date={params.get('date')} attendanceOff={attendanceOff} />
          )}
          {tab === 'timesheets' && (
            <TimesheetsPanel status={status} timesheetId={params.get('timesheet')} />
          )}
          {tab === 'requests' && (
            <RequestsPanel
              key={params.get('entry') ?? ''}
              status={status}
              entryId={params.get('entry')}
              attendanceOff={attendanceOff}
            />
          )}
        </TabPanel>
      </div>
    </PageContainer>
  );
}

/** The interval's assignment; with simultaneous coverage, the paid one and the others covered. */
function AssignmentCoverage({ entry }: { entry: TimeEntryRead }) {
  const others = (entry.coverage ?? []).filter((covered) => !covered.isPayrollOwner);
  if (others.length === 0) return <>{entry.assignment.position.name}</>;
  return (
    <div>
      <p>
        {entry.assignment.position.name}{' '}
        <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-700">
          Paid
        </span>
      </p>
      <p className="text-xs text-slate-500">
        Also covers: {others.map((covered) => covered.assignment.position.name).join(', ')}
      </p>
    </div>
  );
}

export function RecordsTable({
  entries,
  self = false,
  label: regionLabel,
  showPayable = false,
}: {
  entries: TimeEntryRead[];
  self?: boolean;
  /** Batch 4E-1: names the scroll area so keyboard users can focus and scroll it. */
  label?: string;
  /** Batch 4E-1 (managers): the automatic deduction and payable minutes of each entry. */
  showPayable?: boolean;
}) {
  if (entries.length === 0) return <EmptyState>No attendance records found.</EmptyState>;
  return (
    <DataTable
      bare
      label={regionLabel ?? 'Attendance records'}
      minWidth="min-w-[720px]"
      rows={entries}
      rowKey={(entry) => entry.id}
      columns={[
        ...(!self
          ? [
              {
                key: 'employee',
                header: 'Employee',
                rowHeader: true,
                className: 'font-medium text-slate-900',
                cell: (entry: TimeEntryRead) => entry.employeeName,
              },
            ]
          : []),
        { key: 'workDate', header: 'Work date', cell: (entry) => formatDateOnly(entry.workDate) },
        {
          key: 'assignment',
          header: 'Assignment',
          cell: (entry) => <AssignmentCoverage entry={entry} />,
        },
        {
          key: 'clockIn',
          header: 'Clock in',
          cell: (entry) => formatInstant(entry.clockInAt, entry.timezone),
        },
        {
          key: 'clockOut',
          header: 'Clock out',
          cell: (entry) => formatInstant(entry.clockOutAt, entry.timezone),
        },
        { key: 'net', header: 'Net', cell: (entry) => formatMinutes(entry.netWorkedMinutes) },
        ...(showPayable
          ? [
              {
                key: 'deduction',
                header: 'Auto deduction',
                cell: (entry: TimeEntryRead) => formatMinutes(entry.policyDeductionMinutes),
              },
              {
                key: 'payable',
                header: 'Payable',
                className: 'font-medium text-slate-900',
                cell: (entry: TimeEntryRead) => formatMinutes(entry.payableMinutes),
              },
            ]
          : []),
        { key: 'exceptions', header: 'Exceptions', cell: (entry) => entry.exceptions.length },
      ]}
    />
  );
}

/** Batch 10C: the shared StatusBadge (words always shown; tone from the central status map). */
export function StatusPill({ value }: { value: string }) {
  return <StatusBadge status={value} label={label(value)} />;
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-slate-300 p-5 text-center text-sm text-slate-600">
      {children}
    </div>
  );
}
