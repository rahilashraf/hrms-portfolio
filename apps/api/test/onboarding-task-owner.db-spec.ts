import { readFileSync } from 'node:fs';
import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service.js';
import {
  FixedOnboardingClock,
  onboardingServices,
  type OnboardingServices,
} from './support/onboarding-fixtures.js';
import { failure } from './support/performance-fixtures.js';
import {
  OWNER_USERS,
  ownerPopulation,
  ownerTemplate,
  savedTasks,
} from './support/onboarding-owner-fixtures.js';
import {
  createSchedulingFixtures,
  ctx,
  rollbackClient,
  type SchedulingFixtures,
  type Tx,
} from './support/scheduling-fixtures.js';

config({ path: '../../.env' });

class RollbackFixtures extends Error {}

/** The read-only operator query of docs/security/sql (its SELECT, without the transaction). */
const OWNER_SCOPE_SQL = readFileSync(
  new URL(
    '../../../docs/security/sql/onboarding-task-owner-scope.sql',
    import.meta.url,
  ),
  'utf8',
)
  .split('BEGIN TRANSACTION READ ONLY;')[1]!
  .split('ROLLBACK;')[0]!;

async function ownerScopeFindings(tx: Tx, organizationId: string) {
  const rows =
    await tx.$queryRawUnsafe<
      Array<{ organization_id: string; finding: string; tasks: bigint }>
    >(OWNER_SCOPE_SQL);
  return rows
    .filter((row) => row.organization_id === organizationId)
    .map((row) => [row.finding.split(' ')[0], Number(row.tasks)]);
}

const TASK_ID_DUPLICATE = { status: 400, code: 'WORKFLOW_TASK_ID_DUPLICATE' };
const TASK_ID_INVALID = { status: 400, code: 'WORKFLOW_TASK_ID_INVALID' };

const OWNER_INVALID = {
  status: 400,
  code: 'WORKFLOW_OWNER_INVALID',
};
/**
 * Security fix: an onboarding task (or template task) may only be given to an account
 * connected to the workflow's organization (PLANNED or ACTIVE employment there, or a current
 * organization role there), or to the employee's own manager; any active account only with
 * System-scope authority. Before the fix, any active account of any organization could be
 * named by its id.
 */
describe('Onboarding task owners stay within the organization (database)', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService(process.env.DATABASE_URL!);
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  async function scenario(
    run: (h: {
      tx: Tx;
      fx: SchedulingFixtures;
      svc: OnboardingServices;
      people: Awaited<ReturnType<typeof ownerPopulation>>;
    }) => Promise<void>,
  ) {
    await expect(
      prisma.$transaction(
        async (tx) => {
          const fx = await createSchedulingFixtures(tx, OWNER_USERS);
          const svc = onboardingServices(
            rollbackClient(tx),
            new FixedOnboardingClock(),
          );
          await run({
            tx,
            fx,
            svc,
            people: await ownerPopulation(tx, fx),
          }).catch((error: unknown) => {
            console.error('SCENARIO FAILURE', error);
            throw error;
          });
          throw new RollbackFixtures();
        },
        { timeout: 120_000 },
      ),
    ).rejects.toBeInstanceOf(RollbackFixtures);
  }

  it('reassigns tasks only to accounts of the organization, the manager or by System authority', async () => {
    await scenario(async ({ fx, svc, people }) => {
      const admin = ctx(fx.users.templateAdmin!);
      const created = await svc.templates.create(
        ownerTemplate(fx, 'reassign', []),
        admin,
      );
      await svc.templates.activate(created.id, admin);
      const hr = ctx(fx.users.onboardingHr!);
      const workflow = await svc.workflows.start(
        'ONBOARDING',
        {
          employmentAssignmentId: people.newcomerAssignment,
          templateId: created.id,
        },
        hr,
      );
      const taskId = workflow.tasks.find(
        (task) => task.title === 'Paperwork',
      )!.id;

      for (const allowed of [
        people.employedA,
        people.plannedA,
        fx.users.roleA!,
        people.bothAB,
        // The employee's manager works in Org B: still a legitimate owner.
        people.managerB,
      ]) {
        await svc.tasks.reassign(taskId, allowed, hr);
      }

      // Refused alike: another organization's active employee or role holder, an ended
      // employment, a revoked or expired role, an inactive account and an unknown id.
      const unknown = await failure(
        svc.tasks.reassign(taskId, people.unknown, hr),
      );
      expect(unknown).toEqual(OWNER_INVALID);
      for (const refused of [
        people.outsiderB,
        fx.users.roleB!,
        people.endedA,
        people.revokedA,
        people.expiredA,
        people.inactiveA,
      ]) {
        expect(await failure(svc.tasks.reassign(taskId, refused, hr))).toEqual(
          unknown,
        );
      }
      // Unchanged: never to the employee themselves.
      await expect(
        svc.tasks.reassign(taskId, people.newcomer.userId, hr),
      ).rejects.toThrow('never given to the employee themselves');

      // System-scope authority may name any active account (still not an inactive one).
      await svc.tasks.reassign(taskId, people.outsiderB, ctx(people.system));
      expect(
        await failure(
          svc.tasks.reassign(taskId, people.inactiveA, ctx(people.system)),
        ),
      ).toEqual(OWNER_INVALID);
    });
  });

  it('checks template owners after authorization and keeps existing owners editable', async () => {
    await scenario(async ({ tx, fx, svc, people }) => {
      const admin = ctx(fx.users.templateAdmin!);
      const count = () =>
        tx.workflowTemplate.count({
          where: { organizationId: fx.orgA, code: { startsWith: 'OWN' } },
        });
      const before = await count();
      for (const refused of [people.outsiderB, people.unknown, people.endedA]) {
        expect(
          await failure(
            svc.templates.create(
              ownerTemplate(fx, `own-${refused.slice(-4)}`, [refused]),
              admin,
            ),
          ),
        ).toEqual(OWNER_INVALID);
      }
      expect(await count()).toBe(before);
      const kept = await svc.templates.create(
        ownerTemplate(fx, 'own-ok', [people.plannedA]),
        admin,
      );
      // A System-scope template manager may name any active account.
      await svc.templates.create(
        ownerTemplate(fx, 'own-sys', [people.outsiderB]),
        ctx(people.system),
      );

      // Unauthorized callers learn nothing about an owner id: 403 before any owner check.
      expect(
        await failure(
          svc.templates.update(
            kept.id,
            { tasks: ownerTemplate(fx, 'x', [people.unknown]).tasks },
            ctx(fx.users.onboardingHr!),
          ),
        ),
      ).toMatchObject({ status: 403 });

      // A template saved before the fix with an owner outside the organization (as stored).
      const legacy = await svc.templates.create(
        ownerTemplate(fx, 'own-legacy', [people.plannedA]),
        admin,
      );
      await tx.workflowTemplateTask.updateMany({
        where: { templateId: legacy.id, ownerType: 'SPECIFIC_USER' },
        data: { ownerUserId: people.outsiderB },
      });
      // As the editor sends it back: [Paperwork (HR), Owned task 0 (outsiderB)], with ids.
      const [paperwork, owned] = savedTasks(legacy).map((task) =>
        task.ownerType === 'SPECIFIC_USER'
          ? { ...task, ownerUserId: people.outsiderB }
          : task,
      );
      const ownedTask = (template: { tasks: typeof legacy.tasks }) =>
        template.tasks.find((task) => task.ownerType === 'SPECIFIC_USER');

      // Permitted: that task, unchanged owner, with an unrelated edit (name, reordering, a title).
      const renamed = await svc.templates.update(
        legacy.id,
        {
          name: 'Renamed',
          tasks: [{ ...owned!, title: 'Accounts' }, paperwork!],
        },
        admin,
      );
      expect(ownedTask(renamed)).toMatchObject({
        id: owned!.id,
        title: 'Accounts',
        ownerUserId: people.outsiderB,
      });
      const legacyTask = { ...owned!, title: 'Accounts' };
      // ...and again, with the ids it now has (the task legacyTask its id).
      await svc.templates.update(
        legacy.id,
        { tasks: [paperwork!, legacyTask] },
        admin,
      );

      // Forbidden: reusing that owner anywhere else, the exception belongs to the one task.
      const newTask = {
        title: 'Another task',
        category: 'ACCOUNT_ACCESS',
        ownerType: 'SPECIFIC_USER' as const,
        ownerUserId: people.outsiderB,
        dueOffsetDays: 1,
      };
      for (const tasks of [
        // on a new task (no id),
        [paperwork!, legacyTask, newTask],
        // on another existing task (Paperwork's id, owner changed),
        [{ ...paperwork!, ...newTask, id: paperwork!.id }, legacyTask],
        // or on that task sent without its id (it is then a new task).
        [paperwork!, { ...legacyTask, id: undefined }],
      ]) {
        expect(
          await failure(svc.templates.update(legacy.id, { tasks }, admin)),
        ).toEqual(OWNER_INVALID);
      }
      // A new owner outside the organization is refused too, legacy owner or not.
      expect(
        await failure(
          svc.templates.update(
            legacy.id,
            {
              tasks: [
                paperwork!,
                legacyTask,
                { ...newTask, ownerUserId: fx.users.roleB! },
              ],
            },
            admin,
          ),
        ),
      ).toEqual(OWNER_INVALID);
      // Nothing above changed the stored task.
      expect(
        await tx.workflowTemplateTask.findMany({
          where: { templateId: legacy.id, ownerType: 'SPECIFIC_USER' },
          select: { id: true, ownerUserId: true },
        }),
      ).toEqual([{ id: owned!.id, ownerUserId: people.outsiderB }]);
      // An existing owner who is no longer active is refused, as before the fix.
      await tx.user.update({
        where: { id: people.outsiderB },
        data: { status: 'DISABLED' },
      });
      expect(
        await failure(
          svc.templates.update(
            legacy.id,
            { tasks: [paperwork!, legacyTask] },
            admin,
          ),
        ),
      ).toEqual(OWNER_INVALID);
    });
  });

  it('starts a workflow without giving tasks to template owners no longer in the organization', async () => {
    await scenario(async ({ tx, fx, svc, people }) => {
      const admin = ctx(fx.users.templateAdmin!);
      const created = await svc.templates.create(
        ownerTemplate(fx, 'start', [people.employedA, people.plannedA]),
        admin,
      );
      // Saved before the fix (or the owner left): one owner is outside the organization.
      await tx.workflowTemplateTask.updateMany({
        where: { templateId: created.id, title: 'Owned task 1' },
        data: { ownerUserId: people.outsiderB },
      });
      await svc.templates.activate(created.id, admin);
      // The operator query counts the legacy template owner (employedA and plannedA are fine).
      expect(await ownerScopeFindings(tx, fx.orgA)).toEqual([['template', 1]]);

      const hr = ctx(fx.users.onboardingHr!);
      const workflow = await svc.workflows.start(
        'ONBOARDING',
        {
          employmentAssignmentId: people.newcomerAssignment,
          templateId: created.id,
        },
        hr,
      );
      const tasks = await tx.employeeWorkflowTask.findMany({
        where: { workflowId: workflow.id, title: { startsWith: 'Owned task' } },
        orderBy: { sortOrder: 'asc' },
      });
      // The eligible owner keeps the task; the other task starts in the HR pool.
      expect(tasks.map((task) => [task.ownerType, task.ownerUserId])).toEqual([
        ['SPECIFIC_USER', people.employedA],
        ['HR', null],
      ]);
      // The outsider gets no view of the workflow; the template itself is left as it was.
      await expect(
        svc.workflows.detail(people.outsiderB, workflow.id),
      ).rejects.toThrow();
      expect(
        (
          await tx.workflowTemplateTask.findFirstOrThrow({
            where: { templateId: created.id, title: 'Owned task 1' },
          })
        ).ownerUserId,
      ).toBe(people.outsiderB);
      const audit = await tx.auditLog.findFirstOrThrow({
        where: { action: 'ONBOARDING_STARTED', entityId: workflow.id },
      });
      expect(audit.metadata).toMatchObject({ ownersMovedToHrPool: 1 });
      // HR then gives the task to someone of the organization, or to the employee's manager
      // (in Org B): neither is counted by the operator query.
      await svc.tasks.reassign(tasks[1]!.id, people.plannedA, hr);
      await svc.tasks.reassign(tasks[0]!.id, people.managerB, hr);
      expect(await ownerScopeFindings(tx, fx.orgA)).toEqual([['template', 1]]);

      // Started by System-scope authority, the template owner is kept.
      await svc.workflows.cancel(workflow.id, 'Restart', hr);
      const systemStart = await svc.workflows.start(
        'ONBOARDING',
        {
          employmentAssignmentId: people.newcomerAssignment,
          templateId: created.id,
        },
        ctx(people.system),
      );
      expect(
        (
          await tx.employeeWorkflowTask.findFirstOrThrow({
            where: { workflowId: systemStart.id, title: 'Owned task 1' },
          })
        ).ownerUserId,
      ).toBe(people.outsiderB);
      // Counted too (a System-scope assignment is not distinguishable from data).
      expect(await ownerScopeFindings(tx, fx.orgA)).toEqual([
        ['open', 1],
        ['template', 1],
      ]);
    });
  });

  it('counts every task moved to the HR pool, also when one owner has several', async () => {
    await scenario(async ({ tx, fx, svc, people }) => {
      const admin = ctx(fx.users.templateAdmin!);
      const created = await svc.templates.create(
        ownerTemplate(fx, 'count', [
          people.plannedA,
          people.employedA,
          people.plannedA,
          people.plannedA,
        ]),
        admin,
      );
      // One owner outside the organization on three of the four owned tasks.
      await tx.workflowTemplateTask.updateMany({
        where: { templateId: created.id, ownerUserId: people.plannedA },
        data: { ownerUserId: people.outsiderB },
      });
      await svc.templates.activate(created.id, admin);
      const workflow = await svc.workflows.start(
        'ONBOARDING',
        {
          employmentAssignmentId: people.newcomerAssignment,
          templateId: created.id,
        },
        ctx(fx.users.onboardingHr!),
      );
      expect(
        (
          await tx.employeeWorkflowTask.findMany({
            where: { workflowId: workflow.id, title: { startsWith: 'Owned' } },
            orderBy: { sortOrder: 'asc' },
          })
        ).map((task) => [task.ownerType, task.ownerUserId]),
      ).toEqual([
        ['HR', null],
        ['SPECIFIC_USER', people.employedA],
        ['HR', null],
        ['HR', null],
      ]);
      const audit = await tx.auditLog.findFirstOrThrow({
        where: { action: 'ONBOARDING_STARTED', entityId: workflow.id },
      });
      expect(audit.metadata).toMatchObject({ ownersMovedToHrPool: 3 });
    });
  });

  it("accepts each task id of the template once, never another template's", async () => {
    await scenario(async ({ tx, fx, svc, people }) => {
      const admin = ctx(fx.users.templateAdmin!);
      const template = await svc.templates.create(
        ownerTemplate(fx, 'ids', [people.plannedA, people.employedA]),
        admin,
      );
      const other = await svc.templates.create(
        ownerTemplate(fx, 'ids-other', [people.plannedA]),
        admin,
      );
      const [paperwork, first, second] = savedTasks(template);
      const stored = () =>
        tx.workflowTemplateTask.findMany({
          where: { templateId: { in: [template.id, other.id] } },
          orderBy: [{ templateId: 'asc' }, { sortOrder: 'asc' }],
          select: {
            id: true,
            templateId: true,
            title: true,
            ownerUserId: true,
          },
        });
      const before = await stored();

      // Checked after authorization: a caller who cannot edit the template learns nothing.
      expect(
        await failure(
          svc.templates.update(
            template.id,
            { tasks: [first!, first!] },
            ctx(fx.users.onboardingHr!),
          ),
        ),
      ).toMatchObject({ status: 403 });

      // Duplicates are refused, even with an eligible (or no) owner and different fields.
      for (const tasks of [
        [paperwork!, first!, second!, first!],
        [paperwork!, first!, { ...first!, title: 'Copy', dueOffsetDays: 5 }],
        [paperwork!, { ...paperwork!, title: 'Paperwork again' }, first!],
      ]) {
        expect(
          await failure(svc.templates.update(template.id, { tasks }, admin)),
        ).toEqual(TASK_ID_DUPLICATE);
      }

      // Another template's task id, and an id that exists nowhere, get the same answer.
      const [, otherTask] = savedTasks(other);
      const borrowed = await failure(
        svc.templates.update(
          template.id,
          { tasks: [paperwork!, first!, { ...second!, id: otherTask!.id }] },
          admin,
        ),
      );
      expect(borrowed).toEqual(TASK_ID_INVALID);
      expect(
        await failure(
          svc.templates.update(
            template.id,
            { tasks: [paperwork!, { ...first!, id: people.unknown }] },
            admin,
          ),
        ),
      ).toEqual(borrowed);
      // A new template's tasks never carry an id.
      expect(
        await failure(
          svc.templates.create(
            {
              ...ownerTemplate(fx, 'ids-copy', []),
              tasks: [{ ...otherTask!, ownerUserId: people.plannedA }],
            },
            admin,
          ),
        ),
      ).toEqual(TASK_ID_INVALID);
      // Nothing was changed by the refusals.
      expect(await stored()).toEqual(before);

      // Legitimate edits: reorder, rename, delete one task (Paperwork) and add a new one.
      const edited = await svc.templates.update(
        template.id,
        {
          tasks: [
            { ...second!, title: 'Second, first now' },
            first!,
            {
              title: 'New task',
              category: 'PAPERWORK',
              ownerType: 'HR',
              dueOffsetDays: 2,
            },
          ],
        },
        admin,
      );
      expect(
        edited.tasks.map((task) => [task.id, task.title, task.ownerUserId]),
      ).toEqual([
        [second!.id, 'Second, first now', people.employedA],
        [first!.id, 'Owned task 0', people.plannedA],
        [expect.any(String), 'New task', null],
      ]);
      expect(edited.tasks.map((task) => task.id)).not.toContain(paperwork!.id);
      // The other template is untouched.
      expect(
        (await stored()).filter((task) => task.templateId === other.id),
      ).toEqual(before.filter((task) => task.templateId === other.id));
    });
  });
});
