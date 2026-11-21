'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AuthApiError } from '../auth/types';

/** One page of a record search. `next` is the cursor of the following page, if any. */
export interface RecordPage<T> {
  items: T[];
  next: string | null;
}

/**
 * Batch 3B — where a record picker gets its options: a server search with a cursor. Build sources
 * with the adapters in ./sources.ts and keep them stable (useMemo) while their inputs are.
 */
export interface RecordSource<T> {
  search(query: string, cursor: string | null): Promise<RecordPage<T>>;
}

export interface RecordSearchState<T> {
  items: T[];
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  /** A readable error, or null. */
  error: string | null;
  /** The search is not permitted for this user (403): offer another way, e.g. typing the ID. */
  forbidden: boolean;
  loadMore(): void;
}

/**
 * Searches `source` for `query` (debounced) while `enabled`. Only the latest request updates the
 * state: a slower, older response never overwrites a newer one. `loadMore` appends the next page.
 */
export function useRecordSearch<T>(
  source: RecordSource<T>,
  query: string,
  {
    enabled = true,
    debounceMs = 250,
    describeError,
  }: {
    enabled?: boolean;
    debounceMs?: number;
    /** A module's own wording for a failed search (e.g. its error-message helper). */
    describeError?: (cause: unknown) => string;
  } = {},
): RecordSearchState<T> {
  const [items, setItems] = useState<T[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  // Which search the shown results answer: until the current one has, the state is "loading"
  // (no "no results" flash while the debounce waits).
  const [settled, setSettled] = useState<{ source: RecordSource<T>; term: string } | null>(null);
  const request = useRef(0);
  const term = query.trim();

  const run = useCallback(
    async (cursor: string | null) => {
      const current = ++request.current;
      if (cursor) setLoadingMore(true);
      else setLoading(true);
      setError(null);
      try {
        const page = await source.search(term, cursor);
        if (current !== request.current) return;
        setItems((previous) => (cursor ? [...previous, ...page.items] : page.items));
        setNext(page.next);
        setForbidden(false);
        setSettled({ source, term });
      } catch (cause) {
        if (current !== request.current) return;
        const denied = cause instanceof AuthApiError && cause.status === 403;
        setForbidden(denied);
        setSettled({ source, term });
        if (!cursor) setItems([]);
        setNext(null);
        setError(
          describeError?.(cause) ??
            (denied
              ? 'You cannot search these records here.'
              : 'The search failed. Try again in a moment.'),
        );
      } finally {
        if (current === request.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [source, term, describeError],
  );

  useEffect(() => {
    if (!enabled) {
      // A closed picker cancels whatever it was waiting for.
      request.current += 1;
      return;
    }
    const timer = window.setTimeout(() => void run(null), debounceMs);
    return () => window.clearTimeout(timer);
  }, [enabled, run, debounceMs]);

  const loadMore = useCallback(() => {
    if (next && !loadingMore) void run(next);
  }, [next, loadingMore, run]);

  const waiting = enabled && (settled?.source !== source || settled.term !== term);
  return {
    items,
    loading: loading || waiting,
    loadingMore,
    hasMore: next !== null,
    error: waiting ? null : error,
    forbidden,
    loadMore,
  };
}
