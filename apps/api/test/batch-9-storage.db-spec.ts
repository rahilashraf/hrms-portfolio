import { config } from 'dotenv';
import { inspect } from 'node:util';
import { mkdtemp, readdir, readFile, readlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, type Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service.js';
import {
  attachStoredObject,
  type DocumentFileService,
} from '../src/documents/document-file.service.js';
import {
  DocumentObjectStore,
  LocalDocumentObjectStore,
  ObjectStoreError,
  type DocumentStorageSettings,
} from '../src/documents/document-object-store.js';
import type {
  DocumentMalwareScanner,
  ScanVerdict,
} from '../src/documents/document-scanner.js';
import {
  SAMPLE_JPEG,
  SAMPLE_PDF,
  SAMPLE_PNG,
} from '../src/documents/document-file-samples.js';
import {
  DOCUMENT_USERS,
  documentFileServices,
  documentServices,
  FixedDocumentsClock,
  multipartFile,
  type DocumentServices,
} from './support/documents-fixtures.js';
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

const SIGNING_KEY = 'batch-9-local-signing-key-for-tests-only-0123456789';

async function readAll(stream: Readable) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

async function initTypes(svc: DocumentServices, fx: SchedulingFixtures) {
  const { items } = await svc.types.initializeDefaults(
    fx.orgA,
    ctx(fx.users.typeAdmin!),
  );
  return Object.fromEntries(
    items.map((type) => [type.code, type.id]),
  ) as Record<string, string>;
}

/** A scanner whose verdict the test sets. */
class FakeScanner implements DocumentMalwareScanner {
  readonly name = 'fake';
  verdict: ScanVerdict | 'THROW' = 'CLEAN';
  async scan() {
    if (this.verdict === 'THROW') throw new Error('scanner down');
    return this.verdict;
  }
}

/** A store whose writes fail (a storage outage). */
class FailingStore extends DocumentObjectStore {
  readonly backend = 'local' as const;
  deleted: string[] = [];
  async put(): Promise<void> {
    throw new ObjectStoreError('DOCUMENT_STORAGE_UNAVAILABLE', 'down');
  }
  async head() {
    return null;
  }
  async delete(key: string) {
    this.deleted.push(key);
  }
  async downloadUrl(): Promise<{ url: string; expiresAt: Date }> {
    throw new Error('not reached');
  }
}

/**
 * Batch 9 — document files on the database: streamed uploads (content, size, interruption),
 * the server-owned ledger binding, idempotent retries, failed writes and transactions, the
 * confidentiality / organization matrix for download URLs (historical versions included, every
 * URL re-authorized), local URL expiry and tampering, scanner quarantine, cleanup safety under a
 * concurrent attach, concurrent version uploads, and policy files.
 */
describe('Batch 9 document storage (database)', () => {
  let prisma: PrismaService;
  let directory: string;
  let settings: DocumentStorageSettings;
  let store: LocalDocumentObjectStore;

  beforeAll(async () => {
    prisma = new PrismaService(process.env.DATABASE_URL!);
    await prisma.$connect();
    directory = await mkdtemp(join(tmpdir(), 'b9-db-store-'));
    store = new LocalDocumentObjectStore(directory, SIGNING_KEY);
    settings = { store, maxUploadBytes: 64 * 1024, requireMalwareScan: false };
  });
  afterAll(async () => {
    await prisma?.$disconnect();
    await rm(directory, { recursive: true, force: true });
  });

  async function scenario(
    run: (input: {
      tx: Tx;
      fx: SchedulingFixtures;
      svc: DocumentServices;
      files: DocumentFileService;
      clock: FixedDocumentsClock;
      types: Record<string, string>;
    }) => Promise<void>,
    options: {
      settings?: DocumentStorageSettings;
      scanner?: DocumentMalwareScanner;
    } = {},
  ) {
    await expect(
      prisma.$transaction(
        async (tx) => {
          const fx = await createSchedulingFixtures(tx, DOCUMENT_USERS);
          const clock = new FixedDocumentsClock();
          clock.value = new Date();
          const client = rollbackClient(tx);
          const svc = documentServices(client, clock);
          const files = documentFileServices(
            client,
            clock,
            options.settings ?? settings,
            options.scanner ?? null,
          );
          const types = await initTypes(svc, fx);
          await run({ tx, fx, svc, files, clock, types }).catch(
            (error: unknown) => {
              console.error('SCENARIO FAILURE', error);
              throw error;
            },
          );
          throw new RollbackFixtures();
        },
        { timeout: 120_000 },
      ),
    ).rejects.toBeInstanceOf(RollbackFixtures);
  }

  const upload = async (
    files: DocumentFileService,
    userId: string,
    target: Parameters<DocumentFileService['authorize']>[1],
    content: Buffer = SAMPLE_PDF,
    fileName = 'contract.pdf',
    options: { truncateAt?: number; field?: string } = {},
  ) =>
    files.receive(
      await files.authorize(userId, target),
      multipartFile(content, fileName, options),
      ctx(userId),
    );

  it('uploads a PDF to a record, downloads it by a 60-second URL, and keeps every version', async () => {
    await scenario(async ({ tx, fx, svc, files, types, clock }) => {
      const hr = fx.users.restricted!;
      const record = {
        kind: 'record' as const,
        organizationId: fx.orgA,
        employeeId: fx.employee1,
      };
      const first = await upload(
        files,
        hr,
        record,
        SAMPLE_PDF,
        '../../contract.pdf',
      );
      expect(first).toEqual({
        id: expect.any(String),
        fileName: 'contract.pdf',
        sizeBytes: SAMPLE_PDF.length,
        mimeType: 'application/pdf',
        scanStatus: 'NOT_SCANNED',
      });
      expect(JSON.stringify(first)).not.toContain('documents/');
      const doc = await svc.documents.create(
        {
          organizationId: fx.orgA,
          employeeId: fx.employee1,
          typeId: types['EMPLOYMENT-AGREEMENT']!,
          title: 'Employment agreement',
          confidentiality: 'EMPLOYEE_VISIBLE',
          version: { provider: 'INTERNAL_OBJECT_STORAGE', uploadId: first.id },
        },
        ctx(hr),
      );
      expect(doc.currentVersion).toMatchObject({
        provider: 'INTERNAL_OBJECT_STORAGE',
        fileName: 'contract.pdf',
        mimeType: 'application/pdf',
        sizeBytes: SAMPLE_PDF.length,
        legacyReference: false,
        file: {
          fileName: 'contract.pdf',
          mimeType: 'application/pdf',
          scanStatus: 'NOT_SCANNED',
          downloadable: true,
        },
      });
      expect(JSON.stringify(doc)).not.toMatch(/documents\/[0-9a-f-]{36}\//);
      const ledger = await tx.documentStoredObject.findUniqueOrThrow({
        where: { id: first.id },
      });
      expect(ledger).toMatchObject({
        status: 'ATTACHED',
        organizationId: fx.orgA,
        purpose: 'EMPLOYEE_DOCUMENT',
        employeeId: fx.employee1,
        storageKey: `documents/${fx.orgA}/${first.id}`,
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
      // The employee downloads it (EMPLOYEE_VISIBLE), through a URL valid 60 seconds.
      const issued = await files.employeeVersionUrl(
        fx.selfUser1,
        doc.id,
        doc.currentVersion!.id,
        ctx(fx.selfUser1),
      );
      expect(new Date(issued.expiresAt).getTime() - clock.now().getTime()).toBe(
        60_000,
      );
      expect(issued.url).toMatch(/^\/documents\/files\/[\w-]+\.[\w-]+$/);
      const token = issued.url.split('/').pop()!;
      const downloaded = await files.localDownload(token);
      expect(await readAll(downloaded.stream)).toEqual(SAMPLE_PDF);
      expect(downloaded.headers).toMatchObject({
        'Content-Type': 'application/pdf',
        'Content-Disposition': expect.stringMatching(
          /^attachment; filename="contract.pdf"/,
        ),
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
      });
      // Audited without the URL, key or name.
      const audits = await tx.auditLog.findMany({
        where: {
          action: {
            in: ['DOCUMENT_FILE_UPLOADED', 'DOCUMENT_FILE_URL_ISSUED'],
          },
          entityId: { in: [first.id, doc.id] },
        },
      });
      expect(audits.map((a) => a.action).sort()).toEqual([
        'DOCUMENT_FILE_UPLOADED',
        'DOCUMENT_FILE_URL_ISSUED',
      ]);
      const auditText = JSON.stringify(audits);
      expect(auditText).not.toContain(token);
      expect(auditText).not.toContain('documents/');
      expect(auditText).not.toContain('contract.pdf');
      // A new version (PNG) keeps the first; the old version still downloads.
      const second = await upload(
        files,
        hr,
        { kind: 'version', documentId: doc.id },
        SAMPLE_PNG,
        'scan.png',
      );
      const versioned = await svc.documents.addVersion(
        doc.id,
        { provider: 'INTERNAL_OBJECT_STORAGE', uploadId: second.id },
        ctx(hr),
      );
      expect(
        versioned.versions.map((v) => [v.versionNumber, v.mimeType, v.current]),
      ).toEqual([
        [2, 'image/png', true],
        [1, 'application/pdf', false],
      ]);
      const old = await files.employeeVersionUrl(
        hr,
        doc.id,
        versioned.versions[1]!.id,
        ctx(hr),
      );
      expect(
        await readAll(
          (await files.localDownload(old.url.split('/').pop()!)).stream,
        ),
      ).toEqual(SAMPLE_PDF);
      // Objects are immutable at the database level.
      expect(
        await violation(tx, () =>
          tx.documentStoredObject.update({
            where: { id: first.id },
            data: { status: 'ABANDONED', abandonedAt: new Date() },
          }),
        ),
      ).toSatisfy((error: unknown) =>
        /Invalid stored-object status change/.test(
          inspect(error, { depth: 8 }),
        ),
      );
      expect(
        await violation(tx, () =>
          tx.documentStoredObject.update({
            where: { id: first.id },
            data: { sha256: 'a'.repeat(64) },
          }),
        ),
      ).toSatisfy((error: unknown) =>
        /never change/.test(inspect(error, { depth: 8 })),
      );
      expect(
        await violation(tx, () =>
          tx.employeeDocumentVersion.update({
            where: { id: versioned.versions[1]!.id },
            data: { storedObjectId: second.id },
          }),
        ),
      ).toBeTruthy();
    });
  });

  it('enforces confidentiality, scope and organization on every download URL, historical versions included', async () => {
    await scenario(async ({ fx, svc, files, types }) => {
      const hr = fx.users.restricted!;
      const record = {
        kind: 'record' as const,
        organizationId: fx.orgA,
        employeeId: fx.employee1,
      };
      const up = await upload(files, hr, record);
      const doc = await svc.documents.create(
        {
          organizationId: fx.orgA,
          employeeId: fx.employee1,
          typeId: types['CERTIFICATION']!,
          title: 'Certification',
          confidentiality: 'EMPLOYEE_VISIBLE',
          version: {
            provider: 'INTERNAL_OBJECT_STORAGE',
            uploadId: up.id,
            expiresOn: '2030-01-01',
          },
        },
        ctx(hr),
      );
      const v1 = doc.currentVersion!.id;
      const can = async (userId: string, versionId = v1) =>
        files.employeeVersionUrl(userId, doc.id, versionId, ctx(userId)).then(
          () => 200,
          (error: { getStatus?: () => number }) => error.getStatus?.() ?? 500,
        );
      // EMPLOYEE_VISIBLE: the employee, readers in scope; not another organization.
      expect(await can(fx.selfUser1)).toBe(200);
      expect(await can(fx.users.reader!)).toBe(200);
      expect(await can(fx.users.orgBAdmin!)).toBe(404);
      // Employee 1 also works in Dept B (a second assignment): its reader reaches them.
      expect(await can(fx.users.deptBReader!)).toBe(200);
      // HR_ONLY: the employee and plain readers lose access — for every version.
      await svc.documents.update(
        doc.id,
        { confidentiality: 'HR_ONLY' },
        ctx(hr),
      );
      const up2 = await upload(files, hr, {
        kind: 'version',
        documentId: doc.id,
      });
      const v2 = (
        await svc.documents.addVersion(
          doc.id,
          {
            provider: 'INTERNAL_OBJECT_STORAGE',
            uploadId: up2.id,
            expiresOn: '2031-01-01',
          },
          ctx(hr),
        )
      ).currentVersion!.id;
      for (const versionId of [v1, v2]) {
        expect(await can(fx.selfUser1, versionId)).toBe(404);
        expect(await can(fx.users.reader!, versionId)).toBe(404);
        expect(await can(fx.users.teamRecords!, versionId)).toBe(404);
        expect(await can(fx.users.hrRecords!, versionId)).toBe(200);
      }
      // RESTRICTED: only restricted readers.
      await svc.documents.update(
        doc.id,
        { confidentiality: 'RESTRICTED' },
        ctx(hr),
      );
      expect(await can(fx.users.hrRecords!)).toBe(404);
      expect(await can(hr)).toBe(200);
      // A version of another document is not found through this one.
      const other = await upload(files, hr, record);
      const otherDoc = await svc.documents.create(
        {
          organizationId: fx.orgA,
          employeeId: fx.employee1,
          typeId: types['OTHER']!,
          title: 'Other',
          version: { provider: 'INTERNAL_OBJECT_STORAGE', uploadId: other.id },
        },
        ctx(hr),
      );
      expect(
        await failure(
          files.employeeVersionUrl(
            hr,
            doc.id,
            otherDoc.currentVersion!.id,
            ctx(hr),
          ),
        ),
      ).toMatchObject({ status: 404 });
      // Access revoked: a new URL is refused (an issued one only lives 60 seconds).
      await svc.documents.update(
        doc.id,
        { confidentiality: 'EMPLOYEE_VISIBLE' },
        ctx(hr),
      );
      expect(await can(fx.selfUser1)).toBe(200);
      await svc.documents.update(
        doc.id,
        { confidentiality: 'MANAGER_VISIBLE' },
        ctx(hr),
      );
      expect(await can(fx.selfUser1)).toBe(404);
      // Links and manual references are not stored files.
      const link = await svc.documents.create(
        {
          organizationId: fx.orgA,
          employeeId: fx.employee1,
          typeId: types['OTHER']!,
          title: 'Link',
          version: {
            provider: 'EXTERNAL_URL',
            externalUrl: 'https://example.com/x.pdf',
          },
        },
        ctx(hr),
      );
      expect(
        await failure(
          files.employeeVersionUrl(
            hr,
            link.id,
            link.currentVersion!.id,
            ctx(hr),
          ),
        ),
      ).toEqual({ status: 409, code: 'DOCUMENT_NOT_A_STORED_FILE' });
    });
  });

  it('refuses wrong types, disguised, truncated, oversized, empty and interrupted uploads before storing anything', async () => {
    await scenario(async ({ tx, fx, files }) => {
      const hr = fx.users.restricted!;
      const record = {
        kind: 'record' as const,
        organizationId: fx.orgA,
        employeeId: fx.employee1,
      };
      const before = await tx.documentStoredObject.count({
        where: { organizationId: fx.orgA },
      });
      const cases: Array<[Buffer, string, object, number, string]> = [
        [
          Buffer.from('<html><script>alert(1)</script></html>'),
          'x.pdf',
          {},
          415,
          'DOCUMENT_FILE_TYPE_NOT_ALLOWED',
        ],
        [
          Buffer.from('MZ\u0090\u0000 not a pdf'),
          'invoice.pdf',
          {},
          415,
          'DOCUMENT_FILE_TYPE_NOT_ALLOWED',
        ],
        [
          SAMPLE_PDF.subarray(0, 20),
          'cut.pdf',
          {},
          400,
          'DOCUMENT_FILE_MALFORMED',
        ],
        [SAMPLE_PNG, 'photo.pdf', {}, 415, 'DOCUMENT_FILE_TYPE_MISMATCH'],
        [
          Buffer.concat([SAMPLE_PDF, Buffer.alloc(70 * 1024)]),
          'big.pdf',
          {},
          413,
          'DOCUMENT_FILE_TOO_LARGE',
        ],
        [Buffer.alloc(0), 'empty.pdf', {}, 400, 'DOCUMENT_FILE_EMPTY'],
        [
          SAMPLE_PDF,
          'x.pdf',
          { truncateAt: 120 },
          400,
          'DOCUMENT_UPLOAD_INTERRUPTED',
        ],
        [
          SAMPLE_PDF,
          'x.pdf',
          { field: 'other' },
          400,
          'DOCUMENT_UPLOAD_INVALID',
        ],
      ];
      for (const [content, name, options, status, code] of cases)
        expect(
          await failure(upload(files, hr, record, content, name, options)),
          code,
        ).toEqual({ status, code });
      expect(
        await tx.documentStoredObject.count({
          where: { organizationId: fx.orgA },
        }),
      ).toBe(before);
      // JPEG is accepted.
      expect(
        (await upload(files, hr, record, SAMPLE_JPEG, 'id.jpg')).mimeType,
      ).toBe('image/jpeg');
    });
  });

  it('authorizes before reading the file and binds an upload to its user, organization and target', async () => {
    await scenario(async ({ fx, svc, files, types }) => {
      const hr = fx.users.restricted!;
      const record = {
        kind: 'record' as const,
        organizationId: fx.orgA,
        employeeId: fx.employee1,
      };
      // Not authorized: refused before any byte is read.
      expect(
        await failure(files.authorize(fx.users.orgBAdmin!, record)),
      ).toMatchObject({ status: 404 });
      expect(
        await failure(files.authorize(fx.users.reader!, record)),
      ).toMatchObject({ status: 403 });
      expect(
        await failure(files.authorize(fx.selfUser1, record)),
      ).toMatchObject({ status: 403, code: 'DOCUMENT_SELF_MANAGEMENT' });
      expect(
        await failure(
          files.authorize(hr, {
            kind: 'version',
            documentId: '00000000-0000-4000-8000-000000000001',
          }),
        ),
      ).toMatchObject({ status: 404 });
      const up = await upload(files, hr, record);
      const create = (
        userId: string,
        uploadId: string,
        employeeId = fx.employee1,
      ) =>
        svc.documents.create(
          {
            organizationId: fx.orgA,
            employeeId,
            typeId: types['OTHER']!,
            title: 'x',
            version: { provider: 'INTERNAL_OBJECT_STORAGE', uploadId },
          },
          ctx(userId),
        );
      // Another user cannot use it; nor for another employee.
      expect(await failure(create(fx.users.hrRecords!, up.id))).toEqual({
        status: 400,
        code: 'DOCUMENT_UPLOAD_INVALID',
      });
      expect(await failure(create(hr, up.id, fx.employee2))).toEqual({
        status: 400,
        code: 'DOCUMENT_UPLOAD_INVALID',
      });
      expect(
        await failure(create(hr, '00000000-0000-4000-8000-000000000002')),
      ).toEqual({ status: 400, code: 'DOCUMENT_UPLOAD_INVALID' });
      // A retry of the same request returns the same document (no second version).
      const doc = await create(hr, up.id);
      const again = await create(hr, up.id);
      expect(again.id).toBe(doc.id);
      expect(again.versions).toHaveLength(1);
      // The same upload is never attached to another document.
      const versionTarget = await upload(files, hr, {
        kind: 'version',
        documentId: doc.id,
      });
      expect(await failure(create(hr, versionTarget.id))).toEqual({
        status: 400,
        code: 'DOCUMENT_UPLOAD_INVALID',
      });
      // An employee's own upload (self service) only for their own provided documents.
      // An employee never versions an HR record (here HR_ONLY: not even visible to them).
      expect(
        await failure(
          files.authorize(fx.selfUser1, {
            kind: 'version',
            documentId: doc.id,
          }),
        ),
      ).toMatchObject({ status: 404 });
    });
  });

  it('employee self-service: uploads while EMPLOYEE_VISIBLE, refused once HR reclassified (F1)', async () => {
    await scenario(async ({ fx, svc, files, types }) => {
      const mine = await upload(
        files,
        fx.selfUser1,
        { kind: 'self', organizationId: fx.orgA },
        SAMPLE_JPEG,
        'cert.jpg',
      );
      const doc = await svc.documents.provide(
        {
          organizationId: fx.orgA,
          typeId: types['CERTIFICATION']!,
          title: 'First aid',
          version: {
            provider: 'INTERNAL_OBJECT_STORAGE',
            uploadId: mine.id,
            expiresOn: '2030-01-01',
          },
        },
        ctx(fx.selfUser1),
      );
      expect(doc.currentVersion?.file).toMatchObject({
        mimeType: 'image/jpeg',
        downloadable: true,
      });
      const renew = await upload(files, fx.selfUser1, {
        kind: 'version',
        documentId: doc.id,
      });
      await svc.documents.addVersion(
        doc.id,
        {
          provider: 'INTERNAL_OBJECT_STORAGE',
          uploadId: renew.id,
          expiresOn: '2031-01-01',
        },
        ctx(fx.selfUser1),
      );
      // HR uses the employee's self-service upload? Never (bound to the uploader and purpose).
      const third = await upload(files, fx.selfUser1, {
        kind: 'version',
        documentId: doc.id,
      });
      expect(
        await failure(
          svc.documents.addVersion(
            doc.id,
            {
              provider: 'INTERNAL_OBJECT_STORAGE',
              uploadId: third.id,
              expiresOn: '2031-01-01',
            },
            ctx(fx.users.restricted!),
          ),
        ),
      ).toEqual({ status: 400, code: 'DOCUMENT_UPLOAD_INVALID' });
      await svc.documents.update(
        doc.id,
        { confidentiality: 'HR_ONLY' },
        ctx(fx.users.restricted!),
      );
      expect(
        await failure(
          files.authorize(fx.selfUser1, {
            kind: 'version',
            documentId: doc.id,
          }),
        ),
      ).toMatchObject({ status: 404 });
      expect(
        await failure(
          files.employeeVersionUrl(
            fx.selfUser1,
            doc.id,
            doc.currentVersion!.id,
            ctx(fx.selfUser1),
          ),
        ),
      ).toMatchObject({ status: 404 });
      // An upload made before the reclassification cannot be attached either.
      expect(
        await failure(
          svc.documents.addVersion(
            doc.id,
            {
              provider: 'INTERNAL_OBJECT_STORAGE',
              uploadId: third.id,
              expiresOn: '2031-01-01',
            },
            ctx(fx.selfUser1),
          ),
        ),
      ).toMatchObject({ status: 404 });
    });
  });

  it('handles a failed storage write and a failed database step without orphaning anything', async () => {
    const failing = new FailingStore();
    await scenario(
      async ({ tx, fx, files }) => {
        const record = {
          kind: 'record' as const,
          organizationId: fx.orgA,
          employeeId: fx.employee1,
        };
        expect(
          await failure(upload(files, fx.users.restricted!, record)),
        ).toEqual({
          status: 503,
          code: 'DOCUMENT_STORAGE_UNAVAILABLE',
        });
        const rows = await tx.documentStoredObject.findMany({
          where: { organizationId: fx.orgA },
        });
        expect(rows.map((row) => row.status)).toEqual(['DELETED']);
        expect(failing.deleted).toEqual([rows[0]!.storageKey]);
      },
      {
        settings: {
          store: failing,
          maxUploadBytes: 64 * 1024,
          requireMalwareScan: false,
        },
      },
    );
    await scenario(async ({ tx, fx, svc, files, types, clock }) => {
      const hr = fx.users.restricted!;
      const up = await upload(files, hr, {
        kind: 'record',
        organizationId: fx.orgA,
        employeeId: fx.employee1,
      });
      // The record creation fails (an expiry-tracked type without an expiry): the transaction
      // rolls back, the object stays STORED (never attached) and the cleanup removes it later.
      expect(
        await failure(
          svc.documents.create(
            {
              organizationId: fx.orgA,
              employeeId: fx.employee1,
              typeId: types['CERTIFICATION']!,
              title: 'x',
              version: { provider: 'INTERNAL_OBJECT_STORAGE', uploadId: up.id },
            },
            ctx(hr),
          ),
        ),
      ).toMatchObject({ status: 400, code: 'DOCUMENT_EXPIRY_REQUIRED' });
      const row = await tx.documentStoredObject.findUniqueOrThrow({
        where: { id: up.id },
      });
      expect(row.status).toBe('STORED');
      expect(await store.head(row.storageKey)).not.toBeNull();
      // Too recent: kept.
      expect(await files.cleanupAbandoned()).toMatchObject({
        abandoned: 0,
        deleted: 0,
      });
      clock.value = new Date(clock.value.getTime() + 25 * 3_600_000);
      expect(await files.cleanupAbandoned()).toMatchObject({
        abandoned: 1,
        deleted: 1,
      });
      expect(
        await tx.documentStoredObject.findUniqueOrThrow({
          where: { id: up.id },
        }),
      ).toMatchObject({
        status: 'DELETED',
      });
      expect(await store.head(row.storageKey)).toBeNull();
      // Re-using it now: refused (upload again).
      expect(
        await failure(
          svc.documents.create(
            {
              organizationId: fx.orgA,
              employeeId: fx.employee1,
              typeId: types['OTHER']!,
              title: 'x',
              version: { provider: 'INTERNAL_OBJECT_STORAGE', uploadId: up.id },
            },
            ctx(hr),
          ),
        ),
      ).toEqual({ status: 409, code: 'DOCUMENT_UPLOAD_EXPIRED' });
    });
  });

  it('quarantines uploads under a scanner: infected refused, pending not downloadable until clean, scanner errors store nothing', async () => {
    const scanner = new FakeScanner();
    await scenario(
      async ({ tx, fx, svc, files, types }) => {
        const hr = fx.users.restricted!;
        const record = {
          kind: 'record' as const,
          organizationId: fx.orgA,
          employeeId: fx.employee1,
        };
        scanner.verdict = 'INFECTED';
        expect(await failure(upload(files, hr, record))).toEqual({
          status: 422,
          code: 'DOCUMENT_FILE_INFECTED',
        });
        const rejected = await tx.documentStoredObject.findFirstOrThrow({
          where: { organizationId: fx.orgA },
        });
        expect(rejected).toMatchObject({
          status: 'REJECTED',
          scanStatus: 'INFECTED',
        });
        expect(await store.head(rejected.storageKey)).toBeNull();
        scanner.verdict = 'THROW';
        expect(await failure(upload(files, hr, record))).toEqual({
          status: 503,
          code: 'DOCUMENT_SCAN_UNAVAILABLE',
        });
        scanner.verdict = 'PENDING';
        const pending = await upload(files, hr, record);
        expect(pending.scanStatus).toBe('PENDING');
        const doc = await svc.documents.create(
          {
            organizationId: fx.orgA,
            employeeId: fx.employee1,
            typeId: types['OTHER']!,
            title: 'Pending scan',
            version: {
              provider: 'INTERNAL_OBJECT_STORAGE',
              uploadId: pending.id,
            },
          },
          ctx(hr),
        );
        expect(doc.currentVersion?.file).toMatchObject({
          scanStatus: 'PENDING',
          downloadable: false,
        });
        expect(
          await failure(
            files.employeeVersionUrl(
              hr,
              doc.id,
              doc.currentVersion!.id,
              ctx(hr),
            ),
          ),
        ).toEqual({
          status: 409,
          code: 'DOCUMENT_FILE_QUARANTINED',
        });
        expect(await files.recordScanResult(pending.id, 'CLEAN')).toEqual({
          updated: true,
        });
        expect(await files.recordScanResult(pending.id, 'INFECTED')).toEqual({
          updated: false,
        });
        await files.employeeVersionUrl(
          hr,
          doc.id,
          doc.currentVersion!.id,
          ctx(hr),
        );
        scanner.verdict = 'CLEAN';
        expect((await upload(files, hr, record)).scanStatus).toBe('CLEAN');
      },
      { scanner },
    );
    // Scanning required but no scanner: uploads refused.
    await scenario(
      async ({ fx, files }) => {
        expect(
          await failure(
            files.authorize(fx.users.restricted!, {
              kind: 'record',
              organizationId: fx.orgA,
              employeeId: fx.employee1,
            }),
          ),
        ).toEqual({ status: 503, code: 'DOCUMENT_SCAN_REQUIRED' });
      },
      { settings: { ...settings, requireMalwareScan: true } },
    );
  });

  it('refuses expired, tampered and foreign local download tokens', async () => {
    await scenario(async ({ fx, svc, files, types, clock }) => {
      const hr = fx.users.restricted!;
      const up = await upload(files, hr, {
        kind: 'record',
        organizationId: fx.orgA,
        employeeId: fx.employee1,
      });
      const doc = await svc.documents.create(
        {
          organizationId: fx.orgA,
          employeeId: fx.employee1,
          typeId: types['OTHER']!,
          title: 'x',
          version: { provider: 'INTERNAL_OBJECT_STORAGE', uploadId: up.id },
        },
        ctx(hr),
      );
      const { url } = await files.employeeVersionUrl(
        hr,
        doc.id,
        doc.currentVersion!.id,
        ctx(hr),
      );
      const token = url.split('/').pop()!;
      await files.localDownload(token);
      const [payload, mac] = token.split('.');
      for (const bad of [
        `${payload}.${mac!.slice(0, -2)}AA`,
        `${payload}x.${mac}`,
        'nonsense',
        `${token}.x`,
      ])
        expect(await failure(files.localDownload(bad))).toMatchObject({
          status: 404,
        });
      clock.value = new Date(clock.value.getTime() + 61_000);
      expect(await failure(files.localDownload(token))).toMatchObject({
        status: 404,
      });
      // A token signed with another key is refused.
      const other = new LocalDocumentObjectStore(
        directory,
        'another-signing-key-of-sufficient-length-000',
      );
      const foreign = (
        await other.downloadUrl({
          objectId: up.id,
          key: `documents/${fx.orgA}/${up.id}`,
          fileName: 'x',
          contentType: 'application/pdf',
          now: clock.now(),
        })
      ).url
        .split('/')
        .pop()!;
      expect(await failure(files.localDownload(foreign))).toMatchObject({
        status: 404,
      });
    });
  });

  it('policy files: managers download drafts; readers and the audience only published versions', async () => {
    await scenario(async ({ fx, svc, files }) => {
      const manager = fx.users.policyAdmin!;
      const policy = await svc.policies.create(
        { organizationId: fx.orgA, code: 'HANDBOOK', title: 'Handbook' },
        ctx(manager),
      );
      const up = await upload(files, manager, {
        kind: 'policy',
        policyId: policy.id,
      });
      expect(
        await failure(
          files.authorize(fx.users.reader!, {
            kind: 'policy',
            policyId: policy.id,
          }),
        ),
      ).toMatchObject({ status: 403 });
      expect(
        await failure(
          files.authorize(fx.users.orgBAdmin!, {
            kind: 'policy',
            policyId: policy.id,
          }),
        ),
      ).toMatchObject({ status: 404 });
      const drafted = await svc.policies.createVersion(
        policy.id,
        {
          versionLabel: '2026',
          provider: 'INTERNAL_OBJECT_STORAGE',
          uploadId: up.id,
          acknowledgementStatement: 'I have read the handbook.',
        },
        ctx(manager),
      );
      const version = drafted.versions[0]!;
      expect(version).toMatchObject({
        provider: 'INTERNAL_OBJECT_STORAGE',
        sizeBytes: SAMPLE_PDF.length,
        file: { downloadable: true },
      });
      const status = (userId: string) =>
        files.policyVersionUrl(userId, policy.id, version.id, ctx(userId)).then(
          () => 200,
          (error: { getStatus?: () => number }) => error.getStatus?.() ?? 500,
        );
      expect(await status(manager)).toBe(200);
      // Employee 2 (no document permission, in the policy's audience).
      expect(await status(fx.selfUser2)).toBe(404);
      expect(await status(fx.users.reader!)).toBe(404);
      await svc.policies.publish(policy.id, version.id, ctx(manager));
      expect(await status(fx.selfUser2)).toBe(200);
      expect(await status(fx.users.reader!)).toBe(200);
      expect(await status(fx.users.orgBAdmin!)).toBe(404);
    });
  });

  it('review fixes: retries never leak a reclassified record; policy retries are idempotent; retired policies stay with managers', async () => {
    await scenario(async ({ fx, svc, files, types }) => {
      const restricted = fx.users.restricted!;
      // Self-service retry after HR reclassified the provided document: 404, nothing returned.
      const mine = await upload(
        files,
        fx.selfUser1,
        { kind: 'self', organizationId: fx.orgA },
        SAMPLE_JPEG,
        'cert.jpg',
      );
      const provide = () =>
        svc.documents.provide(
          {
            organizationId: fx.orgA,
            typeId: types['CERTIFICATION']!,
            title: 'First aid',
            version: {
              provider: 'INTERNAL_OBJECT_STORAGE',
              uploadId: mine.id,
              expiresOn: '2030-01-01',
            },
          },
          ctx(fx.selfUser1),
        );
      const provided = await provide();
      expect((await provide()).id).toBe(provided.id);
      await svc.documents.update(
        provided.id,
        { confidentiality: 'HR_ONLY', description: 'HR note' },
        ctx(restricted),
      );
      const leaked = await failure(provide());
      expect(leaked).toMatchObject({ status: 404 });
      expect(JSON.stringify(leaked)).not.toContain('HR note');

      // HR create retry after someone raised the record above the creator's clearance: 404.
      const hrUp = await upload(files, fx.users.hrRecords!, {
        kind: 'record',
        organizationId: fx.orgA,
        employeeId: fx.employee1,
      });
      const create = () =>
        svc.documents.create(
          {
            organizationId: fx.orgA,
            employeeId: fx.employee1,
            typeId: types['EMPLOYMENT-AGREEMENT']!,
            title: 'Agreement',
            confidentiality: 'HR_ONLY',
            version: { provider: 'INTERNAL_OBJECT_STORAGE', uploadId: hrUp.id },
          },
          ctx(fx.users.hrRecords!),
        );
      const created = await create();
      expect((await create()).id).toBe(created.id);
      await svc.documents.update(
        created.id,
        { confidentiality: 'RESTRICTED' },
        ctx(restricted),
      );
      expect(await failure(create())).toMatchObject({ status: 404 });

      // A policy version save retried with the same upload returns the same draft (no 409).
      const manager = fx.users.policyAdmin!;
      const policy = await svc.policies.create(
        {
          organizationId: fx.orgA,
          code: 'RETRY',
          title: 'Retry policy',
          acknowledgementRequired: false,
        },
        ctx(manager),
      );
      const pUp = await upload(files, manager, {
        kind: 'policy',
        policyId: policy.id,
      });
      const draft = () =>
        svc.policies.createVersion(
          policy.id,
          {
            versionLabel: '1',
            provider: 'INTERNAL_OBJECT_STORAGE',
            uploadId: pUp.id,
          },
          ctx(manager),
        );
      const first = await draft();
      const second = await draft();
      expect(second.versions.map((v) => v.id)).toEqual(
        first.versions.map((v) => v.id),
      );
      // Another draft (a different upload) is still refused while one is pending.
      const other = await upload(files, manager, {
        kind: 'policy',
        policyId: policy.id,
      });
      expect(
        await failure(
          svc.policies.createVersion(
            policy.id,
            {
              versionLabel: '2',
              provider: 'INTERNAL_OBJECT_STORAGE',
              uploadId: other.id,
            },
            ctx(manager),
          ),
        ),
      ).toMatchObject({ status: 409 });

      // Retired policies: only managers download their published versions.
      const versionId = first.versions[0]!.id;
      await svc.policies.publish(policy.id, versionId, ctx(manager));
      const status = (userId: string) =>
        files.policyVersionUrl(userId, policy.id, versionId, ctx(userId)).then(
          () => 200,
          (error: { getStatus?: () => number }) => error.getStatus?.() ?? 500,
        );
      expect(await status(fx.users.reader!)).toBe(200);
      await svc.policies.retire(policy.id, ctx(manager));
      expect(await status(fx.users.reader!)).toBe(404);
      expect(await status(fx.selfUser2)).toBe(404);
      expect(await status(manager)).toBe(200);
    });
  });

  it('final review N3: the database binds a stored object to its own employee, document or policy', async () => {
    await scenario(async ({ tx, fx, svc, files, types }) => {
      const hr = fx.users.restricted!;
      const manager = fx.users.policyAdmin!;
      /** An upload marked attached directly (bypassing the application's binding check). */
      const attachedObject = async (
        userId: string,
        target: Parameters<DocumentFileService['authorize']>[1],
      ) => {
        const up = await upload(files, userId, target);
        return tx.documentStoredObject.update({
          where: { id: up.id },
          data: { status: 'ATTACHED', attachedAt: new Date() },
        });
      };
      /** Inserts the next version straight into the table (the caller wraps it in a savepoint). */
      const insertVersion = (
        documentId: string,
        object: { id: string; storageKey: string },
      ) =>
        tx.employeeDocumentVersion
          .updateMany({
            where: { documentId, supersededAt: null },
            data: { supersededAt: new Date() },
          })
          .then(() =>
            tx.employeeDocumentVersion.create({
              data: {
                documentId,
                versionNumber: 2,
                provider: 'INTERNAL_OBJECT_STORAGE',
                storageKey: object.storageKey,
                storedObjectId: object.id,
              },
            }),
          );
      const refused = (error: unknown) =>
        /not attached to this organization's version/.test(
          inspect(error, { depth: 8 }),
        );
      const doc = await svc.documents.create(
        {
          organizationId: fx.orgA,
          employeeId: fx.employee1,
          typeId: types['EMPLOYMENT-AGREEMENT']!,
          title: 'Agreement',
          version: {
            provider: 'EXTERNAL_URL',
            externalUrl: 'https://docs.example.org/a',
          },
        },
        ctx(hr),
      );
      // Uploaded for another employee: refused for employee 1's document.
      const otherEmployee = await attachedObject(hr, {
        kind: 'record',
        organizationId: fx.orgA,
        employeeId: fx.employee2,
      });
      expect(
        await violation(tx, () => insertVersion(doc.id, otherEmployee)),
      ).toSatisfy(refused);
      // Uploaded for another document of the same employee: refused.
      const otherDoc = await svc.documents.create(
        {
          organizationId: fx.orgA,
          employeeId: fx.employee1,
          typeId: types['EMPLOYMENT-AGREEMENT']!,
          title: 'Other',
          version: {
            provider: 'EXTERNAL_URL',
            externalUrl: 'https://docs.example.org/b',
          },
        },
        ctx(hr),
      );
      const forOtherDoc = await attachedObject(hr, {
        kind: 'version',
        documentId: otherDoc.id,
      });
      expect(
        await violation(tx, () => insertVersion(doc.id, forOtherDoc)),
      ).toSatisfy(refused);
      // Uploaded for another policy: refused for this policy's version.
      const policyA = await svc.policies.create(
        { organizationId: fx.orgA, code: 'N3-A', title: 'A' },
        ctx(manager),
      );
      const policyB = await svc.policies.create(
        { organizationId: fx.orgA, code: 'N3-B', title: 'B' },
        ctx(manager),
      );
      const forPolicyA = await attachedObject(manager, {
        kind: 'policy',
        policyId: policyA.id,
      });
      expect(
        await violation(tx, () =>
          tx.policyDocumentVersion.create({
            data: {
              policyId: policyB.id,
              organizationId: fx.orgA,
              versionNumber: 1,
              versionLabel: 'x',
              provider: 'INTERNAL_OBJECT_STORAGE',
              storageKey: forPolicyA.storageKey,
              storedObjectId: forPolicyA.id,
            },
          }),
        ),
      ).toSatisfy(refused);
      // The matching owner is accepted (the application path, covered above, is unchanged).
      const own = await attachedObject(hr, {
        kind: 'version',
        documentId: doc.id,
      });
      await tx.$executeRawUnsafe('SAVEPOINT n3_ok');
      await expect(insertVersion(doc.id, own)).resolves.toMatchObject({
        storedObjectId: own.id,
      });
      await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT n3_ok');
    });
  });

  it('final review fix: a request closed early (before, during or after the file part) settles, closes every handle and leaves nothing', async () => {
    const previous = process.env.TMPDIR;
    const temp = await mkdtemp(join(tmpdir(), 'b9-race-'));
    process.env.TMPDIR = temp;
    const handlesUnder = async () => {
      const found: string[] = [];
      for (const fd of await readdir('/proc/self/fd')) {
        const target = await readlink(`/proc/self/fd/${fd}`).catch(() => '');
        if (target.startsWith(temp)) found.push(target);
      }
      return found;
    };
    try {
      await scenario(async ({ fx, files, tx }) => {
        const hr = fx.users.restricted!;
        const target = {
          kind: 'record' as const,
          organizationId: fx.orgA,
          employeeId: fx.employee1,
        };
        const boundary = 'b9racebound';
        const headers = {
          'content-type': `multipart/form-data; boundary=${boundary}`,
          'content-length': String(64 * 1024),
        };
        const partHead = Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.pdf"\r\nContent-Type: application/pdf\r\n\r\n`,
        );
        const partial = Buffer.concat([
          Buffer.from('%PDF-1.4\n'),
          Buffer.alloc(16 * 1024, 0x41),
        ]);
        /**
         * Feeds `chunks`, then ends the request the way a dropped connection does (destroyed:
         * 'close' without 'end'), optionally with an error. Never hangs: 5 s at most.
         */
        const attempt = async (
          chunks: Buffer[],
          close: 'before' | 'sync' | 'tick' | 'after-data' | 'error',
        ) => {
          const stream = new PassThrough();
          if (close === 'before') stream.destroy();
          const authorized = await files.authorize(hr, target);
          const pending = files.receive(
            authorized,
            { headers, stream },
            ctx(hr),
          );
          for (const chunk of chunks) stream.write(chunk);
          if (close === 'sync') stream.destroy();
          if (close === 'tick') setImmediate(() => stream.destroy());
          if (close === 'after-data') setTimeout(() => stream.destroy(), 50);
          if (close === 'error')
            setTimeout(() => stream.destroy(new Error('socket reset')), 50);
          const outcome = await Promise.race([
            pending.then(
              () => 'resolved',
              (error: {
                getStatus?: () => number;
                getResponse?: () => unknown;
              }) =>
                `${error.getStatus?.() ?? 'raw'} ${JSON.stringify(error.getResponse?.() ?? {})}`,
            ),
            new Promise<string>((resolve) =>
              setTimeout(() => resolve('hung'), 5_000),
            ),
          ]);
          return outcome;
        };
        const cases: Array<[Buffer[], Parameters<typeof attempt>[1]]> = [
          [[], 'before'],
          [[partHead], 'sync'],
          [[partHead], 'tick'],
          [[partHead.subarray(0, 20)], 'tick'],
          [[partHead, partial], 'sync'],
          [[partHead, partial], 'tick'],
          [[partHead, partial], 'after-data'],
          [[partHead, partial], 'error'],
        ];
        for (const [chunks, close] of cases) {
          const outcome = await attempt(chunks, close);
          expect(outcome, `${close} after ${chunks.length} chunk(s)`).toMatch(
            /^400 .*DOCUMENT_UPLOAD_INTERRUPTED/,
          );
        }
        // Every file handle is closed and every temporary directory removed.
        const deadline = Date.now() + 3_000;
        while (
          ((await readdir(temp)).length > 0 ||
            (await handlesUnder()).length > 0) &&
          Date.now() < deadline
        )
          await new Promise((resolve) => setTimeout(resolve, 25));
        expect({
          entries: await readdir(temp),
          handles: await handlesUnder(),
        }).toEqual({ entries: [], handles: [] });
        // Nothing was recorded, let alone attached.
        expect(
          await tx.documentStoredObject.count({
            where: { organizationId: fx.orgA },
          }),
        ).toBe(0);
      });
    } finally {
      if (previous === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previous;
      await rm(temp, { recursive: true, force: true });
    }
  });

  it('review fix: interrupted or malformed uploads leave no temporary file behind', async () => {
    const previous = process.env.TMPDIR;
    const temp = await mkdtemp(join(tmpdir(), 'b9-tmp-'));
    process.env.TMPDIR = temp;
    try {
      await scenario(async ({ fx, files }) => {
        const target = {
          kind: 'record' as const,
          organizationId: fx.orgA,
          employeeId: fx.employee1,
        };
        const big = Buffer.concat([SAMPLE_PDF, Buffer.alloc(32 * 1024)]);
        for (const truncateAt of [300, 2_000, 20_000]) {
          expect(
            await failure(
              upload(files, fx.users.restricted!, target, big, 'a.pdf', {
                truncateAt,
              }),
            ),
          ).toMatchObject({ status: 400 });
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(await readdir(temp)).toEqual([]);
      });
    } finally {
      if (previous === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previous;
      await rm(temp, { recursive: true, force: true });
    }
  });

  describe('committed data', () => {
    let fx: SchedulingFixtures;
    let svc: DocumentServices;
    let files: DocumentFileService;
    let types: Record<string, string>;

    beforeAll(async () => {
      fx = await prisma.$transaction(
        (tx) => createSchedulingFixtures(tx, DOCUMENT_USERS),
        { timeout: 60_000 },
      );
      const clock = new FixedDocumentsClock();
      clock.value = new Date();
      svc = documentServices(prisma, clock);
      files = documentFileServices(prisma, clock, settings);
      types = await initTypes(svc, fx);
    });
    afterAll(async () => {
      if (fx) {
        await prisma.$executeRawUnsafe(
          'SET session_replication_role = replica',
        );
        try {
          await prisma.$executeRaw`DELETE FROM "EmployeeDocumentVersion" WHERE "documentId" IN (SELECT "id" FROM "EmployeeDocument" WHERE "organizationId" = ${fx.orgA}::uuid)`;
          await prisma.$executeRaw`DELETE FROM "EmployeeDocument" WHERE "organizationId" = ${fx.orgA}::uuid`;
          await prisma.$executeRaw`DELETE FROM "DocumentStoredObject" WHERE "organizationId" = ${fx.orgA}::uuid`;
          await prisma.$executeRaw`DELETE FROM "DocumentType" WHERE "organizationId" = ${fx.orgA}::uuid`;
        } finally {
          await prisma.$executeRawUnsafe(
            'SET session_replication_role = origin',
          );
        }
        await cleanupSchedulingFixtures(prisma, fx);
      }
    });

    it('a cleanup run concurrent with an attach never deletes the attached object', async () => {
      const hr = fx.users.restricted!;
      const up = await upload(files, hr, {
        kind: 'record',
        organizationId: fx.orgA,
        employeeId: fx.employee1,
      });
      // The attaching transaction holds the row; the cleanup (with a cutoff that would include
      // it) skips it, and after the commit nothing can abandon it.
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let locked!: () => void;
      const holding = new Promise<void>((resolve) => (locked = resolve));
      const attaching = prisma.$transaction(
        async (tx) => {
          const outcome = await attachStoredObject(
            tx,
            up.id,
            {
              actorUserId: hr,
              organizationId: fx.orgA,
              purposes: ['EMPLOYEE_DOCUMENT'],
              employeeId: fx.employee1,
              documentId: null,
            },
            new Date(),
          );
          locked();
          await gate;
          return outcome;
        },
        { timeout: 30_000 },
      );
      await holding;
      const during = await files.cleanupAbandoned({ olderThanMs: -60_000 });
      expect(during.abandoned).toBe(0);
      release();
      expect((await attaching).kind).toBe('ATTACHED');
      const after = await files.cleanupAbandoned({ olderThanMs: -60_000 });
      expect(after.abandoned).toBe(0);
      const row = await prisma.documentStoredObject.findUniqueOrThrow({
        where: { id: up.id },
      });
      expect(row.status).toBe('ATTACHED');
      expect(await store.head(row.storageKey)).not.toBeNull();
    });

    it('serializes concurrent version uploads: numbered in sequence, one current, every object attached', async () => {
      const hr = fx.users.restricted!;
      const first = await upload(files, hr, {
        kind: 'record',
        organizationId: fx.orgA,
        employeeId: fx.employee2,
      });
      const doc = await svc.documents.create(
        {
          organizationId: fx.orgA,
          employeeId: fx.employee2,
          typeId: types['OTHER']!,
          title: 'Concurrent',
          version: { provider: 'INTERNAL_OBJECT_STORAGE', uploadId: first.id },
        },
        ctx(hr),
      );
      const uploads = await Promise.all(
        [0, 1, 2, 3].map(() =>
          upload(files, hr, { kind: 'version', documentId: doc.id }),
        ),
      );
      await Promise.all(
        uploads.map((up) =>
          svc.documents.addVersion(
            doc.id,
            { provider: 'INTERNAL_OBJECT_STORAGE', uploadId: up.id },
            ctx(hr),
          ),
        ),
      );
      const versions = await prisma.employeeDocumentVersion.findMany({
        where: { documentId: doc.id },
        orderBy: { versionNumber: 'asc' },
      });
      expect(versions.map((v) => v.versionNumber)).toEqual([1, 2, 3, 4, 5]);
      expect(versions.filter((v) => v.supersededAt === null)).toHaveLength(1);
      expect(new Set(versions.map((v) => v.storedObjectId)).size).toBe(5);
      const objects = await prisma.documentStoredObject.findMany({
        where: { id: { in: uploads.map((u) => u.id) } },
      });
      expect(objects.every((o) => o.status === 'ATTACHED')).toBe(true);
      for (const object of objects)
        expect(await readFile(store.pathOf(object.storageKey))).toEqual(
          SAMPLE_PDF,
        );
    });
  });
});
