import {
  CredentialCipher,
  CredentialCipherError,
  connectionCredentialAad,
} from './google-credential-cipher.js';
import { GoogleApiError, type GoogleApiClient } from './google-api.client.js';
import {
  serviceAccountAssertion,
  type ServiceAccountCredential,
} from './google-workspace-domain.js';
import type { GoogleWorkspaceSettings } from './google-workspace-common.js';

/**
 * Phase 16.5 — one access-token boundary for both authentication strategies:
 *
 * - OAUTH (default): the stored (encrypted) refresh token is exchanged with the app's OAuth
 *   client for a short-lived access token.
 * - SERVICE_ACCOUNT (optional, advanced): a self-signed RS256 JWT assertion for the
 *   impersonated Workspace user (domain-wide delegation configured by the Workspace admin).
 *
 * Access tokens live only in this process's memory (keyed by connection, credential version and
 * scopes) and are never persisted or logged.
 */
export interface TokenConnection {
  id: string;
  organizationId: string;
  mode: 'OAUTH' | 'SERVICE_ACCOUNT';
  credentialVersion: number;
  credentialCiphertext: string | null;
  credentialKeyId: string | null;
  grantedScopes: readonly string[];
  accountEmail: string | null;
}

export interface GoogleTokenProvider {
  getAccessToken(
    connection: TokenConnection,
    scopes: readonly string[],
  ): Promise<string>;
  /** Forgets cached tokens of a connection (credential change, disconnect). */
  forget(connectionId: string): void;
}

export const GOOGLE_TOKEN_PROVIDER = Symbol('GOOGLE_TOKEN_PROVIDER');

export type StoredCredential =
  | { kind: 'OAUTH'; refreshToken: string }
  | ({ kind: 'SERVICE_ACCOUNT' } & ServiceAccountCredential);

export function decryptCredential(
  cipher: CredentialCipher,
  connection: TokenConnection,
): StoredCredential {
  if (!connection.credentialCiphertext || !connection.credentialKeyId)
    throw new CredentialCipherError('INTEGRATION_KEY_UNAVAILABLE');
  const plaintext = cipher.decrypt(
    {
      ciphertext: connection.credentialCiphertext,
      keyId: connection.credentialKeyId,
    },
    connectionCredentialAad(connection),
  );
  const parsed = JSON.parse(plaintext) as StoredCredential;
  if (parsed.kind !== connection.mode)
    throw new CredentialCipherError('INTEGRATION_CIPHERTEXT_INVALID');
  return parsed;
}

export function encryptCredential(
  cipher: CredentialCipher,
  connection: {
    id: string;
    organizationId: string;
    mode: 'OAUTH' | 'SERVICE_ACCOUNT';
    credentialVersion: number;
  },
  credential: StoredCredential,
) {
  return cipher.encrypt(
    JSON.stringify(credential),
    connectionCredentialAad(connection),
  );
}

export class DefaultGoogleTokenProvider implements GoogleTokenProvider {
  private readonly cache = new Map<
    string,
    { token: string; expiresAt: number }
  >();

  constructor(
    private readonly api: GoogleApiClient,
    private readonly cipher: CredentialCipher,
    private readonly settings: GoogleWorkspaceSettings,
    private readonly clock: { now(): Date } = { now: () => new Date() },
  ) {}

  forget(connectionId: string) {
    for (const key of this.cache.keys())
      if (key.startsWith(`${connectionId}:`)) this.cache.delete(key);
  }

  async getAccessToken(connection: TokenConnection, scopes: readonly string[]) {
    const wanted = [...new Set(scopes)].sort();
    if (!wanted.every((scope) => connection.grantedScopes.includes(scope)))
      throw new GoogleApiError('GOOGLE_SCOPE_NOT_GRANTED', false);
    const key = `${connection.id}:${connection.credentialVersion}:${wanted.join(' ')}`;
    const now = this.clock.now().getTime();
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > now) return cached.token;
    const credential = decryptCredential(this.cipher, connection);
    let response;
    if (credential.kind === 'OAUTH') {
      if (!this.settings.oauth)
        throw new GoogleApiError('GOOGLE_AUTH_FAILED', false);
      response = await this.api.refreshAccessToken({
        refreshToken: credential.refreshToken,
        clientId: this.settings.oauth.clientId,
        clientSecret: this.settings.oauth.clientSecret,
      });
    } else {
      if (!connection.accountEmail)
        throw new GoogleApiError('GOOGLE_AUTH_FAILED', false);
      response = await this.api.jwtBearerToken(
        serviceAccountAssertion(credential, {
          subject: connection.accountEmail,
          scopes: wanted,
          now: this.clock.now(),
        }),
      );
    }
    // Cached until a minute before Google's expiry.
    const lifetime = Math.max(0, response.expiresInSeconds - 60) * 1000;
    if (lifetime > 0)
      this.cache.set(key, {
        token: response.accessToken,
        expiresAt: now + lifetime,
      });
    return response.accessToken;
  }
}
