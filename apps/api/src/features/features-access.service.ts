import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { permissionIsGranted } from '../authorization/authorization.policy.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import type { EffectiveGrant } from '../authorization/authorization.types.js';
import { PrismaService } from '../database/prisma.service.js';
import type { FeatureClient } from './feature-gate.service.js';

export const FEATURE_PERMISSIONS = ['feature.read', 'feature.manage'] as const;
export type FeaturePermission = (typeof FEATURE_PERMISSIONS)[number];

/**
 * Feature management authorization. Both permissions are organization-level:
 *
 * - feature.read: view an organization's modules, settings and change history.
 * - feature.manage (implies read here): enable / disable modules, change and reset settings.
 *
 * Neither grants any domain data: the linked sections (time & attendance policies,
 * notification settings, Google Workspace status) are read through their own services with
 * the caller's own permissions, and are shown only when those allow it.
 */
@Injectable()
export class FeaturesAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService,
  ) {}

  async grants(userId: string, client: FeatureClient = this.prisma) {
    return (
      await this.authorization.effectiveGrants(userId, new Date(), client)
    ).filter((grant) =>
      (FEATURE_PERMISSIONS as readonly string[]).includes(grant.permission),
    );
  }

  can(
    grants: EffectiveGrant[],
    permission: FeaturePermission,
    organizationId: string,
  ) {
    const target = { type: 'ORGANIZATION' as const, organizationId };
    return (
      permissionIsGranted(grants, permission, target) ||
      (permission === 'feature.read' &&
        permissionIsGranted(grants, 'feature.manage', target))
    );
  }

  /**
   * The caller's grants when they hold the permission in an existing, non-archived
   * organization. An unknown organization is 404; a known one without the grant is 403.
   */
  async require(
    userId: string | undefined,
    permission: FeaturePermission,
    organizationId: string,
    client: FeatureClient = this.prisma,
  ) {
    const organization = await client.organization.findUnique({
      where: { id: organizationId },
      select: { id: true, archivedAt: true },
    });
    const grants = userId ? await this.grants(userId, client) : [];
    if (!organization || organization.archivedAt) {
      // Never reveal an organization to someone without any feature grant over it.
      if (!grants.some((g) => g.scope.type === 'SYSTEM'))
        throw new ForbiddenException(
          `Missing permission ${permission} for the organization.`,
        );
      throw new NotFoundException('Organization not found.');
    }
    if (!this.can(grants, permission, organizationId))
      throw new ForbiddenException(
        `Missing permission ${permission} for the organization.`,
      );
    return grants;
  }

  /** Organizations whose features the user reads or manages, with UI action flags. */
  async organizations(userId: string) {
    const grants = await this.grants(userId);
    if (grants.length === 0) return { items: [] };
    const rows = await this.prisma.organization.findMany({
      where: { archivedAt: null },
      select: { id: true, name: true, code: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
    const items = [];
    for (const row of rows) {
      const actions = {
        canRead: this.can(grants, 'feature.read', row.id),
        canManage: this.can(grants, 'feature.manage', row.id),
      };
      if (actions.canRead) items.push({ ...row, actions });
    }
    return { items };
  }
}
