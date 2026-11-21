import { describe, expect, it } from 'vitest';
import type { TimePolicy } from '../../lib/attendance/types';
import { attendanceSummary, clockSections } from './attendance-admin';

const text = (values: Record<string, string>) => (key: string) => values[key] ?? '';

describe('attendance policy time clock settings', () => {
  it('adds only the clock and break settings that were chosen (blank inherits)', () => {
    expect(clockSections(text({}))).toEqual({});
    expect(
      clockSections(
        text({ clockMode: 'LIVE_CLOCK', assignmentSwitching: 'false', breaksMode: 'MANUAL_PUNCH' }),
      ),
    ).toEqual({
      clock: { mode: 'LIVE_CLOCK', assignmentSwitching: false },
      breaks: { mode: 'MANUAL_PUNCH' },
    });
  });

  it('shows whether a layer turns the time clock on', () => {
    const policy = (config: TimePolicy['config']) => ({ config }) as TimePolicy;
    expect(
      attendanceSummary(
        policy({ attendance: { trackingMode: 'TIME_CLOCK', captureMode: 'KIOSK_ONLY' } }),
      ),
    ).toBe('Time Clock · Kiosk Only');
    expect(
      attendanceSummary(
        policy({ clock: { mode: 'LIVE_CLOCK' }, attendance: { captureMode: 'KIOSK_ONLY' } }),
      ),
    ).toBe('Clocking on · Kiosk Only');
    expect(attendanceSummary(policy({}))).toBe('No attendance settings');
  });
});
