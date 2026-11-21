import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '../src/audit/audit.service.js';
import { AuthorizationService } from '../src/authorization/authorization.service.js';
import { PositionAuthorizationTargetResolver } from '../src/authorization/position-authorization-target.resolver.js';
import { RoleManagementService } from '../src/authorization/role-management.service.js';
import { DEFAULT_PUBLIC_BRANDING } from '../src/branding/branding-domain.js';
import { BrandingService } from '../src/branding/branding.service.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { DashboardService } from '../src/workspace/dashboard.service.js';
import { EmployeeCapabilitiesService } from '../src/workspace/employee-capabilities.service.js';
import { SetupService } from '../src/workspace/setup.service.js';
import { WorkspaceService } from '../src/workspace/workspace.service.js';
import {
  documentServices,
  FixedDocumentsClock,
} from './support/documents-fixtures.js';
import {
  LEAVE_USERS,
  leaveServices,
  seedLeaveConfig,
} from './support/leave-fixtures.js';
import { failure } from './support/performance-fixtures.js';
import {
  cleanupSchedulingFixtures,
  createSchedulingFixtures,
  ctx,
  rollbackClient,
  violation,
  type SchedulingFixtures,
  type Tx,
  type UserSpec,
} from './support/scheduling-fixtures.js';

config({ path: '../../.env' });

class RollbackFixtures extends Error {}

const BRANDING = 'organization.branding.manage';

/** Personas: permissions only, never role names. */
const USERS: Record<string, UserSpec[]> = {
  ...LEAVE_USERS,
  // Employee 2: self-service plus a team approver and org-level readers (own-record rules).
  self2: [
    { permissions: ['leave.request', 'time.clock'], scope: 'org' },
    { permissions: ['leave.approve', 'leave.read'], scope: 'teamA' },
    {
      permissions: [
        'employee.read',
        'document.read',
        'document.manage',
        'compensation.read',
        'compensation.manage',
        'performance.read',
      ],
      scope: 'org',
    },
  ],
  hrAdmin: [
    {
      permissions: [
        'organization.read',
        'employee.read',
        'employee.manage',
        'leave.approve',
        'leave.read',
        'onboarding.read',
        'recruitment.read',
        'recruitment.manage',
        'performance.read',
        'document.read',
        'time.view',
        'time.timesheet.approve',
      ],
      scope: 'org',
    },
  ],
  payrollAdmin: [
    {
      permissions: [
        'payroll.read',
        'payroll.calculate',
        'payroll.manage',
        'compensation.read',
        'compensation.manage',
        'employee.read',
      ],
      scope: 'org',
    },
  ],
  brandingAdmin: [{ permissions: [BRANDING], scope: 'org' }],
  orgReader: [{ permissions: ['organization.read'], scope: 'org' }],
  roleReader: [{ permissions: ['role.read', 'employee.read'], scope: 'org' }],
  teamManager: [
    {
      permissions: [
        'employee.read',
        'leave.approve',
        'time.view',
        'recruitment.read',
      ],
      scope: 'teamA',
    },
  ],
  deptBViewer: [{ permissions: ['employee.read'], scope: 'deptB' }],
  // Batch 5C: manages only Employee 1's Team A assignment, not every assignment in effect.
  teamAEmployeeManager: [
    { permissions: ['employee.read', 'employee.manage'], scope: 'teamA' },
  ],
  unitViewer: [{ permissions: ['employee.read'], scope: 'unitChild' }],
  // Batch 7A: onboarding and offboarding starts from the profile.
  teamOnboarding: [
    { permissions: ['employee.read', 'onboarding.manage'], scope: 'teamA' },
  ],
  offboarding: [
    { permissions: ['employee.read', 'offboarding.manage'], scope: 'org' },
  ],
  orgBAdmin: [
    {
      permissions: [
        'organization.read',
        BRANDING,
        'employee.read',
        'role.read',
        'leave.approve',
      ],
      scope: 'orgB',
    },
  ],
};

function services(prisma: PrismaService) {
  const authorization = new AuthorizationService(prisma);
  const audit = new AuditService(prisma);
  const leave = leaveServices(prisma);
  const docs = documentServices(prisma, new FixedDocumentsClock());
  return {
    leave,
    workspace: new WorkspaceService(prisma, authorization),
    branding: new BrandingService(prisma, authorization, audit),
    dashboard: new DashboardService(
      prisma,
      authorization,
      leave.views,
      docs.documents,
      docs.policies,
    ),
    setup: new SetupService(prisma, authorization),
    capabilities: new EmployeeCapabilitiesService(
      prisma,
      authorization,
      new PositionAuthorizationTargetResolver(prisma),
      docs.access,
    ),
    roles: new RoleManagementService(prisma, authorization, audit),
  };
}
type Services = ReturnType<typeof services>;

/** The reserved System Owner (SYSTEM scope) for a fresh user, inside the test transaction. */
async function systemOwner(tx: Tx, fx: SchedulingFixtures) {
  const role =
    (await tx.role.findFirst({ where: { isSystemOwner: true } })) ??
    (await tx.role.create({
      data: {
        organizationId: null,
        code: 'SYSTEM_OWNER',
        name: 'System Owner',
        isSystemOwner: true,
      },
    }));
  for (const key of ['employee.read', 'employee.manage', 'organization.read']) {
    const permission = await tx.permission.findUniqueOrThrow({
      where: { key },
    });
    await tx.rolePermission.upsert({
      where: {
        roleId_permissionId: { roleId: role.id, permissionId: permission.id },
      },
      create: { roleId: role.id, permissionId: permission.id },
      update: {},
    });
  }
  const person = await tx.person.create({ data: {} });
  const user = await tx.user.create({
    data: {
      personId: person.id,
      email: `p20-owner-${fx.suffix.toLowerCase()}@example.com`,
      status: 'ACTIVE',
    },
  });
  await tx.roleAssignment.create({
    data: { userId: user.id, roleId: role.id, scopeType: 'SYSTEM' },
  });
  return user.id;
}

const disable = (tx: Tx, organizationId: string, module: 'LEAVE') =>
  tx.organizationModuleSetting.create({
    data: { organizationId, module, enabled: false },
  });

describe('Phase 20 workspace, branding, dashboard, setup and capabilities (database)', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService(process.env.DATABASE_URL!);
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  async function scenario(
    run: (tx: Tx, fx: SchedulingFixtures, svc: Services) => Promise<void>,
  ) {
    await expect(
      prisma.$transaction(
        async (tx) => {
          const fx = await createSchedulingFixtures(tx, USERS, [BRANDING]);
          const svc = services(rollbackClient(tx));
          await run(tx, fx, svc).catch((error: unknown) => {
            console.error('SCENARIO FAILURE', error);
            throw error;
          });
          throw new RollbackFixtures();
        },
        { timeout: 120_000 },
      ),
    ).rejects.toBeInstanceOf(RollbackFixtures);
  }

  // ─── Workspace context ────────────────────────────────────────────────────

  it('builds the workspace context per persona, isolated per organization', async () => {
    await scenario(async (tx, fx, svc) => {
      // Employee 1 manages Employee 2's Team A assignment.
      await tx.employmentAssignment.update({
        where: { id: fx.otherTeamA },
        data: { managerAssignmentId: fx.assignmentTeamA },
      });
      const orgOf = async (userId: string, organizationId = fx.orgA) =>
        (await svc.workspace.workspace(userId)).organizations.find(
          (o) => o.id === organizationId,
        );

      // Employee with self-service grants only.
      const employee = await svc.workspace.workspace(fx.selfUser1);
      expect(employee.user).toMatchObject({
        id: fx.selfUser1,
        displayName: `Employee1 ${fx.suffix}`,
      });
      expect(employee.systemPermissions).toEqual([]);
      expect(employee.organizations.map((o) => o.id)).toEqual([fx.orgA]);
      expect(employee.organizations[0]).toMatchObject({
        isEmployee: true,
        isManager: true,
        permissions: ['leave.request', 'time.clock'],
        branding: null,
      });
      expect(employee.organizations[0]!.enabledModules).toContain('LEAVE');
      expect(await orgOf(fx.selfUser2)).toMatchObject({
        isEmployee: true,
        isManager: false,
      });

      // HR administrator: organization grants, not an employee.
      const hr = await orgOf(fx.users.hrAdmin!);
      expect(hr).toMatchObject({ isEmployee: false, isManager: false });
      expect(hr!.permissions).toEqual(
        expect.arrayContaining(['employee.manage', 'organization.read']),
      );
      expect(
        (await svc.workspace.workspace(fx.users.hrAdmin!)).organizations,
      ).toHaveLength(1);

      // Payroll administrator.
      expect((await orgOf(fx.users.payrollAdmin!))!.permissions).toEqual([
        'compensation.manage',
        'compensation.read',
        'employee.read',
        'payroll.calculate',
        'payroll.manage',
        'payroll.read',
      ]);

      // Team-, department- and unit-scoped grants reach their organization.
      for (const user of ['teamManager', 'deptBViewer', 'unitViewer'])
        expect((await orgOf(fx.users[user]!))!.permissions).toContain(
          'employee.read',
        );

      // Cross-organization isolation.
      const orgB = await svc.workspace.workspace(fx.users.orgBAdmin!);
      expect(orgB.organizations.map((o) => o.id)).toEqual([fx.orgB]);
      expect(orgB.organizations[0]!.permissions).not.toContain('time.view');

      // System owner: every non-archived organization, SYSTEM permissions everywhere.
      const owner = await systemOwner(tx, fx);
      const system = await svc.workspace.workspace(owner);
      expect(system.systemPermissions).toEqual(
        expect.arrayContaining(['employee.manage', 'organization.read']),
      );
      const ids = system.organizations.map((o) => o.id);
      expect(ids).toEqual(expect.arrayContaining([fx.orgA, fx.orgB]));
      expect(
        system.organizations.find((o) => o.id === fx.orgB)!.permissions,
      ).toEqual(expect.arrayContaining(system.systemPermissions));

      // A disabled module is left out of enabledModules (and only there).
      await disable(tx, fx.orgA, 'LEAVE');
      const after = await orgOf(fx.selfUser1);
      expect(after!.enabledModules).not.toContain('LEAVE');
      expect(after!.enabledModules).toContain('ATTENDANCE');
      expect(
        (await orgOf(fx.users.orgBAdmin!, fx.orgB))!.enabledModules,
      ).toContain('LEAVE');

      // Branding summary once branding is set.
      await svc.branding.update(
        fx.orgA,
        {
          displayName: 'Acme Health',
          primaryColor: '#112233',
          supportEmail: 'help@example.com',
          expectedVersion: 0,
        },
        ctx(fx.users.brandingAdmin!),
      );
      expect((await orgOf(fx.selfUser1))!.branding).toEqual({
        displayName: 'Acme Health',
        shortName: 'Acme Health',
        logoUrl: null,
        iconUrl: null,
        primaryColor: '#112233',
        secondaryColor: null,
      });
    });
  });

  // ─── Branding ─────────────────────────────────────────────────────────────

  it('persists branding with permission checks, optimistic concurrency and safe audit', async () => {
    await scenario(async (tx, fx, svc) => {
      const admin = ctx(fx.users.brandingAdmin!);
      // Read: organization.read or branding.manage at the organization.
      expect(
        await svc.branding.get(fx.users.orgReader!, fx.orgA),
      ).toMatchObject({
        organizationId: fx.orgA,
        version: 0,
        displayName: null,
      });
      expect(
        (await svc.branding.get(fx.users.brandingAdmin!, fx.orgA)).version,
      ).toBe(0);
      expect(
        await failure(svc.branding.get(fx.users.teamManager!, fx.orgA)),
      ).toMatchObject({ status: 403 });
      expect(
        await failure(svc.branding.get(fx.users.orgBAdmin!, fx.orgA)),
      ).toMatchObject({ status: 404 });
      expect(
        await failure(
          svc.branding.get(
            fx.users.brandingAdmin!,
            '00000000-0000-4000-8000-000000000999',
          ),
        ),
      ).toMatchObject({ status: 404 });

      // Write: branding.manage only.
      const input = {
        displayName: ' Acme Health ',
        logoUrl: 'https://cdn.example.com/logo.svg',
        primaryColor: '#aabbcc',
        supportEmail: 'help@example.com',
        publicLoginEnabled: true,
        expectedVersion: 0,
      };
      for (const user of ['orgReader', 'hrAdmin', 'orgBAdmin', 'teamManager'])
        expect(
          await failure(
            svc.branding.update(fx.orgA, input, ctx(fx.users[user]!)),
          ),
        ).toMatchObject({ status: user === 'orgBAdmin' ? 404 : 403 });
      expect(
        await failure(
          svc.branding.update(
            fx.orgA,
            { ...input, logoUrl: 'http://cdn.example.com/logo.svg' },
            admin,
          ),
        ),
      ).toMatchObject({ status: 400, code: 'BRANDING_INVALID' });

      const created = await svc.branding.update(fx.orgA, input, admin);
      expect(created).toMatchObject({
        organizationId: fx.orgA,
        displayName: 'Acme Health',
        primaryColor: '#AABBCC',
        publicLoginEnabled: true,
        version: 1,
        updatedByUserId: fx.users.brandingAdmin,
      });
      expect(
        await failure(svc.branding.update(fx.orgA, input, admin)),
      ).toMatchObject({ status: 409, code: 'BRANDING_VERSION_CONFLICT' });
      const updated = await svc.branding.update(
        fx.orgA,
        { ...input, logoUrl: null, expectedVersion: 1 },
        admin,
      );
      expect(updated).toMatchObject({ version: 2, logoUrl: null });

      const audits = await tx.auditLog.findMany({
        where: {
          action: 'ORGANIZATION_BRANDING_UPDATED',
          actorUserId: fx.users.brandingAdmin,
        },
        orderBy: { occurredAt: 'asc' },
      });
      expect(audits.map((a) => a.metadata)).toEqual([
        {
          organizationId: fx.orgA,
          changedFields: [
            'displayName',
            'logoUrl',
            'primaryColor',
            'supportEmail',
            'publicLoginEnabled',
          ],
          version: 1,
          created: true,
          publicLoginEnabled: true,
        },
        {
          organizationId: fx.orgA,
          changedFields: ['logoUrl'],
          version: 2,
          created: false,
          publicLoginEnabled: true,
        },
      ]);
      const serialized = JSON.stringify(audits);
      expect(serialized).not.toContain('https://');
      expect(serialized).not.toContain('help@example.com');
      expect(serialized).not.toContain('Acme');

      // The database refuses non-https references and malformed colors directly.
      for (const data of [
        { iconUrl: 'http://example.com/icon.png' },
        { iconUrl: 'data:image/png;base64,AAAA' },
        { primaryColor: '#abc' },
        { supportEmail: 'nope' },
        { displayName: ' padded ' },
      ])
        expect(
          await violation(tx, () =>
            tx.organizationBranding.update({
              where: { organizationId: fx.orgA },
              data,
            }),
          ),
        ).toBeInstanceOf(Error);
    });
  });

  it('serves public branding with only public fields and DEFAULT fallbacks', async () => {
    await scenario(async (tx, fx, svc) => {
      const codes = await tx.organization.findMany({
        where: { id: { in: [fx.orgA, fx.orgB] } },
        select: { id: true, code: true },
      });
      const codeOf = (id: string) => codes.find((c) => c.id === id)!.code;
      // Nothing opted in yet.
      expect(await svc.branding.publicBranding(codeOf(fx.orgA))).toEqual(
        DEFAULT_PUBLIC_BRANDING,
      );
      await svc.branding.update(
        fx.orgA,
        {
          displayName: 'Acme Health',
          logoUrl: 'https://cdn.example.com/private.svg',
          loginLogoUrl: 'https://cdn.example.com/login.svg',
          loginSubtitle: 'Sign in to Acme',
          supportEmail: 'help@example.com',
          publicLoginEnabled: true,
          expectedVersion: 0,
        },
        ctx(fx.users.brandingAdmin!),
      );
      await svc.branding.update(
        fx.orgB,
        {
          displayName: 'Org B private',
          publicLoginEnabled: false,
          expectedVersion: 0,
        },
        ctx(fx.users.orgBAdmin!),
      );
      const result = await svc.branding.publicBranding(codeOf(fx.orgA));
      expect(result).toEqual({
        source: 'ORGANIZATION',
        displayName: 'Acme Health',
        shortName: 'Acme Health',
        loginLogoUrl: 'https://cdn.example.com/login.svg',
        iconUrl: null,
        primaryColor: null,
        secondaryColor: null,
        loginSubtitle: 'Sign in to Acme',
        websiteUrl: null,
        supportEmail: 'help@example.com',
      });
      const serialized = JSON.stringify(result);
      for (const secret of ['private.svg', fx.orgA, 'version', 'updatedBy'])
        expect(serialized).not.toContain(secret);
      // Not opted in, unknown code, or no code with several organizations: DEFAULT.
      expect(await svc.branding.publicBranding(codeOf(fx.orgB))).toEqual(
        DEFAULT_PUBLIC_BRANDING,
      );
      expect(await svc.branding.publicBranding('NO-SUCH-CODE')).toEqual(
        DEFAULT_PUBLIC_BRANDING,
      );
      expect(await svc.branding.publicBranding(undefined)).toEqual(
        DEFAULT_PUBLIC_BRANDING,
      );
      // An archived organization is never served.
      await tx.organization.update({
        where: { id: fx.orgA },
        data: { archivedAt: new Date() },
      });
      expect(await svc.branding.publicBranding(codeOf(fx.orgA))).toEqual(
        DEFAULT_PUBLIC_BRANDING,
      );
    });
  });

  it('lets exactly one of two concurrent first writes win (committed data)', async () => {
    const fx = await prisma.$transaction(
      (tx) => createSchedulingFixtures(tx, USERS, [BRANDING]),
      { timeout: 60_000 },
    );
    try {
      const svc = services(prisma);
      const write = (name: string) =>
        svc.branding.update(
          fx.orgA,
          { displayName: name, expectedVersion: 0 },
          ctx(fx.users.brandingAdmin!),
        );
      const results = await Promise.allSettled([write('One'), write('Two')]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find(
        (r) => r.status === 'rejected',
      ) as PromiseRejectedResult;
      expect(
        (rejected.reason as { getResponse(): { code: string } }).getResponse()
          .code,
      ).toBe('BRANDING_VERSION_CONFLICT');
      expect(
        await prisma.organizationBranding.findUniqueOrThrow({
          where: { organizationId: fx.orgA },
        }),
      ).toMatchObject({ version: 1 });
    } finally {
      await cleanupSchedulingFixtures(prisma, fx);
    }
  });

  // ─── Role templates and permission labels ─────────────────────────────────

  it('serves role templates to role readers only, and labels the permission catalog', async () => {
    await scenario(async (_tx, fx, svc) => {
      const templates = await svc.roles.listRoleTemplates(fx.users.roleReader!);
      expect(templates.items.map((t) => t.key)).toContain('AUDITOR');
      // Security remediation M2 added Payroll preparer and Payroll approver.
      expect(templates.items).toHaveLength(11);
      const inOrg = await svc.roles.listRoleTemplates(
        fx.users.roleReader!,
        fx.orgA,
      );
      expect(
        inOrg.items.find((t) => t.key === 'MANAGER')!.missingPermissions,
      ).not.toContain('employee.read');
      expect(
        inOrg.items.find((t) => t.key === 'MANAGER')!.missingPermissions,
      ).toContain('leave.approve');
      for (const user of ['brandingAdmin', 'teamManager', 'selfUser1'])
        expect(
          await failure(
            svc.roles.listRoleTemplates(
              user === 'selfUser1' ? fx.selfUser1 : fx.users[user]!,
            ),
          ),
        ).toMatchObject({ status: 403 });
      expect(
        await failure(
          svc.roles.listRoleTemplates(fx.users.orgBAdmin!, fx.orgA),
        ),
      ).toMatchObject({ status: 403 });
      const permissions = await svc.roles.listPermissions(
        fx.users.roleReader!,
        fx.orgA,
      );
      expect(permissions.length).toBeGreaterThan(0);
      for (const row of permissions) {
        expect(row.area, row.key).toBeTruthy();
        expect(row.label, row.key).toBeTruthy();
      }
      expect(permissions.find((p) => p.key === BRANDING)).toMatchObject({
        area: 'Administration',
        label: 'Manage branding',
      });
    });
  });

  // ─── Dashboard ────────────────────────────────────────────────────────────

  it('shows only authorized cards with scoped counts, and omits disabled modules', async () => {
    await scenario(async (tx, fx, svc) => {
      const types = await seedLeaveConfig(tx, fx, svc.leave);
      const submit = (user: string, assignment: string, date: string) =>
        svc.leave.requests.submitOwn(
          user,
          {
            employmentAssignmentId: assignment,
            leaveTypeId: types.personal.id,
            startDate: date,
            endDate: date,
          },
          ctx(user),
        );
      await submit(fx.selfUser1, fx.assignmentTeamA, '2027-03-03');
      await submit(fx.selfUser2, fx.otherTeamA, '2027-03-04');
      await submit(fx.selfUser2, fx.orgLevel, '2027-03-05');
      const opening = async (
        code: string,
        placement: Record<string, unknown>,
      ) => {
        const draft = await tx.jobOpening.create({
          data: {
            organizationId: fx.orgA,
            code: `${code}-${fx.suffix}`,
            title: 'Opening',
            employmentType: 'FULL_TIME',
            ...placement,
          },
        });
        return tx.jobOpening.update({
          where: { id: draft.id },
          data: { status: 'OPEN', openedAt: new Date() },
        });
      };
      await opening('TEAM', {
        organizationalUnitId: fx.unitChild,
        departmentId: fx.deptA,
        teamId: fx.teamA,
      });
      await opening('DEPT', { departmentId: fx.deptB });

      const card = async (user: string, key: string) =>
        (await svc.dashboard.dashboard(user, fx.orgA)).cards.find(
          (c) => c.key === key,
        );

      const hr = await svc.dashboard.dashboard(fx.users.hrAdmin!, fx.orgA);
      const values = Object.fromEntries(hr.cards.map((c) => [c.key, c.value]));
      expect(values).toMatchObject({
        activeEmployees: 2,
        pendingLeaveApprovals: 3,
        timesheetsAwaitingApproval: 0,
        openAttendanceExceptions: 0,
        activeOnboarding: 0,
        openJobOpenings: 2,
        reviewsInProgress: 0,
        documentsExpiring: 0,
      });
      expect(hr.self).toBeNull();
      expect(hr.quickActions.map((a) => a.key)).toEqual([
        'addEmployee',
        'reviewLeave',
        'reviewTimesheets',
        'postJob',
      ]);
      for (const c of hr.cards) expect(c.href).toMatch(/^\/admin\//);

      // Scoped counts.
      expect(
        (await card(fx.users.teamManager!, 'pendingLeaveApprovals'))!.value,
      ).toBe(2);
      expect(
        (await card(fx.users.teamManager!, 'activeEmployees'))!.value,
      ).toBe(2);
      expect(
        (await card(fx.users.teamManager!, 'openJobOpenings'))!.value,
      ).toBe(1);
      expect(
        (await card(fx.users.deptBViewer!, 'activeEmployees'))!.value,
      ).toBe(1);
      expect((await card(fx.users.unitViewer!, 'activeEmployees'))!.value).toBe(
        2,
      );
      // Employee 2 approves Team A leave, but never their own.
      expect((await card(fx.selfUser2, 'pendingLeaveApprovals'))!.value).toBe(
        1,
      );

      // No source permission, no card.
      const payroll = await svc.dashboard.dashboard(
        fx.users.payrollAdmin!,
        fx.orgA,
      );
      expect(payroll.cards.map((c) => c.key)).toEqual(['activeEmployees']);
      expect(payroll.quickActions.map((a) => a.key)).toEqual(['runPayroll']);
      const branding = await svc.dashboard.dashboard(
        fx.users.brandingAdmin!,
        fx.orgA,
      );
      expect(branding.cards).toEqual([]);
      expect(branding.quickActions).toEqual([]);

      // The employee's own section.
      const mine = await svc.dashboard.dashboard(fx.selfUser1, fx.orgA);
      expect(mine.cards).toEqual([]);
      expect(mine.self).toMatchObject({
        employeeId: fx.employee1,
        todayShifts: 0,
        policyAcknowledgementsDue: 0,
        selfReviewsDue: 0,
        reviewsToWrite: 0,
        openGoals: 0,
      });
      expect(mine.self!.leaveBalances).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ leaveTypeId: types.vacation.id }),
        ]),
      );
      expect(
        mine.self!.leaveBalances!.some(
          (b) => b.leaveTypeId === types.personal.id,
        ),
      ).toBe(false);

      // Isolation: another organization's administrator, or an unknown organization.
      expect(
        await failure(svc.dashboard.dashboard(fx.users.orgBAdmin!, fx.orgA)),
      ).toMatchObject({ status: 404 });
      expect(
        await failure(
          svc.dashboard.dashboard(
            fx.users.hrAdmin!,
            '00000000-0000-4000-8000-000000000999',
          ),
        ),
      ).toMatchObject({ status: 404 });
      const orgB = await svc.dashboard.dashboard(fx.users.orgBAdmin!, fx.orgB);
      expect(
        Object.fromEntries(orgB.cards.map((c) => [c.key, c.value])),
      ).toEqual({ activeEmployees: 0, pendingLeaveApprovals: 0 });

      // Disabled module: its cards, actions and self-service summary disappear.
      await disable(tx, fx.orgA, 'LEAVE');
      const disabled = await svc.dashboard.dashboard(
        fx.users.hrAdmin!,
        fx.orgA,
      );
      expect(disabled.cards.map((c) => c.key)).not.toContain(
        'pendingLeaveApprovals',
      );
      expect(disabled.quickActions.map((a) => a.key)).not.toContain(
        'reviewLeave',
      );
      expect(
        (await svc.dashboard.dashboard(fx.selfUser1, fx.orgA)).self!
          .leaveBalances,
      ).toBeNull();
    });
  });

  // ─── Setup checklist ──────────────────────────────────────────────────────

  it('derives setup completion from real rows', async () => {
    await scenario(async (tx, fx, svc) => {
      const steps = async () =>
        Object.fromEntries(
          (await svc.setup.checklist(fx.users.orgReader!, fx.orgA)).steps.map(
            (s) => [s.key, s],
          ),
        );
      let current = await steps();
      expect(Object.keys(current)).toEqual([
        'company',
        'branding',
        'structure',
        'roles',
        'employees',
        'timeAttendance',
        'leave',
        'payroll',
      ]);
      expect(current.company!.complete).toBe(false);
      expect(current.branding).toMatchObject({
        complete: false,
        optional: true,
      });
      expect(current.structure!.complete).toBe(true);
      expect(current.structure!.detail).toContain('2 locations');
      expect(current.roles!.complete).toBe(true);
      expect(current.employees).toMatchObject({
        complete: true,
        detail: '2 active employees',
      });
      expect(current.leave!.complete).toBe(false);
      expect(current.timeAttendance!.complete).toBe(false);
      expect(current.payroll!.complete).toBe(false);
      for (const step of Object.values(current))
        expect(step.href).toMatch(/^\//);

      await seedLeaveConfig(tx, fx, svc.leave);
      await svc.branding.update(
        fx.orgA,
        { displayName: 'Acme', expectedVersion: 0 },
        ctx(fx.users.brandingAdmin!),
      );
      current = await steps();
      expect(current.company!.complete).toBe(true);
      expect(current.leave!.complete).toBe(true);
      expect(current.branding!.complete).toBe(true);

      // Access: organization.read / manage at the organization only.
      for (const user of ['teamManager', 'brandingAdmin'])
        expect(
          await failure(svc.setup.checklist(fx.users[user]!, fx.orgA)),
        ).toMatchObject({ status: 403 });
      expect(
        await failure(svc.setup.checklist(fx.users.orgBAdmin!, fx.orgA)),
      ).toMatchObject({ status: 404 });
      expect(
        await failure(svc.setup.checklist(fx.selfUser1, fx.orgA)),
      ).toMatchObject({ status: 403 });

      await disable(tx, fx.orgA, 'LEAVE');
      expect(Object.keys(await steps())).not.toContain('leave');
    });
  });

  // ─── Employee capabilities ────────────────────────────────────────────────

  it('Batch 7A: onboarding and offboarding starts from the profile follow the module permission', async () => {
    await scenario(async (tx, fx, svc) => {
      const caps = (user: string, employeeId = fx.employee1) =>
        svc.capabilities.capabilities(user, employeeId);
      // onboarding.manage over Team A: Employee 1 (Team A assignment) can be onboarded.
      expect((await caps(fx.users.teamOnboarding!)).actions).toMatchObject({
        startOnboarding: true,
        startOffboarding: false,
      });
      expect((await caps(fx.users.offboarding!)).actions).toMatchObject({
        startOnboarding: false,
        startOffboarding: true,
      });
      // Never oneself.
      const teamRole = await tx.roleAssignment.findFirstOrThrow({
        where: { userId: fx.users.teamOnboarding! },
      });
      await tx.roleAssignment.create({
        data: {
          userId: fx.selfUser2,
          roleId: teamRole.roleId,
          roleOrganizationId: teamRole.roleOrganizationId,
          scopeType: teamRole.scopeType,
          organizationId: teamRole.organizationId,
          teamId: teamRole.teamId,
        },
      });
      // Employee 2's own account (Team A onboarding): Employee 1 yes, themself never.
      expect(
        (await caps(fx.selfUser2, fx.employee1)).actions.startOnboarding,
      ).toBe(true);
      expect(
        (await caps(fx.selfUser2, fx.employee2)).actions.startOnboarding,
      ).toBe(false);
      // An ended assignment can still be offboarded; onboarding needs a planned or active one.
      await tx.employmentAssignment.updateMany({
        where: { employeeId: fx.employee1 },
        data: { status: 'ENDED', endDate: new Date('2026-03-01T00:00:00Z') },
      });
      const ended = await caps(fx.users.offboarding!);
      expect(ended.actions.startOffboarding).toBe(true);
      expect(
        (await caps(fx.users.teamOnboarding!, fx.employee1)).actions
          .startOnboarding,
      ).toBe(false);
    });
  });

  it('derives employee capabilities from the domain access rules', async () => {
    await scenario(async (tx, fx, svc) => {
      const caps = (user: string, employeeId = fx.employee1) =>
        svc.capabilities.capabilities(user, employeeId);

      const hr = await caps(fx.users.hrAdmin!);
      expect(hr.organizationIds).toEqual([fx.orgA]);
      expect(hr.tabs).toEqual({
        overview: true,
        employment: true,
        compensation: false,
        time: true,
        leave: true,
        benefits: false,
        documents: true,
        performance: true,
      });
      expect(hr.actions).toEqual({
        edit: false,
        changePosition: true,
        assignManager: true,
        addCompensation: false,
        manageDocuments: false,
        startOffboarding: false,
        startOnboarding: false,
        manageLifecycle: true,
      });

      const payroll = await caps(fx.users.payrollAdmin!);
      expect(payroll.tabs).toMatchObject({
        compensation: true,
        leave: false,
        documents: false,
        time: false,
      });
      expect(payroll.actions).toMatchObject({
        addCompensation: true,
        changePosition: false,
      });

      // Team scope: Employee 1 is on Team A.
      expect((await caps(fx.users.teamManager!)).tabs).toMatchObject({
        time: true,
        leave: true,
        compensation: false,
      });
      // Department B scope sees Employee 1 (Dept B assignment) but not Employee 2.
      expect((await caps(fx.users.deptBViewer!)).tabs.overview).toBe(true);
      expect(
        await failure(caps(fx.users.deptBViewer!, fx.employee2)),
      ).toMatchObject({ status: 404 });

      // Own record: read through self rules, never managed through grants.
      const own = await caps(fx.selfUser2, fx.employee2);
      expect(own.tabs).toMatchObject({
        compensation: true,
        documents: false,
        performance: true,
      });
      expect(own.actions).toMatchObject({
        addCompensation: false,
        manageDocuments: false,
      });
      const other = await caps(fx.selfUser2, fx.employee1);
      expect(other.tabs.documents).toBe(true);
      expect(other.actions).toMatchObject({
        addCompensation: true,
        manageDocuments: true,
      });

      // Not visible: no employee.read over the employee, another organization, unknown id.
      expect(await failure(caps(fx.selfUser1))).toMatchObject({ status: 404 });
      expect(await failure(caps(fx.users.orgBAdmin!))).toMatchObject({
        status: 404,
      });
      expect(
        await failure(
          caps(fx.users.hrAdmin!, '00000000-0000-4000-8000-000000000999'),
        ),
      ).toMatchObject({ status: 404 });

      // Batch 5C: lifecycle actions need employee.manage over every assignment in effect.
      const partial = await caps(fx.users.teamAEmployeeManager!);
      expect(partial.actions).toMatchObject({
        changePosition: true,
        manageLifecycle: false,
      });
      expect(payroll.actions.manageLifecycle).toBe(false);
      // Own record: never through organization grants (self-target rule).
      const selfManage = await tx.role.create({
        data: {
          organizationId: fx.orgA,
          code: `P20-SELF-${fx.suffix}`,
          name: 'Self manage',
        },
      });
      for (const key of ['employee.read', 'employee.manage']) {
        const permission = await tx.permission.findUniqueOrThrow({
          where: { key },
        });
        await tx.rolePermission.create({
          data: { roleId: selfManage.id, permissionId: permission.id },
        });
      }
      await tx.roleAssignment.create({
        data: {
          userId: fx.selfUser1,
          roleId: selfManage.id,
          roleOrganizationId: fx.orgA,
          scopeType: 'ORGANIZATION',
          organizationId: fx.orgA,
        },
      });
      const ownManaged = await caps(fx.selfUser1);
      // Batch 5E (D1): the API refuses assignment changes on one's own employment
      // (LIFECYCLE_SELF_TARGET) without System employee.manage, so they are not offered.
      expect(ownManaged.actions).toMatchObject({
        changePosition: false,
        manageLifecycle: false,
      });
      expect(
        (await caps(fx.selfUser1, fx.employee2)).actions.manageLifecycle,
      ).toBe(true);

      // SYSTEM employee.manage edits person fields.
      const owner = await systemOwner(tx, fx);
      expect((await caps(owner)).actions.edit).toBe(true);
      expect((await caps(owner)).actions.manageLifecycle).toBe(true);

      // Disabled module: its tab is hidden.
      await disable(tx, fx.orgA, 'LEAVE');
      expect((await caps(fx.users.hrAdmin!)).tabs.leave).toBe(false);
    });
  });
});
