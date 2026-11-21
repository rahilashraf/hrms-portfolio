'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { organizationApi } from '../../lib/organization/api';
import { organizationErrorMessage } from '../../lib/organization/errors';
import type { Organization } from '../../lib/organization/types';
import { useAuth } from '../../providers/auth-provider';
import {
  PageHeader,
  ErrorBanner,
  FeedbackMessage,
  LoadingState,
  RecordActions,
  StatusBadge,
} from './shared';
import { PageContainer } from '../ui/page-container';

const resources = [
  { slug: 'units', title: 'Business Units', description: 'Manage the unit hierarchy.' },
  {
    slug: 'departments',
    title: 'Departments',
    description: 'Manage organization-wide or unit departments.',
  },
  { slug: 'teams', title: 'Teams', description: 'Manage department or unit teams.' },
  { slug: 'job-titles', title: 'Job Titles', description: 'Manage organization job titles.' },
  {
    slug: 'positions',
    title: 'Positions',
    description: 'Manage positions and their structural placement.',
  },
  {
    slug: 'work-locations',
    title: 'Work Locations',
    description: 'Manage work sites and time zones.',
  },
  {
    slug: 'physical-sites',
    title: 'Physical Sites',
    description: 'Manage the buildings work locations and kiosks belong to.',
  },
];

export function OrganizationOverviewPage({ organizationId }: { organizationId: string }) {
  const { can } = useAuth();
  const canManage = can('organization.manage', { type: 'ORGANIZATION', id: organizationId });
  const [organization, setOrganization] = useState<Organization | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const requestId = useRef(0);

  const fetchOrganization = useCallback(
    () => organizationApi.getOrganization(organizationId, true),
    [organizationId],
  );

  const load = useCallback(async () => {
    const currentRequest = ++requestId.current;
    setLoading(true);
    try {
      const nextOrganization = await fetchOrganization();
      if (currentRequest !== requestId.current) return;
      setOrganization(nextOrganization);
      setError(null);
    } catch (cause) {
      if (currentRequest === requestId.current) {
        setError(organizationErrorMessage(cause, 'Unable to load this organization.'));
      }
    } finally {
      if (currentRequest === requestId.current) setLoading(false);
    }
  }, [fetchOrganization]);

  useEffect(() => {
    const currentRequest = ++requestId.current;
    let active = true;
    fetchOrganization()
      .then((nextOrganization) => {
        if (!active || currentRequest !== requestId.current) return;
        setOrganization(nextOrganization);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (!active || currentRequest !== requestId.current) return;
        setError(organizationErrorMessage(cause, 'Unable to load this organization.'));
      })
      .finally(() => {
        if (active && currentRequest === requestId.current) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [fetchOrganization]);

  async function update(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!organization || saving) return;
    setSaving(true);
    setError(null);
    const data = new FormData(event.currentTarget);
    try {
      await organizationApi.updateOrganization(organization.id, {
        name: String(data.get('name') ?? '').trim(),
        description: String(data.get('description') ?? '').trim(),
        sortOrder: Number(data.get('sortOrder') ?? 0),
        // The timezone can be changed but never cleared: leave never falls back to UTC.
        ...(String(data.get('timezone') ?? '').trim()
          ? { timezone: String(data.get('timezone')).trim() }
          : {}),
      });
      setEditing(false);
      setSuccess('Organization updated.');
      await load();
    } catch (cause) {
      setError(organizationErrorMessage(cause, 'Unable to update organization.'));
    } finally {
      setSaving(false);
    }
  }

  async function archive() {
    if (!organization) return;
    setError(null);
    try {
      await organizationApi.archiveOrganization(organization.id);
      setSuccess('Organization archived.');
      await load();
    } catch (cause) {
      setError(organizationErrorMessage(cause, 'Unable to archive organization.'));
    }
  }

  async function reactivate() {
    if (!organization) return;
    setError(null);
    try {
      await organizationApi.reactivateOrganization(organization.id);
      setSuccess('Organization reactivated.');
      await load();
    } catch (cause) {
      setError(organizationErrorMessage(cause, 'Unable to reactivate organization.'));
    }
  }

  return (
    <PageContainer>
      <Link
        href="/admin/organizations"
        className="text-sm font-medium text-indigo-700 hover:underline"
      >
        ← Organizations
      </Link>
      {loading ? (
        <LoadingState />
      ) : error && !organization ? (
        <div className="mt-6">
          <ErrorBanner>{error}</ErrorBanner>
        </div>
      ) : organization ? (
        <>
          <div className="mt-6">
            <PageHeader
              eyebrow="Organization"
              title={organization.name}
              description={`${organization.code}${organization.description ? ` · ${organization.description}` : ''}`}
            >
              <div className="flex flex-wrap items-center gap-3">
                <StatusBadge archived={Boolean(organization.archivedAt)} />
                <RecordActions
                  archived={Boolean(organization.archivedAt)}
                  onEdit={() => setEditing((value) => !value)}
                  onArchive={archive}
                  onReactivate={reactivate}
                  readOnly={!canManage}
                />
              </div>
            </PageHeader>
          </div>
          {success && (
            <div className="mt-5">
              <FeedbackMessage>{success}</FeedbackMessage>
            </div>
          )}
          {error && (
            <div className="mt-5">
              <ErrorBanner>{error}</ErrorBanner>
            </div>
          )}
          {editing && !organization.archivedAt && (
            <form
              onSubmit={(event) => void update(event)}
              className="mt-6 grid grid-cols-1 gap-4 rounded-xl border border-slate-200 bg-white p-5 sm:grid-cols-2"
            >
              <h2 className="text-lg font-semibold sm:col-span-2">Edit organization</h2>
              <label className="text-sm font-medium text-slate-700">
                Name
                <input
                  name="name"
                  defaultValue={organization.name}
                  required
                  className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2"
                />
              </label>
              <label className="text-sm font-medium text-slate-700">
                Code
                <input
                  value={organization.code}
                  readOnly
                  className="mt-1 block w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-sm text-slate-600"
                />
              </label>
              <label className="text-sm font-medium text-slate-700 sm:col-span-2">
                Description
                <textarea
                  name="description"
                  defaultValue={organization.description ?? ''}
                  rows={3}
                  className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2"
                />
              </label>
              <label className="text-sm font-medium text-slate-700">
                Sort order
                <input
                  name="sortOrder"
                  type="number"
                  min={0}
                  defaultValue={organization.sortOrder}
                  className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2"
                />
              </label>
              <label className="text-sm font-medium text-slate-700">
                Timezone (IANA)
                <input
                  name="timezone"
                  maxLength={200}
                  defaultValue={organization.timezone ?? ''}
                  placeholder="America/Toronto"
                  className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2"
                />
              </label>
              <div className="flex items-end justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setEditing(false)}
                  className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="rounded-lg bg-indigo-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
                >
                  {saving ? 'Saving…' : 'Save changes'}
                </button>
              </div>
            </form>
          )}
          <section className="mt-8">
            <h2 className="text-xl font-semibold text-slate-950">Organization structure</h2>
            <p className="mt-1 text-sm text-slate-600">Choose a section to manage its records.</p>
            <ul className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {resources.map((resource) => (
                <li key={resource.slug}>
                  <Link
                    href={`/admin/organizations/${organization.id}/${resource.slug}`}
                    className="block h-full rounded-xl border border-slate-200 bg-white p-5 transition hover:border-indigo-300 hover:shadow-sm"
                  >
                    <h3 className="font-semibold text-slate-950">{resource.title}</h3>
                    <p className="mt-2 text-sm text-slate-600">{resource.description}</p>
                    <span className="mt-4 inline-block text-sm font-medium text-indigo-700">
                      Manage →
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        </>
      ) : null}
    </PageContainer>
  );
}
