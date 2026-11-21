'use client';

import type { ReactNode } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AuthApiError } from '../../../lib/auth/types';
import { performanceErrorMessage } from '../../../lib/performance/errors';
import { secondaryButton } from '../performance-shared';

/**
 * Runs a change, reports its message and reloads the sections. An error goes to the page
 * banner, or to `onError` (a dialog shows it next to its fields instead).
 */
export type Mutate = (
  action: () => Promise<unknown>,
  message: string,
  options?: { onError?(message: string): void },
) => Promise<boolean>;

/** The admin page's context for every section. */
export interface SectionProps {
  organizationId: string;
  busy: boolean;
  mutate: Mutate;
  /** Bumped after every successful change (sections reload). */
  version: number;
}

// Batch 10E-2: the shared label/hint wiring (was a local copy here and in two other modules).
export { ControlField as Field } from '../../ui/form/form-field';

/**
 * Batch 7B: an error message for an admin action. A scale or competency used by active
 * templates (409 PERFORMANCE_CONFIG_IN_USE) names those templates.
 */
export function adminErrorMessage(cause: unknown, fallback?: string) {
  const message = performanceErrorMessage(
    cause,
    fallback ?? 'Unable to complete the performance action.',
  );
  if (cause instanceof AuthApiError) {
    const templates = cause.details?.templates;
    if (cause.details?.code === 'PERFORMANCE_CONFIG_IN_USE' && Array.isArray(templates)) {
      const names = templates
        .map((t) => (t && typeof t === 'object' ? (t as { name?: string; code?: string }) : null))
        .filter(Boolean)
        .map((t) => `${t!.name ?? ''} (${t!.code ?? ''})`.trim());
      return `In use by active templates: ${names.join(', ')}. Archive or replace those templates first.`;
    }
  }
  return message;
}

/**
 * Batch 7B: one section's data, loaded on its own (a failing section never blanks the
 * others nor shows a false empty state). Reloads when `deps` change; `reload` retries.
 */
export function useSectionData<T>(load: () => Promise<T>, deps: readonly unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const generation = useRef(0);
  // The latest loader (it closes over the current filters); `deps` decide when to reload.
  const loader = useRef(load);
  useEffect(() => {
    loader.current = load;
  });
  const key = JSON.stringify(deps);
  const reload = useCallback(() => {
    const current = ++generation.current;
    setLoading(true);
    setError(null);
    loader
      .current()
      .then((value) => {
        if (current === generation.current) setData(value);
      })
      .catch((cause) => {
        if (current === generation.current) setError(performanceErrorMessage(cause));
      })
      .finally(() => {
        if (current === generation.current) setLoading(false);
      });
    // `key` stands for `deps` (reload when they change).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useEffect(() => {
    const timer = window.setTimeout(reload, 0);
    return () => window.clearTimeout(timer);
  }, [reload]);
  return { data, error, loading, reload, setData };
}

/** Loading, error (with retry) or the content of a section. */
export function SectionState({
  loading,
  error,
  onRetry,
  what,
  children,
}: {
  loading: boolean;
  error: string | null;
  onRetry(): void;
  what: string;
  children: ReactNode;
}) {
  if (error) {
    return (
      <div role="alert" className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm">
        <p className="text-rose-900">
          Unable to load {what}: {error}
        </p>
        <button type="button" className={`${secondaryButton} mt-2`} onClick={onRetry}>
          Retry
        </button>
      </div>
    );
  }
  if (loading) {
    return (
      <p role="status" className="text-sm text-slate-600">
        Loading {what}…
      </p>
    );
  }
  return <>{children}</>;
}

/** "Load more" for a paged list. */
export function LoadMore({
  label,
  busy,
  onClick,
}: {
  label: string;
  busy: boolean;
  onClick(): void;
}) {
  return (
    <button type="button" className={secondaryButton} disabled={busy} onClick={onClick}>
      {busy ? 'Loading…' : label}
    </button>
  );
}

/** Codes: 2–64 letters, digits, "_" or "-" (as the API accepts; stored upper case). */
export const CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{1,63}$/;
