import { Injectable } from '@nestjs/common';
import type { AuthorizationTarget } from '../authorization/authorization.types.js';
import { pageBy } from '../common/option-paging.js';
import { PrismaService } from '../database/prisma.service.js';
import { RecruitmentAccessService } from './recruitment-access.service.js';

export const RECRUITMENT_OPTION_KINDS = [
  'position',
  'unit',
  'department',
  'team',
  'workLocation',
  'hiringManager',
  'staff',
] as const;
export type RecruitmentOptionKind = (typeof RECRUITMENT_OPTION_KINDS)[number];

export interface RecruitmentOptionQuery {
  organizationId: string;
  kind: RecruitmentOptionKind;
  search?: string;
  limit?: number;
  afterId?: string;
}

/** What a picker needs and nothing more. */
export interface RecruitmentOption {
  id: string;
  label: string;
  description?: string;
  /** Structure ancestry to send with a unit, department or team (so the opening's scope matches). */
  placement?: {
    organizationalUnitId: string | null;
    departmentId: string | null;
    teamId: string | null;
  };
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

/**
 * Batch 7A (Q2) — read-only pickers for the opening form and interview scheduling, so a
 * standard Recruiter (recruitment.* only, no employee.read or role.assign) never types an id.
 *
 * Every kind needs recruitment.manage reaching into the organization, and Recruitment enabled
 * there. Positions and structures are further limited to those the caller could place an
 * opening on (recruitment.manage over that placement — what opening creation checks). People
 * are the ones the services accept: hiring managers are employees of the organization (any
 * non-cancelled assignment) and staff (recruiter, interviewers) are active users who are such
 * employees. Only ids, a display label and a short description are returned — never emails,
 * contact details or employment data. Paged by id (`afterId`, `nextAfterId`).
 */
@Injectable()
export class RecruitmentOptionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: RecruitmentAccessService,
  ) {}

  async options(userId: string, query: RecruitmentOptionQuery) {
    const { organizationId } = query;
    await this.access.requireAnyInOrganization(
      userId,
      'recruitment.manage',
      organizationId,
    );
    await this.access.requireEnabled(organizationId);
    const grants = (await this.access.grants(userId)).filter(
      (g) => g.permission === 'recruitment.manage',
    );
    const limit = Math.min(Math.max(query.limit ?? 20, 1), MAX_LIMIT);
    const units = await this.prisma.organizationalUnit.findMany({
      where: { organizationId },
      select: { id: true, parentUnitId: true },
    });
    const parent = new Map(units.map((u) => [u.id, u.parentUnitId]));
    const pathOf = (leaf: string | null) => {
      const path: string[] = [];
      for (
        let unit = leaf;
        unit && !path.includes(unit);
        unit = parent.get(unit) ?? null
      )
        path.push(unit);
      return path;
    };
    const placeable = (p: {
      organizationalUnitId: string | null;
      departmentId: string | null;
      teamId: string | null;
    }) => {
      const target: AuthorizationTarget = {
        type: p.teamId
          ? 'TEAM'
          : p.departmentId
            ? 'DEPARTMENT'
            : p.organizationalUnitId
              ? 'ORGANIZATIONAL_UNIT'
              : 'ORGANIZATION',
        organizationId,
        unitPathIds: pathOf(p.organizationalUnitId),
        departmentId: p.departmentId,
        teamId: p.teamId,
      };
      return this.access.can(grants, 'recruitment.manage', target);
    };

    return pageBy<RecruitmentOption>(
      limit,
      query.afterId,
      async (cursor, take) => {
        const after = cursor ? { id: { gt: cursor } } : {};
        const s = contains(query.search?.trim());
        switch (query.kind) {
          case 'position': {
            const rows = await this.prisma.position.findMany({
              where: {
                organizationId,
                archivedAt: null,
                ...after,
                ...(s ? { OR: [{ name: s }, { code: s }] } : {}),
              },
              select: {
                id: true,
                name: true,
                code: true,
                organizationalUnitId: true,
                departmentId: true,
                teamId: true,
                jobTitle: { select: { name: true } },
              },
              orderBy: { id: 'asc' },
              take,
            });
            return rows.map((row) => ({
              id: row.id,
              option: placeable(row)
                ? {
                    id: row.id,
                    label: row.name,
                    description: [row.code, row.jobTitle.name]
                      .filter(Boolean)
                      .join(' · '),
                  }
                : null,
            }));
          }
          case 'unit': {
            const rows = await this.prisma.organizationalUnit.findMany({
              where: {
                organizationId,
                archivedAt: null,
                ...after,
                ...(s ? { OR: [{ name: s }, { code: s }] } : {}),
              },
              select: { id: true, name: true, code: true },
              orderBy: { id: 'asc' },
              take,
            });
            return rows.map((row) => {
              const placement = {
                organizationalUnitId: row.id,
                departmentId: null,
                teamId: null,
              };
              return {
                id: row.id,
                option: placeable(placement)
                  ? {
                      id: row.id,
                      label: row.name,
                      description: row.code,
                      placement,
                    }
                  : null,
              };
            });
          }
          case 'department': {
            const rows = await this.prisma.department.findMany({
              where: {
                organizationId,
                archivedAt: null,
                ...after,
                ...(s ? { OR: [{ name: s }, { code: s }] } : {}),
              },
              select: {
                id: true,
                name: true,
                code: true,
                organizationalUnitId: true,
              },
              orderBy: { id: 'asc' },
              take,
            });
            return rows.map((row) => {
              const placement = {
                organizationalUnitId: row.organizationalUnitId,
                departmentId: row.id,
                teamId: null,
              };
              return {
                id: row.id,
                option: placeable(placement)
                  ? {
                      id: row.id,
                      label: row.name,
                      description: row.code,
                      placement,
                    }
                  : null,
              };
            });
          }
          case 'team': {
            const rows = await this.prisma.team.findMany({
              where: {
                organizationId,
                archivedAt: null,
                ...after,
                ...(s ? { OR: [{ name: s }, { code: s }] } : {}),
              },
              select: {
                id: true,
                name: true,
                code: true,
                departmentId: true,
                organizationalUnitId: true,
                department: { select: { organizationalUnitId: true } },
              },
              orderBy: { id: 'asc' },
              take,
            });
            return rows.map((row) => {
              const placement = {
                organizationalUnitId:
                  row.organizationalUnitId ??
                  row.department?.organizationalUnitId ??
                  null,
                departmentId: row.departmentId,
                teamId: row.id,
              };
              return {
                id: row.id,
                option: placeable(placement)
                  ? {
                      id: row.id,
                      label: row.name,
                      description: row.code,
                      placement,
                    }
                  : null,
              };
            });
          }
          case 'workLocation': {
            const rows = await this.prisma.workLocation.findMany({
              where: {
                organizationId,
                archivedAt: null,
                ...after,
                ...(s ? { OR: [{ name: s }, { code: s }] } : {}),
              },
              select: { id: true, name: true, code: true },
              orderBy: { id: 'asc' },
              take,
            });
            return rows.map((row) => ({
              id: row.id,
              option: { id: row.id, label: row.name, description: row.code },
            }));
          }
          case 'hiringManager': {
            const rows = await this.prisma.employee.findMany({
              where: {
                archivedAt: null,
                ...after,
                assignments: {
                  some: {
                    status: { not: 'CANCELLED' },
                    position: { organizationId },
                  },
                },
                ...(s ? personSearch(s) : {}),
              },
              select: {
                id: true,
                employeeNumber: true,
                person: {
                  select: {
                    preferredName: true,
                    firstName: true,
                    lastName: true,
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
                description: row.employeeNumber,
              },
            }));
          }
          case 'staff': {
            const rows = await this.prisma.user.findMany({
              where: {
                status: 'ACTIVE',
                archivedAt: null,
                ...after,
                person: {
                  employee: {
                    archivedAt: null,
                    assignments: {
                      some: {
                        status: { not: 'CANCELLED' },
                        position: { organizationId },
                      },
                    },
                  },
                  ...(s
                    ? {
                        OR: [
                          { firstName: s },
                          { lastName: s },
                          { preferredName: s },
                          { employee: { employeeNumber: s } },
                        ],
                      }
                    : {}),
                },
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
              },
            }));
          }
        }
      },
    );
  }
}

function personSearch(s: { contains: string; mode: 'insensitive' }) {
  return {
    OR: [
      { employeeNumber: s },
      { person: { firstName: s } },
      { person: { lastName: s } },
      { person: { preferredName: s } },
    ],
  };
}
