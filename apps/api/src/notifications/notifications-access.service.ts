import { ForbiddenException, Injectable, Optional } from '@nestjs/common';
import { permissionIsGranted } from '../authorization/authorization.policy.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import type {
  AuthorizationTarget,
  EffectiveGrant,
} from '../authorization/authorization.types.js';
import { PrismaService } from '../database/prisma.service.js';
import {
  featureGateFor,
  FeatureGateService,
} from '../features/feature-gate.service.js';
import { OPEN_TASK } from '../onboarding/onboarding-domain.js';
import type { NotificationsClient } from './notifications-common.js';

export const NOTIFICATION_PERMISSIONS = [
  'notification.template.manage',
  'notification.settings.manage',
  // Batch 8 (N5): read-only organization delivery log.
  'notification.delivery.read',
] as const;
export type NotificationPermission = (typeof NOTIFICATION_PERMISSIONS)[number];

/**
 * Notifications authorization.
 *
 * - Every authenticated user reads, marks and archives their own notifications and sets their
 *   own email preferences; nobody reads another user's notifications (they are not found).
 * - notification.template.manage (organization templates), notification.settings.manage
 *   (organization email settings) and notification.delivery.read (Batch 8: the read-only
 *   delivery log) are organization-level.
 * - A notification is only published to a user related to its organization: a grant reaching
 *   the organization, a non-cancelled employment assignment in it, or ownership of one of its
 *   open onboarding/offboarding tasks (task owners may hold no grant). Producers additionally
 *   re-check, per recipient, that the linked page is readable through the domain's own access.
 */
@Injectable()
export class NotificationsAccessService {
  /** Phase 18: the NOTIFICATIONS module gate (organization administration and email). */
  readonly features: FeatureGateService;

  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService,
    @Optional() features?: FeatureGateService,
  ) {
    this.features = featureGateFor(prisma, features);
  }

  async allGrants(
    userId: string,
    client: NotificationsClient = this.prisma,
  ): Promise<EffectiveGrant[]> {
    return this.authorization.effectiveGrants(userId, new Date(), client);
  }

  canInOrganization(
    grants: EffectiveGrant[],
    permission: string,
    organizationId: string,
  ) {
    return permissionIsGranted(grants, permission, {
      type: 'ORGANIZATION',
      organizationId,
    });
  }

  async requireOrganization(
    userId: string | undefined,
    permission: NotificationPermission,
    organizationId: string,
    client: NotificationsClient = this.prisma,
  ) {
    const grants = userId ? await this.allGrants(userId, client) : [];
    if (!this.canInOrganization(grants, permission, organizationId)) {
      throw new ForbiddenException(
        `Missing permission ${permission} for the organization.`,
      );
    }
    // Phase 18: template and email administration need the NOTIFICATIONS module.
    await this.features.require(organizationId, 'NOTIFICATIONS', client);
    return grants;
  }

  /** Organizations whose templates or settings the user manages, with UI action flags. */
  async organizations(userId: string) {
    const grants = (await this.allGrants(userId)).filter((grant) =>
      (NOTIFICATION_PERMISSIONS as readonly string[]).includes(
        grant.permission,
      ),
    );
    if (grants.length === 0) return { items: [] };
    const disabled = await this.features.disabledOrganizations('NOTIFICATIONS');
    const rows = await this.prisma.organization.findMany({
      where: { archivedAt: null, id: { notIn: [...disabled] } },
      select: { id: true, name: true, code: true, timezone: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
    const items = [];
    for (const row of rows) {
      const actions = {
        canManageTemplates: this.canInOrganization(
          grants,
          'notification.template.manage',
          row.id,
        ),
        canManageSettings: this.canInOrganization(
          grants,
          'notification.settings.manage',
          row.id,
        ),
        canReadDeliveries: this.canInOrganization(
          grants,
          'notification.delivery.read',
          row.id,
        ),
      };
      if (
        actions.canManageTemplates ||
        actions.canManageSettings ||
        actions.canReadDeliveries
      )
        items.push({ ...row, actions });
    }
    return { items };
  }

  /** Whether any grant of the user reaches into the organization (any scope inside it). */
  async grantsReachOrganization(
    grants: EffectiveGrant[],
    organizationId: string,
    client: NotificationsClient,
  ) {
    if (grants.some((g) => g.scope.type === 'SYSTEM')) return true;
    if (
      grants.some(
        (g) => g.scope.type === 'ORGANIZATION' && g.scope.id === organizationId,
      )
    )
      return true;
    const ids = (type: string) =>
      grants
        .filter((g) => g.scope.type === type)
        .map((g) => g.scope.id!)
        .filter(Boolean);
    const units = ids('ORGANIZATIONAL_UNIT');
    const departments = ids('DEPARTMENT');
    const teams = ids('TEAM');
    return (
      (units.length > 0 &&
        (await client.organizationalUnit.count({
          where: { id: { in: units }, organizationId },
        })) > 0) ||
      (departments.length > 0 &&
        (await client.department.count({
          where: { id: { in: departments }, organizationId },
        })) > 0) ||
      (teams.length > 0 &&
        (await client.team.count({
          where: { id: { in: teams }, organizationId },
        })) > 0)
    );
  }

  /**
   * Whether the user may receive notifications of the organization: an account that is not
   * disabled or archived, related to the organization (see the class comment).
   */
  async isOrganizationMember(
    userId: string,
    organizationId: string,
    client: NotificationsClient = this.prisma,
  ) {
    const user = await client.user.findUnique({
      where: { id: userId },
      select: {
        status: true,
        archivedAt: true,
        person: { select: { employee: { select: { id: true } } } },
      },
    });
    if (
      !user ||
      user.archivedAt ||
      user.status === 'DISABLED' ||
      user.status === 'ARCHIVED'
    )
      return false;
    const employeeId = user.person?.employee?.id;
    if (
      employeeId &&
      (await client.employmentAssignment.count({
        where: {
          employeeId,
          status: { not: 'CANCELLED' },
          position: { organizationId },
        },
      })) > 0
    )
      return true;
    const grants = await this.authorization.effectiveGrants(
      userId,
      new Date(),
      client,
    );
    if (await this.grantsReachOrganization(grants, organizationId, client))
      return true;
    return (
      (await client.employeeWorkflowTask.count({
        where: {
          organizationId,
          ownerUserId: userId,
          status: { in: OPEN_TASK },
        },
      })) > 0
    );
  }

  /**
   * Users holding a permission at organization scope (or SYSTEM) in the organization, from
   * effective role assignments, confirmed through the authorization policy.
   */
  async usersWithOrganizationPermission(
    permission: string,
    organizationId: string,
    client: NotificationsClient = this.prisma,
    now = new Date(),
  ) {
    const candidates = await client.roleAssignment.findMany({
      where: {
        revokedAt: null,
        startsAt: { lte: now },
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        AND: [
          {
            OR: [
              { scopeType: 'SYSTEM' },
              { scopeType: 'ORGANIZATION', organizationId },
            ],
          },
        ],
        role: {
          archivedAt: null,
          permissions: { some: { permission: { key: permission } } },
        },
      },
      select: { userId: true },
      distinct: ['userId'],
    });
    const users: Array<{ userId: string; grants: EffectiveGrant[] }> = [];
    for (const { userId } of candidates) {
      const grants = await this.authorization.effectiveGrants(
        userId,
        now,
        client,
      );
      if (this.canInOrganization(grants, permission, organizationId))
        users.push({ userId, grants });
    }
    return users;
  }

  /**
   * Batch 8 (N7) — the users to whom a permission is granted on a target (e.g. leave.approve
   * on a request's assignment) through an organization, unit, department or team scope inside
   * the target's organization. Each candidate's effective grants at `now` (revoked, expired or
   * archived-role grants excluded) are re-checked against the target through the authorization
   * policy, ignoring SYSTEM-scope grants: platform administrators are not notified about every
   * organization's work. Disabled or archived accounts are excluded. Callers exclude the actor
   * and the subject (no self-notification).
   */
  async scopedPermissionHolders(
    permission: string,
    target: AuthorizationTarget,
    client: NotificationsClient = this.prisma,
    now = new Date(),
  ) {
    const candidates = await client.roleAssignment.findMany({
      where: {
        revokedAt: null,
        startsAt: { lte: now },
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        scopeType: { not: 'SYSTEM' },
        organizationId: target.organizationId,
        role: {
          archivedAt: null,
          permissions: { some: { permission: { key: permission } } },
        },
        user: { archivedAt: null, status: { notIn: ['DISABLED', 'ARCHIVED'] } },
      },
      select: { userId: true },
      distinct: ['userId'],
      orderBy: { userId: 'asc' },
    });
    const users: string[] = [];
    for (const { userId } of candidates) {
      const grants = (
        await this.authorization.effectiveGrants(userId, now, client)
      ).filter(
        (grant) =>
          grant.permission === permission && grant.scope.type !== 'SYSTEM',
      );
      if (permissionIsGranted(grants, permission, target)) users.push(userId);
    }
    return users;
  }
}
