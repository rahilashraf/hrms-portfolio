'use client';

import { useId } from 'react';
import { accentPalette } from '../../lib/branding/color';
import { organizationInitials } from '../../lib/navigation/context';
import type { WorkspaceOrganization } from '../../lib/workspace/types';

export function organizationDisplayName(organization: WorkspaceOrganization): string {
  return (
    organization.branding?.shortName || organization.branding?.displayName || organization.name
  );
}

function OrganizationBadge({ organization }: { organization: WorkspaceOrganization }) {
  const iconUrl = organization.branding?.iconUrl;
  const palette = accentPalette(
    organization.branding?.primaryColor,
    organization.branding?.secondaryColor,
  );
  if (iconUrl) {
    return (
      // Branding icons are external https references chosen by administrators.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={iconUrl}
        alt=""
        referrerPolicy="no-referrer"
        className="size-8 shrink-0 rounded-lg object-cover"
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-xs font-semibold"
      style={{ backgroundColor: palette.accent, color: palette.onAccent }}
    >
      {organizationInitials(organizationDisplayName(organization))}
    </span>
  );
}

/**
 * The selected organization (navigation context) and, when the caller has several, a switcher.
 * Switching changes what the navigation shows, never what the API allows.
 */
export function OrganizationSwitcher({
  organizations,
  selected,
  collapsed,
  onSelect,
}: {
  organizations: readonly WorkspaceOrganization[];
  selected: WorkspaceOrganization | null;
  collapsed: boolean;
  onSelect(organizationId: string): void;
}) {
  const id = useId();
  if (!selected) return null;
  const name = organizationDisplayName(selected);
  if (collapsed) {
    return (
      <div className="flex justify-center px-2 pb-2" title={name}>
        <OrganizationBadge organization={selected} />
        <span className="sr-only">Current organization: {name}</span>
      </div>
    );
  }
  return (
    <div className="mx-3 mb-2 flex items-center gap-3 rounded-xl border border-slate-200 bg-slate-50 p-2">
      <OrganizationBadge organization={selected} />
      <div className="min-w-0 flex-1">
        {organizations.length > 1 ? (
          <>
            <label htmlFor={id} className="block text-xs font-medium text-slate-500">
              Switch organization
            </label>
            <select
              id={id}
              value={selected.id}
              onChange={(event) => onSelect(event.currentTarget.value)}
              className="mt-0.5 block w-full truncate rounded-md border border-slate-300 bg-white px-2 py-1 text-sm font-medium text-slate-900 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[var(--hrms-accent-text)]"
            >
              {organizations.map((organization) => (
                <option key={organization.id} value={organization.id}>
                  {organizationDisplayName(organization)}
                </option>
              ))}
            </select>
          </>
        ) : (
          <>
            <p className="text-xs font-medium text-slate-500">Organization</p>
            <p className="truncate text-sm font-semibold text-slate-900">{name}</p>
          </>
        )}
      </div>
    </div>
  );
}
