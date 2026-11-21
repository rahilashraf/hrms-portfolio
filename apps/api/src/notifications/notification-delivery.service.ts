import { Logger } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import type { PrismaService } from '../database/prisma.service.js';
import {
  classifyTransportError,
  EMAIL_PROVIDER_NOT_CONFIGURED,
  type NotificationEmailTransport,
} from './notification-email.transport.js';
import { NotificationsClock, type Tx } from './notifications-common.js';
import {
  afterFailure,
  EMAIL_MAX_AGE_MS,
  isMandatory,
  MAX_EMAIL_ATTEMPTS,
  resolveEmailDelivery,
  safeErrorCode,
  safeErrorMessage,
  SEND_LEASE_MS,
  SEND_TIMEOUT_MS,
} from './notifications-domain.js';
import type { NotificationSettingsService } from './notification-settings.service.js';
import { FeatureGateService } from '../features/feature-gate.service.js';

export interface DeliverPendingOutcome {
  claimed: number;
  sent: number;
  retried: number;
  failed: number;
  suppressed: number;
  /** Deliveries whose previous worker's lease expired (crash/timeout) and were claimed again. */
  reclaimed: number;
  /**
   * Claims this worker gave up because another worker took them over: before the send (Batch 8,
   * D1: nothing sent) or, rarely, after it (the other worker's outcome is kept).
   */
  lost: number;
  /** Batch 8 (D1): sends whose outcome is unknown (timed out); recorded UNCERTAIN, not retried. */
  uncertain: number;
  /** Batch 8 (D2): deliveries suppressed because no email provider is configured. */
  providerNotConfigured: number;
  /** Batch 8 (O1): deliveries suppressed because they waited past EMAIL_MAX_AGE_MS. */
  expired: number;
  /** Internal errors (not provider failures, which are recorded per attempt). */
  errors: Array<{ deliveryId: string; message: string }>;
  /**
   * Phase 18: organizations with the NOTIFICATIONS module disabled. Their deliveries are left
   * untouched (never claimed, never sent) until the module is enabled again.
   */
  skippedOrganizations: string[];
}

interface Claim {
  deliveryId: string;
  attemptNumber: number;
  attemptId: string;
  notificationId: string;
  recipientUserId: string;
  organizationId: string;
  to: string;
  subject: string;
  text: string;
}

type SendResult =
  | { ok: true; providerReference: string | null }
  | {
      ok: false;
      code: string;
      retryable: boolean;
      message: string | null;
      /** The provider may or may not have accepted the message (a timed-out send). */
      uncertain?: boolean;
    };

class SendTimeout extends Error {}

/**
 * The email delivery worker. Due PENDING deliveries (and SENDING ones whose lease expired)
 * are claimed in batches with FOR UPDATE SKIP LOCKED and marked SENDING with a lease and a
 * STARTED attempt in one short transaction; the email is sent outside it; the result is
 * recorded only while the claim is still ours. A SENT delivery is final (never resent);
 * failures retry with exponential backoff until MAX_EMAIL_ATTEMPTS, then FAIL.
 *
 * Batch 8 (D1): a batch is sent one by one, so a claim can wait longer than its lease. Just
 * before each send the worker re-checks it still owns the claim and renews its lease (one
 * conditional update); a claim another worker reclaimed meanwhile is dropped unsent. Each send
 * is bounded by SEND_TIMEOUT_MS, well inside the renewed lease, so no other worker can claim a
 * delivery while its send is in flight; a send that times out has an unknown outcome and is
 * recorded UNCERTAIN (delivery FAILED, DELIVERY_OUTCOME_UNCERTAIN) instead of being retried.
 * A worker that stops after renewing (crash, deploy, frozen VM) leaves a renewed lease: when it
 * expires, the next worker records the attempt UNCERTAIN (LEASE_EXPIRED_DURING_SEND) and does
 * not resend; only a claim that never reached its send is ABANDONED and claimed again. This
 * prevents duplicate sends between workers; it is not exactly-once delivery (an uncertain
 * email may never have been delivered; a provider that accepts and then errors can duplicate).
 *
 * Preferences, organization settings and the recipient's account are re-checked at claim
 * time, and the address is read from the User record then — never stored on a notification.
 */
export class NotificationDeliveryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: NotificationSettingsService,
    private readonly transport: NotificationEmailTransport,
    private readonly clock = new NotificationsClock(),
    private readonly options: { webOrigin?: string | null } = {},
  ) {}

  private readonly logger = new Logger('NotificationDelivery');

  async deliverPending(
    options: {
      batchSize?: number;
      maxBatches?: number;
      /** Restrict to some organizations (operations and tests); all by default. */
      organizationIds?: string[];
      /** The send time budget (tests); SEND_TIMEOUT_MS by default, never above it. */
      sendTimeoutMs?: number;
    } = {},
  ): Promise<DeliverPendingOutcome> {
    const batchSize = Math.min(Math.max(options.batchSize ?? 50, 1), 500);
    const maxBatches = Math.max(options.maxBatches ?? 20, 1);
    const outcome: DeliverPendingOutcome = {
      claimed: 0,
      sent: 0,
      retried: 0,
      failed: 0,
      suppressed: 0,
      reclaimed: 0,
      lost: 0,
      uncertain: 0,
      providerNotConfigured: 0,
      expired: 0,
      errors: [],
      skippedOrganizations: [],
    };
    const sendTimeoutMs = Math.min(
      Math.max(options.sendTimeoutMs ?? SEND_TIMEOUT_MS, 1),
      SEND_TIMEOUT_MS,
    );
    const disabled = [
      ...(await new FeatureGateService(this.prisma).disabledOrganizations(
        'NOTIFICATIONS',
      )),
    ].sort();
    outcome.skippedOrganizations = options.organizationIds
      ? disabled.filter((id) => options.organizationIds!.includes(id))
      : disabled;
    for (let batch = 0; batch < maxBatches; batch += 1) {
      const claims = await this.claim(
        batchSize,
        outcome,
        options.organizationIds ?? null,
        disabled,
      );
      if (claims === null) break;
      for (const claim of claims)
        await this.send(claim, outcome, sendTimeoutMs);
    }
    // Operational warnings (counts only: no addresses, subjects or bodies).
    if (outcome.providerNotConfigured > 0)
      this.logger.warn(
        `${outcome.providerNotConfigured} notification email(s) suppressed: no email provider is configured (EMAIL_PROVIDER_NOT_CONFIGURED). Configure SMTP or a Gmail connection; suppressed email is not resent automatically.`,
      );
    if (outcome.uncertain > 0)
      this.logger.warn(
        `${outcome.uncertain} notification email(s) timed out with an unknown outcome (DELIVERY_OUTCOME_UNCERTAIN); they are not retried automatically.`,
      );
    if (outcome.lost > 0)
      this.logger.warn(
        `${outcome.lost} notification email claim(s) were taken over by another worker.`,
      );
    return outcome;
  }

  /** Claims one batch; null when nothing was due. */
  private async claim(
    batchSize: number,
    outcome: DeliverPendingOutcome,
    organizationIds: string[] | null,
    skipped: string[],
  ) {
    const now = this.clock.now();
    return this.prisma.$transaction(async (tx) => {
      const due = await tx.$queryRaw<
        Array<{
          id: string;
          status: string;
          attemptCount: number;
          leaseExpiresAt: Date | null;
        }>
      >(Prisma.sql`
        SELECT "id", "status"::text AS "status", "attemptCount", "leaseExpiresAt"
        FROM "NotificationDelivery"
        WHERE "channel" = 'EMAIL'
        AND (${organizationIds}::uuid[] IS NULL OR "organizationId" = ANY(${organizationIds}::uuid[]))
        AND NOT ("organizationId" = ANY(${skipped}::uuid[]))
        AND (
          ("status" = 'PENDING' AND "nextAttemptAt" <= ${now})
          OR ("status" = 'SENDING' AND "leaseExpiresAt" <= ${now})
        )
        ORDER BY "nextAttemptAt" ASC NULLS FIRST, "id" ASC
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED`);
      if (due.length === 0) return null;
      const claims: Claim[] = [];
      for (const row of due) {
        if (row.status === 'SENDING') {
          // Batch 8 (review M1): a lease renewed after the claim means the worker reached its
          // send (renew() runs immediately before it): the provider may have the message.
          // That outcome is unknown — recorded UNCERTAIN and never resent automatically. Only
          // a claim that never reached its send is abandoned and claimed again.
          const started = await tx.notificationDeliveryAttempt.findFirst({
            where: { deliveryId: row.id, status: 'STARTED' },
            select: { id: true, startedAt: true },
          });
          if (
            started &&
            row.leaseExpiresAt &&
            row.leaseExpiresAt.getTime() >
              started.startedAt.getTime() + SEND_LEASE_MS
          ) {
            await tx.notificationDeliveryAttempt.update({
              where: { id: started.id },
              data: {
                status: 'UNCERTAIN',
                finishedAt: now,
                errorCode: 'LEASE_EXPIRED_DURING_SEND',
              },
            });
            await tx.notificationDelivery.update({
              where: { id: row.id },
              data: {
                status: 'FAILED',
                leaseExpiresAt: null,
                nextAttemptAt: null,
                lastErrorCode: 'DELIVERY_OUTCOME_UNCERTAIN',
              },
            });
            outcome.uncertain += 1;
            outcome.failed += 1;
            continue;
          }
          outcome.reclaimed += 1;
          await tx.notificationDeliveryAttempt.updateMany({
            where: { deliveryId: row.id, status: 'STARTED' },
            data: {
              status: 'ABANDONED',
              finishedAt: now,
              errorCode: 'LEASE_EXPIRED',
            },
          });
          if (row.attemptCount >= MAX_EMAIL_ATTEMPTS) {
            await tx.notificationDelivery.update({
              where: { id: row.id },
              data: {
                status: 'FAILED',
                leaseExpiresAt: null,
                nextAttemptAt: null,
                lastErrorCode: 'LEASE_EXPIRED',
              },
            });
            outcome.failed += 1;
            continue;
          }
        }
        const claim = await this.claimOne(tx, row.id, now, outcome);
        if (claim) claims.push(claim);
      }
      return claims;
    });
  }

  private async claimOne(
    tx: Tx,
    deliveryId: string,
    now: Date,
    outcome: DeliverPendingOutcome,
  ): Promise<Claim | null> {
    const delivery = await tx.notificationDelivery.findUniqueOrThrow({
      where: { id: deliveryId },
      include: {
        notification: {
          include: {
            recipient: {
              select: { email: true, status: true, archivedAt: true },
            },
          },
        },
      },
    });
    const notification = delivery.notification;
    const recipient = notification.recipient;
    const inactive =
      recipient.archivedAt !== null ||
      recipient.status === 'DISABLED' ||
      recipient.status === 'ARCHIVED';
    const expired =
      notification.createdAt.getTime() < now.getTime() - EMAIL_MAX_AGE_MS;
    const decision = inactive
      ? ({ deliver: false, reason: 'RECIPIENT_INACTIVE' } as const)
      : expired
        ? ({ deliver: false, reason: 'DELIVERY_EXPIRED' } as const)
        : resolveEmailDelivery({
            category: notification.category,
            mandatory: isMandatory(
              notification.category,
              notification.mandatory,
            ),
            ...(await this.settings.emailInputs(
              tx,
              notification.organizationId,
              notification.recipientUserId,
              notification.category,
            )),
          });
    if (!decision.deliver) {
      await tx.notificationDelivery.update({
        where: { id: deliveryId },
        data: {
          status: 'SUPPRESSED',
          suppressedReason: decision.reason,
          leaseExpiresAt: null,
          nextAttemptAt: null,
        },
      });
      outcome.suppressed += 1;
      if (decision.reason === 'DELIVERY_EXPIRED') outcome.expired += 1;
      return null;
    }
    const provider = (
      (await this.providerOf(notification.organizationId)) ||
      this.transport.provider
    ).slice(0, 64);
    const attemptNumber = delivery.attemptCount + 1;
    await tx.notificationDelivery.update({
      where: { id: deliveryId },
      data: {
        status: 'SENDING',
        attemptCount: attemptNumber,
        leaseExpiresAt: new Date(now.getTime() + SEND_LEASE_MS),
      },
    });
    const attempt = await tx.notificationDeliveryAttempt.create({
      data: {
        deliveryId,
        organizationId: delivery.organizationId,
        attemptNumber,
        status: 'STARTED',
        provider,
        startedAt: now,
      },
    });
    outcome.claimed += 1;
    const origin = this.options.webOrigin?.replace(/\/+$/, '');
    return {
      deliveryId,
      attemptNumber,
      attemptId: attempt.id,
      notificationId: notification.id,
      recipientUserId: notification.recipientUserId,
      organizationId: notification.organizationId,
      to: recipient.email,
      subject: notification.title,
      text:
        notification.link && origin
          ? `${notification.body}\n\nOpen in HRMS: ${origin}${notification.link}`
          : notification.body,
    };
  }

  private readonly providers = new Map<string, Promise<string | null>>();

  /** D3: the provider recorded on attempts, resolved once per organization and run. */
  private providerOf(organizationId: string) {
    let provider = this.providers.get(organizationId);
    if (!provider) {
      provider = this.transport
        .providerFor(organizationId)
        .catch(() => null)
        .then((name) => (name && name.trim() ? name.trim() : null));
      this.providers.set(organizationId, provider);
    }
    return provider;
  }

  /**
   * D1: re-checks that the claim is still this worker's (SENDING under this attempt) and renews
   * its lease, immediately before the send. False when another worker reclaimed it.
   */
  private async renew(claim: Claim) {
    const now = this.clock.now();
    // One millisecond beyond a fresh claim's lease, and always beyond the stored lease, so a
    // renewal is recognisable (review M1: "the send may have started") even within the claim's
    // millisecond or if the worker clock stepped back (review L-a).
    const count = await this.prisma.$executeRaw(Prisma.sql`
      UPDATE "NotificationDelivery"
      SET "leaseExpiresAt" = GREATEST(
            "leaseExpiresAt" + interval '1 millisecond',
            ${new Date(now.getTime() + SEND_LEASE_MS + 1)}::timestamptz
          ),
          "updatedAt" = ${now}
      WHERE "id" = ${claim.deliveryId}::uuid
        AND "status" = 'SENDING'
        AND "attemptCount" = ${claim.attemptNumber}`);
    return count === 1;
  }

  private async send(
    claim: Claim,
    outcome: DeliverPendingOutcome,
    sendTimeoutMs: number,
  ) {
    try {
      if (!(await this.renew(claim))) {
        outcome.lost += 1;
        return;
      }
    } catch (error) {
      outcome.errors.push({
        deliveryId: claim.deliveryId,
        message: safeErrorMessage(
          error instanceof Error ? error.message : String(error),
        )!,
      });
      return;
    }
    let result: SendResult;
    let timer: NodeJS.Timeout | undefined;
    try {
      const sent = await Promise.race([
        this.transport.send({
          to: claim.to,
          subject: claim.subject,
          text: claim.text,
          notificationId: claim.notificationId,
          recipientUserId: claim.recipientUserId,
          organizationId: claim.organizationId,
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new SendTimeout()), sendTimeoutMs);
        }),
      ]);
      result = {
        ok: true,
        providerReference: sent.providerReference?.slice(0, 200) ?? null,
      };
    } catch (error) {
      result =
        error instanceof SendTimeout
          ? {
              ok: false,
              code: 'SEND_TIMEOUT',
              retryable: false,
              uncertain: true,
              message:
                'The send did not finish in time; it may have been delivered.',
            }
          : { ok: false, ...classifyTransportError(error) };
    } finally {
      if (timer) clearTimeout(timer);
    }
    try {
      await this.record(claim, result, outcome);
    } catch (error) {
      outcome.errors.push({
        deliveryId: claim.deliveryId,
        message: safeErrorMessage(
          error instanceof Error ? error.message : String(error),
        )!,
      });
    }
  }

  private async record(
    claim: Claim,
    result: SendResult,
    outcome: DeliverPendingOutcome,
  ) {
    const now = this.clock.now();
    await this.prisma.$transaction(async (tx) => {
      // Ours only while still SENDING under this attempt (a reclaimer would have moved on).
      const owned = {
        id: claim.deliveryId,
        status: 'SENDING' as const,
        attemptCount: claim.attemptNumber,
      };
      if (result.ok) {
        const { count } = await tx.notificationDelivery.updateMany({
          where: owned,
          data: {
            status: 'SENT',
            sentAt: now,
            leaseExpiresAt: null,
            nextAttemptAt: null,
            lastErrorCode: null,
          },
        });
        if (count === 0) {
          outcome.lost += 1;
          return;
        }
        await tx.notificationDeliveryAttempt.updateMany({
          where: { id: claim.attemptId, status: 'STARTED' },
          data: {
            status: 'SUCCEEDED',
            finishedAt: now,
            providerReference: result.providerReference,
          },
        });
        outcome.sent += 1;
        return;
      }
      const code = safeErrorCode(result.code);
      if (code === EMAIL_PROVIDER_NOT_CONFIGURED || result.uncertain) {
        // D2: no provider is configured — suppressed with a reason (distinct from the user's
        // preference), never retried; recovery is documented, there is no automatic resend.
        // D1: an uncertain outcome is never retried automatically (it may have been sent).
        const notConfigured = code === EMAIL_PROVIDER_NOT_CONFIGURED;
        const { count } = await tx.notificationDelivery.updateMany({
          where: owned,
          data: notConfigured
            ? {
                status: 'SUPPRESSED',
                suppressedReason: 'EMAIL_PROVIDER_NOT_CONFIGURED',
                nextAttemptAt: null,
                leaseExpiresAt: null,
                lastErrorCode: code,
              }
            : {
                status: 'FAILED',
                nextAttemptAt: null,
                leaseExpiresAt: null,
                lastErrorCode: 'DELIVERY_OUTCOME_UNCERTAIN',
              },
        });
        if (count === 0) {
          outcome.lost += 1;
          return;
        }
        await tx.notificationDeliveryAttempt.updateMany({
          where: { id: claim.attemptId, status: 'STARTED' },
          data: {
            status: notConfigured ? 'PERMANENT_FAILURE' : 'UNCERTAIN',
            finishedAt: now,
            errorCode: code,
            errorMessage: safeErrorMessage(result.message),
          },
        });
        if (notConfigured) {
          outcome.providerNotConfigured += 1;
          outcome.suppressed += 1;
        } else {
          outcome.uncertain += 1;
          outcome.failed += 1;
        }
        return;
      }
      const next = afterFailure(claim.attemptNumber, result.retryable, now);
      const { count } = await tx.notificationDelivery.updateMany({
        where: owned,
        data:
          next.status === 'PENDING'
            ? {
                status: 'PENDING',
                nextAttemptAt: next.nextAttemptAt,
                leaseExpiresAt: null,
                lastErrorCode: code,
              }
            : {
                status: 'FAILED',
                nextAttemptAt: null,
                leaseExpiresAt: null,
                lastErrorCode: code,
              },
      });
      if (count === 0) {
        outcome.lost += 1;
        return;
      }
      await tx.notificationDeliveryAttempt.updateMany({
        where: { id: claim.attemptId, status: 'STARTED' },
        data: {
          status: result.retryable ? 'RETRYABLE_FAILURE' : 'PERMANENT_FAILURE',
          finishedAt: now,
          errorCode: code,
          errorMessage: safeErrorMessage(result.message),
        },
      });
      if (next.status === 'PENDING') outcome.retried += 1;
      else outcome.failed += 1;
    });
  }
}
