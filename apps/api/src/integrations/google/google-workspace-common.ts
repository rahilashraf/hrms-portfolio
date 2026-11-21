import {
  ConflictException,
  HttpException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { AuditService } from '../../audit/audit.service.js';
import {
  domainError,
  jsonValue,
  type DomainRequestContext,
} from '../../common/domain-support.js';
import type { PrismaService } from '../../database/prisma.service.js';
import type {
  GoogleWorkspaceConnection,
  Prisma,
} from '../../generated/prisma/client.js';

export type GoogleClient = PrismaService | Prisma.TransactionClient;
export type Tx = Prisma.TransactionClient;
export type GoogleRequestContext = DomainRequestContext;

/** The integration clock (overridden in tests). */
@Injectable()
export class GoogleWorkspaceClock {
  now(): Date {
    return new Date();
  }
}

/**
 * App-level settings from the environment. The OAuth client is optional: without it the OAuth
 * endpoints answer 503 GOOGLE_OAUTH_NOT_CONFIGURED. Nothing here is per organization.
 */
export interface GoogleWorkspaceSettings {
  oauth: { clientId: string; clientSecret: string; redirectUri: string } | null;
  /** The web origin the OAuth callback redirects back to (WEB_ORIGIN). */
  webOrigin: string;
  production: boolean;
}

export const GOOGLE_WORKSPACE_SETTINGS = Symbol('GOOGLE_WORKSPACE_SETTINGS');

export function googleWorkspaceSettingsFromEnv(
  env: Record<string, string | undefined> = process.env,
): GoogleWorkspaceSettings {
  const clientId = env.GOOGLE_OAUTH_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_OAUTH_CLIENT_SECRET?.trim();
  const redirectUri = env.GOOGLE_OAUTH_REDIRECT_URI?.trim();
  return {
    oauth:
      clientId && clientSecret && redirectUri
        ? { clientId, clientSecret, redirectUri }
        : null,
    webOrigin: (env.WEB_ORIGIN ?? 'http://localhost:3000').replace(/\/+$/, ''),
    production: env.NODE_ENV === 'production',
  };
}

export const conflict = (
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
) => new ConflictException(domainError(409, code, message, extra));

export const unavailable = (code: string, message: string) =>
  new ServiceUnavailableException({
    statusCode: 503,
    error: 'Service Unavailable',
    code,
    message,
  });

export const tooManyRequests = (code: string, message: string) =>
  new HttpException(
    { statusCode: 429, error: 'Too Many Requests', code, message },
    429,
  );

export const oauthNotConfigured = () =>
  unavailable(
    'GOOGLE_OAUTH_NOT_CONFIGURED',
    'Google OAuth is not configured for this deployment.',
  );

export const encryptionNotConfigured = () =>
  unavailable(
    'INTEGRATION_ENCRYPTION_NOT_CONFIGURED',
    'Integration credential encryption is not configured for this deployment.',
  );

/** The organization's current (not disconnected) connection. */
export function currentConnection(
  client: GoogleClient,
  organizationId: string,
) {
  return client.googleWorkspaceConnection.findFirst({
    where: { organizationId, status: { not: 'DISCONNECTED' } },
  });
}

export async function lockConnection(tx: Tx, organizationId: string) {
  const rows = await tx.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT "id" FROM "GoogleWorkspaceConnection" WHERE "organizationId" = $1::uuid AND "status" <> 'DISCONNECTED' FOR NO KEY UPDATE`,
    organizationId,
  );
  return rows[0]
    ? tx.googleWorkspaceConnection.findUniqueOrThrow({
        where: { id: rows[0].id },
      })
    : null;
}

export type ConnectionRow = GoogleWorkspaceConnection;

/**
 * Audit in the caller's transaction. Metadata carries identifiers, modes, scopes, capabilities
 * and form-id hashes only: never tokens, keys, response content or respondent emails.
 */
export function writeGoogleAudit(
  audit: AuditService,
  client: Tx | PrismaService,
  input: {
    action: string;
    entityType: string;
    entityId: string;
    context: GoogleRequestContext;
    metadata: Record<string, unknown>;
  },
) {
  return audit.write(
    {
      action: input.action,
      actorUserId: input.context.actorUserId,
      entityType: input.entityType,
      entityId: input.entityId,
      ipAddress: input.context.ipAddress,
      userAgent: input.context.userAgent,
      correlationId: input.context.correlationId,
      metadata: jsonValue(input.metadata),
    },
    client,
  );
}
