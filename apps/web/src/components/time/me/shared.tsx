'use client';

import type { ReactNode } from 'react';
import { setLocationSearchParam } from '../../../lib/navigation/use-location-hash';
import type {
  AssignmentCapability,
  ExpectedAttendanceStatus,
  TimeStatus,
} from '../../../lib/time/types';

/**
 * Batch 4E-3 — small building blocks of My Time. Presentation only: what the employee may do is
 * decided by the API (status actions, capabilities), and every action is authorized again there.
 */

export type MyTimeTab = 'today' | 'history' | 'timesheets' | 'requests';

export const MY_TIME_TABS: ReadonlyArray<{ id: MyTimeTab; label: string }> = [
  { id: 'today', label: 'Today' },
  { id: 'history', label: 'History' },
  { id: 'timesheets', label: 'Timesheets' },
  { id: 'requests', label: 'Requests' },
];

/** The query parameters My Time reads (stable deep links: /time?tab=…&…). */
export const MY_TIME_PARAMS = ['tab', 'timesheet', 'date', 'entry'] as const;

/** Opens a My Time tab with its parameters (others cleared), keeping the URL shareable. */
export function openMyTime(tab: MyTimeTab, params: Partial<Record<string, string>> = {}) {
  for (const key of MY_TIME_PARAMS) {
    if (key === 'tab') continue;
    setLocationSearchParam(key, params[key] ?? null);
  }
  setLocationSearchParam('tab', tab === 'today' ? null : tab);
}

/** "Position · Organization", so the same position in two organizations is never confused. */
export function assignmentName(assignment: {
  position: { name: string };
  organization: { name: string };
}): string {
  return `${assignment.position.name} · ${assignment.organization.name}`;
}

/** The capability of an assignment (status), if the API sent it. */
export function capabilityOf(
  status: TimeStatus | null,
  employmentAssignmentId: string | null | undefined,
): AssignmentCapability | undefined {
  return status?.assignmentCapabilities?.find(
    (item) => item.employmentAssignmentId === employmentAssignmentId,
  );
}

/** The organizations of the employee's active assignments (for filters), by id. */
export function organizationsOf(status: TimeStatus | null): Array<{ id: string; name: string }> {
  const seen = new Map<string, string>();
  for (const item of status?.assignmentCapabilities ?? []) {
    seen.set(item.organization.id, item.organization.name);
  }
  return [...seen.entries()].map(([id, name]) => ({ id, name }));
}

/** HH:mm of an instant in a time zone. */
export function timeIn(value: string, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(new Date(value));
  } catch {
    return value;
  }
}

const EXPECTED: Record<ExpectedAttendanceStatus, { text: string; tone: string }> = {
  UPCOMING: { text: 'Upcoming', tone: 'bg-slate-100 text-slate-800 ring-slate-300' },
  DUE: { text: 'Due now', tone: 'bg-sky-50 text-sky-900 ring-sky-300' },
  ATTENDED: { text: 'Attended', tone: 'bg-emerald-50 text-emerald-900 ring-emerald-300' },
  LATE: { text: 'Late', tone: 'bg-amber-50 text-amber-950 ring-amber-300' },
  MISSING: { text: 'Missing', tone: 'bg-rose-50 text-rose-900 ring-rose-300' },
  NOT_RECORDED: { text: 'Not recorded', tone: 'bg-slate-100 text-slate-800 ring-slate-300' },
  EXCUSED: { text: 'Excused', tone: 'bg-violet-50 text-violet-900 ring-violet-300' },
  CANCELLED: { text: 'Cancelled', tone: 'bg-slate-100 text-slate-700 ring-slate-300' },
  CHANGED_AFTER_ATTENDANCE: {
    text: 'Changed after attendance',
    tone: 'bg-amber-50 text-amber-950 ring-amber-300',
  },
};

/** What attendance shows for a scheduled shift, in words (never colour alone). */
export function ExpectedBadge({ status }: { status: ExpectedAttendanceStatus }) {
  const entry = EXPECTED[status];
  return (
    <span
      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ring-inset ${entry.tone}`}
    >
      {entry.text}
    </span>
  );
}

export function expectedText(status: ExpectedAttendanceStatus): string {
  return EXPECTED[status].text;
}

export function Section({
  title,
  description,
  children,
  headingLevel = 2,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  headingLevel?: 2 | 3;
}) {
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 sm:p-5">
      <Heading className="text-base font-semibold text-slate-950">{title}</Heading>
      {description && <div className="mt-1 text-sm text-slate-600">{description}</div>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

/** YYYY-MM-DD shifted by whole days (calendar arithmetic, no time zone). */
export function shiftDate(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** A fresh idempotency key for one capture interaction. */
export function interactionKey(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `k-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
  }
}
