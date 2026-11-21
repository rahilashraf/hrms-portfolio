'use client';

import { checkboxClass } from '../ui/tokens';

import { useId } from 'react';
import type { Permission, RoleTemplate } from '../../lib/authorization/types';
import { enumLabel } from '../../lib/ui/labels';

/** Keys the caller is known not to hold in the organization (from the templates' answer). */
export function notGrantableKeys(templates: readonly RoleTemplate[]): ReadonlySet<string> {
  return new Set(templates.flatMap((template) => template.missingPermissions ?? []));
}

/** A template's keys minus the ones the caller cannot delegate. */
export function grantableTemplatePermissions(template: RoleTemplate): string[] {
  const missing = new Set(template.missingPermissions ?? []);
  return template.permissions.filter((key) => !missing.has(key));
}

/** "leave.manage_policy" → "Leave" when the API gave no area. */
function fallbackArea(key: string): string {
  return enumLabel((key.split('.')[0] ?? 'other').toUpperCase());
}

export function groupPermissionsByArea(
  permissions: readonly Permission[],
): Array<[string, Permission[]]> {
  const groups = new Map<string, Permission[]>();
  for (const permission of permissions) {
    const area = permission.area || fallbackArea(permission.key);
    const list = groups.get(area) ?? [];
    list.push(permission);
    groups.set(area, list);
  }
  return [...groups.entries()];
}

/**
 * Phase 20 — starting points for a new role. Choosing a template pre-selects its permissions
 * (except those the caller cannot grant); the selection stays fully editable before and after
 * the role is created. Templates never grant anything by themselves.
 */
export function RoleTemplatePicker({
  templates,
  selectedKey,
  onSelect,
}: {
  templates: readonly RoleTemplate[];
  selectedKey: string;
  onSelect(key: string): void;
}) {
  const id = useId();
  const selected = templates.find((template) => template.key === selectedKey) ?? null;
  const missing = selected?.missingPermissions ?? [];
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
      <label htmlFor={id} className="block text-sm font-medium text-slate-800">
        Start from a template (optional)
      </label>
      <select
        id={id}
        value={selectedKey}
        onChange={(event) => onSelect(event.currentTarget.value)}
        className="mt-1 block w-full rounded border bg-white px-3 py-2 text-sm sm:max-w-md"
      >
        <option value="">No template — choose permissions yourself</option>
        {templates.map((template) => (
          <option key={template.key} value={template.key}>
            {template.name}
          </option>
        ))}
      </select>
      {selected ? (
        <div className="mt-2 text-sm text-slate-600">
          <p>{selected.description}</p>
          <p className="mt-1">
            Pre-selected {selected.permissions.length - missing.length} of{' '}
            {selected.permissions.length} permissions. Adjust them below before creating the role.
          </p>
          {missing.length > 0 && (
            <p role="note" className="mt-1 text-amber-800">
              {missing.length === 1
                ? '1 permission in this template is'
                : `${missing.length} permissions in this template are`}{' '}
              not selected because you can&apos;t grant them: you don&apos;t hold them in this
              organization.
            </p>
          )}
        </div>
      ) : (
        <p className="mt-2 text-sm text-slate-600">
          Templates pre-select a typical set of permissions. They are only a starting point.
        </p>
      )}
    </div>
  );
}

/**
 * Permissions grouped by product area with their human label and description; the raw key is
 * secondary small text. Keys the caller cannot grant are disabled with an explanation.
 */
export function PermissionPicker({
  legend,
  hideLegend = false,
  permissions,
  selected,
  onChange,
  notGrantable = new Set<string>(),
  disabled = false,
}: {
  legend: string;
  hideLegend?: boolean;
  permissions: readonly Permission[];
  selected: readonly string[];
  onChange(next: string[]): void;
  notGrantable?: ReadonlySet<string>;
  disabled?: boolean;
}) {
  const groups = groupPermissionsByArea(permissions);
  return (
    <fieldset className="space-y-4">
      <legend className={hideLegend ? 'sr-only' : 'font-medium'}>{legend}</legend>
      {notGrantable.size > 0 && !disabled && (
        <p className="text-sm text-slate-600">
          Greyed-out permissions can&apos;t be granted by you: you don&apos;t hold them in this
          organization.
        </p>
      )}
      {groups.map(([area, entries]) => (
        <fieldset key={area} className="rounded-lg border border-slate-200 p-3">
          <legend className="px-1 text-sm font-semibold text-slate-900">{area}</legend>
          <div className="mt-1 grid grid-cols-1 gap-3 sm:grid-cols-2">
            {entries.map((permission) => {
              const blocked = notGrantable.has(permission.key);
              const checked = selected.includes(permission.key) && !blocked;
              return (
                <label
                  key={permission.key}
                  className={`flex gap-2 text-sm ${blocked ? 'text-slate-500' : 'text-slate-800'}`}
                >
                  <input
                    type="checkbox"
                    className={`${checkboxClass} mt-1`}
                    disabled={disabled || blocked}
                    checked={checked}
                    aria-describedby={blocked ? `blocked-${permission.key}` : undefined}
                    onChange={(event) =>
                      onChange(
                        event.currentTarget.checked
                          ? [...selected, permission.key]
                          : selected.filter((key) => key !== permission.key),
                      )
                    }
                  />
                  <span>
                    <span className="block font-medium">{permission.label || permission.name}</span>
                    {permission.description && (
                      <span className="block text-slate-600">{permission.description}</span>
                    )}
                    {blocked && (
                      <span id={`blocked-${permission.key}`} className="block text-amber-800">
                        You can&apos;t grant this permission.
                      </span>
                    )}
                    <span className="block font-mono text-xs text-slate-600">{permission.key}</span>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>
      ))}
    </fieldset>
  );
}
