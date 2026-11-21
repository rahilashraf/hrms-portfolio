/** Batch 9: minimal valid PDF, PNG and JPEG files for tests (content checks only). */
export const SAMPLE_PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n',
  'latin1',
);
export const SAMPLE_PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from([0, 0, 0, 13]),
  Buffer.from('IHDR', 'latin1'),
  Buffer.alloc(17),
  Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]),
]);
export const SAMPLE_JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 0xff, 0xd9,
]);
