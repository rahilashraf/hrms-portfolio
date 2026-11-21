/**
 * Batch 11 — a tiny, valid one-page PDF with a few lines of text, generated in code so the demo
 * ships no binary file. The text says it is demonstration data; there is nothing else inside
 * (no scripts, forms, links, fonts beyond the standard Helvetica, or metadata).
 */
export function samplePdf(lines: string[]): Buffer {
  const escape = (text: string) =>
    text.replace(/[\\()]/g, (character) => `\\${character}`);
  const content = [
    'BT',
    '/F1 20 Tf',
    '72 720 Td',
    ...lines.flatMap((line, index) =>
      index === 0
        ? [`(${escape(line)}) Tj`, '/F1 12 Tf']
        : ['0 -24 Td', `(${escape(line)}) Tj`],
    ),
    'ET',
  ].join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
  ];
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body, 'latin1'));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body, 'latin1');
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('');
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}
