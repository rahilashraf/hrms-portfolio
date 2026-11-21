import { describe, expect, it } from 'vitest';
import { AuthApiError } from '../auth/types';
import {
  isAttendanceTurnedOff,
  LOCAL_TIME_SELECT_OCCURRENCE,
  localTimeOccurrences,
  timeErrorMessage,
} from './errors';

const ambiguous = new AuthApiError('conflict', 409, 'Ambiguous local time', {
  code: 'TIME_LOCAL_TIME_AMBIGUOUS',
  occurrences: [
    { instant: '2026-11-01T05:30:00.000Z', offset: '-04:00', value: '2026-11-01T01:30-04:00' },
    { instant: '2026-11-01T06:30:00.000Z', offset: '-05:00', value: '2026-11-01T01:30-05:00' },
  ],
});

describe('time error messages (Batch 4E-1)', () => {
  it('explains a repeated local time without asking for a choice most screens cannot offer', () => {
    const message = timeErrorMessage(ambiguous);
    expect(message).toBe(
      'This local time occurs twice because the clocks moved back. A manager can help record the correct occurrence.',
    );
    // Employee correction requests and Attendance admin forms have no occurrence selector.
    expect(message).not.toMatch(/\b(select|choose|pick)\b/i);
    expect(message).not.toMatch(/below|listed/i);
  });

  it('keeps the selection instruction for screens that offer the occurrences', () => {
    expect(LOCAL_TIME_SELECT_OCCURRENCE).toBe(
      'This time occurs twice because the clocks moved back. Select the correct occurrence below.',
    );
    expect(localTimeOccurrences(ambiguous).map((occurrence) => occurrence.value)).toEqual([
      '2026-11-01T01:30-04:00',
      '2026-11-01T01:30-05:00',
    ]);
  });

  it('shows the server’s own text for other conflicts, never the error category', () => {
    expect(timeErrorMessage(new AuthApiError('conflict', 409, 'Already submitted.'))).toBe(
      'Already submitted.',
    );
    expect(timeErrorMessage(new AuthApiError('conflict', 409))).toBe(
      'This time action cannot be completed yet.',
    );
  });
});

describe('time error messages (Batch 4F)', () => {
  it('asks for the occurrence when several are open and one is signed in', () => {
    const error = new AuthApiError('conflict', 409, 'server text', {
      code: 'ATTENDANCE_OCCURRENCE_CHOICE_REQUIRED',
    });
    expect(timeErrorMessage(error)).toBe(
      'Several shifts are open now and one is already signed in. Choose the shift to sign in for.',
    );
  });

  it('recognizes Time & attendance turned off (403 FEATURE_DISABLED)', () => {
    const off = new AuthApiError('forbidden', 403, undefined, {
      code: 'FEATURE_DISABLED',
      module: 'ATTENDANCE',
    });
    expect(isAttendanceTurnedOff(off)).toBe(true);
    expect(
      isAttendanceTurnedOff(
        new AuthApiError('forbidden', 403, undefined, {
          code: 'FEATURE_DISABLED',
          module: 'PAYROLL',
        }),
      ),
    ).toBe(false);
    expect(isAttendanceTurnedOff(new AuthApiError('forbidden', 403))).toBe(false);
  });
});
