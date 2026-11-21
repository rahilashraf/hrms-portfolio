'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import {
  flattenNavigation,
  visibleNavigation,
  type NavIconName,
} from '../../lib/navigation/registry';
import { organizationApi } from '../../lib/organization/api';
import type { Organization } from '../../lib/organization/types';
import { useWorkspace } from '../../providers/workspace-provider';
import { Forbidden } from '../auth/forbidden';
import { Icon } from '../shell/icons';
import { SetupChecklist, canSeeSetup } from '../setup/setup-checklist';
import { buttonClass } from '../ui/button';
import { PageHeader } from '../ui/page-header';
import { EmptyState, LoadingState } from '../ui/states';
import { PageContainer } from '../ui/page-container';

/** The settings areas linked from Company Settings, by navigation registry id. */
export const COMPANY_SETTINGS_LINKS = [
  'branding',
  'features',
  'notification-settings',
  'integrations',
  'roles',
  'user-access',
  'audit',
] as const;

/**
 * Phase 20 — Company Settings: a hub for the selected organization. Organization details are
 * edited on the existing organization page (linked, not duplicated); each settings card is
 * shown only when the navigation registry would show it to this user.
 */
export function CompanySettingsPage() {
  const { selectedOrganization, navContext, status, workspace } = useWorkspace();
  const organizationId = selectedOrganization?.id ?? null;
  const [details, setDetails] = useState<Organization | null>(null);

  useEffect(() => {
    if (!organizationId) return;
    let active = true;
    organizationApi
      .getOrganization(organizationId)
      .then((value) => {
        if (active) setDetails(value);
      })
      .catch(() => {
        // The workspace summary below still shows the essentials.
        if (active) setDetails(null);
      });
    return () => {
      active = false;
    };
  }, [organizationId]);

  const leaves = useMemo(
    () => (navContext ? flattenNavigation(visibleNavigation(navContext)) : []),
    [navContext],
  );

  if (status === 'loading' || !navContext) {
    return (
      <Page>
        <LoadingState label="Loading company settings…" />
      </Page>
    );
  }
  if (!selectedOrganization) {
    return (
      <Page>
        <PageHeader eyebrow="Administration" title="Company Settings" />
        <div className="mt-6">
          <EmptyState
            title="No organization selected"
            description="Company settings belong to an organization. Choose one in the organization switcher."
          />
        </div>
      </Page>
    );
  }
  if (!canSeeSetup(navContext.permissions)) {
    return (
      <PageContainer width="wide" padded={false}>
        <Forbidden message="You do not have permission to view this organization's settings." />
      </PageContainer>
    );
  }

  const cards = COMPANY_SETTINGS_LINKS.map((id) => leaves.find((item) => item.id === id)).filter(
    (item) => item !== undefined,
  );
  const canOpenOrganization = leaves.some((item) => item.id === 'organization');
  const current = details && details.id === selectedOrganization.id ? details : null;
  const timezone = current?.timezone ?? selectedOrganization.timezone;

  return (
    <Page>
      <PageHeader
        eyebrow="Administration"
        title="Company Settings"
        description={`Profile, setup and settings for ${selectedOrganization.name}.`}
      />
      <div className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <section
          aria-labelledby="company-details-heading"
          className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <h2 id="company-details-heading" className="text-lg font-semibold text-slate-950">
              Organization details
            </h2>
            {canOpenOrganization && (
              <Link
                href={`/admin/organizations/${encodeURIComponent(selectedOrganization.id)}`}
                className={buttonClass('secondary', 'sm')}
              >
                Edit organization details
              </Link>
            )}
          </div>
          <dl className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Detail label="Name">{current?.name ?? selectedOrganization.name}</Detail>
            <Detail label="Code">{current?.code ?? selectedOrganization.code}</Detail>
            <Detail label="Time zone">
              {timezone ?? (
                <span className="text-amber-800">Not set — needed for dates and leave</span>
              )}
            </Detail>
            {current?.description && <Detail label="Description">{current.description}</Detail>}
          </dl>
        </section>
        <SetupChecklist
          variant="full"
          organizationId={selectedOrganization.id}
          userId={workspace?.user.id ?? 'anonymous'}
        />
      </div>
      {cards.length > 0 && (
        <section aria-labelledby="company-settings-areas" className="mt-8">
          <h2 id="company-settings-areas" className="text-lg font-semibold text-slate-950">
            Settings
          </h2>
          <ul className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {cards.map((item) => (
              <li key={item.id}>
                <Link
                  href={item.href!}
                  className="flex h-full gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm transition hover:border-indigo-300 hover:shadow focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500"
                >
                  <Icon
                    name={item.icon as NavIconName}
                    className="mt-0.5 size-5 shrink-0 text-[var(--hrms-accent-text)]"
                  />
                  <span>
                    <span className="block font-medium text-slate-900">{item.label}</span>
                    <span className="mt-1 block text-sm text-slate-600">{item.description}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </Page>
  );
}

function Page({ children }: { children: React.ReactNode }) {
  return <PageContainer width="wide">{children}</PageContainer>;
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-sm text-slate-500">{label}</dt>
      <dd className="mt-1 break-words font-medium text-slate-900">{children}</dd>
    </div>
  );
}
