import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PROCESS_LEAVE_ENTITLEMENTS_JOB } from 'api/leave-jobs';
import { EXTEND_GENERATED_SHIFTS_JOB } from 'api/scheduling-jobs';
import { PREPARE_PAYROLL_PERIODS_JOB } from 'api/payroll-jobs';
import { PERFORMANCE_REMINDERS_JOB, SYNC_PERFORMANCE_EVIDENCE_JOB } from 'api/performance-jobs';
import {
  EXPIRE_RECRUITMENT_OFFERS_JOB,
  RECRUITMENT_REMINDERS_JOB,
  SYNC_RECRUITMENT_APPLICATIONS_JOB,
} from 'api/recruitment-jobs';
import {
  DELIVER_PENDING_NOTIFICATIONS_JOB,
  PUBLISH_EVENT_NOTIFICATIONS_JOB,
} from 'api/notifications-jobs';
import { GOOGLE_HEALTH_CHECK_JOB, SYNC_GOOGLE_FORMS_JOB } from 'api/google-workspace-jobs';
import { SCAN_OPEN_TIME_ENTRIES_JOB } from 'api/time-jobs';
import { ACTIVATE_DUE_ASSIGNMENTS_JOB } from 'api/employee-jobs';
import { WORKFLOW_TASK_REMINDERS_JOB } from 'api/onboarding-jobs';
import {
  CLEANUP_DOCUMENT_UPLOADS_JOB,
  DOCUMENT_EXPIRY_REMINDERS_JOB,
  VERIFY_DOCUMENT_REFERENCES_JOB,
} from 'api/documents-jobs';
import { RETENTION_APPLY_JOB } from 'api/retention-jobs';
import { AccountEmailJobError, DELIVER_ACCOUNT_EMAIL_JOB } from 'api/account-email-jobs';
import { UnrecoverableError } from 'bullmq';
import {
  accountEmailHandlers,
  createJobProcessor,
  skippedOrganizationsOf,
  documentHandlers,
  googleHandlers,
  onboardingHandlers,
  leaveHandlers,
  notificationHandlers,
  payrollHandlers,
  performanceHandlers,
  recruitmentHandlers,
  reminderHandlers,
  retentionHandlers,
  schedulingHandlers,
  timeHandlers,
  employeeHandlers,
} from './jobs.js';

type Outcome = Awaited<
  ReturnType<typeof import('api/scheduling-jobs').runExtendGeneratedShiftsJob>
>;

function outcome(failed: Outcome['failed'] = []): Outcome {
  return {
    range: { from: '2027-01-04', to: '2027-04-04' },
    patterns: 2,
    succeeded: 2 - failed.length,
    skippedOrganizations: [] as string[],
    failed,
    totals: { created: 3, updated: 0, removed: 0, blocked: 0, errors: 0 },
  };
}

describe('worker job routing', () => {
  it('reports organizations a run skipped because the module is disabled there', async () => {
    const logged: string[] = [];
    const processor = createJobProcessor(
      schedulingHandlers(async () => ({ ...outcome(), skippedOrganizations: ['org-1', 'org-2'] })),
      async () => assert.fail('fallback must not run'),
      (message) => logged.push(message),
    );
    const result = await processor({ name: EXTEND_GENERATED_SHIFTS_JOB, data: {} });
    assert.deepEqual((result as Outcome).skippedOrganizations, ['org-1', 'org-2']);
    assert.deepEqual(logged, [
      `Job ${EXTEND_GENERATED_SHIFTS_JOB} skipped 2 organization(s) with the module disabled: org-1, org-2`,
    ]);
    const quiet: string[] = [];
    await createJobProcessor(
      schedulingHandlers(async () => outcome()),
      async () => assert.fail('fallback must not run'),
      (message) => quiet.push(message),
    )({ name: EXTEND_GENERATED_SHIFTS_JOB, data: {} });
    assert.deepEqual(quiet, []);
    assert.deepEqual(skippedOrganizationsOf({ skippedOrganizations: ['a', 1] }), ['a']);
    assert.deepEqual(skippedOrganizationsOf(null), []);
  });

  it('routes the generation job to the scheduling runner with its data', async () => {
    const calls: unknown[] = [];
    const processor = createJobProcessor(
      schedulingHandlers(async (data) => {
        calls.push(data);
        return outcome();
      }),
      async () => assert.fail('fallback must not run'),
    );
    const result = await processor({
      name: EXTEND_GENERATED_SHIFTS_JOB,
      data: { horizonDays: 30 },
    });
    assert.deepEqual(calls, [{ horizonDays: 30 }]);
    assert.equal((result as Outcome).totals.created, 3);
  });

  it('keeps default handling for other jobs', async () => {
    const seen: string[] = [];
    const processor = createJobProcessor(
      schedulingHandlers(async () => assert.fail('runner must not run')),
      async (job) => {
        seen.push(job.name);
      },
    );
    await processor({ name: 'something-else', data: {} });
    assert.deepEqual(seen, ['something-else']);
  });

  it('fails the job when any pattern failed, so it is retried', async () => {
    const processor = createJobProcessor(
      schedulingHandlers(async () => outcome([{ patternId: 'p-1', message: 'boom' }])),
      async () => undefined,
    );
    await assert.rejects(
      processor({ name: EXTEND_GENERATED_SHIFTS_JOB, data: {} }),
      /failed for 1 of 2 pattern\(s\): p-1/,
    );
  });

  it('routes the leave entitlement job and fails it when any account failed', async () => {
    const calls: unknown[] = [];
    const leaveOutcome = (
      failed: Array<{ employmentAssignmentId: string; leaveTypeId: string; message: string }>,
    ) => ({
      asOf: '2027-01-01',
      accounts: 2,
      posted: { GRANT: 1, ACCRUAL: 2, CARRYOVER_FORFEIT: 0, EXPIRY: 0, REVERSAL: 0 },
      skippedOrganizations: [] as string[],
      failed,
    });
    const processor = createJobProcessor(
      leaveHandlers(async (data) => {
        calls.push(data);
        return leaveOutcome(
          calls.length === 1
            ? []
            : [{ employmentAssignmentId: 'a-1', leaveTypeId: 't-1', message: 'boom' }],
        );
      }),
      async () => assert.fail('fallback must not run'),
    );
    const result = await processor({
      name: PROCESS_LEAVE_ENTITLEMENTS_JOB,
      data: { asOf: '2027-01-01' },
    });
    assert.deepEqual(calls, [{ asOf: '2027-01-01' }]);
    assert.equal((result as ReturnType<typeof leaveOutcome>).posted.ACCRUAL, 2);
    await assert.rejects(
      processor({ name: PROCESS_LEAVE_ENTITLEMENTS_JOB, data: {} }),
      /failed for 1 account\(s\): a-1\/t-1/,
    );
  });

  it('routes the open time entry scan and fails it when any entry failed', async () => {
    const calls: unknown[] = [];
    const scanOutcome = (failed: Array<{ timeEntryId: string; message: string }>) => ({
      scanned: 3,
      detected: 1,
      autoResolved: 1,
      escalated: 0,
      skippedOrganizations: [] as string[],
      failed,
    });
    const processor = createJobProcessor(
      timeHandlers(async (data) => {
        calls.push(data);
        return scanOutcome(calls.length === 1 ? [] : [{ timeEntryId: 'e-1', message: 'boom' }]);
      }),
      async () => assert.fail('fallback must not run'),
    );
    const result = await processor({ name: SCAN_OPEN_TIME_ENTRIES_JOB, data: {} });
    assert.deepEqual(calls, [{}]);
    assert.equal((result as ReturnType<typeof scanOutcome>).detected, 1);
    await assert.rejects(
      processor({ name: SCAN_OPEN_TIME_ENTRIES_JOB, data: {} }),
      /failed for 1 of 3 entries: e-1/,
    );
  });

  it('routes assignment activation, keeps skips successful and fails the job on any failure', async () => {
    const calls: unknown[] = [];
    const outcome = (failed: Array<{ employmentAssignmentId: string; message: string }>) => ({
      scanned: 3,
      activated: ['a-1'],
      alreadyActive: 0,
      skipped: [{ employmentAssignmentId: 'a-2', code: 'EMPLOYMENT_ASSIGNMENT_EXPIRED' }],
      failed,
    });
    const processor = createJobProcessor(
      employeeHandlers(async (data) => {
        calls.push(data);
        return outcome(
          calls.length === 1 ? [] : [{ employmentAssignmentId: 'a-3', message: 'boom' }],
        );
      }),
      async () => assert.fail('fallback must not run'),
    );
    const result = await processor({ name: ACTIVATE_DUE_ASSIGNMENTS_JOB, data: {} });
    assert.deepEqual(calls, [{}]);
    assert.deepEqual((result as ReturnType<typeof outcome>).activated, ['a-1']);
    // A failed assignment fails the job so it is retried; the retry re-runs the whole idempotent scan.
    await assert.rejects(
      processor({ name: ACTIVATE_DUE_ASSIGNMENTS_JOB, data: {} }),
      /failed for 1 of 3 assignment\(s\): a-3/,
    );
  });

  it('routes payroll preparation and fails the job when any pay group or period failed', async () => {
    const ok = createJobProcessor(
      payrollHandlers(async () => ({
        payGroups: 2,
        periodsCreated: 3,
        periodsMaterialized: 1,
        skippedOrganizations: [] as string[],
        failed: [],
      })),
      async () => assert.fail('fallback must not run'),
    );
    assert.deepEqual(await ok({ name: PREPARE_PAYROLL_PERIODS_JOB, data: {} }), {
      payGroups: 2,
      periodsCreated: 3,
      periodsMaterialized: 1,
      skippedOrganizations: [] as string[],
      failed: [],
    });
    const failing = createJobProcessor(
      payrollHandlers(async () => ({
        payGroups: 1,
        periodsCreated: 0,
        periodsMaterialized: 0,
        skippedOrganizations: [] as string[],
        failed: [{ payGroupId: 'pay-group-1', message: 'boom' }],
      })),
      async () => assert.fail('fallback must not run'),
    );
    await assert.rejects(
      failing({ name: PREPARE_PAYROLL_PERIODS_JOB, data: {} }),
      /Payroll period preparation failed for 1 item\(s\): pay-group-1/,
    );
  });

  it('routes performance evidence synchronization and fails the job when a source failed', async () => {
    const ok = createJobProcessor(
      performanceHandlers(async () => ({
        sources: 2,
        synced: 0,
        skipped: 2,
        received: 0,
        skippedOrganizations: [] as string[],
        failed: [],
      })),
      async () => assert.fail('fallback must not run'),
    );
    assert.deepEqual(await ok({ name: SYNC_PERFORMANCE_EVIDENCE_JOB, data: {} }), {
      sources: 2,
      synced: 0,
      skipped: 2,
      received: 0,
      skippedOrganizations: [] as string[],
      failed: [],
    });
    const failing = createJobProcessor(
      performanceHandlers(async () => ({
        sources: 1,
        synced: 0,
        skipped: 0,
        received: 0,
        skippedOrganizations: [] as string[],
        failed: [{ sourceId: 'source-1', message: 'quota exceeded' }],
      })),
      async () => assert.fail('fallback must not run'),
    );
    await assert.rejects(
      failing({ name: SYNC_PERFORMANCE_EVIDENCE_JOB, data: {} }),
      /Performance evidence synchronization failed for 1 of 1 source\(s\): source-1/,
    );
  });

  it('routes recruitment offer expiry and application sync, failing the job on any failure', async () => {
    const ok = createJobProcessor(
      recruitmentHandlers(
        async () => ({ scanned: 3, expired: 1, skippedOrganizations: [], failed: [] }),
        async () => ({
          sources: 1,
          synced: 0,
          skipped: 1,
          received: 0,
          skippedOrganizations: [],
          failed: [],
        }),
      ),
      async () => assert.fail('fallback must not run'),
    );
    assert.deepEqual(await ok({ name: EXPIRE_RECRUITMENT_OFFERS_JOB, data: {} }), {
      scanned: 3,
      expired: 1,
      skippedOrganizations: [] as string[],
      failed: [],
    });
    assert.deepEqual(await ok({ name: SYNC_RECRUITMENT_APPLICATIONS_JOB, data: {} }), {
      sources: 1,
      synced: 0,
      skipped: 1,
      received: 0,
      skippedOrganizations: [] as string[],
      failed: [],
    });
    const failing = createJobProcessor(
      recruitmentHandlers(
        async () => ({
          scanned: 1,
          expired: 0,
          skippedOrganizations: [],
          failed: [{ offerId: 'offer-1', message: 'boom' }],
        }),
        async () => ({
          sources: 2,
          synced: 1,
          skipped: 0,
          received: 3,
          skippedOrganizations: [] as string[],
          failed: [{ sourceId: 'source-1', message: 'quota' }],
        }),
      ),
      async () => assert.fail('fallback must not run'),
    );
    await assert.rejects(
      failing({ name: EXPIRE_RECRUITMENT_OFFERS_JOB, data: {} }),
      /Offer expiry failed for 1 offer\(s\): offer-1/,
    );
    await assert.rejects(
      failing({ name: SYNC_RECRUITMENT_APPLICATIONS_JOB, data: {} }),
      /Application synchronization failed for 1 of 2 source\(s\): source-1/,
    );
  });

  it('routes onboarding task reminders and fails the job when a delivery sink failed', async () => {
    const outcome = {
      owners: 2,
      overdue: 1,
      dueSoon: 3,
      unownedOverdue: 0,
      delivered: 0,
      skippedOrganizations: [] as string[],
      failed: [],
    };
    const ok = createJobProcessor(
      onboardingHandlers(async () => outcome),
      async () => assert.fail('fallback must not run'),
    );
    assert.deepEqual(await ok({ name: WORKFLOW_TASK_REMINDERS_JOB, data: {} }), outcome);
    const failing = createJobProcessor(
      onboardingHandlers(async () => ({ ...outcome, failed: [{ sink: 0, message: 'smtp down' }] })),
      async () => assert.fail('fallback must not run'),
    );
    await assert.rejects(
      failing({ name: WORKFLOW_TASK_REMINDERS_JOB, data: {} }),
      /Task reminder delivery failed for 1 sink\(s\): smtp down/,
    );
  });

  it('routes document expiry reminders and reference verification, failing on any failure', async () => {
    const reminders = {
      organizations: 1,
      expired: 1,
      expiringSoon: 2,
      delivered: 0,
      skippedOrganizations: [] as string[],
      failed: [] as Array<{ sink: number; message: string }>,
    };
    const verify = {
      checked: 0,
      skipped: 3,
      changed: 0,
      skippedOrganizations: [] as string[],
      failed: [] as Array<{ versionId: string; message: string }>,
    };
    const ok = createJobProcessor(
      documentHandlers(
        async () => reminders,
        async () => verify,
        async () => ({ abandoned: 1, deleted: 1, skipped: 0, failed: [] }),
      ),
      async () => assert.fail('fallback must not run'),
    );
    assert.deepEqual(await ok({ name: DOCUMENT_EXPIRY_REMINDERS_JOB, data: {} }), reminders);
    assert.deepEqual(await ok({ name: VERIFY_DOCUMENT_REFERENCES_JOB, data: {} }), verify);
    const failing = createJobProcessor(
      documentHandlers(
        async () => ({ ...reminders, failed: [{ sink: 0, message: 'smtp down' }] }),
        async () => ({ ...verify, failed: [{ versionId: 'v-1', message: 'quota' }] }),
        async () => ({
          abandoned: 0,
          deleted: 0,
          skipped: 0,
          failed: [{ objectId: 'o-1', message: 'DOCUMENT_STORAGE_UNAVAILABLE' }],
        }),
      ),
      async () => assert.fail('fallback must not run'),
    );
    await assert.rejects(
      failing({ name: DOCUMENT_EXPIRY_REMINDERS_JOB, data: {} }),
      /failed for 1 sink\(s\): smtp down/,
    );
    await assert.rejects(
      failing({ name: VERIFY_DOCUMENT_REFERENCES_JOB, data: {} }),
      /failed for 1 version\(s\): v-1/,
    );
    assert.deepEqual(await ok({ name: CLEANUP_DOCUMENT_UPLOADS_JOB, data: {} }), {
      abandoned: 1,
      deleted: 1,
      skipped: 0,
      failed: [],
    });
    await assert.rejects(
      failing({ name: CLEANUP_DOCUMENT_UPLOADS_JOB, data: {} }),
      /cleanup failed for 1 object\(s\): o-1/,
    );
  });

  it('routes performance and recruitment reminders, failing the job when a publish failed', async () => {
    const reminders = {
      considered: 3,
      created: 2,
      existing: 1,
      skipped: 0,
      skippedOrganizations: [] as string[],
      failed: [] as Array<{ message: string }>,
    };
    const calls: unknown[] = [];
    const ok = createJobProcessor(
      reminderHandlers(
        async (data) => {
          calls.push(['performance', data]);
          return reminders;
        },
        async (data) => {
          calls.push(['recruitment', data]);
          return { ...reminders, created: 0 };
        },
      ),
      async () => assert.fail('fallback must not run'),
    );
    assert.deepEqual(await ok({ name: PERFORMANCE_REMINDERS_JOB, data: {} }), reminders);
    assert.deepEqual(await ok({ name: RECRUITMENT_REMINDERS_JOB, data: {} }), {
      ...reminders,
      created: 0,
    });
    assert.deepEqual(calls, [
      ['performance', {}],
      ['recruitment', {}],
    ]);
    const failing = createJobProcessor(
      reminderHandlers(
        async () => ({
          ...reminders,
          failed: [{ message: 'performance.reviews-due for u-1: boom' }],
        }),
        async () => ({
          ...reminders,
          failed: [{ message: 'recruitment.offer-expiring for u-2: boom' }],
        }),
      ),
      async () => assert.fail('fallback must not run'),
    );
    await assert.rejects(
      failing({ name: PERFORMANCE_REMINDERS_JOB, data: {} }),
      /Performance reminders failed for 1 notification\(s\): performance\.reviews-due for u-1/,
    );
    await assert.rejects(
      failing({ name: RECRUITMENT_REMINDERS_JOB, data: {} }),
      /Recruitment reminders failed for 1 notification\(s\)/,
    );
  });

  it('routes notification delivery; provider failures are per delivery, internal errors fail the job', async () => {
    const delivered = {
      claimed: 3,
      sent: 2,
      retried: 1,
      failed: 0,
      suppressed: 0,
      reclaimed: 0,
      lost: 0,
      uncertain: 0,
      providerNotConfigured: 0,
      expired: 0,
      skippedOrganizations: [] as string[],
      errors: [] as Array<{ deliveryId: string; message: string }>,
    };
    const calls: unknown[] = [];
    const ok = createJobProcessor(
      notificationHandlers(
        async (data) => {
          calls.push(data);
          return delivered;
        },
        async () => assert.fail('event notifications must not run'),
      ),
      async () => assert.fail('fallback must not run'),
    );
    assert.deepEqual(
      await ok({ name: DELIVER_PENDING_NOTIFICATIONS_JOB, data: { batchSize: 10 } }),
      delivered,
    );
    assert.deepEqual(calls, [{ batchSize: 10 }]);
    const failing = createJobProcessor(
      notificationHandlers(
        async () => ({
          ...delivered,
          errors: [{ deliveryId: 'd-1', message: 'connection reset' }],
        }),
        async () => assert.fail('event notifications must not run'),
      ),
      async () => assert.fail('fallback must not run'),
    );
    await assert.rejects(
      failing({ name: DELIVER_PENDING_NOTIFICATIONS_JOB, data: {} }),
      /failed to record 1 delivery: d-1/,
    );
  });

  it('routes Batch 8 event notifications; a failed event fails the job (the next run retries it)', async () => {
    const published = {
      horizon: '2026-03-15T16:00:00.000Z',
      sources: [
        {
          source: 'events.leave-request',
          bootstrapped: false,
          events: 2,
          created: 3,
          existing: 0,
          skipped: 0,
          failed: [] as Array<{ message: string }>,
          cursor: null,
        },
      ],
    };
    const calls: unknown[] = [];
    const ok = createJobProcessor(
      notificationHandlers(
        async () => assert.fail('delivery must not run'),
        async (data) => {
          calls.push(data);
          return published;
        },
      ),
      async () => assert.fail('fallback must not run'),
    );
    assert.deepEqual(await ok({ name: PUBLISH_EVENT_NOTIFICATIONS_JOB, data: {} }), published);
    assert.deepEqual(calls, [{}]);
    const failing = createJobProcessor(
      notificationHandlers(
        async () => assert.fail('delivery must not run'),
        async () => ({
          ...published,
          sources: [
            { ...published.sources[0]!, failed: [{ message: 'events.leave-request e-1: boom' }] },
          ],
        }),
      ),
      async () => assert.fail('fallback must not run'),
    );
    await assert.rejects(
      failing({ name: PUBLISH_EVENT_NOTIFICATIONS_JOB, data: {} }),
      /Event notifications failed for 1 event\(s\): events.leave-request e-1: boom/,
    );
  });

  it('routes Google Workspace jobs; per-binding failures are recorded, internal errors fail the job', async () => {
    const swept = {
      bindings: 3,
      succeeded: 1,
      failed: [{ bindingId: 'b-2', code: 'GOOGLE_UNAVAILABLE' }],
      skipped: 1,
      skippedOrganizations: [] as string[],
      errors: [] as Array<{ bindingId: string; message: string }>,
    };
    const health = {
      checked: 2,
      active: 1,
      error: 1,
      unavailable: 0,
      unknown: 0,
      prunedStates: 4,
      skippedOrganizations: [] as string[],
    };
    const calls: unknown[] = [];
    const ok = createJobProcessor(
      googleHandlers(
        async (data) => {
          calls.push(['sync', data]);
          return swept;
        },
        async (data) => {
          calls.push(['health', data]);
          return health;
        },
      ),
      async () => assert.fail('fallback must not run'),
    );
    // A failed binding (recorded with backoff) does not fail the job.
    assert.deepEqual(await ok({ name: SYNC_GOOGLE_FORMS_JOB, data: {} }), swept);
    assert.deepEqual(await ok({ name: GOOGLE_HEALTH_CHECK_JOB, data: {} }), health);
    assert.deepEqual(calls, [
      ['sync', {}],
      ['health', {}],
    ]);
    const failing = createJobProcessor(
      googleHandlers(
        async () => ({ ...swept, errors: [{ bindingId: 'b-9', message: 'SYNC_INTERNAL_ERROR' }] }),
        async () => health,
      ),
      async () => assert.fail('fallback must not run'),
    );
    await assert.rejects(
      failing({ name: SYNC_GOOGLE_FORMS_JOB, data: {} }),
      /failed internally for 1 binding\(s\): b-9 \(SYNC_INTERNAL_ERROR\)/,
    );
  });

  it('routes data retention; an organization that failed fails the job', async () => {
    const applied = {
      organizations: [],
      skippedOrganizations: ['org-2'],
      failed: [] as Array<{ organizationId: string; message: string }>,
    };
    const calls: unknown[] = [];
    const log: string[] = [];
    const ok = createJobProcessor(
      retentionHandlers(async (data) => {
        calls.push(data);
        return applied;
      }),
      async () => assert.fail('fallback must not run'),
      (message) => log.push(message),
    );
    assert.deepEqual(await ok({ name: RETENTION_APPLY_JOB, data: {} }), applied);
    assert.deepEqual(calls, [{}]);
    assert.equal(log.length, 1);
    const failing = createJobProcessor(
      retentionHandlers(async () => ({
        ...applied,
        failed: [{ organizationId: 'org-1', message: 'lock timeout' }],
      })),
      async () => assert.fail('fallback must not run'),
    );
    await assert.rejects(
      failing({ name: RETENTION_APPLY_JOB, data: {} }),
      /Data retention failed for 1 organization\(s\): org-1/,
    );
  });

  it('routes account recovery email; retryable failures retry, malformed or refused ones do not', async () => {
    const job = { kind: 'password-reset', userId: null, requestedAt: '2027-01-01T00:00:00.000Z' };
    const calls: unknown[] = [];
    const ok = createJobProcessor(
      accountEmailHandlers(async (data) => {
        calls.push(data);
        return { status: 'SKIPPED' as const, reason: 'NO_ACCOUNT' as const };
      }),
      async () => assert.fail('fallback must not run'),
    );
    assert.deepEqual(await ok({ name: DELIVER_ACCOUNT_EMAIL_JOB, data: job }), {
      status: 'SKIPPED',
      reason: 'NO_ACCOUNT',
    });
    assert.deepEqual(calls, [job]);

    const retryable = createJobProcessor(
      accountEmailHandlers(async () => {
        throw new AccountEmailJobError('not delivered: ACCOUNT_EMAIL_DELIVERY_FAILED', true);
      }),
      async () => assert.fail('fallback must not run'),
    );
    await assert.rejects(retryable({ name: DELIVER_ACCOUNT_EMAIL_JOB, data: job }), (error) => {
      assert.ok(!(error instanceof UnrecoverableError));
      return true;
    });
    const permanent = createJobProcessor(
      accountEmailHandlers(async () => {
        throw new AccountEmailJobError('kind must be password-reset or verification.', false);
      }),
      async () => assert.fail('fallback must not run'),
    );
    await assert.rejects(
      permanent({ name: DELIVER_ACCOUNT_EMAIL_JOB, data: job }),
      UnrecoverableError,
    );
  });
});
