import { ForbiddenException, Injectable } from '@nestjs/common';
import { domainError, positionTargets } from '../common/domain-support.js';
import { pageBy } from '../common/option-paging.js';
import { PrismaService } from '../database/prisma.service.js';
import type { EffectiveGrant } from '../authorization/authorization.types.js';
import { PerformanceAccessService } from './performance-access.service.js';
import type { PerformancePermission } from './performance-access.service.js';
import { displayName } from './performance-cycle.service.js';

export const PERFORMANCE_OPTION_KINDS = [
  'employee',
  'assignment',
  'reviewer',
  'unit',
  'department',
  'team',
] as const;
export type PerformanceOptionKind = (typeof PERFORMANCE_OPTION_KINDS)[number];

export interface PerformanceOptionQuery {
  organizationId: string;
  kind: PerformanceOptionKind;
  /** `assignment`: only this employee's assignments (evidence and goals after an employee pick). */
  employeeId?: string;
  search?: string;
  limit?: number;
  afterId?: string;
}

export interface PerformanceOption {
  id: string;
  label: string;
  description?: string;
  /** `assignment`: whose assignment it is. */
  employeeId?: string;
}

const MAX_LIMIT = 50;
const contains = (search: string | undefined) =>
  search ? { contains: search, mode: 'insensitive' as const } : undefined;
const personSearch = (s: { contains: string; mode: 'insensitive' }) => ({
  OR: [
    { employeeNumber: s },
    { person: { firstName: s } },
    { person: { lastName: s } },
    { person: { preferredName: s } },
  ],
});
const nameOf = (person: Parameters<typeof displayName>[0]) =>
  displayName(person) || 'Unnamed';
const POSITION = {
  id: true,
  name: true,
  organizationId: true,
  organizationalUnitId: true,
  departmentId: true,
  teamId: true,
} as const;

/**
 * Batch 7B (D7) — read-only pickers for Performance, so performance administrators never need
 * employee.read, organization.read or role.assign to choose people and structures. Every kind
 * needs a performance permission reaching the organization (and Performance enabled there):
 *
 * - `reviewer`: performance.manage — people who may review (employed in the organization now,
 *   as reviewer reassignment requires).
 * - `employee`: performance.evidence.manage (the organization) or performance.manage (the
 *   employees of assignments in its scope) — evidence recording, re-mapping, intake matching.
 * - `assignment`: performance.cycle.manage (the organization) or performance.manage (its scope)
 *   — targeted review addition and goals.
 * - `unit`, `department`, `team`: performance.cycle.manage — narrowing a cycle's population.
 *
 * The caller's own employee record and assignments are never offered (self-management).
 * Only ids, display names and a short description are returned — never contact data.
 */
@Injectable()
export class PerformanceOptionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: PerformanceAccessService,
  ) {}

  async options(userId: string, query: PerformanceOptionQuery) {
    const { organizationId } = query;
    const grants = await this.access.grants(userId);
    const org = (
      permission: Parameters<PerformanceAccessService['canInOrganization']>[1],
    ) => this.access.canInOrganization(grants, permission, organizationId);
    const reaching = async (permission: PerformancePermission) =>
      this.access.hasAnyInOrganization(
        userId,
        organizationId,
        this.prisma,
        grants.filter((g) => g.permission === permission),
      );
    const canCycle = org('performance.cycle.manage');
    const canEvidence = org('performance.evidence.manage');
    const canManage = await reaching('performance.manage');
    const allowed =
      query.kind === 'reviewer'
        ? canManage
        : query.kind === 'employee'
          ? canEvidence || canManage
          : query.kind === 'assignment'
            ? canCycle || canManage
            : canCycle;
    if (!allowed) {
      throw new ForbiddenException(
        domainError(
          403,
          'PERFORMANCE_PERMISSION_REQUIRED',
          'Missing performance permissions for these options.',
        ),
      );
    }
    await this.access.requireEnabled(organizationId);
    const selfEmployeeId = await this.access.employeeIdOfUser(userId);
    const limit = Math.min(Math.max(query.limit ?? 20, 1), MAX_LIMIT);
    const s = contains(query.search?.trim());
    const after = (cursor: string | undefined) =>
      cursor ? { id: { gt: cursor } } : {};
    // Scope of performance.manage alone (when the organization-level permission is absent).
    const manageScope = async (
      positions: Array<{
        id: string;
        organizationId: string;
        organizationalUnitId: string | null;
        departmentId: string | null;
        teamId: string | null;
      }>,
    ) => {
      const targets = await positionTargets(this.prisma, positions);
      return (positionId: string) =>
        this.access.can(
          grants as EffectiveGrant[],
          'performance.manage',
          targets.get(positionId)!,
        );
    };

    switch (query.kind) {
      case 'unit':
      case 'department':
      case 'team': {
        const model =
          query.kind === 'unit'
            ? this.prisma.organizationalUnit
            : query.kind === 'department'
              ? this.prisma.department
              : this.prisma.team;
        return pageBy<PerformanceOption>(
          limit,
          query.afterId,
          async (cursor, take) => {
            const rows = await (
              model as unknown as {
                findMany(
                  args: unknown,
                ): Promise<Array<{ id: string; name: string; code: string }>>;
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
              option: { id: row.id, label: row.name, description: row.code },
            }));
          },
        );
      }
      case 'reviewer':
      case 'employee': {
        const statuses =
          query.kind === 'reviewer'
            ? (['PLANNED', 'ACTIVE'] as const)
            : (['PLANNED', 'ACTIVE', 'ENDED'] as const);
        const wholeOrganization = query.kind === 'reviewer' || canEvidence;
        return pageBy<PerformanceOption>(
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
                    status: { in: [...statuses] },
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
                    firstName: true,
                    lastName: true,
                    preferredName: true,
                  },
                },
                assignments: {
                  where: {
                    status: { in: [...statuses] },
                    position: { organizationId },
                  },
                  select: { position: { select: POSITION } },
                },
              },
              orderBy: { id: 'asc' },
              take,
            });
            const inScope = wholeOrganization
              ? null
              : await manageScope(
                  rows.flatMap((row) => row.assignments.map((a) => a.position)),
                );
            return rows.map((row) => ({
              id: row.id,
              option:
                !inScope || row.assignments.some((a) => inScope(a.position.id))
                  ? {
                      id: row.id,
                      label: nameOf(row.person),
                      description: row.employeeNumber,
                    }
                  : null,
            }));
          },
        );
      }
      case 'assignment': {
        return pageBy<PerformanceOption>(
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
                employee: { archivedAt: null, ...(s ? personSearch(s) : {}) },
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
                position: { select: POSITION },
              },
              orderBy: { id: 'asc' },
              take,
            });
            const inScope = canCycle
              ? null
              : await manageScope(rows.map((row) => row.position));
            return rows.map((row) => ({
              id: row.id,
              option:
                !inScope || inScope(row.position.id)
                  ? {
                      id: row.id,
                      employeeId: row.employeeId,
                      label: nameOf(row.employee.person),
                      description: [
                        row.employee.employeeNumber,
                        row.position.name,
                        row.status === 'ACTIVE'
                          ? null
                          : row.status.toLowerCase(),
                      ]
                        .filter(Boolean)
                        .join(' · '),
                    }
                  : null,
            }));
          },
        );
      }
    }
  }
}
