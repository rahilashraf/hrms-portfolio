'use client';

import Link from 'next/link';
import { useCallback, useState } from 'react';
import { useTabParam } from '../../lib/navigation/use-tab-param';
import { PageContainer } from '../ui/page-container';
import { TabList, TabPanel, useTabIdBase } from '../ui/tabs';
import { PageHeader, ErrorBanner, FeedbackMessage } from '../organization/shared';
import { performanceApi } from '../../lib/performance/api';
import { performanceErrorMessage } from '../../lib/performance/errors';
import type { Evidence, Goal, QueueItem, ReviewSummary } from '../../lib/performance/types';
import { GoalDialog, GoalsTable, type GoalRun } from './goals/goal-components';
import { Section, SectionFailure, useLoadedSection } from './review/load-section';
import {
  dateTimeText,
  datePeriod,
  EmptyState,
  formatDateOnly,
  inputClass,
  partText,
  primaryButton,
  PROVIDER_LABELS,
  ReviewStatusBadge,
  scoreText,
} from './performance-shared';
import { DataTable } from '../ui/data-table';

type Tab = 'reviews' | 'goals' | 'evidence' | 'reviewing';
const TAB_IDS: readonly Tab[] = ['reviews', 'goals', 'evidence', 'reviewing'];

interface Assignment {
  id: string;
  positionName: string;
  organization: { id: string; name: string };
}

const loadMe = () => performanceApi.me();
const loadReviews = () => performanceApi.myReviews();
const loadGoals = () => performanceApi.myGoals();
const loadEvidence = () => performanceApi.myEvidence();
const loadQueue = () => performanceApi.reviewing();

/**
 * Employee self-service "My performance": the employee's reviews (outcome once finalized),
 * goals (they create and update their own; goals their manager set are completed or cancelled
 * by the manager or HR), assessment and training evidence (e.g. Google Forms quiz results), and
 * the reviews they are asked to write.
 *
 * Batch 7B: every section loads on its own, with its own error and retry — one failed request
 * never blanks the page or reads as "nothing yet". Only a missing employee record (or
 * Performance switched off) replaces the page with that explanation.
 */
export function MyPerformancePage() {
  // Batch 10E-2: sections deep-link with #goals etc.; picking one writes it to the URL.
  const [tab, setTab] = useTabParam<Tab>(TAB_IDS, 'reviews', { writeHash: true });
  const tabIdBase = useTabIdBase('my-performance');
  const me = useLoadedSection(loadMe);
  const reviews = useLoadedSection(loadReviews);
  const goals = useLoadedSection(loadGoals);
  const evidence = useLoadedSection(loadEvidence);
  const queue = useLoadedSection(loadQueue);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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

  const pageBlocked =
    me.state.status === 'error' &&
    (me.state.kind === 'NOT_EMPLOYEE' || me.state.kind === 'MODULE_DISABLED')
      ? me.state.kind
      : null;
  const queueItems = queue.state.status === 'ready' ? queue.state.data.items : [];
  const tabs: ReadonlyArray<{ id: Tab; label: string }> = [
    { id: 'reviews', label: 'My reviews' },
    { id: 'goals', label: 'My goals' },
    { id: 'evidence', label: 'Assessments & training' },
    ...(queueItems.length > 0
      ? [{ id: 'reviewing' as const, label: `Reviews to write (${queueItems.length})` }]
      : []),
  ];
  const activeTab = tabs.some((t) => t.id === tab) ? tab : 'reviews';
  const assignments: Assignment[] = me.state.status === 'ready' ? me.state.data.assignments : [];

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Self-service"
        title="My performance"
        description="Your reviews, goals and assessment results. Ratings are decided in the review; assessment results are supporting evidence only."
      />
      <div className="mt-8 space-y-4">
        {error && <ErrorBanner>{error}</ErrorBanner>}
        {success && <FeedbackMessage>{success}</FeedbackMessage>}
        {pageBlocked === 'NOT_EMPLOYEE' ? (
          <EmptyState>
            Your account is not linked to an employee record, so there is nothing to show.
          </EmptyState>
        ) : pageBlocked === 'MODULE_DISABLED' ? (
          <EmptyState>Performance is switched off for your organization.</EmptyState>
        ) : (
          <>
            {me.state.status === 'error' && (
              <SectionFailure
                name="Your positions"
                kind={me.state.kind}
                message={me.state.message}
                onRetry={() => void me.reload()}
              />
            )}
            {queue.state.status === 'error' && (
              <SectionFailure
                name="Reviews to write"
                kind={queue.state.kind}
                message={queue.state.message}
                onRetry={() => void queue.reload()}
              />
            )}
            <TabList<Tab>
              tabs={tabs}
              active={activeTab}
              onChange={setTab}
              label="Performance sections"
              idBase={tabIdBase}
            />
            <TabPanel idBase={tabIdBase} id={activeTab}>
              {activeTab === 'reviews' && (
                <Section
                  name="Your reviews"
                  state={reviews.state}
                  onRetry={() => void reviews.reload()}
                >
                  {(data) => <MyReviews reviews={data.items} />}
                </Section>
              )}
              {activeTab === 'goals' && (
                <Section name="Your goals" state={goals.state} onRetry={() => void goals.reload()}>
                  {(data) => (
                    <MyGoals
                      goals={data.items}
                      assignments={assignments}
                      busy={busy}
                      run={run}
                      onCreated={() => goals.reload()}
                    />
                  )}
                </Section>
              )}
              {activeTab === 'evidence' && (
                <Section
                  name="Your assessments"
                  state={evidence.state}
                  onRetry={() => void evidence.reload()}
                >
                  {(data) => <MyEvidence evidence={data.items} />}
                </Section>
              )}
              {activeTab === 'reviewing' && <ReviewQueue items={queueItems} />}
            </TabPanel>
          </>
        )}
      </div>
    </PageContainer>
  );
}

function MyReviews({ reviews }: { reviews: ReviewSummary[] }) {
  if (reviews.length === 0) return <EmptyState>You have no performance reviews yet.</EmptyState>;
  return (
    <DataTable
      label="Your reviews"
      rows={reviews}
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
              {review.awaitingAcknowledgement && (
                <span className="mt-1 block text-xs text-indigo-700">Please acknowledge</span>
              )}
            </>
          ),
        },
        {
          key: 'self',
          header: 'Your self review',
          cell: (review) => <>{partText(review.selfStatus)}</>,
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
                aria-label={`Open ${review.cycle.name} review`}
              >
                Open
              </Link>
            </>
          ),
        },
      ]}
    />
  );
}

function MyGoals({
  goals,
  assignments,
  busy,
  run,
  onCreated,
}: {
  goals: Goal[];
  assignments: Assignment[];
  busy: boolean;
  run: GoalRun;
  onCreated(): Promise<void>;
}) {
  const [adding, setAdding] = useState(false);
  const [assignmentId, setAssignmentId] = useState('');
  const chosen = assignmentId || assignments[0]?.id || '';
  return (
    <div className="space-y-4">
      {goals.length === 0 ? (
        <EmptyState>You have no goals yet.</EmptyState>
      ) : (
        <GoalsTable label="Your goals" goals={goals} viewerIsEmployee busy={busy} run={run} />
      )}
      {assignments.length > 0 && (
        <div className="flex flex-wrap items-end gap-2">
          {assignments.length > 1 && (
            <label className="text-sm font-medium text-slate-800">
              Position
              <select
                className={inputClass}
                value={chosen}
                onChange={(e) => setAssignmentId(e.currentTarget.value)}
              >
                {assignments.map((assignment) => (
                  <option key={assignment.id} value={assignment.id}>
                    {assignment.positionName} ({assignment.organization.name})
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
            Add goal
          </button>
        </div>
      )}
      {adding && (
        <GoalDialog
          open
          goal={null}
          assignmentId={chosen}
          title="Add a goal"
          onClose={() => setAdding(false)}
          onSaved={async () => {
            setAdding(false);
            await onCreated();
          }}
        />
      )}
    </div>
  );
}

function MyEvidence({ evidence }: { evidence: Evidence[] }) {
  if (evidence.length === 0) {
    return <EmptyState>No assessment or training results are recorded for you yet.</EmptyState>;
  }
  return (
    <DataTable
      label="Your assessments"
      rows={evidence}
      rowKey={(item) => item.id}
      columns={[
        {
          key: 'assessment',
          header: 'Assessment',
          rowHeader: true,
          cell: (item) => (
            <>
              {item.title}
              {item.revision > 1 && <span className="block text-xs text-amber-800">Corrected</span>}
            </>
          ),
        },
        {
          key: 'source',
          header: 'Source',
          cell: (item) => (
            <>
              {PROVIDER_LABELS[item.provider]}
              {item.sync?.lastSyncedAt && (
                <span className="block text-xs text-slate-500">
                  Synced {dateTimeText(item.sync.lastSyncedAt)}
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
          cell: (item) => <>{item.status === 'WITHDRAWN' ? 'Withdrawn' : 'Recorded'}</>,
        },
      ]}
    />
  );
}

function ReviewQueue({ items }: { items: QueueItem[] }) {
  return (
    <DataTable
      label="Reviews to write"
      rows={items}
      rowKey={(item) => item.id}
      columns={[
        {
          key: 'employee',
          header: 'Employee',
          rowHeader: true,
          cell: (item) => (
            <>
              {item.employee.displayName}
              <span className="block text-xs font-normal text-slate-500">{item.positionName}</span>
            </>
          ),
        },
        {
          key: 'cycle',
          header: 'Cycle',
          cell: (item) => <>{item.cycle.name}</>,
        },
        {
          key: 'review',
          header: 'Your review',
          cell: (item) => (
            <>
              {partText(item.reviewerStatus)}
              {item.overdue.includes('REVIEWER') && (
                <span className="block text-xs text-rose-700">Overdue</span>
              )}
            </>
          ),
        },
        {
          key: 'due',
          header: 'Due',
          cell: (item) => (
            <>{item.cycle.reviewerDueDate ? formatDateOnly(item.cycle.reviewerDueDate) : '—'}</>
          ),
        },
        {
          key: 'open',
          header: <span className="sr-only">Actions</span>,
          cell: (item) => (
            <>
              <Link className="text-indigo-700 underline" href={`/performance/reviews/${item.id}`}>
                Write review
              </Link>
            </>
          ),
        },
      ]}
    />
  );
}
