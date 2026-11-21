import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service.js';
import { RetentionService } from '../src/retention/retention.service.js';
import {
  candidateDetails,
  FixedRecruitmentClock,
  openOpening,
  RECRUITMENT_USERS,
  recruitmentServices,
  type RecruitmentServices,
} from './support/recruitment-fixtures.js';
import {
  createSchedulingFixtures,
  ctx,
  rollbackClient,
  violation,
  type SchedulingFixtures,
  type Tx,
} from './support/scheduling-fixtures.js';

config({ path: '../../.env' });

class RollbackFixtures extends Error {}

/** Months before the database's now() (the retention triggers compare against now()). */
const monthsAgo = (months: number) => {
  const date = new Date();
  date.setUTCMonth(date.getUTCMonth() - months);
  return date;
};

async function setRetention(
  tx: Tx,
  organizationId: string,
  key: string,
  value: number,
) {
  await tx.organizationSetting.create({
    data: { organizationId, key, value, schemaVersion: 1 },
  });
}

let sequence = 0;
async function notification(
  tx: Tx,
  organizationId: string,
  recipientUserId: string,
  createdAt: Date,
  state: 'unread' | 'read' | 'archived',
) {
  sequence += 1;
  const row = await tx.notification.create({
    data: {
      organizationId,
      recipientUserId,
      type: 'system.retention-test',
      category: 'ONBOARDING',
      title: 'Retention test',
      body: 'Body',
      sourceDomain: 'ONBOARDING',
      dedupeKey: `retention-test-${sequence}-${Math.random()}`,
      createdAt,
    },
  });
  if (state !== 'unread')
    await tx.notification.update({
      where: { id: row.id },
      data:
        state === 'read'
          ? { readAt: createdAt }
          : { readAt: createdAt, archivedAt: createdAt },
    });
  return row.id;
}

/** A sent email delivery with one finished attempt. */
async function sentDelivery(
  tx: Tx,
  organizationId: string,
  notificationId: string,
  at: Date,
) {
  const delivery = await tx.notificationDelivery.create({
    data: {
      notificationId,
      organizationId,
      channel: 'EMAIL',
      status: 'PENDING',
      nextAttemptAt: at,
      createdAt: at,
    },
  });
  await tx.notificationDelivery.update({
    where: { id: delivery.id },
    data: {
      status: 'SENDING',
      attemptCount: 1,
      leaseExpiresAt: new Date(at.getTime() + 60_000),
    },
  });
  const attempt = await tx.notificationDeliveryAttempt.create({
    data: {
      deliveryId: delivery.id,
      organizationId,
      attemptNumber: 1,
      status: 'STARTED',
      provider: 'test',
      startedAt: at,
    },
  });
  await tx.notificationDeliveryAttempt.update({
    where: { id: attempt.id },
    data: { status: 'SUCCEEDED', finishedAt: at },
  });
  await tx.notificationDelivery.update({
    where: { id: delivery.id },
    data: { status: 'SENT', sentAt: at, leaseExpiresAt: null },
  });
  return { deliveryId: delivery.id, attemptId: attempt.id };
}

async function binding(tx: Tx, organizationId: string) {
  const row = await tx.googleFormBinding.create({
    data: {
      organizationId,
      formId: `retentionForm${Math.random().toString(36).slice(2, 12)}`,
      target: 'ONBOARDING_TASKS',
      mapping: {},
      mappingSchemaVersion: 1,
    },
  });
  return row.id;
}

async function syncRun(
  tx: Tx,
  organizationId: string,
  bindingId: string,
  startedAt: Date,
) {
  const run = await tx.googleSyncRun.create({
    data: {
      organizationId,
      bindingId,
      target: 'ONBOARDING_TASKS',
      trigger: 'SCHEDULED',
      status: 'RUNNING',
      startedAt,
      leaseExpiresAt: new Date(startedAt.getTime() + 60_000),
    },
  });
  await tx.googleSyncRun.update({
    where: { id: run.id },
    data: { status: 'SUCCEEDED', finishedAt: startedAt, fetched: 2 },
  });
  return run.id;
}

async function auditEntry(tx: Tx, organizationId: string, occurredAt: Date) {
  const row = await tx.auditLog.create({
    data: {
      action: 'RETENTION_TEST',
      entityType: 'Organization',
      entityId: organizationId,
      metadata: { organizationId },
      occurredAt,
    },
  });
  return row.id;
}

/** The database's message of a refused write (trigger texts included). */
function dbMessage(error: unknown): string {
  const e = error as {
    message?: string;
    meta?: { driverAdapterError?: { message?: string; cause?: unknown } };
  };
  return [
    e?.message,
    e?.meta?.driverAdapterError?.message,
    JSON.stringify(e?.meta?.driverAdapterError?.cause ?? null),
  ].join(' ');
}

const exists = async (tx: Tx, table: string, id: string): Promise<boolean> => {
  const rows = await tx.$queryRawUnsafe<unknown[]>(
    `SELECT 1 FROM "${table}" WHERE "id" = $1::uuid`,
    id,
  );
  return rows.length === 1;
};

describe('Data retention (database)', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService(process.env.DATABASE_URL!);
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  async function scenario(
    run: (
      tx: Tx,
      fx: SchedulingFixtures,
      retention: RetentionService,
      svc: RecruitmentServices,
      clock: FixedRecruitmentClock,
    ) => Promise<void>,
  ) {
    await expect(
      prisma.$transaction(
        async (tx) => {
          const fx = await createSchedulingFixtures(tx, RECRUITMENT_USERS);
          const client = rollbackClient(tx);
          const clock = new FixedRecruitmentClock();
          await run(
            tx,
            fx,
            new RetentionService(client),
            recruitmentServices(client, clock),
            clock,
          ).catch((error: unknown) => {
            console.error('SCENARIO FAILURE', error);
            throw error;
          });
          throw new RollbackFixtures();
        },
        { timeout: 120_000 },
      ),
    ).rejects.toBeInstanceOf(RollbackFixtures);
  }

  /** A candidate whose only application was rejected, closed at the clock's time. */
  async function rejectedCandidate(
    tx: Tx,
    fx: SchedulingFixtures,
    svc: RecruitmentServices,
    openingId: string,
    email: string,
    ageMonths: number,
  ) {
    const admin = ctx(fx.users.hiringAdmin!);
    const application = await svc.applications.create(
      {
        openingId,
        sourceDetail: 'Referred by a friend of the family',
        documents: [
          {
            kind: 'RESUME',
            title: 'Ada resume',
            provider: 'EXTERNAL_URL',
            externalUrl: 'https://files.example.com/ada-resume.pdf',
            fileName: 'ada-resume.pdf',
          },
        ],
        candidate: candidateDetails({
          email,
          location: 'Toronto',
          notes: 'Strong references',
        }),
      },
      admin,
    );
    // Free text about the candidate across the pipeline: screening, an offer, interview feedback.
    await svc.applications.recordScreening(
      application.id,
      { outcome: 'HOLD', notes: 'Mentioned a health condition' },
      admin,
    );
    const offer = await svc.offers.create(
      application.id,
      {
        positionId: fx.positionOrg,
        employmentType: 'FULL_TIME',
        startDate: '2026-04-01',
        payBasis: 'SALARY',
        rateAmount: '62000.00',
        currency: 'CAD',
        candidateTerms: 'Personal terms',
        internalNotes: 'Negotiated hard',
      },
      admin,
    );
    await svc.offers.act(offer.id, 'withdraw', 'Candidate relocated', admin);
    const interview = await tx.recruitmentInterview.create({
      data: {
        organizationId: fx.orgA,
        applicationId: application.id,
        type: 'PHONE',
        title: 'Phone screen',
        scheduledStart: new Date('2025-01-10T15:00:00Z'),
        durationMinutes: 30,
      },
    });
    await tx.recruitmentInterviewFeedback.create({
      data: {
        interviewId: interview.id,
        interviewerUserId: fx.users.recruiter!,
        strengths: 'Warm',
        concerns: 'Personal situation',
        comments: 'Lives far away',
      },
    });
    await svc.applications.reject(
      application.id,
      'Not enough classroom experience',
      admin,
    );
    // Age the rows (the triggers compare with the database clock).
    const at = monthsAgo(ageMonths);
    await tx.$executeRaw`UPDATE "RecruitmentApplication" SET "createdAt" = ${at}, "updatedAt" = ${at} WHERE "id" = ${application.id}::uuid`;
    await tx.$executeRaw`UPDATE "RecruitmentCandidate" SET "createdAt" = ${at}, "updatedAt" = ${at} WHERE "id" = ${application.candidateId}::uuid`;
    return {
      applicationId: application.id,
      candidateId: application.candidateId,
    };
  }

  it('changes nothing by default: no organization opted in', async () => {
    await scenario(async (tx, fx, retention) => {
      const old = monthsAgo(60);
      const notificationId = await notification(
        tx,
        fx.orgA,
        fx.users.recruiter!,
        old,
        'archived',
      );
      const runId = await syncRun(tx, fx.orgA, await binding(tx, fx.orgA), old);
      const auditId = await auditEntry(tx, fx.orgA, old);
      const outcome = await retention.apply({
        organizationIds: [fx.orgA, fx.orgB],
      });
      expect(outcome).toEqual({
        organizations: [],
        skippedOrganizations: [],
        failed: [],
      });
      expect(await exists(tx, 'Notification', notificationId)).toBe(true);
      expect(await exists(tx, 'GoogleSyncRun', runId)).toBe(true);
      expect(await exists(tx, 'AuditLog', auditId)).toBe(true);
      // Explicitly off (0) is the same as no setting.
      await setRetention(tx, fx.orgA, 'retention.auditLogMonths', 0);
      expect(
        (await retention.apply({ organizationIds: [fx.orgA] })).organizations,
      ).toEqual([]);
      expect(await exists(tx, 'AuditLog', auditId)).toBe(true);
    });
  });

  it('purges only rows past the organization period, in that organization only; idempotent and audited', async () => {
    await scenario(async (tx, fx, retention) => {
      for (const [key, months] of [
        ['retention.notificationMonths', 6],
        ['retention.deliveryLogMonths', 3],
        ['retention.syncLogMonths', 6],
        ['retention.auditLogMonths', 24],
      ] as const)
        await setRetention(tx, fx.orgA, key, months);
      const user = fx.users.recruiter!;
      const oldRead = await notification(
        tx,
        fx.orgA,
        user,
        monthsAgo(12),
        'read',
      );
      const oldDelivery = await sentDelivery(
        tx,
        fx.orgA,
        oldRead,
        monthsAgo(12),
      );
      const oldArchived = await notification(
        tx,
        fx.orgA,
        user,
        monthsAgo(9),
        'archived',
      );
      const oldUnread = await notification(
        tx,
        fx.orgA,
        user,
        monthsAgo(12),
        'unread',
      );
      const youngRead = await notification(
        tx,
        fx.orgA,
        user,
        monthsAgo(4),
        'read',
      );
      // A young notification's attempt log is older than the delivery-log period.
      const youngDelivery = await sentDelivery(
        tx,
        fx.orgA,
        youngRead,
        monthsAgo(4),
      );
      const orgBRead = await notification(
        tx,
        fx.orgB,
        user,
        monthsAgo(12),
        'read',
      );
      const bindingA = await binding(tx, fx.orgA);
      const oldRun = await syncRun(tx, fx.orgA, bindingA, monthsAgo(7));
      const youngRun = await syncRun(tx, fx.orgA, bindingA, monthsAgo(5));
      const orgBRun = await syncRun(
        tx,
        fx.orgB,
        await binding(tx, fx.orgB),
        monthsAgo(24),
      );
      const oldAudit = await auditEntry(tx, fx.orgA, monthsAgo(30));
      const youngAudit = await auditEntry(tx, fx.orgA, monthsAgo(20));
      const orgBAudit = await auditEntry(tx, fx.orgB, monthsAgo(30));

      const outcome = await retention.apply({
        organizationIds: [fx.orgA, fx.orgB],
        batchSize: 1,
      });
      expect(outcome.failed).toEqual([]);
      expect(outcome.skippedOrganizations).toEqual([]);
      expect(outcome.organizations).toEqual([
        {
          organizationId: fx.orgA,
          periods: {
            notifications: 6,
            deliveryLogs: 3,
            syncLogs: 6,
            auditLog: 24,
          },
          counts: {
            candidatesAnonymized: 0,
            intakeSubmissionsRedacted: 0,
            notificationsDeleted: 2,
            deliveriesDeleted: 1,
            deliveryAttemptsDeleted: 2,
            syncRunsDeleted: 1,
            auditEntriesDeleted: 1,
          },
          incomplete: [],
        },
      ]);
      for (const id of [oldRead, oldArchived])
        expect(await exists(tx, 'Notification', id)).toBe(false);
      expect(
        await exists(tx, 'NotificationDelivery', oldDelivery.deliveryId),
      ).toBe(false);
      for (const id of [oldUnread, youngRead, orgBRead])
        expect(await exists(tx, 'Notification', id)).toBe(true);
      expect(
        await exists(tx, 'NotificationDelivery', youngDelivery.deliveryId),
      ).toBe(true);
      expect(
        await exists(
          tx,
          'NotificationDeliveryAttempt',
          youngDelivery.attemptId,
        ),
      ).toBe(false);
      expect(await exists(tx, 'GoogleSyncRun', oldRun)).toBe(false);
      for (const id of [youngRun, orgBRun])
        expect(await exists(tx, 'GoogleSyncRun', id)).toBe(true);
      expect(await exists(tx, 'AuditLog', oldAudit)).toBe(false);
      for (const id of [youngAudit, orgBAudit])
        expect(await exists(tx, 'AuditLog', id)).toBe(true);

      // Audited per run with periods and counts only.
      const audits = await tx.auditLog.findMany({
        where: { action: 'DATA_RETENTION_APPLIED', entityId: fx.orgA },
      });
      expect(audits).toHaveLength(1);
      expect(audits[0]!.metadata).toMatchObject({
        organizationId: fx.orgA,
        counts: { notificationsDeleted: 2, auditEntriesDeleted: 1 },
      });

      // Idempotent: a re-run finds nothing and records nothing.
      const again = await retention.apply({ organizationIds: [fx.orgA] });
      expect(Object.values(again.organizations[0]!.counts)).toEqual(
        Array(7).fill(0),
      );
      expect(
        await tx.auditLog.count({
          where: { action: 'DATA_RETENTION_APPLIED', entityId: fx.orgA },
        }),
      ).toBe(1);
    });
  });

  it('skips datasets whose module is disabled and reports the organization', async () => {
    await scenario(async (tx, fx, retention) => {
      await setRetention(tx, fx.orgA, 'retention.syncLogMonths', 3);
      await tx.organizationModuleSetting.create({
        data: {
          organizationId: fx.orgA,
          module: 'GOOGLE_WORKSPACE',
          enabled: false,
        },
      });
      const runId = await syncRun(
        tx,
        fx.orgA,
        await binding(tx, fx.orgA),
        monthsAgo(12),
      );
      const outcome = await retention.apply({ organizationIds: [fx.orgA] });
      expect(outcome.skippedOrganizations).toEqual([fx.orgA]);
      expect(outcome.organizations).toEqual([]);
      expect(await exists(tx, 'GoogleSyncRun', runId)).toBe(true);
    });
  });

  it('anonymizes unsuccessful candidates past the period and keeps the counts reportable', async () => {
    await scenario(async (tx, fx, retention, svc, clock) => {
      clock.value = monthsAgo(14);
      const opening = await openOpening(svc, fx);
      const old = await rejectedCandidate(
        tx,
        fx,
        svc,
        opening.id,
        'old.candidate@example.com',
        13,
      );
      clock.value = monthsAgo(3);
      const young = await rejectedCandidate(
        tx,
        fx,
        svc,
        opening.id,
        'young.candidate@example.com',
        2,
      );
      const live = await svc.applications.create(
        {
          openingId: opening.id,
          candidate: candidateDetails({ email: 'live.candidate@example.com' }),
        },
        ctx(fx.users.hiringAdmin!),
      );
      await tx.$executeRaw`UPDATE "RecruitmentCandidate" SET "createdAt" = ${monthsAgo(13)}, "updatedAt" = ${monthsAgo(13)} WHERE "id" = ${live.candidateId}::uuid`;
      const statusCounts = async () =>
        (
          await tx.recruitmentApplication.groupBy({
            by: ['status'],
            where: { openingId: opening.id },
            _count: { _all: true },
            orderBy: { status: 'asc' },
          })
        ).map((g) => [g.status, g._count._all]);
      const before = await statusCounts();

      // Off by default.
      expect(
        (await retention.apply({ organizationIds: [fx.orgA] })).organizations,
      ).toEqual([]);
      await setRetention(tx, fx.orgA, 'retention.rejectedCandidateMonths', 12);
      const outcome = await retention.apply({ organizationIds: [fx.orgA] });
      expect(outcome.failed).toEqual([]);
      expect(outcome.organizations[0]!.counts.candidatesAnonymized).toBe(1);

      const anonymized = await tx.recruitmentCandidate.findUniqueOrThrow({
        where: { id: old.candidateId },
      });
      expect(anonymized).toMatchObject({
        firstName: 'Anonymized',
        lastName: 'Candidate',
        email: null,
        normalizedEmail: null,
        phone: null,
        location: null,
        notes: null,
        status: 'ARCHIVED',
      });
      expect(anonymized.anonymizedAt).not.toBeNull();
      expect(
        await tx.recruitmentApplication.findUniqueOrThrow({
          where: { id: old.applicationId },
        }),
      ).toMatchObject({
        status: 'REJECTED',
        sourceDetail: null,
        dispositionReason: null,
      });
      expect(
        await tx.recruitmentScreening.findUniqueOrThrow({
          where: { applicationId: old.applicationId },
        }),
      ).toMatchObject({ outcome: 'HOLD', notes: null });
      expect(
        await tx.recruitmentOffer.findFirstOrThrow({
          where: { applicationId: old.applicationId },
        }),
      ).toMatchObject({
        status: 'WITHDRAWN',
        candidateTerms: null,
        internalNotes: null,
        withdrawalReason: 'Redacted',
        rateAmount: expect.anything(),
      });
      expect(
        await tx.recruitmentInterviewFeedback.findFirstOrThrow({
          where: { interview: { applicationId: old.applicationId } },
        }),
      ).toMatchObject({ strengths: null, concerns: null, comments: null });
      // The young candidate's free text is untouched.
      expect(
        await tx.recruitmentScreening.findUniqueOrThrow({
          where: { applicationId: young.applicationId },
        }),
      ).toMatchObject({ notes: 'Mentioned a health condition' });
      expect(
        await tx.recruitmentCandidateDocument.findMany({
          where: { candidateId: old.candidateId },
        }),
      ).toEqual([
        expect.objectContaining({
          kind: 'RESUME',
          title: 'Redacted',
          provider: 'MANUAL_REFERENCE',
          externalUrl: null,
          fileName: null,
          removalReason: 'Removed by data retention.',
          removedAt: expect.any(Date),
        }),
      ]);
      for (const id of [young.candidateId, live.candidateId]) {
        const kept = await tx.recruitmentCandidate.findUniqueOrThrow({
          where: { id },
        });
        expect(kept.anonymizedAt).toBeNull();
        expect(kept.email).not.toBeNull();
      }
      expect(await statusCounts()).toEqual(before);

      // Idempotent, and the identity never comes back.
      expect(
        (await retention.apply({ organizationIds: [fx.orgA] }))
          .organizations[0]!.counts.candidatesAnonymized,
      ).toBe(0);
      expect(
        dbMessage(
          await violation(tx, () =>
            tx.recruitmentCandidate.update({
              where: { id: old.candidateId },
              data: {
                email: 'back@example.com',
                normalizedEmail: 'back@example.com',
              },
            }),
          ),
        ),
      ).toContain('stays anonymized');
    });
  });

  it('guard triggers still block ordinary deletes and anything outside the age rule', async () => {
    await scenario(async (tx, fx, _retention, svc, clock) => {
      await setRetention(tx, fx.orgA, 'retention.notificationMonths', 6);
      await setRetention(tx, fx.orgA, 'retention.rejectedCandidateMonths', 6);
      const user = fx.users.recruiter!;
      const old = await notification(tx, fx.orgA, user, monthsAgo(12), 'read');
      const young = await notification(tx, fx.orgA, user, monthsAgo(2), 'read');
      const runId = await syncRun(
        tx,
        fx.orgA,
        await binding(tx, fx.orgA),
        monthsAgo(24),
      );
      const on = () =>
        tx.$executeRaw`SELECT set_config('hrms.retention_purge', 'on', true)`;
      const message = dbMessage;

      // Outside a retention transaction nothing is deletable, however old.
      expect(
        message(
          await violation(tx, () =>
            tx.notification.delete({ where: { id: old } }),
          ),
        ),
      ).toContain('never deleted');
      expect(
        message(
          await violation(tx, () =>
            tx.googleSyncRun.delete({ where: { id: runId } }),
          ),
        ),
      ).toContain('append-only');
      // Inside one, young rows and organizations without a period stay protected.
      expect(
        message(
          await violation(tx, async () => {
            await on();
            await tx.notification.delete({ where: { id: young } });
          }),
        ),
      ).toContain('Retention purges only');
      expect(
        message(
          await violation(tx, async () => {
            await on();
            await tx.googleSyncRun.delete({ where: { id: runId } });
          }),
        ),
      ).toContain('Retention purges only');
      expect(
        message(
          await violation(tx, async () => {
            await on();
            await tx.auditLog.delete({
              where: { id: await auditEntry(tx, fx.orgA, monthsAgo(1)) },
            });
          }),
        ),
      ).toContain('Retention purges only');

      // Candidates: never anonymized outside retention, nor while not eligible.
      clock.value = monthsAgo(14);
      const opening = await openOpening(svc, fx);
      const candidate = await rejectedCandidate(
        tx,
        fx,
        svc,
        opening.id,
        'guard.candidate@example.com',
        1,
      );
      const anonymize = () =>
        tx.$executeRaw`UPDATE "RecruitmentCandidate" SET "firstName" = 'Anonymized', "lastName" = 'Candidate',
          "email" = NULL, "normalizedEmail" = NULL, "phone" = NULL, "location" = NULL, "notes" = NULL,
          "preferredName" = NULL, "status" = 'ARCHIVED', "anonymizedAt" = now()
          WHERE "id" = ${candidate.candidateId}::uuid`;
      expect(message(await violation(tx, anonymize))).toContain(
        'Only the retention job',
      );
      expect(
        message(
          await violation(tx, async () => {
            await on();
            await anonymize();
          }),
        ),
      ).toContain('Only the retention job');
      // A closed application stays frozen outside retention, and retention only redacts.
      expect(
        message(
          await violation(
            tx,
            () =>
              tx.$executeRaw`UPDATE "RecruitmentApplication" SET "dispositionReason" = NULL WHERE "id" = ${candidate.applicationId}::uuid`,
          ),
        ),
      ).toContain('frozen');
      expect(
        message(
          await violation(tx, async () => {
            await on();
            await tx.$executeRaw`UPDATE "RecruitmentApplication" SET "dispositionReason" = NULL WHERE "id" = ${candidate.applicationId}::uuid`;
          }),
        ),
      ).toContain('Retention only redacts');
      // The read path of the normal guard is unchanged: an ordinary update still works.
      await tx.notification.update({
        where: { id: young },
        data: { archivedAt: new Date() },
      });
    });
  });
});
