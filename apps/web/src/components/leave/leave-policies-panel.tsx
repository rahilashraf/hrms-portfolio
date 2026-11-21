'use client';

import { useCallback, useState } from 'react';
import { ErrorBanner, FeedbackMessage } from '../organization/shared';
import { leaveApi } from '../../lib/leave/api';
import { formatDateOnly, formatLeaveAmount, label, todayIso } from '../../lib/leave/format';
import type { LeaveOrganization, LeavePolicy } from '../../lib/leave/types';
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
import { usePanel, useStructure, value } from './leave-config-shared';
import { PolicyForm, settingsOf } from './leave-policy-form';

// ─── Leave policies ───────────────────────────────────────────────────────────

function scopeLabel(policy: LeavePolicy, structure: ReturnType<typeof useStructure>) {
  const name = (rows: Array<{ id: string; name: string }>, id: string | null) =>
    rows.find((r) => r.id === id)?.name ?? id;
  switch (policy.scopeType) {
    case 'ORGANIZATION':
      return 'Organization';
    case 'ORGANIZATIONAL_UNIT':
      return `Unit: ${name(structure.units, policy.organizationalUnitId)}`;
    case 'DEPARTMENT':
      return `Department: ${name(structure.departments, policy.departmentId)}`;
    case 'TEAM':
      return `Team: ${name(structure.teams, policy.teamId)}`;
    case 'EMPLOYMENT_ASSIGNMENT':
      return policy.assignment
        ? `Employee: ${policy.assignment.employeeName} (${policy.assignment.employeeNumber}) · ${policy.assignment.positionName}`
        : 'One employee assignment';
  }
}

function policySummary(policy: LeavePolicy) {
  if (!policy.eligible) return 'Not eligible';
  const parts = [];
  if (policy.accrualMethod === 'ANNUAL_GRANT')
    parts.push(`${formatLeaveAmount(policy.annualGrantMinutes)} per year`);
  if (policy.accrualMethod === 'PERIODIC') {
    parts.push(
      `${formatLeaveAmount(policy.accrualMinutesPerPeriod)} ${label(policy.accrualFrequency)}`,
    );
  }
  if (policy.accrualMethod === 'NONE') parts.push('No accrual');
  if (policy.carryoverMode === 'CAPPED')
    parts.push(`carryover ≤ ${formatLeaveAmount(policy.carryoverMaxMinutes)}`);
  if (policy.carryoverMode === 'NONE') parts.push('no carryover');
  if (policy.employmentTypes.length) parts.push(policy.employmentTypes.map(label).join('/'));
  return parts.join(' · ');
}

export function LeavePoliciesPanel({ organization }: { organization: LeaveOrganization }) {
  const loader = useCallback(
    () =>
      Promise.all([leaveApi.policies(organization.id), leaveApi.types(organization.id)]).then(
        ([p, t]) => ({ policies: p.items, types: t.items }),
      ),
    [organization.id],
  );
  const { data, error, success, busy, mutate } = usePanel(loader);
  const structure = useStructure(organization.id);
  const [editing, setEditing] = useState<LeavePolicy | 'new' | null>(null);
  const [ending, setEnding] = useState<LeavePolicy | null>(null);
  const [confirm, confirmDialog] = useConfirm();

  return (
    <div className="space-y-6">
      {confirmDialog}
      {error && <ErrorBanner>{error}</ErrorBanner>}
      {success && <FeedbackMessage>{success}</FeedbackMessage>}
      <Panel
        title="Leave policies"
        actions={
          organization.actions.canManagePolicies && (
            <button type="button" className={primaryButton} onClick={() => setEditing('new')}>
              New policy
            </button>
          )
        }
      >
        {!data ? (
          <p role="status" className="text-sm text-slate-600">
            Loading policies…
          </p>
        ) : data.policies.length === 0 ? (
          <EmptyState>No leave policies yet.</EmptyState>
        ) : (
          <TableScroll bare label="Leave policies">
            <table className="w-full min-w-[880px] text-left text-sm">
              <thead className="border-b border-slate-200 text-xs uppercase text-slate-500">
                <tr>
                  <th scope="col" className="px-3 py-2">
                    Leave type
                  </th>
                  <th scope="col" className="px-3 py-2">
                    Scope
                  </th>
                  <th scope="col" className="px-3 py-2">
                    Effective
                  </th>
                  <th scope="col" className="px-3 py-2">
                    Rules
                  </th>
                  <th scope="col" className="px-3 py-2">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.policies.map((policy) => (
                  <tr key={policy.id}>
                    <td className="px-3 py-2">
                      {policy.leaveType.name}
                      {policy.name && <div className="text-xs text-slate-500">{policy.name}</div>}
                    </td>
                    <td className="px-3 py-2">{scopeLabel(policy, structure)}</td>
                    <td className="px-3 py-2">
                      {formatDateOnly(policy.effectiveFrom)} –{' '}
                      {policy.effectiveTo ? formatDateOnly(policy.effectiveTo) : 'open'}
                    </td>
                    <td className="px-3 py-2 text-slate-700">{policySummary(policy)}</td>
                    <td className="px-3 py-2">
                      <div className="flex gap-2">
                        {policy.actions?.canEdit && (
                          <button
                            type="button"
                            className={secondaryButton}
                            aria-label={`Edit policy: ${policy.name || policy.leaveType.name}`}
                            onClick={() => setEditing(policy)}
                          >
                            Edit
                          </button>
                        )}
                        {policy.actions?.canEnd && (
                          <button
                            type="button"
                            className={secondaryButton}
                            onClick={() => setEnding(policy)}
                          >
                            End
                          </button>
                        )}
                        {policy.actions?.canDelete && (
                          <button
                            type="button"
                            className={dangerButton}
                            disabled={busy === `delete-${policy.id}`}
                            onClick={async () => {
                              if (
                                await confirm({
                                  title: 'Delete this policy?',
                                  description: 'It has not taken effect yet.',
                                  confirmLabel: 'Delete policy',
                                })
                              ) {
                                void mutate(
                                  `delete-${policy.id}`,
                                  () => leaveApi.deletePolicy(policy.id),
                                  'Policy deleted.',
                                );
                              }
                            }}
                          >
                            Delete
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
      {ending && (
        <form
          className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-5 sm:flex-row sm:items-end"
          onSubmit={(event) => {
            event.preventDefault();
            const effectiveTo = value(new FormData(event.currentTarget), 'effectiveTo');
            void mutate(
              'end',
              () => leaveApi.endPolicy(ending.id, effectiveTo),
              'Policy ended.',
            ).then((ok) => ok && setEnding(null));
          }}
        >
          <label className="flex-1 text-sm font-medium text-slate-700">
            Last day of the policy
            <input
              name="effectiveTo"
              type="date"
              required
              min={ending.effectiveFrom}
              defaultValue={todayIso()}
              className={inputClass}
            />
          </label>
          <button type="submit" disabled={busy === 'end'} className={primaryButton}>
            End policy
          </button>
          <button type="button" className={secondaryButton} onClick={() => setEnding(null)}>
            Cancel
          </button>
        </form>
      )}
      {editing && data && (
        <PolicyForm
          key={editing === 'new' ? 'new' : editing.id}
          organizationId={organization.id}
          policy={editing === 'new' ? null : editing}
          types={data.types}
          structure={structure}
          busy={busy === 'save'}
          onCancel={() => setEditing(null)}
          onSave={(input) =>
            mutate(
              'save',
              () =>
                editing === 'new'
                  ? leaveApi.createPolicy(input)
                  : leaveApi.updatePolicy(editing.id, settingsOf(input)),
              editing === 'new' ? 'Policy created.' : 'Policy updated.',
            ).then((ok) => ok && setEditing(null))
          }
        />
      )}
    </div>
  );
}
