import type { PerformanceEvidenceProvider } from '../generated/prisma/client.js';

/**
 * Phase 12 — the consumer-side contract through which Performance accepts results from
 * systems outside the HRMS (Google Forms quizzes today; training platforms, certification
 * bodies later).
 *
 * Integrations never write Performance tables. A provider adapter (e.g. the shared Google
 * Workspace connector of a later phase) fetches results for a configured
 * PerformanceEvidenceSource and hands them to PerformanceEvidenceIngestion.ingest, which owns
 * every rule:
 *
 * - Organization: a result belongs to its source's organization, and only maps to employees
 *   with an assignment there.
 * - Identity: an explicit employeeId, else the respondent's email matched to an HRMS user;
 *   results that cannot be confidently matched wait in the intake queue for HR.
 * - Assignment: the given assignment, else the employee's only assignment in the organization
 *   at completion, else none (employee-level evidence).
 * - Deduplication: one current revision per (organization, provider, externalResourceId,
 *   externalResultId); re-delivering the same content is a no-op (retry- and replay-safe).
 * - Corrections: different content (or a later externalUpdatedAt) supersedes the current
 *   revision; an older externalUpdatedAt is ignored as stale; `withdrawn` retracts it.
 * - Snapshots: the title as completed and the pass threshold in force when first imported are
 *   kept, so renaming/deleting the form or changing the threshold never rewrites history.
 * - Minimal data: only the normalized fields below are kept — never raw response payloads.
 * - Never authoritative: evidence informs reviews (linked explicitly); it never sets a rating
 *   or a score.
 */

/** One external result, normalized by the provider adapter. */
export interface ExternalAssessmentResult {
  /** The provider's response/result identifier (unique within the source's resource). */
  externalResultId: string;
  /** Pre-mapped employee, when the provider already knows the HRMS employee. */
  employeeId?: string | null;
  /** The assignment the result concerns, when known. */
  employmentAssignmentId?: string | null;
  /** The respondent's email as collected by the source (used only for matching). */
  respondentEmail?: string | null;
  /** The provider's own respondent identifier, kept with unmatched results for HR. */
  respondentReference?: string | null;
  /** The resource title when completed; defaults to the source's current resource title. */
  title?: string | null;
  /** ISO-8601 instant of completion/submission. */
  completedAt: string;
  /** Decimal strings or numbers; all optional (an ungraded form has none). */
  score?: string | number | null;
  maxScore?: string | number | null;
  /** The source's own pass/fail, when it reports one. */
  passed?: boolean | null;
  resultUrl?: string | null;
  /** When the source last changed the result (orders corrections). */
  externalUpdatedAt?: string | null;
  /** The result was deleted or invalidated at the source. */
  withdrawn?: boolean;
}

export type EvidenceIngestionOutcomeKind =
  | 'CREATED'
  | 'UNCHANGED'
  | 'CORRECTED'
  | 'WITHDRAWN'
  | 'STALE'
  | 'PENDING_MATCH'
  | 'REJECTED';

export interface EvidenceIngestionOutcome {
  externalResultId: string;
  outcome: EvidenceIngestionOutcomeKind;
  evidenceId?: string;
  intakeId?: string;
  /** A machine-readable reason for PENDING_MATCH / REJECTED / STALE. */
  reason?: string;
}

export interface EvidenceIngestionReport {
  sourceId: string;
  received: number;
  counts: Record<EvidenceIngestionOutcomeKind, number>;
  outcomes: EvidenceIngestionOutcome[];
}

/** Injection token of the ingestion service (the only way in). */
export const PERFORMANCE_EVIDENCE_INGESTION = Symbol(
  'PERFORMANCE_EVIDENCE_INGESTION',
);

export interface PerformanceEvidenceIngestion {
  /**
   * Ingests results of one source. `IMPORT` is an authorized user's import
   * (performance.evidence.manage at the source's organization); `SYNC` is a provider
   * synchronization (no user: the source's configuration is the authorization).
   */
  ingest(
    sourceId: string,
    results: readonly ExternalAssessmentResult[],
    channel: 'IMPORT' | 'SYNC',
    actorUserId: string | null,
  ): Promise<EvidenceIngestionReport>;
}

/**
 * A provider adapter: fetches a source's results. Phase 12 registers none (no Google OAuth is
 * built here); the shared Google Workspace integration registers a GOOGLE_FORMS adapter.
 */
export interface ExternalAssessmentProvider {
  readonly provider: PerformanceEvidenceProvider;
  fetchResults(
    source: {
      id: string;
      externalResourceId: string;
      lastSyncedAt: Date | null;
    },
    since: Date | null,
  ): Promise<ExternalAssessmentResult[]>;
}

/** Injection token of the registered provider adapters (an array; empty in Phase 12). */
export const PERFORMANCE_EVIDENCE_PROVIDERS = Symbol(
  'PERFORMANCE_EVIDENCE_PROVIDERS',
);
