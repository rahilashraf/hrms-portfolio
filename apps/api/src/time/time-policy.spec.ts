import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TIME_ATTENDANCE_POLICY_CONFIG,
  TimeDomainService,
  type TimeAttendancePolicyConfig,
} from './time-domain.service.js';
import {
  attendanceModes,
  captureAllows,
  DEFAULT_ATTENDANCE_MODES,
  validateTimePolicyConfig,
} from './time-policy.js';

const codeOf = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return (
      error as { getResponse?: () => { code?: string; path?: string } }
    ).getResponse?.();
  }
  return null;
};

describe('attendance modes', () => {
  const domain = new TimeDomainService();

  it('defaults to the pre-9.5 behaviour: time clock captured through self-service', () => {
    expect(attendanceModes(DEFAULT_TIME_ATTENDANCE_POLICY_CONFIG)).toEqual(
      DEFAULT_ATTENDANCE_MODES,
    );
    expect(DEFAULT_ATTENDANCE_MODES).toMatchObject({
      trackingMode: 'TIME_CLOCK',
      captureMode: 'SELF_SERVICE',
    });
  });

  it('inherits and overrides the attendance section like every other policy section', () => {
    const resolved = domain.resolvePolicyConfig([
      {
        inheritanceMode: 'INHERIT',
        config: { attendance: { captureMode: 'KIOSK_ONLY' } },
      },
      {
        inheritanceMode: 'INHERIT',
        config: { attendance: { trackingMode: 'SIGN_IN_ONLY' } },
      },
    ]);
    expect(attendanceModes(resolved)).toMatchObject({
      trackingMode: 'SIGN_IN_ONLY',
      captureMode: 'KIOSK_ONLY',
    });
    const overridden = domain.resolvePolicyConfig([
      {
        inheritanceMode: 'INHERIT',
        config: { attendance: { captureMode: 'KIOSK_ONLY' } },
      },
      {
        inheritanceMode: 'OVERRIDE',
        config: { clock: { mode: 'LIVE_CLOCK' } },
      },
    ]);
    expect(attendanceModes(overridden).captureMode).toBe('SELF_SERVICE');
  });

  it('falls back to defaults for unknown stored values', () => {
    const config = {
      ...DEFAULT_TIME_ATTENDANCE_POLICY_CONFIG,
      attendance: {
        mode: 'BASIC',
        trackingMode: 'NOPE',
        signInDuplicateWindowMinutes: 9999,
      },
    } as TimeAttendancePolicyConfig;
    expect(attendanceModes(config)).toEqual(DEFAULT_ATTENDANCE_MODES);
  });

  it('allows each channel only where the capture mode does', () => {
    expect(captureAllows('KIOSK_ONLY', 'KIOSK')).toBe(true);
    expect(captureAllows('KIOSK_ONLY', 'SELF_SERVICE')).toBe(false);
    expect(captureAllows('SELF_SERVICE', 'KIOSK')).toBe(false);
    expect(captureAllows('SELF_SERVICE', 'SELF_SERVICE')).toBe(true);
    expect(captureAllows('KIOSK_OR_SELF_SERVICE', 'KIOSK')).toBe(true);
    expect(captureAllows('KIOSK_OR_SELF_SERVICE', 'SELF_SERVICE')).toBe(true);
  });
});

describe('time policy config validation', () => {
  it('accepts every documented setting', () => {
    const config = {
      clock: { mode: 'LIVE_CLOCK', assignmentSwitching: true },
      breaks: {
        mode: 'MANUAL_PUNCH',
        autoDeductMinutes: 30,
        paidUnpaidClassification: true,
        defaultPayType: 'UNPAID',
        openBreakAutoCloseExceptionEnabled: true,
      },
      missedPunch: {
        enabled: true,
        maxOpenDurationMinutes: 720,
        detectionGraceMinutes: 30,
        allowAutoCloseFromExpectedEnd: false,
        expectedEndLocalTime: '17:00',
        employeeResolutionEnabled: true,
      },
      correction: {
        employeeRequestsEnabled: true,
        approvalMode: 'AUTO_APPROVE_SAFE',
        autoApprovalToleranceMinutes: 15,
      },
      attendanceInterpretation: {
        lateArrivalEnabled: true,
        earlyDepartureEnabled: false,
        lateGraceMinutes: 5,
        earlyDepartureGraceMinutes: 5,
        expectedStartLocalTime: '09:00',
        expectedEndLocalTime: '17:00',
      },
      timesheet: { mode: 'REVIEW_REQUIRED', autoLockOnApproval: true },
      attendance: {
        trackingMode: 'SIGN_IN_ONLY',
        captureMode: 'KIOSK_ONLY',
        kioskLocationRule: 'ASSIGNMENT_WORK_LOCATION',
        signInDuplicateWindowMinutes: 15,
      },
    };
    expect(validateTimePolicyConfig(config)).toEqual(config);
    expect(validateTimePolicyConfig({})).toEqual({});
  });

  it('refuses unknown sections, unknown keys, wrong types and out-of-range values', () => {
    for (const [config, path] of [
      [[], 'config'],
      [{ payroll: {} }, 'payroll'],
      [{ attendance: 'KIOSK_ONLY' }, 'attendance'],
      [{ attendance: { captureMode: 'KIOSK' } }, 'attendance.captureMode'],
      [{ attendance: { gps: true } }, 'attendance.gps'],
      [
        { attendance: { signInDuplicateWindowMinutes: 241 } },
        'attendance.signInDuplicateWindowMinutes',
      ],
      [
        { attendance: { signInDuplicateWindowMinutes: 1.5 } },
        'attendance.signInDuplicateWindowMinutes',
      ],
      [{ clock: { mode: 'SIGN_IN' } }, 'clock.mode'],
      [{ clock: { assignmentSwitching: 'yes' } }, 'clock.assignmentSwitching'],
      [
        { missedPunch: { expectedEndLocalTime: '25:00' } },
        'missedPunch.expectedEndLocalTime',
      ],
      [{ correction: { approvalMode: 'ALWAYS' } }, 'correction.approvalMode'],
    ] as const) {
      expect(codeOf(() => validateTimePolicyConfig(config))).toMatchObject({
        code: 'TIME_POLICY_CONFIG_INVALID',
        path,
      });
    }
  });
});
