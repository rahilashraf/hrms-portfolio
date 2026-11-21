/**
 * Batch 11 — a minimal client for the demo seed's workflow phase. Every workflow record goes
 * through the real HTTP API as a signed-in demo user, so validation, business rules,
 * authorization, audit and notification producers all apply exactly as they do for a person.
 */

export class DemoApiError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(
      `${method} ${path} → ${status}: ${JSON.stringify(body).slice(0, 500)}`,
    );
    this.name = 'DemoApiError';
  }
}

export interface DemoSession {
  email: string;
  request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T>;
  get<T = unknown>(path: string): Promise<T>;
  post<T = unknown>(path: string, body?: unknown): Promise<T>;
  patch<T = unknown>(path: string, body?: unknown): Promise<T>;
  put<T = unknown>(path: string, body?: unknown): Promise<T>;
  upload<T = unknown>(path: string, form: FormData): Promise<T>;
}

async function parse(response: Response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** Signs in with email and password and returns a session that sends the Bearer token. */
export async function signIn(
  apiUrl: string,
  email: string,
  password: string,
): Promise<DemoSession> {
  // The API limits sign-ins (10 a minute per address); wait out a 429 instead of failing.
  let login: Response;
  for (let attempt = 0; ; attempt += 1) {
    login = await fetch(`${apiUrl}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (login.status !== 429 || attempt >= 4) break;
    const retryAfter = Number(login.headers.get('retry-after')) || 30;
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(retryAfter, 90) * 1000),
    );
  }
  const loginBody = (await parse(login)) as { accessToken?: string } | null;
  if (!login.ok || !loginBody?.accessToken) {
    throw new DemoApiError('POST', '/auth/login', login.status, loginBody);
  }
  const token = loginBody.accessToken;
  const send = async <T>(
    method: string,
    path: string,
    body?: unknown,
    form?: FormData,
  ) => {
    const response = await fetch(`${apiUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(form || body === undefined
          ? {}
          : { 'content-type': 'application/json' }),
      },
      body: form ?? (body === undefined ? undefined : JSON.stringify(body)),
    });
    const parsed = await parse(response);
    if (!response.ok)
      throw new DemoApiError(method, path, response.status, parsed);
    return parsed as T;
  };
  return {
    email,
    request: (method, path, body) => send(method, path, body),
    get: (path) => send('GET', path),
    post: (path, body) => send('POST', path, body ?? {}),
    patch: (path, body) => send('PATCH', path, body ?? {}),
    put: (path, body) => send('PUT', path, body ?? {}),
    upload: (path, form) => send('POST', path, undefined, form),
  };
}

/** Pages through a cursor-paginated list ({ items, nextCursor | nextAfterId }). */
export async function listAll<T>(
  session: DemoSession,
  path: string,
  limit = 100,
): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 50; page += 1) {
    const separator = path.includes('?') ? '&' : '?';
    const query: string = cursor
      ? `${separator}limit=${limit}&cursor=${encodeURIComponent(cursor)}`
      : `${separator}limit=${limit}`;
    const body = await session.get<
      | { items?: T[]; nextCursor?: string | null; nextAfterId?: string | null }
      | T[]
    >(`${path}${query}`);
    if (Array.isArray(body)) return body;
    items.push(...(body.items ?? []));
    cursor = body.nextCursor ?? null;
    if (!cursor) break;
  }
  return items;
}
