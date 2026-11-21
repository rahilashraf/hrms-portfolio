import { z } from 'zod';

export const nodeEnvSchema = z.enum(['development', 'test', 'production']);

export type NodeEnv = z.infer<typeof nodeEnvSchema>;

const emptyAsUndefined = (value: unknown) => (value === '' ? undefined : value);

const optionalPositiveInt = () =>
  z.preprocess(emptyAsUndefined, z.coerce.number().int().positive().optional());

/** A base64-encoded AES-256 key: exactly 32 bytes once decoded. */
export function isEncryptionKey(value: string): boolean {
  const trimmed = value.trim();
  // 32 bytes encode to 43 base64 characters plus one '=' of padding (optional).
  return /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=?$/.test(trimmed);
}

const environmentObjectSchema = z.object({
  NODE_ENV: nodeEnvSchema.default('development'),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  JWT_ACCESS_SECRET: z
    .string()
    .refine((secret) => new TextEncoder().encode(secret).length >= 32, {
      message: 'JWT_ACCESS_SECRET must contain at least 32 bytes',
    })
    .refine((secret) => new Set(secret).size >= 8, {
      message: 'JWT_ACCESS_SECRET must contain sufficient character variety',
    })
    .refine(
      (secret) => !/^(change[-_ ]?me|your[-_ ]|example|test-secret|secret|password)/i.test(secret),
      { message: 'JWT_ACCESS_SECRET must not be a placeholder value' },
    ),
  WEB_ORIGIN: z
    .string()
    .url()
    .refine((origin) => new URL(origin).origin === origin, {
      message: 'WEB_ORIGIN must contain only an origin without a path',
    })
    .optional(),
  TRUST_PROXY_HOPS: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.coerce.number().int().min(0).optional(),
  ),
  // Phase 19: log output (default: json in production, text elsewhere).
  LOG_FORMAT: z.preprocess(emptyAsUndefined, z.enum(['json', 'text']).optional()),
  ARGON2_MEMORY_COST_KIB: z.coerce.number().int().positive().default(65_536),
  ARGON2_TIME_COST: z.coerce.number().int().positive().default(3),
  ARGON2_PARALLELISM: z.coerce.number().int().positive().default(1),
  // Batch 4B (D6): kiosk identification limits count failed identifications only. Each is
  // optional; the defaults are in apps/api/src/kiosk/kiosk-rate-limiter.service.ts.
  KIOSK_DEVICE_FAILURE_LIMIT: optionalPositiveInt(),
  KIOSK_DEVICE_FAILURE_WINDOW_SECONDS: optionalPositiveInt(),
  KIOSK_DEVICE_EMPLOYEE_FAILURE_LIMIT: optionalPositiveInt(),
  KIOSK_DEVICE_EMPLOYEE_FAILURE_WINDOW_SECONDS: optionalPositiveInt(),
  KIOSK_EMPLOYEE_FAILURE_LIMIT: optionalPositiveInt(),
  KIOSK_EMPLOYEE_FAILURE_WINDOW_SECONDS: optionalPositiveInt(),
  KIOSK_ORGANIZATION_FAILURE_LIMIT: optionalPositiveInt(),
  KIOSK_ORGANIZATION_FAILURE_WINDOW_SECONDS: optionalPositiveInt(),
  // Phase 16.5 Google Workspace: the app's OAuth client (all three or none). Without it the
  // OAuth connection endpoints answer 503 GOOGLE_OAUTH_NOT_CONFIGURED.
  GOOGLE_OAUTH_CLIENT_ID: z.preprocess(emptyAsUndefined, z.string().min(1).max(500).optional()),
  GOOGLE_OAUTH_CLIENT_SECRET: z.preprocess(emptyAsUndefined, z.string().min(1).max(500).optional()),
  GOOGLE_OAUTH_REDIRECT_URI: z.preprocess(emptyAsUndefined, z.string().url().optional()),
  // Integration credential encryption (AES-256-GCM): base64 of exactly 32 bytes. Without it
  // credentials cannot be stored (503 INTEGRATION_ENCRYPTION_NOT_CONFIGURED).
  INTEGRATION_ENCRYPTION_KEY: z.preprocess(
    emptyAsUndefined,
    z
      .string()
      .refine(isEncryptionKey, {
        message: 'INTEGRATION_ENCRYPTION_KEY must be base64 of exactly 32 bytes',
      })
      .optional(),
  ),
  // Retired keys (comma-separated, same format) still decrypt existing credentials.
  INTEGRATION_ENCRYPTION_PREVIOUS_KEYS: z.preprocess(
    emptyAsUndefined,
    z
      .string()
      .refine((value) => value.split(',').every((key) => isEncryptionKey(key)), {
        message:
          'INTEGRATION_ENCRYPTION_PREVIOUS_KEYS must be base64 32-byte keys separated by commas',
      })
      .optional(),
  ),
  // Batch 2: the deployment's SMTP server (optional), used for account and notification email
  // when an organization has no Google Workspace Gmail connection. All or nothing; TLS is
  // required in production (tls on 465, starttls on 587 by default).
  SMTP_HOST: z.preprocess(emptyAsUndefined, z.string().min(1).max(255).optional()),
  SMTP_PORT: z.preprocess(emptyAsUndefined, z.coerce.number().int().min(1).max(65_535).optional()),
  SMTP_SECURITY: z.preprocess(emptyAsUndefined, z.enum(['tls', 'starttls', 'none']).optional()),
  SMTP_USER: z.preprocess(emptyAsUndefined, z.string().min(1).max(500).optional()),
  SMTP_PASSWORD: z.preprocess(emptyAsUndefined, z.string().min(1).max(500).optional()),
  SMTP_FROM: z.preprocess(
    emptyAsUndefined,
    z
      .string()
      .email()
      .refine((value) => !/[\s<>"]/.test(value), {
        message: 'SMTP_FROM must be a plain sender address',
      })
      .optional(),
  ),
  // Batch 9: document file storage (provider-neutral). `none` (default) disables uploads;
  // `local` is a directory for development and tests (refused in production unless explicitly
  // allowed); `s3` is any private S3-compatible bucket (endpoint, region, bucket and keys).
  DOCUMENT_STORAGE_DRIVER: z.preprocess(
    emptyAsUndefined,
    z.enum(['none', 'local', 's3']).default('none'),
  ),
  DOCUMENT_STORAGE_LOCAL_DIR: z.preprocess(
    emptyAsUndefined,
    z.string().min(1).max(1000).optional(),
  ),
  DOCUMENT_STORAGE_ALLOW_LOCAL_IN_PRODUCTION: z.preprocess(
    emptyAsUndefined,
    z.enum(['true', 'false']).default('false'),
  ),
  /** Signs local download URLs (HMAC-SHA256): at least 32 bytes. */
  DOCUMENT_URL_SIGNING_KEY: z.preprocess(
    emptyAsUndefined,
    z
      .string()
      .refine((key) => new TextEncoder().encode(key).length >= 32, {
        message: 'DOCUMENT_URL_SIGNING_KEY must contain at least 32 bytes',
      })
      .optional(),
  ),
  DOCUMENT_S3_ENDPOINT: z.preprocess(emptyAsUndefined, z.string().url().optional()),
  DOCUMENT_S3_REGION: z.preprocess(emptyAsUndefined, z.string().min(1).max(100).optional()),
  DOCUMENT_S3_BUCKET: z.preprocess(
    emptyAsUndefined,
    z
      .string()
      .regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, 'DOCUMENT_S3_BUCKET must be a bucket name')
      .optional(),
  ),
  DOCUMENT_S3_ACCESS_KEY_ID: z.preprocess(emptyAsUndefined, z.string().min(1).max(500).optional()),
  DOCUMENT_S3_SECRET_ACCESS_KEY: z.preprocess(
    emptyAsUndefined,
    z.string().min(1).max(500).optional(),
  ),
  DOCUMENT_S3_FORCE_PATH_STYLE: z.preprocess(
    emptyAsUndefined,
    z.enum(['true', 'false']).default('false'),
  ),
  /** Upload size limit in bytes: 10 MB by default, at most 25 MB. */
  DOCUMENT_UPLOAD_MAX_BYTES: z.preprocess(
    emptyAsUndefined,
    z.coerce.number().int().min(1).max(26_214_400).default(10_485_760),
  ),
  /** Future hardening: unscanned files are refused and never downloadable when true. */
  DOCUMENT_REQUIRE_MALWARE_SCAN: z.preprocess(
    emptyAsUndefined,
    z.enum(['true', 'false']).default('false'),
  ),
});

export const environmentSchema = environmentObjectSchema
  .superRefine((environment, context) => {
    if (environment.NODE_ENV === 'production' && !environment.WEB_ORIGIN) {
      context.addIssue({
        code: 'custom',
        path: ['WEB_ORIGIN'],
        message: 'WEB_ORIGIN must be configured in production',
      });
    }
    const oauth = [
      environment.GOOGLE_OAUTH_CLIENT_ID,
      environment.GOOGLE_OAUTH_CLIENT_SECRET,
      environment.GOOGLE_OAUTH_REDIRECT_URI,
    ];
    if (oauth.some(Boolean) && !oauth.every(Boolean)) {
      context.addIssue({
        code: 'custom',
        path: ['GOOGLE_OAUTH_CLIENT_ID'],
        message:
          'GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET and GOOGLE_OAUTH_REDIRECT_URI are configured together',
      });
    }
    if (
      environment.NODE_ENV === 'production' &&
      environment.GOOGLE_OAUTH_REDIRECT_URI &&
      new URL(environment.GOOGLE_OAUTH_REDIRECT_URI).protocol !== 'https:'
    ) {
      context.addIssue({
        code: 'custom',
        path: ['GOOGLE_OAUTH_REDIRECT_URI'],
        message: 'GOOGLE_OAUTH_REDIRECT_URI must use https in production',
      });
    }
    const smtp = [
      environment.SMTP_HOST,
      environment.SMTP_PORT,
      environment.SMTP_SECURITY,
      environment.SMTP_USER,
      environment.SMTP_PASSWORD,
      environment.SMTP_FROM,
    ];
    if (smtp.some((value) => value !== undefined)) {
      if (!environment.SMTP_HOST || !environment.SMTP_FROM) {
        context.addIssue({
          code: 'custom',
          path: [environment.SMTP_HOST ? 'SMTP_FROM' : 'SMTP_HOST'],
          message: 'SMTP_HOST and SMTP_FROM are required to configure SMTP',
        });
      }
      if (Boolean(environment.SMTP_USER) !== Boolean(environment.SMTP_PASSWORD)) {
        context.addIssue({
          code: 'custom',
          path: ['SMTP_USER'],
          message: 'SMTP_USER and SMTP_PASSWORD are configured together',
        });
      }
      if (environment.NODE_ENV === 'production' && environment.SMTP_SECURITY === 'none') {
        context.addIssue({
          code: 'custom',
          path: ['SMTP_SECURITY'],
          message: 'SMTP_SECURITY=none is not allowed in production; use tls or starttls',
        });
      }
    }
    // Batch 9: document storage.
    if (environment.DOCUMENT_STORAGE_DRIVER === 'local') {
      if (!environment.DOCUMENT_STORAGE_LOCAL_DIR || !environment.DOCUMENT_URL_SIGNING_KEY) {
        context.addIssue({
          code: 'custom',
          path: ['DOCUMENT_STORAGE_LOCAL_DIR'],
          message:
            'DOCUMENT_STORAGE_LOCAL_DIR and DOCUMENT_URL_SIGNING_KEY are required for local document storage',
        });
      }
      if (
        environment.NODE_ENV === 'production' &&
        environment.DOCUMENT_STORAGE_ALLOW_LOCAL_IN_PRODUCTION !== 'true'
      ) {
        context.addIssue({
          code: 'custom',
          path: ['DOCUMENT_STORAGE_DRIVER'],
          message:
            'Local document storage is refused in production; use s3 (or set DOCUMENT_STORAGE_ALLOW_LOCAL_IN_PRODUCTION=true deliberately)',
        });
      }
    }
    if (environment.DOCUMENT_STORAGE_DRIVER === 's3') {
      const s3 = {
        DOCUMENT_S3_ENDPOINT: environment.DOCUMENT_S3_ENDPOINT,
        DOCUMENT_S3_REGION: environment.DOCUMENT_S3_REGION,
        DOCUMENT_S3_BUCKET: environment.DOCUMENT_S3_BUCKET,
        DOCUMENT_S3_ACCESS_KEY_ID: environment.DOCUMENT_S3_ACCESS_KEY_ID,
        DOCUMENT_S3_SECRET_ACCESS_KEY: environment.DOCUMENT_S3_SECRET_ACCESS_KEY,
      };
      for (const [key, value] of Object.entries(s3)) {
        if (!value)
          context.addIssue({
            code: 'custom',
            path: [key],
            message: `${key} is required for s3 document storage`,
          });
      }
      if (
        environment.NODE_ENV === 'production' &&
        environment.DOCUMENT_S3_ENDPOINT &&
        new URL(environment.DOCUMENT_S3_ENDPOINT).protocol !== 'https:'
      ) {
        context.addIssue({
          code: 'custom',
          path: ['DOCUMENT_S3_ENDPOINT'],
          message: 'DOCUMENT_S3_ENDPOINT must use https in production',
        });
      }
    }
    if (environment.NODE_ENV === 'production' && environment.TRUST_PROXY_HOPS === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['TRUST_PROXY_HOPS'],
        message: 'TRUST_PROXY_HOPS must be deliberately configured in production',
      });
    }
  })
  .transform((environment) => ({
    ...environment,
    WEB_ORIGIN: environment.WEB_ORIGIN ?? 'http://localhost:3000',
    TRUST_PROXY_HOPS: environment.TRUST_PROXY_HOPS ?? 0,
  }));

export type EnvironmentConfig = z.infer<typeof environmentSchema>;

export function validateEnvironment(environment: Record<string, unknown>): EnvironmentConfig {
  return environmentSchema.parse(environment);
}
