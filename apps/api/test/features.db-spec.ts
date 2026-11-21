import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service.js';
import type { FeatureModule } from '../src/features/features-domain.js';
import {
  FEATURE_USERS,
  featureServices,
  refusal,
  setModule,
  type FeatureServices,
} from './support/features-fixtures.js';
import { failure } from './support/performance-fixtures.js';
import {
  cleanupSchedulingFixtures,
  createSchedulingFixtures,
  ctx,
  rollbackClient,
  violation,
  type SchedulingFixtures,
  type Tx,
} from './support/scheduling-fixtures.js';

config({ path: '../../.env' });

class RollbackFixtures extends Error {}

describe('Feature management (database)', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService(process.env.DATABASE_URL!);
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  async function scenario(
    run: (
      tx: Tx,
      fx: SchedulingFixtures,
      svc: FeatureServices,
    ) => Promise<void>,
  ) {
    await expect(
      prisma.$transaction(
        async (tx) => {
          const fx = await createSchedulingFixtures(tx, FEATURE_USERS);
          const svc = featureServices(rollbackClient(tx));
          await run(tx, fx, svc).catch((error: unknown) => {
            console.error('SCENARIO FAILURE', error);
            throw error;
          });
          throw new RollbackFixtures();
        },
        { timeout: 120_000 },
      ),
    ).rejects.toBeInstanceOf(RollbackFixtures);
  }

  it('keeps existing organizations on their current behaviour: no rows, every module on, defaults', async () => {
    await scenario(async (tx, fx, svc) => {
      expect(
        await tx.organizationModuleSetting.count({
          where: { organizationId: { in: [fx.orgA, fx.orgB] } },
        }),
      ).toBe(0);
      const overview = await svc.features.overview(
        fx.users.featureReader!,
        fx.orgA,
      );
      expect(overview.organization.id).toBe(fx.orgA);
      expect(overview.canManage).toBe(false);
      expect(overview.modules).toHaveLength(13);
      for (const module of overview.modules) {
        expect(module).toMatchObject({
          enabled: true,
          isDefault: true,
          version: 0,
          updatedAt: null,
        });
      }
      expect(
        overview.modules.find((m) => m.module === 'PAYROLL'),
      ).toMatchObject({
        requires: ['COMPENSATION', 'ATTENDANCE'],
        dependents: [],
      });
      expect(
        overview.modules.find((m) => m.module === 'COMPENSATION'),
      ).toMatchObject({ requires: [], dependents: ['PAYROLL'] });
      for (const setting of overview.settings) {
        // Phase 19 retention periods are integers that default to 0 (off).
        const retention = setting.key.startsWith('retention.');
        expect(setting).toMatchObject({
          value: retention ? 0 : true,
          default: retention ? 0 : true,
          isDefault: true,
          version: 0,
          type: { kind: retention ? 'integer' : 'boolean' },
        });
      }
      expect(overview.core).toContain('Employees');
      // Linked sections are read with the caller's own permissions only.
      expect(overview.linked.timeAttendance).toEqual({
        available: false,
        reason: 'FORBIDDEN',
      });
      expect(overview.linked.notifications).toEqual({
        available: false,
        reason: 'FORBIDDEN',
      });
      expect(overview.linked.googleWorkspace).toEqual({
        available: false,
        reason: 'UNAVAILABLE',
      });
      for (const module of [
        'PAYROLL',
        'DOCUMENTS',
        'ATTENDANCE',
      ] as FeatureModule[]) {
        expect(await svc.gate.isEnabled(fx.orgA, module)).toBe(true);
        await svc.gate.require(fx.orgA, module);
      }
      expect(
        await svc.gate.setting(fx.orgA, 'documents.selfServiceProvide'),
      ).toBe(true);
      expect(await svc.gate.disabledOrganizations('PAYROLL')).not.toContain(
        fx.orgA,
      );
    });
  });

  it('requires feature.read / feature.manage at the organization itself, and never crosses organizations', async () => {
    await scenario(async (tx, fx, svc) => {
      // Organization pickers list only organizations with a feature grant.
      expect(
        (await svc.features.organizations(fx.users.featureAdmin!)).items,
      ).toEqual([
        expect.objectContaining({
          id: fx.orgA,
          actions: { canRead: true, canManage: true },
        }),
      ]);
      expect(
        (await svc.features.organizations(fx.users.featureReader!)).items,
      ).toEqual([
        expect.objectContaining({
          id: fx.orgA,
          actions: { canRead: true, canManage: false },
        }),
      ]);
      expect((await svc.features.organizations(fx.users.hr!)).items).toEqual(
        [],
      );
      expect(
        (await svc.features.organizations(fx.users.teamFeature!)).items,
      ).toEqual([]);

      // Domain permissions never grant feature access; team scope never does.
      for (const user of ['hr', 'teamFeature', 'featureB', 'self1']) {
        expect(
          await failure(svc.features.overview(fx.users[user]!, fx.orgA)),
        ).toMatchObject({ status: 403 });
        expect(
          await failure(
            svc.features.setModule(
              {
                organizationId: fx.orgA,
                module: 'PAYROLL',
                enabled: false,
                expectedVersion: 0,
              },
              ctx(fx.users[user]!),
            ),
          ),
        ).toMatchObject({ status: 403 });
      }
      // feature.read reads but never writes.
      expect(
        await failure(
          svc.features.setSetting(
            {
              organizationId: fx.orgA,
              key: 'documents.selfServiceProvide',
              value: false,
              expectedVersion: 0,
            },
            ctx(fx.users.featureReader!),
          ),
        ),
      ).toMatchObject({ status: 403 });
      expect(
        await failure(svc.features.history(fx.users.featureB!, fx.orgA)),
      ).toMatchObject({ status: 403 });
      // An unknown organization is not revealed to an organization-scoped admin.
      expect(
        await failure(
          svc.features.overview(
            fx.users.featureAdmin!,
            '00000000-0000-4000-8000-00000000abcd',
          ),
        ),
      ).toMatchObject({ status: 403 });

      // Org B's admin changes only Org B.
      await setModule(svc, fx, 'BENEFITS', false, fx.orgB);
      expect(await svc.gate.isEnabled(fx.orgB, 'BENEFITS')).toBe(false);
      expect(await svc.gate.isEnabled(fx.orgA, 'BENEFITS')).toBe(true);
      void tx;
    });
  });

  it('changes modules with dependency rules, audit and history; disabling keeps data and re-enabling restores', async () => {
    await scenario(async (tx, fx, svc) => {
      const admin = ctx(fx.users.featureAdmin!);
      // COMPENSATION (and ATTENDANCE) cannot be disabled while PAYROLL depends on them.
      expect(
        await refusal(
          svc.features.setModule(
            {
              organizationId: fx.orgA,
              module: 'COMPENSATION',
              enabled: false,
              expectedVersion: 0,
            },
            admin,
          ),
        ),
      ).toMatchObject({ status: 409, code: 'FEATURE_DEPENDENTS_ENABLED' });
      const dependents = await svc.features
        .setModule(
          {
            organizationId: fx.orgA,
            module: 'ATTENDANCE',
            enabled: false,
            expectedVersion: 0,
          },
          admin,
        )
        .catch((error: { getResponse(): unknown }) => error.getResponse());
      expect(dependents).toMatchObject({
        code: 'FEATURE_DEPENDENTS_ENABLED',
        module: 'ATTENDANCE',
        dependents: ['PAYROLL'],
      });
      // Nothing was written by the refusals.
      expect(
        await tx.organizationModuleSetting.count({
          where: { organizationId: fx.orgA },
        }),
      ).toBe(0);

      const payroll = await svc.features.setModule(
        {
          organizationId: fx.orgA,
          module: 'PAYROLL',
          enabled: false,
          expectedVersion: 0,
        },
        admin,
      );
      expect(payroll.module).toMatchObject({
        module: 'PAYROLL',
        enabled: false,
        isDefault: false,
        version: 1,
        updatedByUserId: fx.users.featureAdmin,
      });
      const compensation = await setModule(svc, fx, 'COMPENSATION', false);
      expect(compensation.module).toMatchObject({ enabled: false, version: 1 });
      // PAYROLL cannot come back before its requirements.
      const blocked = await svc.features
        .setModule(
          {
            organizationId: fx.orgA,
            module: 'PAYROLL',
            enabled: true,
            expectedVersion: 1,
          },
          admin,
        )
        .catch((error: { getResponse(): unknown }) => error.getResponse());
      expect(blocked).toMatchObject({
        statusCode: 409,
        code: 'FEATURE_DEPENDENCY_DISABLED',
        module: 'PAYROLL',
        requires: ['COMPENSATION'],
      });
      const overview = await svc.features.overview(
        fx.users.featureAdmin!,
        fx.orgA,
      );
      expect(
        overview.modules.find((m) => m.module === 'PAYROLL'),
      ).toMatchObject({ enabled: false, blockedBy: ['COMPENSATION'] });

      // Unknown modules are refused.
      expect(
        await refusal(
          svc.features.setModule(
            {
              organizationId: fx.orgA,
              module: 'EMPLOYEES',
              enabled: false,
              expectedVersion: 0,
            },
            admin,
          ),
        ),
      ).toEqual({ status: 404, code: 'FEATURE_MODULE_UNKNOWN' });

      // Re-enable in dependency order.
      await setModule(svc, fx, 'COMPENSATION', true);
      const back = await setModule(svc, fx, 'PAYROLL', true);
      expect(back.module).toMatchObject({ enabled: true, version: 2 });
      expect(await svc.gate.isEnabled(fx.orgA, 'PAYROLL')).toBe(true);

      // Audit: identifiers and old → new values only.
      const audits = await tx.auditLog.findMany({
        where: {
          entityType: 'Organization',
          entityId: fx.orgA,
          action: 'ORGANIZATION_MODULE_UPDATED',
        },
        orderBy: { occurredAt: 'asc' },
      });
      expect(audits.map((a) => a.metadata)).toEqual([
        {
          organizationId: fx.orgA,
          version: 1,
          module: 'PAYROLL',
          enabled: false,
          previous: true,
        },
        {
          organizationId: fx.orgA,
          version: 1,
          module: 'COMPENSATION',
          enabled: false,
          previous: true,
        },
        {
          organizationId: fx.orgA,
          version: 2,
          module: 'COMPENSATION',
          enabled: true,
          previous: false,
        },
        {
          organizationId: fx.orgA,
          version: 2,
          module: 'PAYROLL',
          enabled: true,
          previous: false,
        },
      ]);
      expect(audits.every((a) => a.actorUserId === fx.users.featureAdmin)).toBe(
        true,
      );
      expect(audits[0]!.correlationId).toBe('phase7-db-spec');

      // History (newest first), append-only.
      const history = await svc.features.history(
        fx.users.featureReader!,
        fx.orgA,
      );
      expect(
        history.items.map((h) => [
          h.kind,
          h.subject,
          h.oldValue,
          h.newValue,
          h.version,
        ]),
      ).toEqual([
        ['MODULE', 'PAYROLL', false, true, 2],
        ['MODULE', 'COMPENSATION', false, true, 2],
        ['MODULE', 'COMPENSATION', true, false, 1],
        ['MODULE', 'PAYROLL', true, false, 1],
      ]);
      const first = await tx.organizationSettingChange.findFirstOrThrow({
        where: { organizationId: fx.orgA },
      });
      expect(
        await violation(tx, () =>
          tx.organizationSettingChange.update({
            where: { id: first.id },
            data: { newValue: false },
          }),
        ),
      ).toBeTruthy();
      expect(
        await violation(tx, () =>
          tx.organizationSettingChange.delete({ where: { id: first.id } }),
        ),
      ).toBeTruthy();
      // Module rows are never deleted and versions only move forward by one.
      const row = await tx.organizationModuleSetting.findFirstOrThrow({
        where: { organizationId: fx.orgA, module: 'PAYROLL' },
      });
      expect(
        await violation(tx, () =>
          tx.organizationModuleSetting.delete({ where: { id: row.id } }),
        ),
      ).toBeTruthy();
      expect(
        await violation(tx, () =>
          tx.organizationModuleSetting.update({
            where: { id: row.id },
            data: { enabled: false },
          }),
        ),
      ).toBeTruthy();
      expect(
        await violation(tx, () =>
          tx.organizationModuleSetting.update({
            where: { id: row.id },
            data: { module: 'LEAVE', version: row.version + 1 },
          }),
        ),
      ).toBeTruthy();
    });
  });

  it('validates typed settings against the registry; reset returns to the default; audit and history', async () => {
    await scenario(async (tx, fx, svc) => {
      const admin = ctx(fx.users.featureAdmin!);
      for (const value of ['false', 0, null, { on: false }, []]) {
        expect(
          await refusal(
            svc.features.setSetting(
              {
                organizationId: fx.orgA,
                key: 'documents.selfServiceProvide',
                value,
                expectedVersion: 0,
              },
              admin,
            ),
          ),
        ).toEqual({
          status: 400,
          code: 'SETTING_VALUE_INVALID',
          key: 'documents.selfServiceProvide',
        });
      }
      for (const key of ['documents.unknown', 'time.selfClock', 'x', '']) {
        expect(
          await refusal(
            svc.features.setSetting(
              { organizationId: fx.orgA, key, value: true, expectedVersion: 0 },
              admin,
            ),
          ),
        ).toMatchObject({ status: 404, code: 'SETTING_UNKNOWN' });
      }
      const off = await svc.features.setSetting(
        {
          organizationId: fx.orgA,
          key: 'documents.selfServiceProvide',
          value: false,
          expectedVersion: 0,
        },
        admin,
      );
      expect(off.setting).toMatchObject({
        key: 'documents.selfServiceProvide',
        section: 'DOCUMENTS',
        value: false,
        default: true,
        isDefault: false,
        version: 1,
        schemaVersion: 1,
      });
      expect(
        await svc.gate.setting(fx.orgA, 'documents.selfServiceProvide'),
      ).toBe(false);
      expect(
        await svc.gate.setting(fx.orgB, 'documents.selfServiceProvide'),
      ).toBe(true);
      expect(
        await svc.gate.settingOffOrganizations('documents.selfServiceProvide'),
      ).toContain(fx.orgA);
      const reset = await svc.features.resetSetting(
        {
          organizationId: fx.orgA,
          key: 'documents.selfServiceProvide',
          expectedVersion: 1,
        },
        admin,
      );
      expect(reset.setting).toMatchObject({
        value: true,
        isDefault: true,
        version: 2,
      });
      const row = await tx.organizationSetting.findFirstOrThrow({
        where: { organizationId: fx.orgA, key: 'documents.selfServiceProvide' },
      });
      expect(row).toMatchObject({ value: null, schemaVersion: 1, version: 2 });
      // The database refuses malformed keys and non-scalar values on its own.
      expect(
        await violation(tx, () =>
          tx.organizationSetting.create({
            data: {
              organizationId: fx.orgA,
              key: 'Bad Key',
              value: true,
              schemaVersion: 1,
            },
          }),
        ),
      ).toBeTruthy();
      expect(
        await violation(tx, () =>
          tx.organizationSetting.create({
            data: {
              organizationId: fx.orgA,
              key: 'documents.other',
              value: { nested: true },
              schemaVersion: 1,
            },
          }),
        ),
      ).toBeTruthy();
      const audits = await tx.auditLog.findMany({
        where: {
          entityId: fx.orgA,
          action: {
            in: ['ORGANIZATION_SETTING_UPDATED', 'ORGANIZATION_SETTING_RESET'],
          },
        },
        orderBy: { occurredAt: 'asc' },
      });
      expect(audits.map((a) => [a.action, a.metadata])).toEqual([
        [
          'ORGANIZATION_SETTING_UPDATED',
          {
            organizationId: fx.orgA,
            version: 1,
            key: 'documents.selfServiceProvide',
            schemaVersion: 1,
            previous: true,
            previousIsDefault: true,
            value: false,
            isDefault: false,
          },
        ],
        [
          'ORGANIZATION_SETTING_RESET',
          {
            organizationId: fx.orgA,
            version: 2,
            key: 'documents.selfServiceProvide',
            schemaVersion: 1,
            previous: false,
            previousIsDefault: false,
            value: true,
            isDefault: true,
          },
        ],
      ]);
      const history = await svc.features.history(
        fx.users.featureAdmin!,
        fx.orgA,
      );
      expect(
        history.items.map((h) => [h.subject, h.oldValue, h.newValue]),
      ).toEqual([
        ['documents.selfServiceProvide', false, null],
        ['documents.selfServiceProvide', null, false],
      ]);
    });
  });

  it('refuses stale versions (optimistic concurrency) inside one transaction', async () => {
    await scenario(async (_tx, fx, svc) => {
      const admin = ctx(fx.users.featureAdmin!);
      await svc.features.setModule(
        {
          organizationId: fx.orgA,
          module: 'LEAVE',
          enabled: false,
          expectedVersion: 0,
        },
        admin,
      );
      expect(
        await refusal(
          svc.features.setModule(
            {
              organizationId: fx.orgA,
              module: 'LEAVE',
              enabled: true,
              expectedVersion: 0,
            },
            ctx(fx.users.featureAdmin2!),
          ),
        ),
      ).toMatchObject({ status: 409, code: 'FEATURE_VERSION_CONFLICT' });
      expect(
        await refusal(
          svc.features.resetSetting(
            {
              organizationId: fx.orgA,
              key: 'google.drive.verify',
              expectedVersion: 3,
            },
            admin,
          ),
        ),
      ).toMatchObject({ status: 409, code: 'FEATURE_VERSION_CONFLICT' });
    });
  });

  it('lets exactly one of two concurrent changes from the same version win (committed, parallel)', async () => {
    const fx = await prisma.$transaction(
      (tx) => createSchedulingFixtures(tx, FEATURE_USERS),
      { timeout: 120_000 },
    );
    try {
      const svc = featureServices(prisma);
      const attempt = (user: string, enabled: boolean) =>
        svc.features.setModule(
          {
            organizationId: fx.orgA,
            module: 'RECRUITMENT',
            enabled,
            expectedVersion: 0,
          },
          ctx(fx.users[user]!),
        );
      const results = await Promise.allSettled([
        attempt('featureAdmin', false),
        attempt('featureAdmin2', false),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find((r) => r.status === 'rejected') as
        PromiseRejectedResult | undefined;
      expect(
        (rejected!.reason as { getResponse(): unknown }).getResponse(),
      ).toMatchObject({ statusCode: 409, code: 'FEATURE_VERSION_CONFLICT' });
      const row = await prisma.organizationModuleSetting.findFirstOrThrow({
        where: { organizationId: fx.orgA, module: 'RECRUITMENT' },
      });
      expect(row).toMatchObject({ enabled: false, version: 1 });

      // Settings too: two writers from version 0, one wins.
      const settingResults = await Promise.allSettled(
        ['featureAdmin', 'featureAdmin2'].map((user, index) =>
          svc.features.setSetting(
            {
              organizationId: fx.orgA,
              key: 'google.drive.verify',
              value: index === 0,
              expectedVersion: 0,
            },
            ctx(fx.users[user]!),
          ),
        ),
      );
      expect(
        settingResults.filter((r) => r.status === 'fulfilled'),
      ).toHaveLength(1);
      expect(
        await prisma.organizationSettingChange.count({
          where: { organizationId: fx.orgA },
        }),
      ).toBe(2);
    } finally {
      await cleanupSchedulingFixtures(prisma, fx);
    }
  });
});
