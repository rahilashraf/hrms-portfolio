import type { PrismaService } from '../../src/database/prisma.service.js';
import {
  NotificationTransportError,
  type NotificationEmailMessage,
  type NotificationEmailTransport,
} from '../../src/notifications/notification-email.transport.js';
import { NotificationDeliveryService } from '../../src/notifications/notification-delivery.service.js';
import { notificationServices } from '../../src/notifications/notifications-producers.js';
import { DOCUMENT_PERMISSION_KEYS } from './documents-fixtures.js';
import { RECRUITMENT_PERMISSION_KEYS } from './recruitment-fixtures.js';
import type { UserSpec } from './scheduling-fixtures.js';

export const NOTIFICATION_PERMISSION_KEYS = [
  'notification.template.manage',
  'notification.settings.manage',
] as const;

/**
 * Users of notification specs. templateAdmin and cycleAdmin also configure the onboarding,
 * performance and document fixtures the producer scenarios need.
 */
export const NOTIFICATION_USERS: Record<string, UserSpec[]> = {
  templateAdmin: [
    {
      permissions: [
        'notification.template.manage',
        'onboarding.template.manage',
        'performance.template.manage',
      ],
      scope: 'org',
    },
  ],
  settingsAdmin: [
    { permissions: ['notification.settings.manage'], scope: 'org' },
  ],
  teamNotificationAdmin: [
    { permissions: NOTIFICATION_PERMISSION_KEYS, scope: 'teamA' },
  ],
  orgBAdmin: [{ permissions: NOTIFICATION_PERMISSION_KEYS, scope: 'orgB' }],
  cycleAdmin: [{ permissions: ['performance.cycle.manage'], scope: 'org' }],
  onboardingHr: [
    { permissions: ['onboarding.read', 'onboarding.manage'], scope: 'org' },
  ],
  typeAdmin: [{ permissions: ['document.type.manage'], scope: 'org' }],
  hrRecords: [
    {
      permissions: [
        'document.read',
        'document.confidential.read',
        'document.manage',
      ],
      scope: 'org',
    },
  ],
  restricted: [
    {
      permissions: [
        'document.read',
        'document.confidential.read',
        'document.restricted.read',
        'document.manage',
      ],
      scope: 'org',
    },
  ],
  teamRecords: [
    { permissions: ['document.read', 'document.manage'], scope: 'teamA' },
  ],
  reader: [{ permissions: ['document.read'], scope: 'org' }],
  hiringAdmin: [
    { permissions: RECRUITMENT_PERMISSION_KEYS, scope: 'org' },
    {
      permissions: [
        'employee.read',
        'employee.manage',
        'compensation.read',
        'compensation.manage',
      ],
      scope: 'org',
    },
  ],
  approver: [
    {
      permissions: ['recruitment.read', 'recruitment.offer.approve'],
      scope: 'org',
    },
  ],
  /** Employee 1's own account with full document rights (never counted for own records). */
  self1: [{ permissions: DOCUMENT_PERMISSION_KEYS, scope: 'org' }],
  /** No grants and no employment: an outsider of every organization. */
  outsider: [],
  /** No grants: owns specific-user onboarding tasks only. */
  // Works in Org A without any permission (a role with none): may own onboarding tasks.
  itDesk: [{ permissions: [], scope: 'org' }],
};

export class FixedNotificationsClock {
  value = new Date('2026-03-15T16:00:00.000Z');

  now() {
    return this.value;
  }
}

/** A recording transport; `fail` decides per message whether (and how) a send fails. */
export class RecordingTransport implements NotificationEmailTransport {
  readonly provider = 'test';
  readonly sent: NotificationEmailMessage[] = [];
  constructor(
    public fail: (
      message: NotificationEmailMessage,
    ) => NotificationTransportError | null = () => null,
    private readonly delayMs = 0,
  ) {}

  async send(message: NotificationEmailMessage) {
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    const error = this.fail(message);
    if (error) throw error;
    this.sent.push(message);
    return { providerReference: `test-${message.notificationId}` };
  }

  async providerFor() {
    return this.provider;
  }
}

export function notificationTestServices(
  prisma: PrismaService,
  clock: FixedNotificationsClock,
) {
  const services = notificationServices(prisma, clock);
  return {
    ...services,
    delivery: (
      transport: NotificationEmailTransport,
      webOrigin: string | null = null,
    ) =>
      new NotificationDeliveryService(
        prisma,
        services.settings,
        transport,
        clock,
        { webOrigin },
      ),
  };
}

export type NotificationTestServices = ReturnType<
  typeof notificationTestServices
>;
