import { rateLimitedMessage } from '../auth/error-message';
import { AuthApiError } from '../auth/types';
import type { FeatureModule } from './types';

/** Display names of the modules (the API's registry names). */
export const MODULE_LABELS: Readonly<Record<FeatureModule, string>> = {
  ATTENDANCE: 'Time & attendance',
  SCHEDULING: 'Scheduling',
  LEAVE: 'Leave',
  COMPENSATION: 'Compensation',
  PAYROLL: 'Payroll',
  BENEFITS: 'Benefits',
  PERFORMANCE: 'Performance',
  RECRUITMENT: 'Recruitment',
  ONBOARDING: 'Onboarding & offboarding',
  DOCUMENTS: 'Documents',
  NOTIFICATIONS: 'Email notifications',
  GOOGLE_WORKSPACE: 'Google Workspace',
  REPORTING: 'Reporting',
};

export function moduleLabel(module: string): string {
  return (MODULE_LABELS as Record<string, string>)[module] ?? module;
}

export function moduleList(modules: readonly string[]): string {
  return modules.map(moduleLabel).join(', ');
}

// ─── Disabled features across the app ─────────────────────────────────────────

export const FEATURE_DISABLED_MESSAGE = 'This feature is turned off for your organization.';
export const SETTING_DISABLED_MESSAGE = 'This option is turned off for your organization.';

export type FeatureDisabledInfo =
  { kind: 'module'; module: string | null } | { kind: 'setting'; key: string | null };

/**
 * Whether an API error is a 403 refusal because a module (FEATURE_DISABLED) or a self-service /
 * sync setting (SETTING_DISABLED) is turned off for the organization.
 *
 * The code is read from the error body when the client kept it. NOTE: the shared JSON client
 * (lib/auth/api-client) does not read 403 bodies today, so ordinary requests surface a plain
 * 403; only requests that keep every body (e.g. the reporting CSV export) are recognized.
 */
export function featureDisabledInfo(error: unknown): FeatureDisabledInfo | null {
  if (!(error instanceof AuthApiError) || error.status !== 403) return null;
  const code = error.details?.code;
  if (code === 'FEATURE_DISABLED') {
    const moduleName = error.details?.module;
    return { kind: 'module', module: typeof moduleName === 'string' ? moduleName : null };
  }
  if (code === 'SETTING_DISABLED') {
    const key = error.details?.key;
    return { kind: 'setting', key: typeof key === 'string' ? key : null };
  }
  return null;
}

export function isFeatureDisabled(error: unknown): boolean {
  return featureDisabledInfo(error) !== null;
}

/**
 * The message for a disabled module / setting refusal, or null for any other error. Domain error
 * helpers call this first so every area explains a switched-off feature the same way.
 */
export function featureDisabledMessage(error: unknown): string | null {
  const info = featureDisabledInfo(error);
  if (!info) return null;
  if (info.kind === 'setting') return SETTING_DISABLED_MESSAGE;
  if (info.module && info.module in MODULE_LABELS) {
    return `${moduleLabel(info.module)} is turned off for your organization.`;
  }
  return FEATURE_DISABLED_MESSAGE;
}

/**
 * The message every area shows the same way, or null: a switched-off module / setting, then a
 * rate-limit refusal (429 RATE_LIMITED). Domain error helpers call this first.
 */
export function sharedErrorMessage(error: unknown): string | null {
  return featureDisabledMessage(error) ?? rateLimitedMessage(error);
}

// ─── Feature administration errors ──────────────────────────────────────────

/** The domain error code of a features administration error (400/409 bodies are kept). */
export function featuresErrorCode(error: unknown): string | null {
  if (!(error instanceof AuthApiError)) return null;
  const code = error.details?.code;
  return typeof code === 'string' ? code : null;
}

/** An optimistic-concurrency refusal: the configuration changed since it was loaded. */
export function isFeatureVersionConflict(error: unknown): boolean {
  return featuresErrorCode(error) === 'FEATURE_VERSION_CONFLICT';
}

function detailModules(error: AuthApiError, field: string): string[] {
  const value = error.details?.[field];
  return Array.isArray(value) ? value.filter((m): m is string => typeof m === 'string') : [];
}

export function featuresErrorMessage(
  error: unknown,
  fallback = 'Unable to load the organization settings.',
): string {
  const shared = sharedErrorMessage(error);
  if (shared) return shared;
  if (!(error instanceof AuthApiError)) return fallback;
  switch (featuresErrorCode(error)) {
    case 'FEATURE_VERSION_CONFLICT':
      return 'Someone else changed this configuration since it was loaded. The latest settings were reloaded; review them and try again.';
    case 'FEATURE_DEPENDENTS_ENABLED': {
      const dependents = detailModules(error, 'dependents');
      return dependents.length
        ? `This module cannot be turned off while ${moduleList(dependents)} ${dependents.length > 1 ? 'depend' : 'depends'} on it. Turn ${dependents.length > 1 ? 'them' : 'it'} off first.`
        : error.validationMessage || 'Other enabled modules depend on this module.';
    }
    case 'FEATURE_DEPENDENCY_DISABLED': {
      const requires = detailModules(error, 'requires');
      return requires.length
        ? `This module requires ${moduleList(requires)}. Turn ${requires.length > 1 ? 'them' : 'it'} on first.`
        : error.validationMessage || 'A module this one requires is turned off.';
    }
    case 'FEATURE_MODULE_UNKNOWN':
      return 'This module is not known. Reload the page.';
    case 'SETTING_UNKNOWN':
      return 'This setting is not known. Reload the page.';
    case 'SETTING_VALUE_INVALID':
      return error.validationMessage || 'The value is not valid for this setting.';
  }
  if (error.status === 401) return 'Your session has expired. Please sign in again.';
  if (error.status === 403) return 'You do not have permission to manage features.';
  if (error.status === 404) return 'The organization was not found.';
  if (error.status === 409) {
    return (
      error.validationMessage ||
      'This change conflicts with the current state. Reload and try again.'
    );
  }
  if (error.status === 400) return error.validationMessage || 'Check the value and try again.';
  if (error.status >= 500) return 'The settings service is unavailable. Please try again.';
  return fallback;
}
