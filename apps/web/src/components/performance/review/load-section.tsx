'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  performanceErrorMessage,
  performanceFailureKind,
  type PerformanceFailureKind,
} from '../../../lib/performance/errors';
import { secondaryButton } from '../performance-shared';

export type SectionState<T> =
  | { status: 'loading' }
  | { status: 'ready'; data: T }
  | { status: 'error'; kind: PerformanceFailureKind; message: string };

/**
 * Batch 7B: one independently loaded section (no all-or-nothing page): its own loading and error
 * state and a retry. A failed request is never shown as an empty list.
 */
export function useLoadedSection<T>(load: (() => Promise<T>) | null) {
  const [state, setState] = useState<SectionState<T>>({ status: 'loading' });
  const generation = useRef(0);
  const reload = useCallback(async () => {
    if (!load) return;
    const current = ++generation.current;
    setState((previous) => (previous.status === 'ready' ? previous : { status: 'loading' }));
    try {
      const data = await load();
      if (current === generation.current) setState({ status: 'ready', data });
    } catch (cause) {
      if (current === generation.current)
        setState({
          status: 'error',
          kind: performanceFailureKind(cause),
          message: performanceErrorMessage(cause),
        });
    }
  }, [load]);
  useEffect(() => {
    const timer = window.setTimeout(() => void reload(), 0);
    return () => window.clearTimeout(timer);
  }, [reload]);
  return { state, reload };
}

/** What a failed section shows: why, and a retry for failures a retry can fix. */
export function SectionFailure({
  name,
  kind,
  message,
  onRetry,
}: {
  name: string;
  kind: PerformanceFailureKind;
  message: string;
  onRetry(): void;
}) {
  const text =
    kind === 'MODULE_DISABLED'
      ? 'Performance is switched off for this organization.'
      : kind === 'NOT_EMPLOYEE'
        ? 'Your account is not linked to an employee record.'
        : kind === 'FORBIDDEN'
          ? `You do not have access to ${name.toLowerCase()}.`
          : `${name} could not be loaded. ${message}`;
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-900"
    >
      <span>{text}</span>
      {kind === 'ERROR' && (
        <button type="button" className={secondaryButton} onClick={onRetry}>
          Retry {name.toLowerCase()}
        </button>
      )}
    </div>
  );
}

/** Renders a section by its state: loading text, the failure, or the content. */
export function Section<T>({
  name,
  state,
  onRetry,
  children,
}: {
  name: string;
  state: SectionState<T>;
  onRetry(): void;
  children(data: T): ReactNode;
}) {
  if (state.status === 'loading')
    return (
      <p role="status" className="text-sm text-slate-600">
        Loading {name.toLowerCase()}…
      </p>
    );
  if (state.status === 'error')
    return (
      <SectionFailure name={name} kind={state.kind} message={state.message} onRetry={onRetry} />
    );
  return <>{children(state.data)}</>;
}
