import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccountSessionsService } from '../src/auth/account-sessions.service.js';
import type { AccountTokenService } from '../src/auth/account-token.service.js';
import type { AuthService } from '../src/auth/auth.service.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { PasswordHasherService } from '../src/security/password-hasher.service.js';
import type { SessionsService } from '../src/sessions/sessions.service.js';
import {
  authServices,
  codeOf,
  createLogin,
  FIREFOX,
  hasher,
  META,
  NEW_PASSWORD,
  PASSWORD,
  statusOf,
  testConfig,
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

interface Harness {
  tx: Tx;
  fx: SchedulingFixtures;
  client: PrismaService;
  auth: AuthService;
  sessions: SessionsService;
  accountSessions: AccountSessionsService;
  tokens: AccountTokenService;
  passwords: PasswordHasherService;
}

const login = createLogin;

describe('Account self-service: password change and sessions (database)', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService(process.env.DATABASE_URL!);
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  async function scenario(
    run: (h: Harness) => Promise<void>,
    passwords: PasswordHasherService = hasher,
  ) {
    await expect(
      prisma.$transaction(
        async (tx) => {
          const fx = await createSchedulingFixtures(tx, {});
          const client = rollbackClient(tx);
          const { auth, sessions, tokens, audit } = authServices(client, {
            passwords,
          });
          await run({
            tx,
            fx,
            client,
            auth,
            sessions,
            accountSessions: new AccountSessionsService(client, audit),
            tokens,
            passwords,
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

  /** Signs in and returns the new session's id. */
  async function signIn(
    h: Harness,
    email: string,
    password = PASSWORD,
    userAgent = FIREFOX,
  ) {
    await h.auth.login(email, password, { ...META, userAgent });
    const session = await h.tx.authSession.findFirstOrThrow({
      where: { user: { email } },
      orderBy: { createdAt: 'desc' },
    });
    return session.id;
  }

  const live = (h: Harness, sessionId: string, userId: string) =>
    h.sessions.findActiveByIdAndUser(sessionId, userId, new Date());

  it('changes the password, keeps the current session and ends every other one', async () => {
    await scenario(async (h) => {
      const ada = await login(h.tx, h.fx, 'ada', { mustChangePassword: true });
      const laptop = await signIn(h, ada.email);
      const phone = await signIn(h, ada.email);
      const tablet = await signIn(h, ada.email);
      const reset = await h.tokens.issue(ada.id, 'PASSWORD_RESET', 60_000);

      expect(await live(h, laptop, ada.id)).toEqual({
        id: laptop,
        mustChangePassword: true,
      });
      const result = await h.auth.changePassword(
        { userId: ada.id, sessionId: laptop },
        PASSWORD,
        NEW_PASSWORD,
        META,
      );
      expect(result).toEqual({ success: true, revokedSessionCount: 2 });

      expect(await live(h, laptop, ada.id)).toEqual({
        id: laptop,
        mustChangePassword: false,
      });
      expect(await live(h, phone, ada.id)).toBeNull();
      expect(await live(h, tablet, ada.id)).toBeNull();
      expect(
        await h.tx.authSession.findUniqueOrThrow({ where: { id: phone } }),
      ).toMatchObject({ revokedReason: 'password_changed' });
      // The reset link issued before the change no longer works.
      expect(
        await h.tokens.findUsable(reset.token, 'PASSWORD_RESET'),
      ).toBeNull();
      const user = await h.tx.user.findUniqueOrThrow({ where: { id: ada.id } });
      expect(user.mustChangePassword).toBe(false);
      expect(user.passwordChangedAt).not.toBeNull();
      expect(
        await h.passwords.verifyPassword(user.passwordHash!, NEW_PASSWORD),
      ).toBe(true);
      const audit = await h.tx.auditLog.findMany({
        where: { action: 'AUTH_PASSWORD_CHANGED', entityId: ada.id },
      });
      expect(audit).toHaveLength(1);
      expect(audit[0]!.metadata).toMatchObject({ revokedSessionCount: 2 });
      expect(JSON.stringify(audit[0]!.metadata)).not.toContain(NEW_PASSWORD);

      // The old password is gone; the new one signs in.
      const old = await rejection(h.auth.login(ada.email, PASSWORD, META));
      expect(statusOf(old)).toBe(401);
      await expect(
        h.auth.login(ada.email, NEW_PASSWORD, META),
      ).resolves.toMatchObject({ identity: { mustChangePassword: false } });
    });
  });

  it('refuses a wrong current password without changing anything or counting toward the lockout', async () => {
    await scenario(async (h) => {
      const ada = await login(h.tx, h.fx, 'ada');
      const session = await signIn(h, ada.email);
      const other = await signIn(h, ada.email);
      for (let attempt = 0; attempt < 6; attempt++) {
        const error = await rejection(
          h.auth.changePassword(
            { userId: ada.id, sessionId: session },
            'not-the-password',
            NEW_PASSWORD,
            META,
          ),
        );
        expect(statusOf(error)).toBe(400);
        expect(codeOf(error)).toBe('CURRENT_PASSWORD_INVALID');
      }
      const user = await h.tx.user.findUniqueOrThrow({ where: { id: ada.id } });
      expect(user).toMatchObject({ failedLoginAttempts: 0, lockedUntil: null });
      expect(
        await h.passwords.verifyPassword(user.passwordHash!, PASSWORD),
      ).toBe(true);
      expect(await live(h, other, ada.id)).not.toBeNull();
      const failures = await h.tx.auditLog.findMany({
        where: { action: 'AUTH_PASSWORD_CHANGE_FAILED', entityId: ada.id },
      });
      expect(failures).toHaveLength(6);
      expect(failures[0]!.metadata).toEqual({
        reasonCode: 'INVALID_CURRENT_PASSWORD',
      });
      expect(JSON.stringify(failures)).not.toContain('not-the-password');
    });
  });

  it('applies the password policy and refuses an unchanged password', async () => {
    await scenario(async (h) => {
      const ada = await login(h.tx, h.fx, 'ada');
      const session = await signIn(h, ada.email);
      const identity = { userId: ada.id, sessionId: session };
      const short = await rejection(
        h.auth.changePassword(identity, PASSWORD, 'too-short', META),
      );
      expect(statusOf(short)).toBe(400);
      const same = await rejection(
        h.auth.changePassword(identity, PASSWORD, PASSWORD, META),
      );
      expect(codeOf(same)).toBe('PASSWORD_UNCHANGED');
    });
  });

  it('refuses inactive accounts and sessions revoked meanwhile', async () => {
    await scenario(async (h) => {
      const ada = await login(h.tx, h.fx, 'ada');
      const session = await signIn(h, ada.email);
      await h.tx.authSession.update({
        where: { id: session },
        data: { revokedAt: new Date(), revokedReason: 'logout' },
      });
      const revoked = await rejection(
        h.auth.changePassword(
          { userId: ada.id, sessionId: session },
          PASSWORD,
          NEW_PASSWORD,
          META,
        ),
      );
      expect(statusOf(revoked)).toBe(401);

      const bob = await login(h.tx, h.fx, 'bob');
      const bobSession = await signIn(h, bob.email);
      await h.tx.user.update({
        where: { id: bob.id },
        data: { status: 'DISABLED' },
      });
      const disabled = await rejection(
        h.auth.changePassword(
          { userId: bob.id, sessionId: bobSession },
          PASSWORD,
          NEW_PASSWORD,
          META,
        ),
      );
      expect(statusOf(disabled)).toBe(401);
      for (const id of [ada.id, bob.id]) {
        const user = await h.tx.user.findUniqueOrThrow({ where: { id } });
        expect(
          await h.passwords.verifyPassword(user.passwordHash!, PASSWORD),
        ).toBe(true);
      }
    });
  });

  it('lets only one of two racing changes (or a change racing a reset) succeed', async () => {
    // The racing write happens after the current password was verified and before the update.
    let race: (() => Promise<void>) | undefined;
    const racingHasher = new (class extends PasswordHasherService {
      override async hashPassword(password: string) {
        const hash = await super.hashPassword(password);
        const run = race;
        race = undefined;
        await run?.();
        return hash;
      }
    })(testConfig);
    await scenario(async (h) => {
      const ada = await login(h.tx, h.fx, 'ada');
      const session = await signIn(h, ada.email);
      race = async () => {
        await h.tx.user.update({
          where: { id: ada.id },
          data: {
            passwordHash: await hasher.hashPassword('Reset-By-Someone-1'),
          },
        });
      };
      const error = await rejection(
        h.auth.changePassword(
          { userId: ada.id, sessionId: session },
          PASSWORD,
          NEW_PASSWORD,
          META,
        ),
      );
      expect(statusOf(error)).toBe(409);
      expect(codeOf(error)).toBe('PASSWORD_CHANGED_CONCURRENTLY');
      const user = await h.tx.user.findUniqueOrThrow({ where: { id: ada.id } });
      expect(
        await hasher.verifyPassword(user.passwordHash!, 'Reset-By-Someone-1'),
      ).toBe(true);
      expect(
        await h.tx.auditLog.count({
          where: { action: 'AUTH_PASSWORD_CHANGED', entityId: ada.id },
        }),
      ).toBe(0);
    }, racingHasher);
  });

  it('lists only the user’s own live sessions and ends them one by one or all others at once', async () => {
    await scenario(async (h) => {
      const ada = await login(h.tx, h.fx, 'ada');
      const bob = await login(h.tx, h.fx, 'bob');
      const current = await signIn(h, ada.email);
      const phone = await signIn(
        h,
        ada.email,
        PASSWORD,
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      );
      const tablet = await signIn(h, ada.email);
      const expired = await h.tx.authSession.create({
        data: {
          userId: ada.id,
          refreshTokenHash: `expired-${h.fx.suffix}`,
          expiresAt: new Date(Date.now() - 1000),
        },
      });
      const bobSession = await signIn(h, bob.email);
      const identity = { userId: ada.id, sessionId: current };

      const listed = await h.accountSessions.list(identity);
      expect(listed.items.map((item) => item.id).sort()).toEqual(
        [current, phone, tablet].sort(),
      );
      expect(listed.items.find((item) => item.id === current)).toMatchObject({
        current: true,
        browser: 'Firefox',
        os: 'Windows',
        ipAddress: META.ipAddress,
      });
      expect(listed.items.find((item) => item.id === phone)).toMatchObject({
        current: false,
        browser: 'Safari',
        os: 'iOS',
      });
      expect(JSON.stringify(listed)).not.toContain('refreshTokenHash');
      expect(JSON.stringify(listed)).not.toContain(expired.id);

      // Another user's session (or an unknown id) is "not found" and stays live.
      for (const id of [bobSession, expired.id]) {
        const error = await rejection(
          h.accountSessions.revoke(identity, id, META),
        );
        expect(statusOf(error)).toBe(404);
      }
      expect(await live(h, bobSession, bob.id)).not.toBeNull();
      // The session in use ends through "Sign out".
      expect(
        codeOf(
          await rejection(h.accountSessions.revoke(identity, current, META)),
        ),
      ).toBe('CURRENT_SESSION');

      await h.accountSessions.revoke(identity, phone, META);
      expect(await live(h, phone, ada.id)).toBeNull();
      expect(
        codeOf(
          await rejection(h.accountSessions.revoke(identity, phone, META)),
        ),
      ).toBe('SESSION_NOT_FOUND');
      expect(
        await h.tx.auditLog.findMany({
          where: { action: 'AUTH_SESSION_REVOKED', entityId: phone },
        }),
      ).toEqual([
        expect.objectContaining({
          metadata: expect.objectContaining({ reasonCode: 'USER_REVOKED' }),
        }),
      ]);

      expect(await h.accountSessions.revokeOthers(identity, META)).toEqual({
        success: true,
        revokedSessionCount: 1,
      });
      expect(await live(h, tablet, ada.id)).toBeNull();
      expect(await live(h, current, ada.id)).not.toBeNull();
      expect(await live(h, bobSession, bob.id)).not.toBeNull();
      expect(
        (await h.accountSessions.list(identity)).items.map((item) => item.id),
      ).toEqual([current]);
    });
  });
});
