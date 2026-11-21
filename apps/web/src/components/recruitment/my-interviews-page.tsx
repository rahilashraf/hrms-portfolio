'use client';

import { PageContainer } from '../ui/page-container';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { PageHeader, ErrorBanner, FeedbackMessage } from '../organization/shared';
import { recruitmentApi, type FeedbackInput } from '../../lib/recruitment/api';
import { recruitmentErrorMessage } from '../../lib/recruitment/errors';
import type { MyInterview, Recommendation } from '../../lib/recruitment/types';
import {
  dateTimeText,
  EmptyState,
  Field,
  inputClass,
  InterviewStatusBadge,
  isHttpsUrl,
  label,
  primaryButton,
  RECOMMENDATIONS,
  SafeLink,
  secondaryButton,
} from './recruitment-shared';

type Run = (action: () => Promise<unknown>, message: string) => Promise<boolean>;

/**
 * Self-service "My interviews": the interviews the user is an interviewer on, with their own
 * feedback (a draft until submitted; submitted feedback is locked unless a recruiter reopens it).
 */
export function MyInterviewsPage() {
  const [items, setItems] = useState<MyInterview[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setItems((await recruitmentApi.myInterviews()).items);
      setError(null);
    } catch (cause) {
      setError(recruitmentErrorMessage(cause, 'Unable to load your interviews.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const run: Run = async (action, message) => {
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      await action();
      await load();
      setSuccess(message);
      return true;
    } catch (cause) {
      setError(recruitmentErrorMessage(cause, 'Unable to save your feedback.'));
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Self-service"
        title="My interviews"
        description="Interviews you are on and your feedback. Your feedback is a draft until you submit it; submitted feedback is locked."
      />
      <div className="mt-8 space-y-4">
        {error && <ErrorBanner>{error}</ErrorBanner>}
        {success && <FeedbackMessage>{success}</FeedbackMessage>}
        {loading ? (
          <p role="status" className="text-sm text-slate-600">
            Loading interviews…
          </p>
        ) : items.length === 0 ? (
          <EmptyState>You have no interviews assigned.</EmptyState>
        ) : (
          <ul className="space-y-4">
            {items.map((interview) => (
              <InterviewItem
                key={`${interview.id}-${interview.myFeedback?.id ?? 'new'}-${interview.myFeedback?.status ?? ''}`}
                interview={interview}
                busy={busy}
                run={run}
              />
            ))}
          </ul>
        )}
      </div>
    </PageContainer>
  );
}

function InterviewItem({
  interview,
  busy,
  run,
}: {
  interview: MyInterview;
  busy: boolean;
  run: Run;
}) {
  const mine = interview.myFeedback;
  const locked = mine?.status === 'SUBMITTED';
  const canWrite = !locked && interview.status !== 'CANCELLED' && interview.status !== 'NO_SHOW';
  return (
    <li
      aria-label={`Interview ${interview.title} with ${interview.candidate.displayName}`}
      className="space-y-3 rounded-xl border border-slate-200 bg-white p-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-base font-semibold text-slate-900">
          {interview.title}: {interview.candidate.displayName}
        </h2>
        <InterviewStatusBadge status={interview.status} />
        {interview.feedbackOverdue && !locked && (
          <span className="text-xs font-medium text-amber-800">Feedback overdue</span>
        )}
      </div>
      <p className="text-sm text-slate-600">
        {interview.opening.title} ({interview.opening.code}) · {interview.stageName} ·{' '}
        {label(interview.type)} · {dateTimeText(interview.scheduledStart)} ·{' '}
        {interview.durationMinutes} min
        {interview.location ? ` · ${interview.location}` : ''}
        {isHttpsUrl(interview.meetingUrl) && (
          <>
            {' · '}
            <SafeLink href={interview.meetingUrl}>Meeting link</SafeLink>
          </>
        )}
      </p>
      <p className="text-sm">
        <Link
          className="text-indigo-700 underline"
          href={`/recruitment/applications/${interview.applicationId}`}
        >
          Application and documents
        </Link>
        {interview.feedbackDueAt && (
          <span className="ml-3 text-slate-500">
            Feedback due {dateTimeText(interview.feedbackDueAt)}
          </span>
        )}
      </p>
      {mine?.reopenReason && !locked && (
        <p className="text-sm text-amber-800">Reopened: {mine.reopenReason}</p>
      )}
      {locked ? (
        <div
          aria-label="My submitted feedback"
          className="space-y-1 rounded-lg bg-slate-50 p-3 text-sm text-slate-800"
        >
          <p className="font-medium">Submitted {dateTimeText(mine.submittedAt)} · locked</p>
          <p>Recommendation: {label(mine.recommendation)}</p>
          <p>Rating: {mine.rating !== null ? `${mine.rating} / 5` : '—'}</p>
          {mine.strengths && <p>Strengths: {mine.strengths}</p>}
          {mine.concerns && <p>Concerns: {mine.concerns}</p>}
          {mine.comments && <p>Comments: {mine.comments}</p>}
        </div>
      ) : canWrite ? (
        <FeedbackForm interview={interview} busy={busy} run={run} />
      ) : (
        <p className="text-sm text-slate-500">This interview did not take place.</p>
      )}
    </li>
  );
}

function FeedbackForm({
  interview,
  busy,
  run,
}: {
  interview: MyInterview;
  busy: boolean;
  run: Run;
}) {
  const mine = interview.myFeedback;
  const [form, setForm] = useState({
    recommendation: (mine?.recommendation ?? '') as Recommendation | '',
    rating: mine?.rating ? String(mine.rating) : '',
    strengths: mine?.strengths ?? '',
    concerns: mine?.concerns ?? '',
    comments: mine?.comments ?? '',
  });
  const input = (): FeedbackInput => ({
    recommendation: form.recommendation || null,
    rating: form.rating ? Number(form.rating) : null,
    strengths: form.strengths.trim() || null,
    concerns: form.concerns.trim() || null,
    comments: form.comments.trim() || null,
  });
  return (
    <form
      aria-label="Interview feedback"
      className="grid grid-cols-1 gap-3 sm:grid-cols-2"
      onSubmit={(event) => {
        event.preventDefault();
        void run(() => recruitmentApi.submitFeedback(interview.id, input()), 'Feedback submitted.');
      }}
    >
      <Field label="Recommendation">
        <select
          className={inputClass}
          value={form.recommendation}
          onChange={(e) =>
            setForm({ ...form, recommendation: e.currentTarget.value as Recommendation | '' })
          }
        >
          <option value="">Choose</option>
          {RECOMMENDATIONS.map((value) => (
            <option key={value} value={value}>
              {label(value)}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Rating (1–5)">
        <select
          className={inputClass}
          value={form.rating}
          onChange={(e) => setForm({ ...form, rating: e.currentTarget.value })}
        >
          <option value="">Choose</option>
          {[1, 2, 3, 4, 5].map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </Field>
      {(
        [
          ['strengths', 'Strengths'],
          ['concerns', 'Concerns'],
          ['comments', 'Comments'],
        ] as const
      ).map(([key, text]) => (
        <div key={key} className="sm:col-span-2">
          <Field label={text}>
            <textarea
              className={inputClass}
              rows={2}
              value={form[key]}
              onChange={(e) => setForm({ ...form, [key]: e.currentTarget.value })}
            />
          </Field>
        </div>
      ))}
      <div className="flex gap-2 sm:col-span-2">
        <button
          type="button"
          className={secondaryButton}
          disabled={busy}
          onClick={() =>
            void run(() => recruitmentApi.saveFeedback(interview.id, input()), 'Draft saved.')
          }
        >
          Save draft
        </button>
        <button type="submit" className={primaryButton} disabled={busy}>
          Submit feedback
        </button>
      </div>
    </form>
  );
}
