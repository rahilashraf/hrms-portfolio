import { ForbiddenException, Injectable } from '@nestjs/common';
import { AuthorizationService } from '../authorization/authorization.service.js';
import { PrismaService } from '../database/prisma.service.js';
import type { FeatureModule } from '../features/features-domain.js';
import {
  disabledModules,
  requireOrganizationContext,
} from './workspace-scope.js';

export interface SetupStep {
  key: string;
  label: string;
  description: string;
  complete: boolean;
  optional: boolean;
  href: string;
  /** A short, count-only summary (never names or other content). */
  detail: string;
}

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

/**
 * Phase 20 — the organization setup checklist. Completion is DERIVED from real rows on every
 * read (COUNT queries only); nothing is stored. Requires organization.read or
 * organization.manage at the organization. Steps of disabled modules are left out.
 */
@Injectable()
export class SetupService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService,
  ) {}

  async checklist(userId: string, organizationId: string) {
    const grants = await this.authorization.effectiveGrants(userId);
    const context = await requireOrganizationContext(
      this.prisma,
      grants,
      userId,
      organizationId,
    );
    if (
      !context.atOrganization('organization.read') &&
      !context.atOrganization('organization.manage')
    )
      throw new ForbiddenException(
        'Missing permission organization.read for the organization.',
      );
    const disabled =
      (await disabledModules(this.prisma, [organizationId])).get(
        organizationId,
      ) ?? new Set<FeatureModule>();
    const enabled = (module: FeatureModule) => !disabled.has(module);
    const org = { organizationId };
    const active = { organizationId, archivedAt: null };
    const [
      branding,
      units,
      departments,
      teams,
      locations,
      positions,
      roles,
      roleAssignments,
      employees,
      timePolicies,
      leaveTypes,
      leavePolicies,
      payGroups,
    ] = await Promise.all([
      this.prisma.organizationBranding.count({ where: org }),
      this.prisma.organizationalUnit.count({ where: active }),
      this.prisma.department.count({ where: active }),
      this.prisma.team.count({ where: active }),
      this.prisma.workLocation.count({ where: active }),
      this.prisma.position.count({ where: active }),
      this.prisma.role.count({
        where: { ...active, isSystemOwner: false },
      }),
      this.prisma.roleAssignment.count({
        where: { roleOrganizationId: organizationId, revokedAt: null },
      }),
      this.prisma.employee.count({
        where: {
          archivedAt: null,
          assignments: {
            some: { status: 'ACTIVE', position: { organizationId } },
          },
        },
      }),
      enabled('ATTENDANCE')
        ? this.prisma.timeAttendancePolicy.count({ where: org })
        : 0,
      enabled('LEAVE') ? this.prisma.leaveType.count({ where: active }) : 0,
      enabled('LEAVE') ? this.prisma.leavePolicy.count({ where: org }) : 0,
      enabled('COMPENSATION') || enabled('PAYROLL')
        ? this.prisma.payGroup.count({ where: org })
        : 0,
    ]);
    const steps: SetupStep[] = [
      {
        key: 'company',
        label: 'Company details',
        description: 'Name, code and the timezone used for local dates.',
        complete: context.organization.timezone !== null,
        optional: false,
        href: '/admin/settings/company',
        detail: context.organization.timezone
          ? 'Timezone set'
          : 'Timezone not set',
      },
      {
        key: 'branding',
        label: 'Branding',
        description: 'Display name, logo, colors and the login page.',
        complete: branding > 0,
        optional: true,
        href: '/admin/settings/branding',
        detail: branding > 0 ? 'Customized' : 'Using defaults',
      },
      {
        key: 'structure',
        label: 'Structure',
        description:
          'Business units, departments, teams, work locations and positions.',
        complete: units + departments + teams > 0 && locations > 0,
        optional: false,
        href: `/admin/organizations/${organizationId}`,
        detail: [
          plural(units, 'unit'),
          plural(departments, 'department'),
          plural(teams, 'team'),
          plural(locations, 'location'),
          plural(positions, 'position'),
        ].join(', '),
      },
      {
        key: 'roles',
        label: 'Roles & access',
        description: 'Roles with permissions, assigned to people at a scope.',
        complete: roles > 0 && roleAssignments > 0,
        optional: false,
        href: '/admin/access-control/roles',
        detail: `${plural(roles, 'role')}, ${plural(roleAssignments, 'assignment')}`,
      },
      {
        key: 'employees',
        label: 'Employees',
        description: 'People with an active employment assignment.',
        complete: employees > 0,
        optional: false,
        href: '/admin/employees',
        detail: plural(employees, 'active employee'),
      },
    ];
    if (enabled('ATTENDANCE'))
      steps.push({
        key: 'timeAttendance',
        label: 'Time & attendance policy',
        description: 'How attendance is captured and interpreted.',
        complete: timePolicies > 0,
        optional: true,
        href: '/admin/time',
        detail: plural(timePolicies, 'policy', 'policies'),
      });
    if (enabled('LEAVE'))
      steps.push({
        key: 'leave',
        label: 'Leave types & policies',
        description: 'Leave types and the policies that grant them.',
        complete: leaveTypes > 0 && leavePolicies > 0,
        optional: true,
        href: '/admin/leave#policies',
        detail: `${plural(leaveTypes, 'leave type')}, ${plural(leavePolicies, 'policy', 'policies')}`,
      });
    if (enabled('COMPENSATION') || enabled('PAYROLL'))
      steps.push({
        key: 'payroll',
        label: 'Pay groups',
        description: 'Pay groups for compensation and payroll.',
        complete: payGroups > 0,
        optional: true,
        href: '/admin/compensation',
        detail: plural(payGroups, 'pay group'),
      });
    return { organizationId, steps };
  }
}
