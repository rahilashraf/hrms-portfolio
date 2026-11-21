import { Injectable, Logger } from '@nestjs/common';
import { AuthorizationService } from '../authorization/authorization.service.js';
import { PrismaService } from '../database/prisma.service.js';
import { NotificationService } from '../notifications/notification.service.js';
import {
  ALERTS_PER_ACTOR_PER_HOUR,
  cappedAlertDedupeKey,
  refusalAlertDedupeKey,
  type AccountAction,
  type AccountRiskCategory,
} from './employee-account-policy.js';

/** Who receives M1 alerts: holders of this permission at SYSTEM scope. */
export const ACCOUNT_ALERT_PERMISSION = 'audit.read';
export const ACCOUNT_ALERT_TYPE = 'security.account-action-refused';

const ACTION_LABELS: Record<AccountAction, string> = {
  invite: 'invite',
  resend: 'resend an invitation to',
  cancel: 'cancel the invitation of',
  disable: 'disable',
  enable: 'enable',
  requirePasswordChange: 'require a password change for',
  sendPasswordReset: 'send a password reset link to',
  signOut: 'sign out',
  unlock: 'unlock',
};

const RISK_LABELS: Record<AccountRiskCategory, string> = {
  SYSTEM_PRIVILEGED_TARGET: 'the login holds System-level access',
  CROSS_ORGANIZATION:
    'the person is employed or holds access in another organization',
  REPEATED_REFUSALS:
    'the same administrator was refused credential actions repeatedly',
};

const CAPPED_LABEL =
  'the same administrator was refused many times this hour (further attempts this hour are summarized here)';

export interface RefusalAlert {
  risk: AccountRiskCategory;
  action: AccountAction;
  actorUserId: string;
  /** The refused login (or, without one, the employee). */
  subjectType: 'User' | 'Employee';
  subjectId: string;
  /** The organization the alert is filed under: one the actor already has authority in. */
  organizationId: string;
  at: Date;
}

/**
 * Security remediation M1 — alerts to security administrators about high-risk refused account
 * actions. Recipients are active logins holding audit.read at SYSTEM scope (they can already read
 * every audit entry, so the alert discloses nothing new to them), never the actor. Published
 * through the shared notification service as a mandatory SECURITY notice (in-app, and email with
 * its retries), deduplicated per actor and subject per hour (repeats: per actor per day). The
 * text names no organization, role or person; details stay in the audit log.
 *
 * Best effort by design: called after the refusal is final and audited; a failure is logged and
 * never changes the refusal.
 */
@Injectable()
export class EmployeeAccountAlertService {
  private readonly logger = new Logger(EmployeeAccountAlertService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService,
    private readonly notifications: NotificationService,
  ) {}

  async refused(alert: RefusalAlert): Promise<number> {
    let delivered = 0;
    let dedupeKey = refusalAlertDedupeKey(
      alert.risk,
      alert.actorUserId,
      alert.subjectId,
      alert.at,
    );
    let risk = RISK_LABELS[alert.risk];
    try {
      // Per-actor cap: past ALERTS_PER_ACTOR_PER_HOUR distinct alerts this hour, one summary.
      const sent = await this.alertKeysThisHour(alert.actorUserId, alert.at);
      if (!sent.has(dedupeKey) && sent.size >= ALERTS_PER_ACTOR_PER_HOUR) {
        dedupeKey = cappedAlertDedupeKey(alert.actorUserId, alert.at);
        risk = CAPPED_LABEL;
      }
    } catch (error) {
      this.logger.error(
        `Account refusal alert volume could not be read: ${(error as Error).message}`,
      );
    }
    for (const recipient of await this.recipients(alert.actorUserId)) {
      try {
        const result = await this.notifications.publish({
          organizationId: alert.organizationId,
          recipientUserId: recipient,
          type: ACCOUNT_ALERT_TYPE,
          variables: { action: ACTION_LABELS[alert.action], risk },
          link: '/admin/audit',
          sourceEntityType: alert.subjectType,
          sourceEntityId: alert.subjectId,
          dedupeKey,
        });
        if (result.outcome === 'CREATED') delivered += 1;
      } catch (error) {
        this.logger.error(
          `Account refusal alert could not be recorded: ${(error as Error).message}`,
        );
      }
    }
    return delivered;
  }

  /** The distinct alert keys already published about this actor in the alert's UTC hour. */
  private async alertKeysThisHour(actorUserId: string, at: Date) {
    const hour = new Date(`${at.toISOString().slice(0, 13)}:00:00.000Z`);
    const rows = await this.prisma.notification.findMany({
      where: {
        type: ACCOUNT_ALERT_TYPE,
        createdAt: { gte: hour },
        // The actor is always the key's third segment (never match it as a subject).
        OR: [
          'SYSTEM_PRIVILEGED_TARGET',
          'CROSS_ORGANIZATION',
          'REPEATED_REFUSALS',
          'CAPPED',
        ].map((prefix) => ({
          dedupeKey: {
            startsWith: `account-refused:${prefix}:${actorUserId}:`,
          },
        })),
      },
      select: { dedupeKey: true },
      distinct: ['dedupeKey'],
    });
    return new Set(rows.map((row) => row.dedupeKey));
  }

  /** Active logins with audit.read at SYSTEM scope, except the actor, in id order. */
  private async recipients(actorUserId: string) {
    const now = new Date();
    const candidates = await this.prisma.roleAssignment.findMany({
      where: {
        scopeType: 'SYSTEM',
        revokedAt: null,
        userId: { not: actorUserId },
        user: { status: 'ACTIVE', archivedAt: null },
        role: {
          archivedAt: null,
          permissions: {
            some: { permission: { key: ACCOUNT_ALERT_PERMISSION } },
          },
        },
      },
      select: { userId: true },
      distinct: ['userId'],
      orderBy: { userId: 'asc' },
    });
    const recipients: string[] = [];
    for (const { userId } of candidates) {
      // Confirmed through the authorization policy (dates, archived roles, inactive keys).
      const grants = await this.authorization.effectiveGrants(userId, now);
      if (
        grants.some(
          (grant) =>
            grant.permission === ACCOUNT_ALERT_PERMISSION &&
            grant.scope.type === 'SYSTEM',
        )
      )
        recipients.push(userId);
    }
    return recipients;
  }
}
