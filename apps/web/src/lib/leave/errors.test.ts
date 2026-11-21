import { describe, expect, it } from 'vitest';
import { AuthApiError } from '../auth/types';
import { leaveErrorMessage } from './errors';

describe('leaveErrorMessage', () => {
  it('explains the self-decision refusal (D5) without the server text', () => {
    expect(
      leaveErrorMessage(
        new AuthApiError('forbidden', 403, undefined, { code: 'LEAVE_SELF_APPROVAL' }),
      ),
    ).toMatch(/cannot record, approve or decide your own leave/);
    expect(leaveErrorMessage(new AuthApiError('forbidden', 403))).toBe(
      'You do not have permission for this leave action.',
    );
  });
});
