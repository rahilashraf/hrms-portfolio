import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service.js';
import { settingDefinition } from '../src/features/features-domain.js';
import { OnboardingOptionsService } from '../src/onboarding/onboarding-options.service.js';
import { RecruitmentOptionsService } from '../src/recruitment/recruitment-options.service.js';
import {
  activeTemplate,
  offboardingTasks,
  FixedOnboardingClock,
  ONBOARDING_USERS,
  onboardingServices,
  type OnboardingServices,
} from './support/onboarding-fixtures.js';
import { failure } from './support/performance-fixtures.js';
import {
  acceptedOffer,
  FixedRecruitmentClock,
  openingInput,
  RECRUITMENT_USERS,
  recruitmentServices,
  type RecruitmentServices,
  vacantPosition,
} from './support/recruitment-fixtures.js';
import {
  createSchedulingFixtures,
  ctx,
  rollbackClient,
  type SchedulingFixtures,
  type Tx,
} from './support/scheduling-fixtures.js';

config({ path: '../../.env' });

class RollbackFixtures extends Error {}

type Option = { id: string; label: string; description?: string };
const ids = (page: { items: Option[] }) => page.items.map((o) => o.id).sort();

/**
 * Batch 7A — the module-scoped picker endpoints (Q2), intake history paging, and the onboarding
 * fixes (HR pool, employee task completion setting, cancelled-hire restart, dashboard).
 */
describe('Batch 7A backend (database)', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService(process.env.DATABASE_URL!);
    await prisma.$connect();
  });
  afterAll(async () => {
    await prisma?.$disconnect();
  });

  async function inRollback<S>(
    users: Parameters<typeof createSchedulingFixtures>[1],
    build: (client: PrismaService) => S,
    run: (tx: Tx, fx: SchedulingFixtures, svc: S) => Promise<void>,
  ) {
    await expect(
      prisma.$transaction(
        async (tx) => {
          const fx = await createSchedulingFixtures(tx, users);
          const svc = build(rollbackClient(tx));
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

  const recruitment = (
    run: (
      tx: Tx,
      fx: SchedulingFixtures,
      svc: RecruitmentServices & { options: RecruitmentOptionsService },
    ) => Promise<void>,
  ) =>
    inRollback(
      RECRUITMENT_USERS,
      (client) => {
        const svc = recruitmentServices(client, new FixedRecruitmentClock());
        return {
          ...svc,
          options: new RecruitmentOptionsService(client, svc.access),
        };
      },
      run,
    );

  const onboarding = (
    run: (
      tx: Tx,
      fx: SchedulingFixtures,
      svc: OnboardingServices & {
        options: OnboardingOptionsService;
        client: PrismaService;
      },
    ) => Promise<void>,
  ) =>
    inRollback(
      ONBOARDING_USERS,
      (client) => {
        const svc = onboardingServices(client, new FixedOnboardingClock());
        return {
          ...svc,
          client,
          options: new OnboardingOptionsService(client, svc.access),
        };
      },
      run,
    );

  it('recruitment options: scoped to what the caller may place, minimal fields, isolated', async () => {
    await recruitment(async (tx, fx, svc) => {
      const q = (kind: string, extra: Record<string, unknown> = {}) => ({
        organizationId: fx.orgA,
        kind: kind as never,
        ...extra,
      });
      const admin = fx.users.hiringAdmin!;
      const team = fx.users.teamRecruiter!;

      // Organization-wide: every position and structure of the organization.
      expect(ids(await svc.options.options(admin, q('position')))).toEqual(
        [fx.positionDeptB, fx.positionOrg, fx.positionTeamA].sort(),
      );
      expect(ids(await svc.options.options(admin, q('department')))).toEqual(
        [fx.deptA, fx.deptB].sort(),
      );
      // A team recruiter: only what an opening of theirs may be placed on.
      expect(ids(await svc.options.options(team, q('position')))).toEqual([
        fx.positionTeamA,
      ]);
      expect((await svc.options.options(team, q('department'))).items).toEqual(
        [],
      );
      expect((await svc.options.options(team, q('unit'))).items).toEqual([]);
      const teams = await svc.options.options(team, q('team'));
      expect(teams.items).toEqual([
        expect.objectContaining({
          id: fx.teamA,
          placement: {
            organizationalUnitId: fx.unitChild,
            departmentId: fx.deptA,
            teamId: fx.teamA,
          },
        }),
      ]);
      // The placement round-trips: the team recruiter creates an opening on that team.
      const placed = await svc.openings.create(
        openingInput(fx, {
          code: 'REQ-TEAM-PICK',
          positionId: undefined,
          ...(teams.items[0] as { placement: object }).placement,
        }),
        ctx(team),
      );
      expect(JSON.stringify(placed)).toContain(fx.teamA);

      // People: names and employee numbers only — never an email or other contact data.
      const managers = await svc.options.options(
        team,
        q('hiringManager', { search: fx.suffix }),
      );
      expect(ids(managers)).toEqual([fx.employee1, fx.employee2].sort());
      for (const option of managers.items) {
        expect(Object.keys(option).sort()).toEqual([
          'description',
          'id',
          'label',
        ]);
      }
      const staff = await svc.options.options(
        team,
        q('staff', { search: fx.suffix }),
      );
      expect(ids(staff)).toEqual([fx.selfUser1, fx.selfUser2].sort());
      expect(JSON.stringify(staff)).not.toMatch(/@/);
      // An archived position never appears.
      await tx.position.update({
        where: { id: fx.positionDeptB },
        data: { archivedAt: new Date() },
      });
      expect(
        ids(await svc.options.options(admin, q('position'))),
      ).not.toContain(fx.positionDeptB);

      // Paging by id.
      const first = await svc.options.options(
        admin,
        q('hiringManager', { search: fx.suffix, limit: 1 }),
      );
      expect(first.items).toHaveLength(1);
      expect(first.nextAfterId).toBe(first.items[0]!.id);
      const second = await svc.options.options(
        admin,
        q('hiringManager', {
          search: fx.suffix,
          limit: 1,
          afterId: first.nextAfterId,
        }),
      );
      expect(second.items).toHaveLength(1);
      expect(second.items[0]!.id).not.toBe(first.items[0]!.id);

      // Refusals: read-only, pipeline-only and another organization's administrator.
      for (const user of [
        'reader',
        'pipelineAdmin',
        'intakeAdmin',
        'orgBAdmin',
      ]) {
        expect([
          user,
          (await failure(svc.options.options(fx.users[user]!, q('staff'))))
            .status,
        ]).toEqual([user, 403]);
      }
      // Recruitment switched off for the organization.
      await tx.organizationModuleSetting.create({
        data: {
          organizationId: fx.orgA,
          module: 'RECRUITMENT',
          enabled: false,
        },
      });
      expect(
        await failure(svc.options.options(admin, q('position'))),
      ).toMatchObject({ status: 403, code: 'FEATURE_DISABLED' });
    });
  });

  it('intake history: newest first, filtered by source, paged', async () => {
    await recruitment(async (tx, fx, svc) => {
      const intake = ctx(fx.users.intakeAdmin!);
      const source = await svc.intake.createSource(
        {
          organizationId: fx.orgA,
          code: 'FORM-A',
          name: 'Form A',
          provider: 'MANUAL_IMPORT',
        },
        intake,
      );
      const other = await svc.intake.createSource(
        {
          organizationId: fx.orgA,
          code: 'FORM-B',
          name: 'Form B',
          provider: 'MANUAL_IMPORT',
        },
        intake,
      );
      const add = (
        sourceId: string,
        n: number,
        status: 'REJECTED' | 'PENDING_OPENING',
      ) =>
        tx.recruitmentIntakeSubmission.create({
          data: {
            organizationId: fx.orgA,
            sourceId,
            externalResponseId: `r-${sourceId}-${n}`,
            status,
            submission: {},
            contentHash: `h${n}`,
            submittedAt: new Date(Date.UTC(2026, 2, n)),
          },
        });
      const rejected = [];
      for (const n of [1, 2, 3])
        rejected.push(await add(source.id, n, 'REJECTED'));
      await add(other.id, 4, 'REJECTED');
      const pending = [
        await add(source.id, 6, 'PENDING_OPENING'),
        await add(source.id, 5, 'PENDING_OPENING'),
      ];

      const page1 = await svc.intake.queue(
        fx.users.intakeAdmin!,
        fx.orgA,
        'REJECTED',
        { sourceId: source.id, limit: 2 },
      );
      expect(page1.items.map((i) => i.id)).toEqual([
        rejected[2]!.id,
        rejected[1]!.id,
      ]);
      const page2 = await svc.intake.queue(
        fx.users.intakeAdmin!,
        fx.orgA,
        'REJECTED',
        { sourceId: source.id, limit: 2, afterId: page1.nextAfterId! },
      );
      expect(page2).toMatchObject({ nextAfterId: null });
      expect(page2.items.map((i) => i.id)).toEqual([rejected[0]!.id]);
      // All sources together; the pending queue stays oldest first.
      expect(
        (await svc.intake.queue(fx.users.intakeAdmin!, fx.orgA, 'REJECTED'))
          .items,
      ).toHaveLength(4);
      expect(
        (await svc.intake.queue(fx.users.intakeAdmin!, fx.orgA)).items.map(
          (i) => i.id,
        ),
      ).toEqual([pending[1]!.id, pending[0]!.id]);
      // A cursor from another list is refused.
      expect(
        await failure(
          svc.intake.queue(fx.users.intakeAdmin!, fx.orgA, 'APPLIED', {
            afterId: rejected[0]!.id,
          }),
        ),
      ).toMatchObject({ status: 400, code: 'RECRUITMENT_CURSOR_INVALID' });
    });
  });

  it('onboarding options: owners, startable assignments (ended ones for offboarding), scoped and isolated', async () => {
    await onboarding(async (tx, fx, svc) => {
      await activeTemplate(svc, fx, {
        kind: 'OFFBOARDING',
        code: 'EXIT',
        tasks: offboardingTasks(fx) as never,
      });
      const q = (kind: string, extra: Record<string, unknown> = {}) => ({
        organizationId: fx.orgA,
        kind: kind as never,
        ...extra,
      });
      // Import: organization-level manage of a kind (a team-scoped manager may not import).
      const importFlags = async (user: string) =>
        (await svc.access.organizations(fx.users[user]!)).items.find(
          (o) => o.id === fx.orgA,
        )?.actions;
      expect(await importFlags('onboardingHr')).toMatchObject({
        canImportOnboarding: true,
        canImportOffboarding: false,
      });
      expect(await importFlags('offboardingHr')).toMatchObject({
        canImportOnboarding: false,
        canImportOffboarding: true,
      });
      expect(await importFlags('teamOnboarding')).toMatchObject({
        onboarding: true,
        canImportOnboarding: false,
      });
      // Owners: people connected to the organization, for template and workflow managers.
      for (const user of ['templateAdmin', 'onboardingHr', 'offboardingHr']) {
        const owners = await svc.options.options(
          fx.users[user]!,
          q('owner', { search: fx.suffix }),
        );
        expect(ids(owners)).toEqual([fx.selfUser1, fx.selfUser2].sort());
        expect(JSON.stringify(owners)).not.toMatch(/@/);
      }
      for (const user of ['onboardingReader', 'itDesk', 'orgBAdmin']) {
        expect([
          user,
          (await failure(svc.options.options(fx.users[user]!, q('owner'))))
            .status,
        ]).toEqual([user, 403]);
      }

      // Assignments to start onboarding on: within the caller's scope, never their own.
      const assignments = (user: string, workflowKind = 'ONBOARDING') =>
        svc.options.options(
          fx.users[user]!,
          q('assignment', { workflowKind, search: fx.suffix }),
        );
      expect(ids(await assignments('onboardingHr'))).toEqual(
        [
          fx.assignmentTeamA,
          fx.assignmentDeptB,
          fx.otherTeamA,
          fx.orgLevel,
        ].sort(),
      );
      expect(ids(await assignments('teamOnboarding'))).toEqual(
        [fx.assignmentTeamA, fx.otherTeamA].sort(),
      );
      // Employee 1's own account (full onboarding rights) never sees their own assignments.
      expect(ids(await assignments('self1'))).toEqual(
        [fx.otherTeamA, fx.orgLevel].sort(),
      );
      // An ENDED assignment: offboarding only, labelled as ended.
      await tx.employmentAssignment.update({
        where: { id: fx.orgLevel },
        data: { status: 'ENDED', endDate: new Date('2026-03-01T00:00:00Z') },
      });
      expect(ids(await assignments('onboardingHr'))).not.toContain(fx.orgLevel);
      const offboarding = await assignments('offboardingHr', 'OFFBOARDING');
      expect(
        offboarding.items.find((o) => o.id === fx.orgLevel)?.description,
      ).toMatch(/Ended 2026-03-01/);
      // Onboarding rights never list offboarding candidates.
      expect(
        await failure(assignments('onboardingHr', 'OFFBOARDING')),
      ).toMatchObject({ status: 403 });
      // The ENDED assignment can be offboarded.
      await svc.workflows.start(
        'OFFBOARDING',
        { employmentAssignmentId: fx.orgLevel, plannedEndDate: '2026-03-01' },
        ctx(fx.users.offboardingHr!),
      );
      expect(
        await failure(
          svc.options.options(fx.users.orgBAdmin!, q('assignment')),
        ),
      ).toMatchObject({ status: 403 });
    });
  });

  it('onboarding: hire options and restarting a cancelled hire onboarding', async () => {
    await onboarding(async (tx, fx, svc) => {
      await activeTemplate(svc, fx);
      const recruitmentSvc = recruitmentServices(
        svc.client,
        new FixedRecruitmentClock(),
      );
      const position = await vacantPosition(tx, fx, { team: true });
      const role = await tx.role.create({
        data: {
          organizationId: fx.orgA,
          code: `HIRE-${fx.suffix}`,
          name: 'Hiring',
        },
      });
      for (const key of [
        'recruitment.read',
        'recruitment.manage',
        'recruitment.offer.approve',
        'recruitment.hire',
        'employee.read',
        'employee.manage',
      ]) {
        const permission = await tx.permission.upsert({
          where: { key },
          create: { key, name: key, isActive: true },
          update: {},
        });
        await tx.rolePermission.create({
          data: { roleId: role.id, permissionId: permission.id },
        });
      }
      await tx.roleAssignment.create({
        data: {
          userId: fx.users.hr!,
          roleId: role.id,
          roleOrganizationId: fx.orgA,
          scopeType: 'ORGANIZATION',
          organizationId: fx.orgA,
        },
      });
      const { applicationId } = await acceptedOffer(
        recruitmentSvc,
        { ...fx, users: { ...fx.users, hiringAdmin: fx.users.hr! } },
        { positionId: position, candidate: { email: 'restart@example.com' } },
      );
      const hire = await recruitmentSvc.hires.convert(
        applicationId,
        {},
        ctx(fx.users.hr!),
      );
      const hr = ctx(fx.users.onboardingHr!);
      const hires = () =>
        svc.options.options(fx.users.onboardingHr!, {
          organizationId: fx.orgA,
          kind: 'hire',
        });
      expect((await hires()).items).toEqual([
        expect.objectContaining({ id: hire.id, restartable: false }),
      ]);
      // Recruitment access alone, offboarding HR and another organization: refused.
      for (const user of ['hr', 'offboardingHr', 'orgBAdmin']) {
        expect([
          user,
          (
            await failure(
              svc.options.options(fx.users[user]!, {
                organizationId: fx.orgA,
                kind: 'hire',
              }),
            )
          ).status,
        ]).toEqual([user, 403]);
      }

      const first = await svc.workflows.startFromHire(hire.id, null, hr);
      expect(first).toMatchObject({ created: true });
      expect((await hires()).items).toEqual([]);
      await svc.workflows.cancel(first.id, 'Started by mistake', hr);
      expect((await hires()).items).toEqual([
        expect.objectContaining({ id: hire.id, restartable: true }),
      ]);
      // Restart: a new onboarding of the hire's assignment; the cancelled one keeps the link.
      const restarted = await svc.workflows.startFromHire(hire.id, null, hr);
      expect(restarted).toMatchObject({
        created: true,
        restartedFromWorkflowId: first.id,
        status: 'ACTIVE',
      });
      expect(restarted.id).not.toBe(first.id);
      // Idempotent afterwards.
      const again = await svc.workflows.startFromHire(hire.id, null, hr);
      expect(again).toMatchObject({ created: false, id: restarted.id });
      expect((await hires()).items).toEqual([]);
      expect(
        (
          await tx.employeeWorkflow.findUniqueOrThrow({
            where: { id: first.id },
          })
        ).recruitmentHireId,
      ).toBe(hire.id);
    });
  });

  it('onboarding: no-owner reassignment and the employee completion setting', async () => {
    await onboarding(async (tx, fx, svc) => {
      await activeTemplate(svc, fx);
      const hr = ctx(fx.users.onboardingHr!);
      const workflow = await svc.workflows.start(
        'ONBOARDING',
        { employmentAssignmentId: fx.assignmentTeamA },
        hr,
      );
      type T = (typeof workflow.tasks)[number];
      const byTitle = (w: { tasks: T[] }, title: string) =>
        w.tasks.find((t) => t.title === title)!;

      // No owner: allowed for a manager task (it waits for HR, listed as unassigned), refused
      // for a specific-user task — the snapshot's owner type never changes (the web offers
      // "no owner" for manager tasks only).
      const managerTask = byTitle(workflow, 'Supervisor welcome meeting');
      const cleared = await svc.tasks.reassign(managerTask.id, null, hr);
      expect(byTitle(cleared, 'Supervisor welcome meeting')).toMatchObject({
        ownerType: 'MANAGER',
        owner: null,
      });
      expect(
        (
          await svc.workflows.dashboard(
            fx.users.onboardingHr!,
            fx.orgA,
            'ONBOARDING',
          )
        ).attention.unassignedTasks.map((t) => t.title),
      ).toContain('Supervisor welcome meeting');
      expect(
        await failure(
          svc.tasks.reassign(byTitle(workflow, 'Set up accounts').id, null, hr),
        ),
      ).toMatchObject({ status: 400, code: 'WORKFLOW_OWNER_INVALID' });

      // The employee completion setting: off → the employee is not offered start/complete.
      const own = await svc.workflows.detail(fx.selfUser1, workflow.id);
      expect(byTitle(own, 'Sign employment paperwork').actions).toMatchObject({
        canStart: true,
        canComplete: true,
      });
      const definition = settingDefinition(
        'onboarding.employeeTaskCompletion',
      )!;
      await tx.organizationSetting.create({
        data: {
          organizationId: fx.orgA,
          key: definition.key,
          value: false,
          schemaVersion: definition.schemaVersion,
        },
      });
      const off = await svc.workflows.detail(fx.selfUser1, workflow.id);
      expect(byTitle(off, 'Sign employment paperwork').actions).toMatchObject({
        canStart: false,
        canComplete: false,
      });
      expect(
        byTitle(off, 'Acknowledge the Staff Handbook').actions.canAcknowledge,
      ).toBe(true);
      // HR keeps its actions.
      expect(
        byTitle(
          await svc.workflows.detail(fx.users.onboardingHr!, workflow.id),
          'Sign employment paperwork',
        ).actions.canComplete,
      ).toBe(true);
    });
  });

  it('onboarding dashboard: unknown organization 404, scope applied before the limit', async () => {
    await onboarding(async (tx, fx, svc) => {
      await activeTemplate(svc, fx);
      const hr = ctx(fx.users.onboardingHr!);
      const workflow = await svc.workflows.start(
        'ONBOARDING',
        { employmentAssignmentId: fx.assignmentTeamA },
        hr,
      );
      // Dashboard: an unknown organization is a 404 for a System-scope reader (was a 500).
      const system = await tx.user.create({
        data: {
          personId: (await tx.person.create({ data: {} })).id,
          email: `b7a-sys-${fx.suffix.toLowerCase()}@example.com`,
          status: 'ACTIVE',
        },
      });
      const systemRole =
        (await tx.role.findFirst({ where: { isSystemOwner: true } })) ??
        (await tx.role.create({
          data: {
            organizationId: null,
            code: 'SYSTEM_OWNER',
            name: 'System Owner',
            isSystemOwner: true,
          },
        }));
      const read = await tx.permission.findUniqueOrThrow({
        where: { key: 'onboarding.read' },
      });
      await tx.rolePermission.upsert({
        where: {
          roleId_permissionId: { roleId: systemRole.id, permissionId: read.id },
        },
        create: { roleId: systemRole.id, permissionId: read.id },
        update: {},
      });
      await tx.roleAssignment.create({
        data: { userId: system.id, roleId: systemRole.id, scopeType: 'SYSTEM' },
      });
      expect(
        await failure(
          svc.workflows.dashboard(
            system.id,
            '00000000-0000-4000-8000-000000000000',
            'ONBOARDING',
          ),
        ),
      ).toMatchObject({ status: 404 });

      // Dashboard scope before the limit: 501 closed workflows of Department B anchored
      // earlier never hide Team A's from a team-scoped reader.
      await svc.workflows.cancel(workflow.id, 'Replaced', hr);
      // (A workflow is created ACTIVE and one per assignment is active: create, then cancel.)
      for (let i = 0; i < 501; i += 1) {
        const bulk = await tx.employeeWorkflow.create({
          data: {
            organizationId: fx.orgA,
            kind: 'ONBOARDING',
            employeeId: fx.employee1,
            employmentAssignmentId: fx.assignmentDeptB,
            templateName: `Bulk ${i}`,
            anchorDate: new Date('2025-01-01T00:00:00Z'),
          },
        });
        await tx.employeeWorkflow.update({
          where: { id: bulk.id },
          data: {
            status: 'CANCELLED',
            cancelledAt: new Date(),
            cancellationReason: 'Bulk',
          },
        });
      }
      const teamView = await svc.workflows.dashboard(
        fx.users.teamOnboarding!,
        fx.orgA,
        'ONBOARDING',
        true,
      );
      expect(teamView.items.map((i) => i.id)).toEqual([workflow.id]);
      expect(teamView.truncated).toBe(false);
      const orgView = await svc.workflows.dashboard(
        fx.users.onboardingHr!,
        fx.orgA,
        'ONBOARDING',
        true,
      );
      expect(orgView.items).toHaveLength(500);
      expect(orgView.truncated).toBe(true);
    });
  });
});
