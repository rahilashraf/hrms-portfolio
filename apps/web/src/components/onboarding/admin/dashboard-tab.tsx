'use client';

import { checkboxClass } from '../../ui/tokens';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { useCallback, useState } from 'react';
import { onboardingApi } from '../../../lib/onboarding/api';
import type { WorkflowDashboard, WorkflowKind } from '../../../lib/onboarding/types';
import {
  EmptyState,
  formatDateOnly,
  KIND_LABELS,
  label,
  OWNER_TYPE_LABELS,
  WorkflowStatusBadge,
} from '../onboarding-shared';
import { Loading, useData } from './admin-shared';
import { DataTable } from '../../ui/data-table';

// Batch 10E-1: moved from onboarding-admin-page.tsx unchanged.
export const workflowLink = (workflowId: string, text: string) => (
  <Link className="text-indigo-700 underline" href={`/onboarding/workflows/${workflowId}`}>
    {text}
  </Link>
);

function AttentionList({
  title,
  count,
  children,
  note,
}: {
  title: string;
  count: number;
  children: ReactNode;
  note?: string;
}) {
  return (
    <section
      aria-label={title}
      className="space-y-2 rounded-xl border border-slate-200 bg-white p-4"
    >
      <h3 className="text-sm font-semibold text-slate-900">
        {title} ({count})
      </h3>
      {note && <p className="text-xs text-slate-600">{note}</p>}
      {count === 0 ? (
        <p className="text-sm text-slate-500">Nothing here.</p>
      ) : (
        <ul className="space-y-1 text-sm text-slate-800">{children}</ul>
      )}
    </section>
  );
}

export function DashboardTab({
  organizationId,
  kind,
  onError,
}: {
  organizationId: string;
  kind: WorkflowKind;
  onError(message: string): void;
}) {
  const [includeClosed, setIncludeClosed] = useState(false);
  const load = useCallback(
    () => onboardingApi.dashboard(organizationId, kind, includeClosed),
    [organizationId, kind, includeClosed],
  );
  const { data, loaded } = useData<WorkflowDashboard>(load, onError);
  const offboarding = kind === 'OFFBOARDING';
  const name = KIND_LABELS[kind].toLowerCase();
  return (
    <div className="space-y-4">
      <label className="inline-flex items-center gap-2 text-sm text-slate-700">
        <input
          type="checkbox"
          checked={includeClosed}
          onChange={(event) => setIncludeClosed(event.currentTarget.checked)}
          className={checkboxClass}
        />
        Include completed and cancelled
      </label>
      {!loaded ? (
        <Loading />
      ) : !data ? (
        <EmptyState>The {name} dashboard is unavailable.</EmptyState>
      ) : (
        <>
          {data.truncated && (
            <p role="note" className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-950">
              Showing the first {data.items.length} {name} workflows by date. More are within your
              access: clear “Include completed and cancelled” or open an employee&apos;s profile to
              find one.
            </p>
          )}
          {data.items.length === 0 ? (
            <EmptyState>No {name} workflows.</EmptyState>
          ) : (
            <DataTable
              label={`${KIND_LABELS[kind]} workflows`}
              minWidth="min-w-[760px]"
              rows={data.items}
              rowKey={(item) => item.id}
              columns={[
                {
                  key: 'employee',
                  header: 'Employee',
                  rowHeader: true,
                  cell: (item) => (
                    <>
                      {item.employee.displayName ?? '—'}
                      <span className="block text-xs font-normal text-slate-500">
                        {item.employee.employeeNumber} · {item.templateName}
                      </span>
                    </>
                  ),
                },
                {
                  key: 'position',
                  header: 'Position',
                  cell: (item) => <>{item.position.name}</>,
                },
                {
                  key: 'date',
                  header: offboarding ? 'Last day' : 'Start date',
                  cell: (item) => (
                    <>{formatDateOnly(offboarding ? item.plannedEndDate : item.anchorDate)}</>
                  ),
                },
                {
                  key: 'status',
                  header: 'Status',
                  cell: (item) => (
                    <>
                      <WorkflowStatusBadge status={item.status} />
                      {offboarding && (
                        <span className="block text-xs font-normal text-slate-500">
                          Assignment {label(item.assignmentStatus).toLowerCase()}
                        </span>
                      )}
                    </>
                  ),
                },
                {
                  key: 'progress',
                  header: 'Progress',
                  cell: (item) => (
                    <>
                      {item.progress.percent}%
                      <span className="block text-xs font-normal text-slate-500">
                        {item.progress.done} / {item.progress.total}
                      </span>
                    </>
                  ),
                },
                {
                  key: 'overdue',
                  header: 'Overdue',
                  cell: (item) => (
                    <>
                      {item.progress.overdue > 0 ? (
                        <span className="text-rose-800">{item.progress.overdue}</span>
                      ) : (
                        0
                      )}
                    </>
                  ),
                },
                {
                  key: 'open',
                  header: <span className="sr-only">Actions</span>,
                  cell: (item) => (
                    <>{workflowLink(item.id, `Open ${item.employee.displayName ?? 'workflow'}`)}</>
                  ),
                },
              ]}
            />
          )}
          <h2 className="text-base font-semibold text-slate-900">Needs attention</h2>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <AttentionList title="Overdue tasks" count={data.attention.overdueTasks.length}>
              {data.attention.overdueTasks.map((item) => (
                <li key={item.taskId}>
                  {workflowLink(item.workflowId, `${item.employee ?? 'Employee'} — ${item.title}`)}{' '}
                  <span className="text-xs text-rose-800">
                    due {formatDateOnly(item.dueDate)} · {OWNER_TYPE_LABELS[item.ownerType]}
                    {item.owner ? ` (${item.owner})` : ''}
                  </span>
                </li>
              ))}
            </AttentionList>
            <AttentionList
              title="Unassigned tasks"
              count={data.attention.unassignedTasks.length}
              note="Tasks whose owner could not be resolved (no manager, or no user account)."
            >
              {data.attention.unassignedTasks.map((item) => (
                <li key={item.taskId}>
                  {workflowLink(item.workflowId, `${item.employee ?? 'Employee'} — ${item.title}`)}{' '}
                  <span className="text-xs text-amber-800">
                    {OWNER_TYPE_LABELS[item.ownerType]} task
                  </span>
                </li>
              ))}
            </AttentionList>
            <AttentionList
              title={offboarding ? 'Upcoming last days' : 'Upcoming starts'}
              count={data.attention.upcoming.length}
            >
              {data.attention.upcoming.map((item) => (
                <li key={item.workflowId}>
                  {workflowLink(item.workflowId, item.employee ?? 'Employee')}{' '}
                  <span className="text-xs text-slate-500">{formatDateOnly(item.anchorDate)}</span>
                </li>
              ))}
            </AttentionList>
            {offboarding && (
              <AttentionList
                title="Awaiting Core HR"
                count={data.attention.coreHrPending.length}
                note="The planned last day has passed but Core HR has not ended the assignment yet. Offboarding never ends employment: end the assignment or terminate the employee in Core HR."
              >
                {data.attention.coreHrPending.map((item) => (
                  <li key={item.workflowId}>
                    {workflowLink(item.workflowId, item.employee ?? 'Employee')}{' '}
                    <span className="text-xs text-amber-800">
                      last day {formatDateOnly(item.plannedEndDate)}
                    </span>
                  </li>
                ))}
              </AttentionList>
            )}
          </div>
        </>
      )}
    </div>
  );
}
