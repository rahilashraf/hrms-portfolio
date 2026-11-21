import { HttpException, Logger } from '@nestjs/common';
import type { PrismaService } from '../database/prisma.service.js';
import type { GoogleApiClient } from '../integrations/google/google-api.client.js';
import type { GoogleWorkspaceRuntime } from '../integrations/google/google-workspace-runtime.js';
import type { AccountEmailService } from './account-email.service.js';
import {
  GoogleWorkspaceAccountEmailService,
  accountEmailContent,
} from './google-account-email.service.js';

const TOKEN = 'single-use-token-abc';
const ADDRESS = 'ada@example.com';
const message = (extra: object = {}) => ({
  email: ADDRESS,
  token: TOKEN,
  expiresAt: new Date('2026-10-15T12:00:00.000Z'),
  userId: 'user-1',
  ...extra,
});

const codeOf = (error: unknown) =>
  ((error as HttpException).getResponse() as { code?: string }).code;

function harness(options: {
  production: boolean;
  connectedOrganizations?: string[];
  employeeOrganizations?: string[];
  /** Organizations of the recipient's organization-scoped role assignments. */
  roleOrganizations?: string[];
  systemScope?: boolean;
  sendError?: Error;
}) {
  const connected = new Set(options.connectedOrganizations ?? []);
  const connectionFor = vi.fn(async (organizationId: string) =>
    connected.has(organizationId)
      ? {
          id: `conn-${organizationId}`,
          organizationId,
          accountEmail: 'hr@school.example',
        }
      : null,
  );
  const runtime = {
    connectionFor,
    call: vi.fn(
      async (
        _connection: unknown,
        _capability: string,
        run: (t: string) => unknown,
      ) => run('google-access-token'),
    ),
  } as unknown as GoogleWorkspaceRuntime;
  const sent: string[] = [];
  const sendGmailMessage = vi.fn(async (_token: string, raw: string) => {
    if (options.sendError) throw options.sendError;
    sent.push(raw);
    return { id: 'gmail-1' };
  });
  const api = { sendGmailMessage } as unknown as GoogleApiClient;
  const prisma = {
    user: {
      findUnique: vi.fn(async () => ({
        person: {
          employee: {
            assignments: (options.employeeOrganizations ?? []).map(
              (organizationId, index) => ({
                status: 'ACTIVE',
                startDate: new Date(Date.UTC(2026, 0, 1 + index)),
                position: { organizationId },
              }),
            ),
          },
        },
      })),
    },
    roleAssignment: {
      findMany: vi.fn(async () => [
        ...(options.roleOrganizations ?? []).map((organizationId) => ({
          scopeType: 'ORGANIZATION',
          organizationId,
        })),
        ...(options.systemScope
          ? [{ scopeType: 'SYSTEM', organizationId: null }]
          : []),
      ]),
    },
    googleWorkspaceConnection: {
      findMany: vi.fn(async () =>
        [...connected].map((organizationId) => ({ organizationId })),
      ),
    },
  } as unknown as PrismaService;
  const fallback = {
    assertAvailable: vi.fn(),
    sendInvitation: vi.fn(async () => undefined),
    sendPasswordReset: vi.fn(async () => undefined),
    sendVerification: vi.fn(async () => undefined),
  } as unknown as AccountEmailService & {
    sendInvitation: ReturnType<typeof vi.fn>;
  };
  const service = new GoogleWorkspaceAccountEmailService(
    prisma,
    runtime,
    api,
    fallback,
    {
      production: options.production,
      webOrigin: 'https://hr.example.org',
    },
  );
  return { service, connectionFor, sendGmailMessage, fallback, sent };
}

const decodeBody = (raw: string) => {
  const mime = Buffer.from(raw, 'base64url').toString('utf8');
  const body = mime.split('\r\n\r\n').slice(1).join('').replace(/\r\n/g, '');
  return Buffer.from(body, 'base64').toString('utf8');
};

describe('GoogleWorkspaceAccountEmailService', () => {
  afterEach(() => vi.restoreAllMocks());

  it('sends through the preferred organization Gmail with a fragment link and no token in headers', async () => {
    const { service, sent, connectionFor } = harness({
      production: true,
      connectedOrganizations: ['org-b'],
    });
    await service.sendInvitation(
      message({ organizationIds: ['org-a', 'org-b'] }),
    );
    expect(connectionFor).toHaveBeenCalledWith('org-a', 'GMAIL_SEND');
    expect(sent).toHaveLength(1);
    const mime = Buffer.from(sent[0]!, 'base64url').toString('utf8');
    expect(mime).toContain('From: hr@school.example');
    expect(mime).toContain(`To: ${ADDRESS}`);
    expect(mime.split('\r\n\r\n')[0]).not.toContain(TOKEN);
    expect(decodeBody(sent[0]!)).toContain(
      `https://hr.example.org/accept-invitation#token=${TOKEN}`,
    );
  });

  it("routes resets and verifications through the recipient's own employee organizations", async () => {
    const { service, sent, connectionFor } = harness({
      production: true,
      connectedOrganizations: ['org-2'],
      employeeOrganizations: ['org-1', 'org-2'],
    });
    await service.sendPasswordReset(message());
    await service.sendVerification(message());
    expect(sent).toHaveLength(2);
    expect(decodeBody(sent[0]!)).toContain('/reset-password#token=');
    expect(decodeBody(sent[1]!)).toContain('/verify-email#token=');
    // Current work first: the most recently started active assignment's organization.
    expect(connectionFor).toHaveBeenNthCalledWith(1, 'org-2', 'GMAIL_SEND');
  });

  it('fails clearly in production without a Gmail connection, and falls back in development', async () => {
    const production = harness({ production: true });
    await expect(production.service.assertAvailable()).rejects.toThrow(
      HttpException,
    );
    expect(
      codeOf(
        await production.service.sendInvitation(message()).catch((e) => e),
      ),
    ).toBe('ACCOUNT_EMAIL_UNAVAILABLE');

    const development = harness({ production: false });
    await expect(
      development.service.assertAvailable(),
    ).resolves.toBeUndefined();
    await development.service.sendInvitation(message());
    expect(development.fallback.sendInvitation).toHaveBeenCalledWith(message());
  });

  it('routes a user without employee assignments through their single role organization only', async () => {
    const { service, sent, connectionFor } = harness({
      production: true,
      connectedOrganizations: ['org-a', 'org-b'],
      roleOrganizations: ['org-b'],
    });
    await service.sendPasswordReset(message());
    expect(sent).toHaveLength(1);
    expect(connectionFor.mock.calls.map(([id]) => id)).toEqual(['org-b']);
  });

  it("never uses an unrelated organization's mailbox", async () => {
    const warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    // Org B (the user's) cannot send; Org A can but is unrelated.
    const { service, sent, connectionFor } = harness({
      production: true,
      connectedOrganizations: ['org-a'],
      roleOrganizations: ['org-b'],
    });
    expect(
      codeOf(await service.sendPasswordReset(message()).catch((e) => e)),
    ).toBe('ACCOUNT_EMAIL_UNAVAILABLE');
    expect(sent).toHaveLength(0);
    expect(connectionFor).not.toHaveBeenCalledWith('org-a', 'GMAIL_SEND');
    expect(String(warn.mock.calls[0]?.[0])).not.toContain(ADDRESS);

    // No employee record and no role at all: nothing to route through.
    const none = harness({
      production: true,
      connectedOrganizations: ['org-a'],
    });
    expect(
      codeOf(await none.service.sendVerification(message()).catch((e) => e)),
    ).toBe('ACCOUNT_EMAIL_UNAVAILABLE');
    expect(none.sent).toHaveLength(0);
  });

  it('refuses an ambiguous sender instead of choosing one', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const roles = harness({
      production: true,
      connectedOrganizations: ['org-a', 'org-b'],
      roleOrganizations: ['org-a', 'org-b'],
    });
    expect(
      codeOf(await roles.service.sendPasswordReset(message()).catch((e) => e)),
    ).toBe('ACCOUNT_EMAIL_UNAVAILABLE');
    expect(roles.sent).toHaveLength(0);

    const owner = harness({
      production: true,
      connectedOrganizations: ['org-a', 'org-b'],
      systemScope: true,
    });
    expect(
      codeOf(await owner.service.sendPasswordReset(message()).catch((e) => e)),
    ).toBe('ACCOUNT_EMAIL_UNAVAILABLE');
    expect(owner.sent).toHaveLength(0);
  });

  it('lets a System-scope owner use the single connected organization of the deployment', async () => {
    const { service, sent } = harness({
      production: true,
      connectedOrganizations: ['org-a'],
      systemScope: true,
    });
    await service.sendPasswordReset(message());
    expect(sent).toHaveLength(1);
  });

  it('keeps employee routing within the employee organizations even when another can send', async () => {
    const { service, sent, connectionFor } = harness({
      production: true,
      connectedOrganizations: ['org-other'],
      employeeOrganizations: ['org-1'],
      roleOrganizations: ['org-other'],
      systemScope: true,
    });
    expect(
      codeOf(await service.sendPasswordReset(message()).catch((e) => e)),
    ).toBe('ACCOUNT_EMAIL_UNAVAILABLE');
    expect(sent).toHaveLength(0);
    expect(connectionFor.mock.calls.map(([id]) => id)).toEqual(['org-1']);
  });

  it('reports a provider failure without logging the token, address or body', async () => {
    const warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const error = new Error('RATE_LIMITED');
    const { service } = harness({
      production: true,
      connectedOrganizations: ['org-1'],
      employeeOrganizations: ['org-1'],
      sendError: error,
    });
    expect(
      codeOf(await service.sendInvitation(message()).catch((e) => e)),
    ).toBe('ACCOUNT_EMAIL_DELIVERY_FAILED');
    const logged = warn.mock.calls.map((call) => String(call[0])).join('\n');
    expect(logged).toContain('RATE_LIMITED');
    expect(logged).not.toContain(TOKEN);
    expect(logged).not.toContain(ADDRESS);
  });

  it('refuses an address that cannot be a safe header', async () => {
    const { service, sendGmailMessage } = harness({
      production: true,
      connectedOrganizations: ['org-1'],
      employeeOrganizations: ['org-1'],
    });
    expect(
      codeOf(
        await service
          .sendInvitation(
            message({ email: 'evil@example.com\r\nBcc: x@example.com' }),
          )
          .catch((e) => e),
      ),
    ).toBe('ACCOUNT_EMAIL_DELIVERY_FAILED');
    expect(sendGmailMessage).not.toHaveBeenCalled();
  });

  it('writes plain, action-specific content that never contains a password', () => {
    const content = accountEmailContent(
      'invitation',
      'https://hr.example.org/accept-invitation#token=t',
      new Date('2026-10-15T12:00:00.000Z'),
    );
    expect(content.subject).toBe('Your HRMS account invitation');
    expect(content.text).toContain('Choose your own password');
    expect(content.text).toContain('2026-10-15 12:00 UTC');
    expect(content.text.toLowerCase()).not.toContain('temporary password');
  });
});
