import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service.js';
import {
  authServices,
  createLogin,
  META,
  PASSWORD,
  statusOf,
} from './support/auth-fixtures.js';
import {
  createSchedulingFixtures,
  rejection,
  rollbackClient,
  type SchedulingFixtures,
  type Tx,
} from './support/scheduling-fixtures.js';

config({ path: '../../.env' });

class RollbackFixtures extends Error {}

describe('Password sign-in (database)', () => {
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
      services: ReturnType<typeof authServices>;
    }) => Promise<void>,
  ) {
    await expect(
      prisma.$transaction(
        async (tx) => {
          const fx = await createSchedulingFixtures(tx, {});
          await run({ tx, fx, services: authServices(rollbackClient(tx)) });
          throw new RollbackFixtures();
        },
        { timeout: 120_000 },
      ),
    ).rejects.toBeInstanceOf(RollbackFixtures);
  }

  it('answers a wrong password like an unknown email and locks the account after five', async () => {
    await scenario(async ({ tx, fx, services: { auth } }) => {
      const ada = await createLogin(tx, fx, 'ada');
      const unknown = await rejection(
        auth.login(`nobody-${fx.suffix}@example.com`, PASSWORD, META),
      );
      expect(statusOf(unknown)).toBe(401);
      for (let attempt = 1; attempt <= 5; attempt++) {
        // Before the fix the failure counter's SQL errored here (500): an account-existence
        // oracle, and the lock never started.
        const error = await rejection(
          auth.login(ada.email, 'wrong-password', META),
        );
        expect(statusOf(error)).toBe(401);
        expect((error as Error).message).toBe((unknown as Error).message);
      }
      const user = await tx.user.findUniqueOrThrow({ where: { id: ada.id } });
      expect(user.failedLoginAttempts).toBe(5);
      expect(user.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
      // Locked: even the right password is refused, the same way.
      expect(
        statusOf(await rejection(auth.login(ada.email, PASSWORD, META))),
      ).toBe(401);
      expect(
        await tx.auditLog.count({
          where: { action: 'AUTH_ACCOUNT_TEMP_LOCKED', entityId: ada.id },
        }),
      ).toBe(1);
      // Once the lock has passed, the right password signs in and resets the count.
      await tx.user.update({
        where: { id: ada.id },
        data: { lockedUntil: new Date(Date.now() - 1000) },
      });
      await auth.login(ada.email, PASSWORD, META);
      expect(
        await tx.user.findUniqueOrThrow({ where: { id: ada.id } }),
      ).toMatchObject({ failedLoginAttempts: 0, lockedUntil: null });
    });
  });
});
