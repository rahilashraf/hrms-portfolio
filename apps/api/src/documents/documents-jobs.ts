import { addDays } from '../common/domain-support.js';
import { PrismaService } from '../database/prisma.service.js';
import {
  StorageAdapterUnavailableError,
  type DocumentStorageAdapter,
} from './document-storage.contract.js';
import { DocumentsClock, documentsToday, isoDate } from './documents-common.js';
import { EXPIRING_SOON_DAYS, expiryStatus } from './documents-domain.js';
import { DocumentReminderNotifier } from '../notifications/notifications-producers.js';
import { FeatureGateService } from '../features/feature-gate.service.js';
import { AuditService } from '../audit/audit.service.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import { DocumentsAccessService } from './documents-access.service.js';
import { DocumentsAuditAdapter } from './documents-audit.js';
import { DocumentFileService } from './document-file.service.js';
import {
  documentStorageFromEnv,
  type DocumentStorageSettings,
} from './document-object-store.js';
import { InternalObjectStorageAdapter } from './internal-storage.adapter.js';

/**
 * Background job contracts for Documents (Phase 15). The worker routes these jobs to the
 * runners below; the API owns the logic.
 *
 * - Expiry reminders: builds per-organization digests of documents expired or expiring soon
 *   (identifiers and dates only) for reminder sinks. The job runner uses
 *   defaultDocumentReminderSinks(): the static registered sinks plus the Phase 16
 *   notifications sink (employee renewal notices, HR count digests, missing required
 *   documents). Expiry status is date-derived on every read; correctness never depends on
 *   this job.
 * - Reference verification: asks registered storage adapters (the Phase 16.5 Google Drive
 *   adapter, with the document organization's own connection) whether current references
 *   still resolve, and records the result on the version. With no adapter registered — or
 *   when the adapter cannot check right now (StorageAdapterUnavailableError, e.g. the
 *   organization is not connected) — the reference is skipped and keeps its status.
 */
export const DOCUMENTS_QUEUE = 'hrms-default';
export const DOCUMENT_EXPIRY_REMINDERS_JOB = 'documents.expiry-reminders';
export const DOCUMENT_EXPIRY_REMINDERS_SCHEDULER =
  'documents.expiry-reminders.daily';
export const DOCUMENT_EXPIRY_REMINDERS_CRON = '45 7 * * *';
export const VERIFY_DOCUMENT_REFERENCES_JOB = 'documents.verify-references';
export const VERIFY_DOCUMENT_REFERENCES_SCHEDULER =
  'documents.verify-references.daily';
export const VERIFY_DOCUMENT_REFERENCES_CRON = '10 4 * * *';

export interface DocumentExpiryDigest {
  organizationId: string;
  expired: Array<{
    documentId: string;
    employeeId: string;
    typeId: string;
    expiresOn: string | null;
  }>;
  expiringSoon: Array<{
    documentId: string;
    employeeId: string;
    typeId: string;
    expiresOn: string | null;
  }>;
}

export interface DocumentReminderSink {
  deliver(digests: readonly DocumentExpiryDigest[]): Promise<void>;
}

export const REGISTERED_DOCUMENT_REMINDER_SINKS: readonly DocumentReminderSink[] =
  [];
/** The sinks the job uses by default: the registered ones and Phase 16 notifications. */
export function defaultDocumentReminderSinks(
  prisma: PrismaService,
  clock: { now(): Date } = new DocumentsClock(),
): readonly DocumentReminderSink[] {
  return [
    ...REGISTERED_DOCUMENT_REMINDER_SINKS,
    new DocumentReminderNotifier(prisma, clock),
  ];
}
export const REGISTERED_STORAGE_ADAPTERS: readonly DocumentStorageAdapter[] =
  [];

export async function buildExpiryDigests(
  prisma: PrismaService,
  clock = new DocumentsClock(),
) {
  const now = clock.now();
  // Phase 18: organizations with Documents disabled get no digest.
  const disabled = await new FeatureGateService(prisma).disabledOrganizations(
    'DOCUMENTS',
  );
  const rows = await prisma.employeeDocumentVersion.findMany({
    where: {
      supersededAt: null,
      expiresOn: { not: null, lte: addDays(now, EXPIRING_SOON_DAYS + 1) },
      document: { status: 'ACTIVE', organizationId: { notIn: [...disabled] } },
    },
    include: {
      document: { include: { organization: { select: { timezone: true } } } },
    },
    orderBy: [{ expiresOn: 'asc' }, { id: 'asc' }],
  });
  const digests = new Map<string, DocumentExpiryDigest>();
  for (const row of rows) {
    const status = expiryStatus(
      row.expiresOn,
      documentsToday(now, row.document.organization.timezone),
    );
    if (status !== 'EXPIRED' && status !== 'EXPIRING_SOON') continue;
    const digest = digests.get(row.document.organizationId) ?? {
      organizationId: row.document.organizationId,
      expired: [],
      expiringSoon: [],
    };
    (status === 'EXPIRED' ? digest.expired : digest.expiringSoon).push({
      documentId: row.documentId,
      employeeId: row.document.employeeId,
      typeId: row.document.typeId,
      expiresOn: isoDate(row.expiresOn),
    });
    digests.set(row.document.organizationId, digest);
  }
  return [...digests.values()];
}

export async function sendExpiryReminders(
  prisma: PrismaService,
  sinks: readonly DocumentReminderSink[] = REGISTERED_DOCUMENT_REMINDER_SINKS,
  clock = new DocumentsClock(),
) {
  const digests = await buildExpiryDigests(prisma, clock);
  const outcome = {
    organizations: digests.length,
    /** Phase 18: organizations skipped because Documents is disabled for them. */
    skippedOrganizations: [
      ...(await new FeatureGateService(prisma).disabledOrganizations(
        'DOCUMENTS',
      )),
    ].sort(),
    expired: digests.reduce((sum, d) => sum + d.expired.length, 0),
    expiringSoon: digests.reduce((sum, d) => sum + d.expiringSoon.length, 0),
    delivered: 0,
    failed: [] as Array<{ sink: number; message: string }>,
  };
  for (const [index, sink] of sinks.entries()) {
    try {
      await sink.deliver(digests);
      outcome.delivered += 1;
    } catch (error) {
      outcome.failed.push({
        sink: index,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return outcome;
}

export async function verifyDocumentReferences(
  prisma: PrismaService,
  adapters: readonly DocumentStorageAdapter[] = REGISTERED_STORAGE_ADAPTERS,
  clock = new DocumentsClock(),
) {
  // Phase 18: organizations with Documents disabled are skipped entirely; Google Drive
  // references are not checked where Google Workspace is disabled or google.drive.verify off.
  const features = new FeatureGateService(prisma);
  const documentsOff = await features.disabledOrganizations('DOCUMENTS');
  const googleOff = await features.disabledOrganizations('GOOGLE_WORKSPACE');
  const driveVerifyOff = await features.settingOffOrganizations(
    'google.drive.verify',
  );
  const outcome = {
    checked: 0,
    skipped: 0,
    changed: 0,
    skippedOrganizations: [...documentsOff].sort(),
    failed: [] as Array<{ versionId: string; message: string }>,
  };
  const versions = await prisma.employeeDocumentVersion.findMany({
    where: {
      supersededAt: null,
      provider: { not: 'MANUAL_REFERENCE' },
      document: {
        status: 'ACTIVE',
        organizationId: { notIn: [...documentsOff] },
      },
    },
    include: { document: { select: { organizationId: true } } },
    orderBy: { id: 'asc' },
    take: 1000,
  });
  for (const version of versions) {
    const adapter = adapters.find(
      (candidate) => candidate.provider === version.provider,
    );
    const organizationId = version.document.organizationId;
    if (
      !adapter ||
      (version.provider === 'GOOGLE_DRIVE' &&
        (googleOff.has(organizationId) || driveVerifyOff.has(organizationId)))
    ) {
      outcome.skipped += 1;
      continue;
    }
    try {
      const status = await adapter.checkReference({
        provider: version.provider,
        externalUrl: version.externalUrl,
        storageKey: version.storageKey,
        externalFileId: version.externalFileId,
        organizationId: version.document.organizationId,
        storedObjectId: version.storedObjectId,
        fileName: version.fileName,
        mimeType: version.mimeType,
      });
      outcome.checked += 1;
      if (status !== version.referenceStatus) outcome.changed += 1;
      await prisma.employeeDocumentVersion.update({
        where: { id: version.id },
        data: { referenceStatus: status, referenceCheckedAt: clock.now() },
      });
    } catch (error) {
      if (error instanceof StorageAdapterUnavailableError) {
        outcome.skipped += 1;
        continue;
      }
      outcome.failed.push({
        versionId: version.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return outcome;
}

function noParameters(data: unknown, job: string) {
  if (
    data !== undefined &&
    data !== null &&
    (typeof data !== 'object' || Array.isArray(data))
  )
    throw new Error('Job data must be an object.');
  if (data && Object.keys(data).length > 0)
    throw new Error(`${job} takes no parameters.`);
}

async function withPrisma<T>(
  options: { prisma?: PrismaService; databaseUrl?: string },
  run: (prisma: PrismaService) => Promise<T>,
) {
  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL;
  if (!options.prisma && !databaseUrl)
    throw new Error('DATABASE_URL must be configured for document jobs.');
  const prisma = options.prisma ?? new PrismaService(databaseUrl!);
  try {
    return await run(prisma);
  } finally {
    if (!options.prisma) await prisma.$disconnect();
  }
}

export async function runDocumentExpiryRemindersJob(
  data: unknown,
  options: {
    prisma?: PrismaService;
    databaseUrl?: string;
    sinks?: readonly DocumentReminderSink[];
  } = {},
) {
  noParameters(data, 'Document expiry reminders');
  return withPrisma(options, (prisma) =>
    sendExpiryReminders(
      prisma,
      options.sinks ?? defaultDocumentReminderSinks(prisma),
    ),
  );
}

export async function runVerifyDocumentReferencesJob(
  data: unknown,
  options: {
    prisma?: PrismaService;
    databaseUrl?: string;
    adapters?: readonly DocumentStorageAdapter[];
  } = {},
) {
  noParameters(data, 'Document reference verification');
  return withPrisma(options, (prisma) =>
    verifyDocumentReferences(prisma, options.adapters),
  );
}

// ─── Batch 9: document storage ────────────────────────────────────────────────

/** The internal object-storage adapter when document storage is configured (verify job). */
export function configuredStorageAdapters(
  env: Record<string, string | undefined> = process.env,
): DocumentStorageAdapter[] {
  const { store } = documentStorageFromEnv(env);
  return store ? [new InternalObjectStorageAdapter(store)] : [];
}

/**
 * Batch 9 (D6): removes the objects of uploads never attached to a version within 24 hours
 * (and finishes removals that failed before). Attached objects are never touched — the ledger
 * and the database guard refuse it. Hourly; idempotent.
 */
export const CLEANUP_DOCUMENT_UPLOADS_JOB = 'documents.cleanup-uploads';
export const CLEANUP_DOCUMENT_UPLOADS_SCHEDULER =
  'documents.cleanup-uploads.hourly';
export const CLEANUP_DOCUMENT_UPLOADS_CRON = '25 * * * *';

export function documentFileServiceFor(
  prisma: PrismaService,
  options: {
    env?: Record<string, string | undefined>;
    clock?: DocumentsClock;
    settings?: DocumentStorageSettings;
  } = {},
) {
  const clock = options.clock ?? new DocumentsClock();
  return new DocumentFileService(
    prisma,
    new DocumentsAccessService(prisma, new AuthorizationService(prisma)),
    new DocumentsAuditAdapter(new AuditService(prisma)),
    clock,
    options.settings ?? documentStorageFromEnv(options.env),
  );
}

export async function runCleanupDocumentUploadsJob(
  data: unknown,
  options: {
    prisma?: PrismaService;
    databaseUrl?: string;
    settings?: DocumentStorageSettings;
  } = {},
) {
  noParameters(data, 'Document upload cleanup');
  return withPrisma(options, (prisma) =>
    documentFileServiceFor(prisma, {
      settings: options.settings,
    }).cleanupAbandoned(),
  );
}
