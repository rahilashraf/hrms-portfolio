import { describe, expect, it } from 'vitest';
import { AuthApiError } from '../auth/types';
import { benefitsErrorMessage } from '../benefits/errors';
import { leaveErrorMessage } from '../leave/errors';
import { reportingErrorMessage } from '../reporting/errors';
import {
  FEATURE_DISABLED_MESSAGE,
  featureDisabledInfo,
  featureDisabledMessage,
  featuresErrorCode,
  featuresErrorMessage,
  isFeatureDisabled,
  isFeatureVersionConflict,
  moduleLabel,
  moduleList,
  SETTING_DISABLED_MESSAGE,
} from './errors';

const err = (status: number, details?: Record<string, unknown>, message?: string) =>
  new AuthApiError(status === 409 ? 'conflict' : 'unexpected', status, message, details);

describe('disabled features', () => {
  it('recognizes FEATURE_DISABLED and SETTING_DISABLED 403 bodies', () => {
    expect(featureDisabledInfo(err(403, { code: 'FEATURE_DISABLED', module: 'PAYROLL' }))).toEqual({
      kind: 'module',
      module: 'PAYROLL',
    });
    expect(featureDisabledInfo(err(403, { code: 'FEATURE_DISABLED' }))).toEqual({
      kind: 'module',
      module: null,
    });
    expect(
      featureDisabledInfo(err(403, { code: 'SETTING_DISABLED', key: 'performance.selfReview' })),
    ).toEqual({ kind: 'setting', key: 'performance.selfReview' });
    expect(featureDisabledMessage(err(403, { code: 'FEATURE_DISABLED', module: 'PAYROLL' }))).toBe(
      'Payroll is turned off for your organization.',
    );
    expect(featureDisabledMessage(err(403, { code: 'FEATURE_DISABLED', module: 'NOPE' }))).toBe(
      FEATURE_DISABLED_MESSAGE,
    );
    expect(featureDisabledMessage(err(403, { code: 'SETTING_DISABLED' }))).toBe(
      SETTING_DISABLED_MESSAGE,
    );
  });

  it('ignores plain 403s, other statuses and non-API errors', () => {
    // The shared client does not keep 403 bodies: a plain 403 stays a permission problem.
    expect(isFeatureDisabled(new AuthApiError('forbidden', 403))).toBe(false);
    expect(isFeatureDisabled(err(409, { code: 'FEATURE_DISABLED' }))).toBe(false);
    expect(isFeatureDisabled(new Error('FEATURE_DISABLED'))).toBe(false);
    expect(featureDisabledMessage(null)).toBeNull();
  });

  it('is used first by the domain error helpers', () => {
    const disabled = err(403, { code: 'FEATURE_DISABLED', module: 'BENEFITS' });
    expect(benefitsErrorMessage(disabled)).toBe('Benefits is turned off for your organization.');
    expect(leaveErrorMessage(err(403, { code: 'FEATURE_DISABLED', module: 'LEAVE' }))).toBe(
      'Leave is turned off for your organization.',
    );
    expect(reportingErrorMessage(err(403, { code: 'FEATURE_DISABLED', module: 'REPORTING' }))).toBe(
      'Reporting is turned off for your organization.',
    );
    expect(benefitsErrorMessage(new AuthApiError('forbidden', 403))).toBe(
      'You do not have permission for this benefits action.',
    );
  });
});

describe('features administration errors', () => {
  it('names modules', () => {
    expect(moduleLabel('GOOGLE_WORKSPACE')).toBe('Google Workspace');
    expect(moduleLabel('UNKNOWN')).toBe('UNKNOWN');
    expect(moduleList(['COMPENSATION', 'ATTENDANCE'])).toBe('Compensation, Time & attendance');
  });

  it('maps the domain codes', () => {
    const conflict = err(409, { code: 'FEATURE_VERSION_CONFLICT', currentVersion: 3 });
    expect(featuresErrorCode(conflict)).toBe('FEATURE_VERSION_CONFLICT');
    expect(isFeatureVersionConflict(conflict)).toBe(true);
    expect(isFeatureVersionConflict(err(409, { code: 'OTHER' }))).toBe(false);
    expect(featuresErrorMessage(conflict)).toMatch(/changed this configuration.*reloaded/);
    expect(
      featuresErrorMessage(
        err(409, { code: 'FEATURE_DEPENDENTS_ENABLED', dependents: ['PAYROLL'] }),
      ),
    ).toBe('This module cannot be turned off while Payroll depends on it. Turn it off first.');
    expect(
      featuresErrorMessage(
        err(409, { code: 'FEATURE_DEPENDENCY_DISABLED', requires: ['COMPENSATION', 'ATTENDANCE'] }),
      ),
    ).toBe('This module requires Compensation, Time & attendance. Turn them on first.');
    expect(
      featuresErrorMessage(
        err(409, { code: 'FEATURE_DEPENDENTS_ENABLED' }, 'Payroll depends on Compensation.'),
      ),
    ).toBe('Payroll depends on Compensation.');
    expect(featuresErrorMessage(err(404, { code: 'SETTING_UNKNOWN' }))).toMatch(/not known/);
    expect(featuresErrorMessage(err(404, { code: 'FEATURE_MODULE_UNKNOWN' }))).toMatch(/not known/);
    expect(
      featuresErrorMessage(
        err(400, { code: 'SETTING_VALUE_INVALID' }, 'performance.selfReview must be a boolean.'),
      ),
    ).toBe('performance.selfReview must be a boolean.');
  });

  it('falls back by status', () => {
    expect(featuresErrorMessage(new AuthApiError('forbidden', 403))).toMatch(/permission/);
    expect(featuresErrorMessage(new AuthApiError('unauthenticated', 401))).toMatch(/expired/);
    expect(featuresErrorMessage(new AuthApiError('unexpected', 404))).toMatch(/not found/);
    expect(featuresErrorMessage(new AuthApiError('validation', 400))).toMatch(/Check the value/);
    expect(featuresErrorMessage(new AuthApiError('service-unavailable', 503))).toMatch(
      /unavailable/,
    );
    expect(featuresErrorMessage(new AuthApiError('conflict', 409))).toMatch(/conflicts/);
    expect(featuresErrorMessage(new Error('x'), 'Fallback.')).toBe('Fallback.');
  });
});
