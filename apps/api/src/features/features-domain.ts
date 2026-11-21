import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { domainError } from '../common/domain-support.js';
import type { OrganizationModule } from '../generated/prisma/client.js';

/**
 * Phase 18 — per-organization feature management: the module catalog with its genuine
 * dependencies, and the registry of typed organization settings. Pure rules only.
 *
 * Absence of a row is always the current behaviour: every module is enabled and every setting
 * holds its registry default until an administrator changes it. Core HR (organization
 * structure, employees, employment assignments, users / roles / authentication, audit) is not
 * a module and can never be disabled.
 */

export const ORGANIZATION_MODULES = [
  'ATTENDANCE',
  'SCHEDULING',
  'LEAVE',
  'COMPENSATION',
  'PAYROLL',
  'BENEFITS',
  'PERFORMANCE',
  'RECRUITMENT',
  'ONBOARDING',
  'DOCUMENTS',
  'NOTIFICATIONS',
  'GOOGLE_WORKSPACE',
  'REPORTING',
] as const satisfies readonly OrganizationModule[];

export type FeatureModule = (typeof ORGANIZATION_MODULES)[number];

export interface ModuleDefinition {
  module: FeatureModule;
  name: string;
  description: string;
  /** Modules this one cannot work without (validated on every change). */
  requires: readonly FeatureModule[];
}

/**
 * Only dependencies that exist in the code:
 * - PAYROLL → COMPENSATION: pay groups, pay-group membership and pay facts live in
 *   Compensation (PayrollCompensationSource); a payroll calendar is a pay group's.
 * - PAYROLL → ATTENDANCE: every payroll period is bound to a Time period, payroll preparation
 *   materializes timesheets through Time and approved time is the hours source.
 * Payroll reads leave and benefit facts when present, but works without them (no dependency);
 * Benefits flags a sponsor not on payroll but never needs Payroll; Onboarding uses Documents
 * only for document-backed tasks (optional contract); Google Workspace and Reporting feed or
 * read the other modules through their own gates.
 */
export const MODULE_DEFINITIONS: Readonly<
  Record<FeatureModule, ModuleDefinition>
> = Object.freeze({
  ATTENDANCE: {
    module: 'ATTENDANCE',
    name: 'Time & attendance',
    description:
      'Clock in/out, breaks, timesheets, corrections, attendance policies, kiosks and sign-ins.',
    requires: [],
  },
  SCHEDULING: {
    module: 'SCHEDULING',
    name: 'Scheduling',
    description:
      'Schedules, shifts, templates, recurring patterns, schedule policies and shift generation.',
    requires: [],
  },
  LEAVE: {
    module: 'LEAVE',
    name: 'Leave',
    description:
      'Leave types, policies, balances and ledger, requests and the entitlement job.',
    requires: [],
  },
  COMPENSATION: {
    module: 'COMPENSATION',
    name: 'Compensation',
    description: 'Pay groups and effective-dated compensation records.',
    requires: [],
  },
  PAYROLL: {
    module: 'PAYROLL',
    name: 'Payroll',
    description:
      'Payroll calendars, periods, runs, adjustments, payslips and period preparation.',
    requires: ['COMPENSATION', 'ATTENDANCE'],
  },
  BENEFITS: {
    module: 'BENEFITS',
    name: 'Benefits',
    description:
      'Benefit plans, rates, eligibility, dependents and elections (payroll deductions are read by Payroll).',
    requires: [],
  },
  PERFORMANCE: {
    module: 'PERFORMANCE',
    name: 'Performance',
    description:
      'Performance configuration, cycles, reviews, goals, evidence and reminders.',
    requires: [],
  },
  RECRUITMENT: {
    module: 'RECRUITMENT',
    name: 'Recruitment',
    description:
      'Job openings, candidates, applications, interviews, offers, hires, external intake and reminders.',
    requires: [],
  },
  ONBOARDING: {
    module: 'ONBOARDING',
    name: 'Onboarding & offboarding',
    description:
      'Onboarding and offboarding checklists, workflows, tasks and task reminders.',
    requires: [],
  },
  DOCUMENTS: {
    module: 'DOCUMENTS',
    name: 'Documents',
    description:
      'Document types and requirements, employee records, policy documents and acknowledgements, expiry reminders and reference checks.',
    requires: [],
  },
  NOTIFICATIONS: {
    module: 'NOTIFICATIONS',
    name: 'Email notifications',
    description:
      'Email delivery of notifications, organization email settings and templates. When disabled no email is sent for the organization; in-app notices (including mandatory SECURITY and HR_REQUIRED ones) are still recorded and readable.',
    requires: [],
  },
  GOOGLE_WORKSPACE: {
    module: 'GOOGLE_WORKSPACE',
    name: 'Google Workspace',
    description:
      'The Google Workspace connection, form bindings and synchronization, Drive reference checks, Gmail delivery and Sheets export.',
    requires: [],
  },
  REPORTING: {
    module: 'REPORTING',
    name: 'Reporting',
    description:
      'The Reporting area (reports of disabled source modules are always omitted).',
    requires: [],
  },
});

/** Modules that directly require `module`. */
export function dependentsOf(module: FeatureModule): FeatureModule[] {
  return ORGANIZATION_MODULES.filter((candidate) =>
    MODULE_DEFINITIONS[candidate].requires.includes(module),
  );
}

export function isOrganizationModule(value: unknown): value is FeatureModule {
  return (ORGANIZATION_MODULES as readonly unknown[]).includes(value);
}

/**
 * Validates a module change against the organization's resulting state: enabling needs every
 * required module enabled; disabling is refused while an enabled module depends on it.
 */
export function moduleChangeProblem(
  module: FeatureModule,
  enabled: boolean,
  state: (module: FeatureModule) => boolean,
):
  | { code: 'FEATURE_DEPENDENCY_DISABLED'; modules: FeatureModule[] }
  | { code: 'FEATURE_DEPENDENTS_ENABLED'; modules: FeatureModule[] }
  | null {
  if (enabled) {
    const missing = MODULE_DEFINITIONS[module].requires.filter(
      (required) => !state(required),
    );
    return missing.length
      ? { code: 'FEATURE_DEPENDENCY_DISABLED', modules: missing }
      : null;
  }
  const dependents = dependentsOf(module).filter((dependent) =>
    state(dependent),
  );
  return dependents.length
    ? { code: 'FEATURE_DEPENDENTS_ENABLED', modules: dependents }
    : null;
}

// ─── Typed settings registry ──────────────────────────────────────────────────

export type SettingType =
  | { kind: 'boolean' }
  | {
      kind: 'integer';
      min: number;
      max: number;
      /**
       * Phase 19: 0 means "off" and any other value must be at least this (e.g. a retention
       * period has a hard minimum, re-checked by the database triggers).
       */
      minWhenEnabled?: number;
    }
  | { kind: 'enum'; values: readonly string[] };

export type SettingValue = boolean | number | string;

/**
 * The admin area's section of a setting: the module whose behaviour it tunes, or CORE for
 * core HR behaviour that is never a module (e.g. audit log retention).
 */
export type SettingSection = FeatureModule | 'CORE';

export interface SettingDefinition {
  key: string;
  /** The module whose behaviour the setting tunes (the admin area's section). */
  module: SettingSection;
  type: SettingType;
  /** The current (pre-Phase 18) behaviour. */
  default: SettingValue;
  /** Bumped when the key's type or meaning changes; stored with every value. */
  schemaVersion: number;
  name: string;
  description: string;
}

export const SETTING_KEY_PATTERN = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/;

const bool = (
  key: string,
  module: FeatureModule,
  name: string,
  description: string,
): SettingDefinition => ({
  key,
  module,
  type: { kind: 'boolean' },
  default: true,
  schemaVersion: 1,
  name,
  description,
});

const retentionMonths = (
  key: string,
  module: SettingSection,
  minimum: number,
  max: number,
  name: string,
  description: string,
): SettingDefinition => ({
  key,
  module,
  type: { kind: 'integer', min: 0, max, minWhenEnabled: minimum },
  default: 0,
  schemaVersion: 1,
  name,
  description,
});

/**
 * Phase 19 — data retention periods in months (0 = off, the default: nothing is ever purged or
 * anonymized unless an organization opts in). The minimums are hard floors, enforced again by
 * the database triggers (prisma/migrations/20270126090000_phase19_data_hardening).
 */
export const RETENTION_MINIMUM_MONTHS = Object.freeze({
  'retention.rejectedCandidateMonths': 6,
  'retention.notificationMonths': 3,
  'retention.deliveryLogMonths': 3,
  'retention.syncLogMonths': 3,
  'retention.auditLogMonths': 24,
} as const);

export type RetentionSettingKey = keyof typeof RETENTION_MINIMUM_MONTHS;

/**
 * Every setting maps to behaviour that exists in the code. Time & attendance behaviour (self
 * clock in/out, kiosk capture, breaks, missed clock-out, thresholds, sign-in mode) stays in
 * the effective-dated TimeAttendancePolicy layers, and notification email defaults stay in the
 * organization notification settings: both are linked sections of the admin view, never
 * copied here.
 */
export const SETTING_DEFINITIONS: readonly SettingDefinition[] = Object.freeze([
  bool(
    'documents.selfServiceProvide',
    'DOCUMENTS',
    'Employees provide documents',
    'Employees may provide (and version) their own documents of employee-provided types through self-service.',
  ),
  bool(
    'onboarding.employeeTaskCompletion',
    'ONBOARDING',
    'Employees complete their own tasks',
    'Employees may start and complete the onboarding / offboarding tasks they own through self-service (HR may always complete tasks on their behalf; acknowledgements stay the employee’s own act).',
  ),
  bool(
    'performance.selfReview',
    'PERFORMANCE',
    'Self reviews',
    'Performance cycles may include an employee self review. When off, new and draft cycles cannot enable self reviews (they default to none); launched cycles keep what they were launched with.',
  ),
  bool(
    'payroll.dualControl',
    'PAYROLL',
    'Payroll dual control',
    'Two-person payroll: whoever calculates a run, adds one of its adjustments or changed compensation it pays cannot approve it, and the calculator cannot finalize it. Only a System administrator may turn it off, with a reason; it is on by default.',
  ),
  bool(
    'recruitment.externalIntake',
    'RECRUITMENT',
    'External application intake',
    'Applications from external intake sources (e.g. Google Forms) are ingested. When off, the intake contract and its synchronization refuse for the organization.',
  ),
  bool(
    'google.sync.performanceEvidence',
    'GOOGLE_WORKSPACE',
    'Sync performance evidence forms',
    'Google Forms bound to performance evidence sources are synchronized.',
  ),
  bool(
    'google.sync.recruitmentIntake',
    'GOOGLE_WORKSPACE',
    'Sync recruitment intake forms',
    'Google Forms bound to recruitment intake sources are synchronized.',
  ),
  bool(
    'google.sync.onboardingTasks',
    'GOOGLE_WORKSPACE',
    'Sync onboarding task forms',
    'Google Forms bound to onboarding tasks are synchronized.',
  ),
  bool(
    'google.drive.verify',
    'GOOGLE_WORKSPACE',
    'Verify Google Drive references',
    'The daily reference check verifies that employee documents stored as Google Drive references still resolve.',
  ),
  retentionMonths(
    'retention.rejectedCandidateMonths',
    'RECRUITMENT',
    RETENTION_MINIMUM_MONTHS['retention.rejectedCandidateMonths'],
    120,
    'Anonymize unsuccessful candidates after (months)',
    'Candidates never hired whose applications were all rejected or withdrawn, with no change for this many months, are anonymized: name, contact details, notes, document links, intake answers and free-text feedback are redacted; applications, stages, offers and interviews stay for reporting. Internal (employee) candidates are never anonymized. 0 = off; otherwise at least 6.',
  ),
  retentionMonths(
    'retention.notificationMonths',
    'NOTIFICATIONS',
    RETENTION_MINIMUM_MONTHS['retention.notificationMonths'],
    120,
    'Delete read notifications after (months)',
    'Read or archived in-app notifications older than this, with their finished email deliveries, are deleted. Unread notifications are never deleted. 0 = off; otherwise at least 3.',
  ),
  retentionMonths(
    'retention.deliveryLogMonths',
    'NOTIFICATIONS',
    RETENTION_MINIMUM_MONTHS['retention.deliveryLogMonths'],
    120,
    'Delete email delivery attempt logs after (months)',
    'Finished email delivery attempts (provider references and error details) older than this are deleted; each delivery keeps its status and attempt count. 0 = off; otherwise at least 3.',
  ),
  retentionMonths(
    'retention.syncLogMonths',
    'GOOGLE_WORKSPACE',
    RETENTION_MINIMUM_MONTHS['retention.syncLogMonths'],
    120,
    'Delete Google synchronization run logs after (months)',
    'Finished Google Forms synchronization runs (counts and error codes) older than this are deleted. 0 = off; otherwise at least 3.',
  ),
  retentionMonths(
    'retention.auditLogMonths',
    'CORE',
    RETENTION_MINIMUM_MONTHS['retention.auditLogMonths'],
    240,
    'Delete audit log entries after (months)',
    'Audit entries recorded for this organization older than this are deleted. Entries not tied to an organization (sign-in and account events) are never deleted by this setting. 0 = off; otherwise at least 24.',
  ),
]);

export const SETTING_KEYS = SETTING_DEFINITIONS.map((d) => d.key);
export type SettingKey =
  | 'documents.selfServiceProvide'
  | 'onboarding.employeeTaskCompletion'
  | 'performance.selfReview'
  | 'recruitment.externalIntake'
  | 'payroll.dualControl'
  | 'google.sync.performanceEvidence'
  | 'google.sync.recruitmentIntake'
  | 'google.sync.onboardingTasks'
  | 'google.drive.verify'
  | RetentionSettingKey;

/** Registry consistency (unit-tested): unique well-formed keys, defaults valid for their type. */
export function registryProblems(
  definitions: readonly SettingDefinition[] = SETTING_DEFINITIONS,
): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const definition of definitions) {
    if (
      !SETTING_KEY_PATTERN.test(definition.key) ||
      definition.key.length > 100
    )
      problems.push(`${definition.key}: malformed key`);
    if (seen.has(definition.key)) problems.push(`${definition.key}: duplicate`);
    seen.add(definition.key);
    if (
      definition.module !== 'CORE' &&
      !isOrganizationModule(definition.module)
    )
      problems.push(`${definition.key}: unknown module`);
    if (
      !Number.isInteger(definition.schemaVersion) ||
      definition.schemaVersion < 1
    )
      problems.push(`${definition.key}: invalid schemaVersion`);
    if (
      definition.type.kind === 'integer' &&
      (!Number.isInteger(definition.type.min) ||
        !Number.isInteger(definition.type.max) ||
        definition.type.min > definition.type.max)
    )
      problems.push(`${definition.key}: invalid bounds`);
    if (
      definition.type.kind === 'integer' &&
      definition.type.minWhenEnabled !== undefined &&
      (!Number.isInteger(definition.type.minWhenEnabled) ||
        definition.type.min !== 0 ||
        definition.type.minWhenEnabled < 1 ||
        definition.type.minWhenEnabled > definition.type.max)
    )
      problems.push(`${definition.key}: invalid minWhenEnabled`);
    if (
      definition.type.kind === 'enum' &&
      (definition.type.values.length === 0 ||
        new Set(definition.type.values).size !== definition.type.values.length)
    )
      problems.push(`${definition.key}: invalid values`);
    if (settingValueProblem(definition.type, definition.default))
      problems.push(`${definition.key}: invalid default`);
  }
  return problems;
}

export function settingDefinition(
  key: string,
  definitions: readonly SettingDefinition[] = SETTING_DEFINITIONS,
): SettingDefinition | undefined {
  return definitions.find((definition) => definition.key === key);
}

/** Why a value does not fit a type (null when it fits). Strict: no coercion. */
export function settingValueProblem(
  type: SettingType,
  value: unknown,
): string | null {
  switch (type.kind) {
    case 'boolean':
      return typeof value === 'boolean' ? null : 'must be a boolean';
    case 'integer':
      if (typeof value !== 'number' || !Number.isInteger(value))
        return 'must be an integer';
      if (value < type.min || value > type.max)
        return `must be from ${type.min} to ${type.max}`;
      return type.minWhenEnabled !== undefined &&
        value !== 0 &&
        value < type.minWhenEnabled
        ? `must be 0 (off) or from ${type.minWhenEnabled} to ${type.max}`
        : null;
    case 'enum':
      return typeof value === 'string' && type.values.includes(value)
        ? null
        : `must be one of ${type.values.join(', ')}`;
  }
}

/** The validated value (400 SETTING_VALUE_INVALID otherwise). */
export function validateSettingValue(
  definition: SettingDefinition,
  value: unknown,
): SettingValue {
  const problem = settingValueProblem(definition.type, value);
  if (problem) {
    throw new BadRequestException(
      domainError(
        400,
        'SETTING_VALUE_INVALID',
        `${definition.key} ${problem}.`,
        { key: definition.key },
      ),
    );
  }
  return value as SettingValue;
}

/**
 * The effective value of a stored row: the registry default when there is no row, the row was
 * reset (NULL), or it was written under another schema version or no longer fits the type
 * (never trusted blindly).
 */
export function effectiveSettingValue(
  definition: SettingDefinition,
  row: { value: unknown; schemaVersion: number } | null | undefined,
): { value: SettingValue; isDefault: boolean } {
  if (
    !row ||
    row.value === null ||
    row.value === undefined ||
    row.schemaVersion !== definition.schemaVersion ||
    settingValueProblem(definition.type, row.value)
  )
    return { value: definition.default, isDefault: true };
  return { value: row.value as SettingValue, isDefault: false };
}

// ─── Errors ──────────────────────────────────────────────────────────────────

/** 403 { code: 'FEATURE_DISABLED', module } — the shape every gated entry point returns. */
export function featureDisabled(module: FeatureModule) {
  return new ForbiddenException(
    domainError(
      403,
      'FEATURE_DISABLED',
      `${MODULE_DEFINITIONS[module].name} is disabled for this organization.`,
      { module },
    ),
  );
}

/** 403 { code: 'SETTING_DISABLED', key } — a self-service or sync setting is turned off. */
export function settingDisabled(key: SettingKey) {
  return new ForbiddenException(
    domainError(
      403,
      'SETTING_DISABLED',
      `This is turned off for the organization (${key}).`,
      { key },
    ),
  );
}
