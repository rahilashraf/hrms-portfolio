import { AuditService } from '../audit/audit.service.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import { PrismaService } from '../database/prisma.service.js';
import { PerformanceAccessService } from './performance-access.service.js';
import { PerformanceClock } from './performance-common.js';
import type { ExternalAssessmentProvider } from './performance-evidence.contract.js';
import { PerformanceEvidenceService } from './performance-evidence.service.js';
import {
  PerformanceReminderProducer,
  type ProducerOutcome,
} from '../notifications/notifications-producers.js';

/**
 * Background job contract for Performance (Phase 12): synchronizing external assessment
 * results (e.g. Google Forms quizzes) into Performance Evidence. The worker routes this job to
 * runSyncPerformanceEvidenceJob; the API owns the logic (framework-free composition).
 *
 * The job only feeds the ingestion contract — mapping, deduplication, corrections and
 * organization boundaries are the ingestion service's. It is idempotent (re-fetched results
 * are no-ops) and never required for correctness: HR can always import results or record
 * evidence by hand. Phase 12 registers no provider adapter (no Google OAuth is built here), so
 * every source is reported as skipped until the shared Google Workspace integration registers
 * a GOOGLE_FORMS adapter.
 */
export const PERFORMANCE_QUEUE = 'hrms-default';
export const SYNC_PERFORMANCE_EVIDENCE_JOB = 'performance.sync-evidence';
/** Stable id of the repeat, so registering it again on every worker start is a no-op. */
export const SYNC_PERFORMANCE_EVIDENCE_SCHEDULER =
  'performance.sync-evidence.daily';
export const SYNC_PERFORMANCE_EVIDENCE_CRON = '40 6 * * *';

/** The provider adapters available to the worker (none in Phase 12). */
export const REGISTERED_EVIDENCE_PROVIDERS: readonly ExternalAssessmentProvider[] =
  [];

export interface SyncPerformanceEvidenceOutcome {
  sources: number;
  synced: number;
  /** Sources whose provider has no registered adapter (nothing fetched, nothing changed). */
  skipped: number;
  received: number;
  /** Phase 18: organizations whose sources were skipped (Performance disabled there). */
  skippedOrganizations: string[];
  failed: Array<{ sourceId: string; message: string }>;
}

export function parseSyncPerformanceEvidenceJobData(
  data: unknown,
): Record<string, never> {
  if (
    data !== undefined &&
    data !== null &&
    (typeof data !== 'object' || Array.isArray(data))
  ) {
    throw new Error('Job data must be an object.');
  }
  if (data && Object.keys(data).length > 0) {
    throw new Error(
      'Performance evidence synchronization takes no parameters.',
    );
  }
  return {};
}

export async function syncPerformanceEvidence(
  prisma: PrismaService,
  providers: readonly ExternalAssessmentProvider[] = REGISTERED_EVIDENCE_PROVIDERS,
  clock = new PerformanceClock(),
): Promise<SyncPerformanceEvidenceOutcome> {
  const access = new PerformanceAccessService(
    prisma,
    new AuthorizationService(prisma),
  );
  const evidence = new PerformanceEvidenceService(
    prisma,
    access,
    new AuditService(prisma),
    clock,
  );
  const outcome: SyncPerformanceEvidenceOutcome = {
    sources: 0,
    synced: 0,
    skipped: 0,
    received: 0,
    skippedOrganizations: await access.disabledOrganizations(),
    failed: [],
  };
  outcome.skippedOrganizations.sort();
  const sources = await prisma.performanceEvidenceSource.findMany({
    where: {
      archivedAt: null,
      organizationId: { notIn: outcome.skippedOrganizations },
      externalResourceId: { not: null },
      provider: { not: 'MANUAL' },
    },
    orderBy: { id: 'asc' },
  });
  for (const source of sources) {
    outcome.sources += 1;
    const adapter = providers.find(
      (candidate) => candidate.provider === source.provider,
    );
    if (!adapter) {
      outcome.skipped += 1;
      continue;
    }
    try {
      const results = await adapter.fetchResults(
        {
          id: source.id,
          externalResourceId: source.externalResourceId!,
          lastSyncedAt: source.lastSyncedAt,
        },
        source.lastSyncedAt,
      );
      const report = await evidence.ingest(source.id, results, 'SYNC', null);
      outcome.received += report.received;
      outcome.synced += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      outcome.failed.push({ sourceId: source.id, message });
      // Visible to HR on the source; the next run retries (ingestion is idempotent).
      await prisma.performanceEvidenceSource.update({
        where: { id: source.id },
        data: {
          lastSyncStatus: 'FAILED',
          lastSyncMessage: message.slice(0, 500),
        },
      });
    }
  }
  return outcome;
}

export async function runSyncPerformanceEvidenceJob(
  data: unknown,
  options: {
    prisma?: PrismaService;
    databaseUrl?: string;
    providers?: readonly ExternalAssessmentProvider[];
  } = {},
) {
  parseSyncPerformanceEvidenceJobData(data);
  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL;
  if (!options.prisma && !databaseUrl) {
    throw new Error('DATABASE_URL must be configured for performance jobs.');
  }
  const prisma = options.prisma ?? new PrismaService(databaseUrl!);
  try {
    return await syncPerformanceEvidence(prisma, options.providers);
  } finally {
    if (!options.prisma) await prisma.$disconnect();
  }
}

/**
 * Phase 16 — performance review reminders through the shared notification framework: the
 * self part to the employee and a count digest to each current reviewer, while due within a
 * few days or overdue in open cycles. Idempotent (dedupe keys); never changes a review.
 */
export const PERFORMANCE_REMINDERS_JOB = 'performance.reminders';
export const PERFORMANCE_REMINDERS_SCHEDULER = 'performance.reminders.daily';
export const PERFORMANCE_REMINDERS_CRON = '50 7 * * *';

export function sendPerformanceReminders(
  prisma: PrismaService,
  clock: { now(): Date } = new PerformanceClock(),
): Promise<ProducerOutcome> {
  return new PerformanceReminderProducer(prisma, clock).run();
}

export async function runPerformanceRemindersJob(
  data: unknown,
  options: { prisma?: PrismaService; databaseUrl?: string } = {},
): Promise<ProducerOutcome> {
  if (
    data !== undefined &&
    data !== null &&
    (typeof data !== 'object' || Array.isArray(data))
  )
    throw new Error('Job data must be an object.');
  if (data && Object.keys(data).length > 0)
    throw new Error('Performance reminders take no parameters.');
  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL;
  if (!options.prisma && !databaseUrl)
    throw new Error('DATABASE_URL must be configured for performance jobs.');
  const prisma = options.prisma ?? new PrismaService(databaseUrl!);
  try {
    return await sendPerformanceReminders(prisma);
  } finally {
    if (!options.prisma) await prisma.$disconnect();
  }
}
