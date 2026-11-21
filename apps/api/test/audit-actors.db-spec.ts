import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditViewerService } from '../src/audit/audit-viewer.service.js';
import { AuthorizationService } from '../src/authorization/authorization.service.js';
import { PrismaService } from '../src/database/prisma.service.js';
import {
  createSchedulingFixtures,
  rejection,
  rollbackClient,
  type SchedulingFixtures,
  type Tx,
} from './support/scheduling-fixtures.js';

config({ path: '../../.env', quiet: true });

class RollbackFixtures extends Error {}

const USERS = {
  auditorA: [{ permissions: ['audit.read'], scope: 'org' as const }],
  auditorB: [{ permissions: ['audit.read'], scope: 'orgB' as const }],
  hrA: [{ permissions: ['employee.read'], scope: 'org' as const }],
  teamAuditor: [{ permissions: ['audit.read'], scope: 'teamA' as const }],
};

/**
 * Batch R3.3: GET /audit/actors, the lookup behind the audit viewer's actor filter. It returns
 * only the people who acted in the audit entries the caller may already read (same permission,
 * organization and date window as the list), by name only.
 */
describe('Audit actor lookup (database)', () => {
  let prisma: PrismaService;
  const NOW = new Date('2026-11-16T12:00:00.000Z');

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
      audit: AuditViewerService;
    }) => Promise<void>,
  ) {
    await expect(
      prisma.$transaction(
        async (tx) => {
          const fx = await createSchedulingFixtures(tx, USERS);
          const client = rollbackClient(tx);
          const audit = new AuditViewerService(
            client,
            new AuthorizationService(client),
          );
          await run({ tx, fx, audit }).catch((error: unknown) => {
            console.error('SCENARIO FAILURE', error);
            throw error;
          });
          throw new RollbackFixtures();
        },
        { timeout: 120_000 },
      ),
    ).rejects.toBeInstanceOf(RollbackFixtures);
  }

  async function person(
    tx: Tx,
    names: { firstName?: string; lastName?: string; preferredName?: string },
    archived = false,
  ) {
    const row = await tx.person.create({ data: names });
    const user = await tx.user.create({
      data: {
        personId: row.id,
        email: `r33-${randomUUID().slice(0, 8)}@example.invalid`,
        status: archived ? 'DISABLED' : 'ACTIVE',
        ...(archived ? { archivedAt: new Date('2026-06-01T00:00:00Z') } : {}),
      },
    });
    return user.id;
  }

  async function acted(
    tx: Tx,
    actorUserId: string,
    organizationId: string | null,
    occurredAt = new Date('2026-11-10T09:00:00Z'),
  ) {
    await tx.auditLog.create({
      data: {
        actorUserId,
        action: 'R33_TEST',
        entityType: 'Organization',
        entityId: organizationId,
        metadata: organizationId ? { organizationId } : {},
        occurredAt,
      },
    });
  }

  it('lists only the actors of the organization’s entries in the window, by name', async () => {
    await scenario(async ({ tx, fx, audit }) => {
      const ada = await person(tx, { firstName: 'Ada', lastName: 'Lovelace' });
      const grace = await person(tx, {
        firstName: 'Grace',
        lastName: 'Hopper',
        preferredName: 'Amazing Grace',
      });
      const onlyB = await person(tx, { firstName: 'Bertha', lastName: 'Benz' });
      const longAgo = await person(tx, { firstName: 'Old', lastName: 'Timer' });
      const unnamed = await person(tx, {});
      await acted(tx, ada, fx.orgA);
      await acted(tx, grace, fx.orgA);
      await acted(tx, unnamed, fx.orgA);
      await acted(tx, onlyB, fx.orgB);
      await acted(tx, longAgo, fx.orgA, new Date('2026-06-01T00:00:00Z'));

      const page = await audit.actors(
        fx.users.auditorA!,
        { organizationId: fx.orgA, limit: 50 },
        NOW,
      );
      const byId = new Map(
        page.items.map((item) => [item.userId, item.displayName]),
      );
      expect(byId.get(ada)).toBe('Ada Lovelace');
      expect(byId.get(grace)).toBe('Amazing Grace Hopper');
      expect(byId.has(unnamed)).toBe(true);
      expect(byId.get(unnamed)).toBeNull();
      // Organization B's actor, and one outside the default 30-day window, are not revealed.
      expect(byId.has(onlyB)).toBe(false);
      expect(byId.has(longAgo)).toBe(false);
      expect(JSON.stringify(page)).not.toMatch(/@example\.invalid/);

      // A wider window includes the older actor.
      const wide = await audit.actors(
        fx.users.auditorA!,
        {
          organizationId: fx.orgA,
          from: '2026-01-01T00:00:00.000Z',
          limit: 50,
        },
        NOW,
      );
      expect(wide.items.map((item) => item.userId)).toContain(longAgo);
    });
  });

  it('searches by any name part (wildcards escaped) or by exact user id', async () => {
    await scenario(async ({ tx, fx, audit }) => {
      const ada = await person(tx, { firstName: 'Ada', lastName: 'Lovelace' });
      const grace = await person(tx, {
        firstName: 'Grace',
        lastName: 'Hopper',
        preferredName: 'Amazing',
      });
      // An empty preferred name falls back to the first name, as the displayed name does.
      const blankPreferred = await person(tx, {
        firstName: 'Mary',
        lastName: 'Somerville',
        preferredName: '',
      });
      await acted(tx, ada, fx.orgA);
      await acted(tx, grace, fx.orgA);
      await acted(tx, blankPreferred, fx.orgA);
      const ids = async (query: string) =>
        (
          await audit.actors(
            fx.users.auditorA!,
            { organizationId: fx.orgA, query },
            NOW,
          )
        ).items.map((item) => item.userId);

      expect(await ids('love')).toEqual([ada]);
      expect(await ids('ada lov')).toEqual([ada]);
      expect(await ids('AMAZING')).toEqual([grace]);
      expect(await ids('hopper')).toEqual([grace]);
      expect(await ids(grace)).toEqual([grace]);
      expect(await ids('mary somerville')).toEqual([blankPreferred]);
      // "%" and "_" are literal characters, not wildcards.
      expect(await ids('%')).toEqual([]);
      expect(await ids('_')).toEqual([]);
    });
  });

  it('includes archived (former) users, whose entries remain', async () => {
    await scenario(async ({ tx, fx, audit }) => {
      const former = await person(
        tx,
        { firstName: 'Former', lastName: 'Staff' },
        true,
      );
      await acted(tx, former, fx.orgA);
      const page = await audit.actors(
        fx.users.auditorA!,
        { organizationId: fx.orgA },
        NOW,
      );
      expect(page.items).toContainEqual({
        userId: former,
        displayName: 'Former Staff',
      });
    });
  });

  it('lists, in the System view, only the actors of entries tied to no organization', async () => {
    await scenario(async ({ tx, fx, audit }) => {
      // Only the singleton System Owner role can be held at System scope (rolled back here).
      const sysAuditor = await person(tx, {
        firstName: 'Sys',
        lastName: 'Auditor',
      });
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
      const permission = await tx.permission.upsert({
        where: { key: 'audit.read' },
        create: { key: 'audit.read', name: 'audit.read', isActive: true },
        update: { isActive: true },
      });
      await tx.rolePermission.upsert({
        where: {
          roleId_permissionId: { roleId: role.id, permissionId: permission.id },
        },
        create: { roleId: role.id, permissionId: permission.id },
        update: {},
      });
      await tx.roleAssignment.create({
        data: { userId: sysAuditor, roleId: role.id, scopeType: 'SYSTEM' },
      });
      const systemOnly = await person(tx, {
        firstName: 'Platform',
        lastName: 'Admin',
      });
      const orgOnly = await person(tx, { firstName: 'Org', lastName: 'Only' });
      await acted(tx, systemOnly, null);
      await acted(tx, orgOnly, fx.orgA);

      const page = await audit.actors(
        sysAuditor,
        { scope: 'system', limit: 50 },
        NOW,
      );
      const ids = page.items.map((item) => item.userId);
      expect(ids).toContain(systemOnly);
      expect(ids).not.toContain(orgOnly);
    });
  });

  it('orders by displayed name (unnamed last), then id, across page boundaries (R4-A.7)', async () => {
    await scenario(async ({ tx, fx, audit }) => {
      // Created out of name order; two share a displayed name; one has no name.
      const zoe = await person(tx, { firstName: 'Zoe', lastName: 'Pager' });
      const amy1 = await person(tx, { firstName: 'Amy', lastName: 'Pager' });
      const unnamed = await person(tx, { lastName: '' });
      const amy2 = await person(tx, {
        firstName: 'Someone',
        preferredName: 'amy',
        lastName: 'pager',
      });
      const bob = await person(tx, { firstName: 'Bob', lastName: 'Pager' });
      for (const id of [zoe, amy1, unnamed, amy2, bob])
        await acted(tx, id, fx.orgA);
      const amys = [amy1, amy2].sort();
      const expected = [...amys, bob, zoe];

      const pageThrough = async (limit: number, query?: string) => {
        const seen: Array<string> = [];
        let afterId: string | undefined;
        for (let round = 0; round < 20; round += 1) {
          const page = await audit.actors(
            fx.users.auditorA!,
            { organizationId: fx.orgA, query, limit, afterId },
            NOW,
          );
          seen.push(...page.items.map((item) => item.userId));
          if (!page.nextAfterId) break;
          afterId = page.nextAfterId;
        }
        return seen;
      };
      // Searching: names in order, equal names by id, every page boundary (incl. inside the tie).
      for (const limit of [1, 2, 3, 50])
        expect(await pageThrough(limit, 'pager')).toEqual(expected);
      // Unfiltered: the unnamed actor comes after every named one, and nobody repeats.
      for (const limit of [1, 2, 50]) {
        const all = await pageThrough(limit);
        expect(new Set(all).size).toBe(all.length);
        const ours = all.filter((id) => [...expected, unnamed].includes(id));
        expect(ours).toEqual([...expected, unnamed]);
        expect(all.indexOf(unnamed)).toBeGreaterThan(all.indexOf(zoe));
      }
      // A cursor naming someone outside this caller's list reveals nothing about where their
      // name sorts: the page is empty (before, it continued from that user's name).
      const outsider = await person(tx, {
        firstName: 'Aaron',
        lastName: 'Outside',
      });
      expect(
        (
          await audit.actors(
            fx.users.auditorA!,
            { organizationId: fx.orgA, afterId: outsider },
            NOW,
          )
        ).items,
      ).toEqual([]);
    });
  });

  it('refuses callers without audit.read on that organization', async () => {
    await scenario(async ({ fx, audit }) => {
      // Another organization's auditor, a non-auditor, and a team-scoped auditor (the list
      // needs organization scope too).
      for (const user of [
        fx.users.auditorB!,
        fx.users.hrA!,
        fx.users.teamAuditor!,
      ]) {
        const error = (await rejection(
          audit.actors(user, { organizationId: fx.orgA }, NOW),
        )) as { getStatus?: () => number };
        expect(error.getStatus?.()).toBe(403);
      }
      // The System view needs audit.read at System scope.
      const system = (await rejection(
        audit.actors(fx.users.auditorA!, { scope: 'system' }, NOW),
      )) as { getStatus?: () => number };
      expect(system.getStatus?.()).toBe(403);
      // organizationId is required outside the System view.
      const missing = (await rejection(
        audit.actors(fx.users.auditorA!, {}, NOW),
      )) as {
        getStatus?: () => number;
      };
      expect(missing.getStatus?.()).toBe(400);
    });
  });
});
