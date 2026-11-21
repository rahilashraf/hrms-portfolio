/**
 * Phase 20 — the single, typed navigation registry. The sidebar, the mobile drawer and the
 * breadcrumbs are all derived from it.
 *
 * Visibility is computed from a {@link NavContext}: the permission keys held in the SELECTED
 * organization (plus SYSTEM-scope keys), that organization's enabled Phase 18 modules and the
 * caller's organization context (employee or not). Role names are never consulted, and the API
 * stays authoritative — hiding a link is a convenience, never access control.
 */
import type { OrganizationModule } from '../workspace/types';

export type NavIconName =
  | 'home'
  | 'users'
  | 'user'
  | 'building'
  | 'briefcase'
  | 'key'
  | 'clock'
  | 'clipboard'
  | 'edit'
  | 'tablet'
  | 'calendar'
  | 'sun'
  | 'inbox'
  | 'book'
  | 'wallet'
  | 'banknote'
  | 'heart'
  | 'star'
  | 'search'
  | 'chat'
  | 'flag'
  | 'file'
  | 'folder'
  | 'chart'
  | 'settings'
  | 'palette'
  | 'toggle'
  | 'bell'
  | 'plug'
  | 'shield'
  | 'history';

/** A permission requirement: any one of `anyOf` (when given) AND every key of `allOf`. */
export interface PermissionRule {
  anyOf?: readonly string[];
  allOf?: readonly string[];
}

export interface NavHrefContext {
  /** The selected organization (only set for items with `requiresOrganization`). */
  organizationId: string;
}

export interface NavItem {
  id: string;
  label: string;
  /** Leaf items only. A function builds an organization-specific route. */
  href?: string | ((context: NavHrefContext) => string);
  icon: NavIconName;
  description: string;
  permissions?: PermissionRule;
  /** Phase 18 modules that must all be enabled for the selected organization. */
  modules?: readonly OrganizationModule[];
  /** Needs a selected organization (organization-specific route or page). */
  requiresOrganization?: boolean;
  /** Self-service: the caller must be employed in the selected organization. */
  requiresEmployee?: boolean;
  children?: readonly NavItem[];
}

/** What the caller can see. Built by `navigation/context.ts`. */
export interface NavContext {
  /** `workspace`: GET /auth/me/workspace; `fallback`: the /auth/me/authorization snapshot. */
  mode: 'workspace' | 'fallback';
  /** Selected organization's keys ∪ SYSTEM keys (fallback: keys held anywhere). */
  permissions: ReadonlySet<string>;
  /** Enabled modules of the selected organization; `null` skips module filtering (fallback). */
  enabledModules: ReadonlySet<OrganizationModule> | null;
  organizationId: string | null;
  /** `null` when unknown (fallback): self-service items stay visible. */
  isEmployee: boolean | null;
}

export interface ResolvedNavItem {
  id: string;
  label: string;
  /** `null` for groups. */
  href: string | null;
  icon: NavIconName;
  description: string;
  children: ResolvedNavItem[];
}

// ─── Permission sets (mirroring the API's own access checks) ─────────────────

const TIME_OPERATIONS = [
  'time.view',
  'time.approve',
  'time.correct',
  'time.timesheet.approve',
  'time.timesheet.manage',
  'time.manage_policy',
  'time.device.manage',
] as const;
const LEAVE_OPERATIONS = [
  'leave.read',
  'leave.approve',
  'leave.adjust',
  'leave.manage_policy',
  'holiday.manage',
] as const;
const PAYROLL_KEYS = [
  'payroll.read',
  'payroll.manage',
  'payroll.calculate',
  'payroll.approve',
  'payroll.finalize',
  'payroll.adjust',
] as const;

export const NAV_REGISTRY: readonly NavItem[] = [
  {
    id: 'home',
    label: 'Home',
    href: '/dashboard',
    icon: 'home',
    description: 'Your overview and account status.',
  },
  {
    id: 'people',
    label: 'People',
    icon: 'users',
    description: 'Employees and how the organization is structured.',
    children: [
      {
        id: 'my-profile',
        label: 'My Profile',
        href: '/profile',
        icon: 'user',
        description: 'Your own employee record and employment, read-only.',
        requiresEmployee: true,
      },
      {
        id: 'employees',
        label: 'Employees',
        href: '/admin/employees',
        icon: 'users',
        description: 'Employee directory, profiles and employment.',
        permissions: { anyOf: ['employee.read'] },
      },
      {
        id: 'organization',
        label: 'Organization',
        href: '/admin/organizations',
        icon: 'building',
        description: 'Organizations, business units, departments, teams and locations.',
        permissions: { anyOf: ['organization.read'] },
      },
      {
        id: 'positions',
        label: 'Positions',
        href: ({ organizationId }) =>
          `/admin/organizations/${encodeURIComponent(organizationId)}/positions`,
        icon: 'briefcase',
        description: 'Positions in the selected organization.',
        permissions: { anyOf: ['organization.read'] },
        requiresOrganization: true,
      },
      {
        id: 'user-access',
        label: 'User Access',
        href: '/admin/access-control/assignments',
        icon: 'key',
        description: 'Who holds which role, and granting or revoking access.',
        // The User Access page needs both (it lists and changes role assignments).
        permissions: { allOf: ['role.read', 'role.assign'] },
      },
    ],
  },
  {
    id: 'time',
    label: 'Time & Attendance',
    icon: 'clock',
    description: 'Clocking, attendance records, timesheets and corrections.',
    children: [
      {
        id: 'my-time',
        label: 'My Time',
        href: '/time',
        icon: 'clock',
        description: 'Clock in and out, your attendance records and timesheets.',
        modules: ['ATTENDANCE'],
        requiresEmployee: true,
      },
      {
        id: 'attendance',
        label: 'Attendance',
        href: '/admin/time',
        icon: 'clipboard',
        description: 'Attendance records, exceptions and attendance administration.',
        permissions: { anyOf: TIME_OPERATIONS },
        modules: ['ATTENDANCE'],
      },
      {
        id: 'timesheets',
        label: 'Timesheets',
        href: '/admin/time#timesheets',
        icon: 'calendar',
        description: 'Timesheet approvals and reopening.',
        permissions: { anyOf: ['time.timesheet.approve', 'time.timesheet.manage'] },
        modules: ['ATTENDANCE'],
      },
      {
        id: 'corrections',
        label: 'Corrections',
        href: '/admin/time#corrections',
        icon: 'edit',
        description: 'Review time corrections.',
        permissions: { anyOf: ['time.approve'] },
        modules: ['ATTENDANCE'],
      },
      {
        id: 'kiosk',
        label: 'Kiosk Management',
        href: '/admin/time?attendanceTab=kiosks#attendance',
        icon: 'tablet',
        description: 'Register and manage shared attendance kiosk devices.',
        permissions: { anyOf: ['time.device.manage'] },
        modules: ['ATTENDANCE'],
      },
      {
        // Batch 4E-2: attendance policy layers, the effective policy and assignment attendance.
        id: 'attendance-policies',
        label: 'Attendance Policies',
        href: '/admin/time?attendanceTab=policies#attendance',
        icon: 'settings',
        description: 'Configure attendance policies and inspect what applies to each assignment.',
        permissions: { anyOf: ['time.manage_policy'] },
        modules: ['ATTENDANCE'],
      },
    ],
  },
  {
    id: 'scheduling',
    label: 'Scheduling',
    icon: 'calendar',
    description: 'Schedules, shift templates, recurring patterns and holiday calendars.',
    children: [
      {
        id: 'my-schedule',
        label: 'My Schedule',
        href: '/schedule',
        icon: 'calendar',
        description: 'Your published shifts across your assignments.',
        modules: ['SCHEDULING'],
        requiresEmployee: true,
      },
      {
        id: 'schedules',
        label: 'Schedules',
        href: '/admin/scheduling',
        icon: 'calendar',
        description: 'Plan, publish and correct employee shifts.',
        permissions: { anyOf: ['schedule.read', 'schedule.manage'] },
        modules: ['SCHEDULING'],
      },
      {
        id: 'schedule-templates',
        label: 'Shift Templates',
        href: '/admin/scheduling/templates',
        icon: 'clipboard',
        description: 'Reusable weekly shift templates.',
        permissions: {
          anyOf: ['schedule.read', 'schedule.manage_templates', 'schedule.manage_patterns'],
        },
        modules: ['SCHEDULING'],
      },
      {
        id: 'schedule-patterns',
        label: 'Recurring Patterns',
        href: '/admin/scheduling/patterns',
        icon: 'clock',
        description: 'Recurring shifts per employment assignment and draft generation.',
        permissions: { anyOf: ['schedule.read', 'schedule.manage_patterns'] },
        modules: ['SCHEDULING'],
      },
      {
        id: 'schedule-policies',
        label: 'Scheduling Policies',
        href: '/admin/scheduling/policies',
        icon: 'settings',
        description: 'Rest periods, shift limits, overrides and clock-in windows.',
        permissions: { anyOf: ['schedule.read', 'schedule.manage_policy'] },
        modules: ['SCHEDULING'],
      },
      {
        id: 'scheduled-hours',
        label: 'Scheduled Hours',
        href: '/admin/scheduling/reports',
        icon: 'chart',
        description: 'Scheduled hours by unit, location, employee and more.',
        permissions: { anyOf: ['schedule.read', 'schedule.manage'] },
        modules: ['SCHEDULING'],
      },
      {
        id: 'holidays',
        label: 'Holidays',
        href: '/admin/leave#holidays',
        icon: 'sun',
        description: 'Organization and team holiday calendars.',
        permissions: { anyOf: ['holiday.manage', 'leave.read', 'leave.approve'] },
        modules: ['LEAVE'],
      },
    ],
  },
  {
    id: 'leave',
    label: 'Leave',
    icon: 'sun',
    description: 'Leave requests, approvals, balances and policies.',
    children: [
      {
        id: 'my-leave',
        label: 'My Leave',
        href: '/leave',
        icon: 'sun',
        description: 'Your balances and leave requests.',
        modules: ['LEAVE'],
        requiresEmployee: true,
      },
      {
        id: 'leave-requests',
        label: 'Requests',
        href: '/admin/leave',
        icon: 'inbox',
        description: 'Review and approve leave requests, coverage and balances.',
        permissions: { anyOf: LEAVE_OPERATIONS },
        modules: ['LEAVE'],
      },
      {
        id: 'leave-policies',
        label: 'Policies',
        href: '/admin/leave#policies',
        icon: 'book',
        description: 'Leave types and policies.',
        permissions: { anyOf: ['leave.manage_policy', 'leave.read', 'leave.approve'] },
        modules: ['LEAVE'],
      },
    ],
  },
  {
    id: 'pay',
    label: 'Pay',
    icon: 'wallet',
    description: 'Pay statements, compensation, payroll and benefits.',
    children: [
      {
        id: 'my-pay',
        label: 'My Pay',
        href: '/pay',
        icon: 'banknote',
        description: 'Your pay statements.',
        modules: ['PAYROLL'],
        requiresEmployee: true,
      },
      {
        id: 'my-compensation',
        label: 'My Compensation',
        href: '/compensation',
        icon: 'wallet',
        description: 'Your pay rates.',
        modules: ['COMPENSATION'],
        requiresEmployee: true,
      },
      {
        id: 'my-benefits',
        label: 'My Benefits',
        href: '/benefits',
        icon: 'heart',
        description: 'Your benefit enrollments.',
        modules: ['BENEFITS'],
        requiresEmployee: true,
      },
      {
        id: 'compensation',
        label: 'Compensation',
        href: '/admin/compensation',
        icon: 'wallet',
        description: 'Pay groups, pay periods and pay rates.',
        permissions: { anyOf: ['compensation.read', 'compensation.manage'] },
        modules: ['COMPENSATION'],
      },
      {
        id: 'payroll',
        label: 'Payroll',
        href: '/admin/payroll',
        icon: 'banknote',
        description: 'Payroll runs from draft to finalized.',
        permissions: { anyOf: PAYROLL_KEYS },
        modules: ['PAYROLL'],
      },
      {
        id: 'benefits',
        label: 'Benefits',
        href: '/admin/benefits',
        icon: 'heart',
        description: 'Benefit plans and enrollments.',
        permissions: { anyOf: ['benefit.read', 'benefit.manage', 'benefit.plan.manage'] },
        modules: ['BENEFITS'],
      },
    ],
  },
  {
    id: 'talent',
    label: 'Talent',
    icon: 'star',
    description: 'Recruitment, onboarding and performance.',
    children: [
      {
        id: 'my-performance',
        label: 'My Performance',
        href: '/performance',
        icon: 'star',
        description: 'Your reviews and goals.',
        modules: ['PERFORMANCE'],
        requiresEmployee: true,
      },
      {
        id: 'my-interviews',
        label: 'My Interviews',
        href: '/interviews',
        icon: 'chat',
        description: 'Interviews you are a panelist on.',
        modules: ['RECRUITMENT'],
        requiresEmployee: true,
      },
      {
        id: 'my-onboarding',
        label: 'My Onboarding',
        href: '/onboarding',
        icon: 'flag',
        description: 'Your onboarding and offboarding tasks.',
        modules: ['ONBOARDING'],
        requiresEmployee: true,
      },
      {
        id: 'recruitment',
        label: 'Recruitment',
        href: '/admin/recruitment',
        icon: 'search',
        description: 'Openings, candidates, applications, interviews and offers.',
        permissions: {
          anyOf: [
            'recruitment.read',
            'recruitment.manage',
            'recruitment.offer.approve',
            'recruitment.hire',
            'recruitment.pipeline.manage',
            'recruitment.intake.manage',
          ],
        },
        modules: ['RECRUITMENT'],
      },
      {
        id: 'onboarding',
        label: 'Onboarding',
        href: '/admin/onboarding',
        icon: 'flag',
        description: 'Onboarding and offboarding workflows and templates.',
        permissions: {
          anyOf: [
            'onboarding.read',
            'onboarding.manage',
            'offboarding.read',
            'offboarding.manage',
            'onboarding.template.manage',
          ],
        },
        modules: ['ONBOARDING'],
      },
      {
        id: 'performance',
        label: 'Performance',
        href: '/admin/performance',
        icon: 'star',
        description: 'Review cycles, reviews, goals and results.',
        permissions: {
          anyOf: [
            'performance.read',
            'performance.manage',
            'performance.template.manage',
            'performance.cycle.manage',
            'performance.evidence.manage',
          ],
        },
        modules: ['PERFORMANCE'],
      },
    ],
  },
  {
    id: 'documents',
    label: 'Documents',
    icon: 'folder',
    description: 'Policies, acknowledgements and employee records.',
    children: [
      {
        id: 'my-documents',
        label: 'My Documents',
        href: '/documents',
        icon: 'file',
        description: 'Documents shared with you and your acknowledgements.',
        modules: ['DOCUMENTS'],
        requiresEmployee: true,
      },
      {
        id: 'document-records',
        label: 'Document Records',
        href: '/admin/documents',
        icon: 'folder',
        description: 'Employee records, document types and policies.',
        permissions: {
          anyOf: [
            'document.read',
            'document.confidential.read',
            'document.restricted.read',
            'document.manage',
            'document.type.manage',
            'document.policy.manage',
          ],
        },
        modules: ['DOCUMENTS'],
      },
    ],
  },
  {
    id: 'reports',
    label: 'Reports',
    href: '/reports',
    icon: 'chart',
    description: 'Operational reports and exports.',
    permissions: { anyOf: ['report.read'] },
    modules: ['REPORTING'],
  },
  {
    id: 'administration',
    label: 'Administration',
    icon: 'settings',
    description: 'Company settings, features, integrations, access and audit.',
    children: [
      {
        id: 'company-settings',
        label: 'Company Settings',
        href: '/admin/settings/company',
        icon: 'building',
        description: 'Company profile and setup.',
        permissions: { anyOf: ['organization.manage'] },
        requiresOrganization: true,
      },
      {
        id: 'branding',
        label: 'Branding',
        href: '/admin/settings/branding',
        icon: 'palette',
        description: 'Logo, colors and sign-in page branding.',
        permissions: { anyOf: ['organization.branding.manage'] },
        requiresOrganization: true,
      },
      {
        id: 'features',
        label: 'Features',
        href: '/admin/settings',
        icon: 'toggle',
        description: 'Turn modules on or off and tune their settings.',
        permissions: { anyOf: ['feature.read', 'feature.manage'] },
      },
      {
        id: 'notification-settings',
        label: 'Notification Settings',
        href: '/admin/notifications',
        icon: 'bell',
        description: 'Notification templates, email settings and the delivery log.',
        permissions: {
          anyOf: [
            'notification.template.manage',
            'notification.settings.manage',
            'notification.delivery.read',
          ],
        },
        modules: ['NOTIFICATIONS'],
      },
      {
        id: 'integrations',
        label: 'Integrations',
        href: '/settings/integrations/google',
        icon: 'plug',
        description: 'Google Workspace connection and sync.',
        permissions: { anyOf: ['integration.google.read', 'integration.google.manage'] },
        modules: ['GOOGLE_WORKSPACE'],
      },
      {
        id: 'roles',
        label: 'Roles & Permissions',
        href: '/admin/access-control/roles',
        icon: 'shield',
        description: 'Roles, their permissions and who holds them.',
        // Batch R3.2: exactly what the page requires (RolesPage gates on role.read). role.manage
        // or role.assign alone used to show the item and lead to "Access denied".
        permissions: { anyOf: ['role.read'] },
      },
      {
        id: 'audit',
        label: 'Audit Log',
        href: '/admin/audit',
        icon: 'history',
        description: 'Who changed what, and when.',
        permissions: { anyOf: ['audit.read'] },
      },
    ],
  },
];

/**
 * Pages that are not sidebar entries but still need a breadcrumb trail: each names the nav
 * items it belongs under (the first visible one wins) and its own label.
 */
export interface RouteCrumb {
  /** Path pattern; `[name]` matches one segment. */
  pattern: string;
  label: string | ((params: Record<string, string>) => string);
  /** Nav item ids, in preference order. */
  parents: readonly string[];
  /** An intermediate route pattern shown between the parent item and this page. */
  via?: string;
}

const RESOURCE_LABELS: Record<string, string> = {
  units: 'Business Units',
  departments: 'Departments',
  teams: 'Teams',
  'job-titles': 'Job Titles',
  positions: 'Positions',
  'work-locations': 'Work Locations',
  'physical-sites': 'Physical Sites',
};

export const ROUTE_CRUMBS: readonly RouteCrumb[] = [
  { pattern: '/admin/employees/new', label: 'Add employee', parents: ['employees'] },
  // Before [employeeId], which would otherwise match "lifecycle" as an employee id.
  { pattern: '/admin/employees/lifecycle', label: 'Ending assignments', parents: ['employees'] },
  { pattern: '/admin/employees/[employeeId]', label: 'Employee profile', parents: ['employees'] },
  {
    pattern: '/admin/organizations/[organizationId]',
    label: 'Organization details',
    parents: ['organization'],
  },
  {
    pattern: '/admin/organizations/[organizationId]/[resource]',
    label: (params) => RESOURCE_LABELS[params.resource ?? ''] ?? 'Details',
    parents: ['organization'],
    via: '/admin/organizations/[organizationId]',
  },
  { pattern: '/admin/structure', label: 'Organization', parents: ['organization'] },
  { pattern: '/admin', label: 'Administration overview', parents: ['organization'] },
  {
    pattern: '/admin/access-control/roles/[roleId]',
    label: 'Role details',
    parents: ['roles'],
  },
  {
    pattern: '/admin/access-control/assignments',
    label: 'User Access',
    parents: ['user-access', 'roles'],
  },
  { pattern: '/admin/payroll/runs/[runId]', label: 'Payroll run', parents: ['payroll'] },
  {
    pattern: '/recruitment/applications/[applicationId]',
    label: 'Application',
    parents: ['recruitment'],
  },
  {
    pattern: '/recruitment/candidates/[candidateId]',
    label: 'Candidate',
    parents: ['recruitment'],
  },
  {
    pattern: '/onboarding/workflows/[workflowId]',
    label: 'Workflow',
    parents: ['onboarding', 'my-onboarding'],
  },
  {
    pattern: '/performance/reviews/[reviewId]',
    label: 'Review',
    parents: ['performance', 'my-performance'],
  },
  {
    pattern: '/documents/records/[documentId]',
    label: 'Document',
    parents: ['document-records', 'my-documents'],
  },
  { pattern: '/reports/[reportKey]', label: 'Report', parents: ['reports'] },
  { pattern: '/notifications', label: 'Notifications', parents: ['home'] },
  // Batch 2: every signed-in account (employee or not), reached from the user panel.
  { pattern: '/account/security', label: 'Account security', parents: ['home'] },
  {
    pattern: '/notifications/preferences',
    label: 'Notification preferences',
    parents: ['home'],
    via: '/notifications',
  },
];

// ─── Visibility ──────────────────────────────────────────────────────────────

export function permissionRuleSatisfied(
  rule: PermissionRule | undefined,
  permissions: ReadonlySet<string>,
): boolean {
  if (!rule) return true;
  if (rule.anyOf && rule.anyOf.length > 0 && !rule.anyOf.some((key) => permissions.has(key))) {
    return false;
  }
  return (rule.allOf ?? []).every((key) => permissions.has(key));
}

/** Whether a single item's own rules pass (children are not considered). */
export function itemAllowed(item: NavItem, context: NavContext): boolean {
  if (!permissionRuleSatisfied(item.permissions, context.permissions)) return false;
  if (item.requiresOrganization && !context.organizationId) return false;
  if (item.requiresEmployee && context.isEmployee === false) return false;
  if (item.modules && item.modules.length > 0 && context.enabledModules !== null) {
    const enabled = context.enabledModules;
    if (!item.modules.every((module) => enabled.has(module))) return false;
  }
  return true;
}

function resolveHref(item: NavItem, context: NavContext): string | null {
  if (!item.href) return null;
  if (typeof item.href === 'string') return item.href;
  return context.organizationId ? item.href({ organizationId: context.organizationId }) : null;
}

/** The visible navigation tree: hidden items are removed and empty groups dropped. */
export function visibleNavigation(
  context: NavContext,
  registry: readonly NavItem[] = NAV_REGISTRY,
): ResolvedNavItem[] {
  const resolve = (item: NavItem): ResolvedNavItem | null => {
    if (!itemAllowed(item, context)) return null;
    if (item.children) {
      const children = item.children
        .map(resolve)
        .filter((child): child is ResolvedNavItem => child !== null);
      if (children.length === 0) return null;
      return { ...base(item), href: resolveHref(item, context), children };
    }
    const href = resolveHref(item, context);
    if (!href) return null;
    return { ...base(item), href, children: [] };
  };
  return registry.map(resolve).filter((item): item is ResolvedNavItem => item !== null);
}

function base(item: NavItem) {
  return { id: item.id, label: item.label, icon: item.icon, description: item.description };
}

/** All visible leaf items, depth-first. */
export function flattenNavigation(tree: readonly ResolvedNavItem[]): ResolvedNavItem[] {
  return tree.flatMap((item) =>
    item.children.length > 0 ? flattenNavigation(item.children) : [item],
  );
}

// ─── Active item and breadcrumbs ─────────────────────────────────────────────

function splitHref(href: string): { path: string; hash: string } {
  const index = href.indexOf('#');
  return index < 0
    ? { path: href, hash: '' }
    : { path: href.slice(0, index), hash: href.slice(index + 1) };
}

function normalizePath(pathname: string): string {
  const path = pathname.split('?')[0]?.split('#')[0] ?? '/';
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path || '/';
}

export function matchPattern(pattern: string, pathname: string): Record<string, string> | null {
  const expected = pattern.split('/').filter(Boolean);
  const actual = normalizePath(pathname).split('/').filter(Boolean);
  if (expected.length !== actual.length) return null;
  const params: Record<string, string> = {};
  for (let index = 0; index < expected.length; index += 1) {
    const part = expected[index]!;
    const value = actual[index]!;
    if (part.startsWith('[') && part.endsWith(']')) {
      try {
        params[part.slice(1, -1)] = decodeURIComponent(value);
      } catch {
        params[part.slice(1, -1)] = value;
      }
    } else if (part !== value) {
      return null;
    }
  }
  return params;
}

function fillPattern(pattern: string, params: Record<string, string>): string {
  return pattern.replace(/\[([^\]]+)\]/g, (_, name: string) =>
    encodeURIComponent(params[name] ?? ''),
  );
}

/**
 * The nav item the current location belongs to. Exact path matches win (an item with a hash
 * only when the location's hash matches it), then registered sub-pages, then the longest
 * path prefix.
 */
export function activeNavItem(
  tree: readonly ResolvedNavItem[],
  pathname: string,
  hash = '',
): ResolvedNavItem | null {
  const path = normalizePath(pathname);
  const currentHash = hash.replace(/^#/, '');
  const leaves = flattenNavigation(tree).filter((item) => item.href);
  const exact = leaves.filter((item) => splitHref(item.href!).path === path);
  if (exact.length > 0) {
    return (
      exact.find((item) => currentHash && splitHref(item.href!).hash === currentHash) ??
      exact.find((item) => splitHref(item.href!).hash === '') ??
      exact[0]!
    );
  }
  const route = matchRouteCrumb(path);
  if (route) {
    const parent = route.crumb.parents
      .map((id) => leaves.find((item) => item.id === id))
      .find((item) => item !== undefined);
    if (parent) return parent;
  }
  let best: ResolvedNavItem | null = null;
  for (const item of leaves) {
    const { path: itemPath, hash: itemHash } = splitHref(item.href!);
    if (itemHash || itemPath === '/') continue;
    if (path.startsWith(`${itemPath}/`)) {
      if (!best || itemPath.length > splitHref(best.href!).path.length) best = item;
    }
  }
  return best;
}

function matchRouteCrumb(path: string) {
  for (const crumb of ROUTE_CRUMBS) {
    const params = matchPattern(crumb.pattern, path);
    if (params) return { crumb, params };
  }
  return null;
}

/** The group containing an item (or `null` for a top-level item). */
export function parentGroup(
  tree: readonly ResolvedNavItem[],
  itemId: string,
): ResolvedNavItem | null {
  return tree.find((group) => group.children.some((child) => child.id === itemId)) ?? null;
}

export interface Breadcrumb {
  label: string;
  /** `null`: plain text (a group, the current page, or an item the caller cannot open). */
  href: string | null;
  current: boolean;
}

function findRegistryItem(id: string, registry: readonly NavItem[] = NAV_REGISTRY): NavItem | null {
  for (const item of registry) {
    if (item.id === id) return item;
    const child = item.children ? findRegistryItem(id, item.children) : null;
    if (child) return child;
  }
  return null;
}

function registryGroupLabel(id: string): string | null {
  return (
    NAV_REGISTRY.find((group) => group.children?.some((child) => child.id === id))?.label ?? null
  );
}

/**
 * Breadcrumbs for a location: Home › group › item › sub-page. Only items visible to the
 * caller are links; the current page is never a link.
 */
export function breadcrumbsFor(
  tree: readonly ResolvedNavItem[],
  pathname: string,
  hash = '',
): Breadcrumb[] {
  const path = normalizePath(pathname);
  const home: Breadcrumb = { label: 'Home', href: '/dashboard', current: false };
  if (path === '/dashboard') return [{ ...home, href: null, current: true }];

  const leaves = flattenNavigation(tree);
  const route = matchRouteCrumb(path);
  const active = activeNavItem(tree, path, hash);
  const exactActive = active && splitHref(active.href!).path === path ? active : null;

  const trail: Breadcrumb[] = [home];
  const pushItem = (id: string, current: boolean) => {
    if (id === 'home') return;
    const visible = leaves.find((item) => item.id === id);
    const group = registryGroupLabel(id);
    if (group) trail.push({ label: group, href: null, current: false });
    const label = visible?.label ?? findRegistryItem(id)?.label ?? id;
    trail.push({ label, href: current || !visible ? null : visible.href, current });
  };

  if (exactActive) {
    pushItem(exactActive.id, true);
    return trail;
  }
  if (route) {
    const parentId =
      route.crumb.parents.find((id) => leaves.some((item) => item.id === id)) ??
      route.crumb.parents[0]!;
    pushItem(parentId, false);
    if (route.crumb.via) {
      const via = ROUTE_CRUMBS.find((crumb) => crumb.pattern === route.crumb.via);
      if (via) {
        const viaLabel = typeof via.label === 'function' ? via.label(route.params) : via.label;
        trail.push({
          label: viaLabel,
          href: fillPattern(via.pattern, route.params),
          current: false,
        });
      }
    }
    const label =
      typeof route.crumb.label === 'function' ? route.crumb.label(route.params) : route.crumb.label;
    trail.push({ label, href: null, current: true });
    return trail;
  }
  if (active) {
    pushItem(active.id, false);
    trail.push({ label: 'Details', href: null, current: true });
    return trail;
  }
  return trail;
}
