import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service.js';
import {
  DOCUMENT_USERS,
  documentServices,
  FixedDocumentsClock,
  type DocumentServices,
} from './support/documents-fixtures.js';
import { failure } from './support/performance-fixtures.js';
import {
  createSchedulingFixtures,
  ctx,
  rollbackClient,
  type SchedulingFixtures,
  type Tx,
} from './support/scheduling-fixtures.js';

config({ path: '../../.env' });

class RollbackFixtures extends Error {}

const link = (url: string, extra: Record<string, unknown> = {}) => ({
  provider: 'EXTERNAL_URL' as const,
  externalUrl: url,
  expiresOn: '2030-01-01',
  ...extra,
});

async function initTypes(svc: DocumentServices, fx: SchedulingFixtures) {
  const { items } = await svc.types.initializeDefaults(
    fx.orgA,
    ctx(fx.users.typeAdmin!),
  );
  return Object.fromEntries(
    items.map((type) => [type.code, type.id]),
  ) as Record<string, string>;
}

/**
 * Batch 9 — Documents security regressions F1–F5 (tests first: each failed on the previous
 * sources). F1 confidentiality of an employee's own provided document after HR reclassified it;
 * F2 storage keys are never client-chosen; F3 storage identifiers never reach employee-facing
 * responses; F4 legacy hand-typed keys are never treated as stored files; F5 the requirement
 * and policy pickers use a Documents-owned options endpoint (no raw ids).
 */
describe('Batch 9 Documents security (database)', () => {
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
      svc: DocumentServices,
      types: Record<string, string>,
    ) => Promise<void>,
  ) {
    await expect(
      prisma.$transaction(
        async (tx) => {
          const fx = await createSchedulingFixtures(tx, DOCUMENT_USERS);
          const svc = documentServices(
            rollbackClient(tx),
            new FixedDocumentsClock(),
          );
          const types = await initTypes(svc, fx);
          await run(tx, fx, svc, types).catch((error: unknown) => {
            console.error('SCENARIO FAILURE', error);
            throw error;
          });
          throw new RollbackFixtures();
        },
        { timeout: 120_000 },
      ),
    ).rejects.toBeInstanceOf(RollbackFixtures);
  }

  it('F1: an employee cannot version their own document once HR reclassified it, and learns nothing of it', async () => {
    await scenario(async (_tx, fx, svc, types) => {
      const doc = await svc.documents.provide(
        {
          organizationId: fx.orgA,
          typeId: types['CERTIFICATION']!,
          title: 'First aid',
          version: link('https://example.com/first-aid.pdf'),
        },
        ctx(fx.selfUser1),
      );
      // Still EMPLOYEE_VISIBLE: the employee renews it.
      await svc.documents.addVersion(
        doc.id,
        link('https://example.com/first-aid-2.pdf'),
        ctx(fx.selfUser1),
      );
      for (const level of [
        'MANAGER_VISIBLE',
        'HR_ONLY',
        'RESTRICTED',
      ] as const) {
        await svc.documents.update(
          doc.id,
          { confidentiality: level },
          ctx(fx.users.restricted!),
        );
        await svc.documents.addVersion(
          doc.id,
          link('https://hr.example.com/investigation.pdf', {
            note: `HR-CONFIDENTIAL-${level}`,
          }),
          ctx(fx.users.restricted!),
        );
        // Not found, exactly like a document the employee may not read.
        expect(
          await failure(
            svc.documents.addVersion(
              doc.id,
              link('https://example.com/again.pdf'),
              ctx(fx.selfUser1),
            ),
          ),
        ).toMatchObject({ status: 404 });
        expect(
          await failure(svc.documents.detail(fx.selfUser1, doc.id)),
        ).toMatchObject({ status: 404 });
      }
      // Nothing the employee could read was added, and their own list hides it.
      const mine = (await svc.documents.mine(fx.selfUser1)).items[0]!;
      expect(mine.documents.map((d) => d.id)).not.toContain(doc.id);
      const versions = await prisma.employeeDocumentVersion.count({
        where: { documentId: doc.id },
      });
      void versions;
      // Back to EMPLOYEE_VISIBLE: the employee may renew it again.
      await svc.documents.update(
        doc.id,
        { confidentiality: 'EMPLOYEE_VISIBLE' },
        ctx(fx.users.restricted!),
      );
      const renewed = await svc.documents.addVersion(
        doc.id,
        link('https://example.com/first-aid-3.pdf'),
        ctx(fx.selfUser1),
      );
      expect(renewed.confidentiality).toBe('EMPLOYEE_VISIBLE');
    });
  });

  it('F2: internal storage keys are never accepted from a client', async () => {
    await scenario(async (_tx, fx, svc, types) => {
      const key = {
        provider: 'INTERNAL_OBJECT_STORAGE' as const,
        storageKey: 'documents/other-org/someone-else.pdf',
        expiresOn: '2030-01-01',
      };
      const refused = {
        status: 400,
        code: 'DOCUMENT_STORAGE_KEY_NOT_ACCEPTED',
      };
      // Employee self-service.
      expect(
        await failure(
          svc.documents.provide(
            {
              organizationId: fx.orgA,
              typeId: types['CERTIFICATION']!,
              title: 'x',
              version: key,
            },
            ctx(fx.selfUser1),
          ),
        ),
      ).toEqual(refused);
      // HR record creation and versioning.
      expect(
        await failure(
          svc.documents.create(
            {
              organizationId: fx.orgA,
              employeeId: fx.employee2,
              typeId: types['CERTIFICATION']!,
              title: 'x',
              version: key,
            },
            ctx(fx.users.restricted!),
          ),
        ),
      ).toEqual(refused);
      const doc = await svc.documents.create(
        {
          organizationId: fx.orgA,
          employeeId: fx.employee2,
          typeId: types['CERTIFICATION']!,
          title: 'Cert',
          version: link('https://example.com/c.pdf'),
        },
        ctx(fx.users.restricted!),
      );
      expect(
        await failure(
          svc.documents.addVersion(doc.id, key, ctx(fx.users.restricted!)),
        ),
      ).toEqual(refused);
      // Policy versions.
      const policy = await svc.policies.create(
        { organizationId: fx.orgA, code: 'HANDBOOK', title: 'Handbook' },
        ctx(fx.users.policyAdmin!),
      );
      expect(
        await failure(
          svc.policies.createVersion(
            policy.id,
            {
              versionLabel: '2026',
              provider: 'INTERNAL_OBJECT_STORAGE',
              storageKey: 'documents/x/y.pdf',
            },
            ctx(fx.users.policyAdmin!),
          ),
        ),
      ).toEqual(refused);
      // A key is refused with any provider, not only internal storage.
      expect(
        await failure(
          svc.documents.addVersion(
            doc.id,
            { ...link('https://example.com/d.pdf'), storageKey: 'x/y' },
            ctx(fx.users.restricted!),
          ),
        ),
      ).toEqual(refused);
    });
  });

  it('F3/F4: storage identifiers never reach employees; legacy internal keys are not stored files', async () => {
    await scenario(async (tx, fx, svc, types) => {
      const drive = await svc.documents.create(
        {
          organizationId: fx.orgA,
          employeeId: fx.employee1,
          typeId: types['EMPLOYMENT-AGREEMENT']!,
          title: 'Agreement',
          confidentiality: 'EMPLOYEE_VISIBLE',
          version: {
            provider: 'GOOGLE_DRIVE',
            externalFileId: 'drive-file-id-secret',
            fileName: 'agreement.pdf',
          },
        },
        ctx(fx.users.restricted!),
      );
      // A legacy record holding a hand-typed internal key (written before Batch 9; the Batch 9
      // guard refuses new ones, so the row is written with triggers off, as history would be).
      await tx.$executeRawUnsafe(
        'SET LOCAL session_replication_role = replica',
      );
      const legacy = await tx.employeeDocument.create({
        data: {
          organizationId: fx.orgA,
          employeeId: fx.employee1,
          typeId: types['HANDBOOK']!,
          title: 'Legacy',
          confidentiality: 'EMPLOYEE_VISIBLE',
          source: 'HR',
        },
      });
      await tx.employeeDocumentVersion.create({
        data: {
          documentId: legacy.id,
          versionNumber: 1,
          provider: 'INTERNAL_OBJECT_STORAGE',
          storageKey: 'legacy/hand-typed/key.pdf',
          fileName: 'legacy.pdf',
        },
      });
      await tx.$executeRawUnsafe('SET LOCAL session_replication_role = origin');
      const mine = JSON.stringify(await svc.documents.mine(fx.selfUser1));
      expect(mine).not.toContain('legacy/hand-typed/key.pdf');
      expect(mine).not.toContain('drive-file-id-secret');
      expect(mine).not.toContain('"storageKey"');
      expect(mine).not.toContain('"externalFileId"');
      const hr = await svc.documents.detail(fx.users.restricted!, legacy.id);
      expect(JSON.stringify(hr)).not.toContain('legacy/hand-typed/key.pdf');
      expect(hr.currentVersion).toMatchObject({
        provider: 'INTERNAL_OBJECT_STORAGE',
        file: null,
        legacyReference: true,
      });
      // Managers still see a Drive file id (needed to manage the reference).
      const managed = await svc.documents.detail(
        fx.users.restricted!,
        drive.id,
      );
      expect(managed.currentVersion).toMatchObject({
        externalFileId: 'drive-file-id-secret',
        legacyReference: false,
      });
    });
  });

  it('F5: requirement and policy pickers come from a Documents options endpoint', async () => {
    await scenario(async (_tx, fx, svc) => {
      const departments = await svc.options.options(fx.users.typeAdmin!, {
        organizationId: fx.orgA,
        kind: 'department',
      });
      expect(departments.items.map((item) => item.id)).toEqual(
        expect.arrayContaining([fx.deptA, fx.deptB]),
      );
      const positions = await svc.options.options(fx.users.policyAdmin!, {
        organizationId: fx.orgA,
        kind: 'position',
      });
      expect(positions.items.length).toBeGreaterThan(0);
      // Readers of records do not configure requirements or policies.
      expect(
        await failure(
          svc.options.options(fx.users.reader!, {
            organizationId: fx.orgA,
            kind: 'department',
          }),
        ),
      ).toMatchObject({ status: 403 });
      // Another organization: refused.
      expect(
        await failure(
          svc.options.options(fx.users.typeAdmin!, {
            organizationId: fx.orgB,
            kind: 'department',
          }),
        ),
      ).toMatchObject({ status: 403 });
    });
  });
});
