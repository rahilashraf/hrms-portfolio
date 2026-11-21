import { randomBytes } from 'node:crypto';
import type { PrismaService } from '../../src/database/prisma.service.js';
import {
  GoogleApiError,
  type GoogleApiClient,
  type GoogleDriveFileMetadata,
  type GoogleTokenResponse,
} from '../../src/integrations/google/google-api.client.js';
import { CredentialCipher } from '../../src/integrations/google/google-credential-cipher.js';
import { GoogleWorkspaceClock } from '../../src/integrations/google/google-workspace-common.js';
import type {
  GoogleFormInfo,
  GoogleFormResponse,
} from '../../src/integrations/google/google-workspace-domain.js';
import { googleWorkspaceServices } from '../../src/integrations/google/google-workspace-jobs.js';
import { RECRUITMENT_USERS } from './recruitment-fixtures.js';
import type { UserSpec } from './scheduling-fixtures.js';
import { ctx } from './scheduling-fixtures.js';

export const GOOGLE_PERMISSION_KEYS = [
  'integration.google.manage',
  'integration.google.read',
] as const;

/** Users of Google Workspace specs: integration access never implies domain access. */
export const GOOGLE_USERS: Record<string, UserSpec[]> = {
  googleAdmin: [{ permissions: ['integration.google.manage'], scope: 'org' }],
  googleAdmin2: [{ permissions: ['integration.google.manage'], scope: 'org' }],
  googleReader: [{ permissions: ['integration.google.read'], scope: 'org' }],
  teamGoogle: [{ permissions: GOOGLE_PERMISSION_KEYS, scope: 'teamA' }],
  orgBGoogle: [{ permissions: ['integration.google.manage'], scope: 'orgB' }],
  /** Domain administrators with no integration grant. */
  hr: [
    {
      permissions: [
        'performance.evidence.manage',
        'recruitment.intake.manage',
        'onboarding.manage',
        'document.manage',
      ],
      scope: 'org',
    },
  ],
  hiringAdmin: RECRUITMENT_USERS.hiringAdmin!,
  recruiter: RECRUITMENT_USERS.recruiter!,
  templateAdmin: [
    { permissions: ['onboarding.template.manage'], scope: 'org' },
  ],
  onboardingHr: [
    { permissions: ['onboarding.read', 'onboarding.manage'], scope: 'org' },
  ],
  typeAdmin: [{ permissions: ['document.type.manage'], scope: 'org' }],
  hrRecords: [
    {
      permissions: [
        'document.read',
        'document.confidential.read',
        'document.manage',
      ],
      scope: 'org',
    },
  ],
  /** Owns specific-user onboarding tasks only. */
  // Works in Org A without any permission (a role with none): may own onboarding tasks.
  itDesk: [{ permissions: [], scope: 'org' }],
  outsider: [],
};

export const OAUTH = {
  clientId: 'test-client-id.apps.example',
  clientSecret: 'test-only-client-secret',
  redirectUri: 'https://api.example.test/integrations/google/oauth/callback',
};

export class FixedGoogleClock extends GoogleWorkspaceClock {
  value = new Date('2026-10-06T16:00:00.000Z');

  override now() {
    return this.value;
  }

  advance(ms: number) {
    this.value = new Date(this.value.getTime() + ms);
  }
}

/** An unsigned ID token as Google's token endpoint would return (claims only matter here). */
export function fakeIdToken(claims: Record<string, unknown>) {
  return [
    Buffer.from('{"alg":"RS256"}').toString('base64url'),
    Buffer.from(JSON.stringify(claims)).toString('base64url'),
    'sig',
  ].join('.');
}

/**
 * An in-memory Google: forms and responses per form id, Drive files, Gmail and Sheets
 * recorders, token behaviour. No network, no credentials: every token is a fake string.
 */
export class FakeGoogleApiClient implements GoogleApiClient {
  forms = new Map<string, GoogleFormInfo>();
  responses = new Map<string, GoogleFormResponse[]>();
  /** Form ids the connected account cannot read. */
  forbiddenForms = new Set<string>();
  driveFiles = new Map<string, GoogleDriveFileMetadata | 'FORBIDDEN'>();
  sentMail: Array<{ accessToken: string; raw: string }> = [];
  spreadsheets: Array<{ id: string; title: string; rows: unknown[][] }> = [];
  revoked: string[] = [];
  calls: string[] = [];
  refreshFailure: GoogleApiError | null = null;
  listFailure: GoogleApiError | null = null;
  listDelayMs = 0;
  exchangeIdentity: Record<string, unknown> = {};
  grantedScope: string | null = null;
  issueRefreshToken = true;
  jwtFailure: GoogleApiError | null = null;
  gmailFailure: GoogleApiError | null = null;
  private counter = 0;

  constructor(private readonly clock: { now(): Date }) {}

  private token(extra: Partial<GoogleTokenResponse> = {}): GoogleTokenResponse {
    this.counter += 1;
    return {
      accessToken: `fake-access-${this.counter}`,
      expiresInSeconds: 3600,
      refreshToken: null,
      scope: null,
      idToken: null,
      ...extra,
    };
  }

  async exchangeAuthorizationCode(input: {
    code: string;
    codeVerifier: string;
    clientId: string;
  }) {
    this.calls.push(`exchange:${input.code}`);
    if (input.code === 'bad-code')
      throw new GoogleApiError('GOOGLE_BAD_REQUEST', false, 400);
    const exp = Math.floor(this.clock.now().getTime() / 1000) + 3600;
    return this.token({
      refreshToken: this.issueRefreshToken
        ? `fake-refresh-${input.code}`
        : null,
      scope: this.grantedScope,
      idToken: fakeIdToken({
        iss: 'https://accounts.google.com',
        aud: input.clientId,
        exp,
        email: 'admin@school.example',
        email_verified: true,
        hd: 'school.example',
        ...this.exchangeIdentity,
      }),
    });
  }

  async refreshAccessToken(input: { refreshToken: string }) {
    this.calls.push('refresh');
    if (this.refreshFailure) throw this.refreshFailure;
    if (!input.refreshToken.startsWith('fake-refresh-'))
      throw new GoogleApiError('GOOGLE_AUTH_REVOKED', false, 400);
    return this.token();
  }

  async jwtBearerToken(assertion: string) {
    this.calls.push('jwt');
    if (this.jwtFailure) throw this.jwtFailure;
    if (assertion.split('.').length !== 3)
      throw new GoogleApiError('GOOGLE_BAD_REQUEST', false, 400);
    return this.token();
  }

  async revokeToken(token: string) {
    this.revoked.push(token);
  }

  async getForm(_accessToken: string, formId: string) {
    this.calls.push(`form:${formId}`);
    if (this.forbiddenForms.has(formId))
      throw new GoogleApiError('GOOGLE_FORBIDDEN', false, 403);
    const form = this.forms.get(formId);
    if (!form) throw new GoogleApiError('GOOGLE_NOT_FOUND', false, 404);
    return form;
  }

  async listFormResponses(
    _accessToken: string,
    formId: string,
    options: {
      filter: string | null;
      pageToken: string | null;
      pageSize: number;
    },
  ) {
    this.calls.push(
      `responses:${formId}:${options.filter ?? '-'}:${options.pageToken ?? '-'}`,
    );
    if (this.listDelayMs)
      await new Promise((r) => setTimeout(r, this.listDelayMs));
    if (this.listFailure) throw this.listFailure;
    let all = this.responses.get(formId) ?? [];
    const since = options.filter?.match(/^timestamp >= (.+)$/)?.[1];
    if (since)
      all = all.filter((r) => new Date(r.lastSubmittedTime) >= new Date(since));
    // Two-item pages, returned newest first: the reader must not rely on page order.
    const page = Number(options.pageToken ?? '0');
    const ordered = [...all].reverse();
    const slice = ordered.slice(page * 2, page * 2 + 2);
    return {
      responses: slice,
      nextPageToken: page * 2 + 2 < ordered.length ? String(page + 1) : null,
    };
  }

  async getDriveFile(_accessToken: string, fileId: string) {
    this.calls.push(`drive:${fileId}`);
    const file = this.driveFiles.get(fileId);
    if (file === 'FORBIDDEN')
      throw new GoogleApiError('GOOGLE_FORBIDDEN', false, 403);
    if (!file) throw new GoogleApiError('GOOGLE_NOT_FOUND', false, 404);
    return file;
  }

  async createSpreadsheet(_accessToken: string, title: string) {
    const id = `sheet-${randomBytes(8).toString('hex')}`;
    this.spreadsheets.push({ id, title, rows: [] });
    return { spreadsheetId: id };
  }

  async appendValues(
    _accessToken: string,
    spreadsheetId: string,
    _range: string,
    rows: ReadonlyArray<ReadonlyArray<string | number | boolean | null>>,
  ) {
    const sheet = this.spreadsheets.find((s) => s.id === spreadsheetId);
    if (!sheet) throw new GoogleApiError('GOOGLE_NOT_FOUND', false, 404);
    sheet.rows.push(...rows.map((row) => [...row]));
    return { updatedRows: rows.length };
  }

  async sendGmailMessage(accessToken: string, raw: string) {
    if (this.gmailFailure) throw this.gmailFailure;
    this.sentMail.push({ accessToken, raw });
    return { id: `gmail-${this.sentMail.length}` };
  }
}

export function testCipher() {
  return new CredentialCipher(randomBytes(32));
}

export function googleTestServices(
  prisma: PrismaService,
  clock: FixedGoogleClock,
  options: {
    api?: FakeGoogleApiClient;
    cipher?: CredentialCipher;
    oauth?: typeof OAUTH | null;
  } = {},
) {
  const api = options.api ?? new FakeGoogleApiClient(clock);
  const services = googleWorkspaceServices(prisma, {
    api,
    clock,
    cipher: options.cipher ?? testCipher(),
    settings: {
      oauth: options.oauth === undefined ? OAUTH : options.oauth,
      webOrigin: 'https://hr.example.test',
      production: false,
    },
  });
  return { ...services, fake: api };
}

export type GoogleTestServices = ReturnType<typeof googleTestServices>;

/** Connects an organization through the OAuth flow against the fake Google. */
export async function connectOAuth(
  svc: GoogleTestServices,
  organizationId: string,
  adminUserId: string,
  capabilities: string[] = [
    'FORMS',
    'DRIVE_METADATA',
    'GMAIL_SEND',
    'SHEETS_EXPORT',
  ],
  code = 'auth-code-1',
) {
  const started = await svc.connections.startOAuth(
    { organizationId, capabilities },
    ctx(adminUserId),
  );
  const state = new URL(started.authorizationUrl).searchParams.get('state')!;
  const scope = new URL(started.authorizationUrl).searchParams.get('scope')!;
  // Google grants what was requested (tests narrow it by setting grantedScope themselves).
  svc.fake.grantedScope = scope;
  try {
    const result = await svc.connections.completeOAuth(
      { state, code },
      { userId: adminUserId },
      ctx(adminUserId),
    );
    return { ...result, state, started };
  } finally {
    svc.fake.grantedScope = null;
  }
}

export function formInfo(
  formId: string,
  overrides: Partial<GoogleFormInfo> = {},
): GoogleFormInfo {
  return {
    formId,
    title: 'Staff form',
    emailCollection: 'VERIFIED',
    questions: [
      {
        questionId: 'q-first',
        title: 'First name',
        kind: 'TEXT',
        pointValue: null,
      },
      {
        questionId: 'q-last',
        title: 'Last name',
        kind: 'TEXT',
        pointValue: null,
      },
      {
        questionId: 'q-why',
        title: 'Why do you want to join?',
        kind: 'TEXT',
        pointValue: 10,
      },
      {
        questionId: 'q-opening',
        title: 'Requisition',
        kind: 'TEXT',
        pointValue: null,
      },
      {
        questionId: 'q-cv',
        title: 'Resume',
        kind: 'FILE_UPLOAD',
        pointValue: null,
      },
      { questionId: 'q-quiz', title: 'Quiz', kind: 'CHOICE', pointValue: 10 },
    ],
    ...overrides,
  };
}

export function formResponse(
  responseId: string,
  submittedAt: string,
  overrides: Partial<GoogleFormResponse> = {},
): GoogleFormResponse {
  return {
    responseId,
    createTime: submittedAt,
    lastSubmittedTime: submittedAt,
    respondentEmail: null,
    totalScore: null,
    answers: {},
    ...overrides,
  };
}
