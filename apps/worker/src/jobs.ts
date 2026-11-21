import { UnrecoverableError } from 'bullmq';
import { PROCESS_LEAVE_ENTITLEMENTS_JOB, type runLeaveEntitlementsJob } from 'api/leave-jobs';
import { EXTEND_GENERATED_SHIFTS_JOB, type runExtendGeneratedShiftsJob } from 'api/scheduling-jobs';
import { PREPARE_PAYROLL_PERIODS_JOB, type runPreparePayrollPeriodsJob } from 'api/payroll-jobs';
import {
  PERFORMANCE_REMINDERS_JOB,
  SYNC_PERFORMANCE_EVIDENCE_JOB,
  type runPerformanceRemindersJob,
  type runSyncPerformanceEvidenceJob,
} from 'api/performance-jobs';
import {
  EXPIRE_RECRUITMENT_OFFERS_JOB,
  RECRUITMENT_REMINDERS_JOB,
  SYNC_RECRUITMENT_APPLICATIONS_JOB,
  type runExpireRecruitmentOffersJob,
  type runRecruitmentRemindersJob,
  type runSyncRecruitmentApplicationsJob,
} from 'api/recruitment-jobs';
import {
  DETECT_NO_SHOWS_JOB,
  PREPARE_ATTENDANCE_PERIODS_JOB,
  SCAN_OPEN_TIME_ENTRIES_JOB,
  type runDetectNoShowsJob,
  type runPrepareAttendancePeriodsJob,
  type runScanOpenTimeEntriesJob,
} from 'api/time-jobs';
import {
  ACTIVATE_DUE_ASSIGNMENTS_JOB,
  APPLY_DUE_TERMINATIONS_JOB,
  END_DUE_ASSIGNMENTS_JOB,
  type runActivateDueAssignmentsJob,
  type runApplyDueTerminationsJob,
  type runEndDueAssignmentsJob,
  RECONCILE_RETAINED_GRANTS_JOB,
  type runReconcileRetainedGrantsJob,
} from 'api/employee-jobs';
import { WORKFLOW_TASK_REMINDERS_JOB, type runWorkflowTaskRemindersJob } from 'api/onboarding-jobs';
import {
  DOCUMENT_EXPIRY_REMINDERS_JOB,
  VERIFY_DOCUMENT_REFERENCES_JOB,
  type runDocumentExpiryRemindersJob,
  type runVerifyDocumentReferencesJob,
  CLEANUP_DOCUMENT_UPLOADS_JOB,
  type runCleanupDocumentUploadsJob,
} from 'api/documents-jobs';
import {
  DELIVER_PENDING_NOTIFICATIONS_JOB,
  PUBLISH_EVENT_NOTIFICATIONS_JOB,
  type runDeliverPendingNotificationsJob,
  type runPublishEventNotificationsJob,
} from 'api/notifications-jobs';
import {
  GOOGLE_HEALTH_CHECK_JOB,
  SYNC_GOOGLE_FORMS_JOB,
  type runGoogleHealthCheckJob,
  type runGoogleSyncFormsJob,
} from 'api/google-workspace-jobs';
import { RETENTION_APPLY_JOB, type runRetentionApplyJob } from 'api/retention-jobs';
import { PRUNE_AUTH_RECORDS_JOB, type runPruneAuthRecordsJob } from 'api/auth-retention-jobs';
import {
  AccountEmailJobError,
  DELIVER_ACCOUNT_EMAIL_JOB,
  type runDeliverAccountEmailJob,
} from 'api/account-email-jobs';

export interface WorkerJob {
  id?: string;
  name: string;
  data: unknown;
}

export type JobHandler = (data: unknown) => Promise<unknown>;

/**
 * Phase 18: the organizations a job run skipped because the job's module is disabled for them
 * (every API job outcome reports them as `skippedOrganizations`).
 */
export function skippedOrganizationsOf(outcome: unknown): string[] {
  const skipped =
    outcome && typeof outcome === 'object'
      ? (outcome as { skippedOrganizations?: unknown }).skippedOrganizations
      : undefined;
  return Array.isArray(skipped) ? skipped.filter((id): id is string => typeof id === 'string') : [];
}

/**
 * Phase 19: job data is a JSON object (or absent). Anything else is a poison message that no
 * retry can fix, so it fails at once (UnrecoverableError: no further attempts).
 */
export function assertJobDataShape(data: unknown): void {
  if (data === undefined || data === null) return;
  if (typeof data !== 'object' || Array.isArray(data)) {
    throw new UnrecoverableError('Job data must be an object');
  }
}

/**
 * Phase 19: the fallback for a job name no handler knows (e.g. enqueued by a newer or older
 * release). It fails at once without retries and without logging the payload.
 */
export async function rejectUnknownJob(job: WorkerJob): Promise<never> {
  throw new UnrecoverableError(`Unknown job name: ${safeJobName(job.name)}`);
}

/** Job names are ours, but a poison message could carry anything: keep it short and plain. */
export function safeJobName(name: unknown): string {
  return typeof name === 'string' ? name.replace(/[^\w.:-]/g, '?').slice(0, 100) : '?';
}

/**
 * Routes a job to its handler by name; unknown names go to the fallback (rejectUnknownJob in
 * the worker). Runs that skipped organizations with the job's module disabled say so
 * (identifiers only).
 */
export function createJobProcessor(
  handlers: Record<string, JobHandler>,
  fallback: (job: WorkerJob) => Promise<unknown>,
  log: (message: string) => void = (message) => console.log(message),
) {
  return async (job: WorkerJob) => {
    assertJobDataShape(job.data);
    const handler = Object.hasOwn(handlers, job.name) ? handlers[job.name] : undefined;
    if (!handler) return fallback(job);
    const outcome = await handler(job.data);
    const skipped = skippedOrganizationsOf(outcome);
    if (skipped.length > 0)
      log(
        `Job ${job.name} skipped ${skipped.length} organization(s) with the module disabled: ${skipped.join(', ')}`,
      );
    return outcome;
  };
}

/**
 * Scheduling jobs. Generation is idempotent, so a failed run is safe to retry; a run with any
 * failed pattern is reported as a failed job so it is visible and retried, while the patterns
 * that succeeded stay committed.
 */
export function schedulingHandlers(
  run: typeof runExtendGeneratedShiftsJob,
): Record<string, JobHandler> {
  return {
    [EXTEND_GENERATED_SHIFTS_JOB]: async (data) => {
      const outcome = await run(data);
      if (outcome.failed.length > 0) {
        throw new Error(
          `Shift generation failed for ${outcome.failed.length} of ${outcome.patterns} pattern(s): ${outcome.failed
            .map((failure) => failure.patternId)
            .join(', ')}`,
        );
      }
      return outcome;
    },
  };
}

/**
 * Leave entitlement jobs. Every posting has a deterministic idempotency key, so a failed run is
 * safe to retry; a run with any failed account is reported as a failed job (and retried) while
 * the accounts that succeeded stay committed.
 */
export function leaveHandlers(run: typeof runLeaveEntitlementsJob): Record<string, JobHandler> {
  return {
    [PROCESS_LEAVE_ENTITLEMENTS_JOB]: async (data) => {
      const outcome = await run(data);
      if (outcome.failed.length > 0) {
        throw new Error(
          `Leave entitlement processing failed for ${outcome.failed.length} account(s): ${outcome.failed
            .map((failure) => `${failure.employmentAssignmentId}/${failure.leaveTypeId}`)
            .join(', ')}`,
        );
      }
      return outcome;
    },
  };
}

/**
 * Time jobs. The open time entry scan is idempotent (an entry is flagged or escalated at most
 * once), so a failed run is safe to retry; a run with any failed entry is reported as a failed
 * job (and retried) while the entries that succeeded stay committed.
 */
export function timeHandlers(
  run: typeof runScanOpenTimeEntriesJob,
  prepareAttendancePeriods?: typeof runPrepareAttendancePeriodsJob,
  detectNoShows?: typeof runDetectNoShowsJob,
): Record<string, JobHandler> {
  return {
    // Batch 4C: attendance-only automation. Each run does nothing unless
    // TIME_ATTENDANCE_AUTOMATION_ENABLED is "true"; a run with any failed organization or shift
    // is a failed job (retried), while what succeeded stays committed (both are idempotent).
    ...(prepareAttendancePeriods
      ? {
          [PREPARE_ATTENDANCE_PERIODS_JOB]: async (data: unknown) => {
            const outcome = await prepareAttendancePeriods(data);
            if (outcome.failed.length > 0) {
              throw new Error(
                `Attendance period preparation failed for ${outcome.failed.length} organization(s): ${outcome.failed
                  .map((failure) => failure.organizationId)
                  .join(', ')}`,
              );
            }
            return outcome;
          },
        }
      : {}),
    ...(detectNoShows
      ? {
          [DETECT_NO_SHOWS_JOB]: async (data: unknown) => {
            const outcome = await detectNoShows(data);
            if (outcome.failed.length > 0) {
              throw new Error(
                `No-show detection failed for ${outcome.failed.length} shift(s) or exception(s): ${outcome.failed
                  .map((failure) => failure.scheduledShiftId)
                  .join(', ')}`,
              );
            }
            return outcome;
          },
        }
      : {}),
    [SCAN_OPEN_TIME_ENTRIES_JOB]: async (data) => {
      const outcome = await run(data);
      if (outcome.failed.length > 0) {
        throw new Error(
          `Open time entry scan failed for ${outcome.failed.length} of ${outcome.scanned} entr${outcome.scanned === 1 ? 'y' : 'ies'}: ${outcome.failed
            .map((failure) => failure.timeEntryId)
            .join(', ')}`,
        );
      }
      return outcome;
    },
  };
}

/**
 * Core HR assignment lifecycle. Activation is idempotent and locked per assignment (an
 * assignment is activated and audited at most once), so a failed run is safe to retry; a run
 * with any failed assignment is reported as a failed job (and retried) while the activations
 * that succeeded stay committed. Skipped assignments (not yet started in their timezone,
 * expired, inactive employee) are part of a successful run.
 */
export function employeeHandlers(
  run: typeof runActivateDueAssignmentsJob,
  applyDueTerminations?: typeof runApplyDueTerminationsJob,
  endDueAssignments?: typeof runEndDueAssignmentsJob,
  reconcileRetainedGrants?: typeof runReconcileRetainedGrantsJob,
): Record<string, JobHandler> {
  return {
    // M3 (decision A): retained-grant expiry reconciliation, independent of lifecycle automation.
    // A run with any failed employee is a failed job (retried); the others stay committed.
    ...(reconcileRetainedGrants
      ? {
          [RECONCILE_RETAINED_GRANTS_JOB]: async (data: unknown) => {
            const outcome = await reconcileRetainedGrants(data);
            if (outcome.failed.length > 0) {
              throw new Error(
                `Reconciling retained grants failed for ${outcome.failed.length} employee(s): ${outcome.failed
                  .map((failure) => failure.employeeId)
                  .join(', ')}`,
              );
            }
            return outcome;
          },
        }
      : {}),
    // Batch 5A: lifecycle automation. Each run does nothing unless
    // EMPLOYEE_LIFECYCLE_AUTOMATION_ENABLED is "true"; a run with any failure is a failed job
    // (retried) while what succeeded stays committed (both are idempotent).
    ...(applyDueTerminations
      ? {
          [APPLY_DUE_TERMINATIONS_JOB]: async (data: unknown) => {
            const outcome = await applyDueTerminations(data);
            // M3: a due termination waiting for SYSTEM grant decisions changed nothing and needs
            // an administrator, not a retry: the run succeeds and reports it (ids and codes only).
            if (outcome.blocked.length > 0) {
              console.warn(
                `Due termination(s) waiting for role-grant decisions: ${outcome.blocked
                  .map((item) => `${item.terminationId} (${item.code})`)
                  .join(', ')}`,
              );
            }
            if (outcome.failed.length > 0) {
              throw new Error(
                `Applying due terminations failed for ${outcome.failed.length} termination(s): ${outcome.failed
                  .map((failure) => failure.terminationId)
                  .join(', ')}`,
              );
            }
            // M3: a failed retention-expiry check (login not re-checked) is retried.
            if (outcome.retentionsFailed.length > 0) {
              throw new Error(
                `Checking expired retained grants failed for ${outcome.retentionsFailed.length} employee(s): ${outcome.retentionsFailed
                  .map((failure) => failure.employeeId)
                  .join(', ')}`,
              );
            }
            return outcome;
          },
        }
      : {}),
    ...(endDueAssignments
      ? {
          [END_DUE_ASSIGNMENTS_JOB]: async (data: unknown) => {
            const outcome = await endDueAssignments(data);
            if (outcome.failed.length > 0) {
              throw new Error(
                `Ending due assignments failed for ${outcome.failed.length} assignment(s): ${outcome.failed
                  .map((failure) => failure.employmentAssignmentId)
                  .join(', ')}`,
              );
            }
            return outcome;
          },
        }
      : {}),
    [ACTIVATE_DUE_ASSIGNMENTS_JOB]: async (data) => {
      const outcome = await run(data);
      if (outcome.failed.length > 0) {
        throw new Error(
          `Assignment activation failed for ${outcome.failed.length} of ${outcome.scanned} assignment(s): ${outcome.failed
            .map((failure) => failure.employmentAssignmentId)
            .join(', ')}`,
        );
      }
      return outcome;
    },
  };
}

/**
 * Payroll preparation jobs. Period generation and timesheet materialization are idempotent, so a
 * failed run is safe to retry; a run with any failed pay group or period is reported as a failed
 * job (and retried) while what succeeded stays committed. Never calculates, approves or
 * finalizes payroll.
 */
export function payrollHandlers(
  run: typeof runPreparePayrollPeriodsJob,
): Record<string, JobHandler> {
  return {
    [PREPARE_PAYROLL_PERIODS_JOB]: async (data) => {
      const outcome = await run(data);
      if (outcome.failed.length > 0) {
        throw new Error(
          `Payroll period preparation failed for ${outcome.failed.length} item(s): ${outcome.failed
            .map((failure) => failure.payGroupId ?? failure.payrollPeriodId)
            .join(', ')}`,
        );
      }
      return outcome;
    },
  };
}

/**
 * Performance evidence synchronization. Ingestion deduplicates every external result, so a
 * failed run is safe to retry; a run with any failed source is reported as a failed job (and
 * retried) while the sources that succeeded stay committed. Never decides a rating.
 */
export function performanceHandlers(
  run: typeof runSyncPerformanceEvidenceJob,
): Record<string, JobHandler> {
  return {
    [SYNC_PERFORMANCE_EVIDENCE_JOB]: async (data) => {
      const outcome = await run(data);
      if (outcome.failed.length > 0) {
        throw new Error(
          `Performance evidence synchronization failed for ${outcome.failed.length} of ${outcome.sources} source(s): ${outcome.failed
            .map((failure) => failure.sourceId)
            .join(', ')}`,
        );
      }
      return outcome;
    },
  };
}

/**
 * Recruitment jobs. Offer expiry only records what is already date-derived, and application
 * synchronization deduplicates every external submission, so both are safe to retry; a run with
 * any failed offer or source is reported as a failed job (and retried) while what succeeded
 * stays committed. Never rejects, scores or hires anyone.
 */
export function recruitmentHandlers(
  expire: typeof runExpireRecruitmentOffersJob,
  sync: typeof runSyncRecruitmentApplicationsJob,
): Record<string, JobHandler> {
  return {
    [EXPIRE_RECRUITMENT_OFFERS_JOB]: async (data) => {
      const outcome = await expire(data);
      if (outcome.failed.length > 0) {
        throw new Error(
          `Offer expiry failed for ${outcome.failed.length} offer(s): ${outcome.failed
            .map((failure) => failure.offerId)
            .join(', ')}`,
        );
      }
      return outcome;
    },
    [SYNC_RECRUITMENT_APPLICATIONS_JOB]: async (data) => {
      const outcome = await sync(data);
      if (outcome.failed.length > 0) {
        throw new Error(
          `Application synchronization failed for ${outcome.failed.length} of ${outcome.sources} source(s): ${outcome.failed
            .map((failure) => failure.sourceId)
            .join(', ')}`,
        );
      }
      return outcome;
    },
  };
}

/**
 * Onboarding / offboarding task reminders. The digest is rebuilt from the current tasks on
 * every run (overdue status is date-derived), so a failed run is safe to retry; a run with any
 * failed delivery sink is reported as a failed job.
 */
export function onboardingHandlers(
  run: typeof runWorkflowTaskRemindersJob,
): Record<string, JobHandler> {
  return {
    [WORKFLOW_TASK_REMINDERS_JOB]: async (data) => {
      const outcome = await run(data);
      if (outcome.failed.length > 0) {
        throw new Error(
          `Task reminder delivery failed for ${outcome.failed.length} sink(s): ${outcome.failed
            .map((failure) => failure.message)
            .join(', ')}`,
        );
      }
      return outcome;
    },
  };
}

/**
 * Document jobs. Expiry digests are rebuilt from current versions on every run (expiry is
 * date-derived) and reference verification only records adapter results, so both are safe to
 * retry; any failed sink or reference makes the job fail visibly.
 */
export function documentHandlers(
  reminders: typeof runDocumentExpiryRemindersJob,
  verify: typeof runVerifyDocumentReferencesJob,
  cleanup: typeof runCleanupDocumentUploadsJob,
): Record<string, JobHandler> {
  return {
    // Batch 9: unattached uploads past 24 hours; a failed removal is retried next run.
    [CLEANUP_DOCUMENT_UPLOADS_JOB]: async (data) => {
      const outcome = await cleanup(data);
      if (outcome.failed.length > 0) {
        throw new Error(
          `Document upload cleanup failed for ${outcome.failed.length} object(s): ${outcome.failed.map((f) => f.objectId).join(', ')}`,
        );
      }
      return outcome;
    },
    [DOCUMENT_EXPIRY_REMINDERS_JOB]: async (data) => {
      const outcome = await reminders(data);
      if (outcome.failed.length > 0) {
        throw new Error(
          `Document expiry reminder delivery failed for ${outcome.failed.length} sink(s): ${outcome.failed.map((f) => f.message).join(', ')}`,
        );
      }
      return outcome;
    },
    [VERIFY_DOCUMENT_REFERENCES_JOB]: async (data) => {
      const outcome = await verify(data);
      if (outcome.failed.length > 0) {
        throw new Error(
          `Document reference verification failed for ${outcome.failed.length} version(s): ${outcome.failed.map((f) => f.versionId).join(', ')}`,
        );
      }
      return outcome;
    },
  };
}

/**
 * Phase 16 notification reminders (performance reviews due, recruitment interviews, overdue
 * feedback and expiring offers). Every notification has a dedupe key, so a failed run is safe
 * to retry; a run with any failed publish is reported as a failed job.
 */
export function reminderHandlers(
  performance: typeof runPerformanceRemindersJob,
  recruitment: typeof runRecruitmentRemindersJob,
): Record<string, JobHandler> {
  const check = (label: string) => (outcome: Awaited<ReturnType<typeof performance>>) => {
    if (outcome.failed.length > 0) {
      throw new Error(
        `${label} failed for ${outcome.failed.length} notification(s): ${outcome.failed
          .map((failure) => failure.message)
          .join('; ')}`,
      );
    }
    return outcome;
  };
  return {
    [PERFORMANCE_REMINDERS_JOB]: async (data) =>
      check('Performance reminders')(await performance(data)),
    [RECRUITMENT_REMINDERS_JOB]: async (data) =>
      check('Recruitment reminders')(await recruitment(data)),
  };
}

/**
 * Notification email delivery. Claims are exclusive (SKIP LOCKED), SENT deliveries are final
 * and provider failures are retried per delivery with backoff, so the job itself only fails
 * on internal errors (it is then retried; nothing is sent twice).
 */
export function notificationHandlers(
  deliver: typeof runDeliverPendingNotificationsJob,
  publishEvents: typeof runPublishEventNotificationsJob,
): Record<string, JobHandler> {
  return {
    // Batch 8: event notifications from committed records; a failed event keeps its source's
    // checkpoint before it, so failing the job only means the next run retries it.
    [PUBLISH_EVENT_NOTIFICATIONS_JOB]: async (data) => {
      const outcome = await publishEvents(data);
      const failed = outcome.sources.flatMap((source) => source.failed);
      if (failed.length > 0) {
        throw new Error(
          `Event notifications failed for ${failed.length} event(s): ${failed
            .map((failure) => failure.message)
            .join('; ')}`.slice(0, 1000),
        );
      }
      return outcome;
    },
    [DELIVER_PENDING_NOTIFICATIONS_JOB]: async (data) => {
      const outcome = await deliver(data);
      if (outcome.errors.length > 0) {
        throw new Error(
          `Notification delivery failed to record ${outcome.errors.length} deliver${outcome.errors.length === 1 ? 'y' : 'ies'}: ${outcome.errors
            .map((error) => error.deliveryId)
            .join(', ')}`,
        );
      }
      return outcome;
    },
  };
}

/**
 * Phase 16.5 Google Workspace jobs. Form synchronization records Google and domain failures per
 * binding (run log, exponential backoff) and advances cursors only after the domain accepted a
 * chunk, so a retried job never duplicates anything; the job fails only on internal errors.
 * The health check only records each connection's state; it fails on nothing but a crash.
 */
export function googleHandlers(
  sync: typeof runGoogleSyncFormsJob,
  health: typeof runGoogleHealthCheckJob,
): Record<string, JobHandler> {
  return {
    [SYNC_GOOGLE_FORMS_JOB]: async (data) => {
      const outcome = await sync(data);
      if (outcome.errors.length > 0) {
        throw new Error(
          `Google Forms synchronization failed internally for ${outcome.errors.length} binding(s): ${outcome.errors
            .map((error) => `${error.bindingId} (${error.message})`)
            .join(', ')}`,
        );
      }
      return outcome;
    },
    [GOOGLE_HEALTH_CHECK_JOB]: async (data) => health(data),
  };
}

/**
 * Phase 19 data retention. Processes only organizations that opted in, in bounded idempotent
 * batches, so a failed run is safe to retry; any organization that failed fails the job.
 */
export function retentionHandlers(apply: typeof runRetentionApplyJob): Record<string, JobHandler> {
  return {
    [RETENTION_APPLY_JOB]: async (data) => {
      const outcome = await apply(data);
      if (outcome.failed.length > 0) {
        throw new Error(
          `Data retention failed for ${outcome.failed.length} organization(s): ${outcome.failed
            .map((failure) => failure.organizationId)
            .join(', ')}`,
        );
      }
      return outcome;
    },
  };
}

/**
 * Batch 2 (D6) account recovery email. Each attempt issues a fresh single-use link and withdraws
 * it when delivery fails, so retrying is safe; malformed jobs and refused addresses fail at once
 * (UnrecoverableError, no retry). Outcomes and errors carry ids and codes only.
 */
export function accountEmailHandlers(
  deliver: typeof runDeliverAccountEmailJob,
): Record<string, JobHandler> {
  return {
    [DELIVER_ACCOUNT_EMAIL_JOB]: async (data) => {
      try {
        return await deliver(data);
      } catch (error) {
        if (error instanceof AccountEmailJobError && !error.retryable)
          throw new UnrecoverableError(error.message);
        throw error;
      }
    },
  };
}

/**
 * Batch 2 (D3) sign-in record retention: deletes old revoked or expired sessions and old used or
 * expired account tokens in bounded, idempotent batches; it fails only on a crash. Each run is a
 * no-op unless AUTH_RECORD_RETENTION_ENABLED=true (rollout switch, read per run).
 */
export function authRetentionHandlers(
  prune: typeof runPruneAuthRecordsJob,
): Record<string, JobHandler> {
  return {
    [PRUNE_AUTH_RECORDS_JOB]: async (data) => prune(data),
  };
}
