import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthApiError } from '../auth/types';
import { googleWorkspaceApi } from './api';
import {
  GOOGLE_CAPABILITIES,
  isGoogleAuthorizationUrl,
  MAPPING_FIELDS,
  mappingFromRows,
  mappingRowsProblem,
  parseCallbackResult,
  rowsFromMapping,
} from './domain';
import {
  callbackErrorMessage,
  GOOGLE_WORKSPACE_ERROR_MESSAGES,
  googleCodeText,
  googleWorkspaceErrorCode,
  googleWorkspaceErrorMessage,
  isGoogleWorkspaceForbidden,
} from './errors';
import { browserNavigation, navigateToGoogleAuthorization } from './navigation';

const apiRequest = vi.hoisted(() => vi.fn());

vi.mock('../auth/api-client', () => ({ apiRequest }));

beforeEach(() => {
  apiRequest.mockClear();
  apiRequest.mockResolvedValue({});
});

const calls = () =>
  apiRequest.mock.calls.map((call) => [call[0], call[1]?.method ?? 'GET', call[1]?.body]);

const ORG = '11111111-1111-4111-8111-111111111111';

describe('googleWorkspaceApi', () => {
  it('maps the connection routes', async () => {
    await googleWorkspaceApi.organizations();
    await googleWorkspaceApi.status(ORG);
    await googleWorkspaceApi.startOAuth(ORG, ['FORMS', 'GMAIL_SEND']);
    await googleWorkspaceApi.connectServiceAccount({
      organizationId: ORG,
      keyJson: '{"type":"service_account"}',
      impersonatedUser: 'admin@example.com',
      capabilities: ['FORMS'],
    });
    await googleWorkspaceApi.disconnect(ORG);
    await googleWorkspaceApi.healthCheck(ORG);
    expect(calls()).toEqual([
      ['/integrations/google/organizations', 'GET', undefined],
      [`/integrations/google/status?organizationId=${ORG}`, 'GET', undefined],
      [
        '/integrations/google/oauth/start',
        'POST',
        JSON.stringify({ organizationId: ORG, capabilities: ['FORMS', 'GMAIL_SEND'] }),
      ],
      [
        '/integrations/google/service-account',
        'POST',
        JSON.stringify({
          organizationId: ORG,
          keyJson: '{"type":"service_account"}',
          impersonatedUser: 'admin@example.com',
          capabilities: ['FORMS'],
        }),
      ],
      ['/integrations/google/disconnect', 'POST', JSON.stringify({ organizationId: ORG })],
      ['/integrations/google/health-check', 'POST', JSON.stringify({ organizationId: ORG })],
    ]);
    // The OAuth start sets the browser-binding cookie, so it carries credentials.
    expect(apiRequest.mock.calls[2]![1].credentials).toBe('include');
  });

  it('maps the binding and sync routes', async () => {
    const mapping = {
      schemaVersion: 1 as const,
      fields: [{ questionId: 'q1', field: 'respondentEmail' }],
    };
    await googleWorkspaceApi.sources(ORG);
    await googleWorkspaceApi.bindings(ORG);
    await googleWorkspaceApi.bindings(ORG, true);
    await googleWorkspaceApi.createBinding({
      organizationId: ORG,
      formId: 'form-1234567890',
      target: 'ONBOARDING_TASKS',
      mapping,
      enabled: true,
    });
    await googleWorkspaceApi.updateBinding('b/1', { enabled: false });
    await googleWorkspaceApi.archiveBinding('b-1');
    await googleWorkspaceApi.syncBinding('b-1');
    await googleWorkspaceApi.syncRuns({ organizationId: ORG });
    await googleWorkspaceApi.syncRuns({
      organizationId: ORG,
      bindingId: 'b-1',
      limit: 10,
      offset: 20,
    });
    await googleWorkspaceApi.syncRuns({
      organizationId: ORG,
      bindingId: null,
      limit: 10,
      offset: 0,
    });
    expect(calls()).toEqual([
      [`/integrations/google/sources?organizationId=${ORG}`, 'GET', undefined],
      [`/integrations/google/bindings?organizationId=${ORG}`, 'GET', undefined],
      [
        `/integrations/google/bindings?organizationId=${ORG}&includeArchived=true`,
        'GET',
        undefined,
      ],
      [
        '/integrations/google/bindings',
        'POST',
        JSON.stringify({
          organizationId: ORG,
          formId: 'form-1234567890',
          target: 'ONBOARDING_TASKS',
          mapping,
          enabled: true,
        }),
      ],
      ['/integrations/google/bindings/b%2F1', 'PATCH', JSON.stringify({ enabled: false })],
      ['/integrations/google/bindings/b-1/archive', 'POST', undefined],
      ['/integrations/google/bindings/b-1/sync', 'POST', undefined],
      [`/integrations/google/sync-runs?organizationId=${ORG}`, 'GET', undefined],
      [
        `/integrations/google/sync-runs?organizationId=${ORG}&bindingId=b-1&limit=10&offset=20`,
        'GET',
        undefined,
      ],
      [`/integrations/google/sync-runs?organizationId=${ORG}&limit=10&offset=0`, 'GET', undefined],
    ]);
  });
});

describe('Google authorization navigation', () => {
  it('accepts only https://accounts.google.com URLs', () => {
    expect(isGoogleAuthorizationUrl('https://accounts.google.com/o/oauth2/v2/auth?x=1')).toBe(true);
    for (const value of [
      null,
      undefined,
      42,
      '',
      'not a url',
      'http://accounts.google.com/o/oauth2/v2/auth',
      'https://accounts.google.com.evil.example/o/oauth2',
      'https://evil.example/https://accounts.google.com',
      'https://accounts.google.com:8443/o/oauth2',
      'https://oauth2.googleapis.com/token',
      'javascript:alert(1)',
      '//accounts.google.com/o/oauth2',
      '/settings/integrations/google',
    ]) {
      expect(isGoogleAuthorizationUrl(value)).toBe(false);
    }
  });

  it('navigates only to Google', () => {
    const assign = vi.spyOn(browserNavigation, 'assign').mockImplementation(() => undefined);
    expect(navigateToGoogleAuthorization('https://evil.example/auth')).toBe(false);
    expect(assign).not.toHaveBeenCalled();
    expect(navigateToGoogleAuthorization('https://accounts.google.com/o/oauth2/v2/auth?s=1')).toBe(
      true,
    );
    expect(assign).toHaveBeenCalledWith('https://accounts.google.com/o/oauth2/v2/auth?s=1');
  });
});

describe('callback result', () => {
  it('parses connected and error results strictly', () => {
    expect(parseCallbackResult(`?result=connected&organizationId=${ORG}`)).toEqual({
      kind: 'connected',
      organizationId: ORG,
    });
    expect(parseCallbackResult('?result=connected&organizationId=<script>')).toEqual({
      kind: 'connected',
      organizationId: null,
    });
    expect(parseCallbackResult('?result=error&code=OAUTH_DENIED')).toEqual({
      kind: 'error',
      code: 'OAUTH_DENIED',
    });
    expect(parseCallbackResult('?result=error&code=<img src=x onerror=alert(1)>')).toEqual({
      kind: 'error',
      code: null,
    });
    expect(parseCallbackResult('')).toBeNull();
    expect(parseCallbackResult('?result=other')).toBeNull();
  });

  it('maps every callback code to friendly text and never echoes unknown codes', () => {
    for (const code of [
      'OAUTH_STATE_INVALID',
      'OAUTH_STATE_USED',
      'OAUTH_STATE_EXPIRED',
      'OAUTH_STATE_OTHER_USER',
      'OAUTH_STATE_UNBOUND',
      'OAUTH_DENIED',
      'OAUTH_FORBIDDEN',
      'OAUTH_EXCHANGE_FAILED',
      'OAUTH_IDENTITY_INVALID',
      'OAUTH_NO_REFRESH_TOKEN',
      'OAUTH_SCOPES_NOT_GRANTED',
      'OAUTH_FAILED',
      'GOOGLE_WORKSPACE_ACCOUNT_REQUIRED',
      'GOOGLE_WORKSPACE_DOMAIN_MISMATCH',
      'GOOGLE_CONNECTION_MODE_CONFLICT',
      'GOOGLE_OAUTH_NOT_CONFIGURED',
    ]) {
      expect(GOOGLE_WORKSPACE_ERROR_MESSAGES[code], code).toBeTruthy();
      expect(callbackErrorMessage(code)).toBe(GOOGLE_WORKSPACE_ERROR_MESSAGES[code]);
    }
    expect(callbackErrorMessage('SOMETHING_NEW')).not.toContain('SOMETHING_NEW');
    expect(callbackErrorMessage(null)).toContain('could not be completed');
  });
});

describe('errors', () => {
  const error = (status: number, code?: string, message?: string) =>
    new AuthApiError(
      status === 409 ? 'conflict' : status === 400 ? 'validation' : 'unexpected',
      status,
      message,
      code ? { code, message } : undefined,
    );

  it('covers every error code the API and the sync runs record', () => {
    for (const code of [
      'GOOGLE_OAUTH_NOT_CONFIGURED',
      'INTEGRATION_ENCRYPTION_NOT_CONFIGURED',
      'INTEGRATION_KEY_UNAVAILABLE',
      'INTEGRATION_CIPHERTEXT_INVALID',
      'GOOGLE_CAPABILITY_REQUIRED',
      'GOOGLE_IMPERSONATED_USER_INVALID',
      'SERVICE_ACCOUNT_KEY_NOT_JSON',
      'SERVICE_ACCOUNT_KEY_TYPE',
      'SERVICE_ACCOUNT_KEY_FIELDS',
      'SERVICE_ACCOUNT_KEY_TOKEN_URI',
      'SERVICE_ACCOUNT_KEY_PRIVATE_KEY',
      'GOOGLE_SERVICE_ACCOUNT_REJECTED',
      'GOOGLE_CONNECTION_NOT_FOUND',
      'GOOGLE_CONNECTION_CHANGED',
      'GOOGLE_CONNECTION_REQUIRED',
      'GOOGLE_NOT_CONNECTED',
      'GOOGLE_HEALTH_CHECK_FAILED',
      'GOOGLE_FORM_ID_INVALID',
      'GOOGLE_MAPPING_INVALID',
      'GOOGLE_MAPPING_VERSION',
      'GOOGLE_MAPPING_FIELD',
      'GOOGLE_MAPPING_DUPLICATE',
      'GOOGLE_MAPPING_REQUIRED',
      'GOOGLE_MAPPING_UNKNOWN_QUESTION',
      'GOOGLE_MAPPING_QUESTION_KIND',
      'GOOGLE_BINDING_SOURCE_NOT_ALLOWED',
      'GOOGLE_BINDING_SOURCE_REQUIRED',
      'GOOGLE_SOURCE_NOT_FOUND',
      'GOOGLE_SOURCE_ARCHIVED',
      'GOOGLE_SOURCE_PROVIDER',
      'GOOGLE_SOURCE_FORM_MISMATCH',
      'GOOGLE_FORM_ALREADY_BOUND',
      'GOOGLE_FORM_NOT_ACCESSIBLE',
      'GOOGLE_FORM_CHECK_FAILED',
      'GOOGLE_FORM_EMAIL_NOT_COLLECTED',
      'GOOGLE_FORM_TOO_MANY_RESPONSES',
      'GOOGLE_BINDING_NOT_FOUND',
      'GOOGLE_BINDING_ARCHIVED',
      'GOOGLE_BINDING_DISABLED',
      'GOOGLE_SYNC_IN_PROGRESS',
      'GOOGLE_SYNC_TOO_FREQUENT',
      'LEASE_EXPIRED',
      'DOMAIN_INGESTION_FAILED',
      'SYNC_INTERNAL_ERROR',
      'GOOGLE_RATE_LIMITED',
      'GOOGLE_UNAVAILABLE',
      'GOOGLE_NETWORK_ERROR',
      'GOOGLE_BAD_REQUEST',
      'GOOGLE_UNAUTHORIZED',
      'GOOGLE_FORBIDDEN',
      'GOOGLE_NOT_FOUND',
      'GOOGLE_AUTH_REVOKED',
      'GOOGLE_AUTH_FAILED',
      'GOOGLE_SCOPE_NOT_GRANTED',
      'GOOGLE_INVALID_RESPONSE',
      'GOOGLE_HTTP_ERROR',
    ]) {
      expect(GOOGLE_WORKSPACE_ERROR_MESSAGES[code], code).toBeTruthy();
      expect(googleCodeText(code)).toBe(GOOGLE_WORKSPACE_ERROR_MESSAGES[code]);
    }
    expect(googleCodeText(null)).toBeNull();
    expect(googleCodeText('UNKNOWN_CODE')).toBe('An error occurred.');
  });

  it('reads codes and builds friendly messages by status', () => {
    expect(googleWorkspaceErrorCode(error(409, 'GOOGLE_SYNC_IN_PROGRESS'))).toBe(
      'GOOGLE_SYNC_IN_PROGRESS',
    );
    // The client does not parse 429 bodies: the only 429 is the manual sync throttle.
    expect(googleWorkspaceErrorCode(new AuthApiError('rate-limited', 429))).toBe(
      'GOOGLE_SYNC_TOO_FREQUENT',
    );
    expect(googleWorkspaceErrorCode(new Error('x'))).toBeNull();
    expect(googleWorkspaceErrorMessage(new AuthApiError('rate-limited', 429))).toContain(
      'less than a minute ago',
    );
    expect(googleWorkspaceErrorMessage(error(409, 'GOOGLE_SYNC_IN_PROGRESS'))).toContain(
      'already running',
    );
    expect(googleWorkspaceErrorMessage(error(409, undefined, 'Server says no.'))).toBe(
      'Server says no.',
    );
    expect(googleWorkspaceErrorMessage(error(400, undefined, 'formId is bad'))).toBe(
      'formId is bad',
    );
    expect(googleWorkspaceErrorMessage(new AuthApiError('service-unavailable', 503))).toContain(
      'not configured',
    );
    expect(googleWorkspaceErrorMessage(new AuthApiError('forbidden', 403))).toContain('permission');
    expect(googleWorkspaceErrorMessage(new AuthApiError('unexpected', 404))).toContain('not found');
    expect(googleWorkspaceErrorMessage(new Error('x'), 'Fallback.')).toBe('Fallback.');
    expect(isGoogleWorkspaceForbidden(new AuthApiError('forbidden', 403))).toBe(true);
    expect(isGoogleWorkspaceForbidden(error(409))).toBe(false);
  });
});

describe('mapping rows', () => {
  it('mirrors the API mapping rules', () => {
    expect(GOOGLE_CAPABILITIES).toEqual(['FORMS', 'DRIVE_METADATA', 'GMAIL_SEND', 'SHEETS_EXPORT']);
    expect(MAPPING_FIELDS.RECRUITMENT_INTAKE).toContain('document.RESUME');
    const row = (questionId: string, field: string, label = '') => ({ questionId, field, label });
    expect(mappingRowsProblem('PERFORMANCE_EVIDENCE', [])).toBeNull();
    expect(mappingRowsProblem('ONBOARDING_TASKS', [row('q1', 'respondentEmail')])).toBeNull();
    expect(mappingRowsProblem('ONBOARDING_TASKS', [row('bad id', 'respondentEmail')])).toContain(
      'Question ids',
    );
    expect(mappingRowsProblem('ONBOARDING_TASKS', [row('q1', 'answer')])).toContain(
      'Choose a field',
    );
    expect(
      mappingRowsProblem('PERFORMANCE_EVIDENCE', [
        row('q1', 'respondentEmail'),
        row('q1', 'respondentReference'),
      ]),
    ).toContain('one field only');
    expect(
      mappingRowsProblem('PERFORMANCE_EVIDENCE', [
        row('q1', 'respondentEmail'),
        row('q2', 'respondentEmail'),
      ]),
    ).toContain('mapped twice');
    expect(mappingRowsProblem('RECRUITMENT_INTAKE', [row('q1', 'candidate.firstName')])).toContain(
      'Candidate last name',
    );
    expect(
      mappingRowsProblem('RECRUITMENT_INTAKE', [
        row('q1', 'candidate.firstName', 'x'),
        row('q2', 'candidate.lastName'),
      ]),
    ).toContain('Only answers and documents');
    const rows = [
      row(' q1 ', 'candidate.firstName'),
      row('q2', 'candidate.lastName'),
      row('q3', 'answer', ' Why us? '),
      row('q4', 'answer'),
      row('q5', 'document.RESUME'),
    ];
    expect(mappingRowsProblem('RECRUITMENT_INTAKE', rows)).toBeNull();
    const mapping = mappingFromRows('RECRUITMENT_INTAKE', rows, 'QUIZ_TOTAL');
    expect(mapping).toEqual({
      schemaVersion: 1,
      fields: [
        { questionId: 'q1', field: 'candidate.firstName' },
        { questionId: 'q2', field: 'candidate.lastName' },
        { questionId: 'q3', field: 'answer', label: 'Why us?' },
        { questionId: 'q4', field: 'answer' },
        { questionId: 'q5', field: 'document.RESUME' },
      ],
    });
    expect(mappingFromRows('PERFORMANCE_EVIDENCE', [], 'NONE')).toEqual({
      schemaVersion: 1,
      fields: [],
      scoreSource: 'NONE',
    });
    expect(rowsFromMapping(mapping)[2]).toEqual({
      questionId: 'q3',
      field: 'answer',
      label: 'Why us?',
    });
    expect(rowsFromMapping(null)).toEqual([]);
  });
});
