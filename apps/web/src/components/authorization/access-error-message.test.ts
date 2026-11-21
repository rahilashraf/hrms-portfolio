import { describe, expect, it, vi } from 'vitest';
import { AuthApiError } from '../../lib/auth/types';

vi.mock('../../lib/authorization/api', () => ({ authorizationApi: {} }));
vi.mock('../../lib/organization/api', () => ({ organizationApi: {} }));
const { accessErrorMessage } = await import('./access-control');

/** Batch 10B — role pages show words for API refusals, never the raw category ("forbidden"). */
describe('accessErrorMessage', () => {
  it('maps refusals to readable text', () => {
    expect(accessErrorMessage(new AuthApiError('forbidden', 403))).toBe(
      'You do not have permission to perform this action.',
    );
    expect(accessErrorMessage(new AuthApiError('service-unavailable', 503))).toBe(
      'The service is temporarily unavailable. Please try again later.',
    );
    expect(accessErrorMessage(new AuthApiError('conflict', 409, 'Code already used.'))).toBe(
      'Code already used.',
    );
    expect(accessErrorMessage(new Error('Choose a user.'))).toBe('Choose a user.');
  });

  it('says "role not found" only where the role itself was requested', () => {
    const missing = new AuthApiError('unexpected', 404);
    expect(accessErrorMessage(missing)).toBe(
      'The requested record was not found. It may have been removed.',
    );
    expect(accessErrorMessage(missing, 'This role was not found. It may have been removed.')).toBe(
      'This role was not found. It may have been removed.',
    );
  });
});
