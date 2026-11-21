export interface AuthIdentity {
  id: string;
  personId: string;
  email: string;
  status: string;
  emailVerifiedAt: string | null;
  mustChangePassword: boolean;
}

/** Batch 2: one of the signed-in user's own sessions (GET /auth/sessions). */
export interface AccountSession {
  id: string;
  current: boolean;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
  ipAddress: string | null;
  browser: string;
  os: string;
}

export interface LoginResponse {
  accessToken: string;
  identity: AuthIdentity;
}

export type AuthErrorCategory =
  | 'invalid-credentials'
  | 'unauthenticated'
  | 'forbidden'
  | 'conflict'
  | 'rate-limited'
  | 'service-unavailable'
  | 'validation'
  | 'unexpected';

export class AuthApiError extends Error {
  constructor(
    readonly category: AuthErrorCategory,
    readonly status: number,
    readonly validationMessage?: string,
    /**
     * The parsed error body of a 400/403/404/409/422/429/503 response (e.g. a domain `code` and
     * its details).
     */
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(category);
    this.name = 'AuthApiError';
  }
}

export const AUTH_ERROR_MESSAGES: Record<AuthErrorCategory, string> = {
  'invalid-credentials': 'The email or password is incorrect.',
  unauthenticated: 'Your session has expired. Please sign in again.',
  forbidden: 'You do not have permission to perform this action.',
  conflict: 'The request conflicts with existing data.',
  'rate-limited': 'Too many attempts — please wait and try again.',
  'service-unavailable': 'Authentication is temporarily unavailable. Please try again later.',
  validation: 'Check the information you entered and try again.',
  unexpected: 'Something went wrong. Please try again.',
};
