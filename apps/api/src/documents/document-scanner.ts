/**
 * Batch 9 (D5) — the optional malware-scanning boundary. No scanner is registered by default:
 * files are then recorded NOT_SCANNED (never presented as clean). A registered scanner decides
 * per upload:
 *
 * - CLEAN: stored and downloadable;
 * - INFECTED: refused — never stored, never downloadable;
 * - PENDING: an asynchronous scanner; the file is stored quarantined (not downloadable) until
 *   DocumentFileService.recordScanResult records CLEAN (or INFECTED / FAILED, which keep it
 *   quarantined for good).
 *
 * A scanner that throws fails the upload (DOCUMENT_SCAN_UNAVAILABLE): nothing is stored.
 * DOCUMENT_REQUIRE_MALWARE_SCAN=true refuses uploads without a scanner and makes NOT_SCANNED
 * files undownloadable — the future production-hardening switch, with no storage redesign.
 */
export const DOCUMENT_MALWARE_SCANNER = Symbol('DOCUMENT_MALWARE_SCANNER');

export type ScanVerdict = 'CLEAN' | 'INFECTED' | 'PENDING';

export interface DocumentMalwareScanner {
  readonly name: string;
  scan(
    filePath: string,
    file: { sizeBytes: number; mimeType: string; sha256: string },
  ): Promise<ScanVerdict>;
}
