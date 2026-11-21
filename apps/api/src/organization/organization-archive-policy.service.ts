import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';

@Injectable()
export class OrganizationArchivePolicyService {
  async hasActiveOrganizationChildren(
    tx: Prisma.TransactionClient,
    organizationId: string,
  ) {
    const counts = await Promise.all([
      tx.organizationalUnit.count({
        where: { organizationId, archivedAt: null },
      }),
      tx.department.count({ where: { organizationId, archivedAt: null } }),
      tx.team.count({ where: { organizationId, archivedAt: null } }),
      tx.position.count({ where: { organizationId, archivedAt: null } }),
      tx.jobTitle.count({ where: { organizationId, archivedAt: null } }),
      tx.workLocation.count({ where: { organizationId, archivedAt: null } }),
    ]);
    return counts.some((count) => count > 0);
  }

  async hasActiveUnitChildren(tx: Prisma.TransactionClient, unitId: string) {
    const counts = await Promise.all([
      tx.organizationalUnit.count({
        where: { parentUnitId: unitId, archivedAt: null },
      }),
      tx.department.count({
        where: { organizationalUnitId: unitId, archivedAt: null },
      }),
      tx.team.count({
        where: { organizationalUnitId: unitId, archivedAt: null },
      }),
      tx.position.count({
        where: { organizationalUnitId: unitId, archivedAt: null },
      }),
    ]);
    return counts.some((count) => count > 0);
  }

  async hasActiveDepartmentChildren(
    tx: Prisma.TransactionClient,
    departmentId: string,
  ) {
    const counts = await Promise.all([
      tx.team.count({ where: { departmentId, archivedAt: null } }),
      tx.position.count({ where: { departmentId, archivedAt: null } }),
    ]);
    return counts.some((count) => count > 0);
  }

  hasActiveTeamPositions(tx: Prisma.TransactionClient, teamId: string) {
    return tx.position.count({ where: { teamId, archivedAt: null } });
  }

  hasActiveJobTitlePositions(tx: Prisma.TransactionClient, jobTitleId: string) {
    return tx.position.count({
      where: { jobTitleId, archivedAt: null },
    });
  }

  hasActiveWorkLocationPositions(
    tx: Prisma.TransactionClient,
    workLocationId: string,
  ) {
    return tx.position.count({
      where: { workLocationId, archivedAt: null },
    });
  }
}
