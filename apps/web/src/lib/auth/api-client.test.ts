import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  apiRequest,
  apiUpload,
  refreshAccessToken,
  setAccessToken,
  setSessionExpiredHandler,
} from './api-client';
import { AuthApiError } from './types';

function response(status: number, body: unknown = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

describe('frontend API client', () => {
  beforeEach(() => {
    setAccessToken(null);
    setSessionExpiredHandler(() => undefined);
    vi.unstubAllGlobals();
  });

  it('keeps the bearer token in memory and attaches it without browser storage', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(200, { ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    const localWrite = vi.spyOn(Storage.prototype, 'setItem');
    setAccessToken('memory-only-access');

    await expect(apiRequest('/protected')).resolves.toEqual({ ok: true });

    expect(new Headers(fetchMock.mock.calls[0]![1].headers).get('Authorization')).toBe(
      'Bearer memory-only-access',
    );
    expect(localWrite).not.toHaveBeenCalled();
  });

  it('coordinates concurrent 401 responses through one refresh and retries each once', async () => {
    let resolveRefresh!: (value: Response) => void;
    const refreshResponse = new Promise<Response>((resolve) => {
      resolveRefresh = resolve;
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/auth/refresh')) return refreshResponse;
      const authorization = new Headers(init?.headers).get('Authorization');
      if (authorization === 'Bearer old-token') return response(401);
      return response(200, { ok: true });
    });
    vi.stubGlobal('fetch', fetchMock);
    setAccessToken('old-token');

    const first = apiRequest('/protected');
    const second = apiRequest('/protected');
    await vi.waitFor(() => {
      expect(
        fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/auth/refresh')),
      ).toHaveLength(1);
    });
    resolveRefresh(response(200, { accessToken: 'new-token' }));

    await expect(Promise.all([first, second])).resolves.toEqual([{ ok: true }, { ok: true }]);
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/auth/refresh')),
    ).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/protected'))).toHaveLength(
      4,
    );
  });

  it('clears auth when refresh fails and never retries the protected request twice', async () => {
    const expired = vi.fn();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/auth/refresh')) {
        return response(200, { accessToken: 'fresh-but-rejected' });
      }
      return response(401);
    });
    vi.stubGlobal('fetch', fetchMock);
    setAccessToken('expired');
    setSessionExpiredHandler(expired);

    await expect(apiRequest('/protected')).rejects.toMatchObject({
      category: 'unauthenticated',
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(expired).toHaveBeenCalledTimes(1);
  });

  it('clears auth when refresh itself is unavailable', async () => {
    const expired = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(503)));
    setSessionExpiredHandler(expired);

    await expect(refreshAccessToken()).resolves.toBeNull();
    expect(expired).toHaveBeenCalledOnce();
  });

  it('categorizes auth request failures without exposing server response text', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        json: vi.fn().mockResolvedValue({ message: 'private backend details' }),
      }),
    );
    await expect(apiRequest('/auth/login', { method: 'POST' })).rejects.toBeInstanceOf(
      AuthApiError,
    );
  });

  it('distinguishes forbidden responses from expired sessions', async () => {
    const expired = vi.fn();
    setSessionExpiredHandler(expired);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(403)));
    await expect(apiRequest('/authorization/roles')).rejects.toMatchObject({
      category: 'forbidden',
      status: 403,
    });
    expect(expired).not.toHaveBeenCalled();
  });

  it('keeps the error code of a forbidden response as details without exposing its text', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          response(403, { code: 'FEATURE_DISABLED', module: 'PAYROLL', message: 'internal text' }),
        ),
    );
    const error = await apiRequest('/payroll/runs').catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      category: 'forbidden',
      status: 403,
      validationMessage: undefined,
      details: { code: 'FEATURE_DISABLED', module: 'PAYROLL' },
    });
  });

  it('keeps the error code of not-found and rate-limited responses as details only', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(response(404, { code: 'REPORT_FILTER_NOT_FOUND', message: 'x' })),
    );
    await expect(apiRequest('/reports/x')).rejects.toMatchObject({
      status: 404,
      validationMessage: undefined,
      details: { code: 'REPORT_FILTER_NOT_FOUND' },
    });
  });

  it('preserves safe backend validation messages for organization forms', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: vi.fn().mockResolvedValue({
          statusCode: 400,
          message: 'Department cannot be archived while active teams remain.',
        }),
      }),
    );

    await expect(
      apiRequest('/organizations/org/departments/dep/archive', { method: 'POST' }),
    ).rejects.toMatchObject({
      category: 'validation',
      validationMessage: 'Department cannot be archived while active teams remain.',
    });
  });

  it('preserves safe backend validation messages for 422 responses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 422,
        json: vi.fn().mockResolvedValue({
          statusCode: 422,
          message: ['email must be an email'],
        }),
      }),
    );

    await expect(apiRequest('/auth/resend-verification', { method: 'POST' })).rejects.toMatchObject(
      {
        category: 'validation',
        validationMessage: 'Email must be an email.',
      },
    );
  });

  it('classifies 409 responses as conflicts and preserves safe string messages', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        json: vi.fn().mockResolvedValue({
          statusCode: 409,
          message: 'Position is occupied during the requested dates.',
          error: 'Conflict',
        }),
      }),
    );

    await expect(
      apiRequest('/employees/employee-1/assignments', { method: 'POST' }),
    ).rejects.toMatchObject({
      category: 'conflict',
      status: 409,
      validationMessage: 'Position is occupied during the requested dates.',
    });
  });

  it('keeps the parsed body of a 409 domain conflict for callers that need its details', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        response(409, {
          statusCode: 409,
          code: 'RECRUITMENT_POSSIBLE_EXISTING_EMPLOYEE',
          message: 'An employee with this email already exists.',
          matches: [{ employeeId: 'emp-1', employeeNumber: 'E-1', status: 'ACTIVE' }],
        }),
      ),
    );

    await expect(
      apiRequest('/recruitment/applications/a1/hire', { method: 'POST' }),
    ).rejects.toMatchObject({
      status: 409,
      validationMessage: 'An employee with this email already exists.',
      details: {
        code: 'RECRUITMENT_POSSIBLE_EXISTING_EMPLOYEE',
        matches: [{ employeeId: 'emp-1', employeeNumber: 'E-1', status: 'ACTIVE' }],
      },
    });
  });

  it('preserves safe string-array messages for 409 responses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        json: vi.fn().mockResolvedValue({
          statusCode: 409,
          message: ['Primary assignments may not overlap.', 'Choose different dates.'],
        }),
      }),
    );

    await expect(
      apiRequest('/employees/employee-1/assignments', { method: 'POST' }),
    ).rejects.toMatchObject({
      category: 'conflict',
      status: 409,
      validationMessage: 'Primary assignments may not overlap. Choose different dates.',
    });
  });

  it('keeps non-validation error categories unchanged', async () => {
    for (const [status, category] of [
      [404, 'unexpected'],
      [500, 'service-unavailable'],
    ] as const) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(status, { message: 'hidden' })));
      await expect(apiRequest('/resource')).rejects.toMatchObject({ category, status });
    }
  });
});

/** Batch 9: multipart uploads through XMLHttpRequest (progress, cancel, same error model). */
describe('apiUpload', () => {
  class FakeXhr {
    static instances: FakeXhr[] = [];
    static respond: (xhr: FakeXhr) => void = () => undefined;
    headers: Record<string, string> = {};
    method = '';
    url = '';
    status = 0;
    responseText = '';
    body: unknown;
    upload: { onprogress: ((event: ProgressEvent) => void) | null } = { onprogress: null };
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    constructor() {
      FakeXhr.instances.push(this);
    }
    open(method: string, url: string) {
      this.method = method;
      this.url = url;
    }
    setRequestHeader(name: string, value: string) {
      this.headers[name] = value;
    }
    getResponseHeader() {
      return null;
    }
    send(body: unknown) {
      this.body = body;
      queueMicrotask(() => FakeXhr.respond(this));
    }
    abort() {
      queueMicrotask(() => this.onabort?.());
    }
    reply(status: number, body: unknown) {
      this.status = status;
      this.responseText = JSON.stringify(body);
      this.onload?.();
    }
  }

  beforeEach(() => {
    FakeXhr.instances = [];
    vi.unstubAllGlobals();
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    setAccessToken('upload-token');
  });

  it('posts the form with the bearer token, reports progress and returns the body', async () => {
    const progress: number[] = [];
    FakeXhr.respond = (xhr) => {
      xhr.upload.onprogress?.({ lengthComputable: true, loaded: 50, total: 100 } as ProgressEvent);
      xhr.reply(201, { id: 'up-1' });
    };
    const form = new FormData();
    await expect(
      apiUpload('/documents/uploads?documentId=d-1', form, {
        onProgress: (sent, total) => progress.push(sent / total),
      }),
    ).resolves.toEqual({ id: 'up-1' });
    const [xhr] = FakeXhr.instances;
    expect(xhr!.method).toBe('POST');
    expect(xhr!.url).toMatch(/\/documents\/uploads\?documentId=d-1$/);
    expect(xhr!.headers.Authorization).toBe('Bearer upload-token');
    expect(xhr!.body).toBe(form);
    expect(progress).toEqual([0.5]);
  });

  it('keeps the domain code of 413/415/422 refusals', async () => {
    for (const [status, code] of [
      [413, 'DOCUMENT_FILE_TOO_LARGE'],
      [415, 'DOCUMENT_FILE_TYPE_NOT_ALLOWED'],
      [422, 'DOCUMENT_FILE_INFECTED'],
    ] as const) {
      FakeXhr.respond = (xhr) => xhr.reply(status, { code, message: 'm' });
      const error = await apiUpload('/u', new FormData()).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AuthApiError);
      expect(error).toMatchObject({ status, details: { code } });
    }
  });

  it('cancels with an AbortError', async () => {
    FakeXhr.respond = () => undefined;
    const controller = new AbortController();
    const pending = apiUpload('/u', new FormData(), { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('reports a lost connection without a status', async () => {
    FakeXhr.respond = (xhr) => xhr.onerror?.();
    await expect(apiUpload('/u', new FormData())).rejects.toMatchObject({
      status: 0,
      details: { code: 'UPLOAD_NETWORK' },
    });
  });
});
