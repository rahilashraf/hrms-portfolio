import { config } from 'dotenv';
import { lastValueFrom, of } from 'rxjs';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '../src/audit/audit.service.js';
import { AuthorizationService } from '../src/authorization/authorization.service.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { OrganizationArchivePolicyService } from '../src/organization/organization-archive-policy.service.js';
import { OrganizationAuthorizationInterceptor } from '../src/organization/organization-authorization.interceptor.js';
import { OrganizationIntegrityService } from '../src/organization/organization-integrity.service.js';
import { OrganizationService } from '../src/organization/organization.service.js';
import {
  createSchedulingFixtures,
  ctx,
  rejection,
  rollbackClient,
  violation,
  type SchedulingFixtures,
  type Tx,
} from './support/scheduling-fixtures.js';

config({ path: '../../.env' });

class RollbackFixtures extends Error {}

const MANAGE = ['organization.read', 'organization.manage'] as const;

const USERS = {
  orgManager: [{ permissions: MANAGE, scope: 'org' as const }],
  unitManager: [{ permissions: MANAGE, scope: 'unitChild' as const }],
  deptManager: [{ permissions: MANAGE, scope: 'deptB' as const }],
  teamManager: [{ permissions: MANAGE, scope: 'teamA' as const }],
  reader: [{ permissions: ['organization.read'], scope: 'org' as const }],
  nobody: [],
  otherOrgManager: [{ permissions: MANAGE, scope: 'orgB' as const }],
};

type Status = { getStatus(): number };
const status = (error: unknown) => (error as Status).getStatus();

/**
 * R5B: Unit, Department and Team managers may create Positions but could not list the
 * organization-level Job Titles and Work Locations a Position needs. The reference-options route
 * offers the active ones (id/name/code only) to anyone with organization.manage within the
 * Organization, and grants nothing else.
 */
describe('Position reference options (database)', () => {
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
      interceptor: OrganizationAuthorizationInterceptor;
      jobTitleId: string;
      archivedJobTitleId: string;
      archivedWorkLocationId: string;
    }) => Promise<void>,
  ) {
    await expect(
      prisma.$transaction(
        async (tx) => {
          const fx = await createSchedulingFixtures(tx, USERS);
          const client = rollbackClient(tx);
          const authorization = new AuthorizationService(client);
          const service = new OrganizationService(
            client,
            new AuditService(client),
            new OrganizationIntegrityService(client),
            new OrganizationArchivePolicyService(),
            authorization,
          );
          const interceptor = new OrganizationAuthorizationInterceptor(
            client,
            authorization,
          );
          const jobTitle = await tx.jobTitle.findFirstOrThrow({
            where: { organizationId: fx.orgA },
          });
          const archivedJobTitle = await tx.jobTitle.create({
            data: {
              organizationId: fx.orgA,
              name: 'Archived title',
              code: `AJ${fx.suffix}`,
              archivedAt: new Date(),
            },
          });
          const archivedWorkLocation = await tx.workLocation.create({
            data: {
              organizationId: fx.orgA,
              name: 'Archived location',
              code: `AW${fx.suffix}`,
              archivedAt: new Date(),
            },
          });
          await tx.jobTitle.create({
            data: {
              organizationId: fx.orgB,
              name: 'Other organization title',
              code: `OB${fx.suffix}`,
            },
          });
          await run({
            tx,
            fx,
            service,
            interceptor,
            jobTitleId: jobTitle.id,
            archivedJobTitleId: archivedJobTitle.id,
            archivedWorkLocationId: archivedWorkLocation.id,
          }).catch((error: unknown) => {
            console.error('SCENARIO FAILURE', error);
            throw error;
          });
          throw new RollbackFixtures();
        },
        { timeout: 60_000 },
      ),
    ).rejects.toBeInstanceOf(RollbackFixtures);
  }

  it('offers active references of the organization to managers at every scope', async () => {
    await scenario(
      async ({
        fx,
        service,
        jobTitleId,
        archivedJobTitleId,
        archivedWorkLocationId,
      }) => {
        for (const label of [
          'orgManager',
          'unitManager',
          'deptManager',
          'teamManager',
        ]) {
          const options = await service.listPositionReferenceOptions(
            fx.orgA,
            fx.users[label],
          );
          expect(Object.keys(options).sort()).toEqual([
            'jobTitles',
            'workLocations',
          ]);
          for (const row of [...options.jobTitles, ...options.workLocations])
            expect(Object.keys(row).sort()).toEqual(['code', 'id', 'name']);
          expect(options.jobTitles.map((row) => row.id)).toEqual([jobTitleId]);
          // Ottawa before Toronto: sorted by name, then code.
          expect(options.workLocations.map((row) => row.id)).toEqual([
            fx.workLocationOttawa,
            fx.workLocationToronto,
          ]);
          expect(options.jobTitles.map((row) => row.id)).not.toContain(
            archivedJobTitleId,
          );
          expect(options.workLocations.map((row) => row.id)).not.toContain(
            archivedWorkLocationId,
          );
        }
      },
    );
  });

  it('refuses readers (403), callers without grants and other organizations (404)', async () => {
    await scenario(async ({ tx, fx, service }) => {
      const reader = await rejection(
        service.listPositionReferenceOptions(fx.orgA, fx.users.reader),
      );
      expect(status(reader)).toBe(403);
      for (const label of ['nobody', 'otherOrgManager']) {
        const refused = await rejection(
          service.listPositionReferenceOptions(fx.orgA, fx.users[label]),
        );
        expect(status(refused)).toBe(404);
      }
      // The other organization's manager is served in their own organization only.
      const own = await service.listPositionReferenceOptions(
        fx.orgB,
        fx.users.otherOrgManager,
      );
      expect(own.jobTitles.map((row) => row.name)).toEqual([
        'Other organization title',
      ]);
      // Unknown and archived organizations answer 404, even to the organization manager.
      const unknown = await rejection(
        service.listPositionReferenceOptions(
          '00000000-0000-4000-8000-00000000dead',
          fx.users.orgManager,
        ),
      );
      expect(status(unknown)).toBe(404);
      await tx.organization.update({
        where: { id: fx.orgA },
        data: { archivedAt: new Date() },
      });
      const archived = await rejection(
        service.listPositionReferenceOptions(fx.orgA, fx.users.orgManager),
      );
      expect(status(archived)).toBe(404);
    });
  });

  // Only effective grants count: an expired or revoked organization.manage grant opens nothing.
  // (Role-assignment history is immutable, so the expired grant is created already expired and
  // the revocation is one-way.)
  it('refuses a manager whose only grant has expired or been revoked (404)', async () => {
    await scenario(async ({ tx, fx, service }) => {
      const managerGrants = await tx.roleAssignment.findMany({
        where: { userId: fx.users.deptManager, revokedAt: null },
      });
      expect(managerGrants.length).toBeGreaterThan(0);
      // Expired: the same department grants, for a user who holds nothing else, ended a day ago.
      const dayAgo = new Date(Date.now() - 86_400_000);
      for (const grant of managerGrants) {
        await tx.roleAssignment.create({
          data: {
            userId: fx.users.nobody,
            roleId: grant.roleId,
            roleOrganizationId: grant.roleOrganizationId,
            scopeType: grant.scopeType,
            organizationId: grant.organizationId,
            organizationalUnitId: grant.organizationalUnitId,
            departmentId: grant.departmentId,
            teamId: grant.teamId,
            startsAt: new Date(dayAgo.getTime() - 86_400_000),
            expiresAt: dayAgo,
          },
        });
      }
      expect(
        status(
          await rejection(
            service.listPositionReferenceOptions(fx.orgA, fx.users.nobody),
          ),
        ),
      ).toBe(404);
      // Revoked: the department manager is served, then refused once the grants are revoked.
      await expect(
        service.listPositionReferenceOptions(fx.orgA, fx.users.deptManager),
      ).resolves.toMatchObject({ jobTitles: expect.any(Array) });
      await tx.roleAssignment.updateMany({
        where: { userId: fx.users.deptManager, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      expect(
        status(
          await rejection(
            service.listPositionReferenceOptions(fx.orgA, fx.users.deptManager),
          ),
        ),
      ).toBe(404);
    });
  });

  it('lets a department manager create a Position with listed references, only in scope', async () => {
    await scenario(async ({ tx, fx, service }) => {
      const manager = fx.users.deptManager!;
      const options = await service.listPositionReferenceOptions(
        fx.orgA,
        manager,
      );
      const created = await service.createPosition(
        fx.orgA,
        {
          name: 'Dept B Analyst',
          code: `PB${fx.suffix}`,
          jobTitleId: options.jobTitles[0]!.id,
          workLocationId: options.workLocations[0]!.id,
          departmentId: fx.deptB,
        },
        ctx(manager),
      );
      expect(created).toMatchObject({
        departmentId: fx.deptB,
        jobTitleId: options.jobTitles[0]!.id,
        workLocationId: options.workLocations[0]!.id,
      });

      for (const placement of [
        { departmentId: fx.deptA },
        { teamId: fx.teamA },
        {},
      ]) {
        const refused = await violation(tx, () =>
          service.createPosition(
            fx.orgA,
            {
              name: 'Outside',
              code: `PX${fx.suffix}`,
              jobTitleId: options.jobTitles[0]!.id,
              ...placement,
            },
            ctx(manager),
          ),
        );
        expect(status(refused)).toBe(403);
      }
    });
  });

  it('grants nothing else: Job Titles and Work Locations stay organization-level', async () => {
    await scenario(
      async ({
        tx,
        fx,
        service,
        interceptor,
        jobTitleId,
        archivedJobTitleId,
        archivedWorkLocationId,
      }) => {
        for (const label of ['unitManager', 'deptManager', 'teamManager']) {
          const actor = ctx(fx.users[label]!);
          const attempts: Array<() => Promise<unknown>> = [
            () =>
              service.createJobTitle(
                fx.orgA,
                { name: 'New', code: `NJ${fx.suffix}` },
                actor,
              ),
            () =>
              service.updateJobTitle(
                fx.orgA,
                jobTitleId,
                { name: 'Renamed' },
                actor,
              ),
            () => service.archiveJobTitle(fx.orgA, jobTitleId, actor),
            () =>
              service.reactivateJobTitle(fx.orgA, archivedJobTitleId, actor),
            () =>
              service.createWorkLocation(
                fx.orgA,
                { name: 'New', code: `NW${fx.suffix}` },
                actor,
              ),
            () =>
              service.updateWorkLocation(
                fx.orgA,
                fx.workLocationOttawa,
                { name: 'Renamed' },
                actor,
              ),
            () =>
              service.archiveWorkLocation(
                fx.orgA,
                fx.workLocationOttawa,
                actor,
              ),
            () =>
              service.reactivateWorkLocation(
                fx.orgA,
                archivedWorkLocationId,
                actor,
              ),
          ];
          for (const attempt of attempts) {
            expect(status(await violation(tx, attempt))).toBe(403);
          }

          // The organization-level lists stay empty for them (filtered by organization.read).
          for (const [handler, list] of [
            ['listJobTitles', () => service.listJobTitles(fx.orgA)],
            ['listWorkLocations', () => service.listWorkLocations(fx.orgA)],
          ] as const) {
            const context = {
              getHandler: () => ({ name: handler }),
              switchToHttp: () => ({
                getRequest: () => ({
                  auth: { userId: fx.users[label], sessionId: 's' },
                  params: { organizationId: fx.orgA },
                  body: {},
                }),
              }),
            } as unknown as ExecutionContext;
            const next: CallHandler = { handle: () => of(null) };
            const rows = await list();
            next.handle = () => of(rows);
            expect(rows.length).toBeGreaterThan(0);
            await expect(
              lastValueFrom(interceptor.intercept(context, next)),
            ).resolves.toEqual([]);
          }
        }
      },
    );
  });

  it('edits a staffed Position only when identity fields are left out', async () => {
    await scenario(async ({ tx, fx, service, jobTitleId }) => {
      const otherTitle = await tx.jobTitle.create({
        data: {
          organizationId: fx.orgA,
          name: 'Senior',
          code: `SJ${fx.suffix}`,
        },
      });
      for (const label of ['orgManager', 'deptManager']) {
        const updated = await service.updatePosition(
          fx.orgA,
          fx.positionDeptB,
          { name: `Renamed by ${label}`, description: 'Updated' },
          ctx(fx.users[label]!),
        );
        expect(updated).toMatchObject({
          name: `Renamed by ${label}`,
          description: 'Updated',
          jobTitleId,
        });
      }
      // The existing protection: a changed identity is refused once history exists...
      const changed = await violation(tx, () =>
        service.updatePosition(
          fx.orgA,
          fx.positionDeptB,
          { jobTitleId: otherTitle.id },
          ctx(fx.users.orgManager!),
        ),
      );
      expect(status(changed)).toBe(400);
      // ...and so is resending the unchanged value or a null work location: clients must omit
      // identity fields they did not change.
      for (const body of [
        { name: 'Again', jobTitleId },
        { name: 'Again', workLocationId: null },
      ]) {
        const resent = await violation(tx, () =>
          service.updatePosition(
            fx.orgA,
            fx.positionDeptB,
            body,
            ctx(fx.users.orgManager!),
          ),
        );
        expect(status(resent)).toBe(400);
      }
    });
  });
});
