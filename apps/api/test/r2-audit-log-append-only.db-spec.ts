import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service.js';
import { AuditService } from '../src/audit/audit.service.js';
import { violation, type Tx } from './support/scheduling-fixtures.js';

config({ path: '../../.env', quiet: true });

class Rollback extends Error {}

/** The database's message of a refused write (trigger texts included). */
function dbMessage(error: unknown): string {
  const e = error as {
    message?: string;
    meta?: { driverAdapterError?: { message?: string; cause?: unknown } };
  };
  return [
    e?.message,
    e?.meta?.driverAdapterError?.message,
    JSON.stringify(e?.meta?.driverAdapterError?.cause ?? null),
  ].join(' ');
}

const monthsAgo = (months: number) => {
  const date = new Date();
  date.setUTCMonth(date.getUTCMonth() - months);
  return date;
};

/**
 * Batch R2.1: the audit log is append-only in the database (migration
 * 20271201090000_r2_audit_log_append_only). Every scenario runs in a transaction that is rolled
 * back at the end, so nothing is left behind and no historical entry is touched.
 */
describe('Audit log append-only guard (database)', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService(process.env.DATABASE_URL!);
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  async function scenario(run: (tx: Tx) => Promise<void>) {
    await expect(
      prisma.$transaction(
        async (tx) => {
          await run(tx as Tx);
          throw new Rollback();
        },
        { timeout: 60_000 },
      ),
    ).rejects.toBeInstanceOf(Rollback);
  }

  async function organization(tx: Tx, auditLogMonths?: number) {
    const suffix = randomUUID().slice(0, 8).toUpperCase();
    const org = await tx.organization.create({
      data: { name: `R2 audit ${suffix}`, code: `R2A-${suffix}` },
    });
    if (auditLogMonths !== undefined) {
      await tx.organizationSetting.create({
        data: {
          organizationId: org.id,
          key: 'retention.auditLogMonths',
          value: auditLogMonths,
          schemaVersion: 1,
        },
      });
    }
    return org.id;
  }

  async function entry(
    tx: Tx,
    organizationId: string,
    occurredAt = new Date(),
  ) {
    const row = await tx.auditLog.create({
      data: {
        action: 'R2_AUDIT_TEST',
        entityType: 'Organization',
        entityId: organizationId,
        metadata: { organizationId },
        occurredAt,
      },
    });
    return row;
  }

  it('accepts new entries through the application audit service and directly', async () => {
    await scenario(async (tx) => {
      const org = await organization(tx);
      await new AuditService(tx as never).write({
        action: 'R2_AUDIT_SERVICE',
        entityType: 'Organization',
        entityId: org,
        metadata: { organizationId: org },
      });
      const direct = await entry(tx, org);
      const rows = await tx.auditLog.findMany({ where: { entityId: org } });
      expect(rows.map((row) => row.action).sort()).toEqual([
        'R2_AUDIT_SERVICE',
        'R2_AUDIT_TEST',
      ]);
      expect(direct.occurredAt).toBeInstanceOf(Date);
    });
  });

  it('refuses every UPDATE, through Prisma and raw SQL, and leaves the entry unchanged', async () => {
    await scenario(async (tx) => {
      const org = await organization(tx);
      const row = await entry(tx, org);
      for (const attempt of [
        () =>
          tx.auditLog.update({
            where: { id: row.id },
            data: { action: 'TAMPERED' },
          }),
        () =>
          tx.auditLog.updateMany({
            where: { id: row.id },
            data: { metadata: { organizationId: org, forged: true } },
          }),
        () =>
          tx.$executeRawUnsafe(
            `UPDATE "AuditLog" SET "occurredAt" = now() - interval '10 years' WHERE "id" = $1::uuid`,
            row.id,
          ),
      ]) {
        expect(dbMessage(await violation(tx, attempt))).toContain(
          'Audit log entries are append-only and cannot be changed.',
        );
      }
      const after = await tx.auditLog.findUniqueOrThrow({
        where: { id: row.id },
      });
      expect(after).toEqual(row);
    });
  });

  it('refuses DELETE outside a retention transaction, and TRUNCATE always', async () => {
    await scenario(async (tx) => {
      const org = await organization(tx, 24);
      const old = await entry(tx, org, monthsAgo(36));
      expect(
        dbMessage(
          await violation(tx, () =>
            tx.auditLog.delete({ where: { id: old.id } }),
          ),
        ),
      ).toContain('only the retention job may delete them');
      expect(
        dbMessage(
          await violation(tx, () =>
            tx.$executeRawUnsafe(
              `DELETE FROM "AuditLog" WHERE "id" = $1::uuid`,
              old.id,
            ),
          ),
        ),
      ).toContain('only the retention job may delete them');
      expect(
        dbMessage(
          await violation(tx, () =>
            tx.$executeRawUnsafe('TRUNCATE "AuditLog"'),
          ),
        ),
      ).toContain('cannot be truncated');
      await expect(
        tx.auditLog.findUnique({ where: { id: old.id } }),
      ).resolves.not.toBeNull();
    });
  });

  it('cannot be tricked by a look-alike retention function earlier in the search_path', async () => {
    await scenario(async (tx) => {
      const org = await organization(tx);
      const row = await entry(tx, org);
      const schema = `r2_spoof_${randomUUID().slice(0, 8)}`;
      await tx.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
      await tx.$executeRawUnsafe(
        `CREATE FUNCTION "${schema}".hrms_retention_active() RETURNS boolean LANGUAGE sql AS 'SELECT true'`,
      );
      await tx.$executeRawUnsafe(`SET LOCAL search_path = "${schema}", public`);
      expect(
        dbMessage(
          await violation(tx, () =>
            tx.$executeRawUnsafe(
              `DELETE FROM "AuditLog" WHERE "id" = $1::uuid`,
              row.id,
            ),
          ),
        ),
      ).toContain('only the retention job may delete them');
      await tx.$executeRawUnsafe('SET LOCAL search_path = public');
      await expect(
        tx.auditLog.findUnique({ where: { id: row.id } }),
      ).resolves.not.toBeNull();
    });
  });

  it('cannot skip the retention age check with a look-alike current_setting() ahead of pg_catalog', async () => {
    await scenario(async (tx) => {
      // The organization never opted in, so no entry of it may be purged.
      const org = await organization(tx);
      const old = await entry(tx, org, monthsAgo(36));
      const schema = `r2_spoof_${randomUUID().slice(0, 8)}`;
      await tx.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
      // Makes the retention trigger's WHEN (hrms_retention_active()) false if that function
      // resolved current_setting() through the caller's search_path.
      await tx.$executeRawUnsafe(
        `CREATE FUNCTION "${schema}".current_setting(text, boolean) RETURNS text LANGUAGE sql AS $$SELECT 'off'::text$$`,
      );
      await tx.$executeRaw`SELECT set_config('hrms.retention_purge', 'on', true)`;
      await tx.$executeRawUnsafe(
        `SET LOCAL search_path = "${schema}", pg_catalog, public`,
      );
      expect(
        dbMessage(
          await violation(tx, () =>
            tx.$executeRawUnsafe(
              `DELETE FROM public."AuditLog" WHERE "id" = $1::uuid`,
              old.id,
            ),
          ),
        ),
      ).toContain(
        'Retention purges only organization audit entries older than',
      );
      await tx.$executeRawUnsafe('SET LOCAL search_path = public');
      await tx.$executeRaw`SELECT set_config('hrms.retention_purge', 'off', true)`;
      await expect(
        tx.auditLog.findUnique({ where: { id: old.id } }),
      ).resolves.not.toBeNull();
    });
  });

  it('cannot be tricked by a temporary table shadowing the organization settings', async () => {
    await scenario(async (tx) => {
      // The organization never opted in to audit-log retention.
      const org = await organization(tx);
      const old = await entry(tx, org, monthsAgo(36));
      // A session-local table with the same name as the settings table, claiming it did.
      await tx.$executeRawUnsafe(
        `CREATE TEMP TABLE "OrganizationSetting" ON COMMIT DROP AS SELECT * FROM public."OrganizationSetting" WHERE false`,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO pg_temp."OrganizationSetting" ("id", "organizationId", "key", "value", "schemaVersion", "updatedAt")
         VALUES (gen_random_uuid(), $1::uuid, 'retention.auditLogMonths', '24'::jsonb, 1, now())`,
        org,
      );
      await tx.$executeRaw`SELECT set_config('hrms.retention_purge', 'on', true)`;
      expect(
        dbMessage(
          await violation(tx, () =>
            tx.$executeRawUnsafe(
              `DELETE FROM "AuditLog" WHERE "id" = $1::uuid`,
              old.id,
            ),
          ),
        ),
      ).toContain(
        'Retention purges only organization audit entries older than',
      );
      await tx.$executeRaw`SELECT set_config('hrms.retention_purge', 'off', true)`;
      await expect(
        tx.auditLog.findUnique({ where: { id: old.id } }),
      ).resolves.not.toBeNull();
    });
  });

  it('keeps the actor: deleting a user who appears in the audit log is refused', async () => {
    await scenario(async (tx) => {
      const org = await organization(tx);
      const person = await tx.person.create({ data: {} });
      const user = await tx.user.create({
        data: {
          personId: person.id,
          email: `r2-audit-${randomUUID().slice(0, 8)}@example.invalid`,
          status: 'ACTIVE',
        },
      });
      const row = await tx.auditLog.create({
        data: {
          actorUserId: user.id,
          action: 'R2_AUDIT_ACTOR',
          metadata: { organizationId: org },
        },
      });
      // ON DELETE SET NULL would rewrite the entry's actor: the guard refuses that UPDATE.
      expect(
        dbMessage(
          await violation(tx, () => tx.user.delete({ where: { id: user.id } })),
        ),
      ).toContain('cannot be changed');
      const after = await tx.auditLog.findUniqueOrThrow({
        where: { id: row.id },
      });
      expect(after.actorUserId).toBe(user.id);
    });
  });

  it('retention still deletes eligible entries and still refuses ineligible ones', async () => {
    await scenario(async (tx) => {
      const org = await organization(tx, 24);
      const eligible = await entry(tx, org, monthsAgo(36));
      const recent = await entry(tx, org, monthsAgo(1));
      const unconfigured = await entry(
        tx,
        await organization(tx),
        monthsAgo(36),
      );
      await tx.$executeRaw`SELECT set_config('hrms.retention_purge', 'on', true)`;

      await tx.$executeRawUnsafe(
        `DELETE FROM "AuditLog" WHERE "id" = $1::uuid`,
        eligible.id,
      );
      await expect(
        tx.auditLog.findUnique({ where: { id: eligible.id } }),
      ).resolves.toBeNull();

      for (const id of [recent.id, unconfigured.id]) {
        expect(
          dbMessage(
            await violation(tx, () =>
              tx.$executeRawUnsafe(
                `DELETE FROM "AuditLog" WHERE "id" = $1::uuid`,
                id,
              ),
            ),
          ),
        ).toContain(
          'Retention purges only organization audit entries older than',
        );
      }
      // Even inside a retention transaction an entry can never be changed.
      expect(
        dbMessage(
          await violation(tx, () =>
            tx.auditLog.update({
              where: { id: recent.id },
              data: { action: 'TAMPERED' },
            }),
          ),
        ),
      ).toContain('cannot be changed');
      await tx.$executeRaw`SELECT set_config('hrms.retention_purge', 'off', true)`;
    });
  });
});
