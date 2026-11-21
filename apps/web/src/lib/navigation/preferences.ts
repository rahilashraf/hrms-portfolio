/**
 * Per-browser shell preferences. Storage can be unavailable (private mode, blocked cookies,
 * quota): every access is guarded and falls back to the default.
 */
export const PREFERENCE_KEYS = {
  collapsed: 'hrms.nav.collapsed',
  collapsedGroups: 'hrms.nav.collapsedGroups',
  organization: 'hrms.workspace.organizationId',
} as const;

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readPreference(key: string): string | null {
  try {
    return storage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function writePreference(key: string, value: string | null): void {
  try {
    const store = storage();
    if (!store) return;
    if (value === null) store.removeItem(key);
    else store.setItem(key, value);
  } catch {
    // Preferences are a convenience; failing to persist one is not an error.
  }
}

export function readCollapsed(): boolean {
  return readPreference(PREFERENCE_KEYS.collapsed) === '1';
}

export function writeCollapsed(collapsed: boolean): void {
  writePreference(PREFERENCE_KEYS.collapsed, collapsed ? '1' : '0');
}

/** Groups the user collapsed; `null` when never stored (every group starts expanded). */
export function readCollapsedGroups(): string[] | null {
  const raw = readPreference(PREFERENCE_KEYS.collapsedGroups);
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string')
      : null;
  } catch {
    return null;
  }
}

export function writeCollapsedGroups(groups: readonly string[]): void {
  writePreference(PREFERENCE_KEYS.collapsedGroups, JSON.stringify([...groups]));
}
