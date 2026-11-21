import { CredentialCipher } from './google-credential-cipher.js';
import {
  GoogleConnectionService,
  OAUTH_CALLBACK_COOKIE,
  OAuthCompletionError,
} from './google-connection.service.js';
import {
  GoogleOAuthCallbackController,
  GoogleWorkspaceController,
} from './google-workspace.controller.js';
import type { GoogleWorkspaceSettings } from './google-workspace-common.js';

const settings: GoogleWorkspaceSettings = {
  oauth: {
    clientId: 'client',
    clientSecret: 'secret',
    redirectUri: 'https://api.example.test/integrations/google/oauth/callback',
  },
  webOrigin: 'https://hr.example.test',
  production: true,
};

function connections(complete: GoogleConnectionService['completeOAuth']) {
  const real = new GoogleConnectionService(
    null as never,
    null as never,
    null as never,
    null as never,
    new CredentialCipher(null),
    null as never,
    null as never,
    settings,
  );
  return Object.assign(real, { completeOAuth: vi.fn(complete) });
}

function response() {
  return {
    cookie: vi.fn(),
    clearCookie: vi.fn(),
    redirect: vi.fn(),
  };
}

const request = (cookies: Record<string, string> = {}) =>
  ({
    cookies,
    ip: '127.0.0.1',
    get: () => undefined,
  }) as never;

describe('Google OAuth callback', () => {
  it('completes with the browser-binding cookie and redirects to the web origin only', async () => {
    const service = connections(async () => ({
      organizationId: '00000000-0000-4000-8000-000000000001',
      connectionId: 'c',
    }));
    const controller = new GoogleOAuthCallbackController(service, settings);
    const res = response();
    await controller.callback(
      {
        state: 'state-value',
        code: 'code-value',
        scope: 'openid',
        authuser: '0',
        redirect: 'https://evil.example',
      },
      request({ [OAUTH_CALLBACK_COOKIE]: 'nonce-1' }),
      res as never,
    );
    expect(service.completeOAuth).toHaveBeenCalledWith(
      { state: 'state-value', code: 'code-value', error: null },
      { browserNonce: 'nonce-1' },
      expect.objectContaining({ ipAddress: '127.0.0.1' }),
    );
    expect(res.clearCookie).toHaveBeenCalledWith(
      OAUTH_CALLBACK_COOKIE,
      expect.objectContaining({
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
      }),
    );
    expect(res.redirect).toHaveBeenCalledWith(
      302,
      'https://hr.example.test/settings/integrations/google?result=connected&organizationId=00000000-0000-4000-8000-000000000001',
    );
  });

  it('redirects failures with a safe code and never forwards tokens', async () => {
    const service = connections(async () => {
      throw new OAuthCompletionError('OAUTH_STATE_OTHER_USER');
    });
    const controller = new GoogleOAuthCallbackController(service, settings);
    const res = response();
    await controller.callback(
      { state: 'state-value', code: 'c' },
      request(),
      res as never,
    );
    expect(service.completeOAuth).toHaveBeenCalledWith(
      expect.anything(),
      { browserNonce: null },
      expect.anything(),
    );
    expect(res.redirect).toHaveBeenCalledWith(
      302,
      'https://hr.example.test/settings/integrations/google?result=error&code=OAUTH_STATE_OTHER_USER',
    );
    const missing = response();
    await controller.callback({}, request(), missing as never);
    expect(missing.redirect).toHaveBeenCalledWith(
      302,
      'https://hr.example.test/settings/integrations/google?result=error&code=OAUTH_STATE_INVALID',
    );
    const unexpected = connections(async () => {
      throw new Error('boom with refresh_token=abc');
    });
    const other = response();
    await new GoogleOAuthCallbackController(unexpected, settings).callback(
      { state: 's' },
      request(),
      other as never,
    );
    expect(other.redirect.mock.calls[0]![1]).toBe(
      'https://hr.example.test/settings/integrations/google?result=error&code=OAUTH_FAILED',
    );
  });

  it('sets an HttpOnly browser-binding cookie at start and returns only the URL', async () => {
    const connectionsStub = {
      startOAuth: vi.fn(async () => ({
        authorizationUrl:
          'https://accounts.google.com/o/oauth2/v2/auth?state=x',
        expiresAt: new Date('2026-10-06T10:10:00Z'),
        browserNonce: 'nonce-2',
      })),
    };
    const controller = new GoogleWorkspaceController(
      null as never,
      connectionsStub as never,
      null as never,
      null as never,
      settings,
    );
    const res = response();
    const body = await controller.startOAuth(
      { organizationId: 'o', capabilities: ['FORMS'] },
      { userId: 'u', sessionId: 's' },
      { ip: '127.0.0.1', get: () => undefined } as never,
      res as never,
    );
    expect(body).toEqual({
      authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=x',
      expiresAt: new Date('2026-10-06T10:10:00Z'),
    });
    expect(res.cookie).toHaveBeenCalledWith(
      OAUTH_CALLBACK_COOKIE,
      'nonce-2',
      expect.objectContaining({
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        path: '/integrations/google/oauth',
        maxAge: 600_000,
      }),
    );
  });
});
