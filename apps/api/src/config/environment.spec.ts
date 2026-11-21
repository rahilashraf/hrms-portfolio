import { validateEnvironment } from '@hrms/config';
import { passwordSchema } from '@hrms/validation';

describe('validateEnvironment', () => {
  it('uses the centralized password hashing defaults', () => {
    expect(
      validateEnvironment({
        DATABASE_URL: 'postgresql://hrms:secret@localhost:5436/hrms',
        REDIS_URL: 'redis://localhost:6380',
        JWT_ACCESS_SECRET: 'unit-test-only-secret-value-at-least-32-bytes',
      }),
    ).toMatchObject({
      ARGON2_MEMORY_COST_KIB: 65_536,
      ARGON2_TIME_COST: 3,
      ARGON2_PARALLELISM: 1,
      TRUST_PROXY_HOPS: 0,
    });
  });

  it('accepts only json or text as LOG_FORMAT (Phase 19)', () => {
    const base = {
      DATABASE_URL: 'postgresql://hrms:secret@localhost:5436/hrms',
      REDIS_URL: 'redis://localhost:6380',
      JWT_ACCESS_SECRET: 'unit-test-only-secret-value-at-least-32-bytes',
    };
    expect(
      validateEnvironment({ ...base, LOG_FORMAT: 'json' }).LOG_FORMAT,
    ).toBe('json');
    expect(validateEnvironment({ ...base, LOG_FORMAT: '' }).LOG_FORMAT).toBe(
      undefined,
    );
    expect(() => validateEnvironment({ ...base, LOG_FORMAT: 'xml' })).toThrow();
  });

  it('rejects an invalid database URL', () => {
    expect(() =>
      validateEnvironment({
        DATABASE_URL: 'not-a-url',
        REDIS_URL: 'redis://localhost:6380',
        JWT_ACCESS_SECRET: 'unit-test-only-secret-value-at-least-32-bytes',
      }),
    ).toThrow();
  });

  describe('passwordSchema', () => {
    it('accepts passphrases and Unicode by character count', () => {
      expect(passwordSchema.safeParse('    twelve chars').success).toBe(true);
      expect(passwordSchema.safeParse('🙂'.repeat(12)).success).toBe(true);
    });

    it('rejects passwords outside the 12 to 128 character policy', () => {
      expect(passwordSchema.safeParse('short').success).toBe(false);
      expect(passwordSchema.safeParse('a'.repeat(129)).success).toBe(false);
    });
  });

  it('rejects a missing, weak, or placeholder JWT secret', () => {
    expect(() =>
      validateEnvironment({
        DATABASE_URL: 'postgresql://hrms:secret@localhost:5436/hrms',
        REDIS_URL: 'redis://localhost:6380',
      }),
    ).toThrow();
    expect(() =>
      validateEnvironment({
        DATABASE_URL: 'postgresql://hrms:secret@localhost:5436/hrms',
        REDIS_URL: 'redis://localhost:6380',
        JWT_ACCESS_SECRET: 'too-short',
      }),
    ).toThrow();
    expect(() =>
      validateEnvironment({
        DATABASE_URL: 'postgresql://hrms:secret@localhost:5436/hrms',
        REDIS_URL: 'redis://localhost:6380',
        JWT_ACCESS_SECRET: 'change-me-this-is-long-but-still-a-placeholder',
      }),
    ).toThrow();
    expect(() =>
      validateEnvironment({
        DATABASE_URL: 'postgresql://hrms:secret@localhost:5436/hrms',
        REDIS_URL: 'redis://localhost:6380',
        JWT_ACCESS_SECRET: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      }),
    ).toThrow();
  });

  it('requires an explicit browser origin in production', () => {
    const base = {
      DATABASE_URL: 'postgresql://hrms:secret@localhost:5436/hrms',
      REDIS_URL: 'redis://localhost:6380',
      JWT_ACCESS_SECRET: 'unit-test-only-secret-value-at-least-32-bytes',
      NODE_ENV: 'production',
    };
    expect(() => validateEnvironment(base)).toThrow();
    expect(
      validateEnvironment({
        ...base,
        WEB_ORIGIN: 'https://hrms.example.com',
        TRUST_PROXY_HOPS: 0,
      }).WEB_ORIGIN,
    ).toBe('https://hrms.example.com');
    expect(() =>
      validateEnvironment({
        ...base,
        WEB_ORIGIN: 'https://hrms.example.com',
      }),
    ).toThrow(/TRUST_PROXY_HOPS/);
    expect(
      validateEnvironment({
        ...base,
        WEB_ORIGIN: 'https://hrms.example.com',
        TRUST_PROXY_HOPS: '2',
      }).TRUST_PROXY_HOPS,
    ).toBe(2);
  });

  it('validates the optional SMTP server all-or-nothing and requires TLS in production (Batch 2)', () => {
    const base = {
      DATABASE_URL: 'postgresql://hrms:secret@localhost:5436/hrms',
      REDIS_URL: 'redis://localhost:6380',
      JWT_ACCESS_SECRET: 'unit-test-only-secret-value-at-least-32-bytes',
    };
    const smtp = {
      SMTP_HOST: 'smtp.example.com',
      SMTP_PORT: '587',
      SMTP_SECURITY: 'starttls',
      SMTP_USER: 'apikey',
      SMTP_PASSWORD: 'secret-value',
      SMTP_FROM: 'hr@example.com',
    };
    expect(validateEnvironment(base).SMTP_HOST).toBeUndefined();
    expect(validateEnvironment({ ...base, ...smtp })).toMatchObject({
      SMTP_HOST: 'smtp.example.com',
      SMTP_PORT: 587,
      SMTP_SECURITY: 'starttls',
    });
    // Without credentials (e.g. an internal relay) is allowed.
    expect(() =>
      validateEnvironment({
        ...base,
        SMTP_HOST: 'relay.internal',
        SMTP_FROM: 'hr@example.com',
      }),
    ).not.toThrow();
    for (const broken of [
      { SMTP_HOST: 'smtp.example.com' },
      { SMTP_FROM: 'hr@example.com' },
      { ...smtp, SMTP_PASSWORD: '' },
      { ...smtp, SMTP_FROM: 'HR <hr@example.com>' },
      { ...smtp, SMTP_SECURITY: 'ssl' },
      { ...smtp, SMTP_PORT: '70000' },
    ])
      expect(() => validateEnvironment({ ...base, ...broken })).toThrow();
    const production = {
      ...base,
      NODE_ENV: 'production',
      WEB_ORIGIN: 'https://hrms.example.com',
      TRUST_PROXY_HOPS: '1',
    };
    expect(() =>
      validateEnvironment({ ...production, ...smtp, SMTP_SECURITY: 'none' }),
    ).toThrow(/SMTP_SECURITY=none/);
    expect(() => validateEnvironment({ ...production, ...smtp })).not.toThrow();
  });
});
