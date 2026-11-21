import {
  DRIVE_FILE_ID,
  FORM_ID,
  GOOGLE_TOKEN_ENDPOINT,
  type GoogleFormAnswer,
  type GoogleFormInfo,
  type GoogleFormQuestion,
  type GoogleFormResponse,
} from './google-workspace-domain.js';

/**
 * Phase 16.5 — the thin Google API boundary. Only the endpoints this integration uses, with
 * typed (normalized) responses; everything else in the codebase talks to this interface, and
 * tests use a fake. The fetch implementation never logs, and its errors carry a safe code and
 * the HTTP status only — never a response body, a token or a URL with parameters.
 */

export type GoogleErrorCode =
  | 'GOOGLE_RATE_LIMITED'
  | 'GOOGLE_UNAVAILABLE'
  | 'GOOGLE_NETWORK_ERROR'
  | 'GOOGLE_BAD_REQUEST'
  | 'GOOGLE_UNAUTHORIZED'
  | 'GOOGLE_FORBIDDEN'
  | 'GOOGLE_NOT_FOUND'
  | 'GOOGLE_AUTH_REVOKED'
  | 'GOOGLE_AUTH_FAILED'
  | 'GOOGLE_SCOPE_NOT_GRANTED'
  | 'GOOGLE_INVALID_RESPONSE'
  | 'GOOGLE_HTTP_ERROR';

export class GoogleApiError extends Error {
  constructor(
    readonly code: GoogleErrorCode,
    readonly retryable: boolean,
    readonly httpStatus: number | null = null,
  ) {
    super(code);
    this.name = 'GoogleApiError';
  }

  /** Google refused the credentials themselves: the connection needs an admin. */
  get authFailure() {
    return (
      this.code === 'GOOGLE_UNAUTHORIZED' ||
      this.code === 'GOOGLE_AUTH_REVOKED' ||
      this.code === 'GOOGLE_AUTH_FAILED'
    );
  }
}

/** HTTP status → safe error (retryable: 429, 5xx; permanent: 4xx). */
export function classifyHttpStatus(
  status: number,
  tokenEndpointError?: string | null,
): GoogleApiError {
  if (status === 429)
    return new GoogleApiError('GOOGLE_RATE_LIMITED', true, status);
  if (status >= 500)
    return new GoogleApiError('GOOGLE_UNAVAILABLE', true, status);
  if (tokenEndpointError === 'invalid_grant')
    return new GoogleApiError('GOOGLE_AUTH_REVOKED', false, status);
  if (
    tokenEndpointError === 'unauthorized_client' ||
    tokenEndpointError === 'invalid_client' ||
    tokenEndpointError === 'access_denied'
  )
    return new GoogleApiError('GOOGLE_AUTH_FAILED', false, status);
  if (status === 400)
    return new GoogleApiError('GOOGLE_BAD_REQUEST', false, status);
  if (status === 401)
    return new GoogleApiError('GOOGLE_UNAUTHORIZED', false, status);
  if (status === 403)
    return new GoogleApiError('GOOGLE_FORBIDDEN', false, status);
  if (status === 404)
    return new GoogleApiError('GOOGLE_NOT_FOUND', false, status);
  return new GoogleApiError('GOOGLE_HTTP_ERROR', false, status);
}

export interface GoogleTokenResponse {
  accessToken: string;
  expiresInSeconds: number;
  refreshToken: string | null;
  scope: string | null;
  idToken: string | null;
}

export interface GoogleDriveFileMetadata {
  id: string;
  name: string | null;
  mimeType: string | null;
  trashed: boolean;
  modifiedTime: string | null;
}

export interface GoogleApiClient {
  exchangeAuthorizationCode(input: {
    code: string;
    codeVerifier: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
  }): Promise<GoogleTokenResponse>;
  refreshAccessToken(input: {
    refreshToken: string;
    clientId: string;
    clientSecret: string;
  }): Promise<GoogleTokenResponse>;
  jwtBearerToken(assertion: string): Promise<GoogleTokenResponse>;
  revokeToken(token: string): Promise<void>;
  getForm(accessToken: string, formId: string): Promise<GoogleFormInfo>;
  listFormResponses(
    accessToken: string,
    formId: string,
    options: {
      filter: string | null;
      pageToken: string | null;
      pageSize: number;
    },
  ): Promise<{ responses: GoogleFormResponse[]; nextPageToken: string | null }>;
  getDriveFile(
    accessToken: string,
    fileId: string,
  ): Promise<GoogleDriveFileMetadata>;
  createSpreadsheet(
    accessToken: string,
    title: string,
    sheetTitle: string,
  ): Promise<{ spreadsheetId: string }>;
  appendValues(
    accessToken: string,
    spreadsheetId: string,
    range: string,
    rows: ReadonlyArray<ReadonlyArray<string | number | boolean | null>>,
  ): Promise<{ updatedRows: number }>;
  sendGmailMessage(accessToken: string, raw: string): Promise<{ id: string }>;
}

export const GOOGLE_API_CLIENT = Symbol('GOOGLE_API_CLIENT');

type FetchLike = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

const str = (value: unknown) => (typeof value === 'string' ? value : null);

/** The production client: fetch with a timeout; no retries here (callers schedule retries). */
export class FetchGoogleApiClient implements GoogleApiClient {
  constructor(
    private readonly fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
    private readonly timeoutMs = 15_000,
  ) {}

  private async request(
    url: string,
    init: { method: string; headers?: Record<string, string>; body?: string },
    tokenEndpoint = false,
  ): Promise<unknown> {
    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await this.fetchImpl(url, {
        method: init.method,
        headers: init.headers ?? {},
        body: init.body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new GoogleApiError('GOOGLE_NETWORK_ERROR', true);
    }
    if (!response.ok) {
      // Only the token endpoint's short OAuth error code is read (never echoed as such).
      let oauthError: string | null = null;
      if (tokenEndpoint) {
        const body = await response.json().catch(() => null);
        oauthError = str((body as Record<string, unknown> | null)?.error);
      }
      throw classifyHttpStatus(response.status, oauthError);
    }
    if (response.status === 204) return null;
    try {
      return await response.json();
    } catch {
      throw new GoogleApiError(
        'GOOGLE_INVALID_RESPONSE',
        true,
        response.status,
      );
    }
  }

  private bearer(accessToken: string) {
    return { authorization: `Bearer ${accessToken}` };
  }

  private async token(params: Record<string, string>) {
    const body = (await this.request(
      GOOGLE_TOKEN_ENDPOINT,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(params).toString(),
      },
      true,
    )) as Record<string, unknown> | null;
    const accessToken = str(body?.access_token);
    const expires = body?.expires_in;
    if (!accessToken || typeof expires !== 'number')
      throw new GoogleApiError('GOOGLE_INVALID_RESPONSE', false);
    return {
      accessToken,
      expiresInSeconds: expires,
      refreshToken: str(body?.refresh_token),
      scope: str(body?.scope),
      idToken: str(body?.id_token),
    };
  }

  exchangeAuthorizationCode(input: {
    code: string;
    codeVerifier: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
  }) {
    return this.token({
      grant_type: 'authorization_code',
      code: input.code,
      code_verifier: input.codeVerifier,
      client_id: input.clientId,
      client_secret: input.clientSecret,
      redirect_uri: input.redirectUri,
    });
  }

  refreshAccessToken(input: {
    refreshToken: string;
    clientId: string;
    clientSecret: string;
  }) {
    return this.token({
      grant_type: 'refresh_token',
      refresh_token: input.refreshToken,
      client_id: input.clientId,
      client_secret: input.clientSecret,
    });
  }

  jwtBearerToken(assertion: string) {
    return this.token({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    });
  }

  async revokeToken(token: string) {
    await this.request('https://oauth2.googleapis.com/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }).toString(),
    }).catch((error: unknown) => {
      // A revocation succeeds with an empty body.
      if (
        !(error instanceof GoogleApiError) ||
        error.code !== 'GOOGLE_INVALID_RESPONSE'
      )
        throw error;
    });
  }

  async getForm(accessToken: string, formId: string): Promise<GoogleFormInfo> {
    if (!FORM_ID.test(formId))
      throw new GoogleApiError('GOOGLE_BAD_REQUEST', false);
    const body = (await this.request(
      `https://forms.googleapis.com/v1/forms/${encodeURIComponent(formId)}`,
      { method: 'GET', headers: this.bearer(accessToken) },
    )) as Record<string, any> | null;
    if (!body || str(body.formId) === null)
      throw new GoogleApiError('GOOGLE_INVALID_RESPONSE', false);
    const questions: GoogleFormQuestion[] = [];
    for (const item of Array.isArray(body.items) ? body.items : []) {
      const single = item?.questionItem?.question;
      const group = item?.questionGroupItem?.questions;
      for (const question of single
        ? [single]
        : Array.isArray(group)
          ? group
          : []) {
        const questionId = str(question?.questionId);
        if (!questionId) continue;
        questions.push({
          questionId,
          title: (str(item?.title) ?? '').slice(0, 300),
          kind: question.fileUploadQuestion
            ? 'FILE_UPLOAD'
            : question.textQuestion
              ? 'TEXT'
              : question.choiceQuestion
                ? 'CHOICE'
                : 'OTHER',
          pointValue:
            typeof question?.grading?.pointValue === 'number'
              ? question.grading.pointValue
              : null,
        });
      }
    }
    return {
      formId: body.formId,
      title: (str(body.info?.title) ?? '').slice(0, 300),
      emailCollection: str(body.settings?.emailCollectionType),
      questions,
    };
  }

  async listFormResponses(
    accessToken: string,
    formId: string,
    options: {
      filter: string | null;
      pageToken: string | null;
      pageSize: number;
    },
  ) {
    if (!FORM_ID.test(formId))
      throw new GoogleApiError('GOOGLE_BAD_REQUEST', false);
    const params = new URLSearchParams({ pageSize: String(options.pageSize) });
    if (options.filter) params.set('filter', options.filter);
    if (options.pageToken) params.set('pageToken', options.pageToken);
    const body = (await this.request(
      `https://forms.googleapis.com/v1/forms/${encodeURIComponent(formId)}/responses?${params.toString()}`,
      { method: 'GET', headers: this.bearer(accessToken) },
    )) as Record<string, any> | null;
    const responses: GoogleFormResponse[] = [];
    for (const raw of Array.isArray(body?.responses) ? body.responses : []) {
      const responseId = str(raw?.responseId);
      const createTime = str(raw?.createTime);
      const lastSubmittedTime = str(raw?.lastSubmittedTime) ?? createTime;
      if (!responseId || !createTime || !lastSubmittedTime) continue;
      const answers: Record<string, GoogleFormAnswer> = {};
      for (const [questionId, answer] of Object.entries(
        (raw.answers ?? {}) as Record<string, any>,
      )) {
        answers[questionId] = {
          texts: (Array.isArray(answer?.textAnswers?.answers)
            ? answer.textAnswers.answers
            : []
          )
            .map((a: any) => str(a?.value))
            .filter((v: string | null): v is string => v !== null),
          files: (Array.isArray(answer?.fileUploadAnswers?.answers)
            ? answer.fileUploadAnswers.answers
            : []
          )
            .filter((f: any) => str(f?.fileId))
            .map((f: any) => ({
              fileId: f.fileId as string,
              fileName: str(f.fileName),
              mimeType: str(f.mimeType),
            })),
        };
      }
      responses.push({
        responseId,
        createTime,
        lastSubmittedTime,
        respondentEmail: str(raw.respondentEmail),
        totalScore: typeof raw.totalScore === 'number' ? raw.totalScore : null,
        answers,
      });
    }
    return { responses, nextPageToken: str(body?.nextPageToken) };
  }

  async getDriveFile(accessToken: string, fileId: string) {
    if (!DRIVE_FILE_ID.test(fileId))
      throw new GoogleApiError('GOOGLE_BAD_REQUEST', false);
    const params = new URLSearchParams({
      fields: 'id,name,mimeType,trashed,modifiedTime',
      supportsAllDrives: 'true',
    });
    const body = (await this.request(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?${params.toString()}`,
      { method: 'GET', headers: this.bearer(accessToken) },
    )) as Record<string, unknown> | null;
    const id = str(body?.id);
    if (!id) throw new GoogleApiError('GOOGLE_INVALID_RESPONSE', false);
    return {
      id,
      name: str(body?.name),
      mimeType: str(body?.mimeType),
      trashed: body?.trashed === true,
      modifiedTime: str(body?.modifiedTime),
    };
  }

  async createSpreadsheet(
    accessToken: string,
    title: string,
    sheetTitle: string,
  ) {
    const body = (await this.request(
      'https://sheets.googleapis.com/v4/spreadsheets',
      {
        method: 'POST',
        headers: {
          ...this.bearer(accessToken),
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          properties: { title },
          sheets: [{ properties: { title: sheetTitle } }],
        }),
      },
    )) as Record<string, unknown> | null;
    const spreadsheetId = str(body?.spreadsheetId);
    if (!spreadsheetId)
      throw new GoogleApiError('GOOGLE_INVALID_RESPONSE', false);
    return { spreadsheetId };
  }

  async appendValues(
    accessToken: string,
    spreadsheetId: string,
    range: string,
    rows: ReadonlyArray<ReadonlyArray<string | number | boolean | null>>,
  ) {
    if (!DRIVE_FILE_ID.test(spreadsheetId))
      throw new GoogleApiError('GOOGLE_BAD_REQUEST', false);
    const params = new URLSearchParams({
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
    });
    const body = (await this.request(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}:append?${params.toString()}`,
      {
        method: 'POST',
        headers: {
          ...this.bearer(accessToken),
          'content-type': 'application/json',
        },
        body: JSON.stringify({ majorDimension: 'ROWS', values: rows }),
      },
    )) as Record<string, any> | null;
    const updated = body?.updates?.updatedRows;
    return { updatedRows: typeof updated === 'number' ? updated : 0 };
  }

  async sendGmailMessage(accessToken: string, raw: string) {
    const body = (await this.request(
      'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
      {
        method: 'POST',
        headers: {
          ...this.bearer(accessToken),
          'content-type': 'application/json',
        },
        body: JSON.stringify({ raw }),
      },
    )) as Record<string, unknown> | null;
    const id = str(body?.id);
    if (!id) throw new GoogleApiError('GOOGLE_INVALID_RESPONSE', false);
    return { id };
  }
}
