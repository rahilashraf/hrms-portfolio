import { ForbiddenException, Injectable, Optional } from '@nestjs/common';
import { AuthorizationService } from '../authorization/authorization.service.js';
import { PrismaService } from '../database/prisma.service.js';
import {
  featureGateFor,
  FeatureGateService,
} from '../features/feature-gate.service.js';
import type { PayrollClient } from './payroll-common.js';

export const PAYROLL_PERMISSIONS = [
  'payroll.read',
  'payroll.manage',
  'payroll.calculate',
  'payroll.approve',
  'payroll.finalize',
  'payroll.adjust',
] as const;
export type PayrollPermission = (typeof PAYROLL_PERMISSIONS)[number];

/**
 * Payroll is organization-scoped in V1: every payroll entity belongs to one organization and a
 * grant counts only at that organization (or SYSTEM). Unit, department and team grants never
 * reach payroll, and no employee, compensation or manager access implies it. Employees see
 * their own pay through self-only routes, never through these permissions.
 */
@Injectable()
export class PayrollAccessService {
  /** Phase 18: the PAYROLL module gate (assert() — every payroll path — uses it). */
  readonly features: FeatureGateService;

  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService,
    @Optional() features?: FeatureGateService,
  ) {
    this.features = featureGateFor(prisma, features);
  }

  /** 403 FEATURE_DISABLED when Payroll is disabled for the organization. */
  requireEnabled(organizationId: string, client: PayrollClient = this.prisma) {
    return this.features.require(organizationId, 'PAYROLL', client);
  }

  can(
    userId: string,
    permission: PayrollPermission,
    organizationId: string,
    client: PayrollClient = this.prisma,
  ) {
    return this.authorization.canAccess(
      userId,
      permission,
      { type: 'ORGANIZATION', id: organizationId },
      client,
    );
  }

  async assert(
    userId: string | undefined,
    permission: PayrollPermission,
    organizationId: string,
    client: PayrollClient = this.prisma,
  ) {
    if (
      !userId ||
      !(await this.can(userId, permission, organizationId, client))
    ) {
      throw new ForbiddenException(
        `Missing permission ${permission} for the organization.`,
      );
    }
    await this.requireEnabled(organizationId, client);
  }

  /** What the user may do in an organization's payroll (UI action flags). */
  async actions(userId: string, organizationId: string) {
    const entries = await Promise.all(
      PAYROLL_PERMISSIONS.map(
        async (permission) =>
          [
            permission,
            await this.can(userId, permission, organizationId),
          ] as const,
      ),
    );
    const has = Object.fromEntries(entries) as Record<
      PayrollPermission,
      boolean
    >;
    return {
      canRead: has['payroll.read'],
      canManage: has['payroll.manage'],
      canCalculate: has['payroll.calculate'],
      canApprove: has['payroll.approve'],
      canFinalize: has['payroll.finalize'],
      canAdjust: has['payroll.adjust'],
    };
  }

  /** Organizations where the user holds any payroll permission at organization (or SYSTEM) scope. */
  async organizations(userId: string) {
    const grants = (await this.authorization.effectiveGrants(userId)).filter(
      (grant) =>
        (PAYROLL_PERMISSIONS as readonly string[]).includes(grant.permission),
    );
    const system = grants.some((grant) => grant.scope.type === 'SYSTEM');
    const ids = grants
      .filter((grant) => grant.scope.type === 'ORGANIZATION' && grant.scope.id)
      .map((grant) => grant.scope.id!);
    if (!system && ids.length === 0) return { items: [] };
    const disabled = await this.features.disabledOrganizations('PAYROLL');
    const rows = await this.prisma.organization.findMany({
      where: {
        archivedAt: null,
        AND: [{ id: { notIn: [...disabled] } }],
        ...(system ? {} : { id: { in: [...new Set(ids)] } }),
      },
      select: { id: true, name: true, code: true, timezone: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
    return {
      items: await Promise.all(
        rows.map(async (row) => ({
          ...row,
          actions: await this.actions(userId, row.id),
        })),
      ),
    };
  }
}
