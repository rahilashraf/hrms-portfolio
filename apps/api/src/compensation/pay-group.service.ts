import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import {
  domainError,
  jsonValue,
  requireActor,
  type DomainRequestContext,
} from '../common/domain-support.js';
import { PrismaService } from '../database/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import type { PayGroup } from '../generated/prisma/client.js';
import { CompensationAccessService } from './compensation-access.service.js';
import type {
  CreatePayGroupDto,
  PayGroupListQueryDto,
  UpdatePayGroupDto,
} from './compensation.dto.js';

/**
 * Phase 9 — minimal pay groups: an organization's named payroll groupings that compensation
 * records point to, ahead of Phase 10 Payroll. Code and organization are fixed once created;
 * archiving keeps history intact (existing records keep their group).
 */
@Injectable()
export class PayGroupService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: CompensationAccessService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Organizations in which the user holds any compensation permission (for the pay-group admin),
   * each with whether they may manage its pay groups (compensation.manage at the organization).
   */
  async organizations(userId: string) {
    const grants = await this.access.grants(userId);
    if (grants.length === 0) return { items: [] };
    const system = grants.some((g) => g.scope.type === 'SYSTEM');
    const ids = (type: string) => [
      ...new Set(
        grants
          .filter((g) => g.scope.type === type)
          .map((g) => g.scope.id!)
          .filter(Boolean),
      ),
    ];
    const [units, departments, teams] = await Promise.all([
      this.prisma.organizationalUnit.findMany({
        where: { id: { in: ids('ORGANIZATIONAL_UNIT') } },
        select: { organizationId: true },
      }),
      this.prisma.department.findMany({
        where: { id: { in: ids('DEPARTMENT') } },
        select: { organizationId: true },
      }),
      this.prisma.team.findMany({
        where: { id: { in: ids('TEAM') } },
        select: { organizationId: true },
      }),
    ]);
    const organizationIds = new Set([
      ...ids('ORGANIZATION'),
      ...[...units, ...departments, ...teams].map((r) => r.organizationId),
    ]);
    const disabled = await this.access.disabledOrganizations();
    const rows = await this.prisma.organization.findMany({
      where: {
        archivedAt: null,
        AND: [{ id: { notIn: disabled } }],
        ...(system ? {} : { id: { in: [...organizationIds] } }),
      },
      select: { id: true, name: true, code: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
    return {
      items: rows.map((row) => ({
        ...row,
        canManagePayGroups: this.access.can(grants, 'compensation.manage', {
          type: 'ORGANIZATION',
          organizationId: row.id,
        }),
      })),
    };
  }

  async list(userId: string, query: PayGroupListQueryDto) {
    if (
      !(await this.access.hasAnyInOrganization(userId, query.organizationId))
    ) {
      throw new ForbiddenException(
        'Missing compensation permission in the organization.',
      );
    }
    await this.access.requireEnabled(query.organizationId);
    const grants = await this.access.grants(userId);
    const canManage = this.access.can(grants, 'compensation.manage', {
      type: 'ORGANIZATION',
      organizationId: query.organizationId,
    });
    const rows = await this.prisma.payGroup.findMany({
      where: {
        organizationId: query.organizationId,
        ...(query.includeArchived ? {} : { archivedAt: null }),
      },
      orderBy: [{ name: 'asc' }, { code: 'asc' }],
    });
    return {
      items: rows.map((row) => ({
        ...this.shape(row),
        actions: {
          canEdit: canManage && !row.archivedAt,
          canArchive: canManage && !row.archivedAt,
        },
      })),
    };
  }

  async create(input: CreatePayGroupDto, context: DomainRequestContext) {
    const actor = requireActor(context);
    const code = input.code.trim().replace(/\s+/g, '-').toUpperCase();
    if (!/^[A-Z0-9_-]{2,64}$/.test(code)) {
      throw new BadRequestException(
        'code must be 2–64 letters, digits, "-" or "_".',
      );
    }
    const name = input.name.trim();
    if (!name) throw new BadRequestException('name is required.');
    return this.prisma.$transaction(async (tx) => {
      await this.access.requireOrganizationManage(
        actor,
        input.organizationId,
        tx,
      );
      const organization = await tx.organization.findUnique({
        where: { id: input.organizationId },
        select: { id: true },
      });
      if (!organization) throw new NotFoundException('Organization not found');
      try {
        const created = await tx.payGroup.create({
          data: {
            organizationId: input.organizationId,
            code,
            name,
            description: input.description?.trim() || null,
          },
        });
        await this.writeAudit(tx, 'PAY_GROUP_CREATED', created.id, context, {
          after: this.shape(created),
        });
        return this.shape(created);
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002'
        ) {
          throw new ConflictException(
            domainError(
              409,
              'PAY_GROUP_CODE_TAKEN',
              'A pay group with this code already exists.',
            ),
          );
        }
        throw error;
      }
    });
  }

  async update(
    payGroupId: string,
    input: UpdatePayGroupDto,
    context: DomainRequestContext,
  ) {
    const actor = requireActor(context);
    return this.prisma.$transaction(async (tx) => {
      const current = await this.locked(tx, actor, payGroupId);
      if (current.archivedAt)
        throw new ConflictException('An archived pay group cannot be edited.');
      const data: Prisma.PayGroupUpdateInput = {};
      if (input.name !== undefined) {
        if (!input.name.trim())
          throw new BadRequestException('name is required.');
        data.name = input.name.trim();
      }
      if (input.description !== undefined)
        data.description = input.description.trim() || null;
      if (Object.keys(data).length === 0) return this.shape(current);
      const updated = await tx.payGroup.update({
        where: { id: payGroupId },
        data,
      });
      await this.writeAudit(tx, 'PAY_GROUP_UPDATED', payGroupId, context, {
        before: this.shape(current),
        after: this.shape(updated),
      });
      return this.shape(updated);
    });
  }

  async archive(payGroupId: string, context: DomainRequestContext) {
    const actor = requireActor(context);
    return this.prisma.$transaction(async (tx) => {
      const current = await this.locked(tx, actor, payGroupId);
      if (current.archivedAt) return this.shape(current);
      const archived = await tx.payGroup.update({
        where: { id: payGroupId },
        data: { archivedAt: new Date() },
      });
      await this.writeAudit(tx, 'PAY_GROUP_ARCHIVED', payGroupId, context, {
        payGroup: this.shape(archived),
      });
      return this.shape(archived);
    });
  }

  shape(row: PayGroup) {
    return {
      id: row.id,
      organizationId: row.organizationId,
      code: row.code,
      name: row.name,
      description: row.description,
      archivedAt: row.archivedAt?.toISOString() ?? null,
    };
  }

  private async locked(
    tx: Prisma.TransactionClient,
    actor: string,
    payGroupId: string,
  ) {
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "PayGroup" WHERE "id" = ${payGroupId}::uuid FOR UPDATE`,
    );
    const current = await tx.payGroup.findUnique({ where: { id: payGroupId } });
    if (!current) throw new NotFoundException('Pay group not found');
    await this.access.requireOrganizationManage(
      actor,
      current.organizationId,
      tx,
    );
    return current;
  }

  private writeAudit(
    tx: Prisma.TransactionClient,
    action: string,
    entityId: string,
    context: DomainRequestContext,
    metadata: Record<string, unknown>,
  ) {
    return this.audit.write(
      {
        action,
        actorUserId: context.actorUserId,
        entityType: 'PayGroup',
        entityId,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
        correlationId: context.correlationId,
        metadata: jsonValue(metadata),
      },
      tx,
    );
  }
}
