/**
 * Batch 9 (D3) — what a document file may be, decided from its content (signatures and
 * structure), never from its name or the client's declared type. V1 allows PDF, PNG and JPEG.
 * File names are display metadata only: sanitized here, never used to place an object.
 */

export const ALLOWED_DOCUMENT_TYPES = {
  'application/pdf': ['.pdf'],
  'image/png': ['.png'],
  'image/jpeg': ['.jpg', '.jpeg'],
} as const;
export type DocumentFileType = keyof typeof ALLOWED_DOCUMENT_TYPES;

/** Default upload limit (10 MB) and the hard maximum any configuration may set (25 MB). */
export const DEFAULT_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
export const HARD_UPLOAD_MAX_BYTES = 25 * 1024 * 1024;

/** How many leading / trailing bytes the checks read. */
export const HEAD_BYTES = 16;
export const TAIL_BYTES = 1024;

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const PNG_IEND = Buffer.from([
  0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

export type DetectionResult =
  | { ok: true; type: DocumentFileType }
  | {
      ok: false;
      code: 'DOCUMENT_FILE_TYPE_NOT_ALLOWED' | 'DOCUMENT_FILE_MALFORMED';
    };

/**
 * The file's type from its first and last bytes: a PDF starts with `%PDF-` and ends with an
 * `%%EOF` marker; a PNG has its 8-byte signature, an IHDR first chunk and ends with IEND; a JPEG
 * starts with an SOI marker and ends with EOI. A recognized start without a valid end is
 * malformed (truncated or not what it claims).
 */
export function detectFileType(head: Buffer, tail: Buffer): DetectionResult {
  if (head.length >= 5 && head.subarray(0, 5).toString('latin1') === '%PDF-') {
    return tail.toString('latin1').includes('%%EOF')
      ? { ok: true, type: 'application/pdf' }
      : { ok: false, code: 'DOCUMENT_FILE_MALFORMED' };
  }
  if (head.length >= 16 && head.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return head.subarray(12, 16).toString('latin1') === 'IHDR' &&
      tail.length >= PNG_IEND.length &&
      tail.subarray(tail.length - PNG_IEND.length).equals(PNG_IEND)
      ? { ok: true, type: 'image/png' }
      : { ok: false, code: 'DOCUMENT_FILE_MALFORMED' };
  }
  if (
    head.length >= 3 &&
    head[0] === 0xff &&
    head[1] === 0xd8 &&
    head[2] === 0xff
  ) {
    // EOI, allowing a few bytes of trailing padding some encoders append.
    const end = tail.subarray(Math.max(0, tail.length - 32));
    for (let index = end.length - 2; index >= 0; index -= 1) {
      if (end[index] === 0xff && end[index + 1] === 0xd9)
        return { ok: true, type: 'image/jpeg' };
    }
    return { ok: false, code: 'DOCUMENT_FILE_MALFORMED' };
  }
  return { ok: false, code: 'DOCUMENT_FILE_TYPE_NOT_ALLOWED' };
}

/**
 * A safe display name: the last path segment only, no control or reserved characters, no
 * leading dots, at most 200 characters (keeping the extension), never empty.
 */
export function sanitizeFileName(raw: string | null | undefined) {
  const base = String(raw ?? '')
    .normalize('NFC')
    .split(/[\\/]/)
    .pop()!
    // oxlint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '')
    .replace(/[<>:"|?*;]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '');
  if (!base) return 'document';
  if (base.length <= 200) return base;
  const dot = base.lastIndexOf('.');
  const extension = dot > 0 && base.length - dot <= 10 ? base.slice(dot) : '';
  return base.slice(0, 200 - extension.length) + extension;
}

/** The name's extension (lower case, with the dot), or ''. */
export function extensionOf(fileName: string) {
  const dot = fileName.lastIndexOf('.');
  return dot > 0 ? fileName.slice(dot).toLowerCase() : '';
}

/**
 * The stored display name for a detected type: an allowed extension of that type is kept, a
 * name without an extension gets the type's, and a name claiming another known type is refused
 * (null) — content decides, and a mismatch is reported rather than silently renamed.
 */
export function fileNameForType(
  fileName: string,
  type: DocumentFileType,
): string | null {
  const extension = extensionOf(fileName);
  const allowed: readonly string[] = ALLOWED_DOCUMENT_TYPES[type];
  if (allowed.includes(extension)) return fileName;
  const known = Object.values(ALLOWED_DOCUMENT_TYPES).some((list) =>
    (list as readonly string[]).includes(extension),
  );
  if (known) return null;
  return sanitizeFileName(`${fileName}${allowed[0]}`);
}

/** RFC 6266 attachment disposition with an ASCII fallback and the UTF-8 name. */
export function attachmentDisposition(fileName: string) {
  const safe = sanitizeFileName(fileName);
  const ascii = safe.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(safe).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
