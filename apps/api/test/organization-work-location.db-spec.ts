import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '../src/audit/audit.service.js';
import { AuthorizationService } from '../src/authorization/authorization.service.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { OrganizationArchivePolicyService } from '../src/organization/organization-archive-policy.service.js';
import { OrganizationIntegrityService } from '../src/organization/organization-integrity.service.js';
import { OrganizationService } from '../src/organization/organization.service.js';
import {
  createSchedulingFixtures,
  ctx,
  rejection,
  rollbackClient,
  type SchedulingFixtures,
  type Tx,
} from './support/scheduling-fixtures.js';

config({ path: '../../.env' });

class RollbackFixtures extends Error {}

const USERS = {
  structureAdmin: [
    {
      permissions: ['organization.read', 'organization.manage'],
      scope: 'org' as const,
    },
  ],
  structureReader: [
    { permissions: ['organization.read'], scope: 'org' as const },
  ],
};

/**
 * Batch 1 (BR-3): a work location's physical site groups its attendance devices. Editing the
 * location's details must keep the site; only an explicit choice moves it or creates a new one.
 */
describe('Work locations and their physical sites (database)', () => {
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
      service: OrganizationService;
      deviceId: string;
    }) => Promise<void>,
  ) {
    await expect(
      prisma.$transaction(
        async (tx) => {
          const fx = await createSchedulingFixtures(tx, USERS);
          const client = rollbackClient(tx);
          const service = new OrganizationService(
            client,
            new AuditService(client),
            new OrganizationIntegrityService(client),
            new OrganizationArchivePolicyService(),
            new AuthorizationService(client),
          );
          const device = await tx.attendanceDevice.create({
            data: {
              organizationId: fx.orgA,
              physicalSiteId: fx.physicalSiteToronto,
              name: 'Front desk',
              credentialHash: `hash-front-desk-${fx.suffix}`,
              credentialIssuedAt: new Date(),
            },
          });
          await run({ tx, fx, service, deviceId: device.id }).catch(
            (error: unknown) => {
              console.error('SCENARIO FAILURE', error);
              throw error;
            },
          );
          throw new RollbackFixtures();
        },
        { timeout: 60_000 },
      ),
    ).rejects.toBeInstanceOf(RollbackFixtures);
  }

  it('keeps the physical site and its devices when other details change', async () => {
    await scenario(async ({ tx, fx, service, deviceId }) => {
      const sites = await tx.physicalSite.count({
        where: { organizationId: fx.orgA },
      });
      await service.updateWorkLocation(
        fx.orgA,
        fx.workLocationToronto,
        { city: 'Toronto', addressLine1: '1 Front St' },
        ctx(fx.users.structureAdmin!),
      );
      // The same choice sent back explicitly (what the edit form now submits) is a no-op too.
      await service.updateWorkLocation(
        fx.orgA,
        fx.workLocationToronto,
        { physicalSiteId: fx.physicalSiteToronto, postalCode: 'M5J 2N1' },
        ctx(fx.users.structureAdmin!),
      );
      const location = await tx.workLocation.findUniqueOrThrow({
        where: { id: fx.workLocationToronto },
      });
      expect(location).toMatchObject({
        physicalSiteId: fx.physicalSiteToronto,
        city: 'Toronto',
        postalCode: 'M5J 2N1',
      });
      expect(
        await tx.physicalSite.count({ where: { organizationId: fx.orgA } }),
      ).toBe(sites);
      expect(
        (
          await tx.attendanceDevice.findUniqueOrThrow({
            where: { id: deviceId },
          })
        ).physicalSiteId,
      ).toBe(fx.physicalSiteToronto);
    });
  });

  it('moves to another site or a new one only when asked, and only for managers', async () => {
    await scenario(async ({ tx, fx, service }) => {
      const refused = await rejection(
        service.updateWorkLocation(
          fx.orgA,
          fx.workLocationToronto,
          { physicalSiteId: fx.physicalSiteOttawa },
          ctx(fx.users.structureReader!),
        ),
      );
      expect((refused as { getStatus(): number }).getStatus()).toBe(403);

      await service.updateWorkLocation(
        fx.orgA,
        fx.workLocationToronto,
        { physicalSiteId: fx.physicalSiteOttawa },
        ctx(fx.users.structureAdmin!),
      );
      expect(
        (
          await tx.workLocation.findUniqueOrThrow({
            where: { id: fx.workLocationToronto },
          })
        ).physicalSiteId,
      ).toBe(fx.physicalSiteOttawa);

      // Batch 5B (D12): null alone keeps the current site (nothing is created silently).
      await service.updateWorkLocation(
        fx.orgA,
        fx.workLocationToronto,
        { physicalSiteId: null },
        ctx(fx.users.structureAdmin!),
      );
      expect(
        (
          await tx.workLocation.findUniqueOrThrow({
            where: { id: fx.workLocationToronto },
          })
        ).physicalSiteId,
      ).toBe(fx.physicalSiteOttawa);
      // A matching site is created only on explicit request, and audited.
      await service.updateWorkLocation(
        fx.orgA,
        fx.workLocationToronto,
        { createPhysicalSite: true },
        ctx(fx.users.structureAdmin!),
      );
      const moved = await tx.workLocation.findUniqueOrThrow({
        where: { id: fx.workLocationToronto },
        include: { physicalSite: true },
      });
      expect([fx.physicalSiteToronto, fx.physicalSiteOttawa]).not.toContain(
        moved.physicalSiteId,
      );
      expect(
        await tx.auditLog.count({
          where: {
            action: 'PHYSICAL_SITE_CREATED',
            entityId: moved.physicalSiteId!,
          },
        }),
      ).toBe(1);
      expect(moved.physicalSite?.organizationId).toBe(fx.orgA);
    });
  });
});
