import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUDIT_ORGANIZATION_RESOLVERS } from '../src/audit/audit-organization.js';
import { AuditService } from '../src/audit/audit.service.js';
import { PrismaService } from '../src/database/prisma.service.js';
import type { Prisma } from '../src/generated/prisma/client.js';
import {
  createSchedulingFixtures,
  rollbackClient,
  type SchedulingFixtures,
  type Tx,
} from './support/scheduling-fixtures.js';

config({ path: '../../.env' });

class RollbackFixtures extends Error {}

/**
 * Phase 19: audit entries of the earlier modules are tagged with their organization
 * (metadata.organizationId) when their writer did not set it, so the audit viewer and audit
 * retention see them. Every resolver's SQL runs against the real schema.
 */
describe('Audit organization tagging (database)', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService(process.env.DATABASE_URL!);
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  async function scenario(
    run: (tx: Tx, fx: SchedulingFixtures, audit: AuditService) => Promise<void>,
  ) {
    await expect(
      prisma.$transaction(
        async (tx) => {
          const fx = await createSchedulingFixtures(tx, {});
          await run(tx, fx, new AuditService(rollbackClient(tx)));
          throw new RollbackFixtures();
        },
        { timeout: 60_000 },
      ),
    ).rejects.toBeInstanceOf(RollbackFixtures);
  }

  it('runs every resolver against the schema (unknown ids resolve to nothing)', async () => {
    await scenario(async (tx) => {
      for (const [entityType, resolver] of Object.entries(
        AUDIT_ORGANIZATION_RESOLVERS,
      )) {
        const rows = await tx.$queryRaw<unknown[]>(resolver(randomUUID()));
        expect(rows, entityType).toEqual([]);
      }
    });
  });

  it('tags untagged entries from the audited row, inside the writer transaction', async () => {
    await scenario(async (tx, fx, audit) => {
      const write = (
        entityType: string,
        entityId: string,
        metadata?: Prisma.InputJsonObject,
      ) =>
        audit.write(
          { action: 'PHASE19_TAG_CHECK', entityType, entityId, metadata },
          tx,
        );
      expect(
        (await write('Position', fx.positionTeamA, { a: 1 })).metadata,
      ).toEqual({
        a: 1,
        organizationId: fx.orgA,
      });
      expect(
        (await write('EmploymentAssignment', fx.assignmentDeptB)).metadata,
      ).toEqual({ organizationId: fx.orgA });
      expect((await write('Organization', fx.orgB)).metadata).toEqual({
        organizationId: fx.orgB,
      });
      expect((await write('Department', fx.deptB)).metadata).toEqual({
        organizationId: fx.orgA,
      });
      // A writer's own organizationId is never replaced; unknown types and non-ids are left.
      expect(
        (await write('Position', fx.positionTeamA, { organizationId: fx.orgB }))
          .metadata,
      ).toEqual({ organizationId: fx.orgB });
      // Batch 2: an entry about an account carries its organizations (employee 1 works in A;
      // see audit-account-visibility.db-spec.ts); a type without a resolver stays untagged.
      expect((await write('User', fx.selfUser1)).metadata).toEqual({
        organizationId: fx.orgA,
      });
      expect((await write('Permission', randomUUID())).metadata).toBeNull();
      expect((await write('Position', 'not-a-uuid')).metadata).toBeNull();
      expect((await write('Position', randomUUID())).metadata).toBeNull();
    });
  });
});
