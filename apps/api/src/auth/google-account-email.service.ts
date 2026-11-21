import { LIVE_ORGANIZATION_GRANT } from '../authorization/authorization.service.js';
import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import type { GoogleApiClient } from '../integrations/google/google-api.client.js';
import { buildPlainTextMessage } from '../integrations/google/google-workspace-domain.js';
import type { GoogleWorkspaceRuntime } from '../integrations/google/google-workspace-runtime.js';
import {
  accountEmailContent,
  accountEmailLink,
} from './account-email-content.js';
import {
  AccountEmailService,
  accountEmailDeliveryFailed,
  accountEmailUnavailable,
  type AccountEmailKind,
  type AccountEmailMessage,
} from './account-email.service.js';

export { accountEmailContent } from './account-email-content.js';

/**
 * Production account email: sends through the Gmail account an organization connected in
 * Google Workspace (Phase 16.5, capability GMAIL_SEND) — no extra paid email service. The
 * message is routed only through organizations the recipient belongs to (see connectionFor):
 * an inviting administrator's, else the recipient's employee organizations, else the single
 * organization their role assignments (or, for System scope, the deployment) can send from.
 *
 * Without any usable connection it uses the deployment's SMTP server when one is configured
 * (Batch 2); otherwise it fails with 503 ACCOUNT_EMAIL_UNAVAILABLE in production and falls back to
 * the in-memory development service in development and tests. A provider failure
 * is reported as 503 ACCOUNT_EMAIL_DELIVERY_FAILED. Tokens, addresses and bodies are never
 * logged — only the account id, organization id and a provider error code.
 */
export class GoogleWorkspaceAccountEmailService extends AccountEmailService {
  private readonly logger = new Logger('AccountEmail');

  constructor(
    private readonly prisma: PrismaService,
    private readonly runtime: GoogleWorkspaceRuntime,
    private readonly api: GoogleApiClient,
    private readonly fallback: AccountEmailService,
    private readonly settings: {
      production: boolean;
      webOrigin?: string;
      /** Batch 2: the deployment's SMTP sender, used when no Gmail connection applies. */
      smtp?: AccountEmailService;
    },
  ) {
    super();
  }

  async assertAvailable(): Promise<void> {
    if (!this.settings.production || this.settings.smtp) return;
    for (const organizationId of await this.connectedOrganizations()) {
      if (await this.runtime.connectionFor(organizationId, 'GMAIL_SEND'))
        return;
    }
    throw accountEmailUnavailable();
  }

  sendInvitation(message: AccountEmailMessage) {
    return this.send('invitation', message);
  }

  sendPasswordReset(message: AccountEmailMessage) {
    return this.send('password-reset', message);
  }

  sendVerification(message: AccountEmailMessage) {
    return this.send('verification', message);
  }

  private async send(kind: AccountEmailKind, message: AccountEmailMessage) {
    const connection = await this.connectionFor(message);
    if (!connection) {
      // Batch 2: the deployment's SMTP server, else development's in-memory service.
      const next = this.settings.smtp ?? this.fallback;
      if (!this.settings.smtp && this.settings.production)
        throw accountEmailUnavailable();
      switch (kind) {
        case 'invitation':
          return next.sendInvitation(message);
        case 'password-reset':
          return next.sendPasswordReset(message);
        case 'verification':
          return next.sendVerification(message);
      }
    }
    const content = accountEmailContent(
      kind,
      accountEmailLink(kind, message.token, this.settings),
      message.expiresAt,
    );
    let raw: string;
    try {
      raw = buildPlainTextMessage({
        from: connection.accountEmail,
        to: message.email,
        subject: content.subject,
        text: content.text,
        messageId: randomUUID(),
      });
    } catch {
      this.logger.warn(
        `Account email (${kind}) refused for user ${message.userId ?? 'unknown'}: invalid address`,
      );
      throw accountEmailDeliveryFailed();
    }
    try {
      await this.runtime.call(connection, 'GMAIL_SEND', (token) =>
        this.api.sendGmailMessage(token, raw),
      );
    } catch (error) {
      const code =
        error instanceof Error && /^[A-Z0-9_]{1,64}$/.test(error.message)
          ? error.message
          : 'SEND_FAILED';
      this.logger.warn(
        `Account email (${kind}) for user ${message.userId ?? 'unknown'} via organization ${connection.organizationId} failed: ${code}`,
      );
      throw accountEmailDeliveryFailed();
    }
  }

  /**
   * The sending connection, from organizations the recipient belongs to only:
   *
   * 1. `organizationIds` (an inviting administrator's), in preference order;
   * 2. else the recipient's employee organizations, current work first;
   * 3. else (no employee record) the organizations of their active, organization-scoped role
   *    assignments; a System-scope holder (the deployment owner) may also use a connected
   *    organization — in both cases only when exactly one such organization can send.
   *
   * An unrelated organization's mailbox is never used; with no unambiguous sender the result is
   * null (ACCOUNT_EMAIL_UNAVAILABLE in production).
   */
  private async connectionFor(message: AccountEmailMessage) {
    const preferred = message.organizationIds?.length
      ? [...message.organizationIds]
      : await this.employeeOrganizations(message.userId);
    if (preferred.length > 0) {
      for (const organizationId of preferred) {
        const connection = await this.runtime.connectionFor(
          organizationId,
          'GMAIL_SEND',
        );
        if (connection) return connection;
      }
      return null;
    }
    if (!message.userId) return null;
    const roles = await this.roleOrganizations(message.userId);
    const fromRoles = await this.soleConnection(roles.organizations);
    if (fromRoles !== undefined || !roles.system) {
      if (!fromRoles)
        this.ambiguous(message.userId, roles.organizations.length);
      return fromRoles ?? null;
    }
    const fromSystem = await this.soleConnection(
      await this.connectedOrganizations(),
    );
    if (!fromSystem) this.ambiguous(message.userId, -1);
    return fromSystem ?? null;
  }

  /**
   * The one usable connection among the organizations: `undefined` when none can send, `null`
   * when more than one could (ambiguous), else that connection.
   */
  private async soleConnection(organizationIds: readonly string[]) {
    const usable = [];
    for (const organizationId of organizationIds) {
      const connection = await this.runtime.connectionFor(
        organizationId,
        'GMAIL_SEND',
      );
      if (connection) usable.push(connection);
    }
    if (usable.length === 0) return undefined;
    return usable.length === 1 ? usable[0]! : null;
  }

  private ambiguous(userId: string, candidates: number) {
    this.logger.warn(
      `Account email for user ${userId}: no unambiguous sender organization (${
        candidates < 0 ? 'system scope' : `${candidates} role organization(s)`
      })`,
    );
  }

  /** The recipient's employee organizations, current work first. */
  private async employeeOrganizations(userId?: string): Promise<string[]> {
    if (!userId) return [];
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        person: {
          select: {
            employee: {
              select: {
                assignments: {
                  where: { status: { not: 'CANCELLED' } },
                  select: {
                    status: true,
                    startDate: true,
                    position: { select: { organizationId: true } },
                  },
                },
              },
            },
          },
        },
      },
    });
    const assignments = user?.person.employee?.assignments ?? [];
    const rank = (status: string) =>
      status === 'ACTIVE' ? 0 : status === 'PLANNED' ? 1 : 2;
    const ordered = [...assignments].sort(
      (a, b) =>
        rank(a.status) - rank(b.status) ||
        b.startDate.getTime() - a.startDate.getTime(),
    );
    return [...new Set(ordered.map((a) => a.position.organizationId))];
  }

  /**
   * Organizations of the user's effective role assignments (the same rule authorization uses:
   * not revoked, role not archived, started and not expired), and whether one is System-scope.
   */
  private async roleOrganizations(userId: string) {
    const now = new Date();
    const assignments = await this.prisma.roleAssignment.findMany({
      where: {
        userId,
        revokedAt: null,
        startsAt: { lte: now },
        AND: [
          { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
          // Batch 5B (K9): grants of archived organizations do not count.
          LIVE_ORGANIZATION_GRANT,
        ],
      },
      select: { scopeType: true, organizationId: true },
      orderBy: { createdAt: 'asc' },
    });
    return {
      organizations: [
        ...new Set(
          assignments.flatMap((a) =>
            a.scopeType !== 'SYSTEM' && a.organizationId
              ? [a.organizationId]
              : [],
          ),
        ),
      ],
      system: assignments.some((a) => a.scopeType === 'SYSTEM'),
    };
  }

  private async connectedOrganizations(): Promise<string[]> {
    const rows = await this.prisma.googleWorkspaceConnection.findMany({
      where: { status: 'ACTIVE', capabilities: { has: 'GMAIL_SEND' } },
      select: { organizationId: true },
      orderBy: { createdAt: 'asc' },
    });
    return [...new Set(rows.map((row) => row.organizationId))];
  }
}
