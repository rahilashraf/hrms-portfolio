import { Injectable, NotFoundException } from '@nestjs/common';
import { advisoryLock, requireActor } from '../common/domain-support.js';
import { PrismaService } from '../database/prisma.service.js';
import type {
  DocumentCategory,
  DocumentConfidentiality,
  DocumentRequirement,
  DocumentType,
  EmploymentType,
} from '../generated/prisma/client.js';
import { DocumentsAccessService } from './documents-access.service.js';
import { DocumentsAuditAdapter } from './documents-audit.js';
import {
  conflict,
  DocumentsClock,
  type DocumentsRequestContext,
  type Tx,
} from './documents-common.js';
import {
  DEFAULT_DOCUMENT_TYPES,
  invalid,
  parseDocumentCode,
  parseText,
} from './documents-domain.js';

export function typeShape(row: DocumentType) {
  return {
    id: row.id,
    organizationId: row.organizationId,
    code: row.code,
    name: row.name,
    description: row.description,
    category: row.category,
    defaultConfidentiality: row.defaultConfidentiality,
    expiryTracked: row.expiryTracked,
    employeeProvided: row.employeeProvided,
    archivedAt: row.archivedAt?.toISOString() ?? null,
  };
}

/** Batch 9 (F5): requirements carry the names of their department and position for pickers. */
export const REQUIREMENT_INCLUDE = {
  type: true,
  department: { select: { name: true } },
  position: { select: { name: true } },
} as const;

export function requirementShape(
  row: DocumentRequirement & {
    type?: DocumentType;
    department?: { name: string } | null;
    position?: { name: string } | null;
  },
) {
  return {
    id: row.id,
    typeId: row.typeId,
    typeName: row.type?.name ?? null,
    employmentType: row.employmentType,
    departmentId: row.departmentId,
    departmentName: row.department?.name ?? null,
    positionId: row.positionId,
    positionName: row.position?.name ?? null,
    note: row.note,
    archivedAt: row.archivedAt?.toISOString() ?? null,
  };
}

/**
 * Phase 15 — organization-managed document types (configurable, with sensible system
 * categories created on first use) and simple required-document rules (organization, employment
 * type, department and/or position — no rules engine). document.type.manage at the
 * organization; reading types needs any document permission there.
 */
@Injectable()
export class DocumentTypeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: DocumentsAccessService,
    private readonly audit: DocumentsAuditAdapter,
    private readonly clock: DocumentsClock,
  ) {}

  /** Creates the default types when the organization has none yet (idempotent). */
  async ensureDefaults(tx: Tx, organizationId: string, actorUserId?: string) {
    await advisoryLock(tx, `document-types:${organizationId}`);
    if ((await tx.documentType.count({ where: { organizationId } })) > 0)
      return false;
    for (const type of DEFAULT_DOCUMENT_TYPES) {
      await tx.documentType.create({
        data: {
          organizationId,
          code: type.code,
          name: type.name,
          category: type.category,
          defaultConfidentiality: type.defaultConfidentiality,
          expiryTracked: type.expiryTracked ?? false,
          employeeProvided: type.employeeProvided ?? false,
          createdByUserId: actorUserId ?? null,
        },
      });
    }
    return true;
  }

  async list(userId: string, organizationId: string, includeArchived = false) {
    const grants = await this.access.grants(userId);
    const self = await this.access.employeeIdOfUser(userId);
    const selfInOrg =
      self &&
      (await this.prisma.employmentAssignment.count({
        where: {
          employeeId: self,
          status: { not: 'CANCELLED' },
          position: { organizationId },
        },
      })) > 0;
    if (
      !selfInOrg &&
      !(await this.access.hasAnyInOrganization(organizationId, grants))
    ) {
      await this.access.requireAnyInOrganization(userId, organizationId);
    } else await this.access.requireEnabled(organizationId);
    const rows = await this.prisma.documentType.findMany({
      where: {
        organizationId,
        ...(includeArchived ? {} : { archivedAt: null }),
      },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
    return { items: rows.map(typeShape) };
  }

  async initializeDefaults(
    organizationId: string,
    context: DocumentsRequestContext,
  ) {
    const actor = requireActor(context);
    await this.access.requireOrganization(
      actor,
      'document.type.manage',
      organizationId,
    );
    return this.prisma.$transaction(async (tx) => {
      const created = await this.ensureDefaults(tx, organizationId, actor);
      if (created) {
        await this.audit.write(
          tx,
          'DOCUMENT_TYPES_INITIALIZED',
          'Organization',
          organizationId,
          context,
          { organizationId, types: DEFAULT_DOCUMENT_TYPES.length },
        );
      }
      return {
        created,
        items: (
          await tx.documentType.findMany({
            where: { organizationId },
            orderBy: { name: 'asc' },
          })
        ).map(typeShape),
      };
    });
  }

  async create(
    input: {
      organizationId: string;
      code: string;
      name: string;
      description?: string | null;
      category: DocumentCategory;
      defaultConfidentiality: DocumentConfidentiality;
      expiryTracked?: boolean;
      employeeProvided?: boolean;
    },
    context: DocumentsRequestContext,
  ) {
    const actor = requireActor(context);
    await this.access.requireOrganization(
      actor,
      'document.type.manage',
      input.organizationId,
    );
    const code = parseDocumentCode(input.code);
    return this.prisma.$transaction(async (tx) => {
      await this.ensureDefaults(tx, input.organizationId, actor);
      if (
        await tx.documentType.findUnique({
          where: {
            organizationId_code: { organizationId: input.organizationId, code },
          },
        })
      ) {
        throw conflict(
          'DOCUMENT_TYPE_EXISTS',
          `A document type with code ${code} already exists.`,
        );
      }
      const row = await tx.documentType.create({
        data: {
          organizationId: input.organizationId,
          code,
          name: parseText(input.name, 'name', { required: true, max: 200 })!,
          description: parseText(input.description, 'description'),
          category: input.category,
          defaultConfidentiality: input.defaultConfidentiality,
          expiryTracked: input.expiryTracked ?? false,
          employeeProvided: input.employeeProvided ?? false,
          createdByUserId: actor,
        },
      });
      await this.audit.write(
        tx,
        'DOCUMENT_TYPE_CREATED',
        'DocumentType',
        row.id,
        context,
        { organizationId: row.organizationId, code, category: row.category },
      );
      return typeShape(row);
    });
  }

  async update(
    typeId: string,
    input: {
      name?: string;
      description?: string | null;
      defaultConfidentiality?: DocumentConfidentiality;
      expiryTracked?: boolean;
      employeeProvided?: boolean;
    },
    context: DocumentsRequestContext,
  ) {
    const actor = requireActor(context);
    const type = await this.typeOrThrow(typeId);
    await this.access.requireOrganization(
      actor,
      'document.type.manage',
      type.organizationId,
    );
    if (type.archivedAt)
      throw conflict(
        'DOCUMENT_TYPE_ARCHIVED',
        'The document type is archived.',
      );
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.documentType.update({
        where: { id: typeId },
        data: {
          ...(input.name !== undefined
            ? {
                name: parseText(input.name, 'name', {
                  required: true,
                  max: 200,
                })!,
              }
            : {}),
          ...(input.description !== undefined
            ? { description: parseText(input.description, 'description') }
            : {}),
          ...(input.defaultConfidentiality !== undefined
            ? { defaultConfidentiality: input.defaultConfidentiality }
            : {}),
          ...(input.expiryTracked !== undefined
            ? { expiryTracked: input.expiryTracked }
            : {}),
          ...(input.employeeProvided !== undefined
            ? { employeeProvided: input.employeeProvided }
            : {}),
        },
      });
      await this.audit.write(
        tx,
        'DOCUMENT_TYPE_UPDATED',
        'DocumentType',
        typeId,
        context,
        {
          organizationId: row.organizationId,
          fields: Object.keys(input).filter(
            (key) => input[key as keyof typeof input] !== undefined,
          ),
        },
      );
      return typeShape(row);
    });
  }

  async archive(typeId: string, context: DocumentsRequestContext) {
    const actor = requireActor(context);
    const type = await this.typeOrThrow(typeId);
    await this.access.requireOrganization(
      actor,
      'document.type.manage',
      type.organizationId,
    );
    if (type.archivedAt) return typeShape(type);
    return this.prisma.$transaction(async (tx) => {
      const live = await tx.documentRequirement.count({
        where: { typeId, archivedAt: null },
      });
      if (live > 0)
        throw conflict(
          'DOCUMENT_TYPE_REQUIRED',
          'Archive the requirements of this type first.',
        );
      const row = await tx.documentType.update({
        where: { id: typeId },
        data: { archivedAt: this.clock.now() },
      });
      await this.audit.write(
        tx,
        'DOCUMENT_TYPE_ARCHIVED',
        'DocumentType',
        typeId,
        context,
        { organizationId: row.organizationId },
      );
      return typeShape(row);
    });
  }

  /**
   * Batch 9 (D10): makes an archived type available again for new documents and requirements.
   * Its code, category and history are unchanged (the database keeps them fixed); documents
   * recorded with it were never affected by the archive. An active type is returned as is.
   */
  async reactivate(typeId: string, context: DocumentsRequestContext) {
    const actor = requireActor(context);
    const type = await this.typeOrThrow(typeId);
    await this.access.requireOrganization(
      actor,
      'document.type.manage',
      type.organizationId,
    );
    if (!type.archivedAt) return typeShape(type);
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.documentType.updateMany({
        where: { id: typeId, archivedAt: { not: null } },
        data: { archivedAt: null },
      });
      const row = await tx.documentType.findUniqueOrThrow({
        where: { id: typeId },
      });
      if (updated.count === 1)
        await this.audit.write(
          tx,
          'DOCUMENT_TYPE_REACTIVATED',
          'DocumentType',
          typeId,
          context,
          { organizationId: row.organizationId },
        );
      return typeShape(row);
    });
  }

  // ─── Requirements ─────────────────────────────────────────────────────────

  /** Active requirements; with `includeArchived`, the history (archived and replaced) too. */
  async requirements(
    userId: string,
    organizationId: string,
    includeArchived = false,
  ) {
    await this.access.requireAnyInOrganization(userId, organizationId);
    const rows = await this.prisma.documentRequirement.findMany({
      where: {
        organizationId,
        ...(includeArchived ? {} : { archivedAt: null }),
      },
      include: REQUIREMENT_INCLUDE,
      orderBy: [
        { archivedAt: { sort: 'desc', nulls: 'first' } },
        { createdAt: 'asc' },
        { id: 'asc' },
      ],
    });
    return { items: rows.map(requirementShape) };
  }

  /**
   * Batch 9 (D10): "updating" a requirement archives it and adds its replacement in one
   * transaction — a requirement row never changes (the database refuses it), so the history of
   * what was required, and when, is kept.
   */
  async replaceRequirement(
    requirementId: string,
    input: {
      employmentType?: EmploymentType | null;
      departmentId?: string | null;
      positionId?: string | null;
      note?: string | null;
    },
    context: DocumentsRequestContext,
  ) {
    const actor = requireActor(context);
    const current = await this.prisma.documentRequirement.findUnique({
      where: { id: requirementId },
    });
    if (!current) throw new NotFoundException('Requirement not found.');
    await this.access.requireOrganization(
      actor,
      'document.type.manage',
      current.organizationId,
    );
    return this.prisma.$transaction(async (tx) => {
      const [locked] = await tx.$queryRaw<Array<{ archivedAt: Date | null }>>`
        SELECT "archivedAt" FROM "DocumentRequirement" WHERE "id" = ${requirementId}::uuid FOR UPDATE`;
      if (!locked || locked.archivedAt)
        throw conflict(
          'DOCUMENT_REQUIREMENT_ARCHIVED',
          'This requirement was archived or replaced already.',
        );
      const type = await tx.documentType.findUnique({
        where: { id: current.typeId },
      });
      if (!type || type.archivedAt)
        invalid(
          'DOCUMENT_TYPE_INVALID',
          'The document type is archived; reactivate it first.',
        );
      const next = {
        employmentType: input.employmentType ?? null,
        departmentId: input.departmentId ?? null,
        positionId: input.positionId ?? null,
        note: parseText(input.note, 'note', { max: 1000 }),
      };
      if (
        next.employmentType === current.employmentType &&
        next.departmentId === current.departmentId &&
        next.positionId === current.positionId &&
        next.note === current.note
      )
        invalid(
          'DOCUMENT_REQUIREMENT_UNCHANGED',
          'The replacement is the same as the current requirement.',
        );
      await this.validateCriteria(tx, current.organizationId, next);
      const duplicate = await tx.documentRequirement.findFirst({
        where: {
          organizationId: current.organizationId,
          typeId: current.typeId,
          archivedAt: null,
          id: { not: requirementId },
          employmentType: next.employmentType,
          departmentId: next.departmentId,
          positionId: next.positionId,
        },
      });
      if (duplicate)
        throw conflict(
          'DOCUMENT_REQUIREMENT_EXISTS',
          'This requirement already exists.',
        );
      const previous = await tx.documentRequirement.update({
        where: { id: requirementId },
        data: { archivedAt: this.clock.now() },
        include: REQUIREMENT_INCLUDE,
      });
      const row = await tx.documentRequirement.create({
        data: {
          organizationId: current.organizationId,
          typeId: current.typeId,
          ...next,
          createdByUserId: actor,
        },
        include: REQUIREMENT_INCLUDE,
      });
      await this.audit.write(
        tx,
        'DOCUMENT_REQUIREMENT_REPLACED',
        'DocumentRequirement',
        row.id,
        context,
        {
          organizationId: row.organizationId,
          typeId: row.typeId,
          previousRequirementId: requirementId,
        },
      );
      return {
        previous: requirementShape(previous),
        requirement: requirementShape(row),
      };
    });
  }

  private async validateCriteria(
    tx: Tx,
    organizationId: string,
    criteria: { departmentId: string | null; positionId: string | null },
  ) {
    if (
      criteria.departmentId &&
      !(await tx.department.count({
        where: { id: criteria.departmentId, organizationId },
      }))
    )
      invalid(
        'DOCUMENT_REQUIREMENT_INVALID',
        'The department belongs to another organization.',
      );
    if (
      criteria.positionId &&
      !(await tx.position.count({
        where: { id: criteria.positionId, organizationId },
      }))
    )
      invalid(
        'DOCUMENT_REQUIREMENT_INVALID',
        'The position belongs to another organization.',
      );
  }

  async createRequirement(
    input: {
      organizationId: string;
      typeId: string;
      employmentType?: EmploymentType | null;
      departmentId?: string | null;
      positionId?: string | null;
      note?: string | null;
    },
    context: DocumentsRequestContext,
  ) {
    const actor = requireActor(context);
    await this.access.requireOrganization(
      actor,
      'document.type.manage',
      input.organizationId,
    );
    return this.prisma.$transaction(async (tx) => {
      const type = await tx.documentType.findUnique({
        where: { id: input.typeId },
      });
      if (
        !type ||
        type.organizationId !== input.organizationId ||
        type.archivedAt
      ) {
        invalid(
          'DOCUMENT_TYPE_INVALID',
          'The document type is not an active type of the organization.',
        );
      }
      if (
        input.departmentId &&
        !(await tx.department.count({
          where: {
            id: input.departmentId,
            organizationId: input.organizationId,
          },
        }))
      ) {
        invalid(
          'DOCUMENT_REQUIREMENT_INVALID',
          'The department belongs to another organization.',
        );
      }
      if (
        input.positionId &&
        !(await tx.position.count({
          where: { id: input.positionId, organizationId: input.organizationId },
        }))
      ) {
        invalid(
          'DOCUMENT_REQUIREMENT_INVALID',
          'The position belongs to another organization.',
        );
      }
      const duplicate = await tx.documentRequirement.findFirst({
        where: {
          organizationId: input.organizationId,
          typeId: input.typeId,
          archivedAt: null,
          employmentType: input.employmentType ?? null,
          departmentId: input.departmentId ?? null,
          positionId: input.positionId ?? null,
        },
      });
      if (duplicate)
        throw conflict(
          'DOCUMENT_REQUIREMENT_EXISTS',
          'This requirement already exists.',
        );
      const row = await tx.documentRequirement.create({
        data: {
          organizationId: input.organizationId,
          typeId: input.typeId,
          employmentType: input.employmentType ?? null,
          departmentId: input.departmentId ?? null,
          positionId: input.positionId ?? null,
          note: parseText(input.note, 'note', { max: 1000 }),
          createdByUserId: actor,
        },
        include: REQUIREMENT_INCLUDE,
      });
      await this.audit.write(
        tx,
        'DOCUMENT_REQUIREMENT_CREATED',
        'DocumentRequirement',
        row.id,
        context,
        { organizationId: row.organizationId, typeId: row.typeId },
      );
      return requirementShape(row);
    });
  }

  async archiveRequirement(
    requirementId: string,
    context: DocumentsRequestContext,
  ) {
    const actor = requireActor(context);
    const row = await this.prisma.documentRequirement.findUnique({
      where: { id: requirementId },
    });
    if (!row) throw new NotFoundException('Requirement not found.');
    await this.access.requireOrganization(
      actor,
      'document.type.manage',
      row.organizationId,
    );
    if (row.archivedAt) return requirementShape(row);
    return this.prisma.$transaction(async (tx) => {
      const archived = await tx.documentRequirement.update({
        where: { id: requirementId },
        data: { archivedAt: this.clock.now() },
        include: REQUIREMENT_INCLUDE,
      });
      await this.audit.write(
        tx,
        'DOCUMENT_REQUIREMENT_ARCHIVED',
        'DocumentRequirement',
        requirementId,
        context,
        { organizationId: row.organizationId },
      );
      return requirementShape(archived);
    });
  }

  private async typeOrThrow(typeId: string) {
    const type = await this.prisma.documentType.findUnique({
      where: { id: typeId },
    });
    if (!type) throw new NotFoundException('Document type not found.');
    return type;
  }
}
