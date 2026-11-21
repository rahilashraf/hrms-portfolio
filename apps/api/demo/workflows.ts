import type { PrismaService } from '../src/database/prisma.service.js';
import { EventNotificationPublisher } from '../src/notifications/notifications-events.js';
import { signIn, type DemoSession } from './api-client.js';
import {
  DEMO_ACCOUNTS,
  DEPARTMENTS,
  EMPLOYEES,
  ORGANIZATIONS,
  POSITIONS,
  STRUCTURE_ROLES,
  type DemoAccountKey,
  type DemoEmployee,
  type DemoOrganizationKey,
  type DemoRole,
} from './dataset.js';
import { seedDemoOperations } from './operations.js';
import { seedDemoScenarios } from './scenarios.js';

/**
 * Batch 11 — the demo's workflow phase. Every record below is created through the HTTP API as a
 * demo user who is allowed to do it (separation of duties included: nobody approves their own
 * leave, timesheet or payroll). Lookups for idempotency are read-only database queries; nothing
 * here writes to the database directly. Each step checks what exists first, so a rerun creates
 * nothing new and advances nothing that already advanced.
 */

export interface SeedContext {
  prisma: PrismaService;
  apiUrl: string;
  /** The demo's reference Monday (YYYY-MM-DD); every date is relative to it. */
  referenceDate: string;
  passwords: Record<string, string>;
  log(message: string): void;
}

export interface Summary {
  created: Record<string, number>;
  existing: Record<string, number>;
  skipped: string[];
}

export interface DemoWorld {
  context: SeedContext;
  summary: Summary;
  session(key: DemoAccountKey): Promise<DemoSession>;
  organizationIds: Record<DemoOrganizationKey, string>;
  /** Employee number → employee id, primary assignment id, person id, user id (if any). */
  employees: Map<
    string,
    {
      id: string;
      assignmentId: string;
      personId: string;
      userId: string | null;
      spec: DemoEmployee;
    }
  >;
  positionIds: Map<string, string>;
  departmentIds: Map<string, string>;
  date(offsetDays: number): string;
}

export function addDays(date: string, days: number) {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! + days))
    .toISOString()
    .slice(0, 10);
}

const dateColumn = (date: string) => new Date(`${date}T00:00:00.000Z`);

/** Counts a created or existing record for the summary. */
export function tally(summary: Summary, kind: string, created: boolean) {
  const bucket = created ? summary.created : summary.existing;
  bucket[kind] = (bucket[kind] ?? 0) + 1;
}

/** The position code an employee occupies (positions are single-occupancy). */
export const positionCode = (employee: DemoEmployee) =>
  `${employee.position}-${employee.number.slice(3)}`;

async function ensureOrganizations(world: DemoWorld) {
  const owner = await world.session('owner');
  for (const key of Object.keys(ORGANIZATIONS) as DemoOrganizationKey[]) {
    const spec = ORGANIZATIONS[key];
    const existing = await world.context.prisma.organization.findUnique({
      where: { code: spec.code },
      select: { id: true },
    });
    if (existing) {
      world.organizationIds[key] = existing.id;
      tally(world.summary, 'organizations', false);
      continue;
    }
    const created = await owner.post<{ id: string }>('/organizations', {
      code: spec.code,
      name: spec.name,
      description: spec.description,
      timezone: spec.timezone,
    });
    world.organizationIds[key] = created.id;
    tally(world.summary, 'organizations', true);
  }
}

async function ensureStructure(world: DemoWorld) {
  const owner = await world.session('owner');
  const { prisma } = world.context;
  for (const key of Object.keys(ORGANIZATIONS) as DemoOrganizationKey[]) {
    const organizationId = world.organizationIds[key];
    const base = `/organizations/${organizationId}`;
    for (const department of DEPARTMENTS[key]) {
      const existing = await prisma.department.findFirst({
        where: { organizationId, code: department.code },
        select: { id: true },
      });
      const id =
        existing?.id ??
        (await owner.post<{ id: string }>(`${base}/departments`, department))
          .id;
      world.departmentIds.set(`${key}:${department.code}`, id);
      tally(world.summary, 'departments', !existing);
    }
    for (const position of POSITIONS[key]) {
      const existing = await prisma.jobTitle.findFirst({
        where: { organizationId, code: position.code },
        select: { id: true },
      });
      const jobTitleId =
        existing?.id ??
        (
          await owner.post<{ id: string }>(`${base}/job-titles`, {
            code: position.code,
            name: position.name,
          })
        ).id;
      tally(world.summary, 'jobTitles', !existing);
      // One position per person who holds this title, plus open counsellor seats for hiring.
      const holders = EMPLOYEES.filter(
        (employee) =>
          employee.organization === key && employee.position === position.code,
      ).map(positionCode);
      const codes =
        position.code === 'CNS'
          ? [...holders, 'CNS-OPEN1', 'CNS-OPEN2']
          : holders;
      for (const code of codes) {
        const found = await prisma.position.findFirst({
          where: { organizationId, code },
          select: { id: true },
        });
        const id =
          found?.id ??
          (
            await owner.post<{ id: string }>(`${base}/positions`, {
              code,
              name: position.name,
              jobTitleId,
              departmentId: world.departmentIds.get(
                `${key}:${position.department}`,
              ),
            })
          ).id;
        world.positionIds.set(`${key}:${code}`, id);
        tally(world.summary, 'positions', !found);
      }
    }
  }
}

/** Managers before the people who report to them. */
function inHierarchyOrder(employees: readonly DemoEmployee[]) {
  const ordered: DemoEmployee[] = [];
  const placed = new Set<string>();
  while (ordered.length < employees.length) {
    const before = ordered.length;
    for (const employee of employees) {
      if (placed.has(employee.number)) continue;
      if (employee.manager && !placed.has(employee.manager)) continue;
      ordered.push(employee);
      placed.add(employee.number);
    }
    if (ordered.length === before)
      throw new Error('Demo manager hierarchy has a cycle.');
  }
  return ordered;
}

async function ensureEmployees(world: DemoWorld) {
  const owner = await world.session('owner');
  const { prisma } = world.context;
  const accountPersons = new Map(
    (
      await prisma.user.findMany({
        where: { email: { in: DEMO_ACCOUNTS.map((account) => account.email) } },
        select: { email: true, personId: true, id: true },
      })
    ).map((user) => [user.email, user]),
  );
  for (const spec of inHierarchyOrder(EMPLOYEES)) {
    const account = spec.account
      ? DEMO_ACCOUNTS.find((candidate) => candidate.key === spec.account)
      : undefined;
    const user = account ? accountPersons.get(account.email) : undefined;
    const hireDate = world.date(-spec.hiredDaysAgo);
    let employee = await prisma.employee.findUnique({
      where: { employeeNumber: spec.number },
      select: { id: true, personId: true },
    });
    if (!employee) {
      const manager = spec.manager
        ? world.employees.get(spec.manager)
        : undefined;
      await owner.post('/employees', {
        ...(user
          ? { personId: user.personId }
          : { person: { firstName: spec.firstName, lastName: spec.lastName } }),
        employeeNumber: spec.number,
        hireDate,
        initialPositionId: world.positionIds.get(
          `${spec.organization}:${positionCode(spec)}`,
        ),
        initialEmploymentType:
          spec.pay.type === 'SALARY' ? 'FULL_TIME' : 'PART_TIME',
        initialStartDate: hireDate,
        initialPrimary: true,
        ...(manager
          ? { initialManagerAssignmentId: manager.assignmentId }
          : {}),
      });
      employee = await prisma.employee.findUniqueOrThrow({
        where: { employeeNumber: spec.number },
        select: { id: true, personId: true },
      });
      tally(world.summary, 'employees', true);
    } else {
      tally(world.summary, 'employees', false);
    }
    const assignment = await prisma.employmentAssignment.findFirstOrThrow({
      where: { employeeId: employee.id, isPrimary: true },
      orderBy: { startDate: 'asc' },
      select: { id: true },
    });
    world.employees.set(spec.number, {
      id: employee.id,
      assignmentId: assignment.id,
      personId: employee.personId,
      userId: user?.id ?? null,
      spec,
    });
  }
}

/**
 * Organization roles: what each demo account may do, and nothing more. Assigned to the whole
 * organization unless the role names a narrower scope (R5-A: the structure roles).
 */
const ROLES: Record<DemoOrganizationKey, ReadonlyArray<DemoRole>> = {
  centre: [
    {
      code: 'HL-EMPLOYEE',
      name: 'Employee self-service',
      permissions: ['time.clock', 'leave.request'],
      holders: ['hr', 'payroll', 'manager', 'employee', 'recruiter'],
    },
    {
      code: 'HL-HR-ADMIN',
      name: 'HR administrator',
      permissions: [
        'organization.read',
        'employee.read',
        'employee.manage',
        'employee.account.manage',
        'role.read',
        'leave.read',
        'leave.approve',
        'leave.adjust',
        'leave.manage_policy',
        'holiday.manage',
        'time.view',
        'compensation.read',
        'compensation.manage',
        'benefit.read',
        'benefit.manage',
        'benefit.plan.manage',
        'performance.read',
        'performance.manage',
        'performance.template.manage',
        'performance.cycle.manage',
        'recruitment.read',
        'recruitment.manage',
        'recruitment.offer.approve',
        'recruitment.hire',
        'recruitment.pipeline.manage',
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
        'notification.delivery.read',
        'report.read',
        'audit.read',
      ],
      holders: ['hr'],
    },
    {
      code: 'HL-PAYROLL-ADMIN',
      name: 'Payroll administrator',
      permissions: [
        'employee.read',
        'compensation.read',
        'compensation.manage',
        'payroll.read',
        'payroll.manage',
        'payroll.calculate',
        'payroll.approve',
        'payroll.finalize',
        'payroll.adjust',
        'time.view',
        'time.timesheet.manage',
        'benefit.read',
        'report.read',
        'report.export',
      ],
      holders: ['payroll'],
    },
    {
      code: 'HL-PROGRAMS-MANAGER',
      name: 'Programs manager',
      permissions: [
        'employee.read',
        'time.view',
        'time.approve',
        'time.correct',
        'time.timesheet.approve',
        'time.timesheet.manage',
        'schedule.read',
        'schedule.manage',
        'schedule.publish',
        'schedule.manage_templates',
        'leave.read',
        'leave.approve',
        'performance.read',
        'recruitment.read',
      ],
      holders: ['manager'],
    },
    {
      code: 'HL-RECRUITER',
      name: 'Recruiter',
      permissions: [
        'employee.read',
        'recruitment.read',
        'recruitment.manage',
        'recruitment.pipeline.manage',
      ],
      holders: ['recruiter'],
    },
    ...STRUCTURE_ROLES,
  ],
  studio: [
    {
      code: 'HL-STUDIO-LEAD',
      name: 'Studio lead',
      permissions: [
        'organization.read',
        'employee.read',
        'time.clock',
        'time.view',
        'time.approve',
        'leave.request',
        'leave.read',
        'leave.approve',
        'schedule.read',
        'performance.read',
        'document.read',
      ],
      holders: ['studioLead'],
    },
  ],
};

async function ensureRoles(world: DemoWorld) {
  const owner = await world.session('owner');
  const { prisma } = world.context;
  const userIds = new Map(
    (
      await prisma.user.findMany({
        where: { email: { in: DEMO_ACCOUNTS.map((account) => account.email) } },
        select: { email: true, id: true },
      })
    ).map((user) => [user.email, user.id]),
  );
  for (const key of Object.keys(ROLES) as DemoOrganizationKey[]) {
    const organizationId = world.organizationIds[key];
    for (const role of ROLES[key]) {
      let found = await prisma.role.findFirst({
        where: { organizationId, code: role.code },
        select: { id: true },
      });
      if (!found) {
        found = await owner.post<{ id: string }>(
          `/authorization/organizations/${organizationId}/roles`,
          {
            code: role.code,
            name: role.name,
            permissionKeys: role.permissions,
          },
        );
        tally(world.summary, 'roles', true);
      } else {
        tally(world.summary, 'roles', false);
      }
      for (const holder of role.holders) {
        const email = DEMO_ACCOUNTS.find(
          (account) => account.key === holder,
        )!.email;
        const userId = userIds.get(email)!;
        const scope =
          role.scope?.type === 'DEPARTMENT'
            ? {
                type: 'DEPARTMENT' as const,
                id: world.departmentIds.get(`${key}:${role.scope.department}`)!,
              }
            : { type: 'ORGANIZATION' as const, id: organizationId };
        const assigned = await prisma.roleAssignment.findFirst({
          where: {
            userId,
            roleId: found.id,
            revokedAt: null,
            scopeType: scope.type,
            ...(scope.type === 'DEPARTMENT'
              ? { departmentId: scope.id }
              : { organizationId: scope.id }),
          },
          select: { id: true },
        });
        if (!assigned) {
          await owner.post('/authorization/assignments', {
            userId,
            roleId: found.id,
            scope,
          });
        }
        tally(world.summary, 'roleAssignments', !assigned);
      }
    }
  }
}

export async function seedDemoWorkflows(
  context: SeedContext,
): Promise<Summary> {
  const summary: Summary = { created: {}, existing: {}, skipped: [] };
  const sessions = new Map<
    DemoAccountKey,
    { session: DemoSession; at: number }
  >();
  const world: DemoWorld = {
    context,
    summary,
    organizationIds: {} as Record<DemoOrganizationKey, string>,
    employees: new Map(),
    positionIds: new Map(),
    departmentIds: new Map(),
    date: (offset) => addDays(context.referenceDate, offset),
    async session(key) {
      // Access tokens last 15 minutes; sign in again well before that. Sign-ins are paced by
      // the API's limiter (10 a minute per address), so each account signs in once per window.
      const cached = sessions.get(key);
      if (cached && Date.now() - cached.at < 12 * 60_000) return cached.session;
      const email = DEMO_ACCOUNTS.find((account) => account.key === key)!.email;
      const session = await signIn(
        context.apiUrl,
        email,
        context.passwords[key]!,
      );
      sessions.set(key, { session, at: Date.now() });
      return session;
    },
  };

  // Notifications are published from committed records by the worker; the first run sets the
  // checkpoints (history is never notified), so set them before the demo's events happen.
  const publisher = new EventNotificationPublisher(context.prisma);
  await publisher.run({ horizonMarginMs: 0 });

  context.log('Organizations and structure…');
  await ensureOrganizations(world);
  await ensureStructure(world);
  context.log('Employees and roles…');
  await ensureEmployees(world);
  await ensureRoles(world);
  await seedDemoOperations(world);
  await seedDemoScenarios(world);

  // Publish the notifications for everything the demo just did (the worker would do the same
  // within two minutes).
  await publisher.run({ horizonMarginMs: 0 });
  return summary;
}

export { dateColumn };
