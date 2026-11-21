import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  advisoryLock,
  domainError,
  requireActor,
} from '../common/domain-support.js';
import { PrismaService } from '../database/prisma.service.js';
import type {
  EmploymentType,
  PolicyDocument,
  DocumentStoredObject,
  PolicyDocumentVersion,
  Prisma,
} from '../generated/prisma/client.js';
import type { DocumentAcknowledgementContract } from './document-storage.contract.js';
import { DocumentsAccessService } from './documents-access.service.js';
import {
  conflict,
  DocumentsClock,
  isoDate,
  lockPolicy,
  optionalDate,
  personName,
  type DocumentsClient,
  type DocumentsRequestContext,
  type Tx,
} from './documents-common.js';
import {
  invalid,
  parseDocumentCode,
  parseStorageReference,
  parseText,
  type StorageReferenceInput,
} from './documents-domain.js';
import { DocumentsAuditAdapter } from './documents-audit.js';
import {
  EmployeeDocumentService,
  fileShape,
} from './employee-document.service.js';
import { attachStoredObject } from './document-file.service.js';

export interface PolicyInput {
  organizationId: string;
  code: string;
  title: string;
  description?: string | null;
  typeId?: string | null;
  acknowledgementRequired?: boolean;
  audienceEmploymentType?: EmploymentType | null;
  audienceDepartmentId?: string | null;
}

export interface PolicyVersionInput extends StorageReferenceInput {
  versionLabel: string;
  acknowledgementStatement?: string | null;
  effectiveOn?: string | null;
}

const POLICY_INCLUDE = {
  versions: {
    orderBy: [{ versionNumber: 'desc' }],
    include: { storedObject: true },
  },
  audienceDepartment: { select: { name: true } },
} satisfies Prisma.PolicyDocumentInclude;
type PolicyRow = Prisma.PolicyDocumentGetPayload<{
  include: typeof POLICY_INCLUDE;
}>;

/** Batch 9 (F3): never the storage key; provider file ids only to policy managers. */
function policyVersionShape(
  version: PolicyDocumentVersion & {
    storedObject?: DocumentStoredObject | null;
  },
  manager: boolean,
) {
  return {
    id: version.id,
    versionNumber: version.versionNumber,
    versionLabel: version.versionLabel,
    provider: version.provider,
    externalUrl: version.externalUrl,
    ...(manager ? { externalFileId: version.externalFileId } : {}),
    fileName: version.fileName,
    mimeType: version.mimeType,
    sizeBytes: version.sizeBytes,
    file: fileShape(version.storedObject ?? null),
    legacyReference:
      version.provider === 'INTERNAL_OBJECT_STORAGE' &&
      version.storedObjectId === null,
    acknowledgementStatement: version.acknowledgementStatement,
    effectiveOn: isoDate(version.effectiveOn),
    state:
      version.publishedAt === null
        ? 'DRAFT'
        : version.supersededAt === null
          ? 'CURRENT'
          : 'SUPERSEDED',
    publishedAt: version.publishedAt?.toISOString() ?? null,
    supersededAt: version.supersededAt?.toISOString() ?? null,
    referenceStatus: version.referenceStatus,
  };
}

function policyShape(row: PolicyRow, includeDrafts: boolean) {
  const versions = row.versions.filter(
    (version) => includeDrafts || version.publishedAt !== null,
  );
  const current =
    row.versions.find(
      (version) =>
        version.publishedAt !== null && version.supersededAt === null,
    ) ?? null;
  return {
    id: row.id,
    organizationId: row.organizationId,
    code: row.code,
    title: row.title,
    description: row.description,
    typeId: row.typeId,
    status: row.status,
    acknowledgementRequired: row.acknowledgementRequired,
    audience: {
      employmentType: row.audienceEmploymentType,
      departmentId: row.audienceDepartmentId,
      departmentName: row.audienceDepartment?.name ?? null,
    },
    currentVersion: current ? policyVersionShape(current, includeDrafts) : null,
    versions: versions.map((version) =>
      policyVersionShape(version, includeDrafts),
    ),
    retiredAt: row.retiredAt?.toISOString() ?? null,
  };
}

/**
 * Phase 15 — organization policy documents (staff handbook, Code of Conduct, confidentiality,
 * technology use…) with published versions and per-version employee acknowledgements.
 * document.policy.manage at the organization authors, publishes and retires them. Publishing a
 * version supersedes the previous one; an acknowledgement covers exactly one version, so a new
 * version needs a new acknowledgement. A published version's content never changes.
 */
@Injectable()
export class PolicyDocumentService implements DocumentAcknowledgementContract {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: DocumentsAccessService,
    private readonly audit: DocumentsAuditAdapter,
    private readonly clock: DocumentsClock,
    private readonly documents: EmployeeDocumentService,
  ) {}

  async list(userId: string, organizationId: string) {
    const grants = await this.access.grants(userId);
    const canManage = this.access.canInOrganization(
      grants,
      'document.policy.manage',
      organizationId,
    );
    if (!canManage)
      await this.access.requireAnyInOrganization(userId, organizationId);
    else await this.access.requireEnabled(organizationId);
    const rows = await this.prisma.policyDocument.findMany({
      where: { organizationId, ...(canManage ? {} : { status: 'PUBLISHED' }) },
      include: POLICY_INCLUDE,
      orderBy: [{ status: 'asc' }, { title: 'asc' }],
    });
    return { items: rows.map((row) => policyShape(row, canManage)) };
  }

  async create(input: PolicyInput, context: DocumentsRequestContext) {
    const actor = requireActor(context);
    await this.access.requireOrganization(
      actor,
      'document.policy.manage',
      input.organizationId,
    );
    const code = parseDocumentCode(input.code);
    return this.prisma.$transaction(async (tx) => {
      if (
        await tx.policyDocument.findUnique({
          where: {
            organizationId_code: { organizationId: input.organizationId, code },
          },
        })
      ) {
        throw conflict(
          'POLICY_EXISTS',
          `A policy with code ${code} already exists.`,
        );
      }
      await this.validateRefs(
        tx,
        input.organizationId,
        input.typeId,
        input.audienceDepartmentId,
      );
      const row = await tx.policyDocument.create({
        data: {
          organizationId: input.organizationId,
          code,
          title: parseText(input.title, 'title', { required: true, max: 300 })!,
          description: parseText(input.description, 'description'),
          typeId: input.typeId ?? null,
          acknowledgementRequired: input.acknowledgementRequired ?? true,
          audienceEmploymentType: input.audienceEmploymentType ?? null,
          audienceDepartmentId: input.audienceDepartmentId ?? null,
          createdByUserId: actor,
        },
        include: POLICY_INCLUDE,
      });
      await this.audit.write(
        tx,
        'POLICY_DOCUMENT_CREATED',
        'PolicyDocument',
        row.id,
        context,
        { organizationId: row.organizationId, code },
      );
      return policyShape(row, true);
    });
  }

  async update(
    policyId: string,
    input: Partial<
      Pick<
        PolicyInput,
        | 'title'
        | 'description'
        | 'acknowledgementRequired'
        | 'audienceEmploymentType'
        | 'audienceDepartmentId'
      >
    >,
    context: DocumentsRequestContext,
  ) {
    const actor = requireActor(context);
    return this.prisma.$transaction(async (tx) => {
      const policy = await this.lockedForManage(tx, actor, policyId);
      if (input.audienceDepartmentId !== undefined)
        await this.validateRefs(
          tx,
          policy.organizationId,
          null,
          input.audienceDepartmentId,
        );
      await tx.policyDocument.update({
        where: { id: policyId },
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
          ...(input.acknowledgementRequired !== undefined
            ? { acknowledgementRequired: input.acknowledgementRequired }
            : {}),
          ...(input.audienceEmploymentType !== undefined
            ? { audienceEmploymentType: input.audienceEmploymentType }
            : {}),
          ...(input.audienceDepartmentId !== undefined
            ? { audienceDepartmentId: input.audienceDepartmentId }
            : {}),
        },
      });
      await this.audit.write(
        tx,
        'POLICY_DOCUMENT_UPDATED',
        'PolicyDocument',
        policyId,
        context,
        {
          organizationId: policy.organizationId,
          fields: Object.keys(input).filter(
            (key) => input[key as keyof typeof input] !== undefined,
          ),
        },
      );
      return policyShape(
        await tx.policyDocument.findUniqueOrThrow({
          where: { id: policyId },
          include: POLICY_INCLUDE,
        }),
        true,
      );
    });
  }

  /** The policy's next version as a draft (one draft at a time). */
  async createVersion(
    policyId: string,
    input: PolicyVersionInput,
    context: DocumentsRequestContext,
  ) {
    const actor = requireActor(context);
    // Links carry the reference only; an uploaded file brings its verified size (Batch 9).
    const {
      sizeBytes: _sizeBytes,
      uploadId,
      ...reference
    } = parseStorageReference(input);
    return this.prisma.$transaction(async (tx) => {
      const policy = await this.lockedForManage(tx, actor, policyId);
      // Batch 9 (review): the upload is attached (or recognized as a retry) before the
      // one-draft rule, so retrying a save that succeeded returns its result instead of 409;
      // a refusal below rolls the attachment back with the transaction.
      const stored = uploadId
        ? await attachStoredObject(
            tx,
            uploadId,
            {
              actorUserId: actor,
              organizationId: policy.organizationId,
              purposes: ['POLICY_VERSION'],
              policyId,
            },
            this.clock.now(),
          )
        : null;
      if (stored?.kind === 'ALREADY_ATTACHED')
        return policyShape(
          await tx.policyDocument.findUniqueOrThrow({
            where: { id: policyId },
            include: POLICY_INCLUDE,
          }),
          true,
        );
      if (
        await tx.policyDocumentVersion.findFirst({
          where: {
            policyId,
            publishedAt: null,
          },
        })
      ) {
        throw conflict(
          'POLICY_DRAFT_EXISTS',
          'The policy already has an unpublished draft version.',
        );
      }
      const last = await tx.policyDocumentVersion.findFirst({
        where: { policyId },
        orderBy: { versionNumber: 'desc' },
      });
      const statement = parseText(
        input.acknowledgementStatement,
        'acknowledgementStatement',
        { max: 4000 },
      );
      const version = await tx.policyDocumentVersion.create({
        data: {
          policyId,
          organizationId: policy.organizationId,
          versionNumber: (last?.versionNumber ?? 0) + 1,
          versionLabel: parseText(input.versionLabel, 'versionLabel', {
            required: true,
            max: 100,
          })!,
          ...(stored?.kind === 'ATTACHED'
            ? {
                provider: stored.version.provider,
                storageKey: stored.version.storageKey,
                storedObjectId: stored.version.storedObjectId,
                fileName: stored.version.fileName,
                mimeType: stored.version.mimeType,
                sizeBytes: stored.version.sizeBytes,
              }
            : reference),
          acknowledgementStatement: statement,
          effectiveOn: optionalDate(input.effectiveOn, 'effectiveOn'),
          createdByUserId: actor,
        },
      });
      await this.audit.write(
        tx,
        'POLICY_VERSION_CREATED',
        'PolicyDocument',
        policyId,
        context,
        {
          organizationId: policy.organizationId,
          versionId: version.id,
          versionNumber: version.versionNumber,
          provider: reference.provider,
        },
      );
      return policyShape(
        await tx.policyDocument.findUniqueOrThrow({
          where: { id: policyId },
          include: POLICY_INCLUDE,
        }),
        true,
      );
    });
  }

  /**
   * Batch 9 (D10): reuses a retired policy as a new DRAFT policy under a new code — its
   * title, description, type, acknowledgement setting and audience are copied; no version is
   * copied (a version's file belongs to that version), so the draft gets its own first version.
   * The retired policy, its versions and every acknowledgement stay exactly as they were.
   */
  async copyRetired(
    policyId: string,
    input: { code: string; title?: string | null },
    context: DocumentsRequestContext,
  ) {
    const actor = requireActor(context);
    const source = await this.prisma.policyDocument.findUnique({
      where: { id: policyId },
    });
    if (!source) throw new NotFoundException('Policy not found.');
    await this.access.requireOrganization(
      actor,
      'document.policy.manage',
      source.organizationId,
    );
    if (source.status !== 'RETIRED')
      throw conflict(
        'POLICY_NOT_RETIRED',
        'Only a retired policy is copied into a new draft; edit this one instead.',
      );
    const code = parseDocumentCode(input.code);
    return this.prisma.$transaction(async (tx) => {
      if (
        await tx.policyDocument.findUnique({
          where: {
            organizationId_code: {
              organizationId: source.organizationId,
              code,
            },
          },
        })
      )
        throw conflict(
          'POLICY_EXISTS',
          `A policy with code ${code} already exists.`,
        );
      const typeActive =
        source.typeId &&
        (await tx.documentType.count({
          where: { id: source.typeId, archivedAt: null },
        }));
      const row = await tx.policyDocument.create({
        data: {
          organizationId: source.organizationId,
          code,
          title: parseText(input.title, 'title', { max: 300 }) ?? source.title,
          description: source.description,
          typeId: typeActive ? source.typeId : null,
          acknowledgementRequired: source.acknowledgementRequired,
          audienceEmploymentType: source.audienceEmploymentType,
          audienceDepartmentId: source.audienceDepartmentId,
          createdByUserId: actor,
        },
        include: POLICY_INCLUDE,
      });
      await this.audit.write(
        tx,
        'POLICY_COPIED',
        'PolicyDocument',
        row.id,
        context,
        {
          organizationId: row.organizationId,
          sourcePolicyId: source.id,
          code,
        },
      );
      return policyShape(row, true);
    });
  }

  /** Publishes the draft: it becomes current and the previous version is superseded. */
  async publish(
    policyId: string,
    versionId: string,
    context: DocumentsRequestContext,
  ) {
    const actor = requireActor(context);
    return this.prisma.$transaction(async (tx) => {
      const policy = await this.lockedForManage(tx, actor, policyId);
      const version = await tx.policyDocumentVersion.findUnique({
        where: { id: versionId },
      });
      if (!version || version.policyId !== policyId)
        throw new NotFoundException('Version not found.');
      if (version.publishedAt)
        throw conflict(
          'POLICY_VERSION_PUBLISHED',
          'The version is already published.',
        );
      if (policy.acknowledgementRequired && !version.acknowledgementStatement) {
        invalid(
          'POLICY_STATEMENT_REQUIRED',
          'A policy that needs acknowledgement states what employees acknowledge.',
        );
      }
      const now = this.clock.now();
      await tx.policyDocumentVersion.updateMany({
        where: { policyId, publishedAt: { not: null }, supersededAt: null },
        data: { supersededAt: now },
      });
      await tx.policyDocumentVersion.update({
        where: { id: versionId },
        data: { publishedAt: now, publishedByUserId: actor },
      });
      if (policy.status === 'DRAFT')
        await tx.policyDocument.update({
          where: { id: policyId },
          data: { status: 'PUBLISHED' },
        });
      await this.audit.write(
        tx,
        'POLICY_VERSION_PUBLISHED',
        'PolicyDocument',
        policyId,
        context,
        {
          organizationId: policy.organizationId,
          versionId,
          versionNumber: version.versionNumber,
        },
      );
      return policyShape(
        await tx.policyDocument.findUniqueOrThrow({
          where: { id: policyId },
          include: POLICY_INCLUDE,
        }),
        true,
      );
    });
  }

  async retire(policyId: string, context: DocumentsRequestContext) {
    const actor = requireActor(context);
    return this.prisma.$transaction(async (tx) => {
      const policy = await this.lockedForManage(tx, actor, policyId);
      await tx.policyDocumentVersion.deleteMany({
        where: { policyId, publishedAt: null },
      });
      await tx.policyDocument.update({
        where: { id: policyId },
        data: { status: 'RETIRED', retiredAt: this.clock.now() },
      });
      await this.audit.write(
        tx,
        'POLICY_DOCUMENT_RETIRED',
        'PolicyDocument',
        policyId,
        context,
        { organizationId: policy.organizationId },
      );
      return policyShape(
        await tx.policyDocument.findUniqueOrThrow({
          where: { id: policyId },
          include: POLICY_INCLUDE,
        }),
        true,
      );
    });
  }

  // ─── Acknowledgements ─────────────────────────────────────────────────────

  /** The employee acknowledges the current version of a policy addressed to them. */
  async acknowledge(
    policyId: string,
    versionId: string,
    statementAccepted: boolean,
    context: DocumentsRequestContext,
  ) {
    const actor = requireActor(context);
    if (statementAccepted !== true)
      invalid(
        'POLICY_ACKNOWLEDGEMENT_REQUIRED',
        'Confirm the acknowledgement statement.',
      );
    const employeeId = await this.access.employeeIdOfUser(actor);
    if (!employeeId)
      throw new ForbiddenException(
        domainError(
          403,
          'DOCUMENT_NOT_AN_EMPLOYEE',
          'Your account is not linked to an employee.',
        ),
      );
    return this.prisma.$transaction(async (tx) => {
      const policy = await tx.policyDocument.findUnique({
        where: { id: policyId },
      });
      if (!policy) throw new NotFoundException('Policy not found.');
      const result = await this.acknowledgeCurrentVersion(tx, {
        organizationId: policy.organizationId,
        policyId,
        employeeId,
        userId: actor,
        source: 'SELF_SERVICE',
        expectedVersionId: versionId,
      });
      await this.audit.write(
        tx,
        'POLICY_ACKNOWLEDGED',
        'DocumentAcknowledgement',
        result.acknowledgementId,
        context,
        {
          organizationId: policy.organizationId,
          policyId,
          policyVersionId: result.policyVersionId,
          created: result.created,
        },
      );
      return result;
    });
  }

  /**
   * The acknowledgement contract (also used by Phase 14 onboarding tasks): idempotent per
   * (version, employee), serialized by an advisory lock and a unique constraint.
   */
  async acknowledgeCurrentVersion(
    clientIn: unknown,
    input: {
      organizationId: string;
      policyId: string;
      employeeId: string;
      userId: string;
      source: 'SELF_SERVICE' | 'ONBOARDING_TASK';
      expectedVersionId?: string;
    },
  ) {
    const tx = clientIn as Tx;
    const policy = await tx.policyDocument.findUnique({
      where: { id: input.policyId },
    });
    if (!policy || policy.organizationId !== input.organizationId)
      throw new NotFoundException('Policy not found.');
    // Phase 18: self-service acknowledgements and the onboarding contract need Documents on.
    await this.access.requireEnabled(policy.organizationId, tx);
    if (policy.status !== 'PUBLISHED')
      throw conflict('POLICY_NOT_PUBLISHED', 'The policy is not published.');
    if (!(await this.inAudience(tx, policy, input.employeeId)))
      throw new NotFoundException('Policy not found.');
    const current = await tx.policyDocumentVersion.findFirst({
      where: {
        policyId: input.policyId,
        publishedAt: { not: null },
        supersededAt: null,
      },
    });
    if (!current)
      throw conflict(
        'POLICY_NOT_PUBLISHED',
        'The policy has no published version.',
      );
    if (input.expectedVersionId && input.expectedVersionId !== current.id) {
      throw conflict(
        'POLICY_VERSION_NOT_CURRENT',
        'A newer version was published; review it before acknowledging.',
        { currentVersionId: current.id },
      );
    }
    const statement =
      current.acknowledgementStatement ??
      `I have received version ${current.versionLabel} of ${policy.title}.`;
    await advisoryLock(tx, `document-ack:${current.id}:${input.employeeId}`);
    const existing = await tx.documentAcknowledgement.findUnique({
      where: {
        policyVersionId_employeeId: {
          policyVersionId: current.id,
          employeeId: input.employeeId,
        },
      },
    });
    if (existing)
      return {
        acknowledgementId: existing.id,
        policyVersionId: current.id,
        created: false,
        statement: existing.statement,
      };
    const row = await tx.documentAcknowledgement.create({
      data: {
        organizationId: input.organizationId,
        policyVersionId: current.id,
        employeeId: input.employeeId,
        acknowledgedByUserId: input.userId,
        statement,
        source: input.source,
        acknowledgedAt: this.clock.now(),
      },
    });
    return {
      acknowledgementId: row.id,
      policyVersionId: current.id,
      created: true,
      statement,
    };
  }

  validDocumentOfType(
    client: unknown,
    input: { organizationId: string; employeeId: string; typeId: string },
  ) {
    return this.documents.validDocumentOfType(client as DocumentsClient, input);
  }

  /** The signed-in employee's policies: current version and whether they acknowledged it. */
  async mine(userId: string) {
    const employeeId = await this.access.employeeIdOfUser(userId);
    if (!employeeId) return { items: [] };
    const orgs = await this.prisma.employmentAssignment.findMany({
      where: { employeeId, status: { in: ['ACTIVE', 'PLANNED'] } },
      select: { position: { select: { organizationId: true } } },
    });
    const candidates = [
      ...new Set(orgs.map((row) => row.position.organizationId)),
    ];
    // Phase 18: organizations with Documents disabled are left out.
    const disabled = await this.access.features.disabledAmong(
      'DOCUMENTS',
      candidates,
    );
    const organizationIds = candidates.filter((id) => !disabled.has(id));
    const policies = await this.prisma.policyDocument.findMany({
      where: { organizationId: { in: organizationIds }, status: 'PUBLISHED' },
      include: POLICY_INCLUDE,
      orderBy: { title: 'asc' },
    });
    const acknowledgements = await this.prisma.documentAcknowledgement.findMany(
      { where: { employeeId } },
    );
    const items = [];
    for (const policy of policies) {
      if (!(await this.inAudience(this.prisma, policy, employeeId))) continue;
      const shape = policyShape(policy, false);
      const current = shape.currentVersion;
      const mineAck = acknowledgements.find(
        (ack) => ack.policyVersionId === current?.id,
      );
      const earlier = acknowledgements.filter((ack) =>
        policy.versions.some(
          (v) => v.id === ack.policyVersionId && v.id !== current?.id,
        ),
      );
      items.push({
        ...shape,
        myAcknowledgement: mineAck
          ? {
              id: mineAck.id,
              acknowledgedAt: mineAck.acknowledgedAt.toISOString(),
              statement: mineAck.statement,
            }
          : null,
        acknowledgedEarlierVersion: earlier.length > 0,
        needsAcknowledgement:
          policy.acknowledgementRequired && current !== null && !mineAck,
      });
    }
    return { items };
  }

  /** Acknowledgement tracking for the current version (policy managers or org-level readers). */
  async tracking(userId: string, policyId: string) {
    const policy = await this.prisma.policyDocument.findUnique({
      where: { id: policyId },
      include: POLICY_INCLUDE,
    });
    if (!policy) throw new NotFoundException('Policy not found.');
    const grants = await this.access.grants(userId);
    if (
      !this.access.canInOrganization(
        grants,
        'document.policy.manage',
        policy.organizationId,
      ) &&
      !this.access.canInOrganization(
        grants,
        'document.read',
        policy.organizationId,
      )
    ) {
      throw new ForbiddenException(
        'Missing permission document.policy.manage for the organization.',
      );
    }
    await this.access.requireEnabled(policy.organizationId);
    const current =
      policy.versions.find((v) => v.publishedAt && !v.supersededAt) ?? null;
    const assignments = await this.prisma.employmentAssignment.findMany({
      where: {
        status: { in: ['ACTIVE', 'PLANNED'] },
        position: { organizationId: policy.organizationId },
      },
      select: {
        employeeId: true,
        employmentType: true,
        position: { select: { departmentId: true } },
        employee: {
          select: {
            employeeNumber: true,
            person: {
              select: { firstName: true, lastName: true, preferredName: true },
            },
          },
        },
      },
    });
    const audience = new Map<string, (typeof assignments)[number]>();
    for (const row of assignments) {
      if (
        policy.audienceEmploymentType &&
        row.employmentType !== policy.audienceEmploymentType
      )
        continue;
      if (
        policy.audienceDepartmentId &&
        row.position.departmentId !== policy.audienceDepartmentId
      )
        continue;
      audience.set(row.employeeId, row);
    }
    const acks = await this.prisma.documentAcknowledgement.findMany({
      where: {
        employeeId: { in: [...audience.keys()] },
        policyVersion: { policyId },
      },
      include: { policyVersion: { select: { id: true, versionNumber: true } } },
    });
    const items = [...audience.values()].map((row) => {
      const ofEmployee = acks.filter(
        (ack) => ack.employeeId === row.employeeId,
      );
      const currentAck = current
        ? ofEmployee.find((ack) => ack.policyVersionId === current.id)
        : undefined;
      return {
        employee: {
          id: row.employeeId,
          employeeNumber: row.employee.employeeNumber,
          displayName: personName(row.employee.person),
        },
        status: currentAck
          ? 'ACKNOWLEDGED'
          : ofEmployee.length > 0
            ? 'EARLIER_VERSION_ONLY'
            : 'PENDING',
        acknowledgedAt: currentAck?.acknowledgedAt.toISOString() ?? null,
      };
    });
    return {
      policy: policyShape(policy, false),
      currentVersionId: current?.id ?? null,
      counts: {
        audience: items.length,
        acknowledged: items.filter((i) => i.status === 'ACKNOWLEDGED').length,
        pending: items.filter((i) => i.status !== 'ACKNOWLEDGED').length,
      },
      items,
    };
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  async inAudience(
    client: DocumentsClient,
    policy: PolicyDocument,
    employeeId: string,
  ) {
    return (
      (await client.employmentAssignment.count({
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
            ? { employmentType: policy.audienceEmploymentType }
            : {}),
        },
      })) > 0
    );
  }

  private async lockedForManage(tx: Tx, actor: string, policyId: string) {
    await lockPolicy(tx, policyId);
    const policy = await tx.policyDocument.findUniqueOrThrow({
      where: { id: policyId },
    });
    await this.access.requireOrganization(
      actor,
      'document.policy.manage',
      policy.organizationId,
      tx,
    );
    if (policy.status === 'RETIRED')
      throw conflict('POLICY_RETIRED', 'A retired policy is frozen.');
    return policy;
  }

  private async validateRefs(
    tx: Tx,
    organizationId: string,
    typeId: string | null | undefined,
    departmentId: string | null | undefined,
  ) {
    if (
      typeId &&
      !(await tx.documentType.count({ where: { id: typeId, organizationId } }))
    ) {
      invalid(
        'DOCUMENT_TYPE_INVALID',
        'The document type belongs to another organization.',
      );
    }
    if (
      departmentId &&
      !(await tx.department.count({
        where: { id: departmentId, organizationId },
      }))
    ) {
      invalid(
        'POLICY_AUDIENCE_INVALID',
        'The department belongs to another organization.',
      );
    }
  }
}
