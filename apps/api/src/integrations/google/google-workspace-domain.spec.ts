import {
  generateKeyPairSync,
  randomBytes,
  verify as verifySignature,
} from 'node:crypto';
import {
  classifyHttpStatus,
  FetchGoogleApiClient,
  GoogleApiError,
  type GoogleApiClient,
} from './google-api.client.js';
import {
  CredentialCipher,
  CredentialCipherError,
  encryptionKeyId,
  parseEncryptionKey,
} from './google-credential-cipher.js';
import {
  DefaultGoogleTokenProvider,
  encryptCredential,
  type TokenConnection,
} from './google-token.provider.js';
import {
  authorizationUrl,
  buildPlainTextMessage,
  CAPABILITY_SCOPES,
  compareCursor,
  connectionCan,
  exportRows,
  grantedCapabilities,
  idTokenIdentity,
  mappingProblemsAgainstForm,
  MappingError,
  MessageHeaderError,
  nextSyncAfter,
  normalizeCapabilities,
  normalizeInstant,
  oauthStateProblem,
  parseServiceAccountKey,
  pkceChallenge,
  pkcePair,
  recordedScopes,
  responseFilter,
  responsesAfter,
  scopesFor,
  serviceAccountAssertion,
  sha256Hex,
  toApplicationSubmission,
  toAssessmentResult,
  toTaskSubmission,
  validateFieldMapping,
  type GoogleFormInfo,
  type GoogleFormResponse,
} from './google-workspace-domain.js';

const key = () => randomBytes(32);

function rsaKey() {
  return generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
    type: 'pkcs8',
    format: 'pem',
  }) as string;
}

const serviceAccountJson = (privateKey: string, overrides = {}) =>
  JSON.stringify({
    type: 'service_account',
    project_id: 'hrms-test',
    private_key_id: 'abc123',
    private_key: privateKey,
    client_email: 'hrms-sync@hrms-test.iam.gserviceaccount.com',
    client_id: '1234567890',
    token_uri: 'https://oauth2.googleapis.com/token',
    ...overrides,
  });

const idToken = (claims: Record<string, unknown>) =>
  [
    Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64url'),
    Buffer.from(JSON.stringify(claims)).toString('base64url'),
    'signature',
  ].join('.');

const form: GoogleFormInfo = {
  formId: 'form-1234567890',
  title: 'Code of Conduct quiz',
  emailCollection: 'VERIFIED',
  questions: [
    { questionId: 'q1', title: 'First name', kind: 'TEXT', pointValue: null },
    { questionId: 'q2', title: 'Last name', kind: 'TEXT', pointValue: null },
    { questionId: 'q3', title: 'Why us?', kind: 'TEXT', pointValue: 5 },
    {
      questionId: 'q4',
      title: 'Resume',
      kind: 'FILE_UPLOAD',
      pointValue: null,
    },
    { questionId: 'q5', title: 'Pick one', kind: 'CHOICE', pointValue: 15 },
  ],
};

const response = (
  id: string,
  submitted: string,
  overrides: Partial<GoogleFormResponse> = {},
): GoogleFormResponse => ({
  responseId: id,
  createTime: submitted,
  lastSubmittedTime: submitted,
  respondentEmail: 'Ada@Example.com',
  totalScore: 17,
  answers: {
    q1: { texts: ['Ada'], files: [] },
    q2: { texts: ['Lovelace'], files: [] },
    q3: { texts: ['Because', 'of math'], files: [] },
    q4: {
      texts: [],
      files: [
        {
          fileId: 'drive-file-123456',
          fileName: 'cv.pdf',
          mimeType: 'application/pdf',
        },
      ],
    },
  },
  ...overrides,
});

describe('Google Workspace domain', () => {
  describe('credential encryption', () => {
    it('round-trips with AES-256-GCM and stores only a key id beside the ciphertext', () => {
      const secret = key();
      const cipher = new CredentialCipher(secret);
      const encrypted = cipher.encrypt('refresh-token-value', 'aad-1');
      expect(encrypted.keyId).toBe(encryptionKeyId(secret));
      expect(encrypted.keyId).toMatch(/^k-[0-9a-f]{16}$/);
      expect(encrypted.ciphertext).toMatch(/^v1\./);
      expect(encrypted.ciphertext).not.toContain('refresh-token-value');
      expect(encrypted.ciphertext).not.toContain(secret.toString('base64'));
      expect(cipher.decrypt(encrypted, 'aad-1')).toBe('refresh-token-value');
      // Fresh IVs: the same plaintext never encrypts the same twice.
      expect(
        cipher.encrypt('refresh-token-value', 'aad-1').ciphertext,
      ).not.toBe(encrypted.ciphertext);
    });

    it('detects tampering, wrong associated data and unknown key ids', () => {
      const cipher = new CredentialCipher(key());
      const encrypted = cipher.encrypt('secret', 'aad-1');
      const parts = encrypted.ciphertext.split('.');
      const body = Buffer.from(parts[3]!, 'base64url');
      body[0] = body[0]! ^ 0xff;
      const tampered = [...parts.slice(0, 3), body.toString('base64url')].join(
        '.',
      );
      const code = (run: () => unknown) => {
        try {
          run();
        } catch (error) {
          return (error as CredentialCipherError).code;
        }
        return null;
      };
      expect(
        code(() =>
          cipher.decrypt({ ...encrypted, ciphertext: tampered }, 'aad-1'),
        ),
      ).toBe('INTEGRATION_CIPHERTEXT_INVALID');
      expect(code(() => cipher.decrypt(encrypted, 'aad-2'))).toBe(
        'INTEGRATION_CIPHERTEXT_INVALID',
      );
      expect(
        code(() =>
          cipher.decrypt({ ...encrypted, ciphertext: 'v2.x.y.z' }, 'aad-1'),
        ),
      ).toBe('INTEGRATION_CIPHERTEXT_INVALID');
      // Another key (or a rotated-away one): the key id does not match any available key.
      const other = new CredentialCipher(key());
      expect(other.canDecrypt(encrypted.keyId)).toBe(false);
      expect(code(() => other.decrypt(encrypted, 'aad-1'))).toBe(
        'INTEGRATION_KEY_UNAVAILABLE',
      );
      // Same key id but a forged id/key pairing still fails authentication.
      expect(
        code(() =>
          other.decrypt(
            { ...encrypted, keyId: encryptionKeyId(randomBytes(32)) },
            'aad-1',
          ),
        ),
      ).toBe('INTEGRATION_KEY_UNAVAILABLE');
    });

    it('decrypts with previous keys but encrypts with the current one; refuses without a key', () => {
      const old = key();
      const encrypted = new CredentialCipher(old).encrypt('v', 'a');
      const rotated = new CredentialCipher(key(), [old]);
      expect(rotated.decrypt(encrypted, 'a')).toBe('v');
      expect(rotated.encrypt('v', 'a').keyId).not.toBe(encrypted.keyId);
      const none = new CredentialCipher(null);
      expect(none.configured).toBe(false);
      expect(() => none.encrypt('v', 'a')).toThrow(CredentialCipherError);
    });

    it('reads the key from the environment: base64 of exactly 32 bytes only', () => {
      const good = key().toString('base64');
      expect(
        CredentialCipher.fromEnvironment({ INTEGRATION_ENCRYPTION_KEY: good })
          .configured,
      ).toBe(true);
      expect(parseEncryptionKey(randomBytes(16).toString('base64'))).toBeNull();
      expect(parseEncryptionKey('not base64!')).toBeNull();
      expect(
        CredentialCipher.fromEnvironment({
          INTEGRATION_ENCRYPTION_KEY: randomBytes(31).toString('base64'),
        }).configured,
      ).toBe(false);
      expect(CredentialCipher.fromEnvironment({}).configured).toBe(false);
    });
  });

  describe('OAuth state and PKCE', () => {
    it('builds S256 challenges (RFC 7636 appendix B) and fresh verifiers', () => {
      expect(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
        'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
      );
      const pair = pkcePair();
      expect(pair.verifier.length).toBeGreaterThanOrEqual(43);
      expect(pair.verifier.length).toBeLessThanOrEqual(128);
      expect(pair.verifier).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(pair.challenge).toBe(pkceChallenge(pair.verifier));
      expect(pkcePair().verifier).not.toBe(pair.verifier);
    });

    it('builds an offline, consent, S256 authorization URL with exactly the requested scopes', () => {
      const url = new URL(
        authorizationUrl({
          clientId: 'client-id',
          redirectUri:
            'https://api.example.com/integrations/google/oauth/callback',
          scopes: ['openid', 'email', ...scopesFor(['FORMS'])],
          state: 'state-value',
          codeChallenge: 'challenge',
        }),
      );
      expect(url.origin + url.pathname).toBe(
        'https://accounts.google.com/o/oauth2/v2/auth',
      );
      expect(Object.fromEntries(url.searchParams)).toMatchObject({
        client_id: 'client-id',
        response_type: 'code',
        access_type: 'offline',
        prompt: 'consent',
        code_challenge: 'challenge',
        code_challenge_method: 'S256',
        state: 'state-value',
        include_granted_scopes: 'false',
      });
      expect(url.searchParams.get('scope')!.split(' ')).toEqual([
        'openid',
        'email',
        'https://www.googleapis.com/auth/forms.body.readonly',
        'https://www.googleapis.com/auth/forms.responses.readonly',
      ]);
    });

    it('accepts a state once, unexpired, for the same initiating user or browser only', () => {
      const nonce = 'browser-nonce';
      const state = {
        consumedAt: null,
        expiresAt: new Date('2026-10-06T10:10:00Z'),
        initiatedByUserId: 'u-1',
        browserBindingHash: sha256Hex(nonce),
      };
      const now = new Date('2026-10-06T10:05:00Z');
      expect(sha256Hex('x')).toMatch(/^[0-9a-f]{64}$/);
      expect(oauthStateProblem(state, now, { userId: 'u-1' })).toBeNull();
      expect(oauthStateProblem(state, now, { browserNonce: nonce })).toBeNull();
      expect(oauthStateProblem(state, now, { userId: 'u-2' })).toBe(
        'OAUTH_STATE_OTHER_USER',
      );
      expect(oauthStateProblem(state, now, { browserNonce: 'other' })).toBe(
        'OAUTH_STATE_OTHER_USER',
      );
      expect(oauthStateProblem(state, now, {})).toBe('OAUTH_STATE_UNBOUND');
      expect(
        oauthStateProblem(state, new Date('2026-10-06T10:10:00Z'), {
          userId: 'u-1',
        }),
      ).toBe('OAUTH_STATE_EXPIRED');
      expect(
        oauthStateProblem({ ...state, consumedAt: now }, now, {
          userId: 'u-1',
        }),
      ).toBe('OAUTH_STATE_USED');
    });

    it('reads the consenting identity from the ID token (issuer, audience, expiry, verified email)', () => {
      const now = new Date('2026-10-06T10:00:00Z');
      const exp = Math.floor(now.getTime() / 1000) + 600;
      const claims = {
        iss: 'https://accounts.google.com',
        aud: 'client-id',
        exp,
        email: 'Admin@School.example',
        email_verified: true,
        hd: 'School.example',
      };
      expect(idTokenIdentity(idToken(claims), 'client-id', now)).toEqual({
        email: 'admin@school.example',
        hostedDomain: 'school.example',
      });
      expect(
        idTokenIdentity(
          idToken({ ...claims, hd: undefined }),
          'client-id',
          now,
        ),
      ).toEqual({
        email: 'admin@school.example',
        hostedDomain: null,
      });
      expect(
        idTokenIdentity(idToken({ ...claims, aud: 'other' }), 'client-id', now),
      ).toBeNull();
      expect(
        idTokenIdentity(idToken({ ...claims, iss: 'evil' }), 'client-id', now),
      ).toBeNull();
      expect(
        idTokenIdentity(idToken({ ...claims, exp: 1 }), 'client-id', now),
      ).toBeNull();
      expect(
        idTokenIdentity(
          idToken({ ...claims, email_verified: false }),
          'client-id',
          now,
        ),
      ).toBeNull();
      expect(idTokenIdentity('garbage', 'client-id', now)).toBeNull();
    });
  });

  describe('scopes and capabilities', () => {
    it('maps capabilities to minimal delegated scopes and records only known granted scopes', () => {
      expect(
        normalizeCapabilities(['GMAIL_SEND', 'FORMS', 'NOPE', 'FORMS']),
      ).toEqual(['FORMS', 'GMAIL_SEND']);
      expect(CAPABILITY_SCOPES.SHEETS_EXPORT).toEqual([
        'https://www.googleapis.com/auth/drive.file',
      ]);
      expect(CAPABILITY_SCOPES.DRIVE_METADATA).toEqual([
        'https://www.googleapis.com/auth/drive.metadata.readonly',
      ]);
      const granted = recordedScopes(
        'openid https://www.googleapis.com/auth/forms.body.readonly https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/forms.responses.readonly',
      );
      expect(granted).not.toContain('https://www.googleapis.com/auth/drive');
      expect(grantedCapabilities(['FORMS', 'GMAIL_SEND'], granted)).toEqual([
        'FORMS',
      ]);
      expect(
        connectionCan(
          { status: 'ACTIVE', capabilities: ['FORMS'], grantedScopes: granted },
          'FORMS',
        ),
      ).toBe(true);
      expect(
        connectionCan(
          { status: 'ERROR', capabilities: ['FORMS'], grantedScopes: granted },
          'FORMS',
        ),
      ).toBe(false);
      expect(
        connectionCan(
          {
            status: 'ACTIVE',
            capabilities: ['GMAIL_SEND'],
            grantedScopes: granted,
          },
          'GMAIL_SEND',
        ),
      ).toBe(false);
    });
  });

  describe('service accounts', () => {
    it('validates the key shape and keeps only the minimal key material', () => {
      const privateKey = rsaKey();
      const parsed = parseServiceAccountKey(serviceAccountJson(privateKey));
      expect(parsed).toEqual({
        clientEmail: 'hrms-sync@hrms-test.iam.gserviceaccount.com',
        privateKeyId: 'abc123',
        privateKey,
      });
      expect(parseServiceAccountKey('{')).toBe('SERVICE_ACCOUNT_KEY_NOT_JSON');
      expect(parseServiceAccountKey('[]')).toBe('SERVICE_ACCOUNT_KEY_NOT_JSON');
      expect(
        parseServiceAccountKey(
          serviceAccountJson(privateKey, { type: 'user' }),
        ),
      ).toBe('SERVICE_ACCOUNT_KEY_TYPE');
      expect(
        parseServiceAccountKey(
          serviceAccountJson(privateKey, { client_email: 'x@gmail.com' }),
        ),
      ).toBe('SERVICE_ACCOUNT_KEY_FIELDS');
      expect(
        parseServiceAccountKey(
          serviceAccountJson(privateKey, {
            token_uri: 'https://evil.example/token',
          }),
        ),
      ).toBe('SERVICE_ACCOUNT_KEY_TOKEN_URI');
      expect(parseServiceAccountKey(serviceAccountJson('not a key'))).toBe(
        'SERVICE_ACCOUNT_KEY_PRIVATE_KEY',
      );
    });

    it('signs an RS256 JWT bearer assertion for the impersonated user and scopes', () => {
      const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
      const credential = {
        clientEmail: 'hrms-sync@hrms-test.iam.gserviceaccount.com',
        privateKeyId: 'abc123',
        privateKey: pair.privateKey.export({
          type: 'pkcs8',
          format: 'pem',
        }) as string,
      };
      const now = new Date('2026-10-06T10:00:00Z');
      const assertion = serviceAccountAssertion(credential, {
        subject: 'hr-bot@school.example',
        scopes: ['s1', 's2'],
        now,
      });
      const [header, claims, signature] = assertion.split('.');
      expect(JSON.parse(Buffer.from(header!, 'base64url').toString())).toEqual({
        alg: 'RS256',
        typ: 'JWT',
        kid: 'abc123',
      });
      expect(JSON.parse(Buffer.from(claims!, 'base64url').toString())).toEqual({
        iss: credential.clientEmail,
        sub: 'hr-bot@school.example',
        scope: 's1 s2',
        aud: 'https://oauth2.googleapis.com/token',
        iat: now.getTime() / 1000,
        exp: now.getTime() / 1000 + 3600,
      });
      expect(
        verifySignature(
          'RSA-SHA256',
          Buffer.from(`${header}.${claims}`),
          pair.publicKey,
          Buffer.from(signature!, 'base64url'),
        ),
      ).toBe(true);
    });
  });

  describe('field mapping', () => {
    it('accepts a valid versioned mapping per target', () => {
      expect(
        validateFieldMapping('RECRUITMENT_INTAKE', {
          schemaVersion: 1,
          fields: [
            { questionId: 'q1', field: 'candidate.firstName' },
            { questionId: 'q2', field: 'candidate.lastName' },
            { questionId: 'q3', field: 'answer', label: ' Motivation ' },
            { questionId: 'q4', field: 'document.RESUME' },
          ],
        }),
      ).toEqual({
        schemaVersion: 1,
        fields: [
          { questionId: 'q1', field: 'candidate.firstName' },
          { questionId: 'q2', field: 'candidate.lastName' },
          { questionId: 'q3', field: 'answer', label: 'Motivation' },
          { questionId: 'q4', field: 'document.RESUME' },
        ],
      });
      expect(
        validateFieldMapping('PERFORMANCE_EVIDENCE', {
          schemaVersion: 1,
          fields: [],
          scoreSource: 'NONE',
        }),
      ).toEqual({ schemaVersion: 1, fields: [], scoreSource: 'NONE' });
      expect(
        validateFieldMapping('ONBOARDING_TASKS', {
          schemaVersion: 1,
          fields: [],
        }),
      ).toEqual({
        schemaVersion: 1,
        fields: [],
      });
    });

    it('refuses unknown properties, fields, versions, duplicates and missing required fields', () => {
      const code = (
        target: Parameters<typeof validateFieldMapping>[0],
        input: unknown,
      ) => {
        try {
          validateFieldMapping(target, input);
          return null;
        } catch (error) {
          return (error as MappingError).code;
        }
      };
      const names = [
        { questionId: 'q1', field: 'candidate.firstName' },
        { questionId: 'q2', field: 'candidate.lastName' },
      ];
      expect(code('ONBOARDING_TASKS', null)).toBe('GOOGLE_MAPPING_INVALID');
      expect(code('ONBOARDING_TASKS', { schemaVersion: 2, fields: [] })).toBe(
        'GOOGLE_MAPPING_VERSION',
      );
      expect(
        code('ONBOARDING_TASKS', { schemaVersion: 1, fields: [], extra: 1 }),
      ).toBe('GOOGLE_MAPPING_INVALID');
      expect(
        code('ONBOARDING_TASKS', {
          schemaVersion: 1,
          fields: [{ questionId: 'q1', field: 'candidate.firstName' }],
        }),
      ).toBe('GOOGLE_MAPPING_FIELD');
      expect(
        code('ONBOARDING_TASKS', {
          schemaVersion: 1,
          fields: [{ questionId: 'q 1', field: 'respondentEmail' }],
        }),
      ).toBe('GOOGLE_MAPPING_INVALID');
      expect(
        code('ONBOARDING_TASKS', {
          schemaVersion: 1,
          fields: [{ questionId: 'q1', field: 'respondentEmail', other: true }],
        }),
      ).toBe('GOOGLE_MAPPING_INVALID');
      expect(
        code('RECRUITMENT_INTAKE', {
          schemaVersion: 1,
          fields: [...names, { questionId: 'q1', field: 'answer' }],
        }),
      ).toBe('GOOGLE_MAPPING_DUPLICATE');
      expect(
        code('RECRUITMENT_INTAKE', {
          schemaVersion: 1,
          fields: [
            ...names,
            { questionId: 'q3', field: 'candidate.firstName' },
          ],
        }),
      ).toBe('GOOGLE_MAPPING_DUPLICATE');
      expect(
        code('RECRUITMENT_INTAKE', { schemaVersion: 1, fields: [names[0]] }),
      ).toBe('GOOGLE_MAPPING_REQUIRED');
      expect(
        code('RECRUITMENT_INTAKE', {
          schemaVersion: 1,
          fields: [{ ...names[0], label: 'x' }, names[1]],
        }),
      ).toBe('GOOGLE_MAPPING_INVALID');
      expect(
        code('RECRUITMENT_INTAKE', {
          schemaVersion: 1,
          fields: [
            ...names,
            { questionId: 'q3', field: 'answer', label: 'a\nb' },
          ],
        }),
      ).toBe('GOOGLE_MAPPING_INVALID');
      expect(
        code('RECRUITMENT_INTAKE', {
          schemaVersion: 1,
          fields: names,
          scoreSource: 'NONE',
        }),
      ).toBe('GOOGLE_MAPPING_INVALID');
    });

    it('checks a mapping against the form questions', () => {
      const mapping = (fields: Array<{ questionId: string; field: string }>) =>
        validateFieldMapping('RECRUITMENT_INTAKE', {
          schemaVersion: 1,
          fields: [
            { questionId: 'q1', field: 'candidate.firstName' },
            { questionId: 'q2', field: 'candidate.lastName' },
            ...fields,
          ],
        });
      expect(
        mappingProblemsAgainstForm(
          mapping([{ questionId: 'q4', field: 'document.RESUME' }]),
          form,
        ),
      ).toBeNull();
      expect(
        mappingProblemsAgainstForm(
          mapping([{ questionId: 'zz', field: 'answer' }]),
          form,
        ),
      ).toBe('GOOGLE_MAPPING_UNKNOWN_QUESTION');
      expect(
        mappingProblemsAgainstForm(
          mapping([{ questionId: 'q3', field: 'document.RESUME' }]),
          form,
        ),
      ).toBe('GOOGLE_MAPPING_QUESTION_KIND');
      expect(
        mappingProblemsAgainstForm(
          mapping([{ questionId: 'q4', field: 'answer' }]),
          form,
        ),
      ).toBe('GOOGLE_MAPPING_QUESTION_KIND');
    });
  });

  describe('responses and cursors', () => {
    it('normalizes instants to comparable 9-digit UTC text without losing microseconds', () => {
      expect(normalizeInstant('2026-10-06T10:00:00.123456Z')).toBe(
        '2026-10-06T10:00:00.123456000Z',
      );
      expect(normalizeInstant('2026-10-06T10:00:00Z')).toBe(
        '2026-10-06T10:00:00.000000000Z',
      );
      expect(normalizeInstant('2026-10-06T12:00:00.5+02:00')).toBe(
        '2026-10-06T10:00:00.500000000Z',
      );
      expect(normalizeInstant('yesterday')).toBeNull();
    });

    it('orders responses by (submission time, id) and keeps only those after the cursor', () => {
      const all = [
        response('b', '2026-10-06T10:00:00.000002Z'),
        response('a', '2026-10-06T10:00:00.000002Z'),
        response('c', '2026-10-06T10:00:00.000001Z'),
        response('d', '2026-10-06T11:00:00Z'),
        response('bad', 'not a time'),
      ];
      expect(
        responsesAfter(all, null).map((r) => r.response.responseId),
      ).toEqual(['c', 'a', 'b', 'd']);
      const cursor = {
        submittedAt: '2026-10-06T10:00:00.000002000Z',
        responseId: 'a',
      };
      expect(
        responsesAfter(all, cursor).map((r) => r.response.responseId),
      ).toEqual(['b', 'd']);
      expect(compareCursor(cursor, { ...cursor, responseId: 'b' })).toBe(-1);
      expect(responseFilter(cursor)).toBe('timestamp >= 2026-10-06T10:00:00Z');
      expect(responseFilter(null)).toBeNull();
    });

    it('maps responses to each domain contract without raw payloads', () => {
      const perf = toAssessmentResult(
        validateFieldMapping('PERFORMANCE_EVIDENCE', {
          schemaVersion: 1,
          fields: [],
        }),
        form,
        response('r1', '2026-10-06T10:00:00Z', {
          lastSubmittedTime: '2026-10-06T11:00:00Z',
        }),
      );
      expect(perf).toEqual({
        externalResultId: 'r1',
        respondentEmail: 'ada@example.com',
        respondentReference: null,
        title: 'Code of Conduct quiz',
        completedAt: '2026-10-06T10:00:00Z',
        externalUpdatedAt: '2026-10-06T11:00:00Z',
        score: 17,
        maxScore: 20,
      });
      expect(
        toAssessmentResult(
          validateFieldMapping('PERFORMANCE_EVIDENCE', {
            schemaVersion: 1,
            fields: [],
            scoreSource: 'NONE',
          }),
          form,
          response('r1', '2026-10-06T10:00:00Z'),
        ),
      ).toMatchObject({ score: null, maxScore: null });
      const application = toApplicationSubmission(
        validateFieldMapping('RECRUITMENT_INTAKE', {
          schemaVersion: 1,
          fields: [
            { questionId: 'q1', field: 'candidate.firstName' },
            { questionId: 'q2', field: 'candidate.lastName' },
            { questionId: 'q3', field: 'answer' },
            { questionId: 'q4', field: 'document.RESUME', label: 'CV' },
          ],
        }),
        form,
        response('r2', '2026-10-06T10:00:00Z'),
      );
      expect(application).toMatchObject({
        externalResponseId: 'r2',
        candidate: {
          firstName: 'Ada',
          lastName: 'Lovelace',
          email: 'ada@example.com',
        },
        answers: [{ question: 'Why us?', answer: 'Because, of math' }],
        documents: [
          {
            kind: 'RESUME',
            title: 'CV',
            provider: 'GOOGLE_DRIVE',
            externalFileId: 'drive-file-123456',
            fileName: 'cv.pdf',
          },
        ],
      });
      expect(JSON.stringify(application)).not.toContain('webViewLink');
      const taskForm = { ...form, formId: 'form-1234567890' };
      expect(
        toTaskSubmission(taskForm, response('r3', '2026-10-06T10:00:00Z')),
      ).toEqual({
        externalResourceId: 'form-1234567890',
        externalResponseId: 'r3',
        respondentEmail: 'ada@example.com',
        submittedAt: '2026-10-06T10:00:00Z',
      });
      expect(
        toTaskSubmission(
          taskForm,
          response('r4', '2026-10-06T10:00:00Z', { respondentEmail: null }),
        ),
      ).toBeNull();
      // Batch 7B (D1): an email the respondent typed (not verified by Google) is no identity.
      expect(
        toTaskSubmission(
          { ...taskForm, emailCollection: 'RESPONDER_INPUT' },
          response('r5', '2026-10-06T10:00:00Z'),
        ),
      ).toBeNull();
      expect(
        toAssessmentResult(
          validateFieldMapping('PERFORMANCE_EVIDENCE', {
            schemaVersion: 1,
            fields: [],
          }),
          { ...form, emailCollection: 'RESPONDER_INPUT' },
          response('r6', '2026-10-06T10:00:00Z'),
        ),
      ).toMatchObject({
        respondentEmail: null,
        respondentReference: 'Unverified email: ada@example.com',
      });
    });
  });

  describe('errors and backoff', () => {
    it('classifies HTTP failures as retryable (429, 5xx) or permanent (4xx)', () => {
      expect(classifyHttpStatus(429)).toMatchObject({
        code: 'GOOGLE_RATE_LIMITED',
        retryable: true,
      });
      expect(classifyHttpStatus(503)).toMatchObject({
        code: 'GOOGLE_UNAVAILABLE',
        retryable: true,
      });
      expect(classifyHttpStatus(400)).toMatchObject({
        code: 'GOOGLE_BAD_REQUEST',
        retryable: false,
      });
      expect(classifyHttpStatus(401)).toMatchObject({
        code: 'GOOGLE_UNAUTHORIZED',
        retryable: false,
      });
      expect(classifyHttpStatus(403)).toMatchObject({
        code: 'GOOGLE_FORBIDDEN',
        retryable: false,
      });
      expect(classifyHttpStatus(404)).toMatchObject({
        code: 'GOOGLE_NOT_FOUND',
        retryable: false,
      });
      expect(classifyHttpStatus(400, 'invalid_grant')).toMatchObject({
        code: 'GOOGLE_AUTH_REVOKED',
        authFailure: true,
      });
      expect(classifyHttpStatus(401, 'invalid_client').authFailure).toBe(true);
      expect(classifyHttpStatus(404).authFailure).toBe(false);
    });

    it('never puts response bodies, tokens or URLs into client errors', async () => {
      const calls: Array<{
        url: string;
        init: { headers: Record<string, string>; body?: string };
      }> = [];
      const reply =
        (status: number, body: unknown) =>
        async (
          url: string,
          init: {
            method: string;
            headers: Record<string, string>;
            body?: string;
          },
        ) => {
          calls.push({ url, init });
          return { ok: status < 400, status, json: async () => body };
        };
      const failing = new FetchGoogleApiClient(
        reply(403, {
          error: { message: 'secret answer from respondent@example.com' },
        }),
      );
      const error = (await failing
        .getForm('access-token-xyz', 'form-1234567890')
        .catch((e: unknown) => e)) as GoogleApiError;
      expect(error).toBeInstanceOf(GoogleApiError);
      expect(error.code).toBe('GOOGLE_FORBIDDEN');
      expect(`${error.message} ${error.stack}`).not.toMatch(
        /secret|respondent|access-token-xyz|forms\.googleapis/,
      );
      expect(calls[0]!.init.headers.authorization).toBe(
        'Bearer access-token-xyz',
      );
      const network = new FetchGoogleApiClient(async () => {
        throw new Error(
          'ECONNRESET to https://oauth2.googleapis.com/token?refresh_token=abc',
        );
      });
      const failure = (await network
        .refreshAccessToken({
          refreshToken: 'abc',
          clientId: 'c',
          clientSecret: 's',
        })
        .catch((e: unknown) => e)) as GoogleApiError;
      expect(failure).toMatchObject({
        code: 'GOOGLE_NETWORK_ERROR',
        retryable: true,
      });
      expect(failure.message).not.toContain('refresh_token');
      const revoked = new FetchGoogleApiClient(
        reply(400, {
          error: 'invalid_grant',
          error_description: 'Token has been expired or revoked.',
        }),
      );
      await expect(
        revoked.refreshAccessToken({
          refreshToken: 'abc',
          clientId: 'c',
          clientSecret: 's',
        }),
      ).rejects.toMatchObject({
        code: 'GOOGLE_AUTH_REVOKED',
        retryable: false,
      });
      // Ids are validated before any URL is built.
      await expect(
        failing.getDriveFile('t', '../../etc'),
      ).rejects.toMatchObject({
        code: 'GOOGLE_BAD_REQUEST',
      });
      const okClient = new FetchGoogleApiClient(
        reply(200, {
          responses: [
            {
              responseId: 'r1',
              createTime: '2026-10-06T10:00:00Z',
              lastSubmittedTime: '2026-10-06T10:00:00Z',
              respondentEmail: 'a@example.com',
              totalScore: 3,
              answers: { q1: { textAnswers: { answers: [{ value: 'x' }] } } },
            },
          ],
          nextPageToken: 'p2',
        }),
      );
      const page = await okClient.listFormResponses('t', 'form-1234567890', {
        filter: 'timestamp >= 2026-10-06T10:00:00Z',
        pageToken: null,
        pageSize: 500,
      });
      expect(page).toEqual({
        responses: [
          {
            responseId: 'r1',
            createTime: '2026-10-06T10:00:00Z',
            lastSubmittedTime: '2026-10-06T10:00:00Z',
            respondentEmail: 'a@example.com',
            totalScore: 3,
            answers: { q1: { texts: ['x'], files: [] } },
          },
        ],
        nextPageToken: 'p2',
      });
      expect(new URL(calls.at(-1)!.url).searchParams.get('filter')).toBe(
        'timestamp >= 2026-10-06T10:00:00Z',
      );
    });

    it('backs off exponentially, capped at a day', () => {
      const now = new Date('2026-10-06T10:00:00Z');
      const minutes = (n: number) =>
        (nextSyncAfter(n, now)!.getTime() - now.getTime()) / 60_000;
      expect(nextSyncAfter(0, now)).toBeNull();
      expect([1, 2, 3, 4].map(minutes)).toEqual([15, 30, 60, 120]);
      expect(minutes(30)).toBe(24 * 60);
    });
  });

  describe('Gmail messages', () => {
    const decode = (raw: string) =>
      Buffer.from(raw, 'base64url').toString('utf8');

    it('builds an RFC 5322 text/plain message, base64url encoded', () => {
      const raw = buildPlainTextMessage({
        from: 'hr@school.example',
        to: 'staff@school.example',
        subject: 'Réunion — demain',
        text: 'Line one\nLine two',
        messageId: '0f1e2d3c-0000-4000-8000-000000000001',
      });
      expect(raw).toMatch(/^[A-Za-z0-9_-]+$/);
      const message = decode(raw);
      const [head, body] = message.split('\r\n\r\n');
      expect(head!.split('\r\n')).toEqual([
        'From: hr@school.example',
        'To: staff@school.example',
        `Subject: =?UTF-8?B?${Buffer.from('Réunion — demain').toString('base64')}?=`,
        'X-HRMS-Notification: 0f1e2d3c-0000-4000-8000-000000000001',
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset="UTF-8"',
        'Content-Transfer-Encoding: base64',
      ]);
      expect(Buffer.from(body!.replace(/\r\n/g, ''), 'base64').toString()).toBe(
        'Line one\r\nLine two',
      );
    });

    it('prevents header injection through addresses, subject and body', () => {
      const build = (overrides: Record<string, string | null>) => () =>
        buildPlainTextMessage({
          from: 'hr@school.example',
          to: 'staff@school.example',
          subject: 'Hello',
          text: 'Body',
          ...overrides,
        });
      for (const to of [
        'staff@school.example\r\nBcc: attacker@evil.example',
        'Staff <staff@school.example>',
        'a@b.example, c@d.example',
        'not-an-address',
      ]) {
        expect(build({ to })).toThrow(MessageHeaderError);
      }
      expect(build({ from: 'hr@school.example\nBcc: x@evil.example' })).toThrow(
        MessageHeaderError,
      );
      expect(build({ subject: '\r\n' })).toThrow(MessageHeaderError);
      const message = decode(
        build({
          subject: 'Hi\r\nBcc: attacker@evil.example',
          text: 'Body\r\n\r\nBcc: attacker@evil.example',
        })(),
      );
      const head = message.split('\r\n\r\n')[0]!;
      expect(head).not.toMatch(/^Bcc:/im);
      expect(head.split('\r\n')).toHaveLength(6);
      expect(message).not.toContain('attacker@evil.example');
    });
  });

  describe('token provider', () => {
    const connection = (
      cipher: CredentialCipher,
      mode: 'OAUTH' | 'SERVICE_ACCOUNT',
      credential: object,
    ): TokenConnection => {
      const base = {
        id: '00000000-0000-4000-8000-0000000000aa',
        organizationId: '00000000-0000-4000-8000-0000000000bb',
        mode,
        credentialVersion: 1,
      };
      const encrypted = encryptCredential(cipher, base, credential as never);
      return {
        ...base,
        credentialCiphertext: encrypted.ciphertext,
        credentialKeyId: encrypted.keyId,
        grantedScopes: scopesFor(['FORMS', 'DRIVE_METADATA']),
        accountEmail: 'hr-bot@school.example',
      };
    };

    it('refreshes OAuth tokens once and caches them in memory only until expiry', async () => {
      const cipher = new CredentialCipher(key());
      let refreshes = 0;
      const api = {
        refreshAccessToken: async (input: { refreshToken: string }) => {
          refreshes += 1;
          expect(input.refreshToken).toBe('refresh-1');
          return {
            accessToken: `access-${refreshes}`,
            expiresInSeconds: 3600,
            refreshToken: null,
            scope: null,
            idToken: null,
          };
        },
      } as unknown as GoogleApiClient;
      let now = new Date('2026-10-06T10:00:00Z');
      const provider = new DefaultGoogleTokenProvider(
        api,
        cipher,
        {
          oauth: {
            clientId: 'c',
            clientSecret: 's',
            redirectUri: 'https://x.example/cb',
          },
          webOrigin: 'https://web.example',
          production: false,
        },
        { now: () => now },
      );
      const conn = connection(cipher, 'OAUTH', {
        kind: 'OAUTH',
        refreshToken: 'refresh-1',
      });
      const scopes = CAPABILITY_SCOPES.FORMS;
      expect(await provider.getAccessToken(conn, scopes)).toBe('access-1');
      expect(await provider.getAccessToken(conn, scopes)).toBe('access-1');
      now = new Date(now.getTime() + 3600_000);
      expect(await provider.getAccessToken(conn, scopes)).toBe('access-2');
      provider.forget(conn.id);
      expect(await provider.getAccessToken(conn, scopes)).toBe('access-3');
      await expect(
        provider.getAccessToken(conn, CAPABILITY_SCOPES.GMAIL_SEND),
      ).rejects.toMatchObject({
        code: 'GOOGLE_SCOPE_NOT_GRANTED',
      });
      // Another key cannot read the credential.
      const other = new DefaultGoogleTokenProvider(
        api,
        new CredentialCipher(key()),
        {
          oauth: {
            clientId: 'c',
            clientSecret: 's',
            redirectUri: 'https://x.example/cb',
          },
          webOrigin: 'https://web.example',
          production: false,
        },
      );
      await expect(other.getAccessToken(conn, scopes)).rejects.toMatchObject({
        code: 'INTEGRATION_KEY_UNAVAILABLE',
      });
    });

    it('obtains service-account tokens through a signed assertion for the impersonated user', async () => {
      const cipher = new CredentialCipher(key());
      const assertions: string[] = [];
      const api = {
        jwtBearerToken: async (assertion: string) => {
          assertions.push(assertion);
          return {
            accessToken: 'sa-access',
            expiresInSeconds: 3600,
            refreshToken: null,
            scope: null,
            idToken: null,
          };
        },
      } as unknown as GoogleApiClient;
      const provider = new DefaultGoogleTokenProvider(api, cipher, {
        oauth: null,
        webOrigin: 'https://web.example',
        production: false,
      });
      const conn = connection(cipher, 'SERVICE_ACCOUNT', {
        kind: 'SERVICE_ACCOUNT',
        clientEmail: 'hrms-sync@hrms-test.iam.gserviceaccount.com',
        privateKeyId: 'abc123',
        privateKey: rsaKey(),
      });
      expect(
        await provider.getAccessToken(conn, CAPABILITY_SCOPES.DRIVE_METADATA),
      ).toBe('sa-access');
      const claims = JSON.parse(
        Buffer.from(assertions[0]!.split('.')[1]!, 'base64url').toString(),
      );
      expect(claims).toMatchObject({
        sub: 'hr-bot@school.example',
        scope: 'https://www.googleapis.com/auth/drive.metadata.readonly',
      });
    });
  });

  it('bounds Sheets export rows and never evaluates formulas', () => {
    expect(
      exportRows(['Name', 'Score'], [['=HYPERLINK("x")', 3], [null]]),
    ).toEqual([['Name', 'Score'], ['=HYPERLINK("x")', 3], [null]]);
    expect(() => exportRows([], [])).toThrow();
    expect(() => exportRows(['a'], [['x', 'y']])).toThrow();
  });
});
