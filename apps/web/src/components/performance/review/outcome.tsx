'use client';

import type { ReviewDetail } from '../../../lib/performance/types';

// Batch 10E-2: moved from review-page.tsx unchanged.
export function Outcome({ review }: { review: ReviewDetail }) {
  if (!review.overallRating && !review.calculatedScore) return null;
  if (review.viewer === 'REVIEWER' && review.status !== 'FINALIZED') return null;
  return (
    <section
      id="results"
      aria-label="Outcome"
      className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm"
    >
      {review.overallRating && (
        <p>
          Overall rating:{' '}
          <strong>
            {review.overallRating.value} — {review.overallRating.label}
          </strong>
        </p>
      )}
      {review.calculatedScore && <p>Calculated score: {review.calculatedScore}</p>}
    </section>
  );
}
