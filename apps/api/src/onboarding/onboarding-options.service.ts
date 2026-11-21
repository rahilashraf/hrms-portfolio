import { ForbiddenException, Injectable } from '@nestjs/common';
import type { EmployeeWorkflowKind } from '../generated/prisma/client.js';
import { positionTargets } from '../common/domain-support.js';
import { pageBy } from '../common/option-paging.js';
import { PrismaService } from '../database/prisma.service.js';
import {
  OnboardingAccessService,
  type OnboardingPermission,
} from './onboarding-access.service.js';
import { permissionFamily } from './onboarding-domain.js';

export const ONBOARDING_OPTION_KINDS = ['owner', 'assignment', 'hire'] as const;
export type OnboardingOptionKind = (typeof ONBOARDING_OPTION_KINDS)[number];

export interface OnboardingOptionQuery {
  organizationId: string;
  kind: OnboardingOptionKind;
  /** For `assignment`: which workflow is being started (default ONBOARDING). */
  workflowKind?: EmployeeWorkflowKind;
  search?: string;
  limit?: number;
  afterId?: string;
}

export interface OnboardingOption {
  id: string;
  label: string;
  description?: string;
  /** `assignment` and `hire`: the employee, so a form can show who it is for. */
  employeeId?: string;
  /** `hire`: an onboarding was started for this hire before and cancelled. */
  restartable?: boolean;
}

const MAX_LIMIT = 50;
const contains = (search: string | undefined) =>
  search ? { contains: search, mode: 'insensitive' as const } : undefined;
const personName = (
  person: {
    preferredName: string | null;
    firstName: string | null;
    lastName: string | null;
  } | null,
) =>
  person?.preferredName ||
  [person?.firstName, person?.lastName].filter(Boolean).join(' ') ||
  'Unnamed';
const personSearch = (s: { contains: string; mode: 'insensitive' }) => ({
  OR: [
    { firstName: s },
    { lastName: s },
    { preferredName: s },
    { employee: { employeeNumber: s } },
  ],
});
const day = (value: Date | null) => value?.toISOString().slice(0, 10) ?? null;

/**
 * Batch 7A (Q2) — read-only pickers for onboarding and offboarding, so HR never types an id and
 * never needs role.assign or employee.read for them.
 *
 * - `owner`: eligible task owners (what template and reassignment validation accepts: active
 *   users employed in the organization or holding a role there). Needs
 *   onboarding.template.manage, onboarding.manage or offboarding.manage reaching into the
 *   organization.
 * - `assignment`: assignments the caller may start the given workflow on (`<kind>.manage` over
 *   the position, never their own). Offboarding includes ENDED assignments; onboarding only
 *   PLANNED and ACTIVE ones.
 * - `hire`: Recruitment hires whose onboarding the caller may start and that have no onboarding
 *   in progress or completed (`restartable` marks one whose onboarding was cancelled). Empty when
 *   Recruitment is switched off.
 *
 * Only ids, a display label and a short description (employee number, position, dates) are
 * returned. Paged by id (`afterId`, `nextAfterId`).
 */
@Injectable()
export class OnboardingOptionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: OnboardingAccessService,
  ) {}

  async options(userId: string, query: OnboardingOptionQuery) {
    const { organizationId } = query;
    const grants = await this.access.grants(userId);
    const limit = Math.min(Math.max(query.limit ?? 20, 1), MAX_LIMIT);
    const s = contains(query.search?.trim());
    const reaches = async (permissions: OnboardingPermission[]) =>
      this.access.hasAnyInOrganization(
        organizationId,
        grants.filter((g) => (permissions as string[]).includes(g.permission)),
      );
    const kind = query.workflowKind ?? 'ONBOARDING';
    const manage = `${permissionFamily(kind)}.manage` as OnboardingPermission;
    const needed: OnboardingPermission[] =
      query.kind === 'owner'
        ? [
            'onboarding.template.manage',
            'onboarding.manage',
            'offboarding.manage',
          ]
        : query.kind === 'hire'
          ? ['onboarding.manage']
          : [manage];
    if (!(await reaches(needed))) {
      throw new ForbiddenException(
        `Missing permission ${needed.join(' or ')} for the organization.`,
      );
    }
    await this.access.requireEnabled(organizationId);
    const selfEmployeeId = await this.access.employeeIdOfUser(userId);

    if (query.kind === 'owner') {
      const now = new Date();
      return pageBy<OnboardingOption>(
        limit,
        query.afterId,
        async (cursor, take) => {
          const rows = await this.prisma.user.findMany({
            where: {
              status: 'ACTIVE',
              archivedAt: null,
              ...(cursor ? { id: { gt: cursor } } : {}),
              ...(s ? { person: personSearch(s) } : {}),
              OR: [
                {
                  person: {
                    employee: {
                      assignments: {
                        some: {
                          status: { in: ['PLANNED', 'ACTIVE'] },
                          position: { organizationId },
                        },
                      },
                    },
                  },
                },
                {
                  roleAssignments: {
                    some: {
                      revokedAt: null,
                      scopeType: { not: 'SYSTEM' },
                      organizationId,
                      role: { archivedAt: null },
                      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
                    },
                  },
                },
              ],
            },
            select: {
              id: true,
              person: {
                select: {
                  preferredName: true,
                  firstName: true,
                  lastName: true,
                  employee: { select: { employeeNumber: true } },
                },
              },
            },
            orderBy: { id: 'asc' },
            take,
          });
          return rows.map((row) => ({
            id: row.id,
            option: {
              id: row.id,
              label: personName(row.person),
              description: row.person.employee?.employeeNumber,
            } as OnboardingOption,
          }));
        },
      );
    }

    const canStart = async (
      positions: Array<{
        id: string;
        organizationId: string;
        organizationalUnitId: string | null;
        departmentId: string | null;
        teamId: string | null;
      }>,
    ) => {
      const targets = await positionTargets(this.prisma, positions);
      return (positionId: string, employeeId: string) =>
        this.access.kindAccess(
          grants,
          query.kind === 'hire' ? 'ONBOARDING' : kind,
          targets.get(positionId)!,
          employeeId === selfEmployeeId,
        ).canManage;
    };
    const positionSelect = {
      id: true,
      name: true,
      organizationId: true,
      organizationalUnitId: true,
      departmentId: true,
      teamId: true,
    } as const;
    const employeeSelect = {
      id: true,
      employeeNumber: true,
      person: {
        select: { preferredName: true, firstName: true, lastName: true },
      },
    } as const;

    if (query.kind === 'assignment') {
      return pageBy<OnboardingOption>(
        limit,
        query.afterId,
        async (cursor, take) => {
          const rows = await this.prisma.employmentAssignment.findMany({
            where: {
              position: { organizationId },
              status: {
                in:
                  kind === 'OFFBOARDING'
                    ? ['PLANNED', 'ACTIVE', 'ENDED']
                    : ['PLANNED', 'ACTIVE'],
              },
              employee: {
                archivedAt: null,
                ...(s
                  ? {
                      OR: [
                        { employeeNumber: s },
                        { person: { firstName: s } },
                        { person: { lastName: s } },
                        { person: { preferredName: s } },
                      ],
                    }
                  : {}),
              },
              ...(cursor ? { id: { gt: cursor } } : {}),
            },
            select: {
              id: true,
              status: true,
              startDate: true,
              endDate: true,
              employee: { select: employeeSelect },
              position: { select: positionSelect },
            },
            orderBy: { id: 'asc' },
            take,
          });
          const allowed = await canStart(rows.map((r) => r.position));
          return rows.map((row) => ({
            id: row.id,
            option: allowed(row.position.id, row.employee.id)
              ? ({
                  id: row.id,
                  employeeId: row.employee.id,
                  label: personName(row.employee.person),
                  description: [
                    row.employee.employeeNumber,
                    row.position.name,
                    row.status === 'ENDED'
                      ? `Ended ${day(row.endDate)}`
                      : row.status === 'PLANNED'
                        ? `Starts ${day(row.startDate)}`
                        : 'Active',
                  ].join(' · '),
                } as OnboardingOption)
              : null,
          }));
        },
      );
    }

    // Hires: none when Recruitment is switched off for the organization.
    if (
      !(await this.access.features.isEnabled(organizationId, 'RECRUITMENT'))
    ) {
      return { items: [], nextAfterId: null };
    }
    return pageBy<OnboardingOption>(
      limit,
      query.afterId,
      async (cursor, take) => {
        const rows = await this.prisma.recruitmentHire.findMany({
          where: {
            organizationId,
            ...(cursor ? { id: { gt: cursor } } : {}),
            // Not yet onboarded: no onboarding of the hire's assignment in progress or completed
            // (a restart after a cancellation is not linked to the hire).
            employmentAssignment: {
              status: { in: ['PLANNED', 'ACTIVE'] },
              employeeWorkflows: {
                none: {
                  kind: 'ONBOARDING',
                  status: { in: ['ACTIVE', 'COMPLETED'] },
                },
              },
            },
            ...(s
              ? {
                  employee: {
                    OR: [
                      { employeeNumber: s },
                      { person: { firstName: s } },
                      { person: { lastName: s } },
                      { person: { preferredName: s } },
                    ],
                  },
                }
              : {}),
          },
          select: {
            id: true,
            employee: { select: employeeSelect },
            employmentAssignment: {
              select: { startDate: true, position: { select: positionSelect } },
            },
            onboardingWorkflows: { select: { id: true } },
          },
          orderBy: { id: 'asc' },
          take,
        });
        const allowed = await canStart(
          rows.map((r) => r.employmentAssignment.position),
        );
        return rows.map((row) => ({
          id: row.id,
          option: allowed(row.employmentAssignment.position.id, row.employee.id)
            ? ({
                id: row.id,
                employeeId: row.employee.id,
                label: personName(row.employee.person),
                description: [
                  row.employee.employeeNumber,
                  row.employmentAssignment.position.name,
                  `Starts ${day(row.employmentAssignment.startDate)}`,
                ].join(' · '),
                restartable: row.onboardingWorkflows.length > 0,
              } as OnboardingOption)
            : null,
        }));
      },
    );
  }
}
