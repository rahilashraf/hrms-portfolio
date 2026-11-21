import type { PrismaService } from '../../database/prisma.service.js';
import { FeatureGateService } from '../../features/feature-gate.service.js';
import type { GoogleCapability } from '../../generated/prisma/client.js';
import { GoogleApiError } from './google-api.client.js';
import {
  CredentialCipher,
  CredentialCipherError,
} from './google-credential-cipher.js';
import type { GoogleTokenProvider } from './google-token.provider.js';
import { CAPABILITY_SCOPES, connectionCan } from './google-workspace-domain.js';
import type { ConnectionRow } from './google-workspace-common.js';

/**
 * Phase 16.5 — what every Google adapter shares: find the organization's usable connection
 * for a capability (ACTIVE, capability enabled, scopes granted, credentials decryptable) and
 * call Google with it, recording credential failures on the connection. An organization's
 * adapters only ever use that organization's own connection.
 */
export class GoogleWorkspaceRuntime {
  constructor(
    private readonly prisma: PrismaService,
    readonly cipher: CredentialCipher,
    readonly tokens: GoogleTokenProvider,
    private readonly clock: { now(): Date } = { now: () => new Date() },
  ) {}

  /** The organization's connection usable for a capability, or null. */
  async connectionFor(
    organizationId: string,
    capability: GoogleCapability,
  ): Promise<ConnectionRow | null> {
    // Phase 18: with Google Workspace disabled the organization is treated as not connected
    // (Drive checks skip, email falls back to the default transport, exports are refused).
    if (
      !(await new FeatureGateService(this.prisma).isEnabled(
        organizationId,
        'GOOGLE_WORKSPACE',
      ))
    )
      return null;
    const connection = await this.prisma.googleWorkspaceConnection.findFirst({
      where: { organizationId, status: 'ACTIVE' },
    });
    if (!connection || !connectionCan(connection, capability)) return null;
    if (!this.cipher.canDecrypt(connection.credentialKeyId)) {
      await this.markUnavailable(connection.id);
      return null;
    }
    return connection;
  }

  /**
   * Runs a Google call with an access token for the capability. Credential failures are
   * recorded on the connection (ERROR: Google refused the credentials; CREDENTIALS_UNAVAILABLE:
   * they cannot be decrypted) and rethrown.
   */
  async call<T>(
    connection: ConnectionRow,
    capability: GoogleCapability,
    run: (accessToken: string) => Promise<T>,
  ): Promise<T> {
    try {
      const token = await this.tokens.getAccessToken(
        connection,
        CAPABILITY_SCOPES[capability],
      );
      return await run(token);
    } catch (error) {
      if (error instanceof GoogleApiError && error.authFailure)
        await this.markError(connection.id, error.code);
      if (error instanceof CredentialCipherError)
        await this.markUnavailable(connection.id);
      throw error;
    }
  }

  async markError(connectionId: string, code: string) {
    this.tokens.forget(connectionId);
    await this.prisma.googleWorkspaceConnection.updateMany({
      where: { id: connectionId, status: { in: ['ACTIVE', 'ERROR'] } },
      data: {
        status: 'ERROR',
        lastErrorCode: code,
        lastHealthOk: false,
        lastHealthCheckAt: this.clock.now(),
      },
    });
  }

  async markUnavailable(connectionId: string) {
    this.tokens.forget(connectionId);
    await this.prisma.googleWorkspaceConnection.updateMany({
      where: { id: connectionId, status: { in: ['ACTIVE', 'ERROR'] } },
      data: {
        status: 'CREDENTIALS_UNAVAILABLE',
        lastErrorCode: 'INTEGRATION_KEY_UNAVAILABLE',
        lastHealthOk: false,
      },
    });
  }
}
