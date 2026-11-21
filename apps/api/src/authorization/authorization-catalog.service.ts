import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';
import { PERMISSION_CATALOG } from './authorization-catalog.js';

@Injectable()
export class AuthorizationCatalogService {
  constructor(private readonly prisma: PrismaService) {}

  async sync(): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      for (const permission of PERMISSION_CATALOG) {
        await tx.permission.upsert({
          where: { key: permission.key },
          create: { ...permission, isActive: true },
          update: {
            name: permission.name,
            description: permission.description,
            isActive: true,
          },
        });
      }

      await tx.permission.updateMany({
        where: { key: { notIn: PERMISSION_CATALOG.map(({ key }) => key) } },
        data: { isActive: false },
      });

      const systemOwner = await tx.role.findFirst({
        where: { isSystemOwner: true },
      });
      if (systemOwner) {
        const activePermissions = await tx.permission.findMany({
          where: { isActive: true },
          select: { id: true },
        });
        for (const permission of activePermissions) {
          await tx.rolePermission.upsert({
            where: {
              roleId_permissionId: {
                roleId: systemOwner.id,
                permissionId: permission.id,
              },
            },
            create: {
              roleId: systemOwner.id,
              permissionId: permission.id,
            },
            update: {},
          });
        }
      }
    });
  }
}
