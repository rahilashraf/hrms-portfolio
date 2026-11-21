import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
  ServiceUnavailableException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { open, rm } from 'node:fs/promises';
import type { IncomingHttpHeaders } from 'node:http';
import type { Readable } from 'node:stream';
import { domainError } from '../common/domain-support.js';
import { PrismaService } from '../database/prisma.service.js';
import type {
  DocumentScanStatus,
  DocumentStoredObject,
  DocumentUploadPurpose,
} from '../generated/prisma/client.js';
import { Prisma } from '../generated/prisma/client.js';
import { DocumentsAccessService } from './documents-access.service.js';
import { DocumentsAuditAdapter } from './documents-audit.js';
import {
  DocumentsClock,
  type DocumentsRequestContext,
  type Tx,
} from './documents-common.js';
import {
  attachmentDisposition,
  detectFileType,
  fileNameForType,
  TAIL_BYTES,
} from './document-files.js';
import {
  receiveMultipartFile,
  type ReceivedFile,
} from './document-upload-stream.js';
import {
  LocalDocumentObjectStore,
  objectKeyFor,
  ObjectStoreError,
  type DocumentStorageSettings,
} from './document-object-store.js';
import type {
  DocumentMalwareScanner,
  ScanVerdict,
} from './document-scanner.js';

/** Unattached uploads are abandoned (and their objects removed) after this long (D6). */
export const UPLOAD_ABANDON_AFTER_MS = 24 * 3_600_000;

/** What an upload is authorized for (decided by the server from the target and the caller). */
export type UploadTarget =
  | { kind: 'record'; organizationId: string; employeeId: string }
  | { kind: 'version'; documentId: string }
  | { kind: 'self'; organizationId: string }
  | { kind: 'policy'; policyId: string };

export interface AuthorizedUpload {
  userId: string;
  organizationId: string;
  purpose: DocumentUploadPurpose;
  employeeId: string | null;
  documentId: string | null;
  policyId: string | null;
}

/** The binding a version must match to attach an upload (see attachStoredObject). */
export interface AttachBinding {
  actorUserId: string;
  organizationId: string;
  purposes: readonly DocumentUploadPurpose[];
  employeeId?: string | null;
  /** The existing document for a new version; null for a new document. */
  documentId?: string | null;
  policyId?: string | null;
}

export type AttachOutcome =
  | {
      kind: 'ATTACHED';
      version: {
        provider: 'INTERNAL_OBJECT_STORAGE';
        storageKey: string;
        storedObjectId: string;
        fileName: string;
        mimeType: string;
        sizeBytes: number;
      };
    }
  | {
      kind: 'ALREADY_ATTACHED';
      documentId: string | null;
      policyId: string | null;
    };

function fail(status: number, code: string, message: string): never {
  const body = domainError(status as 400, code, message);
  if (status === 400) throw new BadRequestException(body);
  if (status === 403) throw new ForbiddenException(body);
  if (status === 404) throw new NotFoundException(body);
  if (status === 409) throw new ConflictException(body);
  if (status === 413) throw new PayloadTooLargeException(body);
  if (status === 415) throw new UnsupportedMediaTypeException(body);
  if (status === 503) throw new ServiceUnavailableException(body);
  throw new HttpException(body, status);
}

/** Whether an object's bytes may be handed out (attached, and clean or — unless required — unscanned). */
export function downloadable(
  object: Pick<DocumentStoredObject, 'status' | 'scanStatus'>,
  requireScan: boolean,
) {
  return (
    object.status === 'ATTACHED' &&
    (object.scanStatus === 'CLEAN' ||
      (object.scanStatus === 'NOT_SCANNED' && !requireScan))
  );
}

/** Whether DOCUMENT_REQUIRE_MALWARE_SCAN is on (response shapes, without a service). */
export function scanRequiredFromEnv(
  env: Record<string, string | undefined> = process.env,
) {
  return env.DOCUMENT_REQUIRE_MALWARE_SCAN === 'true';
}

/**
 * Binds an uploaded object to the version being created, in the caller's transaction (D2, F2).
 * The object must have been uploaded by the same user for the same organization, purpose and
 * target, be STORED (bytes verified) and not refused by a scan. The STORED→ATTACHED change is
 * conditional and the row is locked, so the cleanup job (which abandons only STORED/UPLOADING
 * rows, and the database refuses abandoning a referenced one) can never remove an object that
 * a version just took. Re-sending the same upload for the same target reports ALREADY_ATTACHED
 * (an idempotent retry) instead of attaching twice.
 */
export async function attachStoredObject(
  tx: Tx,
  uploadId: string,
  binding: AttachBinding,
  now: Date,
): Promise<AttachOutcome> {
  const [row] = await tx.$queryRaw<DocumentStoredObject[]>(Prisma.sql`
    SELECT * FROM "DocumentStoredObject" WHERE "id" = ${uploadId}::uuid FOR UPDATE`);
  const mismatch =
    !row ||
    row.organizationId !== binding.organizationId ||
    row.uploadedByUserId !== binding.actorUserId ||
    !binding.purposes.includes(row.purpose) ||
    (binding.employeeId !== undefined &&
      row.employeeId !== binding.employeeId) ||
    (binding.documentId !== undefined &&
      row.documentId !== binding.documentId) ||
    (binding.policyId !== undefined && row.policyId !== binding.policyId);
  if (mismatch)
    fail(
      400,
      'DOCUMENT_UPLOAD_INVALID',
      'The upload does not belong to this record.',
    );
  if (row.status === 'ATTACHED') {
    const employee = await tx.employeeDocumentVersion.findUnique({
      where: { storedObjectId: row.id },
      select: { documentId: true },
    });
    const policy = employee
      ? null
      : await tx.policyDocumentVersion.findUnique({
          where: { storedObjectId: row.id },
          select: { policyId: true },
        });
    if (
      (employee &&
        (binding.documentId === undefined ||
          binding.documentId === null ||
          employee.documentId === binding.documentId)) ||
      (policy && policy.policyId === binding.policyId)
    )
      return {
        kind: 'ALREADY_ATTACHED',
        documentId: employee?.documentId ?? null,
        policyId: policy?.policyId ?? null,
      };
    fail(
      409,
      'DOCUMENT_UPLOAD_USED',
      'The upload is already part of a document.',
    );
  }
  if (row.status !== 'STORED')
    fail(
      409,
      'DOCUMENT_UPLOAD_EXPIRED',
      'The upload is no longer available; upload the file again.',
    );
  if (row.scanStatus === 'INFECTED' || row.scanStatus === 'FAILED')
    fail(
      409,
      'DOCUMENT_FILE_QUARANTINED',
      'The file was refused by the malware scan.',
    );
  const updated = await tx.documentStoredObject.updateMany({
    where: { id: row.id, status: 'STORED' },
    data: { status: 'ATTACHED', attachedAt: now },
  });
  if (updated.count !== 1)
    fail(
      409,
      'DOCUMENT_UPLOAD_EXPIRED',
      'The upload is no longer available; upload the file again.',
    );
  return {
    kind: 'ATTACHED',
    version: {
      provider: 'INTERNAL_OBJECT_STORAGE',
      storageKey: row.storageKey,
      storedObjectId: row.id,
      fileName: row.fileName,
      mimeType: row.detectedMimeType!,
      sizeBytes: row.sizeBytes!,
    },
  };
}

export const DOCUMENT_STORAGE_SETTINGS = Symbol('DOCUMENT_STORAGE_SETTINGS');

/**
 * Batch 9 — document files: streamed uploads (authorized before any byte is read, size-limited
 * while streaming, content-checked, optionally scanned, stored under a server-generated key and
 * recorded in the DocumentStoredObject ledger), short-lived download URLs (authorized on every
 * request against the document's current confidentiality), the local download handler, scan
 * results and the cleanup of abandoned uploads.
 *
 * Object writes are not part of any database transaction: the ledger row is committed
 * (UPLOADING) before the bytes are written and marked STORED after, so a crash or a failed write
 * leaves a row the cleanup job finds; a failed database step after the write leaves a STORED row
 * that is never attached and is cleaned the same way. Nothing is ever overwritten.
 */
@Injectable()
export class DocumentFileService {
  private readonly logger = new Logger('DocumentFiles');

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: DocumentsAccessService,
    private readonly audit: DocumentsAuditAdapter,
    private readonly clock: DocumentsClock,
    private readonly storage: DocumentStorageSettings,
    private readonly scanner: DocumentMalwareScanner | null = null,
  ) {}

  get configured() {
    return this.storage.store !== null;
  }

  get maxUploadBytes() {
    return this.storage.maxUploadBytes;
  }

  /** What the web needs to offer uploads: whether they can succeed, and the size limit. */
  get uploads() {
    return {
      enabled:
        this.storage.store !== null &&
        !(this.storage.requireMalwareScan && this.scanner === null),
      maxBytes: this.storage.maxUploadBytes,
      allowedTypes: ['application/pdf', 'image/png', 'image/jpeg'],
    };
  }

  private requireStore() {
    if (!this.storage.store)
      fail(
        503,
        'DOCUMENT_STORAGE_NOT_CONFIGURED',
        'File storage is not configured.',
      );
    return this.storage.store;
  }

  // ─── Authorization (before any file byte is read) ─────────────────────────

  async authorize(
    userId: string,
    target: UploadTarget,
  ): Promise<AuthorizedUpload> {
    this.requireStore();
    if (this.storage.requireMalwareScan && !this.scanner)
      fail(
        503,
        'DOCUMENT_SCAN_REQUIRED',
        'Uploads need a malware scanner, which is not configured.',
      );
    if (target.kind === 'record') {
      const access = await this.access.employeeAccess(
        userId,
        target.employeeId,
        target.organizationId,
      );
      if (
        !access.targets.length ||
        (!access.isSelf && access.clearance < 0 && !access.canManage)
      )
        throw new NotFoundException('Employee not found.');
      if (access.isSelf)
        fail(
          403,
          'DOCUMENT_SELF_MANAGEMENT',
          'You cannot manage your own employee records.',
        );
      if (!access.canManage || access.clearance < 0)
        throw new ForbiddenException(
          'Missing permission document.manage for the employee.',
        );
      return {
        userId,
        organizationId: target.organizationId,
        purpose: 'EMPLOYEE_DOCUMENT',
        employeeId: target.employeeId,
        documentId: null,
        policyId: null,
      };
    }
    if (target.kind === 'version') {
      const document = await this.prisma.employeeDocument.findUnique({
        where: { id: target.documentId },
        include: { type: true },
      });
      if (!document) throw this.access.notFound();
      const access = await this.access.employeeAccess(
        userId,
        document.employeeId,
        document.organizationId,
        this.prisma,
        await this.access.grants(userId),
      );
      const ownProvided =
        access.isSelf &&
        document.source === 'EMPLOYEE' &&
        document.type.employeeProvided &&
        document.confidentiality === 'EMPLOYEE_VISIBLE';
      if (!ownProvided) {
        if (!this.access.canReadLevel(access, document.confidentiality))
          throw this.access.notFound();
        this.access.requireManageLevel(access, document.confidentiality);
        await this.access.requireEnabled(document.organizationId);
      } else {
        await this.access.requireEnabled(document.organizationId);
        await this.access.features.requireSetting(
          document.organizationId,
          'documents.selfServiceProvide',
        );
      }
      if (document.status !== 'ACTIVE')
        fail(409, 'DOCUMENT_ARCHIVED', 'The document is archived.');
      return {
        userId,
        organizationId: document.organizationId,
        purpose: ownProvided ? 'SELF_SERVICE' : 'EMPLOYEE_DOCUMENT',
        employeeId: document.employeeId,
        documentId: document.id,
        policyId: null,
      };
    }
    if (target.kind === 'self') {
      const employeeId = await this.access.employeeIdOfUser(userId);
      if (!employeeId)
        fail(
          403,
          'DOCUMENT_NOT_AN_EMPLOYEE',
          'Your account is not linked to an employee.',
        );
      const inOrganization = await this.prisma.employmentAssignment.count({
        where: {
          employeeId,
          status: { not: 'CANCELLED' },
          position: { organizationId: target.organizationId },
        },
      });
      if (!inOrganization)
        throw new NotFoundException('Organization not found.');
      await this.access.requireEnabled(target.organizationId);
      await this.access.features.requireSetting(
        target.organizationId,
        'documents.selfServiceProvide',
      );
      return {
        userId,
        organizationId: target.organizationId,
        purpose: 'SELF_SERVICE',
        employeeId,
        documentId: null,
        policyId: null,
      };
    }
    const policy = await this.prisma.policyDocument.findUnique({
      where: { id: target.policyId },
    });
    if (!policy) throw new NotFoundException('Policy not found.');
    const grants = await this.access.grants(userId);
    if (
      !this.access.canInOrganization(
        grants,
        'document.policy.manage',
        policy.organizationId,
      )
    ) {
      if (
        !(await this.access.hasAnyInOrganization(policy.organizationId, grants))
      )
        throw new NotFoundException('Policy not found.');
      throw new ForbiddenException(
        'Missing permission document.policy.manage for the organization.',
      );
    }
    await this.access.requireEnabled(policy.organizationId);
    if (policy.status === 'RETIRED')
      fail(409, 'POLICY_RETIRED', 'A retired policy is frozen.');
    return {
      userId,
      organizationId: policy.organizationId,
      purpose: 'POLICY_VERSION',
      employeeId: null,
      documentId: null,
      policyId: policy.id,
    };
  }

  // ─── Upload ───────────────────────────────────────────────────────────────

  /**
   * Streams one multipart file part (field `file`) to a private temporary file with a running
   * size limit and SHA-256, checks its content, scans it when a scanner is registered, then
   * records and stores it. The response describes the upload (id, safe name, size, detected
   * type, scan state) — never its key.
   */
  async receive(
    authorized: AuthorizedUpload,
    request: { headers: IncomingHttpHeaders; stream: Readable },
    context: DocumentsRequestContext,
  ) {
    const store = this.requireStore();
    const limit = this.storage.maxUploadBytes;
    const declared = Number(request.headers['content-length'] ?? 0);
    if (declared && declared > limit + 64 * 1024)
      fail(
        413,
        'DOCUMENT_FILE_TOO_LARGE',
        `Files may be at most ${limit} bytes.`,
      );
    if (
      !/^multipart\/form-data/i.test(
        String(request.headers['content-type'] ?? ''),
      )
    )
      fail(
        400,
        'DOCUMENT_UPLOAD_INVALID',
        'Send the file as multipart/form-data (field "file").',
      );
    const received = await this.stream(request, limit);
    try {
      const tail = await readTail(received.path, received.sizeBytes);
      const detected = detectFileType(received.head, tail);
      if (!detected.ok) {
        if (detected.code === 'DOCUMENT_FILE_MALFORMED')
          fail(
            400,
            detected.code,
            'The file is damaged or not what its type claims.',
          );
        fail(415, detected.code, 'Only PDF, PNG and JPEG files are accepted.');
      }
      const fileName = fileNameForType(received.fileName, detected.type);
      if (!fileName)
        fail(
          415,
          'DOCUMENT_FILE_TYPE_MISMATCH',
          "The file's content does not match its extension.",
        );
      const file = {
        sizeBytes: received.sizeBytes,
        mimeType: detected.type,
        sha256: received.sha256,
      };
      let verdict: ScanVerdict | null = null;
      if (this.scanner) {
        try {
          verdict = await this.scanner.scan(received.path, file);
        } catch {
          fail(
            503,
            'DOCUMENT_SCAN_UNAVAILABLE',
            'The malware scan is unavailable; try again later.',
          );
        }
      }
      const scanStatus: DocumentScanStatus =
        verdict === null
          ? 'NOT_SCANNED'
          : verdict === 'CLEAN'
            ? 'CLEAN'
            : verdict === 'PENDING'
              ? 'PENDING'
              : 'INFECTED';
      const id = randomUUID();
      const key = objectKeyFor(authorized.organizationId, id);
      // Committed before the write: a crash leaves a row the cleanup finds.
      await this.prisma.documentStoredObject.create({
        data: {
          id,
          organizationId: authorized.organizationId,
          purpose: authorized.purpose,
          employeeId: authorized.employeeId,
          documentId: authorized.documentId,
          policyId: authorized.policyId,
          backend: store.backend,
          storageKey: key,
          fileName,
          uploadedByUserId: authorized.userId,
          scanStatus,
        },
      });
      if (scanStatus === 'INFECTED') {
        await this.prisma.documentStoredObject.update({
          where: { id },
          data: { status: 'REJECTED', rejectionCode: 'MALWARE_DETECTED' },
        });
        await this.auditUpload(
          authorized,
          id,
          file,
          scanStatus,
          context,
          'DOCUMENT_FILE_REJECTED',
        );
        fail(
          422,
          'DOCUMENT_FILE_INFECTED',
          'The file was refused by the malware scan.',
        );
      }
      try {
        await store.put({
          key,
          filePath: received.path,
          ...file,
          contentType: file.mimeType,
        });
      } catch (error) {
        await this.abandon(id, key).catch(() => undefined);
        this.logger.warn(
          `Document upload ${id} could not be stored: ${error instanceof ObjectStoreError ? error.code : 'error'}.`,
        );
        fail(
          503,
          'DOCUMENT_STORAGE_UNAVAILABLE',
          'The file could not be stored; try again.',
        );
      }
      await this.prisma.documentStoredObject.update({
        where: { id },
        data: {
          status: 'STORED',
          storedAt: this.clock.now(),
          sizeBytes: file.sizeBytes,
          sha256: file.sha256,
          detectedMimeType: file.mimeType,
        },
      });
      await this.auditUpload(
        authorized,
        id,
        file,
        scanStatus,
        context,
        'DOCUMENT_FILE_UPLOADED',
      );
      return {
        id,
        fileName,
        sizeBytes: file.sizeBytes,
        mimeType: file.mimeType,
        scanStatus,
      };
    } finally {
      await rm(received.directory, { recursive: true, force: true });
    }
  }

  /** One file part, streamed into a temporary directory (see receiveMultipartFile). */
  private stream(
    request: { headers: IncomingHttpHeaders; stream: Readable },
    limit: number,
  ): Promise<ReceivedFile> {
    return receiveMultipartFile(request, limit);
  }

  private auditUpload(
    authorized: AuthorizedUpload,
    objectId: string,
    file: { sizeBytes: number; mimeType: string },
    scanStatus: DocumentScanStatus,
    context: DocumentsRequestContext,
    action: 'DOCUMENT_FILE_UPLOADED' | 'DOCUMENT_FILE_REJECTED',
  ) {
    // Ids, size, type and scan state only: never the key, the file name or a URL.
    return this.audit.write(
      this.prisma,
      action,
      'DocumentStoredObject',
      objectId,
      context,
      {
        organizationId: authorized.organizationId,
        purpose: authorized.purpose,
        employeeId: authorized.employeeId,
        documentId: authorized.documentId,
        policyId: authorized.policyId,
        sizeBytes: file.sizeBytes,
        mimeType: file.mimeType,
        scanStatus,
      },
    );
  }

  private async abandon(id: string, key: string) {
    await this.prisma.documentStoredObject.updateMany({
      where: { id, status: { in: ['UPLOADING', 'STORED'] } },
      data: { status: 'ABANDONED', abandonedAt: this.clock.now() },
    });
    await this.storage.store?.delete(key);
    await this.prisma.documentStoredObject.updateMany({
      where: { id, status: 'ABANDONED' },
      data: { status: 'DELETED', deletedAt: this.clock.now() },
    });
  }

  // ─── Download URLs (authorized on every request) ──────────────────────────

  /** A 60-second download URL for one version of an employee document the caller may read. */
  async employeeVersionUrl(
    userId: string,
    documentId: string,
    versionId: string,
    context: DocumentsRequestContext,
  ) {
    const document = await this.prisma.employeeDocument.findUnique({
      where: { id: documentId },
    });
    if (!document) throw this.access.notFound();
    const access = await this.access.employeeAccess(
      userId,
      document.employeeId,
      document.organizationId,
      this.prisma,
      await this.access.grants(userId),
    );
    // Every version follows the document's current level (D7).
    if (!this.access.canReadLevel(access, document.confidentiality))
      throw this.access.notFound();
    await this.access.requireEnabled(document.organizationId);
    const version = await this.prisma.employeeDocumentVersion.findFirst({
      where: { id: versionId, documentId },
      include: { storedObject: true },
    });
    if (!version) throw this.access.notFound();
    const url = await this.issue(version.storedObject, version.provider);
    await this.audit.write(
      this.prisma,
      'DOCUMENT_FILE_URL_ISSUED',
      'EmployeeDocument',
      documentId,
      context,
      {
        organizationId: document.organizationId,
        employeeId: document.employeeId,
        versionId,
        versionNumber: version.versionNumber,
        confidentiality: document.confidentiality,
      },
    );
    return url;
  }

  /** A download URL for a policy version: drafts for policy managers, published ones for its readers. */
  async policyVersionUrl(
    userId: string,
    policyId: string,
    versionId: string,
    context: DocumentsRequestContext,
  ) {
    const policy = await this.prisma.policyDocument.findUnique({
      where: { id: policyId },
    });
    if (!policy) throw new NotFoundException('Policy not found.');
    const version = await this.prisma.policyDocumentVersion.findFirst({
      where: { id: versionId, policyId },
      include: { storedObject: true },
    });
    const grants = await this.access.grants(userId);
    const manager = this.access.canInOrganization(
      grants,
      'document.policy.manage',
      policy.organizationId,
    );
    // Batch 9 (review): readers who do not manage policies see published versions of
    // published policies only (as the policy list shows them) — never drafts or retired ones.
    let allowed = manager;
    if (!allowed && version?.publishedAt && policy.status === 'PUBLISHED') {
      allowed = await this.access.hasAnyInOrganization(
        policy.organizationId,
        grants,
      );
      if (!allowed) {
        const employeeId = await this.access.employeeIdOfUser(userId);
        allowed =
          employeeId !== null &&
          (await this.inPolicyAudience(policy, employeeId));
      }
    }
    if (!version || !allowed) throw new NotFoundException('Policy not found.');
    await this.access.requireEnabled(policy.organizationId);
    const url = await this.issue(version.storedObject, version.provider);
    await this.audit.write(
      this.prisma,
      'DOCUMENT_FILE_URL_ISSUED',
      'PolicyDocument',
      policyId,
      context,
      {
        organizationId: policy.organizationId,
        versionId,
        versionNumber: version.versionNumber,
      },
    );
    return url;
  }

  private async inPolicyAudience(
    policy: {
      organizationId: string;
      audienceDepartmentId: string | null;
      audienceEmploymentType: string | null;
    },
    employeeId: string,
  ) {
    return (
      (await this.prisma.employmentAssignment.count({
        where: {
          employeeId,
          status: { in: ['ACTIVE', 'PLANNED'] },
          position: {
            organizationId: policy.organizationId,
            ...(policy.audienceDepartmentId
              ? { departmentId: policy.audienceDepartmentId }
              : {}),
          },
          ...(policy.audienceEmploymentType
            ? { employmentType: policy.audienceEmploymentType as never }
            : {}),
        },
      })) > 0
    );
  }

  private async issue(object: DocumentStoredObject | null, provider: string) {
    if (!object)
      fail(
        409,
        provider === 'INTERNAL_OBJECT_STORAGE'
          ? 'DOCUMENT_LEGACY_REFERENCE'
          : 'DOCUMENT_NOT_A_STORED_FILE',
        provider === 'INTERNAL_OBJECT_STORAGE'
          ? 'This is a legacy reference, not a stored file.'
          : 'This version is a link or reference, not a stored file.',
      );
    if (!downloadable(object, this.storage.requireMalwareScan))
      fail(
        409,
        object.status === 'ATTACHED'
          ? 'DOCUMENT_FILE_QUARANTINED'
          : 'DOCUMENT_FILE_UNAVAILABLE',
        object.status === 'ATTACHED'
          ? 'The file is not available until its malware scan is clean.'
          : 'The file is not available.',
      );
    const store = this.requireStore();
    if (object.backend !== store.backend)
      fail(
        503,
        'DOCUMENT_STORAGE_UNAVAILABLE',
        'The file is held by another storage backend.',
      );
    const signed = await store.downloadUrl({
      objectId: object.id,
      key: object.storageKey,
      fileName: object.fileName,
      contentType: object.detectedMimeType!,
      now: this.clock.now(),
    });
    // Never logged or audited: the response is the only place a URL appears.
    return {
      url: signed.url,
      expiresAt: signed.expiresAt.toISOString(),
      fileName: object.fileName,
      mimeType: object.detectedMimeType,
      sizeBytes: object.sizeBytes,
    };
  }

  /**
   * The local download (GET /documents/files/:token): a valid, unexpired token bound to an
   * object that is still attached and downloadable. Anything else is a plain 404.
   */
  async localDownload(token: string) {
    const store = this.storage.store;
    if (!(store instanceof LocalDocumentObjectStore))
      throw new NotFoundException('File not found.');
    const objectId = store.verifyToken(token, this.clock.now());
    if (!objectId) throw new NotFoundException('File not found.');
    const object = await this.prisma.documentStoredObject.findUnique({
      where: { id: objectId },
    });
    if (
      !object ||
      object.backend !== 'local' ||
      !downloadable(object, this.storage.requireMalwareScan) ||
      !(await store.head(object.storageKey))
    )
      throw new NotFoundException('File not found.');
    return {
      stream: store.openRead(object.storageKey),
      headers: {
        'Content-Type': object.detectedMimeType!,
        'Content-Length': String(object.sizeBytes),
        'Content-Disposition': attachmentDisposition(object.fileName),
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'none'; sandbox",
      },
    };
  }

  // ─── Scanning and cleanup ─────────────────────────────────────────────────

  /** An asynchronous scanner's result for a PENDING object (recorded once). */
  async recordScanResult(
    objectId: string,
    result: 'CLEAN' | 'INFECTED' | 'FAILED',
  ) {
    const updated = await this.prisma.documentStoredObject.updateMany({
      where: { id: objectId, scanStatus: 'PENDING' },
      data: { scanStatus: result },
    });
    return { updated: updated.count === 1 };
  }

  /**
   * Abandons uploads never attached within UPLOAD_ABANDON_AFTER_MS (rows locked SKIP LOCKED;
   * the conditional update and the database guard refuse a referenced object), then removes
   * their objects and marks them DELETED. Idempotent: a failed removal is retried next run.
   */
  async cleanupAbandoned(
    options: { olderThanMs?: number; batchSize?: number } = {},
  ) {
    const store = this.storage.store;
    const outcome = {
      abandoned: 0,
      deleted: 0,
      skipped: 0,
      failed: [] as Array<{ objectId: string; message: string }>,
    };
    if (!store) return outcome;
    const cutoff = new Date(
      this.clock.now().getTime() -
        (options.olderThanMs ?? UPLOAD_ABANDON_AFTER_MS),
    );
    const batchSize = Math.min(Math.max(options.batchSize ?? 100, 1), 1000);
    const marked = await this.prisma.$transaction(async (tx) => {
      const due = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id" FROM "DocumentStoredObject"
        WHERE "status" IN ('UPLOADING', 'STORED') AND "createdAt" < ${cutoff}
        ORDER BY "createdAt" ASC, "id" ASC
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED`);
      if (due.length === 0) return 0;
      const result = await tx.documentStoredObject.updateMany({
        where: {
          id: { in: due.map((row) => row.id) },
          status: { in: ['UPLOADING', 'STORED'] },
        },
        data: { status: 'ABANDONED', abandonedAt: this.clock.now() },
      });
      return result.count;
    });
    outcome.abandoned = marked;
    const abandoned = await this.prisma.documentStoredObject.findMany({
      // Only this backend's objects: others never take the batch's places (review).
      where: { status: 'ABANDONED', backend: store.backend },
      orderBy: { abandonedAt: 'asc' },
      take: batchSize,
    });
    for (const object of abandoned) {
      if (object.backend !== store.backend) {
        outcome.skipped += 1;
        continue;
      }
      try {
        await store.delete(object.storageKey);
        await this.prisma.documentStoredObject.updateMany({
          where: { id: object.id, status: 'ABANDONED' },
          data: { status: 'DELETED', deletedAt: this.clock.now() },
        });
        outcome.deleted += 1;
      } catch (error) {
        outcome.failed.push({
          objectId: object.id,
          message: error instanceof ObjectStoreError ? error.code : 'error',
        });
      }
    }
    return outcome;
  }
}

async function readTail(path: string, size: number) {
  const handle = await open(path, 'r');
  try {
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    return buffer;
  } finally {
    await handle.close();
  }
}
