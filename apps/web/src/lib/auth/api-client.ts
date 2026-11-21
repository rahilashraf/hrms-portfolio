import { getApiBaseUrl } from '../api-config';
import { AuthApiError } from './types';
import type { AccountSession, AuthIdentity, LoginResponse } from './types';
import { humanizeValidationMessages } from '../ui/validation';

let accessToken: string | null = null;
let refreshPromise: Promise<string | null> | null = null;
let onSessionExpired: () => void = () => undefined;
let onPasswordChangeRequired: () => void = () => undefined;

interface RequestOptions extends RequestInit {
  authenticated?: boolean;
  retryUnauthorized?: boolean;
  credentials?: RequestCredentials;
}

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export function setSessionExpiredHandler(handler: () => void): void {
  onSessionExpired = handler;
}

/** Batch 2: called when the API answers 403 PASSWORD_CHANGE_REQUIRED (a forced change). */
export function setPasswordChangeRequiredHandler(handler: () => void): void {
  onPasswordChangeRequired = handler;
}

export async function login(email: string, password: string): Promise<LoginResponse> {
  return requestJson<LoginResponse>(
    '/auth/login',
    {
      method: 'POST',
      body: JSON.stringify({ email, password }),
      credentials: 'include',
    },
    false,
  );
}

export async function refreshAccessToken(): Promise<string | null> {
  if (refreshPromise) {
    return refreshPromise;
  }

  refreshPromise = (async () => {
    try {
      const response = await fetch(`${getApiBaseUrl()}/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) {
        expireSession();
        return null;
      }
      const result = (await response.json()) as { accessToken?: unknown };
      if (typeof result.accessToken !== 'string' || result.accessToken.length === 0) {
        expireSession();
        return null;
      }
      setAccessToken(result.accessToken);
      return result.accessToken;
    } catch {
      expireSession();
      return null;
    }
  })().finally(() => {
    refreshPromise = null;
  });

  return refreshPromise;
}

export async function getCurrentIdentity(): Promise<AuthIdentity> {
  return requestJson<AuthIdentity>('/auth/me');
}

export async function logout(): Promise<void> {
  await requestJson(
    '/auth/logout',
    {
      method: 'POST',
      credentials: 'include',
    },
    false,
  );
}

export async function logoutAll(): Promise<void> {
  await requestJson('/auth/logout-all', {
    method: 'POST',
    credentials: 'include',
  });
}

/** Batch 2: the signed-in user changes their password (other sessions end). */
export function changePassword(
  currentPassword: string,
  newPassword: string,
): Promise<{ success: true; revokedSessionCount: number }> {
  return requestJson('/auth/change-password', {
    method: 'POST',
    body: JSON.stringify({ currentPassword, newPassword }),
  });
}

export function listSessions(): Promise<{ items: AccountSession[] }> {
  return requestJson('/auth/sessions');
}

export function revokeSession(id: string): Promise<{ success: true }> {
  return requestJson(`/auth/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function revokeOtherSessions(): Promise<{
  success: true;
  revokedSessionCount: number;
}> {
  return requestJson('/auth/sessions/revoke-others', {
    method: 'POST',
    credentials: 'include',
  });
}

export function forgotPassword(email: string): Promise<{ message: string }> {
  return requestJson(
    '/auth/forgot-password',
    {
      method: 'POST',
      body: JSON.stringify({ email }),
    },
    false,
  );
}

export function resetPassword(token: string, newPassword: string): Promise<{ success: true }> {
  return requestJson(
    '/auth/reset-password',
    {
      method: 'POST',
      body: JSON.stringify({ token, newPassword }),
    },
    false,
  );
}

export function acceptInvitation(token: string, password: string): Promise<{ success: true }> {
  return requestJson(
    '/auth/accept-invitation',
    {
      method: 'POST',
      body: JSON.stringify({ token, password }),
    },
    false,
  );
}

export function verifyEmail(token: string): Promise<{ success: true }> {
  return requestJson(
    '/auth/verify-email',
    { method: 'POST', body: JSON.stringify({ token }) },
    false,
  );
}

export function resendVerification(email: string): Promise<{ message: string }> {
  return requestJson(
    '/auth/resend-verification',
    {
      method: 'POST',
      body: JSON.stringify({ email }),
    },
    false,
  );
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  return requestJson<T>(path, options, options.authenticated !== false);
}

async function requestJson<T>(
  path: string,
  options: RequestOptions = {},
  authenticated = true,
  alreadyRetried = false,
): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set('Accept', 'application/json');
  if (options.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  if (authenticated && accessToken) {
    headers.set('Authorization', `Bearer ${accessToken}`);
  }
  const init = { ...options };
  delete init.authenticated;
  delete init.retryUnauthorized;
  const response = await fetch(`${getApiBaseUrl()}${path}`, {
    ...init,
    headers,
  });

  if (
    authenticated &&
    response.status === 401 &&
    options.retryUnauthorized !== false &&
    !alreadyRetried
  ) {
    const refreshed = await refreshAccessToken();
    if (refreshed) {
      return requestJson<T>(path, options, authenticated, true);
    }
    throw new AuthApiError('unauthenticated', 401);
  }
  if (authenticated && response.status === 401 && alreadyRetried) {
    expireSession();
    throw new AuthApiError('unauthenticated', 401);
  }
  if (response.status === 403) {
    // The body is kept only as details (e.g. FEATURE_DISABLED); the message stays generic.
    const { body: details } = await safeServerBody(response);
    if (authenticated && details?.code === 'PASSWORD_CHANGE_REQUIRED') onPasswordChangeRequired();
    throw new AuthApiError('forbidden', 403, undefined, details);
  }

  if (!response.ok) {
    let validationMessage: string | undefined;
    let details: Record<string, unknown> | undefined;
    if (response.status === 400 || response.status === 409 || response.status === 422) {
      ({ message: validationMessage, body: details } = await safeServerBody(response));
    } else if ([404, 413, 415, 429, 503].includes(response.status)) {
      // Error codes only (e.g. REPORT_FILTER_NOT_FOUND); server text is not shown to users.
      ({ body: details } = await safeServerBody(response));
    }
    // Batch 2: how long a rate limit lasts (the API exposes Retry-After to the web origin).
    const retryAfter = Number(response.headers?.get('Retry-After'));
    if (response.status === 429 && Number.isInteger(retryAfter) && retryAfter > 0) {
      details = { ...details, retryAfterSeconds: retryAfter };
    }
    throw new AuthApiError(
      categoryForStatus(response.status),
      response.status,
      validationMessage,
      details,
    );
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

export interface UploadOptions {
  /** Bytes sent so far (the request body, so slightly more than the file). */
  onProgress?(sent: number, total: number): void;
  /** Aborting rejects with a DOMException named AbortError. */
  signal?: AbortSignal;
}

/**
 * Batch 9: a multipart upload with progress (XMLHttpRequest — fetch cannot report upload
 * progress). Same authentication, one refresh-and-retry on 401 and the same error model as
 * apiRequest; the server's error code is kept for 400/404/409/413/415/422/429/503.
 */
export async function apiUpload<T>(
  path: string,
  form: FormData,
  options: UploadOptions = {},
  alreadyRetried = false,
): Promise<T> {
  const result = await new Promise<{ status: number; text: string; retryAfter: string | null }>(
    (resolve, reject) => {
      if (options.signal?.aborted) {
        reject(new DOMException('The upload was cancelled.', 'AbortError'));
        return;
      }
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${getApiBaseUrl()}${path}`);
      xhr.setRequestHeader('Accept', 'application/json');
      if (accessToken) xhr.setRequestHeader('Authorization', `Bearer ${accessToken}`);
      const abort = () => xhr.abort();
      options.signal?.addEventListener('abort', abort, { once: true });
      const done = () => options.signal?.removeEventListener('abort', abort);
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) options.onProgress?.(event.loaded, event.total);
      };
      xhr.onload = () => {
        done();
        resolve({
          status: xhr.status,
          text: xhr.responseText,
          retryAfter: xhr.getResponseHeader('Retry-After'),
        });
      };
      xhr.onerror = () => {
        done();
        reject(new AuthApiError('service-unavailable', 0, undefined, { code: 'UPLOAD_NETWORK' }));
      };
      xhr.onabort = () => {
        done();
        reject(new DOMException('The upload was cancelled.', 'AbortError'));
      };
      xhr.send(form);
    },
  );
  if (result.status === 401 && !alreadyRetried) {
    const refreshed = await refreshAccessToken();
    if (refreshed) return apiUpload<T>(path, form, options, true);
    throw new AuthApiError('unauthenticated', 401);
  }
  if (result.status === 401) {
    expireSession();
    throw new AuthApiError('unauthenticated', 401);
  }
  let body: Record<string, unknown> | undefined;
  try {
    const parsed: unknown = JSON.parse(result.text);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed))
      body = parsed as Record<string, unknown>;
  } catch {
    body = undefined;
  }
  if (result.status >= 200 && result.status < 300) return body as T;
  const message =
    [400, 409, 422].includes(result.status) && typeof body?.message === 'string'
      ? body.message
      : undefined;
  let details = body;
  const retryAfter = Number(result.retryAfter);
  if (result.status === 429 && Number.isInteger(retryAfter) && retryAfter > 0) {
    details = { ...details, retryAfterSeconds: retryAfter };
  }
  throw new AuthApiError(categoryForStatus(result.status), result.status, message, details);
}

function categoryForStatus(status: number) {
  if (status === 401) return 'invalid-credentials' as const;
  if (status === 403) return 'forbidden' as const;
  if (status === 409) return 'conflict' as const;
  if (status === 422 || status === 400) return 'validation' as const;
  if (status === 429) return 'rate-limited' as const;
  if (status >= 500) return 'service-unavailable' as const;
  return 'unexpected' as const;
}

async function safeServerBody(
  response: Response,
): Promise<{ message?: string; body?: Record<string, unknown> }> {
  try {
    const body: unknown = await response.json();
    if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
      const record = body as Record<string, unknown>;
      const message = record.message;
      if (typeof message === 'string') return { message, body: record };
      if (
        Array.isArray(message) &&
        message.every((item): item is string => typeof item === 'string')
      ) {
        // class-validator lists raw property names; show them as readable sentences.
        return { message: humanizeValidationMessages(message), body: record };
      }
      return { body: record };
    }
  } catch {
    return {};
  }
  return {};
}

function expireSession(): void {
  setAccessToken(null);
  onSessionExpired();
}
