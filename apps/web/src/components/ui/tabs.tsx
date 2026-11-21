'use client';

import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react';

export interface TabItem<T extends string> {
  id: T;
  label: string;
}

/** Stable ids linking a tab to its panel. */
export function tabIds(base: string, id: string) {
  return { tab: `${base}-tab-${id}`, panel: `${base}-panel-${id}` };
}

/**
 * An accessible tablist (WAI-ARIA tabs, automatic activation): roving tabindex, ←/→ (and
 * ↑/↓) move and select, Home/End jump. Pair with {@link TabPanel} using the same `idBase`.
 */
export function TabList<T extends string>({
  tabs,
  active,
  onChange,
  label,
  idBase,
  withPanels = true,
}: {
  tabs: readonly TabItem<T>[];
  active: T;
  onChange(tab: T): void;
  label: string;
  idBase: string;
  /** False when the content is not wrapped in a TabPanel (no aria-controls then). */
  withPanels?: boolean;
}) {
  const list = useRef<HTMLDivElement>(null);

  function move(event: KeyboardEvent<HTMLDivElement>) {
    const index = tabs.findIndex((tab) => tab.id === active);
    let next = -1;
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        next = (index + 1) % tabs.length;
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        next = (index - 1 + tabs.length) % tabs.length;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = tabs.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    const target = tabs[next];
    if (!target) return;
    onChange(target.id);
    list.current?.ownerDocument.getElementById(tabIds(idBase, target.id).tab)?.focus();
  }

  return (
    <div
      ref={list}
      role="tablist"
      aria-label={label}
      onKeyDown={move}
      className="flex gap-1 overflow-x-auto border-b border-slate-200"
    >
      {tabs.map((tab) => {
        const selected = tab.id === active;
        const ids = tabIds(idBase, tab.id);
        return (
          <button
            key={tab.id}
            id={ids.tab}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={withPanels ? ids.panel : undefined}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(tab.id)}
            className={`-mb-px shrink-0 whitespace-nowrap border-b-2 px-3 py-2 text-sm focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[var(--hrms-accent-text)] ${
              selected
                ? 'border-[var(--hrms-accent-text)] font-semibold text-[var(--hrms-accent-text)]'
                : 'border-transparent font-medium text-slate-600 hover:text-slate-900'
            }`}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

export function TabPanel({
  idBase,
  id,
  children,
}: {
  idBase: string;
  id: string;
  children: ReactNode;
}) {
  const ids = tabIds(idBase, id);
  return (
    <div role="tabpanel" id={ids.panel} aria-labelledby={ids.tab} tabIndex={0} className="mt-6">
      {children}
    </div>
  );
}

/** A unique, CSS-safe id base for a tab set. */
export function useTabIdBase(prefix: string): string {
  return `${prefix}-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
}
