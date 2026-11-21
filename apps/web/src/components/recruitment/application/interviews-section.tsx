'use client';

import Link from 'next/link';
import type { FormEvent } from 'react';
import { useMemo, useState } from 'react';
import { recruitmentApi } from '../../../lib/recruitment/api';
import { recruitmentErrorMessage } from '../../../lib/recruitment/errors';
import type {
  ApplicationDetail,
  Feedback,
  Interview,
  InterviewType,
} from '../../../lib/recruitment/types';
import {
  dateTimeText,
  EmptyState,
  Field,
  inputClass,
  InterviewStatusBadge,
  isHttpsUrl,
  label,
  localDateTimeToIso,
  primaryButton,
  SafeLink,
  secondaryButton,
  Section,
} from '../recruitment-shared';
import { ConfirmButton } from '../../ui/confirm-button';
import type { PickerOption } from '../../../lib/pickers/sources';
import { RecordCombobox } from '../../ui/record-combobox';
import { recruitmentOptionSource } from '../../../lib/recruitment/pickers';
import { Run } from './application-shared';

// Batch 10E-1: interviews, feedback, scheduling and rescheduling (moved from
// application-page.tsx unchanged).
const INTERVIEW_TYPES: InterviewType[] = ['PHONE', 'VIDEO', 'IN_PERSON', 'PANEL', 'OTHER'];

export function InterviewsSection({
  application,
  busy,
  run,
}: {
  application: ApplicationDetail;
  busy: boolean;
  run: Run;
}) {
  const { view, actions } = application;
  return (
    <Section id="interviews" title={view === 'INTERVIEWER' ? 'My interviews' : 'Interviews'}>
      {view === 'INTERVIEWER' && (
        <p className="text-sm text-slate-600">
          Write and submit your feedback from{' '}
          <Link href="/interviews" className="text-indigo-700 underline">
            My interviews
          </Link>
          .
        </p>
      )}
      {application.interviews.length === 0 ? (
        <EmptyState>No interviews scheduled.</EmptyState>
      ) : (
        <ul className="space-y-3">
          {application.interviews.map((interview) => (
            <InterviewCard
              key={interview.id}
              interview={interview}
              organizationId={application.organization.id}
              canManage={view === 'FULL' && actions.canManage}
              busy={busy}
              run={run}
            />
          ))}
        </ul>
      )}
      {actions.canScheduleInterview && (
        <ScheduleForm
          applicationId={application.id}
          organizationId={application.organization.id}
          busy={busy}
          run={run}
        />
      )}
    </Section>
  );
}

function InterviewCard({
  interview,
  organizationId,
  canManage,
  busy,
  run,
}: {
  interview: Interview;
  organizationId: string;
  canManage: boolean;
  busy: boolean;
  run: Run;
}) {
  const [interviewer, setInterviewer] = useState('');
  const [rescheduling, setRescheduling] = useState(false);
  const [history, setHistory] = useState<Feedback[] | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  // Batch 7A: staff of the organization (recruitment.manage; no role.assign needed).
  const interviewers = useMemo(
    () => recruitmentOptionSource(organizationId, 'staff'),
    [organizationId],
  );
  async function toggleHistory() {
    if (history) {
      setHistory(null);
      return;
    }
    setHistoryError(null);
    try {
      setHistory((await recruitmentApi.feedbackHistory(interview.id)).items);
    } catch (cause) {
      setHistoryError(recruitmentErrorMessage(cause, 'Unable to load the feedback history.'));
    }
  }
  const emailOf = (userId: string) =>
    interview.interviewers.find((row) => row.userId === userId)?.email ?? userId;
  const submitted = interview.feedback.filter((row) => row.status === 'SUBMITTED');
  const live = interview.status === 'SCHEDULED' || interview.status === 'COMPLETED';
  return (
    <li
      aria-label={`Interview ${interview.title}`}
      className="space-y-2 rounded-lg border border-slate-200 p-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-slate-900">{interview.title}</span>
        <InterviewStatusBadge status={interview.status} />
        {interview.feedbackOverdue && (
          <span className="text-xs font-medium text-amber-800">Feedback overdue</span>
        )}
      </div>
      <p className="text-sm text-slate-600">
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
      {interview.cancellationReason && (
        <p className="text-sm text-slate-600">Cancelled: {interview.cancellationReason}</p>
      )}
      <ul className="flex flex-wrap gap-2 text-xs text-slate-700">
        {interview.interviewers.map((row) => (
          <li key={row.userId} className="rounded-full bg-slate-100 px-2 py-1">
            {row.email} {row.feedbackSubmitted ? '✓ feedback' : '· feedback pending'}
            {canManage && live && (
              <ConfirmButton
                // Batch 10E-1: at least 24 × 24 px (was 6 × 16), with the brand focus ring.
                className="ml-1 inline-flex min-h-6 min-w-6 items-center justify-center rounded text-rose-700 hover:bg-rose-50 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[var(--hrms-accent-text)]"
                aria-label={`Remove interviewer ${row.email}`}
                disabled={busy}
                confirm={{
                  title: `Remove ${row.email} from this interview?`,
                  description: 'They are no longer asked for feedback on it.',
                  confirmLabel: 'Remove interviewer',
                }}
                onConfirm={() =>
                  void run(
                    () => recruitmentApi.removeInterviewer(interview.id, row.userId),
                    'Interviewer removed.',
                  )
                }
              >
                ×
              </ConfirmButton>
            )}
          </li>
        ))}
      </ul>
      {interview.feedback.length > 0 && (
        <div className="space-y-2">
          {interview.feedback.map((feedback) => (
            <div
              key={feedback.id}
              aria-label={`Feedback from ${emailOf(feedback.interviewerUserId)}`}
              className="rounded-lg bg-slate-50 p-2 text-sm"
            >
              <p className="font-medium text-slate-900">
                {emailOf(feedback.interviewerUserId)} ·{' '}
                {feedback.status === 'SUBMITTED' ? 'Submitted' : 'Draft'}
                {feedback.recommendation ? ` · ${label(feedback.recommendation)}` : ''}
                {feedback.rating !== null ? ` · Rating ${feedback.rating} / 5` : ''}
              </p>
              {feedback.strengths && <p>Strengths: {feedback.strengths}</p>}
              {feedback.concerns && <p>Concerns: {feedback.concerns}</p>}
              {feedback.comments && <p>Comments: {feedback.comments}</p>}
            </div>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-end gap-2">
        <button
          type="button"
          className={secondaryButton}
          aria-expanded={history !== null}
          onClick={() => void toggleHistory()}
        >
          {history ? 'Hide feedback history' : 'Feedback history'}
        </button>
        {canManage && interview.status === 'SCHEDULED' && (
          <>
            <button
              type="button"
              className={secondaryButton}
              aria-expanded={rescheduling}
              onClick={() => setRescheduling(!rescheduling)}
            >
              Reschedule
            </button>
            <button
              type="button"
              className={secondaryButton}
              disabled={busy}
              onClick={() =>
                void run(
                  () => recruitmentApi.completeInterview(interview.id),
                  'Interview marked complete.',
                )
              }
            >
              Mark complete
            </button>
            <ConfirmButton
              className={secondaryButton}
              disabled={busy}
              confirm={{
                title: `Mark ${interview.title} as a no-show?`,
                description:
                  'The candidate did not attend. The interview cannot be completed after.',
                confirmLabel: 'Mark no-show',
              }}
              onConfirm={() =>
                void run(
                  () => recruitmentApi.noShowInterview(interview.id),
                  'Interview marked as a no-show.',
                )
              }
            >
              No-show
            </ConfirmButton>
            <ConfirmButton
              className={secondaryButton}
              disabled={busy}
              confirm={{
                title: `Cancel ${interview.title}?`,
                description: 'The interviewers are no longer asked for feedback on it.',
                confirmLabel: 'Cancel interview',
                cancelLabel: 'Keep interview',
                destructive: true,
                reason: { label: 'Reason', required: true },
              }}
              onConfirm={(reason) =>
                void run(
                  () => recruitmentApi.cancelInterview(interview.id, reason),
                  'Interview cancelled.',
                )
              }
            >
              Cancel interview
            </ConfirmButton>
          </>
        )}
        {canManage &&
          submitted.map((feedback) => (
            <ConfirmButton
              key={feedback.id}
              className={secondaryButton}
              disabled={busy}
              confirm={{
                title: `Reopen feedback from ${emailOf(feedback.interviewerUserId)}?`,
                description:
                  'The submitted revision is kept in the history and a new draft revision starts.',
                confirmLabel: 'Reopen feedback',
                reason: { label: 'Reason', required: true },
              }}
              onConfirm={(reason) =>
                void run(
                  () => recruitmentApi.reopenFeedback(feedback.id, reason),
                  'Feedback reopened.',
                )
              }
            >
              Reopen feedback from {emailOf(feedback.interviewerUserId)}
            </ConfirmButton>
          ))}
      </div>
      {historyError && (
        <p role="alert" className="text-sm text-rose-800">
          {historyError}
        </p>
      )}
      {history && (
        <section aria-label={`Feedback history of ${interview.title}`} className="space-y-2">
          {history.length === 0 ? (
            <p className="text-sm text-slate-500">No feedback yet.</p>
          ) : (
            <ol className="space-y-2 text-sm">
              {history.map((feedback) => (
                <li key={feedback.id} className="rounded-lg border border-slate-200 p-2">
                  <p className="font-medium text-slate-900">
                    {emailOf(feedback.interviewerUserId)} · Revision {feedback.revision} ·{' '}
                    {feedback.status === 'SUBMITTED' ? 'Submitted' : 'Draft'}
                    {feedback.submittedAt ? ` ${dateTimeText(feedback.submittedAt)}` : ''}
                    {feedback.supersededAt ? ' · Superseded' : ''}
                  </p>
                  {feedback.recommendation && (
                    <p>Recommendation: {label(feedback.recommendation)}</p>
                  )}
                  {feedback.rating !== null && <p>Rating {feedback.rating} / 5</p>}
                  {feedback.strengths && <p>Strengths: {feedback.strengths}</p>}
                  {feedback.concerns && <p>Concerns: {feedback.concerns}</p>}
                  {feedback.comments && <p>Comments: {feedback.comments}</p>}
                  {feedback.reopenReason && <p>Reopened: {feedback.reopenReason}</p>}
                </li>
              ))}
            </ol>
          )}
        </section>
      )}
      {rescheduling && (
        <RescheduleForm
          interview={interview}
          busy={busy}
          run={run}
          onDone={() => setRescheduling(false)}
        />
      )}
      {canManage && live && (
        <div className="flex flex-wrap items-end gap-2">
          <RecordCombobox
            className="min-w-64"
            label={`Add interviewer to ${interview.title}`}
            source={interviewers}
            value={interviewer}
            onChange={(id) => setInterviewer(id)}
            placeholder="Name or employee number"
            noResultsText="No matching staff of the organization."
          />
          <button
            type="button"
            className={secondaryButton}
            disabled={busy || !interviewer.trim()}
            onClick={() =>
              void run(
                () => recruitmentApi.addInterviewer(interview.id, interviewer.trim()),
                'Interviewer added.',
              )
            }
          >
            Add interviewer
          </button>
        </div>
      )}
    </li>
  );
}

/** ISO instant → the value of a datetime-local input, in the browser's time zone. */
function isoToLocalInput(iso: string): string {
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

/** Batch 7A — move a scheduled interview (time, length, place); interviewers are kept. */
function RescheduleForm({
  interview,
  busy,
  run,
  onDone,
}: {
  interview: Interview;
  busy: boolean;
  run: Run;
  onDone(): void;
}) {
  const [form, setForm] = useState({
    start: isoToLocalInput(interview.scheduledStart),
    duration: String(interview.durationMinutes),
    location: interview.location ?? '',
    meetingUrl: interview.meetingUrl ?? '',
  });
  const urlInvalid = form.meetingUrl.trim() !== '' && !isHttpsUrl(form.meetingUrl.trim());
  return (
    <form
      aria-label={`Reschedule ${interview.title}`}
      className="grid grid-cols-1 gap-3 rounded-lg bg-slate-50 p-3 sm:grid-cols-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (urlInvalid) return;
        void run(
          () =>
            recruitmentApi.rescheduleInterview(interview.id, {
              scheduledStart: localDateTimeToIso(form.start),
              durationMinutes: Number(form.duration),
              location: form.location.trim() || null,
              meetingUrl: form.meetingUrl.trim() || null,
            }),
          'Interview rescheduled.',
        ).then((ok) => ok && onDone());
      }}
    >
      <Field label="New start">
        <input
          className={inputClass}
          type="datetime-local"
          required
          value={form.start}
          onChange={(e) => setForm({ ...form, start: e.currentTarget.value })}
        />
      </Field>
      <Field label="New duration (minutes)">
        <input
          className={inputClass}
          type="number"
          min={5}
          max={1440}
          required
          value={form.duration}
          onChange={(e) => setForm({ ...form, duration: e.currentTarget.value })}
        />
      </Field>
      <Field label="New location">
        <input
          className={inputClass}
          value={form.location}
          onChange={(e) => setForm({ ...form, location: e.currentTarget.value })}
        />
      </Field>
      <Field label="New meeting link (https)">
        <input
          className={inputClass}
          type="url"
          value={form.meetingUrl}
          onChange={(e) => setForm({ ...form, meetingUrl: e.currentTarget.value })}
        />
      </Field>
      {urlInvalid && (
        <p role="alert" className="text-sm text-rose-800 sm:col-span-2">
          Meeting links must start with https://.
        </p>
      )}
      <div className="flex gap-2 sm:col-span-2">
        <button type="submit" className={primaryButton} disabled={busy || urlInvalid}>
          Save new time
        </button>
        <button type="button" className={secondaryButton} onClick={onDone}>
          Keep current time
        </button>
      </div>
    </form>
  );
}

function ScheduleForm({
  applicationId,
  organizationId,
  busy,
  run,
}: {
  applicationId: string;
  organizationId: string;
  busy: boolean;
  run: Run;
}) {
  const [form, setForm] = useState({
    type: 'VIDEO' as InterviewType,
    title: '',
    start: '',
    duration: '60',
    location: '',
    meetingUrl: '',
  });
  const [picked, setPicked] = useState<PickerOption[]>([]);
  // Batch 7A: staff of the organization from GET /recruitment/options (recruitment.manage).
  const interviewerSource = useMemo(
    () => recruitmentOptionSource(organizationId, 'staff'),
    [organizationId],
  );
  const urlInvalid = form.meetingUrl.trim() !== '' && !isHttpsUrl(form.meetingUrl.trim());
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (urlInvalid) return;
    await run(
      () =>
        recruitmentApi.scheduleInterview(applicationId, {
          type: form.type,
          title: form.title.trim(),
          scheduledStart: localDateTimeToIso(form.start),
          durationMinutes: Number(form.duration),
          location: form.location.trim() || null,
          meetingUrl: form.meetingUrl.trim() || null,
          interviewerUserIds: [...new Set(picked.map((option) => option.id))],
        }),
      'Interview scheduled.',
    );
  }
  return (
    <form
      aria-label="Schedule interview"
      className="grid grid-cols-1 gap-3 border-t border-slate-100 pt-3 sm:grid-cols-3"
      onSubmit={(event) => void submit(event)}
    >
      <Field label="Interview type">
        <select
          className={inputClass}
          value={form.type}
          onChange={(e) => setForm({ ...form, type: e.currentTarget.value as InterviewType })}
        >
          {INTERVIEW_TYPES.map((type) => (
            <option key={type} value={type}>
              {label(type)}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Interview title">
        <input
          className={inputClass}
          required
          value={form.title}
          onChange={(e) => setForm({ ...form, title: e.currentTarget.value })}
        />
      </Field>
      <Field label="Starts at">
        <input
          className={inputClass}
          type="datetime-local"
          required
          value={form.start}
          onChange={(e) => setForm({ ...form, start: e.currentTarget.value })}
        />
      </Field>
      <Field label="Duration (minutes)">
        <input
          className={inputClass}
          type="number"
          min={5}
          max={1440}
          required
          value={form.duration}
          onChange={(e) => setForm({ ...form, duration: e.currentTarget.value })}
        />
      </Field>
      <Field label="Location">
        <input
          className={inputClass}
          value={form.location}
          onChange={(e) => setForm({ ...form, location: e.currentTarget.value })}
        />
      </Field>
      <Field label="Meeting link (https)">
        <input
          className={inputClass}
          type="url"
          value={form.meetingUrl}
          onChange={(e) => setForm({ ...form, meetingUrl: e.currentTarget.value })}
        />
      </Field>
      <div className="space-y-2 sm:col-span-3">
        <RecordCombobox
          label="Add an interviewer"
          source={interviewerSource}
          value=""
          onChange={(_id, option) => {
            if (option && !picked.some((item) => item.id === option.id))
              setPicked([...picked, option]);
          }}
          placeholder="Name or employee number"
          noResultsText="No matching staff of the organization."
        />
        {picked.length > 0 && (
          <ul aria-label="Interviewers" className="flex flex-wrap gap-2">
            {picked.map((option) => (
              <li
                key={option.id}
                className="flex items-center gap-1 rounded-full bg-slate-100 px-3 py-1 text-sm"
              >
                {option.label}
                <button
                  type="button"
                  aria-label={`Remove ${option.label}`}
                  className="inline-flex min-h-6 min-w-6 items-center justify-center rounded-full px-1 text-slate-700 hover:bg-slate-200 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[var(--hrms-accent-text)]"
                  onClick={() => setPicked(picked.filter((item) => item.id !== option.id))}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex items-end">
        <button type="submit" className={primaryButton} disabled={busy || urlInvalid}>
          Schedule interview
        </button>
      </div>
      {urlInvalid && (
        <p role="alert" className="text-sm text-rose-800 sm:col-span-3">
          Meeting links must start with https://.
        </p>
      )}
    </form>
  );
}
