import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service.js';
import {
  sendTaskReminders,
  type WorkflowReminderSink,
} from '../src/onboarding/onboarding-jobs.js';
import {
  activeTemplate,
  FixedOnboardingClock,
  offboardingTasks,
  ONBOARDING_USERS,
  onboardingServices,
  onboardingTasks,
  type OnboardingServices,
} from './support/onboarding-fixtures.js';
import { failure } from './support/performance-fixtures.js';
import {
  acceptedOffer,
  FixedRecruitmentClock,
  recruitmentServices,
  vacantPosition,
} from './support/recruitment-fixtures.js';
import {
  cleanupSchedulingFixtures,
  createSchedulingFixtures,
  ctx,
  rollbackClient,
  violation,
  type SchedulingFixtures,
  type Tx,
} from './support/scheduling-fixtures.js';

config({ path: '../../.env' });

class RollbackFixtures extends Error {}

type HrWorkflow = Extract<
  Awaited<ReturnType<OnboardingServices['workflows']['detail']>>,
  { coreHr: unknown }
>;

/** A new team-A assignment of employee 1 starting 2026-04-01, managed by employee 2. */
async function newAssignment(
  tx: Tx,
  fx: SchedulingFixtures,
  startDate = '2026-04-01',
) {
  const position = await vacantPosition(tx, fx, { team: true });
  const assignment = await tx.employmentAssignment.create({
    data: {
      employeeId: fx.employee1,
      positionId: position,
      employmentType: 'FULL_TIME',
      status: 'PLANNED',
      startDate: new Date(`${startDate}T00:00:00.000Z`),
      managerAssignmentId: fx.otherTeamA,
    },
  });
  return assignment.id;
}

describe('Onboarding and offboarding (database)', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService(process.env.DATABASE_URL!);
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  async function scenario(
    run: (
      tx: Tx,
      fx: SchedulingFixtures,
      svc: OnboardingServices,
      clock: FixedOnboardingClock,
    ) => Promise<void>,
  ) {
    await expect(
      prisma.$transaction(
        async (tx) => {
          const fx = await createSchedulingFixtures(tx, ONBOARDING_USERS);
          const clock = new FixedOnboardingClock();
          const svc = onboardingServices(rollbackClient(tx), clock);
          await run(tx, fx, svc, clock).catch((error: unknown) => {
            console.error('SCENARIO FAILURE', error);
            throw error;
          });
          throw new RollbackFixtures();
        },
        { timeout: 120_000 },
      ),
    ).rejects.toBeInstanceOf(RollbackFixtures);
  }

  it('manages templates at organization level, with one default per kind and frozen archives', async () => {
    await scenario(async (tx, fx, svc) => {
      const admin = ctx(fx.users.templateAdmin!);
      const input = {
        organizationId: fx.orgA,
        kind: 'ONBOARDING' as const,
        code: 'teach',
        name: 'Teacher onboarding',
        tasks: onboardingTasks(fx),
      };
      for (const user of ['teamTemplate', 'onboardingHr', 'hr', 'orgBAdmin']) {
        expect(
          await failure(svc.templates.create(input, ctx(fx.users[user]!))),
        ).toMatchObject({ status: 403 });
      }
      const draft = await svc.templates.create(input, admin);
      expect(draft).toMatchObject({
        code: 'TEACH',
        status: 'DRAFT',
        tasks: expect.arrayContaining([
          expect.objectContaining({
            ownerType: 'SPECIFIC_USER',
            ownerUserId: fx.users.itDesk,
          }),
        ]),
      });
      expect(await failure(svc.templates.create(input, admin))).toEqual({
        status: 409,
        code: 'WORKFLOW_TEMPLATE_EXISTS',
      });
      expect(
        await failure(
          svc.templates.create(
            {
              ...input,
              code: 'x2',
              tasks: [
                {
                  title: 'Ack',
                  category: 'POLICY',
                  ownerType: 'MANAGER',
                  acknowledgementRequired: true,
                  acknowledgementStatement: 'I read it',
                },
              ],
            },
            admin,
          ),
        ),
      ).toEqual({
        status: 400,
        code: 'WORKFLOW_ACKNOWLEDGEMENT_INVALID',
      });
      expect(await failure(svc.templates.setDefault(draft.id, admin))).toEqual({
        status: 409,
        code: 'WORKFLOW_TEMPLATE_NOT_ACTIVE',
      });
      const empty = await svc.templates.create(
        { ...input, code: 'empty', tasks: [] },
        admin,
      );
      expect(await failure(svc.templates.activate(empty.id, admin))).toEqual({
        status: 400,
        code: 'WORKFLOW_TEMPLATE_EMPTY',
      });
      await svc.templates.activate(draft.id, admin);
      await svc.templates.setDefault(draft.id, admin);
      const second = await activeTemplate(svc, fx, { code: 'second' });
      expect(second.isDefault).toBe(true);
      expect(
        (
          await tx.workflowTemplate.findUniqueOrThrow({
            where: { id: draft.id },
          })
        ).isDefault,
      ).toBe(false);
      // HR starting workflows see active templates only; template managers see all.
      expect(
        (await svc.templates.list(fx.users.onboardingHr!, fx.orgA)).items.map(
          (t) => t.status,
        ),
      ).not.toContain('DRAFT');
      expect(
        await failure(svc.templates.list(fx.users.hr!, fx.orgA)),
      ).toMatchObject({ status: 403 });
      await svc.templates.archive(draft.id, admin);
      expect(
        await failure(svc.templates.update(draft.id, { name: 'Again' }, admin)),
      ).toEqual({ status: 409, code: 'WORKFLOW_TEMPLATE_ARCHIVED' });
      expect(
        await violation(tx, () =>
          tx.workflowTemplate.update({
            where: { id: draft.id },
            data: { name: 'x' },
          }),
        ),
      ).toBeTruthy();
      expect(
        await violation(tx, () =>
          tx.workflowTemplateTask.deleteMany({
            where: { templateId: draft.id },
          }),
        ),
      ).toBeTruthy();
      expect(
        await violation(tx, () =>
          tx.workflowTemplate.update({
            where: { id: second.id },
            data: { kind: 'OFFBOARDING' },
          }),
        ),
      ).toBeTruthy();
      expect(
        await violation(tx, () =>
          tx.workflowTemplate.delete({ where: { id: second.id } }),
        ),
      ).toBeTruthy();
    });
  });

  it('starts onboarding from a frozen template snapshot with resolved owners and due dates', async () => {
    await scenario(async (tx, fx, svc) => {
      const template = await activeTemplate(svc, fx);
      const assignmentId = await newAssignment(tx, fx);
      const hr = ctx(fx.users.onboardingHr!);
      // Onboarding access is never implied by HR, recruitment or a reporting line.
      for (const user of [
        'hr',
        'onboardingReader',
        'deptBOnboarding',
        'offboardingHr',
      ]) {
        expect(
          await failure(
            svc.workflows.start(
              'ONBOARDING',
              { employmentAssignmentId: assignmentId },
              ctx(fx.users[user]!),
            ),
          ),
        ).toMatchObject({ status: 403 });
      }
      // Batch 7A (Q4): another organization's assignment reads as missing.
      expect(
        await failure(
          svc.workflows.start(
            'ONBOARDING',
            { employmentAssignmentId: assignmentId },
            ctx(fx.users.orgBAdmin!),
          ),
        ),
      ).toMatchObject({ status: 404 });
      expect(
        await failure(
          svc.workflows.start(
            'ONBOARDING',
            { employmentAssignmentId: assignmentId },
            ctx(fx.users.self1!),
          ),
        ),
      ).toEqual({ status: 403, code: 'WORKFLOW_SELF_MANAGEMENT' });
      const workflow = await svc.workflows.start(
        'ONBOARDING',
        { employmentAssignmentId: assignmentId },
        ctx(fx.users.teamOnboarding!),
      );
      expect(workflow).toMatchObject({
        view: 'HR',
        status: 'ACTIVE',
        anchorDate: '2026-04-01',
        templateName: 'Teacher onboarding',
      });
      const byTitle = Object.fromEntries(
        workflow.tasks.map((task) => [task.title, task]),
      );
      expect(byTitle['Sign employment paperwork']).toMatchObject({
        dueDate: '2026-03-29',
        owner: { userId: fx.selfUser1 },
      });
      expect(byTitle['Supervisor welcome meeting']).toMatchObject({
        dueDate: '2026-04-02',
        owner: { userId: fx.selfUser2 },
      });
      expect(byTitle['Set up accounts']).toMatchObject({
        owner: { userId: fx.users.itDesk },
        systemAction: 'PROVISION_HRMS_ACCOUNT',
      });
      expect(byTitle['Payroll information']).toMatchObject({
        ownerType: 'HR',
        owner: null,
        required: false,
      });
      expect(byTitle['Acknowledge the Staff Handbook']).toMatchObject({
        reference: { type: 'GOOGLE_DOC', externalId: 'handbook-2026' },
      });
      expect((workflow as HrWorkflow).coreHr).toMatchObject({
        assignmentStatus: 'PLANNED',
        manager: { assignmentId: fx.otherTeamA },
      });
      // One active onboarding per assignment.
      expect(
        await failure(
          svc.workflows.start(
            'ONBOARDING',
            { employmentAssignmentId: assignmentId },
            hr,
          ),
        ),
      ).toMatchObject({ status: 409, code: 'WORKFLOW_ALREADY_ACTIVE' });
      // Later template edits never rewrite the started workflow.
      await svc.templates.update(
        template.id,
        {
          tasks: [
            { title: 'Only task now', category: 'OTHER', ownerType: 'HR' },
          ],
        },
        ctx(fx.users.templateAdmin!),
      );
      const again = await svc.workflows.detail(
        fx.users.onboardingHr!,
        workflow.id,
      );
      expect(again.tasks.map((task) => task.title)).toEqual(
        workflow.tasks.map((task) => task.title),
      );
      // The snapshot is immutable in the database.
      expect(
        await violation(tx, () =>
          tx.employeeWorkflowTask.update({
            where: { id: byTitle['Sign employment paperwork']!.id },
            data: { title: 'Changed' },
          }),
        ),
      ).toBeTruthy();
      expect(
        await violation(tx, () =>
          tx.employeeWorkflowTask.delete({
            where: { id: byTitle['Sign employment paperwork']!.id },
          }),
        ),
      ).toBeTruthy();
      expect(
        await violation(tx, () =>
          tx.employeeWorkflow.update({
            where: { id: workflow.id },
            data: { employmentAssignmentId: fx.assignmentDeptB },
          }),
        ),
      ).toBeTruthy();
      expect(
        await violation(tx, () =>
          tx.employeeWorkflow.delete({ where: { id: workflow.id } }),
        ),
      ).toBeTruthy();
      expect(
        await violation(tx, () =>
          tx.employeeWorkflow.create({
            data: {
              organizationId: fx.orgB,
              kind: 'ONBOARDING',
              employeeId: fx.employee1,
              employmentAssignmentId: fx.assignmentDeptB,
              templateName: 'x',
              anchorDate: new Date(),
            },
          }),
        ),
      ).toBeTruthy();
      expect(
        await violation(tx, () =>
          tx.employeeWorkflowEvent.deleteMany({
            where: { workflowId: workflow.id },
          }),
        ),
      ).toBeTruthy();
      // Scoped visibility: dept B HR never sees a team-A workflow.
      expect(
        await failure(
          svc.workflows.detail(fx.users.deptBOnboarding!, workflow.id),
        ),
      ).toMatchObject({ status: 404 });
      expect(
        await failure(
          svc.workflows.detail(fx.users.offboardingHr!, workflow.id),
        ),
      ).toMatchObject({ status: 404 });
      expect(
        await failure(svc.workflows.detail(fx.users.hr!, workflow.id)),
      ).toMatchObject({ status: 404 });
    });
  });

  it('scopes self-service, task owners and HR, and keeps acknowledgement the employee’s own act', async () => {
    await scenario(async (tx, fx, svc, clock) => {
      await activeTemplate(svc, fx);
      const assignmentId = await newAssignment(tx, fx);
      const hr = ctx(fx.users.onboardingHr!);
      const started = await svc.workflows.start(
        'ONBOARDING',
        { employmentAssignmentId: assignmentId },
        hr,
      );
      const id = (title: string) =>
        started.tasks.find((task) => task.title === title)!.id;
      // The employee sees their workflow with only their own tasks.
      const mine = await svc.workflows.mine(fx.selfUser1);
      expect(mine.items).toHaveLength(1);
      expect(mine.items[0]).toMatchObject({
        view: 'EMPLOYEE',
        progress: { total: 6 },
      });
      expect(mine.items[0]!.tasks.map((task) => task.title)).toEqual([
        'Sign employment paperwork',
        'Acknowledge the Staff Handbook',
        'Complete the Code of Conduct form',
      ]);
      expect(mine.items[0]).not.toHaveProperty('events');
      // Even with onboarding.manage, the employee cannot manage their own workflow.
      expect(
        await failure(
          svc.tasks.waive(
            id('Sign employment paperwork'),
            'n/a',
            ctx(fx.users.self1!),
          ),
        ),
      ).toMatchObject({ status: 403 });
      expect(
        await failure(
          svc.tasks.complete(
            id('Supervisor welcome meeting'),
            {},
            ctx(fx.users.self1!),
          ),
        ),
      ).toEqual({ status: 403, code: 'WORKFLOW_TASK_NOT_YOURS' });
      // The manager (employee 2) is a task owner only: their task, nothing else.
      const managerTasks = await svc.workflows.myTasks(fx.selfUser2);
      expect(managerTasks.items.map((task) => task.title)).toEqual([
        'Supervisor welcome meeting',
      ]);
      expect(
        (await svc.workflows.detail(fx.selfUser2, started.id)).tasks.map(
          (task) => task.title,
        ),
      ).toEqual(['Supervisor welcome meeting']);
      expect(
        await failure(
          svc.tasks.complete(id('Payroll information'), {}, ctx(fx.selfUser2)),
        ),
      ).toMatchObject({ status: 404 });
      await svc.tasks.complete(
        id('Supervisor welcome meeting'),
        { note: 'Met in room 12' },
        ctx(fx.selfUser2),
      );
      // Evidence-required task.
      const paperwork = id('Sign employment paperwork');
      expect(
        await failure(svc.tasks.complete(paperwork, {}, ctx(fx.selfUser1))),
      ).toEqual({ status: 400, code: 'WORKFLOW_EVIDENCE_REQUIRED' });
      await svc.tasks.start(paperwork, ctx(fx.selfUser1));
      await svc.tasks.complete(
        paperwork,
        { evidenceReference: 'https://drive.google.com/file/d/contract' },
        ctx(fx.selfUser1),
      );
      // Acknowledgement: only the employee, of the frozen statement; HR cannot do it on their behalf.
      const handbook = id('Acknowledge the Staff Handbook');
      expect(
        await failure(svc.tasks.complete(handbook, { note: 'done' }, hr)),
      ).toEqual({ status: 400, code: 'WORKFLOW_ACKNOWLEDGEMENT_REQUIRED' });
      expect(
        await failure(
          svc.tasks.acknowledge(handbook, { statementAccepted: true }, hr),
        ),
      ).toEqual({ status: 403, code: 'WORKFLOW_ACKNOWLEDGEMENT_SELF_ONLY' });
      await svc.tasks.acknowledge(
        handbook,
        { statementAccepted: true },
        ctx(fx.selfUser1),
      );
      const row = await tx.employeeWorkflowTask.findUniqueOrThrow({
        where: { id: handbook },
      });
      expect(row).toMatchObject({
        status: 'COMPLETED',
        acknowledgedByUserId: fx.selfUser1,
        acknowledgementStatement:
          'I have received and read the Staff Handbook 2026.',
      });
      // A completed task is locked; only an explicit, reasoned reopening changes it.
      expect(
        await violation(tx, () =>
          tx.employeeWorkflowTask.update({
            where: { id: paperwork },
            data: { completionNote: 'edited' },
          }),
        ),
      ).toBeTruthy();
      expect(
        await violation(tx, () =>
          tx.employeeWorkflowTask.update({
            where: { id: paperwork },
            data: {
              status: 'IN_PROGRESS',
              completedAt: null,
              completionSource: null,
            },
          }),
        ),
      ).toBeTruthy();
      expect(
        await failure(
          svc.tasks.reopen(
            paperwork,
            'Wrong contract version',
            ctx(fx.selfUser2),
          ),
        ),
      ).toMatchObject({ status: 404 });
      // HR completes the HR-pool task on its behalf; IT completes theirs; the CoC form waits.
      await svc.tasks.complete(id('Payroll information'), {}, hr);
      expect(
        (await svc.workflows.myTasks(fx.users.itDesk!)).items.map(
          (task) => task.title,
        ),
      ).toEqual(['Set up accounts']);
      await svc.tasks.complete(
        id('Set up accounts'),
        { note: 'Accounts created' },
        ctx(fx.users.itDesk!),
      );
      expect(
        (await svc.workflows.detail(fx.users.onboardingHr!, started.id)).status,
      ).toBe('ACTIVE');
      // Waiving the last task completes the workflow; reopening a task reopens it.
      expect(
        await failure(
          svc.tasks.waive(id('Complete the Code of Conduct form'), '', hr),
        ),
      ).toMatchObject({ status: 400 });
      await svc.tasks.waive(
        id('Complete the Code of Conduct form'),
        'Completed at a previous school',
        hr,
      );
      const done = await svc.workflows.detail(
        fx.users.onboardingHr!,
        started.id,
      );
      expect(done).toMatchObject({
        status: 'COMPLETED',
        progress: { percent: 100, allDone: true },
      });
      clock.value = new Date('2026-03-20T16:00:00.000Z');
      const reopened = await svc.tasks.reopen(
        paperwork,
        'Wrong contract version',
        hr,
      );
      expect(reopened.status).toBe('ACTIVE');
      expect(
        reopened.tasks.find((task) => task.id === paperwork),
      ).toMatchObject({
        status: 'IN_PROGRESS',
        reopenCount: 1,
        completedAt: null,
      });
      expect(await failure(svc.tasks.reopen(paperwork, 'again', hr))).toEqual({
        status: 409,
        code: 'WORKFLOW_TASK_NOT_FINISHED',
      });
      const events = (
        reopened as { events: Array<{ type: string }> }
      ).events.map((event) => event.type);
      expect(events).toEqual(
        expect.arrayContaining([
          'STARTED',
          'TASK_COMPLETED',
          'TASK_ACKNOWLEDGED',
          'TASK_WAIVED',
          'COMPLETED',
          'REOPENED',
          'TASK_REOPENED',
        ]),
      );
      // Employee tasks stay the employee's; others can be reassigned (never to the employee).
      expect(
        await failure(svc.tasks.reassign(paperwork, fx.selfUser2, hr)),
      ).toEqual({ status: 409, code: 'WORKFLOW_TASK_EMPLOYEE_OWNED' });
      // Audit metadata holds identifiers only — never notes or evidence.
      const audits = await tx.auditLog.findMany({
        where: {
          entityType: { in: ['EmployeeWorkflowTask', 'EmployeeWorkflow'] },
        },
      });
      expect(JSON.stringify(audits.map((a) => a.metadata))).not.toMatch(
        /room 12|contract|previous school|Handbook/,
      );
    });
  });

  it('tracks offboarding around Core HR without changing employment, with sensitive reasons hidden', async () => {
    await scenario(async (tx, fx, svc, clock) => {
      await activeTemplate(svc, fx, {
        kind: 'OFFBOARDING',
        code: 'staff-off',
        tasks: offboardingTasks(fx) as never,
      });
      const off = ctx(fx.users.offboardingHr!);
      // Onboarding access does not reach offboarding.
      expect(
        await failure(
          svc.workflows.start(
            'OFFBOARDING',
            {
              employmentAssignmentId: fx.assignmentTeamA,
              plannedEndDate: '2026-06-30',
            },
            ctx(fx.users.onboardingHr!),
          ),
        ),
      ).toMatchObject({ status: 403 });
      expect(
        await failure(
          svc.workflows.start(
            'OFFBOARDING',
            { employmentAssignmentId: fx.assignmentTeamA },
            off,
          ),
        ),
      ).toEqual({ status: 400, code: 'WORKFLOW_END_DATE_REQUIRED' });
      const workflow = await svc.workflows.start(
        'OFFBOARDING',
        {
          employmentAssignmentId: fx.assignmentTeamA,
          plannedEndDate: '2026-06-30',
          reason: 'Relocating to another province',
        },
        off,
      );
      expect(workflow).toMatchObject({
        kind: 'OFFBOARDING',
        anchorDate: '2026-06-30',
        reason: 'Relocating to another province',
        coreHr: {
          assignmentStatus: 'ACTIVE',
          assignmentEndDate: null,
          endDateRecorded: false,
        },
      });
      // Starting offboarding never touches Core HR.
      expect(
        await tx.employmentAssignment.findUniqueOrThrow({
          where: { id: fx.assignmentTeamA },
        }),
      ).toMatchObject({ status: 'ACTIVE', endDate: null });
      expect(
        await tx.employee.findUniqueOrThrow({ where: { id: fx.employee1 } }),
      ).toMatchObject({ status: 'ACTIVE', terminationDate: null });
      // The employee sees their own tasks but never the reason; IT sees its task only.
      const own = (await svc.workflows.mine(fx.selfUser1)).items.find(
        (item) => item.kind === 'OFFBOARDING',
      )!;
      expect(own).not.toHaveProperty('reason');
      expect(own.tasks.map((task) => task.title)).toEqual([
        'Return laptop and keys',
      ]);
      const it = await svc.workflows.detail(fx.users.itDesk!, workflow.id);
      expect(it).toMatchObject({ view: 'TASK_OWNER' });
      expect(it).not.toHaveProperty('reason');
      // After the planned date, Core HR not yet ended: an attention item, never an automatic end.
      clock.value = new Date('2026-07-02T16:00:00.000Z');
      const dashboard = await svc.workflows.dashboard(
        fx.users.offboardingHr!,
        fx.orgA,
        'OFFBOARDING',
      );
      expect(
        dashboard.attention.coreHrPending.map((row) => row.workflowId),
      ).toEqual([workflow.id]);
      // Due 06-30, 07-01 and 06-28 are overdue on 07-02; the final payroll review (07-03) is not yet.
      expect(
        dashboard.attention.overdueTasks.map((row) => row.title).sort(),
      ).toEqual([
        'Disable HRMS and Google accounts',
        'Exit interview',
        'Return laptop and keys',
      ]);
      expect(
        await failure(
          svc.workflows.dashboard(
            fx.users.onboardingHr!,
            fx.orgA,
            'OFFBOARDING',
          ),
        ),
      ).toMatchObject({ status: 403 });
      // Cancelling closes open tasks; a cancelled workflow is frozen.
      await svc.tasks.complete(
        workflow.tasks.find((task) => task.title === 'Exit interview')!.id,
        { note: 'Held' },
        off,
      );
      const cancelled = await svc.workflows.cancel(
        workflow.id,
        'Employee decided to stay',
        off,
      );
      expect(cancelled.status).toBe('CANCELLED');
      expect(cancelled.tasks.map((task) => task.status).sort()).toEqual([
        'CANCELLED',
        'CANCELLED',
        'CANCELLED',
        'COMPLETED',
      ]);
      expect(
        await failure(svc.tasks.complete(workflow.tasks[0]!.id, {}, off)),
      ).toMatchObject({ status: 409 });
      expect(
        await violation(tx, () =>
          tx.employeeWorkflow.update({
            where: { id: workflow.id },
            data: {
              status: 'ACTIVE',
              cancelledAt: null,
              cancellationReason: null,
            },
          }),
        ),
      ).toBeTruthy();
      // A new offboarding may start once the previous one is closed.
      await svc.workflows.start(
        'OFFBOARDING',
        {
          employmentAssignmentId: fx.assignmentTeamA,
          plannedEndDate: '2026-08-31',
        },
        off,
      );
    });
  });

  it('starts onboarding from a Phase 13 hire, once, through the hand-off contract', async () => {
    await scenario(async (tx, fx, svc) => {
      await activeTemplate(svc, fx);
      const recruitment = recruitmentServices(
        rollbackClient(tx),
        new FixedRecruitmentClock(),
      );
      // The hiring admin of the recruitment fixtures is created here with the same permissions.
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
      const fxWithHirer = {
        ...fx,
        users: { ...fx.users, hiringAdmin: fx.users.hr! },
      };
      const { applicationId } = await acceptedOffer(recruitment, fxWithHirer, {
        positionId: position,
        candidate: { email: 'new.teacher@example.com' },
      });
      const hire = await recruitment.hires.convert(
        applicationId,
        {},
        ctx(fx.users.hr!),
      );
      // Recruitment access alone never starts onboarding.
      expect(
        await failure(
          svc.workflows.startFromHire(hire.id, null, ctx(fx.users.hr!)),
        ),
      ).toMatchObject({ status: 403 });
      const first = await svc.workflows.startFromHire(
        hire.id,
        null,
        ctx(fx.users.onboardingHr!),
      );
      expect(first).toMatchObject({
        created: true,
        recruitmentHireId: hire.id,
        anchorDate: '2026-04-01',
      });
      // The new employee has no account yet: their tasks wait unassigned (an attention item).
      expect(
        first.tasks.find((task) => task.ownerType === 'EMPLOYEE')!.owner,
      ).toBeNull();
      const second = await svc.workflows.startFromHire(
        hire.id,
        null,
        ctx(fx.users.onboardingHr!),
      );
      expect(second).toMatchObject({ created: false, id: first.id });
      expect(
        await tx.employeeWorkflow.count({
          where: { recruitmentHireId: hire.id },
        }),
      ).toBe(1);
      const dashboard = await svc.workflows.dashboard(
        fx.users.onboardingHr!,
        fx.orgA,
        'ONBOARDING',
      );
      expect(dashboard.attention.unassignedTasks.length).toBeGreaterThan(0);
      expect(
        dashboard.attention.upcoming.map((row) => row.workflowId),
      ).toContain(first.id);
      // The database ties the hire to the assignment it created.
      expect(
        await violation(tx, () =>
          tx.employeeWorkflow.create({
            data: {
              organizationId: fx.orgA,
              kind: 'ONBOARDING',
              employeeId: fx.employee1,
              employmentAssignmentId: fx.assignmentTeamA,
              templateName: 'x',
              anchorDate: new Date(),
              recruitmentHireId: hire.id,
            },
          }),
        ),
      ).toBeTruthy();
    });
  });

  it('completes Google Form tasks through the external-completion contract, idempotently', async () => {
    await scenario(async (tx, fx, svc) => {
      await activeTemplate(svc, fx);
      const assignmentId = await newAssignment(tx, fx);
      const workflow = await svc.workflows.start(
        'ONBOARDING',
        { employmentAssignmentId: assignmentId },
        ctx(fx.users.onboardingHr!),
      );
      const email = (
        await tx.user.findUniqueOrThrow({ where: { id: fx.selfUser1 } })
      ).email;
      const submission = {
        externalResourceId: 'coc-form-1',
        externalResponseId: 'resp-1',
        respondentEmail: email.toUpperCase(),
        submittedAt: '2026-03-16T10:00:00Z',
      };
      expect(
        await failure(
          svc.tasks.completeFromSubmissions(
            fx.orgA,
            'GOOGLE_FORM',
            [submission],
            fx.users.onboardingReader!,
          ),
        ),
      ).toMatchObject({ status: 403 });
      const first = await svc.tasks.completeFromSubmissions(
        fx.orgA,
        'GOOGLE_FORM',
        [
          submission,
          {
            ...submission,
            externalResponseId: 'resp-x',
            respondentEmail: 'stranger@example.com',
          },
          {
            ...submission,
            externalResourceId: 'another-form',
            externalResponseId: 'resp-y',
          },
          { ...submission, externalResponseId: '' },
        ],
        null,
      );
      expect(first.outcomes.map((row) => row.outcome)).toEqual([
        'COMPLETED',
        'NO_MATCHING_EMPLOYEE',
        'NO_OPEN_TASK',
        'REJECTED',
      ]);
      const again = await svc.tasks.completeFromSubmissions(
        fx.orgA,
        'GOOGLE_FORM',
        [submission],
        null,
      );
      expect(again.outcomes[0]).toMatchObject({
        outcome: 'UNCHANGED',
        taskId: first.outcomes[0]!.taskId,
      });
      const task = await tx.employeeWorkflowTask.findUniqueOrThrow({
        where: { id: first.outcomes[0]!.taskId! },
      });
      expect(task).toMatchObject({
        status: 'COMPLETED',
        completionSource: 'EXTERNAL',
        externalCompletionId: 'resp-1',
        workflowId: workflow.id,
      });
      // Another organization's workflows are never reached.
      expect(
        (
          await svc.tasks.completeFromSubmissions(
            fx.orgB,
            'GOOGLE_FORM',
            [{ ...submission, externalResponseId: 'resp-2' }],
            null,
          )
        ).outcomes[0]!.outcome,
      ).toBe('NO_OPEN_TASK');
      // Acknowledgement tasks are never completed externally.
      expect(
        (
          await svc.tasks.completeFromSubmissions(
            fx.orgA,
            'GOOGLE_DOC',
            [
              {
                ...submission,
                externalResourceId: 'handbook-2026',
                externalResponseId: 'resp-3',
              },
            ],
            null,
          )
        ).outcomes[0]!.outcome,
      ).toBe('NO_OPEN_TASK');
    });
  });

  it('builds reminder digests for task owners (no delivery sink in Phase 14)', async () => {
    await scenario(async (tx, fx, svc, clock) => {
      await activeTemplate(svc, fx);
      const assignmentId = await newAssignment(tx, fx);
      await svc.workflows.start(
        'ONBOARDING',
        { employmentAssignmentId: assignmentId },
        ctx(fx.users.onboardingHr!),
      );
      clock.value = new Date('2026-03-30T12:00:00.000Z');
      const delivered: unknown[] = [];
      const sink: WorkflowReminderSink = {
        deliver: async (digests) => void delivered.push(...digests),
      };
      const outcome = await sendTaskReminders(
        rollbackClient(tx),
        [sink],
        clock,
      );
      expect(outcome).toMatchObject({ owners: 3, delivered: 1, failed: [] });
      // Paperwork (due 03-29) is overdue; accounts (03-31) and the manager meeting (04-02) are due soon;
      // the HR-pool payroll task (04-01) has no owner to remind.
      expect(outcome).toMatchObject({ overdue: 1, dueSoon: 2 });
      expect(delivered).toHaveLength(3);
      expect(
        await sendTaskReminders(rollbackClient(tx), [], clock),
      ).toMatchObject({ delivered: 0, failed: [] });
    });
  });
});

describe('Onboarding concurrency (committed data)', () => {
  let prisma: PrismaService;
  let fx: SchedulingFixtures;
  let svc: OnboardingServices;

  beforeAll(async () => {
    prisma = new PrismaService(process.env.DATABASE_URL!);
    await prisma.$connect();
    fx = await prisma.$transaction(
      (tx) => createSchedulingFixtures(tx, ONBOARDING_USERS),
      { timeout: 60_000 },
    );
    svc = onboardingServices(prisma, new FixedOnboardingClock());
    await activeTemplate(svc, fx, { code: `T-${fx.suffix}` });
  });

  afterAll(async () => {
    if (fx) await cleanupSchedulingFixtures(prisma, fx);
    await prisma?.$disconnect();
  });

  it('starts one onboarding when it is started twice at once', async () => {
    const assignmentId = await prisma.$transaction((tx) =>
      newAssignment(tx, fx, '2026-05-01'),
    );
    const results = await Promise.allSettled(
      [0, 1, 2].map(() =>
        svc.workflows.start(
          'ONBOARDING',
          { employmentAssignmentId: assignmentId },
          ctx(fx.users.onboardingHr!),
        ),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const rejected of results.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    )) {
      expect(await failure(Promise.reject(rejected.reason))).toMatchObject({
        status: 409,
        code: 'WORKFLOW_ALREADY_ACTIVE',
      });
    }
    expect(
      await prisma.employeeWorkflow.count({
        where: { employmentAssignmentId: assignmentId },
      }),
    ).toBe(1);
  });

  it('completes a task once when two users complete it together', async () => {
    const assignmentId = await prisma.$transaction((tx) =>
      newAssignment(tx, fx, '2026-05-02'),
    );
    const workflow = await svc.workflows.start(
      'ONBOARDING',
      { employmentAssignmentId: assignmentId },
      ctx(fx.users.onboardingHr!),
    );
    const task = workflow.tasks.find((row) => row.title === 'Set up accounts')!;
    const results = await Promise.allSettled([
      svc.tasks.complete(task.id, { note: 'IT' }, ctx(fx.users.itDesk!)),
      svc.tasks.complete(task.id, { note: 'HR' }, ctx(fx.users.onboardingHr!)),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([
      'fulfilled',
      'rejected',
    ]);
    const rejected = results.find(
      (r) => r.status === 'rejected',
    ) as PromiseRejectedResult;
    expect(await failure(Promise.reject(rejected.reason))).toEqual({
      status: 409,
      code: 'WORKFLOW_TASK_NOT_OPEN',
    });
    expect(
      await prisma.employeeWorkflowEvent.count({
        where: { taskId: task.id, type: 'TASK_COMPLETED' },
      }),
    ).toBe(1);
  });

  it('serializes task completion with workflow cancellation', async () => {
    const assignmentId = await prisma.$transaction((tx) =>
      newAssignment(tx, fx, '2026-05-03'),
    );
    const workflow = await svc.workflows.start(
      'ONBOARDING',
      { employmentAssignmentId: assignmentId },
      ctx(fx.users.onboardingHr!),
    );
    const task = workflow.tasks.find((row) => row.title === 'Set up accounts')!;
    const results = await Promise.allSettled([
      svc.tasks.complete(task.id, { note: 'IT' }, ctx(fx.users.itDesk!)),
      svc.workflows.cancel(
        workflow.id,
        'Offer rescinded',
        ctx(fx.users.onboardingHr!),
      ),
    ]);
    expect(results[1]!.status).toBe('fulfilled');
    const finalTask = await prisma.employeeWorkflowTask.findUniqueOrThrow({
      where: { id: task.id },
    });
    // Either the completion landed first (kept, the rest cancelled) or the cancellation did.
    expect(finalTask.status).toBe(
      results[0]!.status === 'fulfilled' ? 'COMPLETED' : 'CANCELLED',
    );
    expect(
      await prisma.employeeWorkflowTask.count({
        where: {
          workflowId: workflow.id,
          status: { in: ['NOT_STARTED', 'IN_PROGRESS'] },
        },
      }),
    ).toBe(0);
  });
});
