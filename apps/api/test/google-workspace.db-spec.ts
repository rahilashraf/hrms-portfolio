import { generateKeyPairSync } from 'node:crypto';
import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service.js';
import { verifyDocumentReferences } from '../src/documents/documents-jobs.js';
import { GoogleApiError } from '../src/integrations/google/google-api.client.js';
import { CredentialCipher } from '../src/integrations/google/google-credential-cipher.js';
import { decryptCredential } from '../src/integrations/google/google-token.provider.js';
import { sha256Hex } from '../src/integrations/google/google-workspace-domain.js';
import { runGoogleSyncFormsJob } from '../src/integrations/google/google-workspace-jobs.js';
import { NotificationTransportError } from '../src/notifications/notification-email.transport.js';
import { syncPerformanceEvidence } from '../src/performance/performance-jobs.js';
import {
  documentServices,
  FixedDocumentsClock,
} from './support/documents-fixtures.js';
import {
  connectOAuth,
  FixedGoogleClock,
  formInfo,
  formResponse,
  GOOGLE_USERS,
  googleTestServices,
  OAUTH,
  testCipher,
  type GoogleTestServices,
} from './support/google-fixtures.js';
import { RecordingTransport } from './support/notifications-fixtures.js';
import {
  activeTemplate,
  FixedOnboardingClock,
  onboardingServices,
} from './support/onboarding-fixtures.js';
import { failure } from './support/performance-fixtures.js';
import {
  FixedRecruitmentClock,
  openOpening,
  recruitmentServices,
  vacantPosition,
} from './support/recruitment-fixtures.js';
import {
  cleanupSchedulingFixtures,
  createSchedulingFixtures,
  ctx,
  rejection,
  rollbackClient,
  violation,
  type SchedulingFixtures,
  type Tx,
} from './support/scheduling-fixtures.js';

config({ path: '../../.env' });

class RollbackFixtures extends Error {}

const MINUTE = 60_000;

async function oauthFailure(promise: Promise<unknown>) {
  const error = (await rejection(promise)) as {
    code?: string;
    status?: number;
  };
  return error.code;
}

async function emailOf(tx: Tx, userId: string) {
  return (await tx.user.findUniqueOrThrow({ where: { id: userId } })).email;
}

function serviceAccountKey() {
  const privateKey = generateKeyPairSync('rsa', {
    modulusLength: 2048,
  }).privateKey.export({
    type: 'pkcs8',
    format: 'pem',
  }) as string;
  return JSON.stringify({
    type: 'service_account',
    project_id: 'hrms-test-project',
    private_key_id: 'key0123456789',
    private_key: privateKey,
    client_email: 'hrms-sync@hrms-test-project.iam.gserviceaccount.com',
    client_id: '109876543210',
    auth_uri: 'https://accounts.google.com/o/oauth2/auth',
    token_uri: 'https://oauth2.googleapis.com/token',
  });
}

const EMPTY_MAPPING = { schemaVersion: 1, fields: [] };

describe('Google Workspace integration (database)', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService(process.env.DATABASE_URL!);
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  async function scenario(
    run: (
      tx: Tx,
      fx: SchedulingFixtures,
      svc: GoogleTestServices,
      clock: FixedGoogleClock,
    ) => Promise<void>,
  ) {
    await expect(
      prisma.$transaction(
        async (tx) => {
          const fx = await createSchedulingFixtures(tx, GOOGLE_USERS);
          const clock = new FixedGoogleClock();
          const svc = googleTestServices(rollbackClient(tx), clock);
          await run(tx, fx, svc, clock).catch((error: unknown) => {
            console.error('SCENARIO FAILURE', error);
            throw error;
          });
          throw new RollbackFixtures();
        },
        { timeout: 120_000 },
      ),
    ).rejects.toBeInstanceOf(RollbackFixtures);
  }

  it('connects through OAuth with a hashed, single-use, user-bound state and encrypted refresh token', async () => {
    await scenario(async (tx, fx, svc, clock) => {
      const admin = fx.users.googleAdmin!;
      const client = rollbackClient(tx);
      // Deployment not configured: 503 before anything else.
      const noOauth = googleTestServices(client, clock, { oauth: null });
      expect(
        await failure(
          noOauth.connections.startOAuth(
            { organizationId: fx.orgA, capabilities: ['FORMS'] },
            ctx(admin),
          ),
        ),
      ).toEqual({ status: 503, code: 'GOOGLE_OAUTH_NOT_CONFIGURED' });
      const noKey = googleTestServices(client, clock, {
        cipher: new CredentialCipher(null),
      });
      expect(
        await failure(
          noKey.connections.startOAuth(
            { organizationId: fx.orgA, capabilities: ['FORMS'] },
            ctx(admin),
          ),
        ),
      ).toEqual({ status: 503, code: 'INTEGRATION_ENCRYPTION_NOT_CONFIGURED' });
      // Organization-level permission only; read does not manage; domain admins hold nothing here.
      for (const user of [
        'googleReader',
        'teamGoogle',
        'orgBGoogle',
        'hr',
        'outsider',
      ]) {
        expect(
          await failure(
            svc.connections.startOAuth(
              { organizationId: fx.orgA, capabilities: ['FORMS'] },
              ctx(fx.users[user]!),
            ),
          ),
        ).toMatchObject({ status: 403 });
      }
      for (const user of ['teamGoogle', 'hr', 'outsider', 'orgBGoogle']) {
        expect(
          await failure(svc.connections.status(fx.users[user]!, fx.orgA)),
        ).toMatchObject({
          status: 403,
        });
      }
      expect(
        await svc.connections.status(fx.users.googleReader!, fx.orgA),
      ).toMatchObject({
        canManage: false,
        connection: null,
        oauthConfigured: true,
        encryptionConfigured: true,
        strategies: {
          OAUTH: { default: true, requiresDomainWideDelegation: false },
          SERVICE_ACCOUNT: {
            optional: true,
            requiresDomainWideDelegation: true,
          },
        },
      });
      expect(
        (await svc.access.organizations(fx.users.googleReader!)).items,
      ).toEqual([
        expect.objectContaining({
          id: fx.orgA,
          actions: { canRead: true, canManage: false },
        }),
      ]);
      expect((await svc.access.organizations(fx.users.hr!)).items).toEqual([]);

      const started = await svc.connections.startOAuth(
        { organizationId: fx.orgA, capabilities: ['GMAIL_SEND', 'FORMS'] },
        ctx(admin),
      );
      const url = new URL(started.authorizationUrl);
      const state = url.searchParams.get('state')!;
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
      expect(url.searchParams.get('scope')).toBe(
        'openid email https://www.googleapis.com/auth/forms.body.readonly https://www.googleapis.com/auth/forms.responses.readonly https://www.googleapis.com/auth/gmail.send',
      );
      const row = await tx.googleOAuthState.findFirstOrThrow({
        where: { organizationId: fx.orgA },
      });
      expect(row).toMatchObject({
        stateHash: sha256Hex(state),
        initiatedByUserId: admin,
        consumedAt: null,
        capabilities: ['FORMS', 'GMAIL_SEND'],
        expiresAt: new Date(clock.value.getTime() + 10 * MINUTE),
      });
      expect(JSON.stringify(row)).not.toContain(state);
      expect(JSON.stringify(row)).not.toContain(started.browserNonce);

      // Another user (even another admin of the organization) or another browser: refused.
      expect(
        await oauthFailure(
          svc.connections.completeOAuth(
            { state, code: 'c1' },
            { userId: fx.users.googleAdmin2! },
          ),
        ),
      ).toBe('OAUTH_STATE_OTHER_USER');
      expect(
        await oauthFailure(
          svc.connections.completeOAuth(
            { state, code: 'c1' },
            { browserNonce: 'other-browser' },
          ),
        ),
      ).toBe('OAUTH_STATE_OTHER_USER');
      expect(
        await oauthFailure(
          svc.connections.completeOAuth(
            { state: 'unknown-state-value-xyz', code: 'c1' },
            { userId: admin },
          ),
        ),
      ).toBe('OAUTH_STATE_INVALID');
      svc.fake.grantedScope = url.searchParams.get('scope');
      const connected = await svc.connections.completeOAuth(
        { state, code: 'c1' },
        { browserNonce: started.browserNonce },
      );
      svc.fake.grantedScope = null;
      expect(connected.organizationId).toBe(fx.orgA);
      // Single use.
      expect(
        await oauthFailure(
          svc.connections.completeOAuth(
            { state, code: 'c1' },
            { userId: admin },
          ),
        ),
      ).toBe('OAUTH_STATE_USED');
      const connection = await tx.googleWorkspaceConnection.findUniqueOrThrow({
        where: { id: connected.connectionId },
      });
      expect(connection).toMatchObject({
        mode: 'OAUTH',
        status: 'ACTIVE',
        workspaceDomain: 'school.example',
        accountEmail: 'admin@school.example',
        capabilities: ['FORMS', 'GMAIL_SEND'],
        credentialVersion: 1,
        connectedByUserId: admin,
      });
      expect(connection.grantedScopes).toContain(
        'https://www.googleapis.com/auth/gmail.send',
      );
      expect(connection.credentialCiphertext).not.toContain('fake-refresh-c1');
      expect(connection.credentialKeyId).toMatch(/^k-[0-9a-f]{16}$/);
      expect(decryptCredential(svc.cipher, connection)).toEqual({
        kind: 'OAUTH',
        refreshToken: 'fake-refresh-c1',
      });
      const status = await svc.connections.status(
        fx.users.googleReader!,
        fx.orgA,
      );
      expect(status.connection).toMatchObject({
        status: 'ACTIVE',
        credentialsAvailable: true,
      });
      expect(JSON.stringify(status)).not.toMatch(
        /fake-refresh|fake-access|v1\.|credentialCiphertext/,
      );

      // Expired state.
      const late = await svc.connections.startOAuth(
        { organizationId: fx.orgA, capabilities: ['FORMS'] },
        ctx(admin),
      );
      clock.advance(11 * MINUTE);
      expect(
        await oauthFailure(
          svc.connections.completeOAuth(
            {
              state: new URL(late.authorizationUrl).searchParams.get('state')!,
              code: 'c2',
            },
            { userId: admin },
          ),
        ),
      ).toBe('OAUTH_STATE_EXPIRED');
      // A consumer account (no hosted domain) is refused and its grant revoked.
      svc.fake.exchangeIdentity = {
        hd: undefined,
        email: 'someone@gmail.example',
      };
      expect(
        await oauthFailure(connectOAuth(svc, fx.orgA, admin, ['FORMS'], 'c3')),
      ).toBe('GOOGLE_WORKSPACE_ACCOUNT_REQUIRED');
      expect(svc.fake.revoked).toContain('fake-refresh-c3');
      // Another Workspace domain cannot replace the connection.
      svc.fake.exchangeIdentity = {
        hd: 'other.example',
        email: 'admin@other.example',
      };
      expect(
        await oauthFailure(connectOAuth(svc, fx.orgA, admin, ['FORMS'], 'c4')),
      ).toBe('GOOGLE_WORKSPACE_DOMAIN_MISMATCH');
      svc.fake.exchangeIdentity = {};
      // A denied consent consumes the state and connects nothing.
      const denied = await svc.connections.startOAuth(
        { organizationId: fx.orgA, capabilities: ['FORMS'] },
        ctx(admin),
      );
      expect(
        await oauthFailure(
          svc.connections.completeOAuth(
            {
              state: new URL(denied.authorizationUrl).searchParams.get(
                'state',
              )!,
              error: 'access_denied',
            },
            { userId: admin },
          ),
        ),
      ).toBe('OAUTH_DENIED');
      // Re-consent replaces the credentials of the same connection (new version and scopes).
      const again = await connectOAuth(
        svc,
        fx.orgA,
        admin,
        ['FORMS', 'DRIVE_METADATA'],
        'c5',
      );
      expect(again.connectionId).toBe(connected.connectionId);
      const updated = await tx.googleWorkspaceConnection.findUniqueOrThrow({
        where: { id: again.connectionId },
      });
      expect(updated).toMatchObject({
        credentialVersion: 2,
        capabilities: ['FORMS', 'DRIVE_METADATA'],
      });
      expect(decryptCredential(svc.cipher, updated)).toMatchObject({
        refreshToken: 'fake-refresh-c5',
      });
      // The old ciphertext cannot be replayed under the new version (bound associated data).
      expect(() =>
        decryptCredential(svc.cipher, {
          ...updated,
          credentialCiphertext: connection.credentialCiphertext,
        }),
      ).toThrow();

      // One current connection per organization (database guard).
      expect(
        await violation(tx, () =>
          tx.googleWorkspaceConnection.create({
            data: {
              organizationId: fx.orgA,
              mode: 'OAUTH',
              status: 'ACTIVE',
              capabilities: ['FORMS'],
              grantedScopes: [],
              credentialCiphertext: 'v1.x.y.z',
              credentialKeyId: 'k-0000000000000000',
            },
          }),
        ),
      ).toBeTruthy();
      // Only known scopes are ever recorded.
      expect(
        await violation(tx, () =>
          tx.googleWorkspaceConnection.update({
            where: { id: again.connectionId },
            data: { grantedScopes: ['https://www.googleapis.com/auth/drive'] },
          }),
        ),
      ).toBeTruthy();

      // Without the key (or with another key), the connection reports CREDENTIALS_UNAVAILABLE.
      const rotated = googleTestServices(client, clock, {
        cipher: testCipher(),
      });
      const unavailable = await rotated.connections.status(
        fx.users.googleReader!,
        fx.orgA,
      );
      expect(unavailable.connection).toMatchObject({
        status: 'CREDENTIALS_UNAVAILABLE',
        credentialsAvailable: false,
      });
      expect(
        await rotated.connections.healthCheck(fx.orgA, ctx(admin)),
      ).toMatchObject({
        result: 'CREDENTIALS_UNAVAILABLE',
      });
      expect(
        await svc.connections.healthCheck(fx.orgA, ctx(admin)),
      ).toMatchObject({
        result: 'ACTIVE',
        connection: { status: 'ACTIVE', lastHealthOk: true },
      });

      // Disconnect: revoke (best effort), wipe the ciphertext, keep the row.
      expect(
        await failure(
          svc.connections.disconnect(fx.orgA, ctx(fx.users.googleReader!)),
        ),
      ).toMatchObject({
        status: 403,
      });
      const disconnected = await svc.connections.disconnect(
        fx.orgA,
        ctx(admin),
      );
      expect(disconnected).toMatchObject({
        revoked: true,
        connection: { status: 'DISCONNECTED' },
      });
      expect(svc.fake.revoked).toContain('fake-refresh-c5');
      expect(
        await tx.googleWorkspaceConnection.findUniqueOrThrow({
          where: { id: again.connectionId },
        }),
      ).toMatchObject({
        status: 'DISCONNECTED',
        credentialCiphertext: null,
        credentialKeyId: null,
        disconnectedByUserId: admin,
      });
      expect(
        await failure(svc.connections.disconnect(fx.orgA, ctx(admin))),
      ).toMatchObject({
        status: 404,
        code: 'GOOGLE_CONNECTION_NOT_FOUND',
      });
      expect(
        await violation(tx, () =>
          tx.googleWorkspaceConnection.update({
            where: { id: again.connectionId },
            data: { status: 'ACTIVE' },
          }),
        ),
      ).toBeTruthy();
      const after = await svc.connections.status(admin, fx.orgA);
      expect(after.connection).toBeNull();
      expect(after.previousConnections).toHaveLength(1);
      // A new connection can follow.
      const reconnected = await connectOAuth(
        svc,
        fx.orgA,
        admin,
        ['FORMS'],
        'c6',
      );
      expect(reconnected.connectionId).not.toBe(again.connectionId);

      // Audit: identifiers, modes and scopes only — never tokens or keys.
      const audits = await tx.auditLog.findMany({
        where: { action: { startsWith: 'GOOGLE_' }, actorUserId: admin },
      });
      expect(audits.map((a) => a.action)).toEqual(
        expect.arrayContaining([
          'GOOGLE_OAUTH_STARTED',
          'GOOGLE_CONNECTION_CONNECTED',
          'GOOGLE_CONNECTION_CREDENTIALS_UPDATED',
          'GOOGLE_CONNECTION_DISCONNECTED',
        ]),
      );
      expect(JSON.stringify(audits)).not.toMatch(
        /fake-refresh|fake-access|v1\.|PRIVATE KEY/,
      );
    });
  });

  it('connects a service account (optional) keeping only the minimal key material, encrypted', async () => {
    await scenario(async (tx, fx, svc, clock) => {
      const admin = fx.users.googleAdmin!;
      const input = (overrides = {}) => ({
        organizationId: fx.orgA,
        keyJson: serviceAccountKey(),
        impersonatedUser: 'HR-Bot@School.example',
        capabilities: ['FORMS', 'DRIVE_METADATA'],
        ...overrides,
      });
      expect(
        await failure(
          googleTestServices(rollbackClient(tx), clock, {
            cipher: new CredentialCipher(null),
          }).connections.connectServiceAccount(input(), ctx(admin)),
        ),
      ).toEqual({ status: 503, code: 'INTEGRATION_ENCRYPTION_NOT_CONFIGURED' });
      expect(
        await failure(
          svc.connections.connectServiceAccount(
            input(),
            ctx(fx.users.googleReader!),
          ),
        ),
      ).toMatchObject({
        status: 403,
      });
      expect(
        await failure(
          svc.connections.connectServiceAccount(
            input({ keyJson: '{"type":"user"}' }),
            ctx(admin),
          ),
        ),
      ).toEqual({
        status: 400,
        code: 'SERVICE_ACCOUNT_KEY_TYPE',
      });
      svc.fake.jwtFailure = new GoogleApiError(
        'GOOGLE_AUTH_FAILED',
        false,
        401,
      );
      expect(
        await failure(
          svc.connections.connectServiceAccount(input(), ctx(admin)),
        ),
      ).toEqual({
        status: 400,
        code: 'GOOGLE_SERVICE_ACCOUNT_REJECTED',
      });
      svc.fake.jwtFailure = null;
      const key = input();
      const result = await svc.connections.connectServiceAccount(
        key,
        ctx(admin),
      );
      expect(result.connection).toMatchObject({
        mode: 'SERVICE_ACCOUNT',
        status: 'ACTIVE',
        workspaceDomain: 'school.example',
        accountEmail: 'hr-bot@school.example',
        serviceAccountEmail:
          'hrms-sync@hrms-test-project.iam.gserviceaccount.com',
        capabilities: ['FORMS', 'DRIVE_METADATA'],
      });
      expect(JSON.stringify(result)).not.toMatch(
        /PRIVATE KEY|key0123456789|hrms-test-project"/,
      );
      const row = await tx.googleWorkspaceConnection.findUniqueOrThrow({
        where: { id: result.connection!.id },
      });
      expect(row.credentialCiphertext).not.toContain('PRIVATE KEY');
      const stored = decryptCredential(svc.cipher, row);
      expect(Object.keys(stored).sort()).toEqual([
        'clientEmail',
        'kind',
        'privateKey',
        'privateKeyId',
      ]);
      // OAuth cannot silently replace it.
      expect(
        await failure(
          svc.connections.startOAuth(
            { organizationId: fx.orgA, capabilities: ['FORMS'] },
            ctx(admin),
          ),
        ),
      ).toEqual({ status: 409, code: 'GOOGLE_CONNECTION_MODE_CONFLICT' });
      expect(
        await svc.connections.healthCheck(fx.orgA, ctx(admin)),
      ).toMatchObject({ result: 'ACTIVE' });
      expect(
        await svc.connections.disconnect(fx.orgA, ctx(admin)),
      ).toMatchObject({ revoked: false });
    });
  });

  it('binds forms only to the organization’s own sources and forms readable through its own connection', async () => {
    await scenario(async (tx, fx, svc) => {
      const admin = ctx(fx.users.googleAdmin!);
      const formId = `perf-form-${fx.suffix}`;
      const source = await tx.performanceEvidenceSource.create({
        data: {
          organizationId: fx.orgA,
          code: 'COC-QUIZ',
          name: 'Code of Conduct quiz',
          provider: 'GOOGLE_FORMS',
          kind: 'ASSESSMENT',
          externalResourceId: formId,
        },
      });
      const orgBSource = await tx.performanceEvidenceSource.create({
        data: {
          organizationId: fx.orgB,
          code: 'COC-QUIZ',
          name: 'Code of Conduct quiz',
          provider: 'GOOGLE_FORMS',
          kind: 'ASSESSMENT',
          externalResourceId: formId,
        },
      });
      const binding = (overrides = {}) => ({
        organizationId: fx.orgA,
        formId,
        target: 'PERFORMANCE_EVIDENCE' as const,
        performanceSourceId: source.id,
        mapping: EMPTY_MAPPING,
        ...overrides,
      });
      // Not connected yet.
      expect(await failure(svc.bindings.create(binding(), admin))).toEqual({
        status: 409,
        code: 'GOOGLE_CONNECTION_REQUIRED',
      });
      await connectOAuth(svc, fx.orgA, fx.users.googleAdmin!, ['FORMS']);
      svc.fake.forms.set(formId, formInfo(formId, { title: 'CoC quiz 2026' }));
      expect(
        await failure(
          svc.bindings.create(binding(), ctx(fx.users.googleReader!)),
        ),
      ).toMatchObject({ status: 403 });
      expect(
        await failure(svc.bindings.create(binding(), ctx(fx.users.hr!))),
      ).toMatchObject({ status: 403 });
      // Another organization's source is not found (never revealed).
      expect(
        await failure(
          svc.bindings.create(
            binding({ performanceSourceId: orgBSource.id }),
            admin,
          ),
        ),
      ).toEqual({
        status: 404,
        code: 'GOOGLE_SOURCE_NOT_FOUND',
      });
      expect(
        await failure(
          svc.bindings.create(
            binding({ performanceSourceId: undefined }),
            admin,
          ),
        ),
      ).toEqual({
        status: 400,
        code: 'GOOGLE_BINDING_SOURCE_REQUIRED',
      });
      expect(
        await failure(
          svc.bindings.create(binding({ formId: 'another-form-123' }), admin),
        ),
      ).toEqual({
        status: 400,
        code: 'GOOGLE_SOURCE_FORM_MISMATCH',
      });
      expect(
        await failure(
          svc.bindings.create(
            binding({
              mapping: {
                schemaVersion: 1,
                fields: [{ questionId: 'nope', field: 'respondentEmail' }],
              },
            }),
            admin,
          ),
        ),
      ).toEqual({ status: 400, code: 'GOOGLE_MAPPING_UNKNOWN_QUESTION' });
      expect(
        await failure(
          svc.bindings.create(
            binding({
              mapping: {
                schemaVersion: 1,
                fields: [
                  { questionId: 'q-first', field: 'candidate.firstName' },
                ],
              },
            }),
            admin,
          ),
        ),
      ).toEqual({ status: 400, code: 'GOOGLE_MAPPING_FIELD' });
      svc.fake.forbiddenForms.add(formId);
      expect(await failure(svc.bindings.create(binding(), admin))).toEqual({
        status: 400,
        code: 'GOOGLE_FORM_NOT_ACCESSIBLE',
      });
      svc.fake.forbiddenForms.delete(formId);
      const created = await svc.bindings.create(binding(), admin);
      expect(created).toMatchObject({
        formTitle: 'CoC quiz 2026',
        target: 'PERFORMANCE_EVIDENCE',
        enabled: true,
        cursorSubmittedAt: null,
        mappingSchemaVersion: 1,
      });
      expect(await failure(svc.bindings.create(binding(), admin))).toEqual({
        status: 409,
        code: 'GOOGLE_FORM_ALREADY_BOUND',
      });
      // The database ties a binding to a source of its own organization.
      expect(
        await violation(tx, () =>
          tx.googleFormBinding.create({
            data: {
              organizationId: fx.orgA,
              formId: `other-form-${fx.suffix}`,
              target: 'PERFORMANCE_EVIDENCE',
              performanceSourceId: orgBSource.id,
              mapping: EMPTY_MAPPING,
              mappingSchemaVersion: 1,
            },
          }),
        ),
      ).toBeTruthy();
      // Another organization (with its own connection) cannot bind the same form.
      await connectOAuth(
        svc,
        fx.orgB,
        fx.users.orgBGoogle!,
        ['FORMS'],
        'org-b-code',
      );
      expect(
        await failure(
          svc.bindings.create(
            {
              organizationId: fx.orgB,
              formId,
              target: 'ONBOARDING_TASKS',
              mapping: EMPTY_MAPPING,
            },
            ctx(fx.users.orgBGoogle!),
          ),
        ),
      ).toEqual({ status: 409, code: 'GOOGLE_FORM_ALREADY_BOUND' });
      expect(
        await violation(tx, () =>
          tx.googleFormBinding.create({
            data: {
              organizationId: fx.orgB,
              formId,
              target: 'ONBOARDING_TASKS',
              mapping: EMPTY_MAPPING,
              mappingSchemaVersion: 1,
            },
          }),
        ),
      ).toBeTruthy();
      // Nor see, change or sync this organization's binding.
      expect(
        await failure(
          svc.bindings.update(
            created.id,
            { enabled: false },
            ctx(fx.users.orgBGoogle!),
          ),
        ),
      ).toMatchObject({
        status: 404,
      });
      expect(
        await failure(
          svc.sync.syncManually(created.id, ctx(fx.users.orgBGoogle!)),
        ),
      ).toMatchObject({
        status: 404,
      });
      expect(
        await failure(svc.bindings.list(fx.users.orgBGoogle!, fx.orgA)),
      ).toMatchObject({ status: 403 });
      expect(
        (await svc.bindings.list(fx.users.googleReader!, fx.orgA)).items,
      ).toHaveLength(1);
      expect(
        await failure(
          svc.bindings.update(
            created.id,
            { enabled: false },
            ctx(fx.users.googleReader!),
          ),
        ),
      ).toMatchObject({
        status: 403,
      });
      const sources = await svc.bindings.sources(
        fx.users.googleAdmin!,
        fx.orgA,
      );
      expect(sources.performanceSources).toEqual([
        {
          id: source.id,
          code: 'COC-QUIZ',
          name: 'Code of Conduct quiz',
          formId,
        },
      ]);
      // Update and archive (audited with a form-id hash, never the mapping content).
      const disabled = await svc.bindings.update(
        created.id,
        { enabled: false },
        admin,
      );
      expect(disabled.enabled).toBe(false);
      const archived = await svc.bindings.archive(created.id, admin);
      expect(archived.archivedAt).not.toBeNull();
      expect(
        await failure(
          svc.bindings.update(created.id, { enabled: true }, admin),
        ),
      ).toMatchObject({
        status: 409,
        code: 'GOOGLE_BINDING_ARCHIVED',
      });
      const audits = await tx.auditLog.findMany({
        where: {
          entityId: created.id,
          action: { startsWith: 'GOOGLE_FORM_BINDING_' },
        },
        orderBy: { occurredAt: 'asc' },
      });
      expect(audits.map((a) => a.action)).toEqual([
        'GOOGLE_FORM_BINDING_CREATED',
        'GOOGLE_FORM_BINDING_UPDATED',
        'GOOGLE_FORM_BINDING_ARCHIVED',
      ]);
      expect(JSON.stringify(audits)).not.toContain(formId);
      // The archived binding is frozen, and never deleted.
      expect(
        await violation(tx, () =>
          tx.googleFormBinding.update({
            where: { id: created.id },
            data: { enabled: true },
          }),
        ),
      ).toBeTruthy();
      expect(
        await violation(tx, () =>
          tx.googleFormBinding.delete({ where: { id: created.id } }),
        ),
      ).toBeTruthy();
    });
  });

  it('feeds performance evidence through the ingestion contract, advancing the cursor only on success', async () => {
    await scenario(async (tx, fx, svc, clock) => {
      const admin = ctx(fx.users.googleAdmin!);
      const formId = `perf-form-${fx.suffix}`;
      const source = await tx.performanceEvidenceSource.create({
        data: {
          organizationId: fx.orgA,
          code: 'COC-QUIZ',
          name: 'Code of Conduct quiz',
          provider: 'GOOGLE_FORMS',
          kind: 'ASSESSMENT',
          externalResourceId: formId,
          passThresholdPercent: '50',
        },
      });
      const connection = await connectOAuth(
        svc,
        fx.orgA,
        fx.users.googleAdmin!,
        ['FORMS'],
      );
      svc.fake.forms.set(formId, formInfo(formId, { title: 'CoC quiz 2026' }));
      const email1 = await emailOf(tx, fx.selfUser1);
      svc.fake.responses.set(formId, [
        formResponse('resp-a', '2026-10-06T09:00:00.000001Z', {
          respondentEmail: email1.toUpperCase(),
          totalScore: 8,
        }),
        formResponse('resp-b', '2026-10-06T09:05:00Z', {
          respondentEmail: 'unknown@example.com',
          totalScore: 4,
        }),
        formResponse('resp-c', '2026-10-06T09:10:00Z', {
          respondentEmail: email1,
          totalScore: 10,
        }),
      ]);
      const binding = await svc.bindings.create(
        {
          organizationId: fx.orgA,
          formId,
          target: 'PERFORMANCE_EVIDENCE',
          performanceSourceId: source.id,
          mapping: EMPTY_MAPPING,
        },
        admin,
      );
      expect(
        await failure(
          svc.sync.syncManually(binding.id, ctx(fx.users.googleReader!)),
        ),
      ).toMatchObject({
        status: 403,
      });
      const first = await svc.sync.syncManually(binding.id, admin);
      expect(first).toMatchObject({
        status: 'SUCCEEDED',
        fetched: 3,
        accepted: 3,
        duplicates: 0,
        rejected: 0,
        errorCode: null,
      });
      const evidence = await tx.performanceEvidence.findMany({
        where: { sourceId: source.id, supersededAt: null },
        orderBy: { externalResultId: 'asc' },
      });
      expect(
        evidence.map((e) => [
          e.externalResultId,
          e.employeeId,
          String(e.score),
          String(e.maxScore),
        ]),
      ).toEqual([
        ['resp-a', fx.employee1, '8', '20'],
        ['resp-c', fx.employee1, '10', '20'],
      ]);
      // The unmatched respondent waits in the performance intake queue (domain rule).
      expect(
        await tx.performanceEvidenceIntake.count({
          where: { sourceId: source.id },
        }),
      ).toBe(1);
      const afterFirst = await tx.googleFormBinding.findUniqueOrThrow({
        where: { id: binding.id },
      });
      expect(afterFirst).toMatchObject({
        cursorSubmittedAt: '2026-10-06T09:10:00.000000000Z',
        cursorResponseId: 'resp-c',
        consecutiveFailures: 0,
        lastErrorCode: null,
      });
      // Manual syncs are rate limited per binding.
      expect(await failure(svc.sync.syncManually(binding.id, admin))).toEqual({
        status: 429,
        code: 'GOOGLE_SYNC_TOO_FREQUENT',
      });
      clock.advance(2 * MINUTE);
      // Nothing new: the cursor filters what Google returns again.
      expect(await svc.sync.syncManually(binding.id, admin)).toMatchObject({
        status: 'SUCCEEDED',
        fetched: 0,
      });
      // An edited response comes back with its update time: a correction through the contract.
      svc.fake.responses.get(formId)![0] = formResponse(
        'resp-a',
        '2026-10-06T09:00:00.000001Z',
        {
          lastSubmittedTime: '2026-10-06T09:30:00Z',
          respondentEmail: email1,
          totalScore: 9,
        },
      );
      clock.advance(2 * MINUTE);
      expect(await svc.sync.syncManually(binding.id, admin)).toMatchObject({
        status: 'SUCCEEDED',
        fetched: 1,
        accepted: 1,
      });
      expect(
        (
          await tx.performanceEvidence.findFirstOrThrow({
            where: {
              sourceId: source.id,
              externalResultId: 'resp-a',
              supersededAt: null,
            },
          })
        ).score?.toString(),
      ).toBe('9');

      // A Google outage: run FAILED, cursor kept, exponential backoff for scheduled syncs.
      svc.fake.responses.get(formId)!.push(
        formResponse('resp-d', '2026-10-06T10:00:00Z', {
          respondentEmail: email1,
          totalScore: 7,
        }),
      );
      svc.fake.listFailure = new GoogleApiError(
        'GOOGLE_UNAVAILABLE',
        true,
        503,
      );
      clock.advance(2 * MINUTE);
      expect(await svc.sync.syncManually(binding.id, admin)).toMatchObject({
        status: 'FAILED',
        errorCode: 'GOOGLE_UNAVAILABLE',
        fetched: 0,
      });
      const failed = await tx.googleFormBinding.findUniqueOrThrow({
        where: { id: binding.id },
      });
      expect(failed).toMatchObject({
        cursorResponseId: 'resp-a',
        consecutiveFailures: 1,
        lastErrorCode: 'GOOGLE_UNAVAILABLE',
        nextSyncAfter: new Date(clock.value.getTime() + 15 * MINUTE),
      });
      svc.fake.listFailure = null;
      expect(await svc.sync.syncBinding(binding.id, 'SCHEDULED')).toEqual({
        status: 'SKIPPED',
        bindingId: binding.id,
        reason: 'BACKOFF',
      });
      clock.advance(16 * MINUTE);
      expect(await svc.sync.syncBinding(binding.id, 'SCHEDULED')).toMatchObject(
        {
          status: 'SUCCEEDED',
          fetched: 1,
          accepted: 1,
        },
      );
      expect(
        await tx.googleFormBinding.findUniqueOrThrow({
          where: { id: binding.id },
        }),
      ).toMatchObject({
        consecutiveFailures: 0,
        nextSyncAfter: null,
        cursorResponseId: 'resp-d',
      });

      // A domain refusal (archived source) fails the run and never advances the cursor.
      await tx.performanceEvidenceSource.update({
        where: { id: source.id },
        data: { archivedAt: clock.value },
      });
      svc.fake.responses.get(formId)!.push(
        formResponse('resp-e', '2026-10-06T11:00:00Z', {
          respondentEmail: email1,
          totalScore: 7,
        }),
      );
      clock.advance(2 * MINUTE);
      expect(await svc.sync.syncManually(binding.id, admin)).toMatchObject({
        status: 'FAILED',
        errorCode: 'PERFORMANCE_SOURCE_ARCHIVED',
      });
      expect(
        (
          await tx.googleFormBinding.findUniqueOrThrow({
            where: { id: binding.id },
          })
        ).cursorResponseId,
      ).toBe('resp-d');
      await tx.performanceEvidenceSource.update({
        where: { id: source.id },
        data: { archivedAt: null },
      });

      // Re-binding the form re-delivers every response: the contract's idempotency makes them no-ops.
      await svc.bindings.archive(binding.id, admin);
      const rebound = await svc.bindings.create(
        {
          organizationId: fx.orgA,
          formId,
          target: 'PERFORMANCE_EVIDENCE',
          performanceSourceId: source.id,
          mapping: EMPTY_MAPPING,
        },
        admin,
      );
      clock.advance(2 * MINUTE);
      const resynced = await svc.sync.syncManually(rebound.id, admin);
      expect(resynced).toMatchObject({
        status: 'SUCCEEDED',
        fetched: 5,
        rejected: 0,
      });
      // Only resp-e is new evidence; the others are the contract's no-ops (or the unmatched
      // respondent's queue entry, re-reported as pending).
      if (resynced.status === 'SKIPPED') throw new Error('unexpected skip');
      expect(resynced.duplicates).toBeGreaterThanOrEqual(3);
      expect(
        await tx.performanceEvidence.count({
          where: { sourceId: source.id, supersededAt: null },
        }),
      ).toBe(4);
      // The registered provider adapter also plugs into the existing domain job unchanged.
      const domainJob = await syncPerformanceEvidence(rollbackClient(tx), [
        svc.assessmentProvider,
      ]);
      expect(domainJob.failed.filter((f) => f.sourceId === source.id)).toEqual(
        [],
      );

      // A stale RUNNING run is reclaimed after its lease.
      clock.advance(2 * MINUTE);
      const stale = await tx.googleSyncRun.create({
        data: {
          organizationId: fx.orgA,
          bindingId: rebound.id,
          target: 'PERFORMANCE_EVIDENCE',
          trigger: 'SCHEDULED',
          status: 'RUNNING',
          startedAt: new Date(clock.value.getTime() - 60 * MINUTE),
          leaseExpiresAt: new Date(clock.value.getTime() - 30 * MINUTE),
        },
      });
      expect(await svc.sync.syncBinding(rebound.id, 'SCHEDULED')).toMatchObject(
        { status: 'SUCCEEDED' },
      );
      expect(
        await tx.googleSyncRun.findUniqueOrThrow({ where: { id: stale.id } }),
      ).toMatchObject({
        status: 'FAILED',
        errorCode: 'LEASE_EXPIRED',
      });
      // Runs are append-only and at most one runs per binding.
      expect(
        await violation(tx, () =>
          tx.googleSyncRun.update({
            where: { id: stale.id },
            data: { status: 'RUNNING', finishedAt: null },
          }),
        ),
      ).toBeTruthy();
      await tx.googleSyncRun.create({
        data: {
          organizationId: fx.orgA,
          bindingId: rebound.id,
          target: 'PERFORMANCE_EVIDENCE',
          trigger: 'SCHEDULED',
          status: 'RUNNING',
          startedAt: clock.value,
          leaseExpiresAt: new Date(clock.value.getTime() + MINUTE),
        },
      });
      expect(
        await violation(tx, () =>
          tx.googleSyncRun.create({
            data: {
              organizationId: fx.orgA,
              bindingId: rebound.id,
              target: 'PERFORMANCE_EVIDENCE',
              trigger: 'SCHEDULED',
              status: 'RUNNING',
              startedAt: clock.value,
              leaseExpiresAt: new Date(clock.value.getTime() + MINUTE),
            },
          }),
        ),
      ).toBeTruthy();
      expect(await failure(svc.sync.syncManually(rebound.id, admin))).toEqual({
        status: 409,
        code: 'GOOGLE_SYNC_IN_PROGRESS',
      });

      // Run log: counts and codes only, paginated, readable with integration.google.read.
      const runs = await svc.bindings.runs(fx.users.googleReader!, {
        organizationId: fx.orgA,
        bindingId: binding.id,
        limit: 2,
      });
      expect(runs.total).toBe(6);
      expect(runs.items).toHaveLength(2);
      expect(
        JSON.stringify(
          await svc.bindings.runs(fx.users.googleReader!, {
            organizationId: fx.orgA,
          }),
        ),
      ).not.toMatch(/@example\.com|resp-a/);

      // Refused credentials mark the connection ERROR: syncing stops until it is fixed.
      await tx.googleSyncRun.updateMany({
        where: { bindingId: rebound.id, status: 'RUNNING' },
        data: {
          status: 'FAILED',
          finishedAt: clock.value,
          errorCode: 'TEST_STOPPED',
        },
      });
      svc.tokens.forget(connection.connectionId);
      svc.fake.refreshFailure = new GoogleApiError(
        'GOOGLE_AUTH_REVOKED',
        false,
        400,
      );
      clock.advance(2 * MINUTE);
      expect(await svc.sync.syncManually(rebound.id, admin)).toMatchObject({
        status: 'FAILED',
        errorCode: 'GOOGLE_AUTH_REVOKED',
      });
      expect(
        await tx.googleWorkspaceConnection.findUniqueOrThrow({
          where: { id: connection.connectionId },
        }),
      ).toMatchObject({
        status: 'ERROR',
        lastErrorCode: 'GOOGLE_AUTH_REVOKED',
      });
      clock.advance(2 * MINUTE);
      expect(await failure(svc.sync.syncManually(rebound.id, admin))).toEqual({
        status: 409,
        code: 'GOOGLE_CONNECTION_REQUIRED',
      });
      expect(await svc.sync.syncBinding(rebound.id, 'SCHEDULED')).toMatchObject(
        {
          status: 'SKIPPED',
          reason: 'NOT_CONNECTED',
        },
      );
      svc.fake.refreshFailure = null;
      expect(await svc.connections.healthCheck(fx.orgA, admin)).toMatchObject({
        result: 'ACTIVE',
      });
    });
  });

  it('feeds recruitment applications through the intake contract', async () => {
    await scenario(async (tx, fx, svc) => {
      const recruitment = recruitmentServices(
        rollbackClient(tx),
        new FixedRecruitmentClock(),
      );
      await openOpening(recruitment, fx);
      const formId = `apply-form-${fx.suffix}`;
      const source = await recruitment.intake.createSource(
        {
          organizationId: fx.orgA,
          code: 'staff-form',
          name: 'Staff application',
          provider: 'GOOGLE_FORMS',
          externalResourceId: formId,
        },
        ctx(fx.users.hiringAdmin!),
      );
      await connectOAuth(svc, fx.orgA, fx.users.googleAdmin!, ['FORMS']);
      svc.fake.forms.set(formId, formInfo(formId));
      const binding = await svc.bindings.create(
        {
          organizationId: fx.orgA,
          formId,
          target: 'RECRUITMENT_INTAKE',
          recruitmentSourceId: source.id,
          mapping: {
            schemaVersion: 1,
            fields: [
              { questionId: 'q-first', field: 'candidate.firstName' },
              { questionId: 'q-last', field: 'candidate.lastName' },
              { questionId: 'q-opening', field: 'openingCode' },
              { questionId: 'q-why', field: 'answer', label: 'Motivation' },
              { questionId: 'q-cv', field: 'document.RESUME' },
            ],
          },
        },
        ctx(fx.users.googleAdmin!),
      );
      const answers = (first: string, last: string, opening: string) => ({
        'q-first': { texts: [first], files: [] },
        'q-last': { texts: [last], files: [] },
        'q-opening': { texts: [opening], files: [] },
        'q-why': { texts: ['I love teaching'], files: [] },
        'q-cv': {
          texts: [],
          files: [
            {
              fileId: 'drive-cv-0000001',
              fileName: 'cv.pdf',
              mimeType: 'application/pdf',
            },
          ],
        },
      });
      svc.fake.responses.set(formId, [
        formResponse('app-1', '2026-10-06T08:00:00Z', {
          respondentEmail: 'ada.form@example.com',
          answers: answers('Ada', 'Lovelace', 'REQ-TEACH-1'),
        }),
        formResponse('app-2', '2026-10-06T08:01:00Z', {
          respondentEmail: 'grace@example.com',
          answers: answers('Grace', 'Hopper', 'NO-SUCH-REQ'),
        }),
        formResponse('app-3', '2026-10-06T08:02:00Z', {
          respondentEmail: 'x@example.com',
          answers: answers('', 'Nameless', 'REQ-TEACH-1'),
        }),
      ]);
      expect(
        await svc.sync.syncManually(binding.id, ctx(fx.users.googleAdmin!)),
      ).toMatchObject({
        status: 'SUCCEEDED',
        fetched: 3,
        accepted: 2,
        rejected: 1,
      });
      const submissions = await tx.recruitmentIntakeSubmission.findMany({
        where: { sourceId: source.id },
        orderBy: { externalResponseId: 'asc' },
      });
      expect(submissions.map((s) => [s.externalResponseId, s.status])).toEqual([
        ['app-1', 'APPLIED'],
        ['app-2', 'PENDING_OPENING'],
      ]);
      const application = await tx.recruitmentApplication.findFirstOrThrow({
        where: { candidate: { email: 'ada.form@example.com' } },
        include: { documents: true },
      });
      expect(
        application.documents.map((d) => [d.provider, d.externalFileId]),
      ).toEqual([['GOOGLE_DRIVE', 'drive-cv-0000001']]);
    });
  });

  it('completes onboarding Google Form tasks through the task completion contract', async () => {
    await scenario(async (tx, fx, svc) => {
      const onboarding = onboardingServices(
        rollbackClient(tx),
        new FixedOnboardingClock(),
      );
      await activeTemplate(onboarding, fx);
      const position = await vacantPosition(tx, fx, { team: true });
      const assignment = await tx.employmentAssignment.create({
        data: {
          employeeId: fx.employee1,
          positionId: position,
          employmentType: 'FULL_TIME',
          status: 'PLANNED',
          startDate: new Date('2026-04-01T00:00:00.000Z'),
          managerAssignmentId: fx.otherTeamA,
        },
      });
      await onboarding.workflows.start(
        'ONBOARDING',
        { employmentAssignmentId: assignment.id },
        ctx(fx.users.onboardingHr!),
      );
      // The template's Code of Conduct task references this form id.
      const formId = 'coc-form-1';
      await connectOAuth(svc, fx.orgA, fx.users.googleAdmin!, ['FORMS']);
      svc.fake.forms.set(
        formId,
        formInfo(formId, { emailCollection: 'DO_NOT_COLLECT' }),
      );
      expect(
        await failure(
          svc.bindings.create(
            {
              organizationId: fx.orgA,
              formId,
              target: 'ONBOARDING_TASKS',
              mapping: EMPTY_MAPPING,
            },
            ctx(fx.users.googleAdmin!),
          ),
        ),
      ).toEqual({ status: 400, code: 'GOOGLE_FORM_EMAIL_NOT_VERIFIED' });
      svc.fake.forms.set(formId, formInfo(formId));
      const binding = await svc.bindings.create(
        {
          organizationId: fx.orgA,
          formId,
          target: 'ONBOARDING_TASKS',
          mapping: EMPTY_MAPPING,
        },
        ctx(fx.users.googleAdmin!),
      );
      const email1 = await emailOf(tx, fx.selfUser1);
      svc.fake.responses.set(formId, [
        formResponse('ob-1', '2026-10-06T08:00:00Z', {
          respondentEmail: email1,
        }),
        formResponse('ob-2', '2026-10-06T08:01:00Z', {
          respondentEmail: 'stranger@example.com',
        }),
        formResponse('ob-3', '2026-10-06T08:02:00Z', { respondentEmail: null }),
      ]);
      expect(
        await svc.sync.syncManually(binding.id, ctx(fx.users.googleAdmin!)),
      ).toMatchObject({
        status: 'SUCCEEDED',
        fetched: 3,
        accepted: 1,
        rejected: 2,
      });
      const task = await tx.employeeWorkflowTask.findFirstOrThrow({
        where: {
          referenceType: 'GOOGLE_FORM',
          referenceExternalId: formId,
          workflow: { employmentAssignmentId: assignment.id },
        },
      });
      expect(task).toMatchObject({
        status: 'COMPLETED',
        completionSource: 'EXTERNAL',
        externalCompletionId: 'ob-1',
      });
    });
  });

  it('verifies Google Drive document references with the document organization’s connection only', async () => {
    await scenario(async (tx, fx, svc) => {
      const documents = documentServices(
        rollbackClient(tx),
        new FixedDocumentsClock(),
      );
      const { items } = await documents.types.initializeDefaults(
        fx.orgA,
        ctx(fx.users.typeAdmin!),
      );
      const typeId = items.find((t) => t.code === 'CERTIFICATION')!.id;
      const record = async (fileId: string) =>
        documents.documents.create(
          {
            organizationId: fx.orgA,
            employeeId: fx.employee2,
            typeId,
            title: `Certificate ${fileId}`,
            version: {
              provider: 'GOOGLE_DRIVE',
              externalFileId: fileId,
              fileName: 'c.pdf',
              mimeType: 'application/pdf',
              expiresOn: '2027-06-30',
            },
          },
          ctx(fx.users.hrRecords!),
        );
      const ok = await record('drive-ok-0000001');
      const trashed = await record('drive-gone-000001');
      const denied = await record('drive-denied-0001');
      const missing = await record('drive-missing-001');
      const versionOf = async (documentId: string) =>
        tx.employeeDocumentVersion.findFirstOrThrow({
          where: { documentId, supersededAt: null },
        });
      // Not connected: references are skipped and stay UNKNOWN.
      await verifyDocumentReferences(rollbackClient(tx), [svc.drive]);
      expect((await versionOf(ok.id)).referenceStatus).toBe('UNKNOWN');
      await connectOAuth(svc, fx.orgA, fx.users.googleAdmin!, [
        'DRIVE_METADATA',
      ]);
      const file = (id: string, trashedFlag = false) => ({
        id,
        name: 'c.pdf',
        mimeType: 'application/pdf',
        trashed: trashedFlag,
        modifiedTime: '2026-10-01T00:00:00Z',
      });
      svc.fake.driveFiles.set('drive-ok-0000001', file('drive-ok-0000001'));
      svc.fake.driveFiles.set(
        'drive-gone-000001',
        file('drive-gone-000001', true),
      );
      svc.fake.driveFiles.set('drive-denied-0001', 'FORBIDDEN');
      const outcome = await verifyDocumentReferences(rollbackClient(tx), [
        svc.drive,
      ]);
      expect(outcome.failed).toEqual([]);
      expect([
        (await versionOf(ok.id)).referenceStatus,
        (await versionOf(trashed.id)).referenceStatus,
        (await versionOf(denied.id)).referenceStatus,
        (await versionOf(missing.id)).referenceStatus,
      ]).toEqual(['OK', 'MISSING', 'ACCESS_DENIED', 'MISSING']);
      expect(svc.fake.calls.filter((c) => c.startsWith('drive:'))).toHaveLength(
        4,
      );
    });
  });

  it('routes notification email through Gmail per organization, else the default transport', async () => {
    await scenario(async (tx, fx, svc) => {
      await connectOAuth(svc, fx.orgA, fx.users.googleAdmin!, ['GMAIL_SEND']);
      const fallback = new RecordingTransport();
      const transport = svc.emailTransport(fallback);
      const message = (
        organizationId: string,
        to = 'staff@school.example',
      ) => ({
        to,
        subject: 'Your review is due',
        text: 'Open the HRMS to complete it.',
        notificationId: '00000000-0000-4000-8000-000000000001',
        recipientUserId: fx.selfUser1,
        organizationId,
      });
      expect(await transport.send(message(fx.orgA))).toEqual({
        providerReference: 'gmail:gmail-1',
      });
      const raw = Buffer.from(
        svc.fake.sentMail[0]!.raw,
        'base64url',
      ).toString();
      expect(raw).toContain(
        'From: admin@school.example\r\nTo: staff@school.example\r\n',
      );
      expect(fallback.sent).toHaveLength(0);
      // Organization B has no connection: the default transport.
      expect(await transport.send(message(fx.orgB))).toEqual({
        providerReference: 'test:test-00000000-0000-4000-8000-000000000001',
      });
      expect(fallback.sent).toHaveLength(1);
      // Header injection is a permanent failure; Gmail rate limits are retryable.
      const injected = (await rejection(
        transport.send(
          message(fx.orgA, 'staff@school.example\r\nBcc: x@evil.example'),
        ),
      )) as NotificationTransportError;
      expect(injected).toMatchObject({
        code: 'EMAIL_ADDRESS_INVALID',
        retryable: false,
      });
      svc.fake.gmailFailure = new GoogleApiError(
        'GOOGLE_RATE_LIMITED',
        true,
        429,
      );
      expect(await rejection(transport.send(message(fx.orgA)))).toMatchObject({
        code: 'GOOGLE_RATE_LIMITED',
        retryable: true,
      });
      svc.fake.gmailFailure = null;
      // A connection without the Gmail capability falls back.
      await connectOAuth(
        svc,
        fx.orgB,
        fx.users.orgBGoogle!,
        ['FORMS'],
        'org-b-code',
      );
      await transport.send(message(fx.orgB));
      expect(fallback.sent).toHaveLength(2);
      expect(svc.fake.sentMail).toHaveLength(1);
    });
  });

  it('exports rows to a new spreadsheet only through a connection with the Sheets capability', async () => {
    await scenario(async (tx, fx, svc) => {
      await connectOAuth(svc, fx.orgA, fx.users.googleAdmin!, [
        'SHEETS_EXPORT',
      ]);
      const exported = await svc.sheets.export(fx.orgA, {
        title: 'Headcount\r\nexport',
        header: ['Department', 'Headcount'],
        rows: [
          ['Dept A', 3],
          ['=IMPORTXML("x")', 1],
        ],
      });
      expect(exported.rows).toBe(3);
      expect(svc.fake.spreadsheets[0]).toMatchObject({
        title: 'Headcount export',
        rows: [
          ['Department', 'Headcount'],
          ['Dept A', 3],
          ['=IMPORTXML("x")', 1],
        ],
      });
      expect(
        await rejection(
          svc.sheets.export(fx.orgB, { title: 'x', header: ['a'], rows: [] }),
        ),
      ).toMatchObject({
        code: 'GOOGLE_NOT_CONNECTED',
      });
    });
  });

  it('runs the scheduled sweep and health check jobs', async () => {
    await scenario(async (tx, fx, svc, clock) => {
      await expect(runGoogleSyncFormsJob({ unexpected: true })).rejects.toThrow(
        /takes no parameters/,
      );
      const formId = `sweep-form-${fx.suffix}`;
      await connectOAuth(svc, fx.orgA, fx.users.googleAdmin!, ['FORMS']);
      svc.fake.forms.set(formId, formInfo(formId));
      const binding = await svc.bindings.create(
        {
          organizationId: fx.orgA,
          formId,
          target: 'ONBOARDING_TASKS',
          mapping: EMPTY_MAPPING,
        },
        ctx(fx.users.googleAdmin!),
      );
      svc.fake.responses.set(formId, [
        formResponse('s-1', '2026-10-06T08:00:00Z', {
          respondentEmail: 'nobody@example.com',
        }),
      ]);
      const sweep = await svc.sync.syncDue();
      expect(sweep.errors).toEqual([]);
      expect(
        await tx.googleSyncRun.findFirstOrThrow({
          where: { bindingId: binding.id },
        }),
      ).toMatchObject({
        trigger: 'SCHEDULED',
        status: 'SUCCEEDED',
        fetched: 1,
        rejected: 1,
      });
      const health = await svc.connections.checkAll();
      expect(health.checked).toBeGreaterThanOrEqual(1);
      expect(
        await tx.googleWorkspaceConnection.findFirstOrThrow({
          where: { organizationId: fx.orgA },
        }),
      ).toMatchObject({
        status: 'ACTIVE',
        lastHealthOk: true,
        lastHealthCheckAt: clock.value,
      });
    });
  });
});

describe('Google Workspace integration concurrency (committed data)', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService(process.env.DATABASE_URL!);
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it('lets concurrent manual syncs of one binding create a single run', async () => {
    const fx = await prisma.$transaction(
      (tx) => createSchedulingFixtures(tx, GOOGLE_USERS),
      {
        timeout: 60_000,
      },
    );
    try {
      const clock = new FixedGoogleClock();
      const svc = googleTestServices(prisma, clock);
      const formId = `race-form-${fx.suffix}`;
      await connectOAuth(svc, fx.orgA, fx.users.googleAdmin!, ['FORMS']);
      svc.fake.forms.set(formId, formInfo(formId));
      const binding = await svc.bindings.create(
        {
          organizationId: fx.orgA,
          formId,
          target: 'ONBOARDING_TASKS',
          mapping: EMPTY_MAPPING,
        },
        ctx(fx.users.googleAdmin!),
      );
      svc.fake.responses.set(formId, [
        formResponse('race-1', '2026-10-06T08:00:00Z', {
          respondentEmail: 'n@example.com',
        }),
      ]);
      svc.fake.listDelayMs = 300;
      const results = await Promise.allSettled([
        svc.sync.syncManually(binding.id, ctx(fx.users.googleAdmin!)),
        svc.sync.syncManually(binding.id, ctx(fx.users.googleAdmin2!)),
        svc.sync.syncManually(binding.id, ctx(fx.users.googleAdmin!)),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      for (const result of results.filter((r) => r.status === 'rejected')) {
        const status = (
          (result as PromiseRejectedResult).reason as { getStatus(): number }
        ).getStatus();
        expect([409, 429]).toContain(status);
      }
      expect(
        await prisma.googleSyncRun.count({ where: { bindingId: binding.id } }),
      ).toBe(1);
      expect(
        await prisma.googleSyncRun.findFirstOrThrow({
          where: { bindingId: binding.id },
        }),
      ).toMatchObject({
        status: 'SUCCEEDED',
      });
      expect(OAUTH.clientId).toBeTruthy();
    } finally {
      await cleanupSchedulingFixtures(prisma, fx);
    }
  });
});
