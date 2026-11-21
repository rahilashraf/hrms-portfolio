'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ErrorBanner } from '../organization/shared';
import { onboardingApi } from '../../lib/onboarding/api';
import { isOnboardingForbidden, onboardingErrorMessage } from '../../lib/onboarding/errors';
import type { EmployeeWorkflowSummary } from '../../lib/onboarding/types';
import { EmptyState, formatDateOnly, KindBadge, WorkflowStatusBadge } from './onboarding-shared';
import { DataTable } from '../ui/data-table';

/**
 * The employee profile's onboarding & offboarding section, for onboarding.* / offboarding.*
 * holders only (never implied by employee access). The API lists only workflows within scope.
 */
export function EmployeeWorkflowsSection({ employeeId }: { employeeId: string }) {
  const [items, setItems] = useState<EmployeeWorkflowSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      onboardingApi
        .employeeWorkflows(employeeId)
        .then((result) => {
          if (active) setItems(result.items);
        })
        .catch((cause) => {
          if (!active) return;
          setForbidden(isOnboardingForbidden(cause));
          setError(onboardingErrorMessage(cause));
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [employeeId]);

  return (
    <section aria-labelledby="onboarding-heading" className="mt-8 space-y-4">
      <h2 id="onboarding-heading" className="text-xl font-semibold text-slate-950">
        Onboarding &amp; offboarding
      </h2>
      {loading ? (
        <p role="status" className="text-sm text-slate-600">
          Loading onboarding…
        </p>
      ) : forbidden ? (
        <EmptyState>You do not have access to this employee’s onboarding records.</EmptyState>
      ) : error ? (
        <ErrorBanner>{error}</ErrorBanner>
      ) : items.length === 0 ? (
        <EmptyState>No onboarding or offboarding workflows.</EmptyState>
      ) : (
        <DataTable
          label="Onboarding and offboarding workflows"
          rows={items}
          rowKey={(item) => item.id}
          columns={[
            {
              key: 'workflow',
              header: 'Workflow',
              rowHeader: true,
              cell: (item) => (
                <>
                  <KindBadge kind={item.kind} />
                  <span className="block text-xs font-normal text-slate-500">
                    {item.templateName}
                  </span>
                </>
              ),
            },
            {
              key: 'position',
              header: 'Position',
              cell: (item) => <>{item.positionName}</>,
            },
            {
              key: 'date',
              header: 'Date',
              cell: (item) => (
                <>
                  {item.kind === 'OFFBOARDING'
                    ? `Last day ${formatDateOnly(item.plannedEndDate)}`
                    : `Starts ${formatDateOnly(item.anchorDate)}`}
                </>
              ),
            },
            {
              key: 'status',
              header: 'Status',
              cell: (item) => (
                <>
                  <WorkflowStatusBadge status={item.status} />
                </>
              ),
            },
            {
              key: 'progress',
              header: 'Progress',
              cell: (item) => (
                <>
                  {item.progress.percent}%
                  {item.progress.overdue > 0 && (
                    <span className="block text-xs text-rose-800">
                      {item.progress.overdue} overdue
                    </span>
                  )}
                </>
              ),
            },
            {
              key: 'open',
              header: <span className="sr-only">Actions</span>,
              cell: (item) => (
                <>
                  <Link
                    className="text-indigo-700 underline"
                    href={`/onboarding/workflows/${item.id}`}
                    aria-label={`Open ${item.templateName}`}
                  >
                    Open
                  </Link>
                </>
              ),
            },
          ]}
        />
      )}
    </section>
  );
}
