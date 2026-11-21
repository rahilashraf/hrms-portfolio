'use client';

import { checkboxClass } from '../../ui/tokens';
import { useConfirm } from '../../ui/use-confirm';
import { useMemo, useState } from 'react';
import { performanceApi } from '../../../lib/performance/api';
import { performanceErrorMessage } from '../../../lib/performance/errors';
import type { Answer, ReviewDetail } from '../../../lib/performance/types';
import { inputClass, primaryButton, secondaryButton } from '../performance-shared';
import { performanceOptionSource } from '../../../lib/performance/pickers';
import { ConfirmButton } from '../../ui/confirm-button';
import { FormDialog } from '../../ui/form-dialog';
import { RecordCombobox } from '../../ui/record-combobox';
import { AnswerInput } from './review-form';
import { answeredBy, toAnswer, type Run } from './review-shared';

// Batch 10E-2: HR actions with the reassign and correction dialogs (moved from
// review-page.tsx unchanged).
export function HrActions({
  review,
  busy,
  run,
}: {
  review: ReviewDetail;
  busy: boolean;
  run: Run;
}) {
  const { actions } = review;
  const [reassigning, setReassigning] = useState(false);
  const [correcting, setCorrecting] = useState(false);
  if (
    !actions.canFinalize &&
    !actions.canReassign &&
    !actions.canReopenSelf &&
    !actions.canReopenReviewer &&
    !actions.canClose &&
    !actions.canCorrect
  ) {
    return null;
  }
  const unfinished = ['NOT_STARTED', 'IN_PROGRESS', 'SUBMITTED'].includes(review.status);
  return (
    <section
      aria-label="HR actions"
      className="space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-4"
    >
      <h2 className="text-base font-semibold text-slate-900">HR actions</h2>
      <p className="text-xs text-slate-600">
        Each action asks for confirmation, and for its own reason where one is recorded.
      </p>
      <div className="flex flex-wrap gap-2">
        {actions.canFinalize && (
          <ConfirmButton
            className={primaryButton}
            disabled={busy}
            confirm={{
              title: 'Finalize this review?',
              description:
                'The final rating and comments are shared with the employee, and the review can no longer be edited (only reopened or corrected with a reason).',
              confirmLabel: 'Finalize review',
            }}
            onConfirm={() =>
              void run(
                () => performanceApi.finalize(review.id),
                'Review finalized and shared with the employee.',
              )
            }
          >
            Finalize
          </ConfirmButton>
        )}
        {actions.canReopenSelf && (
          <ConfirmButton
            className={secondaryButton}
            disabled={busy}
            confirm={{
              title: 'Reopen the self review?',
              description: 'The employee can change and submit their self review again.',
              confirmLabel: 'Reopen self review',
              reason: { label: 'Why is the self review reopened?', required: true },
            }}
            onConfirm={(why) =>
              void run(
                () => performanceApi.reopen(review.id, 'SELF', why.trim()),
                'Self review reopened.',
              )
            }
          >
            Reopen self review
          </ConfirmButton>
        )}
        {actions.canReopenReviewer && (
          <ConfirmButton
            className={secondaryButton}
            disabled={busy}
            confirm={{
              title: 'Reopen the reviewer review?',
              description: 'The reviewer can change and submit their review again.',
              confirmLabel: 'Reopen reviewer review',
              reason: { label: 'Why is the reviewer review reopened?', required: true },
            }}
            onConfirm={(why) =>
              void run(
                () => performanceApi.reopen(review.id, 'REVIEWER', why.trim()),
                'Reviewer review reopened.',
              )
            }
          >
            Reopen reviewer review
          </ConfirmButton>
        )}
        {actions.canReassign && (
          <button
            type="button"
            className={secondaryButton}
            disabled={busy}
            onClick={() => setReassigning(true)}
          >
            Change reviewer
          </button>
        )}
        {actions.canReassign && review.reviewer && (
          <ConfirmButton
            className={secondaryButton}
            disabled={busy}
            confirm={{
              title: `Remove ${review.reviewer.displayName} as reviewer?`,
              description:
                'The review is left without a reviewer until someone is assigned; it is listed as needing attention.',
              confirmLabel: 'Remove reviewer',
              destructive: true,
              reason: { label: 'Why is the reviewer removed?', required: true },
            }}
            onConfirm={(why) =>
              void run(
                () => performanceApi.reassign(review.id, null, why.trim()),
                'Reviewer removed.',
              )
            }
          >
            Remove reviewer
          </ConfirmButton>
        )}
        {actions.canCorrect && (
          <button
            type="button"
            className={secondaryButton}
            disabled={busy}
            onClick={() => setCorrecting(true)}
          >
            Correct review
          </button>
        )}
        {actions.canClose && (
          <ConfirmButton
            className={secondaryButton}
            disabled={busy}
            confirm={{
              title: 'Close this review?',
              description: unfinished
                ? 'The review is not finalized: it is closed as incomplete and cannot be continued.'
                : 'The finalized review is closed as completed.',
              confirmLabel: 'Close review',
              destructive: unfinished,
              reason: unfinished
                ? { label: 'Why is the unfinished review closed?', required: true }
                : { label: 'Note', required: false },
            }}
            onConfirm={(why) =>
              void run(
                () => performanceApi.closeReview(review.id, why.trim() || null),
                'Review closed.',
              )
            }
          >
            Close review
          </ConfirmButton>
        )}
      </div>
      {reassigning && (
        <ReassignDialog
          review={review}
          onClose={() => setReassigning(false)}
          onDone={() => {
            setReassigning(false);
            return run(async () => undefined, 'Reviewer changed.');
          }}
        />
      )}
      {correcting && (
        <CorrectionDialog
          review={review}
          onClose={() => setCorrecting(false)}
          onDone={() => {
            setCorrecting(false);
            return run(async () => undefined, 'Review corrected.');
          }}
        />
      )}
    </section>
  );
}

/** Batch 7B: a reviewer is picked by name (performance options, no ids), with a reason. */
function ReassignDialog({
  review,
  onClose,
  onDone,
}: {
  review: ReviewDetail;
  onClose(): void;
  onDone(): Promise<boolean>;
}) {
  const reviewers = useMemo(
    () => performanceOptionSource(review.organization.id, 'reviewer'),
    [review.organization.id],
  );
  const [reviewerId, setReviewerId] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <FormDialog
      open
      title="Change reviewer"
      description={`Currently: ${review.reviewer?.displayName ?? 'no reviewer'}.`}
      submitLabel="Change reviewer"
      busy={busy}
      canSubmit={reviewerId !== '' && reason.trim() !== ''}
      error={error}
      onClose={onClose}
      onSubmit={() => {
        setBusy(true);
        setError(null);
        performanceApi
          .reassign(review.id, reviewerId, reason.trim())
          .then(() => onDone())
          .catch((cause) =>
            setError(performanceErrorMessage(cause, 'Unable to change the reviewer.')),
          )
          .finally(() => setBusy(false));
      }}
    >
      <div className="space-y-3">
        <RecordCombobox
          label="New reviewer"
          required
          source={reviewers}
          value={reviewerId}
          onChange={(id) => setReviewerId(id)}
          placeholder="Name or employee number"
          noResultsText="No matching people in the organization."
        />
        <label className="block text-sm text-slate-700">
          Reason
          <input
            className={inputClass}
            required
            value={reason}
            onChange={(e) => setReason(e.currentTarget.value)}
          />
        </label>
      </div>
    </FormDialog>
  );
}

/**
 * Batch 7B: a correction of a finalized review — any reviewer answers and/or the overall
 * rating, with the reason the audit trail keeps. The originals stay in the history.
 */
function CorrectionDialog({
  review,
  onClose,
  onDone,
}: {
  review: ReviewDetail;
  onClose(): void;
  onDone(): Promise<boolean>;
}) {
  const items = review.form
    .flatMap((section) => section.items)
    .filter((item) => answeredBy(item, 'REVIEWER'));
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [values, setValues] = useState<Record<string, Answer>>(() =>
    Object.fromEntries(
      items.map((item) => [item.id, toAnswer(item.id, review.responses[item.id]?.reviewer)]),
    ),
  );
  const [overall, setOverall] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, confirmDialog] = useConfirm();
  const chosen = items.filter((item) => selected[item.id]);
  const canSubmit = reason.trim() !== '' && (chosen.length > 0 || overall !== '');

  async function submit() {
    if (
      !(await confirm({
        title: 'Save this correction?',
        description: `${chosen.length} answer(s)${overall ? ' and the overall rating' : ''} will be corrected. The original values stay in the review history.`,
        confirmLabel: 'Save correction',
      }))
    )
      return;
    setBusy(true);
    setError(null);
    try {
      await performanceApi.correct(review.id, {
        ...(chosen.length > 0 ? { answers: chosen.map((item) => values[item.id]!) } : {}),
        ...(overall ? { overallRatingValue: Number(overall) } : {}),
        reason: reason.trim(),
      });
      await onDone();
    } catch (cause) {
      setError(performanceErrorMessage(cause, 'Unable to correct the review.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <FormDialog
      open
      size="lg"
      title="Correct review"
      description="Choose the answers to correct and give the corrected values."
      submitLabel="Correct review"
      busy={busy}
      canSubmit={canSubmit}
      error={error}
      onClose={onClose}
      onSubmit={() => void submit()}
    >
      {confirmDialog}
      <div className="space-y-4">
        {items.map((item) => (
          <fieldset key={item.id} className="space-y-2 border-t border-slate-100 pt-3">
            <legend className="text-sm font-medium text-slate-900">
              <label className="inline-flex items-center gap-2">
                <input
                  type="checkbox"
                  className={checkboxClass}
                  checked={Boolean(selected[item.id])}
                  onChange={(e) => {
                    const checked = e.currentTarget.checked;
                    setSelected((current) => ({ ...current, [item.id]: checked }));
                  }}
                />
                Correct “{item.prompt}”
              </label>
            </legend>
            {selected[item.id] && (
              <AnswerInput
                item={item}
                value={values[item.id]!}
                onChange={(patch) =>
                  setValues((current) => ({
                    ...current,
                    [item.id]: { ...current[item.id]!, ...patch },
                  }))
                }
              />
            )}
          </fieldset>
        ))}
        {review.cycle.overallRatingEnabled && (
          <label className="block max-w-sm text-sm text-slate-700">
            Corrected overall rating
            <select
              className={inputClass}
              value={overall}
              onChange={(e) => setOverall(e.currentTarget.value)}
            >
              <option value="">Keep {review.overallRating?.value ?? 'the current rating'}</option>
              {(review.cycle.overallScaleLevels ?? []).map((level) => (
                <option key={level.value} value={level.value}>
                  {level.value} — {level.label}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="block text-sm text-slate-700">
          Reason for the correction
          <input
            className={inputClass}
            required
            value={reason}
            onChange={(e) => setReason(e.currentTarget.value)}
          />
        </label>
      </div>
    </FormDialog>
  );
}
