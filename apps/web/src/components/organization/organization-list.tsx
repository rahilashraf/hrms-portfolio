'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { organizationApi } from '../../lib/organization/api';
import { organizationErrorMessage } from '../../lib/organization/errors';
import type { Organization } from '../../lib/organization/types';
import { useAuth } from '../../providers/auth-provider';
import {
  PageHeader,
  ArchivedToggle,
  ErrorBanner,
  FeedbackMessage,
  LoadingState,
  StatusBadge,
} from './shared';
import { PageContainer } from '../ui/page-container';

export function OrganizationListPage({ intro }: { intro?: ReactNode } = {}) {
  const { can } = useAuth();
  const canCreate = can('organization.manage', { type: 'SYSTEM' });
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const requestId = useRef(0);

  const fetchOrganizations = useCallback(
    () => organizationApi.listOrganizations(includeArchived),
    [includeArchived],
  );

  const loadOrganizations = useCallback(async () => {
    const currentRequest = ++requestId.current;
    setLoading(true);
    try {
      const nextOrganizations = await fetchOrganizations();
      if (currentRequest !== requestId.current) return;
      setOrganizations(nextOrganizations);
      setError(null);
    } catch (cause) {
      if (currentRequest === requestId.current) {
        setError(organizationErrorMessage(cause, 'Unable to load organizations.'));
      }
    } finally {
      if (currentRequest === requestId.current) setLoading(false);
    }
  }, [fetchOrganizations]);

  useEffect(() => {
    const currentRequest = ++requestId.current;
    let active = true;
    fetchOrganizations()
      .then((nextOrganizations) => {
        if (!active || currentRequest !== requestId.current) return;
        setOrganizations(nextOrganizations);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (!active || currentRequest !== requestId.current) return;
        setError(organizationErrorMessage(cause, 'Unable to load organizations.'));
      })
      .finally(() => {
        if (active && currentRequest === requestId.current) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [fetchOrganizations]);

  async function createOrganization(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setFormError(null);
    setSuccess(null);
    const data = new FormData(event.currentTarget);
    try {
      await organizationApi.createOrganization({
        name: String(data.get('name') ?? '').trim(),
        code: String(data.get('code') ?? '').trim(),
        description: String(data.get('description') ?? '').trim(),
        sortOrder: Number(data.get('sortOrder') ?? 0),
        ...(String(data.get('timezone') ?? '').trim()
          ? { timezone: String(data.get('timezone')).trim() }
          : {}),
      });
      setFormOpen(false);
      setSuccess('Organization created.');
      await loadOrganizations();
    } catch (cause) {
      setFormError(organizationErrorMessage(cause, 'Unable to create organization.'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Admin"
        title="Organizations"
        description="Choose an organization to manage its structure, or create a new organization."
      >
        {canCreate && (
          <button
            type="button"
            onClick={() => {
              setFormOpen((open) => !open);
              setFormError(null);
            }}
            className="rounded-lg bg-indigo-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-800"
          >
            {formOpen ? 'Cancel' : 'New organization'}
          </button>
        )}
      </PageHeader>

      {/* Batch 10A: anything the caller adds (e.g. the roles shortcut) follows the page heading. */}
      {intro && <div className="mt-6">{intro}</div>}

      <section className="mt-8 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-slate-950">Organization directory</h2>
          <ArchivedToggle
            checked={includeArchived}
            onChange={(checked) => {
              setLoading(true);
              setIncludeArchived(checked);
            }}
          />
        </div>
        {success && <FeedbackMessage>{success}</FeedbackMessage>}
        {error && <ErrorBanner>{error}</ErrorBanner>}
        {formOpen && canCreate && (
          <form
            onSubmit={(event) => void createOrganization(event)}
            className="grid grid-cols-1 gap-4 rounded-xl border border-slate-200 bg-white p-5 sm:grid-cols-2"
          >
            <h3 className="text-lg font-semibold sm:col-span-2">Create organization</h3>
            {formError && (
              <div className="sm:col-span-2">
                <ErrorBanner>{formError}</ErrorBanner>
              </div>
            )}
            <label className="text-sm font-medium text-slate-700">
              Name
              <input
                name="name"
                required
                maxLength={200}
                className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2"
              />
            </label>
            <label className="text-sm font-medium text-slate-700">
              Code
              <input
                name="code"
                required
                minLength={2}
                maxLength={64}
                className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 uppercase"
              />
            </label>
            <label className="text-sm font-medium text-slate-700 sm:col-span-2">
              Description
              <textarea
                name="description"
                rows={3}
                maxLength={2000}
                className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2"
              />
            </label>
            <label className="text-sm font-medium text-slate-700">
              Sort order
              <input
                name="sortOrder"
                type="number"
                min={0}
                step={1}
                defaultValue={0}
                className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2"
              />
            </label>
            <label className="text-sm font-medium text-slate-700">
              Timezone (IANA)
              <input
                name="timezone"
                maxLength={200}
                placeholder="America/Toronto"
                className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2"
              />
            </label>
            <div className="flex items-end justify-end">
              <button
                type="submit"
                disabled={saving}
                className="rounded-lg bg-indigo-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
              >
                {saving ? 'Creating…' : 'Create organization'}
              </button>
            </div>
          </form>
        )}
        {loading ? (
          <LoadingState />
        ) : organizations.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center">
            <p className="font-medium text-slate-900">No organizations found</p>
            <p className="mt-1 text-sm text-slate-600">
              {includeArchived
                ? 'Create an organization to begin managing its structure.'
                : 'There are no active organizations yet.'}
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white">
            {organizations.map((organization) => (
              <li
                key={organization.id}
                className={`flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between ${organization.archivedAt ? 'bg-slate-50' : ''}`}
              >
                <div>
                  <Link
                    href={`/admin/organizations/${organization.id}`}
                    className="font-semibold text-indigo-800 hover:underline"
                  >
                    {organization.name}
                  </Link>
                  <p className="mt-1 font-mono text-xs text-slate-500">{organization.code}</p>
                  {organization.description && (
                    <p className="mt-2 text-sm text-slate-600">{organization.description}</p>
                  )}
                </div>
                <div className="flex items-center gap-3">
                  <StatusBadge archived={Boolean(organization.archivedAt)} />
                  <Link
                    href={`/admin/organizations/${organization.id}`}
                    aria-label={`Open ${organization.name}`}
                    className="rounded-md border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
                  >
                    Open
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </PageContainer>
  );
}
