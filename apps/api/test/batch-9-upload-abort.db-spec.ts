import { config } from 'dotenv';
import { mkdtemp, readdir, readlink, rm, stat } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccessTokenService } from '../src/auth/access-token.service.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { DOCUMENT_STORAGE_SETTINGS } from '../src/documents/document-file.service.js';
import { SAMPLE_PDF } from '../src/documents/document-file-samples.js';
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls until `check` is true (or the deadline passes) and returns its last value. */
async function eventually(check: () => Promise<boolean>, ms = 5_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await check()) return true;
    if (Date.now() > deadline) return false;
    await sleep(25);
  }
}

/** Upload directories under `root` (the API's temporary directory for this test). */
const uploadDirectories = async (root: string) =>
  (await readdir(root)).filter((name) => name.startsWith('hrms-upload-'));

/**
 * Open file descriptors of this process (the API runs in-process) that point under `root`:
 * read from /proc/self/fd, so only handles on the upload's own files are counted — never the
 * process-wide total.
 */
async function openHandlesUnder(root: string) {
  const handles: string[] = [];
  for (const fd of await readdir('/proc/self/fd')) {
    const target = await readlink(`/proc/self/fd/${fd}`).catch(() => '');
    if (target.startsWith(root)) handles.push(target);
  }
  return handles;
}

/**
 * Batch 9 (final review, medium): a client that drops the connection in the middle of a
 * multipart upload. Over a real TCP connection: the request is authorized, a partial file part
 * reaches the API (its temporary file exists and has bytes), then the socket is destroyed. The
 * upload must settle, close its file handle, remove its temporary directory and attach nothing;
 * repeated drops never accumulate anything, and the API keeps serving normal uploads (and their
 * refusals) afterwards.
 */
describe('Document uploads: client disconnects (HTTP, database)', () => {
  let prisma: PrismaService;
  let store: string;
  let settings: DocumentStorageSettings;

  beforeAll(async () => {
    prisma = new PrismaService(process.env.DATABASE_URL!);
    await prisma.$connect();
    store = await mkdtemp(join(tmpdir(), 'b9-abort-store-'));
    settings = {
      store: new LocalDocumentObjectStore(
        store,
        'abort-spec-signing-key-0123456789-abcdef',
      ),
      maxUploadBytes: 256 * 1024,
      requireMalwareScan: false,
    };
  });
  afterAll(async () => {
    await prisma?.$disconnect();
    await rm(store, { recursive: true, force: true });
  });

  it('a dropped connection mid-file leaves no temporary file, directory or handle, attaches nothing, and the API keeps working', async () => {
    const previous = process.env.TMPDIR;
    const temp = await mkdtemp(join(tmpdir(), 'b9-abort-tmp-'));
    await expect(
      prisma.$transaction(
        async (tx) => {
          const fx = await createSchedulingFixtures(tx, DOCUMENT_USERS);
          await withTimeHttp(
            tx,
            new FixedClock(),
            async (http) => {
              process.env.TMPDIR = temp;
              const token = await http.app.get(AccessTokenService).issue({
                userId: fx.users.restricted!,
                sessionId: 'session-1',
              });
              // The application's own Node HTTP server, listening for raw TCP clients.
              const server = http.server as unknown as Server;
              await new Promise<void>((resolve) =>
                server.listen(0, '127.0.0.1', () => resolve()),
              );
              const { port } = server.address() as AddressInfo;
              const path = `/documents/uploads?organizationId=${fx.orgA}&employeeId=${fx.employee1}`;
              const objects = () =>
                tx.documentStoredObject.count({
                  where: { organizationId: fx.orgA },
                });

              /** Nothing of any upload is left: no directory, file or open handle. */
              const expectClean = async () => {
                await eventually(
                  async () =>
                    (await uploadDirectories(temp)).length === 0 &&
                    (await openHandlesUnder(temp)).length === 0,
                );
                expect({
                  directories: await uploadDirectories(temp),
                  handles: await openHandlesUnder(temp),
                }).toEqual({ directories: [], handles: [] });
              };

              /** Sends headers and a partial file part, waits until it is on disk, drops. */
              const dropMidFile = async () => {
                const boundary = 'b9abortboundary';
                const head = Buffer.from(
                  `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="big.pdf"\r\nContent-Type: application/pdf\r\n\r\n`,
                );
                const partial = Buffer.concat([
                  Buffer.from('%PDF-1.4\n'),
                  Buffer.alloc(32 * 1024, 0x41),
                ]);
                const socket = connect(port, '127.0.0.1');
                socket.on('error', () => undefined);
                await new Promise<void>((resolve) =>
                  socket.once('connect', () => resolve()),
                );
                socket.write(
                  [
                    `POST ${path} HTTP/1.1`,
                    `Host: 127.0.0.1:${port}`,
                    `Authorization: Bearer ${token}`,
                    `Content-Type: multipart/form-data; boundary=${boundary}`,
                    // Promises far more than is sent: the multipart terminator never arrives.
                    `Content-Length: ${200 * 1024}`,
                    'Connection: close',
                    '',
                    '',
                  ].join('\r\n'),
                );
                socket.write(Buffer.concat([head, partial]));
                // The partial file reached the API: its temporary file holds bytes.
                const received = await eventually(async () => {
                  for (const name of await uploadDirectories(temp)) {
                    const size = await stat(
                      join(temp, name, 'upload.bin'),
                    ).then(
                      (s) => s.size,
                      () => 0,
                    );
                    if (size > 0) return true;
                  }
                  return false;
                });
                expect(received, 'the partial file reached the API').toBe(true);
                socket.destroy();
              };

              await dropMidFile();
              // Settled and cleaned up: no directory, no file, no open handle under temp.
              await expectClean();
              expect(await objects()).toBe(0);

              // Repeated drops do not accumulate anything.
              for (let i = 0; i < 5; i += 1) await dropMidFile();
              await expectClean();
              expect(await objects()).toBe(0);

              // The API keeps working: a normal upload, an oversized one and a malformed one.
              const upload = (content: Buffer, name: string) =>
                request(`http://127.0.0.1:${port}`)
                  .post(path)
                  .set('Authorization', `Bearer ${token}`)
                  .attach('file', content, name);
              const ok = await upload(SAMPLE_PDF, 'ok.pdf');
              expect(ok.status, JSON.stringify(ok.body)).toBe(201);
              const big = await upload(
                Buffer.concat([SAMPLE_PDF, Buffer.alloc(300 * 1024)]),
                'big.pdf',
              );
              expect([big.status, big.body.code]).toEqual([
                413,
                'DOCUMENT_FILE_TOO_LARGE',
              ]);
              const html = await upload(Buffer.from('<html></html>'), 'x.pdf');
              expect([html.status, html.body.code]).toEqual([
                415,
                'DOCUMENT_FILE_TYPE_NOT_ALLOWED',
              ]);
              // Only the successful upload exists, and it is stored, not attached.
              expect(
                await tx.documentStoredObject.findMany({
                  where: { organizationId: fx.orgA },
                  select: { id: true, status: true },
                }),
              ).toEqual([{ id: ok.body.id, status: 'STORED' }]);
              // Authorization is unchanged: without a token the body is never read.
              await request(`http://127.0.0.1:${port}`)
                .post(path)
                .attach('file', SAMPLE_PDF, 'a.pdf')
                .expect(401);
              await expectClean();
            },
            [[DOCUMENT_STORAGE_SETTINGS, settings]],
          ).catch((error: unknown) => {
            console.error('UPLOAD ABORT FAILURE', error);
            throw error;
          });
          throw new RollbackFixtures();
        },
        { timeout: 120_000 },
      ),
    ).rejects.toBeInstanceOf(RollbackFixtures);
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
    await rm(temp, { recursive: true, force: true });
  });
});
