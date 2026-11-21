import { getApiBaseUrl } from '../api-config';

/**
 * Phase 9.5 — the kiosk's own API client. The kiosk is authenticated by its device cookie
 * (httpOnly, set at enrollment), never by a user session: this client never touches the user
 * access token, never calls /auth/refresh, and treats 401 as "start again", not "sign in".
 */
export type KioskAction =
  | 'CLOCK_IN'
  | 'CLOCK_OUT'
  | 'START_BREAK'
  | 'END_BREAK'
  | 'SWITCH_ASSIGNMENT'
  | 'SIGN_IN'
  // Batch 4D: offered only where the organization enables sign-out.
  | 'SIGN_OUT';

export interface KioskSession {
  device: { id: string; name: string };
  location: { name: string; timezone: string | null };
  organization: { name: string };
  interactionSeconds: number;
}

export interface KioskOption {
  action: KioskAction;
  employmentAssignmentId: string | null;
  /**
   * Multi-assignment clock-in: one physical clock-in covering two or more of these assignments,
   * one of which is the payroll assignment. Offered only when several assignments are eligible.
   */
  coverableAssignments?: Array<{
    employmentAssignmentId: string;
    name: string;
    /** Present when the assignment has several shifts open: the payroll owner picks one. */
    shifts?: Array<{ scheduledShiftId: string; label: string }>;
  }>;
  /** One option per shift when the assignment has several published shifts open now. */
  scheduledShiftId?: string;
  label: string;
}

export interface KioskIdentification {
  token: string;
  expiresInSeconds: number;
  employee: { firstName: string | null };
  state: 'OFF_CLOCK' | 'CLOCKED_IN' | 'ON_BREAK';
  actions: KioskOption[];
  /** Why there is nothing (or something unresolved) to record; the code is a reference for managers. */
  notice?: { code: string; message: string } | null;
}

export interface KioskActionResult {
  action: KioskAction;
  outcome: 'RECORDED' | 'SIGNED_IN' | 'ALREADY_SIGNED_IN' | 'SIGNED_OUT' | 'ALREADY_SIGNED_OUT';
  occurredAt: string;
  timezone?: string;
  /** R4-A.3: recorded, but flagged (code only — nothing private on a shared screen). */
  warnings?: Array<{ code: string }>;
}

export class KioskApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
  ) {
    super(message);
    this.name = 'KioskApiError';
  }
}

async function request<T>(path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${getApiBaseUrl()}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      credentials: 'include',
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new KioskApiError(0, 'KIOSK_OFFLINE', 'The kiosk is offline.');
  }
  if (response.ok) return (await response.json()) as T;
  let code: string | null = null;
  let message = 'Something went wrong.';
  try {
    const payload = (await response.json()) as { code?: unknown; message?: unknown };
    if (typeof payload.code === 'string') code = payload.code;
    if (typeof payload.message === 'string') message = payload.message;
  } catch {
    // Keep the generic message.
  }
  throw new KioskApiError(response.status, code, message);
}

export const kioskApi = {
  session(): Promise<KioskSession> {
    return request('/kiosk/session');
  },
  enroll(enrollmentCode: string): Promise<KioskSession> {
    return request('/kiosk/enroll', { enrollmentCode });
  },
  identify(employeeNumber: string, pin: string): Promise<KioskIdentification> {
    return request('/kiosk/identify', { employeeNumber, pin });
  },
  act(input: {
    token: string;
    action: KioskAction;
    employmentAssignmentId?: string;
    additionalEmploymentAssignmentIds?: string[];
    scheduledShiftId?: string;
    idempotencyKey: string;
  }): Promise<KioskActionResult> {
    return request('/kiosk/actions', input);
  },
  cancel(token: string): Promise<{ cancelled: boolean }> {
    return request('/kiosk/cancel', { token });
  },
};
