import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import {
  LOCATION_HASH_EVENT,
  LocationChangeNotifierContext,
  notifyLocationHashChange,
  useHashTab,
  useLocationChangeNotifier,
  useOwnedLocationChangeNotifier,
} from './use-location-hash';
import { useTabParam } from './use-tab-param';

/**
 * Batch 10A — the shared tab hook keeps every existing deep link working: hash tabs
 * (/admin/leave#holidays), query tabs (/time?tab=history, /admin/payroll?tab=calendars), other
 * parameters and the hash are preserved, and Back/Forward re-read the URL.
 */
type Tab = 'overview' | 'calendars' | 'runs';
const TABS: readonly Tab[] = ['overview', 'calendars', 'runs'];

function Tabs({ mode, param }: { mode?: 'hash' | 'query'; param?: string }) {
  const [tab, select] = useTabParam<Tab>(TABS, 'overview', { mode, param });
  return (
    <div>
      <p data-testid="tab">{tab}</p>
      {TABS.map((t) => (
        <button key={t} type="button" onClick={() => select(t)}>
          {t}
        </button>
      ))}
    </div>
  );
}

function LegacyHashTabs() {
  const [tab, select] = useHashTab<Tab>(TABS, 'overview');
  return (
    <div>
      <p data-testid="tab">{tab}</p>
      <button type="button" onClick={() => select('runs')}>
        runs
      </button>
    </div>
  );
}

const go = (url: string) => window.history.replaceState(null, '', url);
const tab = () => screen.getByTestId('tab').textContent;

beforeEach(() => go('/admin/payroll'));
afterEach(cleanup);

describe('useTabParam — hash mode (default)', () => {
  it('opens the tab a hash names, and clears that hash when another tab is picked', () => {
    go('/admin/leave?employeeId=e-1#calendars');
    render(<Tabs />);
    expect(tab()).toBe('calendars');
    fireEvent.click(screen.getByRole('button', { name: 'runs' }));
    expect(tab()).toBe('runs');
    expect(window.location.hash).toBe('');
    expect(window.location.search).toBe('?employeeId=e-1');
  });

  it('ignores a hash naming no tab, and the old useHashTab behaves the same', () => {
    go('/admin/leave#not-a-tab');
    render(<LegacyHashTabs />);
    expect(tab()).toBe('overview');
    fireEvent.click(screen.getByRole('button', { name: 'runs' }));
    expect(tab()).toBe('runs');
    expect(window.location.hash).toBe('#not-a-tab');
  });
});

describe('useTabParam — query mode', () => {
  it('opens ?tab= deep links (e.g. /admin/payroll?tab=calendars) and writes the choice', () => {
    go('/admin/payroll?tab=calendars&organizationId=o-1#top');
    render(<Tabs mode="query" />);
    expect(tab()).toBe('calendars');
    fireEvent.click(screen.getByRole('button', { name: 'runs' }));
    expect(tab()).toBe('runs');
    const params = new URLSearchParams(window.location.search);
    expect(params.get('tab')).toBe('runs');
    expect(params.get('organizationId')).toBe('o-1');
    expect(window.location.hash).toBe('#top');
    // The initial tab is the bare URL.
    fireEvent.click(screen.getByRole('button', { name: 'overview' }));
    expect(tab()).toBe('overview');
    expect(new URLSearchParams(window.location.search).has('tab')).toBe(false);
  });

  it('uses a custom parameter and falls back to the initial tab for unknown values', () => {
    go('/time?section=runs');
    const { unmount } = render(<Tabs mode="query" param="section" />);
    expect(tab()).toBe('runs');
    unmount();
    go('/time?section=bogus');
    render(<Tabs mode="query" param="section" />);
    expect(tab()).toBe('overview');
  });

  it('follows Back and Forward (popstate) without adding history entries', () => {
    go('/admin/payroll?tab=calendars');
    const before = window.history.length;
    render(<Tabs mode="query" />);
    fireEvent.click(screen.getByRole('button', { name: 'runs' }));
    expect(window.history.length).toBe(before);
    // The browser moves to another entry (Back/Forward) and fires popstate.
    act(() => {
      window.history.pushState(null, '', '/admin/payroll?tab=calendars');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(tab()).toBe('calendars');
    act(() => {
      window.history.pushState(null, '', '/admin/payroll');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(tab()).toBe('overview');
  });

  it('hash tabs follow Back and Forward too', () => {
    go('/admin/leave#calendars');
    render(<Tabs />);
    act(() => {
      window.history.pushState(null, '', '/admin/leave#runs');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(tab()).toBe('runs');
  });
});

function WritingTabs({ tabs }: { tabs: readonly Tab[] }) {
  const [tab, select] = useTabParam<Tab>(tabs, 'overview', { writeHash: true });
  return (
    <div>
      <p data-testid="tab">{tab}</p>
      {tabs.map((t) => (
        <button key={t} type="button" onClick={() => select(t)}>
          {t}
        </button>
      ))}
    </div>
  );
}

describe('useTabParam — hash mode with writeHash (Batch 10B, the employee profile)', () => {
  it('writes the picked tab into the hash (keeping the query) and follows Back/Forward', () => {
    go('/admin/employees/e-1?from=directory');
    render(<WritingTabs tabs={TABS} />);
    expect(tab()).toBe('overview');
    fireEvent.click(screen.getByRole('button', { name: 'runs' }));
    expect(tab()).toBe('runs');
    expect(window.location.hash).toBe('#runs');
    expect(window.location.search).toBe('?from=directory');
    act(() => {
      go('/admin/employees/e-1?from=directory#calendars');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(tab()).toBe('calendars');
  });

  it('opens a deep-linked tab, and falls back to the initial tab when the choice disappears', () => {
    go('/admin/employees/e-1#calendars');
    const { rerender } = render(<WritingTabs tabs={TABS} />);
    expect(tab()).toBe('calendars');
    fireEvent.click(screen.getByRole('button', { name: 'runs' }));
    expect(tab()).toBe('runs');
    // e.g. the tab is hidden once the employee's capabilities load.
    act(() => go('/admin/employees/e-1'));
    rerender(<WritingTabs tabs={['overview', 'calendars']} />);
    expect(tab()).toBe('overview');
  });
});

describe('notifyLocationHashChange (Batch 10C)', () => {
  it('notifies again once a router commits the new URL later than the next tick', async () => {
    vi.useFakeTimers();
    try {
      go('/admin/time#records');
      render(<Tabs />);
      expect(tab()).toBe('overview');
      notifyLocationHashChange();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10);
      });
      expect(tab()).toBe('overview');
      // The router commits the URL 300 ms later (after fetching the page for the new query).
      await act(async () => {
        await vi.advanceTimersByTimeAsync(290);
        window.history.pushState(null, '', '/admin/time#calendars');
        await vi.advanceTimersByTimeAsync(60);
      });
      expect(tab()).toBe('calendars');
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * R4-A (Checkpoint D): the watcher started by a navigation belongs to its owner. A link whose
 * navigation never commits (jsdom does not navigate) used to leave a 2 s interval running after
 * the test unmounted everything; once the test environment was torn down it read a missing
 * `window` ("window is not defined"). These pin the lifecycle: nothing runs after the owner
 * unmounts or cancels.
 */
describe('location watcher ownership (R4-A)', () => {
  function Owner() {
    const notify = useLocationChangeNotifier();
    return (
      <button type="button" onClick={notify}>
        navigate
      </button>
    );
  }

  it('cancels both timers when the owning component unmounts, and notifies no one after', async () => {
    vi.useFakeTimers();
    const heard = vi.fn();
    window.addEventListener(LOCATION_HASH_EVENT, heard);
    try {
      go('/admin/time#records');
      const { unmount } = render(<Owner />);
      fireEvent.click(screen.getByRole('button', { name: 'navigate' }));
      // The next-tick notice and the commit watcher are pending.
      expect(vi.getTimerCount()).toBe(2);
      unmount();
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(3_000);
      expect(heard).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener(LOCATION_HASH_EVENT, heard);
      vi.useRealTimers();
    }
  });

  it("uses the shell's watcher inside a shell: a link that leaves the page still gets the notice", async () => {
    // e.g. the review journey's "Cycle" link: the page (and the link) unmounts in the commit
    // that changes the URL, so the shell, which stays mounted, must own the watcher.
    function Shell() {
      const notify = useOwnedLocationChangeNotifier();
      const [page, setPage] = useState(true);
      return (
        <LocationChangeNotifierContext.Provider value={notify}>
          {page && <Owner />}
          <button type="button" onClick={() => setPage(false)}>
            leave
          </button>
        </LocationChangeNotifierContext.Provider>
      );
    }
    vi.useFakeTimers();
    const heard = vi.fn();
    window.addEventListener(LOCATION_HASH_EVENT, heard);
    try {
      go('/admin/performance/reviews/r-1');
      const { unmount } = render(<Shell />);
      fireEvent.click(screen.getByRole('button', { name: 'navigate' }));
      await vi.advanceTimersByTimeAsync(10);
      expect(heard).toHaveBeenCalledTimes(1);
      // The page unmounts, then the router commits the URL.
      fireEvent.click(screen.getByRole('button', { name: 'leave' }));
      window.history.pushState(null, '', '/admin/performance#cycles');
      await vi.advanceTimersByTimeAsync(50);
      expect(heard).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
      unmount();
      // And when the shell itself unmounts, its pending watcher goes with it.
      render(<Shell />);
      fireEvent.click(screen.getByRole('button', { name: 'navigate' }));
      expect(vi.getTimerCount()).toBe(2);
      cleanup();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      window.removeEventListener(LOCATION_HASH_EVENT, heard);
      vi.useRealTimers();
    }
  });

  it('stops by itself once the URL commits, and a new navigation replaces the pending watcher', async () => {
    vi.useFakeTimers();
    const heard = vi.fn();
    window.addEventListener(LOCATION_HASH_EVENT, heard);
    try {
      go('/admin/time#records');
      const first = notifyLocationHashChange();
      notifyLocationHashChange();
      // Only the latest navigation's two timers remain.
      expect(vi.getTimerCount()).toBe(2);
      await vi.advanceTimersByTimeAsync(10);
      expect(heard).toHaveBeenCalledTimes(1);
      window.history.pushState(null, '', '/admin/time#calendars');
      await vi.advanceTimersByTimeAsync(50);
      expect(heard).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
      // Cancelling a watcher that was already replaced or finished is harmless.
      first();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      window.removeEventListener(LOCATION_HASH_EVENT, heard);
      vi.useRealTimers();
    }
  });

  it('gives up after 2 s when the URL never changes, then leaves nothing running', async () => {
    vi.useFakeTimers();
    try {
      go('/admin/time#records');
      const cancel = notifyLocationHashChange();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(vi.getTimerCount()).toBe(0);
      cancel();
    } finally {
      vi.useRealTimers();
    }
  });
});
