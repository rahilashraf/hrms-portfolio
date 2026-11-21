import { AuditService } from '../../audit/audit.service.js';
import { AuthorizationService } from '../../authorization/authorization.service.js';
import { PrismaService } from '../../database/prisma.service.js';
import {
  REGISTERED_STORAGE_ADAPTERS,
  configuredStorageAdapters,
  verifyDocumentReferences,
} from '../../documents/documents-jobs.js';
import {
  defaultNotificationEmailTransport,
  deliverPendingNotifications,
  parseDeliverPendingJobData,
} from '../../notifications/notifications-jobs.js';
import type { NotificationEmailTransport } from '../../notifications/notification-email.transport.js';
import { OnboardingAccessService } from '../../onboarding/onboarding-access.service.js';
import { OnboardingClock } from '../../onboarding/onboarding-common.js';
import { OnboardingTaskService } from '../../onboarding/onboarding-task.service.js';
import { OnboardingWorkflowService } from '../../onboarding/onboarding-workflow.service.js';
import { PerformanceAccessService } from '../../performance/performance-access.service.js';
import { PerformanceClock } from '../../performance/performance-common.js';
import { PerformanceEvidenceService } from '../../performance/performance-evidence.service.js';
import { recruitmentServices } from '../../recruitment/recruitment-jobs.js';
import {
  FetchGoogleApiClient,
  type GoogleApiClient,
} from './google-api.client.js';
import { GoogleConnectionService } from './google-connection.service.js';
import { CredentialCipher } from './google-credential-cipher.js';
import { GoogleFormBindingService } from './google-form-binding.service.js';
import {
  GoogleFormsApplicationProvider,
  GoogleFormsAssessmentProvider,
  GoogleFormsReader,
} from './google-forms.adapters.js';
import {
  GoogleSyncService,
  type SyncDueOutcome,
} from './google-sync.service.js';
import {
  DefaultGoogleTokenProvider,
  type GoogleTokenProvider,
} from './google-token.provider.js';
import { GoogleWorkspaceAccessService } from './google-workspace-access.service.js';
import {
  GoogleWorkspaceClock,
  googleWorkspaceSettingsFromEnv,
  type GoogleWorkspaceSettings,
} from './google-workspace-common.js';
import { GoogleWorkspaceRuntime } from './google-workspace-runtime.js';
import {
  GoogleDriveStorageAdapter,
  GoogleSheetsExportService,
  GoogleWorkspaceEmailTransport,
} from './google-workspace.adapters.js';

/**
 * Background job contracts for the Google Workspace integration (Phase 16.5). The worker routes
 * these jobs to the runners below; the API owns the logic (framework-free composition).
 *
 * - google.sync-forms (every 15 minutes): every live form binding of an organization with an
 *   ACTIVE Forms connection is synchronized through its domain contract; per-binding failures
 *   are recorded on runs with backoff, so only internal errors fail the job.
 * - google.health-check (hourly): refreshes each connection's health (token issuance with its
 *   scopes) and prunes old OAuth states.
 * - The Documents reference check and notification email delivery jobs run with the Google
 *   adapters registered (runVerifyDocumentReferencesWithGoogleJob,
 *   runDeliverPendingNotificationsWithGoogleJob): organizations without a usable connection
 *   keep the previous behavior (skipped references, the default email transport).
 *
 * The performance / recruitment domain sync jobs keep no Google provider registered: Google
 * Forms sources are synchronized by google.sync-forms (with its cursor), never twice.
 */
export const GOOGLE_QUEUE = 'hrms-default';
export const SYNC_GOOGLE_FORMS_JOB = 'google.sync-forms';
export const SYNC_GOOGLE_FORMS_SCHEDULER = 'google.sync-forms.frequent';
export const SYNC_GOOGLE_FORMS_CRON = '7,22,37,52 * * * *';
export const GOOGLE_HEALTH_CHECK_JOB = 'google.health-check';
export const GOOGLE_HEALTH_CHECK_SCHEDULER = 'google.health-check.hourly';
export const GOOGLE_HEALTH_CHECK_CRON = '17 * * * *';

export interface GoogleWorkspaceServiceOptions {
  env?: Record<string, string | undefined>;
  api?: GoogleApiClient;
  tokens?: GoogleTokenProvider;
  cipher?: CredentialCipher;
  settings?: GoogleWorkspaceSettings;
  clock?: GoogleWorkspaceClock;
}

/** Framework-free composition of the integration and the domain contracts it feeds. */
export function googleWorkspaceServices(
  prisma: PrismaService,
  options: GoogleWorkspaceServiceOptions = {},
) {
  const env = options.env ?? process.env;
  const clock = options.clock ?? new GoogleWorkspaceClock();
  const settings = options.settings ?? googleWorkspaceSettingsFromEnv(env);
  const cipher = options.cipher ?? CredentialCipher.fromEnvironment(env);
  const api = options.api ?? new FetchGoogleApiClient();
  const tokens =
    options.tokens ??
    new DefaultGoogleTokenProvider(api, cipher, settings, clock);
  const runtime = new GoogleWorkspaceRuntime(prisma, cipher, tokens, clock);
  const reader = new GoogleFormsReader(runtime, api);
  const authorization = new AuthorizationService(prisma);
  const audit = new AuditService(prisma);
  const access = new GoogleWorkspaceAccessService(prisma, authorization);
  // Domain contracts, composed as their own jobs compose them.
  const performance = new PerformanceEvidenceService(
    prisma,
    new PerformanceAccessService(prisma, authorization),
    audit,
    new PerformanceClock(),
  );
  const recruitment = recruitmentServices(prisma).intake;
  const onboardingAccess = new OnboardingAccessService(prisma, authorization);
  const onboardingClock = new OnboardingClock();
  const onboarding = new OnboardingTaskService(
    prisma,
    onboardingAccess,
    audit,
    onboardingClock,
    new OnboardingWorkflowService(
      prisma,
      onboardingAccess,
      audit,
      onboardingClock,
    ),
  );
  return {
    settings,
    cipher,
    api,
    tokens,
    runtime,
    reader,
    access,
    connections: new GoogleConnectionService(
      prisma,
      access,
      audit,
      clock,
      cipher,
      api,
      tokens,
      settings,
    ),
    bindings: new GoogleFormBindingService(
      prisma,
      access,
      audit,
      clock,
      reader,
    ),
    sync: new GoogleSyncService(
      prisma,
      access,
      audit,
      clock,
      reader,
      performance,
      recruitment,
      onboarding,
    ),
    drive: new GoogleDriveStorageAdapter(runtime, api),
    sheets: new GoogleSheetsExportService(runtime, api),
    assessmentProvider: new GoogleFormsAssessmentProvider(prisma, reader),
    applicationProvider: new GoogleFormsApplicationProvider(prisma, reader),
    emailTransport: (fallback: NotificationEmailTransport) =>
      new GoogleWorkspaceEmailTransport(runtime, api, fallback),
  };
}

export type GoogleWorkspaceServices = ReturnType<
  typeof googleWorkspaceServices
>;

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

interface JobOptions extends GoogleWorkspaceServiceOptions {
  prisma?: PrismaService;
  databaseUrl?: string;
}

async function withPrisma<T>(
  options: JobOptions,
  run: (prisma: PrismaService) => Promise<T>,
) {
  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL;
  if (!options.prisma && !databaseUrl)
    throw new Error(
      'DATABASE_URL must be configured for Google Workspace jobs.',
    );
  const prisma = options.prisma ?? new PrismaService(databaseUrl!);
  try {
    return await run(prisma);
  } finally {
    if (!options.prisma) await prisma.$disconnect();
  }
}

export async function runGoogleSyncFormsJob(
  data: unknown,
  options: JobOptions = {},
): Promise<SyncDueOutcome> {
  noParameters(data, 'Google Forms synchronization');
  return withPrisma(options, (prisma) =>
    googleWorkspaceServices(prisma, options).sync.syncDue(),
  );
}

export async function runGoogleHealthCheckJob(
  data: unknown,
  options: JobOptions = {},
) {
  noParameters(data, 'Google Workspace health check');
  return withPrisma(options, (prisma) =>
    googleWorkspaceServices(prisma, options).connections.checkAll(),
  );
}

/** documents.verify-references with the Google Drive adapter registered. */
export async function runVerifyDocumentReferencesWithGoogleJob(
  data: unknown,
  options: JobOptions = {},
) {
  noParameters(data, 'Document reference verification');
  return withPrisma(options, (prisma) =>
    verifyDocumentReferences(prisma, [
      ...REGISTERED_STORAGE_ADAPTERS,
      googleWorkspaceServices(prisma, options).drive,
      // Batch 9: uploaded files in the configured object store.
      ...configuredStorageAdapters(),
    ]),
  );
}

/** notifications.deliver-pending through the per-organization Gmail routing transport. */
export async function runDeliverPendingNotificationsWithGoogleJob(
  data: unknown,
  options: JobOptions & { fallback?: NotificationEmailTransport } = {},
) {
  const { batchSize } = parseDeliverPendingJobData(data);
  return withPrisma(options, (prisma) =>
    deliverPendingNotifications(
      prisma,
      googleWorkspaceServices(prisma, options).emailTransport(
        options.fallback ?? defaultNotificationEmailTransport(),
      ),
      { batchSize },
    ),
  );
}
