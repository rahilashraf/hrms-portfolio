import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { AuthorizationTarget } from '../authorization/authorization.types.js';
import { holidayAppliesTo } from '../calendar/holiday-calendar.js';
import { positionTargets } from '../common/domain-support.js';
import { PrismaService } from '../database/prisma.service.js';
import { LeaveAccessService } from './leave-access.service.js';
import { addDays, formatDate, parseDateOnly } from './leave-common.js';

/** A team calendar spans at most this many days. */
export const MAX_TEAM_CALENDAR_DAYS = 62;
/** A holiday list spans at most this many days. */
export const MAX_SELF_HOLIDAY_DAYS = 400;

interface Covered {
  start: Date;
  end: Date | null;
}

const covers = (assignment: Covered, day: Date) =>
  assignment.start <= day && (assignment.end === null || assignment.end >= day);

function displayName(person: {
  firstName: string | null;
  lastName: string | null;
  preferredName: string | null;
}) {
  return (
    [person.preferredName ?? person.firstName, person.lastName]
      .filter(Boolean)
      .join(' ') || null
  );
}

/**
 * Batch 6B — employee self-service reads of the leave calendar (decision D4) and holidays (D6).
 *
 * The team calendar shows, per day, who in the viewer's team is absent on approved leave — a
 * name and "Absent" only. It never returns a leave type, reason, paid/unpaid class, request
 * status, request or assignment id, minutes or partial-day detail. "Team" is the team of the
 * position of an assignment, day by day: a colleague's absence on a date is shown only when the
 * leave belongs to an assignment covering that date in a team where the viewer also holds an
 * assignment covering that date (and may request leave). Pending leave is never shown; nobody
 * without a team sees colleagues. A position's team is its current placement (positions carry
 * no placement history); assignment dates carry moves between positions.
 *
 * Holidays: those that apply, on their date, to one of the viewer's own assignments covering
 * that date (organization, unit, department or team scope), in organizations with Leave on.
 */
@Injectable()
export class LeaveSelfCalendarService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: LeaveAccessService,
  ) {}

  async teamCalendar(userId: string, query: { from: string; to: string }) {
    const { from, to } = this.range(query, MAX_TEAM_CALENDAR_DAYS);
    const { self, assignments } = await this.ownAssignments(userId, from, to);
    const teamed = assignments.filter((a) => a.teamId !== null);
    const teamIds = [...new Set(teamed.map((a) => a.teamId!))];
    const teams = teamIds.length
      ? await this.prisma.team.findMany({
          where: { id: { in: teamIds } },
          select: { id: true, name: true },
          orderBy: [{ name: 'asc' }, { id: 'asc' }],
        })
      : [];

    const days = await this.prisma.leaveRequestDay.findMany({
      where: {
        cancelledByAmendmentId: null,
        minutes: { gt: 0 },
        date: { gte: from, lte: to },
        request: {
          status: 'APPROVED',
          OR: [
            { employeeId: self.id },
            ...(teamIds.length
              ? [
                  {
                    employmentAssignment: {
                      status: { not: 'CANCELLED' as const },
                      position: { teamId: { in: teamIds } },
                    },
                  },
                ]
              : []),
          ],
        },
      },
      select: {
        date: true,
        request: {
          select: {
            employeeId: true,
            employee: {
              select: {
                archivedAt: true,
                person: {
                  select: {
                    firstName: true,
                    lastName: true,
                    preferredName: true,
                  },
                },
              },
            },
            employmentAssignment: {
              select: {
                id: true,
                status: true,
                startDate: true,
                endDate: true,
                position: { select: { organizationId: true, teamId: true } },
              },
            },
          },
        },
      },
    });

    const own = new Set(assignments.map((a) => a.id));
    const people = new Map<
      string,
      { name: string | null; self: boolean; dates: Set<string> }
    >();
    for (const day of days) {
      const request = day.request;
      const assignment = request.employmentAssignment;
      if (assignment.status === 'CANCELLED') continue;
      const window = { start: assignment.startDate, end: assignment.endDate };
      if (!covers(window, day.date)) continue;
      const isSelf = request.employeeId === self.id;
      if (isSelf) {
        // One's own leave, from an assignment this view covers (Leave on, may request).
        if (!own.has(assignment.id)) continue;
      } else {
        if (request.employee.archivedAt) continue;
        const team = assignment.position.teamId;
        // The viewer must be in that team on that day.
        const shared = teamed.some(
          (mine) =>
            mine.teamId === team &&
            mine.organizationId === assignment.position.organizationId &&
            covers(mine, day.date),
        );
        if (!shared) continue;
      }
      const entry = people.get(request.employeeId) ?? {
        name: isSelf ? null : displayName(request.employee.person),
        self: isSelf,
        dates: new Set<string>(),
      };
      entry.dates.add(formatDate(day.date));
      people.set(request.employeeId, entry);
    }

    return {
      range: { from: formatDate(from), to: formatDate(to) },
      teams: teams.map((team) => team.name),
      hasTeam: teamed.length > 0,
      people: [...people.values()]
        .sort(
          (a, b) =>
            Number(b.self) - Number(a.self) ||
            (a.name ?? '').localeCompare(b.name ?? ''),
        )
        .map((person) => ({
          displayName: person.self ? 'You' : (person.name ?? 'Colleague'),
          self: person.self,
          absences: [...person.dates].sort().map((date) => ({
            date,
            label: 'Absent' as const,
          })),
        })),
    };
  }

  async holidays(userId: string, query: { from: string; to: string }) {
    const { from, to } = this.range(query, MAX_SELF_HOLIDAY_DAYS);
    const { assignments } = await this.ownAssignments(userId, from, to);
    const organizationIds = [
      ...new Set(assignments.map((a) => a.organizationId)),
    ];
    if (organizationIds.length === 0)
      return {
        range: { from: formatDate(from), to: formatDate(to) },
        items: [],
      };
    const [holidays, organizations] = await Promise.all([
      this.prisma.organizationHoliday.findMany({
        where: {
          organizationId: { in: organizationIds },
          archivedAt: null,
          date: { gte: from, lte: to },
        },
        orderBy: [{ date: 'asc' }, { name: 'asc' }, { id: 'asc' }],
      }),
      this.prisma.organization.findMany({
        where: { id: { in: organizationIds } },
        select: { id: true, name: true },
      }),
    ]);
    const names = new Map(organizations.map((o) => [o.id, o.name]));
    return {
      range: { from: formatDate(from), to: formatDate(to) },
      items: holidays
        .filter((holiday) =>
          assignments.some(
            (assignment) =>
              covers(assignment, holiday.date) &&
              holidayAppliesTo(holiday, assignment.target),
          ),
        )
        .map((holiday) => ({
          date: formatDate(holiday.date),
          name: holiday.name,
          kind: holiday.kind,
          organizationName: names.get(holiday.organizationId) ?? null,
        })),
    };
  }

  private range(query: { from: string; to: string }, maxDays: number) {
    const from = parseDateOnly(query.from, 'from');
    const to = parseDateOnly(query.to, 'to');
    if (to < from)
      throw new BadRequestException('to must be on or after from.');
    if (to > addDays(from, maxDays - 1))
      throw new BadRequestException(
        `The range may span at most ${maxDays} days.`,
      );
    return { from, to };
  }

  /**
   * The viewer's assignments overlapping the range, in organizations with Leave on, on which
   * they may request leave. 403 when they may request leave on none of their assignments.
   */
  private async ownAssignments(userId: string, from: Date, to: Date) {
    const self = await this.access.selfEmployee(userId);
    const disabled = await this.access.disabledOrganizations();
    const rows = await this.prisma.employmentAssignment.findMany({
      where: {
        employeeId: self.id,
        status: { not: 'CANCELLED' },
        position: { organizationId: { notIn: disabled } },
      },
      select: {
        id: true,
        startDate: true,
        endDate: true,
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
    });
    const grants = await this.access.grants(userId);
    const targets = await positionTargets(
      this.prisma,
      rows.map((row) => row.position),
    );
    const permitted = rows
      .map((row) => ({
        id: row.id,
        start: row.startDate,
        end: row.endDate,
        organizationId: row.position.organizationId,
        teamId: row.position.teamId,
        target: targets.get(row.position.id)! as AuthorizationTarget,
      }))
      .filter((row) => this.access.can(grants, 'leave.request', row.target));
    if (permitted.length === 0) {
      throw new ForbiddenException(
        'Missing permission leave.request for any of your assignments.',
      );
    }
    return {
      self,
      assignments: permitted.filter(
        (row) => row.start <= to && (row.end === null || row.end >= from),
      ),
    };
  }
}
