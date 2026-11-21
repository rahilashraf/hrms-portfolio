import { Queue, Worker } from 'bullmq';
import { config } from 'dotenv';
import { Redis } from 'ioredis';
import { runExtendGeneratedShiftsJob, SCHEDULING_QUEUE } from 'api/scheduling-jobs';
import { runLeaveEntitlementsJob } from 'api/leave-jobs';
import { runPreparePayrollPeriodsJob } from 'api/payroll-jobs';
import { runPerformanceRemindersJob, runSyncPerformanceEvidenceJob } from 'api/performance-jobs';
import {
  runExpireRecruitmentOffersJob,
  runRecruitmentRemindersJob,
  runSyncRecruitmentApplicationsJob,
} from 'api/recruitment-jobs';
import {
  runDetectNoShowsJob,
  runPrepareAttendancePeriodsJob,
  runScanOpenTimeEntriesJob,
  timeAttendanceAutomationEnabled,
} from 'api/time-jobs';
import {
  employeeLifecycleAutomationEnabled,
  runActivateDueAssignmentsJob,
  runApplyDueTerminationsJob,
  runEndDueAssignmentsJob,
  runReconcileRetainedGrantsJob,
  retainedGrantReconciliationCron,
  retainedGrantReconciliationEnabled,
} from 'api/employee-jobs';
import { runWorkflowTaskRemindersJob } from 'api/onboarding-jobs';
import { runCleanupDocumentUploadsJob, runDocumentExpiryRemindersJob } from 'api/documents-jobs';
import {
  runDeliverPendingNotificationsWithGoogleJob,
  runGoogleHealthCheckJob,
  runGoogleSyncFormsJob,
  runVerifyDocumentReferencesWithGoogleJob,
} from 'api/google-workspace-jobs';
import { runRetentionApplyJob } from 'api/retention-jobs';
import { runPublishEventNotificationsJob } from 'api/notifications-jobs';
import { assertAuthRetentionConfiguration, runPruneAuthRecordsJob } from 'api/auth-retention-jobs';
import { assertAccountEmailConfiguration, runDeliverAccountEmailJob } from 'api/account-email-jobs';
import {
  checkDatabase,
  checkRedis,
  createDatabaseProbeClient,
  readiness,
} from 'api/platform-health';
import {
  accountEmailHandlers,
  authRetentionHandlers,
  createJobProcessor,
  documentHandlers,
  googleHandlers,
  onboardingHandlers,
  leaveHandlers,
  notificationHandlers,
  payrollHandlers,
  performanceHandlers,
  recruitmentHandlers,
  rejectUnknownJob,
  reminderHandlers,
  retentionHandlers,
  schedulingHandlers,
  timeHandlers,
  employeeHandlers,
} from './jobs.js';
import {
  createHealthServer,
  createShutdown,
  describeJobFailure,
  parseWorkerSettings,
  resolveConnections,
  startHeartbeat,
} from './runtime.js';
import {
  KEEP_COMPLETED_JOBS,
  KEEP_FAILED_JOBS,
  registerSchedules,
  schedulesFor,
} from './schedules.js';

config({ path: '../../.env' });

const settings = parseWorkerSettings(process.env);
// Batch 2: invalid SMTP settings stop the worker at start-up (variable names only, never values).
assertAccountEmailConfiguration(process.env);
// Batch 2: AUTH_RECORD_RETENTION_ENABLED must be empty, "true" or "false".
assertAuthRetentionConfiguration(process.env);
// Batch 4C: TIME_ATTENDANCE_AUTOMATION_ENABLED must be empty, "true" or "false".
const attendanceAutomation = timeAttendanceAutomationEnabled(process.env);
// Batch 5A: EMPLOYEE_LIFECYCLE_AUTOMATION_ENABLED must be empty, "true" or "false" (default off).
const lifecycleAutomation = employeeLifecycleAutomationEnabled(process.env);
// M3: independent of lifecycle automation (validated at start, like the other switches).
const reconciliation = {
  enabled: retainedGrantReconciliationEnabled(process.env),
  pattern: retainedGrantReconciliationCron(process.env),
};
const { redisUrl, databaseUrl } = resolveConnections(process.env);

// BullMQ requires maxRetriesPerRequest: null (blocking commands); reconnects are unbounded.
const connection = new Redis(redisUrl, {
  maxRetriesPerRequest: null,
  retryStrategy: (attempt: number) => Math.min(100 * 2 ** Math.max(0, attempt - 1), 5_000),
});
let lastRedisErrorAt = 0;
connection.on('error', () => {
  const now = Date.now();
  if (now - lastRedisErrorAt >= 60_000) {
    lastRedisErrorAt = now;
    console.error('Worker Redis connection failed; reconnecting');
  }
});

const worker = new Worker(
  SCHEDULING_QUEUE,
  createJobProcessor(
    {
      ...schedulingHandlers(runExtendGeneratedShiftsJob),
      ...leaveHandlers(runLeaveEntitlementsJob),
      ...employeeHandlers(
        runActivateDueAssignmentsJob,
        runApplyDueTerminationsJob,
        runEndDueAssignmentsJob,
        runReconcileRetainedGrantsJob,
      ),
      ...timeHandlers(
        runScanOpenTimeEntriesJob,
        runPrepareAttendancePeriodsJob,
        runDetectNoShowsJob,
      ),
      ...payrollHandlers(runPreparePayrollPeriodsJob),
      ...performanceHandlers(runSyncPerformanceEvidenceJob),
      ...recruitmentHandlers(runExpireRecruitmentOffersJob, runSyncRecruitmentApplicationsJob),
      ...onboardingHandlers(runWorkflowTaskRemindersJob),
      // Phase 16.5: reference checks use the Google Drive adapter and email delivery routes
      // through each organization's Gmail connection (else the default transport).
      ...documentHandlers(
        runDocumentExpiryRemindersJob,
        runVerifyDocumentReferencesWithGoogleJob,
        runCleanupDocumentUploadsJob,
      ),
      ...reminderHandlers(runPerformanceRemindersJob, runRecruitmentRemindersJob),
      ...notificationHandlers(
        runDeliverPendingNotificationsWithGoogleJob,
        runPublishEventNotificationsJob,
      ),
      ...googleHandlers(runGoogleSyncFormsJob, runGoogleHealthCheckJob),
      ...retentionHandlers(runRetentionApplyJob),
      // Batch 2: account recovery email queued by the API (forgot password, verification).
      ...accountEmailHandlers(runDeliverAccountEmailJob),
      ...authRetentionHandlers(runPruneAuthRecordsJob),
    },
    // Phase 19: an unknown job name is a poison message: failed at once, never retried, and
    // its payload is never logged.
    rejectUnknownJob,
  ),
  {
    connection,
    concurrency: settings.concurrency,
    // Defaults for jobs enqueued without their own retention (schedulers set it explicitly).
    removeOnComplete: KEEP_COMPLETED_JOBS,
    removeOnFail: KEEP_FAILED_JOBS,
  },
);

worker.on('ready', () => {
  console.log('HRMS worker connected to Redis');
});

worker.on('completed', (job) => {
  console.log(`Job ${job.name} (${job.id}) completed`);
});

worker.on('failed', (job, error) => {
  console.error(describeJobFailure(job, error));
});

worker.on('error', (error) => {
  console.error(`Worker error: ${error.name}`);
});

// Every schedule has a stable scheduler id, so registering on every start upserts the same
// single schedule (no duplicates across restarts or several worker processes).
const queue = new Queue(SCHEDULING_QUEUE, { connection });
const schedules = schedulesFor(attendanceAutomation, lifecycleAutomation, reconciliation);
await registerSchedules(queue, schedules.jobs, schedules.disabled);

// Phase 19 health signal: a Redis heartbeat, and an optional HTTP probe (WORKER_HEALTH_PORT).
let stopping = false;
const heartbeat = startHeartbeat(connection, settings.heartbeatIntervalMs);
const database = databaseUrl ? await createDatabaseProbeClient(databaseUrl) : null;
const healthServer =
  settings.healthPort === null
    ? null
    : createHealthServer({
        port: settings.healthPort,
        alive: () => !stopping && !worker.closing,
        ready: () =>
          readiness({
            redis: () => checkRedis(connection),
            database: () => (database ? checkDatabase(database) : Promise.resolve('down')),
          }),
      });
healthServer?.listen(settings.healthPort ?? 0, () => {
  console.log(`Worker health server listening on port ${settings.healthPort}`);
});

const shutdown = createShutdown(
  [
    // Stop fetching new jobs and wait for the active ones to finish.
    { name: 'worker', run: () => worker.close() },
    { name: 'queue', run: () => queue.close() },
    { name: 'heartbeat', run: async () => heartbeat.stop() },
    {
      name: 'health-server',
      run: () =>
        new Promise<void>((resolve) =>
          healthServer ? healthServer.close(() => resolve()) : resolve(),
        ),
    },
    { name: 'database', run: async () => database?.$disconnect() },
    { name: 'redis', run: () => connection.quit() },
  ],
  settings.shutdownTimeoutMs,
);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    stopping = true;
    void shutdown().then((code) => process.exit(code));
  });
}
