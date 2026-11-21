import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { domainError } from '../common/domain-support.js';
import type {
  JobOpeningStatus,
  RecruitmentApplicationStatus,
  RecruitmentDocumentKind,
  RecruitmentDocumentProvider,
  RecruitmentOfferStatus,
  RecruitmentStageKind,
} from '../generated/prisma/client.js';

/**
 * Phase 13 — pure Recruitment domain rules (no Nest services, no database). Each rule mirrors,
 * and fails before, the matching constraint or trigger of the phase13 recruitment migration.
 */

const CODE = /^[A-Z0-9_-]{2,64}$/;
export const MAX_TEXT = 10_000;
export const MAX_ANSWERS = 60;

export function invalid(
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): never {
  throw new BadRequestException(domainError(400, code, message, extra));
}

/** Requisition, stage and intake source codes. */
export function parseRecruitmentCode(value: unknown, field = 'code'): string {
  const code = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (!CODE.test(code)) {
    invalid(
      'RECRUITMENT_CODE_INVALID',
      `${field} must be 2–64 characters: letters, digits, "_" or "-" (e.g. "REQ-2026-014").`,
    );
  }
  return code;
}

/** Trimmed non-empty text, or null when optional and blank. */
export function parseText(
  value: unknown,
  field: string,
  options: { required?: boolean; max?: number } = {},
): string | null {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) {
    if (options.required)
      invalid('RECRUITMENT_TEXT_REQUIRED', `${field} is required.`);
    return null;
  }
  if (text.length > (options.max ?? MAX_TEXT)) {
    invalid('RECRUITMENT_TEXT_TOO_LONG', `${field} is too long.`);
  }
  return text;
}

/**
 * The deduplication key of a candidate: lower-cased, trimmed email. Malformed emails are
 * refused (never silently dropped), so a typo never creates an undeduplicated candidate.
 */
export function normalizeCandidateEmail(value: unknown): string | null {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!email) return null;
  if (email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    invalid('RECRUITMENT_EMAIL_INVALID', 'The email address is not valid.');
  }
  return email;
}

/** External links are https only (no javascript:, data: or plain http). */
export function parseHttpsUrl(value: unknown, field: string): string | null {
  const text = parseText(value, field, { max: 2000 });
  if (text && !/^https:\/\/\S+$/i.test(text)) {
    invalid('RECRUITMENT_URL_INVALID', `${field} must be an https URL.`);
  }
  return text;
}

export function parseInstant(value: unknown, field: string): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const date = typeof value === 'string' ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) {
    invalid(
      'RECRUITMENT_DATE_INVALID',
      `${field} must be an ISO-8601 instant.`,
    );
  }
  return date;
}

// ─── Lifecycles (mirror the migration's guards) ──────────────────────────────

const OPENING_TRANSITIONS: Record<JobOpeningStatus, JobOpeningStatus[]> = {
  DRAFT: ['OPEN', 'CANCELLED'],
  OPEN: ['ON_HOLD', 'FILLED', 'CLOSED', 'CANCELLED'],
  ON_HOLD: ['OPEN', 'CLOSED', 'CANCELLED'],
  FILLED: ['OPEN', 'CLOSED'],
  CLOSED: [],
  CANCELLED: [],
};

export function canMoveOpening(from: JobOpeningStatus, to: JobOpeningStatus) {
  return OPENING_TRANSITIONS[from].includes(to);
}

const APPLICATION_TRANSITIONS: Record<
  RecruitmentApplicationStatus,
  RecruitmentApplicationStatus[]
> = {
  ACTIVE: ['WITHDRAWN', 'REJECTED', 'OFFERED'],
  OFFERED: ['ACTIVE', 'HIRED', 'WITHDRAWN', 'REJECTED'],
  WITHDRAWN: [],
  REJECTED: [],
  HIRED: [],
};

export function canMoveApplication(
  from: RecruitmentApplicationStatus,
  to: RecruitmentApplicationStatus,
) {
  return APPLICATION_TRANSITIONS[from].includes(to);
}

export const LIVE_APPLICATION: RecruitmentApplicationStatus[] = [
  'ACTIVE',
  'OFFERED',
];

const OFFER_TRANSITIONS: Record<
  RecruitmentOfferStatus,
  RecruitmentOfferStatus[]
> = {
  DRAFT: ['APPROVED', 'WITHDRAWN'],
  APPROVED: ['DRAFT', 'SENT', 'WITHDRAWN'],
  SENT: ['ACCEPTED', 'DECLINED', 'WITHDRAWN', 'EXPIRED'],
  ACCEPTED: [],
  DECLINED: [],
  WITHDRAWN: [],
  EXPIRED: [],
};

export function canMoveOffer(
  from: RecruitmentOfferStatus,
  to: RecruitmentOfferStatus,
) {
  return OFFER_TRANSITIONS[from].includes(to);
}

export const OPEN_OFFER: RecruitmentOfferStatus[] = [
  'DRAFT',
  'APPROVED',
  'SENT',
];

/**
 * Expiry is date-derived: a sent offer whose last acceptance day (expiresOn) is before the
 * organization's today is expired, whether or not the expiry job has marked it yet.
 */
export function offerIsExpired(
  offer: { status: RecruitmentOfferStatus; expiresOn: Date | null },
  today: Date,
) {
  return (
    offer.status === 'EXPIRED' ||
    (offer.status === 'SENT' &&
      offer.expiresOn !== null &&
      offer.expiresOn.getTime() < today.getTime())
  );
}

export function effectiveOfferStatus(
  offer: { status: RecruitmentOfferStatus; expiresOn: Date | null },
  today: Date,
): RecruitmentOfferStatus {
  return offerIsExpired(offer, today) ? 'EXPIRED' : offer.status;
}

/** After one more hire: FILLED when every opening is taken, else unchanged. */
export function openingAfterHire(opening: {
  status: JobOpeningStatus;
  openingCount: number;
  hiredCount: number;
}): { hiredCount: number; status: JobOpeningStatus } {
  const hiredCount = opening.hiredCount + 1;
  return {
    hiredCount,
    status: hiredCount >= opening.openingCount ? 'FILLED' : opening.status,
  };
}

/** A new opening count: never below hires; a filled opening with room again reopens. */
export function openingAfterCountChange(
  opening: { status: JobOpeningStatus; hiredCount: number },
  openingCount: number,
): JobOpeningStatus {
  if (
    !Number.isInteger(openingCount) ||
    openingCount < 1 ||
    openingCount > 1000
  ) {
    invalid(
      'RECRUITMENT_OPENING_COUNT_INVALID',
      'The number of openings is a whole number from 1 to 1000.',
    );
  }
  if (openingCount < opening.hiredCount) {
    invalid(
      'RECRUITMENT_OPENING_COUNT_BELOW_HIRES',
      `The opening already has ${opening.hiredCount} hire(s).`,
    );
  }
  if (opening.status === 'FILLED' && openingCount > opening.hiredCount)
    return 'OPEN';
  if (opening.status === 'OPEN' && openingCount === opening.hiredCount)
    return 'FILLED';
  return opening.status;
}

// ─── Stages ──────────────────────────────────────────────────────────────────

export const DEFAULT_STAGES: ReadonlyArray<{
  code: string;
  name: string;
  kind: RecruitmentStageKind;
}> = [
  { code: 'APPLIED', name: 'Applied', kind: 'APPLIED' },
  { code: 'SCREENING', name: 'Screening', kind: 'SCREENING' },
  { code: 'PHONE_SCREEN', name: 'Phone Screen', kind: 'SCREENING' },
  { code: 'INTERVIEW', name: 'Interview', kind: 'INTERVIEW' },
  { code: 'FINAL_INTERVIEW', name: 'Final Interview', kind: 'INTERVIEW' },
  { code: 'REFERENCE_CHECK', name: 'Reference Check', kind: 'REFERENCE_CHECK' },
  { code: 'OFFER', name: 'Offer', kind: 'OFFER' },
  { code: 'HIRED', name: 'Hired', kind: 'HIRED' },
];

/** The stage new applications enter: the first APPLIED stage, else the first stage. */
export function initialStage<
  T extends {
    kind: RecruitmentStageKind;
    sortOrder: number;
    archivedAt: Date | null;
  },
>(stages: readonly T[]): T | null {
  const live = stages
    .filter((stage) => !stage.archivedAt)
    .sort((a, b) => a.sortOrder - b.sortOrder);
  return live.find((stage) => stage.kind === 'APPLIED') ?? live[0] ?? null;
}

// ─── Interviews and feedback ─────────────────────────────────────────────────

export function parseDuration(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 5 ||
    value > 1440
  ) {
    invalid(
      'RECRUITMENT_INTERVIEW_DURATION_INVALID',
      'The duration is a whole number of minutes from 5 to 1440.',
    );
  }
  return value;
}

/** Feedback is due a day after the interview ends unless set explicitly. */
export function defaultFeedbackDue(start: Date, durationMinutes: number) {
  return new Date(start.getTime() + (durationMinutes + 24 * 60) * 60_000);
}

export function parseRating(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > 5
  ) {
    invalid(
      'RECRUITMENT_RATING_INVALID',
      'The rating is a whole number from 1 to 5.',
    );
  }
  return value;
}

// ─── Documents ───────────────────────────────────────────────────────────────

export interface DocumentReferenceInput {
  kind: RecruitmentDocumentKind;
  title: string;
  provider: RecruitmentDocumentProvider;
  externalUrl?: string | null;
  externalFileId?: string | null;
  fileName?: string | null;
  mimeType?: string | null;
}

/** A document reference: metadata and an https link or provider file id, never the file. */
export function parseDocumentReference(input: DocumentReferenceInput) {
  const externalUrl = parseHttpsUrl(input.externalUrl, 'externalUrl');
  const externalFileId = parseText(input.externalFileId, 'externalFileId', {
    max: 500,
  });
  if (input.provider === 'EXTERNAL_URL' && !externalUrl) {
    invalid('RECRUITMENT_DOCUMENT_LINK_REQUIRED', 'A link is required.');
  }
  if (input.provider === 'GOOGLE_DRIVE' && !externalUrl && !externalFileId) {
    invalid(
      'RECRUITMENT_DOCUMENT_LINK_REQUIRED',
      'A Google Drive link or file id is required.',
    );
  }
  const mimeType = parseText(input.mimeType, 'mimeType', { max: 200 });
  if (mimeType && !/^[\w.+-]+\/[\w.+-]+$/.test(mimeType)) {
    invalid(
      'RECRUITMENT_DOCUMENT_MIME_INVALID',
      'mimeType is not a media type.',
    );
  }
  return {
    kind: input.kind,
    title: parseText(input.title, 'title', { required: true, max: 300 })!,
    provider: input.provider,
    externalUrl,
    externalFileId,
    fileName: parseText(input.fileName, 'fileName', { max: 300 }),
    mimeType,
  };
}

// ─── External application ingestion ──────────────────────────────────────────

export interface NormalizedSubmission {
  openingCode: string | null;
  candidate: {
    firstName: string;
    lastName: string;
    preferredName: string | null;
    email: string | null;
    phone: string | null;
    location: string | null;
  };
  answers: Array<{ question: string; answer: string }>;
  documents: ReturnType<typeof parseDocumentReference>[];
  sourceDetail: string | null;
}

export function normalizeSubmission(input: {
  openingCode?: string | null;
  candidate: {
    firstName?: string | null;
    lastName?: string | null;
    preferredName?: string | null;
    email?: string | null;
    phone?: string | null;
    location?: string | null;
  };
  answers?: ReadonlyArray<{
    question?: string | null;
    answer?: string | null;
  }> | null;
  documents?: readonly DocumentReferenceInput[] | null;
  sourceDetail?: string | null;
}): NormalizedSubmission {
  if (!input || typeof input !== 'object' || !input.candidate) {
    invalid(
      'RECRUITMENT_SUBMISSION_INVALID',
      'The submission has no candidate.',
    );
  }
  const answers = input.answers ?? [];
  if (!Array.isArray(answers) || answers.length > MAX_ANSWERS) {
    invalid(
      'RECRUITMENT_SUBMISSION_INVALID',
      `At most ${MAX_ANSWERS} answers.`,
    );
  }
  const documents = input.documents ?? [];
  if (!Array.isArray(documents) || documents.length > 10) {
    invalid('RECRUITMENT_SUBMISSION_INVALID', 'At most 10 documents.');
  }
  return {
    openingCode: input.openingCode
      ? parseRecruitmentCode(input.openingCode, 'openingCode')
      : null,
    candidate: {
      firstName: parseText(input.candidate.firstName, 'firstName', {
        required: true,
        max: 120,
      })!,
      lastName: parseText(input.candidate.lastName, 'lastName', {
        required: true,
        max: 120,
      })!,
      preferredName: parseText(input.candidate.preferredName, 'preferredName', {
        max: 120,
      }),
      email: normalizeCandidateEmail(input.candidate.email),
      phone: parseText(input.candidate.phone, 'phone', { max: 50 }),
      location: parseText(input.candidate.location, 'location', { max: 200 }),
    },
    answers: answers
      .map((entry) => ({
        question: parseText(entry?.question, 'question', {
          required: true,
          max: 500,
        })!,
        answer: parseText(entry?.answer, 'answer', { max: 4000 }) ?? '',
      }))
      .filter((entry) => entry.answer !== ''),
    documents: documents.map((document) => parseDocumentReference(document)),
    sourceDetail: parseText(input.sourceDetail, 'sourceDetail', { max: 200 }),
  };
}

/**
 * Hash of a submission's meaningful content: a re-delivery with the same hash is a duplicate
 * (no-op); a different hash is a correction at the source.
 */
export function submissionHash(
  submission: NormalizedSubmission,
  submittedAt: Date,
): string {
  return createHash('sha256')
    .update(JSON.stringify([submission, submittedAt.toISOString()]))
    .digest('hex');
}
