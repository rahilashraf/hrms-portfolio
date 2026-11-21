'use client';

import { checkboxClass } from '../../ui/tokens';

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { attendanceApi } from '../../../lib/attendance/api';
import type { AttendanceOrganization } from '../../../lib/attendance/types';
import { timeErrorMessage } from '../../../lib/time/errors';
import type { ActorNames, TimePage } from '../../../lib/time/types';
import { buttonClass } from '../../ui/button';
import { inputClass } from '../../ui/tokens';

/**
 * Batch 4E-1 — building blocks of the manager attendance review screens. Everything here is
 * presentation: which records a manager sees, and whether an action succeeds, is decided by the
 * API (G1 filters run inside the reader's authorization; every action is authorized per record).
 */

export type ReviewOrganization = AttendanceOrganization;

const ORGANIZATION_KEY = 'hrms.timeReview.organizationId';

function hasReviewAccess({ actions }: ReviewOrganization) {
  return Boolean(
    actions.canViewAttendance ||
    actions.canCorrectTime ||
    actions.canReviewExceptions ||
    actions.canReviewCorrections ||
    actions.canApproveTimesheets ||
    actions.canManageTimesheets,
  );
}

function storedOrganizationId(): string | null {
  try {
    return window.localStorage.getItem(ORGANIZATION_KEY);
  } catch {
    return null;
  }
}

function storeOrganizationId(id: string) {
  try {
    window.localStorage.setItem(ORGANIZATION_KEY, id);
  } catch {
    // Remembering the choice is a convenience only.
  }
}

/** Batch 4F (C10): an organization listed only for its history (attendance turned off). */
export function isHistoricalOrganization(organization: { attendanceEnabled?: boolean }): boolean {
  return organization.attendanceEnabled === false;
}

/**
 * Batch 4F (C10): the opt-in every manager list call of a historical organization sends. Such an
 * organization is only listed when the manager asked for history, so the flag follows it.
 */
export function historyQuery(organization: { attendanceEnabled?: boolean }): {
  includeDisabledOrganizations?: true;
} {
  return isHistoricalOrganization(organization) ? { includeDisabledOrganizations: true } : {};
}

/** The organization's name, marked when it is history only. */
export function organizationLabel(organization: { name: string; attendanceEnabled?: boolean }) {
  return isHistoricalOrganization(organization)
    ? `${organization.name} (turned off — read only)`
    : organization.name;
}

/**
 * The organizations the user reviews attendance in, and the one chosen (remembered per viewer).
 * Batch 4F (C10): `includeDisabled` also lists organizations with attendance turned off.
 */
export function useReviewOrganizations(enabled: boolean, includeDisabled = false) {
  const [organizations, setOrganizations] = useState<ReviewOrganization[] | null>(
    enabled ? null : [],
  );
  const [organizationId, setOrganizationIdState] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    attendanceApi
      .organizations(includeDisabled ? { includeDisabledOrganizations: true } : {})
      .then((result) => {
        if (!active) return;
        setError(null);
        const reviewable = result.items.filter(hasReviewAccess);
        setOrganizations(reviewable);
        const remembered = storedOrganizationId();
        setOrganizationIdState(
          reviewable.find((item) => item.id === remembered)?.id ?? reviewable[0]?.id ?? '',
        );
      })
      .catch((cause) => {
        if (!active) return;
        setOrganizations([]);
        setError(timeErrorMessage(cause, 'Unable to load your organizations.'));
      });
    return () => {
      active = false;
    };
  }, [enabled, attempt, includeDisabled]);

  const reload = useCallback(() => {
    setError(null);
    setOrganizations(null);
    setAttempt((value) => value + 1);
  }, []);

  const setOrganizationId = useCallback((id: string) => {
    setOrganizationIdState(id);
    storeOrganizationId(id);
  }, []);

  const organization = organizations?.find((item) => item.id === organizationId) ?? null;
  return { organizations, organization, setOrganizationId, error, reload };
}

export function OrganizationPicker({
  organizations,
  value,
  onChange,
}: {
  organizations: ReviewOrganization[];
  value: string;
  onChange(id: string): void;
}) {
  const id = useId();
  if (organizations.length <= 1) {
    const only = organizations[0];
    return only ? (
      <p className="text-sm text-slate-600">
        Organization:{' '}
        <span className="font-semibold text-slate-900">{organizationLabel(only)}</span>
      </p>
    ) : null;
  }
  return (
    <div className="max-w-sm">
      <label htmlFor={id} className="block text-sm font-medium text-slate-700">
        Organization
      </label>
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={inputClass}
      >
        {organizations.map((item) => (
          <option key={item.id} value={item.id}>
            {organizationLabel(item)}
          </option>
        ))}
      </select>
    </div>
  );
}

export interface PagedList<T> {
  items: T[];
  /** Batch 4F (C10): organizations of the loaded rows with attendance turned off (read only). */
  disabledOrganizationIds: ReadonlySet<string>;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  hasMore: boolean;
  loadMore(): void;
  reload(): Promise<void>;
}

const EMPTY_SET: ReadonlySet<string> = new Set();

/**
 * A server-paged list: the first page loads whenever `fetchPage` changes (memoize it), "Load
 * more" follows the API's cursor. Answers that arrive after a newer request are dropped, so a
 * quick filter change never shows another filter's rows.
 */
export function usePagedList<T extends { id: string }>(
  fetchPage: ((afterId?: string) => Promise<TimePage<T>>) | null,
  fallbackError = 'Unable to load these records.',
): PagedList<T> {
  const [items, setItems] = useState<T[]>([]);
  const [disabled, setDisabled] = useState<ReadonlySet<string>>(EMPTY_SET);
  const [nextAfterId, setNextAfterId] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(fetchPage));
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);

  const reload = useCallback(async () => {
    const current = ++generation.current;
    if (!fetchPage) {
      setItems([]);
      setNextAfterId(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const page = await fetchPage();
      if (current !== generation.current) return;
      setItems(page.items);
      setDisabled(new Set(page.attendanceDisabledOrganizationIds ?? []));
      setNextAfterId(page.nextAfterId);
    } catch (cause) {
      if (current !== generation.current) return;
      setItems([]);
      setDisabled(EMPTY_SET);
      setNextAfterId(null);
      setError(timeErrorMessage(cause, fallbackError));
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }, [fetchPage, fallbackError]);

  useEffect(() => {
    const timer = window.setTimeout(() => void reload(), 0);
    return () => window.clearTimeout(timer);
  }, [reload]);

  const loadMore = useCallback(() => {
    if (!fetchPage || !nextAfterId || loadingMore) return;
    const current = generation.current;
    setLoadingMore(true);
    fetchPage(nextAfterId)
      .then((page) => {
        if (current !== generation.current) return;
        setItems((existing) => {
          const seen = new Set(existing.map((item) => item.id));
          return [...existing, ...page.items.filter((item) => !seen.has(item.id))];
        });
        const more = page.attendanceDisabledOrganizationIds ?? [];
        if (more.length > 0) setDisabled((existing) => new Set([...existing, ...more]));
        setNextAfterId(page.nextAfterId);
      })
      .catch((cause) => {
        if (current === generation.current) setError(timeErrorMessage(cause, fallbackError));
      })
      .finally(() => {
        if (current === generation.current) setLoadingMore(false);
      });
  }, [fetchPage, nextAfterId, loadingMore, fallbackError]);

  return {
    items,
    disabledOrganizationIds: disabled,
    loading,
    loadingMore,
    error,
    hasMore: nextAfterId !== null,
    loadMore,
    reload,
  };
}

export function LoadMore({
  list,
  noun,
}: {
  list: PagedList<{ id: string }>;
  /** Plural, or [singular, plural]. */
  noun: string | readonly [string, string];
}) {
  if (list.loading || list.items.length === 0) return null;
  const [singular, plural] = typeof noun === 'string' ? [noun, noun] : noun;
  return (
    <div className="mt-4 flex flex-wrap items-center gap-3">
      <p className="text-sm text-slate-600" aria-live="polite">
        Showing {list.items.length} {list.items.length === 1 ? singular : plural}
        {list.hasMore ? '; more are available.' : '.'}
      </p>
      {list.hasMore && (
        <button
          type="button"
          onClick={list.loadMore}
          disabled={list.loadingMore}
          className={buttonClass('secondary', 'sm')}
        >
          {list.loadingMore ? 'Loading…' : 'Load more'}
        </button>
      )}
    </div>
  );
}

/** "You", the user's name, or "Unknown user" (deleted, or no name on record). */
export function actorLabel(
  actors: ActorNames | undefined,
  userId: string | null | undefined,
  currentUserId: string | null | undefined,
): string {
  if (!userId) return 'System';
  if (currentUserId && userId === currentUserId) return 'You';
  return actors?.[userId] ?? 'Unknown user';
}

const TIMESHEET_STATUS: Record<string, { text: string; className: string }> = {
  OPEN: { text: 'Draft', className: 'bg-slate-100 text-slate-800 ring-slate-300' },
  SUBMITTED: { text: 'Submitted', className: 'bg-sky-50 text-sky-900 ring-sky-300' },
  CHANGES_REQUESTED: {
    text: 'Changes requested',
    className: 'bg-amber-50 text-amber-900 ring-amber-300',
  },
  APPROVED: { text: 'Approved', className: 'bg-emerald-50 text-emerald-900 ring-emerald-300' },
  LOCKED: { text: 'Locked', className: 'bg-violet-50 text-violet-900 ring-violet-300' },
  // Segments.
  PENDING: { text: 'Awaiting approval', className: 'bg-sky-50 text-sky-900 ring-sky-300' },
};

/** A timesheet or segment state as text and colour (the text alone carries the meaning). */
export function TimesheetStatusBadge({ status }: { status: string }) {
  const style = TIMESHEET_STATUS[status] ?? {
    text: status,
    className: 'bg-slate-100 text-slate-800 ring-slate-300',
  };
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset ${style.className}`}
    >
      {style.text}
    </span>
  );
}

export const FINALIZED_STATUSES = new Set(['APPROVED', 'LOCKED']);

const RESOLUTION_METHOD: Record<string, string> = {
  SYSTEM_AUTO_RESOLUTION: 'Closed automatically by the system',
  EMPLOYEE_RESOLUTION: 'Resolved by the employee',
  MANAGER_RESOLUTION: 'Manager decision',
  ADMIN_RESOLUTION: 'Administrator decision',
};

/** How an exception was closed: automatically, by the employee, or by a manager's decision. */
export function resolutionLabel(status: string, method: string | null | undefined): string | null {
  if (status === 'OPEN') return null;
  if (status === 'SUPERSEDED') return 'Superseded automatically by the system';
  return (method && RESOLUTION_METHOD[method]) ?? null;
}

export function ReviewPanel({
  title,
  description,
  actions,
  children,
  headingLevel = 2,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  headingLevel?: 2 | 3;
}) {
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  return (
    <section className="min-w-0 rounded-xl border border-slate-200 bg-white p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Heading className="text-lg font-semibold text-slate-950">{title}</Heading>
          {description && <div className="mt-1 text-sm text-slate-600">{description}</div>}
        </div>
        {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

/** A labelled date input (YYYY-MM-DD). */
export function DateField({
  label,
  value,
  onChange,
  required,
}: {
  label: string;
  value: string;
  onChange(value: string): void;
  required?: boolean;
}) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-slate-700">
        {label}
      </label>
      <input
        id={id}
        type="date"
        value={value}
        required={required}
        onChange={(event) => onChange(event.target.value)}
        className={inputClass}
      />
    </div>
  );
}

/** A debounced value (search boxes: one request after typing stops). */
export function useDebounced<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

/** Today's date (YYYY-MM-DD) in a time zone, defaulting to the browser's. */
export function todayIn(timezone?: string | null): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone || undefined,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

/**
 * Batch 4F (C10): the opt-in to also list organizations with Time & attendance turned off, whose
 * history stays readable but offers no action.
 */
export function HistoricalToggle({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange(checked: boolean): void;
}) {
  const id = useId();
  return (
    <div className="flex items-start gap-2 text-sm text-slate-800">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        aria-describedby={`${id}-hint`}
        className={`${checkboxClass} mt-0.5`}
      />
      <div>
        <label htmlFor={id} className="font-medium">
          Include organizations with attendance turned off (read only)
        </label>
        <p id={`${id}-hint`} className="text-xs text-slate-600">
          Their records stay readable as history; nothing can be changed there.
        </p>
      </div>
    </div>
  );
}

/** Explains the read-only history of the chosen organization (attendance turned off). */
export function HistoricalNotice({ organizationName }: { organizationName: string }) {
  return (
    <p
      role="status"
      className="rounded-lg border border-slate-300 bg-slate-50 p-3 text-sm text-slate-800"
    >
      <span className="font-semibold">
        Time &amp; attendance is turned off for {organizationName}.
      </span>{' '}
      Its history is shown read only: approvals, corrections and other changes are not available
      until attendance is turned back on.
    </p>
  );
}
