export const PERMISSION_CATALOG = [
  {
    key: 'organization.read',
    name: 'Read organization',
    description: 'View organization structure and details.',
  },
  {
    key: 'organization.manage',
    name: 'Manage organization',
    description: 'Create, update, archive, and reactivate organization data.',
  },
  {
    key: 'organization.branding.manage',
    name: 'Manage organization branding',
    description:
      "Change an organization's branding (display name, logo and icon references, colors, login page text) and whether it is shown on the public login page; every change is audited. Never grants access to any domain data. Granted only at organization scope.",
  },
  {
    key: 'role.read',
    name: 'Read roles',
    description: 'View roles, permissions, and assignments.',
  },
  {
    key: 'role.manage',
    name: 'Manage roles',
    description: 'Create, update, archive, and reactivate configurable roles.',
  },
  {
    key: 'role.assign',
    name: 'Assign roles',
    description: 'Create and revoke scoped role assignments.',
  },
  {
    key: 'employee.read',
    name: 'Read employees',
    description:
      'View employee directory and profiles within authorized scopes.',
  },
  {
    key: 'employee.manage',
    name: 'Manage employees',
    description:
      'Create, update, assign, terminate, and rehire employees within authorized scopes.',
  },
  {
    key: 'employee.account.manage',
    name: 'Manage employee login access',
    description:
      "Invite employees to their personal HRMS login (linked to their existing record, activated by the employee's own password), resend or cancel invitations, disable or re-enable login access, require a password change, sign the login out, email a password reset link and lift a temporary lock, within authorized scopes. Never sets or reveals a password and never grants any role or permission; kiosk PINs are unaffected.",
  },
  {
    key: 'time.clock',
    name: 'Use employee time clock',
    description:
      'Clock in, clock out, and switch assignments for the authenticated employee within authorized scopes.',
  },
  {
    key: 'time.view',
    name: 'View time records',
    description:
      'View time and attendance records, exceptions, and operational summaries within authorized scopes.',
  },
  {
    key: 'time.approve',
    name: 'Approve time corrections',
    description:
      'Approve and reject employee time correction requests within authorized scopes.',
  },
  {
    key: 'time.correct',
    name: 'Correct time records',
    description:
      'Directly apply time and attendance corrections within authorized scopes.',
  },
  {
    key: 'time.timesheet.approve',
    name: 'Approve timesheet segments',
    description:
      'Approve and request changes for assignment-scoped timesheet segments.',
  },
  {
    key: 'time.timesheet.manage',
    name: 'Manage timesheets',
    description:
      'Generate periods, lock timesheets, and reopen approved or locked timesheets within authorized scopes.',
  },
  {
    key: 'time.manage_policy',
    name: 'Manage time policies',
    description:
      'Create, end, and withdraw effective-dated time and attendance policies, including attendance tracking and capture modes, within authorized scopes.',
  },
  {
    key: 'time.device.manage',
    name: 'Manage attendance kiosks',
    description:
      'Register, enroll, disable, rotate, and revoke trusted onsite attendance devices of an organization. Highly sensitive: a device records attendance on behalf of employees.',
  },
  {
    key: 'time.credential.manage',
    name: 'Manage attendance PINs',
    description:
      "Issue, reset, and revoke employees' kiosk attendance credentials within authorized scopes. Never reveals an existing credential.",
  },
  {
    key: 'schedule.read',
    name: 'Read schedules',
    description:
      'View schedules and scheduled shifts within authorized scopes.',
  },
  {
    key: 'schedule.manage',
    name: 'Manage schedules',
    description:
      'Create, update, and delete draft schedules and their one-off shifts within authorized scopes.',
  },
  {
    key: 'schedule.override_conflict',
    name: 'Override schedule conflicts',
    description:
      'Accept overrideable scheduling conflict warnings, with a recorded reason, within authorized scopes. Requires schedule.manage as well.',
  },
  {
    key: 'schedule.publish',
    name: 'Publish schedules',
    description:
      'Publish draft schedules and make revision-recorded corrections, additions, and cancellations to published shifts within authorized scopes. Requires schedule.manage as well.',
  },
  {
    key: 'schedule.manage_templates',
    name: 'Manage schedule templates',
    description:
      'Create, edit, archive, and delete reusable organization-level schedule templates and their recurring rules.',
  },
  {
    key: 'schedule.manage_patterns',
    name: 'Manage schedule patterns',
    description:
      'Create, apply templates to, edit before they start, and end effective-dated recurring schedule patterns for employment assignments within authorized scopes.',
  },
  {
    key: 'schedule.manage_policy',
    name: 'Manage scheduling policy',
    description:
      'Create, edit before they take effect, end, and delete effective-dated scheduling policies for organizational scopes within authorized scopes.',
  },
  {
    key: 'leave.request',
    name: 'Request leave',
    description:
      'Submit and cancel leave requests for the authenticated employee within authorized scopes.',
  },
  {
    key: 'leave.read',
    name: 'Read leave',
    description:
      'View leave requests, balances, ledger history, and the absence calendar within authorized scopes.',
  },
  {
    key: 'leave.approve',
    name: 'Approve leave',
    description:
      'Approve, reject, cancel, and shorten leave requests and record leave on behalf of employees within authorized scopes. Never for oneself.',
  },
  {
    key: 'leave.adjust',
    name: 'Adjust leave balances',
    description:
      'Post manual leave balance adjustments and reversals, each with a recorded reason, within authorized scopes.',
  },
  {
    key: 'leave.manage_policy',
    name: 'Manage leave configuration',
    description:
      'Create and maintain organization leave types and effective-dated leave policies within authorized scopes.',
  },
  {
    key: 'holiday.manage',
    name: 'Manage holidays and closures',
    description:
      'Create, edit, and archive organization holidays and closures within authorized scopes.',
  },
  {
    key: 'compensation.read',
    name: 'Read compensation',
    description:
      'View pay basis, rates, salaries, pay groups, and compensation history of employment assignments within authorized scopes. Sensitive: never implied by employee.read or by managing an employee.',
  },
  {
    key: 'compensation.manage',
    name: 'Manage compensation',
    description:
      "Record initial compensation, effective-dated changes, corrections, and period ends for employment assignments, and administer organization pay groups, within authorized scopes. Never one's own compensation.",
  },
  {
    key: 'payroll.read',
    name: 'Read payroll',
    description:
      "View an organization's payroll calendars, periods, runs, validation results, and payroll results. Highly sensitive: granted only explicitly at organization scope, never implied by employee.read, compensation.read, or managing employees.",
  },
  {
    key: 'payroll.manage',
    name: 'Manage payroll configuration',
    description:
      "Administer an organization's payroll calendars and payroll periods, and create payroll runs. Sensitive: grants no pay-result access by itself beyond payroll.read.",
  },
  {
    key: 'payroll.calculate',
    name: 'Calculate payroll',
    description:
      "Calculate and recalculate an organization's draft payroll runs from approved source facts. Sensitive: never rewrites Time, Compensation, Leave, or Scheduling.",
  },
  {
    key: 'payroll.approve',
    name: 'Approve payroll',
    description:
      "Review and approve an organization's calculated payroll runs before finalization. Sensitive.",
  },
  {
    key: 'payroll.finalize',
    name: 'Finalize payroll',
    description:
      "Finalize an organization's approved payroll runs. Finalized payroll is immutable; later source changes become adjustments. Highly sensitive.",
  },
  {
    key: 'payroll.adjust',
    name: 'Adjust payroll',
    description:
      "Add manual earning, deduction and employer-contribution lines to an organization's unapproved payroll runs, and create or cancel payroll adjustments (including retroactive corrections of finalized payroll). Highly sensitive: changes what employees are paid.",
  },
  {
    key: 'benefit.read',
    name: 'Read benefits',
    description:
      "View employees' benefit elections, eligibility and covered dependents within scope. Sensitive: never implied by employee.read, compensation access, payroll access, or managing employees.",
  },
  {
    key: 'benefit.manage',
    name: 'Manage benefits',
    description:
      "Record, change, waive, end and correct employees' benefit elections and maintain their dependents within scope. Sensitive: never one's own benefits.",
  },
  {
    key: 'benefit.plan.manage',
    name: 'Manage benefit plans',
    description:
      "Configure an organization's benefit plans, coverage options, effective-dated rates and eligibility rules. Sensitive: granted only at organization scope.",
  },
  {
    key: 'performance.read',
    name: 'Read performance',
    description:
      "View employees' performance reviews, goals and performance evidence within scope. Sensitive: never implied by employee.read, managing employees, a reporting line, compensation, payroll or benefits access.",
  },
  {
    key: 'performance.manage',
    name: 'Manage performance',
    description:
      "Assign and reassign reviewers, complete HR reviews, reopen, finalize, correct and close reviews, and manage goals within scope. Sensitive: never one's own performance records.",
  },
  {
    key: 'performance.template.manage',
    name: 'Manage performance templates',
    description:
      "Configure an organization's competencies, rating scales and review templates. Sensitive: granted only at organization scope.",
  },
  {
    key: 'performance.cycle.manage',
    name: 'Manage review cycles',
    description:
      "Create, open, close and archive an organization's review cycles and choose who is reviewed. Sensitive: granted only at organization scope.",
  },
  {
    key: 'performance.evidence.manage',
    name: 'Manage performance evidence',
    description:
      "Configure evidence sources (such as Google Forms assessments), import, record, correct and withdraw performance evidence and resolve unmatched results for an organization. Sensitive: granted only at organization scope; never one's own evidence.",
  },
  {
    key: 'recruitment.read',
    name: 'Read recruitment',
    description:
      "View job openings, candidates, applications, screening, interviews, feedback and offers within the openings' scope. Sensitive: never implied by employee.read, managing employees, a reporting line, compensation, payroll, benefits or performance access; never one's own candidacy.",
  },
  {
    key: 'recruitment.manage',
    name: 'Manage recruitment',
    description:
      "Create and change job openings, candidates and applications, move candidates through stages, record screening, schedule interviews, draft, send and record responses to offers within scope. Sensitive: never one's own candidacy.",
  },
  {
    key: 'recruitment.offer.approve',
    name: 'Approve offers',
    description:
      'Approve drafted offers (terms and compensation) for openings within scope. Sensitive: never implied by recruitment.manage or compensation access.',
  },
  {
    key: 'recruitment.hire',
    name: 'Convert hires to employees',
    description:
      'Convert an accepted offer into a Person, Employee and EmploymentAssignment (with Core HR employee.manage on the offered position; compensation.manage to initialize pay). Sensitive.',
  },
  {
    key: 'recruitment.pipeline.manage',
    name: 'Manage hiring stages',
    description:
      "Configure an organization's ordered hiring stages. Granted only at organization scope.",
  },
  {
    key: 'recruitment.intake.manage',
    name: 'Manage application intake',
    description:
      'Configure external application sources (such as a Google Forms staff application), import submissions and resolve submissions waiting for an opening. Sensitive: granted only at organization scope.',
  },
  {
    key: 'onboarding.read',
    name: 'Read onboarding',
    description:
      "View employees' onboarding workflows, tasks, owners, progress and acknowledgements within scope. Sensitive: never implied by employee.read, managing employees, a reporting line, recruitment, compensation, payroll, benefits or performance access; never one's own workflow (employees see their own tasks through self-service).",
  },
  {
    key: 'onboarding.manage',
    name: 'Manage onboarding',
    description:
      "Start, complete and cancel onboarding workflows and complete, waive, reopen, reassign and re-date their tasks within scope. Sensitive: never one's own onboarding.",
  },
  {
    key: 'offboarding.read',
    name: 'Read offboarding',
    description:
      "View employees' offboarding workflows (including planned last days and reasons) within scope. Sensitive: never implied by onboarding access, employee.read or a reporting line; never one's own.",
  },
  {
    key: 'offboarding.manage',
    name: 'Manage offboarding',
    description:
      "Start, complete and cancel offboarding workflows and manage their tasks within scope. Never ends employment (Core HR does). Sensitive: never one's own offboarding.",
  },
  {
    key: 'onboarding.template.manage',
    name: 'Manage onboarding and offboarding templates',
    description:
      "Configure an organization's onboarding and offboarding checklists. Sensitive: granted only at organization scope.",
  },
  {
    key: 'document.read',
    name: 'Read employee documents',
    description:
      "View employees' employee-visible and manager-visible documents, versions, expiry and acknowledgements within scope. Sensitive: never implied by employee.read, managing employees, a reporting line, payroll, compensation, recruitment or performance access; never one's own records (employees see their own through self-service).",
  },
  {
    key: 'document.confidential.read',
    name: 'Read HR-only documents',
    description:
      'Also view HR-only employee documents within scope. Sensitive: never implied by document.read.',
  },
  {
    key: 'document.restricted.read',
    name: 'Read restricted documents',
    description:
      'Also view restricted employee documents (identification, background-check evidence, tax records) within scope. Sensitive: never implied by any other permission.',
  },
  {
    key: 'document.manage',
    name: 'Manage employee documents',
    description:
      "Create, version, re-classify and archive employee documents within scope, up to the confidentiality the user can read, and hand off recruitment documents after hire. Sensitive: never one's own records.",
  },
  {
    key: 'document.type.manage',
    name: 'Manage document types',
    description:
      "Configure an organization's document types and required documents. Sensitive: granted only at organization scope.",
  },
  {
    key: 'document.policy.manage',
    name: 'Manage policy documents',
    description:
      "Author, publish, version and retire an organization's policy documents and track acknowledgements. Sensitive: granted only at organization scope.",
  },
  {
    key: 'notification.template.manage',
    name: 'Manage notification templates',
    description:
      "Customize an organization's notification wording (subjects and bodies) within the allowed placeholders, preview and archive templates. Never grants reading anyone's notifications. Granted only at organization scope.",
  },
  {
    key: 'notification.settings.manage',
    name: 'Manage notification settings',
    description:
      "Turn an organization's email notifications on or off per category or entirely; mandatory notices stay delivered unless explicitly suppressed. Never grants reading anyone's notifications. Granted only at organization scope.",
  },
  {
    key: 'notification.delivery.read',
    name: 'View notification delivery log',
    description:
      "Read-only: an organization's notification deliveries and attempts (event type, recipient name, channel, status, safe error codes and timestamps) to diagnose email delivery. Never shows message subjects, bodies, email addresses or variables, and never grants reading anyone's notifications. Granted only at organization scope.",
  },
  {
    key: 'integration.google.manage',
    name: 'Manage Google Workspace integration',
    description:
      "Connect or disconnect an organization's Google Workspace (OAuth consent or an optional service account), manage form bindings and trigger synchronizations. Never grants access to any domain data: synchronized results go through each domain's own rules. Granted only at organization scope.",
  },
  {
    key: 'integration.google.read',
    name: 'View Google Workspace integration',
    description:
      "View an organization's Google Workspace connection status, form bindings and synchronization logs (never credentials or response content). Never grants access to any domain data. Granted only at organization scope.",
  },
  {
    key: 'report.read',
    name: 'Read reports',
    description:
      "Open the Reporting area and run aggregate reports within authorized scopes. Never grants access to any domain data by itself: each report also needs its source domain's own read permission (employee.read, time.view, schedule.read, leave.read, compensation.read, payroll.read, benefit.read, performance.read, recruitment.read, onboarding.read, offboarding.read or document.read) over the same scope.",
  },
  {
    key: 'report.export',
    name: 'Export reports',
    description:
      'Export reports one can run (CSV download or Google Sheets) within authorized scopes; every export is audited. Never grants access to any domain data by itself.',
  },
  {
    key: 'feature.read',
    name: 'View feature configuration',
    description:
      "View an organization's enabled modules, typed settings and their change history. Never grants access to any domain data. Granted only at organization scope.",
  },
  {
    key: 'feature.manage',
    name: 'Manage feature configuration',
    description:
      "Enable or disable an organization's modules (dependency rules apply; data is never deleted) and change or reset its typed settings; every change is audited. Never grants access to any domain data. Granted only at organization scope.",
  },
  {
    key: 'audit.read',
    name: 'View the audit trail',
    description:
      "View an organization's audit trail: who changed which record and when, with identifiers and a safe subset of the change metadata. Never grants access to any domain data (no record contents, free text, IP addresses or emails). Granted only at organization scope.",
  },
] as const;

export const SYSTEM_OWNER_ROLE_CODE = 'SYSTEM_OWNER';
export const SYSTEM_OWNER_ROLE_NAME = 'System Owner';

export type CatalogPermissionKey = (typeof PERMISSION_CATALOG)[number]['key'];
