'use client';

import { checkboxClass } from '../ui/tokens';

import Link from 'next/link';
import { useEffect, useId, useState } from 'react';
import { PageHeader } from '../organization/shared';
import { buttonClass } from '../ui/button';
import { ErrorState, LoadingState } from '../ui/states';
import { ExpectedBadge } from '../time/me/shared';
import { isReadOnly, ReadOnlyBadge, TruncatedRecordsNotice } from '../time/time-notices';
import { schedulingApi } from '../../lib/scheduling/api';
import { todayIn } from '../../lib/scheduling/time';
import { timeApi } from '../../lib/time/api';
import type { ExpectedAttendanceItem } from '../../lib/time/types';
import { isNotEmployee, schedulingErrorMessage } from '../../lib/scheduling/errors';
import type { MyScheduledShift, ScheduleHolidayMarker } from '../../lib/scheduling/types';
import { HolidayMarker, holidaysByDate } from './scheduling-shared';
import { formatDateOnly } from '../../lib/employee/date';
import { formatMinutes } from '../../lib/time/format';
import { PageContainer } from '../ui/page-container';

const RANGE_DAYS = 14;

/** YYYY-MM-DD of a local calendar date. */
function isoDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function scheduleRange(start: Date): { from: string; to: string } {
  const end = new Date(start);
  end.setDate(end.getDate() + RANGE_DAYS - 1);
  return { from: isoDate(start), to: isoDate(end) };
}

function startOfWeek(date: Date): Date {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7)); // Monday
  return start;
}

function timeOf(value: string, timezone: string) {
  return new Intl.DateTimeFormat('en-US', { timeStyle: 'short', timeZone: timezone }).format(
    new Date(value),
  );
}

/**
 * Employee self-service: one's own published shifts (GET /scheduling/me), two weeks at a time,
 * with cancelled ones optionally shown. Batch 4E-3: each shift shows what attendance recorded
 * (GET /time/me/expected-attendance, when Time & attendance is available) and links to it in My
 * Time. Read-only; recording attendance stays on My Time and the attendance kiosk.
 */
export function MySchedulePage({ today = new Date() }: { today?: Date }) {
  const [start, setStart] = useState(() => startOfWeek(today));
  const [items, setItems] = useState<MyScheduledShift[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notEmployee, setNotEmployee] = useState(false);
  const [showCancelled, setShowCancelled] = useState(false);
  // R4-A.6: holidays of the employee's own assignments (read-only markers).
  const [holidays, setHolidays] = useState<ScheduleHolidayMarker[]>([]);
  const [attempt, setAttempt] = useState(0);
  const [attendance, setAttendance] = useState<Map<string, ExpectedAttendanceItem>>(new Map());
  const [attendanceCap, setAttendanceCap] = useState<{ truncated?: boolean; limit?: number }>({});
  // Batch 4F (C10): organizations with attendance turned off: history only, nothing to record.
  const [disabledIds, setDisabledIds] = useState<string[]>([]);
  const cancelledId = useId();
  const range = scheduleRange(start);

  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      setLoading(true);
      setError(null);
      schedulingApi
        .mySchedule(range.from, range.to, showCancelled)
        .then((value) => {
          if (active) {
            setItems(value.items);
            setHolidays(value.holidays ?? []);
          }
        })
        .catch((cause) => {
          if (!active) return;
          setNotEmployee(isNotEmployee(cause));
          setError(schedulingErrorMessage(cause));
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [range.from, range.to, showCancelled, attempt]);

  // What attendance recorded for each shift (none when Time & attendance is not available).
  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      timeApi
        .expectedAttendance({ from: range.from, to: range.to })
        .then((value) => {
          if (active) {
            setAttendance(new Map(value.items.map((item) => [item.scheduledShiftId, item])));
            setAttendanceCap({ truncated: value.truncated, limit: value.limit });
            setDisabledIds(value.attendanceDisabledOrganizationIds ?? []);
          }
        })
        .catch(() => {
          if (active) {
            setAttendance(new Map());
            setAttendanceCap({});
            setDisabledIds([]);
          }
        });
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [range.from, range.to]);

  function shift(days: number) {
    setStart((current) => {
      const next = new Date(current);
      next.setDate(next.getDate() + days);
      return next;
    });
  }

  const byDate = new Map<string, MyScheduledShift[]>();
  for (const item of items) byDate.set(item.workDate, [...(byDate.get(item.workDate) ?? []), item]);
  const holidaysOn = holidaysByDate(holidays);
  // The organization's name only matters when the employee works in more than one.
  const organizationNames = new Map(
    items.map((item) => [item.assignment.organization.id, item.assignment.organization.name]),
  );
  const severalOrganizations = new Set(holidays.map((h) => h.organizationId)).size > 1;
  const holidayOrganization = (organizationId: string) =>
    severalOrganizations ? (organizationNames.get(organizationId) ?? null) : null;

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Self-service"
        title="My schedule"
        description="Your published shifts. Ask your manager about changes."
      />
      <div className="mt-8 flex flex-wrap items-center gap-3">
        <button type="button" className={buttonClass('secondary', 'sm')} onClick={() => shift(-7)}>
          Previous week
        </button>
        <p className="text-sm font-medium text-slate-700" aria-live="polite">
          {formatDateOnly(range.from)} – {formatDateOnly(range.to)}
        </p>
        <button type="button" className={buttonClass('secondary', 'sm')} onClick={() => shift(7)}>
          Next week
        </button>
        <button
          type="button"
          className={buttonClass('ghost', 'sm')}
          onClick={() => setStart(startOfWeek(today))}
        >
          This week
        </button>
        <span className="flex items-center gap-2 text-sm text-slate-700">
          <input
            id={cancelledId}
            type="checkbox"
            className={checkboxClass}
            checked={showCancelled}
            onChange={(event) => setShowCancelled(event.target.checked)}
          />
          <label htmlFor={cancelledId}>Show cancelled shifts</label>
        </span>
        <Link href="/time" className={buttonClass('ghost', 'sm')}>
          My Time
        </Link>
      </div>
      <div className="mt-6 space-y-4">
        {!loading && !error && (
          // Batch 4F (Q3): attendance shown for only part of the shifts is never presented as
          // complete.
          <TruncatedRecordsNotice truncated={attendanceCap.truncated} limit={attendanceCap.limit} />
        )}
        {loading ? (
          <LoadingState label="Loading your schedule…" />
        ) : notEmployee ? (
          <p className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-600">
            Your account is not linked to an employee record, so there is no schedule to show.
          </p>
        ) : error ? (
          <ErrorState
            title="Your schedule could not be loaded"
            message={error}
            onRetry={() => setAttempt((value) => value + 1)}
          />
        ) : items.length === 0 ? (
          <>
            {holidays.length > 0 && (
              <HolidayList holidays={holidays} organizationOf={holidayOrganization} />
            )}
            <p className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-600">
              No published shifts in these two weeks.
            </p>
          </>
        ) : (
          <>
            {holidays.length > 0 && (
              <HolidayList holidays={holidays} organizationOf={holidayOrganization} />
            )}
            {[...byDate.entries()].map(([date, shifts]) => (
              <section
                key={date}
                aria-label={formatDateOnly(date)}
                className="rounded-xl border border-slate-200 bg-white p-5"
              >
                <h2 className="text-base font-semibold text-slate-950">{formatDateOnly(date)}</h2>
                {(holidaysOn.get(date) ?? []).length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {holidaysOn.get(date)!.map((holiday, index) => (
                      <HolidayMarker
                        key={`${holiday.organizationId}-${holiday.name}-${index}`}
                        holiday={holiday}
                        organizationName={holidayOrganization(holiday.organizationId)}
                      />
                    ))}
                  </div>
                )}
                <ul className="mt-3 divide-y divide-slate-100">
                  {shifts.map((item) => {
                    const recorded = attendance.get(item.id);
                    const cancelled = item.status === 'CANCELLED';
                    const readOnly = isReadOnly(disabledIds, item.assignment.organization.id);
                    const time = `${timeOf(item.startsAt, item.timezone)} – ${timeOf(item.endsAt, item.timezone)}`;
                    return (
                      <li
                        key={item.id}
                        className="flex flex-wrap items-baseline justify-between gap-2 py-2 text-sm"
                      >
                        <span
                          className={`font-medium ${cancelled ? 'text-slate-500 line-through' : 'text-slate-900'}`}
                        >
                          {time}
                          <span className="ml-2 font-normal text-slate-500 no-underline">
                            ({formatMinutes(item.durationMinutes)})
                          </span>
                        </span>
                        <span className="text-slate-700">
                          {item.assignment.position.name}
                          {item.workLocation ? ` · ${item.workLocation.name}` : ''}
                          {` · ${item.assignment.organization.name}`}
                        </span>
                        <span className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
                          {cancelled && !recorded && (
                            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-700">
                              Cancelled
                            </span>
                          )}
                          {readOnly && <ReadOnlyBadge />}
                          {recorded && <ExpectedBadge status={recorded.status} />}
                          {recorded &&
                            !cancelled &&
                            (() => {
                              const open =
                                (recorded.status === 'DUE' || recorded.status === 'UPCOMING') &&
                                item.workDate === todayIn(item.timezone);
                              if (recorded.status === 'UPCOMING' && !open) return null;
                              // Nothing can be recorded where attendance is turned off.
                              if (open && readOnly) return null;
                              return (
                                <Link
                                  href={open ? '/time' : `/time?tab=history&date=${item.workDate}`}
                                  className="text-xs font-semibold text-indigo-800 underline"
                                >
                                  {open ? 'Record attendance' : 'View attendance'}{' '}
                                  <span className="sr-only">
                                    for {formatDateOnly(item.workDate)}, {time}
                                  </span>
                                </Link>
                              );
                            })()}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </>
        )}
      </div>
    </PageContainer>
  );
}

/** R4-A.6: every holiday in the shown weeks (including days with no shift). */
function HolidayList({
  holidays,
  organizationOf,
}: {
  holidays: ScheduleHolidayMarker[];
  organizationOf(organizationId: string): string | null;
}) {
  return (
    <section
      aria-label="Holidays in these two weeks"
      className="rounded-xl border border-amber-200 bg-amber-50/60 p-4"
    >
      <h2 className="text-sm font-semibold text-slate-950">Holidays in these two weeks</h2>
      <ul className="mt-2 space-y-1 text-sm text-slate-800">
        {holidays.map((holiday) => (
          <li key={`${holiday.organizationId}-${holiday.date}-${holiday.name}`}>
            {formatDateOnly(holiday.date)} ·{' '}
            <HolidayMarker
              holiday={holiday}
              organizationName={organizationOf(holiday.organizationId)}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}
