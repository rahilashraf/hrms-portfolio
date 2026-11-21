import { Injectable, NotFoundException } from '@nestjs/common';
import { RoleAssignmentScopeType } from '../generated/prisma/enums.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../database/prisma.service.js';
import type { AuthorizationTarget, ScopeRef } from './authorization.types.js';

type Client = Prisma.TransactionClient | PrismaService;

@Injectable()
export class PositionAuthorizationTargetResolver {
  constructor(private readonly prisma: PrismaService) {}

  async resolvePosition(
    positionId: string,
    organizationId?: string,
    client: Client = this.prisma,
  ): Promise<AuthorizationTarget> {
    const position = await client.position.findFirst({
      where: { id: positionId, ...(organizationId ? { organizationId } : {}) },
      select: {
        organizationId: true,
        organizationalUnitId: true,
        departmentId: true,
        teamId: true,
      },
    });
    if (!position) throw new NotFoundException('Position not found');
    // Batch 5B (D19): a team- or department-anchored position inherits its department and unit
    // path from the team and department (the same derivation AuthorizationService.resolveTarget
    // uses for a TEAM or DEPARTMENT scope), so unit- and department-scoped grants cover it.
    const team = position.teamId
      ? await client.team.findFirst({
          where: {
            id: position.teamId,
            organizationId: position.organizationId,
          },
          select: { departmentId: true, organizationalUnitId: true },
        })
      : null;
    const departmentId = position.departmentId ?? team?.departmentId ?? null;
    const department = departmentId
      ? await client.department.findFirst({
          where: { id: departmentId, organizationId: position.organizationId },
          select: { organizationalUnitId: true },
        })
      : null;
    const unitId =
      position.organizationalUnitId ??
      department?.organizationalUnitId ??
      team?.organizationalUnitId ??
      null;
    const unitPathIds = unitId
      ? await this.unitPath(position.organizationId, unitId, client)
      : [];
    return {
      type: position.teamId
        ? 'TEAM'
        : departmentId
          ? 'DEPARTMENT'
          : unitId
            ? 'ORGANIZATIONAL_UNIT'
            : 'ORGANIZATION',
      organizationId: position.organizationId,
      unitPathIds,
      departmentId,
      teamId: position.teamId,
    };
  }

  async scopeForPosition(
    positionId: string,
    organizationId?: string,
    client: Client = this.prisma,
  ): Promise<ScopeRef> {
    const target = await this.resolvePosition(
      positionId,
      organizationId,
      client,
    );
    if (target.type === 'TEAM')
      return { type: RoleAssignmentScopeType.TEAM, id: target.teamId! };
    if (target.type === 'DEPARTMENT')
      return {
        type: RoleAssignmentScopeType.DEPARTMENT,
        id: target.departmentId!,
      };
    if (target.type === 'ORGANIZATIONAL_UNIT')
      return {
        type: RoleAssignmentScopeType.ORGANIZATIONAL_UNIT,
        id: target.unitPathIds?.[0],
      };
    return {
      type: RoleAssignmentScopeType.ORGANIZATION,
      id: target.organizationId,
    };
  }

  async scopeForPlacement(
    organizationId: string,
    teamId?: unknown,
    departmentId?: unknown,
    organizationalUnitId?: unknown,
    client: Client = this.prisma,
  ): Promise<ScopeRef> {
    if (teamId)
      return this.scopeForEntity(
        'TEAM',
        this.idValue(teamId),
        organizationId,
        client,
      );
    if (departmentId)
      return this.scopeForEntity(
        'DEPARTMENT',
        this.idValue(departmentId),
        organizationId,
        client,
      );
    if (organizationalUnitId)
      return this.scopeForEntity(
        'ORGANIZATIONAL_UNIT',
        this.idValue(organizationalUnitId),
        organizationId,
        client,
      );
    return { type: RoleAssignmentScopeType.ORGANIZATION, id: organizationId };
  }

  private async scopeForEntity(
    type: 'TEAM' | 'DEPARTMENT' | 'ORGANIZATIONAL_UNIT',
    id: string,
    organizationId: string,
    client: Client,
  ): Promise<ScopeRef> {
    const row =
      type === 'TEAM'
        ? await client.team.findFirst({
            where: { id, organizationId },
            select: { id: true },
          })
        : type === 'DEPARTMENT'
          ? await client.department.findFirst({
              where: { id, organizationId },
              select: { id: true },
            })
          : await client.organizationalUnit.findFirst({
              where: { id, organizationId },
              select: { id: true },
            });
    if (!row) throw new NotFoundException('Authorization scope not found');
    return { type: RoleAssignmentScopeType[type], id };
  }

  private async unitPath(
    organizationId: string,
    unitId: string,
    client: Client,
  ): Promise<string[]> {
    const rows = await client.organizationalUnit.findMany({
      where: { organizationId },
      select: { id: true, parentUnitId: true },
    });
    const parents = new Map(rows.map((row) => [row.id, row.parentUnitId]));
    const result: string[] = [];
    let current: string | null | undefined = unitId;
    while (current) {
      if (result.includes(current)) break;
      result.push(current);
      current = parents.get(current);
    }
    return result;
  }

  private idValue(value: unknown): string {
    return typeof value === 'string' ? value : '';
  }
}
