'use client';

import Link from 'next/link';
import type { KeyboardEvent, ReactNode } from 'react';
import type { ResolvedNavItem } from '../../lib/navigation/registry';
import { Icon } from './icons';

const ITEM_BASE =
  'group relative flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[var(--hrms-accent-text)] focus-visible:ring-offset-1';

function Tooltip({ label, show }: { label: string; show: boolean }) {
  if (!show) return null;
  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute left-full top-1/2 z-50 ml-3 hidden -translate-y-1/2 whitespace-nowrap rounded-md bg-slate-900 px-2 py-1 text-xs font-medium text-white shadow group-hover:block group-focus-visible:block"
    >
      {label}
    </span>
  );
}

function NavLink({
  item,
  active,
  collapsed,
  nested,
  onNavigate,
}: {
  item: ResolvedNavItem;
  active: boolean;
  collapsed: boolean;
  nested: boolean;
  onNavigate(): void;
}) {
  return (
    <Link
      href={item.href!}
      data-nav-item=""
      aria-current={active ? 'page' : undefined}
      aria-label={collapsed ? item.label : undefined}
      title={collapsed ? item.label : undefined}
      // The shell's onNavigate tells tab subscribers to re-read the URL (R4-A: it owns that
      // watcher, since a drawer link unmounts as soon as it is clicked).
      onClick={onNavigate}
      className={`${ITEM_BASE} ${collapsed ? 'justify-center px-2' : nested ? 'pl-9' : ''} ${
        active
          ? // Organization branding: the indicator bar and icon use the accent; the label stays
            // near-black on the tint so its contrast never depends on the brand color.
            'bg-slate-100 text-slate-950 before:absolute before:inset-y-1 before:left-0 before:w-1 before:rounded-full before:bg-[var(--hrms-accent)]'
          : 'text-slate-700 hover:bg-slate-100 hover:text-slate-950'
      }`}
    >
      <Icon
        name={item.icon}
        className={`size-[18px] ${active ? 'text-[var(--hrms-accent-text)]' : 'text-slate-500'}`}
      />
      {!collapsed && <span className="truncate">{item.label}</span>}
      <Tooltip label={item.label} show={collapsed} />
    </Link>
  );
}

function focusItem(items: HTMLElement[], index: number) {
  if (items.length === 0) return;
  const bounded = (index + items.length) % items.length;
  items[bounded]?.focus();
}

/**
 * The grouped, collapsible primary navigation. Keyboard: ↑/↓ move between entries, Home/End
 * jump, → expands a group (or enters it), ← collapses it (or returns to its toggle), and
 * Enter/Space activate links and toggles natively.
 */
export function SidebarNavigation({
  tree,
  activeId,
  collapsed,
  collapsedGroups,
  onToggleGroup,
  onNavigate,
  loading,
}: {
  tree: readonly ResolvedNavItem[];
  activeId: string | null;
  collapsed: boolean;
  collapsedGroups: ReadonlySet<string>;
  onToggleGroup(groupId: string, expanded: boolean): void;
  onNavigate(): void;
  loading: boolean;
}) {
  const activeGroupId =
    tree.find((group) => group.children.some((child) => child.id === activeId))?.id ?? null;

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[data-nav-item]'));
    const current = document.activeElement as HTMLElement | null;
    const index = current ? items.indexOf(current) : -1;
    if (index < 0) return;
    const groupId = current?.dataset.groupId;
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        focusItem(items, index + 1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        focusItem(items, index - 1);
        break;
      case 'Home':
        event.preventDefault();
        focusItem(items, 0);
        break;
      case 'End':
        event.preventDefault();
        focusItem(items, items.length - 1);
        break;
      case 'ArrowRight':
        if (groupId) {
          event.preventDefault();
          if (collapsedGroups.has(groupId)) onToggleGroup(groupId, true);
          else focusItem(items, index + 1);
        }
        break;
      case 'ArrowLeft': {
        event.preventDefault();
        if (groupId) {
          if (!collapsedGroups.has(groupId)) onToggleGroup(groupId, false);
          break;
        }
        const toggle = current
          ?.closest('[data-nav-group]')
          ?.querySelector<HTMLElement>('[data-group-id]');
        toggle?.focus();
        break;
      }
    }
  }

  if (loading) {
    return (
      <div className="space-y-2 px-3 py-4" aria-hidden="true">
        {Array.from({ length: 6 }, (_, index) => (
          <span key={index} className="block h-8 animate-pulse rounded-lg bg-slate-100" />
        ))}
      </div>
    );
  }

  const groupBody = (group: ResolvedNavItem, expanded: boolean): ReactNode =>
    expanded && (
      <ul id={`nav-group-${group.id}`} className="mt-1 space-y-0.5">
        {group.children.map((child) => (
          <li key={child.id}>
            <NavLink
              item={child}
              active={child.id === activeId}
              collapsed={collapsed}
              nested={!collapsed}
              onNavigate={onNavigate}
            />
          </li>
        ))}
      </ul>
    );

  return (
    <nav aria-label="Primary" className="flex-1 overflow-y-auto px-2 py-3" onKeyDown={onKeyDown}>
      <ul className="space-y-1">
        {tree.map((item) => {
          if (item.children.length === 0) {
            return (
              <li key={item.id}>
                <NavLink
                  item={item}
                  active={item.id === activeId}
                  collapsed={collapsed}
                  nested={false}
                  onNavigate={onNavigate}
                />
              </li>
            );
          }
          if (collapsed) {
            // Icon-only mode lists every entry; groups become labelled separators.
            return (
              <li key={item.id} data-nav-group="" className="border-t border-slate-100 pt-1">
                <span className="sr-only">{item.label}</span>
                {groupBody(item, true)}
              </li>
            );
          }
          const expanded = !collapsedGroups.has(item.id);
          const containsActive = item.id === activeGroupId;
          return (
            <li key={item.id} data-nav-group="">
              <button
                type="button"
                data-nav-item=""
                data-group-id={item.id}
                aria-expanded={expanded}
                aria-controls={`nav-group-${item.id}`}
                onClick={() => onToggleGroup(item.id, !expanded)}
                className={`${ITEM_BASE} ${containsActive ? 'text-slate-950' : 'text-slate-700'} hover:bg-slate-100`}
              >
                <Icon name={item.icon} className="size-[18px] text-slate-500" />
                <span className="flex-1 truncate text-left">{item.label}</span>
                <Icon
                  name="chevronDown"
                  className={`size-4 text-slate-400 transition-transform ${expanded ? '' : '-rotate-90'}`}
                />
              </button>
              {groupBody(item, expanded)}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
