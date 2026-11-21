'use client';

import Link from 'next/link';
import { useCallback, useEffect, useId, useState } from 'react';
import { organizationApi } from '../../lib/organization/api';
import { organizationErrorMessage, physicalSiteErrorMessage } from '../../lib/organization/errors';
import type {
  Organization,
  PhysicalSiteInput,
  PhysicalSiteListItem,
} from '../../lib/organization/types';
import { useAuth } from '../../providers/auth-provider';
import { buttonClass } from '../ui/button';
import { FormDialog } from '../ui/form-dialog';
import { EmptyState, ErrorState, LoadingState } from '../ui/states';
import { inputClass } from '../ui/tokens';
import { ArchivedToggle, FeedbackMessage, PageHeader, StatusBadge } from './shared';
import { PageContainer } from '../ui/page-container';

const ADDRESS_FIELDS: Array<[keyof PhysicalSiteInput, string]> = [
  ['addressLine1', 'Address line 1'],
  ['addressLine2', 'Address line 2'],
  ['city', 'City'],
  ['stateProvince', 'State / Province'],
  ['postalCode', 'Postal code'],
  ['country', 'Country'],
];

type Editing = { mode: 'create' } | { mode: 'edit'; site: PhysicalSiteListItem } | null;

/**
 * Batch 5C — an organization's physical sites (Batch 5B D12): the buildings its work locations
 * and kiosk devices belong to. Readers with organization.read see the list; changes need
 * organization.manage in the organization (actions appear only then; the API stays
 * authoritative). Nothing is deleted: a site still used by a work location or an active kiosk
 * cannot be archived, and an archived site can be reactivated.
 */
export function PhysicalSitesPage({ organizationId }: { organizationId: string }) {
  const { can } = useAuth();
  const canManage = can('organization.manage', { type: 'ORGANIZATION', id: organizationId });
  const [organization, setOrganization] = useState<Organization | null>(null);
  const [sites, setSites] = useState<PhysicalSiteListItem[]>([]);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const [archiving, setArchiving] = useState<PhysicalSiteListItem | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      setLoading(true);
      Promise.all([
        organizationApi.getOrganization(organizationId, true),
        organizationApi.listPhysicalSites(organizationId, includeArchived),
      ])
        .then(([nextOrganization, list]) => {
          if (!active) return;
          setOrganization(nextOrganization);
          setSites(list.items);
          setError(null);
        })
        .catch((cause) => {
          if (active)
            setError(organizationErrorMessage(cause, 'Unable to load the physical sites.'));
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [organizationId, includeArchived, attempt]);

  const reload = useCallback(() => setAttempt((value) => value + 1), []);
  const archivedOrganization = Boolean(organization?.archivedAt);
  const mayChange = canManage && !archivedOrganization;

  async function reactivate(site: PhysicalSiteListItem) {
    setBusyId(site.id);
    setActionError(null);
    setSuccess(null);
    try {
      await organizationApi.reactivatePhysicalSite(organizationId, site.id);
      setSuccess(`${site.name} reactivated.`);
      reload();
    } catch (cause) {
      setActionError(physicalSiteErrorMessage(cause, 'Unable to reactivate the physical site.'));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <PageContainer>
      <Link
        href={`/admin/organizations/${organizationId}`}
        className="text-sm font-medium text-indigo-700 hover:underline"
      >
        ← {organization?.name ?? 'Organization'}
      </Link>
      <div className="mt-6">
        <PageHeader
          eyebrow={organization?.name ?? 'Organization'}
          title="Physical Sites"
          description="The buildings work locations and kiosk devices belong to. Several work locations can share one site."
        >
          {mayChange && (
            <button
              type="button"
              onClick={() => {
                setSuccess(null);
                setActionError(null);
                setEditing({ mode: 'create' });
              }}
              className={buttonClass('primary', 'sm')}
            >
              Add physical site
            </button>
          )}
        </PageHeader>
      </div>
      {archivedOrganization && (
        <p className="mt-4 rounded-lg bg-slate-100 px-3 py-2 text-sm text-slate-800">
          This organization is archived; its physical sites are read-only.
        </p>
      )}
      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <ArchivedToggle checked={includeArchived} onChange={setIncludeArchived} />
      </div>
      {success && (
        <div className="mt-4">
          <FeedbackMessage>{success}</FeedbackMessage>
        </div>
      )}
      {actionError && (
        <p role="alert" className="mt-4 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-900">
          {actionError}
        </p>
      )}
      <div className="mt-4">
        {loading ? (
          <LoadingState label="Loading physical sites…" />
        ) : error ? (
          <ErrorState title="Physical sites unavailable" message={error} onRetry={reload} />
        ) : sites.length === 0 ? (
          <EmptyState
            title={includeArchived ? 'No physical sites' : 'No active physical sites'}
            description="Work locations created with “Create a matching physical site” add one automatically."
          />
        ) : (
          <ul className="space-y-3" aria-label="Physical sites">
            {sites.map((site) => (
              <SiteRow
                key={site.id}
                site={site}
                canManage={mayChange}
                busy={busyId === site.id}
                onEdit={() => {
                  setSuccess(null);
                  setActionError(null);
                  setEditing({ mode: 'edit', site });
                }}
                onArchive={() => {
                  setSuccess(null);
                  setActionError(null);
                  setArchiving(site);
                }}
                onReactivate={() => void reactivate(site)}
              />
            ))}
          </ul>
        )}
      </div>
      {editing && (
        <SiteDialog
          organizationId={organizationId}
          editing={editing}
          onClose={() => setEditing(null)}
          onSaved={(name) => {
            setEditing(null);
            setSuccess(editing.mode === 'create' ? `${name} added.` : `${name} saved.`);
            reload();
          }}
        />
      )}
      {archiving && (
        <ArchiveSiteDialog
          organizationId={organizationId}
          site={archiving}
          onClose={() => setArchiving(null)}
          onArchived={() => {
            setSuccess(`${archiving.name} archived.`);
            setArchiving(null);
            reload();
          }}
        />
      )}
    </PageContainer>
  );
}

function address(site: PhysicalSiteListItem): string {
  return [
    site.addressLine1,
    site.addressLine2,
    site.city,
    site.stateProvince,
    site.postalCode,
    site.country,
  ]
    .filter(Boolean)
    .join(', ');
}

export function archiveRestriction(
  site: Pick<PhysicalSiteListItem, 'activeWorkLocations' | 'activeDevices'>,
): string | null {
  if (site.activeWorkLocations === 0 && site.activeDevices === 0) return null;
  const parts = [
    site.activeWorkLocations > 0
      ? `${site.activeWorkLocations} work location${site.activeWorkLocations === 1 ? '' : 's'}`
      : null,
    site.activeDevices > 0
      ? `${site.activeDevices} active kiosk device${site.activeDevices === 1 ? '' : 's'}`
      : null,
  ].filter(Boolean);
  return `In use by ${parts.join(' and ')}. Move or archive them before archiving this site.`;
}

function SiteRow({
  site,
  canManage,
  busy,
  onEdit,
  onArchive,
  onReactivate,
}: {
  site: PhysicalSiteListItem;
  canManage: boolean;
  busy: boolean;
  onEdit(): void;
  onArchive(): void;
  onReactivate(): void;
}) {
  const restrictionId = useId();
  const archived = Boolean(site.archivedAt);
  const restriction = archived ? null : archiveRestriction(site);
  return (
    <li className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="break-words font-semibold text-slate-950">{site.name}</h2>
          <p className="mt-1 break-words text-sm text-slate-600">
            {address(site) || 'No address recorded'}
          </p>
          <p className="mt-1 text-sm text-slate-700">
            {site.activeWorkLocations} work location{site.activeWorkLocations === 1 ? '' : 's'} ·{' '}
            {site.activeDevices} active kiosk device{site.activeDevices === 1 ? '' : 's'}
          </p>
        </div>
        <StatusBadge archived={archived} />
      </div>
      {canManage && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {archived ? (
            <button
              type="button"
              disabled={busy}
              onClick={onReactivate}
              className={buttonClass('secondary', 'sm')}
            >
              {busy ? 'Reactivating…' : 'Reactivate'}
            </button>
          ) : (
            <>
              <button type="button" onClick={onEdit} className={buttonClass('secondary', 'sm')}>
                Rename or edit
              </button>
              <button
                type="button"
                onClick={onArchive}
                disabled={Boolean(restriction)}
                aria-describedby={restriction ? restrictionId : undefined}
                className={buttonClass('danger', 'sm')}
              >
                Archive
              </button>
            </>
          )}
          {restriction && (
            <p id={restrictionId} className="basis-full text-xs text-slate-600">
              {restriction}
            </p>
          )}
        </div>
      )}
    </li>
  );
}

function SiteDialog({
  organizationId,
  editing,
  onClose,
  onSaved,
}: {
  organizationId: string;
  editing: NonNullable<Editing>;
  onClose(): void;
  onSaved(name: string): void;
}) {
  const site = editing.mode === 'edit' ? editing.site : null;
  const nameId = useId();
  const [values, setValues] = useState<Record<string, string>>(() => ({
    name: site?.name ?? '',
    ...Object.fromEntries(
      ADDRESS_FIELDS.map(([key]) => [key, (site?.[key] as string | null) ?? '']),
    ),
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const missingName = !values.name?.trim();

  async function submit() {
    setTouched(true);
    if (missingName) return;
    setBusy(true);
    setError(null);
    const input: PhysicalSiteInput & { name: string } = {
      name: values.name!.trim(),
      ...Object.fromEntries(
        ADDRESS_FIELDS.map(([key]) => [key, values[key]?.trim() ? values[key]!.trim() : null]),
      ),
    };
    try {
      if (site) await organizationApi.updatePhysicalSite(organizationId, site.id, input);
      else await organizationApi.createPhysicalSite(organizationId, input);
      onSaved(input.name);
    } catch (cause) {
      setError(physicalSiteErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <FormDialog
      open
      title={site ? `Edit ${site.name}` : 'Add physical site'}
      description="The name must be unique among this organization's active sites."
      submitLabel={site ? 'Save site' : 'Add site'}
      busy={busy}
      canSubmit={!touched || !missingName}
      error={error}
      onSubmit={() => void submit()}
      onClose={onClose}
    >
      <div>
        <label htmlFor={nameId} className="block text-sm font-medium text-slate-800">
          Name <span className="font-normal text-slate-600">(required)</span>
        </label>
        <input
          id={nameId}
          value={values.name}
          maxLength={200}
          aria-required="true"
          aria-invalid={touched && missingName ? true : undefined}
          aria-describedby={touched && missingName ? `${nameId}-error` : undefined}
          onChange={(event) => setValues((current) => ({ ...current, name: event.target.value }))}
          className={inputClass}
        />
        {touched && missingName && (
          <p id={`${nameId}-error`} className="mt-1 text-sm text-rose-800">
            Enter the site name.
          </p>
        )}
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {ADDRESS_FIELDS.map(([key, label]) => (
          <label key={key} className="block text-sm font-medium text-slate-800">
            {label}
            <input
              value={values[key] ?? ''}
              maxLength={200}
              onChange={(event) =>
                setValues((current) => ({ ...current, [key]: event.target.value }))
              }
              className={inputClass}
            />
          </label>
        ))}
      </div>
    </FormDialog>
  );
}

function ArchiveSiteDialog({
  organizationId,
  site,
  onClose,
  onArchived,
}: {
  organizationId: string;
  site: PhysicalSiteListItem;
  onClose(): void;
  onArchived(): void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <FormDialog
      open
      title={`Archive ${site.name}?`}
      description="An archived site is hidden from pickers and cannot be used by new work locations or kiosks. You can reactivate it later."
      submitLabel="Archive site"
      busyLabel="Archiving…"
      busy={busy}
      canSubmit
      error={error}
      tone="destructive"
      onClose={onClose}
      onSubmit={async () => {
        setBusy(true);
        setError(null);
        try {
          await organizationApi.archivePhysicalSite(organizationId, site.id);
          onArchived();
        } catch (cause) {
          setError(physicalSiteErrorMessage(cause, 'Unable to archive the physical site.'));
        } finally {
          setBusy(false);
        }
      }}
    >
      <p className="text-sm text-slate-700">Work locations and kiosks keep their history.</p>
    </FormDialog>
  );
}
