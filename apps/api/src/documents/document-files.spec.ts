import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  attachmentDisposition,
  detectFileType,
  fileNameForType,
  sanitizeFileName,
} from './document-files.js';
import {
  documentStorageFromEnv,
  LocalDocumentObjectStore,
  objectKeyFor,
  ObjectStoreError,
  S3DocumentObjectStore,
  signLocalToken,
  verifyLocalToken,
} from './document-object-store.js';
import {
  SAMPLE_JPEG,
  SAMPLE_PDF,
  SAMPLE_PNG,
} from './document-file-samples.js';

const ORG = '11111111-1111-4111-8111-111111111111';
const OBJ = '22222222-2222-4222-8222-222222222222';
const KEY = 'k'.repeat(40);

const tail = (buffer: Buffer) =>
  buffer.subarray(Math.max(0, buffer.length - 1024));
const detect = (buffer: Buffer) =>
  detectFileType(buffer.subarray(0, 16), tail(buffer));

describe('Batch 9 document files: content checks and names', () => {
  it('detects PDF, PNG and JPEG by content, never by name', () => {
    expect(detect(SAMPLE_PDF)).toEqual({ ok: true, type: 'application/pdf' });
    expect(detect(SAMPLE_PNG)).toEqual({ ok: true, type: 'image/png' });
    expect(detect(SAMPLE_JPEG)).toEqual({ ok: true, type: 'image/jpeg' });
    // Other content: not allowed whatever it is called.
    for (const other of [
      Buffer.from('<html><script>alert(1)</script></html>'),
      Buffer.from('PK\u0003\u0004 docx-like zip'),
      Buffer.from('GIF89a......'),
      Buffer.from([
        0x7f, 0x45, 0x4c, 0x46, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
      ]),
    ])
      expect(detect(other)).toEqual({
        ok: false,
        code: 'DOCUMENT_FILE_TYPE_NOT_ALLOWED',
      });
    // A recognized start without a valid end: truncated or disguised.
    expect(detect(SAMPLE_PDF.subarray(0, 20))).toEqual({
      ok: false,
      code: 'DOCUMENT_FILE_MALFORMED',
    });
    expect(detect(SAMPLE_PNG.subarray(0, SAMPLE_PNG.length - 4))).toMatchObject(
      {
        ok: false,
        code: 'DOCUMENT_FILE_MALFORMED',
      },
    );
    expect(detect(SAMPLE_JPEG.subarray(0, 8))).toMatchObject({
      ok: false,
      code: 'DOCUMENT_FILE_MALFORMED',
    });
  });

  it('sanitizes display names and refuses extensions that contradict the content', () => {
    expect(sanitizeFileName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFileName('C:\\Users\\me\\report.pdf')).toBe('report.pdf');
    expect(sanitizeFileName('a\u0000b\u202ec<script>.pdf')).toBe(
      'ab\u202ec_script_.pdf',
    );
    expect(sanitizeFileName('  ...hidden.pdf  ')).toBe('hidden.pdf');
    expect(sanitizeFileName('')).toBe('document');
    expect(sanitizeFileName(`${'x'.repeat(300)}.pdf`)).toHaveLength(200);
    expect(sanitizeFileName(`${'x'.repeat(300)}.pdf`).endsWith('.pdf')).toBe(
      true,
    );
    expect(fileNameForType('scan.PDF', 'application/pdf')).toBe('scan.PDF');
    expect(fileNameForType('photo.jpeg', 'image/jpeg')).toBe('photo.jpeg');
    expect(fileNameForType('notes', 'application/pdf')).toBe('notes.pdf');
    expect(fileNameForType('invoice.exe', 'application/pdf')).toBe(
      'invoice.exe.pdf',
    );
    expect(fileNameForType('image.png', 'application/pdf')).toBeNull();
    expect(fileNameForType('doc.pdf', 'image/jpeg')).toBeNull();
  });

  it('builds an attachment disposition safe for any name', () => {
    expect(attachmentDisposition('Résumé "final".pdf')).toBe(
      `attachment; filename="R_sum_ _final_.pdf"; filename*=UTF-8''R%C3%A9sum%C3%A9%20_final_.pdf`,
    );
    expect(attachmentDisposition('a\r\nSet-Cookie: x.pdf')).not.toMatch(
      /[\r\n]/,
    );
  });
});

describe('Batch 9 object store: keys, tokens and configuration', () => {
  let directory: string;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'b9-store-'));
  });
  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('only accepts server-generated keys and never leaves the storage directory', async () => {
    const store = new LocalDocumentObjectStore(directory, KEY);
    const key = objectKeyFor(ORG, OBJ);
    expect(key).toBe(`documents/${ORG}/${OBJ}`);
    for (const bad of [
      '../etc/passwd',
      `documents/${ORG}/../../../etc/passwd`,
      '/etc/passwd',
      `documents/${ORG}/${OBJ}/../x`,
      'documents/x/y',
    ])
      expect(() => store.pathOf(bad)).toThrow(ObjectStoreError);
    expect(() => objectKeyFor('../x', OBJ)).toThrow();
    const source = join(directory, 'src.bin');
    await writeFile(source, SAMPLE_PDF);
    await store.put({ key, filePath: source });
    expect(await store.head(key)).toEqual({ sizeBytes: SAMPLE_PDF.length });
    // Never overwritten.
    await expect(store.put({ key, filePath: source })).rejects.toMatchObject({
      code: 'DOCUMENT_OBJECT_EXISTS',
    });
    await store.delete(key);
    await store.delete(key);
    expect(await store.head(key)).toBeNull();
  });

  it('signs local download tokens bound to one object, refusing tampering and expiry', () => {
    const now = new Date('2026-03-15T16:00:00.000Z');
    const token = signLocalToken(KEY, OBJ, new Date(now.getTime() + 60_000));
    expect(verifyLocalToken(KEY, token, now)).toBe(OBJ);
    expect(
      verifyLocalToken(KEY, token, new Date(now.getTime() + 60_000)),
    ).toBeNull();
    expect(verifyLocalToken('x'.repeat(40), token, now)).toBeNull();
    const [payload, mac] = token.split('.');
    const otherPayload = Buffer.from(
      `${'33333333-3333-4333-8333-333333333333'}.${Math.floor(now.getTime() / 1000) + 60}`,
    ).toString('base64url');
    expect(verifyLocalToken(KEY, `${otherPayload}.${mac}`, now)).toBeNull();
    expect(verifyLocalToken(KEY, `${payload}.${mac}x`, now)).toBeNull();
    expect(verifyLocalToken(KEY, `${payload}`, now)).toBeNull();
    expect(verifyLocalToken(KEY, `${payload}.${mac}.extra`, now)).toBeNull();
    expect(verifyLocalToken(KEY, 'garbage', now)).toBeNull();
  });

  it('presigns S3-compatible GETs for 60 seconds with a forced download and no credentials in the URL', async () => {
    const store = new S3DocumentObjectStore({
      endpoint: 'https://objects.example.test',
      region: 'region-1',
      bucket: 'hrms-documents',
      accessKeyId: 'AKIDEXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
      forcePathStyle: true,
    });
    const now = new Date('2026-03-15T16:00:00.000Z');
    const signed = await store.downloadUrl({
      objectId: OBJ,
      key: objectKeyFor(ORG, OBJ),
      fileName: 'contract.pdf',
      contentType: 'application/pdf',
      now,
    });
    const url = new URL(signed.url);
    expect(url.origin + url.pathname).toBe(
      `https://objects.example.test/hrms-documents/documents/${ORG}/${OBJ}`,
    );
    expect(url.searchParams.get('X-Amz-Expires')).toBe('60');
    expect(url.searchParams.get('response-content-disposition')).toMatch(
      /^attachment;/,
    );
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
    expect(signed.url).not.toContain('wJalrXUtnFEMI');
    expect(signed.expiresAt.toISOString()).toBe('2026-03-15T16:01:00.000Z');
    // Virtual-hosted style.
    const hosted = new S3DocumentObjectStore({
      endpoint: 'https://objects.example.test',
      region: 'r',
      bucket: 'b-1',
      accessKeyId: 'a',
      secretAccessKey: 's',
      forcePathStyle: false,
    });
    expect(hosted.objectUrl(objectKeyFor(ORG, OBJ))).toBe(
      `https://b-1.objects.example.test/documents/${ORG}/${OBJ}`,
    );
  });

  it('reads storage configuration: none by default, local refused in production, s3 complete and https', () => {
    expect(documentStorageFromEnv({}).store).toBeNull();
    expect(documentStorageFromEnv({}).maxUploadBytes).toBe(10 * 1024 * 1024);
    expect(
      documentStorageFromEnv({
        DOCUMENT_UPLOAD_MAX_BYTES: String(100 * 1024 * 1024),
      }).maxUploadBytes,
    ).toBe(25 * 1024 * 1024);
    // Empty or invalid values keep the default (never a 0- or 1-byte limit).
    for (const value of ['', '  ', 'abc', '0', '-5', '1.5'])
      expect(
        documentStorageFromEnv({ DOCUMENT_UPLOAD_MAX_BYTES: value })
          .maxUploadBytes,
      ).toBe(10 * 1024 * 1024);
    const local = {
      DOCUMENT_STORAGE_DRIVER: 'local',
      DOCUMENT_STORAGE_LOCAL_DIR: directory,
      DOCUMENT_URL_SIGNING_KEY: KEY,
    };
    expect(documentStorageFromEnv(local).store?.backend).toBe('local');
    expect(() =>
      documentStorageFromEnv({ ...local, NODE_ENV: 'production' }),
    ).toThrow(/refused in production/);
    expect(
      documentStorageFromEnv({
        ...local,
        NODE_ENV: 'production',
        DOCUMENT_STORAGE_ALLOW_LOCAL_IN_PRODUCTION: 'true',
      }).store?.backend,
    ).toBe('local');
    expect(() =>
      documentStorageFromEnv({ ...local, DOCUMENT_URL_SIGNING_KEY: 'short' }),
    ).toThrow(/32\+ bytes/);
    const s3 = {
      DOCUMENT_STORAGE_DRIVER: 's3',
      DOCUMENT_S3_ENDPOINT: 'http://127.0.0.1:9000',
      DOCUMENT_S3_REGION: 'r',
      DOCUMENT_S3_BUCKET: 'b',
      DOCUMENT_S3_ACCESS_KEY_ID: 'a',
      DOCUMENT_S3_SECRET_ACCESS_KEY: 's',
    };
    expect(documentStorageFromEnv(s3).store?.backend).toBe('s3');
    expect(() =>
      documentStorageFromEnv({ ...s3, DOCUMENT_S3_BUCKET: '' }),
    ).toThrow(/DOCUMENT_S3_BUCKET/);
    expect(() =>
      documentStorageFromEnv({ ...s3, NODE_ENV: 'production' }),
    ).toThrow(/https/);
    expect(() =>
      documentStorageFromEnv({ DOCUMENT_STORAGE_DRIVER: 'ftp' }),
    ).toThrow();
  });
});
