import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service.js';
import { NotificationTransportError } from '../src/notifications/notification-email.transport.js';
import {
  MAX_EMAIL_ATTEMPTS,
  SEND_LEASE_MS,
} from '../src/notifications/notifications-domain.js';
import { deliverPendingNotifications } from '../src/notifications/notifications-jobs.js';
import { notificationServices } from '../src/notifications/notifications-producers.js';
import type { PublishInput } from '../src/notifications/notification.service.js';
import { failure } from './support/performance-fixtures.js';
import {
  FixedNotificationsClock,
  NOTIFICATION_USERS,
  notificationTestServices,
  RecordingTransport,
  type NotificationTestServices,
} from './support/notifications-fixtures.js';
import {
  cleanupSchedulingFixtures,
  createSchedulingFixtures,
  ctx,
  rollbackClient,
  violation,
  type SchedulingFixtures,
  type Tx,
} from './support/scheduling-fixtures.js';

config({ path: '../../.env' });

class RollbackFixtures extends Error {}

const tasksDue = (
  fx: SchedulingFixtures,
  recipientUserId: string,
  overrides: Partial<PublishInput> = {},
): PublishInput => ({
  organizationId: fx.orgA,
  recipientUserId,
  type: 'onboarding.tasks-due',
  variables: {
    overdueCount: 1,
    dueSoonCount: 2,
    taskTitles: 'Set up accounts',
  },
  link: '/onboarding',
  dedupeKey: 'onboarding.tasks-due:2026-03-15',
  ...overrides,
});

const deliveries = (tx: Tx, notificationId: string) =>
  tx.notificationDelivery.findMany({
    where: { notificationId },
    orderBy: { channel: 'asc' },
  });

const emailOf = async (tx: Tx, notificationId: string) =>
  tx.notificationDelivery.findUniqueOrThrow({
    where: { notificationId_channel: { notificationId, channel: 'EMAIL' } },
    include: { attempts: { orderBy: { attemptNumber: 'asc' } } },
  });

describe('Notifications (database)', () => {
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
      svc: NotificationTestServices,
      clock: FixedNotificationsClock,
    ) => Promise<void>,
  ) {
    await expect(
      prisma.$transaction(
        async (tx) => {
          const fx = await createSchedulingFixtures(tx, NOTIFICATION_USERS);
          const clock = new FixedNotificationsClock();
          const svc = notificationTestServices(rollbackClient(tx), clock);
          await run(tx, fx, svc, clock).catch((error: unknown) => {
            console.error('SCENARIO FAILURE', error);
            throw error;
          });
          throw new RollbackFixtures();
        },
        { timeout: 120_000 },
      ),
    ).rejects.toBeInstanceOf(RollbackFixtures);
  }

  it('publishes idempotently with an in-app and an email delivery, to organization members only', async () => {
    await scenario(async (tx, fx, svc) => {
      const first = await svc.notifications.publish(
        tasksDue(fx, fx.selfUser1, {
          variables: {
            overdueCount: 1,
            dueSoonCount: 2,
            taskTitles: 'Set up accounts',
            secret: 'not allowed',
          } as PublishInput['variables'],
        }),
      );
      expect(first.outcome).toBe('CREATED');
      if (first.outcome === 'REJECTED') throw new Error('unexpected');
      expect(first.notification).toMatchObject({
        organizationId: fx.orgA,
        recipientUserId: fx.selfUser1,
        type: 'onboarding.tasks-due',
        category: 'ONBOARDING',
        mandatory: false,
        title: 'Onboarding tasks need your attention',
        body: 'You have 1 overdue and 2 upcoming workflow tasks: Set up accounts.',
        link: '/onboarding',
        sourceDomain: 'ONBOARDING',
        readAt: null,
      });
      expect(
        (await deliveries(tx, first.notification.id)).map((d) => [
          d.channel,
          d.status,
          d.attemptCount,
        ]),
      ).toEqual([
        ['IN_APP', 'SENT', 0],
        ['EMAIL', 'PENDING', 0],
      ]);
      // The same dedupe key returns the existing notification, inside a caller's transaction
      // too, without aborting it.
      const again = await svc.notifications.publish(
        tasksDue(fx, fx.selfUser1, { variables: { overdueCount: 9 } }),
        tx,
      );
      expect(again).toMatchObject({
        outcome: 'EXISTING',
        notification: { id: first.notification.id },
      });
      expect(
        await tx.notification.count({
          where: { recipientUserId: fx.selfUser1 },
        }),
      ).toBe(1);
      // Organization membership: employment (selfUser2), grants (templateAdmin) and owned tasks
      // count; an outsider and another organization's notifications do not.
      expect(
        (await svc.notifications.publish(tasksDue(fx, fx.selfUser2))).outcome,
      ).toBe('CREATED');
      expect(
        (await svc.notifications.publish(tasksDue(fx, fx.users.templateAdmin!)))
          .outcome,
      ).toBe('CREATED');
      expect(
        await svc.notifications.publish(tasksDue(fx, fx.users.outsider!)),
      ).toEqual({
        outcome: 'REJECTED',
        reason: 'RECIPIENT_NOT_IN_ORGANIZATION',
      });
      expect(
        await svc.notifications.publish(
          tasksDue(fx, fx.selfUser1, { organizationId: fx.orgB }),
        ),
      ).toMatchObject({ outcome: 'REJECTED' });
      expect(
        (
          await svc.notifications.publish(
            tasksDue(fx, fx.users.orgBAdmin!, { organizationId: fx.orgB }),
          )
        ).outcome,
      ).toBe('CREATED');
      // A disabled account receives nothing new.
      await tx.user.update({
        where: { id: fx.selfUser2 },
        data: { status: 'DISABLED' },
      });
      expect(
        await svc.notifications.publish(
          tasksDue(fx, fx.selfUser2, { dedupeKey: 'other' }),
        ),
      ).toMatchObject({ outcome: 'REJECTED' });
      // Input validation.
      for (const [input, code] of [
        [
          tasksDue(fx, fx.selfUser1, { type: 'unknown.type' }),
          'NOTIFICATION_TYPE_UNKNOWN',
        ],
        [
          tasksDue(fx, fx.selfUser1, { link: 'https://evil.example.com' }),
          'NOTIFICATION_LINK_INVALID',
        ],
        [
          tasksDue(fx, fx.selfUser1, { link: '//evil.example.com' }),
          'NOTIFICATION_LINK_INVALID',
        ],
        [
          tasksDue(fx, fx.selfUser1, { dedupeKey: 'has space' }),
          'NOTIFICATION_DEDUPE_INVALID',
        ],
        [tasksDue(fx, 'not-a-user'), 'NOTIFICATION_RECIPIENT_INVALID'],
      ] as const) {
        expect(await failure(svc.notifications.publish(input))).toEqual({
          status: 400,
          code,
        });
      }
      // The database refuses what the service refuses, and freezes content.
      const id = first.notification.id;
      expect(
        await violation(tx, () =>
          tx.notification.update({ where: { id }, data: { title: 'Changed' } }),
        ),
      ).toBeTruthy();
      expect(
        await violation(tx, () => tx.notification.delete({ where: { id } })),
      ).toBeTruthy();
      expect(
        await violation(tx, () =>
          tx.$executeRawUnsafe(
            `INSERT INTO "Notification" ("id","organizationId","recipientUserId","type","category","title","body","link","sourceDomain","dedupeKey")
             VALUES (gen_random_uuid(), '${fx.orgA}', '${fx.selfUser1}', 'onboarding.tasks-due', 'ONBOARDING', 'x', 'y', 'https://evil.example.com', 'ONBOARDING', 'k')`,
          ),
        ),
      ).toBeTruthy();
      expect(
        await violation(tx, () =>
          tx.notificationDelivery.update({
            where: {
              notificationId_channel: { notificationId: id, channel: 'IN_APP' },
            },
            data: { status: 'FAILED', sentAt: null },
          }),
        ),
      ).toBeTruthy();
      // Recipient addresses are never stored with the notification.
      expect(
        JSON.stringify(
          await tx.notification.findMany({
            where: { organizationId: fx.orgA },
          }),
        ),
      ).not.toMatch(/@example\.com/);
    });
  });

  it('renders organization overrides with escaped, whitelisted placeholders and audits without text', async () => {
    await scenario(async (tx, fx, svc) => {
      const admin = ctx(fx.users.templateAdmin!);
      const input = {
        organizationId: fx.orgA,
        key: 'onboarding.tasks-due',
        subjectTemplate: 'Checklist reminder',
        bodyTemplate: 'Due now: {{taskTitles}} ({{overdueCount}} late).',
      };
      for (const user of [
        'settingsAdmin',
        'teamNotificationAdmin',
        'orgBAdmin',
        'hrRecords',
      ]) {
        expect(
          await failure(svc.templates.create(input, ctx(fx.users[user]!))),
        ).toMatchObject({ status: 403 });
      }
      for (const [body, code] of [
        ['Hello {{candidateEmail}}', 'NOTIFICATION_TEMPLATE_PLACEHOLDER'],
        ['Click https://evil.example.com', 'NOTIFICATION_TEMPLATE_LINK'],
        ['Broken {{taskTitles}', 'NOTIFICATION_TEMPLATE_SYNTAX'],
      ]) {
        expect(
          await failure(
            svc.templates.create({ ...input, bodyTemplate: body! }, admin),
          ),
        ).toEqual({ status: 400, code });
      }
      expect(
        await failure(
          svc.templates.create({ ...input, key: 'made.up' }, admin),
        ),
      ).toEqual({ status: 400, code: 'NOTIFICATION_TYPE_UNKNOWN' });
      const override = await svc.templates.create(input, admin);
      expect(override).toMatchObject({
        version: 1,
        system: false,
        category: 'ONBOARDING',
        mandatory: false,
      });
      expect(await failure(svc.templates.create(input, admin))).toEqual({
        status: 409,
        code: 'NOTIFICATION_TEMPLATE_EXISTS',
      });
      const listed = await svc.templates.list(fx.users.templateAdmin!, fx.orgA);
      const row = listed.items.find(
        (item) => item.key === 'onboarding.tasks-due',
      )!;
      expect(row.override?.id).toBe(override.id);
      expect(row.system).toMatchObject({ system: true, organizationId: null });
      expect(listed.items.map((item) => item.key)).toEqual(
        expect.arrayContaining([
          'documents.required-missing',
          'recruitment.interview-upcoming',
        ]),
      );
      expect(
        await svc.templates.preview(fx.users.templateAdmin!, {
          organizationId: fx.orgA,
          key: 'onboarding.tasks-due',
        }),
      ).toMatchObject({
        subject: 'Checklist reminder',
        body: 'Due now: Set up accounts, Supervisor welcome meeting (1 late).',
      });
      expect(
        await failure(
          svc.templates.preview(fx.users.templateAdmin!, {
            organizationId: fx.orgA,
            key: 'onboarding.tasks-due',
            bodyTemplate: '{{nope}}',
          }),
        ),
      ).toEqual({ status: 400, code: 'NOTIFICATION_TEMPLATE_PLACEHOLDER' });
      // Publishing uses the override; values cannot inject placeholders or line breaks.
      const published = await svc.notifications.publish(
        tasksDue(fx, fx.selfUser1, {
          variables: {
            taskTitles: 'Badge {{overdueCount}}\n<script>',
            overdueCount: 2,
          },
        }),
      );
      expect(
        published.outcome === 'CREATED' && published.notification,
      ).toMatchObject({
        title: 'Checklist reminder',
        body: 'Due now: Badge overdueCount <script> (2 late).',
        templateId: override.id,
        templateVersion: 1,
      });
      // Other organizations keep the system template.
      const orgB = await svc.notifications.publish(
        tasksDue(fx, fx.users.orgBAdmin!, { organizationId: fx.orgB }),
      );
      expect(orgB.outcome === 'CREATED' && orgB.notification.title).toBe(
        'Onboarding tasks need your attention',
      );
      // Edits version the template; others' and system templates are not found.
      const edited = await svc.templates.update(
        override.id,
        { subjectTemplate: 'Checklist reminder v2' },
        admin,
      );
      expect(edited.version).toBe(2);
      expect(
        await failure(
          svc.templates.update(
            override.id,
            { subjectTemplate: 'x' },
            ctx(fx.users.orgBAdmin!),
          ),
        ),
      ).toMatchObject({ status: 404 });
      expect(
        await failure(
          svc.templates.update(row.system.id, { subjectTemplate: 'x' }, admin),
        ),
      ).toMatchObject({ status: 404 });
      await svc.templates.archive(override.id, admin);
      expect(
        await failure(
          svc.templates.update(override.id, { subjectTemplate: 'y' }, admin),
        ),
      ).toEqual({ status: 409, code: 'NOTIFICATION_TEMPLATE_ARCHIVED' });
      const afterArchive = await svc.notifications.publish(
        tasksDue(fx, fx.selfUser2, { dedupeKey: 'after-archive' }),
      );
      expect(
        afterArchive.outcome === 'CREATED' && afterArchive.notification.title,
      ).toBe('Onboarding tasks need your attention');
      // A new override is allowed once the old one is archived.
      await svc.templates.create(input, admin);
      // Seeding is idempotent and never overwrites system rows.
      await svc.templates.ensureSystemTemplates(tx);
      expect(
        await tx.notificationTemplate.count({
          where: { organizationId: null, key: 'onboarding.tasks-due' },
        }),
      ).toBe(1);
      // Database guards: frozen type/category, versioned edits, frozen archives, no deletes.
      expect(
        await violation(tx, () =>
          tx.notificationTemplate.update({
            where: { id: override.id },
            data: { subjectTemplate: 'z' },
          }),
        ),
      ).toBeTruthy();
      expect(
        await violation(tx, () =>
          tx.notificationTemplate.update({
            where: { id: row.system.id },
            data: { category: 'GENERAL' },
          }),
        ),
      ).toBeTruthy();
      expect(
        await violation(tx, () =>
          tx.notificationTemplate.delete({ where: { id: row.system.id } }),
        ),
      ).toBeTruthy();
      expect(
        await violation(tx, () =>
          tx.notificationTemplate.create({
            data: {
              organizationId: fx.orgA,
              key: 'documents.required-missing',
              category: 'HR_REQUIRED',
              subjectTemplate: 's',
              bodyTemplate: 'b',
              allowedVariables: [],
              mandatory: true,
            },
          }),
        ),
      ).toBeTruthy();
      // Audit: identifiers and keys, never template text.
      const audits = await tx.auditLog.findMany({
        where: { entityType: 'NotificationTemplate', entityId: override.id },
      });
      expect(audits.map((a) => a.action).sort()).toEqual([
        'NOTIFICATION_TEMPLATE_ARCHIVED',
        'NOTIFICATION_TEMPLATE_CREATED',
        'NOTIFICATION_TEMPLATE_UPDATED',
      ]);
      expect(JSON.stringify(audits)).not.toMatch(/Checklist|Due now/);
    });
  });

  it('resolves email by preferences and organization settings, never suppressing mandatory notices by default', async () => {
    await scenario(async (tx, fx, svc) => {
      const self = ctx(fx.selfUser1);
      expect(
        (await svc.settings.preferences(fx.selfUser1)).items.find(
          (i) => i.category === 'HR_REQUIRED',
        ),
      ).toEqual({
        category: 'HR_REQUIRED',
        mandatory: true,
        configurable: false,
        emailEnabled: true,
      });
      expect(
        await failure(
          svc.settings.updatePreferences(
            [{ category: 'HR_REQUIRED', emailEnabled: false }],
            self,
          ),
        ),
      ).toEqual({ status: 400, code: 'NOTIFICATION_CATEGORY_MANDATORY' });
      expect(
        await failure(
          svc.settings.updatePreferences(
            [
              { category: 'ONBOARDING', emailEnabled: false },
              { category: 'ONBOARDING', emailEnabled: true },
            ],
            self,
          ),
        ),
      ).toEqual({ status: 400, code: 'NOTIFICATION_CATEGORY_DUPLICATE' });
      const prefs = await svc.settings.updatePreferences(
        [{ category: 'ONBOARDING', emailEnabled: false }],
        self,
      );
      expect(
        prefs.items.find((i) => i.category === 'ONBOARDING')?.emailEnabled,
      ).toBe(false);
      const email = async (input: PublishInput) => {
        const result = await svc.notifications.publish(input);
        if (result.outcome === 'REJECTED') throw new Error('rejected');
        const row = await emailOf(tx, result.notification.id);
        return [row.status, row.suppressedReason];
      };
      const missing = (key: string, user = fx.selfUser1): PublishInput => ({
        organizationId: fx.orgA,
        recipientUserId: user,
        type: 'documents.required-missing',
        variables: { missingCount: 1 },
        link: '/documents',
        dedupeKey: key,
      });
      const renewal = (key: string, user = fx.selfUser1): PublishInput => ({
        organizationId: fx.orgA,
        recipientUserId: user,
        type: 'documents.renewal-due',
        variables: { expiredCount: 0, expiringSoonCount: 1 },
        link: '/documents',
        dedupeKey: key,
      });
      expect(await email(tasksDue(fx, fx.selfUser1))).toEqual([
        'SUPPRESSED',
        'USER_PREFERENCE',
      ]);
      // Another user's preference is theirs alone.
      expect(await email(tasksDue(fx, fx.selfUser2))).toEqual([
        'PENDING',
        null,
      ]);
      const mandatory = await svc.notifications.publish(missing('m1'));
      expect(
        mandatory.outcome === 'CREATED' && mandatory.notification,
      ).toMatchObject({
        category: 'HR_REQUIRED',
        mandatory: true,
      });
      expect(await email(missing('m1b'))).toEqual(['PENDING', null]);
      // Organization settings: only notification.settings.manage at organization scope.
      for (const user of [
        'templateAdmin',
        'teamNotificationAdmin',
        'orgBAdmin',
      ]) {
        expect(
          await failure(
            svc.settings.updateOrganizationSettings(
              { organizationId: fx.orgA, emailEnabled: false },
              ctx(fx.users[user]!),
            ),
          ),
        ).toMatchObject({ status: 403 });
        expect(
          await failure(
            svc.settings.organizationSettings(fx.users[user]!, fx.orgA),
          ),
        ).toMatchObject({ status: 403 });
      }
      const admin = ctx(fx.users.settingsAdmin!);
      expect(
        await failure(
          svc.settings.updateOrganizationSettings(
            {
              organizationId: fx.orgA,
              categories: [{ category: 'SECURITY', emailEnabled: false }],
            },
            admin,
          ),
        ),
      ).toEqual({ status: 400, code: 'NOTIFICATION_CATEGORY_MANDATORY' });
      expect(
        await failure(
          svc.settings.updateOrganizationSettings(
            {
              organizationId: fx.orgA,
              emailEnabled: true,
              suppressMandatoryEmail: true,
            },
            admin,
          ),
        ),
      ).toEqual({ status: 400, code: 'NOTIFICATION_MANDATORY_SUPPRESSION' });
      const settings = await svc.settings.updateOrganizationSettings(
        {
          organizationId: fx.orgA,
          categories: [{ category: 'DOCUMENTS', emailEnabled: false }],
        },
        admin,
      );
      expect(settings).toMatchObject({
        emailEnabled: true,
        suppressMandatoryEmail: false,
      });
      expect(
        settings.categories.find((c) => c.category === 'DOCUMENTS')
          ?.emailEnabled,
      ).toBe(false);
      expect(await email(renewal('r1', fx.selfUser2))).toEqual([
        'SUPPRESSED',
        'ORGANIZATION_CATEGORY_DISABLED',
      ]);
      // The kill switch suppresses non-mandatory email; mandatory notices still go out.
      await svc.settings.updateOrganizationSettings(
        { organizationId: fx.orgA, emailEnabled: false },
        admin,
      );
      expect(await email(tasksDue(fx, fx.users.templateAdmin!))).toEqual([
        'SUPPRESSED',
        'ORGANIZATION_EMAIL_DISABLED',
      ]);
      expect(await email(missing('m2'))).toEqual(['PENDING', null]);
      // Only an explicit decision suppresses mandatory email.
      await svc.settings.updateOrganizationSettings(
        { organizationId: fx.orgA, suppressMandatoryEmail: true },
        admin,
      );
      expect(await email(missing('m3'))).toEqual([
        'SUPPRESSED',
        'ORGANIZATION_EMAIL_DISABLED',
      ]);
      // Turning email back on clears the mandatory suppression.
      expect(
        await svc.settings.updateOrganizationSettings(
          { organizationId: fx.orgA, emailEnabled: true },
          admin,
        ),
      ).toMatchObject({ emailEnabled: true, suppressMandatoryEmail: false });
      // Other organizations are untouched.
      expect(
        await email(
          tasksDue(fx, fx.users.orgBAdmin!, { organizationId: fx.orgB }),
        ),
      ).toEqual(['PENDING', null]);
      const audit = await tx.auditLog.findMany({
        where: { action: 'NOTIFICATION_SETTINGS_UPDATED', entityId: fx.orgA },
      });
      expect(audit).toHaveLength(4);
      expect(
        await violation(tx, () =>
          tx.notificationPreference.create({
            data: {
              userId: fx.selfUser1,
              category: 'SECURITY',
              emailEnabled: false,
            },
          }),
        ),
      ).toBeTruthy();
      expect(
        await violation(tx, () =>
          tx.organizationNotificationPolicy.update({
            where: { organizationId: fx.orgA },
            data: { suppressMandatoryEmail: true },
          }),
        ),
      ).toBeTruthy();
    });
  });

  it('keeps each inbox private: paging, unread counts, read and archive only on own notifications', async () => {
    await scenario(async (tx, fx, svc, clock) => {
      const ids: string[] = [];
      for (let index = 0; index < 3; index += 1) {
        clock.value = new Date(Date.UTC(2026, 2, 15, 16, index));
        const result = await svc.notifications.publish(
          tasksDue(fx, fx.selfUser1, { dedupeKey: `k-${index}` }),
        );
        if (result.outcome === 'REJECTED') throw new Error('rejected');
        ids.push(result.notification.id);
      }
      const other = await svc.notifications.publish(tasksDue(fx, fx.selfUser2));
      if (other.outcome === 'REJECTED') throw new Error('rejected');
      const page1 = await svc.notifications.mine(fx.selfUser1, { limit: 2 });
      expect(page1.items.map((n) => n.id)).toEqual([ids[2], ids[1]]);
      expect(page1.items[0]).toMatchObject({
        organization: { id: fx.orgA },
        title: 'Onboarding tasks need your attention',
        readAt: null,
      });
      expect(page1.items[0]).not.toHaveProperty('recipientUserId');
      expect(page1.items[0]).not.toHaveProperty('dedupeKey');
      const page2 = await svc.notifications.mine(fx.selfUser1, {
        limit: 2,
        cursor: page1.nextCursor!,
      });
      expect(page2).toEqual({
        items: [expect.objectContaining({ id: ids[0] })],
        nextCursor: null,
      });
      expect(await svc.notifications.unreadCount(fx.selfUser1)).toEqual({
        unread: 3,
      });
      // Nobody reaches another user's notification: not found, nothing changes.
      for (const action of ['markRead', 'archive'] as const) {
        expect(
          await failure(
            svc.notifications[action](other.notification.id, ctx(fx.selfUser1)),
          ),
        ).toMatchObject({ status: 404 });
      }
      expect(
        (await svc.notifications.mine(fx.selfUser2)).items.map((n) => n.id),
      ).toEqual([other.notification.id]);
      expect(await svc.notifications.unreadCount(fx.selfUser2)).toEqual({
        unread: 1,
      });
      const read = await svc.notifications.markRead(ids[0]!, ctx(fx.selfUser1));
      expect(read.readAt).toBe(clock.value.toISOString());
      // Marking twice is harmless (read time recorded once).
      clock.value = new Date('2026-03-16T10:00:00.000Z');
      expect(
        (await svc.notifications.markRead(ids[0]!, ctx(fx.selfUser1))).readAt,
      ).toBe(read.readAt);
      expect(
        (
          await svc.notifications.mine(fx.selfUser1, { unreadOnly: true })
        ).items.map((n) => n.id),
      ).toEqual([ids[2], ids[1]]);
      const archived = await svc.notifications.archive(
        ids[2]!,
        ctx(fx.selfUser1),
      );
      expect(archived).toMatchObject({
        archivedAt: clock.value.toISOString(),
        readAt: clock.value.toISOString(),
      });
      expect(
        (await svc.notifications.mine(fx.selfUser1)).items.map((n) => n.id),
      ).toEqual([ids[1], ids[0]]);
      expect(
        (
          await svc.notifications.mine(fx.selfUser1, { archived: true })
        ).items.map((n) => n.id),
      ).toEqual([ids[2]]);
      expect(await svc.notifications.markAllRead(ctx(fx.selfUser1))).toEqual({
        updated: 1,
      });
      expect(await svc.notifications.unreadCount(fx.selfUser1)).toEqual({
        unread: 0,
      });
      expect(await svc.notifications.unreadCount(fx.selfUser2)).toEqual({
        unread: 1,
      });
      expect(
        await failure(
          svc.notifications.mine(fx.selfUser1, { cursor: 'forged' }),
        ),
      ).toEqual({ status: 400, code: 'NOTIFICATION_CURSOR_INVALID' });
      expect(
        await violation(tx, () =>
          tx.notification.update({
            where: { id: ids[0]! },
            data: { readAt: new Date() },
          }),
        ),
      ).toBeTruthy();
    });
  });

  it('delivers email once, retries with backoff, fails after the maximum and reclaims expired leases', async () => {
    await scenario(async (tx, fx, svc, clock) => {
      const publish = async (key: string, user = fx.selfUser1) => {
        const result = await svc.notifications.publish(
          tasksDue(fx, user, { dedupeKey: key }),
        );
        if (result.outcome === 'REJECTED') throw new Error('rejected');
        return result.notification.id;
      };
      const only = { organizationIds: [fx.orgA] };
      const ok = new RecordingTransport();
      const sentId = await publish('ok');
      await tx.user.update({
        where: { id: fx.selfUser1 },
        data: { email: `changed-${fx.suffix.toLowerCase()}@example.com` },
      });
      const delivery = svc.delivery(ok, 'https://hrms.example.com/');
      expect(await delivery.deliverPending(only)).toMatchObject({
        claimed: 1,
        sent: 1,
        errors: [],
      });
      // The address is read at send time from the user record.
      expect(ok.sent).toEqual([
        expect.objectContaining({
          notificationId: sentId,
          to: `changed-${fx.suffix.toLowerCase()}@example.com`,
          subject: 'Onboarding tasks need your attention',
          text: expect.stringContaining(
            'Open in HRMS: https://hrms.example.com/onboarding',
          ),
        }),
      ]);
      const sent = await emailOf(tx, sentId);
      expect(sent).toMatchObject({
        status: 'SENT',
        attemptCount: 1,
        leaseExpiresAt: null,
      });
      expect(sent.attempts).toEqual([
        expect.objectContaining({
          attemptNumber: 1,
          status: 'SUCCEEDED',
          provider: 'test',
          providerReference: `test-${sentId}`,
        }),
      ]);
      // A sent delivery is never sent again.
      expect(await delivery.deliverPending(only)).toMatchObject({
        claimed: 0,
        sent: 0,
      });
      expect(ok.sent).toHaveLength(1);

      // Retryable failures back off, then fail after MAX_EMAIL_ATTEMPTS.
      const flakyId = await publish('flaky');
      const flaky = new RecordingTransport(
        () =>
          new NotificationTransportError(
            'PROVIDER_UNAVAILABLE',
            true,
            'Mailbox ada@example.com busy',
          ),
      );
      const flakyDelivery = svc.delivery(flaky);
      const start = clock.value.getTime();
      expect(await flakyDelivery.deliverPending(only)).toMatchObject({
        claimed: 1,
        retried: 1,
      });
      let row = await emailOf(tx, flakyId);
      expect(row).toMatchObject({
        status: 'PENDING',
        attemptCount: 1,
        lastErrorCode: 'PROVIDER_UNAVAILABLE',
      });
      expect(row.nextAttemptAt?.getTime()).toBe(start + 60_000);
      expect(row.attempts[0]).toMatchObject({
        status: 'RETRYABLE_FAILURE',
        errorCode: 'PROVIDER_UNAVAILABLE',
        errorMessage: 'Mailbox [redacted] busy',
      });
      // Not due yet: nothing is claimed.
      expect(await flakyDelivery.deliverPending(only)).toMatchObject({
        claimed: 0,
      });
      for (let attempt = 2; attempt <= MAX_EMAIL_ATTEMPTS; attempt += 1) {
        clock.value = new Date(
          (await emailOf(tx, flakyId)).nextAttemptAt!.getTime(),
        );
        expect(await flakyDelivery.deliverPending(only)).toMatchObject({
          claimed: 1,
        });
      }
      row = await emailOf(tx, flakyId);
      expect(row).toMatchObject({
        status: 'FAILED',
        attemptCount: MAX_EMAIL_ATTEMPTS,
        nextAttemptAt: null,
      });
      expect(row.attempts.map((a) => a.attemptNumber)).toEqual([1, 2, 3, 4, 5]);
      expect(
        row.attempts
          .slice(1)
          .map(
            (a, i) =>
              a.startedAt.getTime() - row.attempts[i]!.startedAt.getTime(),
          ),
      ).toEqual([60_000, 120_000, 240_000, 480_000]);
      clock.value = new Date(clock.value.getTime() + 86_400_000);
      expect(await flakyDelivery.deliverPending(only)).toMatchObject({
        claimed: 0,
      });
      expect(JSON.stringify(row.attempts)).not.toMatch(
        /ada@example|Onboarding tasks|Set up accounts/,
      );

      // Permanent failures fail at once.
      const rejectedId = await publish('permanent');
      await svc
        .delivery(
          new RecordingTransport(
            () => new NotificationTransportError('ADDRESS_REJECTED', false),
          ),
        )
        .deliverPending(only);
      expect(await emailOf(tx, rejectedId)).toMatchObject({
        status: 'FAILED',
        attemptCount: 1,
        lastErrorCode: 'ADDRESS_REJECTED',
        attempts: [expect.objectContaining({ status: 'PERMANENT_FAILURE' })],
      });
      // Unknown errors are retryable and recorded generically.
      const unknownId = await publish('unknown');
      await svc
        .delivery(
          new RecordingTransport(() => {
            throw new Error('smtp password=hunter2 for ada@example.com');
          }),
        )
        .deliverPending(only);
      expect((await emailOf(tx, unknownId)).attempts[0]).toMatchObject({
        status: 'RETRYABLE_FAILURE',
        errorCode: 'TRANSPORT_ERROR',
        errorMessage: 'Unexpected transport error.',
      });

      // A crashed worker's SENDING delivery is reclaimed after its lease, the old attempt abandoned.
      const crashedId = await publish('crashed', fx.selfUser2);
      const crashed = await emailOf(tx, crashedId);
      await tx.notificationDelivery.update({
        where: { id: crashed.id },
        data: {
          status: 'SENDING',
          attemptCount: 1,
          leaseExpiresAt: new Date(clock.value.getTime() + SEND_LEASE_MS),
        },
      });
      await tx.notificationDeliveryAttempt.create({
        data: {
          deliveryId: crashed.id,
          organizationId: fx.orgA,
          attemptNumber: 1,
          status: 'STARTED',
          provider: 'test',
          startedAt: clock.value,
        },
      });
      const recovery = new RecordingTransport();
      // While the lease runs, nobody else claims it.
      expect(await svc.delivery(recovery).deliverPending(only)).toMatchObject({
        claimed: 0,
        reclaimed: 0,
      });
      expect(recovery.sent).toEqual([]);
      clock.value = new Date(clock.value.getTime() + SEND_LEASE_MS + 1);
      const reclaimed = await svc.delivery(recovery).deliverPending(only);
      expect(reclaimed.reclaimed).toBe(1);
      expect(recovery.sent.map((m) => m.notificationId)).toContain(crashedId);
      expect(await emailOf(tx, crashedId)).toMatchObject({
        status: 'SENT',
        attemptCount: 2,
        attempts: [
          expect.objectContaining({
            attemptNumber: 1,
            status: 'ABANDONED',
            errorCode: 'LEASE_EXPIRED',
          }),
          expect.objectContaining({ attemptNumber: 2, status: 'SUCCEEDED' }),
        ],
      });

      // Preferences and the account are re-checked when sending.
      const laterId = await publish('later', fx.selfUser2);
      await svc.settings.updatePreferences(
        [{ category: 'ONBOARDING', emailEnabled: false }],
        ctx(fx.selfUser2),
      );
      const inactiveId = await publish('inactive', fx.users.templateAdmin!);
      await tx.user.update({
        where: { id: fx.users.templateAdmin! },
        data: { status: 'DISABLED' },
      });
      const suppressed = await svc
        .delivery(new RecordingTransport())
        .deliverPending(only);
      expect(suppressed).toMatchObject({ suppressed: 2, claimed: 0 });
      expect(await emailOf(tx, laterId)).toMatchObject({
        status: 'SUPPRESSED',
        suppressedReason: 'USER_PREFERENCE',
        attempts: [],
      });
      expect(await emailOf(tx, inactiveId)).toMatchObject({
        status: 'SUPPRESSED',
        suppressedReason: 'RECIPIENT_INACTIVE',
      });

      // Attempts are append-only; final deliveries are frozen.
      expect(
        await violation(tx, () =>
          tx.notificationDeliveryAttempt.updateMany({
            where: { deliveryId: sent.id },
            data: { errorCode: 'X' },
          }),
        ),
      ).toBeTruthy();
      expect(
        await violation(tx, () =>
          tx.notificationDeliveryAttempt.deleteMany({
            where: { deliveryId: sent.id },
          }),
        ),
      ).toBeTruthy();
      expect(
        await violation(tx, () =>
          tx.notificationDelivery.update({
            where: { id: sent.id },
            data: {
              status: 'PENDING',
              sentAt: null,
              nextAttemptAt: new Date(),
            },
          }),
        ),
      ).toBeTruthy();
    });
  });
});

describe('Notification concurrency (committed data)', () => {
  let prisma: PrismaService;
  let fx: SchedulingFixtures;

  beforeAll(async () => {
    prisma = new PrismaService(process.env.DATABASE_URL!);
    await prisma.$connect();
    fx = await prisma.$transaction(
      (tx) => createSchedulingFixtures(tx, NOTIFICATION_USERS),
      { timeout: 60_000 },
    );
  });

  afterAll(async () => {
    if (fx) await cleanupSchedulingFixtures(prisma, fx);
    await prisma?.$disconnect();
  });

  it('creates one notification when the same dedupe key is published in parallel', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        notificationServices(prisma).notifications.publish(
          tasksDue(fx, fx.selfUser1, { dedupeKey: `parallel-${fx.suffix}` }),
        ),
      ),
    );
    expect(results.filter((r) => r.outcome === 'CREATED')).toHaveLength(1);
    expect(results.filter((r) => r.outcome === 'EXISTING')).toHaveLength(7);
    const ids = new Set(
      results.map((r) => (r.outcome === 'REJECTED' ? null : r.notification.id)),
    );
    expect(ids.size).toBe(1);
    const [id] = [...ids];
    expect(
      await prisma.notification.count({
        where: {
          recipientUserId: fx.selfUser1,
          dedupeKey: `parallel-${fx.suffix}`,
        },
      }),
    ).toBe(1);
    expect(
      await prisma.notificationDelivery.count({
        where: { notificationId: id! },
      }),
    ).toBe(2);
  });

  it('sends each delivery exactly once with two workers claiming concurrently', async () => {
    const services = notificationServices(prisma);
    const published: string[] = [];
    for (let index = 0; index < 12; index += 1) {
      const result = await services.notifications.publish(
        tasksDue(fx, index % 2 ? fx.selfUser1 : fx.selfUser2, {
          dedupeKey: `workers-${index}`,
        }),
      );
      if (result.outcome !== 'CREATED') throw new Error('not created');
      published.push(result.notification.id);
    }
    const a = new RecordingTransport(() => null, 15);
    const b = new RecordingTransport(() => null, 15);
    const options = { batchSize: 3, organizationIds: [fx.orgA] };
    const [first, second] = await Promise.all([
      deliverPendingNotifications(prisma, a, options),
      deliverPendingNotifications(prisma, b, options),
    ]);
    const sentIds = [...a.sent, ...b.sent].map((m) => m.notificationId);
    expect(sentIds.filter((id) => published.includes(id)).sort()).toEqual(
      [...published].sort(),
    );
    expect(new Set(sentIds).size).toBe(sentIds.length);
    expect(first.claimed + second.claimed).toBeGreaterThanOrEqual(12);
    expect(first.errors).toEqual([]);
    expect(second.errors).toEqual([]);
    const rows = await prisma.notificationDelivery.findMany({
      where: { notificationId: { in: published }, channel: 'EMAIL' },
      include: { attempts: true },
    });
    expect(
      rows.every(
        (row) =>
          row.status === 'SENT' &&
          row.attemptCount === 1 &&
          row.attempts.length === 1,
      ),
    ).toBe(true);
    // Running again sends nothing.
    const again = new RecordingTransport();
    await deliverPendingNotifications(prisma, again, options);
    expect(
      again.sent.filter((m) => published.includes(m.notificationId)),
    ).toEqual([]);
  });
});
