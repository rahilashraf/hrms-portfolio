'use client';

import { checkboxClass } from '../ui/tokens';

import { useEffect, useState } from 'react';
import { ErrorBanner } from '../organization/shared';
import { leaveApi } from '../../lib/leave/api';
import { leaveErrorMessage } from '../../lib/leave/errors';
import { addDaysIso, formatDateOnly, formatLeaveAmount, todayIso } from '../../lib/leave/format';
import type { LeaveCalendar, LeaveOrganization } from '../../lib/leave/types';
import { EmptyState, inputClass, Panel } from './leave-shared';
import { TableScroll } from '../ui/states';

// ─── Absence calendar ─────────────────────────────────────────────────────────

export function CalendarPanel({ organization }: { organization: LeaveOrganization }) {
  const [from, setFrom] = useState(() => todayIso());
  const [days, setDays] = useState(14);
  const [includePending, setIncludePending] = useState(false);
  const [calendar, setCalendar] = useState<LeaveCalendar | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      leaveApi
        .calendar({
          organizationId: organization.id,
          from,
          to: addDaysIso(from, days - 1),
          includePending,
        })
        .then((result) => {
          if (!active) return;
          setCalendar(result);
          setError(null);
        })
        .catch((cause) => active && setError(leaveErrorMessage(cause)));
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [organization.id, from, days, includePending]);

  const dates = Array.from({ length: days }, (_, index) => addDaysIso(from, index));

  return (
    <div className="space-y-6">
      <form
        className="grid grid-cols-1 gap-4 rounded-xl border border-slate-200 bg-white p-5 md:grid-cols-3"
        onSubmit={(event) => event.preventDefault()}
      >
        <label className="text-sm font-medium text-slate-700">
          From
          <input
            type="date"
            required
            value={from}
            onChange={(event) => event.target.value && setFrom(event.target.value)}
            className={inputClass}
          />
        </label>
        <label className="text-sm font-medium text-slate-700">
          Days
          <select
            value={days}
            onChange={(event) => setDays(Number(event.target.value))}
            className={inputClass}
          >
            {[7, 14, 31, 62, 93].map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-end gap-2 pb-2 text-sm font-medium text-slate-700">
          <input
            type="checkbox"
            className={checkboxClass}
            checked={includePending}
            onChange={(event) => setIncludePending(event.target.checked)}
          />
          Include pending
        </label>
      </form>
      {error && <ErrorBanner>{error}</ErrorBanner>}
      <Panel title="Who is away">
        {!calendar ? (
          <p role="status" className="text-sm text-slate-600">
            Loading calendar…
          </p>
        ) : (
          <TableScroll bare label="Who is away">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead className="border-b border-slate-200 text-xs uppercase text-slate-500">
                <tr>
                  <th scope="col" className="px-3 py-2">
                    Date
                  </th>
                  <th scope="col" className="px-3 py-2">
                    Holidays
                  </th>
                  <th scope="col" className="px-3 py-2">
                    On leave
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {dates.map((date) => {
                  const holidays = calendar.holidays.filter((h) => h.date === date);
                  const away = calendar.entries.flatMap((entry) =>
                    entry.days
                      .filter((day) => day.date === date && day.minutes > 0)
                      .map((day) => ({ entry, day })),
                  );
                  if (holidays.length === 0 && away.length === 0) return null;
                  return (
                    <tr key={date}>
                      <td className="px-3 py-2 align-top">{formatDateOnly(date)}</td>
                      <td className="px-3 py-2 align-top">
                        {holidays.map((h) => h.name).join(', ') || '—'}
                      </td>
                      <td className="px-3 py-2 align-top">
                        <ul className="space-y-1">
                          {away.map(({ entry, day }) => (
                            <li key={entry.requestId}>
                              {entry.employee.displayName ?? entry.employee.employeeNumber} ·{' '}
                              {entry.leaveType.name}
                              {day.partial && ` · ${formatLeaveAmount(day.minutes)}`}
                              {entry.status === 'PENDING' && (
                                <span className="ml-1 text-xs text-amber-700">(pending)</span>
                              )}
                            </li>
                          ))}
                        </ul>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {calendar.entries.length === 0 && calendar.holidays.length === 0 && (
              <EmptyState>Nobody is away in this range.</EmptyState>
            )}
          </TableScroll>
        )}
      </Panel>
    </div>
  );
}
