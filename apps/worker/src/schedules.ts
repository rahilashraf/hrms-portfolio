import {
  EXTEND_GENERATED_SHIFTS_CRON,
  EXTEND_GENERATED_SHIFTS_JOB,
  EXTEND_GENERATED_SHIFTS_SCHEDULER,
} from 'api/scheduling-jobs';
import {
  PROCESS_LEAVE_ENTITLEMENTS_CRON,
  PROCESS_LEAVE_ENTITLEMENTS_JOB,
  PROCESS_LEAVE_ENTITLEMENTS_SCHEDULER,
} from 'api/leave-jobs';
import {
  PREPARE_PAYROLL_PERIODS_CRON,
  PREPARE_PAYROLL_PERIODS_JOB,
  PREPARE_PAYROLL_PERIODS_SCHEDULER,
} from 'api/payroll-jobs';
import {
  PERFORMANCE_REMINDERS_CRON,
  PERFORMANCE_REMINDERS_JOB,
  PERFORMANCE_REMINDERS_SCHEDULER,
  SYNC_PERFORMANCE_EVIDENCE_CRON,
  SYNC_PERFORMANCE_EVIDENCE_JOB,
  SYNC_PERFORMANCE_EVIDENCE_SCHEDULER,
} from 'api/performance-jobs';
import {
  EXPIRE_RECRUITMENT_OFFERS_CRON,
  EXPIRE_RECRUITMENT_OFFERS_JOB,
  EXPIRE_RECRUITMENT_OFFERS_SCHEDULER,
  RECRUITMENT_REMINDERS_CRON,
  RECRUITMENT_REMINDERS_JOB,
  RECRUITMENT_REMINDERS_SCHEDULER,
  SYNC_RECRUITMENT_APPLICATIONS_CRON,
  SYNC_RECRUITMENT_APPLICATIONS_JOB,
  SYNC_RECRUITMENT_APPLICATIONS_SCHEDULER,
} from 'api/recruitment-jobs';
import {
  ACTIVATE_DUE_ASSIGNMENTS_CRON,
  ACTIVATE_DUE_ASSIGNMENTS_JOB,
  ACTIVATE_DUE_ASSIGNMENTS_SCHEDULER,
  APPLY_DUE_TERMINATIONS_CRON,
  APPLY_DUE_TERMINATIONS_JOB,
  APPLY_DUE_TERMINATIONS_SCHEDULER,
  END_DUE_ASSIGNMENTS_CRON,
  END_DUE_ASSIGNMENTS_JOB,
  END_DUE_ASSIGNMENTS_SCHEDULER,
  RECONCILE_RETAINED_GRANTS_CRON,
  RECONCILE_RETAINED_GRANTS_JOB,
  RECONCILE_RETAINED_GRANTS_SCHEDULER,
} from 'api/employee-jobs';
import {
  DETECT_NO_SHOWS_CRON,
  DETECT_NO_SHOWS_JOB,
  DETECT_NO_SHOWS_SCHEDULER,
  PREPARE_ATTENDANCE_PERIODS_CRON,
  PREPARE_ATTENDANCE_PERIODS_JOB,
  PREPARE_ATTENDANCE_PERIODS_SCHEDULER,
  SCAN_OPEN_TIME_ENTRIES_CRON,
  SCAN_OPEN_TIME_ENTRIES_JOB,
  SCAN_OPEN_TIME_ENTRIES_SCHEDULER,
} from 'api/time-jobs';
import {
  WORKFLOW_TASK_REMINDERS_CRON,
  WORKFLOW_TASK_REMINDERS_JOB,
  WORKFLOW_TASK_REMINDERS_SCHEDULER,
} from 'api/onboarding-jobs';
import {
  DOCUMENT_EXPIRY_REMINDERS_CRON,
  DOCUMENT_EXPIRY_REMINDERS_JOB,
  DOCUMENT_EXPIRY_REMINDERS_SCHEDULER,
  VERIFY_DOCUMENT_REFERENCES_CRON,
  VERIFY_DOCUMENT_REFERENCES_JOB,
  VERIFY_DOCUMENT_REFERENCES_SCHEDULER,
  CLEANUP_DOCUMENT_UPLOADS_CRON,
  CLEANUP_DOCUMENT_UPLOADS_JOB,
  CLEANUP_DOCUMENT_UPLOADS_SCHEDULER,
} from 'api/documents-jobs';
import {
  DELIVER_PENDING_NOTIFICATIONS_CRON,
  DELIVER_PENDING_NOTIFICATIONS_JOB,
  DELIVER_PENDING_NOTIFICATIONS_SCHEDULER,
  PUBLISH_EVENT_NOTIFICATIONS_CRON,
  PUBLISH_EVENT_NOTIFICATIONS_JOB,
  PUBLISH_EVENT_NOTIFICATIONS_SCHEDULER,
} from 'api/notifications-jobs';
import {
  GOOGLE_HEALTH_CHECK_CRON,
  GOOGLE_HEALTH_CHECK_JOB,
  GOOGLE_HEALTH_CHECK_SCHEDULER,
  SYNC_GOOGLE_FORMS_CRON,
  SYNC_GOOGLE_FORMS_JOB,
  SYNC_GOOGLE_FORMS_SCHEDULER,
} from 'api/google-workspace-jobs';
import {
  RETENTION_APPLY_CRON,
  RETENTION_APPLY_JOB,
  RETENTION_APPLY_SCHEDULER,
} from 'api/retention-jobs';
import {
  PRUNE_AUTH_RECORDS_CRON,
  PRUNE_AUTH_RECORDS_JOB,
  PRUNE_AUTH_RECORDS_SCHEDULER,
} from 'api/auth-retention-jobs';

/**
 * Phase 19 — retention of finished jobs. Completed jobs are kept briefly for diagnostics;
 * failed jobs stay visible much longer (the dead-letter view), both bounded by count and age
 * so Redis cannot grow without limit.
 */
export const KEEP_COMPLETED_JOBS = { count: 200, age: 7 * 24 * 60 * 60 };
export const KEEP_FAILED_JOBS = { count: 1_000, age: 30 * 24 * 60 * 60 };

export interface RetryPolicy {
  attempts: number;
  backoff?: { type: 'exponential' | 'fixed'; delay: number };
}

/** Daily and hourly runs: three attempts, one and two minutes apart. */
export const STANDARD_RETRY: RetryPolicy = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 60_000 },
};
/** Every 15 minutes: one quick retry; the next run follows soon anyway. */
export const FREQUENT_RETRY: RetryPolicy = {
  attempts: 2,
  backoff: { type: 'fixed', delay: 30_000 },
};
/**
 * Every two minutes: no job-level retry. The next run is the retry, and the job already
 * retries each delivery with its own backoff.
 */
export const NO_RETRY: RetryPolicy = { attempts: 1 };

export interface ScheduledJob {
  /** Stable scheduler id: re-registering on every start upserts the same single schedule. */
  schedulerId: string;
  name: string;
  pattern: string;
  retry: RetryPolicy;
}

export const SCHEDULED_JOBS: readonly ScheduledJob[] = [
  // Daily rolling-horizon shift generation; idempotent.
  {
    schedulerId: EXTEND_GENERATED_SHIFTS_SCHEDULER,
    name: EXTEND_GENERATED_SHIFTS_JOB,
    pattern: EXTEND_GENERATED_SHIFTS_CRON,
    retry: STANDARD_RETRY,
  },
  // Daily leave entitlements (grants, accruals, year-end carryover and expiry); idempotent.
  {
    schedulerId: PROCESS_LEAVE_ENTITLEMENTS_SCHEDULER,
    name: PROCESS_LEAVE_ENTITLEMENTS_JOB,
    pattern: PROCESS_LEAVE_ENTITLEMENTS_CRON,
    retry: STANDARD_RETRY,
  },
  // Hourly PLANNED → ACTIVE assignment activation (each timezone's start date within the
  // hour; overdue assignments from missed runs included); idempotent, one audit per transition.
  {
    schedulerId: ACTIVATE_DUE_ASSIGNMENTS_SCHEDULER,
    name: ACTIVATE_DUE_ASSIGNMENTS_JOB,
    pattern: ACTIVATE_DUE_ASSIGNMENTS_CRON,
    retry: STANDARD_RETRY,
  },
  // Missed clock-out detection for open time entries (every 15 minutes); idempotent.
  {
    schedulerId: SCAN_OPEN_TIME_ENTRIES_SCHEDULER,
    name: SCAN_OPEN_TIME_ENTRIES_JOB,
    pattern: SCAN_OPEN_TIME_ENTRIES_CRON,
    retry: FREQUENT_RETRY,
  },
  // Daily payroll preparation (periods and timesheets); never calculates or finalizes payroll.
  {
    schedulerId: PREPARE_PAYROLL_PERIODS_SCHEDULER,
    name: PREPARE_PAYROLL_PERIODS_JOB,
    pattern: PREPARE_PAYROLL_PERIODS_CRON,
    retry: STANDARD_RETRY,
  },
  // Daily external assessment results into Performance Evidence; idempotent.
  {
    schedulerId: SYNC_PERFORMANCE_EVIDENCE_SCHEDULER,
    name: SYNC_PERFORMANCE_EVIDENCE_JOB,
    pattern: SYNC_PERFORMANCE_EVIDENCE_CRON,
    retry: STANDARD_RETRY,
  },
  // Daily recording of expired offers (expiry itself is date-derived); idempotent.
  {
    schedulerId: EXPIRE_RECRUITMENT_OFFERS_SCHEDULER,
    name: EXPIRE_RECRUITMENT_OFFERS_JOB,
    pattern: EXPIRE_RECRUITMENT_OFFERS_CRON,
    retry: STANDARD_RETRY,
  },
  // Hourly external applications into Recruitment; deduplicated.
  {
    schedulerId: SYNC_RECRUITMENT_APPLICATIONS_SCHEDULER,
    name: SYNC_RECRUITMENT_APPLICATIONS_JOB,
    pattern: SYNC_RECRUITMENT_APPLICATIONS_CRON,
    retry: STANDARD_RETRY,
  },
  // Daily onboarding / offboarding task reminder digests (Phase 16).
  {
    schedulerId: WORKFLOW_TASK_REMINDERS_SCHEDULER,
    name: WORKFLOW_TASK_REMINDERS_JOB,
    pattern: WORKFLOW_TASK_REMINDERS_CRON,
    retry: STANDARD_RETRY,
  },
  // Daily document expiry digests and reference verification (Phases 15, 16.5).
  {
    schedulerId: DOCUMENT_EXPIRY_REMINDERS_SCHEDULER,
    name: DOCUMENT_EXPIRY_REMINDERS_JOB,
    pattern: DOCUMENT_EXPIRY_REMINDERS_CRON,
    retry: STANDARD_RETRY,
  },
  {
    schedulerId: VERIFY_DOCUMENT_REFERENCES_SCHEDULER,
    name: VERIFY_DOCUMENT_REFERENCES_JOB,
    pattern: VERIFY_DOCUMENT_REFERENCES_CRON,
    retry: STANDARD_RETRY,
  },
  // Batch 9: hourly removal of uploads never attached within 24 hours (never attached ones).
  {
    schedulerId: CLEANUP_DOCUMENT_UPLOADS_SCHEDULER,
    name: CLEANUP_DOCUMENT_UPLOADS_JOB,
    pattern: CLEANUP_DOCUMENT_UPLOADS_CRON,
    retry: STANDARD_RETRY,
  },
  // Phase 16 reminders: performance (daily) and recruitment (hourly); dedupe keys.
  {
    schedulerId: PERFORMANCE_REMINDERS_SCHEDULER,
    name: PERFORMANCE_REMINDERS_JOB,
    pattern: PERFORMANCE_REMINDERS_CRON,
    retry: STANDARD_RETRY,
  },
  {
    schedulerId: RECRUITMENT_REMINDERS_SCHEDULER,
    name: RECRUITMENT_REMINDERS_JOB,
    pattern: RECRUITMENT_REMINDERS_CRON,
    retry: STANDARD_RETRY,
  },
  // Notification email delivery every two minutes: exclusive claims, per-delivery retries.
  {
    schedulerId: DELIVER_PENDING_NOTIFICATIONS_SCHEDULER,
    name: DELIVER_PENDING_NOTIFICATIONS_JOB,
    pattern: DELIVER_PENDING_NOTIFICATIONS_CRON,
    retry: NO_RETRY,
  },
  // Batch 8: event notifications every two minutes (persistent checkpoints, dedupe keys).
  {
    schedulerId: PUBLISH_EVENT_NOTIFICATIONS_SCHEDULER,
    name: PUBLISH_EVENT_NOTIFICATIONS_JOB,
    pattern: PUBLISH_EVENT_NOTIFICATIONS_CRON,
    retry: NO_RETRY,
  },
  // Phase 16.5 Google Workspace: forms every 15 minutes, connection health hourly.
  {
    schedulerId: SYNC_GOOGLE_FORMS_SCHEDULER,
    name: SYNC_GOOGLE_FORMS_JOB,
    pattern: SYNC_GOOGLE_FORMS_CRON,
    retry: FREQUENT_RETRY,
  },
  {
    schedulerId: GOOGLE_HEALTH_CHECK_SCHEDULER,
    name: GOOGLE_HEALTH_CHECK_JOB,
    pattern: GOOGLE_HEALTH_CHECK_CRON,
    retry: STANDARD_RETRY,
  },
  // Phase 19 data retention for opted-in organizations; bounded idempotent batches.
  {
    schedulerId: RETENTION_APPLY_SCHEDULER,
    name: RETENTION_APPLY_JOB,
    pattern: RETENTION_APPLY_CRON,
    retry: STANDARD_RETRY,
  },
  // Daily deletion of sign-in records past retention (Batch 2): sessions revoked or expired over
  // 90 days ago, account tokens used or expired over 30 days ago; idempotent.
  {
    schedulerId: PRUNE_AUTH_RECORDS_SCHEDULER,
    name: PRUNE_AUTH_RECORDS_JOB,
    pattern: PRUNE_AUTH_RECORDS_CRON,
    retry: STANDARD_RETRY,
  },
];

/**
 * Batch 4C — attendance-only automation. Scheduled only when TIME_ATTENDANCE_AUTOMATION_ENABLED
 * is "true" on the worker (and unscheduled otherwise); each organization still opts in through
 * its time policy. Both jobs are idempotent.
 */
export const TIME_ATTENDANCE_AUTOMATION_JOBS: readonly ScheduledJob[] = [
  // Daily attendance-only periods and (if configured) timesheets; never touches payroll.
  {
    schedulerId: PREPARE_ATTENDANCE_PERIODS_SCHEDULER,
    name: PREPARE_ATTENDANCE_PERIODS_JOB,
    pattern: PREPARE_ATTENDANCE_PERIODS_CRON,
    retry: STANDARD_RETRY,
  },
  // NO_SHOW review exceptions every 15 minutes (one per shift revision, ever).
  {
    schedulerId: DETECT_NO_SHOWS_SCHEDULER,
    name: DETECT_NO_SHOWS_JOB,
    pattern: DETECT_NO_SHOWS_CRON,
    retry: FREQUENT_RETRY,
  },
];

/** The job template a scheduler creates: retry policy plus bounded retention. */
export function scheduledJobTemplate(job: ScheduledJob) {
  return {
    name: job.name,
    data: {},
    opts: {
      ...job.retry,
      removeOnComplete: KEEP_COMPLETED_JOBS,
      removeOnFail: KEEP_FAILED_JOBS,
    },
  };
}

export interface SchedulerQueue {
  upsertJobScheduler(
    schedulerId: string,
    repeat: { pattern: string; tz: string },
    template: ReturnType<typeof scheduledJobTemplate>,
  ): Promise<unknown>;
  removeJobScheduler?(schedulerId: string): Promise<unknown>;
}

export async function registerSchedules(
  queue: SchedulerQueue,
  jobs: readonly ScheduledJob[] = SCHEDULED_JOBS,
  disabled: readonly ScheduledJob[] = [],
): Promise<void> {
  for (const job of jobs) {
    await queue.upsertJobScheduler(
      job.schedulerId,
      { pattern: job.pattern, tz: 'UTC' },
      scheduledJobTemplate(job),
    );
  }
  // A switched-off schedule is removed, so turning a switch off takes effect on restart.
  for (const job of disabled) {
    await queue.removeJobScheduler?.(job.schedulerId);
  }
}

/**
 * Batch 5A — employee lifecycle automation. Scheduled only when
 * EMPLOYEE_LIFECYCLE_AUTOMATION_ENABLED is "true" on the worker (and unscheduled otherwise);
 * with it off, due terminations and assignment ends are applied by hand. Both jobs are
 * idempotent.
 */
export const EMPLOYEE_LIFECYCLE_AUTOMATION_JOBS: readonly ScheduledJob[] = [
  {
    schedulerId: APPLY_DUE_TERMINATIONS_SCHEDULER,
    name: APPLY_DUE_TERMINATIONS_JOB,
    pattern: APPLY_DUE_TERMINATIONS_CRON,
    retry: STANDARD_RETRY,
  },
  {
    schedulerId: END_DUE_ASSIGNMENTS_SCHEDULER,
    name: END_DUE_ASSIGNMENTS_JOB,
    pattern: END_DUE_ASSIGNMENTS_CRON,
    retry: STANDARD_RETRY,
  },
];

/**
 * Security remediation M3 (decision A) — retained-grant expiry reconciliation: disables a
 * terminated employee's login once their last retained grant has ended and nothing else
 * authorizes it. Independent of EMPLOYEE_LIFECYCLE_AUTOMATION_ENABLED; on unless
 * RETAINED_GRANT_RECONCILIATION_ENABLED is "false" (then removed on restart). Every 15 minutes
 * by default (RETAINED_GRANT_RECONCILIATION_CRON overrides it). Idempotent.
 */
export function retainedGrantReconciliationJobs(pattern: string): readonly ScheduledJob[] {
  return [
    {
      schedulerId: RECONCILE_RETAINED_GRANTS_SCHEDULER,
      name: RECONCILE_RETAINED_GRANTS_JOB,
      pattern,
      retry: FREQUENT_RETRY,
    },
  ];
}

/**
 * Every schedule, with the Batch 4C attendance automation and the Batch 5A lifecycle automation
 * only when each is switched on (a switched-off group is removed). The M3 retained-grant
 * reconciliation has its own switch and never depends on the lifecycle one.
 */
export function schedulesFor(
  automationEnabled: boolean,
  lifecycleEnabled = false,
  reconciliation: { enabled: boolean; pattern: string } = {
    enabled: true,
    pattern: RECONCILE_RETAINED_GRANTS_CRON,
  },
) {
  const reconcile = retainedGrantReconciliationJobs(reconciliation.pattern);
  const jobs = [
    ...SCHEDULED_JOBS,
    ...(automationEnabled ? TIME_ATTENDANCE_AUTOMATION_JOBS : []),
    ...(lifecycleEnabled ? EMPLOYEE_LIFECYCLE_AUTOMATION_JOBS : []),
    ...(reconciliation.enabled ? reconcile : []),
  ];
  const disabled = [
    ...(automationEnabled ? [] : TIME_ATTENDANCE_AUTOMATION_JOBS),
    ...(lifecycleEnabled ? [] : EMPLOYEE_LIFECYCLE_AUTOMATION_JOBS),
    ...(reconciliation.enabled ? [] : reconcile),
  ];
  return { jobs, disabled };
}
