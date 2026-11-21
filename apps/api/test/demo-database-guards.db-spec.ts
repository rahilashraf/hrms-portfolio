import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  readDemoIdentity,
  readNonEmptyTables,
  type RawQueryClient,
} from '../demo/demo-database.js';
import { PrismaService } from '../src/database/prisma.service.js';

config({ path: '../../.env' });

/**
 * Batch 11B — the demo guards' SQL against real PostgreSQL (the unit spec fakes the client).
 * Every scenario runs inside a REPEATABLE READ transaction that is always rolled back, so the
 * counts compared before and after are unaffected by other specs running in parallel, and the
 * test database is never marked or changed. markDemoDatabase itself is deliberately not called:
 * on an empty test database it would write the marker.
 */
class Rollback extends Error {}

let prisma: PrismaService;

beforeAll(async () => {
  prisma = new PrismaService(process.env.DATABASE_URL!);
  await prisma.$connect();
});

afterAll(async () => {
  await prisma?.$disconnect();
});

async function inRolledBackTransaction(
  run: (tx: RawQueryClient) => Promise<void>,
) {
  await expect(
    prisma.$transaction(
      async (tx) => {
        await run(tx);
        throw new Rollback();
      },
      { isolationLevel: 'RepeatableRead', timeout: 60_000 },
    ),
  ).rejects.toBeInstanceOf(Rollback);
}

describe('readNonEmptyTables (Batch 11B)', () => {
  it('reports tables, partitioned tables and materialized views with rows in any schema; skips empty ones and the migration history', async () => {
    const schema = `demo_guard_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await inRolledBackTransaction(async (tx) => {
      await tx.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
      await tx.$executeRawUnsafe(`CREATE TABLE "${schema}"."Filled" (id int)`);
      await tx.$executeRawUnsafe(`INSERT INTO "${schema}"."Filled" VALUES (1)`);
      await tx.$executeRawUnsafe(`CREATE TABLE "${schema}"."Empty" (id int)`);
      await tx.$executeRawUnsafe(
        `CREATE TABLE "${schema}"."Parted" (id int) PARTITION BY RANGE (id)`,
      );
      await tx.$executeRawUnsafe(
        `CREATE TABLE "${schema}"."Parted_1" PARTITION OF "${schema}"."Parted" FOR VALUES FROM (0) TO (10)`,
      );
      await tx.$executeRawUnsafe(`INSERT INTO "${schema}"."Parted" VALUES (5)`);
      await tx.$executeRawUnsafe(
        `CREATE MATERIALIZED VIEW "${schema}"."Summary" AS SELECT 1 AS one`,
      );
      // A quoted identifier that needs escaping.
      await tx.$executeRawUnsafe(
        `CREATE TABLE "${schema}"."Odd""Name" (id int)`,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO "${schema}"."Odd""Name" VALUES (1)`,
      );

      const nonEmpty = await readNonEmptyTables(tx);
      const mine = nonEmpty.filter((name) => name.startsWith(`${schema}.`));
      expect(mine).toEqual(
        [
          `${schema}.Filled`,
          `${schema}.Odd"Name`,
          `${schema}.Parted`,
          `${schema}.Parted_1`,
          `${schema}.Summary`,
        ].sort(),
      );
      // A migrated database always has rows in Prisma's history; that alone never blocks marking.
      expect(nonEmpty).not.toContain('public._prisma_migrations');
    });
  });
});

describe('readDemoIdentity: people and employees outside the demo organizations (Batch 11B)', () => {
  it('counts an orphan person and an unassigned employee, and stops counting them once assigned in an HL- organization', async () => {
    const suffix = randomUUID().slice(0, 8).toUpperCase();
    await inRolledBackTransaction(async (tx) => {
      const before = await readDemoIdentity(tx);

      // A person with no account and no employment: application data with no User or
      // Organization row behind it.
      const personId = randomUUID();
      await tx.$executeRawUnsafe(
        `INSERT INTO "Person" (id, "updatedAt") VALUES ($1::uuid, now())`,
        personId,
      );
      const orphan = await readDemoIdentity(tx);
      expect(orphan.foreignPeople).toBe(before.foreignPeople + 1);
      expect(orphan.foreignEmployees).toBe(before.foreignEmployees);

      // The same person as an employee without any assignment.
      const employeeId = randomUUID();
      await tx.$executeRawUnsafe(
        `INSERT INTO "Employee" (id, "personId", "employeeNumber", "hireDate", "updatedAt")
         VALUES ($1::uuid, $2::uuid, $3, DATE '2026-01-05', now())`,
        employeeId,
        personId,
        `GUARD-${suffix}`,
      );
      const unassigned = await readDemoIdentity(tx);
      expect(unassigned.foreignPeople).toBe(before.foreignPeople + 1);
      expect(unassigned.foreignEmployees).toBe(before.foreignEmployees + 1);

      // Assigned in a non-demo organization: still foreign.
      const assign = async (organizationCode: string) => {
        const organizationId = randomUUID();
        const jobTitleId = randomUUID();
        const positionId = randomUUID();
        await tx.$executeRawUnsafe(
          `INSERT INTO "Organization" (id, name, code, "updatedAt") VALUES ($1::uuid, $2, $2, now())`,
          organizationId,
          organizationCode,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO "JobTitle" (id, "organizationId", name, code, "updatedAt")
           VALUES ($1::uuid, $2::uuid, 'Guard check', 'GRD', now())`,
          jobTitleId,
          organizationId,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO "Position" (id, "organizationId", "jobTitleId", name, code, "updatedAt")
           VALUES ($1::uuid, $2::uuid, $3::uuid, 'Guard check', 'GRD-1', now())`,
          positionId,
          organizationId,
          jobTitleId,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO "EmploymentAssignment" (id, "employeeId", "positionId", "employmentType", "startDate", "updatedAt")
           VALUES ($1::uuid, $2::uuid, $3::uuid, 'FULL_TIME', DATE '2026-01-05', now())`,
          randomUUID(),
          employeeId,
          positionId,
        );
      };
      await assign(`GUARD-${suffix}`);
      const elsewhere = await readDemoIdentity(tx);
      expect(elsewhere.foreignPeople).toBe(before.foreignPeople + 1);
      expect(elsewhere.foreignEmployees).toBe(before.foreignEmployees + 1);

      // Assigned in a demo (HL-) organization: neither counts any more.
      await assign(`HL-GUARD-${suffix}`);
      const demo = await readDemoIdentity(tx);
      expect(demo.foreignPeople).toBe(before.foreignPeople);
      expect(demo.foreignEmployees).toBe(before.foreignEmployees);
    });
  });
});
