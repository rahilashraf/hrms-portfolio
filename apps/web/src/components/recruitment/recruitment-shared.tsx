'use client';

import type { ReactNode } from 'react';
import { useState } from 'react';
import { formatDateOnly, label } from '../../lib/payroll/format';
import type {
  Activity,
  ApplicationStatus,
  CandidateDocument,
  DocumentKind,
  DocumentProvider,
  DocumentReferenceInput,
  InterviewStatus,
  OfferStatus,
  OpeningStatus,
  Recommendation,
} from '../../lib/recruitment/types';
import { EmptyState, inputClass, primaryButton, secondaryButton } from '../payroll/payroll-shared';
import { StatusBadge } from '../ui/status-badge';
import type { Tone } from '../ui/tokens';

export { EmptyState, inputClass, primaryButton, secondaryButton } from '../payroll/payroll-shared';
export { formatDateOnly, label };

/**
 * Batch 10E-1 — opening and interview statuses use the shared `StatusBadge` with a tone per
 * status (the words are always shown). Opening: draft and closed are neutral, open is in
 * progress, on hold waits, filled is done and cancelled is refused. Interview: scheduled is in
 * progress, completed is done, cancelled is neutral and a no-show is a warning.
 */
const OPENING_TONES: Record<OpeningStatus, Tone> = {
  DRAFT: 'neutral',
  OPEN: 'info',
  ON_HOLD: 'warning',
  FILLED: 'success',
  CLOSED: 'neutral',
  CANCELLED: 'danger',
};

export function OpeningStatusBadge({ status }: { status: OpeningStatus }) {
  return <StatusBadge status={status} label={label(status)} tone={OPENING_TONES[status]} />;
}

/**
 * Application and offer statuses keep their own palettes: they are consecutive steps of one
 * process (active → offered → hired; draft → approved → sent → accepted) that the shared five
 * tones would merge (offered and active would both be "info", approved, sent and accepted all
 * "success"). Every badge shows its words.
 */
const badge = 'inline-flex rounded-full px-2.5 py-1 text-xs font-medium';

const APPLICATION_STYLES: Record<ApplicationStatus, string> = {
  ACTIVE: 'bg-sky-50 text-sky-800',
  OFFERED: 'bg-indigo-50 text-indigo-800',
  HIRED: 'bg-emerald-50 text-emerald-800',
  WITHDRAWN: 'bg-slate-200 text-slate-700',
  REJECTED: 'bg-rose-50 text-rose-800',
};

export function ApplicationStatusBadge({ status }: { status: ApplicationStatus }) {
  return <span className={`${badge} ${APPLICATION_STYLES[status]}`}>{label(status)}</span>;
}

const OFFER_STYLES: Record<OfferStatus, string> = {
  DRAFT: 'bg-slate-100 text-slate-700',
  APPROVED: 'bg-sky-50 text-sky-800',
  SENT: 'bg-indigo-50 text-indigo-800',
  ACCEPTED: 'bg-emerald-50 text-emerald-800',
  DECLINED: 'bg-rose-50 text-rose-800',
  WITHDRAWN: 'bg-slate-200 text-slate-700',
  EXPIRED: 'bg-amber-50 text-amber-800',
};

export function OfferStatusBadge({ status }: { status: OfferStatus }) {
  return <span className={`${badge} ${OFFER_STYLES[status]}`}>{label(status)}</span>;
}

const INTERVIEW_TONES: Record<InterviewStatus, Tone> = {
  SCHEDULED: 'info',
  COMPLETED: 'success',
  CANCELLED: 'neutral',
  NO_SHOW: 'warning',
};

export function InterviewStatusBadge({ status }: { status: InterviewStatus }) {
  return <StatusBadge status={status} label={label(status)} tone={INTERVIEW_TONES[status]} />;
}

export const RECOMMENDATIONS: Recommendation[] = [
  'STRONG_YES',
  'YES',
  'NO',
  'STRONG_NO',
  'NO_DECISION',
];

export const DOCUMENT_KINDS: DocumentKind[] = [
  'RESUME',
  'COVER_LETTER',
  'CERTIFICATE',
  'REFERENCE',
  'PORTFOLIO',
  'OTHER',
];

export const DOCUMENT_PROVIDER_LABELS: Record<DocumentProvider, string> = {
  EXTERNAL_URL: 'External link',
  GOOGLE_DRIVE: 'Google Drive',
  MANUAL_REFERENCE: 'Manual reference',
};

export const EMPLOYMENT_TYPES = ['FULL_TIME', 'PART_TIME', 'CASUAL', 'CONTRACT'] as const;

/** "Oct 6, 2026, 9:30 AM" in the viewer's time zone, or an em dash. */
export function dateTimeText(value: string | null | undefined) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

/** A `datetime-local` value (the viewer's local time) as an ISO-8601 instant. */
export function localDateTimeToIso(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}

/** External links are rendered only for https URLs (never javascript:, data: or plain http). */
export function isHttpsUrl(value: string | null | undefined): value is string {
  if (!value) return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

export function SafeLink({ href, children }: { href: string | null; children: ReactNode }) {
  if (!isHttpsUrl(href)) return <span>{children}</span>;
  return (
    <a className="text-indigo-700 underline" href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

export function yesNo(value: boolean | null | undefined) {
  return value === null || value === undefined ? 'Not recorded' : value ? 'Yes' : 'No';
}

export function Field({ label: text, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block text-sm font-medium text-slate-800">
      {text}
      {children}
    </label>
  );
}

export function Section({
  title,
  children,
  actions,
  id,
}: {
  title: string;
  children: ReactNode;
  actions?: ReactNode;
  /** Anchor for in-page workflow links (e.g. #interviews). */
  id?: string;
}) {
  return (
    <section
      id={id}
      aria-label={title}
      className="space-y-3 rounded-xl border border-slate-200 bg-white p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-slate-900">{title}</h2>
        {actions}
      </div>
      {children}
    </section>
  );
}

type Run = (action: () => Promise<unknown>, message: string) => Promise<boolean>;

/** Candidate document references (links / file ids, never file contents). */
export function DocumentsSection({
  documents,
  canManage,
  busy,
  run,
  onAdd,
  onRemove,
}: {
  documents: CandidateDocument[];
  canManage: boolean;
  busy: boolean;
  run: Run;
  onAdd(input: DocumentReferenceInput): Promise<unknown>;
  onRemove(documentId: string, reason: string): Promise<unknown>;
}) {
  const [removing, setRemoving] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [form, setForm] = useState({
    kind: 'RESUME' as DocumentKind,
    title: '',
    provider: 'EXTERNAL_URL' as DocumentProvider,
    externalUrl: '',
    externalFileId: '',
  });
  const urlInvalid = form.externalUrl.trim() !== '' && !isHttpsUrl(form.externalUrl.trim());
  return (
    <Section title="Documents">
      {documents.length === 0 ? (
        <EmptyState>No documents.</EmptyState>
      ) : (
        <ul className="divide-y divide-slate-100 text-sm">
          {documents.map((document) => (
            <li key={document.id} className="flex flex-wrap items-center gap-2 py-2">
              <span className="font-medium text-slate-900">
                <SafeLink href={document.externalUrl}>{document.title}</SafeLink>
              </span>
              <span className="text-xs text-slate-500">
                {label(document.kind)} · {DOCUMENT_PROVIDER_LABELS[document.provider]}
                {document.externalFileId ? ` · ${document.externalFileId}` : ''}
                {document.fileName ? ` · ${document.fileName}` : ''}
              </span>
              {canManage && (
                <button
                  type="button"
                  className={`${secondaryButton} ml-auto`}
                  aria-label={`Remove ${document.title}`}
                  onClick={() => {
                    setRemoving(removing === document.id ? null : document.id);
                    setReason('');
                  }}
                >
                  Remove
                </button>
              )}
              {removing === document.id && (
                <div className="flex w-full flex-wrap items-end gap-2">
                  <Field label="Reason for removing">
                    <input
                      className={inputClass}
                      value={reason}
                      onChange={(e) => setReason(e.currentTarget.value)}
                    />
                  </Field>
                  <button
                    type="button"
                    className={secondaryButton}
                    disabled={busy || !reason.trim()}
                    onClick={() =>
                      void run(async () => {
                        await onRemove(document.id, reason.trim());
                        setRemoving(null);
                      }, 'Document removed.')
                    }
                  >
                    Confirm removal
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {canManage && (
        <form
          aria-label="Add document"
          className="grid grid-cols-1 gap-3 border-t border-slate-100 pt-3 sm:grid-cols-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (urlInvalid) return;
            void run(
              () =>
                onAdd({
                  kind: form.kind,
                  title: form.title.trim(),
                  provider: form.provider,
                  externalUrl: form.externalUrl.trim() || null,
                  externalFileId: form.externalFileId.trim() || null,
                }),
              'Document added.',
            );
          }}
        >
          <Field label="Document kind">
            <select
              className={inputClass}
              value={form.kind}
              onChange={(e) => setForm({ ...form, kind: e.currentTarget.value as DocumentKind })}
            >
              {DOCUMENT_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {label(kind)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Document title">
            <input
              className={inputClass}
              required
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.currentTarget.value })}
            />
          </Field>
          <Field label="Stored in">
            <select
              className={inputClass}
              value={form.provider}
              onChange={(e) =>
                setForm({ ...form, provider: e.currentTarget.value as DocumentProvider })
              }
            >
              {(Object.keys(DOCUMENT_PROVIDER_LABELS) as DocumentProvider[]).map((provider) => (
                <option key={provider} value={provider}>
                  {DOCUMENT_PROVIDER_LABELS[provider]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Link (https)">
            <input
              className={inputClass}
              type="url"
              value={form.externalUrl}
              onChange={(e) => setForm({ ...form, externalUrl: e.currentTarget.value })}
            />
          </Field>
          <Field label="File ID">
            <input
              className={inputClass}
              value={form.externalFileId}
              onChange={(e) => setForm({ ...form, externalFileId: e.currentTarget.value })}
            />
          </Field>
          <div className="flex items-end">
            <button type="submit" className={primaryButton} disabled={busy || urlInvalid}>
              Add document
            </button>
          </div>
          {urlInvalid && (
            <p role="alert" className="text-sm text-rose-800 sm:col-span-3">
              Document links must start with https://.
            </p>
          )}
        </form>
      )}
    </Section>
  );
}

export function ActivityTimeline({ activity }: { activity: Activity[] }) {
  return (
    <Section title="Activity">
      {activity.length === 0 ? (
        <EmptyState>No activity yet.</EmptyState>
      ) : (
        <ol className="space-y-2 text-sm">
          {activity.map((item) => (
            <li key={item.id} className="flex flex-wrap gap-x-3">
              <span className="text-slate-500">{dateTimeText(item.occurredAt)}</span>
              <span className="text-slate-900">{item.summary}</span>
            </li>
          ))}
        </ol>
      )}
    </Section>
  );
}
