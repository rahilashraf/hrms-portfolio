import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service.js';
import {
  createSchedulingFixtures,
  type SchedulingFixtures,
  type Tx,
} from './support/scheduling-fixtures.js';
import {
  afterPeriodEnd,
  FixedClock,
  LIVE_TIME_POLICY,
  seedTimePolicy,
  TIME_PERMISSIONS,
  toronto,
} from './support/time-fixtures.js';
import { withTimeHttp, type TimeHttp } from './support/time-http.js';
import {
  addOrganizationBAssignment,
  closedEntry,
} from './support/time-world.js';

config({ path: '../../.env' });

class RollbackFixtures extends Error {}

const USERS = {
  self1: [
    { permissions: ['time.clock'], scope: 'org' as const },
    { permissions: ['time.clock'], scope: 'orgB' as const },
  ],
  self2: [{ permissions: ['time.clock'], scope: 'org' as const }],
  managerA: [{ permissions: TIME_PERMISSIONS, scope: 'org' as const }],
  /** Time permissions in both organizations. */
  managerAB: [
    { permissions: TIME_PERMISSIONS, scope: 'org' as const },
    { permissions: TIME_PERMISSIONS, scope: 'orgB' as const },
  ],
  /** Team A only: views attendance and approves its timesheets. */
  teamManager: [
    {
      permissions: ['time.view', 'time.timesheet.approve'],
      scope: 'teamA' as const,
    },
  ],
  /** Approves timesheets in Organization A, without time.view (decision D4). */
  approverOnly: [
    { permissions: ['time.timesheet.approve'], scope: 'org' as const },
  ],
  /** Manages Team A's timesheets (lock, reopen), not the organization's periods. */
  teamTimesheetManager: [
    { permissions: ['time.timesheet.manage'], scope: 'teamA' as const },
  ],
  outsider: [{ permissions: ['schedule.read'], scope: 'org' as const }],
};

interface Harness {
  tx: Tx;
  fx: SchedulingFixtures;
  clock: FixedClock;
  http: TimeHttp;
  orgBAssignment: string;
}

type Page<T> = { items: T[]; nextAfterId: string | null };

/**
 * Batch 4E-1 — the manager review contracts (decisions G1–G4) over HTTP against the real
 * database: organization, employee and period filters applied inside the reader's authorization
 * before paging; reviewer and actor names; each entry's automatic deduction and payable minutes
 * from the one Batch 4D calculation; the organization picker's review capabilities.
 */
describe(
  'Manager attendance review contracts (Batch 4E-1, database, HTTP)',
  { timeout: 120_000 },
  () => {
    let prisma: PrismaService;

    beforeAll(async () => {
      prisma = new PrismaService(process.env.DATABASE_URL!);
      await prisma.$connect();
    });

    afterAll(async () => {
      await prisma?.$disconnect();
    });

    async function scenario(
      run: (h: Harness) => Promise<void>,
      policy: Record<string, unknown> = LIVE_TIME_POLICY,
    ) {
      await expect(
        prisma.$transaction(
          async (tx) => {
            const fx = await createSchedulingFixtures(tx, USERS, [
              ...TIME_PERMISSIONS,
            ]);
            await tx.organization.update({
              where: { id: fx.orgA },
              data: { timezone: 'America/Toronto' },
            });
            await seedTimePolicy(tx, fx.orgA, policy);
            const orgB = await addOrganizationBAssignment(tx, fx);
            const clock = new FixedClock();
            await withTimeHttp(tx, clock, (http) =>
              run({ tx, fx, clock, http, orgBAssignment: orgB.assignmentId }),
            ).catch((error: unknown) => {
              console.error('SCENARIO FAILURE', error);
              throw error;
            });
            throw new RollbackFixtures();
          },
          { timeout: 110_000 },
        ),
      ).rejects.toBeInstanceOf(RollbackFixtures);
    }

    /** Every item of a list, following nextAfterId; fails on a repeated id. */
    async function allPages<T extends { id: string }>(
      user: Awaited<ReturnType<TimeHttp['as']>>,
      path: string,
    ) {
      const items: T[] = [];
      let afterId: string | null = null;
      for (let guard = 0; guard < 50; guard += 1) {
        const separator = path.includes('?') ? '&' : '?';
        const response = await user
          .get(`${path}${afterId ? `${separator}afterId=${afterId}` : ''}`)
          .expect(200);
        const page = response.body as Page<T>;
        items.push(...page.items);
        afterId = page.nextAfterId;
        if (!afterId) break;
      }
      expect(new Set(items.map((item) => item.id)).size).toBe(items.length);
      return items;
    }

    /** Closed entries: Employee 1 in Team A (6 days), Dept B (3) and Organization B (3); Employee 2 in Team A (2). */
    async function world(h: Harness) {
      const { tx, fx } = h;
      const entry = (
        employeeId: string,
        employmentAssignmentId: string,
        day: string,
        from = '09:00',
        to = '12:00',
      ) =>
        closedEntry(tx, {
          employeeId,
          employmentAssignmentId,
          clockInAt: toronto(`${day}T${from}`),
          clockOutAt: toronto(`${day}T${to}`),
          workDate: day,
        });
      const ids = {
        teamA: [] as string[],
        deptB: [] as string[],
        orgB: [] as string[],
        other: [] as string[],
      };
      for (const day of ['01', '02', '03', '04', '05', '06']) {
        ids.teamA.push(
          (await entry(fx.employee1, fx.assignmentTeamA, `2027-03-${day}`)).id,
        );
      }
      for (const day of ['02', '03', '04']) {
        ids.deptB.push(
          (
            await entry(
              fx.employee1,
              fx.assignmentDeptB,
              `2027-03-${day}`,
              '13:00',
              '15:00',
            )
          ).id,
        );
        ids.orgB.push(
          (
            await entry(
              fx.employee1,
              h.orgBAssignment,
              `2027-03-${day}`,
              '16:00',
              '18:00',
            )
          ).id,
        );
      }
      for (const day of ['02', '03']) {
        ids.other.push(
          (await entry(fx.employee2, fx.otherTeamA, `2027-03-${day}`)).id,
        );
      }
      return ids;
    }

    const sorted = (values: string[]) => [...values].sort();

    it('filters management lists by organization and employee inside the reader’s authorization, before paging', async () => {
      await scenario(async (h) => {
        const { fx, http } = h;
        const ids = await world(h);
        const managerAB = await http.as(fx.users.managerAB!);
        const managerA = await http.as(fx.users.managerA!);
        const teamManager = await http.as(fx.users.teamManager!);
        const window = 'startDate=2027-03-01&endDate=2027-03-07&limit=2';

        // Organization A, two at a time: every one of its entries exactly once, none of B's.
        const orgA = await allPages<{
          id: string;
          assignment: { organization: { id: string } };
        }>(
          managerAB,
          `/time/manage/entries?organizationId=${fx.orgA}&${window}`,
        );
        expect(sorted(orgA.map((item) => item.id))).toEqual(
          sorted([...ids.teamA, ...ids.deptB, ...ids.other]),
        );
        expect(
          orgA.every((item) => item.assignment.organization.id === fx.orgA),
        ).toBe(true);
        const orgB = await allPages<{ id: string }>(
          managerAB,
          `/time/manage/entries?organizationId=${fx.orgB}&${window}`,
        );
        expect(sorted(orgB.map((item) => item.id))).toEqual(sorted(ids.orgB));

        // An organization the reader holds nothing in: an empty page, never its rows.
        for (const path of [
          'entries',
          'current',
          'exceptions',
          'corrections',
          'timesheets',
        ]) {
          expect(
            (
              await managerA
                .get(`/time/manage/${path}?organizationId=${fx.orgB}`)
                .expect(200)
            ).body,
          ).toEqual({ items: [], nextAfterId: null });
        }

        // The employee filter is exact (no "contains" match on another employee).
        const second = await allPages<{ employeeId: string; id: string }>(
          managerA,
          `/time/manage/entries?employeeId=${fx.employee2}&${window}`,
        );
        expect(sorted(second.map((item) => item.id))).toEqual(
          sorted(ids.other),
        );

        // A Team A manager pages through only what Team A lets them read: Dept B rows in the scan
        // are skipped before the page is cut, and no readable row is lost or repeated.
        const team = await allPages<{ id: string }>(
          teamManager,
          `/time/manage/entries?organizationId=${fx.orgA}&${window}`,
        );
        expect(sorted(team.map((item) => item.id))).toEqual(
          sorted([...ids.teamA, ...ids.other]),
        );

        // Filters are validated.
        await managerA
          .get('/time/manage/entries?organizationId=not-a-uuid')
          .expect(400);
        await managerA
          .get('/time/manage/timesheets?timePeriodId=nope')
          .expect(400);
        await managerA.get('/time/manage/exceptions?type=NO_SHOW').expect(200);
        await managerA
          .get('/time/manage/exceptions?type=RECORDED_AFTER_APPROVAL')
          .expect(200);
      });
    });

    it('never lets an employee read another employee’s entries through the new filters', async () => {
      await scenario(async (h) => {
        const { fx, http } = h;
        const ids = await world(h);
        const employee = await http.as(fx.selfUser1);
        const own = await allPages<{ id: string; employeeId: string }>(
          employee,
          `/time/me/entries?employeeId=${fx.employee2}&organizationId=${fx.orgA}&limit=5`,
        );
        expect(own.every((item) => item.employeeId === fx.employee1)).toBe(
          true,
        );
        // Batch 4E-3 (C2): the organization filter narrows the caller's own entries (it used
        // to be ignored); employeeId still never reaches anyone else's.
        expect(sorted(own.map((item) => item.id))).toEqual(
          sorted([...ids.teamA, ...ids.deptB]),
        );
        const everything = await allPages<{ id: string; employeeId: string }>(
          employee,
          `/time/me/entries?employeeId=${fx.employee2}&limit=5`,
        );
        expect(sorted(everything.map((item) => item.id))).toEqual(
          sorted([...ids.teamA, ...ids.deptB, ...ids.orgB]),
        );
      });
    });

    it('filters exceptions, corrections and timesheets by organization, employee and period', async () => {
      await scenario(async (h) => {
        const { fx, http, tx, clock } = h;
        const ids = await world(h);
        const managerAB = await http.as(fx.users.managerAB!);
        const employee = await http.as(fx.selfUser1);

        // Exceptions on Organization A's and Organization B's entries.
        const exception = (
          timeEntryId: string,
          employmentAssignmentId: string,
        ) =>
          tx.attendanceException.create({
            data: {
              employeeId: fx.employee1,
              employmentAssignmentId,
              timeEntryId,
              type: 'LONG_SHIFT',
              severity: 'REVIEW',
              workflowImpact: 'NON_BLOCKING',
              detectedAt: toronto('2027-03-04T20:00'),
            },
          });
        const exceptionA = await exception(ids.teamA[2]!, fx.assignmentTeamA);
        const exceptionB = await exception(ids.orgB[0]!, h.orgBAssignment);
        const exceptionsOf = async (organizationId: string) =>
          (
            await allPages<{ id: string }>(
              managerAB,
              `/time/manage/exceptions?organizationId=${organizationId}&limit=1`,
            )
          ).map((item) => item.id);
        expect(await exceptionsOf(fx.orgA)).toEqual([exceptionA.id]);
        expect(await exceptionsOf(fx.orgB)).toEqual([exceptionB.id]);
        // Batch 4E-1: the employee, so the exception links to their timesheet.
        const [listed] = (
          await managerAB
            .get(`/time/manage/exceptions?organizationId=${fx.orgA}`)
            .expect(200)
        ).body.items as Array<{ employeeId: string }>;
        expect(listed!.employeeId).toBe(fx.employee1);

        // Corrections requested on each organization's time.
        clock.value = toronto('2027-03-08T09:00');
        const request = (timeEntryId: string, clockOutAt: string) =>
          employee
            .post('/time/me/corrections', {
              type: 'CHANGE_CLOCK_OUT',
              timeEntryId,
              clockOutAt,
              reason: 'Left later',
            })
            .expect(201);
        const correctionA = (await request(ids.teamA[1]!, '2027-03-02T12:30'))
          .body as { id: string };
        const correctionB = (await request(ids.orgB[0]!, '2027-03-02T18:30'))
          .body as { id: string };
        const correctionsOf = async (query: string) =>
          (
            await allPages<{ id: string }>(
              managerAB,
              `/time/manage/corrections?${query}&limit=1`,
            )
          ).map((item) => item.id);
        expect(await correctionsOf(`organizationId=${fx.orgA}`)).toEqual([
          correctionA.id,
        ]);
        expect(await correctionsOf(`organizationId=${fx.orgB}`)).toEqual([
          correctionB.id,
        ]);
        expect(await correctionsOf(`employeeId=${fx.employee2}`)).toEqual([]);

        // Timesheets: one week in each organization.
        for (const organizationId of [fx.orgA, fx.orgB]) {
          await managerAB
            .post('/time/periods/generate', {
              organizationId,
              startDate: '2027-03-01',
              cadence: 'WEEKLY',
            })
            .expect(201);
        }
        const periodOf = async (organizationId: string) =>
          (
            (
              await managerAB
                .get(`/time/periods?organizationId=${organizationId}`)
                .expect(200)
            ).body.items as Array<{ id: string }>
          )[0]!.id;
        const periodA = await periodOf(fx.orgA);
        const periodB = await periodOf(fx.orgB);
        for (const periodId of [periodA, periodB]) {
          await managerAB
            .post(`/time/periods/${periodId}/materialize-timesheets`)
            .expect(201);
        }
        const sheets = async (query: string) =>
          (
            await allPages<{
              id: string;
              employeeId: string;
              timePeriodId: string;
            }>(managerAB, `/time/manage/timesheets?${query}&limit=1`)
          ).map((item) => [item.employeeId, item.timePeriodId]);
        expect(
          sorted((await sheets(`timePeriodId=${periodA}`)).map(String)),
        ).toEqual(
          sorted([`${fx.employee1},${periodA}`, `${fx.employee2},${periodA}`]),
        );
        expect(
          await sheets(`timePeriodId=${periodA}&employeeId=${fx.employee2}`),
        ).toEqual([[fx.employee2, periodA]]);
        expect(await sheets(`organizationId=${fx.orgB}`)).toEqual([
          [fx.employee1, periodB],
        ]);
        // A period of another organization under an organization filter: nothing.
        expect(
          await sheets(`organizationId=${fx.orgA}&timePeriodId=${periodB}`),
        ).toEqual([]);
      });
    });

    it('adds reviewer and actor names to management responses, and nothing else about them', async () => {
      await scenario(async (h) => {
        const { fx, http, tx, clock } = h;
        const ids = await world(h);
        const nameUser = async (
          userId: string,
          firstName: string,
          lastName: string,
        ) => {
          const user = await tx.user.findUniqueOrThrow({
            where: { id: userId },
          });
          await tx.person.update({
            where: { id: user.personId },
            data: { firstName, lastName },
          });
        };
        await nameUser(fx.users.managerA!, 'Maya', 'Manager');
        await nameUser(fx.selfUser1, 'Ada', 'Employee');
        const managerA = await http.as(fx.users.managerA!);
        const managerAB = await http.as(fx.users.managerAB!); // no name on record
        const employee = await http.as(fx.selfUser1);

        // Correction: requested by the employee, approved by Maya.
        clock.value = toronto('2027-03-08T09:00');
        const correction = (
          await employee
            .post('/time/me/corrections', {
              type: 'CHANGE_CLOCK_OUT',
              timeEntryId: ids.teamA[1],
              clockOutAt: '2027-03-02T12:30',
              reason: 'Left later',
            })
            .expect(201)
        ).body as { id: string };
        await managerA
          .post(`/time/corrections/${correction.id}/approve`, {
            reviewerNote: 'OK',
          })
          .expect(201);
        const [corrected] = (
          await managerAB
            .get(`/time/manage/corrections?employeeId=${fx.employee1}`)
            .expect(200)
        ).body.items as Array<{
          actors: Record<string, string | null>;
          reviewerUserId: string;
        }>;
        expect(corrected!.actors).toEqual({
          [fx.selfUser1]: 'Ada Employee',
          [fx.users.managerA!]: 'Maya Manager',
        });
        expect(JSON.stringify(corrected)).not.toMatch(/@example\.com/);

        // Exception resolved by the unnamed manager: the name is null.
        const exception = await tx.attendanceException.create({
          data: {
            employeeId: fx.employee1,
            employmentAssignmentId: fx.assignmentTeamA,
            timeEntryId: ids.teamA[3]!,
            type: 'LONG_SHIFT',
            severity: 'REVIEW',
            workflowImpact: 'NON_BLOCKING',
          },
        });
        await managerAB
          .post(`/time/exceptions/${exception.id}/resolve`, {
            note: 'Approved overtime',
          })
          .expect(200);
        const resolved = (
          (
            await managerA
              .get(
                `/time/manage/exceptions?employeeId=${fx.employee1}&status=RESOLVED`,
              )
              .expect(200)
          ).body.items as Array<{
            id: string;
            actors: Record<string, string | null>;
          }>
        ).find((item) => item.id === exception.id)!;
        expect(resolved.actors).toEqual({ [fx.users.managerAB!]: null });

        // Timesheet: submitted on behalf and approved by Maya; every event actor is named.
        await managerA
          .post('/time/periods/generate', {
            organizationId: fx.orgA,
            startDate: '2027-03-01',
            cadence: 'WEEKLY',
          })
          .expect(201);
        const period = (
          (
            await managerA
              .get(`/time/periods?organizationId=${fx.orgA}`)
              .expect(200)
          ).body.items as Array<{ id: string }>
        )[0]!;
        await managerA
          .post(`/time/periods/${period.id}/materialize-timesheets`)
          .expect(201);
        afterPeriodEnd(clock, '2027-03-07');
        const sheetOf = async () =>
          (
            (
              await managerA
                .get(
                  `/time/manage/timesheets?timePeriodId=${period.id}&employeeId=${fx.employee1}`,
                )
                .expect(200)
            ).body.items as Array<{
              id: string;
              approvedByUserId: string | null;
              segments: Array<{ id: string; netWorkedMinutes: number }>;
              events: Array<{ actorUserId: string | null; type: string }>;
              actors: Record<string, string | null>;
            }>
          )[0]!;
        const sheet = await sheetOf();
        await managerA
          .post(`/time/timesheets/${sheet.id}/submit-on-behalf`, {
            reason: 'On leave',
          })
          .expect(201);
        for (const segment of (await sheetOf()).segments) {
          await managerA
            .post(`/time/timesheet-segments/${segment.id}/approve`, {
              expectedNetWorkedMinutes: segment.netWorkedMinutes,
            })
            .expect(201);
        }
        const approved = await sheetOf();
        expect(approved.approvedByUserId).toBe(fx.users.managerA);
        expect(approved.events.map((event) => event.type)).toContain(
          'APPROVED',
        );
        for (const event of approved.events) {
          expect(approved.actors[event.actorUserId!]).toBe('Maya Manager');
        }
      });
    });

    it('gives each entry the automatic deduction and payable minutes timesheets use, and none to open entries', async () => {
      await scenario(
        async (h) => {
          const { fx, http, tx, clock } = h;
          const entry = (assignment: string, from: string, to: string) =>
            closedEntry(tx, {
              employeeId: fx.employee1,
              employmentAssignmentId: assignment,
              clockInAt: toronto(`2027-03-02T${from}`),
              clockOutAt: toronto(`2027-03-02T${to}`),
              workDate: '2027-03-02',
            });
          // One 30-minute deduction for the day, on the assignment with the most gross minutes.
          const teamA = await entry(fx.assignmentTeamA, '09:00', '13:00');
          const deptB = await entry(fx.assignmentDeptB, '13:00', '16:00');
          const manager = await http.as(fx.users.managerA!);
          const employee = await http.as(fx.selfUser1);
          clock.value = toronto('2027-03-03T08:00');
          await employee
            .post('/time/me/clock-in', {
              employmentAssignmentId: fx.assignmentTeamA,
            })
            .expect(201);
          const rows = (
            await manager
              .get(
                `/time/manage/entries?employeeId=${fx.employee1}&organizationId=${fx.orgA}`,
              )
              .expect(200)
          ).body.items as Array<{
            id: string;
            status: string;
            netWorkedMinutes: number | null;
            policyDeductionMinutes: number | null;
            payableMinutes: number | null;
          }>;
          const byId = new Map(rows.map((row) => [row.id, row]));
          expect(byId.get(teamA.id)).toMatchObject({
            netWorkedMinutes: 240, // unchanged: gross minus unpaid breaks
            policyDeductionMinutes: 30,
            payableMinutes: 210,
          });
          expect(byId.get(deptB.id)).toMatchObject({
            policyDeductionMinutes: 0,
            payableMinutes: 180,
          });
          expect(rows.find((row) => row.status === 'OPEN')).toMatchObject({
            policyDeductionMinutes: null,
            payableMinutes: null,
          });

          // The same numbers as the timesheet's segments.
          await manager
            .post('/time/periods/generate', {
              organizationId: fx.orgA,
              startDate: '2027-03-01',
              cadence: 'WEEKLY',
            })
            .expect(201);
          const period = (
            (
              await manager
                .get(`/time/periods?organizationId=${fx.orgA}`)
                .expect(200)
            ).body.items as Array<{ id: string }>
          )[0]!;
          await manager
            .post(`/time/periods/${period.id}/materialize-timesheets`)
            .expect(201);
          const [sheet] = (
            await manager
              .get(
                `/time/manage/timesheets?timePeriodId=${period.id}&employeeId=${fx.employee1}`,
              )
              .expect(200)
          ).body.items as Array<{
            segments: Array<{
              employmentAssignmentId: string;
              policyDeductionMinutes: number;
              netWorkedMinutes: number;
            }>;
          }>;
          const segment = (assignment: string) =>
            sheet!.segments.find(
              (row) => row.employmentAssignmentId === assignment,
            )!;
          expect(segment(fx.assignmentTeamA)).toMatchObject({
            policyDeductionMinutes: 30,
            netWorkedMinutes: 210,
          });
          expect(segment(fx.assignmentDeptB)).toMatchObject({
            policyDeductionMinutes: 0,
            netWorkedMinutes: 180,
          });
        },
        {
          ...LIVE_TIME_POLICY,
          breaks: { mode: 'AUTO_DEDUCT', autoDeductMinutes: 30 },
        },
      );
    });

    it('lists organizations for every Time reviewer with accurate capabilities, and none for others', async () => {
      await scenario(async ({ fx, http }) => {
        const organizations = async (userId: string) =>
          (
            (
              await (
                await http.as(userId)
              )
                .get('/time/manage/organizations')
                .expect(200)
            ).body.items as Array<{
              id: string;
              actions: Record<string, boolean>;
            }>
          ).map((item) => ({ id: item.id, actions: item.actions }));
        const review = (actions: Record<string, boolean>) => ({
          canViewAttendance: actions.canViewAttendance,
          canCorrectTime: actions.canCorrectTime,
          canReviewExceptions: actions.canReviewExceptions,
          canReviewCorrections: actions.canReviewCorrections,
          canApproveTimesheets: actions.canApproveTimesheets,
          canManageTimesheets: actions.canManageTimesheets,
          canManagePeriods: actions.canManagePeriods,
        });

        const [approver] = await organizations(fx.users.approverOnly!);
        expect(approver!.id).toBe(fx.orgA);
        expect(review(approver!.actions)).toEqual({
          canViewAttendance: false,
          canCorrectTime: false,
          canReviewExceptions: false,
          canReviewCorrections: false,
          canApproveTimesheets: true,
          canManageTimesheets: false,
          canManagePeriods: false,
        });
        // Attendance administration flags are unchanged by review access.
        expect(approver!.actions).toMatchObject({
          canViewSignIns: false,
          canManageDevices: false,
          canManagePolicies: false,
        });

        const [team] = await organizations(fx.users.teamManager!);
        expect(review(team!.actions)).toMatchObject({
          canViewAttendance: true,
          canApproveTimesheets: true,
          canManagePeriods: false,
        });
        const [teamTimesheets] = await organizations(
          fx.users.teamTimesheetManager!,
        );
        // Lock and reopen are per record; periods need the organization.
        expect(review(teamTimesheets!.actions)).toMatchObject({
          canManageTimesheets: true,
          canManagePeriods: false,
        });

        const both = await organizations(fx.users.managerAB!);
        expect(sorted(both.map((item) => item.id))).toEqual(
          sorted([fx.orgA, fx.orgB]),
        );
        for (const item of both) {
          expect(review(item.actions)).toEqual({
            canViewAttendance: true,
            canCorrectTime: true,
            canReviewExceptions: true,
            canReviewCorrections: true,
            canApproveTimesheets: true,
            canManageTimesheets: true,
            canManagePeriods: true,
          });
        }
        expect(await organizations(fx.users.outsider!)).toEqual([]);
        expect(await organizations(fx.selfUser1)).toEqual([]);
      });
    });
  },
);
