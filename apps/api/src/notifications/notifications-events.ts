import { Logger } from '@nestjs/common';
import type { AuthorizationTarget } from '../authorization/authorization.types.js';
import { formatDate, positionTargets } from '../common/domain-support.js';
import type { PrismaService } from '../database/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { NotificationsClock } from './notifications-common.js';
import { containsLink, escapeValue } from './notifications-domain.js';
import { notificationServices } from './notifications-producers.js';
import type { PublishInput } from './notification.service.js';

/**
 * Batch 8 (N1) — durable, replay-safe event notifications.
 *
 * Business operations do not publish notifications. They already commit durable records of
 * what happened (leave request events, timesheet events, correction decisions, schedule
 * publication, shift revisions, payroll finalization, benefits audit entries), and the worker
 * turns those committed records into notifications afterwards, outside every business
 * transaction: a notification can never roll back a business action, and no fan-out runs
 * inside one.
 *
 * Each source is read through a persistent cursor (NotificationProducerCheckpoint) in
 * (timestamp, id) order, up to a horizon behind every open transaction (see `eventHorizon`),
 * so a record committed late is never skipped and an outage of any length loses nothing.
 * Events are published one by one; the checkpoint advances past an event only once all its
 * notices are published (or deliberately skipped), and is saved after each page and on
 * failure. A crash or failure mid fan-out leaves the checkpoint before that event: the next
 * run repeats it and the dedupe keys (one per event and recipient) make the repeat create
 * nothing twice. Real repeated transitions are separate event records with their own keys;
 * a no-op retry of a business action writes no record and so notifies nobody.
 *
 * Bootstrap: a source without a checkpoint starts at the current horizon — history recorded
 * before the first run is never notified. Recipients and their access are resolved when the
 * event is published (the recipient's account, organization membership, the module gate and,
 * for approvers, the approval permission on the record as of then).
 */

export interface EventCursor {
  at: Date;
  id: string;
}

/** The cursor of a bootstrapped checkpoint: everything at or before the horizon is history. */
export const BOOTSTRAP_CURSOR_ID = 'ffffffff-ffff-ffff-ffff-ffffffffffff';

/**
 * How far the horizon stays behind the oldest open transaction and the database clock: covers
 * timestamps the application computes slightly before its transaction starts and clock skew
 * between application servers and the database.
 */
export const HORIZON_MARGIN_MS = 2 * 60_000;

/** A horizon this far behind now means a long-open transaction is holding notices back. */
export const HORIZON_LAG_WARNING_MS = 30 * 60_000;

/**
 * The newest instant whose records are all committed and visible: the earlier of the database
 * clock and the start of the oldest open transaction of the application's database role in
 * this database (its records carry timestamps at or after its start), minus HORIZON_MARGIN_MS.
 *
 * Batch 8 review (M2): only client sessions of the current role count. The API and the worker
 * share one role (one DATABASE_URL), every business record is written through it, and a role's
 * own sessions are always visible in pg_stat_activity (no privilege needed); other roles'
 * transactions (a dump, an analytics or psql session) and background processes (autovacuum)
 * never hold notifications back. Deployments must keep the API and the worker on the same role.
 */
export async function eventHorizon(
  prisma: PrismaService | Prisma.TransactionClient,
  marginMs = HORIZON_MARGIN_MS,
) {
  const [row] = await prisma.$queryRaw<Array<{ horizon: Date; now: Date }>>(
    Prisma.sql`
      SELECT LEAST(clock_timestamp(), COALESCE(MIN(a.xact_start), clock_timestamp())) AS "horizon",
             clock_timestamp() AS "now"
      FROM pg_stat_activity a
      WHERE a.datname = current_database()
        AND a.pid <> pg_backend_pid()
        AND a.backend_type = 'client backend'
        AND a.usename = current_user
        AND a.xact_start IS NOT NULL`,
  );
  return {
    horizon: new Date(row!.horizon.getTime() - marginMs),
    now: row!.now,
  };
}

export interface EventSourceOutcome {
  source: string;
  bootstrapped: boolean;
  events: number;
  created: number;
  existing: number;
  /** Notices not published: refused by membership or the module gate. */
  skipped: number;
  failed: Array<{ message: string }>;
  cursor: { at: string; id: string } | null;
}

export interface PublishEventsOutcome {
  horizon: string;
  sources: EventSourceOutcome[];
}

type Client = PrismaService;

export interface EventSource<E> {
  key: string;
  page(
    client: Client,
    after: EventCursor,
    horizon: Date,
    take: number,
  ): Promise<E[]>;
  cursorOf(event: E): EventCursor;
  /** The notices of one event, resolved now (recipients, access, content). */
  notices(client: Client, event: E): Promise<PublishInput[]>;
}

const after = (field: string, cursor: EventCursor, horizon: Date) => ({
  AND: [
    { [field]: { lte: horizon } },
    {
      OR: [
        { [field]: { gt: cursor.at } },
        { [field]: cursor.at, id: { gt: cursor.id } },
      ],
    },
  ],
});

// ─── Shared lookups ──────────────────────────────────────────────────────────

const PERSON = {
  select: { firstName: true, lastName: true, preferredName: true },
} as const;

/**
 * A person's display name for notification text. Names are editable by HR; a name that reads as
 * a link (review L5) is replaced, so no notification email carries a link that the application
 * did not set.
 */
function displayName(person: {
  firstName: string | null;
  lastName: string | null;
  preferredName: string | null;
}) {
  const name = escapeValue(
    [person.preferredName || person.firstName, person.lastName]
      .filter(Boolean)
      .join(' '),
    120,
  );
  return name && !containsLink(name) ? name : 'An employee';
}

/** The active user account of an employee (none for an archived employee or no account). */
async function userOfEmployee(client: Client, employeeId: string) {
  const employee = await client.employee.findUnique({
    where: { id: employeeId },
    select: {
      archivedAt: true,
      person: { select: { user: { select: { id: true } } } },
    },
  });
  return employee && !employee.archivedAt
    ? (employee.person.user?.id ?? null)
    : null;
}

/** "HH:mm" of an instant in a time zone (UTC if the zone is invalid). */
export function localTime(instant: Date, timezone: string) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(instant);
  } catch {
    return instant.toISOString().slice(11, 16);
  }
}

/** The calendar date of an instant in a time zone (UTC if missing or invalid). */
export function localDate(instant: Date, timezone: string | null) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone ?? 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(instant);
  } catch {
    return instant.toISOString().slice(0, 10);
  }
}

const POSITION_TARGET = {
  select: {
    id: true,
    organizationId: true,
    organizationalUnitId: true,
    departmentId: true,
    teamId: true,
  },
} as const;

// ─── Leave ───────────────────────────────────────────────────────────────────

type LeaveEvent = Awaited<ReturnType<typeof leaveEventPage>>[number];

function leaveEventPage(
  client: Client,
  cursor: EventCursor,
  horizon: Date,
  take: number,
) {
  return client.leaveRequestEvent.findMany({
    where: after('occurredAt', cursor, horizon),
    orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
    take,
    select: {
      id: true,
      type: true,
      actorUserId: true,
      metadata: true,
      occurredAt: true,
      request: {
        select: {
          id: true,
          status: true,
          startDate: true,
          endDate: true,
          employeeId: true,
          employee: { select: { person: PERSON } },
          employmentAssignment: { select: { position: POSITION_TARGET } },
        },
      },
    },
  });
}

/**
 * Leave (N6, N7):
 * - SUBMITTED: the approvers of the request's assignment while it is still pending; when it
 *   was submitted on the employee's behalf, the employee too.
 * - APPROVED / REJECTED: the employee.
 * - CANCELLED (a pending withdrawal or a full cancellation): by the employee — the approvers;
 *   by someone else — the employee.
 * - AMENDED: a partial shortening is "leave changed", routed like a cancellation; a full
 *   cancellation is notified once, through its CANCELLED event.
 * Never the actor; never the leave type, reason, notes, minutes or balances.
 */
export function leaveSource(
  access: ReturnType<typeof notificationServices>['access'],
): EventSource<LeaveEvent> {
  return {
    key: 'events.leave-request',
    page: leaveEventPage,
    cursorOf: (event) => ({ at: event.occurredAt, id: event.id }),
    async notices(client, event) {
      const request = event.request;
      const position = request.employmentAssignment.position;
      const organizationId = position.organizationId;
      const employeeUser = await userOfEmployee(client, request.employeeId);
      const actor = event.actorUserId;
      const variables = {
        employeeName: displayName(request.employee.person),
        startDate: formatDate(request.startDate),
        endDate: formatDate(request.endDate),
      };
      const approvers = async () => {
        const target = (await positionTargets(client, [position])).get(
          position.id,
        )! as AuthorizationTarget;
        return (
          await access.scopedPermissionHolders('leave.approve', target, client)
        ).filter((userId) => userId !== actor && userId !== employeeUser);
      };
      const notice = (
        recipientUserId: string,
        type: string,
        link: string,
        extra: Record<string, string> = {},
      ): PublishInput => ({
        organizationId,
        recipientUserId,
        type,
        variables: { ...variables, ...extra },
        link,
        sourceEntityType: 'LeaveRequest',
        sourceEntityId: request.id,
        dedupeKey: `${type}:${event.id}`,
      });
      const toEmployee = (type: string, extra?: Record<string, string>) =>
        employeeUser && employeeUser !== actor
          ? [notice(employeeUser, type, '/leave', extra)]
          : [];
      const toApprovers = async (
        type: string,
        extra?: Record<string, string>,
      ) =>
        (await approvers()).map((userId) =>
          notice(userId, type, '/admin/leave', extra),
        );
      const byEmployee = actor !== null && actor === employeeUser;
      switch (event.type) {
        case 'SUBMITTED': {
          const notices =
            request.status === 'PENDING'
              ? await toApprovers('leave.request-submitted')
              : [];
          if (!byEmployee)
            notices.push(...toEmployee('leave.request-submitted'));
          return notices;
        }
        case 'APPROVED':
          return toEmployee('leave.request-approved');
        case 'REJECTED':
          return toEmployee('leave.request-rejected');
        case 'CANCELLED':
          return byEmployee
            ? toApprovers('leave.request-cancelled')
            : toEmployee('leave.request-cancelled');
        case 'AMENDED': {
          const metadata = (event.metadata ?? {}) as {
            type?: string;
            cancelledDates?: unknown[];
          };
          if (metadata.type !== 'SHORTEN') return [];
          const extra = {
            cancelledDayCount: String(
              Array.isArray(metadata.cancelledDates)
                ? metadata.cancelledDates.length
                : 0,
            ),
          };
          return byEmployee
            ? toApprovers('leave.request-changed', extra)
            : toEmployee('leave.request-changed', extra);
        }
        default:
          return [];
      }
    },
  };
}

// ─── Time ────────────────────────────────────────────────────────────────────

type CorrectionEvent = Awaited<ReturnType<typeof correctionPage>>[number];

function correctionPage(
  client: Client,
  cursor: EventCursor,
  horizon: Date,
  take: number,
) {
  return client.timeCorrectionRequest.findMany({
    where: {
      reviewedAt: { not: null },
      ...after('reviewedAt', cursor, horizon),
    },
    orderBy: [{ reviewedAt: 'asc' }, { id: 'asc' }],
    take,
    select: {
      id: true,
      status: true,
      requestorUserId: true,
      reviewerUserId: true,
      requestedAt: true,
      reviewedAt: true,
      employmentAssignment: { select: { position: POSITION_TARGET } },
      targetEmploymentAssignment: { select: { position: POSITION_TARGET } },
      timeEntry: {
        select: {
          employmentAssignment: { select: { position: POSITION_TARGET } },
        },
      },
    },
  });
}

/**
 * A decided time correction (N6): the requester, unless they decided it themselves (an
 * automatic approval by policy records the requester as reviewer). Never values or notes.
 */
export const correctionSource: EventSource<CorrectionEvent> = {
  key: 'events.time-correction',
  page: correctionPage,
  cursorOf: (event) => ({ at: event.reviewedAt!, id: event.id }),
  async notices(client, event) {
    if (event.status !== 'APPROVED' && event.status !== 'REJECTED') return [];
    if (!event.reviewerUserId || event.reviewerUserId === event.requestorUserId)
      return [];
    const position =
      event.employmentAssignment?.position ??
      event.targetEmploymentAssignment?.position ??
      event.timeEntry?.employmentAssignment.position;
    if (!position) return [];
    const organization = await client.organization.findUnique({
      where: { id: position.organizationId },
      select: { timezone: true },
    });
    return [
      {
        organizationId: position.organizationId,
        recipientUserId: event.requestorUserId,
        type: 'time.correction-decided',
        variables: {
          decision: event.status === 'APPROVED' ? 'approved' : 'declined',
          requestedOn: localDate(
            event.requestedAt,
            organization?.timezone ?? null,
          ),
        },
        link: '/time?tab=requests',
        sourceEntityType: 'TimeCorrectionRequest',
        sourceEntityId: event.id,
        dedupeKey: `time.correction-decided:${event.id}`,
      },
    ];
  },
};

type TimesheetEventRow = Awaited<ReturnType<typeof timesheetPage>>[number];

function timesheetPage(
  client: Client,
  cursor: EventCursor,
  horizon: Date,
  take: number,
) {
  return client.timesheetEvent.findMany({
    where: {
      type: { in: ['CHANGES_REQUESTED', 'APPROVED'] },
      ...after('occurredAt', cursor, horizon),
    },
    orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
    take,
    select: {
      id: true,
      type: true,
      actorUserId: true,
      occurredAt: true,
      timesheet: {
        select: {
          id: true,
          employeeId: true,
          timePeriod: {
            select: { organizationId: true, startDate: true, endDate: true },
          },
        },
      },
    },
  });
}

/**
 * Timesheet changes requested / timesheet approved (N6): the employee, once per event — an
 * approval is the whole-timesheet APPROVED event, not each segment; a later reopen and
 * re-approval is a new event and a new notice. Never notes or hours.
 */
export const timesheetSource: EventSource<TimesheetEventRow> = {
  key: 'events.timesheet',
  page: timesheetPage,
  cursorOf: (event) => ({ at: event.occurredAt, id: event.id }),
  async notices(client, event) {
    const { timesheet } = event;
    const employeeUser = await userOfEmployee(client, timesheet.employeeId);
    if (!employeeUser || employeeUser === event.actorUserId) return [];
    const type =
      event.type === 'APPROVED'
        ? 'time.timesheet-approved'
        : 'time.timesheet-changes-requested';
    return [
      {
        organizationId: timesheet.timePeriod.organizationId,
        recipientUserId: employeeUser,
        type,
        variables: {
          periodStart: formatDate(timesheet.timePeriod.startDate),
          periodEnd: formatDate(timesheet.timePeriod.endDate),
        },
        link: `/time?tab=timesheets&timesheet=${timesheet.id}`,
        sourceEntityType: 'Timesheet',
        sourceEntityId: timesheet.id,
        dedupeKey: `${type}:${event.id}`,
      },
    ];
  },
};

// ─── Scheduling ──────────────────────────────────────────────────────────────

type SchedulePublication = Awaited<ReturnType<typeof schedulePage>>[number];

function schedulePage(
  client: Client,
  cursor: EventCursor,
  horizon: Date,
  take: number,
) {
  return client.schedule.findMany({
    where: {
      publishedAt: { not: null },
      status: 'PUBLISHED',
      ...after('publishedAt', cursor, horizon),
    },
    orderBy: [{ publishedAt: 'asc' }, { id: 'asc' }],
    take,
    select: {
      id: true,
      organizationId: true,
      periodStart: true,
      periodEnd: true,
      publishedAt: true,
      publishedByUserId: true,
    },
  });
}

/**
 * Schedule published (N6): every employee with an active shift in it, with their own shift
 * count (never colleagues, locations or times); not the publisher. Fans out in the worker.
 */
export const scheduleSource: EventSource<SchedulePublication> = {
  key: 'events.schedule-published',
  page: schedulePage,
  cursorOf: (event) => ({ at: event.publishedAt!, id: event.id }),
  async notices(client, event) {
    const counts = await client.scheduledShift.groupBy({
      by: ['employmentAssignmentId'],
      where: { scheduleId: event.id, status: 'ACTIVE' },
      _count: { _all: true },
    });
    if (counts.length === 0) return [];
    const assignments = await client.employmentAssignment.findMany({
      where: { id: { in: counts.map((row) => row.employmentAssignmentId) } },
      select: { id: true, employeeId: true },
    });
    const employeeOf = new Map(assignments.map((a) => [a.id, a.employeeId]));
    const perEmployee = new Map<string, number>();
    for (const row of counts) {
      const employeeId = employeeOf.get(row.employmentAssignmentId);
      if (employeeId)
        perEmployee.set(
          employeeId,
          (perEmployee.get(employeeId) ?? 0) + row._count._all,
        );
    }
    const users = await client.employee.findMany({
      where: { id: { in: [...perEmployee.keys()] }, archivedAt: null },
      select: {
        id: true,
        person: { select: { user: { select: { id: true } } } },
      },
      orderBy: { id: 'asc' },
    });
    const notices: PublishInput[] = [];
    for (const employee of users) {
      const userId = employee.person.user?.id;
      if (!userId || userId === event.publishedByUserId) continue;
      notices.push({
        organizationId: event.organizationId,
        recipientUserId: userId,
        type: 'scheduling.schedule-published',
        variables: {
          periodStart: formatDate(event.periodStart),
          periodEnd: formatDate(event.periodEnd),
          shiftCount: perEmployee.get(employee.id) ?? 0,
        },
        link: '/schedule',
        sourceEntityType: 'Schedule',
        sourceEntityId: event.id,
        dedupeKey: `scheduling.schedule-published:${event.id}`,
      });
    }
    return notices;
  },
};

type ShiftRevision = Awaited<ReturnType<typeof revisionPage>>[number];

function revisionPage(
  client: Client,
  cursor: EventCursor,
  horizon: Date,
  take: number,
) {
  return client.scheduledShiftRevision.findMany({
    where: {
      revisionType: { in: ['CORRECTED', 'CANCELLED'] },
      ...after('changedAt', cursor, horizon),
    },
    orderBy: [{ changedAt: 'asc' }, { id: 'asc' }],
    take,
    select: {
      id: true,
      scheduledShiftId: true,
      revisionNumber: true,
      revisionType: true,
      employmentAssignmentId: true,
      workDate: true,
      startsAt: true,
      endsAt: true,
      timezone: true,
      changedByUserId: true,
      changedAt: true,
      scheduledShift: {
        select: { schedule: { select: { organizationId: true } } },
      },
    },
  });
}

/**
 * Shift corrected / cancelled (N6): the shift's employee, past shifts included (the record
 * changed). A correction that moved the shift to another employee tells the previous one it
 * was cancelled for them. Never the reason, location or colleagues; not the actor.
 */
export const shiftRevisionSource: EventSource<ShiftRevision> = {
  key: 'events.shift-revision',
  page: revisionPage,
  cursorOf: (event) => ({ at: event.changedAt, id: event.id }),
  async notices(client, event) {
    const organizationId = event.scheduledShift.schedule.organizationId;
    const employeeOfAssignment = async (assignmentId: string) =>
      (
        await client.employmentAssignment.findUnique({
          where: { id: assignmentId },
          select: { employeeId: true },
        })
      )?.employeeId ?? null;
    const notice = (
      recipientUserId: string,
      type: string,
      shift: { workDate: Date; startsAt: Date; endsAt: Date; timezone: string },
    ): PublishInput => ({
      organizationId,
      recipientUserId,
      type,
      variables: {
        workDate: formatDate(shift.workDate),
        startTime: localTime(shift.startsAt, shift.timezone),
        endTime: localTime(shift.endsAt, shift.timezone),
        timezone: shift.timezone,
      },
      link: '/schedule',
      sourceEntityType: 'ScheduledShift',
      sourceEntityId: event.scheduledShiftId,
      dedupeKey: `${type}:${event.id}`,
    });
    const notices: PublishInput[] = [];
    const employeeId = await employeeOfAssignment(event.employmentAssignmentId);
    const userId = employeeId ? await userOfEmployee(client, employeeId) : null;
    const type =
      event.revisionType === 'CANCELLED'
        ? 'scheduling.shift-cancelled'
        : 'scheduling.shift-corrected';
    if (userId && userId !== event.changedByUserId)
      notices.push(notice(userId, type, event));
    if (event.revisionType === 'CORRECTED') {
      const previous = await client.scheduledShiftRevision.findUnique({
        where: {
          scheduledShiftId_revisionNumber: {
            scheduledShiftId: event.scheduledShiftId,
            revisionNumber: event.revisionNumber - 1,
          },
        },
        select: {
          employmentAssignmentId: true,
          workDate: true,
          startsAt: true,
          endsAt: true,
          timezone: true,
        },
      });
      if (
        previous &&
        previous.employmentAssignmentId !== event.employmentAssignmentId
      ) {
        const previousEmployee = await employeeOfAssignment(
          previous.employmentAssignmentId,
        );
        const previousUser =
          previousEmployee && previousEmployee !== employeeId
            ? await userOfEmployee(client, previousEmployee)
            : null;
        if (previousUser && previousUser !== event.changedByUserId)
          notices.push(
            notice(previousUser, 'scheduling.shift-cancelled', previous),
          );
      }
    }
    return notices;
  },
};

// ─── Payroll ─────────────────────────────────────────────────────────────────

type PayrollFinalization = Awaited<ReturnType<typeof payrollPage>>[number];

function payrollPage(
  client: Client,
  cursor: EventCursor,
  horizon: Date,
  take: number,
) {
  return client.payrollRun.findMany({
    where: {
      status: 'FINALIZED',
      finalizedAt: { not: null },
      ...after('finalizedAt', cursor, horizon),
    },
    orderBy: [{ finalizedAt: 'asc' }, { id: 'asc' }],
    take,
    select: {
      id: true,
      organizationId: true,
      finalizedAt: true,
      period: { select: { periodStart: true, periodEnd: true, payDate: true } },
    },
  });
}

/**
 * Payroll finalized (N6): every employee of the run that their pay statement is available —
 * dates only, never amounts. One notice per run employee (the payslip), however often the job
 * runs. Fans out in the worker, never in the 120-second finalization transaction.
 */
export const payrollSource: EventSource<PayrollFinalization> = {
  key: 'events.payroll-finalized',
  page: payrollPage,
  cursorOf: (event) => ({ at: event.finalizedAt!, id: event.id }),
  async notices(client, event) {
    const rows = await client.payrollRunEmployee.findMany({
      where: { payrollRunId: event.id },
      select: {
        id: true,
        employee: {
          select: {
            archivedAt: true,
            person: { select: { user: { select: { id: true } } } },
          },
        },
      },
      orderBy: { id: 'asc' },
    });
    const notices: PublishInput[] = [];
    for (const row of rows) {
      const userId = row.employee.archivedAt
        ? null
        : row.employee.person.user?.id;
      if (!userId) continue;
      notices.push({
        organizationId: event.organizationId,
        recipientUserId: userId,
        type: 'payroll.payslip-available',
        variables: {
          periodStart: formatDate(event.period.periodStart),
          periodEnd: formatDate(event.period.periodEnd),
          payDate: formatDate(event.period.payDate),
        },
        link: '/pay',
        sourceEntityType: 'PayrollRunEmployee',
        sourceEntityId: row.id,
        dedupeKey: `payroll.payslip-available:${row.id}`,
      });
    }
    return notices;
  },
};

// ─── Benefits ────────────────────────────────────────────────────────────────

/** Benefits audit actions that change an employee's elections (one entry per election). */
export const BENEFIT_ELECTION_ACTIONS = [
  'BENEFIT_ENROLLED',
  'BENEFIT_WAIVED',
  'BENEFIT_ELECTION_CHANGED',
  'BENEFIT_ELECTION_ENDED',
  'BENEFIT_ELECTION_TRANSFERRED',
  'BENEFIT_ELECTION_CORRECTED',
  'BENEFIT_ELECTION_RESCINDED',
  // Batch 8: one entry per election a plan discontinuation ended or rescinded.
  'BENEFIT_ELECTION_DISCONTINUED',
] as const;

type BenefitAudit = Awaited<ReturnType<typeof benefitPage>>[number];

function benefitPage(
  client: Client,
  cursor: EventCursor,
  horizon: Date,
  take: number,
) {
  return client.auditLog.findMany({
    where: {
      entityType: 'BenefitEnrollment',
      action: { in: [...BENEFIT_ELECTION_ACTIONS] },
      ...after('occurredAt', cursor, horizon),
    },
    orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
    take,
    select: {
      id: true,
      action: true,
      actorUserId: true,
      entityId: true,
      metadata: true,
      occurredAt: true,
    },
  });
}

/**
 * Benefit election changed (N6) — enrollment, waiver, change, end, sponsor transfer,
 * correction, rescission and plan discontinuation: the employee, with the effective date only
 * (never plan or option names, costs, dependents, reasons or HR notes); not the actor.
 */
export const benefitSource: EventSource<BenefitAudit> = {
  key: 'events.benefit-election',
  page: benefitPage,
  cursorOf: (event) => ({ at: event.occurredAt, id: event.id }),
  async notices(client, event) {
    if (!event.entityId) return [];
    const election = await client.benefitEnrollment.findUnique({
      where: { id: event.entityId },
      select: {
        id: true,
        employeeId: true,
        coverageStart: true,
        coverageEnd: true,
        organizationId: true,
      },
    });
    if (!election) return [];
    const userId = await userOfEmployee(client, election.employeeId);
    if (!userId || userId === event.actorUserId) return [];
    // The dates the audit entry recorded (the election may have changed since): an end's
    // coverageEnd, a discontinuation's effectiveTo, else the coverage start of the record.
    const metadata = (event.metadata ?? {}) as {
      outcome?: string;
      coverageStart?: string | null;
      coverageEnd?: string | null;
      effectiveTo?: string | null;
    };
    const recorded = (value: string | null | undefined) =>
      typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
        ? value
        : null;
    const effective =
      event.action === 'BENEFIT_ELECTION_ENDED'
        ? (recorded(metadata.coverageEnd) ??
          (election.coverageEnd ? formatDate(election.coverageEnd) : null))
        : event.action === 'BENEFIT_ELECTION_DISCONTINUED' &&
            metadata.outcome === 'ENDED'
          ? (recorded(metadata.effectiveTo) ??
            (election.coverageEnd ? formatDate(election.coverageEnd) : null))
          : null;
    const effectiveDate =
      effective ??
      recorded(metadata.coverageStart) ??
      formatDate(election.coverageStart);
    return [
      {
        organizationId: election.organizationId,
        recipientUserId: userId,
        type: 'benefits.election-changed',
        variables: { effectiveDate },
        link: '/benefits',
        sourceEntityType: 'BenefitEnrollment',
        sourceEntityId: election.id,
        dedupeKey: `benefits.election-changed:${event.id}`,
      },
    ];
  },
};

// ─── Runner ──────────────────────────────────────────────────────────────────

export const EVENT_SOURCE_KEYS = [
  'events.leave-request',
  'events.time-correction',
  'events.timesheet',
  'events.schedule-published',
  'events.shift-revision',
  'events.payroll-finalized',
  'events.benefit-election',
] as const;

/**
 * Publishes the notifications of committed business events (see the module comment).
 * Failures are reported per source; the checkpoint stays before the failed event, so the job
 * fails and the next run retries it (idempotently).
 */
export class EventNotificationPublisher {
  private readonly logger = new Logger('EventNotifications');
  private readonly services: ReturnType<typeof notificationServices>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: { now(): Date } = new NotificationsClock(),
  ) {
    this.services = notificationServices(prisma, { now: () => clock.now() });
  }

  sources(): EventSource<unknown>[] {
    return [
      leaveSource(this.services.access),
      correctionSource,
      timesheetSource,
      scheduleSource,
      shiftRevisionSource,
      payrollSource,
      benefitSource,
    ] as EventSource<unknown>[];
  }

  async run(
    options: {
      /** Overrides the computed horizon (tests: their own open transaction holds it back). */
      horizon?: Date;
      /** Overrides HORIZON_MARGIN_MS for the computed horizon (tests). */
      horizonMarginMs?: number;
      /** Restricts the run to some sources (operations and tests). */
      sources?: readonly string[];
      pageSize?: number;
      /** Events per source and run; the rest waits for the next run. */
      maxEvents?: number;
    } = {},
  ): Promise<PublishEventsOutcome> {
    let horizon = options.horizon;
    if (!horizon) {
      const computed = await eventHorizon(this.prisma, options.horizonMarginMs);
      horizon = computed.horizon;
      const lag = computed.now.getTime() - horizon.getTime();
      if (lag > HORIZON_LAG_WARNING_MS)
        this.logger.warn(
          `Event notifications are ${Math.round(lag / 60_000)} minutes behind: a long-open database transaction holds the horizon back.`,
        );
    }
    const pageSize = Math.min(Math.max(options.pageSize ?? 100, 1), 500);
    const maxEvents = Math.max(options.maxEvents ?? 2_000, 1);
    const outcome: PublishEventsOutcome = {
      horizon: horizon.toISOString(),
      sources: [],
    };
    for (const source of this.sources()) {
      if (options.sources && !options.sources.includes(source.key)) continue;
      outcome.sources.push(
        await this.runSource(source, horizon, pageSize, maxEvents),
      );
    }
    return outcome;
  }

  private async runSource(
    source: EventSource<unknown>,
    horizon: Date,
    pageSize: number,
    maxEvents: number,
  ): Promise<EventSourceOutcome> {
    const outcome: EventSourceOutcome = {
      source: source.key,
      bootstrapped: false,
      events: 0,
      created: 0,
      existing: 0,
      skipped: 0,
      failed: [],
      cursor: null,
    };
    const checkpoint =
      await this.prisma.notificationProducerCheckpoint.findUnique({
        where: { producerKey: source.key },
      });
    if (!checkpoint) {
      // Bootstrap: start at the horizon; nothing recorded before it is ever notified.
      await this.prisma.notificationProducerCheckpoint.createMany({
        data: [
          {
            producerKey: source.key,
            cursorAt: horizon,
            cursorId: BOOTSTRAP_CURSOR_ID,
          },
        ],
        skipDuplicates: true,
      });
      outcome.bootstrapped = true;
      outcome.cursor = { at: horizon.toISOString(), id: BOOTSTRAP_CURSOR_ID };
      return outcome;
    }
    let cursor: EventCursor = {
      at: checkpoint.cursorAt,
      id: checkpoint.cursorId,
    };
    const save = async () => {
      // Forward only (the table's guard refuses moving back): a slower concurrent run never
      // rewinds a checkpoint another run advanced.
      await this.prisma.notificationProducerCheckpoint.updateMany({
        where: {
          producerKey: source.key,
          OR: [
            { cursorAt: { lt: cursor.at } },
            { cursorAt: cursor.at, cursorId: { lt: cursor.id } },
          ],
        },
        data: { cursorAt: cursor.at, cursorId: cursor.id },
      });
      outcome.cursor = { at: cursor.at.toISOString(), id: cursor.id };
    };
    pages: while (outcome.events < maxEvents) {
      const events = await source.page(
        this.prisma,
        cursor,
        horizon,
        Math.min(pageSize, maxEvents - outcome.events),
      );
      if (events.length === 0) break;
      for (const event of events) {
        try {
          await this.publishEvent(source, event, outcome);
        } catch (error) {
          outcome.failed.push({
            message: `${source.key} ${source.cursorOf(event).id}: ${
              error instanceof Error ? error.message : String(error)
            }`.slice(0, 500),
          });
          break pages;
        }
        cursor = source.cursorOf(event);
        outcome.events += 1;
      }
      await save();
      if (events.length < pageSize) break;
    }
    await save();
    return outcome;
  }

  private async publishEvent(
    source: EventSource<unknown>,
    event: unknown,
    outcome: EventSourceOutcome,
  ) {
    const notices = await source.notices(this.prisma, event);
    if (notices.length === 0) return;
    // A repeated (partially processed) fan-out skips what already exists in one query.
    const existing = new Set<string>();
    for (let index = 0; index < notices.length; index += 1_000) {
      const chunk = notices.slice(index, index + 1_000);
      const rows = await this.prisma.notification.findMany({
        where: {
          OR: chunk.map((notice) => ({
            organizationId: notice.organizationId,
            recipientUserId: notice.recipientUserId,
            dedupeKey: notice.dedupeKey,
          })),
        },
        select: {
          organizationId: true,
          recipientUserId: true,
          dedupeKey: true,
        },
      });
      for (const row of rows)
        existing.add(
          `${row.organizationId}|${row.recipientUserId}|${row.dedupeKey}`,
        );
    }
    for (const notice of notices) {
      if (
        existing.has(
          `${notice.organizationId}|${notice.recipientUserId}|${notice.dedupeKey}`,
        )
      ) {
        outcome.existing += 1;
        continue;
      }
      // Throws on an internal failure: the event (and the checkpoint) is retried next run.
      const result = await this.services.notifications.publish(notice);
      if (result.outcome === 'CREATED') outcome.created += 1;
      else if (result.outcome === 'EXISTING') outcome.existing += 1;
      else outcome.skipped += 1;
    }
  }
}
