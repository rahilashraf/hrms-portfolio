import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { domainError, requireActor } from '../common/domain-support.js';
import { PrismaService } from '../database/prisma.service.js';
import type {
  PerformanceItemType,
  PerformanceRespondent,
  PerformanceScoringMode,
  Prisma,
} from '../generated/prisma/client.js';
import { PerformanceAccessService } from './performance-access.service.js';
import {
  isUniqueViolation,
  lockScale,
  lockTemplate,
  writePerformanceAudit,
  type PerformanceRequestContext,
} from './performance-common.js';
import {
  assertTemplateWeights,
  parsePerformanceCode,
  parseScaleLevels,
  parseText,
  type ScaleLevel,
} from './performance-domain.js';

export interface CompetencyInput {
  organizationId: string;
  code: string;
  name: string;
  description?: string | null;
  category?: string | null;
}

export interface ScaleInput {
  organizationId: string;
  code: string;
  name: string;
  description?: string | null;
  levels: ScaleLevel[];
}

export interface TemplateItemInput {
  itemType: PerformanceItemType;
  prompt: string;
  helpText?: string | null;
  respondent: PerformanceRespondent;
  required?: boolean;
  weight?: string | null;
  competencyId?: string | null;
  ratingScaleId?: string | null;
  scaleMin?: number | null;
  scaleMax?: number | null;
}

export interface TemplateContentInput {
  scoringMode: PerformanceScoringMode;
  ratingScaleId?: string | null;
  overallRatingEnabled?: boolean;
  sections: Array<{
    title: string;
    description?: string | null;
    items: TemplateItemInput[];
  }>;
}

export interface TemplateInput extends TemplateContentInput {
  organizationId: string;
  code: string;
  name: string;
  description?: string | null;
}

const conflict = (
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
) => new ConflictException(domainError(409, code, message, extra));
const invalid = (
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
) => new BadRequestException(domainError(400, code, message, extra));

const TEMPLATE_INCLUDE = {
  ratingScale: { include: { levels: { orderBy: { value: 'asc' } } } },
  sections: {
    orderBy: { sortOrder: 'asc' },
    include: {
      items: {
        orderBy: { sortOrder: 'asc' },
        include: {
          competency: {
            select: { id: true, code: true, name: true, archivedAt: true },
          },
          ratingScale: {
            select: { id: true, code: true, name: true, status: true },
          },
        },
      },
    },
  },
} as const;

/**
 * Phase 12 Batch 12.2 — reusable performance configuration of an organization
 * (performance.template.manage at the organization): competencies, rating scales and review
 * templates. Scales and templates are edited as drafts and frozen once active (a change is a
 * new version: copy, edit, activate); cycles snapshot them, so nothing here rewrites history.
 * Reads need any performance permission in the organization.
 */
@Injectable()
export class PerformanceConfigService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: PerformanceAccessService,
    private readonly audit: AuditService,
  ) {}

  // ─── Competencies ─────────────────────────────────────────────────────────

  async competencies(
    userId: string,
    organizationId: string,
    includeArchived = false,
  ) {
    await this.access.requireConfigurationRead(userId, organizationId);
    const rows = await this.prisma.performanceCompetency.findMany({
      where: {
        organizationId,
        ...(includeArchived ? {} : { archivedAt: null }),
      },
      orderBy: [{ archivedAt: 'asc' }, { category: 'asc' }, { name: 'asc' }],
    });
    return { items: rows.map((row) => this.competencyShape(row)) };
  }

  async createCompetency(
    input: CompetencyInput,
    context: PerformanceRequestContext,
  ) {
    const actor = requireActor(context);
    await this.access.requireOrganization(
      actor,
      'performance.template.manage',
      input.organizationId,
    );
    const data = {
      organizationId: input.organizationId,
      code: parsePerformanceCode(input.code),
      name: parseText(input.name, 'name', { required: true, max: 120 })!,
      description: parseText(input.description, 'description', { max: 1000 }),
      category: parseText(input.category, 'category', { max: 120 }),
      createdByUserId: actor,
    };
    return this.prisma.$transaction(async (tx) => {
      await this.assertCodeFree(
        tx,
        'competency',
        data.organizationId,
        data.code,
      );
      const row = await tx.performanceCompetency
        .create({ data })
        .catch((error: unknown) => {
          if (isUniqueViolation(error)) {
            throw conflict(
              'PERFORMANCE_CODE_EXISTS',
              'A competency with this code already exists.',
            );
          }
          throw error;
        });
      await this.auditWrite(
        tx,
        'PERFORMANCE_COMPETENCY_CREATED',
        'PerformanceCompetency',
        row.id,
        context,
        {
          organizationId: row.organizationId,
          code: row.code,
        },
      );
      return this.competencyShape(row);
    });
  }

  async updateCompetency(
    id: string,
    input: Partial<Pick<CompetencyInput, 'name' | 'description' | 'category'>>,
    context: PerformanceRequestContext,
  ) {
    const actor = requireActor(context);
    const existing = await this.competencyOrThrow(id);
    await this.access.requireOrganizationRecord(
      actor,
      'performance.template.manage',
      existing.organizationId,
      'Competency not found.',
    );
    if (existing.archivedAt) {
      throw conflict(
        'PERFORMANCE_COMPETENCY_ARCHIVED',
        'An archived competency cannot be edited.',
      );
    }
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.performanceCompetency.update({
        where: { id },
        data: {
          ...(input.name !== undefined
            ? {
                name: parseText(input.name, 'name', {
                  required: true,
                  max: 120,
                })!,
              }
            : {}),
          ...(input.description !== undefined
            ? {
                description: parseText(input.description, 'description', {
                  max: 1000,
                }),
              }
            : {}),
          ...(input.category !== undefined
            ? { category: parseText(input.category, 'category', { max: 120 }) }
            : {}),
        },
      });
      await this.auditWrite(
        tx,
        'PERFORMANCE_COMPETENCY_UPDATED',
        'PerformanceCompetency',
        id,
        context,
        {
          organizationId: row.organizationId,
          fields: Object.keys(input).filter(
            (key) => input[key as keyof typeof input] !== undefined,
          ),
        },
      );
      return this.competencyShape(row);
    });
  }

  /** Archiving keeps history (cycles keep the label) and only stops new template use. */
  async archiveCompetency(id: string, context: PerformanceRequestContext) {
    const actor = requireActor(context);
    const existing = await this.competencyOrThrow(id);
    await this.access.requireOrganizationRecord(
      actor,
      'performance.template.manage',
      existing.organizationId,
      'Competency not found.',
    );
    if (existing.archivedAt) return this.competencyShape(existing);
    return this.prisma.$transaction(async (tx) => {
      await this.refuseIfUsedByActiveTemplate(tx, existing.organizationId, {
        competencyId: id,
      });
      const row = await tx.performanceCompetency.update({
        where: { id },
        data: { archivedAt: new Date() },
      });
      await this.auditWrite(
        tx,
        'PERFORMANCE_COMPETENCY_ARCHIVED',
        'PerformanceCompetency',
        id,
        context,
        {
          organizationId: row.organizationId,
        },
      );
      return this.competencyShape(row);
    });
  }

  // ─── Rating scales ────────────────────────────────────────────────────────

  async scales(
    userId: string,
    organizationId: string,
    includeArchived = false,
  ) {
    await this.access.requireConfigurationRead(userId, organizationId);
    const rows = await this.prisma.performanceRatingScale.findMany({
      where: {
        organizationId,
        ...(includeArchived ? {} : { status: { not: 'ARCHIVED' } }),
      },
      include: { levels: { orderBy: { value: 'asc' } } },
      orderBy: [{ status: 'asc' }, { name: 'asc' }],
    });
    return { items: rows.map((row) => this.scaleShape(row)) };
  }

  async createScale(input: ScaleInput, context: PerformanceRequestContext) {
    const actor = requireActor(context);
    await this.access.requireOrganization(
      actor,
      'performance.template.manage',
      input.organizationId,
    );
    const code = parsePerformanceCode(input.code);
    const name = parseText(input.name, 'name', { required: true, max: 120 })!;
    const description = parseText(input.description, 'description', {
      max: 1000,
    });
    const levels = parseScaleLevels(input.levels);
    return this.prisma.$transaction(async (tx) => {
      await this.assertCodeFree(tx, 'scale', input.organizationId, code);
      const row = await tx.performanceRatingScale
        .create({
          data: {
            organizationId: input.organizationId,
            code,
            name,
            description,
            createdByUserId: actor,
            levels: { create: levels },
          },
          include: { levels: { orderBy: { value: 'asc' } } },
        })
        .catch((error: unknown) => {
          if (isUniqueViolation(error)) {
            throw conflict(
              'PERFORMANCE_CODE_EXISTS',
              'A rating scale with this code already exists.',
            );
          }
          throw error;
        });
      await this.auditWrite(
        tx,
        'PERFORMANCE_SCALE_CREATED',
        'PerformanceRatingScale',
        row.id,
        context,
        {
          organizationId: row.organizationId,
          code,
          levels: levels.length,
        },
      );
      return this.scaleShape(row);
    });
  }

  /** Name and description any time; levels only while the scale is a draft. */
  async updateScale(
    id: string,
    input: Partial<Pick<ScaleInput, 'name' | 'description' | 'levels'>>,
    context: PerformanceRequestContext,
  ) {
    const actor = requireActor(context);
    const existing = await this.scaleOrThrow(id);
    await this.access.requireOrganizationRecord(
      actor,
      'performance.template.manage',
      existing.organizationId,
      'Rating scale not found.',
    );
    const levels =
      input.levels !== undefined ? parseScaleLevels(input.levels) : undefined;
    return this.prisma.$transaction(async (tx) => {
      await lockScale(tx, id);
      const current = await tx.performanceRatingScale.findUniqueOrThrow({
        where: { id },
      });
      if (current.status === 'ARCHIVED') {
        throw conflict(
          'PERFORMANCE_SCALE_ARCHIVED',
          'An archived rating scale cannot be edited.',
        );
      }
      if (levels && current.status !== 'DRAFT') {
        throw conflict(
          'PERFORMANCE_SCALE_ACTIVE',
          'Levels of an active rating scale never change; create a new scale.',
        );
      }
      if (levels) {
        await tx.performanceRatingScaleLevel.deleteMany({
          where: { scaleId: id },
        });
        await tx.performanceRatingScaleLevel.createMany({
          data: levels.map((level) => ({ ...level, scaleId: id })),
        });
      }
      const row = await tx.performanceRatingScale.update({
        where: { id },
        data: {
          ...(input.name !== undefined
            ? {
                name: parseText(input.name, 'name', {
                  required: true,
                  max: 120,
                })!,
              }
            : {}),
          ...(input.description !== undefined
            ? {
                description: parseText(input.description, 'description', {
                  max: 1000,
                }),
              }
            : {}),
        },
        include: { levels: { orderBy: { value: 'asc' } } },
      });
      await this.auditWrite(
        tx,
        'PERFORMANCE_SCALE_UPDATED',
        'PerformanceRatingScale',
        id,
        context,
        {
          organizationId: row.organizationId,
          levelsReplaced: Boolean(levels),
        },
      );
      return this.scaleShape(row);
    });
  }

  async transitionScale(
    id: string,
    to: 'ACTIVE' | 'ARCHIVED',
    context: PerformanceRequestContext,
  ) {
    const actor = requireActor(context);
    const existing = await this.scaleOrThrow(id);
    await this.access.requireOrganizationRecord(
      actor,
      'performance.template.manage',
      existing.organizationId,
      'Rating scale not found.',
    );
    return this.prisma.$transaction(async (tx) => {
      await lockScale(tx, id);
      const current = await tx.performanceRatingScale.findUniqueOrThrow({
        where: { id },
        include: { levels: true },
      });
      if (current.status === to) {
        return this.scaleShape({
          ...current,
          levels: [...current.levels].sort((a, b) => a.value - b.value),
        });
      }
      if (to === 'ACTIVE' && current.status !== 'DRAFT') {
        throw conflict(
          'PERFORMANCE_STATUS_INVALID',
          'Only a draft rating scale can be activated.',
        );
      }
      if (to === 'ACTIVE') parseScaleLevels(current.levels);
      if (to === 'ARCHIVED')
        await this.refuseIfUsedByActiveTemplate(tx, current.organizationId, {
          ratingScaleId: id,
        });
      const row = await tx.performanceRatingScale.update({
        where: { id },
        data:
          to === 'ACTIVE'
            ? { status: 'ACTIVE', activatedAt: new Date() }
            : { status: 'ARCHIVED', archivedAt: new Date() },
        include: { levels: { orderBy: { value: 'asc' } } },
      });
      await this.auditWrite(
        tx,
        to === 'ACTIVE'
          ? 'PERFORMANCE_SCALE_ACTIVATED'
          : 'PERFORMANCE_SCALE_ARCHIVED',
        'PerformanceRatingScale',
        id,
        context,
        { organizationId: row.organizationId, from: current.status, to },
      );
      return this.scaleShape(row);
    });
  }

  // ─── Templates ────────────────────────────────────────────────────────────

  async templates(
    userId: string,
    organizationId: string,
    includeArchived = false,
  ) {
    await this.access.requireConfigurationRead(userId, organizationId);
    const rows = await this.prisma.performanceTemplate.findMany({
      where: {
        organizationId,
        ...(includeArchived ? {} : { status: { not: 'ARCHIVED' } }),
      },
      include: {
        ratingScale: { select: { id: true, code: true, name: true } },
        _count: { select: { items: true, sections: true, cycles: true } },
      },
      orderBy: [{ status: 'asc' }, { name: 'asc' }],
    });
    return {
      items: rows.map((row) => ({
        ...this.templateHeader(row),
        ratingScale: row.ratingScale,
        sectionCount: row._count.sections,
        itemCount: row._count.items,
        cycleCount: row._count.cycles,
      })),
    };
  }

  async template(userId: string, id: string) {
    const row = await this.prisma.performanceTemplate.findUnique({
      where: { id },
      include: TEMPLATE_INCLUDE,
    });
    if (!row) throw new NotFoundException('Template not found.');
    await this.access.notFoundOutside(
      userId,
      row.organizationId,
      'Template not found.',
    );
    await this.access.requireConfigurationRead(userId, row.organizationId);
    const grants = await this.access.grants(userId);
    const canManage = this.access.canInOrganization(
      grants,
      'performance.template.manage',
      row.organizationId,
    );
    return this.templateDetail(row, canManage);
  }

  async createTemplate(
    input: TemplateInput,
    context: PerformanceRequestContext,
  ) {
    const actor = requireActor(context);
    await this.access.requireOrganization(
      actor,
      'performance.template.manage',
      input.organizationId,
    );
    const code = parsePerformanceCode(input.code);
    const name = parseText(input.name, 'name', { required: true, max: 120 })!;
    const description = parseText(input.description, 'description', {
      max: 2000,
    });
    return this.prisma.$transaction(async (tx) => {
      await this.assertCodeFree(tx, 'template', input.organizationId, code);
      const content = await this.parseContent(
        tx,
        input.organizationId,
        input,
        false,
      );
      const row = await tx.performanceTemplate
        .create({
          data: {
            organizationId: input.organizationId,
            code,
            name,
            description,
            scoringMode: content.scoringMode,
            ratingScaleId: content.ratingScaleId,
            overallRatingEnabled: content.overallRatingEnabled,
            createdByUserId: actor,
          },
        })
        .catch((error: unknown) => {
          if (isUniqueViolation(error)) {
            throw conflict(
              'PERFORMANCE_CODE_EXISTS',
              'A template with this code already exists.',
            );
          }
          throw error;
        });
      await this.writeContent(
        tx,
        row.id,
        input.organizationId,
        content.sections,
      );
      await this.auditWrite(
        tx,
        'PERFORMANCE_TEMPLATE_CREATED',
        'PerformanceTemplate',
        row.id,
        context,
        {
          organizationId: row.organizationId,
          code,
          sections: content.sections.length,
          items: content.sections.reduce((n, s) => n + s.items.length, 0),
        },
      );
      return this.templateDetail(
        await tx.performanceTemplate.findUniqueOrThrow({
          where: { id: row.id },
          include: TEMPLATE_INCLUDE,
        }),
        true,
      );
    });
  }

  /** Name/description any time before archiving; content (replaced whole) only as a draft. */
  async updateTemplate(
    id: string,
    input: Partial<Omit<TemplateInput, 'organizationId' | 'code'>>,
    context: PerformanceRequestContext,
  ) {
    const actor = requireActor(context);
    const existing = await this.templateOrThrow(id);
    await this.access.requireOrganizationRecord(
      actor,
      'performance.template.manage',
      existing.organizationId,
      'Template not found.',
    );
    const replacesContent =
      input.sections !== undefined || input.scoringMode !== undefined;
    return this.prisma.$transaction(async (tx) => {
      await lockTemplate(tx, id);
      const current = await tx.performanceTemplate.findUniqueOrThrow({
        where: { id },
      });
      if (current.status === 'ARCHIVED') {
        throw conflict(
          'PERFORMANCE_TEMPLATE_ARCHIVED',
          'An archived template cannot be edited.',
        );
      }
      if (replacesContent && current.status !== 'DRAFT') {
        throw conflict(
          'PERFORMANCE_TEMPLATE_ACTIVE',
          'An active template never changes; copy it into a new version.',
        );
      }
      if (replacesContent) {
        if (!input.sections || !input.scoringMode) {
          throw invalid(
            'PERFORMANCE_TEMPLATE_CONTENT_INVALID',
            'Template content is replaced whole: scoringMode and sections are both required.',
          );
        }
        const content = await this.parseContent(
          tx,
          current.organizationId,
          input as TemplateContentInput,
          false,
        );
        await tx.performanceTemplateItem.deleteMany({
          where: { templateId: id },
        });
        await tx.performanceTemplateSection.deleteMany({
          where: { templateId: id },
        });
        await tx.performanceTemplate.update({
          where: { id },
          data: {
            scoringMode: content.scoringMode,
            ratingScaleId: content.ratingScaleId,
            overallRatingEnabled: content.overallRatingEnabled,
          },
        });
        await this.writeContent(
          tx,
          id,
          current.organizationId,
          content.sections,
        );
      }
      await tx.performanceTemplate.update({
        where: { id },
        data: {
          ...(input.name !== undefined
            ? {
                name: parseText(input.name, 'name', {
                  required: true,
                  max: 120,
                })!,
              }
            : {}),
          ...(input.description !== undefined
            ? {
                description: parseText(input.description, 'description', {
                  max: 2000,
                }),
              }
            : {}),
        },
      });
      await this.auditWrite(
        tx,
        'PERFORMANCE_TEMPLATE_UPDATED',
        'PerformanceTemplate',
        id,
        context,
        {
          organizationId: current.organizationId,
          contentReplaced: replacesContent,
        },
      );
      return this.templateDetail(
        await tx.performanceTemplate.findUniqueOrThrow({
          where: { id },
          include: TEMPLATE_INCLUDE,
        }),
        true,
      );
    });
  }

  /** Activation validates the whole template (structure, scales, competencies, weights). */
  async transitionTemplate(
    id: string,
    to: 'ACTIVE' | 'ARCHIVED',
    context: PerformanceRequestContext,
  ) {
    const actor = requireActor(context);
    const existing = await this.templateOrThrow(id);
    await this.access.requireOrganizationRecord(
      actor,
      'performance.template.manage',
      existing.organizationId,
      'Template not found.',
    );
    return this.prisma.$transaction(async (tx) => {
      await lockTemplate(tx, id);
      const current = await tx.performanceTemplate.findUniqueOrThrow({
        where: { id },
        include: TEMPLATE_INCLUDE,
      });
      if (current.status !== to) {
        if (to === 'ACTIVE') {
          if (current.status !== 'DRAFT') {
            throw conflict(
              'PERFORMANCE_STATUS_INVALID',
              'Only a draft template can be activated.',
            );
          }
          await this.parseContent(
            tx,
            current.organizationId,
            this.contentOf(current),
            true,
          );
        }
        await tx.performanceTemplate.update({
          where: { id },
          data:
            to === 'ACTIVE'
              ? { status: 'ACTIVE', activatedAt: new Date() }
              : { status: 'ARCHIVED', archivedAt: new Date() },
        });
        await this.auditWrite(
          tx,
          to === 'ACTIVE'
            ? 'PERFORMANCE_TEMPLATE_ACTIVATED'
            : 'PERFORMANCE_TEMPLATE_ARCHIVED',
          'PerformanceTemplate',
          id,
          context,
          { organizationId: current.organizationId, from: current.status, to },
        );
      }
      return this.templateDetail(
        await tx.performanceTemplate.findUniqueOrThrow({
          where: { id },
          include: TEMPLATE_INCLUDE,
        }),
        true,
      );
    });
  }

  /** A new draft version with the same content (the way to change an active template). */
  async copyTemplate(
    id: string,
    input: { code: string; name?: string },
    context: PerformanceRequestContext,
  ) {
    const actor = requireActor(context);
    const source = await this.prisma.performanceTemplate.findUnique({
      where: { id },
      include: TEMPLATE_INCLUDE,
    });
    if (!source) throw new NotFoundException('Template not found.');
    await this.access.requireOrganizationRecord(
      actor,
      'performance.template.manage',
      source.organizationId,
      'Template not found.',
    );
    const copy = await this.createTemplate(
      {
        organizationId: source.organizationId,
        code: input.code,
        name: input.name ?? source.name,
        description: source.description,
        ...this.contentOf(source),
      },
      context,
    );
    return copy;
  }

  // ─── Content ──────────────────────────────────────────────────────────────

  private contentOf(row: TemplateRow): TemplateContentInput {
    return {
      scoringMode: row.scoringMode,
      ratingScaleId: row.ratingScaleId,
      overallRatingEnabled: row.overallRatingEnabled,
      sections: row.sections.map((section) => ({
        title: section.title,
        description: section.description,
        items: section.items.map((item) => ({
          itemType: item.itemType,
          prompt: item.prompt,
          helpText: item.helpText,
          respondent: item.respondent,
          required: item.required,
          weight: item.weight?.toFixed(2) ?? null,
          competencyId: item.competencyId,
          ratingScaleId: item.ratingScaleId,
          scaleMin: item.scaleMin,
          scaleMax: item.scaleMax,
        })),
      })),
    };
  }

  /**
   * Validates template content. Drafts may reference draft scales; activation (strict)
   * requires active scales, non-archived competencies, at least one item per section and the
   * scoring rules (weights total 100 over reviewer ratings on the template's scale).
   */
  private async parseContent(
    tx: Prisma.TransactionClient,
    organizationId: string,
    input: TemplateContentInput,
    strict: boolean,
  ) {
    const scoringMode = input.scoringMode;
    const overallRatingEnabled = input.overallRatingEnabled ?? false;
    const ratingScaleId = input.ratingScaleId ?? null;
    if ((scoringMode !== 'NONE' || overallRatingEnabled) && !ratingScaleId) {
      throw invalid(
        'PERFORMANCE_TEMPLATE_SCALE_REQUIRED',
        'Scored templates and overall ratings need the template rating scale.',
      );
    }
    if (input.sections.length === 0 && strict) {
      throw invalid(
        'PERFORMANCE_TEMPLATE_CONTENT_INVALID',
        'A template needs at least one section.',
      );
    }
    const scaleIds = new Set<string>(ratingScaleId ? [ratingScaleId] : []);
    const competencyIds = new Set<string>();
    const sections = input.sections.map((section, sectionIndex) => {
      if (strict && section.items.length === 0) {
        throw invalid(
          'PERFORMANCE_TEMPLATE_CONTENT_INVALID',
          'Every section needs at least one item.',
          {
            section: sectionIndex + 1,
          },
        );
      }
      return {
        title: parseText(section.title, 'Section title', {
          required: true,
          max: 200,
        })!,
        description: parseText(section.description, 'Section description', {
          max: 2000,
        }),
        items: section.items.map((item) => {
          const parsed = {
            itemType: item.itemType,
            prompt: parseText(item.prompt, 'Item prompt', {
              required: true,
              max: 1000,
            })!,
            helpText: parseText(item.helpText, 'Help text', { max: 2000 }),
            respondent: item.respondent,
            required: item.required ?? false,
            weight: item.weight ?? null,
            competencyId:
              item.itemType === 'RATING' ? (item.competencyId ?? null) : null,
            ratingScaleId:
              item.itemType === 'RATING'
                ? (item.ratingScaleId ?? ratingScaleId)
                : null,
            scaleMin:
              item.itemType === 'SCALE' ? (item.scaleMin ?? null) : null,
            scaleMax:
              item.itemType === 'SCALE' ? (item.scaleMax ?? null) : null,
          };
          if (
            item.itemType !== 'RATING' &&
            (item.competencyId || item.ratingScaleId)
          ) {
            throw invalid(
              'PERFORMANCE_TEMPLATE_ITEM_INVALID',
              'Only rating items reference a competency or a rating scale.',
            );
          }
          if (parsed.itemType === 'RATING' && !parsed.ratingScaleId) {
            throw invalid(
              'PERFORMANCE_TEMPLATE_ITEM_INVALID',
              'A rating item needs a rating scale.',
            );
          }
          if (
            parsed.itemType === 'SCALE' &&
            (parsed.scaleMin === null ||
              parsed.scaleMax === null ||
              !Number.isInteger(parsed.scaleMin) ||
              !Number.isInteger(parsed.scaleMax) ||
              parsed.scaleMin >= parsed.scaleMax)
          ) {
            throw invalid(
              'PERFORMANCE_TEMPLATE_ITEM_INVALID',
              'A scale item needs whole scaleMin < scaleMax.',
            );
          }
          if (parsed.ratingScaleId) scaleIds.add(parsed.ratingScaleId);
          if (parsed.competencyId) competencyIds.add(parsed.competencyId);
          return parsed;
        }),
      };
    });
    const items = sections.flatMap((section) => section.items);
    assertTemplateWeights(
      scoringMode,
      items.map((item, index) => ({ ...item, id: String(index) })),
    );
    if (
      scoringMode === 'WEIGHTED_AVERAGE' &&
      items.some(
        (item) =>
          item.itemType === 'RATING' &&
          item.respondent !== 'SELF' &&
          item.ratingScaleId !== ratingScaleId,
      )
    ) {
      throw invalid(
        'PERFORMANCE_WEIGHTS_INVALID',
        'Weighted rating items use the template rating scale.',
      );
    }
    const scales = await tx.performanceRatingScale.findMany({
      where: { id: { in: [...scaleIds] }, organizationId },
      select: { id: true, status: true },
    });
    if (scales.length !== scaleIds.size) {
      throw invalid(
        'PERFORMANCE_SCALE_NOT_FOUND',
        'A rating scale is not in this organization.',
      );
    }
    if (
      scales.some(
        (scale) =>
          scale.status === 'ARCHIVED' || (strict && scale.status !== 'ACTIVE'),
      )
    ) {
      throw conflict(
        'PERFORMANCE_SCALE_NOT_ACTIVE',
        strict
          ? 'Activate every rating scale the template uses first.'
          : 'An archived rating scale cannot be used.',
      );
    }
    const competencies = await tx.performanceCompetency.findMany({
      where: { id: { in: [...competencyIds] }, organizationId },
      select: { id: true, archivedAt: true },
    });
    if (competencies.length !== competencyIds.size) {
      throw invalid(
        'PERFORMANCE_COMPETENCY_NOT_FOUND',
        'A competency is not in this organization.',
      );
    }
    if (competencies.some((competency) => competency.archivedAt)) {
      throw conflict(
        'PERFORMANCE_COMPETENCY_ARCHIVED',
        'An archived competency cannot be used.',
      );
    }
    return { scoringMode, ratingScaleId, overallRatingEnabled, sections };
  }

  private async writeContent(
    tx: Prisma.TransactionClient,
    templateId: string,
    organizationId: string,
    sections: Awaited<
      ReturnType<PerformanceConfigService['parseContent']>
    >['sections'],
  ) {
    for (const [sectionIndex, section] of sections.entries()) {
      const row = await tx.performanceTemplateSection.create({
        data: {
          templateId,
          title: section.title,
          description: section.description,
          sortOrder: sectionIndex + 1,
        },
      });
      for (const [itemIndex, item] of section.items.entries()) {
        await tx.performanceTemplateItem.create({
          data: {
            ...item,
            templateId,
            organizationId,
            sectionId: row.id,
            sortOrder: itemIndex + 1,
          },
        });
      }
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  /** Codes are unique per organization (checked first; the unique index backs it up). */
  private async assertCodeFree(
    tx: Prisma.TransactionClient,
    kind: 'competency' | 'scale' | 'template',
    organizationId: string,
    code: string,
  ) {
    const where = { organizationId_code: { organizationId, code } };
    const taken =
      kind === 'competency'
        ? await tx.performanceCompetency.findUnique({
            where,
            select: { id: true },
          })
        : kind === 'scale'
          ? await tx.performanceRatingScale.findUnique({
              where,
              select: { id: true },
            })
          : await tx.performanceTemplate.findUnique({
              where,
              select: { id: true },
            });
    if (taken) {
      throw conflict(
        'PERFORMANCE_CODE_EXISTS',
        `A ${kind} with code ${code} already exists.`,
      );
    }
  }

  /**
   * Batch 7B (S9/D6): a scale or competency an ACTIVE template uses cannot be archived (a cycle
   * opened later would snapshot it). The refusal names those templates — organization-level
   * configuration the caller manages (performance.template.manage at the organization).
   */
  private async refuseIfUsedByActiveTemplate(
    tx: Prisma.TransactionClient,
    organizationId: string,
    used: { competencyId?: string; ratingScaleId?: string },
  ) {
    const templates = await tx.performanceTemplate.findMany({
      where: {
        organizationId,
        status: 'ACTIVE',
        OR: [
          ...(used.ratingScaleId
            ? [{ ratingScaleId: used.ratingScaleId }]
            : []),
          {
            items: {
              some: used.competencyId
                ? { competencyId: used.competencyId }
                : { ratingScaleId: used.ratingScaleId },
            },
          },
        ],
      },
      select: { id: true, code: true, name: true },
      orderBy: [{ code: 'asc' }],
    });
    if (templates.length > 0) {
      throw conflict(
        'PERFORMANCE_CONFIG_IN_USE',
        `Active templates use it: ${templates.map((t) => t.code).join(', ')}. Archive or replace those templates first.`,
        { templates },
      );
    }
  }

  private async competencyOrThrow(id: string) {
    const row = await this.prisma.performanceCompetency.findUnique({
      where: { id },
    });
    if (!row) throw new NotFoundException('Competency not found.');
    return row;
  }

  private async scaleOrThrow(id: string) {
    const row = await this.prisma.performanceRatingScale.findUnique({
      where: { id },
    });
    if (!row) throw new NotFoundException('Rating scale not found.');
    return row;
  }

  private async templateOrThrow(id: string) {
    const row = await this.prisma.performanceTemplate.findUnique({
      where: { id },
    });
    if (!row) throw new NotFoundException('Template not found.');
    return row;
  }

  private competencyShape(row: {
    id: string;
    organizationId: string;
    code: string;
    name: string;
    description: string | null;
    category: string | null;
    archivedAt: Date | null;
  }) {
    return {
      id: row.id,
      organizationId: row.organizationId,
      code: row.code,
      name: row.name,
      description: row.description,
      category: row.category,
      archived: row.archivedAt !== null,
    };
  }

  private scaleShape(row: {
    id: string;
    organizationId: string;
    code: string;
    name: string;
    description: string | null;
    status: string;
    levels: Array<{ value: number; label: string; description: string | null }>;
  }) {
    return {
      id: row.id,
      organizationId: row.organizationId,
      code: row.code,
      name: row.name,
      description: row.description,
      status: row.status,
      levels: row.levels.map((level) => ({
        value: level.value,
        label: level.label,
        description: level.description,
      })),
    };
  }

  private templateHeader(row: {
    id: string;
    organizationId: string;
    code: string;
    name: string;
    description: string | null;
    status: string;
    scoringMode: string;
    ratingScaleId: string | null;
    overallRatingEnabled: boolean;
  }) {
    return {
      id: row.id,
      organizationId: row.organizationId,
      code: row.code,
      name: row.name,
      description: row.description,
      status: row.status,
      scoringMode: row.scoringMode,
      ratingScaleId: row.ratingScaleId,
      overallRatingEnabled: row.overallRatingEnabled,
    };
  }

  private templateDetail(row: TemplateRow, canManage: boolean) {
    return {
      ...this.templateHeader(row),
      ratingScale: row.ratingScale ? this.scaleShape(row.ratingScale) : null,
      sections: row.sections.map((section) => ({
        id: section.id,
        title: section.title,
        description: section.description,
        sortOrder: section.sortOrder,
        items: section.items.map((item) => ({
          id: item.id,
          sortOrder: item.sortOrder,
          itemType: item.itemType,
          prompt: item.prompt,
          helpText: item.helpText,
          respondent: item.respondent,
          required: item.required,
          weight: item.weight?.toFixed(2) ?? null,
          competency: item.competency
            ? {
                id: item.competency.id,
                code: item.competency.code,
                name: item.competency.name,
                archived: item.competency.archivedAt !== null,
              }
            : null,
          ratingScale: item.ratingScale,
          scaleMin: item.scaleMin,
          scaleMax: item.scaleMax,
        })),
      })),
      actions: {
        canEdit: canManage && row.status === 'DRAFT',
        canActivate: canManage && row.status === 'DRAFT',
        canArchive: canManage && row.status !== 'ARCHIVED',
        canCopy: canManage,
      },
    };
  }

  private auditWrite(
    tx: Prisma.TransactionClient,
    action: string,
    entityType: string,
    entityId: string,
    context: PerformanceRequestContext,
    metadata: Record<string, unknown>,
  ) {
    return writePerformanceAudit(this.audit, tx, {
      action,
      entityType,
      entityId,
      context,
      metadata,
    });
  }
}

type TemplateRow = Prisma.PerformanceTemplateGetPayload<{
  include: typeof TEMPLATE_INCLUDE;
}>;
