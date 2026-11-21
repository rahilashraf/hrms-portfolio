import { Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { advisoryLock, requireActor } from '../common/domain-support.js';
import { PrismaService } from '../database/prisma.service.js';
import type {
  RecruitmentStage,
  RecruitmentStageKind,
} from '../generated/prisma/client.js';
import { RecruitmentAccessService } from './recruitment-access.service.js';
import {
  conflict,
  isUniqueViolation,
  RecruitmentClock,
  writeRecruitmentAudit,
  type RecruitmentRequestContext,
  type Tx,
} from './recruitment-common.js';
import {
  DEFAULT_STAGES,
  invalid,
  parseRecruitmentCode,
  parseText,
} from './recruitment-domain.js';

export function stageShape(stage: RecruitmentStage) {
  return {
    id: stage.id,
    code: stage.code,
    name: stage.name,
    kind: stage.kind,
    sortOrder: stage.sortOrder,
    archivedAt: stage.archivedAt?.toISOString() ?? null,
  };
}

/**
 * Phase 13 — an organization's ordered hiring stages (recruitment.pipeline.manage). Stage
 * names are snapshotted onto stage history, so renaming or archiving never rewrites history;
 * a stage holding live applications cannot be archived. The HIRED stage is entered only by
 * hire conversion.
 */
@Injectable()
export class RecruitmentStageService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: RecruitmentAccessService,
    private readonly audit: AuditService,
    private readonly clock: RecruitmentClock,
  ) {}

  async list(userId: string, organizationId: string, includeArchived = false) {
    await this.access.requireConfigurationRead(userId, organizationId);
    const rows = await this.prisma.recruitmentStage.findMany({
      where: {
        organizationId,
        ...(includeArchived ? {} : { archivedAt: null }),
      },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    });
    return { items: rows.map(stageShape) };
  }

  /** Creates the default pipeline when the organization has no stages yet (idempotent). */
  async ensureDefaults(tx: Tx, organizationId: string, actorUserId?: string) {
    await advisoryLock(tx, `recruitment-stages:${organizationId}`);
    if ((await tx.recruitmentStage.count({ where: { organizationId } })) > 0)
      return false;
    for (const [index, stage] of DEFAULT_STAGES.entries()) {
      await tx.recruitmentStage.create({
        data: {
          organizationId,
          code: stage.code,
          name: stage.name,
          kind: stage.kind,
          sortOrder: (index + 1) * 10,
          createdByUserId: actorUserId ?? null,
        },
      });
    }
    return true;
  }

  async initializeDefaults(
    organizationId: string,
    context: RecruitmentRequestContext,
  ) {
    const actor = requireActor(context);
    await this.access.requireOrganization(
      actor,
      'recruitment.pipeline.manage',
      organizationId,
    );
    return this.prisma.$transaction(async (tx) => {
      const created = await this.ensureDefaults(tx, organizationId, actor);
      if (created) {
        await writeRecruitmentAudit(this.audit, tx, {
          action: 'RECRUITMENT_STAGES_INITIALIZED',
          entityType: 'Organization',
          entityId: organizationId,
          context,
          metadata: { organizationId, stages: DEFAULT_STAGES.length },
        });
      }
      const rows = await tx.recruitmentStage.findMany({
        where: { organizationId, archivedAt: null },
        orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      });
      return { created, items: rows.map(stageShape) };
    });
  }

  async create(
    input: {
      organizationId: string;
      code: string;
      name: string;
      kind: RecruitmentStageKind;
      sortOrder?: number;
    },
    context: RecruitmentRequestContext,
  ) {
    const actor = requireActor(context);
    await this.access.requireOrganization(
      actor,
      'recruitment.pipeline.manage',
      input.organizationId,
    );
    const code = parseRecruitmentCode(input.code);
    const name = parseText(input.name, 'name', { required: true, max: 120 })!;
    if (input.kind === 'HIRED') {
      const hired = await this.prisma.recruitmentStage.count({
        where: {
          organizationId: input.organizationId,
          kind: 'HIRED',
          archivedAt: null,
        },
      });
      if (hired > 0) {
        throw conflict(
          'RECRUITMENT_STAGE_HIRED_EXISTS',
          'The organization already has a Hired stage.',
        );
      }
    }
    try {
      return await this.prisma.$transaction(async (tx) => {
        if (
          await tx.recruitmentStage.findUnique({
            where: {
              organizationId_code: {
                organizationId: input.organizationId,
                code,
              },
            },
            select: { id: true },
          })
        ) {
          throw conflict(
            'RECRUITMENT_STAGE_EXISTS',
            `A stage with code ${code} already exists.`,
          );
        }
        const last = await tx.recruitmentStage.aggregate({
          where: { organizationId: input.organizationId },
          _max: { sortOrder: true },
        });
        const row = await tx.recruitmentStage.create({
          data: {
            organizationId: input.organizationId,
            code,
            name,
            kind: input.kind,
            sortOrder: input.sortOrder ?? (last._max.sortOrder ?? 0) + 10,
            createdByUserId: actor,
          },
        });
        await writeRecruitmentAudit(this.audit, tx, {
          action: 'RECRUITMENT_STAGE_CREATED',
          entityType: 'RecruitmentStage',
          entityId: row.id,
          context,
          metadata: {
            organizationId: row.organizationId,
            code,
            kind: row.kind,
          },
        });
        return stageShape(row);
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw conflict(
          'RECRUITMENT_STAGE_EXISTS',
          `A stage with code ${code} already exists.`,
        );
      }
      throw error;
    }
  }

  async update(
    stageId: string,
    input: { name?: string; sortOrder?: number },
    context: RecruitmentRequestContext,
  ) {
    const actor = requireActor(context);
    const stage = await this.stageOrThrow(stageId);
    await this.access.requireOrganizationRecord(
      actor,
      'recruitment.pipeline.manage',
      stage.organizationId,
      'Stage not found.',
    );
    if (stage.archivedAt)
      throw conflict('RECRUITMENT_STAGE_ARCHIVED', 'The stage is archived.');
    if (
      input.sortOrder !== undefined &&
      (!Number.isInteger(input.sortOrder) || input.sortOrder < 0)
    ) {
      invalid(
        'RECRUITMENT_STAGE_ORDER_INVALID',
        'sortOrder is a whole number.',
      );
    }
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.recruitmentStage.update({
        where: { id: stageId },
        data: {
          ...(input.name !== undefined
            ? {
                name: parseText(input.name, 'name', {
                  required: true,
                  max: 120,
                })!,
              }
            : {}),
          ...(input.sortOrder !== undefined
            ? { sortOrder: input.sortOrder }
            : {}),
        },
      });
      await writeRecruitmentAudit(this.audit, tx, {
        action: 'RECRUITMENT_STAGE_UPDATED',
        entityType: 'RecruitmentStage',
        entityId: stageId,
        context,
        metadata: {
          organizationId: row.organizationId,
          fields: Object.keys(input).filter(
            (key) => input[key as keyof typeof input] !== undefined,
          ),
        },
      });
      return stageShape(row);
    });
  }

  /** Re-numbers the organization's live stages in the given order. */
  async reorder(
    organizationId: string,
    stageIds: readonly string[],
    context: RecruitmentRequestContext,
  ) {
    const actor = requireActor(context);
    await this.access.requireOrganization(
      actor,
      'recruitment.pipeline.manage',
      organizationId,
    );
    return this.prisma.$transaction(async (tx) => {
      await advisoryLock(tx, `recruitment-stages:${organizationId}`);
      const live = await tx.recruitmentStage.findMany({
        where: { organizationId, archivedAt: null },
      });
      const ids = new Set(live.map((stage) => stage.id));
      if (
        stageIds.length !== live.length ||
        new Set(stageIds).size !== stageIds.length ||
        stageIds.some((id) => !ids.has(id))
      ) {
        invalid(
          'RECRUITMENT_STAGE_ORDER_INVALID',
          'Give every live stage of the organization exactly once.',
        );
      }
      for (const [index, id] of stageIds.entries()) {
        await tx.recruitmentStage.update({
          where: { id },
          data: { sortOrder: (index + 1) * 10 },
        });
      }
      await writeRecruitmentAudit(this.audit, tx, {
        action: 'RECRUITMENT_STAGES_REORDERED',
        entityType: 'Organization',
        entityId: organizationId,
        context,
        metadata: { organizationId, stageIds },
      });
      const rows = await tx.recruitmentStage.findMany({
        where: { organizationId, archivedAt: null },
        orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      });
      return { items: rows.map(stageShape) };
    });
  }

  async archive(stageId: string, context: RecruitmentRequestContext) {
    const actor = requireActor(context);
    const stage = await this.stageOrThrow(stageId);
    await this.access.requireOrganizationRecord(
      actor,
      'recruitment.pipeline.manage',
      stage.organizationId,
      'Stage not found.',
    );
    if (stage.archivedAt) return stageShape(stage);
    return this.prisma.$transaction(async (tx) => {
      await advisoryLock(tx, `recruitment-stages:${stage.organizationId}`);
      const live = await tx.recruitmentApplication.count({
        where: { stageId, status: { in: ['ACTIVE', 'OFFERED'] } },
      });
      if (live > 0) {
        throw conflict(
          'RECRUITMENT_STAGE_IN_USE',
          `${live} live application(s) are in this stage; move them first.`,
          { applications: live },
        );
      }
      const remaining = await tx.recruitmentStage.count({
        where: {
          organizationId: stage.organizationId,
          archivedAt: null,
          id: { not: stageId },
        },
      });
      if (remaining === 0) {
        throw conflict(
          'RECRUITMENT_STAGE_LAST',
          'The pipeline needs at least one stage.',
        );
      }
      const row = await tx.recruitmentStage.update({
        where: { id: stageId },
        data: { archivedAt: this.clock.now() },
      });
      await writeRecruitmentAudit(this.audit, tx, {
        action: 'RECRUITMENT_STAGE_ARCHIVED',
        entityType: 'RecruitmentStage',
        entityId: stageId,
        context,
        metadata: { organizationId: row.organizationId, code: row.code },
      });
      return stageShape(row);
    });
  }

  private async stageOrThrow(stageId: string) {
    const stage = await this.prisma.recruitmentStage.findUnique({
      where: { id: stageId },
    });
    if (!stage) throw new NotFoundException('Stage not found.');
    return stage;
  }
}
