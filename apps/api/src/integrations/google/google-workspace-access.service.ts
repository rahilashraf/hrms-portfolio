import { ForbiddenException, Injectable, Optional } from '@nestjs/common';
import { permissionIsGranted } from '../../authorization/authorization.policy.js';
import { AuthorizationService } from '../../authorization/authorization.service.js';
import type { EffectiveGrant } from '../../authorization/authorization.types.js';
import { PrismaService } from '../../database/prisma.service.js';
import {
  featureGateFor,
  FeatureGateService,
} from '../../features/feature-gate.service.js';
import type { GoogleClient } from './google-workspace-common.js';

export const GOOGLE_INTEGRATION_PERMISSIONS = [
  'integration.google.manage',
  'integration.google.read',
] as const;
export type GoogleIntegrationPermission =
  (typeof GOOGLE_INTEGRATION_PERMISSIONS)[number];

/**
 * Google Workspace integration authorization. Both permissions are organization-level:
 *
 * - integration.google.read: view the connection summary, bindings and sync logs.
 * - integration.google.manage (implies read here): connect / disconnect, credentials, health
 *   checks, form bindings and manual syncs.
 *
 * Neither grants access to any domain data: bindings only point forms at a domain's own
 * ingestion contract, which applies the domain's own rules; nobody reads responses here.
 */
@Injectable()
export class GoogleWorkspaceAccessService {
  /** Phase 18: the GOOGLE_WORKSPACE module gate (and the google.* settings). */
  readonly features: FeatureGateService;

  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService,
    @Optional() features?: FeatureGateService,
  ) {
    this.features = featureGateFor(prisma, features);
  }

  async grants(userId: string, client: GoogleClient = this.prisma) {
    return (
      await this.authorization.effectiveGrants(userId, new Date(), client)
    ).filter((grant) =>
      (GOOGLE_INTEGRATION_PERMISSIONS as readonly string[]).includes(
        grant.permission,
      ),
    );
  }

  can(
    grants: EffectiveGrant[],
    permission: GoogleIntegrationPermission,
    organizationId: string,
  ) {
    const target = { type: 'ORGANIZATION' as const, organizationId };
    return (
      permissionIsGranted(grants, permission, target) ||
      (permission === 'integration.google.read' &&
        permissionIsGranted(grants, 'integration.google.manage', target))
    );
  }

  async require(
    userId: string | undefined,
    permission: GoogleIntegrationPermission,
    organizationId: string,
    client: GoogleClient = this.prisma,
  ) {
    const grants = userId ? await this.grants(userId, client) : [];
    if (!this.can(grants, permission, organizationId))
      throw new ForbiddenException(
        `Missing permission ${permission} for the organization.`,
      );
    await this.features.require(organizationId, 'GOOGLE_WORKSPACE', client);
    return grants;
  }

  /** Organizations whose integration the user reads or manages, with UI action flags. */
  async organizations(userId: string) {
    const grants = await this.grants(userId);
    if (grants.length === 0) return { items: [] };
    const disabled =
      await this.features.disabledOrganizations('GOOGLE_WORKSPACE');
    const rows = await this.prisma.organization.findMany({
      where: { archivedAt: null, id: { notIn: [...disabled] } },
      select: { id: true, name: true, code: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
    const items = [];
    for (const row of rows) {
      const actions = {
        canRead: this.can(grants, 'integration.google.read', row.id),
        canManage: this.can(grants, 'integration.google.manage', row.id),
      };
      if (actions.canRead) items.push({ ...row, actions });
    }
    return { items };
  }
}
