'use client';

import type { ReactNode } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { ErrorBanner, FeedbackMessage } from '../../organization/shared';
import { timeErrorMessage } from '../../../lib/time/errors';
import { buttonClass } from '../../ui/tokens';

// Batch 10C: shared by the attendance administration panels (moved from attendance-admin.tsx).
// Row actions here are the small button size.
export const secondaryButton = buttonClass('secondary', 'sm');
export const dangerButton = buttonClass('danger', 'sm');

// ─── Shared ──────────────────────────────────────────────────────────────────

export function Section({
  title,
  children,
  actions,
}: {
  title: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-slate-950">{title}</h2>
        {actions}
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-lg border border-dashed border-slate-300 p-4 text-sm text-slate-600">
      {children}
    </p>
  );
}

/** Loads a panel's data and runs its mutations with one busy key, reloading after each. */
export function usePanel<T>(load: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setData(await load());
      setError(null);
    } catch (cause) {
      setError(timeErrorMessage(cause));
    }
  }, [load]);

  useEffect(() => {
    const timer = window.setTimeout(() => void reload(), 0);
    return () => window.clearTimeout(timer);
  }, [reload]);

  async function mutate<R>(
    key: string,
    action: () => Promise<R>,
    message: string | ((result: R) => string),
  ) {
    if (busy) return undefined;
    setBusy(key);
    setError(null);
    setSuccess(null);
    try {
      const result = await action();
      await reload();
      setSuccess(typeof message === 'string' ? message : message(result));
      return result;
    } catch (cause) {
      setError(timeErrorMessage(cause, 'Unable to complete this attendance action.'));
      return undefined;
    } finally {
      setBusy(null);
    }
  }

  return { data, error, success, busy, mutate };
}

export function Feedback({ error, success }: { error: string | null; success: string | null }) {
  return (
    <>
      {error && <ErrorBanner>{error}</ErrorBanner>}
      {success && <FeedbackMessage>{success}</FeedbackMessage>}
    </>
  );
}

/** The local wall time of an instant in a timezone, as a datetime-local value. */
export function localDateTimeIn(instant: string, timezone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(instant))
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}
