import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  requireActor,
  domainError,
  addDays,
  positionTargets,
} from '../common/domain-support.js';
import { PrismaService } from '../database/prisma.service.js';
import type {
  DocumentConfidentiality,
  EmployeeDocument,
  DocumentStoredObject,
  EmployeeDocumentVersion,
  Prisma,
} from '../generated/prisma/client.js';
import { RecruitmentAccessService } from '../recruitment/recruitment-access.service.js';
import {
  DocumentsAccessService,
  type EmployeeDocumentAccess,
} from './documents-access.service.js';
import {
  conflict,
  DocumentsClock,
  documentsToday,
  isoDate,
  lockDocument,
  optionalDate,
  personName,
  type DocumentsClient,
  type DocumentsRequestContext,
  type Tx,
} from './documents-common.js';
import {
  EXPIRING_SOON_DAYS,
  expiryStatus,
  invalid,
  parseStorageReference,
  parseText,
  requirementApplies,
  satisfies,
  type StorageReferenceInput,
} from './documents-domain.js';
import {
  attachStoredObject,
  downloadable,
  scanRequiredFromEnv,
  type AttachBinding,
} from './document-file.service.js';
import { DocumentsAuditAdapter } from './documents-audit.js';
import { DocumentTypeService, typeShape } from './document-type.service.js';

export interface VersionInput extends StorageReferenceInput {
  issuedOn?: string | null;
  effectiveOn?: string | null;
  expiresOn?: string | null;
  note?: string | null;
}

export interface CreateDocumentInput {
  organizationId: string;
  employeeId: string;
  employmentAssignmentId?: string | null;
  typeId: string;
  title: string;
  description?: string | null;
  confidentiality?: DocumentConfidentiality | null;
  version: VersionInput;
}

export const DOCUMENT_INCLUDE = {
  type: true,
  versions: {
    orderBy: [{ versionNumber: 'desc' }],
    include: { storedObject: true },
  },
} satisfies Prisma.EmployeeDocumentInclude;

type DocumentRow = Prisma.EmployeeDocumentGetPayload<{
  include: typeof DOCUMENT_INCLUDE;
}>;

/** An uploaded file's public description (never its key). */
export function fileShape(object: DocumentStoredObject | null) {
  if (!object) return null;
  return {
    fileName: object.fileName,
    sizeBytes: object.sizeBytes,
    mimeType: object.detectedMimeType,
    scanStatus: object.scanStatus,
    downloadable: downloadable(object, scanRequiredFromEnv()),
  };
}

/**
 * Batch 9 (F3/F4): a version as a reader sees it. Internal storage keys are never returned;
 * provider file ids only to those who manage the document. An uploaded file is described by
 * `file` (name, size, detected type, scan state, whether it can be downloaded now); a legacy
 * internal reference (a hand-typed key from before Batch 9) has no file and is never downloadable.
 */
export function versionShape(
  version: EmployeeDocumentVersion & {
    storedObject?: DocumentStoredObject | null;
  },
  today: Date,
  options: { manager: boolean } = { manager: false },
) {
  const object = version.storedObject ?? null;
  return {
    id: version.id,
    versionNumber: version.versionNumber,
    provider: version.provider,
    externalUrl: version.externalUrl,
    ...(options.manager ? { externalFileId: version.externalFileId } : {}),
    fileName: version.fileName,
    mimeType: version.mimeType,
    sizeBytes: version.sizeBytes,
    file: fileShape(object),
    legacyReference:
      version.provider === 'INTERNAL_OBJECT_STORAGE' &&
      version.storedObjectId === null,
    issuedOn: isoDate(version.issuedOn),
    effectiveOn: isoDate(version.effectiveOn),
    expiresOn: isoDate(version.expiresOn),
    expiryStatus: expiryStatus(version.expiresOn, today),
    note: version.note,
    referenceStatus: version.referenceStatus,
    current: version.supersededAt === null,
    supersededAt: version.supersededAt?.toISOString() ?? null,
    createdAt: version.createdAt.toISOString(),
  };
}

export function documentShape(
  row: DocumentRow,
  today: Date,
  options: { canManage: boolean; history: boolean },
) {
  const current =
    row.versions.find((version) => version.supersededAt === null) ?? null;
  return {
    id: row.id,
    organizationId: row.organizationId,
    employeeId: row.employeeId,
    employmentAssignmentId: row.employmentAssignmentId,
    type: {
      id: row.type.id,
      code: row.type.code,
      name: row.type.name,
      category: row.type.category,
      expiryTracked: row.type.expiryTracked,
    },
    title: row.title,
    description: row.description,
    confidentiality: row.confidentiality,
    status: row.status,
    source: row.source,
    provenance: row.recruitmentHireId
      ? {
          recruitmentHireId: row.recruitmentHireId,
          recruitmentDocumentId: row.recruitmentDocumentId,
        }
      : null,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    currentVersion: current
      ? versionShape(current, today, { manager: options.canManage })
      : null,
    expiryStatus: expiryStatus(current?.expiresOn ?? null, today),
    versions: options.history
      ? row.versions.map((version) =>
          versionShape(version, today, { manager: options.canManage }),
        )
      : [],
    createdAt: row.createdAt.toISOString(),
    actions: { canManage: options.canManage && row.status === 'ACTIVE' },
  };
}

/** Phase 19: most dashboard rows one request returns (the response says when it is cut). */
export const DASHBOARD_LIMIT = 1000;

/**
 * Phase 15 — employee documents and records: metadata with versioned storage references (never
 * contents). Versions are numbered in sequence under a document lock and the database keeps one
 * current version; replacing a document adds a version, never overwrites one. Expiry is
 * date-derived from the current version. Confidentiality gates every read; changes are audited.
 */
@Injectable()
export class EmployeeDocumentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: DocumentsAccessService,
    private readonly audit: DocumentsAuditAdapter,
    private readonly clock: DocumentsClock,
    private readonly types: DocumentTypeService,
    private readonly recruitment: RecruitmentAccessService,
  ) {}

  async create(input: CreateDocumentInput, context: DocumentsRequestContext) {
    const actor = requireActor(context);
    const reference = parseStorageReference(input.version);
    return this.prisma.$transaction(async (tx) => {
      await this.types.ensureDefaults(tx, input.organizationId, actor);
      const type = await this.activeType(
        tx,
        input.organizationId,
        input.typeId,
      );
      const level = input.confidentiality ?? type.defaultConfidentiality;
      const access = await this.access.employeeAccess(
        actor,
        input.employeeId,
        input.organizationId,
        tx,
      );
      if (!access.targets.length)
        throw new NotFoundException('Employee not found.');
      this.access.requireManageLevel(access, level);
      if (input.employmentAssignmentId)
        await this.assignmentOf(
          tx,
          input.employeeId,
          input.organizationId,
          input.employmentAssignmentId,
        );
      const versionValues = this.versionValues(
        input.version,
        type.expiryTracked,
      );
      const stored = await this.attachUpload(tx, reference, {
        actorUserId: actor,
        organizationId: input.organizationId,
        purposes: ['EMPLOYEE_DOCUMENT'],
        employeeId: input.employeeId,
        documentId: null,
      });
      // Batch 9 (review): a retry returns the record only if the caller can still read it at its
      // current level (it may have been reclassified since the first attempt).
      if (isRetry(stored))
        return this.shapeById(tx, stored.documentId, access, {
          requireReadable: true,
        });
      const document = await tx.employeeDocument.create({
        data: {
          organizationId: input.organizationId,
          employeeId: input.employeeId,
          employmentAssignmentId: input.employmentAssignmentId ?? null,
          typeId: type.id,
          title: parseText(input.title, 'title', { required: true, max: 300 })!,
          description: parseText(input.description, 'description'),
          confidentiality: level,
          source: 'HR',
          createdByUserId: actor,
        },
      });
      await tx.employeeDocumentVersion.create({
        data: {
          documentId: document.id,
          versionNumber: 1,
          ...this.referenceColumns(reference, stored),
          ...versionValues,
          createdByUserId: actor,
        },
      });
      await this.audit.write(
        tx,
        'EMPLOYEE_DOCUMENT_CREATED',
        'EmployeeDocument',
        document.id,
        context,
        {
          organizationId: input.organizationId,
          employeeId: input.employeeId,
          typeId: type.id,
          confidentiality: level,
          provider: reference.provider,
          expiresOn: isoDate(versionValues.expiresOn),
        },
      );
      return this.shapeById(tx, document.id, access);
    });
  }

  /**
   * A new version (a renewal, correction or replacement): numbered after the last one under the
   * document lock; the previous current version is superseded, never changed.
   */
  async addVersion(
    documentId: string,
    input: VersionInput,
    context: DocumentsRequestContext,
  ) {
    const actor = requireActor(context);
    const reference = parseStorageReference(input);
    return this.prisma.$transaction(async (tx) => {
      await lockDocument(tx, documentId);
      const document = await tx.employeeDocument.findUniqueOrThrow({
        where: { id: documentId },
        include: { type: true },
      });
      const access = await this.access.employeeAccess(
        actor,
        document.employeeId,
        document.organizationId,
        tx,
      );
      // Batch 9 (F1): only while the document is still EMPLOYEE_VISIBLE — once HR reclassified
      // it, it is not found for the employee like any document they may not read.
      const ownProvided =
        access.isSelf &&
        document.source === 'EMPLOYEE' &&
        document.type.employeeProvided &&
        document.confidentiality === 'EMPLOYEE_VISIBLE';
      if (!ownProvided) {
        if (!this.access.canReadLevel(access, document.confidentiality))
          throw this.access.notFound();
        this.access.requireManageLevel(access, document.confidentiality);
      } else {
        await this.requireSelfService(tx, document.organizationId);
      }
      if (document.status !== 'ACTIVE')
        throw conflict('DOCUMENT_ARCHIVED', 'The document is archived.');
      const versionValues = this.versionValues(
        input,
        document.type.expiryTracked,
      );
      const stored = await this.attachUpload(tx, reference, {
        actorUserId: actor,
        organizationId: document.organizationId,
        purposes: ownProvided ? ['SELF_SERVICE'] : ['EMPLOYEE_DOCUMENT'],
        employeeId: document.employeeId,
        documentId,
      });
      if (isRetry(stored)) return this.shapeById(tx, documentId, access);
      const last = await tx.employeeDocumentVersion.findFirst({
        where: { documentId },
        orderBy: { versionNumber: 'desc' },
      });
      const now = this.clock.now();
      await tx.employeeDocumentVersion.updateMany({
        where: { documentId, supersededAt: null },
        data: { supersededAt: now },
      });
      const version = await tx.employeeDocumentVersion.create({
        data: {
          documentId,
          versionNumber: (last?.versionNumber ?? 0) + 1,
          ...this.referenceColumns(reference, stored),
          ...versionValues,
          createdByUserId: actor,
        },
      });
      await this.audit.write(
        tx,
        'EMPLOYEE_DOCUMENT_VERSION_ADDED',
        'EmployeeDocument',
        documentId,
        context,
        {
          organizationId: document.organizationId,
          employeeId: document.employeeId,
          versionNumber: version.versionNumber,
          provider: reference.provider,
          expiresOn: isoDate(version.expiresOn),
          selfProvided: ownProvided,
        },
      );
      return this.shapeById(tx, documentId, access);
    });
  }

  /** Title / description / confidentiality (re-classifying needs clearance for both levels). */
  async update(
    documentId: string,
    input: {
      title?: string;
      description?: string | null;
      confidentiality?: DocumentConfidentiality;
    },
    context: DocumentsRequestContext,
  ) {
    const actor = requireActor(context);
    return this.prisma.$transaction(async (tx) => {
      const { document, access } = await this.lockedForManage(
        tx,
        actor,
        documentId,
      );
      if (
        input.confidentiality &&
        input.confidentiality !== document.confidentiality
      ) {
        this.access.requireManageLevel(access, input.confidentiality);
      }
      await tx.employeeDocument.update({
        where: { id: documentId },
        data: {
          ...(input.title !== undefined
            ? {
                title: parseText(input.title, 'title', {
                  required: true,
                  max: 300,
                })!,
              }
            : {}),
          ...(input.description !== undefined
            ? { description: parseText(input.description, 'description') }
            : {}),
          ...(input.confidentiality !== undefined
            ? { confidentiality: input.confidentiality }
            : {}),
        },
      });
      await this.audit.write(
        tx,
        input.confidentiality &&
          input.confidentiality !== document.confidentiality
          ? 'EMPLOYEE_DOCUMENT_RECLASSIFIED'
          : 'EMPLOYEE_DOCUMENT_UPDATED',
        'EmployeeDocument',
        documentId,
        context,
        {
          organizationId: document.organizationId,
          employeeId: document.employeeId,
          fields: Object.keys(input).filter(
            (key) => input[key as keyof typeof input] !== undefined,
          ),
          fromConfidentiality: document.confidentiality,
          toConfidentiality: input.confidentiality ?? document.confidentiality,
        },
      );
      return this.shapeById(tx, documentId, access);
    });
  }

  async archive(
    documentId: string,
    reason: string,
    context: DocumentsRequestContext,
  ) {
    const actor = requireActor(context);
    const note = parseText(reason, 'reason', { required: true, max: 1000 })!;
    return this.prisma.$transaction(async (tx) => {
      const { document, access } = await this.lockedForManage(
        tx,
        actor,
        documentId,
      );
      await tx.employeeDocument.update({
        where: { id: documentId },
        data: {
          status: 'ARCHIVED',
          archivedAt: this.clock.now(),
          archivedByUserId: actor,
          archiveReason: note,
        },
      });
      await this.audit.write(
        tx,
        'EMPLOYEE_DOCUMENT_ARCHIVED',
        'EmployeeDocument',
        documentId,
        context,
        {
          organizationId: document.organizationId,
          employeeId: document.employeeId,
        },
      );
      return this.shapeById(tx, documentId, access);
    });
  }

  /** One document as the viewer may see it. */
  async detail(userId: string, documentId: string) {
    const document = await this.prisma.employeeDocument.findUnique({
      where: { id: documentId },
    });
    if (!document) throw this.access.notFound();
    // Phase 19: grants are passed so employeeAccess defers the module gate; it runs only once
    // the viewer may read this document's level (404 otherwise, whatever the module state).
    const access = await this.access.employeeAccess(
      userId,
      document.employeeId,
      document.organizationId,
      this.prisma,
      await this.access.grants(userId),
    );
    if (!this.access.canReadLevel(access, document.confidentiality))
      throw this.access.notFound();
    await this.access.requireEnabled(document.organizationId);
    return this.shapeById(this.prisma, documentId, access);
  }

  /**
   * An employee's records (profile section): readable documents with version history, policy
   * acknowledgements and required / missing documents, per organization the viewer reaches.
   */
  async employeeRecords(userId: string, employeeId: string) {
    const organizations = await this.prisma.employmentAssignment.findMany({
      where: { employeeId, status: { not: 'CANCELLED' } },
      select: {
        position: {
          select: {
            organizationId: true,
            organization: { select: { name: true, timezone: true } },
          },
        },
      },
      distinct: ['positionId'],
    });
    const seen = new Map<string, { name: string; timezone: string | null }>();
    for (const row of organizations)
      seen.set(row.position.organizationId, row.position.organization);
    await this.withoutDisabled(seen);
    const items = [];
    for (const [organizationId, organization] of seen) {
      const access = await this.access.employeeAccess(
        userId,
        employeeId,
        organizationId,
      );
      if (access.clearance < 0) continue;
      const today = documentsToday(this.clock.now(), organization.timezone);
      const documents = await this.prisma.employeeDocument.findMany({
        where: { employeeId, organizationId },
        include: DOCUMENT_INCLUDE,
        orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      });
      const acknowledgements =
        await this.prisma.documentAcknowledgement.findMany({
          where: { employeeId, organizationId },
          include: {
            policyVersion: {
              include: {
                policy: { select: { id: true, code: true, title: true } },
              },
            },
          },
          orderBy: { acknowledgedAt: 'desc' },
        });
      items.push({
        organization: { id: organizationId, name: organization.name },
        access: { clearance: access.clearance, canManage: access.canManage },
        documents: documents
          .filter((row) =>
            this.access.canReadLevel(access, row.confidentiality),
          )
          .map((row) =>
            documentShape(row, today, {
              canManage:
                access.canManage && this.levelOk(access, row.confidentiality),
              history: true,
            }),
          ),
        acknowledgements: acknowledgements.map((row) => ({
          id: row.id,
          policy: row.policyVersion.policy,
          versionNumber: row.policyVersion.versionNumber,
          versionLabel: row.policyVersion.versionLabel,
          acknowledgedAt: row.acknowledgedAt.toISOString(),
          source: row.source,
          current: row.policyVersion.supersededAt === null,
        })),
        requirements: await this.requirementStatus(
          this.prisma,
          organizationId,
          employeeId,
          today,
        ),
      });
    }
    return { items };
  }

  /** The signed-in employee's own records: EMPLOYEE_VISIBLE documents and missing requirements. */
  async mine(userId: string) {
    const employeeId = await this.access.employeeIdOfUser(userId);
    if (!employeeId) return { items: [] };
    const organizations = await this.prisma.employmentAssignment.findMany({
      where: { employeeId, status: { not: 'CANCELLED' } },
      select: {
        position: {
          select: {
            organizationId: true,
            organization: { select: { name: true, timezone: true } },
          },
        },
      },
    });
    const seen = new Map<string, { name: string; timezone: string | null }>();
    for (const row of organizations)
      seen.set(row.position.organizationId, row.position.organization);
    await this.withoutDisabled(seen);
    const items = [];
    for (const [organizationId, organization] of seen) {
      const today = documentsToday(this.clock.now(), organization.timezone);
      const documents = await this.prisma.employeeDocument.findMany({
        where: {
          employeeId,
          organizationId,
          confidentiality: 'EMPLOYEE_VISIBLE',
          status: 'ACTIVE',
        },
        include: DOCUMENT_INCLUDE,
        orderBy: { createdAt: 'desc' },
      });
      const requirements = await this.requirementStatus(
        this.prisma,
        organizationId,
        employeeId,
        today,
      );
      const providable = await this.prisma.documentType.findMany({
        where: { organizationId, employeeProvided: true, archivedAt: null },
        orderBy: { name: 'asc' },
      });
      items.push({
        organization: { id: organizationId, name: organization.name },
        documents: documents
          .map((row) =>
            documentShape(row, today, { canManage: false, history: true }),
          )
          .map((shape, index) => ({
            ...shape,
            actions: {
              canManage: false,
              canAddVersion:
                documents[index]!.source === 'EMPLOYEE' &&
                documents[index]!.type.employeeProvided,
            },
          })),
        // Only whether something is missing; never documents the employee cannot see.
        missing: requirements
          .filter((row) => row.status !== 'SATISFIED')
          .map((row) => ({
            typeId: row.typeId,
            typeName: row.typeName,
            status: row.status,
            employeeProvided: row.employeeProvided,
          })),
        providableTypes: providable.map(typeShape),
      });
    }
    return { items };
  }

  /** The employee provides a document of an employee-provided type (visible to them). */
  async provide(
    input: {
      organizationId: string;
      typeId: string;
      title: string;
      version: VersionInput;
      workflowTaskId?: string | null;
    },
    context: DocumentsRequestContext,
  ) {
    const actor = requireActor(context);
    const employeeId = await this.access.employeeIdOfUser(actor);
    if (!employeeId)
      throw new ForbiddenException(
        domainError(
          403,
          'DOCUMENT_NOT_AN_EMPLOYEE',
          'Your account is not linked to an employee.',
        ),
      );
    const reference = parseStorageReference(input.version);
    return this.prisma.$transaction(async (tx) => {
      const type = await this.activeType(
        tx,
        input.organizationId,
        input.typeId,
      );
      if (!type.employeeProvided)
        throw new ForbiddenException(
          domainError(
            403,
            'DOCUMENT_NOT_EMPLOYEE_PROVIDED',
            'HR records this type of document.',
          ),
        );
      const inOrg = await tx.employmentAssignment.count({
        where: {
          employeeId,
          status: { not: 'CANCELLED' },
          position: { organizationId: input.organizationId },
        },
      });
      if (!inOrg) throw new NotFoundException('Organization not found.');
      await this.requireSelfService(tx, input.organizationId);
      if (input.workflowTaskId) {
        const task = await tx.employeeWorkflowTask.findUnique({
          where: { id: input.workflowTaskId },
          include: { workflow: { select: { employeeId: true } } },
        });
        if (
          !task ||
          task.workflow.employeeId !== employeeId ||
          task.organizationId !== input.organizationId
        ) {
          invalid(
            'DOCUMENT_TASK_INVALID',
            'The task is not one of your onboarding tasks.',
          );
        }
      }
      const versionValues = this.versionValues(
        input.version,
        type.expiryTracked,
      );
      const stored = await this.attachUpload(tx, reference, {
        actorUserId: actor,
        organizationId: input.organizationId,
        purposes: ['SELF_SERVICE'],
        employeeId,
        documentId: null,
      });
      if (isRetry(stored)) {
        const organization = await tx.organization.findUniqueOrThrow({
          where: { id: input.organizationId },
          select: { timezone: true },
        });
        const existing = await tx.employeeDocument.findUniqueOrThrow({
          where: { id: stored.documentId },
          include: DOCUMENT_INCLUDE,
        });
        // Batch 9 (review): an employee reads their own provided document only while it is
        // employee visible (HR may have reclassified it since the first attempt) — 404 otherwise.
        if (
          existing.employeeId !== employeeId ||
          existing.confidentiality !== 'EMPLOYEE_VISIBLE'
        )
          throw this.access.notFound();
        return documentShape(
          existing,
          documentsToday(this.clock.now(), organization.timezone),
          { canManage: false, history: true },
        );
      }
      const document = await tx.employeeDocument.create({
        data: {
          organizationId: input.organizationId,
          employeeId,
          typeId: type.id,
          title: parseText(input.title, 'title', { required: true, max: 300 })!,
          confidentiality: 'EMPLOYEE_VISIBLE',
          source: input.workflowTaskId ? 'ONBOARDING' : 'EMPLOYEE',
          workflowTaskId: input.workflowTaskId ?? null,
          createdByUserId: actor,
        },
      });
      await tx.employeeDocumentVersion.create({
        data: {
          documentId: document.id,
          versionNumber: 1,
          ...this.referenceColumns(reference, stored),
          ...versionValues,
          createdByUserId: actor,
        },
      });
      await this.audit.write(
        tx,
        'EMPLOYEE_DOCUMENT_PROVIDED',
        'EmployeeDocument',
        document.id,
        context,
        {
          organizationId: input.organizationId,
          employeeId,
          typeId: type.id,
          provider: reference.provider,
        },
      );
      const organization = await tx.organization.findUniqueOrThrow({
        where: { id: input.organizationId },
        select: { timezone: true },
      });
      const today = documentsToday(this.clock.now(), organization.timezone);
      return documentShape(
        await tx.employeeDocument.findUniqueOrThrow({
          where: { id: document.id },
          include: DOCUMENT_INCLUDE,
        }),
        today,
        { canManage: false, history: true },
      );
    });
  }

  // ─── Dashboards ───────────────────────────────────────────────────────────

  /** Readable documents expired or expiring within the window (date-derived; no job needed). */
  async expiryDashboard(
    userId: string,
    organizationId: string,
    withinDays = EXPIRING_SOON_DAYS,
  ) {
    const grants = await this.access.requireAnyInOrganization(
      userId,
      organizationId,
    );
    const organization = await this.prisma.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: { timezone: true },
    });
    const today = documentsToday(this.clock.now(), organization.timezone);
    const rows = await this.prisma.employeeDocument.findMany({
      where: {
        organizationId,
        status: 'ACTIVE',
        versions: {
          some: {
            supersededAt: null,
            expiresOn: { not: null, lte: addDays(today, withinDays) },
          },
        },
      },
      include: {
        ...DOCUMENT_INCLUDE,
        employee: {
          select: {
            id: true,
            employeeNumber: true,
            person: {
              select: { firstName: true, lastName: true, preferredName: true },
            },
          },
        },
      },
    });
    const accessCache = new Map<string, EmployeeDocumentAccess>();
    const items = [];
    for (const row of rows) {
      const access =
        accessCache.get(row.employeeId) ??
        (await this.access.employeeAccess(
          userId,
          row.employeeId,
          organizationId,
          this.prisma,
          grants,
        ));
      accessCache.set(row.employeeId, access);
      if (!levelOk(access, row.confidentiality)) continue;
      const current = row.versions.find(
        (version) => version.supersededAt === null,
      )!;
      items.push({
        documentId: row.id,
        title: row.title,
        type: { id: row.type.id, name: row.type.name },
        employee: {
          id: row.employee.id,
          employeeNumber: row.employee.employeeNumber,
          displayName: personName(row.employee.person),
        },
        expiresOn: isoDate(current.expiresOn),
        expiryStatus: expiryStatus(current.expiresOn, today),
      });
    }
    items.sort((a, b) => (a.expiresOn ?? '').localeCompare(b.expiresOn ?? ''));
    // Phase 19: a hard safety cap (soonest first); `truncated` tells the UI.
    return {
      today: isoDate(today),
      withinDays,
      items: items.slice(0, DASHBOARD_LIMIT),
      truncated: items.length > DASHBOARD_LIMIT,
    };
  }

  /** Required documents missing (or expired) for employees the user may read records of. */
  async missingDashboard(userId: string, organizationId: string) {
    const grants = await this.access.requireAnyInOrganization(
      userId,
      organizationId,
    );
    const organization = await this.prisma.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: { timezone: true },
    });
    const today = documentsToday(this.clock.now(), organization.timezone);
    const employees = await this.prisma.employmentAssignment.findMany({
      where: {
        status: { in: ['ACTIVE', 'PLANNED'] },
        position: { organizationId },
      },
      select: {
        employeeId: true,
        employee: {
          select: {
            employeeNumber: true,
            person: {
              select: { firstName: true, lastName: true, preferredName: true },
            },
          },
        },
      },
      distinct: ['employeeId'],
    });
    const self = await this.access.employeeIdOfUser(userId);
    // Phase 19: batched. The dashboard used to run ~6 queries per employee of the organization
    // (access, then requirements / assignments / documents each); it now loads requirements,
    // assignments, placements and documents once and evaluates per employee in memory, with
    // the same rules (employeeAccess clearance; requirementStatus semantics).
    const requirements = await this.prisma.documentRequirement.findMany({
      where: { organizationId, archivedAt: null },
      include: { type: true },
    });
    if (requirements.length === 0)
      return { today: isoDate(today), items: [], truncated: false };
    const employeeIds = employees
      .map((row) => row.employeeId)
      .filter((id) => id !== self);
    const placements = await this.prisma.employmentAssignment.findMany({
      where: {
        employeeId: { in: employeeIds },
        status: { not: 'CANCELLED' },
        position: { organizationId },
      },
      select: {
        employeeId: true,
        status: true,
        employmentType: true,
        positionId: true,
        position: {
          select: {
            id: true,
            organizationId: true,
            organizationalUnitId: true,
            departmentId: true,
            teamId: true,
          },
        },
      },
    });
    const targets = await positionTargets(
      this.prisma,
      placements.map((row) => row.position),
    );
    const typeIds = [...new Set(requirements.map((r) => r.typeId))];
    const documents = await this.prisma.employeeDocument.findMany({
      where: {
        organizationId,
        employeeId: { in: employeeIds },
        typeId: { in: typeIds },
      },
      include: { versions: { where: { supersededAt: null } } },
    });
    const byEmployee = <T extends { employeeId: string }>(rows: T[]) => {
      const map = new Map<string, T[]>();
      for (const row of rows)
        map.set(row.employeeId, [...(map.get(row.employeeId) ?? []), row]);
      return map;
    };
    const placementsOf = byEmployee(placements);
    const documentsOf = byEmployee(documents);
    const items = [];
    let truncated = false;
    for (const row of employees) {
      if (row.employeeId === self) continue;
      if (items.length >= DASHBOARD_LIMIT) {
        truncated = true;
        break;
      }
      const own = placementsOf.get(row.employeeId) ?? [];
      if (own.length === 0) continue;
      const { clearance } = this.access.clearanceOver(
        grants,
        own.map((placement) => targets.get(placement.position.id)!),
      );
      if (clearance < 0) continue;
      const missing = evaluateRequirements(
        requirements,
        own
          .filter((p) => p.status === 'ACTIVE' || p.status === 'PLANNED')
          .map((p) => ({
            employmentType: p.employmentType,
            positionId: p.positionId,
            position: { departmentId: p.position.departmentId },
          })),
        documentsOf.get(row.employeeId) ?? [],
        today,
      ).filter((r) => r.status !== 'SATISFIED');
      if (missing.length === 0) continue;
      items.push({
        employee: {
          id: row.employeeId,
          employeeNumber: row.employee.employeeNumber,
          displayName: personName(row.employee.person),
        },
        missing: missing.map((r) => ({
          typeId: r.typeId,
          typeName: r.typeName,
          status: r.status,
        })),
      });
    }
    return { today: isoDate(today), items, truncated };
  }

  /**
   * Requirement status of one employee: SATISFIED by an active document of the type whose
   * current version has not expired; EXPIRED when only expired ones exist; MISSING otherwise.
   * Counts every document of the type regardless of confidentiality (the answer reveals no
   * content).
   */
  async requirementStatus(
    client: DocumentsClient,
    organizationId: string,
    employeeId: string,
    today: Date,
  ) {
    const requirements = await client.documentRequirement.findMany({
      where: { organizationId, archivedAt: null },
      include: { type: true },
    });
    if (requirements.length === 0) return [];
    const assignments = await client.employmentAssignment.findMany({
      where: {
        employeeId,
        status: { in: ['ACTIVE', 'PLANNED'] },
        position: { organizationId },
      },
      select: {
        employmentType: true,
        positionId: true,
        position: { select: { departmentId: true } },
      },
    });
    const typeIds = applicableTypeIds(requirements, assignments);
    const documents = await client.employeeDocument.findMany({
      where: { employeeId, organizationId, typeId: { in: typeIds } },
      include: { versions: { where: { supersededAt: null } } },
    });
    return evaluateRequirements(requirements, assignments, documents, today);
  }

  // ─── Recruitment hand-off ─────────────────────────────────────────────────

  /**
   * Explicit hand-off of selected Phase 13 candidate documents (and optionally the accepted
   * offer as a record) into the hired employee's records, keeping provenance. Nothing moves
   * automatically; each candidate document is handed off once. Needs document.manage on the
   * employee and recruitment.read on the hired application.
   */
  async handoffFromRecruitment(
    hireId: string,
    input: {
      documents: Array<{
        recruitmentDocumentId: string;
        typeId: string;
        confidentiality?: DocumentConfidentiality | null;
      }>;
      offer?: {
        typeId: string;
        confidentiality?: DocumentConfidentiality | null;
      } | null;
    },
    context: DocumentsRequestContext,
  ) {
    const actor = requireActor(context);
    return this.prisma.$transaction(async (tx) => {
      const hire = await tx.recruitmentHire.findUnique({
        where: { id: hireId },
        include: { offer: true },
      });
      if (!hire) throw new NotFoundException('Hire not found.');
      const recruitmentAccess = await this.recruitment.requireApplicationView(
        actor,
        hire.applicationId,
        tx,
      );
      if (recruitmentAccess.view !== 'FULL')
        throw new NotFoundException('Hire not found.');
      const access = await this.access.employeeAccess(
        actor,
        hire.employeeId,
        hire.organizationId,
        tx,
      );
      await this.types.ensureDefaults(tx, hire.organizationId, actor);
      const outcomes: Array<{
        recruitmentDocumentId: string | null;
        documentId: string;
        outcome: 'CREATED' | 'ALREADY_HANDED_OFF';
      }> = [];
      for (const item of input.documents) {
        const source = await tx.recruitmentCandidateDocument.findUnique({
          where: { id: item.recruitmentDocumentId },
        });
        if (
          !source ||
          source.candidateId !== hire.candidateId ||
          source.removedAt
        ) {
          invalid(
            'DOCUMENT_HANDOFF_INVALID',
            'Only current documents of the hired candidate are handed off.',
          );
        }
        const existing = await tx.employeeDocument.findFirst({
          where: {
            employeeId: hire.employeeId,
            recruitmentDocumentId: source.id,
          },
        });
        if (existing) {
          outcomes.push({
            recruitmentDocumentId: source.id,
            documentId: existing.id,
            outcome: 'ALREADY_HANDED_OFF',
          });
          continue;
        }
        const type = await this.activeType(
          tx,
          hire.organizationId,
          item.typeId,
        );
        const level = item.confidentiality ?? type.defaultConfidentiality;
        this.access.requireManageLevel(access, level);
        const document = await tx.employeeDocument.create({
          data: {
            organizationId: hire.organizationId,
            employeeId: hire.employeeId,
            employmentAssignmentId: hire.employmentAssignmentId,
            typeId: type.id,
            title: source.title,
            confidentiality: level,
            source: 'RECRUITMENT_HANDOFF',
            recruitmentDocumentId: source.id,
            recruitmentHireId: hire.id,
            createdByUserId: actor,
          },
        });
        await tx.employeeDocumentVersion.create({
          data: {
            documentId: document.id,
            versionNumber: 1,
            provider: source.provider,
            externalUrl: source.externalUrl,
            externalFileId: source.externalFileId,
            fileName: source.fileName,
            mimeType: source.mimeType,
            note: 'Handed off from recruitment',
            createdByUserId: actor,
          },
        });
        outcomes.push({
          recruitmentDocumentId: source.id,
          documentId: document.id,
          outcome: 'CREATED',
        });
      }
      if (input.offer) {
        const marker = `recruitment-offer:${hire.offerId}`;
        const existing = await tx.employeeDocument.findFirst({
          where: {
            employeeId: hire.employeeId,
            recruitmentHireId: hire.id,
            recruitmentDocumentId: null,
            versions: { some: { externalFileId: marker } },
          },
        });
        if (existing) {
          outcomes.push({
            recruitmentDocumentId: null,
            documentId: existing.id,
            outcome: 'ALREADY_HANDED_OFF',
          });
        } else {
          const type = await this.activeType(
            tx,
            hire.organizationId,
            input.offer.typeId,
          );
          const level =
            input.offer.confidentiality ?? type.defaultConfidentiality;
          this.access.requireManageLevel(access, level);
          const document = await tx.employeeDocument.create({
            data: {
              organizationId: hire.organizationId,
              employeeId: hire.employeeId,
              employmentAssignmentId: hire.employmentAssignmentId,
              typeId: type.id,
              title: 'Accepted offer',
              confidentiality: level,
              source: 'RECRUITMENT_HANDOFF',
              recruitmentHireId: hire.id,
              createdByUserId: actor,
            },
          });
          await tx.employeeDocumentVersion.create({
            data: {
              documentId: document.id,
              versionNumber: 1,
              provider: 'MANUAL_REFERENCE',
              externalFileId: marker,
              issuedOn: hire.offer.respondedAt
                ? new Date(
                    `${hire.offer.respondedAt.toISOString().slice(0, 10)}T00:00:00.000Z`,
                  )
                : null,
              effectiveOn: hire.offer.startDate,
              note: 'The accepted offer is kept in Recruitment.',
              createdByUserId: actor,
            },
          });
          outcomes.push({
            recruitmentDocumentId: null,
            documentId: document.id,
            outcome: 'CREATED',
          });
        }
      }
      await this.audit.write(
        tx,
        'EMPLOYEE_DOCUMENTS_HANDED_OFF',
        'RecruitmentHire',
        hire.id,
        context,
        {
          organizationId: hire.organizationId,
          employeeId: hire.employeeId,
          created: outcomes.filter((o) => o.outcome === 'CREATED').length,
          skipped: outcomes.filter((o) => o.outcome === 'ALREADY_HANDED_OFF')
            .length,
        },
      );
      return { outcomes };
    });
  }

  /** The Phase 14 contract: an active, unexpired document of the type, if any. */
  async validDocumentOfType(
    client: DocumentsClient,
    input: { organizationId: string; employeeId: string; typeId: string },
  ) {
    // Phase 18: the contract (onboarding document tasks) is refused while Documents is off.
    await this.access.requireEnabled(input.organizationId, client);
    const documents = await client.employeeDocument.findMany({
      where: {
        organizationId: input.organizationId,
        employeeId: input.employeeId,
        typeId: input.typeId,
        status: 'ACTIVE',
      },
      include: { versions: { where: { supersededAt: null } } },
      orderBy: { createdAt: 'desc' },
    });
    const organization = await client.organization.findUnique({
      where: { id: input.organizationId },
      select: { timezone: true },
    });
    const today = documentsToday(this.clock.now(), organization?.timezone);
    const found = documents.find((document) =>
      satisfies(
        {
          status: document.status,
          expiresOn: document.versions[0]?.expiresOn ?? null,
        },
        today,
      ),
    );
    return found ? { documentId: found.id } : null;
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private levelOk(
    access: EmployeeDocumentAccess,
    level: DocumentConfidentiality,
  ) {
    return levelOk(access, level);
  }

  /**
   * Batch 9: binds an uploaded file (INTERNAL_OBJECT_STORAGE) to the version being created; null
   * for links, Drive files and manual references. A retry of the same upload for the same
   * target returns the document it already belongs to.
   */
  private async attachUpload(
    tx: Tx,
    reference: ReturnType<typeof parseStorageReference>,
    binding: AttachBinding,
  ) {
    if (!reference.uploadId) return null;
    const outcome = await attachStoredObject(
      tx,
      reference.uploadId,
      binding,
      this.clock.now(),
    );
    if (outcome.kind === 'ALREADY_ATTACHED')
      return { kind: 'RETRY' as const, documentId: outcome.documentId! };
    return outcome.version;
  }

  /** The version's reference columns: the stored object's (never client input) or the link's. */
  private referenceColumns(
    reference: ReturnType<typeof parseStorageReference>,
    stored: Awaited<ReturnType<EmployeeDocumentService['attachUpload']>>,
  ) {
    if (stored && !isRetry(stored))
      return {
        provider: stored.provider,
        storageKey: stored.storageKey,
        storedObjectId: stored.storedObjectId,
        fileName: stored.fileName,
        mimeType: stored.mimeType,
        sizeBytes: stored.sizeBytes,
        externalUrl: null,
        externalFileId: null,
      };
    return {
      provider: reference.provider,
      externalUrl: reference.externalUrl,
      externalFileId: reference.externalFileId,
      fileName: reference.fileName,
      mimeType: reference.mimeType,
      sizeBytes: reference.sizeBytes,
    };
  }

  private versionValues(input: VersionInput, expiryTracked: boolean) {
    const issuedOn = optionalDate(input.issuedOn, 'issuedOn');
    const expiresOn = optionalDate(input.expiresOn, 'expiresOn');
    if (expiryTracked && !expiresOn)
      invalid(
        'DOCUMENT_EXPIRY_REQUIRED',
        'This type of document needs its expiry date.',
      );
    if (issuedOn && expiresOn && expiresOn < issuedOn)
      invalid(
        'DOCUMENT_DATES_INVALID',
        'The expiry date precedes the issue date.',
      );
    return {
      issuedOn,
      effectiveOn: optionalDate(input.effectiveOn, 'effectiveOn'),
      expiresOn,
      note: parseText(input.note, 'note', { max: 2000 }),
    };
  }

  /** Phase 18: employee self-service providing / versioning (module + setting). */
  private async requireSelfService(tx: Tx, organizationId: string) {
    await this.access.requireEnabled(organizationId, tx);
    await this.access.features.requireSetting(
      organizationId,
      'documents.selfServiceProvide',
      tx,
    );
  }

  /** Phase 18: drops the organizations where Documents is disabled (one query). */
  private async withoutDisabled(organizations: Map<string, unknown>) {
    const disabled = await this.access.features.disabledAmong('DOCUMENTS', [
      ...organizations.keys(),
    ]);
    for (const organizationId of disabled) organizations.delete(organizationId);
  }

  private async activeType(tx: Tx, organizationId: string, typeId: string) {
    const type = await tx.documentType.findUnique({ where: { id: typeId } });
    if (!type || type.organizationId !== organizationId || type.archivedAt)
      invalid(
        'DOCUMENT_TYPE_INVALID',
        'The document type is not an active type of the organization.',
      );
    return type;
  }

  private async assignmentOf(
    tx: Tx,
    employeeId: string,
    organizationId: string,
    assignmentId: string,
  ) {
    const row = await tx.employmentAssignment.findFirst({
      where: { id: assignmentId, employeeId, position: { organizationId } },
    });
    if (!row)
      invalid(
        'DOCUMENT_ASSIGNMENT_INVALID',
        "The assignment is not the employee's in this organization.",
      );
    return row;
  }

  private async lockedForManage(
    tx: Tx,
    actor: string,
    documentId: string,
  ): Promise<{ document: EmployeeDocument; access: EmployeeDocumentAccess }> {
    await lockDocument(tx, documentId);
    const document = await tx.employeeDocument.findUniqueOrThrow({
      where: { id: documentId },
    });
    const access = await this.access.employeeAccess(
      actor,
      document.employeeId,
      document.organizationId,
      tx,
    );
    if (!this.access.canReadLevel(access, document.confidentiality))
      throw this.access.notFound();
    this.access.requireManageLevel(access, document.confidentiality);
    if (document.status !== 'ACTIVE')
      throw conflict('DOCUMENT_ARCHIVED', 'The document is archived.');
    return { document, access };
  }

  private async shapeById(
    client: DocumentsClient,
    documentId: string,
    access: EmployeeDocumentAccess,
    options: { requireReadable?: boolean } = {},
  ) {
    const row = await client.employeeDocument.findUniqueOrThrow({
      where: { id: documentId },
      include: {
        ...DOCUMENT_INCLUDE,
        organization: { select: { timezone: true } },
      },
    });
    if (
      options.requireReadable &&
      (row.employeeId !== access.employeeId ||
        row.organizationId !== access.organizationId ||
        !levelOk(access, row.confidentiality))
    )
      throw this.access.notFound();
    const today = documentsToday(this.clock.now(), row.organization.timezone);
    return documentShape(row, today, {
      canManage: access.canManage && levelOk(access, row.confidentiality),
      history: true,
    });
  }
}

function levelOk(
  access: EmployeeDocumentAccess,
  level: DocumentConfidentiality,
) {
  const rank = {
    EMPLOYEE_VISIBLE: 0,
    MANAGER_VISIBLE: 1,
    HR_ONLY: 2,
    RESTRICTED: 3,
  }[level];
  return rank <= access.clearance;
}

type RequirementRow = Parameters<typeof requirementApplies>[0] & {
  typeId: string;
  type: { name: string; employeeProvided: boolean };
};
interface RequirementAssignment {
  employmentType: Parameters<typeof requirementApplies>[1]['employmentType'];
  positionId: string;
  position: { departmentId: string | null };
}

function applicableRequirements(
  requirements: readonly RequirementRow[],
  assignments: readonly RequirementAssignment[],
) {
  return requirements.filter((requirement) =>
    assignments.some((assignment) =>
      requirementApplies(requirement, {
        employmentType: assignment.employmentType,
        positionId: assignment.positionId,
        departmentId: assignment.position.departmentId,
      }),
    ),
  );
}

function applicableTypeIds(
  requirements: readonly RequirementRow[],
  assignments: readonly RequirementAssignment[],
) {
  return [
    ...new Set(
      applicableRequirements(requirements, assignments).map((r) => r.typeId),
    ),
  ];
}

/**
 * Requirement status from loaded rows (one employee): SATISFIED by an active document of the
 * type whose current version has not expired; EXPIRED when only expired ones exist; MISSING
 * otherwise. `documents` carry their current version only.
 */
export function evaluateRequirements(
  requirements: readonly RequirementRow[],
  assignments: readonly RequirementAssignment[],
  documents: ReadonlyArray<{
    typeId: string;
    status: Parameters<typeof satisfies>[0]['status'];
    versions: ReadonlyArray<{ expiresOn: Date | null }>;
  }>,
  today: Date,
) {
  const applicable = applicableRequirements(requirements, assignments);
  const typeIds = [
    ...new Set(applicable.map((requirement) => requirement.typeId)),
  ];
  return typeIds.map((typeId) => {
    const requirement = applicable.find((r) => r.typeId === typeId)!;
    const ofType = documents.filter((document) => document.typeId === typeId);
    const satisfied = ofType.some((document) =>
      satisfies(
        {
          status: document.status,
          expiresOn: document.versions[0]?.expiresOn ?? null,
        },
        today,
      ),
    );
    const expired =
      !satisfied && ofType.some((document) => document.status === 'ACTIVE');
    return {
      typeId,
      typeName: requirement.type.name,
      employeeProvided: requirement.type.employeeProvided,
      status: satisfied
        ? ('SATISFIED' as const)
        : expired
          ? ('EXPIRED' as const)
          : ('MISSING' as const),
    };
  });
}

function isRetry<T>(
  stored: T | { kind: 'RETRY'; documentId: string } | null,
): stored is { kind: 'RETRY'; documentId: string } {
  return stored !== null && typeof stored === 'object' && 'kind' in stored;
}
