'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';

/** Fired after in-app navigation that may change only the URL hash (no `hashchange`). */
export const LOCATION_HASH_EVENT = 'hrms:location-hash';

function subscribe(callback: () => void) {
  window.addEventListener('hashchange', callback);
  window.addEventListener('popstate', callback);
  window.addEventListener(LOCATION_HASH_EVENT, callback);
  return () => {
    window.removeEventListener('hashchange', callback);
    window.removeEventListener('popstate', callback);
    window.removeEventListener(LOCATION_HASH_EVENT, callback);
  };
}

function readHash(): string {
  try {
    return decodeURIComponent(window.location.hash.replace(/^#/, ''));
  } catch {
    return '';
  }
}

function readSearch(): string {
  try {
    return window.location.search;
  } catch {
    return '';
  }
}

/** The current URL hash without `#` ('' on the server). */
export function useLocationHash(): string {
  return useSyncExternalStore(subscribe, readHash, () => '');
}

/** The current URL query string, including `?` when present ('' on the server). */
export function useLocationSearch(): string {
  return useSyncExternalStore(subscribe, readSearch, () => '');
}

/**
 * Tell hash subscribers to re-read the location (after the router has committed the URL).
 *
 * Batch 10C: a same-page link that also changes the query (e.g. the sidebar's
 * `/admin/time?attendanceTab=kiosks#attendance` from `/admin/time#records`) is committed by the
 * router only after it has fetched the page for the new query, later than the next tick. So
 * subscribers are notified on the next tick (as before) and again once the URL has changed
 * (checked every 50 ms, for at most 2 s).
 *
 * R4-A (Checkpoint D): the watcher belongs to whoever started it. This returns a function that
 * cancels it (both timers); components use `useLocationChangeNotifier()`, whose watcher belongs
 * to the application shell (or, outside one, to the component) and is cancelled when that owner
 * unmounts, so no timer outlives its owner (in tests, the environment it ran in).
 */
let cancelPendingWatch: (() => void) | undefined;

export function notifyLocationHashChange(): () => void {
  // One watcher at a time: a new navigation replaces the previous one's.
  cancelPendingWatch?.();
  const before = window.location.href;
  const notify = () => window.dispatchEvent(new Event(LOCATION_HASH_EVENT));
  let waited = 0;
  const nextTick = window.setTimeout(notify, 0);
  const interval = window.setInterval(() => {
    waited += 50;
    if (window.location.href !== before || waited >= 2_000) {
      cancel();
      notify();
    }
  }, 50);
  function cancel() {
    window.clearTimeout(nextTick);
    window.clearInterval(interval);
    if (cancelPendingWatch === cancel) cancelPendingWatch = undefined;
  }
  cancelPendingWatch = cancel;
  return cancel;
}

/**
 * `notifyLocationHashChange` owned by the calling component: a stable function whose watcher is
 * cancelled when the component unmounts. The application shell uses it (it stays mounted across
 * every navigation) and provides it to the page below through `LocationChangeNotifierContext`.
 */
export function useOwnedLocationChangeNotifier(): () => void {
  const cancel = useRef<(() => void) | undefined>(undefined);
  useEffect(
    () => () => {
      cancel.current?.();
      cancel.current = undefined;
    },
    [],
  );
  return useCallback(() => {
    cancel.current = notifyLocationHashChange();
  }, []);
}

/** The shell's notifier, for links inside a page that may unmount with their own navigation. */
export const LocationChangeNotifierContext = createContext<(() => void) | null>(null);

/**
 * The notifier for a link that starts a navigation: the shell's (so the watcher survives this
 * component unmounting when the link leaves the page) or, outside a shell, one owned by the
 * calling component.
 */
export function useLocationChangeNotifier(): () => void {
  const shell = useContext(LocationChangeNotifierContext);
  const own = useOwnedLocationChangeNotifier();
  return shell ?? own;
}

/** Writes `#hash` into the URL (no navigation, no history entry) and notifies subscribers. */
export function setLocationHash(hash: string): void {
  try {
    const { pathname, search } = window.location;
    window.history.replaceState(
      window.history.state,
      '',
      `${pathname}${search}${hash ? `#${encodeURIComponent(hash)}` : ''}`,
    );
  } catch {
    // The visible tab still changes; only the shareable URL is affected.
  }
  window.dispatchEvent(new Event(LOCATION_HASH_EVENT));
}

/** Replaces one query parameter in the URL and notifies location subscribers. */
export function setLocationSearchParam(key: string, value: string | null): void {
  try {
    const { pathname, search, hash } = window.location;
    const params = new URLSearchParams(search);
    if (value === null || value === '') {
      params.delete(key);
    } else {
      params.set(key, value);
    }
    const next = params.toString();
    window.history.replaceState(
      window.history.state,
      '',
      `${pathname}${next ? `?${next}` : ''}${hash}`,
    );
  } catch {
    // The visible state still changes; only the shareable URL is affected.
  }
  window.dispatchEvent(new Event(LOCATION_HASH_EVENT));
}

function clearLocationHash(): void {
  try {
    const { pathname, search } = window.location;
    window.history.replaceState(window.history.state, '', `${pathname}${search}`);
  } catch {
    // Leaving the hash in place only affects which tab a reload opens.
  }
  window.dispatchEvent(new Event(LOCATION_HASH_EVENT));
}

/**
 * Batch 10A — the shared, type-safe tab selection with a deep link in the URL. Two modes keep
 * every existing link working:
 *
 * - `hash` (default; e.g. /admin/leave#holidays, /admin/performance#cycles): a hash naming an
 *   available tab wins; picking another tab clears that hash so the URL never contradicts the
 *   visible tab (the URL is otherwise left as it is).
 * - `query` (e.g. /time?tab=history, /admin/payroll?tab=calendars): the `param` query parameter
 *   names the tab; picking a tab writes it (and removes it for the `initial` tab), keeping every
 *   other parameter and the hash.
 *
 * URLs are replaced, not pushed (no extra history entries); Back and Forward re-read the URL, so
 * the visible tab always follows it. A value naming no available tab (or a tab the user may not
 * see) falls back to the chosen or initial tab.
 *
 * The URL is re-read on Back/Forward, hash changes and this module's location event (sent by the
 * setters here and by the sidebar). A Next.js `<Link>`/`router.push` to the same page with only
 * a different query does not send it: call `notifyLocationHashChange()` after such a navigation
 * (as the sidebar does) when adopting query mode.
 *
 * `writeHash` (hash mode, Batch 10B): picking a tab writes `#tab` (the employee profile's
 * behaviour, so the address bar can always be copied as a deep link) instead of clearing it.
 */
export function useTabParam<T extends string>(
  tabs: readonly T[],
  initial: T,
  options: { mode?: 'hash' | 'query'; param?: string; writeHash?: boolean } = {},
) {
  const mode = options.mode ?? 'hash';
  const param = options.param ?? 'tab';
  const writeHash = mode === 'hash' && Boolean(options.writeHash);
  const hash = useLocationHash();
  const search = useLocationSearch();
  const [chosen, setChosen] = useState<T>(initial);
  const requested = mode === 'hash' ? hash : new URLSearchParams(search).get(param);
  const fromUrl =
    requested !== null && (tabs as readonly string[]).includes(requested) ? (requested as T) : null;
  const select = useCallback(
    (next: T) => {
      setChosen(next);
      if (mode === 'query') setLocationSearchParam(param, next === initial ? null : next);
      else if (writeHash) setLocationHash(next);
      else if (fromUrl !== null && fromUrl !== next) clearLocationHash();
    },
    [fromUrl, initial, mode, param, writeHash],
  );
  // Hash mode: a hash naming a tab wins, else the choice (as the earlier useHashTab). Query mode:
  // the URL is the source of truth once written; without the parameter it is `initial`.
  // Batch 10B, all modes: a choice that is no longer available (e.g. a tab hidden after
  // permissions changed) falls back to `initial` instead of showing an empty panel.
  const available = (tabs as readonly string[]).includes(chosen) ? chosen : initial;
  const current = fromUrl ?? (mode === 'query' && requested === null ? initial : available);
  return [current, select] as const;
}

/**
 * A tab selection that a navigation link can deep-link with `#tab` (e.g. the sidebar's
 * "Timesheets" → /admin/time#timesheets). Same as `useTabParam(tabs, initial)` (hash mode).
 */
export function useHashTab<T extends string>(tabs: readonly T[], initial: T) {
  return useTabParam(tabs, initial, { mode: 'hash' });
}
