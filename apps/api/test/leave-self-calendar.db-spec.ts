import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service.js';
import { LeaveSelfCalendarService } from '../src/leave/leave-self-calendar.service.js';
import {
  FixedClock,
  LEAVE_PERMISSIONS,
  LEAVE_USERS,
  leaveServices,
  seedLeaveConfig,
  TIME_PERMISSIONS,
  type LeaveServices,
} from './support/leave-fixtures.js';
import {
  createSchedulingFixtures,
  ctx,
  rejection,
  rollbackClient,
  type SchedulingFixtures,
  type Tx,
} from './support/scheduling-fixtures.js';

config({ path: '../../.env' });

class RollbackFixtures extends Error {}

interface Harness {
  tx: Tx;
  fx: SchedulingFixtures;
  svc: LeaveServices;
  calendar: LeaveSelfCalendarService;
  types: Awaited<ReturnType<typeof seedLeaveConfig>>;
  /** Records approved leave (HR, on behalf) for an assignment over the dates. */
  approved: (assignment: string, from: string, to?: string) => Promise<string>;
}

const MARCH = { from: '2027-03-01', to: '2027-03-31' };
const d = (date: string) => new Date(`${date}T00:00:00.000Z`);
const status = async (promise: Promise<unknown>) =>
  ((await rejection(promise)) as { getStatus(): number }).getStatus();

/**
 * Batch 6B (D4, D6) — the employee team calendar and holiday reads. Team calendar: names and
 * "Absent" only; approved, uncancelled leave; one entry per colleague and day however many
 * assignments or requests overlap; a colleague's day only when both people hold an assignment
 * covering that day in the same team; no team, no colleagues. Holidays: by the viewer's own
 * assignments covering the holiday's date, organization isolated.
 */
describe('Leave self-service calendar and holidays (database)', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService(process.env.DATABASE_URL!);
    await prisma.$connect();
  });
  afterAll(async () => {
    await prisma?.$disconnect();
  });

  async function scenario(run: (h: Harness) => Promise<void>) {
    await expect(
      prisma.$transaction(
        async (tx) => {
          const fx = await createSchedulingFixtures(tx, LEAVE_USERS, [
            ...LEAVE_PERMISSIONS,
            ...TIME_PERMISSIONS,
          ]);
          const client = rollbackClient(tx);
          const svc = leaveServices(client, new FixedClock());
          const types = await seedLeaveConfig(tx, fx, svc);
          const calendar = new LeaveSelfCalendarService(client, svc.access);
          const hr = ctx(fx.users.hr!);
          await run({
            tx,
            fx,
            svc,
            calendar,
            types,
            approved: async (assignment, from, to = from) =>
              (
                await svc.requests.createOnBehalf(
                  fx.users.hr!,
                  {
                    employmentAssignmentId: assignment,
                    leaveTypeId: types.personal.id,
                    startDate: from,
                    endDate: to,
                    approve: true,
                    note: 'Private note: medical appointment',
                  },
                  hr,
                )
              ).requestId,
          }).catch((error: unknown) => {
            console.error('SCENARIO FAILURE', error);
            throw error;
          });
          throw new RollbackFixtures();
        },
        { timeout: 60_000 },
      ),
    ).rejects.toBeInstanceOf(RollbackFixtures);
  }

  const nameOf = async (tx: Tx, employeeId: string) => {
    const employee = await tx.employee.findUniqueOrThrow({
      where: { id: employeeId },
      include: { person: true },
    });
    return [
      employee.person.preferredName ?? employee.person.firstName,
      employee.person.lastName,
    ]
      .filter(Boolean)
      .join(' ');
  };

  it('shows teammates\' approved leave as a name and "Absent" only — nothing else', async () => {
    await scenario(async ({ tx, fx, svc, calendar, approved, types }) => {
      await approved(fx.otherTeamA, '2027-03-03', '2027-03-04');
      // Pending and rejected leave never show.
      const pending = await svc.requests.submitOwn(
        fx.selfUser2,
        {
          employmentAssignmentId: fx.otherTeamA,
          leaveTypeId: types.personal.id,
          startDate: '2027-03-15',
          endDate: '2027-03-15',
          reason: 'Private reason',
        },
        ctx(fx.selfUser2),
      );
      expect(pending.status).toBe('PENDING');
      const rejected = await svc.requests.submitOwn(
        fx.selfUser2,
        {
          employmentAssignmentId: fx.otherTeamA,
          leaveTypeId: types.personal.id,
          startDate: '2027-03-16',
          endDate: '2027-03-16',
        },
        ctx(fx.selfUser2),
      );
      await svc.requests.reject(
        fx.users.hr!,
        rejected.requestId,
        { note: 'No' },
        ctx(fx.users.hr!),
      );
      // A day cancelled by an amendment no longer shows.
      const amended = await approved(fx.otherTeamA, '2027-03-22', '2027-03-23');
      await svc.requests.amend(
        fx.users.hr!,
        amended,
        { cancelDates: ['2027-03-23'], reason: 'Came in' },
        ctx(fx.users.hr!),
      );

      const view = await calendar.teamCalendar(fx.selfUser1, MARCH);
      expect(view).toEqual({
        range: MARCH,
        teams: [expect.any(String)],
        hasTeam: true,
        people: [
          {
            displayName: await nameOf(tx, fx.employee2),
            self: false,
            absences: [
              { date: '2027-03-03', label: 'Absent' },
              { date: '2027-03-04', label: 'Absent' },
              { date: '2027-03-22', label: 'Absent' },
            ],
          },
        ],
      });
      // No type, reason, note, class, status, request/assignment/employee id or minutes.
      const text = JSON.stringify(view);
      for (const hidden of [
        'Personal',
        'PERS',
        'UNPAID',
        'APPROVED',
        'PENDING',
        'Private',
        'medical',
        'minutes',
        fx.employee2,
        fx.otherTeamA,
        types.personal.id,
      ]) {
        expect(text).not.toContain(hidden);
      }
    });
  });

  it("lists one's own leave as You, and each colleague once per day however many assignments or requests overlap", async () => {
    await scenario(async ({ tx, fx, calendar, approved }) => {
      const team = await tx.position.findUniqueOrThrow({
        where: { id: fx.positionTeamA },
      });
      const second = await tx.position.create({
        data: {
          organizationId: team.organizationId,
          jobTitleId: team.jobTitleId,
          organizationalUnitId: team.organizationalUnitId,
          departmentId: team.departmentId,
          teamId: team.teamId,
          name: `Team A Second ${fx.suffix}`,
          code: `TA2-${fx.suffix}`,
        },
      });
      const secondAssignment = await tx.employmentAssignment.create({
        data: {
          employeeId: fx.employee2,
          positionId: second.id,
          employmentType: 'PART_TIME',
          status: 'ACTIVE',
          isPrimary: false,
          startDate: d('2026-01-01'),
        },
      });
      await approved(fx.otherTeamA, '2027-03-03');
      await approved(secondAssignment.id, '2027-03-03', '2027-03-04');
      await approved(fx.assignmentTeamA, '2027-03-09');

      const view = await calendar.teamCalendar(fx.selfUser1, MARCH);
      expect(view.people).toEqual([
        {
          displayName: 'You',
          self: true,
          absences: [{ date: '2027-03-09', label: 'Absent' }],
        },
        {
          displayName: await nameOf(tx, fx.employee2),
          self: false,
          absences: [
            { date: '2027-03-03', label: 'Absent' },
            { date: '2027-03-04', label: 'Absent' },
          ],
        },
      ]);
    });
  });

  it('follows team membership day by day: no past or future team information from sharing a team today', async () => {
    await scenario(async ({ tx, fx, calendar, approved }) => {
      await approved(fx.otherTeamA, '2027-03-03');
      await approved(fx.otherTeamA, '2027-03-10');
      await approved(fx.otherTeamA, '2027-03-24');
      // The viewer joined Team A on 03-08 (before that, Dept B only).
      await tx.employmentAssignment.update({
        where: { id: fx.assignmentTeamA },
        data: { startDate: d('2027-03-08') },
      });
      // The colleague left Team A after 03-20.
      await tx.employmentAssignment.update({
        where: { id: fx.otherTeamA },
        data: { endDate: d('2027-03-20') },
      });
      const view = await calendar.teamCalendar(fx.selfUser1, MARCH);
      expect(view.people.map((p) => p.absences.map((a) => a.date))).toEqual([
        ['2027-03-10'],
      ]);
      // A cancelled assignment carries no team membership.
      await tx.employmentAssignment.update({
        where: { id: fx.assignmentTeamA },
        data: { status: 'CANCELLED' },
      });
      const noTeam = await calendar.teamCalendar(fx.selfUser1, MARCH);
      expect(noTeam).toMatchObject({ hasTeam: false, teams: [], people: [] });
    });
  });

  it('refuses callers without leave.request, organizations with Leave off and over-long ranges', async () => {
    await scenario(async ({ tx, fx, calendar }) => {
      // HR and an approver who are not employees.
      expect(await status(calendar.teamCalendar(fx.users.hr!, MARCH))).toBe(
        403,
      );
      expect(
        await status(calendar.holidays(fx.users.teamApprover!, MARCH)),
      ).toBe(403);
      expect(
        await status(
          calendar.teamCalendar(fx.selfUser1, {
            from: '2027-03-01',
            to: '2027-05-15',
          }),
        ),
      ).toBe(400);
      expect(
        await status(
          calendar.teamCalendar(fx.selfUser1, {
            from: '2027-03-10',
            to: '2027-03-01',
          }),
        ),
      ).toBe(400);
      await tx.organizationModuleSetting.create({
        data: { organizationId: fx.orgA, module: 'LEAVE', enabled: false },
      });
      expect(await status(calendar.teamCalendar(fx.selfUser1, MARCH))).toBe(
        403,
      );
      expect(await status(calendar.holidays(fx.selfUser1, MARCH))).toBe(403);
    });
  });

  it("returns the holidays that apply to the viewer's own assignments on their dates, organization isolated", async () => {
    await scenario(async ({ tx, fx, svc }) => {
      const calendar = new LeaveSelfCalendarService(
        rollbackClient(tx),
        svc.access,
      );
      const hr = ctx(fx.users.hr!);
      const holiday = (
        date: string,
        name: string,
        scope: Record<string, string> = {},
        organizationId = fx.orgA,
        actor = hr,
      ) =>
        svc.holidays.create(
          {
            organizationId,
            date,
            name,
            kind: 'STATUTORY_HOLIDAY',
            ...scope,
          } as never,
          actor,
        );
      await holiday('2027-03-10', 'Org day');
      await holiday('2027-03-11', 'Team A day', { teamId: fx.teamA });
      await holiday('2027-03-12', 'Dept B day', { departmentId: fx.deptB });
      const archived = await holiday('2027-03-15', 'Archived day');
      await svc.holidays.archive(archived.id, hr);
      await holiday(
        '2027-03-16',
        'Other org day',
        {},
        fx.orgB,
        ctx(fx.users.outsider!),
      );
      // The colleague leaves Team A after 03-10.
      await tx.employmentAssignment.update({
        where: { id: fx.otherTeamA },
        data: { endDate: d('2027-03-10') },
      });

      const names = async (user: string) =>
        (await calendar.holidays(user, MARCH)).items.map((h) => h.name);
      // Team A and Dept B assignments: all three of Org A.
      expect(await names(fx.selfUser1)).toEqual([
        'Org day',
        'Team A day',
        'Dept B day',
      ]);
      // Team A only, ended on 03-10: the Team A day falls after it.
      expect(await names(fx.selfUser2)).toEqual(['Org day']);
      expect((await calendar.holidays(fx.selfUser1, MARCH)).items[0]).toEqual({
        date: '2027-03-10',
        name: 'Org day',
        kind: 'STATUTORY_HOLIDAY',
        organizationName: expect.any(String),
      });
    });
  });

  it('L1: a pending request of an archived leave type offers no approval and says why (reject still offered)', async () => {
    await scenario(async ({ fx, svc, types }) => {
      const submitted = await svc.requests.submitOwn(
        fx.selfUser1,
        {
          employmentAssignmentId: fx.assignmentTeamA,
          leaveTypeId: types.personal.id,
          startDate: '2027-03-17',
          endDate: '2027-03-17',
        },
        ctx(fx.selfUser1),
      );
      const actionsBefore = (
        await svc.views.requestDetail(fx.users.hr!, submitted.requestId)
      ).actions;
      expect(actionsBefore).toMatchObject({
        canApprove: true,
        canReject: true,
      });
      await svc.config.archiveType(types.personal.id, ctx(fx.users.hr!));

      const detail = await svc.views.requestDetail(
        fx.users.hr!,
        submitted.requestId,
      );
      expect(detail.actions).toMatchObject({
        canApprove: false,
        canReject: true,
      });
      expect(detail.leaveType).toMatchObject({ archived: true });
      const queued = (
        await svc.views.queue(fx.users.hr!, {
          organizationId: fx.orgA,
          status: 'PENDING',
        } as never)
      ).items.find((item) => item.id === submitted.requestId)!;
      expect(queued.actions).toMatchObject({
        canApprove: false,
        canReject: true,
      });
      expect(queued.leaveType).toMatchObject({ archived: true });
      // The API refuses approval as before; rejection works.
      expect(
        await status(
          svc.requests.approve(
            fx.users.hr!,
            submitted.requestId,
            {},
            ctx(fx.users.hr!),
          ),
        ),
      ).toBe(400);
      await svc.requests.reject(
        fx.users.hr!,
        submitted.requestId,
        { note: 'Type withdrawn' },
        ctx(fx.users.hr!),
      );
    });
  });
});
