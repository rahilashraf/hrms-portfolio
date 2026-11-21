import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../database/prisma.service.js';

export type PositionPlacementInput = {
  jobTitleId: string;
  organizationalUnitId?: string | null;
  departmentId?: string | null;
  teamId?: string | null;
  workLocationId?: string | null;
};

@Injectable()
export class OrganizationIntegrityService {
  constructor(private readonly prisma: PrismaService) {}

  async assertPositionIdentityMutable(
    positionId: string,
    client: Prisma.TransactionClient | PrismaService = this.prisma,
  ) {
    const assignment = await client.employmentAssignment.findFirst({
      where: { positionId },
      select: { id: true },
    });
    if (assignment) {
      throw new BadRequestException(
        'A position referenced by employment history cannot have its organizational identity changed.',
      );
    }
  }

  async assertActiveParentUnit(
    organizationId: string,
    parentUnitId: string,
    currentId: string | null,
    client: Prisma.TransactionClient | PrismaService = this.prisma,
  ) {
    const parent = await client.organizationalUnit.findUnique({
      where: { id: parentUnitId },
    });
    if (!parent || parent.organizationId !== organizationId) {
      throw new BadRequestException(
        'Parent organizational unit must belong to the same organization.',
      );
    }
    if (parent.archivedAt) {
      throw new BadRequestException(
        'Parent organizational unit is archived and cannot be used.',
      );
    }
    if (currentId && parent.id === currentId) {
      throw new BadRequestException('Self-parenting is not allowed.');
    }
  }

  async assertNoCycleForUnit(
    parentUnitId: string,
    currentId: string | null,
    client: Prisma.TransactionClient | PrismaService = this.prisma,
  ) {
    let cursor: string | null = parentUnitId;
    const seen = new Set<string>();

    while (cursor) {
      if (cursor === currentId || seen.has(cursor)) {
        throw new BadRequestException(
          'This move would create a hierarchy cycle.',
        );
      }
      seen.add(cursor);
      const parentNode: { parentUnitId: string | null } | null =
        await client.organizationalUnit.findUnique({
          where: { id: cursor },
          select: { parentUnitId: true },
        });
      cursor = parentNode?.parentUnitId ?? null;
    }
  }

  async validateTeamPlacement(
    organizationId: string,
    departmentId: string | null,
    organizationalUnitId: string | null,
    client: Prisma.TransactionClient | PrismaService = this.prisma,
  ) {
    if (
      Number(Boolean(departmentId)) + Number(Boolean(organizationalUnitId)) !==
      1
    ) {
      throw new BadRequestException(
        'Team must have exactly one placement anchor: departmentId or organizationalUnitId.',
      );
    }

    if (departmentId) {
      const department = await client.department.findUnique({
        where: { id: departmentId },
      });
      if (!department || department.organizationId !== organizationId) {
        throw new BadRequestException(
          'Department must belong to the same organization.',
        );
      }
      if (department.archivedAt) {
        throw new BadRequestException(
          'Department is archived and cannot be used.',
        );
      }
      return;
    }

    if (organizationalUnitId) {
      const unit = await client.organizationalUnit.findUnique({
        where: { id: organizationalUnitId },
      });
      if (!unit || unit.organizationId !== organizationId) {
        throw new BadRequestException(
          'Organizational unit must belong to the same organization.',
        );
      }
      if (unit.archivedAt) {
        throw new BadRequestException(
          'Organizational unit is archived and cannot be used.',
        );
      }
    }
  }

  async validatePositionPlacement(
    organizationId: string,
    input: PositionPlacementInput,
    client: Prisma.TransactionClient | PrismaService = this.prisma,
  ) {
    const anchors = [
      input.organizationalUnitId,
      input.departmentId,
      input.teamId,
    ].filter(Boolean);

    if (anchors.length > 1) {
      throw new BadRequestException(
        'Position may have at most one placement anchor: organizationalUnitId, departmentId, or teamId.',
      );
    }

    const jobTitle = await client.jobTitle.findUnique({
      where: { id: input.jobTitleId },
    });
    if (
      !jobTitle ||
      jobTitle.organizationId !== organizationId ||
      jobTitle.archivedAt
    ) {
      throw new BadRequestException(
        'Job title is archived or belongs to another organization.',
      );
    }

    if (input.organizationalUnitId) {
      const unit = await client.organizationalUnit.findUnique({
        where: { id: input.organizationalUnitId },
      });
      if (!unit || unit.organizationId !== organizationId || unit.archivedAt) {
        throw new BadRequestException(
          'Organizational unit is invalid for this position.',
        );
      }
    }

    if (input.departmentId) {
      const department = await client.department.findUnique({
        where: { id: input.departmentId },
      });
      if (
        !department ||
        department.organizationId !== organizationId ||
        department.archivedAt
      ) {
        throw new BadRequestException(
          'Department is invalid for this position.',
        );
      }
    }

    if (input.teamId) {
      const team = await client.team.findUnique({
        where: { id: input.teamId },
      });
      if (!team || team.organizationId !== organizationId || team.archivedAt) {
        throw new BadRequestException('Team is invalid for this position.');
      }
    }

    if (input.workLocationId) {
      const location = await client.workLocation.findUnique({
        where: { id: input.workLocationId },
      });
      if (
        !location ||
        location.organizationId !== organizationId ||
        location.archivedAt
      ) {
        throw new BadRequestException(
          'Work location is invalid for this position.',
        );
      }
    }
  }
}
