import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { advisoryLock, domainError } from '../common/domain-support.js';
import { lockPositions } from '../employee/employee-lifecycle-support.js';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../database/prisma.service.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import type { AuthorizationScope } from '../authorization/authorization.types.js';
import { OrganizationArchivePolicyService } from './organization-archive-policy.service.js';
import {
  normalizeCodeValue,
  type DepartmentCreateDto,
  type DepartmentUpdateDto,
  type JobTitleCreateDto,
  type JobTitleUpdateDto,
  type OrganizationCreateDto,
  type OrganizationUpdateDto,
  type OrganizationalUnitCreateDto,
  type OrganizationalUnitUpdateDto,
  type PositionCreateDto,
  type PositionUpdateDto,
  type TeamCreateDto,
  type TeamUpdateDto,
  type WorkLocationCreateDto,
  type WorkLocationUpdateDto,
} from './organization.dto.js';
import { OrganizationIntegrityService } from './organization-integrity.service.js';
import { PhysicalSiteService } from './physical-site.service.js';

export interface RequestAuditContext {
  actorUserId?: string;
  ipAddress?: string;
  userAgent?: string;
  correlationId?: string;
}

type StructureRow = {
  id: string;
  name: string;
  code: string;
  parentUnitId: string | null;
  sortOrder: number;
  archivedAt: Date | null;
};

type StructureNode = StructureRow & {
  children: StructureNode[];
};

@Injectable()
export class OrganizationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly integrity: OrganizationIntegrityService,
    private readonly archivePolicy: OrganizationArchivePolicyService,
    private readonly authorization: AuthorizationService,
    @Optional() physicalSites?: PhysicalSiteService,
  ) {
    this.physicalSites =
      physicalSites ?? new PhysicalSiteService(prisma, authorization, audit);
  }

  private readonly physicalSites: PhysicalSiteService;

  async createOrganization(
    input: OrganizationCreateDto,
    context: RequestAuditContext = {},
  ) {
    await this.assertManage(context, { type: 'SYSTEM' });
    const code = this.normalizedCode(input.code);
    this.assertCodeValue(code, 'Organization code');
    await this.assertNoExistingOrganizationCode(code);

    const payload = {
      name: input.name.trim(),
      code,
      description: input.description?.trim() || null,
      sortOrder: Number(input.sortOrder ?? 0),
      timezone: input.timezone?.trim() || null,
    };

    return this.prisma.$transaction(async (tx) => {
      const entity = await tx.organization.create({ data: payload });
      await this.writeAudit(
        tx,
        'ORG_CREATED',
        'Organization',
        entity.id,
        context,
        {
          before: null,
          after: entity,
        },
      );
      return entity;
    });
  }

  async listOrganizations(includeArchived = false) {
    return this.prisma.organization.findMany({
      where: includeArchived ? {} : { archivedAt: null },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }, { code: 'asc' }],
    });
  }

  async getOrganization(id: string, includeArchived = false) {
    const entity = await this.prisma.organization.findUnique({ where: { id } });
    if (!entity) throw new NotFoundException('Organization not found');
    if (!includeArchived && entity.archivedAt) {
      throw new NotFoundException('Organization not found');
    }
    return entity;
  }

  async updateOrganization(
    id: string,
    input: OrganizationUpdateDto,
    context: RequestAuditContext = {},
  ) {
    const current = await this.requireOrganization(id, false);
    await this.assertManage(context, { type: 'ORGANIZATION', id });
    const before = { ...current };
    const updates: Record<string, unknown> = {};

    if (typeof input.name === 'string') {
      updates.name = input.name.trim();
    }
    if (typeof input.description === 'string') {
      updates.description = input.description.trim() || null;
    }
    if (typeof input.sortOrder === 'number') {
      updates.sortOrder = Number(input.sortOrder);
    }
    if (typeof input.timezone === 'string') {
      updates.timezone = input.timezone.trim();
    }

    if (Object.keys(updates).length === 0) {
      return current;
    }

    const updated = await this.structureTx(id, async (tx) => {
      const next = await tx.organization.update({
        where: { id },
        data: updates,
      });
      await this.writeAudit(tx, 'ORG_UPDATED', 'Organization', id, context, {
        before,
        after: next,
        changedFields: Object.keys(updates),
      });
      return next;
    });

    return updated;
  }

  async archiveOrganization(id: string, context: RequestAuditContext = {}) {
    const organization = await this.requireOrganization(id, true);
    await this.assertManage(context, { type: 'ORGANIZATION', id });
    if (organization.archivedAt) {
      return { success: true };
    }

    const archived = await this.structureTx(id, async (tx) => {
      if (await this.archivePolicy.hasActiveOrganizationChildren(tx, id)) {
        throw new BadRequestException(
          'Organization cannot be archived while active structural records remain.',
        );
      }
      const result = await tx.organization.update({
        where: { id },
        data: { archivedAt: new Date() },
      });
      await this.writeAudit(tx, 'ORG_ARCHIVED', 'Organization', id, context, {
        before: organization,
        after: result,
      });
      return result;
    });

    return { success: true, organization: archived };
  }

  async reactivateOrganization(id: string, context: RequestAuditContext = {}) {
    const organization = await this.requireOrganization(id, true);
    await this.assertManage(context, { type: 'ORGANIZATION', id });
    if (!organization.archivedAt) {
      return { success: true };
    }

    const reactivated = await this.structureTx(id, async (tx) => {
      const result = await tx.organization.update({
        where: { id },
        data: { archivedAt: null },
      });
      await this.writeAudit(
        tx,
        'ORG_REACTIVATED',
        'Organization',
        id,
        context,
        {
          before: organization,
          after: result,
        },
      );
      return result;
    });

    return { success: true, organization: reactivated };
  }

  async createOrganizationalUnit(
    organizationId: string,
    input: OrganizationalUnitCreateDto,
    context: RequestAuditContext = {},
  ) {
    await this.requireOrganization(organizationId, false);
    await this.assertManage(
      context,
      this.unitParentScope(organizationId, input.parentUnitId ?? null),
    );
    const code = this.normalizedCode(input.code);
    this.assertCodeValue(code, 'Organizational unit code');
    const uniqueKey = { organizationId, code };
    await this.assertCreateUnique('organizationalUnit', uniqueKey);

    const parentUnitId = input.parentUnitId ?? null;
    if (parentUnitId) {
      await this.integrity.assertActiveParentUnit(
        organizationId,
        parentUnitId,
        null,
      );
      await this.integrity.assertNoCycleForUnit(parentUnitId, null);
    }

    const payload = {
      organizationId,
      parentUnitId,
      name: input.name.trim(),
      code,
      description: input.description?.trim() || null,
      sortOrder: Number(input.sortOrder ?? 0),
    };

    return this.structureTx(organizationId, async (tx) => {
      if (parentUnitId) {
        await this.integrity.assertActiveParentUnit(
          organizationId,
          parentUnitId,
          null,
          tx,
        );
        await this.integrity.assertNoCycleForUnit(parentUnitId, null, tx);
      }
      const entity = await tx.organizationalUnit.create({ data: payload });
      await this.writeAudit(
        tx,
        'ORG_UNIT_CREATED',
        'OrganizationalUnit',
        entity.id,
        context,
        { before: null, after: entity },
      );
      return entity;
    });
  }

  async listOrganizationalUnits(
    organizationId: string,
    includeArchived = false,
  ) {
    await this.requireOrganization(organizationId, true);
    return this.prisma.organizationalUnit.findMany({
      where: {
        organizationId,
        ...(includeArchived ? {} : { archivedAt: null }),
      },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }, { code: 'asc' }],
    });
  }

  async getOrganizationalUnit(
    organizationId: string,
    id: string,
    includeArchived = false,
  ) {
    await this.requireOrganization(organizationId, true);
    const entity = await this.prisma.organizationalUnit.findUnique({
      where: { id },
    });
    if (!entity || entity.organizationId !== organizationId) {
      throw new NotFoundException('Organizational unit not found');
    }
    if (!includeArchived && entity.archivedAt) {
      throw new NotFoundException('Organizational unit not found');
    }
    return entity;
  }

  async updateOrganizationalUnit(
    organizationId: string,
    id: string,
    input: OrganizationalUnitUpdateDto,
    context: RequestAuditContext = {},
  ) {
    await this.requireOrganization(organizationId, false);
    const current = await this.requireOrganizationalUnit(
      organizationId,
      id,
      false,
    );
    await this.assertManage(context, {
      type: 'ORGANIZATIONAL_UNIT',
      id,
      organizationId,
    });
    const before = { ...current };
    const updates: Record<string, unknown> = {};

    if (typeof input.name === 'string') updates.name = input.name.trim();
    if (typeof input.description === 'string')
      updates.description = input.description.trim() || null;
    if (input.parentUnitId !== undefined) {
      const newParentId = input.parentUnitId ?? null;
      if (newParentId === id) {
        throw new BadRequestException('Self-parenting is not allowed.');
      }
      if (newParentId) {
        await this.integrity.assertActiveParentUnit(
          organizationId,
          newParentId,
          id,
        );
        await this.integrity.assertNoCycleForUnit(newParentId, id);
      }
      if (newParentId !== current.parentUnitId) {
        await this.assertManage(
          context,
          this.unitParentScope(organizationId, newParentId),
        );
      }
      updates.parentUnitId = newParentId;
    }
    if (typeof input.sortOrder === 'number')
      updates.sortOrder = Number(input.sortOrder);

    if (Object.keys(updates).length === 0) {
      return current;
    }

    const updated = await this.structureTx(organizationId, async (tx) => {
      if (typeof updates.parentUnitId === 'string') {
        await this.integrity.assertActiveParentUnit(
          organizationId,
          updates.parentUnitId,
          id,
          tx,
        );
        await this.integrity.assertNoCycleForUnit(updates.parentUnitId, id, tx);
      }
      const next = await tx.organizationalUnit.update({
        where: { id },
        data: updates,
      });
      const action = Object.hasOwn(updates, 'parentUnitId')
        ? 'ORG_UNIT_MOVED'
        : 'ORG_UNIT_UPDATED';
      await this.writeAudit(tx, action, 'OrganizationalUnit', id, context, {
        before,
        after: next,
        changedFields: Object.keys(updates),
      });
      return next;
    });

    return updated;
  }

  async archiveOrganizationalUnit(
    organizationId: string,
    id: string,
    context: RequestAuditContext = {},
  ) {
    const current = await this.requireOrganizationalUnit(
      organizationId,
      id,
      true,
    );
    await this.assertManage(context, {
      type: 'ORGANIZATIONAL_UNIT',
      id,
      organizationId,
    });
    if (current.archivedAt) {
      return { success: true };
    }

    const updated = await this.structureTx(organizationId, async (tx) => {
      if (await this.archivePolicy.hasActiveUnitChildren(tx, id)) {
        throw new BadRequestException(
          'Organizational unit cannot be archived while active child records remain.',
        );
      }
      const next = await tx.organizationalUnit.update({
        where: { id },
        data: { archivedAt: new Date() },
      });
      await this.writeAudit(
        tx,
        'ORG_UNIT_ARCHIVED',
        'OrganizationalUnit',
        id,
        context,
        { before: current, after: next },
      );
      return next;
    });

    return { success: true, unit: updated };
  }

  async reactivateOrganizationalUnit(
    organizationId: string,
    id: string,
    context: RequestAuditContext = {},
  ) {
    await this.requireOrganization(organizationId, false);
    const current = await this.requireOrganizationalUnit(
      organizationId,
      id,
      true,
    );
    await this.assertManage(context, {
      type: 'ORGANIZATIONAL_UNIT',
      id,
      organizationId,
    });
    if (!current.archivedAt) {
      return { success: true };
    }
    if (current.parentUnitId) {
      const parent = await this.prisma.organizationalUnit.findUnique({
        where: { id: current.parentUnitId },
      });
      if (
        !parent ||
        parent.archivedAt ||
        parent.organizationId !== organizationId
      ) {
        throw new BadRequestException(
          'Organizational unit cannot be reactivated while its parent is archived or invalid.',
        );
      }
    }

    const updated = await this.structureTx(organizationId, async (tx) => {
      if (current.parentUnitId) {
        await this.integrity.assertActiveParentUnit(
          organizationId,
          current.parentUnitId,
          id,
          tx,
        );
      }
      const next = await tx.organizationalUnit.update({
        where: { id },
        data: { archivedAt: null },
      });
      await this.writeAudit(
        tx,
        'ORG_UNIT_REACTIVATED',
        'OrganizationalUnit',
        id,
        context,
        { before: current, after: next },
      );
      return next;
    });

    return { success: true, unit: updated };
  }

  async createDepartment(
    organizationId: string,
    input: DepartmentCreateDto,
    context: RequestAuditContext = {},
  ) {
    await this.requireOrganization(organizationId, false);
    await this.assertManage(
      context,
      input.organizationalUnitId
        ? {
            type: 'ORGANIZATIONAL_UNIT',
            id: input.organizationalUnitId,
            organizationId,
          }
        : { type: 'ORGANIZATION', id: organizationId },
    );
    const code = this.normalizedCode(input.code);
    this.assertCodeValue(code, 'Department code');
    await this.assertCreateUnique('department', { organizationId, code });

    if (input.organizationalUnitId) {
      const unit = await this.requireOrganizationalUnit(
        organizationId,
        input.organizationalUnitId,
        true,
      );
      if (unit.archivedAt) {
        throw new BadRequestException(
          'Department cannot be created under an archived unit',
        );
      }
    }

    const payload = {
      organizationId,
      organizationalUnitId: input.organizationalUnitId ?? null,
      name: input.name.trim(),
      code,
      description: input.description?.trim() || null,
      sortOrder: Number(input.sortOrder ?? 0),
    };

    return this.structureTx(organizationId, async (tx) => {
      if (payload.organizationalUnitId)
        await this.assertActiveUnitIn(
          tx,
          organizationId,
          payload.organizationalUnitId,
        );
      const entity = await tx.department.create({ data: payload });
      await this.writeAudit(
        tx,
        'DEPARTMENT_CREATED',
        'Department',
        entity.id,
        context,
        {
          before: null,
          after: entity,
        },
      );
      return entity;
    });
  }

  async listDepartments(organizationId: string, includeArchived = false) {
    await this.requireOrganization(organizationId, true);
    return this.prisma.department.findMany({
      where: {
        organizationId,
        ...(includeArchived ? {} : { archivedAt: null }),
      },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }, { code: 'asc' }],
    });
  }

  async getDepartment(
    organizationId: string,
    id: string,
    includeArchived = false,
  ) {
    await this.requireOrganization(organizationId, true);
    const entity = await this.prisma.department.findUnique({ where: { id } });
    if (!entity || entity.organizationId !== organizationId) {
      throw new NotFoundException('Department not found');
    }
    if (!includeArchived && entity.archivedAt) {
      throw new NotFoundException('Department not found');
    }
    return entity;
  }

  async updateDepartment(
    organizationId: string,
    id: string,
    input: DepartmentUpdateDto,
    context: RequestAuditContext = {},
  ) {
    await this.requireOrganization(organizationId, false);
    const current = await this.requireDepartment(organizationId, id, false);
    await this.assertManage(context, {
      type: 'DEPARTMENT',
      id,
      organizationId,
    });
    const before = { ...current };
    const updates: Record<string, unknown> = {};

    if (typeof input.name === 'string') updates.name = input.name.trim();
    if (typeof input.description === 'string')
      updates.description = input.description.trim() || null;
    if (typeof input.sortOrder === 'number')
      updates.sortOrder = Number(input.sortOrder);
    if (
      typeof input.organizationalUnitId === 'string' ||
      input.organizationalUnitId === null
    ) {
      const nextUnitId = input.organizationalUnitId ?? null;
      if (nextUnitId) {
        await this.requireOrganizationalUnit(organizationId, nextUnitId, false);
      }
      if (nextUnitId !== current.organizationalUnitId) {
        await this.assertManage(
          context,
          this.unitParentScope(organizationId, nextUnitId),
        );
      }
      updates.organizationalUnitId = nextUnitId;
    }

    if (Object.keys(updates).length === 0) {
      return current;
    }

    const updated = await this.structureTx(organizationId, async (tx) => {
      if (typeof updates.organizationalUnitId === 'string')
        await this.assertActiveUnitIn(
          tx,
          organizationId,
          updates.organizationalUnitId,
        );
      const next = await tx.department.update({
        where: { id },
        data: updates,
      });
      const action = Object.hasOwn(updates, 'organizationalUnitId')
        ? 'DEPARTMENT_MOVED'
        : 'DEPARTMENT_UPDATED';
      await this.writeAudit(tx, action, 'Department', id, context, {
        before,
        after: next,
        changedFields: Object.keys(updates),
      });
      return next;
    });

    return updated;
  }

  async archiveDepartment(
    organizationId: string,
    id: string,
    context: RequestAuditContext = {},
  ) {
    const current = await this.requireDepartment(organizationId, id, true);
    await this.assertManage(context, {
      type: 'DEPARTMENT',
      id,
      organizationId,
    });
    if (current.archivedAt) return { success: true };

    const updated = await this.structureTx(organizationId, async (tx) => {
      if (await this.archivePolicy.hasActiveDepartmentChildren(tx, id)) {
        throw new BadRequestException(
          'Department cannot be archived while active teams or positions remain.',
        );
      }
      const next = await tx.department.update({
        where: { id },
        data: { archivedAt: new Date() },
      });
      await this.writeAudit(
        tx,
        'DEPARTMENT_ARCHIVED',
        'Department',
        id,
        context,
        {
          before: current,
          after: next,
        },
      );
      return next;
    });

    return { success: true, department: updated };
  }

  async reactivateDepartment(
    organizationId: string,
    id: string,
    context: RequestAuditContext = {},
  ) {
    await this.requireOrganization(organizationId, false);
    const current = await this.requireDepartment(organizationId, id, true);
    await this.assertManage(context, {
      type: 'DEPARTMENT',
      id,
      organizationId,
    });
    if (!current.archivedAt) return { success: true };
    if (current.organizationalUnitId) {
      await this.requireOrganizationalUnit(
        organizationId,
        current.organizationalUnitId,
        false,
      );
    }

    const updated = await this.structureTx(organizationId, async (tx) => {
      if (current.organizationalUnitId)
        await this.assertActiveUnitIn(
          tx,
          organizationId,
          current.organizationalUnitId,
        );
      const next = await tx.department.update({
        where: { id },
        data: { archivedAt: null },
      });
      await this.writeAudit(
        tx,
        'DEPARTMENT_REACTIVATED',
        'Department',
        id,
        context,
        {
          before: current,
          after: next,
        },
      );
      return next;
    });

    return { success: true, department: updated };
  }

  async createTeam(
    organizationId: string,
    input: TeamCreateDto,
    context: RequestAuditContext = {},
  ) {
    await this.requireOrganization(organizationId, false);
    await this.assertManage(
      context,
      this.teamAnchorScope(
        organizationId,
        input.departmentId ?? null,
        input.organizationalUnitId ?? null,
      ),
    );
    const code = this.normalizedCode(input.code);
    this.assertCodeValue(code, 'Team code');
    await this.assertCreateUnique('team', { organizationId, code });

    await this.integrity.validateTeamPlacement(
      organizationId,
      input.departmentId ?? null,
      input.organizationalUnitId ?? null,
    );

    const payload = {
      organizationId,
      departmentId: input.departmentId ?? null,
      organizationalUnitId: input.organizationalUnitId ?? null,
      name: input.name.trim(),
      code,
      description: input.description?.trim() || null,
      sortOrder: Number(input.sortOrder ?? 0),
    };

    return this.structureTx(organizationId, async (tx) => {
      await this.integrity.validateTeamPlacement(
        organizationId,
        payload.departmentId,
        payload.organizationalUnitId,
        tx,
      );
      const entity = await tx.team.create({ data: payload });
      await this.writeAudit(tx, 'TEAM_CREATED', 'Team', entity.id, context, {
        before: null,
        after: entity,
      });
      return entity;
    });
  }

  async listTeams(organizationId: string, includeArchived = false) {
    await this.requireOrganization(organizationId, true);
    return this.prisma.team.findMany({
      where: {
        organizationId,
        ...(includeArchived ? {} : { archivedAt: null }),
      },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }, { code: 'asc' }],
    });
  }

  async getTeam(organizationId: string, id: string, includeArchived = false) {
    await this.requireOrganization(organizationId, true);
    const entity = await this.prisma.team.findUnique({ where: { id } });
    if (!entity || entity.organizationId !== organizationId) {
      throw new NotFoundException('Team not found');
    }
    if (!includeArchived && entity.archivedAt) {
      throw new NotFoundException('Team not found');
    }
    return entity;
  }

  async updateTeam(
    organizationId: string,
    id: string,
    input: TeamUpdateDto,
    context: RequestAuditContext = {},
  ) {
    await this.requireOrganization(organizationId, false);
    const current = await this.requireTeam(organizationId, id, false);
    await this.assertManage(context, {
      type: 'TEAM',
      id,
      organizationId,
    });
    const before = { ...current };
    const updates: Record<string, unknown> = {};

    if (typeof input.name === 'string') updates.name = input.name.trim();
    if (typeof input.description === 'string')
      updates.description = input.description.trim() || null;
    if (typeof input.sortOrder === 'number')
      updates.sortOrder = Number(input.sortOrder);
    const changesPlacement =
      input.departmentId !== undefined ||
      input.organizationalUnitId !== undefined;
    const nextDepartmentId = changesPlacement
      ? (input.departmentId ?? null)
      : current.departmentId;
    const nextUnitId = changesPlacement
      ? (input.organizationalUnitId ?? null)
      : current.organizationalUnitId;
    const placementChanged =
      changesPlacement &&
      (nextDepartmentId !== current.departmentId ||
        nextUnitId !== current.organizationalUnitId);
    if (placementChanged) {
      updates.departmentId = nextDepartmentId;
      updates.organizationalUnitId = nextUnitId;
    }

    if (Object.keys(updates).length === 0) {
      return current;
    }

    await this.integrity.validateTeamPlacement(
      organizationId,
      nextDepartmentId,
      nextUnitId,
    );
    if (placementChanged) {
      await this.assertManage(
        context,
        this.teamAnchorScope(organizationId, nextDepartmentId, nextUnitId),
      );
    }

    const updated = await this.structureTx(organizationId, async (tx) => {
      await this.integrity.validateTeamPlacement(
        organizationId,
        nextDepartmentId,
        nextUnitId,
        tx,
      );
      const next = await tx.team.update({
        where: { id },
        data: updates,
      });
      const moved = placementChanged;
      await this.writeAudit(
        tx,
        moved ? 'TEAM_MOVED' : 'TEAM_UPDATED',
        'Team',
        id,
        context,
        {
          before,
          after: next,
          changedFields: Object.keys(updates),
        },
      );
      return next;
    });

    return updated;
  }

  async archiveTeam(
    organizationId: string,
    id: string,
    context: RequestAuditContext = {},
  ) {
    const current = await this.requireTeam(organizationId, id, true);
    await this.assertManage(context, {
      type: 'TEAM',
      id,
      organizationId,
    });
    if (current.archivedAt) return { success: true };

    const updated = await this.structureTx(organizationId, async (tx) => {
      if ((await this.archivePolicy.hasActiveTeamPositions(tx, id)) > 0) {
        throw new BadRequestException(
          'Team cannot be archived while active positions remain.',
        );
      }
      const next = await tx.team.update({
        where: { id },
        data: { archivedAt: new Date() },
      });
      await this.writeAudit(tx, 'TEAM_ARCHIVED', 'Team', id, context, {
        before: current,
        after: next,
      });
      return next;
    });

    return { success: true, team: updated };
  }

  async reactivateTeam(
    organizationId: string,
    id: string,
    context: RequestAuditContext = {},
  ) {
    await this.requireOrganization(organizationId, false);
    const current = await this.requireTeam(organizationId, id, true);
    await this.assertManage(context, {
      type: 'TEAM',
      id,
      organizationId,
    });
    if (!current.archivedAt) return { success: true };
    await this.integrity.validateTeamPlacement(
      organizationId,
      current.departmentId,
      current.organizationalUnitId,
    );

    const updated = await this.structureTx(organizationId, async (tx) => {
      await this.integrity.validateTeamPlacement(
        organizationId,
        current.departmentId,
        current.organizationalUnitId,
        tx,
      );
      const next = await tx.team.update({
        where: { id },
        data: { archivedAt: null },
      });
      await this.writeAudit(tx, 'TEAM_REACTIVATED', 'Team', id, context, {
        before: current,
        after: next,
      });
      return next;
    });

    return { success: true, team: updated };
  }

  async createJobTitle(
    organizationId: string,
    input: JobTitleCreateDto,
    context: RequestAuditContext = {},
  ) {
    await this.requireOrganization(organizationId, false);
    await this.assertManage(context, {
      type: 'ORGANIZATION',
      id: organizationId,
    });
    const code = this.normalizedCode(input.code);
    this.assertCodeValue(code, 'Job title code');
    await this.assertCreateUnique('jobTitle', { organizationId, code });

    const payload = {
      organizationId,
      name: input.name.trim(),
      code,
      description: input.description?.trim() || null,
      sortOrder: Number(input.sortOrder ?? 0),
    };

    return this.structureTx(organizationId, async (tx) => {
      const entity = await tx.jobTitle.create({ data: payload });
      await this.writeAudit(
        tx,
        'JOB_TITLE_CREATED',
        'JobTitle',
        entity.id,
        context,
        {
          before: null,
          after: entity,
        },
      );
      return entity;
    });
  }

  async listJobTitles(organizationId: string, includeArchived = false) {
    await this.requireOrganization(organizationId, true);
    return this.prisma.jobTitle.findMany({
      where: {
        organizationId,
        ...(includeArchived ? {} : { archivedAt: null }),
      },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }, { code: 'asc' }],
    });
  }

  async getJobTitle(
    organizationId: string,
    id: string,
    includeArchived = false,
  ) {
    await this.requireOrganization(organizationId, true);
    const entity = await this.prisma.jobTitle.findUnique({ where: { id } });
    if (!entity || entity.organizationId !== organizationId) {
      throw new NotFoundException('Job title not found');
    }
    if (!includeArchived && entity.archivedAt) {
      throw new NotFoundException('Job title not found');
    }
    return entity;
  }

  async updateJobTitle(
    organizationId: string,
    id: string,
    input: JobTitleUpdateDto,
    context: RequestAuditContext = {},
  ) {
    await this.requireOrganization(organizationId, false);
    const current = await this.requireJobTitle(organizationId, id, false);
    await this.assertManage(context, {
      type: 'ORGANIZATION',
      id: organizationId,
    });
    const before = { ...current };
    const updates: Record<string, unknown> = {};

    if (typeof input.name === 'string') updates.name = input.name.trim();
    if (typeof input.description === 'string')
      updates.description = input.description.trim() || null;
    if (typeof input.sortOrder === 'number')
      updates.sortOrder = Number(input.sortOrder);

    if (Object.keys(updates).length === 0) return current;

    const updated = await this.structureTx(organizationId, async (tx) => {
      const next = await tx.jobTitle.update({
        where: { id },
        data: updates,
      });
      await this.writeAudit(tx, 'JOB_TITLE_UPDATED', 'JobTitle', id, context, {
        before,
        after: next,
        changedFields: Object.keys(updates),
      });
      return next;
    });

    return updated;
  }

  async archiveJobTitle(
    organizationId: string,
    id: string,
    context: RequestAuditContext = {},
  ) {
    const current = await this.requireJobTitle(organizationId, id, true);
    await this.assertManage(context, {
      type: 'ORGANIZATION',
      id: organizationId,
    });
    if (current.archivedAt) return { success: true };

    const updated = await this.structureTx(organizationId, async (tx) => {
      if ((await this.archivePolicy.hasActiveJobTitlePositions(tx, id)) > 0) {
        throw new BadRequestException(
          'Job title cannot be archived while active positions still reference it.',
        );
      }
      const next = await tx.jobTitle.update({
        where: { id },
        data: { archivedAt: new Date() },
      });
      await this.writeAudit(tx, 'JOB_TITLE_ARCHIVED', 'JobTitle', id, context, {
        before: current,
        after: next,
      });
      return next;
    });

    return { success: true, jobTitle: updated };
  }

  async reactivateJobTitle(
    organizationId: string,
    id: string,
    context: RequestAuditContext = {},
  ) {
    await this.requireOrganization(organizationId, false);
    const current = await this.requireJobTitle(organizationId, id, true);
    await this.assertManage(context, {
      type: 'ORGANIZATION',
      id: organizationId,
    });
    if (!current.archivedAt) return { success: true };

    const updated = await this.structureTx(organizationId, async (tx) => {
      const next = await tx.jobTitle.update({
        where: { id },
        data: { archivedAt: null },
      });
      await this.writeAudit(
        tx,
        'JOB_TITLE_REACTIVATED',
        'JobTitle',
        id,
        context,
        {
          before: current,
          after: next,
        },
      );
      return next;
    });

    return { success: true, jobTitle: updated };
  }

  async createPosition(
    organizationId: string,
    input: PositionCreateDto,
    context: RequestAuditContext = {},
  ) {
    await this.requireOrganization(organizationId, false);
    await this.assertManage(
      context,
      this.positionPlacementScope(organizationId, input),
    );
    const code = this.normalizedCode(input.code);
    this.assertCodeValue(code, 'Position code');
    await this.assertCreateUnique('position', { organizationId, code });

    await this.integrity.validatePositionPlacement(organizationId, input);

    const payload = {
      organizationId,
      jobTitleId: input.jobTitleId,
      organizationalUnitId: input.organizationalUnitId ?? null,
      departmentId: input.departmentId ?? null,
      teamId: input.teamId ?? null,
      workLocationId: input.workLocationId ?? null,
      name: input.name.trim(),
      code,
      description: input.description?.trim() || null,
      sortOrder: Number(input.sortOrder ?? 0),
    };

    return this.structureTx(organizationId, async (tx) => {
      await this.integrity.validatePositionPlacement(organizationId, input, tx);
      const entity = await tx.position.create({ data: payload });
      await this.writeAudit(
        tx,
        'POSITION_CREATED',
        'Position',
        entity.id,
        context,
        {
          before: null,
          after: entity,
        },
      );
      return entity;
    });
  }

  /**
   * R5B: the active Job Titles and Work Locations a Position may reference, for anyone who may
   * manage Positions somewhere in the Organization — organization.manage at SYSTEM scope, on the
   * Organization, or on one of its Units, Departments or Teams. Only id/name/code are returned;
   * selecting a reference grants nothing else (Job Title and Work Location management stays
   * Organization-level). Like physical sites (D12): an Organization that is unknown, archived or
   * not visible to the caller (no organization.read/manage within it) answers 404; visible but
   * without organization.manage within it answers 403.
   */
  async listPositionReferenceOptions(
    organizationId: string,
    actorUserId: string | undefined,
  ) {
    if (!actorUserId) {
      throw new ForbiddenException(
        'An authenticated actor is required for position reference options.',
      );
    }
    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { id: true, archivedAt: true },
    });
    if (!organization || organization.archivedAt) {
      throw new NotFoundException('Organization not found');
    }
    const granted = await this.authorization.permissionKeysWithinOrganization(
      actorUserId,
      organizationId,
    );
    if (!granted.has('organization.manage')) {
      if (granted.has('organization.read')) {
        throw new ForbiddenException(
          'Missing permission organization.manage within this organization.',
        );
      }
      throw new NotFoundException('Organization not found');
    }
    const select = { id: true, name: true, code: true } as const;
    const where = { organizationId, archivedAt: null };
    const orderBy = [{ name: 'asc' as const }, { code: 'asc' as const }];
    const [jobTitles, workLocations] = await Promise.all([
      this.prisma.jobTitle.findMany({ where, select, orderBy }),
      this.prisma.workLocation.findMany({ where, select, orderBy }),
    ]);
    return { jobTitles, workLocations };
  }

  async listPositions(organizationId: string, includeArchived = false) {
    await this.requireOrganization(organizationId, true);
    return this.prisma.position.findMany({
      where: {
        organizationId,
        ...(includeArchived ? {} : { archivedAt: null }),
      },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }, { code: 'asc' }],
    });
  }

  async getPosition(
    organizationId: string,
    id: string,
    includeArchived = false,
  ) {
    await this.requireOrganization(organizationId, true);
    const entity = await this.prisma.position.findUnique({ where: { id } });
    if (!entity || entity.organizationId !== organizationId) {
      throw new NotFoundException('Position not found');
    }
    if (!includeArchived && entity.archivedAt) {
      throw new NotFoundException('Position not found');
    }
    return entity;
  }

  async updatePosition(
    organizationId: string,
    id: string,
    input: PositionUpdateDto,
    context: RequestAuditContext = {},
  ) {
    await this.requireOrganization(organizationId, false);
    const current = await this.requirePosition(organizationId, id, false);
    const currentScope = this.positionPlacementScope(organizationId, current);
    await this.assertManage(context, currentScope);
    const before = { ...current };
    const updates: Record<string, unknown> = {};

    if (typeof input.name === 'string') updates.name = input.name.trim();
    if (typeof input.description === 'string')
      updates.description = input.description.trim() || null;
    if (typeof input.sortOrder === 'number')
      updates.sortOrder = Number(input.sortOrder);
    if (typeof input.jobTitleId === 'string')
      updates.jobTitleId = input.jobTitleId;
    if (
      typeof input.organizationalUnitId === 'string' ||
      input.organizationalUnitId === null
    ) {
      updates.organizationalUnitId = input.organizationalUnitId ?? null;
    }
    if (typeof input.departmentId === 'string' || input.departmentId === null) {
      updates.departmentId = input.departmentId ?? null;
    }
    if (typeof input.teamId === 'string' || input.teamId === null) {
      updates.teamId = input.teamId ?? null;
    }
    if (
      typeof input.workLocationId === 'string' ||
      input.workLocationId === null
    ) {
      updates.workLocationId = input.workLocationId ?? null;
    }

    if (Object.keys(updates).length === 0) return current;
    const identityChanged = [
      'jobTitleId',
      'organizationalUnitId',
      'departmentId',
      'teamId',
      'workLocationId',
    ].some((field) => Object.hasOwn(updates, field));
    if (identityChanged) {
      await this.integrity.assertPositionIdentityMutable(id);
    }

    const payload = {
      ...current,
      organizationId,
      jobTitleId:
        (updates.jobTitleId as string | undefined) ?? current.jobTitleId,
      organizationalUnitId:
        input.organizationalUnitId === undefined
          ? current.organizationalUnitId
          : input.organizationalUnitId,
      departmentId:
        input.departmentId === undefined
          ? current.departmentId
          : input.departmentId,
      teamId: input.teamId === undefined ? current.teamId : input.teamId,
      workLocationId:
        input.workLocationId === undefined
          ? current.workLocationId
          : input.workLocationId,
    };
    await this.integrity.validatePositionPlacement(organizationId, {
      jobTitleId: payload.jobTitleId,
      organizationalUnitId: payload.organizationalUnitId,
      departmentId: payload.departmentId,
      teamId: payload.teamId,
      workLocationId: payload.workLocationId,
    });
    const destinationScope = this.positionPlacementScope(organizationId, {
      teamId: payload.teamId,
      departmentId: payload.departmentId,
      organizationalUnitId: payload.organizationalUnitId,
    });
    if (
      destinationScope.type !== currentScope.type ||
      destinationScope.id !== currentScope.id
    ) {
      await this.assertManage(context, destinationScope);
    }

    const updated = await this.structureTx(organizationId, async (tx) => {
      if (identityChanged) {
        await lockPositions(tx, [id]);
        await this.integrity.assertPositionIdentityMutable(id, tx);
      }
      await this.integrity.validatePositionPlacement(
        organizationId,
        {
          jobTitleId: payload.jobTitleId,
          organizationalUnitId: payload.organizationalUnitId,
          departmentId: payload.departmentId,
          teamId: payload.teamId,
          workLocationId: payload.workLocationId,
        },
        tx,
      );
      const next = await tx.position.update({
        where: { id },
        data: updates,
      });
      const moved =
        Object.hasOwn(updates, 'organizationalUnitId') ||
        Object.hasOwn(updates, 'departmentId') ||
        Object.hasOwn(updates, 'teamId');
      await this.writeAudit(
        tx,
        moved ? 'POSITION_MOVED' : 'POSITION_UPDATED',
        'Position',
        id,
        context,
        {
          before,
          after: next,
          changedFields: Object.keys(updates),
        },
      );
      return next;
    });

    return updated;
  }

  async archivePosition(
    organizationId: string,
    id: string,
    context: RequestAuditContext = {},
  ) {
    const current = await this.requirePosition(organizationId, id, true);
    await this.assertManage(
      context,
      this.positionPlacementScope(organizationId, current),
    );
    if (current.archivedAt) return { success: true };

    const updated = await this.structureTx(organizationId, async (tx) => {
      // Batch 5B (D17): never archive a position someone works in or is about to. The position
      // lock is the one assignment creation and transfer take, so neither can slip in.
      await lockPositions(tx, [id]);
      const live = await tx.employmentAssignment.count({
        where: { positionId: id, status: { in: ['ACTIVE', 'PLANNED'] } },
      });
      if (live > 0) {
        throw new ConflictException(
          domainError(
            409,
            'POSITION_HAS_LIVE_ASSIGNMENTS',
            'This position has active or planned assignments; end, cancel or transfer them before archiving it.',
            { liveAssignments: live },
          ),
        );
      }
      const next = await tx.position.update({
        where: { id },
        data: { archivedAt: new Date() },
      });
      await this.writeAudit(tx, 'POSITION_ARCHIVED', 'Position', id, context, {
        before: current,
        after: next,
      });
      return next;
    });

    return { success: true, position: updated };
  }

  async reactivatePosition(
    organizationId: string,
    id: string,
    context: RequestAuditContext = {},
  ) {
    await this.requireOrganization(organizationId, false);
    const current = await this.requirePosition(organizationId, id, true);
    await this.assertManage(
      context,
      this.positionPlacementScope(organizationId, current),
    );
    if (!current.archivedAt) return { success: true };
    await this.integrity.validatePositionPlacement(organizationId, current);

    const updated = await this.structureTx(organizationId, async (tx) => {
      await this.integrity.validatePositionPlacement(
        organizationId,
        current,
        tx,
      );
      const next = await tx.position.update({
        where: { id },
        data: { archivedAt: null },
      });
      await this.writeAudit(
        tx,
        'POSITION_REACTIVATED',
        'Position',
        id,
        context,
        {
          before: current,
          after: next,
        },
      );
      return next;
    });

    return { success: true, position: updated };
  }

  async createWorkLocation(
    organizationId: string,
    input: WorkLocationCreateDto,
    context: RequestAuditContext = {},
  ) {
    await this.requireOrganization(organizationId, false);
    await this.assertManage(context, {
      type: 'ORGANIZATION',
      id: organizationId,
    });
    const code = this.normalizedCode(input.code);
    this.assertCodeValue(code, 'Work location code');
    await this.assertCreateUnique('workLocation', { organizationId, code });

    const payload = {
      organizationId,
      name: input.name.trim(),
      code,
      description: input.description?.trim() || null,
      addressLine1: input.addressLine1?.trim() || null,
      addressLine2: input.addressLine2?.trim() || null,
      city: input.city?.trim() || null,
      stateProvince: input.stateProvince?.trim() || null,
      postalCode: input.postalCode?.trim() || null,
      country: input.country?.trim() || null,
      timezone: input.timezone?.trim() || null,
      sortOrder: Number(input.sortOrder ?? 0),
    };

    return this.structureTx(organizationId, async (tx) => {
      // Batch 5B (D12): an existing site of this organization, or a matching one created on
      // explicit request (audited). Nothing is created from a missing or null id.
      this.assertOneSiteChoice(input);
      let physicalSiteId: string;
      if (input.physicalSiteId) {
        physicalSiteId = (
          await this.requirePhysicalSite(
            tx,
            organizationId,
            input.physicalSiteId,
          )
        ).id;
      } else if (input.createPhysicalSite) {
        physicalSiteId = (
          await this.physicalSites.createForWorkLocation(
            tx,
            organizationId,
            payload,
            context,
          )
        ).id;
      } else {
        throw new BadRequestException(
          domainError(
            400,
            'PHYSICAL_SITE_REQUIRED',
            'Choose the physical site of this work location, or ask for a matching one to be created.',
          ),
        );
      }
      const entity = await tx.workLocation.create({
        data: { ...payload, physicalSiteId },
        include: { physicalSite: true },
      });
      await this.writeAudit(
        tx,
        'WORK_LOCATION_CREATED',
        'WorkLocation',
        entity.id,
        context,
        { before: null, after: entity },
      );
      return entity;
    });
  }

  async listWorkLocations(organizationId: string, includeArchived = false) {
    await this.requireOrganization(organizationId, true);
    return this.prisma.workLocation.findMany({
      where: {
        organizationId,
        ...(includeArchived ? {} : { archivedAt: null }),
      },
      include: { physicalSite: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }, { code: 'asc' }],
    });
  }

  async getWorkLocation(
    organizationId: string,
    id: string,
    includeArchived = false,
  ) {
    await this.requireOrganization(organizationId, true);
    const entity = await this.prisma.workLocation.findUnique({
      where: { id },
      include: { physicalSite: true },
    });
    if (!entity || entity.organizationId !== organizationId) {
      throw new NotFoundException('Work location not found');
    }
    if (!includeArchived && entity.archivedAt) {
      throw new NotFoundException('Work location not found');
    }
    return entity;
  }

  async updateWorkLocation(
    organizationId: string,
    id: string,
    input: WorkLocationUpdateDto,
    context: RequestAuditContext = {},
  ) {
    await this.requireOrganization(organizationId, false);
    const current = await this.requireWorkLocation(organizationId, id, false);
    await this.assertManage(context, {
      type: 'ORGANIZATION',
      id: organizationId,
    });
    const before = { ...current };
    const updates: Record<string, unknown> = {};

    if (typeof input.name === 'string') updates.name = input.name.trim();
    if (typeof input.description === 'string')
      updates.description = input.description.trim() || null;
    if (typeof input.addressLine1 === 'string')
      updates.addressLine1 = input.addressLine1.trim() || null;
    if (typeof input.addressLine2 === 'string')
      updates.addressLine2 = input.addressLine2.trim() || null;
    if (typeof input.city === 'string')
      updates.city = input.city.trim() || null;
    if (typeof input.stateProvince === 'string')
      updates.stateProvince = input.stateProvince.trim() || null;
    if (typeof input.postalCode === 'string')
      updates.postalCode = input.postalCode.trim() || null;
    if (typeof input.country === 'string')
      updates.country = input.country.trim() || null;
    if (typeof input.timezone === 'string')
      updates.timezone = input.timezone.trim() || null;
    if (typeof input.sortOrder === 'number')
      updates.sortOrder = Number(input.sortOrder);

    const updated = await this.structureTx(organizationId, async (tx) => {
      this.assertOneSiteChoice(input);
      if (input.physicalSiteId) {
        updates.physicalSiteId = (
          await this.requirePhysicalSite(
            tx,
            organizationId,
            input.physicalSiteId,
          )
        ).id;
      } else if (input.createPhysicalSite) {
        // Batch 5B (D12): only on explicit request, audited; `null` alone keeps the current site.
        updates.physicalSiteId = (
          await this.physicalSites.createForWorkLocation(
            tx,
            organizationId,
            { ...current, ...(updates as Record<string, string | null>) },
            context,
          )
        ).id;
      }
      if (Object.keys(updates).length === 0) return current;
      const next = await tx.workLocation.update({
        where: { id },
        data: updates,
        include: { physicalSite: true },
      });
      await this.writeAudit(
        tx,
        'WORK_LOCATION_UPDATED',
        'WorkLocation',
        id,
        context,
        { before, after: next, changedFields: Object.keys(updates) },
      );
      return next;
    });

    return updated;
  }

  async archiveWorkLocation(
    organizationId: string,
    id: string,
    context: RequestAuditContext = {},
  ) {
    const current = await this.requireWorkLocation(organizationId, id, true);
    await this.assertManage(context, {
      type: 'ORGANIZATION',
      id: organizationId,
    });
    if (current.archivedAt) return { success: true };

    const updated = await this.structureTx(organizationId, async (tx) => {
      if (
        (await this.archivePolicy.hasActiveWorkLocationPositions(tx, id)) > 0
      ) {
        throw new BadRequestException(
          'Work location cannot be archived while active positions still reference it.',
        );
      }
      const next = await tx.workLocation.update({
        where: { id },
        data: { archivedAt: new Date() },
      });
      await this.writeAudit(
        tx,
        'WORK_LOCATION_ARCHIVED',
        'WorkLocation',
        id,
        context,
        { before: current, after: next },
      );
      return next;
    });

    return { success: true, workLocation: updated };
  }

  async reactivateWorkLocation(
    organizationId: string,
    id: string,
    context: RequestAuditContext = {},
  ) {
    await this.requireOrganization(organizationId, false);
    const current = await this.requireWorkLocation(organizationId, id, true);
    await this.assertManage(context, {
      type: 'ORGANIZATION',
      id: organizationId,
    });
    if (!current.archivedAt) return { success: true };

    const updated = await this.structureTx(organizationId, async (tx) => {
      const next = await tx.workLocation.update({
        where: { id },
        data: { archivedAt: null },
      });
      await this.writeAudit(
        tx,
        'WORK_LOCATION_REACTIVATED',
        'WorkLocation',
        id,
        context,
        { before: current, after: next },
      );
      return next;
    });

    return { success: true, workLocation: updated };
  }

  async getStructure(organizationId: string) {
    await this.requireOrganization(organizationId, true);
    const rows = await this.prisma.organizationalUnit.findMany({
      where: { organizationId, archivedAt: null },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }, { code: 'asc' }],
    });
    const tree = rows
      .filter((row) => !row.parentUnitId)
      .map((row) => this.toTreeNode(rows, row));
    return tree;
  }

  private toTreeNode(rows: StructureRow[], row: StructureRow): StructureNode {
    const children: StructureNode[] = rows
      .filter((item) => item.parentUnitId === row.id)
      .map((item) => this.toTreeNode(rows, item));
    return { ...row, children };
  }

  /**
   * Batch 5B: one transaction per structure change, serialized per organization by the
   * structure lock, so the integrity and archive checks re-run inside it (on the transaction's
   * view) cannot be bypassed by a concurrent change (a child created under a parent being
   * archived, two moves forming a cycle).
   */
  private structureTx<T>(
    organizationId: string,
    run: (tx: Prisma.TransactionClient) => Promise<T>,
  ) {
    return this.prisma.$transaction(async (tx) => {
      await advisoryLock(tx, `organization-structure:${organizationId}`);
      return run(tx);
    });
  }

  private assertOneSiteChoice(input: {
    physicalSiteId?: string | null;
    createPhysicalSite?: boolean;
  }) {
    if (input.physicalSiteId && input.createPhysicalSite)
      throw new BadRequestException(
        'Choose an existing physical site or ask for a new one, not both.',
      );
  }

  private async assertActiveUnitIn(
    tx: Prisma.TransactionClient,
    organizationId: string,
    unitId: string,
  ) {
    const unit = await tx.organizationalUnit.findFirst({
      where: { id: unitId, organizationId },
      select: { archivedAt: true },
    });
    if (!unit) throw new NotFoundException('Organizational unit not found');
    if (unit.archivedAt)
      throw new BadRequestException(
        'Organizational unit is archived and cannot be used.',
      );
  }

  private async assertManage(
    context: RequestAuditContext,
    scope: AuthorizationScope,
  ) {
    if (!context.actorUserId) {
      throw new ForbiddenException(
        'An authenticated actor is required for organization mutations.',
      );
    }
    await this.authorization.assertCan(
      context.actorUserId,
      'organization.manage',
      scope,
    );
  }

  private unitParentScope(
    organizationId: string,
    parentUnitId: string | null,
  ): AuthorizationScope {
    return parentUnitId
      ? {
          type: 'ORGANIZATIONAL_UNIT',
          id: parentUnitId,
          organizationId,
        }
      : { type: 'ORGANIZATION', id: organizationId };
  }

  private teamAnchorScope(
    organizationId: string,
    departmentId: string | null,
    organizationalUnitId: string | null,
  ): AuthorizationScope {
    if (departmentId) {
      return { type: 'DEPARTMENT', id: departmentId, organizationId };
    }
    if (organizationalUnitId) {
      return {
        type: 'ORGANIZATIONAL_UNIT',
        id: organizationalUnitId,
        organizationId,
      };
    }
    return { type: 'ORGANIZATION', id: organizationId };
  }

  private positionPlacementScope(
    organizationId: string,
    placement: {
      teamId?: string | null;
      departmentId?: string | null;
      organizationalUnitId?: string | null;
    },
  ): AuthorizationScope {
    if (placement.teamId) {
      return {
        type: 'TEAM',
        id: placement.teamId,
        organizationId,
      };
    }
    if (placement.departmentId) {
      return {
        type: 'DEPARTMENT',
        id: placement.departmentId,
        organizationId,
      };
    }
    if (placement.organizationalUnitId) {
      return {
        type: 'ORGANIZATIONAL_UNIT',
        id: placement.organizationalUnitId,
        organizationId,
      };
    }
    return { type: 'ORGANIZATION', id: organizationId };
  }

  private async requireOrganization(id: string, allowArchived: boolean) {
    const entity = await this.prisma.organization.findUnique({ where: { id } });
    if (!entity) throw new NotFoundException('Organization not found');
    if (!allowArchived && entity.archivedAt) {
      throw new NotFoundException('Organization not found');
    }
    return entity;
  }

  private async requireOrganizationalUnit(
    organizationId: string,
    id: string,
    allowArchived: boolean,
  ) {
    const entity = await this.prisma.organizationalUnit.findUnique({
      where: { id },
    });
    if (!entity || entity.organizationId !== organizationId) {
      throw new NotFoundException('Organizational unit not found');
    }
    if (!allowArchived && entity.archivedAt) {
      throw new NotFoundException('Organizational unit not found');
    }
    return entity;
  }

  private async requireDepartment(
    organizationId: string,
    id: string,
    allowArchived: boolean,
  ) {
    const entity = await this.prisma.department.findUnique({ where: { id } });
    if (!entity || entity.organizationId !== organizationId) {
      throw new NotFoundException('Department not found');
    }
    if (!allowArchived && entity.archivedAt) {
      throw new NotFoundException('Department not found');
    }
    return entity;
  }

  private async requireTeam(
    organizationId: string,
    id: string,
    allowArchived: boolean,
  ) {
    const entity = await this.prisma.team.findUnique({ where: { id } });
    if (!entity || entity.organizationId !== organizationId) {
      throw new NotFoundException('Team not found');
    }
    if (!allowArchived && entity.archivedAt) {
      throw new NotFoundException('Team not found');
    }
    return entity;
  }

  private async requireJobTitle(
    organizationId: string,
    id: string,
    allowArchived: boolean,
  ) {
    const entity = await this.prisma.jobTitle.findUnique({ where: { id } });
    if (!entity || entity.organizationId !== organizationId) {
      throw new NotFoundException('Job title not found');
    }
    if (!allowArchived && entity.archivedAt) {
      throw new NotFoundException('Job title not found');
    }
    return entity;
  }

  private async requirePosition(
    organizationId: string,
    id: string,
    allowArchived: boolean,
  ) {
    const entity = await this.prisma.position.findUnique({ where: { id } });
    if (!entity || entity.organizationId !== organizationId) {
      throw new NotFoundException('Position not found');
    }
    if (!allowArchived && entity.archivedAt) {
      throw new NotFoundException('Position not found');
    }
    return entity;
  }

  private async requireWorkLocation(
    organizationId: string,
    id: string,
    allowArchived: boolean,
  ) {
    const entity = await this.prisma.workLocation.findUnique({ where: { id } });
    if (!entity || entity.organizationId !== organizationId) {
      throw new NotFoundException('Work location not found');
    }
    if (!allowArchived && entity.archivedAt) {
      throw new NotFoundException('Work location not found');
    }
    return entity;
  }

  private async requirePhysicalSite(
    tx: Prisma.TransactionClient,
    organizationId: string,
    id: string,
  ) {
    const entity = await tx.physicalSite.findUnique({ where: { id } });
    if (
      !entity ||
      entity.organizationId !== organizationId ||
      entity.archivedAt
    ) {
      throw new NotFoundException('Physical site not found');
    }
    return entity;
  }

  private async assertNoExistingOrganizationCode(code: string) {
    const existing = await this.prisma.organization.findUnique({
      where: { code },
    });
    if (existing) {
      throw new ConflictException('Organization code already exists.');
    }
  }

  private async assertCreateUnique(
    model:
      | 'organizationalUnit'
      | 'department'
      | 'team'
      | 'jobTitle'
      | 'position'
      | 'workLocation',
    selector: { organizationId: string; code: string },
  ) {
    const where = { organizationId_code: selector };
    const entity =
      model === 'organizationalUnit'
        ? await this.prisma.organizationalUnit.findUnique({ where })
        : model === 'department'
          ? await this.prisma.department.findUnique({ where })
          : model === 'team'
            ? await this.prisma.team.findUnique({ where })
            : model === 'jobTitle'
              ? await this.prisma.jobTitle.findUnique({ where })
              : model === 'position'
                ? await this.prisma.position.findUnique({ where })
                : await this.prisma.workLocation.findUnique({ where });
    if (entity) {
      throw new ConflictException(
        `${model} code already exists within this organization.`,
      );
    }
  }

  private normalizedCode(value: string): string {
    return normalizeCodeValue(value);
  }

  private assertCodeValue(value: string, label: string) {
    if (!value || value.length < 2) {
      throw new BadRequestException(`${label} must be at least 2 characters.`);
    }
    if (!/^[A-Z0-9_-]+$/.test(value)) {
      throw new BadRequestException(
        `${label} may only use letters, numbers, underscores, and dashes.`,
      );
    }
  }

  private async writeAudit(
    tx: Prisma.TransactionClient,
    action: string,
    entityType: string,
    entityId: string,
    context: RequestAuditContext,
    metadata: Record<string, unknown>,
  ) {
    const auditMetadata = JSON.parse(
      JSON.stringify(metadata),
    ) as Prisma.InputJsonValue;
    await this.audit.write(
      {
        action,
        actorUserId: context.actorUserId ?? null,
        entityType,
        entityId,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
        correlationId: context.correlationId,
        metadata: auditMetadata,
      },
      tx,
    );
  }
}
