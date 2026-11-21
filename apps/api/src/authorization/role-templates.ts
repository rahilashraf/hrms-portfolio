import type { CatalogPermissionKey } from './authorization-catalog.js';

/**
 * Phase 20 — role templates: typed presets of catalog permission keys that the role editor
 * offers as a starting point. A template is never a role and never grants anything: creating
 * a role from one still goes through the existing create-role / replace-permissions APIs, with
 * their delegation rule (an administrator can only hand out permissions they hold in the
 * organization). The reserved System Owner is not a template and no template contains every
 * permission. Templates are product-neutral names, never keyed off by any code path.
 */
export const ROLE_TEMPLATE_KEYS = [
  'ORGANIZATION_ADMINISTRATOR',
  'HR_ADMINISTRATOR',
  'PAYROLL_ADMINISTRATOR',
  'PAYROLL_PREPARER',
  'PAYROLL_APPROVER',
  'TIME_ATTENDANCE_ADMINISTRATOR',
  'SCHEDULER',
  'RECRUITER',
  'MANAGER',
  'EMPLOYEE',
  'AUDITOR',
] as const;

export type RoleTemplateKey = (typeof ROLE_TEMPLATE_KEYS)[number];

export interface RoleTemplate {
  key: RoleTemplateKey;
  name: string;
  description: string;
  permissions: readonly CatalogPermissionKey[];
}

export const ROLE_TEMPLATES: readonly RoleTemplate[] = Object.freeze([
  {
    key: 'ORGANIZATION_ADMINISTRATOR',
    name: 'Organization administrator',
    description:
      'Sets up the organization: structure, branding, roles and assignments, modules and settings, notifications and the audit trail. Assign at organization scope.',
    permissions: [
      'organization.read',
      'organization.manage',
      'organization.branding.manage',
      'role.read',
      'role.manage',
      'role.assign',
      'employee.read',
      'employee.manage',
      'employee.account.manage',
      'holiday.manage',
      'feature.read',
      'feature.manage',
      'audit.read',
      'notification.template.manage',
      'notification.settings.manage',
      'notification.delivery.read',
      'integration.google.read',
      'report.read',
    ],
  },
  {
    key: 'HR_ADMINISTRATOR',
    name: 'HR administrator',
    description:
      'Runs core HR: employee records, leave, benefits, performance, onboarding and offboarding, and employee documents.',
    permissions: [
      'organization.read',
      'employee.read',
      'employee.manage',
      'employee.account.manage',
      'leave.read',
      'leave.approve',
      'leave.adjust',
      'leave.manage_policy',
      'holiday.manage',
      'compensation.read',
      'benefit.read',
      'benefit.manage',
      'benefit.plan.manage',
      'performance.read',
      'performance.manage',
      'performance.template.manage',
      'performance.cycle.manage',
      'onboarding.read',
      'onboarding.manage',
      'offboarding.read',
      'offboarding.manage',
      'onboarding.template.manage',
      'document.read',
      'document.confidential.read',
      'document.manage',
      'document.type.manage',
      'document.policy.manage',
      'report.read',
      'report.export',
    ],
  },
  {
    key: 'PAYROLL_ADMINISTRATOR',
    name: 'Payroll administrator',
    description:
      'Prepares, calculates, approves and finalizes payroll, and maintains compensation and pay groups. Assign at organization scope (payroll is organization-level).',
    permissions: [
      'organization.read',
      'employee.read',
      'compensation.read',
      'compensation.manage',
      'payroll.read',
      'payroll.manage',
      'payroll.calculate',
      'payroll.approve',
      'payroll.finalize',
      'payroll.adjust',
      'benefit.read',
      'time.view',
      'leave.read',
      'report.read',
      'report.export',
    ],
  },
  // Security remediation M2: a maker-checker split. Dual control is enforced on the person, not
  // on these templates — someone holding both (or the administrator template) is still refused
  // approval of payroll they prepared.
  {
    key: 'PAYROLL_PREPARER',
    name: 'Payroll preparer',
    description:
      'Prepares payroll: maintains compensation, adds adjustments, creates and calculates runs. Cannot approve or finalize. Assign at organization scope.',
    permissions: [
      'organization.read',
      'employee.read',
      'compensation.read',
      'compensation.manage',
      'payroll.read',
      'payroll.manage',
      'payroll.calculate',
      'payroll.adjust',
      'benefit.read',
      'time.view',
      'leave.read',
    ],
  },
  {
    key: 'PAYROLL_APPROVER',
    name: 'Payroll approver',
    description:
      'Reviews, approves and finalizes payroll prepared by someone else. Cannot change compensation, add adjustments or calculate. Assign at organization scope.',
    permissions: [
      'organization.read',
      'employee.read',
      'compensation.read',
      'payroll.read',
      'payroll.approve',
      'payroll.finalize',
      'report.read',
    ],
  },
  {
    key: 'TIME_ATTENDANCE_ADMINISTRATOR',
    name: 'Time & attendance administrator',
    description:
      'Maintains attendance policies, kiosks and credentials, and reviews time records, corrections and timesheets.',
    permissions: [
      'organization.read',
      'employee.read',
      'time.view',
      'time.approve',
      'time.correct',
      'time.timesheet.approve',
      'time.timesheet.manage',
      'time.manage_policy',
      'time.device.manage',
      'time.credential.manage',
      'schedule.read',
      'report.read',
    ],
  },
  {
    key: 'SCHEDULER',
    name: 'Scheduler',
    description:
      'Builds and publishes schedules, shift templates and recurring patterns.',
    permissions: [
      'employee.read',
      // Business units, departments, teams and work locations for scheduling pickers.
      'organization.read',
      'schedule.read',
      'schedule.manage',
      'schedule.publish',
      'schedule.manage_templates',
      'schedule.manage_patterns',
      'time.view',
    ],
  },
  {
    key: 'RECRUITER',
    name: 'Recruiter',
    description:
      'Manages job openings, candidates, applications, interviews and external intake.',
    permissions: [
      'recruitment.read',
      'recruitment.manage',
      'recruitment.pipeline.manage',
      'recruitment.intake.manage',
    ],
  },
  {
    key: 'MANAGER',
    name: 'Manager',
    description:
      'Day-to-day team management: sees the team, approves leave, time corrections and timesheets, and reads schedules and performance. Assign at the team, department or unit the person manages.',
    permissions: [
      'employee.read',
      'time.view',
      'time.approve',
      'time.timesheet.approve',
      'schedule.read',
      'leave.read',
      'leave.approve',
      'performance.read',
    ],
  },
  {
    key: 'EMPLOYEE',
    name: 'Employee',
    description:
      'Self-service only: clock in and out and request leave. Everything else an employee sees about themselves needs no permission.',
    permissions: ['time.clock', 'leave.request'],
  },
  {
    key: 'AUDITOR',
    name: 'Auditor',
    description:
      'Read-only access for reviews and audits: records, reports and the audit trail, with no ability to change anything.',
    permissions: [
      'organization.read',
      'role.read',
      'employee.read',
      'feature.read',
      'audit.read',
      'time.view',
      'schedule.read',
      'leave.read',
      'compensation.read',
      'payroll.read',
      'benefit.read',
      'performance.read',
      'recruitment.read',
      'onboarding.read',
      'offboarding.read',
      'document.read',
      'integration.google.read',
      'report.read',
    ],
  },
] satisfies readonly RoleTemplate[]);
