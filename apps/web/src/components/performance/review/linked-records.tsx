'use client';

import { useEffect, useState } from 'react';
import { performanceApi } from '../../../lib/performance/api';
import type { Evidence, Goal, ReviewDetail } from '../../../lib/performance/types';
import {
  dateTimeText,
  EmptyState,
  GoalStatusBadge,
  inputClass,
  PROVIDER_LABELS,
  scoreText,
  secondaryButton,
} from '../performance-shared';
import { ConfirmButton } from '../../ui/confirm-button';
import { GoalDialog } from '../goals/goal-components';
import type { Run } from './review-shared';

// Batch 10E-2: the review's linked goals and evidence (moved from review-page.tsx
// unchanged).
export function LinkedGoals({
  review,
  busy,
  run,
}: {
  review: ReviewDetail;
  busy: boolean;
  run: Run;
}) {
  const [available, setAvailable] = useState<Goal[]>([]);
  const [goalId, setGoalId] = useState('');
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    if (!review.actions.canLinkGoals) return;
    let active = true;
    performanceApi
      .employeeGoals(review.employee.id)
      .then((result) => {
        if (!active) return;
        const linked = new Set(review.goals.map((goal) => goal.goalId));
        setAvailable(
          result.items.filter(
            (goal) =>
              goal.employmentAssignmentId === review.employmentAssignment.id &&
              !linked.has(goal.id),
          ),
        );
      })
      .catch(() => active && setAvailable([]));
    return () => {
      active = false;
    };
  }, [review]);
  if (review.goals.length === 0 && !review.actions.canLinkGoals) return null;
  return (
    <section id="goals" aria-label="Goals" className="space-y-2">
      <h2 className="text-lg font-semibold text-slate-900">Goals</h2>
      {review.goals.length === 0 ? (
        <EmptyState>No goals are linked to this review.</EmptyState>
      ) : (
        <ul className="space-y-1 text-sm">
          {review.goals.map((goal) => (
            <li key={goal.linkId} className="flex flex-wrap items-center gap-2">
              <span>{goal.title}</span>
              <GoalStatusBadge status={goal.status} />
              {goal.progressPercent !== null && <span>{goal.progressPercent}%</span>}
              {goal.snapshotted && (
                <span className="text-xs text-slate-500">(as at finalization)</span>
              )}
              {review.actions.canLinkGoals && (
                <ConfirmButton
                  className="text-xs text-rose-700 underline"
                  disabled={busy}
                  aria-label={`Unlink ${goal.title}`}
                  confirm={{
                    title: `Unlink “${goal.title}” from this review?`,
                    description: 'The goal itself is kept; it is no longer part of this review.',
                    confirmLabel: 'Unlink goal',
                  }}
                  onConfirm={() =>
                    void run(
                      () => performanceApi.unlinkGoal(review.id, goal.goalId),
                      'Goal unlinked.',
                    )
                  }
                >
                  Unlink
                </ConfirmButton>
              )}
            </li>
          ))}
        </ul>
      )}
      {review.actions.canLinkGoals && (
        <div>
          <button
            type="button"
            className={secondaryButton}
            disabled={busy}
            onClick={() => setCreating(true)}
          >
            Set a new goal
          </button>
          {creating && (
            <GoalDialog
              open
              goal={null}
              assignmentId={review.employmentAssignment.id}
              title={`Set a goal for ${review.employee.displayName}`}
              onClose={() => setCreating(false)}
              onSaved={async (goal) => {
                setCreating(false);
                await run(
                  () => performanceApi.linkGoal(review.id, goal.id),
                  'Goal set and linked to the review.',
                );
              }}
            />
          )}
        </div>
      )}
      {review.actions.canLinkGoals && available.length > 0 && (
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-sm text-slate-700">
            Link a goal
            <select
              className={inputClass}
              value={goalId}
              onChange={(e) => setGoalId(e.currentTarget.value)}
            >
              <option value="">Choose a goal</option>
              {available.map((goal) => (
                <option key={goal.id} value={goal.id}>
                  {goal.title}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className={secondaryButton}
            disabled={busy || !goalId}
            onClick={() =>
              void run(() => performanceApi.linkGoal(review.id, goalId), 'Goal linked.')
            }
          >
            Link
          </button>
        </div>
      )}
    </section>
  );
}

export function LinkedEvidence({
  review,
  busy,
  run,
}: {
  review: ReviewDetail;
  busy: boolean;
  run: Run;
}) {
  const [available, setAvailable] = useState<Evidence[]>([]);
  const [evidenceId, setEvidenceId] = useState('');
  const evidenceItem = review.form
    .flatMap((section) => section.items)
    .find((item) => item.itemType === 'EVIDENCE_REFERENCE');
  useEffect(() => {
    if (!review.actions.canLinkEvidence) return;
    let active = true;
    performanceApi
      .employeeEvidence(review.employee.id)
      .then((result) => {
        if (!active) return;
        const linked = new Set(review.evidence.map((item) => item.evidenceId));
        setAvailable(
          result.items.filter(
            (item) =>
              item.status === 'ACTIVE' &&
              item.organizationId === review.organization.id &&
              (!item.employmentAssignment ||
                item.employmentAssignment.id === review.employmentAssignment.id) &&
              !linked.has(item.id),
          ),
        );
      })
      .catch(() => active && setAvailable([]));
    return () => {
      active = false;
    };
  }, [review]);
  if (review.evidence.length === 0 && !review.actions.canLinkEvidence) return null;
  return (
    <section aria-label="Supporting evidence" className="space-y-2">
      <h2 className="text-lg font-semibold text-slate-900">Supporting evidence</h2>
      <p className="text-xs text-slate-500">
        Assessment results inform the review; they never set the rating or the score.
      </p>
      {review.evidence.length === 0 ? (
        <EmptyState>No evidence is linked to this review.</EmptyState>
      ) : (
        <ul className="space-y-1 text-sm">
          {review.evidence.map((item) => (
            <li key={item.linkId} className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{item.title}</span>
              <span className="text-slate-600">
                {PROVIDER_LABELS[item.provider]} · {dateTimeText(item.completedAt)} ·{' '}
                {scoreText(item)}
              </span>
              {item.status === 'WITHDRAWN' && (
                <span className="text-xs text-rose-700">Withdrawn</span>
              )}
              {item.changedSinceLinked && (
                <span className="text-xs text-amber-800">Corrected since it was linked</span>
              )}
              {review.actions.canLinkEvidence && (
                <ConfirmButton
                  className="text-xs text-rose-700 underline"
                  disabled={busy}
                  aria-label={`Unlink ${item.title}`}
                  confirm={{
                    title: `Unlink “${item.title}” from this review?`,
                    description: 'The evidence itself is kept; it no longer supports this review.',
                    confirmLabel: 'Unlink evidence',
                  }}
                  onConfirm={() =>
                    void run(
                      () => performanceApi.unlinkEvidence(review.id, item.linkId),
                      'Evidence unlinked.',
                    )
                  }
                >
                  Unlink
                </ConfirmButton>
              )}
            </li>
          ))}
        </ul>
      )}
      {review.actions.canLinkEvidence && available.length > 0 && (
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-sm text-slate-700">
            Link evidence
            <select
              className={inputClass}
              value={evidenceId}
              onChange={(e) => setEvidenceId(e.currentTarget.value)}
            >
              <option value="">Choose evidence</option>
              {available.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title} ({dateTimeText(item.completedAt)})
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className={secondaryButton}
            disabled={busy || !evidenceId}
            onClick={() =>
              void run(
                () => performanceApi.linkEvidence(review.id, evidenceId, evidenceItem?.id ?? null),
                'Evidence linked.',
              )
            }
          >
            Link
          </button>
        </div>
      )}
    </section>
  );
}
