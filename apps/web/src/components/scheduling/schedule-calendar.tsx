'use client';

import type { GridShift, ScheduleHolidayMarker } from '../../lib/scheduling/types';
import {
  addDays,
  dateRange,
  endOfMonth,
  formatDay,
  formatDuration,
  formatTime,
  startOfMonth,
  startOfWeek,
} from '../../lib/scheduling/time';
import {
  HolidayMarker,
  holidaysByDate,
  ScheduleStatusBadge,
  ShiftStatusBadge,
} from './scheduling-shared';
import { TableScroll } from '../ui/states';

export type CalendarView = 'day' | 'week' | 'month';

/** The inclusive date range a view shows around an anchor date. */
export function viewRange(view: CalendarView, anchor: string): { from: string; to: string } {
  if (view === 'day') return { from: anchor, to: anchor };
  if (view === 'week') {
    const from = startOfWeek(anchor);
    return { from, to: addDays(from, 6) };
  }
  return { from: startOfMonth(anchor), to: endOfMonth(anchor) };
}

/** Moves the anchor by one view period. */
export function stepAnchor(view: CalendarView, anchor: string, direction: 1 | -1): string {
  if (view === 'day') return addDays(anchor, direction);
  if (view === 'week') return addDays(anchor, 7 * direction);
  const [y, m] = anchor.split('-').map(Number);
  const target = new Date(Date.UTC(y!, m! - 1 + direction, 1));
  return target.toISOString().slice(0, 10);
}

function byStart(a: GridShift, b: GridShift) {
  return a.startsAt.localeCompare(b.startsAt) || a.id.localeCompare(b.id);
}

export function groupByDate(shifts: GridShift[]): Map<string, GridShift[]> {
  const map = new Map<string, GridShift[]>();
  for (const shift of [...shifts].sort(byStart)) {
    map.set(shift.workDate, [...(map.get(shift.workDate) ?? []), shift]);
  }
  return map;
}

export function ShiftCard({
  shift,
  selected,
  onSelect,
  compact = false,
}: {
  shift: GridShift;
  selected: boolean;
  onSelect(shift: GridShift): void;
  compact?: boolean;
}) {
  const draft = shift.schedule.status === 'DRAFT';
  const cancelled = shift.status === 'CANCELLED';
  const tone = cancelled
    ? 'border-rose-200 bg-rose-50/60 text-slate-500 line-through decoration-rose-400'
    : draft
      ? 'border-dashed border-amber-400 bg-amber-50/70'
      : 'border-emerald-300 bg-white';
  const time = `${formatTime(shift.startsAt, shift.timezone)}–${formatTime(shift.endsAt, shift.timezone)}`;
  const name = shift.employee.displayName ?? shift.employee.employeeNumber;
  return (
    <button
      type="button"
      onClick={() => onSelect(shift)}
      aria-pressed={selected}
      // Same order as the visible text (time, then name), so speech input matches what is shown.
      aria-label={`${time}, ${name}, ${shift.assignment.position.name}, ${shift.workDate}, ${
        cancelled ? 'cancelled' : draft ? 'draft' : 'published'
      }`}
      className={`w-full rounded-lg border px-2 py-1.5 text-left text-xs transition hover:shadow-sm focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[var(--hrms-accent-text)] ${tone} ${
        selected ? 'ring-2 ring-indigo-500' : ''
      }`}
    >
      <span className="block font-semibold text-slate-900">{time}</span>
      <span className="block truncate">{name}</span>
      {!compact && (
        <>
          <span className="block truncate text-slate-600">
            {shift.assignment.position.name}
            {shift.workLocation ? ` · ${shift.workLocation.name}` : ''}
          </span>
          <span className="mt-1 flex flex-wrap gap-1">
            <ScheduleStatusBadge status={shift.schedule.status} />
            <ShiftStatusBadge status={shift.status} />
            {shift.sourceType === 'PATTERN' && (
              <span className="rounded-full bg-sky-50 px-2 py-0.5 text-[11px] font-medium text-sky-800">
                Recurring
              </span>
            )}
          </span>
        </>
      )}
    </button>
  );
}

export function ScheduleCalendar({
  view,
  anchor,
  shifts,
  holidays = [],
  selectedId,
  onSelect,
  onOpenDay,
}: {
  view: CalendarView;
  anchor: string;
  shifts: GridShift[];
  /** R4-A.6: read-only markers; they change nothing about the shifts. */
  holidays?: readonly ScheduleHolidayMarker[];
  selectedId: string | null;
  onSelect(shift: GridShift): void;
  onOpenDay(date: string): void;
}) {
  const grouped = groupByDate(shifts);
  const range = viewRange(view, anchor);
  const holidaysOn = holidaysByDate(holidays);
  const dayLabel = (day: string) => {
    const names = (holidaysOn.get(day) ?? []).map(
      (h) => `${h.kind === 'CLOSURE' ? 'closure' : 'holiday'}: ${h.name}`,
    );
    return names.length > 0
      ? `${formatDay(day, 'long')} (${names.join('; ')})`
      : formatDay(day, 'long');
  };
  const markers = (day: string) =>
    (holidaysOn.get(day) ?? []).length > 0 ? (
      <div className="mb-1 flex flex-wrap gap-1">
        {holidaysOn.get(day)!.map((holiday, index) => (
          <HolidayMarker
            key={`${holiday.organizationId}-${holiday.name}-${index}`}
            holiday={holiday}
          />
        ))}
      </div>
    ) : null;

  if (view === 'day') {
    const items = grouped.get(anchor) ?? [];
    return (
      <div aria-label={`Shifts on ${dayLabel(anchor)}`} role="region">
        {markers(anchor)}
        {items.length === 0 ? (
          <p className="rounded-lg border border-dashed border-slate-300 p-6 text-center text-sm text-slate-600">
            No shifts on {formatDay(anchor, 'long')} for these filters.
          </p>
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {items.map((shift) => (
              <li key={shift.id}>
                <ShiftCard shift={shift} selected={selectedId === shift.id} onSelect={onSelect} />
                <p className="mt-0.5 text-[11px] text-slate-500">
                  {formatDuration(shift.durationMinutes)} · {shift.assignment.organization.name}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  if (view === 'week') {
    const days = dateRange(range.from, range.to);
    return (
      <TableScroll label="Week calendar" bare>
        {/* A list of days (each holds buttons), not an ARIA grid: Tab moves through it. */}
        <ul aria-label="Week" className="grid min-w-[840px] grid-cols-7 gap-2">
          {days.map((day) => (
            <li
              key={day}
              aria-label={dayLabel(day)}
              className="min-h-40 rounded-lg border border-slate-200 bg-slate-50/60 p-1.5"
            >
              <button
                type="button"
                onClick={() => onOpenDay(day)}
                className="mb-1 min-h-6 w-full rounded px-1 py-1 text-left text-xs font-semibold text-slate-700 hover:bg-white focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[var(--hrms-accent-text)]"
              >
                {formatDay(day)}
              </button>
              {markers(day)}
              <ul className="space-y-1">
                {(grouped.get(day) ?? []).map((shift) => (
                  <li key={shift.id}>
                    <ShiftCard
                      shift={shift}
                      selected={selectedId === shift.id}
                      onSelect={onSelect}
                    />
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </TableScroll>
    );
  }

  // Month: whole weeks, Monday first; days outside the month are muted.
  const gridStart = startOfWeek(range.from);
  const gridEnd = addDays(startOfWeek(range.to), 6);
  const days = dateRange(gridStart, gridEnd);
  return (
    <TableScroll label="Month calendar" bare>
      {/* Weekday headings are visual only: each day is named with its full date. */}
      <div aria-hidden="true" className="grid min-w-[840px] grid-cols-7 gap-1">
        {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((label) => (
          <div key={label} className="px-1 text-xs font-semibold uppercase text-slate-600">
            {label}
          </div>
        ))}
      </div>
      <ul aria-label="Month" className="grid min-w-[840px] grid-cols-7 gap-1">
        {days.map((day) => {
          const items = grouped.get(day) ?? [];
          const inMonth = day >= range.from && day <= range.to;
          return (
            <li
              key={day}
              aria-label={dayLabel(day)}
              className={`min-h-28 rounded-lg border p-1 ${inMonth ? 'border-slate-200 bg-white' : 'border-slate-100 bg-slate-50 text-slate-500'}`}
            >
              <button
                type="button"
                onClick={() => onOpenDay(day)}
                className="min-h-6 w-full rounded px-1 py-1 text-left text-xs font-semibold hover:bg-slate-100 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[var(--hrms-accent-text)]"
                aria-label={`Open ${formatDay(day, 'long')} (${items.length} shifts)`}
              >
                {Number(day.slice(8))}
              </button>
              {markers(day)}
              <ul className="mt-1 space-y-1">
                {items.slice(0, 3).map((shift) => (
                  <li key={shift.id}>
                    <ShiftCard
                      shift={shift}
                      selected={selectedId === shift.id}
                      onSelect={onSelect}
                      compact
                    />
                  </li>
                ))}
              </ul>
              {items.length > 3 && (
                <button
                  type="button"
                  className="mt-1 min-h-6 rounded px-1 text-xs font-medium text-[var(--hrms-accent-text)] hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[var(--hrms-accent-text)]"
                  onClick={() => onOpenDay(day)}
                >
                  +{items.length - 3} more
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </TableScroll>
  );
}
