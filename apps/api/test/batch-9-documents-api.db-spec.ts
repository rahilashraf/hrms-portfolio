import { config } from 'dotenv';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccessTokenService } from '../src/auth/access-token.service.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { DOCUMENT_STORAGE_SETTINGS } from '../src/documents/document-file.service.js';
import {
  SAMPLE_PDF,
  SAMPLE_PNG,
} from '../src/documents/document-file-samples.js';
import {
  LocalDocumentObjectStore,
  type DocumentStorageSettings,
} from '../src/documents/document-object-store.js';
import { DOCUMENT_USERS } from './support/documents-fixtures.js';
import { FixedClock } from './support/leave-fixtures.js';
import { createSchedulingFixtures } from './support/scheduling-fixtures.js';
import { withTimeHttp } from './support/time-http.js';

config({ path: '../../.env' });

class RollbackFixtures extends Error {}

type Body = Record<string, unknown> & { id: string };

/**
 * Batch 9 — Documents over HTTP (the whole application on the scenario's rollback transaction,
 * local storage in a disposable directory): multipart uploads authorized before reading,
 * record creation and versions with uploaded files, 60-second download URLs and the local
 * download route (headers, expiry-free here, tampering), the confidentiality / organization
 * matrix with 404s, validation errors, and the D10 lifecycle (type reactivation, requirement
 * archive-and-replace with history, retired policy copied into a draft).
 */
describe('Documents files and lifecycle API (HTTP, database)', () => {
  let prisma: PrismaService;
  let directory: string;
  let settings: DocumentStorageSettings;

  beforeAll(async () => {
    prisma = new PrismaService(process.env.DATABASE_URL!);
    await prisma.$connect();
    directory = await mkdtemp(join(tmpdir(), 'b9-http-store-'));
    settings = {
      store: new LocalDocumentObjectStore(
        directory,
        'http-spec-signing-key-0123456789-abcdef',
      ),
      maxUploadBytes: 64 * 1024,
      requireMalwareScan: false,
    };
  });
  afterAll(async () => {
    await prisma?.$disconnect();
    await rm(directory, { recursive: true, force: true });
  });

  it('uploads, versions, downloads and authorizes files; D10 lifecycle; validation', async () => {
    await expect(
      prisma.$transaction(
        async (tx) => {
          const fx = await createSchedulingFixtures(tx, DOCUMENT_USERS);
          await withTimeHttp(
            tx,
            new FixedClock(),
            async (http) => {
              const tokens = http.app.get(AccessTokenService);
              const bearer = async (userId: string) =>
                `Bearer ${await tokens.issue({ userId, sessionId: 'session-1' })}`;
              const uploadAs = async (
                userId: string,
                query: string,
                content: Buffer,
                fileName: string,
                status?: number,
              ) => {
                const response = await request(http.server)
                  .post(`/documents/uploads?${query}`)
                  .set('Authorization', await bearer(userId))
                  .attach('file', content, fileName);
                if (status !== undefined)
                  expect(response.status, JSON.stringify(response.body)).toBe(
                    status,
                  );
                return response;
              };
              const hr = await http.as(fx.users.restricted!);
              const employee = await http.as(fx.selfUser1);
              const reader = await http.as(fx.users.reader!);
              const outsider = await http.as(fx.users.orgBAdmin!);
              const typeAdmin = await http.as(fx.users.typeAdmin!);
              const policyAdmin = await http.as(fx.users.policyAdmin!);

              const types = Object.fromEntries(
                (
                  (
                    await typeAdmin
                      .post('/documents/types/initialize', {
                        organizationId: fx.orgA,
                      })
                      .expect(201)
                  ).body as { items: Array<{ id: string; code: string }> }
                ).items.map((t) => [t.code, t.id]),
              ) as Record<string, string>;

              // ── Upload authorization and validation ───────────────────────────
              const record = `organizationId=${fx.orgA}&employeeId=${fx.employee1}`;
              await http
                .anonymous()
                .post(`/documents/uploads?${record}`)
                .attach('file', SAMPLE_PDF, 'a.pdf')
                .expect(401);
              await uploadAs(
                fx.users.orgBAdmin!,
                record,
                SAMPLE_PDF,
                'a.pdf',
                404,
              );
              await uploadAs(
                fx.users.reader!,
                record,
                SAMPLE_PDF,
                'a.pdf',
                403,
              );
              const badTarget = await uploadAs(
                fx.users.restricted!,
                `organizationId=${fx.orgA}`,
                SAMPLE_PDF,
                'a.pdf',
              );
              expect(badTarget.status).toBe(400);
              expect(badTarget.body.code).toBe(
                'DOCUMENT_UPLOAD_TARGET_INVALID',
              );
              const html = await uploadAs(
                fx.users.restricted!,
                record,
                Buffer.from('<html>x</html>'),
                'a.pdf',
              );
              expect([html.status, html.body.code]).toEqual([
                415,
                'DOCUMENT_FILE_TYPE_NOT_ALLOWED',
              ]);
              const big = await uploadAs(
                fx.users.restricted!,
                record,
                Buffer.concat([SAMPLE_PDF, Buffer.alloc(80 * 1024)]),
                'big.pdf',
              );
              expect([big.status, big.body.code]).toEqual([
                413,
                'DOCUMENT_FILE_TOO_LARGE',
              ]);
              const notMultipart = await hr.post(
                `/documents/uploads?${record}`,
                { file: 'x' },
              );
              expect([notMultipart.status, notMultipart.body.code]).toEqual([
                400,
                'DOCUMENT_UPLOAD_INVALID',
              ]);

              // ── Record with an uploaded PDF, then a PNG version ───────────────
              const up = (
                await uploadAs(
                  fx.users.restricted!,
                  record,
                  SAMPLE_PDF,
                  'agreement.pdf',
                  201,
                )
              ).body as Body;
              expect(Object.keys(up).sort()).toEqual([
                'fileName',
                'id',
                'mimeType',
                'scanStatus',
                'sizeBytes',
              ]);
              // A client key is refused with a clear code.
              const typed = await hr
                .post('/documents/records', {
                  organizationId: fx.orgA,
                  employeeId: fx.employee1,
                  typeId: types['EMPLOYMENT-AGREEMENT'],
                  title: 'x',
                  version: {
                    provider: 'INTERNAL_OBJECT_STORAGE',
                    storageKey: 'documents/a/b',
                  },
                })
                .expect(400);
              expect(typed.body.code).toBe('DOCUMENT_STORAGE_KEY_NOT_ACCEPTED');
              const doc = (
                await hr
                  .post('/documents/records', {
                    organizationId: fx.orgA,
                    employeeId: fx.employee1,
                    typeId: types['EMPLOYMENT-AGREEMENT'],
                    title: 'Employment agreement',
                    confidentiality: 'EMPLOYEE_VISIBLE',
                    version: {
                      provider: 'INTERNAL_OBJECT_STORAGE',
                      uploadId: up.id,
                    },
                  })
                  .expect(201)
              ).body as Body & { currentVersion: Body; versions: Body[] };
              expect(JSON.stringify(doc)).not.toMatch(
                /documents\/[0-9a-f-]{36}\//,
              );
              const v2up = (
                await uploadAs(
                  fx.users.restricted!,
                  `documentId=${doc.id}`,
                  SAMPLE_PNG,
                  'scan.png',
                  201,
                )
              ).body as Body;
              const versioned = (
                await hr
                  .post(`/documents/records/${doc.id}/versions`, {
                    provider: 'INTERNAL_OBJECT_STORAGE',
                    uploadId: v2up.id,
                  })
                  .expect(201)
              ).body as { versions: Body[] };
              expect(versioned.versions).toHaveLength(2);

              // ── Downloads ─────────────────────────────────────────────────────
              const v1 = versioned.versions[1]!.id;
              const url = (
                await employee
                  .post(
                    `/documents/records/${doc.id}/versions/${v1}/download-url`,
                  )
                  .expect(200)
              ).body as {
                url: string;
                expiresAt: string;
                fileName: string;
              };
              expect(url.fileName).toBe('agreement.pdf');
              expect(url.url).toMatch(/^\/documents\/files\//);
              const file = await http
                .anonymous()
                .get(url.url)
                .buffer(true)
                .parse((res, done) => {
                  const chunks: Buffer[] = [];
                  res.on('data', (c: Buffer) => chunks.push(c));
                  res.on('end', () => done(null, Buffer.concat(chunks)));
                })
                .expect(200);
              expect(file.body).toEqual(SAMPLE_PDF);
              expect(file.headers['content-type']).toBe('application/pdf');
              expect(file.headers['content-disposition']).toMatch(
                /^attachment; filename="agreement.pdf"/,
              );
              expect(file.headers['x-content-type-options']).toBe('nosniff');
              expect(file.headers['cache-control']).toBe('no-store');
              await http.anonymous().get(`${url.url}x`).expect(404);
              await http
                .anonymous()
                .get('/documents/files/not-a-token')
                .expect(404);

              // Reclassified HR_ONLY: the employee and plain readers get 404, HR still downloads.
              await hr
                .patch(`/documents/records/${doc.id}`, {
                  confidentiality: 'HR_ONLY',
                })
                .expect(200);
              await employee
                .post(
                  `/documents/records/${doc.id}/versions/${v1}/download-url`,
                )
                .expect(404);
              await reader
                .post(
                  `/documents/records/${doc.id}/versions/${v1}/download-url`,
                )
                .expect(404);
              await outsider
                .post(
                  `/documents/records/${doc.id}/versions/${v1}/download-url`,
                )
                .expect(404);
              await hr
                .post(
                  `/documents/records/${doc.id}/versions/${v1}/download-url`,
                )
                .expect(200);
              await hr
                .post(
                  `/documents/records/${doc.id}/versions/00000000-0000-4000-8000-000000000001/download-url`,
                )
                .expect(404);
              const detailForEmployee = await employee
                .get(`/documents/records/${doc.id}`)
                .expect(404);
              expect(JSON.stringify(detailForEmployee.body)).not.toContain(
                'agreement',
              );

              const orgs = await employee
                .get('/documents/organizations')
                .expect(200);
              expect(orgs.body.uploads).toEqual({
                enabled: true,
                maxBytes: 64 * 1024,
                allowedTypes: ['application/pdf', 'image/png', 'image/jpeg'],
              });
              // ── F5: Documents options for pickers ─────────────────────────────
              const departments = (
                await typeAdmin
                  .get(
                    `/documents/options?organizationId=${fx.orgA}&kind=department`,
                  )
                  .expect(200)
              ).body as {
                items: Array<{ id: string; label: string }>;
              };
              expect(departments.items.map((d) => d.id)).toEqual(
                expect.arrayContaining([fx.deptA, fx.deptB]),
              );
              await reader
                .get(
                  `/documents/options?organizationId=${fx.orgA}&kind=department`,
                )
                .expect(403);
              await typeAdmin
                .get(`/documents/options?organizationId=${fx.orgA}&kind=team`)
                .expect(400);

              // ── D10: types, requirements, policies ────────────────────────────
              await typeAdmin
                .post(`/documents/types/${types['LICENSE']}/archive`)
                .expect(201);
              const listed = (
                await typeAdmin
                  .get(`/documents/types?organizationId=${fx.orgA}`)
                  .expect(200)
              ).body as { items: Body[] };
              expect(listed.items.map((t) => t.id)).not.toContain(
                types['LICENSE'],
              );
              const reactivated = (
                await typeAdmin
                  .post(`/documents/types/${types['LICENSE']}/reactivate`)
                  .expect(200)
              ).body as Body;
              expect(reactivated.archivedAt).toBeNull();
              await reader
                .post(`/documents/types/${types['LICENSE']}/reactivate`)
                .expect(403);

              const requirement = (
                await typeAdmin
                  .post('/documents/requirements', {
                    organizationId: fx.orgA,
                    typeId: types['LICENSE'],
                    employmentType: 'FULL_TIME',
                  })
                  .expect(201)
              ).body as Body;
              const replaced = (
                await typeAdmin
                  .post(`/documents/requirements/${requirement.id}/replace`, {
                    departmentId: fx.deptA,
                    note: 'Drivers only',
                  })
                  .expect(200)
              ).body as { previous: Body; requirement: Body };
              expect(replaced.previous).toMatchObject({
                id: requirement.id,
                employmentType: 'FULL_TIME',
                archivedAt: expect.any(String),
              });
              expect(replaced.requirement).toMatchObject({
                departmentId: fx.deptA,
                departmentName: 'Dept A',
                employmentType: null,
                note: 'Drivers only',
                archivedAt: null,
              });
              const again = await typeAdmin
                .post(`/documents/requirements/${requirement.id}/replace`, {
                  departmentId: fx.deptB,
                })
                .expect(409);
              expect(again.body.code).toBe('DOCUMENT_REQUIREMENT_ARCHIVED');
              const same = await typeAdmin
                .post(
                  `/documents/requirements/${replaced.requirement.id}/replace`,
                  { departmentId: fx.deptA, note: 'Drivers only' },
                )
                .expect(400);
              expect(same.body.code).toBe('DOCUMENT_REQUIREMENT_UNCHANGED');
              const history = (
                await typeAdmin
                  .get(
                    `/documents/requirements?organizationId=${fx.orgA}&includeArchived=true`,
                  )
                  .expect(200)
              ).body as { items: Body[] };
              expect(history.items.map((r) => r.id)).toEqual(
                expect.arrayContaining([
                  requirement.id,
                  replaced.requirement.id,
                ]),
              );
              const active = (
                await typeAdmin
                  .get(`/documents/requirements?organizationId=${fx.orgA}`)
                  .expect(200)
              ).body as { items: Body[] };
              expect(active.items.map((r) => r.id)).toEqual([
                replaced.requirement.id,
              ]);
              await reader
                .post(
                  `/documents/requirements/${replaced.requirement.id}/replace`,
                  { departmentId: fx.deptB },
                )
                .expect(403);

              const policy = (
                await policyAdmin
                  .post('/documents/policies', {
                    organizationId: fx.orgA,
                    code: 'CONDUCT',
                    title: 'Code of conduct',
                    audienceDepartmentId: fx.deptA,
                  })
                  .expect(201)
              ).body as Body;
              const notRetired = await policyAdmin
                .post(`/documents/policies/${policy.id}/copy`, {
                  code: 'CONDUCT-2',
                })
                .expect(409);
              expect(notRetired.body.code).toBe('POLICY_NOT_RETIRED');
              await policyAdmin
                .post(`/documents/policies/${policy.id}/retire`)
                .expect(201);
              const copy = (
                await policyAdmin
                  .post(`/documents/policies/${policy.id}/copy`, {
                    code: 'CONDUCT-2027',
                  })
                  .expect(201)
              ).body as Body & {
                audience: Body;
                versions: unknown[];
              };
              expect(copy).toMatchObject({
                code: 'CONDUCT-2027',
                title: 'Code of conduct',
                status: 'DRAFT',
                audience: { departmentId: fx.deptA, departmentName: 'Dept A' },
                versions: [],
              });
              const original = await tx.policyDocument.findUniqueOrThrow({
                where: { id: policy.id },
              });
              expect(original.status).toBe('RETIRED');
              await policyAdmin
                .post(`/documents/policies/${policy.id}/copy`, {
                  code: 'CONDUCT-2027',
                })
                .expect(409);
              await reader
                .post(`/documents/policies/${policy.id}/copy`, { code: 'X-1' })
                .expect(403);

              // A policy version with an uploaded file, downloadable once published.
              const pUp = (
                await uploadAs(
                  fx.users.policyAdmin!,
                  `policyId=${copy.id}`,
                  SAMPLE_PDF,
                  'conduct.pdf',
                  201,
                )
              ).body as Body;
              const drafted = (
                await policyAdmin
                  .post(`/documents/policies/${copy.id}/versions`, {
                    versionLabel: '2027',
                    provider: 'INTERNAL_OBJECT_STORAGE',
                    uploadId: pUp.id,
                    acknowledgementStatement:
                      'I have read the code of conduct.',
                  })
                  .expect(201)
              ).body as { versions: Body[] };
              const pv = drafted.versions[0]!.id;
              await reader
                .post(
                  `/documents/policies/${copy.id}/versions/${pv}/download-url`,
                )
                .expect(404);
              await policyAdmin
                .post(
                  `/documents/policies/${copy.id}/versions/${pv}/download-url`,
                )
                .expect(200);
            },
            [[DOCUMENT_STORAGE_SETTINGS, settings]],
          );
          throw new RollbackFixtures();
        },
        { timeout: 120_000 },
      ),
    ).rejects.toBeInstanceOf(RollbackFixtures);
  });
});
