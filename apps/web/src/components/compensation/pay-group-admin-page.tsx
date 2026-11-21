'use client';

import type { FormEvent } from 'react';
import { useCallback, useEffect, useState } from 'react';
import {
  PageHeader,
  ArchivedToggle,
  ErrorBanner,
  FeedbackMessage,
  StatusBadge,
} from '../organization/shared';
import { compensationApi } from '../../lib/compensation/api';
import { compensationErrorMessage } from '../../lib/compensation/errors';
import type { PayGroup, PayGroupOrganization } from '../../lib/compensation/types';
import { EmptyState, inputClass, primaryButton, secondaryButton } from './compensation-shared';
import { useConfirm } from '../ui/use-confirm';
import { PageContainer } from '../ui/page-container';
import { RequirePermission } from '../ui/require-permission';

export function PayGroupAdminPage() {
  // Batch 10B: the shared gate (loading and denied in the page's own width).
  return (
    <RequirePermission
      anyOf={['compensation.read', 'compensation.manage']}
      deniedMessage="You do not have permission to view pay groups."
    >
      <PayGroupAdmin />
    </RequirePermission>
  );
}

function PayGroupAdmin() {
  const [organizations, setOrganizations] = useState<PayGroupOrganization[]>([]);
  const [organizationId, setOrganizationId] = useState('');
  const [groups, setGroups] = useState<PayGroup[]>([]);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<PayGroup | null>(null);
  const [confirm, confirmDialog] = useConfirm();

  useEffect(() => {
    const timer = window.setTimeout(() => {
      compensationApi
        .payGroupOrganizations()
        .then((result) => {
          setOrganizations(result.items);
          setOrganizationId((current) => current || result.items[0]?.id || '');
          if (result.items.length === 0) setLoading(false);
        })
        .catch((cause) => {
          setError(compensationErrorMessage(cause, 'Unable to load organizations.'));
          setLoading(false);
        });
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const loadGroups = useCallback(async () => {
    if (!organizationId) return;
    try {
      setGroups((await compensationApi.payGroups(organizationId, includeArchived)).items);
      setError(null);
    } catch (cause) {
      setError(compensationErrorMessage(cause, 'Unable to load pay groups.'));
    } finally {
      setLoading(false);
    }
  }, [organizationId, includeArchived]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadGroups(), 0);
    return () => window.clearTimeout(timer);
  }, [loadGroups]);

  const organization = organizations.find((o) => o.id === organizationId);

  async function mutate(run: () => Promise<unknown>, message: string) {
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      await run();
      setSuccess(message);
      setEditing(null);
      await loadGroups();
      return true;
    } catch (cause) {
      setError(compensationErrorMessage(cause, 'Unable to save the pay group.'));
      return false;
    } finally {
      setBusy(false);
    }
  }

  return (
    <PageContainer>
      {confirmDialog}
      <PageHeader
        eyebrow="Compensation"
        title="Pay groups"
        description="Named payroll groupings that compensation records point to. Archiving keeps existing records intact."
      >
        {organizations.length > 1 && (
          <label className="text-sm font-medium text-slate-800" htmlFor="pay-group-organization">
            Organization
            <select
              id="pay-group-organization"
              className={inputClass}
              value={organizationId}
              onChange={(event) => setOrganizationId(event.currentTarget.value)}
            >
              {organizations.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </PageHeader>
      <div className="mt-8 space-y-4">
        {error && <ErrorBanner>{error}</ErrorBanner>}
        {success && <FeedbackMessage>{success}</FeedbackMessage>}
        {loading ? (
          <p role="status" className="text-sm text-slate-600">
            Loading pay groups…
          </p>
        ) : organizations.length === 0 ? (
          <EmptyState>No organizations are within your compensation access.</EmptyState>
        ) : (
          <>
            {organization?.canManagePayGroups && (
              <PayGroupCreateForm
                busy={busy}
                onSubmit={(input) =>
                  mutate(
                    () => compensationApi.createPayGroup({ organizationId, ...input }),
                    'Pay group created.',
                  )
                }
              />
            )}
            <div className="flex justify-end">
              <ArchivedToggle checked={includeArchived} onChange={setIncludeArchived} />
            </div>
            {groups.length === 0 ? (
              <EmptyState>No pay groups yet.</EmptyState>
            ) : (
              <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white">
                {groups.map((group) => (
                  <li key={group.id} className="space-y-3 p-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <p className="font-medium text-slate-900">
                          {group.name}{' '}
                          <span className="text-sm text-slate-500">({group.code})</span>
                        </p>
                        {group.description && (
                          <p className="text-sm text-slate-600">{group.description}</p>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        <StatusBadge archived={Boolean(group.archivedAt)} />
                        {group.actions.canEdit && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => setEditing(group)}
                            aria-label={`Edit ${group.name}`}
                            className={secondaryButton}
                          >
                            Edit
                          </button>
                        )}
                        {group.actions.canArchive && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={async () => {
                              if (
                                await confirm({
                                  title: `Archive pay group ${group.name}?`,
                                  description: 'Existing compensation keeps it.',
                                  confirmLabel: 'Archive pay group',
                                })
                              ) {
                                void mutate(
                                  () => compensationApi.archivePayGroup(group.id),
                                  'Pay group archived.',
                                );
                              }
                            }}
                            className={secondaryButton}
                          >
                            Archive
                          </button>
                        )}
                      </div>
                    </div>
                    {editing?.id === group.id && (
                      <PayGroupEditForm
                        group={group}
                        busy={busy}
                        onCancel={() => setEditing(null)}
                        onSubmit={(input) =>
                          mutate(
                            () => compensationApi.updatePayGroup(group.id, input),
                            'Pay group updated.',
                          )
                        }
                      />
                    )}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </PageContainer>
  );
}

function PayGroupCreateForm({
  busy,
  onSubmit,
}: {
  busy: boolean;
  onSubmit(input: { code: string; name: string; description?: string }): Promise<boolean>;
}) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const saved = await onSubmit({
      code: code.trim(),
      name: name.trim(),
      ...(description.trim() ? { description: description.trim() } : {}),
    });
    if (saved) {
      setCode('');
      setName('');
      setDescription('');
    }
  }

  return (
    <form
      onSubmit={submit}
      aria-label="New pay group"
      className="grid grid-cols-1 gap-3 rounded-xl border border-slate-200 bg-white p-4 sm:grid-cols-4"
    >
      <label className="text-sm font-medium text-slate-800" htmlFor="pay-group-code">
        Code
        <input
          id="pay-group-code"
          className={inputClass}
          required
          value={code}
          onChange={(e) => setCode(e.currentTarget.value)}
        />
      </label>
      <label className="text-sm font-medium text-slate-800" htmlFor="pay-group-name">
        Name
        <input
          id="pay-group-name"
          className={inputClass}
          required
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
        />
      </label>
      <label className="text-sm font-medium text-slate-800" htmlFor="pay-group-description">
        Description
        <input
          id="pay-group-description"
          className={inputClass}
          value={description}
          onChange={(e) => setDescription(e.currentTarget.value)}
        />
      </label>
      <div className="flex items-end">
        <button
          type="submit"
          disabled={busy || !code.trim() || !name.trim()}
          className={primaryButton}
        >
          Add pay group
        </button>
      </div>
    </form>
  );
}

function PayGroupEditForm({
  group,
  busy,
  onCancel,
  onSubmit,
}: {
  group: PayGroup;
  busy: boolean;
  onCancel(): void;
  onSubmit(input: { name: string; description: string }): Promise<boolean>;
}) {
  const [name, setName] = useState(group.name);
  const [description, setDescription] = useState(group.description ?? '');
  return (
    <form
      aria-label={`Edit pay group ${group.code}`}
      className="grid grid-cols-1 gap-3 sm:grid-cols-3"
      onSubmit={(event) => {
        event.preventDefault();
        void onSubmit({ name: name.trim(), description: description.trim() });
      }}
    >
      <label className="text-sm font-medium text-slate-800" htmlFor={`edit-name-${group.id}`}>
        Name
        <input
          id={`edit-name-${group.id}`}
          className={inputClass}
          required
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
        />
      </label>
      <label
        className="text-sm font-medium text-slate-800"
        htmlFor={`edit-description-${group.id}`}
      >
        Description
        <input
          id={`edit-description-${group.id}`}
          className={inputClass}
          value={description}
          onChange={(e) => setDescription(e.currentTarget.value)}
        />
      </label>
      <div className="flex items-end gap-2">
        <button type="submit" disabled={busy || !name.trim()} className={primaryButton}>
          Save
        </button>
        <button type="button" disabled={busy} onClick={onCancel} className={secondaryButton}>
          Cancel
        </button>
      </div>
    </form>
  );
}
