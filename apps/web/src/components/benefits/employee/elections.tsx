'use client';

import type { Election } from '../../../lib/benefits/types';
import { EmptyState } from '../../payroll/payroll-shared';
import { secondaryButton } from '../../ui/tokens';
import { costText, coveragePeriod, ElectionStatusBadge, FlagList } from '../benefits-shared';
import { fullName } from './shared';
import { DataTable } from '../../ui/data-table';

export type ElectionAction = 'change' | 'remove' | 'transfer' | 'correct' | 'end' | 'rescind';

/** The actions offered for an election — strictly what its API flags allow. */
function actionsOf(election: Election) {
  const flags = election.actions;
  if (!flags) return [];
  const plan = election.plan.name;
  const list: Array<{ action: ElectionAction; text: string; label: string }> = [];
  if (flags.canChange)
    list.push({ action: 'change', text: 'Change', label: `Change coverage for ${plan}` });
  if (flags.canChange && election.dependents.length > 0)
    list.push({
      action: 'remove',
      text: 'Remove dependent',
      label: `Remove a dependent from ${plan}`,
    });
  if (flags.canTransfer)
    list.push({
      action: 'transfer',
      text: 'Transfer',
      label: `Move ${plan} to another assignment`,
    });
  if (flags.canCorrect)
    list.push({ action: 'correct', text: 'Correct', label: `Correct ${plan} election` });
  if (flags.canEnd) list.push({ action: 'end', text: 'End', label: `End ${plan} coverage` });
  if (flags.canRescind)
    list.push({ action: 'rescind', text: 'Rescind', label: `Rescind ${plan} election` });
  return list;
}

/** HR notes, shown only when the API shares them (benefits administrators). */
function HrNotes({ election }: { election: Election }) {
  const notes = [
    election.reason ? `Reason: ${election.reason}` : null,
    election.eligibilityOverrideReason
      ? `Eligibility override: ${election.eligibilityOverrideReason}`
      : null,
    election.endReason ? `Ended: ${election.endReason}` : null,
  ].filter(Boolean);
  if (notes.length === 0) return null;
  return (
    <ul className="mt-1 space-y-0.5 text-xs text-slate-600" aria-label="HR notes">
      {notes.map((note) => (
        <li key={note}>{note}</li>
      ))}
    </ul>
  );
}

export function ElectionsTable({
  items,
  busy,
  onAction,
}: {
  items: Election[];
  busy: boolean;
  onAction(action: ElectionAction, election: Election): void;
}) {
  if (items.length === 0)
    return <EmptyState>No benefit elections are recorded for this employee.</EmptyState>;
  return (
    <DataTable
      label="Benefit elections"
      minWidth="min-w-[880px]"
      rows={items}
      rowKey={(item) => item.id}
      columns={[
        {
          key: 'plan',
          header: 'Plan',
          rowHeader: true,
          cell: (item) => (
            <>
              {item.plan.name}
              <FlagList flags={item.flags ?? []} />
              <HrNotes election={item} />
            </>
          ),
        },
        {
          key: 'coverage',
          header: 'Coverage',
          cell: (item) => (
            <>
              {item.option?.name ?? 'Waived'}
              {item.dependents.length > 0 && (
                <span className="block text-xs text-slate-500">
                  {item.dependents.map(fullName).join(', ')}
                </span>
              )}
            </>
          ),
        },
        {
          key: 'status',
          header: 'Status',
          cell: (item) => (
            <>
              <ElectionStatusBadge status={item.status} />
            </>
          ),
        },
        {
          key: 'period',
          header: 'Period',
          cell: (item) => <>{coveragePeriod(item.coverageStart, item.coverageEnd)}</>,
        },
        {
          key: 'cost',
          header: 'Cost',
          cell: (item) => <>{costText(item.cost)}</>,
        },
        {
          key: 'sponsor',
          header: 'Sponsor',
          cell: (item) => <>{item.sponsoringAssignment.positionName}</>,
        },
        {
          key: 'actions',
          header: 'Actions',
          cell: (item) => (
            <>
              <div className="flex flex-wrap gap-1">
                {actionsOf(item).map((entry) => (
                  <button
                    key={entry.action}
                    type="button"
                    className={secondaryButton}
                    disabled={busy}
                    aria-label={entry.label}
                    onClick={() => onAction(entry.action, item)}
                  >
                    {entry.text}
                  </button>
                ))}
              </div>
            </>
          ),
        },
      ]}
    />
  );
}

export function ElectionHistory({ items }: { items: Election[] }) {
  if (items.length === 0) return null;
  return (
    <details className="text-sm text-slate-700">
      <summary className="cursor-pointer font-medium">
        Corrected and rescinded records ({items.length})
      </summary>
      <ul className="mt-2 space-y-1">
        {items.map((item) => (
          <li key={item.id}>
            {item.plan.name} · {item.option?.name ?? 'Waived'} ·{' '}
            {coveragePeriod(item.coverageStart, item.coverageEnd)}
            {item.supersessionReason ? ` — ${item.supersessionReason}` : ''}
          </li>
        ))}
      </ul>
    </details>
  );
}
