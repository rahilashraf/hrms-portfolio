import { afterEach, describe, expect, it, vi } from 'vitest';
import { documentsErrorMessage } from '../documents/errors';
import { featuresErrorMessage } from '../features/errors';
import { googleWorkspaceErrorMessage } from '../google-workspace/errors';
import { notificationsErrorMessage } from '../notifications/errors';
import { recruitmentErrorMessage } from '../recruitment/errors';
import { reportingErrorMessage } from '../reporting/errors';
import { apiRequest } from './api-client';
import {
  authErrorMessage,
  isRateLimited,
  RATE_LIMITED_MESSAGE,
  rateLimitedMessage,
} from './error-message';
import { AuthApiError } from './types';

const limited = () =>
  new AuthApiError('rate-limited', 429, undefined, {
    statusCode: 429,
    code: 'RATE_LIMITED',
    message: 'Too many requests. Please wait and try again.',
  });

afterEach(() => vi.unstubAllGlobals());

describe('rate limiting messages', () => {
  it('uses one friendly message', () => {
    expect(RATE_LIMITED_MESSAGE).toBe('Too many attempts — please wait and try again.');
    expect(authErrorMessage(limited())).toBe(RATE_LIMITED_MESSAGE);
    expect(authErrorMessage(new AuthApiError('rate-limited', 429))).toBe(RATE_LIMITED_MESSAGE);
  });

  it('recognizes 429 RATE_LIMITED (and a bare 429) only', () => {
    expect(isRateLimited(limited())).toBe(true);
    expect(isRateLimited(new AuthApiError('rate-limited', 429))).toBe(true);
    expect(
      isRateLimited(
        new AuthApiError('rate-limited', 429, undefined, { code: 'KIOSK_RATE_LIMITED' }),
      ),
    ).toBe(false);
    expect(
      isRateLimited(new AuthApiError('validation', 400, undefined, { code: 'RATE_LIMITED' })),
    ).toBe(false);
    expect(isRateLimited(new Error('429'))).toBe(false);
    expect(rateLimitedMessage(new AuthApiError('forbidden', 403))).toBeNull();
  });

  it('keeps the 429 body from the shared client and maps it in the domain helpers', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        headers: new Headers({ 'Retry-After': '30' }),
        json: vi.fn().mockResolvedValue({ statusCode: 429, code: 'RATE_LIMITED', message: 'x' }),
      }),
    );
    const error = await apiRequest('/documents/provide', { method: 'POST' }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({
      category: 'rate-limited',
      status: 429,
      validationMessage: undefined,
      details: { code: 'RATE_LIMITED' },
    });
    for (const message of [
      documentsErrorMessage(error),
      notificationsErrorMessage(error),
      recruitmentErrorMessage(error),
      reportingErrorMessage(error),
      featuresErrorMessage(error),
      googleWorkspaceErrorMessage(error),
    ]) {
      // Batch 2: with Retry-After the shared helper also says how long to wait.
      expect(message).toMatch(
        /^Too many attempts — please wait (about 30 seconds )?and try again\.$/,
      );
    }
    expect(rateLimitedMessage(error)).toBe(
      'Too many attempts — please wait about 30 seconds and try again.',
    );
    expect(error).toMatchObject({ details: { retryAfterSeconds: 30 } });
    expect(
      rateLimitedMessage(
        new AuthApiError('rate-limited', 429, undefined, { retryAfterSeconds: 900 }),
      ),
    ).toBe('Too many attempts — please wait about 15 minutes and try again.');
    expect(rateLimitedMessage(new AuthApiError('rate-limited', 429))).toBe(RATE_LIMITED_MESSAGE);
  });

  it('leaves domain-specific 429 codes to their domain', () => {
    const tooFrequent = new AuthApiError('rate-limited', 429, undefined, {
      code: 'GOOGLE_SYNC_TOO_FREQUENT',
    });
    expect(googleWorkspaceErrorMessage(tooFrequent)).not.toBe(RATE_LIMITED_MESSAGE);
  });
});
