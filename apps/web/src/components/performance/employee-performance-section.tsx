'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { ErrorBanner, FeedbackMessage } from '../organization/shared';
import { performanceApi } from '../../lib/performance/api';
import { performanceErrorMessage } from '../../lib/performance/errors';
import type { PerformanceOrganization } from '../../lib/performance/types';
import { GoalDialog, GoalsTable } from './goals/goal-components';
import { Section, useLoadedSection } from './review/load-section';
import {
  dateTimeText,
  datePeriod,
  EmptyState,
  inputClass,
  primaryButton,
  PROVIDER_LABELS,
  ReviewStatusBadge,
  scoreText,
} from './performance-shared';
import { DataTable } from '../ui/data-table';

/**
 * The employee profile's performance section, for performance.read/manage holders only (never
 * implied by employee access). The API limits each list to the assignments within scope.
 *
 * Batch 7B: reviews, goals and evidence load independently (a failed list shows its own error
 * and retry, never "none"); HR and managers set goals for the employee here (the position is
 * picked from the performance options in their scope); goals show who set them.
 */
export function EmployeePerformanceSection({ employeeId }: { employeeId: string }) {
  const loadReviews = useCallback(() => performanceApi.employeeReviews(employeeId), [employeeId]);
  const loadGoals = useCallback(() => performanceApi.employeeGoals(employeeId), [employeeId]);
  const loadEvidence = useCallback(() => performanceApi.employeeEvidence(employeeId), [employeeId]);
  const reviews = useLoadedSection(loadReviews);
  const goals = useLoadedSection(loadGoals);
  const evidence = useLoadedSection(loadEvidence);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [organizations, setOrganizations] = useState<PerformanceOrganization[]>([]);
  const [organizationId, setOrganizationId] = useState('');
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    let active = true;
    performanceApi
      .organizations()
      .then((result) => active && setOrganizations(result.items))
      .catch(() => active && setOrganizations([]));
    return () => {
      active = false;
    };
  }, []);

  const run = useCallback(
    async (action: () => Promise<unknown>, message: string) => {
      setBusy(true);
      setError(null);
      setSuccess(null);
      try {
        await action();
        setSuccess(message);
        await goals.reload();
        return true;
      } catch (cause) {
        setError(performanceErrorMessage(cause, 'Unable to save the goal.'));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [goals],
  );

  const chosenOrganization = organizationId || organizations[0]?.id || '';
  const canSetGoals = goals.state.status === 'ready' && organizations.length > 0;

  return (
    <section aria-labelledby="performance-heading" className="mt-8 space-y-4">
      <h2 id="performance-heading" className="text-xl font-semibold text-slate-950">
        Performance
      </h2>
      {error && <ErrorBanner>{error}</ErrorBanner>}
      {success && <FeedbackMessage>{success}</FeedbackMessage>}

      <h3 className="text-sm font-semibold uppercase text-slate-500">Reviews</h3>
      <Section name="Reviews" state={reviews.state} onRetry={() => void reviews.reload()}>
        {(data) =>
          data.items.length === 0 ? (
            <EmptyState>No reviews.</EmptyState>
          ) : (
            <DataTable
              label="Performance reviews"
              rows={data.items}
              rowKey={(review) => review.id}
              columns={[
                {
                  key: 'cycle',
                  header: 'Cycle',
                  rowHeader: true,
                  cell: (review) => (
                    <>
                      {review.cycle.name}
                      <span className="block text-xs font-normal text-slate-500">
                        {datePeriod(review.cycle.periodStart, review.cycle.periodEnd)}
                      </span>
                    </>
                  ),
                },
                {
                  key: 'position',
                  header: 'Position',
                  cell: (review) => <>{review.positionName}</>,
                },
                {
                  key: 'status',
                  header: 'Status',
                  cell: (review) => (
                    <>
                      <ReviewStatusBadge status={review.status} />
                    </>
                  ),
                },
                {
                  key: 'reviewer',
                  header: 'Reviewed by',
                  cell: (review) => (
                    <>{review.submittedBy?.displayName ?? review.reviewer?.displayName ?? '—'}</>
                  ),
                },
                {
                  key: 'outcome',
                  header: 'Outcome',
                  cell: (review) => (
                    <>
                      {review.overallRating
                        ? `${review.overallRating.value} — ${review.overallRating.label}`
                        : '—'}
                    </>
                  ),
                },
                {
                  key: 'open',
                  header: <span className="sr-only">Actions</span>,
                  cell: (review) => (
                    <>
                      <Link
                        className="text-indigo-700 underline"
                        href={`/performance/reviews/${review.id}`}
                        aria-label={`Open ${review.cycle.name} review by ${review.submittedBy?.displayName ?? review.reviewer?.displayName ?? 'an unassigned reviewer'}`}
                      >
                        Open
                      </Link>
                    </>
                  ),
                },
              ]}
            />
          )
        }
      </Section>

      <div className="flex flex-wrap items-end justify-between gap-2">
        <h3 className="text-sm font-semibold uppercase text-slate-500">Goals</h3>
        {canSetGoals && (
          <div className="flex flex-wrap items-end gap-2">
            {organizations.length > 1 && (
              <label className="text-sm text-slate-700">
                Organization
                <select
                  className={inputClass}
                  value={chosenOrganization}
                  onChange={(e) => setOrganizationId(e.currentTarget.value)}
                >
                  {organizations.map((organization) => (
                    <option key={organization.id} value={organization.id}>
                      {organization.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <button
              type="button"
              className={primaryButton}
              disabled={busy}
              onClick={() => setAdding(true)}
            >
              Set a goal
            </button>
          </div>
        )}
      </div>
      <Section name="Goals" state={goals.state} onRetry={() => void goals.reload()}>
        {(data) =>
          data.items.length === 0 ? (
            <EmptyState>No goals.</EmptyState>
          ) : (
            <GoalsTable
              label="Goals"
              goals={data.items}
              viewerIsEmployee={false}
              busy={busy}
              run={run}
            />
          )
        }
      </Section>
      {adding && chosenOrganization && (
        <GoalDialog
          open
          goal={null}
          pick={{ organizationId: chosenOrganization, employeeId }}
          title="Set a goal for the employee"
          onClose={() => setAdding(false)}
          onSaved={async () => {
            setAdding(false);
            setSuccess('Goal set.');
            await goals.reload();
          }}
        />
      )}

      <h3 className="text-sm font-semibold uppercase text-slate-500">Assessments and evidence</h3>
      <Section name="Evidence" state={evidence.state} onRetry={() => void evidence.reload()}>
        {(data) =>
          data.items.length === 0 ? (
            <EmptyState>No evidence.</EmptyState>
          ) : (
            <DataTable
              label="Assessments and evidence"
              rows={data.items}
              rowKey={(item) => item.id}
              columns={[
                {
                  key: 'evidence',
                  header: 'Evidence',
                  rowHeader: true,
                  cell: (item) => (
                    <>
                      {item.title}
                      {item.revision > 1 && (
                        <span className="block text-xs text-amber-800">
                          Revision {item.revision}
                        </span>
                      )}
                      {item.notes && (
                        <span className="block text-xs font-normal text-slate-600">
                          HR note: {item.notes}
                        </span>
                      )}
                    </>
                  ),
                },
                {
                  key: 'source',
                  header: 'Source',
                  cell: (item) => (
                    <>
                      {PROVIDER_LABELS[item.provider]}
                      {item.sourceName && (
                        <span className="block text-xs font-normal text-slate-500">
                          {item.sourceName}
                        </span>
                      )}
                    </>
                  ),
                },
                {
                  key: 'completed',
                  header: 'Completed',
                  cell: (item) => <>{dateTimeText(item.completedAt)}</>,
                },
                {
                  key: 'result',
                  header: 'Result',
                  cell: (item) => <>{scoreText(item)}</>,
                },
                {
                  key: 'status',
                  header: 'Status',
                  cell: (item) => (
                    <>
                      {item.status === 'WITHDRAWN'
                        ? `Withdrawn: ${item.withdrawalReason ?? ''}`
                        : 'Recorded'}
                    </>
                  ),
                },
              ]}
            />
          )
        }
      </Section>
    </section>
  );
}
