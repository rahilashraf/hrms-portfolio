import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';

/**
 * Phase 16.5 — AES-256-GCM encryption of integration credentials (OAuth refresh tokens,
 * service-account key material, PKCE verifiers).
 *
 * The master key comes only from the environment (INTEGRATION_ENCRYPTION_KEY, base64 of exactly
 * 32 bytes) and is never persisted: each ciphertext is stored with a key id only (a short hash
 * of the key), so a rotated key can be recognized. Previous keys
 * (INTEGRATION_ENCRYPTION_PREVIOUS_KEYS) decrypt but never encrypt. Every ciphertext is bound to
 * its purpose and row through AES-GCM additional authenticated data, so a ciphertext copied to
 * another connection or field fails authentication.
 *
 * Format: `v1.<iv base64url>.<tag base64url>.<ciphertext base64url>`.
 */
export class CredentialCipherError extends Error {
  constructor(
    readonly code:
      | 'INTEGRATION_ENCRYPTION_NOT_CONFIGURED'
      | 'INTEGRATION_KEY_UNAVAILABLE'
      | 'INTEGRATION_CIPHERTEXT_INVALID',
  ) {
    super(code);
    this.name = 'CredentialCipherError';
  }
}

export interface EncryptedValue {
  ciphertext: string;
  keyId: string;
}

export function encryptionKeyId(key: Buffer) {
  return `k-${createHash('sha256').update(key).digest('hex').slice(0, 16)}`;
}

export function parseEncryptionKey(value: string): Buffer | null {
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) return null;
  const key = Buffer.from(trimmed, 'base64');
  return key.length === 32 ? key : null;
}

export class CredentialCipher {
  private readonly keys = new Map<string, Buffer>();
  private readonly currentKeyId: string | null;

  constructor(current: Buffer | null, previous: readonly Buffer[] = []) {
    for (const key of previous) this.keys.set(encryptionKeyId(key), key);
    if (current) {
      if (current.length !== 32) throw new Error('The key must be 32 bytes.');
      this.currentKeyId = encryptionKeyId(current);
      this.keys.set(this.currentKeyId, current);
    } else {
      this.currentKeyId = null;
    }
  }

  /** From INTEGRATION_ENCRYPTION_KEY / INTEGRATION_ENCRYPTION_PREVIOUS_KEYS (invalid → absent). */
  static fromEnvironment(
    env: Record<string, string | undefined> = process.env,
  ): CredentialCipher {
    const current = env.INTEGRATION_ENCRYPTION_KEY
      ? parseEncryptionKey(env.INTEGRATION_ENCRYPTION_KEY)
      : null;
    const previous = (env.INTEGRATION_ENCRYPTION_PREVIOUS_KEYS ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
      .map(parseEncryptionKey)
      .filter((key): key is Buffer => key !== null);
    return new CredentialCipher(current, previous);
  }

  /** Whether new credentials can be stored. */
  get configured() {
    return this.currentKeyId !== null;
  }

  /** Whether a stored ciphertext's key is available. */
  canDecrypt(keyId: string | null | undefined) {
    return !!keyId && this.keys.has(keyId);
  }

  encrypt(plaintext: string, associatedData: string): EncryptedValue {
    if (!this.currentKeyId)
      throw new CredentialCipherError('INTEGRATION_ENCRYPTION_NOT_CONFIGURED');
    const key = this.keys.get(this.currentKeyId)!;
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(associatedData, 'utf8'));
    const body = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return {
      ciphertext: [
        'v1',
        iv.toString('base64url'),
        tag.toString('base64url'),
        body.toString('base64url'),
      ].join('.'),
      keyId: this.currentKeyId,
    };
  }

  decrypt(value: EncryptedValue, associatedData: string): string {
    const key = this.keys.get(value.keyId);
    if (!key) throw new CredentialCipherError('INTEGRATION_KEY_UNAVAILABLE');
    const parts = value.ciphertext.split('.');
    if (parts.length !== 4 || parts[0] !== 'v1')
      throw new CredentialCipherError('INTEGRATION_CIPHERTEXT_INVALID');
    try {
      const iv = Buffer.from(parts[1]!, 'base64url');
      const tag = Buffer.from(parts[2]!, 'base64url');
      if (iv.length !== 12 || tag.length !== 16)
        throw new CredentialCipherError('INTEGRATION_CIPHERTEXT_INVALID');
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAAD(Buffer.from(associatedData, 'utf8'));
      decipher.setAuthTag(tag);
      return Buffer.concat([
        decipher.update(Buffer.from(parts[3]!, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      // Tampering, a wrong key or wrong associated data: never say which.
      throw new CredentialCipherError('INTEGRATION_CIPHERTEXT_INVALID');
    }
  }
}

/** Associated data binding a connection credential to its row and version. */
export const connectionCredentialAad = (connection: {
  id: string;
  organizationId: string;
  mode: string;
  credentialVersion: number;
}) =>
  `google-workspace:connection:${connection.organizationId}:${connection.id}:${connection.mode}:${connection.credentialVersion}`;

export const oauthVerifierAad = (state: {
  id: string;
  organizationId: string;
}) => `google-workspace:oauth-state:${state.organizationId}:${state.id}`;
