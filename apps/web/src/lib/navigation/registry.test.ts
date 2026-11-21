import { describe, expect, it } from 'vitest';
import { ORGANIZATION_MODULES, type OrganizationModule, type Workspace } from '../workspace/types';
import { navContextFromSnapshot, navContextFromWorkspace } from './context';
import {
  activeNavItem,
  breadcrumbsFor,
  flattenNavigation,
  itemAllowed,
  matchPattern,
  NAV_REGISTRY,
  permissionRuleSatisfied,
  ROUTE_CRUMBS,
  visibleNavigation,
  type NavContext,
  type NavItem,
  type ResolvedNavItem,
} from './registry';

/** Every permission key in the API catalog (plus the Phase 20 branding key). */
const ALL_PERMISSIONS = [
  'organization.read',
  'organization.manage',
  'organization.branding.manage',
  'role.read',
  'role.manage',
  'role.assign',
  'employee.read',
  'employee.manage',
  'time.clock',
  'time.view',
  'time.approve',
  'time.correct',
  'time.timesheet.approve',
  'time.timesheet.manage',
  'time.manage_policy',
  'time.device.manage',
  'time.credential.manage',
  'schedule.read',
  'schedule.manage',
  'leave.request',
  'leave.read',
  'leave.approve',
  'leave.adjust',
  'leave.manage_policy',
  'holiday.manage',
  'compensation.read',
  'compensation.manage',
  'payroll.read',
  'payroll.manage',
  'payroll.calculate',
  'payroll.approve',
  'payroll.finalize',
  'payroll.adjust',
  'benefit.read',
  'benefit.manage',
  'benefit.plan.manage',
  'performance.read',
  'performance.manage',
  'performance.template.manage',
  'performance.cycle.manage',
  'performance.evidence.manage',
  'recruitment.read',
  'recruitment.manage',
  'recruitment.offer.approve',
  'recruitment.hire',
  'recruitment.pipeline.manage',
  'recruitment.intake.manage',
  'onboarding.read',
  'onboarding.manage',
  'offboarding.read',
  'offboarding.manage',
  'onboarding.template.manage',
  'document.read',
  'document.confidential.read',
  'document.restricted.read',
  'document.manage',
  'document.type.manage',
  'document.policy.manage',
  'notification.template.manage',
  'notification.settings.manage',
  'integration.google.manage',
  'integration.google.read',
  'report.read',
  'report.export',
  'feature.read',
  'feature.manage',
  'audit.read',
];

const SELF_SERVICE = [
  'my-profile',
  'my-time',
  'my-schedule',
  'my-leave',
  'my-pay',
  'my-compensation',
  'my-benefits',
  'my-performance',
  'my-interviews',
  'my-onboarding',
  'my-documents',
];

function workspace({
  permissions = [],
  systemPermissions = [],
  modules = ORGANIZATION_MODULES,
  isEmployee = true,
  isManager = false,
}: {
  permissions?: string[];
  systemPermissions?: string[];
  modules?: readonly OrganizationModule[];
  isEmployee?: boolean;
  isManager?: boolean;
}): Workspace {
  return {
    user: { id: 'user-1', email: 'user@example.com', displayName: 'Ada Lovelace' },
    systemPermissions,
    organizations: [
      {
        id: 'org-1',
        name: 'Northwind Academy',
        code: 'NWA',
        timezone: 'America/Toronto',
        branding: null,
        enabledModules: [...modules],
        permissions,
        isEmployee,
        isManager,
      },
    ],
  };
}

function persona(options: Parameters<typeof workspace>[0]): NavContext {
  const value = workspace(options);
  return navContextFromWorkspace(value, value.organizations[0]!);
}

const ids = (tree: ResolvedNavItem[]) => flattenNavigation(tree).map((item) => item.id);
const groups = (tree: ResolvedNavItem[]) => tree.map((item) => item.id);

// Personas are permission sets, never role names.
const PERSONAS = {
  systemOwner: () =>
    persona({ systemPermissions: ALL_PERMISSIONS, permissions: [], isEmployee: false }),
  employee: () => persona({ permissions: ['leave.request', 'time.clock'] }),
  manager: () =>
    persona({
      permissions: [
        'leave.request',
        'time.clock',
        'employee.read',
        'leave.approve',
        'time.view',
        'time.approve',
        'time.timesheet.approve',
        'performance.read',
      ],
      isManager: true,
    }),
  payrollAdmin: () =>
    persona({
      permissions: [
        'employee.read',
        'compensation.read',
        'compensation.manage',
        'payroll.read',
        'payroll.manage',
        'payroll.calculate',
        'payroll.approve',
        'payroll.finalize',
        'benefit.read',
        'report.read',
      ],
    }),
  hrAdmin: () =>
    persona({
      permissions: [
        'employee.read',
        'employee.manage',
        'organization.read',
        'leave.read',
        'leave.manage_policy',
        'holiday.manage',
        'recruitment.manage',
        'onboarding.manage',
        'offboarding.manage',
        'document.manage',
        'performance.manage',
        'report.read',
      ],
    }),
};

describe('navigation registry structure', () => {
  it('has unique ids, a label, description and icon for every entry, and hrefs only on leaves', () => {
    const seen = new Set<string>();
    const visit = (item: NavItem) => {
      expect(seen.has(item.id), item.id).toBe(false);
      seen.add(item.id);
      expect(item.label.length).toBeGreaterThan(0);
      expect(item.description.length).toBeGreaterThan(0);
      expect(item.icon.length).toBeGreaterThan(0);
      if (item.children) {
        expect(item.href, item.id).toBeUndefined();
        item.children.forEach(visit);
      } else {
        expect(item.href, item.id).toBeDefined();
      }
    };
    NAV_REGISTRY.forEach(visit);
  });

  it('follows the Phase 20 information architecture', () => {
    expect(NAV_REGISTRY.map((item) => item.label)).toEqual([
      'Home',
      'People',
      'Time & Attendance',
      'Scheduling',
      'Leave',
      'Pay',
      'Talent',
      'Documents',
      'Reports',
      'Administration',
    ]);
  });

  it('only points at routes that exist in the app', () => {
    const routes = [
      '/dashboard',
      '/admin/employees',
      '/admin/organizations',
      '/admin/organizations/org-1/positions',
      '/time',
      '/admin/time',
      '/admin/time?attendanceTab=kiosks#attendance',
      '/admin/time?attendanceTab=policies#attendance',
      '/admin/leave',
      '/leave',
      '/pay',
      '/compensation',
      '/benefits',
      '/admin/compensation',
      '/admin/payroll',
      '/admin/benefits',
      '/performance',
      '/interviews',
      '/onboarding',
      '/admin/recruitment',
      '/admin/onboarding',
      '/admin/performance',
      '/documents',
      '/admin/documents',
      '/reports',
      // Built by the Phase 20 branding pass.
      '/admin/settings/company',
      '/admin/settings/branding',
      '/admin/settings',
      '/admin/notifications',
      '/settings/integrations/google',
      '/admin/access-control/roles',
      '/admin/access-control/assignments',
      '/admin/audit',
      // Scheduling administration.
      '/admin/scheduling',
      '/admin/scheduling/templates',
      '/admin/scheduling/patterns',
      '/admin/scheduling/policies',
      '/admin/scheduling/reports',
    ];
    const hrefs = flattenNavigation(visibleNavigation(PERSONAS.systemOwner())).map(
      (item) => item.href!.split('#')[0]!.split('?')[0],
    );
    for (const href of hrefs) expect(routes, href).toContain(href);
  });

  it('never gates an entry on a role name', () => {
    const keys = JSON.stringify(NAV_REGISTRY);
    expect(keys).not.toMatch(/SYSTEM_OWNER|ADMINISTRATOR|MANAGER|EMPLOYEE"/);
  });
});

describe('permission rules', () => {
  it('supports any-of and all-of requirements', () => {
    const held = new Set(['a', 'b']);
    expect(permissionRuleSatisfied(undefined, held)).toBe(true);
    expect(permissionRuleSatisfied({ anyOf: ['x', 'a'] }, held)).toBe(true);
    expect(permissionRuleSatisfied({ anyOf: ['x', 'y'] }, held)).toBe(false);
    expect(permissionRuleSatisfied({ allOf: ['a', 'b'] }, held)).toBe(true);
    expect(permissionRuleSatisfied({ allOf: ['a', 'c'] }, held)).toBe(false);
    expect(permissionRuleSatisfied({ anyOf: ['a'], allOf: ['c'] }, held)).toBe(false);
  });

  it('applies all-of rules to items', () => {
    const item: NavItem = {
      id: 'x',
      label: 'X',
      href: '/x',
      icon: 'home',
      description: 'x',
      permissions: { allOf: ['role.read', 'role.assign'] },
    };
    expect(itemAllowed(item, persona({ permissions: ['role.read'] }))).toBe(false);
    expect(itemAllowed(item, persona({ permissions: ['role.read', 'role.assign'] }))).toBe(true);
  });
});

describe('persona visibility (permission sets, selected organization)', () => {
  it('shows a system owner every entry', () => {
    const tree = visibleNavigation(PERSONAS.systemOwner());
    const everyLeaf: string[] = [];
    const collect = (item: NavItem) =>
      item.children ? item.children.forEach(collect) : everyLeaf.push(item.id);
    NAV_REGISTRY.forEach(collect);
    // A system owner who is not employed there has no self-service entries.
    expect(ids(tree).sort()).toEqual(everyLeaf.filter((id) => !SELF_SERVICE.includes(id)).sort());
  });

  it('shows an employed system owner self-service too', () => {
    const tree = visibleNavigation(
      persona({ systemPermissions: ALL_PERMISSIONS, isEmployee: true }),
    );
    for (const id of SELF_SERVICE) expect(ids(tree)).toContain(id);
  });

  it('shows a restricted employee only Home and self-service', () => {
    const tree = visibleNavigation(PERSONAS.employee());
    expect(ids(tree)).toEqual(['home', ...SELF_SERVICE]);
    expect(groups(tree)).toEqual([
      'home',
      'people',
      'time',
      'scheduling',
      'leave',
      'pay',
      'talent',
      'documents',
    ]);
  });

  it('shows a manager team operations without administration', () => {
    const tree = visibleNavigation(PERSONAS.manager());
    expect(ids(tree)).toEqual(
      expect.arrayContaining([
        'employees',
        'attendance',
        'timesheets',
        'corrections',
        'holidays',
        'leave-requests',
        'leave-policies',
        'performance',
        'my-time',
        'my-leave',
      ]),
    );
    for (const hidden of [
      'payroll',
      'compensation',
      'recruitment',
      'organization',
      'roles',
      'audit',
      'kiosk',
    ])
      expect(ids(tree)).not.toContain(hidden);
    expect(groups(tree)).not.toContain('administration');
  });

  it('shows a payroll administrator pay operations only', () => {
    const tree = visibleNavigation(PERSONAS.payrollAdmin());
    const pay = tree.find((item) => item.id === 'pay')!;
    expect(pay.children.map((child) => child.id)).toEqual([
      'my-pay',
      'my-compensation',
      'my-benefits',
      'compensation',
      'payroll',
      'benefits',
    ]);
    expect(ids(tree)).toContain('reports');
    for (const hidden of ['recruitment', 'onboarding', 'leave-requests', 'attendance', 'audit'])
      expect(ids(tree)).not.toContain(hidden);
  });

  it('shows an HR administrator people, leave, talent and documents', () => {
    const tree = visibleNavigation(PERSONAS.hrAdmin());
    expect(ids(tree)).toEqual(
      expect.arrayContaining([
        'employees',
        'organization',
        'positions',
        'leave-requests',
        'leave-policies',
        'holidays',
        'recruitment',
        'onboarding',
        'performance',
        'document-records',
        'reports',
      ]),
    );
    for (const hidden of ['payroll', 'compensation', 'features', 'roles', 'audit'])
      expect(ids(tree)).not.toContain(hidden);
  });

  it('uses the selected organization permissions plus SYSTEM permissions only', () => {
    const value: Workspace = {
      ...workspace({ permissions: ['payroll.read'] }),
      systemPermissions: ['audit.read'],
    };
    value.organizations.push({
      ...value.organizations[0]!,
      id: 'org-2',
      name: 'Lakeside',
      permissions: ['recruitment.read'],
    });
    const first = ids(visibleNavigation(navContextFromWorkspace(value, value.organizations[0]!)));
    const second = ids(visibleNavigation(navContextFromWorkspace(value, value.organizations[1]!)));
    expect(first).toEqual(expect.arrayContaining(['payroll', 'audit']));
    expect(first).not.toContain('recruitment');
    expect(second).toEqual(expect.arrayContaining(['recruitment', 'audit']));
    expect(second).not.toContain('payroll');
  });

  it('hides self-service entries where the caller is not employed', () => {
    const tree = visibleNavigation(persona({ permissions: ['leave.request'], isEmployee: false }));
    expect(ids(tree)).toEqual(['home']);
  });

  it('builds organization-specific links for the selected organization', () => {
    const tree = visibleNavigation(PERSONAS.hrAdmin());
    expect(flattenNavigation(tree).find((item) => item.id === 'positions')?.href).toBe(
      '/admin/organizations/org-1/positions',
    );
  });

  it('gates Company Settings and Branding on their permissions', () => {
    expect(ids(visibleNavigation(persona({ permissions: ['organization.manage'] })))).toContain(
      'company-settings',
    );
    expect(ids(visibleNavigation(persona({ permissions: ['organization.manage'] })))).not.toContain(
      'branding',
    );
    expect(
      ids(visibleNavigation(persona({ permissions: ['organization.branding.manage'] }))),
    ).toContain('branding');
  });

  it('offers People › User Access (distinct from Roles & Permissions) with role.read + role.assign', () => {
    const both = visibleNavigation(persona({ permissions: ['role.read', 'role.assign'] }));
    const people = both.find((item) => item.id === 'people')!;
    const access = people.children.find((child) => child.id === 'user-access');
    expect(access?.href).toBe('/admin/access-control/assignments');
    expect(access?.label).toBe('User Access');
    expect(ids(both)).toContain('roles');
    expect(ids(visibleNavigation(persona({ permissions: ['role.read'] })))).not.toContain(
      'user-access',
    );
    expect(ids(visibleNavigation(persona({ permissions: ['role.assign'] })))).not.toContain(
      'user-access',
    );
  });

  it('shows Roles & Permissions exactly when the page is accessible (role.read) — Batch R3.2', () => {
    const shows = (permissions: string[]) =>
      ids(visibleNavigation(persona({ permissions }))).includes('roles');
    // The Roles page requires role.read; manage or assign alone would lead to "Access denied".
    expect(shows(['role.manage'])).toBe(false);
    expect(shows(['role.assign'])).toBe(false);
    expect(shows(['role.manage', 'role.assign'])).toBe(false);
    expect(shows(['role.read'])).toBe(true);
    expect(shows(['role.read', 'role.manage'])).toBe(true);
    expect(shows(['role.read', 'role.assign'])).toBe(true);
    expect(shows(['role.read', 'role.manage', 'role.assign'])).toBe(true);
    expect(shows([])).toBe(false);
    // A system-wide grant still reaches it.
    expect(
      ids(visibleNavigation(persona({ systemPermissions: ['role.read'], permissions: [] }))),
    ).toContain('roles');
  });

  it('puts the User Access page under People in breadcrumbs, and under Roles without it', () => {
    const withAccess = visibleNavigation(persona({ permissions: ['role.read', 'role.assign'] }));
    expect(
      breadcrumbsFor(withAccess, '/admin/access-control/assignments').map((crumb) => crumb.label),
    ).toEqual(['Home', 'People', 'User Access']);
    expect(activeNavItem(withAccess, '/admin/access-control/assignments')?.id).toBe('user-access');
  });
});

describe('feature-flag (module) visibility', () => {
  it('hides entries whose module is disabled for the selected organization', () => {
    const tree = visibleNavigation(
      persona({
        systemPermissions: ALL_PERMISSIONS,
        modules: ORGANIZATION_MODULES.filter(
          (module) => module !== 'PAYROLL' && module !== 'RECRUITMENT',
        ),
        isEmployee: true,
      }),
    );
    for (const hidden of ['payroll', 'my-pay', 'recruitment', 'my-interviews'])
      expect(ids(tree)).not.toContain(hidden);
    expect(ids(tree)).toEqual(expect.arrayContaining(['compensation', 'onboarding', 'employees']));
  });

  it('drops a group when every child is disabled', () => {
    const tree = visibleNavigation(
      persona({
        systemPermissions: ALL_PERMISSIONS,
        modules: ORGANIZATION_MODULES.filter(
          (module) => !['RECRUITMENT', 'ONBOARDING', 'PERFORMANCE'].includes(module),
        ),
      }),
    );
    expect(groups(tree)).not.toContain('talent');
  });

  it('keeps core entries (no module) with every module off', () => {
    const tree = visibleNavigation(persona({ systemPermissions: ALL_PERMISSIONS, modules: [] }));
    expect(ids(tree)).toEqual(
      expect.arrayContaining(['home', 'employees', 'organization', 'features', 'roles', 'audit']),
    );
    expect(ids(tree)).not.toContain('reports');
    expect(ids(tree)).not.toContain('notification-settings');
  });
});

describe('fallback (authorization snapshot) visibility', () => {
  const fallback = (keys: string[]) =>
    navContextFromSnapshot({
      userId: 'user-1',
      permissions: keys.map((key) => ({ key, scopes: [{ type: 'TEAM', id: 'team-1' }] })),
    });

  it('shows items whose permission is held anywhere, without module filtering', () => {
    const tree = visibleNavigation(fallback(['payroll.read', 'report.read']));
    expect(ids(tree)).toEqual(expect.arrayContaining(['payroll', 'reports']));
    expect(ids(tree)).not.toContain('recruitment');
  });

  it('keeps self-service visible (employment unknown) and hides organization-specific items', () => {
    const tree = visibleNavigation(fallback(['organization.read', 'organization.manage']));
    for (const id of SELF_SERVICE) expect(ids(tree)).toContain(id);
    expect(ids(tree)).toContain('organization');
    expect(ids(tree)).not.toContain('positions');
    expect(ids(tree)).not.toContain('company-settings');
  });

  it('shows only Home and self-service without any permission', () => {
    expect(ids(visibleNavigation(navContextFromSnapshot(null)))).toEqual(['home', ...SELF_SERVICE]);
  });
});

describe('submenus and active state', () => {
  const tree = visibleNavigation(PERSONAS.systemOwner());

  it('renders group children in registry order', () => {
    expect(tree.find((item) => item.id === 'time')?.children.map((item) => item.label)).toEqual([
      'Attendance',
      'Timesheets',
      'Corrections',
      'Kiosk Management',
      'Attendance Policies',
    ]);
    expect(tree.find((item) => item.id === 'administration')?.children.map((c) => c.label)).toEqual(
      [
        'Company Settings',
        'Branding',
        'Features',
        'Notification Settings',
        'Integrations',
        'Roles & Permissions',
        'Audit Log',
      ],
    );
  });

  it('matches exact routes, nested routes and registered sub-pages', () => {
    expect(activeNavItem(tree, '/dashboard')?.id).toBe('home');
    expect(activeNavItem(tree, '/admin/employees')?.id).toBe('employees');
    expect(activeNavItem(tree, '/admin/employees/employee-1')?.id).toBe('employees');
    expect(activeNavItem(tree, '/admin/employees/new/')?.id).toBe('employees');
    expect(activeNavItem(tree, '/admin/payroll/runs/run-1')?.id).toBe('payroll');
    expect(activeNavItem(tree, '/recruitment/applications/app-1')?.id).toBe('recruitment');
    expect(activeNavItem(tree, '/onboarding/workflows/wf-1')?.id).toBe('onboarding');
    expect(activeNavItem(tree, '/reports/headcount')?.id).toBe('reports');
    expect(activeNavItem(tree, '/admin/settings')?.id).toBe('features');
    expect(activeNavItem(tree, '/admin/organizations/org-1/positions')?.id).toBe('positions');
    expect(activeNavItem(tree, '/admin/organizations/org-9/teams')?.id).toBe('organization');
    expect(activeNavItem(tree, '/somewhere-else')).toBeNull();
  });

  it('prefers the parent visible to the caller for shared sub-pages', () => {
    const employeeTree = visibleNavigation(PERSONAS.employee());
    expect(activeNavItem(employeeTree, '/onboarding/workflows/wf-1')?.id).toBe('my-onboarding');
    expect(activeNavItem(employeeTree, '/performance/reviews/r-1')?.id).toBe('my-performance');
  });

  it('activates hash entries only when the hash matches', () => {
    expect(activeNavItem(tree, '/admin/time')?.id).toBe('attendance');
    expect(activeNavItem(tree, '/admin/time', '#timesheets')?.id).toBe('timesheets');
    expect(activeNavItem(tree, '/admin/time', 'corrections')?.id).toBe('corrections');
    expect(activeNavItem(tree, '/admin/time', '#unknown')?.id).toBe('attendance');
    expect(activeNavItem(tree, '/admin/leave', '#holidays')?.id).toBe('holidays');
  });
});

describe('breadcrumbs', () => {
  const tree = visibleNavigation(PERSONAS.systemOwner());

  // Batch 10A: these pages' own "Back to …" links were removed because the breadcrumb offers the
  // same parent as a keyboard-reachable link.
  it('links the parent of pages whose back links were removed', () => {
    const employee = visibleNavigation(
      persona({ permissions: ['employee.read', 'employee.manage'] }),
    );
    expect(
      breadcrumbsFor(employee, '/admin/employees/new').find((crumb) => crumb.label === 'Employees'),
    ).toMatchObject({ href: '/admin/employees', current: false });
    const anyone = visibleNavigation(persona({ permissions: [] }));
    expect(
      breadcrumbsFor(anyone, '/notifications/preferences').find(
        (crumb) => crumb.label === 'Notifications',
      ),
    ).toMatchObject({ href: '/notifications', current: false });
  });

  // Batch 10B: the same for the employee profile ("← Employees") and the role detail page
  // ("← Roles & Permissions"). User Access keeps its link: its breadcrumb is People › User Access.
  it('links the parent of the employee profile and the role detail page', () => {
    const employee = visibleNavigation(persona({ permissions: ['employee.read'] }));
    expect(
      breadcrumbsFor(employee, '/admin/employees/emp-1').find(
        (crumb) => crumb.label === 'Employees',
      ),
    ).toMatchObject({ href: '/admin/employees', current: false });
    const roles = visibleNavigation(persona({ permissions: ['role.read'] }));
    expect(
      breadcrumbsFor(roles, '/admin/access-control/roles/role-1').find(
        (crumb) => crumb.label === 'Roles & Permissions',
      ),
    ).toMatchObject({ href: '/admin/access-control/roles', current: false });
  });

  // R5-A: /admin/employees/lifecycle also matches /admin/employees/[employeeId]; it is not an
  // employee profile. The crumb uses the page's own name (its title and the directory's button).
  it('names the ending-assignments page, not an employee profile, under Employees', () => {
    const employee = visibleNavigation(
      persona({ permissions: ['employee.read', 'employee.manage'] }),
    );
    const crumbs = breadcrumbsFor(employee, '/admin/employees/lifecycle');
    expect(crumbs.at(-1)).toEqual({ label: 'Ending assignments', href: null, current: true });
    expect(crumbs.find((crumb) => crumb.label === 'Employees')).toMatchObject({
      href: '/admin/employees',
      current: false,
    });
    expect(crumbs.map((crumb) => crumb.label)).not.toContain('Employee profile');
    // A profile (any other id) keeps its own crumb.
    expect(breadcrumbsFor(employee, '/admin/employees/emp-1').at(-1)?.label).toBe(
      'Employee profile',
    );
  });

  // Batch 10D: the payroll run page's "← Payroll" link was removed; the breadcrumb links Payroll.
  it('links the parent of a payroll run', () => {
    const payroll = visibleNavigation(persona({ permissions: ['payroll.read'] }));
    expect(
      breadcrumbsFor(payroll, '/admin/payroll/runs/run-1').find(
        (crumb) => crumb.href === '/admin/payroll',
      ),
    ).toMatchObject({ current: false });
  });

  it('is just the current Home on the dashboard', () => {
    expect(breadcrumbsFor(tree, '/dashboard')).toEqual([
      { label: 'Home', href: null, current: true },
    ]);
  });

  it('shows Home › group › page for a nav entry', () => {
    expect(breadcrumbsFor(tree, '/admin/payroll')).toEqual([
      { label: 'Home', href: '/dashboard', current: false },
      { label: 'Pay', href: null, current: false },
      { label: 'Payroll', href: null, current: true },
    ]);
  });

  it('links the parent entry from a sub-page', () => {
    expect(breadcrumbsFor(tree, '/admin/payroll/runs/run-1')).toEqual([
      { label: 'Home', href: '/dashboard', current: false },
      { label: 'Pay', href: null, current: false },
      { label: 'Payroll', href: '/admin/payroll', current: false },
      { label: 'Payroll run', href: null, current: true },
    ]);
  });

  it('includes intermediate pages and labelled parameters', () => {
    expect(
      breadcrumbsFor(tree, '/admin/organizations/org-9/units').map((c) => [c.label, c.href]),
    ).toEqual([
      ['Home', '/dashboard'],
      ['People', null],
      ['Organization', '/admin/organizations'],
      ['Organization details', '/admin/organizations/org-9'],
      ['Business Units', null],
    ]);
  });

  it('does not link entries the caller cannot open', () => {
    const employeeTree = visibleNavigation(PERSONAS.employee());
    const crumbs = breadcrumbsFor(employeeTree, '/admin/payroll/runs/run-1');
    expect(crumbs.find((crumb) => crumb.label === 'Payroll')?.href).toBeNull();
  });

  it('uses the hash entry label for deep links', () => {
    expect(breadcrumbsFor(tree, '/admin/time', '#timesheets').at(-1)).toEqual({
      label: 'Timesheets',
      href: null,
      current: true,
    });
  });

  it('covers every registered sub-page pattern', () => {
    for (const crumb of ROUTE_CRUMBS) {
      const path = crumb.pattern.replace(/\[[^\]]+\]/g, 'x');
      const trail = breadcrumbsFor(tree, path);
      expect(trail.at(-1)?.current, crumb.pattern).toBe(true);
      expect(trail[0]?.label).toBe('Home');
    }
  });
});

describe('matchPattern', () => {
  it('matches segments and decodes parameters', () => {
    expect(matchPattern('/reports/[key]', '/reports/head%20count')).toEqual({ key: 'head count' });
    expect(matchPattern('/reports/[key]', '/reports')).toBeNull();
    expect(matchPattern('/a/b', '/a/c')).toBeNull();
  });
});
