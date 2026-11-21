'use client';

import { useEffect, useState } from 'react';
import { PageHeader, ErrorBanner } from '../organization/shared';
import { compensationApi } from '../../lib/compensation/api';
import { compensationErrorMessage, isCompensationForbidden } from '../../lib/compensation/errors';
import type { EmployeeCompensation } from '../../lib/compensation/types';
import { AssignmentStatusBadge } from '../employee/employee-shared';
import {
  assignmentTitle,
  CompensationHistory,
  CompensationOnDate,
  CurrentCompensation,
  EmptyState,
} from './compensation-shared';
import { PageContainer } from '../ui/page-container';

/** Employee self-service: one's own compensation, read-only. */
export function MyCompensationPage() {
  const [data, setData] = useState<EmployeeCompensation | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notEmployee, setNotEmployee] = useState(false);

  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      compensationApi
        .me()
        .then((value) => {
          if (active) setData(value);
        })
        .catch((cause) => {
          if (!active) return;
          setNotEmployee(isCompensationForbidden(cause));
          setError(compensationErrorMessage(cause));
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, []);

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Self-service"
        title="My pay"
        description="Your recorded pay rates by assignment, with their history. Contact HR if something looks wrong."
      />
      <div className="mt-8 space-y-6">
        {loading ? (
          <p role="status" className="text-sm text-slate-600">
            Loading compensation…
          </p>
        ) : notEmployee ? (
          <EmptyState>
            Your account is not linked to an employee record, so there is no pay to show.
          </EmptyState>
        ) : error ? (
          <ErrorBanner>{error}</ErrorBanner>
        ) : !data || data.assignments.length === 0 ? (
          <EmptyState>You have no assignments with compensation yet.</EmptyState>
        ) : (
          data.assignments.map((view) => (
            <article
              key={view.assignment.id}
              aria-label={`Compensation for ${assignmentTitle(view)}`}
              className="space-y-4 rounded-xl border border-slate-200 bg-white p-5"
            >
              <div>
                <h2 className="text-lg font-semibold text-slate-900">{assignmentTitle(view)}</h2>
                <p className="mt-1 flex items-center gap-2 text-sm text-slate-600">
                  <AssignmentStatusBadge status={view.assignment.status} />
                  {view.assignment.isPrimary && <span>Primary</span>}
                </p>
              </div>
              <CurrentCompensation view={view} />
              <CompensationOnDate view={view} />
              <h3 className="text-sm font-semibold uppercase text-slate-500">History</h3>
              <CompensationHistory view={view} />
            </article>
          ))
        )}
      </div>
    </PageContainer>
  );
}
