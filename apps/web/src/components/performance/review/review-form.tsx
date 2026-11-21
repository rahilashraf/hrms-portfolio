'use client';

import { useConfirm } from '../../ui/use-confirm';
import type { FormEvent } from 'react';
import { useState } from 'react';
import type { Answer, AnswerView, FormItem, ReviewDetail } from '../../../lib/performance/types';
import { inputClass, primaryButton, secondaryButton } from '../performance-shared';
import { answeredBy, toAnswer, type Part } from './review-shared';

// Batch 10E-2: the review form, its answers and the read-only answers (moved from
// review-page.tsx unchanged).
export function ReviewForm({
  review,
  part,
  busy,
  onSave,
}: {
  review: ReviewDetail;
  part: Part | null;
  busy: boolean;
  onSave(answers: Answer[], overall: number | null | undefined, submit: boolean): Promise<boolean>;
}) {
  const key = part === 'SELF' ? 'self' : 'reviewer';
  const [draft, setDraft] = useState<Record<string, Answer>>(() => {
    if (!part) return {};
    const initial: Record<string, Answer> = {};
    for (const section of review.form) {
      for (const item of section.items) {
        if (answeredBy(item, part))
          initial[item.id] = toAnswer(item.id, review.responses[item.id]?.[key]);
      }
    }
    return initial;
  });
  const [overall, setOverall] = useState<number | null>(review.overallRating?.value ?? null);
  const showOverall = part === 'REVIEWER' && Boolean(review.cycle.overallRatingEnabled);

  const update = (itemId: string, patch: Partial<Answer>) =>
    setDraft((current) => ({ ...current, [itemId]: { ...current[itemId]!, ...patch } }));
  const [confirm, confirmDialog] = useConfirm();

  async function save(event: FormEvent, submit: boolean) {
    event.preventDefault();
    // Batch 7B: submitting locks the part, so it is confirmed first.
    if (
      submit &&
      !(await confirm({
        title: part === 'SELF' ? 'Submit your self review?' : 'Submit this review?',
        description:
          part === 'SELF'
            ? 'Your answers are shared with your reviewer and can no longer be edited (HR can reopen them).'
            : 'Your answers and rating are locked and the review goes to HR for finalization (HR can reopen it).',
        confirmLabel: part === 'SELF' ? 'Submit self review' : 'Submit review',
      }))
    )
      return;
    void onSave(Object.values(draft), showOverall ? overall : undefined, submit);
  }

  return (
    <form
      aria-label="Review form"
      className="space-y-6"
      onSubmit={(event) => void save(event, false)}
    >
      {confirmDialog}
      {review.form.map((section) => (
        <section
          key={section.id}
          aria-label={section.title}
          className="space-y-3 rounded-xl border border-slate-200 bg-white p-5"
        >
          <h2 className="text-lg font-semibold text-slate-900">{section.title}</h2>
          {section.description && <p className="text-sm text-slate-600">{section.description}</p>}
          {section.items.map((item) => {
            const answers = review.responses[item.id] ?? {};
            const editing = part !== null && answeredBy(item, part);
            return (
              <fieldset key={item.id} className="space-y-2 border-t border-slate-100 pt-3">
                <legend className="text-sm font-medium text-slate-900">
                  {item.prompt}
                  {item.required && <span className="text-rose-700"> *</span>}
                  {item.weight && (
                    <span className="ml-2 text-xs text-slate-500">weight {item.weight}%</span>
                  )}
                </legend>
                {item.helpText && <p className="text-xs text-slate-500">{item.helpText}</p>}
                {editing ? (
                  <AnswerInput
                    item={item}
                    value={draft[item.id]!}
                    onChange={(patch) => update(item.id, patch)}
                  />
                ) : null}
                <ReadAnswers item={item} answers={answers} hide={editing ? key : null} />
              </fieldset>
            );
          })}
        </section>
      ))}
      {showOverall && (
        <label className="block max-w-sm text-sm font-medium text-slate-800">
          Overall rating
          <select
            className={inputClass}
            value={overall ?? ''}
            onChange={(e) =>
              setOverall(e.currentTarget.value ? Number(e.currentTarget.value) : null)
            }
          >
            <option value="">Not rated yet</option>
            {(review.cycle.overallScaleLevels ?? []).map((level) => (
              <option key={level.value} value={level.value}>
                {level.value} — {level.label}
              </option>
            ))}
          </select>
        </label>
      )}
      {part === 'REVIEWER' && review.calculatedScore && (
        <p className="text-sm text-slate-600">
          Calculated score: <strong>{review.calculatedScore}</strong> (advisory; the overall rating
          is your decision).
        </p>
      )}
      {part && (
        <div className="flex gap-2">
          <button type="submit" className={secondaryButton} disabled={busy}>
            Save draft
          </button>
          <button
            type="button"
            className={primaryButton}
            disabled={busy}
            onClick={(event) => void save(event, true)}
          >
            {part === 'SELF' ? 'Submit self review' : 'Submit review'}
          </button>
        </div>
      )}
    </form>
  );
}

export function AnswerInput({
  item,
  value,
  onChange,
}: {
  item: FormItem;
  value: Answer;
  onChange(patch: Partial<Answer>): void;
}) {
  const id = `answer-${item.id}`;
  const comment = (
    <label className="block text-sm text-slate-700" htmlFor={`${id}-text`}>
      {['TEXT', 'GOAL_PROGRESS', 'EVIDENCE_REFERENCE'].includes(item.itemType)
        ? 'Your answer'
        : 'Comment'}
      <textarea
        id={`${id}-text`}
        aria-label={`${item.prompt} ${['TEXT', 'GOAL_PROGRESS', 'EVIDENCE_REFERENCE'].includes(item.itemType) ? 'answer' : 'comment'}`}
        className={inputClass}
        rows={item.itemType === 'TEXT' ? 4 : 2}
        value={value.textValue ?? ''}
        onChange={(e) => onChange({ textValue: e.currentTarget.value })}
      />
    </label>
  );
  return (
    <div className="space-y-2">
      {item.itemType === 'RATING' && (
        <label className="block max-w-sm text-sm text-slate-700" htmlFor={id}>
          Rating
          <select
            id={id}
            aria-label={`${item.prompt} rating`}
            className={inputClass}
            value={value.ratingValue ?? ''}
            onChange={(e) =>
              onChange({
                ratingValue: e.currentTarget.value ? Number(e.currentTarget.value) : null,
              })
            }
          >
            <option value="">Not rated</option>
            {(item.scaleLevels ?? []).map((level) => (
              <option key={level.value} value={level.value}>
                {level.value} — {level.label}
              </option>
            ))}
          </select>
        </label>
      )}
      {item.itemType === 'SCALE' && (
        <label className="block max-w-xs text-sm text-slate-700" htmlFor={id}>
          Value ({item.scaleMin}–{item.scaleMax})
          <input
            id={id}
            aria-label={`${item.prompt} value`}
            type="number"
            min={item.scaleMin ?? undefined}
            max={item.scaleMax ?? undefined}
            className={inputClass}
            value={value.numericValue ?? ''}
            onChange={(e) =>
              onChange({
                numericValue: e.currentTarget.value === '' ? null : Number(e.currentTarget.value),
              })
            }
          />
        </label>
      )}
      {item.itemType === 'YES_NO' && (
        <fieldset className="text-sm text-slate-700">
          <legend className="sr-only">{item.prompt}</legend>
          {[
            ['Yes', true],
            ['No', false],
          ].map(([text, flag]) => (
            <label key={String(text)} className="mr-4 inline-flex items-center gap-1">
              <input
                type="radio"
                name={id}
                checked={value.booleanValue === flag}
                onChange={() => onChange({ booleanValue: flag as boolean })}
              />
              {text as string}
            </label>
          ))}
        </fieldset>
      )}
      {comment}
    </div>
  );
}

function answerText(view: AnswerView) {
  const parts: string[] = [];
  if (view.ratingValue !== null) parts.push(`${view.ratingValue} — ${view.ratingLabel ?? ''}`);
  if (view.numericValue !== null) parts.push(String(view.numericValue));
  if (view.booleanValue !== null) parts.push(view.booleanValue ? 'Yes' : 'No');
  if (view.textValue) parts.push(view.textValue);
  return parts.join(' · ') || '—';
}

function ReadAnswers({
  item,
  answers,
  hide,
}: {
  item: FormItem;
  answers: { self?: AnswerView; reviewer?: AnswerView };
  hide: 'self' | 'reviewer' | null;
}) {
  const rows = (
    [
      ['self', 'Employee', answers.self],
      ['reviewer', 'Reviewer', answers.reviewer],
    ] as const
  ).filter(([key, , view]) => key !== hide && view);
  if (rows.length === 0) return null;
  return (
    <dl className="space-y-1 text-sm">
      {rows.map(([key, title, view]) => (
        <div key={key}>
          <dt className="inline font-medium text-slate-600">{title}: </dt>
          <dd className="inline whitespace-pre-wrap text-slate-800">
            {answerText(view!)}
            {view!.recordType === 'CORRECTION' && (
              <span className="ml-1 text-xs text-amber-800">(corrected)</span>
            )}
            {!view!.submitted && <span className="ml-1 text-xs text-slate-500">(draft)</span>}
          </dd>
        </div>
      ))}
      {item.competency?.name && (
        <p className="text-xs text-slate-500">Competency: {item.competency.name}</p>
      )}
    </dl>
  );
}
