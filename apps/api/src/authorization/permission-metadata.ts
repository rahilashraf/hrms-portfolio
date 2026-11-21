import {
  PERMISSION_CATALOG,
  type CatalogPermissionKey,
} from './authorization-catalog.js';

/**
 * Phase 20 — presentation metadata for the permission catalog: the product area a permission
 * belongs to and a short human label, for grouping permissions in the role editor. Metadata
 * only: it never changes what a permission grants. The Record type makes every catalog key
 * require an entry at compile time (and the spec checks it at run time).
 */
export const PERMISSION_AREAS = [
  'Administration',
  'People',
  'Time & attendance',
  'Scheduling',
  'Leave',
  'Pay',
  'Benefits',
  'Performance',
  'Recruitment',
  'Onboarding',
  'Documents',
  'Notifications',
  'Integrations',
  'Reporting',
] as const;

export type PermissionArea = (typeof PERMISSION_AREAS)[number];

export interface PermissionMetadata {
  area: PermissionArea;
  label: string;
}

export const PERMISSION_METADATA: Readonly<
  Record<CatalogPermissionKey, PermissionMetadata>
> = Object.freeze({
  'organization.read': { area: 'Administration', label: 'View organization' },
  'organization.manage': {
    area: 'Administration',
    label: 'Manage organization',
  },
  'organization.branding.manage': {
    area: 'Administration',
    label: 'Manage branding',
  },
  'role.read': { area: 'Administration', label: 'View roles' },
  'role.manage': { area: 'Administration', label: 'Manage roles' },
  'role.assign': { area: 'Administration', label: 'Assign roles' },
  'feature.read': { area: 'Administration', label: 'View modules & settings' },
  'feature.manage': {
    area: 'Administration',
    label: 'Manage modules & settings',
  },
  'audit.read': { area: 'Administration', label: 'View audit trail' },
  'employee.read': { area: 'People', label: 'View employees' },
  'employee.manage': { area: 'People', label: 'Manage employees' },
  'employee.account.manage': {
    area: 'People',
    label: 'Manage employee login access',
  },
  'time.clock': { area: 'Time & attendance', label: 'Use the time clock' },
  'time.view': { area: 'Time & attendance', label: 'View time records' },
  'time.approve': {
    area: 'Time & attendance',
    label: 'Approve time corrections',
  },
  'time.correct': { area: 'Time & attendance', label: 'Correct time records' },
  'time.timesheet.approve': {
    area: 'Time & attendance',
    label: 'Approve timesheets',
  },
  'time.timesheet.manage': {
    area: 'Time & attendance',
    label: 'Manage timesheets',
  },
  'time.manage_policy': {
    area: 'Time & attendance',
    label: 'Manage attendance policies',
  },
  'time.device.manage': {
    area: 'Time & attendance',
    label: 'Manage kiosk devices',
  },
  'time.credential.manage': {
    area: 'Time & attendance',
    label: 'Manage kiosk credentials',
  },
  'schedule.read': { area: 'Scheduling', label: 'View schedules' },
  'schedule.manage': { area: 'Scheduling', label: 'Manage schedules' },
  'schedule.override_conflict': {
    area: 'Scheduling',
    label: 'Override schedule conflicts',
  },
  'schedule.publish': { area: 'Scheduling', label: 'Publish schedules' },
  'schedule.manage_templates': {
    area: 'Scheduling',
    label: 'Manage shift templates',
  },
  'schedule.manage_patterns': {
    area: 'Scheduling',
    label: 'Manage recurring patterns',
  },
  'schedule.manage_policy': {
    area: 'Scheduling',
    label: 'Manage scheduling policies',
  },
  'leave.request': { area: 'Leave', label: 'Request leave' },
  'leave.read': { area: 'Leave', label: 'View leave' },
  'leave.approve': { area: 'Leave', label: 'Approve leave' },
  'leave.adjust': { area: 'Leave', label: 'Adjust leave balances' },
  'leave.manage_policy': { area: 'Leave', label: 'Manage leave policies' },
  'holiday.manage': { area: 'Leave', label: 'Manage holidays' },
  'compensation.read': { area: 'Pay', label: 'View compensation' },
  'compensation.manage': { area: 'Pay', label: 'Manage compensation' },
  'payroll.read': { area: 'Pay', label: 'View payroll' },
  'payroll.manage': { area: 'Pay', label: 'Manage payroll' },
  'payroll.calculate': { area: 'Pay', label: 'Calculate payroll' },
  'payroll.approve': { area: 'Pay', label: 'Approve payroll' },
  'payroll.finalize': { area: 'Pay', label: 'Finalize payroll' },
  'payroll.adjust': { area: 'Pay', label: 'Adjust payroll' },
  'benefit.read': { area: 'Benefits', label: 'View benefits' },
  'benefit.manage': { area: 'Benefits', label: 'Manage benefit elections' },
  'benefit.plan.manage': { area: 'Benefits', label: 'Manage benefit plans' },
  'performance.read': { area: 'Performance', label: 'View performance' },
  'performance.manage': { area: 'Performance', label: 'Manage performance' },
  'performance.template.manage': {
    area: 'Performance',
    label: 'Manage review templates',
  },
  'performance.cycle.manage': {
    area: 'Performance',
    label: 'Manage review cycles',
  },
  'performance.evidence.manage': {
    area: 'Performance',
    label: 'Manage evidence sources',
  },
  'recruitment.read': { area: 'Recruitment', label: 'View recruitment' },
  'recruitment.manage': { area: 'Recruitment', label: 'Manage recruitment' },
  'recruitment.offer.approve': {
    area: 'Recruitment',
    label: 'Approve offers',
  },
  'recruitment.hire': { area: 'Recruitment', label: 'Convert hires' },
  'recruitment.pipeline.manage': {
    area: 'Recruitment',
    label: 'Manage hiring pipeline',
  },
  'recruitment.intake.manage': {
    area: 'Recruitment',
    label: 'Manage external intake',
  },
  'onboarding.read': { area: 'Onboarding', label: 'View onboarding' },
  'onboarding.manage': { area: 'Onboarding', label: 'Manage onboarding' },
  'offboarding.read': { area: 'Onboarding', label: 'View offboarding' },
  'offboarding.manage': { area: 'Onboarding', label: 'Manage offboarding' },
  'onboarding.template.manage': {
    area: 'Onboarding',
    label: 'Manage checklists',
  },
  'document.read': { area: 'Documents', label: 'View documents' },
  'document.confidential.read': {
    area: 'Documents',
    label: 'View HR-only documents',
  },
  'document.restricted.read': {
    area: 'Documents',
    label: 'View restricted documents',
  },
  'document.manage': { area: 'Documents', label: 'Manage documents' },
  'document.type.manage': {
    area: 'Documents',
    label: 'Manage document types',
  },
  'document.policy.manage': { area: 'Documents', label: 'Manage policies' },
  'notification.template.manage': {
    area: 'Notifications',
    label: 'Manage notification templates',
  },
  'notification.settings.manage': {
    area: 'Notifications',
    label: 'Manage notification settings',
  },
  'notification.delivery.read': {
    area: 'Notifications',
    label: 'View notification delivery log',
  },
  'integration.google.manage': {
    area: 'Integrations',
    label: 'Manage Google Workspace',
  },
  'integration.google.read': {
    area: 'Integrations',
    label: 'View Google Workspace',
  },
  'report.read': { area: 'Reporting', label: 'Run reports' },
  'report.export': { area: 'Reporting', label: 'Export reports' },
});

/** Metadata of a key (unknown / retired keys get a neutral fallback, never an error). */
export function permissionMetadata(key: string): PermissionMetadata {
  const known = (PERMISSION_METADATA as Record<string, PermissionMetadata>)[
    key
  ];
  if (known) return known;
  const name = PERMISSION_CATALOG.find((p) => p.key === key)?.name;
  return { area: 'Administration', label: name ?? key };
}
