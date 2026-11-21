import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service.js';
import {
  defaultDocumentReminderSinks,
  sendExpiryReminders,
} from '../src/documents/documents-jobs.js';
import { notificationServices } from '../src/notifications/notifications-producers.js';
import {
  defaultReminderSinks,
  sendTaskReminders,
} from '../src/onboarding/onboarding-jobs.js';
import { sendPerformanceReminders } from '../src/performance/performance-jobs.js';
import { sendRecruitmentReminders } from '../src/recruitment/recruitment-jobs.js';
import {
  documentServices,
  FixedDocumentsClock,
} from './support/documents-fixtures.js';
import { NOTIFICATION_USERS } from './support/notifications-fixtures.js';
import {
  activeTemplate as onboardingTemplate,
  FixedOnboardingClock,
  onboardingServices,
} from './support/onboarding-fixtures.js';
import {
  FixedPerformanceClock,
  openReview,
  performanceServices,
} from './support/performance-fixtures.js';
import {
  candidateDetails,
  FixedRecruitmentClock,
  openOpening,
  recruitmentServices,
} from './support/recruitment-fixtures.js';
import {
  createSchedulingFixtures,
  ctx,
  rollbackClient,
  type SchedulingFixtures,
  type Tx,
} from './support/scheduling-fixtures.js';

config({ path: '../../.env' });

class RollbackFixtures extends Error {}

const at = (iso: string) => ({ now: () => new Date(iso) });

/** Every notification of the organizations, by recipient label. */
async function inbox(tx: Tx, fx: SchedulingFixtures) {
  const labels = new Map<string, string>([
    ...Object.entries(fx.users).map(
      ([label, id]) => [id, label] as [string, string],
    ),
    [fx.selfUser1, 'self1'],
    [fx.selfUser2, 'self2'],
  ]);
  const rows = await tx.notification.findMany({
    where: { organizationId: { in: [fx.orgA, fx.orgB] } },
    include: { deliveries: true },
    orderBy: [{ type: 'asc' }, { createdAt: 'asc' }],
  });
  return rows.map((row) => ({
    ...row,
    to: labels.get(row.recipientUserId) ?? row.recipientUserId,
    email: row.deliveries.find((d) => d.channel === 'EMAIL')!,
  }));
}

describe('Notification producers (database)', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService(process.env.DATABASE_URL!);
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  async function scenario(
    run: (tx: Tx, fx: SchedulingFixtures) => Promise<void>,
  ) {
    await expect(
      prisma.$transaction(
        async (tx) => {
          const fx = await createSchedulingFixtures(tx, NOTIFICATION_USERS);
          await run(tx, fx).catch((error: unknown) => {
            console.error('SCENARIO FAILURE', error);
            throw error;
          });
          throw new RollbackFixtures();
        },
        { timeout: 120_000 },
      ),
    ).rejects.toBeInstanceOf(RollbackFixtures);
  }

  it('sends onboarding task digests to each owner once a day, with their own task titles only', async () => {
    await scenario(async (tx, fx) => {
      const clock = new FixedOnboardingClock();
      const client = rollbackClient(tx);
      const svc = onboardingServices(client, clock);
      await onboardingTemplate(svc, fx);
      const position = await tx.position.create({
        data: {
          organizationId: fx.orgA,
          jobTitleId: (
            await tx.jobTitle.findFirstOrThrow({
              where: { organizationId: fx.orgA },
            })
          ).id,
          name: 'New team position',
          code: `NEW-${fx.suffix}`,
          organizationalUnitId: fx.unitChild,
          departmentId: fx.deptA,
          teamId: fx.teamA,
        },
      });
      const assignment = await tx.employmentAssignment.create({
        data: {
          employeeId: fx.employee1,
          positionId: position.id,
          employmentType: 'FULL_TIME',
          status: 'PLANNED',
          startDate: new Date('2026-04-01T00:00:00.000Z'),
          managerAssignmentId: fx.otherTeamA,
        },
      });
      await svc.workflows.start(
        'ONBOARDING',
        { employmentAssignmentId: assignment.id },
        ctx(fx.users.onboardingHr!),
      );
      clock.value = new Date('2026-03-30T12:00:00.000Z');
      const outcome = await sendTaskReminders(
        client,
        defaultReminderSinks(client, clock),
        clock,
      );
      expect(outcome).toMatchObject({ owners: 3, delivered: 1, failed: [] });
      const rows = await inbox(tx, fx);
      expect(
        rows.map((row) => [
          row.to,
          row.type,
          row.body,
          row.link,
          row.dedupeKey,
        ]),
      ).toEqual(
        expect.arrayContaining([
          [
            'self1',
            'onboarding.tasks-due',
            'You have 1 overdue and 0 upcoming workflow tasks: Sign employment paperwork.',
            '/onboarding',
            'onboarding.tasks-due:2026-03-30',
          ],
          [
            'self2',
            'onboarding.tasks-due',
            'You have 0 overdue and 1 upcoming workflow tasks: Supervisor welcome meeting.',
            '/onboarding',
            'onboarding.tasks-due:2026-03-30',
          ],
          // A task owner without any grant or employment is reachable through their task.
          [
            'itDesk',
            'onboarding.tasks-due',
            'You have 0 overdue and 1 upcoming workflow tasks: Set up accounts.',
            '/onboarding',
            'onboarding.tasks-due:2026-03-30',
          ],
        ]),
      );
      // HR-pool tasks have no owner to notify.
      expect(rows).toHaveLength(3);
      // Idempotent within the day; the next day brings a new digest.
      await sendTaskReminders(
        client,
        defaultReminderSinks(client, clock),
        clock,
      );
      expect(await inbox(tx, fx)).toHaveLength(3);
      clock.value = new Date('2026-03-31T12:00:00.000Z');
      await sendTaskReminders(
        client,
        defaultReminderSinks(client, clock),
        clock,
      );
      expect(
        (await inbox(tx, fx)).filter((row) => row.to === 'itDesk'),
      ).toHaveLength(2);
    });
  });

  it('notifies employees about their own visible documents and HR with counts within clearance', async () => {
    await scenario(async (tx, fx) => {
      const clock = new FixedDocumentsClock();
      const client = rollbackClient(tx);
      const svc = documentServices(client, clock);
      const { items } = await svc.types.initializeDefaults(
        fx.orgA,
        ctx(fx.users.typeAdmin!),
      );
      const types = Object.fromEntries(
        items.map((type) => [type.code, type.id]),
      );
      const create = (
        user: string,
        employeeId: string,
        typeCode: string,
        confidentiality: string,
        title: string,
        expiresOn: string,
      ) =>
        svc.documents.create(
          {
            organizationId: fx.orgA,
            employeeId,
            typeId: types[typeCode]!,
            title,
            confidentiality: confidentiality as 'HR_ONLY',
            version: {
              provider: 'MANUAL_REFERENCE',
              expiresOn,
            },
          },
          ctx(fx.users[user]!),
        );
      await create(
        'hrRecords',
        fx.employee2,
        'CERTIFICATION',
        'EMPLOYEE_VISIBLE',
        'First aid',
        '2026-03-20',
      );
      await create(
        'hrRecords',
        fx.employee2,
        'CERTIFICATION',
        'HR_ONLY',
        'Old first aid',
        '2026-03-10',
      );
      await create(
        'restricted',
        fx.employee1,
        'BACKGROUND-CHECK',
        'RESTRICTED',
        'Police check',
        '2026-03-25',
      );
      await create(
        'hrRecords',
        fx.employee1,
        'LICENSE',
        'MANAGER_VISIBLE',
        'Driver licence',
        '2026-04-01',
      );
      await svc.types.createRequirement(
        { organizationId: fx.orgA, typeId: types.CERTIFICATION! },
        ctx(fx.users.typeAdmin!),
      );
      // Organization email is off: non-mandatory email suppressed, mandatory still sent.
      await notificationServices(client).settings.updateOrganizationSettings(
        { organizationId: fx.orgA, emailEnabled: false },
        ctx(fx.users.settingsAdmin!),
      );
      const outcome = await sendExpiryReminders(
        client,
        defaultDocumentReminderSinks(client, clock),
        clock,
      );
      expect(outcome).toMatchObject({
        organizations: 1,
        expired: 1,
        expiringSoon: 3,
        delivered: 1,
        failed: [],
      });
      const rows = await inbox(tx, fx);
      const summary = rows.map((row) => [row.to, row.type, row.body, row.link]);
      const byText = (a: Array<string | null>, b: Array<string | null>) =>
        a.join('|').localeCompare(b.join('|'));
      expect(summary.sort(byText)).toEqual(
        [
          // The employee: their one employee-visible document (never HR-only or restricted).
          [
            'self2',
            'documents.renewal-due',
            '0 of your documents have expired and 1 expire soon. Please provide renewed copies.',
            '/documents',
          ],
          // HR: counts within each manager's clearance, never their own records.
          [
            'hrRecords',
            'documents.expiry-digest',
            '1 employee documents have expired and 2 expire soon.',
            '/admin/documents',
          ],
          [
            'restricted',
            'documents.expiry-digest',
            '1 employee documents have expired and 3 expire soon.',
            '/admin/documents',
          ],
          [
            'self1',
            'documents.expiry-digest',
            '1 employee documents have expired and 1 expire soon.',
            '/admin/documents',
          ],
          // Employee 1 misses the required certification (mandatory notice).
          [
            'self1',
            'documents.required-missing',
            '1 required documents are missing or expired in your records.',
            '/documents',
          ],
        ].sort(byText),
      );
      expect(
        JSON.stringify(rows.map((row) => [row.title, row.body])),
      ).not.toMatch(/First aid|Police|licence|Background|Certification/i);
      const missing = rows.find(
        (row) => row.type === 'documents.required-missing',
      )!;
      expect(missing).toMatchObject({
        category: 'HR_REQUIRED',
        mandatory: true,
      });
      expect(missing.email).toMatchObject({ status: 'PENDING' });
      expect(
        rows.find((row) => row.type === 'documents.renewal-due')!.email,
      ).toMatchObject({
        status: 'SUPPRESSED',
        suppressedReason: 'ORGANIZATION_EMAIL_DISABLED',
      });
      // Re-running changes nothing; a change in what is reported notifies again.
      await sendExpiryReminders(
        client,
        defaultDocumentReminderSinks(client, clock),
        clock,
      );
      expect(await inbox(tx, fx)).toHaveLength(5);
      clock.value = new Date('2026-03-21T16:00:00.000Z');
      await sendExpiryReminders(
        client,
        defaultDocumentReminderSinks(client, clock),
        clock,
      );
      const later = (await inbox(tx, fx)).filter((row) => row.to === 'self2');
      expect(later.map((row) => row.body)).toContain(
        '1 of your documents have expired and 0 expire soon. Please provide renewed copies.',
      );
    });
  });

  it('reminds the employee and the current reviewer about due performance reviews', async () => {
    await scenario(async (tx, fx) => {
      const client = rollbackClient(tx);
      const svc = performanceServices(client, new FixedPerformanceClock());
      const { review } = await openReview(tx, svc, fx);
      // 2026-11-15: the self-review (due 11-10) is overdue; the reviewer part (12-01) is not due yet.
      expect(
        await sendPerformanceReminders(client, at('2026-11-15T16:00:00Z')),
      ).toMatchObject({
        created: 1,
        failed: [],
      });
      let rows = await inbox(tx, fx);
      expect(
        rows.map((row) => [row.to, row.type, row.title, row.body, row.link]),
      ).toEqual([
        [
          'self1',
          'performance.self-review-due',
          'Your self-review is overdue',
          'Your performance self-review is overdue (due 2026-11-10).',
          `/performance/reviews/${review.id}`,
        ],
      ]);
      // 2026-11-29: the reviewer part is due soon; the self reminder is not repeated.
      expect(
        await sendPerformanceReminders(client, at('2026-11-29T16:00:00Z')),
      ).toMatchObject({
        created: 1,
        existing: 1,
      });
      rows = await inbox(tx, fx);
      expect(rows.map((row) => [row.to, row.type, row.body, row.link])).toEqual(
        [
          [
            'self2',
            'performance.reviews-due',
            'You have 0 overdue and 1 upcoming performance reviews to write.',
            '/performance',
          ],
          expect.arrayContaining(['self1', 'performance.self-review-due']),
        ],
      );
      // Without a reviewer nobody is reminded of the reviewer part.
      await tx.performanceReview.update({
        where: { id: review.id },
        data: {
          reviewerEmployeeId: null,
          reviewerAssignmentId: null,
          reviewerSource: null,
        },
      });
      expect(
        await sendPerformanceReminders(client, at('2026-12-03T16:00:00Z')),
      ).toMatchObject({
        created: 0,
      });
    });
  });

  it('reminds interviewers and offer owners without candidate details, re-checking access', async () => {
    await scenario(async (tx, fx) => {
      const client = rollbackClient(tx);
      const svc = recruitmentServices(client, new FixedRecruitmentClock());
      const admin = ctx(fx.users.hiringAdmin!);
      const opening = await openOpening(svc, fx);
      const application = await svc.applications.create(
        { openingId: opening.id, candidate: candidateDetails() },
        admin,
      );
      const interview = await svc.interviews.schedule(
        application.id,
        {
          type: 'VIDEO',
          title: 'Panel interview with Ada',
          scheduledStart: '2026-03-16T15:00:00Z',
          durationMinutes: 45,
          meetingUrl: 'https://meet.example.com/abc',
          feedbackDueAt: '2026-03-17T12:00:00Z',
          interviewerUserIds: [fx.selfUser2, fx.selfUser1],
        },
        admin,
      );
      // Removed interviewers are not reminded.
      await svc.interviews.removeInterviewer(interview.id, fx.selfUser1, admin);
      const offer = await svc.offers.create(
        application.id,
        {
          positionId: fx.positionOrg,
          employmentType: 'FULL_TIME',
          startDate: '2026-04-01',
          payBasis: 'SALARY',
          rateAmount: '62000.00',
          currency: 'CAD',
          expiresOn: '2026-03-17',
          candidateTerms: 'Full-time Grade 3 teacher.',
        },
        admin,
      );
      await svc.offers.act(offer.id, 'approve', null, ctx(fx.users.approver!));
      await svc.offers.act(offer.id, 'send', null, admin);
      // The approver lost recruitment access: only the creator is told about the expiring offer.
      await tx.roleAssignment.updateMany({
        where: { userId: fx.users.approver! },
        data: { revokedAt: new Date('2026-03-01T00:00:00Z') },
      });
      expect(
        await sendRecruitmentReminders(client, at('2026-03-15T16:00:00Z')),
      ).toMatchObject({
        created: 2,
        skipped: 1,
        failed: [],
      });
      let rows = await inbox(tx, fx);
      expect(rows.map((row) => [row.to, row.type, row.body, row.link])).toEqual(
        [
          [
            'self2',
            'recruitment.interview-upcoming',
            'You have an interview at 2026-03-16 15:00 UTC (45 minutes).',
            '/interviews',
          ],
          [
            'hiringAdmin',
            'recruitment.offer-expiring',
            'An offer you prepared or approved expires on 2026-03-17 and has not been answered.',
            `/recruitment/applications/${application.id}`,
          ],
        ],
      );
      // After the feedback due time: overdue feedback to the interviewer without feedback.
      expect(
        await sendRecruitmentReminders(client, at('2026-03-17T16:00:00Z')),
      ).toMatchObject({
        created: 1,
        existing: 1,
      });
      rows = await inbox(tx, fx);
      expect(
        rows.find((row) => row.type === 'recruitment.feedback-overdue'),
      ).toMatchObject({
        to: 'self2',
        body: 'Your feedback for an interview was due 2026-03-17 12:00 UTC.',
        link: '/interviews',
      });
      expect(
        JSON.stringify(rows.map((row) => [row.title, row.body, row.link])),
      ).not.toMatch(
        /Ada|Lovelace|candidate@|555|62000|CAD|Panel|meet\.example|Grade/,
      );
      // Re-running is idempotent.
      expect(
        await sendRecruitmentReminders(client, at('2026-03-17T16:30:00Z')),
      ).toMatchObject({
        created: 0,
      });
    });
  });
});
