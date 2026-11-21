import type {
  RecruitmentDocumentKind,
  RecruitmentDocumentProvider,
  RecruitmentIntakeProvider,
} from '../generated/prisma/client.js';

/**
 * Phase 13 — the consumer-side contract through which Recruitment accepts applications from
 * systems outside the HRMS (a Google Form teacher/staff application today; a careers site or
 * other forms later).
 *
 * Integrations never write Recruitment tables. A provider adapter (e.g. the shared Google
 * Workspace connector of a later phase) fetches submissions of a configured
 * RecruitmentIntakeSource and hands them to RecruitmentApplicationIngestion.ingest, which owns
 * every rule:
 *
 * - Organization: a submission belongs to its source's organization and only reaches that
 *   organization's openings and candidates.
 * - Opening: the submission's opening code, else the source's default opening; it must be OPEN.
 *   Submissions without a usable opening wait in the unmatched opening queue for HR.
 * - Candidate: matched by normalized email among the organization's unmerged candidates, else
 *   created; never matched by name. A candidate who already has a live application to the
 *   opening is linked to it rather than duplicated.
 * - Deduplication: one submission per (source, externalResponseId); re-delivering the same
 *   content is a no-op (retry- and replay-safe, also under concurrent delivery).
 * - Corrections: different content (or a later externalUpdatedAt) updates the stored normalized
 *   submission and is recorded on the application's timeline; HR-edited candidate details are
 *   never overwritten. An older externalUpdatedAt is ignored as stale.
 * - Minimal data: only the normalized fields below are kept — never raw response payloads.
 * - Never authoritative: an ingested application starts in the first stage; nothing is scored,
 *   ranked or rejected automatically.
 */

export interface ExternalApplicationSubmission {
  /** The provider's response identifier (unique within the source). */
  externalResponseId: string;
  /** ISO-8601 instant the candidate submitted. */
  submittedAt: string;
  /** When the source last changed the response (orders corrections). */
  externalUpdatedAt?: string | null;
  /** The requisition code the candidate applied to, when the form asks for it. */
  openingCode?: string | null;
  candidate: {
    firstName: string;
    lastName: string;
    preferredName?: string | null;
    email?: string | null;
    phone?: string | null;
    location?: string | null;
  };
  /** Screening answers as asked (bounded); shown to recruiters, never scored. */
  answers?: Array<{ question: string; answer: string }>;
  /** References (links / file ids) to uploaded files — never file contents. */
  documents?: Array<{
    kind: RecruitmentDocumentKind;
    title: string;
    provider: RecruitmentDocumentProvider;
    externalUrl?: string | null;
    externalFileId?: string | null;
    fileName?: string | null;
    mimeType?: string | null;
  }>;
  sourceDetail?: string | null;
}

export type ApplicationIngestionOutcomeKind =
  | 'CREATED'
  | 'ATTACHED'
  | 'UNCHANGED'
  | 'CORRECTED'
  | 'STALE'
  | 'PENDING_OPENING'
  | 'REJECTED';

export interface ApplicationIngestionOutcome {
  externalResponseId: string;
  outcome: ApplicationIngestionOutcomeKind;
  submissionId?: string;
  applicationId?: string;
  candidateId?: string;
  /** A machine-readable reason for PENDING_OPENING / REJECTED / STALE / ATTACHED. */
  reason?: string;
}

export interface ApplicationIngestionReport {
  sourceId: string;
  received: number;
  counts: Record<ApplicationIngestionOutcomeKind, number>;
  outcomes: ApplicationIngestionOutcome[];
}

/** Injection token of the ingestion service (the only way in). */
export const RECRUITMENT_APPLICATION_INGESTION = Symbol(
  'RECRUITMENT_APPLICATION_INGESTION',
);

export interface RecruitmentApplicationIngestion {
  /**
   * Ingests submissions of one source. `IMPORT` is an authorized user's import
   * (recruitment.intake.manage at the source's organization); `SYNC` is a provider
   * synchronization (no user: the source's configuration is the authorization).
   */
  ingest(
    sourceId: string,
    submissions: readonly ExternalApplicationSubmission[],
    channel: 'IMPORT' | 'SYNC',
    actorUserId: string | null,
  ): Promise<ApplicationIngestionReport>;
}

/**
 * A provider adapter: fetches a source's submissions. Phase 13 registers none (no Google OAuth
 * is built here); the shared Google Workspace integration registers a GOOGLE_FORMS adapter.
 */
export interface ExternalApplicationProvider {
  readonly provider: RecruitmentIntakeProvider;
  fetchSubmissions(
    source: {
      id: string;
      externalResourceId: string;
      lastSyncedAt: Date | null;
    },
    since: Date | null,
  ): Promise<ExternalApplicationSubmission[]>;
}

/**
 * Phase 16.5: injection token of the registered application provider adapters (an array; the
 * shared Google Workspace integration registers its GOOGLE_FORMS adapter).
 */
export const RECRUITMENT_APPLICATION_PROVIDERS = Symbol(
  'RECRUITMENT_APPLICATION_PROVIDERS',
);
