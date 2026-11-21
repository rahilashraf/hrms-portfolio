import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditService } from '../../audit/audit.service.js';
import { advisoryLock, domainError } from '../../common/domain-support.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { GoogleCapability } from '../../generated/prisma/client.js';
import {
  GOOGLE_API_CLIENT,
  GoogleApiError,
  type GoogleApiClient,
} from './google-api.client.js';
import {
  CredentialCipher,
  CredentialCipherError,
  oauthVerifierAad,
} from './google-credential-cipher.js';
import {
  decryptCredential,
  encryptCredential,
  GOOGLE_TOKEN_PROVIDER,
  type GoogleTokenProvider,
} from './google-token.provider.js';
import { GoogleWorkspaceAccessService } from './google-workspace-access.service.js';
import {
  conflict,
  currentConnection,
  encryptionNotConfigured,
  GOOGLE_WORKSPACE_SETTINGS,
  GoogleWorkspaceClock,
  lockConnection,
  oauthNotConfigured,
  writeGoogleAudit,
  type ConnectionRow,
  type GoogleRequestContext,
  type GoogleWorkspaceSettings,
} from './google-workspace-common.js';
import {
  authorizationUrl,
  CAPABILITY_SCOPES,
  GOOGLE_CAPABILITIES,
  grantedCapabilities,
  IDENTITY_SCOPES,
  idTokenIdentity,
  isEmailAddress,
  normalizeCapabilities,
  OAUTH_STATE_TTL_MS,
  oauthStateProblem,
  parseServiceAccountKey,
  pkcePair,
  randomToken,
  recordedScopes,
  scopesFor,
  serviceAccountAssertion,
  sha256Hex,
} from './google-workspace-domain.js';

/** A failed OAuth completion: a safe code the callback forwards to the web page. */
export class OAuthCompletionError extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 403 | 409 = 400,
  ) {
    super(code);
    this.name = 'OAuthCompletionError';
  }

  toHttp() {
    return new HttpException(
      domainError(
        this.status,
        this.code,
        'The Google authorization could not be completed.',
      ),
      this.status,
    );
  }
}

const OAUTH_CALLBACK_COOKIE = 'hrms_google_oauth';
export { OAUTH_CALLBACK_COOKIE };

/**
 * Phase 16.5 — an organization's Google Workspace connection: status, OAuth (default) and
 * service-account (optional, advanced) credentials, health checks and disconnection. Tokens,
 * keys and verifiers never leave this service: responses carry the connection summary only.
 */
@Injectable()
export class GoogleConnectionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: GoogleWorkspaceAccessService,
    private readonly audit: AuditService,
    private readonly clock: GoogleWorkspaceClock,
    private readonly cipher: CredentialCipher,
    @Inject(GOOGLE_API_CLIENT) private readonly api: GoogleApiClient,
    @Inject(GOOGLE_TOKEN_PROVIDER) private readonly tokens: GoogleTokenProvider,
    @Inject(GOOGLE_WORKSPACE_SETTINGS)
    private readonly settings: GoogleWorkspaceSettings,
  ) {}

  // ─── Status ────────────────────────────────────────────────────────────────

  summary(connection: ConnectionRow | null) {
    if (!connection) return null;
    const credentialsAvailable =
      connection.status !== 'DISCONNECTED' &&
      this.cipher.canDecrypt(connection.credentialKeyId);
    return {
      id: connection.id,
      mode: connection.mode,
      status:
        connection.status !== 'DISCONNECTED' && !credentialsAvailable
          ? ('CREDENTIALS_UNAVAILABLE' as const)
          : connection.status,
      workspaceDomain: connection.workspaceDomain,
      accountEmail: connection.accountEmail,
      serviceAccountEmail: connection.serviceAccountEmail,
      grantedScopes: connection.grantedScopes,
      capabilities: connection.capabilities,
      credentialsAvailable,
      connectedAt: connection.connectedAt,
      connectedByUserId: connection.connectedByUserId,
      lastHealthCheckAt: connection.lastHealthCheckAt,
      lastHealthOk: connection.lastHealthOk,
      lastErrorCode: connection.lastErrorCode,
    };
  }

  /** What the deployment supports (no secrets), shared by the status response. */
  configuration() {
    const encryption = this.cipher.configured;
    return {
      oauthConfigured: this.settings.oauth !== null,
      encryptionConfigured: encryption,
      strategies: {
        OAUTH: {
          default: true,
          available: this.settings.oauth !== null && encryption,
          requiresDomainWideDelegation: false,
        },
        SERVICE_ACCOUNT: {
          default: false,
          optional: true,
          available: encryption,
          requiresDomainWideDelegation: true,
        },
      },
      capabilities: GOOGLE_CAPABILITIES.map((capability) => ({
        capability,
        scopes: CAPABILITY_SCOPES[capability],
        // Every capability works with ordinary delegated OAuth consent.
        requiresDomainWideDelegation: false,
      })),
    };
  }

  async status(userId: string, organizationId: string) {
    const grants = await this.access.require(
      userId,
      'integration.google.read',
      organizationId,
    );
    const connection = await currentConnection(this.prisma, organizationId);
    const previous = await this.prisma.googleWorkspaceConnection.findMany({
      where: { organizationId, status: 'DISCONNECTED' },
      orderBy: [{ disconnectedAt: 'desc' }, { id: 'desc' }],
      take: 5,
      select: {
        id: true,
        mode: true,
        workspaceDomain: true,
        connectedAt: true,
        disconnectedAt: true,
        disconnectedByUserId: true,
      },
    });
    return {
      organizationId,
      canManage: this.access.can(
        grants,
        'integration.google.manage',
        organizationId,
      ),
      ...this.configuration(),
      connection: this.summary(connection),
      previousConnections: previous,
    };
  }

  // ─── OAuth (default strategy) ──────────────────────────────────────────────

  /**
   * Starts an authorization: a one-time state (stored as a SHA-256 hash, bound to the
   * organization, the initiating user and their browser through a nonce cookie), an encrypted
   * PKCE verifier, a 10-minute expiry and the minimal scopes of the selected capabilities.
   */
  async startOAuth(
    input: { organizationId: string; capabilities: readonly string[] },
    context: GoogleRequestContext,
  ) {
    if (!this.settings.oauth) throw oauthNotConfigured();
    if (!this.cipher.configured) throw encryptionNotConfigured();
    await this.access.require(
      context.actorUserId,
      'integration.google.manage',
      input.organizationId,
    );
    const capabilities = normalizeCapabilities(input.capabilities);
    if (capabilities.length === 0)
      throw new BadRequestException(
        domainError(
          400,
          'GOOGLE_CAPABILITY_REQUIRED',
          'Select at least one capability.',
        ),
      );
    const existing = await currentConnection(this.prisma, input.organizationId);
    if (existing?.mode === 'SERVICE_ACCOUNT')
      throw conflict(
        'GOOGLE_CONNECTION_MODE_CONFLICT',
        'The organization is connected with a service account; disconnect it first.',
      );
    const scopes = [...IDENTITY_SCOPES, ...scopesFor(capabilities)];
    const state = randomToken(32);
    const browserNonce = randomToken(32);
    const pkce = pkcePair();
    const now = this.clock.now();
    const id = randomUUID();
    const verifier = this.cipher.encrypt(
      pkce.verifier,
      oauthVerifierAad({ id, organizationId: input.organizationId }),
    );
    const expiresAt = new Date(now.getTime() + OAUTH_STATE_TTL_MS);
    await this.prisma.$transaction(async (tx) => {
      await tx.googleOAuthState.create({
        data: {
          id,
          organizationId: input.organizationId,
          initiatedByUserId: context.actorUserId!,
          stateHash: sha256Hex(state),
          browserBindingHash: sha256Hex(browserNonce),
          codeVerifierCiphertext: verifier.ciphertext,
          codeVerifierKeyId: verifier.keyId,
          requestedScopes: scopes,
          capabilities,
          expiresAt,
          createdAt: now,
        },
      });
      await writeGoogleAudit(this.audit, tx, {
        action: 'GOOGLE_OAUTH_STARTED',
        entityType: 'Organization',
        entityId: input.organizationId,
        context,
        metadata: {
          organizationId: input.organizationId,
          capabilities,
          scopes,
        },
      });
    });
    return {
      authorizationUrl: authorizationUrl({
        clientId: this.settings.oauth.clientId,
        redirectUri: this.settings.oauth.redirectUri,
        scopes,
        state,
        codeChallenge: pkce.challenge,
      }),
      expiresAt,
      browserNonce,
    };
  }

  /**
   * Completes an authorization. The state must exist, be unused and unexpired, and come back to
   * the same initiating user (authenticated completion) or the same browser (callback cookie).
   * The state is consumed before the code is exchanged, so it can never be replayed.
   */
  async completeOAuth(
    input: { state: string; code?: string | null; error?: string | null },
    caller: { userId?: string | null; browserNonce?: string | null },
    context: GoogleRequestContext = {},
  ): Promise<{ organizationId: string; connectionId: string }> {
    if (!this.settings.oauth) throw oauthNotConfigured();
    const oauth = this.settings.oauth;
    const now = this.clock.now();
    const claimed = await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT "id" FROM "GoogleOAuthState" WHERE "stateHash" = $1 FOR UPDATE`,
        sha256Hex(input.state),
      );
      if (!rows[0]) throw new OAuthCompletionError('OAUTH_STATE_INVALID');
      const state = await tx.googleOAuthState.findUniqueOrThrow({
        where: { id: rows[0].id },
      });
      const problem = oauthStateProblem(state, now, caller);
      if (problem) throw new OAuthCompletionError(problem);
      await tx.googleOAuthState.update({
        where: { id: state.id },
        data: { consumedAt: now },
      });
      return state;
    });
    if (input.error || !input.code)
      throw new OAuthCompletionError('OAUTH_DENIED');
    const actorUserId = claimed.initiatedByUserId;
    const auditContext = { ...context, actorUserId };
    const grants = await this.access.grants(actorUserId);
    if (
      !this.access.can(
        grants,
        'integration.google.manage',
        claimed.organizationId,
      )
    )
      throw new OAuthCompletionError('OAUTH_FORBIDDEN', 403);
    // Phase 18: no connection is completed while Google Workspace is disabled.
    if (
      !(await this.access.features.isEnabled(
        claimed.organizationId,
        'GOOGLE_WORKSPACE',
      ))
    )
      throw new OAuthCompletionError('FEATURE_DISABLED', 403);
    let verifier: string;
    try {
      verifier = this.cipher.decrypt(
        {
          ciphertext: claimed.codeVerifierCiphertext,
          keyId: claimed.codeVerifierKeyId,
        },
        oauthVerifierAad(claimed),
      );
    } catch {
      throw new OAuthCompletionError('OAUTH_STATE_INVALID');
    }
    let token;
    try {
      token = await this.api.exchangeAuthorizationCode({
        code: input.code,
        codeVerifier: verifier,
        clientId: oauth.clientId,
        clientSecret: oauth.clientSecret,
        redirectUri: oauth.redirectUri,
      });
    } catch {
      throw new OAuthCompletionError('OAUTH_EXCHANGE_FAILED');
    }
    const refuse = async (code: string, status: 400 | 403 | 409 = 400) => {
      // Best effort: never keep a grant the HRMS will not use.
      await this.api
        .revokeToken(token.refreshToken ?? token.accessToken)
        .catch(() => undefined);
      return new OAuthCompletionError(code, status);
    };
    const identity = idTokenIdentity(token.idToken, oauth.clientId, now);
    if (!identity) throw await refuse('OAUTH_IDENTITY_INVALID');
    if (!identity.hostedDomain)
      throw await refuse('GOOGLE_WORKSPACE_ACCOUNT_REQUIRED');
    if (!token.refreshToken) throw await refuse('OAUTH_NO_REFRESH_TOKEN');
    const scopes = recordedScopes(token.scope ?? '');
    const capabilities = grantedCapabilities(
      claimed.capabilities as GoogleCapability[],
      scopes,
    );
    if (capabilities.length === 0)
      throw await refuse('OAUTH_SCOPES_NOT_GRANTED');
    const refreshToken = token.refreshToken;
    const result = await this.prisma
      .$transaction(async (tx) => {
        await advisoryLock(tx, `google-connection:${claimed.organizationId}`);
        const existing = await lockConnection(tx, claimed.organizationId);
        if (existing && existing.mode !== 'OAUTH')
          throw new OAuthCompletionError(
            'GOOGLE_CONNECTION_MODE_CONFLICT',
            409,
          );
        if (
          existing?.workspaceDomain &&
          existing.workspaceDomain !== identity.hostedDomain
        )
          throw new OAuthCompletionError(
            'GOOGLE_WORKSPACE_DOMAIN_MISMATCH',
            409,
          );
        const fields = {
          workspaceDomain: identity.hostedDomain,
          accountEmail: identity.email,
          grantedScopes: scopes,
          capabilities,
          status: 'ACTIVE' as const,
          lastErrorCode: null,
          lastHealthOk: true,
          lastHealthCheckAt: now,
          connectedByUserId: actorUserId,
          connectedAt: now,
        };
        if (existing) {
          const version = existing.credentialVersion + 1;
          const encrypted = encryptCredential(
            this.cipher,
            { ...existing, mode: 'OAUTH', credentialVersion: version },
            { kind: 'OAUTH', refreshToken },
          );
          await tx.googleWorkspaceConnection.update({
            where: { id: existing.id },
            data: {
              ...fields,
              credentialVersion: version,
              credentialCiphertext: encrypted.ciphertext,
              credentialKeyId: encrypted.keyId,
            },
          });
          await writeGoogleAudit(this.audit, tx, {
            action: 'GOOGLE_CONNECTION_CREDENTIALS_UPDATED',
            entityType: 'GoogleWorkspaceConnection',
            entityId: existing.id,
            context: auditContext,
            metadata: {
              organizationId: claimed.organizationId,
              mode: 'OAUTH',
              scopes,
              capabilities,
              previousScopes: existing.grantedScopes,
              credentialVersion: version,
            },
          });
          return {
            organizationId: claimed.organizationId,
            connectionId: existing.id,
          };
        }
        const id = randomUUID();
        const encrypted = encryptCredential(
          this.cipher,
          {
            id,
            organizationId: claimed.organizationId,
            mode: 'OAUTH',
            credentialVersion: 1,
          },
          { kind: 'OAUTH', refreshToken },
        );
        await tx.googleWorkspaceConnection.create({
          data: {
            id,
            organizationId: claimed.organizationId,
            mode: 'OAUTH',
            ...fields,
            credentialVersion: 1,
            credentialCiphertext: encrypted.ciphertext,
            credentialKeyId: encrypted.keyId,
            createdByUserId: actorUserId,
          },
        });
        await writeGoogleAudit(this.audit, tx, {
          action: 'GOOGLE_CONNECTION_CONNECTED',
          entityType: 'GoogleWorkspaceConnection',
          entityId: id,
          context: auditContext,
          metadata: {
            organizationId: claimed.organizationId,
            mode: 'OAUTH',
            scopes,
            capabilities,
          },
        });
        return { organizationId: claimed.organizationId, connectionId: id };
      })
      .catch(async (error: unknown) => {
        if (error instanceof OAuthCompletionError)
          throw await refuse(error.code, error.status);
        throw error;
      });
    this.tokens.forget(result.connectionId);
    return result;
  }

  // ─── Service account (optional, advanced strategy) ─────────────────────────

  /**
   * Stores a service-account key for domain-wide delegation. Only client_email, private_key_id
   * and private_key are kept (encrypted); the key is verified by obtaining a token for the
   * impersonated user and the selected scopes before anything is stored. Never echoed back.
   */
  async connectServiceAccount(
    input: {
      organizationId: string;
      keyJson: string;
      impersonatedUser: string;
      capabilities: readonly string[];
    },
    context: GoogleRequestContext,
  ) {
    if (!this.cipher.configured) throw encryptionNotConfigured();
    await this.access.require(
      context.actorUserId,
      'integration.google.manage',
      input.organizationId,
    );
    const capabilities = normalizeCapabilities(input.capabilities);
    if (capabilities.length === 0)
      throw new BadRequestException(
        domainError(
          400,
          'GOOGLE_CAPABILITY_REQUIRED',
          'Select at least one capability.',
        ),
      );
    const subject = input.impersonatedUser.trim().toLowerCase();
    if (!isEmailAddress(subject))
      throw new BadRequestException(
        domainError(
          400,
          'GOOGLE_IMPERSONATED_USER_INVALID',
          'Enter the Workspace user to act as.',
        ),
      );
    const domain = subject.split('@')[1]!;
    const credential = parseServiceAccountKey(input.keyJson);
    if (typeof credential === 'string')
      throw new BadRequestException(
        domainError(
          400,
          credential,
          'The service-account key is not a valid Google key.',
        ),
      );
    const scopes = scopesFor(capabilities);
    const now = this.clock.now();
    try {
      await this.api.jwtBearerToken(
        serviceAccountAssertion(credential, { subject, scopes, now }),
      );
    } catch (error) {
      throw new BadRequestException(
        domainError(
          400,
          'GOOGLE_SERVICE_ACCOUNT_REJECTED',
          'Google did not issue a token for this key, user and scopes (check domain-wide delegation).',
          {
            reason:
              error instanceof GoogleApiError ? error.code : 'GOOGLE_ERROR',
          },
        ),
      );
    }
    const result = await this.prisma.$transaction(async (tx) => {
      await advisoryLock(tx, `google-connection:${input.organizationId}`);
      const existing = await lockConnection(tx, input.organizationId);
      if (existing && existing.mode !== 'SERVICE_ACCOUNT')
        throw conflict(
          'GOOGLE_CONNECTION_MODE_CONFLICT',
          'The organization is connected with OAuth; disconnect it first.',
        );
      if (existing?.workspaceDomain && existing.workspaceDomain !== domain)
        throw conflict(
          'GOOGLE_WORKSPACE_DOMAIN_MISMATCH',
          'The organization is connected to another Workspace domain; disconnect it first.',
        );
      const stored = { kind: 'SERVICE_ACCOUNT' as const, ...credential };
      const fields = {
        workspaceDomain: domain,
        accountEmail: subject,
        serviceAccountEmail: credential.clientEmail,
        grantedScopes: scopes,
        capabilities,
        status: 'ACTIVE' as const,
        lastErrorCode: null,
        lastHealthOk: true,
        lastHealthCheckAt: now,
        connectedByUserId: context.actorUserId,
        connectedAt: now,
      };
      const metadata = {
        organizationId: input.organizationId,
        mode: 'SERVICE_ACCOUNT',
        scopes,
        capabilities,
      };
      if (existing) {
        const version = existing.credentialVersion + 1;
        const encrypted = encryptCredential(
          this.cipher,
          { ...existing, mode: 'SERVICE_ACCOUNT', credentialVersion: version },
          stored,
        );
        const row = await tx.googleWorkspaceConnection.update({
          where: { id: existing.id },
          data: {
            ...fields,
            credentialVersion: version,
            credentialCiphertext: encrypted.ciphertext,
            credentialKeyId: encrypted.keyId,
          },
        });
        await writeGoogleAudit(this.audit, tx, {
          action: 'GOOGLE_CONNECTION_CREDENTIALS_UPDATED',
          entityType: 'GoogleWorkspaceConnection',
          entityId: existing.id,
          context,
          metadata: { ...metadata, credentialVersion: version },
        });
        return row;
      }
      const id = randomUUID();
      const encrypted = encryptCredential(
        this.cipher,
        {
          id,
          organizationId: input.organizationId,
          mode: 'SERVICE_ACCOUNT',
          credentialVersion: 1,
        },
        stored,
      );
      const row = await tx.googleWorkspaceConnection.create({
        data: {
          id,
          organizationId: input.organizationId,
          mode: 'SERVICE_ACCOUNT',
          ...fields,
          credentialVersion: 1,
          credentialCiphertext: encrypted.ciphertext,
          credentialKeyId: encrypted.keyId,
          createdByUserId: context.actorUserId,
        },
      });
      await writeGoogleAudit(this.audit, tx, {
        action: 'GOOGLE_CONNECTION_CONNECTED',
        entityType: 'GoogleWorkspaceConnection',
        entityId: id,
        context,
        metadata,
      });
      return row;
    });
    this.tokens.forget(result.id);
    return {
      organizationId: input.organizationId,
      connection: this.summary(result),
    };
  }

  // ─── Disconnect ────────────────────────────────────────────────────────────

  /**
   * Disconnects: revokes the OAuth grant at Google (best effort), wipes the ciphertext and keeps
   * the row (DISCONNECTED) for audit history. A service-account key cannot be revoked from
   * here: the admin deletes it in Google Cloud (reported as revoked: false).
   */
  async disconnect(organizationId: string, context: GoogleRequestContext) {
    await this.access.require(
      context.actorUserId,
      'integration.google.manage',
      organizationId,
    );
    const connection = await currentConnection(this.prisma, organizationId);
    if (!connection)
      throw new NotFoundException(
        domainError(
          404,
          'GOOGLE_CONNECTION_NOT_FOUND',
          'The organization is not connected.',
        ),
      );
    let revoked = false;
    if (
      connection.mode === 'OAUTH' &&
      this.cipher.canDecrypt(connection.credentialKeyId)
    ) {
      try {
        const credential = decryptCredential(this.cipher, connection);
        if (credential.kind === 'OAUTH') {
          await this.api.revokeToken(credential.refreshToken);
          revoked = true;
        }
      } catch {
        revoked = false;
      }
    }
    const now = this.clock.now();
    const row = await this.prisma.$transaction(async (tx) => {
      await advisoryLock(tx, `google-connection:${organizationId}`);
      const locked = await lockConnection(tx, organizationId);
      if (!locked || locked.id !== connection.id)
        throw conflict(
          'GOOGLE_CONNECTION_CHANGED',
          'The connection changed; try again.',
        );
      const updated = await tx.googleWorkspaceConnection.update({
        where: { id: connection.id },
        data: {
          status: 'DISCONNECTED',
          credentialCiphertext: null,
          credentialKeyId: null,
          disconnectedAt: now,
          disconnectedByUserId: context.actorUserId,
        },
      });
      await writeGoogleAudit(this.audit, tx, {
        action: 'GOOGLE_CONNECTION_DISCONNECTED',
        entityType: 'GoogleWorkspaceConnection',
        entityId: connection.id,
        context,
        metadata: { organizationId, mode: connection.mode, revoked },
      });
      return updated;
    });
    this.tokens.forget(connection.id);
    return { organizationId, revoked, connection: this.summary(row) };
  }

  // ─── Health ────────────────────────────────────────────────────────────────

  /** Refreshes one connection's health by obtaining a token for its capabilities. */
  async checkHealth(connection: ConnectionRow) {
    const now = this.clock.now();
    const record = (data: {
      status?: 'ACTIVE' | 'ERROR' | 'CREDENTIALS_UNAVAILABLE';
      lastHealthOk: boolean;
      lastErrorCode: string | null;
    }) =>
      this.prisma.googleWorkspaceConnection.updateMany({
        where: {
          id: connection.id,
          status: { not: 'DISCONNECTED' },
          credentialVersion: connection.credentialVersion,
        },
        data: { ...data, lastHealthCheckAt: now },
      });
    this.tokens.forget(connection.id);
    if (!this.cipher.canDecrypt(connection.credentialKeyId)) {
      await record({
        status: 'CREDENTIALS_UNAVAILABLE',
        lastHealthOk: false,
        lastErrorCode: 'INTEGRATION_KEY_UNAVAILABLE',
      });
      return 'CREDENTIALS_UNAVAILABLE' as const;
    }
    try {
      await this.tokens.getAccessToken(
        connection,
        scopesFor(connection.capabilities),
      );
      await record({
        status: 'ACTIVE',
        lastHealthOk: true,
        lastErrorCode: null,
      });
      return 'ACTIVE' as const;
    } catch (error) {
      if (error instanceof CredentialCipherError) {
        await record({
          status: 'CREDENTIALS_UNAVAILABLE',
          lastHealthOk: false,
          lastErrorCode: error.code,
        });
        return 'CREDENTIALS_UNAVAILABLE' as const;
      }
      if (error instanceof GoogleApiError && !error.retryable) {
        await record({
          status: 'ERROR',
          lastHealthOk: false,
          lastErrorCode: error.code,
        });
        return 'ERROR' as const;
      }
      // Transient: the status stays as it was.
      await record({
        lastHealthOk: false,
        lastErrorCode:
          error instanceof GoogleApiError
            ? error.code
            : 'GOOGLE_HEALTH_CHECK_FAILED',
      });
      return 'UNKNOWN' as const;
    }
  }

  async healthCheck(organizationId: string, context: GoogleRequestContext) {
    await this.access.require(
      context.actorUserId,
      'integration.google.manage',
      organizationId,
    );
    const connection = await currentConnection(this.prisma, organizationId);
    if (!connection)
      throw new NotFoundException(
        domainError(
          404,
          'GOOGLE_CONNECTION_NOT_FOUND',
          'The organization is not connected.',
        ),
      );
    const result = await this.checkHealth(connection);
    return {
      organizationId,
      result,
      connection: this.summary(
        await this.prisma.googleWorkspaceConnection.findUniqueOrThrow({
          where: { id: connection.id },
        }),
      ),
    };
  }

  /** Every current connection (worker): health refreshed; old authorization states pruned. */
  async checkAll() {
    const outcome = {
      checked: 0,
      active: 0,
      error: 0,
      unavailable: 0,
      unknown: 0,
      prunedStates: 0,
      /** Phase 18: organizations skipped because Google Workspace is disabled for them. */
      skippedOrganizations: [
        ...(await this.access.features.disabledOrganizations(
          'GOOGLE_WORKSPACE',
        )),
      ].sort(),
    };
    const connections = await this.prisma.googleWorkspaceConnection.findMany({
      where: {
        status: { not: 'DISCONNECTED' },
        organizationId: { notIn: outcome.skippedOrganizations },
      },
      orderBy: { id: 'asc' },
    });
    for (const connection of connections) {
      outcome.checked += 1;
      const result = await this.checkHealth(connection);
      if (result === 'ACTIVE') outcome.active += 1;
      else if (result === 'ERROR') outcome.error += 1;
      else if (result === 'CREDENTIALS_UNAVAILABLE') outcome.unavailable += 1;
      else outcome.unknown += 1;
    }
    const cutoff = new Date(this.clock.now().getTime() - 24 * 3_600_000);
    outcome.prunedStates = (
      await this.prisma.googleOAuthState.deleteMany({
        where: {
          OR: [{ consumedAt: { lt: cutoff } }, { expiresAt: { lt: cutoff } }],
        },
      })
    ).count;
    return outcome;
  }

  /** Callback redirect target: the web admin page (WEB_ORIGIN only), with a safe result code. */
  callbackRedirect(
    result: { ok: true; organizationId: string } | { ok: false; code: string },
  ) {
    const url = new URL(
      '/settings/integrations/google',
      `${this.settings.webOrigin}/`,
    );
    if (url.origin !== new URL(this.settings.webOrigin).origin)
      throw new ForbiddenException();
    if (result.ok) {
      url.searchParams.set('result', 'connected');
      url.searchParams.set('organizationId', result.organizationId);
    } else {
      url.searchParams.set('result', 'error');
      url.searchParams.set(
        'code',
        /^[A-Z][A-Z0-9_]{0,63}$/.test(result.code)
          ? result.code
          : 'OAUTH_FAILED',
      );
    }
    return url.toString();
  }
}
