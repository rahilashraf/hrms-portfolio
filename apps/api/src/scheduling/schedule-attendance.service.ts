import { BadRequestException, Injectable, Optional } from '@nestjs/common';
import { PositionAuthorizationTargetResolver } from '../authorization/position-authorization-target.resolver.js';
import { PrismaService } from '../database/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import type { UnscheduledWorkMode } from '../generated/prisma/client.js';
import type {
  PublishedExpectedWorkFact,
  PublishedExpectedWorkQuery,
  PublishedExpectedWorkSource,
} from './scheduling-integration.contracts.js';
import {
  SchedulePolicyContext,
  SchedulePolicyResolver,
} from './schedule-policy-resolver.js';

type Client = Prisma.TransactionClient | PrismaService;

const MAX_EXPECTED_WORK_RANGE_MS = 93 * 86_400_000;

/** The policy bounds clock-in windows to 0..1440 minutes, so no match can start further away. */
const MAX_CLOCK_IN_WINDOW_MINUTES = 1440;

/** A published revision exactly as Time & Attendance consumes it. */
export interface PublishedShiftRevisionFact {
  id: string;
  scheduledShiftId: string;
  revisionNumber: number;
  revisionType: string;
  employmentAssignmentId: string;
  workLocationId: string | null;
  workDate: Date;
  startsAt: Date;
  endsAt: Date;
  timezone: string;
  status: 'ACTIVE' | 'CANCELLED';
}

/** A published ACTIVE shift whose clock-in eligibility window contains the requested instant. */
export interface ClockInShiftCandidate {
  scheduledShiftId: string;
  scheduleId: string;
  employmentAssignmentId: string;
  workLocationId: string | null;
  workDate: Date;
  startsAt: Date;
  endsAt: Date;
  timezone: string;
  revisionId: string;
  revisionNumber: number;
  eligibleFrom: Date;
  eligibleUntil: Date;
}

/**
 * Phase 7 Batch 9 — the read-only Scheduling surface Time & Attendance consumes. It exposes only
 * published, immutable expected-work facts (ScheduledShift in a PUBLISHED Schedule and its
 * latest ScheduledShiftRevision) and the SchedulePolicy attendance settings. It never interprets
 * recurrence: patterns and rules are invisible here, only concrete published shifts are.
 */
@Injectable()
export class ScheduleAttendanceService implements PublishedExpectedWorkSource {
  private readonly policies: SchedulePolicyResolver;

  constructor(
    private readonly prisma: PrismaService,
    targets: PositionAuthorizationTargetResolver,
    @Optional() policies?: SchedulePolicyResolver,
  ) {
    this.policies = policies ?? new SchedulePolicyResolver(prisma, targets);
  }

  /**
   * Published ACTIVE shifts of the given assignments whose clock-in window contains `at`.
   * Matching is by the actual instant against each shift's policy window, never by workDate:
   * eligible iff startsAt − clockInEarlyMinutes ≤ at ≤ min(startsAt + clockInLateMinutes,
   * endsAt), with the policy resolved for the shift's workDate. Overnight shifts therefore match
   * across midnight. Ordered by startsAt, then id.
   */
  async clockInCandidates(
    input: { employeeId: string; employmentAssignmentIds: string[]; at: Date },
    client: Client = this.prisma,
  ): Promise<ClockInShiftCandidate[]> {
    if (input.employmentAssignmentIds.length === 0) return [];
    const margin = MAX_CLOCK_IN_WINDOW_MINUTES * 60_000;
    const shifts = await client.scheduledShift.findMany({
      where: {
        employmentAssignmentId: { in: input.employmentAssignmentIds },
        employmentAssignment: { employeeId: input.employeeId },
        status: 'ACTIVE',
        schedule: { status: 'PUBLISHED' },
        startsAt: {
          gte: new Date(input.at.getTime() - margin),
          lte: new Date(input.at.getTime() + margin),
        },
        endsAt: { gt: input.at },
      },
      include: {
        revisions: {
          orderBy: { revisionNumber: 'desc' },
          take: 1,
          select: { id: true, revisionNumber: true },
        },
      },
      orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
    });
    const contexts = new Map<string, SchedulePolicyContext>();
    const candidates: ClockInShiftCandidate[] = [];
    for (const shift of shifts) {
      const revision = shift.revisions[0];
      // A published shift always has a baseline revision; without one there is no
      // immutable fact for attendance to consume, so it cannot be matched.
      if (!revision) continue;
      let context = contexts.get(shift.employmentAssignmentId);
      if (!context) {
        context = await this.policies.forAssignment(
          shift.employmentAssignmentId,
          client,
        );
        contexts.set(shift.employmentAssignmentId, context);
      }
      const policy = context.resolve(shift.workDate);
      const eligibleFrom = new Date(
        shift.startsAt.getTime() - policy.clockInEarlyMinutes * 60_000,
      );
      const eligibleUntil = new Date(
        Math.min(
          shift.startsAt.getTime() + policy.clockInLateMinutes * 60_000,
          shift.endsAt.getTime(),
        ),
      );
      if (
        input.at.getTime() < eligibleFrom.getTime() ||
        input.at.getTime() > eligibleUntil.getTime()
      ) {
        continue;
      }
      candidates.push({
        scheduledShiftId: shift.id,
        scheduleId: shift.scheduleId,
        employmentAssignmentId: shift.employmentAssignmentId,
        workLocationId: shift.workLocationId,
        workDate: shift.workDate,
        startsAt: shift.startsAt,
        endsAt: shift.endsAt,
        timezone: shift.timezone,
        revisionId: revision.id,
        revisionNumber: revision.revisionNumber,
        eligibleFrom,
        eligibleUntil,
      });
    }
    return candidates;
  }

  /**
   * Batch 4F (D7): how many minutes before a shift's start attendance may be confirmed for it
   * (the schedule policy resolved for the assignment on the shift's work date), the same early
   * bound clockInCandidates uses.
   */
  async earlyAttendanceMinutes(
    employmentAssignmentId: string,
    workDate: Date,
    client: Client = this.prisma,
  ): Promise<number> {
    const context = await this.policies.forAssignment(
      employmentAssignmentId,
      client,
    );
    return context.resolve(workDate).clockInEarlyMinutes;
  }

  /**
   * Published expected work overlapping [start, end) for one employee: the latest revision of
   * each ACTIVE shift in a PUBLISHED Schedule. Implements the future Leave/payroll contract.
   */
  async publishedExpectedWork(
    query: PublishedExpectedWorkQuery,
    client: Client = this.prisma,
  ): Promise<PublishedExpectedWorkFact[]> {
    const start = new Date(query.start);
    const end = new Date(query.end);
    if (
      Number.isNaN(start.getTime()) ||
      Number.isNaN(end.getTime()) ||
      end.getTime() <= start.getTime()
    ) {
      throw new BadRequestException('end must be an instant after start.');
    }
    if (end.getTime() - start.getTime() > MAX_EXPECTED_WORK_RANGE_MS) {
      throw new BadRequestException(
        'Expected work may be read for at most 93 days at a time.',
      );
    }
    const shifts = await client.scheduledShift.findMany({
      where: {
        status: 'ACTIVE',
        schedule: { status: 'PUBLISHED' },
        employmentAssignment: { employeeId: query.employeeId },
        ...(query.employmentAssignmentId
          ? { employmentAssignmentId: query.employmentAssignmentId }
          : {}),
        startsAt: { lt: end },
        endsAt: { gt: start },
      },
      include: {
        revisions: {
          orderBy: { revisionNumber: 'desc' },
          take: 1,
          select: { id: true, revisionNumber: true },
        },
      },
      orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
    });
    return shifts.flatMap((shift) => {
      const revision = shift.revisions[0];
      if (!revision) return [];
      return [
        {
          employeeId: query.employeeId,
          employmentAssignmentId: shift.employmentAssignmentId,
          scheduledShiftId: shift.id,
          scheduledShiftRevisionId: revision.id,
          revisionNumber: revision.revisionNumber,
          scheduleId: shift.scheduleId,
          workLocationId: shift.workLocationId,
          workDate: shift.workDate.toISOString().slice(0, 10),
          startsAt: shift.startsAt.toISOString(),
          endsAt: shift.endsAt.toISOString(),
          timezone: shift.timezone,
          scheduledMinutes: Math.round(
            (shift.endsAt.getTime() - shift.startsAt.getTime()) / 60_000,
          ),
        },
      ];
    });
  }

  /**
   * The local dates in [from, to] on which the assignment's expected work is defined by
   * published schedules, so a date without a shift is a day off rather than "not scheduled":
   *  - a date on which the assignment has an ACTIVE shift in a PUBLISHED schedule; and
   *  - every date of a PUBLISHED STANDARD schedule in which the assignment is rostered (has at
   *    least one ACTIVE shift).
   * A Schedule is a container of shifts, not a claim of completeness over its scope (generation
   * creates per-scope weekly containers holding only the assignments that have patterns), so a
   * schedule whose scope merely contains the position does not make the assignment's other days
   * days off; neither does an AD_HOC schedule beyond its own shifts. Phase 8 Leave uses this to
   * size leave; Scheduling itself never reads Leave.
   */
  async publishedScheduleDates(
    input: { employmentAssignmentId: string; from: Date; to: Date },
    client: Client = this.prisma,
  ): Promise<Set<string>> {
    const [shifts, rosters] = await Promise.all([
      client.scheduledShift.findMany({
        where: {
          employmentAssignmentId: input.employmentAssignmentId,
          status: 'ACTIVE',
          workDate: { gte: input.from, lte: input.to },
          schedule: { status: 'PUBLISHED' },
        },
        select: { workDate: true },
      }),
      client.schedule.findMany({
        where: {
          status: 'PUBLISHED',
          type: 'STANDARD',
          periodStart: { lte: input.to },
          periodEnd: { gte: input.from },
          shifts: {
            some: {
              employmentAssignmentId: input.employmentAssignmentId,
              status: 'ACTIVE',
            },
          },
        },
        select: { periodStart: true, periodEnd: true },
      }),
    ]);
    const dates = new Set(
      shifts.map((shift) => shift.workDate.toISOString().slice(0, 10)),
    );
    for (const schedule of rosters) {
      const start =
        schedule.periodStart > input.from ? schedule.periodStart : input.from;
      const end = schedule.periodEnd < input.to ? schedule.periodEnd : input.to;
      for (let day = start.getTime(); day <= end.getTime(); day += 86_400_000) {
        dates.add(new Date(day).toISOString().slice(0, 10));
      }
    }
    return dates;
  }

  /** The unscheduled-work mode in force for an assignment on a local date. */
  async unscheduledWorkMode(
    employmentAssignmentId: string,
    localDate: Date,
    client: Client = this.prisma,
  ): Promise<UnscheduledWorkMode> {
    return (
      await this.policies.resolveForAssignment(
        employmentAssignmentId,
        localDate,
        client,
      )
    ).unscheduledWorkMode;
  }

  /**
   * Share-locks a shift row and returns it with its latest published revision. Holding the
   * share lock until commit serializes linking attendance against a concurrent correction or
   * cancellation (which update the row): either the link sees the new revision, or the change
   * sees the linked TimeEntry and raises a review signal. Returns null for a shift that is not
   * in a PUBLISHED Schedule or has no published revision.
   */
  async lockPublishedShift(
    scheduledShiftId: string,
    client: Prisma.TransactionClient,
  ) {
    await client.$queryRaw(
      Prisma.sql`SELECT "id" FROM "ScheduledShift" WHERE "id" = ${scheduledShiftId}::uuid FOR SHARE`,
    );
    const shift = await client.scheduledShift.findUnique({
      where: { id: scheduledShiftId },
      include: {
        schedule: { select: { status: true } },
        employmentAssignment: { select: { employeeId: true } },
      },
    });
    if (!shift || shift.schedule.status !== 'PUBLISHED') return null;
    const revision = await this.latestRevision(scheduledShiftId, client);
    if (!revision) return null;
    return { shift, revision };
  }

  async latestRevision(
    scheduledShiftId: string,
    client: Client = this.prisma,
  ): Promise<PublishedShiftRevisionFact | null> {
    return client.scheduledShiftRevision.findFirst({
      where: { scheduledShiftId },
      orderBy: { revisionNumber: 'desc' },
      select: REVISION_FACT_SELECT,
    });
  }

  async revision(
    revisionId: string,
    client: Client = this.prisma,
  ): Promise<PublishedShiftRevisionFact | null> {
    return client.scheduledShiftRevision.findUnique({
      where: { id: revisionId },
      select: REVISION_FACT_SELECT,
    });
  }
}

const REVISION_FACT_SELECT = {
  id: true,
  scheduledShiftId: true,
  revisionNumber: true,
  revisionType: true,
  employmentAssignmentId: true,
  workLocationId: true,
  workDate: true,
  startsAt: true,
  endsAt: true,
  timezone: true,
  status: true,
} as const;
