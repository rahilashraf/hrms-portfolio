import { Injectable } from '@nestjs/common';
import { positionTargets } from '../common/domain-support.js';
import { pageBy } from '../common/option-paging.js';
import { PrismaService } from '../database/prisma.service.js';
import {
  BenefitsAccessService,
  permissionRequired,
} from './benefits-access.service.js';

export const BENEFIT_OPTION_KINDS = [
  'employee',
  'assignment',
  'unit',
  'department',
  'position',
] as const;
export type BenefitOptionKind = (typeof BENEFIT_OPTION_KINDS)[number];

export interface BenefitOptionQuery {
  organizationId: string;
  kind: BenefitOptionKind;
  /** `assignment`: only this employee's assignments (election transfer targets). */
  employeeId?: string;
  search?: string;
  limit?: number;
  afterId?: string;
}

export interface BenefitOption {
  id: string;
  label: string;
  description?: string;
  /** `assignment`: whose assignment it is. */
  employeeId?: string;
}

const MAX_LIMIT = 50;

/**
 * Batch 7C (C7) — read-only pickers for Benefits, so benefits administrators never need
 * employee.read or organization.read to choose people's assignments and structures:
 *
 * - `employee`: benefit.read or benefit.manage over one of the employee's assignments in the
 *   organization (finding an employee's benefits without employee.read); one's own never
 *   offered (self-service is My Benefits). The option id is the employee id.
 * - `assignment`: benefit.manage over the assignment's position (sponsors for elections and
 *   transfer targets), the caller's own never offered (self-management).
 * - `unit`, `department`, `position`: benefit.plan.manage at the organization (eligibility rules).
 *
 * Ids, display names and a short description only; Benefits enabled in the organization;
 * paged by id.
 */
@Injectable()
export class BenefitOptionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: BenefitsAccessService,
  ) {}

  async options(userId: string, query: BenefitOptionQuery) {
    const { organizationId } = query;
    const grants = await this.access.grants(userId);
    if (query.kind === 'employee') {
      if (!(await this.access.hasAnyInOrganization(userId, organizationId))) {
        throw permissionRequired(
          'Missing benefit permissions for these options.',
        );
      }
    } else if (query.kind === 'assignment') {
      if (
        !(await this.access.hasAnyInOrganization(userId, organizationId)) ||
        !grants.some((grant) => grant.permission === 'benefit.manage')
      ) {
        throw permissionRequired(
          'Missing permission benefit.manage for these options.',
        );
      }
    } else if (
      !this.access.can(grants, 'benefit.plan.manage', {
        type: 'ORGANIZATION',
        organizationId,
      })
    ) {
      throw permissionRequired(
        'Missing permission benefit.plan.manage for these options.',
      );
    }
    await this.access.requireEnabled(organizationId);
    const limit = Math.min(Math.max(query.limit ?? 20, 1), MAX_LIMIT);
    const search = query.search?.trim();
    const s = search
      ? { contains: search, mode: 'insensitive' as const }
      : undefined;
    const after = (cursor: string | undefined) =>
      cursor ? { id: { gt: cursor } } : {};

    if (query.kind === 'employee') {
      const selfEmployeeId = await this.access.employeeIdOfUser(userId);
      return pageBy<BenefitOption>(
        limit,
        query.afterId,
        async (cursor, take) => {
          const rows = await this.prisma.employee.findMany({
            where: {
              archivedAt: null,
              ...after(cursor),
              ...(selfEmployeeId ? { NOT: { id: selfEmployeeId } } : {}),
              assignments: {
                some: {
                  status: { not: 'CANCELLED' },
                  position: { organizationId },
                },
              },
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
            select: {
              id: true,
              employeeNumber: true,
              person: {
                select: {
                  firstName: true,
                  lastName: true,
                  preferredName: true,
                },
              },
              assignments: {
                where: {
                  status: { not: 'CANCELLED' },
                  position: { organizationId },
                },
                select: {
                  position: {
                    select: {
                      id: true,
                      organizationId: true,
                      organizationalUnitId: true,
                      departmentId: true,
                      teamId: true,
                    },
                  },
                },
              },
            },
            orderBy: { id: 'asc' },
            take,
          });
          const targets = await positionTargets(
            this.prisma,
            rows.flatMap((row) => row.assignments.map((a) => a.position)),
          );
          return rows.map((row) => {
            const visible = row.assignments.some((a) => {
              const target = targets.get(a.position.id)!;
              return (
                this.access.can(grants, 'benefit.read', target) ||
                this.access.can(grants, 'benefit.manage', target)
              );
            });
            const person = row.person;
            return {
              id: row.id,
              option: visible
                ? {
                    id: row.id,
                    employeeId: row.id,
                    label:
                      [
                        person.preferredName ?? person.firstName,
                        person.lastName,
                      ]
                        .filter(Boolean)
                        .join(' ') || 'Unnamed',
                    description: row.employeeNumber,
                  }
                : null,
            };
          });
        },
      );
    }

    if (query.kind === 'assignment') {
      const selfEmployeeId = await this.access.employeeIdOfUser(userId);
      return pageBy<BenefitOption>(
        limit,
        query.afterId,
        async (cursor, take) => {
          const rows = await this.prisma.employmentAssignment.findMany({
            where: {
              status: { not: 'CANCELLED' },
              position: { organizationId },
              ...after(cursor),
              ...(query.employeeId ? { employeeId: query.employeeId } : {}),
              ...(selfEmployeeId
                ? { NOT: { employeeId: selfEmployeeId } }
                : {}),
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
            },
            select: {
              id: true,
              status: true,
              employeeId: true,
              employee: {
                select: {
                  employeeNumber: true,
                  person: {
                    select: {
                      firstName: true,
                      lastName: true,
                      preferredName: true,
                    },
                  },
                },
              },
              position: {
                select: {
                  id: true,
                  name: true,
                  organizationId: true,
                  organizationalUnitId: true,
                  departmentId: true,
                  teamId: true,
                },
              },
            },
            orderBy: { id: 'asc' },
            take,
          });
          const targets = await positionTargets(
            this.prisma,
            rows.map((row) => row.position),
          );
          return rows.map((row) => {
            const person = row.employee.person;
            const visible = this.access.can(
              grants,
              'benefit.manage',
              targets.get(row.position.id)!,
            );
            return {
              id: row.id,
              option: visible
                ? {
                    id: row.id,
                    employeeId: row.employeeId,
                    label:
                      [
                        person.preferredName ?? person.firstName,
                        person.lastName,
                      ]
                        .filter(Boolean)
                        .join(' ') || 'Unnamed',
                    description: [
                      row.employee.employeeNumber,
                      row.position.name,
                      row.status === 'ACTIVE' ? null : row.status.toLowerCase(),
                    ]
                      .filter(Boolean)
                      .join(' · '),
                  }
                : null,
            };
          });
        },
      );
    }

    const model =
      query.kind === 'unit'
        ? this.prisma.organizationalUnit
        : query.kind === 'department'
          ? this.prisma.department
          : this.prisma.position;
    return pageBy<BenefitOption>(limit, query.afterId, async (cursor, take) => {
      const rows = await (
        model as unknown as {
          findMany(
            args: unknown,
          ): Promise<Array<{ id: string; name: string; code: string | null }>>;
        }
      ).findMany({
        where: {
          organizationId,
          archivedAt: null,
          ...after(cursor),
          ...(s ? { OR: [{ name: s }, { code: s }] } : {}),
        },
        select: { id: true, name: true, code: true },
        orderBy: { id: 'asc' },
        take,
      });
      return rows.map((row) => ({
        id: row.id,
        option: {
          id: row.id,
          label: row.name,
          ...(row.code ? { description: row.code } : {}),
        },
      }));
    });
  }
}
