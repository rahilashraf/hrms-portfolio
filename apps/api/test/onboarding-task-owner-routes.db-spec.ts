import cookieParser from 'cookie-parser';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { config } from 'dotenv';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AccessTokenService } from '../src/auth/access-token.service.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { RedisService } from '../src/redis/redis.service.js';
import { SessionsService } from '../src/sessions/sessions.service.js';
import {
  FixedOnboardingClock,
  onboardingServices,
} from './support/onboarding-fixtures.js';
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

/** The scenario's transaction as the application's PrismaService (it owns no connection). */
function appClient(tx: Tx) {
  const client = rollbackClient(tx);
  return new Proxy(client, {
    get(target, property, receiver) {
      if (property === 'onModuleInit' || property === 'onModuleDestroy') {
        return async () => undefined;
      }
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
}

/**
 * Security fix over HTTP, against the real database (each test runs in a transaction that is
 * rolled back): PUT /onboarding/tasks/:id/owner and POST /onboarding/templates refuse a task
 * owner outside the organization with the same 400 as an unknown account, and accept the
 * organization's people, the employee's manager and System-scope authority.
 */
describe(
  'Onboarding task owner routes (database, HTTP)',
  { timeout: 120_000 },
  () => {
    let prisma: PrismaService;

    beforeAll(async () => {
      process.env.JWT_ACCESS_SECRET ||=
        'db-spec-only-deterministic-secret-value-at-least-32';
      prisma = new PrismaService(process.env.DATABASE_URL!);
      await prisma.$connect();
    });

    afterAll(async () => {
      await prisma?.$disconnect();
    });

    /** The application on the scenario's transaction; tokens for any fixture user. */
    async function scenario(
      run: (h: {
        tx: Tx;
        fx: SchedulingFixtures;
        people: Awaited<ReturnType<typeof ownerPopulation>>;
        call: (
          userId: string,
          method: 'post' | 'put' | 'patch',
          path: string,
          body: object,
          status: number,
        ) => Promise<request.Response>;
      }) => Promise<void>,
    ) {
      await expect(
        prisma.$transaction(
          async (tx) => {
            const fx = await createSchedulingFixtures(tx, OWNER_USERS);
            const people = await ownerPopulation(tx, fx);
            const { AppModule } = await import('../src/app.module.js');
            const moduleFixture = await Test.createTestingModule({
              imports: [AppModule],
            })
              .overrideProvider(PrismaService)
              .useValue(appClient(tx))
              .overrideProvider(RedisService)
              .useValue({ client: { eval: vi.fn().mockResolvedValue(1) } })
              .overrideProvider(SessionsService)
              .useValue({
                findActiveByIdAndUser: vi.fn().mockResolvedValue({
                  id: 'session-1',
                  mustChangePassword: false,
                }),
              })
              .compile();
            const app: INestApplication<App> =
              moduleFixture.createNestApplication();
            app.use(cookieParser());
            app.useGlobalPipes(
              new ValidationPipe({
                whitelist: true,
                forbidNonWhitelisted: true,
                transform: true,
              }),
            );
            await app.init();
            const tokens = app.get(AccessTokenService);
            const server = app.getHttpServer();
            try {
              await run({
                tx,
                fx,
                people,
                async call(userId, method, path, body, status) {
                  const token = await tokens.issue({
                    userId,
                    sessionId: 'session-1',
                  });
                  return request(server)
                    [method](path)
                    .set('Authorization', `Bearer ${token}`)
                    .send(body)
                    .expect(status);
                },
              });
            } finally {
              await app.close();
            }
            throw new RollbackFixtures();
          },
          { timeout: 120_000 },
        ),
      ).rejects.toBeInstanceOf(RollbackFixtures);
    }

    it('PUT /onboarding/tasks/:id/owner refuses accounts outside the organization alike', async () => {
      await scenario(async ({ tx, fx, people, call }) => {
        const svc = onboardingServices(
          rollbackClient(tx),
          new FixedOnboardingClock(),
        );
        const admin = ctx(fx.users.templateAdmin!);
        const created = await svc.templates.create(
          ownerTemplate(fx, 'http', []),
          admin,
        );
        await svc.templates.activate(created.id, admin);
        const workflow = await svc.workflows.start(
          'ONBOARDING',
          {
            employmentAssignmentId: people.newcomerAssignment,
            templateId: created.id,
          },
          ctx(fx.users.onboardingHr!),
        );
        const taskId = workflow.tasks.find(
          (task) => task.title === 'Paperwork',
        )!.id;
        const reassign = (actor: string, ownerUserId: string, status: number) =>
          call(
            actor,
            'put',
            `/onboarding/tasks/${taskId}/owner`,
            { ownerUserId },
            status,
          );
        const hr = fx.users.onboardingHr!;

        // An existing, active account of Org B: refused, exactly like an id that exists nowhere.
        const outsider = await reassign(hr, people.outsiderB, 400);
        expect(outsider.body).toMatchObject({
          code: 'WORKFLOW_OWNER_INVALID',
          message: 'A task owner must be an active user of this organization.',
        });
        const unknown = await reassign(hr, people.unknown, 400);
        expect(unknown.body).toEqual(outsider.body);
        expect(
          (
            await tx.employeeWorkflowTask.findUniqueOrThrow({
              where: { id: taskId },
            })
          ).ownerUserId,
        ).toBeNull();

        // The organization's people and the employee's manager (in Org B) are accepted.
        await reassign(hr, people.employedA, 200);
        await reassign(hr, people.managerB, 200);
        // System-scope authority may name any active account.
        await reassign(people.system, people.outsiderB, 200);
        expect(
          (
            await tx.employeeWorkflowTask.findUniqueOrThrow({
              where: { id: taskId },
            })
          ).ownerUserId,
        ).toBe(people.outsiderB);
      });
    });

    it('POST /onboarding/templates refuses an owner outside the organization, not to System authority', async () => {
      await scenario(async ({ tx, fx, people, call }) => {
        const body = (code: string) =>
          ownerTemplate(fx, code, [people.outsiderB]);
        const refused = await call(
          fx.users.templateAdmin!,
          'post',
          '/onboarding/templates',
          body('http-out'),
          400,
        );
        expect(refused.body).toMatchObject({ code: 'WORKFLOW_OWNER_INVALID' });
        expect(
          await tx.workflowTemplate.count({
            where: { organizationId: fx.orgA, code: 'HTTP-OUT' },
          }),
        ).toBe(0);
        await call(
          fx.users.templateAdmin!,
          'post',
          '/onboarding/templates',
          ownerTemplate(fx, 'http-in', [people.plannedA]),
          201,
        );
        await call(
          people.system,
          'post',
          '/onboarding/templates',
          body('http-sys'),
          201,
        );
      });
    });

    it('PATCH /onboarding/templates/:id keeps an existing owner only on its own task, each task id once', async () => {
      await scenario(async ({ tx, fx, people, call }) => {
        const svc = onboardingServices(
          rollbackClient(tx),
          new FixedOnboardingClock(),
        );
        const admin = fx.users.templateAdmin!;
        const legacy = await svc.templates.create(
          ownerTemplate(fx, 'http-legacy', [people.plannedA]),
          ctx(admin),
        );
        // Saved before the fix with an owner outside the organization.
        await tx.workflowTemplateTask.updateMany({
          where: { templateId: legacy.id, ownerType: 'SPECIFIC_USER' },
          data: { ownerUserId: people.outsiderB },
        });
        const tasks = savedTasks(legacy).map((task) =>
          task.ownerType === 'SPECIFIC_USER'
            ? { ...task, ownerUserId: people.outsiderB }
            : task,
        );
        const path = `/onboarding/templates/${legacy.id}`;
        await call(admin, 'patch', path, { name: 'Renamed', tasks }, 200);
        const reused = await call(
          admin,
          'patch',
          path,
          {
            tasks: [
              ...tasks,
              { ...tasks[1]!, id: undefined, title: 'Another task' },
            ],
          },
          400,
        );
        expect(reused.body).toMatchObject({ code: 'WORKFLOW_OWNER_INVALID' });
        // A task id appears once, and only this template's ids are accepted.
        const duplicate = await call(
          admin,
          'patch',
          path,
          { tasks: [...tasks, { ...tasks[0]!, title: 'Copy' }] },
          400,
        );
        expect(duplicate.body).toMatchObject({
          code: 'WORKFLOW_TASK_ID_DUPLICATE',
        });
        const other = await svc.templates.create(
          ownerTemplate(fx, 'http-other', []),
          ctx(admin),
        );
        const borrowed = await call(
          admin,
          'patch',
          path,
          { tasks: [tasks[1]!, { ...tasks[0]!, id: other.tasks[0]!.id }] },
          400,
        );
        expect(borrowed.body).toMatchObject({
          code: 'WORKFLOW_TASK_ID_INVALID',
        });
      });
    });
  },
);
