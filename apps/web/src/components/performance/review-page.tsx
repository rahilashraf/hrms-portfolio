'use client';

import { LoadingState } from '../ui/states';
import { PageContainer } from '../ui/page-container';
import { PageHeader } from '../ui/page-header';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Forbidden } from '../auth/forbidden';
import { ErrorBanner, FeedbackMessage } from '../organization/shared';
import { performanceApi } from '../../lib/performance/api';
import { isPerformanceForbidden, performanceErrorMessage } from '../../lib/performance/errors';
import type { ReviewDetail } from '../../lib/performance/types';
import {
  dateTimeText,
  datePeriod,
  formatDateOnly,
  label,
  partText,
  ReviewStatusBadge,
} from './performance-shared';
import { AcknowledgeForm } from './review/acknowledge-form';
import { HrActions } from './review/hr-actions';
import { LinkedEvidence, LinkedGoals } from './review/linked-records';
import { Outcome } from './review/outcome';
import { ReviewForm } from './review/review-form';
import { ReviewJourney } from './review/review-journey';
import type { Part } from './review/review-shared';

/**
 * One performance review, as the viewer may see and act on it (decided by the API): the
 * employee writes the self part and acknowledges the finalized review; the reviewer (or HR)
 * writes the reviewer part; HR reassigns, reopens, finalizes, corrects and closes.
 */
export function ReviewPage({ reviewId }: { reviewId: string }) {
  const [review, setReview] = useState<ReviewDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setReview(await performanceApi.review(reviewId));
      setError(null);
    } catch (cause) {
      setForbidden(isPerformanceForbidden(cause));
      setError(performanceErrorMessage(cause, 'Unable to load the review.'));
    } finally {
      setLoading(false);
    }
  }, [reviewId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function run(action: () => Promise<ReviewDetail | unknown>, message: string) {
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const result = await action();
      if (result && typeof result === 'object' && 'form' in result)
        setReview(result as ReviewDetail);
      else await load();
      setSuccess(message);
      return true;
    } catch (cause) {
      setError(performanceErrorMessage(cause, 'Unable to save the review.'));
      return false;
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <PageContainer>
        <LoadingState label="Loading review…" />
      </PageContainer>
    );
  }
  if (forbidden) {
    // Batch 10E-2: the denied state in the page's own width.
    return (
      <PageContainer padded={false}>
        <Forbidden message="You do not have access to this review." />
      </PageContainer>
    );
  }
  if (!review) {
    return (
      <PageContainer>
        <ErrorBanner>{error ?? 'Unable to load the review.'}</ErrorBanner>
      </PageContainer>
    );
  }

  const editablePart: Part | null = review.actions.canEditSelf
    ? 'SELF'
    : review.actions.canEditReviewer
      ? 'REVIEWER'
      : null;

  return (
    <PageContainer className="space-y-6">
      <div>
        <Link
          href={
            review.viewer === 'SELF' || review.viewer === 'REVIEWER'
              ? '/performance'
              : `/admin/employees/${review.employee.id}`
          }
          className="text-sm font-medium text-indigo-700 hover:underline"
        >
          ← Performance
        </Link>
        <div className="mt-2">
          <PageHeader
            title={`${review.cycle.name}: ${review.employee.displayName}`}
            description={
              <>
                {review.employmentAssignment.positionName} · {review.organization.name} · Review
                period {datePeriod(review.cycle.periodStart, review.cycle.periodEnd)}
              </>
            }
          />
        </div>
        <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm">
          <div>
            <dt className="inline text-slate-500">Status </dt>
            <dd className="inline">
              <ReviewStatusBadge status={review.status} />
            </dd>
          </div>
          <div>
            <dt className="inline text-slate-500">Self review: </dt>
            <dd className="inline">{partText(review.selfStatus)}</dd>
          </div>
          <div>
            <dt className="inline text-slate-500">Reviewer: </dt>
            <dd className="inline">
              {review.reviewer?.displayName ?? 'Not assigned'} ({partText(review.reviewerStatus)})
            </dd>
          </div>
          {review.cycle.selfReviewDueDate && (
            <div>
              <dt className="inline text-slate-500">Self review due: </dt>
              <dd className="inline">{formatDateOnly(review.cycle.selfReviewDueDate)}</dd>
            </div>
          )}
          {review.cycle.reviewerDueDate && (
            <div>
              <dt className="inline text-slate-500">Reviewer due: </dt>
              <dd className="inline">{formatDateOnly(review.cycle.reviewerDueDate)}</dd>
            </div>
          )}
        </dl>
      </div>
      <ReviewJourney review={review} />
      {error && <ErrorBanner>{error}</ErrorBanner>}
      {success && <FeedbackMessage>{success}</FeedbackMessage>}

      <ReviewForm
        key={`${review.id}-${review.status}-${review.selfStatus}-${review.reviewerStatus}`}
        review={review}
        part={editablePart}
        busy={busy}
        onSave={(answers, overall, submit) =>
          run(
            async () => {
              const part = editablePart === 'SELF' ? 'self' : 'reviewer';
              const saved = await performanceApi.saveAnswers(review.id, part, {
                answers,
                ...(overall !== undefined ? { overallRatingValue: overall } : {}),
              });
              return submit ? performanceApi.submit(review.id, part) : saved;
            },
            submit ? 'Submitted.' : 'Draft saved.',
          )
        }
      />

      <Outcome review={review} />
      <LinkedGoals review={review} busy={busy} run={run} />
      <LinkedEvidence review={review} busy={busy} run={run} />

      {review.actions.canAcknowledge && (
        <AcknowledgeForm
          busy={busy}
          onSubmit={(comment) =>
            run(() => performanceApi.acknowledge(review.id, comment), 'Review acknowledged.')
          }
        />
      )}
      {review.acknowledgement && (
        <section
          aria-label="Acknowledgement"
          className="rounded-xl border border-slate-200 bg-white p-4 text-sm"
        >
          <p>
            Acknowledged on {dateTimeText(review.acknowledgement.acknowledgedAt)}. Acknowledging
            means the employee has seen the review, not that they agree with it.
          </p>
          {review.acknowledgement.comment && (
            <p className="mt-2 whitespace-pre-wrap text-slate-700">
              “{review.acknowledgement.comment}”
            </p>
          )}
        </section>
      )}

      <HrActions review={review} busy={busy} run={run} />

      {review.events.length > 0 && (
        <details className="text-sm text-slate-700">
          <summary className="cursor-pointer font-medium">History ({review.events.length})</summary>
          <ul className="mt-2 space-y-1">
            {review.events.map((event, index) => (
              <li key={`${event.type}-${index}`}>
                {dateTimeText(event.at)} · {label(event.type)}
                {event.actorName ? ` by ${event.actorName}` : ''}
                {event.type === 'REVIEWER_CHANGED'
                  ? ` (${event.fromEmployeeName ?? 'no reviewer'} → ${event.toEmployeeName ?? 'no reviewer'})`
                  : ''}
                {event.reason ? ` — ${event.reason}` : ''}
              </li>
            ))}
          </ul>
        </details>
      )}
    </PageContainer>
  );
}
