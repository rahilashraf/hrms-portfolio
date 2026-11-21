'use client';

import { StatusBadge } from '../ui/status-badge';
import type { Tone } from '../ui/tokens';
import { formatDateOnly, label } from '../../lib/payroll/format';
import type { Evidence, GoalStatus, PartStatus, ReviewStatus } from '../../lib/performance/types';

export { EmptyState, inputClass, primaryButton, secondaryButton } from '../payroll/payroll-shared';
export { formatDateOnly, label };

/**
 * Batch 10E-2: review statuses keep their own palette: six consecutive steps of one review
 * (not started → in progress → submitted → finalized → acknowledged, or closed) that the shared
 * five tones would merge in pairs. Goal statuses use `StatusBadge`. Words are always shown.
 */
const REVIEW_STYLES: Record<ReviewStatus, string> = {
  NOT_STARTED: 'bg-slate-100 text-slate-700',
  IN_PROGRESS: 'bg-sky-50 text-sky-800',
  SUBMITTED: 'bg-indigo-50 text-indigo-800',
  FINALIZED: 'bg-emerald-50 text-emerald-800',
  ACKNOWLEDGED: 'bg-emerald-100 text-emerald-900',
  CLOSED: 'bg-slate-200 text-slate-700',
};

export function ReviewStatusBadge({ status }: { status: ReviewStatus }) {
  return (
    <span
      className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${REVIEW_STYLES[status]}`}
    >
      {label(status)}
    </span>
  );
}

export function partText(status: PartStatus) {
  return status === 'NOT_REQUIRED' ? 'Not required' : label(status);
}

const GOAL_TONES: Record<GoalStatus, Tone> = {
  NOT_STARTED: 'neutral',
  IN_PROGRESS: 'info',
  COMPLETED: 'success',
  // Cancelled stays distinct from "not started" (as before).
  CANCELLED: 'danger',
};

export function GoalStatusBadge({ status }: { status: GoalStatus }) {
  return <StatusBadge status={status} label={label(status)} tone={GOAL_TONES[status]} />;
}

export const PROVIDER_LABELS: Record<string, string> = {
  GOOGLE_FORMS: 'Google Forms',
  MANUAL: 'Recorded by HR',
  TRAINING: 'Training',
  CERTIFICATION: 'Certification',
  OTHER: 'Other',
};

/** "17.00 / 20.00 (85.00%) · Passed", or what is known of an ungraded completion. */
export function scoreText(
  evidence: Pick<Evidence, 'score' | 'maxScore' | 'percentage' | 'passed'>,
) {
  const parts: string[] = [];
  if (evidence.score !== null) {
    parts.push(
      evidence.maxScore !== null ? `${evidence.score} / ${evidence.maxScore}` : evidence.score,
    );
  }
  if (evidence.percentage !== null) parts.push(`(${evidence.percentage}%)`);
  const result = parts.join(' ');
  const verdict = evidence.passed === null ? '' : evidence.passed ? 'Passed' : 'Not passed';
  if (!result && !verdict) return 'Completed (not graded)';
  return [result, verdict].filter(Boolean).join(' · ');
}

export const ATTENTION_LABELS: Record<string, string> = {
  NO_REVIEWER: 'No reviewer assigned',
  REVIEWER_NOT_IN_ORGANIZATION: 'Reviewer no longer works in the organization',
  OVERDUE_SELF: 'Self review overdue',
  OVERDUE_REVIEWER: 'Reviewer review overdue',
  ASSIGNMENT_ENDED: 'Reviewed assignment has ended',
  EMPLOYEE_TERMINATED: 'Employee has left',
  AWAITING_FINALIZATION: 'Waiting for finalization',
  AWAITING_ACKNOWLEDGEMENT: 'Waiting for acknowledgement',
};

export function datePeriod(start: string, end: string | null) {
  return `${formatDateOnly(start)} – ${end ? formatDateOnly(end) : 'ongoing'}`;
}

export function dateTimeText(value: string | null) {
  return value ? formatDateOnly(value.slice(0, 10)) : '—';
}
