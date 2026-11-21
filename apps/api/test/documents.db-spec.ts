import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service.js';
import type { DocumentStorageAdapter } from '../src/documents/document-storage.contract.js';
import {
  sendExpiryReminders,
  verifyDocumentReferences,
} from '../src/documents/documents-jobs.js';
import {
  DOCUMENT_USERS,
  documentServices,
  FixedDocumentsClock,
  type DocumentServices,
} from './support/documents-fixtures.js';
import {
  FixedOnboardingClock,
  onboardingServices,
} from './support/onboarding-fixtures.js';
import { failure } from './support/performance-fixtures.js';
import {
  acceptedOffer,
  FixedRecruitmentClock,
  recruitmentServices,
  vacantPosition,
} from './support/recruitment-fixtures.js';
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

const drive = (fileId: string, expiresOn: string | null = null) => ({
  provider: 'GOOGLE_DRIVE' as const,
  externalFileId: fileId,
  fileName: `${fileId}.pdf`,
  mimeType: 'application/pdf',
  expiresOn,
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

describe('Documents and employee records (database)', () => {
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
      clock: FixedDocumentsClock,
    ) => Promise<void>,
  ) {
    await expect(
      prisma.$transaction(
        async (tx) => {
          const fx = await createSchedulingFixtures(tx, DOCUMENT_USERS);
          const clock = new FixedDocumentsClock();
          const svc = documentServices(rollbackClient(tx), clock);
          await run(tx, fx, svc, clock).catch((error: unknown) => {
            console.error('SCENARIO FAILURE', error);
            throw error;
          });
          throw new RollbackFixtures();
        },
        { timeout: 120_000 },
      ),
    ).rejects.toBeInstanceOf(RollbackFixtures);
  }

  it('configures document types and requirements at organization level', async () => {
    await scenario(async (tx, fx, svc) => {
      // Organization actions are per organization: a policy admin holds no record grants there.
      const policyOrgs = await svc.access.organizations(fx.users.policyAdmin!);
      expect(
        policyOrgs.items.find((o) => o.id === fx.orgA)?.actions,
      ).toMatchObject({
        canManagePolicies: true,
        canReadRecords: false,
        canManageRecords: false,
      });
      const orgBOrgs = await svc.access.organizations(fx.users.orgBAdmin!);
      expect(orgBOrgs.items.map((o) => o.id)).toEqual([fx.orgB]);
      expect(
        (await svc.access.organizations(fx.users.teamRecords!)).items.find(
          (o) => o.id === fx.orgA,
        )?.actions,
      ).toMatchObject({
        canReadRecords: true,
        canManageRecords: true,
        canManageTypes: false,
      });
      for (const user of ['teamRecords', 'hrRecords', 'hr', 'orgBAdmin']) {
        expect(
          await failure(
            svc.types.initializeDefaults(fx.orgA, ctx(fx.users[user]!)),
          ),
        ).toMatchObject({ status: 403 });
      }
      const types = await initTypes(svc, fx);
      expect(Object.keys(types)).toEqual(
        expect.arrayContaining([
          'EMPLOYMENT-AGREEMENT',
          'CERTIFICATION',
          'IDENTIFICATION',
          'BACKGROUND-CHECK',
          'TAX',
        ]),
      );
      const firstAid = await svc.types.create(
        {
          organizationId: fx.orgA,
          code: 'first-aid',
          name: 'First aid certificate',
          category: 'CERTIFICATION',
          defaultConfidentiality: 'MANAGER_VISIBLE',
          expiryTracked: true,
          employeeProvided: true,
        },
        ctx(fx.users.typeAdmin!),
      );
      expect(
        await failure(
          svc.types.create(
            {
              organizationId: fx.orgA,
              code: 'FIRST-AID',
              name: 'x',
              category: 'OTHER',
              defaultConfidentiality: 'HR_ONLY',
            },
            ctx(fx.users.typeAdmin!),
          ),
        ),
      ).toEqual({
        status: 409,
        code: 'DOCUMENT_TYPE_EXISTS',
      });
      const requirement = await svc.types.createRequirement(
        {
          organizationId: fx.orgA,
          typeId: firstAid.id,
          departmentId: fx.deptA,
        },
        ctx(fx.users.typeAdmin!),
      );
      expect(
        await failure(
          svc.types.createRequirement(
            {
              organizationId: fx.orgA,
              typeId: firstAid.id,
              departmentId: fx.deptA,
            },
            ctx(fx.users.typeAdmin!),
          ),
        ),
      ).toEqual({ status: 409, code: 'DOCUMENT_REQUIREMENT_EXISTS' });
      expect(
        await failure(svc.types.archive(firstAid.id, ctx(fx.users.typeAdmin!))),
      ).toEqual({ status: 409, code: 'DOCUMENT_TYPE_REQUIRED' });
      await svc.types.archiveRequirement(
        requirement.id,
        ctx(fx.users.typeAdmin!),
      );
      await svc.types.archive(firstAid.id, ctx(fx.users.typeAdmin!));
      expect(
        await violation(tx, () =>
          tx.documentType.update({
            where: { id: firstAid.id },
            data: { category: 'TAX' },
          }),
        ),
      ).toBeTruthy();
      expect(
        await violation(tx, () =>
          tx.documentType.delete({ where: { id: firstAid.id } }),
        ),
      ).toBeTruthy();
      expect(
        await violation(tx, () =>
          tx.documentRequirement.delete({ where: { id: requirement.id } }),
        ),
      ).toBeTruthy();
    });
  });

  it('gates every record by scope and confidentiality, never by HR or payroll access', async () => {
    await scenario(async (tx, fx, svc) => {
      const types = await initTypes(svc, fx);
      const hr = ctx(fx.users.hrRecords!);
      const record = (
        level:
          'EMPLOYEE_VISIBLE' | 'MANAGER_VISIBLE' | 'HR_ONLY' | 'RESTRICTED',
        typeCode: string,
        user = hr,
      ) =>
        svc.documents.create(
          {
            organizationId: fx.orgA,
            employeeId: fx.employee2,
            typeId: types[typeCode]!,
            title: `${typeCode} record`,
            confidentiality: level,
            version: drive(
              `${typeCode}-file`,
              typeCode === 'IDENTIFICATION' || typeCode === 'CERTIFICATION'
                ? '2027-01-31'
                : null,
            ),
          },
          user,
        );
      for (const user of [
        'hr',
        'reader',
        'typeAdmin',
        'policyAdmin',
        'orgBAdmin',
        'deptBReader',
      ]) {
        expect(
          await failure(
            record(
              'MANAGER_VISIBLE',
              'EMPLOYMENT-AGREEMENT',
              ctx(fx.users[user]!),
            ),
          ),
        ).toMatchObject({ status: 403 });
      }
      const agreement = await record(
        'EMPLOYEE_VISIBLE',
        'EMPLOYMENT-AGREEMENT',
      );
      const certificate = await record('MANAGER_VISIBLE', 'CERTIFICATION');
      const evaluation = await record('HR_ONLY', 'EVALUATION');
      // Managing a level needs clearance for it.
      expect(await failure(record('RESTRICTED', 'IDENTIFICATION'))).toEqual({
        status: 403,
        code: 'DOCUMENT_CLEARANCE_REQUIRED',
      });
      const identification = await record(
        'RESTRICTED',
        'IDENTIFICATION',
        ctx(fx.users.restricted!),
      );
      expect(identification).toMatchObject({
        confidentiality: 'RESTRICTED',
        currentVersion: {
          versionNumber: 1,
          provider: 'GOOGLE_DRIVE',
          expiryStatus: 'VALID',
        },
      });
      const visible = async (userId: string) =>
        (await svc.documents.employeeRecords(userId, fx.employee2)).items
          .flatMap((org) => org.documents.map((doc) => doc.id))
          .sort();
      expect(await visible(fx.users.reader!)).toEqual(
        [agreement.id, certificate.id].sort(),
      );
      expect(await visible(fx.users.hrRecords!)).toEqual(
        [agreement.id, certificate.id, evaluation.id].sort(),
      );
      expect(await visible(fx.users.restricted!)).toEqual(
        [agreement.id, certificate.id, evaluation.id, identification.id].sort(),
      );
      expect(await visible(fx.users.hr!)).toEqual([]);
      expect(await visible(fx.users.deptBReader!)).toEqual([]);
      expect(await visible(fx.users.orgBAdmin!)).toEqual([]);
      expect(
        await failure(
          svc.documents.detail(fx.users.hrRecords!, identification.id),
        ),
      ).toMatchObject({ status: 404 });
      expect(
        await failure(svc.documents.detail(fx.users.hr!, agreement.id)),
      ).toMatchObject({ status: 404 });
      // The employee (employee 2) sees only their employee-visible records through self-service.
      const mine = await svc.documents.mine(fx.selfUser2);
      expect(mine.items[0]!.documents.map((doc) => doc.id)).toEqual([
        agreement.id,
      ]);
      expect(
        await failure(svc.documents.detail(fx.selfUser2, evaluation.id)),
      ).toMatchObject({ status: 404 });
      // Team-scoped records managers reach employee 2 (team A) but not HR-only documents.
      expect(await visible(fx.users.teamRecords!)).toEqual(
        [agreement.id, certificate.id].sort(),
      );
      // Re-classifying needs clearance for the new level; it is audited without content.
      expect(
        await failure(
          svc.documents.update(
            evaluation.id,
            { confidentiality: 'RESTRICTED' },
            hr,
          ),
        ),
      ).toEqual({ status: 403, code: 'DOCUMENT_CLEARANCE_REQUIRED' });
      await svc.documents.update(
        certificate.id,
        { confidentiality: 'HR_ONLY' },
        hr,
      );
      expect(await visible(fx.users.reader!)).toEqual([agreement.id]);
      // Nobody manages their own records, whatever their permissions.
      expect(
        await failure(
          svc.documents.create(
            {
              organizationId: fx.orgA,
              employeeId: fx.employee1,
              typeId: types['EVALUATION']!,
              title: 'x',
              version: drive('x'),
            },
            ctx(fx.users.self1!),
          ),
        ),
      ).toEqual({ status: 403, code: 'DOCUMENT_SELF_MANAGEMENT' });
      // Archive; archived records are frozen. Records never delete.
      await svc.documents.archive(evaluation.id, 'Filed in error', hr);
      expect(
        await failure(svc.documents.addVersion(evaluation.id, drive('v2'), hr)),
      ).toEqual({ status: 409, code: 'DOCUMENT_ARCHIVED' });
      expect(
        await violation(tx, () =>
          tx.employeeDocument.update({
            where: { id: evaluation.id },
            data: { title: 'x' },
          }),
        ),
      ).toBeTruthy();
      expect(
        await violation(tx, () =>
          tx.employeeDocument.delete({ where: { id: agreement.id } }),
        ),
      ).toBeTruthy();
      expect(
        await violation(tx, () =>
          tx.employeeDocument.update({
            where: { id: agreement.id },
            data: { employeeId: fx.employee1 },
          }),
        ),
      ).toBeTruthy();
      expect(
        await violation(tx, () =>
          tx.employeeDocument.create({
            data: {
              organizationId: fx.orgB,
              employeeId: fx.employee2,
              typeId: types['OTHER']!,
              title: 'x',
              confidentiality: 'HR_ONLY',
              source: 'HR',
            },
          }),
        ),
      ).toBeTruthy();
      // Audit metadata: identifiers and levels only, never file ids, names or links.
      const audits = await tx.auditLog.findMany({
        where: { entityType: 'EmployeeDocument' },
      });
      expect(audits.map((a) => a.action)).toEqual(
        expect.arrayContaining([
          'EMPLOYEE_DOCUMENT_CREATED',
          'EMPLOYEE_DOCUMENT_RECLASSIFIED',
          'EMPLOYEE_DOCUMENT_ARCHIVED',
        ]),
      );
      expect(JSON.stringify(audits.map((a) => a.metadata))).not.toMatch(
        /-file|\.pdf|Filed in error/,
      );
    });
  });

  it('keeps every version, numbered in sequence, with date-derived expiry', async () => {
    await scenario(async (tx, fx, svc, clock) => {
      const types = await initTypes(svc, fx);
      const hr = ctx(fx.users.hrRecords!);
      expect(
        await failure(
          svc.documents.create(
            {
              organizationId: fx.orgA,
              employeeId: fx.employee2,
              typeId: types['CERTIFICATION']!,
              title: 'First aid',
              version: drive('fa-2025'),
            },
            hr,
          ),
        ),
      ).toEqual({ status: 400, code: 'DOCUMENT_EXPIRY_REQUIRED' });
      const doc = await svc.documents.create(
        {
          organizationId: fx.orgA,
          employeeId: fx.employee2,
          typeId: types['CERTIFICATION']!,
          title: 'First aid',
          version: {
            ...drive('fa-2025', '2026-04-01'),
            issuedOn: '2025-04-01',
          },
        },
        hr,
      );
      expect(doc).toMatchObject({
        expiryStatus: 'EXPIRING_SOON',
        currentVersion: { versionNumber: 1 },
      });
      clock.value = new Date('2026-04-02T12:00:00.000Z');
      expect(
        (await svc.documents.detail(fx.users.hrRecords!, doc.id)).expiryStatus,
      ).toBe('EXPIRED');
      const renewed = await svc.documents.addVersion(
        doc.id,
        {
          ...drive('fa-2026', '2027-04-01'),
          issuedOn: '2026-04-01',
          note: 'Renewed',
        },
        hr,
      );
      expect(renewed).toMatchObject({
        expiryStatus: 'VALID',
        currentVersion: { versionNumber: 2 },
      });
      expect(renewed.versions.map((v) => [v.versionNumber, v.current])).toEqual(
        [
          [2, true],
          [1, false],
        ],
      );
      const first = await tx.employeeDocumentVersion.findFirstOrThrow({
        where: { documentId: doc.id, versionNumber: 1 },
      });
      // Versions are immutable (adapters may only record reference status), never deleted, in sequence.
      expect(
        await violation(tx, () =>
          tx.employeeDocumentVersion.update({
            where: { id: first.id },
            data: { expiresOn: new Date('2030-01-01') },
          }),
        ),
      ).toBeTruthy();
      expect(
        await violation(tx, () =>
          tx.employeeDocumentVersion.update({
            where: { id: first.id },
            data: { supersededAt: null },
          }),
        ),
      ).toBeTruthy();
      expect(
        await violation(tx, () =>
          tx.employeeDocumentVersion.delete({ where: { id: first.id } }),
        ),
      ).toBeTruthy();
      expect(
        await violation(tx, () =>
          tx.employeeDocumentVersion.create({
            data: {
              documentId: doc.id,
              versionNumber: 5,
              provider: 'MANUAL_REFERENCE',
            },
          }),
        ),
      ).toBeTruthy();
      expect(
        await violation(tx, () =>
          tx.employeeDocumentVersion.create({
            data: {
              documentId: doc.id,
              versionNumber: 3,
              provider: 'EXTERNAL_URL',
              externalUrl: 'http://x.test',
            },
          }),
        ),
      ).toBeTruthy();
      await tx.employeeDocumentVersion.update({
        where: { id: first.id },
        data: { referenceStatus: 'MISSING', referenceCheckedAt: new Date() },
      });
      // Expiry dashboard: date-derived, scoped.
      clock.value = new Date('2027-03-20T12:00:00.000Z');
      const expiring = await svc.documents.expiryDashboard(
        fx.users.reader!,
        fx.orgA,
      );
      expect(
        expiring.items.map((row) => [row.documentId, row.expiryStatus]),
      ).toEqual([[doc.id, 'EXPIRING_SOON']]);
      expect(
        (await svc.documents.expiryDashboard(fx.users.deptBReader!, fx.orgA))
          .items,
      ).toEqual([]);
    });
  });

  it('lets employees provide documents of employee-provided types and reports missing requirements', async () => {
    await scenario(async (_tx, fx, svc, clock) => {
      const types = await initTypes(svc, fx);
      await svc.types.createRequirement(
        { organizationId: fx.orgA, typeId: types['CERTIFICATION']! },
        ctx(fx.users.typeAdmin!),
      );
      await svc.types.createRequirement(
        {
          organizationId: fx.orgA,
          typeId: types['IDENTIFICATION']!,
          employmentType: 'FULL_TIME',
        },
        ctx(fx.users.typeAdmin!),
      );
      const missingBefore = await svc.documents.missingDashboard(
        fx.users.reader!,
        fx.orgA,
      );
      expect(missingBefore.items.map((row) => row.employee.id).sort()).toEqual(
        [fx.employee1, fx.employee2].sort(),
      );
      expect(
        (await svc.documents.mine(fx.selfUser1)).items[0]!.missing.map(
          (m) => m.typeName,
        ).sort(),
      ).toEqual(['Certification', 'Identification record']);
      // HR-recorded types are not employee-provided.
      expect(
        await failure(
          svc.documents.provide(
            {
              organizationId: fx.orgA,
              typeId: types['IDENTIFICATION']!,
              title: 'Passport',
              version: drive('passport', '2030-01-01'),
            },
            ctx(fx.selfUser1),
          ),
        ),
      ).toEqual({ status: 403, code: 'DOCUMENT_NOT_EMPLOYEE_PROVIDED' });
      const provided = await svc.documents.provide(
        {
          organizationId: fx.orgA,
          typeId: types['CERTIFICATION']!,
          title: 'First aid',
          version: drive('my-first-aid', '2026-04-30'),
        },
        ctx(fx.selfUser1),
      );
      expect(provided).toMatchObject({
        source: 'EMPLOYEE',
        confidentiality: 'EMPLOYEE_VISIBLE',
      });
      // The employee renews their own provided document; never HR records.
      await svc.documents.addVersion(
        provided.id,
        drive('my-first-aid-2', '2027-04-30'),
        ctx(fx.selfUser1),
      );
      const mine = (await svc.documents.mine(fx.selfUser1)).items[0]!;
      expect(mine.missing.map((m) => m.typeName)).toEqual([
        'Identification record',
      ]);
      expect(mine.documents[0]).toMatchObject({
        currentVersion: { versionNumber: 2 },
      });
      // Expired documents no longer satisfy a requirement.
      clock.value = new Date('2027-05-01T12:00:00.000Z');
      const later = await svc.documents.employeeRecords(
        fx.users.reader!,
        fx.employee1,
      );
      expect(
        later.items[0]!.requirements.find(
          (r) => r.typeId === types['CERTIFICATION'],
        ),
      ).toMatchObject({ status: 'EXPIRED' });
      expect(
        await failure(
          svc.documents.provide(
            {
              organizationId: fx.orgB,
              typeId: types['CERTIFICATION']!,
              title: 'x',
              version: drive('x', '2030-01-01'),
            },
            ctx(fx.selfUser1),
          ),
        ),
      ).toMatchObject({
        status: 400,
      });
    });
  });

  it('versions policies and keeps each acknowledgement to the version acknowledged', async () => {
    await scenario(async (tx, fx, svc) => {
      const policy = ctx(fx.users.policyAdmin!);
      expect(
        await failure(
          svc.policies.create(
            {
              organizationId: fx.orgA,
              code: 'handbook',
              title: 'Staff Handbook',
            },
            ctx(fx.users.hrRecords!),
          ),
        ),
      ).toMatchObject({ status: 403 });
      const handbook = await svc.policies.create(
        { organizationId: fx.orgA, code: 'handbook', title: 'Staff Handbook' },
        policy,
      );
      const v1 = (
        await svc.policies.createVersion(
          handbook.id,
          {
            versionLabel: '2026',
            provider: 'GOOGLE_DRIVE',
            externalFileId: 'handbook-2026',
          },
          policy,
        )
      ).versions[0]!;
      expect(
        await failure(
          svc.policies.createVersion(
            handbook.id,
            { versionLabel: 'again', provider: 'MANUAL_REFERENCE' },
            policy,
          ),
        ),
      ).toEqual({ status: 409, code: 'POLICY_DRAFT_EXISTS' });
      expect(
        await failure(svc.policies.publish(handbook.id, v1.id, policy)),
      ).toEqual({ status: 400, code: 'POLICY_STATEMENT_REQUIRED' });
      await tx.policyDocumentVersion.update({
        where: { id: v1.id },
        data: {
          acknowledgementStatement:
            'I have received and read the Staff Handbook 2026.',
        },
      });
      await svc.policies.publish(handbook.id, v1.id, policy);
      // Employees acknowledge the current version; it is idempotent and immutable.
      expect(
        await failure(
          svc.policies.acknowledge(
            handbook.id,
            v1.id,
            false,
            ctx(fx.selfUser1),
          ),
        ),
      ).toEqual({ status: 400, code: 'POLICY_ACKNOWLEDGEMENT_REQUIRED' });
      const ack = await svc.policies.acknowledge(
        handbook.id,
        v1.id,
        true,
        ctx(fx.selfUser1),
      );
      expect(ack).toMatchObject({
        created: true,
        statement: 'I have received and read the Staff Handbook 2026.',
      });
      expect(
        await svc.policies.acknowledge(
          handbook.id,
          v1.id,
          true,
          ctx(fx.selfUser1),
        ),
      ).toMatchObject({
        created: false,
        acknowledgementId: ack.acknowledgementId,
      });
      expect(
        await violation(tx, () =>
          tx.documentAcknowledgement.update({
            where: { id: ack.acknowledgementId },
            data: { statement: 'edited' },
          }),
        ),
      ).toBeTruthy();
      expect(
        await violation(tx, () =>
          tx.documentAcknowledgement.delete({
            where: { id: ack.acknowledgementId },
          }),
        ),
      ).toBeTruthy();
      expect(
        await violation(tx, () =>
          tx.policyDocumentVersion.update({
            where: { id: v1.id },
            data: { externalFileId: 'swapped' },
          }),
        ),
      ).toBeTruthy();
      // Version 2: acknowledging version 1 does not count for it.
      const v2 = (
        await svc.policies.createVersion(
          handbook.id,
          {
            versionLabel: '2027',
            provider: 'EXTERNAL_URL',
            externalUrl: 'https://docs.example.com/handbook-2027',
            acknowledgementStatement:
              'I have received and read the Staff Handbook 2027.',
          },
          policy,
        )
      ).versions[0]!;
      await svc.policies.publish(handbook.id, v2.id, policy);
      expect(
        await failure(
          svc.policies.acknowledge(handbook.id, v1.id, true, ctx(fx.selfUser1)),
        ),
      ).toEqual({ status: 409, code: 'POLICY_VERSION_NOT_CURRENT' });
      const myPolicies = await svc.policies.mine(fx.selfUser1);
      expect(myPolicies.items[0]).toMatchObject({
        needsAcknowledgement: true,
        acknowledgedEarlierVersion: true,
        currentVersion: { versionLabel: '2027' },
      });
      const tracking = await svc.policies.tracking(
        fx.users.policyAdmin!,
        handbook.id,
      );
      expect(
        tracking.items.find((row) => row.employee.id === fx.employee1),
      ).toMatchObject({ status: 'EARLIER_VERSION_ONLY' });
      expect(
        tracking.items.find((row) => row.employee.id === fx.employee2),
      ).toMatchObject({ status: 'PENDING' });
      expect(
        await failure(svc.policies.tracking(fx.users.hr!, handbook.id)),
      ).toMatchObject({ status: 403 });
      // Audience: a department policy is not addressed to employees outside it.
      const dept = await svc.policies.create(
        {
          organizationId: fx.orgA,
          code: 'dept-b-rules',
          title: 'Dept B rules',
          audienceDepartmentId: fx.deptB,
          acknowledgementRequired: false,
        },
        policy,
      );
      const dv = (
        await svc.policies.createVersion(
          dept.id,
          { versionLabel: '1', provider: 'MANUAL_REFERENCE' },
          policy,
        )
      ).versions[0]!;
      await svc.policies.publish(dept.id, dv.id, policy);
      expect(
        await failure(
          svc.policies.acknowledge(dept.id, dv.id, true, ctx(fx.selfUser2)),
        ),
      ).toMatchObject({ status: 404 });
      await svc.policies.acknowledge(dept.id, dv.id, true, ctx(fx.selfUser1));
      await svc.policies.retire(dept.id, policy);
      expect(
        await failure(
          svc.policies.createVersion(
            dept.id,
            { versionLabel: '2', provider: 'MANUAL_REFERENCE' },
            policy,
          ),
        ),
      ).toEqual({ status: 409, code: 'POLICY_RETIRED' });
    });
  });

  it('records onboarding policy acknowledgements and required documents through the Documents contract', async () => {
    await scenario(async (tx, fx, svc) => {
      const types = await initTypes(svc, fx);
      const onboarding = onboardingServices(
        rollbackClient(tx),
        new FixedOnboardingClock(),
        svc.policies,
      );
      const policyAdmin = ctx(fx.users.policyAdmin!);
      const coc = await svc.policies.create(
        { organizationId: fx.orgA, code: 'coc', title: 'Code of Conduct' },
        policyAdmin,
      );
      const v1 = (
        await svc.policies.createVersion(
          coc.id,
          {
            versionLabel: '2026',
            provider: 'MANUAL_REFERENCE',
            acknowledgementStatement: 'I have read the Code of Conduct 2026.',
          },
          policyAdmin,
        )
      ).versions[0]!;
      await svc.policies.publish(coc.id, v1.id, policyAdmin);
      const template = await onboarding.templates.create(
        {
          organizationId: fx.orgA,
          kind: 'ONBOARDING',
          code: 'docs',
          name: 'Documents onboarding',
          tasks: [
            {
              title: 'Acknowledge the Code of Conduct',
              category: 'POLICY',
              ownerType: 'EMPLOYEE',
              acknowledgementRequired: true,
              acknowledgementStatement: 'I have read the Code of Conduct.',
              referenceType: 'POLICY_DOCUMENT',
              referenceExternalId: coc.id,
            },
            {
              title: 'Provide your certification',
              category: 'PAPERWORK',
              ownerType: 'EMPLOYEE',
              referenceType: 'DOCUMENT_TYPE',
              referenceExternalId: types['CERTIFICATION']!,
            },
          ],
        },
        ctx(fx.users.templateAdmin!),
      );
      expect(
        await failure(
          onboarding.templates.create(
            {
              organizationId: fx.orgA,
              kind: 'ONBOARDING',
              code: 'bad',
              name: 'x',
              tasks: [
                {
                  title: 'x',
                  category: 'POLICY',
                  ownerType: 'EMPLOYEE',
                  referenceType: 'POLICY_DOCUMENT',
                  referenceExternalId: fx.orgB,
                },
              ],
            },
            ctx(fx.users.templateAdmin!),
          ),
        ),
      ).toEqual({ status: 400, code: 'WORKFLOW_REFERENCE_INVALID' });
      await onboarding.templates.activate(
        template.id,
        ctx(fx.users.templateAdmin!),
      );
      const workflow = await onboarding.workflows.start(
        'ONBOARDING',
        { employmentAssignmentId: fx.assignmentTeamA, templateId: template.id },
        ctx(fx.users.onboardingHr!),
      );
      const [ackTask, docTask] = workflow.tasks;
      await onboarding.tasks.acknowledge(
        ackTask!.id,
        { statementAccepted: true },
        ctx(fx.selfUser1),
      );
      const linked = await tx.employeeWorkflowTask.findUniqueOrThrow({
        where: { id: ackTask!.id },
      });
      const acknowledgement =
        await tx.documentAcknowledgement.findUniqueOrThrow({
          where: { id: linked.documentAcknowledgementId! },
        });
      expect(acknowledgement).toMatchObject({
        policyVersionId: v1.id,
        employeeId: fx.employee1,
        source: 'ONBOARDING_TASK',
        statement: 'I have read the Code of Conduct 2026.',
      });
      expect(
        (await svc.policies.mine(fx.selfUser1)).items.find(
          (p) => p.id === coc.id,
        ),
      ).toMatchObject({ needsAcknowledgement: false });
      expect(
        await violation(tx, () =>
          tx.employeeWorkflowTask.update({
            where: { id: ackTask!.id },
            data: { documentAcknowledgementId: null },
          }),
        ),
      ).toBeTruthy();
      // The required-document task completes only once a valid document exists.
      expect(
        await failure(
          onboarding.tasks.complete(docTask!.id, {}, ctx(fx.selfUser1)),
        ),
      ).toEqual({ status: 409, code: 'WORKFLOW_DOCUMENT_REQUIRED' });
      const provided = await svc.documents.provide(
        {
          organizationId: fx.orgA,
          typeId: types['CERTIFICATION']!,
          title: 'Teaching certificate',
          workflowTaskId: docTask!.id,
          version: drive('teaching-cert', '2028-06-30'),
        },
        ctx(fx.selfUser1),
      );
      expect(provided.source).toBe('ONBOARDING');
      const completed = await onboarding.tasks.complete(
        docTask!.id,
        {},
        ctx(fx.selfUser1),
      );
      expect(completed.tasks.find((t) => t.id === docTask!.id)).toMatchObject({
        status: 'COMPLETED',
        evidenceReference: `employee-document:${provided.id}`,
      });
      expect(completed.status).toBe('COMPLETED');
    });
  });

  it('hands off selected recruitment documents after hire, once, with provenance', async () => {
    await scenario(async (tx, fx, svc) => {
      const types = await initTypes(svc, fx);
      const recruitment = recruitmentServices(
        rollbackClient(tx),
        new FixedRecruitmentClock(),
      );
      const role = await tx.role.create({
        data: {
          organizationId: fx.orgA,
          code: `HIRE-${fx.suffix}`,
          name: 'Hiring',
        },
      });
      for (const key of [
        'recruitment.read',
        'recruitment.manage',
        'recruitment.offer.approve',
        'recruitment.hire',
        'employee.read',
        'employee.manage',
      ]) {
        const permission = await tx.permission.upsert({
          where: { key },
          create: { key, name: key, isActive: true },
          update: {},
        });
        await tx.rolePermission.create({
          data: { roleId: role.id, permissionId: permission.id },
        });
      }
      await tx.roleAssignment.create({
        data: {
          userId: fx.users.hrRecords!,
          roleId: role.id,
          roleOrganizationId: fx.orgA,
          scopeType: 'ORGANIZATION',
          organizationId: fx.orgA,
        },
      });
      const position = await vacantPosition(tx, fx, { team: true });
      const hiringFx = {
        ...fx,
        users: { ...fx.users, hiringAdmin: fx.users.hrRecords! },
      };
      const { applicationId, candidateId } = await acceptedOffer(
        recruitment,
        hiringFx,
        {
          positionId: position,
          candidate: { email: 'teacher.handoff@example.com' },
        },
      );
      const resume = await recruitment.candidates.addDocument(
        candidateId,
        {
          kind: 'RESUME',
          title: 'CV',
          provider: 'GOOGLE_DRIVE',
          externalFileId: 'cv-file',
        },
        ctx(fx.users.hrRecords!),
      );
      const other = await recruitment.applications.create(
        {
          openingId: (
            await tx.recruitmentApplication.findUniqueOrThrow({
              where: { id: applicationId },
            })
          ).openingId,
          candidate: {
            firstName: 'Other',
            lastName: 'Person',
            email: 'other@example.com',
          },
        },
        ctx(fx.users.hrRecords!),
      );
      const otherDoc = await recruitment.candidates.addDocument(
        other.candidateId,
        {
          kind: 'RESUME',
          title: 'Other CV',
          provider: 'EXTERNAL_URL',
          externalUrl: 'https://x.test/cv',
        },
        ctx(fx.users.hrRecords!),
      );
      const hire = await recruitment.hires.convert(
        applicationId,
        {},
        ctx(fx.users.hrRecords!),
      );
      // Document access alone, or recruitment access alone, never moves candidate documents.
      expect(
        await failure(
          svc.documents.handoffFromRecruitment(
            hire.id,
            {
              documents: [
                { recruitmentDocumentId: resume.id, typeId: types['RESUME']! },
              ],
            },
            ctx(fx.users.restricted!),
          ),
        ),
      ).toMatchObject({ status: 404 });
      expect(
        await failure(
          svc.documents.handoffFromRecruitment(
            hire.id,
            {
              documents: [
                {
                  recruitmentDocumentId: otherDoc.id,
                  typeId: types['RESUME']!,
                },
              ],
            },
            ctx(fx.users.hrRecords!),
          ),
        ),
      ).toEqual({
        status: 400,
        code: 'DOCUMENT_HANDOFF_INVALID',
      });
      const first = await svc.documents.handoffFromRecruitment(
        hire.id,
        {
          documents: [
            { recruitmentDocumentId: resume.id, typeId: types['RESUME']! },
          ],
          offer: { typeId: types['OFFER-LETTER']! },
        },
        ctx(fx.users.hrRecords!),
      );
      expect(first.outcomes.map((o) => o.outcome)).toEqual([
        'CREATED',
        'CREATED',
      ]);
      const again = await svc.documents.handoffFromRecruitment(
        hire.id,
        {
          documents: [
            { recruitmentDocumentId: resume.id, typeId: types['RESUME']! },
          ],
          offer: { typeId: types['OFFER-LETTER']! },
        },
        ctx(fx.users.hrRecords!),
      );
      expect(again.outcomes.map((o) => o.outcome)).toEqual([
        'ALREADY_HANDED_OFF',
        'ALREADY_HANDED_OFF',
      ]);
      const handed = await tx.employeeDocument.findUniqueOrThrow({
        where: { id: first.outcomes[0]!.documentId },
        include: { versions: true },
      });
      expect(handed).toMatchObject({
        employeeId: hire.employeeId,
        source: 'RECRUITMENT_HANDOFF',
        recruitmentDocumentId: resume.id,
        recruitmentHireId: hire.id,
        confidentiality: 'HR_ONLY',
      });
      expect(handed.versions[0]).toMatchObject({
        provider: 'GOOGLE_DRIVE',
        externalFileId: 'cv-file',
      });
      // Nothing else of the candidate (other documents, notes) became an employee record.
      expect(
        await tx.employeeDocument.count({
          where: { employeeId: hire.employeeId },
        }),
      ).toBe(2);
    });
  });

  it('runs expiry digests and reference verification through registered sinks and adapters only', async () => {
    await scenario(async (tx, fx, svc, clock) => {
      const types = await initTypes(svc, fx);
      const doc = await svc.documents.create(
        {
          organizationId: fx.orgA,
          employeeId: fx.employee2,
          typeId: types['CERTIFICATION']!,
          title: 'First aid',
          version: drive('fa', '2026-03-20'),
        },
        ctx(fx.users.hrRecords!),
      );
      const client = rollbackClient(tx);
      const digests: unknown[] = [];
      const outcome = await sendExpiryReminders(
        client,
        [{ deliver: async (d) => void digests.push(...d) }],
        clock,
      );
      expect(outcome).toMatchObject({
        organizations: 1,
        expiringSoon: 1,
        expired: 0,
        delivered: 1,
      });
      expect(JSON.stringify(digests)).not.toMatch(/First aid|fa\.pdf/);
      expect(await verifyDocumentReferences(client, [], clock)).toMatchObject({
        checked: 0,
        skipped: 1,
      });
      const driveAdapter: DocumentStorageAdapter = {
        provider: 'GOOGLE_DRIVE',
        checkReference: async (ref) =>
          ref.externalFileId === 'fa' ? 'ACCESS_DENIED' : 'OK',
      };
      expect(
        await verifyDocumentReferences(client, [driveAdapter], clock),
      ).toMatchObject({ checked: 1, changed: 1, failed: [] });
      expect(
        (await svc.documents.detail(fx.users.hrRecords!, doc.id))
          .currentVersion,
      ).toMatchObject({ referenceStatus: 'ACCESS_DENIED' });
    });
  });
});

describe('Documents concurrency (committed data)', () => {
  let prisma: PrismaService;
  let fx: SchedulingFixtures;
  let svc: DocumentServices;
  let types: Record<string, string>;

  beforeAll(async () => {
    prisma = new PrismaService(process.env.DATABASE_URL!);
    await prisma.$connect();
    fx = await prisma.$transaction(
      (tx) => createSchedulingFixtures(tx, DOCUMENT_USERS),
      { timeout: 60_000 },
    );
    svc = documentServices(prisma, new FixedDocumentsClock());
    types = await initTypes(svc, fx);
  });

  afterAll(async () => {
    if (fx) await cleanupSchedulingFixtures(prisma, fx);
    await prisma?.$disconnect();
  });

  it('numbers concurrent new versions in sequence with one current version', async () => {
    const doc = await svc.documents.create(
      {
        organizationId: fx.orgA,
        employeeId: fx.employee2,
        typeId: types['EMPLOYMENT-AGREEMENT']!,
        title: 'Agreement',
        version: drive('agreement-1'),
      },
      ctx(fx.users.hrRecords!),
    );
    const results = await Promise.allSettled(
      [2, 3, 4, 5].map((n) =>
        svc.documents.addVersion(
          doc.id,
          drive(`agreement-${n}`),
          ctx(fx.users.hrRecords!),
        ),
      ),
    );
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    const versions = await prisma.employeeDocumentVersion.findMany({
      where: { documentId: doc.id },
      orderBy: { versionNumber: 'asc' },
    });
    expect(versions.map((v) => v.versionNumber)).toEqual([1, 2, 3, 4, 5]);
    expect(versions.filter((v) => v.supersededAt === null)).toHaveLength(1);
  });

  it('records one acknowledgement when the same version is acknowledged at once', async () => {
    const admin = ctx(fx.users.policyAdmin!);
    const policy = await svc.policies.create(
      {
        organizationId: fx.orgA,
        code: `tech-${fx.suffix}`,
        title: 'Technology use',
      },
      admin,
    );
    const version = (
      await svc.policies.createVersion(
        policy.id,
        {
          versionLabel: '1',
          provider: 'MANUAL_REFERENCE',
          acknowledgementStatement: 'I have read the technology use policy.',
        },
        admin,
      )
    ).versions[0]!;
    await svc.policies.publish(policy.id, version.id, admin);
    const results = await Promise.all(
      [0, 1, 2, 3].map(() =>
        svc.policies.acknowledge(
          policy.id,
          version.id,
          true,
          ctx(fx.selfUser1),
        ),
      ),
    );
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(results.map((r) => r.acknowledgementId)).size).toBe(1);
    expect(
      await prisma.documentAcknowledgement.count({
        where: { policyVersionId: version.id },
      }),
    ).toBe(1);
  });

  it('publishes replacement policy versions in sequence with one current version', async () => {
    const admin = ctx(fx.users.policyAdmin!);
    const policy = await svc.policies.create(
      {
        organizationId: fx.orgA,
        code: `conf-${fx.suffix}`,
        title: 'Confidentiality',
        acknowledgementRequired: false,
      },
      admin,
    );
    const draft = (
      await svc.policies.createVersion(
        policy.id,
        { versionLabel: '1', provider: 'MANUAL_REFERENCE' },
        admin,
      )
    ).versions[0]!;
    const results = await Promise.allSettled(
      [0, 1].map(() => svc.policies.publish(policy.id, draft.id, admin)),
    );
    expect(results.map((r) => r.status).sort()).toEqual([
      'fulfilled',
      'rejected',
    ]);
    const drafts = await Promise.allSettled(
      [0, 1].map((n) =>
        svc.policies.createVersion(
          policy.id,
          { versionLabel: `2-${n}`, provider: 'MANUAL_REFERENCE' },
          admin,
        ),
      ),
    );
    expect(drafts.map((r) => r.status).sort()).toEqual([
      'fulfilled',
      'rejected',
    ]);
    expect(
      await prisma.policyDocumentVersion.count({
        where: {
          policyId: policy.id,
          publishedAt: { not: null },
          supersededAt: null,
        },
      }),
    ).toBe(1);
  });
});
