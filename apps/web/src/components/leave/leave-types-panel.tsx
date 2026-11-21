'use client';

import { checkboxClass } from '../ui/tokens';

import type { FormEvent } from 'react';
import { useCallback, useState } from 'react';
import { ErrorBanner, FeedbackMessage } from '../organization/shared';
import { leaveApi } from '../../lib/leave/api';
import { label } from '../../lib/leave/format';
import type {
  LeaveClassification,
  LeaveDisplayUnit,
  LeaveOrganization,
  LeaveType,
} from '../../lib/leave/types';
import {
  dangerButton,
  EmptyState,
  inputClass,
  Panel,
  primaryButton,
  secondaryButton,
} from './leave-shared';
import { useConfirm } from '../ui/use-confirm';
import { TableScroll } from '../ui/states';
import { usePanel, value } from './leave-config-shared';

// ─── Leave types ──────────────────────────────────────────────────────────────

export function LeaveTypesPanel({ organization }: { organization: LeaveOrganization }) {
  const loader = useCallback(
    () => leaveApi.types(organization.id, true).then((r) => r.items),
    [organization.id],
  );
  const { data, error, success, busy, mutate } = usePanel(loader);
  const [renaming, setRenaming] = useState<LeaveType | null>(null);
  const [confirm, confirmDialog] = useConfirm();
  const canManage = organization.actions.canManageTypes;

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const ok = await mutate(
      'create',
      () =>
        leaveApi.createType({
          organizationId: organization.id,
          code: value(data, 'code'),
          name: value(data, 'name'),
          classification: value(data, 'classification') as LeaveClassification,
          tracksBalance: data.get('tracksBalance') === 'on',
          displayUnit: value(data, 'displayUnit') as LeaveDisplayUnit,
          ...(value(data, 'description') ? { description: value(data, 'description') } : {}),
        }),
      'Leave type created.',
    );
    if (ok) form.reset();
  }

  return (
    <div className="space-y-6">
      {confirmDialog}
      {error && <ErrorBanner>{error}</ErrorBanner>}
      {success && <FeedbackMessage>{success}</FeedbackMessage>}
      <Panel title="Leave types">
        {!data ? (
          <p role="status" className="text-sm text-slate-600">
            Loading leave types…
          </p>
        ) : data.length === 0 ? (
          <EmptyState>No leave types yet.</EmptyState>
        ) : (
          <TableScroll bare label="Leave types">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead className="border-b border-slate-200 text-xs uppercase text-slate-500">
                <tr>
                  <th scope="col" className="px-3 py-2">
                    Code
                  </th>
                  <th scope="col" className="px-3 py-2">
                    Name
                  </th>
                  <th scope="col" className="px-3 py-2">
                    Classification
                  </th>
                  <th scope="col" className="px-3 py-2">
                    Balance
                  </th>
                  <th scope="col" className="px-3 py-2">
                    Status
                  </th>
                  <th scope="col" className="px-3 py-2">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.map((type) => (
                  <tr key={type.id}>
                    <td className="px-3 py-2 font-mono text-xs">{type.code}</td>
                    <td className="px-3 py-2">{type.name}</td>
                    <td className="px-3 py-2">{label(type.classification)}</td>
                    <td className="px-3 py-2">
                      {type.tracksBalance ? `Tracked (${label(type.displayUnit)})` : 'Untracked'}
                    </td>
                    <td className="px-3 py-2">{type.archivedAt ? 'Archived' : 'Active'}</td>
                    <td className="px-3 py-2">
                      <div className="flex gap-2">
                        {type.actions?.canEdit && (
                          <button
                            type="button"
                            className={secondaryButton}
                            aria-label={`Edit ${type.name}`}
                            onClick={() => setRenaming(type)}
                          >
                            Edit
                          </button>
                        )}
                        {type.actions?.canArchive && (
                          <button
                            type="button"
                            className={dangerButton}
                            disabled={busy === `archive-${type.id}`}
                            onClick={async () => {
                              if (
                                await confirm({
                                  title: `Archive ${type.name}?`,
                                  description: 'Existing requests and balances are kept.',
                                  confirmLabel: 'Archive leave type',
                                })
                              ) {
                                void mutate(
                                  `archive-${type.id}`,
                                  () => leaveApi.archiveType(type.id),
                                  'Leave type archived.',
                                );
                              }
                            }}
                          >
                            Archive
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}
      </Panel>
      {renaming && (
        // Batch 6B: every field the API lets change (name, description, display unit); code,
        // classification and balance tracking are fixed once requests and balances exist.
        <form
          key={renaming.id}
          aria-label={`Edit leave type ${renaming.code}`}
          className="grid grid-cols-1 gap-3 rounded-xl border border-slate-200 bg-white p-5 sm:grid-cols-3"
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            void mutate(
              'rename',
              () =>
                leaveApi.updateType(renaming.id, {
                  name: value(data, 'name'),
                  description: value(data, 'description'),
                  displayUnit: value(data, 'displayUnit') as LeaveDisplayUnit,
                }),
              'Leave type updated.',
            ).then((ok) => ok && setRenaming(null));
          }}
        >
          <label className="text-sm font-medium text-slate-700">
            Name
            <input
              name="name"
              required
              maxLength={200}
              defaultValue={renaming.name}
              className={inputClass}
            />
          </label>
          <label className="text-sm font-medium text-slate-700">
            Display unit
            <select name="displayUnit" defaultValue={renaming.displayUnit} className={inputClass}>
              <option value="HOURS">Hours</option>
              <option value="DAYS">Days</option>
            </select>
          </label>
          <label className="text-sm font-medium text-slate-700 sm:col-span-3">
            Description
            <textarea
              name="description"
              maxLength={2000}
              rows={2}
              defaultValue={renaming.description ?? ''}
              className={inputClass}
            />
          </label>
          <p className="text-sm text-slate-600 sm:col-span-3">
            Code {renaming.code}, {label(renaming.classification).toLowerCase()},{' '}
            {renaming.tracksBalance ? 'balance tracked' : 'balance not tracked'}: these stay fixed
            because existing requests and balances depend on them.
          </p>
          <div className="flex gap-2 sm:col-span-3">
            <button type="submit" disabled={busy === 'rename'} className={primaryButton}>
              Save
            </button>
            <button type="button" className={secondaryButton} onClick={() => setRenaming(null)}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {canManage && (
        <Panel title="New leave type">
          <form
            className="grid grid-cols-1 gap-4 sm:grid-cols-3"
            onSubmit={(event) => void create(event)}
          >
            <label className="text-sm font-medium text-slate-700">
              Code
              <input
                name="code"
                required
                minLength={2}
                maxLength={64}
                className={`${inputClass} uppercase`}
              />
            </label>
            <label className="text-sm font-medium text-slate-700 sm:col-span-2">
              Name
              <input name="name" required maxLength={200} className={inputClass} />
            </label>
            <label className="text-sm font-medium text-slate-700">
              Classification
              <select name="classification" defaultValue="PAID" className={inputClass}>
                <option value="PAID">Paid</option>
                <option value="UNPAID">Unpaid</option>
              </select>
            </label>
            <label className="text-sm font-medium text-slate-700">
              Display unit
              <select name="displayUnit" defaultValue="HOURS" className={inputClass}>
                <option value="HOURS">Hours</option>
                <option value="DAYS">Days</option>
              </select>
            </label>
            <label className="flex items-end gap-2 pb-2 text-sm font-medium text-slate-700">
              <input
                name="tracksBalance"
                type="checkbox"
                className={checkboxClass}
                defaultChecked
              />
              Tracks a balance
            </label>
            <label className="text-sm font-medium text-slate-700 sm:col-span-3">
              Description
              <input name="description" maxLength={2000} className={inputClass} />
            </label>
            <div className="sm:col-span-3">
              <button type="submit" disabled={busy === 'create'} className={primaryButton}>
                Create leave type
              </button>
            </div>
          </form>
        </Panel>
      )}
    </div>
  );
}
