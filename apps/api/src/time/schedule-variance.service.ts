import { BadRequestException, Injectable } from '@nestjs/common';
import { permissionIsGranted } from '../authorization/authorization.policy.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import type { AuthorizationTarget } from '../authorization/authorization.types.js';
import { PositionAuthorizationTargetResolver } from '../authorization/position-authorization-target.resolver.js';
import { PrismaService } from '../database/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import {
  MAX_VARIANCE_RANGE_DAYS,
  type ScheduledVsActualQueryDto,
} from './time.dto.js';
import { TimeDomainService } from './time-domain.service.js';
import { TimeService } from './time.service.js';

const POSITION_INCLUDE = {
  jobTitle: true,
  organization: true,
  organizationalUnit: true,
  department: true,
  team: true,
  workLocation: true,
} as const;

export interface VarianceRow {
  workDate: string;
  employeeId: string;
  employmentAssignmentId: string;
  scheduledShiftCount: number;
  scheduledMinutes: number;
  scheduledShiftIds: string[];
  /** Batch 4F (Q8): who and where, for the scheduled-vs-actual view (no contact details). */
  employeeNumber: string | null;
  employeeName: string | null;
  positionName: string | null;
  closedEntryCount: number;
  openEntryCount: number;
  grossMinutes: number;
  actualMinutes: number;
  linkedActualMinutes: number;
  unscheduledActualMinutes: number;
  varianceMinutes: number;
}

/**
 * Phase 7 Batch 10 — scheduled vs actual. Expected work is the published ACTIVE shifts
 * (minutes from their stored instants); actual work is Time & Attendance's own authoritative
 * worked-time computation of CLOSED, unarchived TimeEntries (the same one timesheets use). Rows
 * are per workDate and EmploymentAssignment; open entries are counted, never estimated. A row
 * is visible only where the actor holds time.view and schedule.read (or schedule.manage) for
 * the assignment's position.
 */
@Injectable()
export class ScheduleVarianceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly domain: TimeDomainService,
    private readonly authorization: AuthorizationService,
    private readonly targets: PositionAuthorizationTargetResolver,
    private readonly time: TimeService,
  ) {}

  async scheduledVsActual(userId: string, query: ScheduledVsActualQueryDto) {
    const from = this.domain.parseDateOnly(query.from);
    const to = this.domain.parseDateOnly(query.to);
    if (to < from)
      throw new BadRequestException('to must be on or after from.');
    if (
      to.getTime() - from.getTime() >
      (MAX_VARIANCE_RANGE_DAYS - 1) * 86_400_000
    ) {
      throw new BadRequestException(
        `A scheduled-vs-actual report may span at most ${MAX_VARIANCE_RANGE_DAYS} days.`,
      );
    }
    const limit = Math.min(Math.max(query.limit ?? 100, 1), 500);
    const result = {
      range: { from: query.from, to: query.to },
      rows: [] as VarianceRow[],
      nextAfterKey: null as string | null,
    };
    const grants = await this.authorization.effectiveGrants(
      userId,
      new Date(),
      this.prisma,
    );
    if (!grants.some((grant) => grant.permission === 'time.view'))
      return result;

    const targets = new Map<string, AuthorizationTarget>();
    const readable = async (positionId: string) => {
      if (!targets.has(positionId)) {
        targets.set(
          positionId,
          await this.targets.resolvePosition(
            positionId,
            undefined,
            this.prisma,
          ),
        );
      }
      const target = targets.get(positionId)!;
      return (
        permissionIsGranted(grants, 'time.view', target) &&
        (permissionIsGranted(grants, 'schedule.read', target) ||
          permissionIsGranted(grants, 'schedule.manage', target))
      );
    };

    const unitIds = query.organizationalUnitId
      ? await this.unitSubtree(query.organizationId, query.organizationalUnitId)
      : null;
    const positionWhere: Prisma.PositionWhereInput = {
      organizationId: query.organizationId,
      ...(query.teamId ? { teamId: query.teamId } : {}),
      ...(query.departmentId ? { departmentId: query.departmentId } : {}),
      ...(unitIds ? { organizationalUnitId: { in: unitIds } } : {}),
    };
    // Batch 4F (D5): the caller's readable positions are resolved first and applied in the
    // queries; with none, the report is empty and the organization's feature state is not
    // revealed.
    const readableIds: string[] = [];
    for (const position of await this.prisma.position.findMany({
      where: positionWhere,
      select: { id: true },
    })) {
      if (await readable(position.id)) readableIds.push(position.id);
    }
    if (readableIds.length === 0) return result;
    // Phase 18: the report reads both Time & attendance and Scheduling.
    await this.time.features.requireAll(query.organizationId, [
      'ATTENDANCE',
      'SCHEDULING',
    ]);
    const assignmentWhere: Prisma.EmploymentAssignmentWhereInput = {
      ...(query.employmentAssignmentId
        ? { id: query.employmentAssignmentId }
        : {}),
      ...(query.employeeId ? { employeeId: query.employeeId } : {}),
      position: { ...positionWhere, id: { in: readableIds } },
    };
    const workDate = { gte: from, lte: to };
    const [shifts, entries] = await Promise.all([
      this.prisma.scheduledShift.findMany({
        where: {
          status: 'ACTIVE',
          schedule: { status: 'PUBLISHED' },
          workDate,
          employmentAssignment: assignmentWhere,
        },
        select: {
          id: true,
          workDate: true,
          startsAt: true,
          endsAt: true,
          employmentAssignmentId: true,
          employmentAssignment: {
            select: { employeeId: true, positionId: true },
          },
        },
        orderBy: [{ workDate: 'asc' }, { startsAt: 'asc' }, { id: 'asc' }],
      }),
      this.prisma.timeEntry.findMany({
        where: {
          archivedAt: null,
          workDate,
          employmentAssignment: assignmentWhere,
        },
        include: {
          breaks: { where: { removedAt: null }, orderBy: { startAt: 'asc' } },
          employmentAssignment: {
            include: { position: { include: POSITION_INCLUDE } },
          },
        },
        orderBy: [{ workDate: 'asc' }, { clockInAt: 'asc' }, { id: 'asc' }],
      }),
    ]);

    const rows = new Map<string, VarianceRow>();
    const row = (date: Date, employeeId: string, assignmentId: string) => {
      const dateKey = date.toISOString().slice(0, 10);
      const key = `${dateKey}|${assignmentId}`;
      let current = rows.get(key);
      if (!current) {
        current = {
          workDate: dateKey,
          employeeId,
          employmentAssignmentId: assignmentId,
          scheduledShiftCount: 0,
          scheduledMinutes: 0,
          scheduledShiftIds: [],
          employeeNumber: null,
          employeeName: null,
          positionName: null,
          closedEntryCount: 0,
          openEntryCount: 0,
          grossMinutes: 0,
          actualMinutes: 0,
          linkedActualMinutes: 0,
          unscheduledActualMinutes: 0,
          varianceMinutes: 0,
        };
        rows.set(key, current);
      }
      return { key, current };
    };
    const afterKey = query.afterKey ?? '';
    const inPage = (key: string) => key > afterKey;

    for (const shift of shifts) {
      if (!(await readable(shift.employmentAssignment.positionId))) continue;
      const { key, current } = row(
        shift.workDate,
        shift.employmentAssignment.employeeId,
        shift.employmentAssignmentId,
      );
      if (!inPage(key)) continue;
      current.scheduledShiftCount += 1;
      current.scheduledMinutes += Math.round(
        (shift.endsAt.getTime() - shift.startsAt.getTime()) / 60_000,
      );
      current.scheduledShiftIds.push(shift.id);
    }
    for (const entry of entries) {
      if (!(await readable(entry.employmentAssignment.positionId))) continue;
      const { key, current } = row(
        entry.workDate,
        entry.employeeId,
        entry.employmentAssignmentId,
      );
      if (!inPage(key)) continue;
      if (!entry.clockOutAt) {
        current.openEntryCount += 1;
        continue;
      }
      const minutes = await this.time.workedMinutesForEntry(
        { ...entry, clockOutAt: entry.clockOutAt },
        this.prisma,
      );
      current.closedEntryCount += 1;
      current.grossMinutes += minutes.grossMinutes;
      current.actualMinutes += minutes.netWorkedMinutes;
      if (entry.scheduledShiftId) {
        current.linkedActualMinutes += minutes.netWorkedMinutes;
      } else {
        current.unscheduledActualMinutes += minutes.netWorkedMinutes;
      }
    }

    const ordered = [...rows.entries()]
      .filter(([key]) => inPage(key))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const page = ordered.slice(0, limit);
    // Batch 4F (Q8): display names of the page's rows only (one query each).
    const assignmentIds = [
      ...new Set(page.map(([, value]) => value.employmentAssignmentId)),
    ];
    const named = new Map(
      (
        await this.prisma.employmentAssignment.findMany({
          where: { id: { in: assignmentIds } },
          select: {
            id: true,
            position: { select: { name: true } },
            employee: {
              select: {
                employeeNumber: true,
                person: {
                  select: {
                    firstName: true,
                    preferredName: true,
                    lastName: true,
                  },
                },
              },
            },
          },
        })
      ).map((assignment) => [assignment.id, assignment]),
    );
    result.rows = page.map(([, value]) => {
      const assignment = named.get(value.employmentAssignmentId);
      const person = assignment?.employee.person;
      return {
        ...value,
        employeeNumber: assignment?.employee.employeeNumber ?? null,
        employeeName: person
          ? [person.preferredName ?? person.firstName, person.lastName]
              .filter(Boolean)
              .join(' ') || null
          : null,
        positionName: assignment?.position.name ?? null,
        varianceMinutes: value.actualMinutes - value.scheduledMinutes,
      };
    });
    result.nextAfterKey =
      ordered.length > limit ? (page.at(-1)?.[0] ?? null) : null;
    return result;
  }

  /** A unit and all of its descendants. */
  private async unitSubtree(organizationId: string, unitId: string) {
    const units = await this.prisma.organizationalUnit.findMany({
      where: { organizationId },
      select: { id: true, parentUnitId: true },
    });
    const result = new Set([unitId]);
    for (let grew = true; grew;) {
      grew = false;
      for (const unit of units) {
        if (
          unit.parentUnitId &&
          result.has(unit.parentUnitId) &&
          !result.has(unit.id)
        ) {
          result.add(unit.id);
          grew = true;
        }
      }
    }
    return [...result];
  }
}
