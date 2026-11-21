import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AwsClient } from 'aws4fetch';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SAMPLE_PDF } from '../src/documents/document-file-samples.js';
import {
  DocumentObjectStore,
  LocalDocumentObjectStore,
  objectKeyFor,
  S3DocumentObjectStore,
} from '../src/documents/document-object-store.js';

/**
 * Batch 9 (D1) — one contract for every object store: write a verified file under a server
 * key, never overwrite it, report its size, issue a short-lived download that returns exactly
 * the bytes as an attachment of the stored type, and delete idempotently.
 *
 * `local` runs always (a disposable directory). `s3` runs against a disposable S3-compatible
 * server when DOCUMENT_S3_TEST_ENDPOINT is set (locally: moto server; never production
 * credentials or buckets — the test creates its own bucket with dummy keys).
 */
const ORG = randomUUID();
const S3_ENDPOINT = process.env.DOCUMENT_S3_TEST_ENDPOINT;

let directory: string;
let file: string;
const local = () =>
  new LocalDocumentObjectStore(
    join(directory, 'store'),
    'contract-signing-key-0123456789-abcdef',
  );
const s3Settings = {
  endpoint: S3_ENDPOINT ?? 'http://127.0.0.1:1',
  region: 'us-east-1',
  bucket: `hrms-b9-${randomUUID().slice(0, 8)}`,
  accessKeyId: 'test-access-key',
  secretAccessKey: 'test-secret-key',
  forcePathStyle: true,
};

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'b9-contract-'));
  file = join(directory, 'upload.bin');
  await writeFile(file, SAMPLE_PDF);
  if (S3_ENDPOINT) {
    const client = new AwsClient({
      accessKeyId: s3Settings.accessKeyId,
      secretAccessKey: s3Settings.secretAccessKey,
      region: s3Settings.region,
      service: 's3',
    });
    const response = await client.fetch(`${S3_ENDPOINT}/${s3Settings.bucket}`, {
      method: 'PUT',
    });
    if (!response.ok)
      throw new Error(`Could not create the test bucket: ${response.status}`);
  }
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

const sha256 = 'a'.repeat(64);

async function download(
  store: DocumentObjectStore,
  key: string,
  objectId: string,
  now = new Date(),
) {
  const signed = await store.downloadUrl({
    objectId,
    key,
    fileName: 'Contrat signé.pdf',
    contentType: 'application/pdf',
    now,
  });
  return signed;
}

describe.each([
  ['local', true],
  ['s3', Boolean(S3_ENDPOINT)],
] as const)('Batch 9 object store contract: %s', (backend, enabled) => {
  const run = enabled ? it : it.skip;
  const store = (): DocumentObjectStore =>
    backend === 'local' ? local() : new S3DocumentObjectStore(s3Settings);

  run(
    'stores, never overwrites, reports, downloads as an attachment and deletes idempotently',
    async () => {
      const objects = store();
      const objectId = randomUUID();
      const key = objectKeyFor(ORG, objectId);
      const { createHash } = await import('node:crypto');
      const digest = createHash('sha256').update(SAMPLE_PDF).digest('hex');
      await objects.put({
        key,
        filePath: file,
        sizeBytes: SAMPLE_PDF.length,
        contentType: 'application/pdf',
        sha256: digest,
      });
      expect(await objects.head(key)).toEqual({ sizeBytes: SAMPLE_PDF.length });
      await expect(
        objects.put({
          key,
          filePath: file,
          sizeBytes: SAMPLE_PDF.length,
          contentType: 'application/pdf',
          sha256: digest,
        }),
      ).rejects.toMatchObject({ code: 'DOCUMENT_OBJECT_EXISTS' });
      const signed = await download(objects, key, objectId);
      expect(signed.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(
        60_000,
      );
      if (backend === 's3') {
        const response = await fetch(signed.url);
        expect(response.status).toBe(200);
        expect(Buffer.from(await response.arrayBuffer())).toEqual(SAMPLE_PDF);
        expect(response.headers.get('content-type')).toBe('application/pdf');
        expect(response.headers.get('content-disposition')).toMatch(
          /^attachment; filename="Contrat sign_.pdf"; filename\*=UTF-8''Contrat%20sign%C3%A9.pdf$/,
        );
        // Unsigned access to the private object is refused when the service enforces it; the
        // URL never carries the secret key.
        expect(signed.url).not.toContain(s3Settings.secretAccessKey);
      } else {
        expect(signed.url).toMatch(/^\/documents\/files\//);
        expect(
          (objects as LocalDocumentObjectStore).verifyToken(
            signed.url.split('/').pop()!,
            new Date(),
          ),
        ).toBe(objectId);
      }
      await objects.delete(key);
      await objects.delete(key);
      expect(await objects.head(key)).toBeNull();
      // The payload's SHA-256 travels as X-Amz-Content-Sha256, which S3 (and MinIO) verify;
      // the local moto test server does not, so integrity is asserted by the ledger's own hash.
    },
  );

  run('refuses keys that were not generated by the server', async () => {
    const objects = store();
    for (const key of [
      '../escape',
      `documents/${ORG}/../../x`,
      'documents/a/b',
    ])
      await expect(
        objects.put({
          key,
          filePath: file,
          sizeBytes: 1,
          contentType: 'application/pdf',
          sha256,
        }),
      ).rejects.toMatchObject({ code: 'DOCUMENT_OBJECT_KEY_INVALID' });
  });
});
