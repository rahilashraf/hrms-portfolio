'use client';

import type { FormEvent } from 'react';
import { useCallback, useState } from 'react';
import { ErrorBanner, FeedbackMessage } from '../organization/shared';
import { leaveApi } from '../../lib/leave/api';
import { formatDateOnly, label, todayIso } from '../../lib/leave/format';
import type { Holiday, HolidayKind, LeaveOrganization } from '../../lib/leave/types';
import {
  dangerButton,
  EmptyState,
  inputClass,
  Panel,
  primaryButton,
  secondaryButton,
} from './leave-shared';
import { useConfirm } from '../ui/use-confirm';
import { DataTable } from '../ui/data-table';
import { usePanel, useStructure, value } from './leave-config-shared';

// ─── Holiday calendar ─────────────────────────────────────────────────────────

export function HolidaysPanel({ organization }: { organization: LeaveOrganization }) {
  const [year, setYear] = useState(() => Number(todayIso().slice(0, 4)));
  const loader = useCallback(
    () =>
      leaveApi
        .holidays({ organizationId: organization.id, from: `${year}-01-01`, to: `${year}-12-31` })
        .then((r) => r.items),
    [organization.id, year],
  );
  const { data, error, success, busy, mutate } = usePanel(loader);
  const structure = useStructure(organization.id);
  const [scope, setScope] = useState<
    'ORGANIZATION' | 'ORGANIZATIONAL_UNIT' | 'DEPARTMENT' | 'TEAM'
  >('ORGANIZATION');
  const [renaming, setRenaming] = useState<Holiday | null>(null);
  const [confirm, confirmDialog] = useConfirm();
  const canManage = organization.actions.canManageHolidays;
  const organizationLevel = organization.actions.canManageOrganizationHolidays;

  const scopeName = (holiday: Holiday) => {
    if (holiday.teamId)
      return `Team: ${structure.teams.find((t) => t.id === holiday.teamId)?.name ?? holiday.teamId}`;
    if (holiday.departmentId)
      return `Department: ${structure.departments.find((d) => d.id === holiday.departmentId)?.name ?? holiday.departmentId}`;
    if (holiday.organizationalUnitId)
      return `Unit: ${structure.units.find((u) => u.id === holiday.organizationalUnitId)?.name ?? holiday.organizationalUnitId}`;
    return 'Organization-wide';
  };

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    // Organization-level managers pick any scope; scoped managers pick one of their own.
    const [chosenScope, target] = organizationLevel
      ? [scope, value(data, 'scopeTarget')]
      : (value(data, 'grantedScope').split(':') as [typeof scope, string]);
    const ok = await mutate(
      'create',
      () =>
        leaveApi.createHoliday({
          organizationId: organization.id,
          date: value(data, 'date'),
          name: value(data, 'name'),
          kind: value(data, 'kind') as HolidayKind,
          ...(chosenScope === 'ORGANIZATIONAL_UNIT' ? { organizationalUnitId: target } : {}),
          ...(chosenScope === 'DEPARTMENT' ? { departmentId: target } : {}),
          ...(chosenScope === 'TEAM' ? { teamId: target } : {}),
        }),
      'Holiday added.',
    );
    if (ok) form.reset();
  }

  const targets =
    scope === 'ORGANIZATIONAL_UNIT'
      ? structure.units
      : scope === 'DEPARTMENT'
        ? structure.departments
        : scope === 'TEAM'
          ? structure.teams
          : [];

  return (
    <div className="space-y-6">
      {confirmDialog}
      {error && <ErrorBanner>{error}</ErrorBanner>}
      {success && <FeedbackMessage>{success}</FeedbackMessage>}
      <Panel
        title="Holiday calendar"
        actions={
          <label className="text-sm font-medium text-slate-700">
            Year
            <input
              type="number"
              min={2000}
              max={2100}
              value={year}
              onChange={(event) => setYear(Number(event.target.value) || year)}
              className={inputClass}
            />
          </label>
        }
      >
        {!data ? (
          <p role="status" className="text-sm text-slate-600">
            Loading holidays…
          </p>
        ) : data.length === 0 ? (
          <EmptyState>No holidays in {year}.</EmptyState>
        ) : (
          // Batch 10B: the shared DataTable (a named, keyboard-scrollable region; the
          // holiday's name heads its row). Actions still follow the API's action flags.
          <DataTable
            bare
            label={`Holidays in ${year}`}
            minWidth="min-w-[640px]"
            rows={data}
            rowKey={(holiday) => holiday.id}
            columns={[
              { key: 'date', header: 'Date', cell: (holiday) => formatDateOnly(holiday.date) },
              { key: 'name', header: 'Name', rowHeader: true, cell: (holiday) => holiday.name },
              { key: 'kind', header: 'Kind', cell: (holiday) => label(holiday.kind) },
              { key: 'scope', header: 'Applies to', cell: (holiday) => scopeName(holiday) },
              {
                key: 'actions',
                header: 'Actions',
                cell: (holiday) => (
                  <div className="flex gap-2">
                    {holiday.actions?.canEdit && (
                      <button
                        type="button"
                        className={secondaryButton}
                        aria-label={`Edit ${holiday.name}`}
                        onClick={() => setRenaming(holiday)}
                      >
                        Edit
                      </button>
                    )}
                    {holiday.actions?.canArchive && (
                      <button
                        type="button"
                        className={dangerButton}
                        disabled={busy === `archive-${holiday.id}`}
                        onClick={async () => {
                          if (
                            await confirm({
                              title: `Remove ${holiday.name}?`,
                              description: 'Leave already approved keeps its frozen amounts.',
                              confirmLabel: 'Remove holiday',
                            })
                          ) {
                            void mutate(
                              `archive-${holiday.id}`,
                              () => leaveApi.archiveHoliday(holiday.id),
                              'Holiday removed.',
                            );
                          }
                        }}
                      >
                        Remove
                      </button>
                    )}
                  </div>
                ),
              },
            ]}
          />
        )}
      </Panel>
      {renaming && (
        <form
          className="grid grid-cols-1 gap-3 rounded-xl border border-slate-200 bg-white p-5 sm:grid-cols-4 sm:items-end"
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            void mutate(
              'update',
              () =>
                leaveApi.updateHoliday(renaming.id, {
                  name: value(data, 'name'),
                  date: value(data, 'date'),
                  kind: value(data, 'kind') as HolidayKind,
                }),
              'Holiday updated.',
            ).then((ok) => ok && setRenaming(null));
          }}
        >
          <label className="text-sm font-medium text-slate-700">
            Date
            <input
              name="date"
              type="date"
              required
              defaultValue={renaming.date}
              className={inputClass}
            />
          </label>
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
            Kind
            <select name="kind" defaultValue={renaming.kind} className={inputClass}>
              <option value="STATUTORY_HOLIDAY">Statutory holiday</option>
              <option value="CLOSURE">Closure</option>
            </select>
          </label>
          <div className="flex gap-2">
            <button type="submit" disabled={busy === 'update'} className={primaryButton}>
              Save
            </button>
            <button type="button" className={secondaryButton} onClick={() => setRenaming(null)}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {canManage && (
        <Panel title="Add holiday">
          <form
            className="grid grid-cols-1 gap-4 sm:grid-cols-3"
            onSubmit={(event) => void create(event)}
          >
            <label className="text-sm font-medium text-slate-700">
              Date
              <input name="date" type="date" required className={inputClass} />
            </label>
            <label className="text-sm font-medium text-slate-700">
              Name
              <input name="name" required maxLength={200} className={inputClass} />
            </label>
            <label className="text-sm font-medium text-slate-700">
              Kind
              <select name="kind" defaultValue="STATUTORY_HOLIDAY" className={inputClass}>
                <option value="STATUTORY_HOLIDAY">Statutory holiday</option>
                <option value="CLOSURE">Closure</option>
              </select>
            </label>
            {!organizationLevel && (
              <label className="text-sm font-medium text-slate-700">
                Applies to
                <select name="grantedScope" required className={inputClass}>
                  {organization.holidayScopes.map((granted) => (
                    <option key={granted.id} value={`${granted.type}:${granted.id}`}>
                      {label(granted.type)}: {granted.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {organizationLevel && (
              <label className="text-sm font-medium text-slate-700">
                Applies to
                <select
                  value={scope}
                  onChange={(event) => setScope(event.target.value as typeof scope)}
                  className={inputClass}
                >
                  <option value="ORGANIZATION">Whole organization</option>
                  <option value="ORGANIZATIONAL_UNIT">A unit</option>
                  <option value="DEPARTMENT">A department</option>
                  <option value="TEAM">A team</option>
                </select>
              </label>
            )}
            {organizationLevel && scope !== 'ORGANIZATION' && (
              <label className="text-sm font-medium text-slate-700">
                {label(scope)}
                <select name="scopeTarget" required className={inputClass}>
                  <option value="">Select…</option>
                  {targets.map((target) => (
                    <option key={target.id} value={target.id}>
                      {target.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <div className="flex items-end sm:col-span-3">
              <button type="submit" disabled={busy === 'create'} className={primaryButton}>
                Add holiday
              </button>
            </div>
          </form>
        </Panel>
      )}
    </div>
  );
}
