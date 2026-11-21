import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditService } from '../../audit/audit.service.js';
import { domainError, jsonValue } from '../../common/domain-support.js';
import { PrismaService } from '../../database/prisma.service.js';
import {
  Prisma,
  type GoogleFormBinding,
  type GoogleFormBindingTarget,
} from '../../generated/prisma/client.js';
import { GoogleApiError } from './google-api.client.js';
import {
  GoogleFormsReader,
  GoogleIntegrationError,
} from './google-forms.adapters.js';
import { GoogleWorkspaceAccessService } from './google-workspace-access.service.js';
import {
  conflict,
  GoogleWorkspaceClock,
  writeGoogleAudit,
  type GoogleRequestContext,
} from './google-workspace-common.js';
import {
  FORM_ID,
  IDENTITY_TARGETS,
  IDENTITY_UNVERIFIED,
  formIdHash,
  MAPPING_SCHEMA_VERSION,
  mappingProblemsAgainstForm,
  MappingError,
  validateFieldMapping,
  type FormFieldMapping,
  type GoogleFormInfo,
} from './google-workspace-domain.js';

const invalid = (code: string, message: string) =>
  new BadRequestException(domainError(400, code, message));
const notFound = () =>
  new NotFoundException(
    domainError(404, 'GOOGLE_BINDING_NOT_FOUND', 'Binding not found.'),
  );

export function bindingSummary(binding: GoogleFormBinding) {
  return {
    id: binding.id,
    organizationId: binding.organizationId,
    formId: binding.formId,
    formTitle: binding.formTitle,
    target: binding.target,
    performanceSourceId: binding.performanceSourceId,
    recruitmentSourceId: binding.recruitmentSourceId,
    mapping: binding.mapping,
    mappingSchemaVersion: binding.mappingSchemaVersion,
    enabled: binding.enabled,
    cursorSubmittedAt: binding.cursorSubmittedAt,
    lastSyncAt: binding.lastSyncAt,
    lastSuccessAt: binding.lastSuccessAt,
    lastFailureAt: binding.lastFailureAt,
    lastErrorCode: binding.lastErrorCode,
    // Batch 7B (D1): the form no longer verifies respondent emails (results are held for HR).
    identityWarning:
      binding.lastErrorCode === IDENTITY_UNVERIFIED
        ? IDENTITY_UNVERIFIED
        : null,
    consecutiveFailures: binding.consecutiveFailures,
    nextSyncAfter: binding.nextSyncAfter,
    archivedAt: binding.archivedAt,
    createdAt: binding.createdAt,
    updatedAt: binding.updatedAt,
  };
}

function isUniqueViolation(error: unknown) {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2002') return true;
    if (error.code === 'P2010' || error.code === 'P2034')
      return JSON.stringify(error.meta ?? {}).includes('23505');
  }
  const text = error instanceof Error ? error.message : String(error);
  return /23505|unique constraint|bound by another organization/i.test(text);
}

/**
 * Phase 16.5 — form bindings: which Google Form feeds which domain contract of an organization
 * (its own PerformanceEvidenceSource / RecruitmentIntakeSource, or its onboarding tasks), with
 * a validated, versioned field mapping. A form is bound by one organization only, and binding
 * requires the organization's own connection to be able to read the form.
 */
@Injectable()
export class GoogleFormBindingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: GoogleWorkspaceAccessService,
    private readonly audit: AuditService,
    private readonly clock: GoogleWorkspaceClock,
    private readonly reader: GoogleFormsReader,
  ) {}

  async list(userId: string, organizationId: string, includeArchived = false) {
    await this.access.require(
      userId,
      'integration.google.read',
      organizationId,
    );
    const rows = await this.prisma.googleFormBinding.findMany({
      where: {
        organizationId,
        ...(includeArchived ? {} : { archivedAt: null }),
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return { items: rows.map(bindingSummary) };
  }

  /** Configured Google Forms sources of the organization's domains (configuration only). */
  async sources(userId: string, organizationId: string) {
    await this.access.require(
      userId,
      'integration.google.manage',
      organizationId,
    );
    const where = {
      organizationId,
      archivedAt: null,
      provider: 'GOOGLE_FORMS' as const,
    };
    const select = {
      id: true,
      code: true,
      name: true,
      externalResourceId: true,
    };
    // Sequential: the client may be a transaction (one connection).
    const performance = await this.prisma.performanceEvidenceSource.findMany({
      where,
      select,
      orderBy: { code: 'asc' },
    });
    const recruitment = await this.prisma.recruitmentIntakeSource.findMany({
      where,
      select,
      orderBy: { code: 'asc' },
    });
    const shape = (row: {
      id: string;
      code: string;
      name: string;
      externalResourceId: string | null;
    }) => ({
      id: row.id,
      code: row.code,
      name: row.name,
      formId: row.externalResourceId,
    });
    return {
      performanceSources: performance.map(shape),
      recruitmentSources: recruitment.map(shape),
    };
  }

  private async visibleBinding(userId: string | undefined, bindingId: string) {
    const binding = await this.prisma.googleFormBinding.findUnique({
      where: { id: bindingId },
    });
    if (!binding) throw notFound();
    const grants = userId ? await this.access.grants(userId) : [];
    if (
      !this.access.can(
        grants,
        'integration.google.read',
        binding.organizationId,
      )
    )
      throw notFound();
    if (
      !this.access.can(
        grants,
        'integration.google.manage',
        binding.organizationId,
      )
    )
      await this.access.require(
        userId,
        'integration.google.manage',
        binding.organizationId,
      );
    await this.access.features.require(
      binding.organizationId,
      'GOOGLE_WORKSPACE',
    );
    return binding;
  }

  private mapping(target: GoogleFormBindingTarget, input: unknown) {
    try {
      return validateFieldMapping(target, input);
    } catch (error) {
      if (error instanceof MappingError)
        throw invalid(error.code, error.message);
      throw error;
    }
  }

  /** Reads the form through the organization's own connection and checks the mapping fits it. */
  private async verifyForm(
    organizationId: string,
    formId: string,
    target: GoogleFormBindingTarget,
    mapping: FormFieldMapping,
  ): Promise<GoogleFormInfo> {
    let form: GoogleFormInfo;
    try {
      form = await this.reader.form(organizationId, formId);
    } catch (error) {
      if (error instanceof GoogleIntegrationError)
        throw conflict(
          'GOOGLE_CONNECTION_REQUIRED',
          'Connect Google Workspace with the Forms capability first.',
        );
      if (error instanceof GoogleApiError) {
        if (
          error.code === 'GOOGLE_NOT_FOUND' ||
          error.code === 'GOOGLE_FORBIDDEN'
        )
          throw invalid(
            'GOOGLE_FORM_NOT_ACCESSIBLE',
            'The connected account cannot read this form.',
          );
        throw conflict(
          'GOOGLE_FORM_CHECK_FAILED',
          'The form could not be checked; try again.',
          {
            reason: error.code,
          },
        );
      }
      throw conflict(
        'GOOGLE_FORM_CHECK_FAILED',
        'The form could not be checked; try again.',
      );
    }
    const problem = mappingProblemsAgainstForm(mapping, form);
    if (problem)
      throw invalid(problem, 'The mapping does not fit the form questions.');
    // Batch 7B (D1): responses are matched to employees automatically, so the form must
    // collect verified emails (the respondent's Google account); a typed or mapped email is not
    // proof of identity.
    if (
      IDENTITY_TARGETS.includes(target) &&
      form.emailCollection !== 'VERIFIED'
    )
      throw invalid(
        'GOOGLE_FORM_EMAIL_NOT_VERIFIED',
        'Set the form to collect verified email addresses (Settings → Responses → Collect email addresses: Verified).',
      );
    return form;
  }

  async create(
    input: {
      organizationId: string;
      formId: string;
      target: GoogleFormBindingTarget;
      performanceSourceId?: string | null;
      recruitmentSourceId?: string | null;
      mapping: unknown;
      enabled?: boolean;
    },
    context: GoogleRequestContext,
  ) {
    await this.access.require(
      context.actorUserId,
      'integration.google.manage',
      input.organizationId,
    );
    const formId = input.formId.trim();
    if (!FORM_ID.test(formId))
      throw invalid('GOOGLE_FORM_ID_INVALID', 'The form id is invalid.');
    const mapping = this.mapping(input.target, input.mapping);
    const performanceSourceId =
      input.target === 'PERFORMANCE_EVIDENCE'
        ? (input.performanceSourceId ?? null)
        : null;
    const recruitmentSourceId =
      input.target === 'RECRUITMENT_INTAKE'
        ? (input.recruitmentSourceId ?? null)
        : null;
    if (
      (input.target !== 'PERFORMANCE_EVIDENCE' && input.performanceSourceId) ||
      (input.target !== 'RECRUITMENT_INTAKE' && input.recruitmentSourceId)
    )
      throw invalid(
        'GOOGLE_BINDING_SOURCE_NOT_ALLOWED',
        'This target takes no such source.',
      );
    if (input.target === 'PERFORMANCE_EVIDENCE' && !performanceSourceId)
      throw invalid(
        'GOOGLE_BINDING_SOURCE_REQUIRED',
        'Choose the performance evidence source.',
      );
    if (input.target === 'RECRUITMENT_INTAKE' && !recruitmentSourceId)
      throw invalid(
        'GOOGLE_BINDING_SOURCE_REQUIRED',
        'Choose the recruitment intake source.',
      );
    // The domain source must be the organization's own Google Forms source for this form.
    const source = performanceSourceId
      ? await this.prisma.performanceEvidenceSource.findFirst({
          where: {
            id: performanceSourceId,
            organizationId: input.organizationId,
          },
        })
      : recruitmentSourceId
        ? await this.prisma.recruitmentIntakeSource.findFirst({
            where: {
              id: recruitmentSourceId,
              organizationId: input.organizationId,
            },
          })
        : null;
    if ((performanceSourceId || recruitmentSourceId) && !source)
      throw new NotFoundException(
        domainError(404, 'GOOGLE_SOURCE_NOT_FOUND', 'Source not found.'),
      );
    if (source) {
      if (source.archivedAt)
        throw conflict('GOOGLE_SOURCE_ARCHIVED', 'The source is archived.');
      if (source.provider !== 'GOOGLE_FORMS')
        throw invalid(
          'GOOGLE_SOURCE_PROVIDER',
          'The source is not a Google Forms source.',
        );
      if (source.externalResourceId !== formId)
        throw invalid(
          'GOOGLE_SOURCE_FORM_MISMATCH',
          "The source's form id differs from the form.",
        );
    }
    if (
      await this.prisma.googleFormBinding.count({
        where: { formId, organizationId: { not: input.organizationId } },
      })
    )
      throw conflict(
        'GOOGLE_FORM_ALREADY_BOUND',
        'This form is bound by another organization.',
      );
    // Friendly pre-check; the partial unique indexes stay the final guard under races.
    if (
      await this.prisma.googleFormBinding.count({
        where: {
          archivedAt: null,
          OR: [
            { formId, target: input.target },
            ...(performanceSourceId ? [{ performanceSourceId }] : []),
            ...(recruitmentSourceId ? [{ recruitmentSourceId }] : []),
          ],
        },
      })
    )
      throw conflict(
        'GOOGLE_FORM_ALREADY_BOUND',
        'This form or source already has a live binding.',
      );
    const form = await this.verifyForm(
      input.organizationId,
      formId,
      input.target,
      mapping,
    );
    try {
      return await this.prisma.$transaction(async (tx) => {
        const binding = await tx.googleFormBinding.create({
          data: {
            organizationId: input.organizationId,
            formId,
            formTitle: form.title ? form.title.slice(0, 300) : null,
            target: input.target,
            performanceSourceId,
            recruitmentSourceId,
            mapping: jsonValue(mapping),
            mappingSchemaVersion: MAPPING_SCHEMA_VERSION,
            enabled: input.enabled ?? true,
            createdByUserId: context.actorUserId,
            updatedByUserId: context.actorUserId,
          },
        });
        await writeGoogleAudit(this.audit, tx, {
          action: 'GOOGLE_FORM_BINDING_CREATED',
          entityType: 'GoogleFormBinding',
          entityId: binding.id,
          context,
          metadata: {
            organizationId: input.organizationId,
            target: input.target,
            formIdHash: formIdHash(formId),
            sourceId: performanceSourceId ?? recruitmentSourceId,
            mappedFields: mapping.fields.map((f) => f.field),
          },
        });
        return bindingSummary(binding);
      });
    } catch (error) {
      if (isUniqueViolation(error))
        throw conflict(
          'GOOGLE_FORM_ALREADY_BOUND',
          'This form or source already has a live binding.',
        );
      throw error;
    }
  }

  async update(
    bindingId: string,
    input: { mapping?: unknown; enabled?: boolean },
    context: GoogleRequestContext,
  ) {
    const binding = await this.visibleBinding(context.actorUserId, bindingId);
    if (binding.archivedAt)
      throw conflict('GOOGLE_BINDING_ARCHIVED', 'The binding is archived.');
    const mapping =
      input.mapping !== undefined
        ? this.mapping(binding.target, input.mapping)
        : null;
    let formTitle = binding.formTitle;
    if (mapping) {
      const form = await this.verifyForm(
        binding.organizationId,
        binding.formId,
        binding.target,
        mapping,
      );
      formTitle = form.title ? form.title.slice(0, 300) : formTitle;
    }
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRawUnsafe<Array<{ archivedAt: Date | null }>>(
        `SELECT "archivedAt" FROM "GoogleFormBinding" WHERE "id" = $1::uuid FOR NO KEY UPDATE`,
        bindingId,
      );
      if (rows[0]?.archivedAt)
        throw conflict('GOOGLE_BINDING_ARCHIVED', 'The binding is archived.');
      const reenabled = input.enabled === true && !binding.enabled;
      const updated = await tx.googleFormBinding.update({
        where: { id: bindingId },
        data: {
          ...(mapping
            ? {
                mapping: jsonValue(mapping),
                mappingSchemaVersion: MAPPING_SCHEMA_VERSION,
                formTitle,
              }
            : {}),
          ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
          // Re-enabling (or a new mapping) clears the backoff: the admin fixed something.
          ...(reenabled || mapping ? { nextSyncAfter: null } : {}),
          updatedByUserId: context.actorUserId,
        },
      });
      await writeGoogleAudit(this.audit, tx, {
        action: 'GOOGLE_FORM_BINDING_UPDATED',
        entityType: 'GoogleFormBinding',
        entityId: bindingId,
        context,
        metadata: {
          organizationId: binding.organizationId,
          target: binding.target,
          formIdHash: formIdHash(binding.formId),
          changed: [
            ...(mapping ? ['mapping'] : []),
            ...(input.enabled !== undefined ? ['enabled'] : []),
          ],
          enabled: updated.enabled,
        },
      });
      return bindingSummary(updated);
    });
  }

  async archive(bindingId: string, context: GoogleRequestContext) {
    const binding = await this.visibleBinding(context.actorUserId, bindingId);
    if (binding.archivedAt)
      throw conflict('GOOGLE_BINDING_ARCHIVED', 'The binding is archived.');
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `SELECT 1 FROM "GoogleFormBinding" WHERE "id" = $1::uuid FOR NO KEY UPDATE`,
        bindingId,
      );
      const { count } = await tx.googleFormBinding.updateMany({
        where: { id: bindingId, archivedAt: null },
        data: {
          enabled: false,
          archivedAt: this.clock.now(),
          updatedByUserId: context.actorUserId,
        },
      });
      if (count === 0)
        throw conflict('GOOGLE_BINDING_ARCHIVED', 'The binding is archived.');
      await writeGoogleAudit(this.audit, tx, {
        action: 'GOOGLE_FORM_BINDING_ARCHIVED',
        entityType: 'GoogleFormBinding',
        entityId: bindingId,
        context,
        metadata: {
          organizationId: binding.organizationId,
          target: binding.target,
          formIdHash: formIdHash(binding.formId),
        },
      });
      return bindingSummary(
        await tx.googleFormBinding.findUniqueOrThrow({
          where: { id: bindingId },
        }),
      );
    });
  }

  async runs(
    userId: string,
    query: {
      organizationId: string;
      bindingId?: string;
      limit?: number;
      offset?: number;
    },
  ) {
    await this.access.require(
      userId,
      'integration.google.read',
      query.organizationId,
    );
    const limit = Math.min(Math.max(query.limit ?? 25, 1), 100);
    const offset = Math.max(query.offset ?? 0, 0);
    const where = {
      organizationId: query.organizationId,
      ...(query.bindingId ? { bindingId: query.bindingId } : {}),
    };
    const total = await this.prisma.googleSyncRun.count({ where });
    const rows = await this.prisma.googleSyncRun.findMany({
      where,
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      skip: offset,
      take: limit,
    });
    return {
      total,
      limit,
      offset,
      items: rows.map((run) => ({
        id: run.id,
        bindingId: run.bindingId,
        target: run.target,
        trigger: run.trigger,
        triggeredByUserId: run.triggeredByUserId,
        status: run.status,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        fetched: run.fetched,
        accepted: run.accepted,
        duplicates: run.duplicates,
        rejected: run.rejected,
        errorCode: run.errorCode,
      })),
    };
  }
}
