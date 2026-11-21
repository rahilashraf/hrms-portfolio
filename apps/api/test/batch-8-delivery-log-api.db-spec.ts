import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service.js';
import { FixedClock } from './support/leave-fixtures.js';
import {
  FixedNotificationsClock,
  notificationTestServices,
  RecordingTransport,
} from './support/notifications-fixtures.js';
import {
  createSchedulingFixtures,
  rollbackClient,
  type UserSpec,
} from './support/scheduling-fixtures.js';
import { withTimeHttp } from './support/time-http.js';

config({ path: '../../.env' });

class RollbackFixtures extends Error {}

const USERS: Record<string, UserSpec[]> = {
  deliveryReader: [
    { permissions: ['notification.delivery.read'], scope: 'org' },
  ],
  teamReader: [{ permissions: ['notification.delivery.read'], scope: 'teamA' }],
  templateAdmin: [
    {
      permissions: [
        'notification.template.manage',
        'notification.settings.manage',
      ],
      scope: 'org',
    },
  ],
  orgBReader: [{ permissions: ['notification.delivery.read'], scope: 'orgB' }],
};

type Delivery = Record<string, unknown> & {
  id: string;
  type: string;
  channel: string;
  status: string;
  recipientName: string;
};

/**
 * Batch 8 (N5) — the read-only organization delivery log over HTTP, on the scenario's
 * rollback transaction: notification.delivery.read at organization scope only (template and
 * settings permissions do not grant it), other organizations' deliveries not found, filters,
 * cursor paging and privacy (never a subject, body, email address or variable).
 */
describe('Notification delivery log API (HTTP, database)', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService(process.env.DATABASE_URL!);
    await prisma.$connect();
  });
  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it('permissions, isolation, filters, paging, attempts and privacy', async () => {
    await expect(
      prisma.$transaction(
        async (tx) => {
          const fx = await createSchedulingFixtures(tx, USERS);
          await tx.organization.update({
            where: { id: fx.orgA },
            data: { timezone: 'America/Toronto' },
          });
          const clock = new FixedNotificationsClock();
          clock.value = new Date('2026-03-15T16:00:00.000Z');
          const svc = notificationTestServices(rollbackClient(tx), clock);
          const secretTitle = 'Payroll ledger 98765';
          const publish = async (
            organizationId: string,
            recipientUserId: string,
            key: string,
          ) => {
            const result = await svc.notifications.publish({
              organizationId,
              recipientUserId,
              type: 'onboarding.tasks-due',
              variables: {
                overdueCount: 1,
                dueSoonCount: 0,
                taskTitles: secretTitle,
              },
              link: '/onboarding',
              dedupeKey: key,
            });
            if (result.outcome !== 'CREATED') throw new Error('not created');
            return result.notification.id;
          };
          const n1 = await publish(fx.orgA, fx.selfUser1, 'b8-log-1');
          clock.value = new Date('2026-03-16T16:00:00.000Z');
          await tx.notificationPreference.upsert({
            where: {
              userId_category: { userId: fx.selfUser2, category: 'ONBOARDING' },
            },
            create: {
              userId: fx.selfUser2,
              category: 'ONBOARDING',
              emailEnabled: false,
            },
            update: { emailEnabled: false },
          });
          const n2 = await publish(fx.orgA, fx.selfUser2, 'b8-log-2');
          const nB = await publish(fx.orgB, fx.users.orgBReader!, 'b8-log-b');
          // Deliver n1's email (one SUCCEEDED attempt).
          await svc
            .delivery(new RecordingTransport())
            .deliverPending({ organizationIds: [fx.orgA] });

          const person = async (userId: string) =>
            (await tx.user.findUniqueOrThrow({
              where: { id: userId },
              select: {
                email: true,
                person: { select: { firstName: true, lastName: true } },
              },
            }))!;
          const self1 = await person(fx.selfUser1);

          await withTimeHttp(tx, new FixedClock(), async (http) => {
            const reader = await http.as(fx.users.deliveryReader!);
            const teamReader = await http.as(fx.users.teamReader!);
            const templateAdmin = await http.as(fx.users.templateAdmin!);
            const outsider = await http.as(fx.users.orgBReader!);
            const employee = await http.as(fx.selfUser1);
            const path = (query: string) =>
              `/notifications/deliveries?organizationId=${fx.orgA}${query}`;

            await http.anonymous().get(path('')).expect(401);
            // Organization scope only; other notification permissions do not grant it.
            for (const caller of [
              teamReader,
              templateAdmin,
              outsider,
              employee,
            ])
              await caller.get(path('')).expect(403);
            // Validation before any service runs.
            await reader.get(path('&status=DELIVERED')).expect(400);
            await reader.get(path('&from=2026-3-1')).expect(400);
            await reader.get(path('&recipientUserId=x')).expect(400);
            await reader.get(path('&limit=500')).expect(400);
            await reader
              .get(path('&from=2026-03-20&to=2026-03-10'))
              .expect(400);

            const all = (await reader.get(path('')).expect(200)).body as {
              items: Delivery[];
              nextCursor: string | null;
              timezone: string;
              types: Array<{ key: string; category: string }>;
            };
            expect(all.timezone).toBe('America/Toronto');
            expect(all.types.map((t) => t.key)).toContain(
              'payroll.payslip-available',
            );
            // Two notifications × (IN_APP + EMAIL), newest first; organization B absent.
            expect(all.items).toHaveLength(4);
            expect(all.items.map((item) => item.channel).sort()).toEqual([
              'EMAIL',
              'EMAIL',
              'IN_APP',
              'IN_APP',
            ]);
            const text = JSON.stringify(all);
            expect(text).not.toContain(secretTitle);
            expect(text).not.toContain('Onboarding tasks need your attention');
            expect(text).not.toContain(self1.email);
            expect(text).not.toContain('/onboarding');
            for (const item of all.items) {
              expect(Object.keys(item).sort()).toEqual(
                [
                  'id',
                  'type',
                  'category',
                  'mandatory',
                  'recipientName',
                  'channel',
                  'status',
                  'attemptCount',
                  'nextAttemptAt',
                  'sentAt',
                  'lastErrorCode',
                  'suppressedReason',
                  'createdAt',
                  'updatedAt',
                ].sort(),
              );
            }

            // Filters.
            const filtered = async (query: string) =>
              (
                (await reader.get(path(query)).expect(200)).body as {
                  items: Delivery[];
                }
              ).items;
            expect(
              (await filtered('&channel=EMAIL&status=SUPPRESSED')).map(
                (item) => [item.recipientName, item.suppressedReason],
              ),
            ).toEqual([[expect.any(String), 'USER_PREFERENCE']]);
            expect(await filtered('&status=SENT&channel=EMAIL')).toHaveLength(
              1,
            );
            expect(await filtered('&type=payroll.payslip-available')).toEqual(
              [],
            );
            expect(await filtered('&category=ONBOARDING')).toHaveLength(4);
            expect(await filtered('&category=TIME')).toEqual([]);
            const byName = await filtered(
              `&recipient=${encodeURIComponent(self1.person!.lastName!.slice(0, 4))}`,
            );
            expect(byName.length).toBeGreaterThanOrEqual(2);
            // Local dates in the organization's time zone (deliveries are recorded now).
            const [{ today, yesterday, tomorrow }] = await tx.$queryRaw<
              Array<{ today: string; yesterday: string; tomorrow: string }>
            >`SELECT to_char((now() AT TIME ZONE 'America/Toronto')::date, 'YYYY-MM-DD') AS "today",
                     to_char((now() AT TIME ZONE 'America/Toronto')::date - 1, 'YYYY-MM-DD') AS "yesterday",
                     to_char((now() AT TIME ZONE 'America/Toronto')::date + 1, 'YYYY-MM-DD') AS "tomorrow"`;
            expect(await filtered(`&from=${today}&to=${today}`)).toHaveLength(
              4,
            );
            expect(await filtered(`&to=${yesterday}`)).toEqual([]);
            expect(await filtered(`&from=${tomorrow}`)).toEqual([]);

            // Cursor paging: no overlap, nothing missed.
            const seen: string[] = [];
            let cursor: string | null = null;
            do {
              const page = (
                await reader
                  .get(
                    path(
                      `&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
                    ),
                  )
                  .expect(200)
              ).body as { items: Delivery[]; nextCursor: string | null };
              seen.push(...page.items.map((item) => item.id));
              cursor = page.nextCursor;
            } while (cursor);
            expect(seen).toEqual(all.items.map((item) => item.id));
            await reader.get(path('&cursor=not-a-cursor')).expect(400);

            // Attempt history; other organizations' deliveries are not found.
            const sentEmail = all.items.find(
              (item) => item.channel === 'EMAIL' && item.status === 'SENT',
            )!;
            const detail = (
              await reader
                .get(`/notifications/deliveries/${sentEmail.id}`)
                .expect(200)
            ).body as Delivery & { attempts: Array<Record<string, unknown>> };
            expect(detail.attempts).toEqual([
              {
                attemptNumber: 1,
                status: 'SUCCEEDED',
                outcome: 'SUCCEEDED',
                provider: 'test',
                errorCode: null,
                startedAt: expect.any(String),
                finishedAt: expect.any(String),
              },
            ]);
            expect(JSON.stringify(detail)).not.toContain(self1.email);
            await outsider
              .get(`/notifications/deliveries/${sentEmail.id}`)
              .expect(404);
            await teamReader
              .get(`/notifications/deliveries/${sentEmail.id}`)
              .expect(404);
            const deliveryB = await tx.notificationDelivery.findFirstOrThrow({
              where: { notificationId: nB, channel: 'EMAIL' },
            });
            await reader
              .get(`/notifications/deliveries/${deliveryB.id}`)
              .expect(404);
            await reader
              .get(
                '/notifications/deliveries/00000000-0000-4000-8000-000000000009',
              )
              .expect(404);
            await outsider
              .get(`/notifications/deliveries?organizationId=${fx.orgB}`)
              .expect(200);

            // The admin page offers the log only where it is granted.
            const orgs = (
              await reader.get('/notifications/organizations').expect(200)
            ).body as {
              items: Array<{ id: string; actions: Record<string, boolean> }>;
            };
            expect(orgs.items.find((o) => o.id === fx.orgA)?.actions).toEqual({
              canManageTemplates: false,
              canManageSettings: false,
              canReadDeliveries: true,
            });
            void n1;
            void n2;
          });
          throw new RollbackFixtures();
        },
        { timeout: 120_000 },
      ),
    ).rejects.toBeInstanceOf(RollbackFixtures);
  });
});
