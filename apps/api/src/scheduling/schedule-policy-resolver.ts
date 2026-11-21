import { Injectable, NotFoundException } from '@nestjs/common';
import { PositionAuthorizationTargetResolver } from '../authorization/position-authorization-target.resolver.js';
import { PrismaService } from '../database/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import {
  resolveSchedulePolicy,
  SCHEDULE_POLICY_FIELDS,
  type ResolvedSchedulePolicy,
  type SchedulePolicyRow,
} from './schedule-policy.js';

type Client = Prisma.TransactionClient | PrismaService;

/**
 * The policy chain of one position: its placement's TEAM, DEPARTMENT, organizational units
 * (leaf to root) and ORGANIZATION, each with all of that scope's policy rows. Resolution for any
 * date is then in memory, so callers that need many dates (generation) query once.
 */
export class SchedulePolicyContext {
  constructor(readonly layers: readonly (readonly SchedulePolicyRow[])[]) {}

  resolve(date: Date): ResolvedSchedulePolicy {
    return resolveSchedulePolicy(this.layers, date);
  }
}

const POLICY_SELECT = {
  id: true,
  scopeType: true,
  organizationalUnitId: true,
  departmentId: true,
  teamId: true,
  effectiveFrom: true,
  effectiveTo: true,
  ...Object.fromEntries(SCHEDULE_POLICY_FIELDS.map((field) => [field, true])),
} as const;

/**
 * Phase 7 Batch 7 — resolves SchedulePolicy in EmploymentAssignment context through the
 * assignment position's existing placement hierarchy (never WorkLocation).
 */
@Injectable()
export class SchedulePolicyResolver {
  constructor(
    private readonly prisma: PrismaService,
    private readonly targets: PositionAuthorizationTargetResolver,
  ) {}

  async forPosition(
    positionId: string,
    client: Client = this.prisma,
  ): Promise<SchedulePolicyContext> {
    const target = await this.targets.resolvePosition(
      positionId,
      undefined,
      client,
    );
    const unitPath = target.unitPathIds ?? [];
    const rows = (await client.schedulePolicy.findMany({
      where: {
        organizationId: target.organizationId,
        OR: [
          { scopeType: 'ORGANIZATION' },
          ...(unitPath.length > 0
            ? [{ organizationalUnitId: { in: [...unitPath] } }]
            : []),
          ...(target.departmentId
            ? [{ departmentId: target.departmentId }]
            : []),
          ...(target.teamId ? [{ teamId: target.teamId }] : []),
        ],
      },
      select: POLICY_SELECT,
      orderBy: { effectiveFrom: 'desc' },
    })) as unknown as Array<
      SchedulePolicyRow & {
        organizationalUnitId: string | null;
        departmentId: string | null;
        teamId: string | null;
      }
    >;
    const layers: SchedulePolicyRow[][] = [];
    if (target.teamId) {
      layers.push(rows.filter((row) => row.teamId === target.teamId));
    }
    if (target.departmentId) {
      layers.push(
        rows.filter(
          (row) =>
            row.scopeType === 'DEPARTMENT' &&
            row.departmentId === target.departmentId,
        ),
      );
    }
    for (const unitId of unitPath) {
      layers.push(rows.filter((row) => row.organizationalUnitId === unitId));
    }
    layers.push(rows.filter((row) => row.scopeType === 'ORGANIZATION'));
    return new SchedulePolicyContext(layers);
  }

  async forAssignment(
    assignmentId: string,
    client: Client = this.prisma,
  ): Promise<SchedulePolicyContext> {
    const assignment = await client.employmentAssignment.findUnique({
      where: { id: assignmentId },
      select: { positionId: true },
    });
    if (!assignment) {
      throw new NotFoundException('EmploymentAssignment not found');
    }
    return this.forPosition(assignment.positionId, client);
  }

  async resolveForAssignment(
    assignmentId: string,
    date: Date,
    client: Client = this.prisma,
  ): Promise<ResolvedSchedulePolicy> {
    return (await this.forAssignment(assignmentId, client)).resolve(date);
  }
}
