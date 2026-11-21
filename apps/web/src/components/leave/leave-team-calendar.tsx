'use client';

import { useEffect, useState } from 'react';
import { leaveApi } from '../../lib/leave/api';
import { isForbidden } from '../../lib/leave/errors';
import { addDaysIso, formatDateOnly, label, todayIso } from '../../lib/leave/format';
import type { MyHoliday, TeamCalendar } from '../../lib/leave/types';
import { EmptyState, Panel, secondaryButton } from './leave-shared';

/** The window shown at once: four weeks (the API allows up to 62 days). */
export const TEAM_WINDOW_DAYS = 28;

const weekday = (date: string) =>
  new Date(`${date}T00:00:00.000Z`).toLocaleDateString('en-CA', {
    weekday: 'short',
    timeZone: 'UTC',
  });

/**
 * Batch 6B (D4, D6) — My Leave: who in one's team is away, and the holidays that apply to one's
 * own assignments, day by day for four weeks. Colleagues appear by name with "Absent" only —
 * never a leave type, reason or status — and only on days both people are in the same team.
 */
export function TeamCalendarAndHolidays({ today = todayIso() }: { today?: string }) {
  const [from, setFrom] = useState(today);
  const to = addDaysIso(from, TEAM_WINDOW_DAYS - 1);
  const [team, setTeam] = useState<TeamCalendar | null>(null);
  const [holidays, setHolidays] = useState<MyHoliday[] | null>(null);
  const [teamError, setTeamError] = useState<string | null>(null);
  const [holidayError, setHolidayError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      setTeam(null);
      setHolidays(null);
      setTeamError(null);
      setHolidayError(null);
      leaveApi
        .myTeamCalendar(from, to)
        .then((value) => active && setTeam(value))
        .catch((cause) => {
          if (!active) return;
          setTeamError(
            isForbidden(cause)
              ? 'Your team calendar is not available: leave requests are not enabled for you.'
              : 'Unable to load your team calendar.',
          );
        });
      leaveApi
        .myHolidays(from, to)
        .then((value) => active && setHolidays(value.items))
        .catch((cause) => {
          if (!active) return;
          setHolidayError(isForbidden(cause) ? null : 'Unable to load holidays.');
          setHolidays([]);
        });
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [from, to]);

  const loading = (team === null && !teamError) || holidays === null;
  const days = new Map<string, { holidays: MyHoliday[]; absent: string[] }>();
  const day = (date: string) => {
    const entry = days.get(date) ?? { holidays: [], absent: [] };
    days.set(date, entry);
    return entry;
  };
  for (const holiday of holidays ?? []) day(holiday.date).holidays.push(holiday);
  for (const person of team?.people ?? []) {
    for (const absence of person.absences) day(absence.date).absent.push(person.displayName);
  }
  const dates = [...days.keys()].sort();

  return (
    <Panel
      title="Team calendar and holidays"
      actions={
        <div className="flex gap-2">
          <button
            type="button"
            className={secondaryButton}
            onClick={() => setFrom(addDaysIso(from, -TEAM_WINDOW_DAYS))}
          >
            Previous 4 weeks
          </button>
          <button
            type="button"
            className={secondaryButton}
            onClick={() => setFrom(addDaysIso(from, TEAM_WINDOW_DAYS))}
          >
            Next 4 weeks
          </button>
        </div>
      }
    >
      <p className="text-sm text-slate-700">
        {formatDateOnly(from)} – {formatDateOnly(to)}
        {team?.teams.length ? ` · ${team.teams.join(', ')}` : ''}
      </p>
      <p className="mt-1 text-xs text-slate-600">
        Teammates on approved leave are shown as “Absent” only; leave types and reasons are private.
      </p>
      {teamError && (
        <p role="alert" className="mt-3 text-sm text-rose-800">
          {teamError}
        </p>
      )}
      {holidayError && (
        <p role="alert" className="mt-3 text-sm text-rose-800">
          {holidayError}
        </p>
      )}
      {team && !team.hasTeam && (
        <p role="note" className="mt-3 text-sm text-slate-700">
          You are not in a team, so only your own leave and your holidays are shown.
        </p>
      )}
      {loading ? (
        <p role="status" className="mt-3 text-sm text-slate-600">
          Loading team calendar…
        </p>
      ) : dates.length === 0 ? (
        <div className="mt-3">
          <EmptyState>Nobody in your team is away and there are no holidays.</EmptyState>
        </div>
      ) : (
        <ul aria-label="Absences and holidays by day" className="mt-3 divide-y divide-slate-100">
          {dates.map((date) => {
            const entry = days.get(date)!;
            return (
              <li key={date} className="flex flex-col gap-1 py-2 sm:flex-row sm:gap-4">
                <span className="w-36 shrink-0 text-sm font-medium text-slate-900">
                  {weekday(date)} {formatDateOnly(date)}
                </span>
                <div className="flex flex-wrap gap-2 text-sm">
                  {entry.holidays.map((holiday, index) => (
                    <span
                      key={`${index}-${holiday.name}`}
                      className="rounded-full bg-amber-50 px-2.5 py-0.5 text-amber-900"
                    >
                      {label(holiday.kind)}: {holiday.name}
                    </span>
                  ))}
                  {entry.absent.map((name, index) => (
                    <span
                      key={`${index}-${name}`}
                      className="rounded-full bg-slate-100 px-2.5 py-0.5 text-slate-800"
                    >
                      {name} — Absent
                    </span>
                  ))}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}
