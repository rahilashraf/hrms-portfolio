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
  managerB: [{ permissions: TIME_PERMISSIONS, scope: 'orgB' as const }],
};

/** Live clocking with a 30-minute automatic deduction per day (Batch 4D, from 0 minutes). */
const DEDUCTING_POLICY = {
  ...LIVE_TIME_POLICY,
  breaks: {
    mode: 'AUTO_DEDUCT',
    autoDeductMinutes: 30,
    autoDeductAfterMinutes: 0,
  },
};

interface Harness {
  tx: Tx;
  fx: SchedulingFixtures;
  clock: FixedClock;
  http: TimeHttp;
  orgBAssignment: string;
}

type Capability = {
  employmentAssignmentId: string;
  organization: { id: string; name: string };
  timezone: string | null;
  attendanceEnabled: boolean;
  clockEnabled: boolean;
  canCapture: boolean;
  trackingMode: string | null;
  captureMode: string | null;
  selfServiceCapture: boolean;
  signOutEnabled: boolean;
  breakMode: string | null;
  correctionRequestsEnabled: boolean;
  missedPunchSelfResolutionEnabled: boolean;
  unavailableReason: string | null;
  explanation: string | null;
};

/**
 * Batch 4E-3 — the employee's own attendance contracts over HTTP against the real database:
 * capabilities per assignment (C1) and coded refusals (C6), payable minutes on the employee's
 * entries (C2), timesheet detail with names and the review-before-submit guard (C3), paged
 * corrections and exceptions with context (C4), requests refused when filed if they could never
 * be approved (C5), and organizations with Attendance switched off (C10): records stay readable,
 * new operational actions are refused. Everything stays the caller's own.
 */
describe(
  'Employee attendance self-service (Batch 4E-3, database, HTTP)',
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
            await tx.timeAttendancePolicy.updateMany({
              where: { organizationId: fx.orgB, scopeType: 'ORGANIZATION' },
              data: { config: policy as object },
            });
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

    const attendanceOff = (tx: Tx, organizationId: string, enabled = false) =>
      tx.organizationModuleSetting.upsert({
        where: {
          organizationId_module: { organizationId, module: 'ATTENDANCE' },
        },
        create: { organizationId, module: 'ATTENDANCE', enabled },
        update: { enabled, version: { increment: 1 } },
      });

    const assignmentLayer = (
      tx: Tx,
      employmentAssignmentId: string,
      config: Record<string, unknown>,
      from = '2026-01-01',
    ) =>
      tx.timeAttendancePolicy.create({
        data: {
          scopeType: 'EMPLOYMENT_ASSIGNMENT',
          employmentAssignmentId,
          effectiveFrom: new Date(`${from}T00:00:00.000Z`),
          config: config as object,
        },
      });

    it('describes every assignment and offers only what its endpoint accepts (C1, C6)', async () => {
      await scenario(async (h) => {
        const { fx, http, tx, clock } = h;
        await assignmentLayer(tx, fx.assignmentDeptB, {
          clock: { mode: 'DISABLED' },
        });
        await attendanceOff(tx, fx.orgB);
        const employee = await http.as(fx.selfUser1);
        const status = async () =>
          (await employee.get('/time/me/status').expect(200)).body as {
            availableActions: string[];
            attendanceModes: Array<{ employmentAssignmentId: string }>;
            assignmentCapabilities: Capability[];
          };
        const of = (view: Awaited<ReturnType<typeof status>>, id: string) =>
          view.assignmentCapabilities.find(
            (item) => item.employmentAssignmentId === id,
          )!;

        let view = await status();
        expect(view.assignmentCapabilities).toHaveLength(3);
        expect(of(view, fx.assignmentTeamA)).toMatchObject({
          organization: { id: fx.orgA },
          timezone: 'America/Toronto',
          attendanceEnabled: true,
          clockEnabled: true,
          canCapture: true,
          trackingMode: 'TIME_CLOCK',
          captureMode: 'SELF_SERVICE',
          selfServiceCapture: true,
          signOutEnabled: false,
          breakMode: 'MANUAL_PUNCH',
          correctionRequestsEnabled: true,
          missedPunchSelfResolutionEnabled: true,
          unavailableReason: null,
          explanation: null,
        });
        // The clock disabled: listed and explained (attendanceModes leaves it out, as before).
        expect(of(view, fx.assignmentDeptB)).toMatchObject({
          clockEnabled: false,
          unavailableReason: 'CLOCK_DISABLED',
          explanation: 'Attendance is not recorded for this assignment.',
        });
        expect(
          view.attendanceModes.map((item) => item.employmentAssignmentId),
        ).not.toContain(fx.assignmentDeptB);
        expect(of(view, h.orgBAssignment)).toMatchObject({
          attendanceEnabled: false,
          canCapture: false,
          unavailableReason: 'ATTENDANCE_DISABLED',
        });
        expect(of(view, h.orgBAssignment).explanation).toContain(
          'switched off',
        );

        // Clocked in with a missed clock-out: offered while the policy lets employees resolve.
        await employee
          .post('/time/me/clock-in', {
            employmentAssignmentId: fx.assignmentTeamA,
          })
          .expect(201);
        const entry = await tx.timeEntry.findFirstOrThrow({
          where: { employeeId: fx.employee1, status: 'OPEN' },
        });
        const exception = await tx.attendanceException.create({
          data: {
            employeeId: fx.employee1,
            employmentAssignmentId: fx.assignmentTeamA,
            timeEntryId: entry.id,
            type: 'MISSING_CLOCK_OUT',
            severity: 'ACTION_REQUIRED',
            workflowImpact: 'SUBMISSION_BLOCKING',
            status: 'OPEN',
            detectedAt: clock.value,
          },
        });
        expect((await status()).availableActions).toContain(
          'RESOLVE_MISSED_CLOCK_OUT',
        );

        // Forbidden by the assignment's policy: never offered, and refused with a code.
        const layer = await assignmentLayer(tx, fx.assignmentTeamA, {
          missedPunch: { employeeResolutionEnabled: false },
          breaks: { mode: 'NONE' },
          correction: { employeeRequestsEnabled: false },
        });
        view = await status();
        expect(view.availableActions).not.toContain('RESOLVE_MISSED_CLOCK_OUT');
        expect(of(view, fx.assignmentTeamA)).toMatchObject({
          missedPunchSelfResolutionEnabled: false,
          breakMode: 'NONE',
          correctionRequestsEnabled: false,
        });
        clock.value = toronto('2027-03-02T12:00');
        const refused = await employee
          .post(
            `/time/me/exceptions/${exception.id}/resolve-missed-clock-out`,
            {
              clockOutAt: '2027-03-02T11:00',
            },
          )
          .expect(403);
        expect(refused.body).toMatchObject({
          code: 'TIME_MISSED_PUNCH_SELF_RESOLUTION_DISABLED',
          message:
            'Employee missed punch resolution is not enabled for this assignment.',
        });
        expect(
          (await employee.post('/time/me/break/start').expect(403)).body.code,
        ).toBe('TIME_BREAKS_NOT_MANUAL');
        expect(
          (
            await employee
              .post('/time/me/switch-assignment', {
                employmentAssignmentId: fx.assignmentDeptB,
              })
              .expect(403)
          ).body.code,
        ).toBe('TIME_CAPTURE_DISABLED');
        await employee.post('/time/me/clock-out').expect(201);
        const closed = await tx.timeEntry.findFirstOrThrow({
          where: { id: entry.id },
        });
        expect(
          (
            await employee
              .post('/time/me/corrections', {
                type: 'CHANGE_CLOCK_OUT',
                timeEntryId: closed.id,
                clockOutAt: '2027-03-02T11:30',
                reason: 'Left earlier',
              })
              .expect(403)
          ).body.code,
        ).toBe('TIME_CORRECTION_REQUESTS_DISABLED');

        // Kiosk only: explained; no self-service capture.
        await tx.timeAttendancePolicy.update({
          where: { id: layer.id },
          data: { config: { attendance: { captureMode: 'KIOSK_ONLY' } } },
        });
        view = await status();
        expect(of(view, fx.assignmentTeamA)).toMatchObject({
          captureMode: 'KIOSK_ONLY',
          selfServiceCapture: false,
          unavailableReason: 'KIOSK_ONLY',
        });
        expect(view.availableActions).not.toContain('CLOCK_IN');
        expect(of(view, fx.assignmentTeamA).explanation).toContain('kiosk');
      });
    });

    it('gives the employee’s entries the payable minutes timesheets use, within their own organizations (C2)', async () => {
      await scenario(async (h) => {
        const { fx, http, tx } = h;
        const entry = (assignment: string, from: string, to: string) =>
          closedEntry(tx, {
            employeeId: fx.employee1,
            employmentAssignmentId: assignment,
            clockInAt: toronto(`2027-03-02T${from}`),
            clockOutAt: toronto(`2027-03-02T${to}`),
            workDate: '2027-03-02',
          });
        const teamA = await entry(fx.assignmentTeamA, '09:00', '13:00');
        const deptB = await entry(fx.assignmentDeptB, '13:00', '16:00');
        const orgB = await entry(h.orgBAssignment, '16:30', '18:30');
        await closedEntry(tx, {
          employeeId: fx.employee2,
          employmentAssignmentId: fx.otherTeamA,
          clockInAt: toronto('2027-03-02T09:00'),
          clockOutAt: toronto('2027-03-02T17:00'),
          workDate: '2027-03-02',
        });
        const employee = await http.as(fx.selfUser1);
        type Row = {
          id: string;
          employeeId: string;
          grossMinutes: number;
          netWorkedMinutes: number;
          policyDeductionMinutes: number | null;
          payableMinutes: number | null;
        };
        const rows = (await employee.get('/time/me/entries').expect(200)).body
          .items as Row[];
        const byId = new Map(rows.map((row) => [row.id, row]));
        expect(rows.every((row) => row.employeeId === fx.employee1)).toBe(true);
        // One deduction per organization and day, on the assignment with the most gross time.
        expect(byId.get(teamA.id)).toMatchObject({
          grossMinutes: 240,
          netWorkedMinutes: 240,
          policyDeductionMinutes: 30,
          payableMinutes: 210,
        });
        expect(byId.get(deptB.id)).toMatchObject({
          policyDeductionMinutes: 0,
          payableMinutes: 180,
        });
        expect(byId.get(orgB.id)).toMatchObject({
          policyDeductionMinutes: 30,
          payableMinutes: 90,
        });
        // The organization filter narrows the caller's own entries only.
        const onlyB = (
          await employee
            .get(
              `/time/me/entries?organizationId=${fx.orgB}&employeeId=${fx.employee2}`,
            )
            .expect(200)
        ).body.items as Row[];
        expect(onlyB.map((row) => row.id)).toEqual([orgB.id]);
      }, DEDUCTING_POLICY);
    });

    it('shows the timesheet with names and refuses a submission of totals the employee didn’t see (C3, C10)', async () => {
      await scenario(async (h) => {
        const { fx, http, tx, clock } = h;
        await closedEntry(tx, {
          employeeId: fx.employee1,
          employmentAssignmentId: fx.assignmentTeamA,
          clockInAt: toronto('2027-03-02T09:00'),
          clockOutAt: toronto('2027-03-02T13:00'),
          workDate: '2027-03-02',
        });
        const manager = await http.as(fx.users.managerA!);
        const employee = await http.as(fx.selfUser1);
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
        afterPeriodEnd(clock, '2027-03-07');
        type Sheet = {
          id: string;
          status: string;
          version: number;
          reviewerNote: string | null;
          totals: { netWorkedMinutes: number };
          segments: Array<{
            id: string;
            netWorkedMinutes: number;
            reviewerNote: string | null;
          }>;
          events: Array<{
            type: string;
            note: string | null;
            actorUserId: string | null;
          }>;
          actors: Record<string, string | null>;
        };
        const list = (await employee.get('/time/me/timesheets').expect(200))
          .body.timesheets as Sheet[];
        expect(list).toHaveLength(1);
        const sheetId = list[0]!.id;
        const detail = async () =>
          (await employee.get(`/time/me/timesheets/${sheetId}`).expect(200))
            .body as Sheet;
        let sheet = await detail();
        expect(sheet).toMatchObject({
          status: 'OPEN',
          totals: { netWorkedMinutes: 210 },
          actors: {},
        });

        // C10: with Attendance switched off for the organization, submitting is refused; the
        // timesheet stays readable.
        await attendanceOff(tx, fx.orgA);
        expect(
          (
            await employee
              .post(`/time/me/timesheets/${sheetId}/submit`, {
                expectedNetWorkedMinutes: 210,
                expectedVersion: sheet.version,
              })
              .expect(403)
          ).body.code,
        ).toBe('FEATURE_DISABLED');
        expect(
          (await employee.get('/time/me/timesheets').expect(200)).body
            .timesheets,
        ).toHaveLength(1);
        await attendanceOff(tx, fx.orgA, true);

        // Stale totals or version: nothing is submitted; the refreshed numbers come back.
        const stale = await employee
          .post(`/time/me/timesheets/${sheetId}/submit`, {
            expectedNetWorkedMinutes: 180,
            expectedVersion: sheet.version,
          })
          .expect(409);
        expect(stale.body).toMatchObject({
          code: 'TIMESHEET_TOTALS_CHANGED',
          netWorkedMinutes: 210,
          version: sheet.version,
        });
        await employee
          .post(`/time/me/timesheets/${sheetId}/submit`, {
            expectedNetWorkedMinutes: 210,
            expectedVersion: sheet.version + 1,
          })
          .expect(409);
        expect((await detail()).status).toBe('OPEN');
        await employee
          .post(`/time/me/timesheets/${sheetId}/submit`, { expectedVersion: 0 })
          .expect(400);

        // As reviewed: submitted. The manager asks for changes with a note the employee sees.
        await employee
          .post(`/time/me/timesheets/${sheetId}/submit`, {
            expectedNetWorkedMinutes: 210,
            expectedVersion: sheet.version,
          })
          .expect(201);
        sheet = await detail();
        await manager
          .post(
            `/time/timesheet-segments/${sheet.segments[0]!.id}/request-changes`,
            {
              note: 'Please confirm Tuesday',
            },
          )
          .expect(201);
        sheet = await detail();
        expect(sheet.status).toBe('CHANGES_REQUESTED');
        expect(sheet.reviewerNote).toBe('Please confirm Tuesday');
        expect(sheet.events.map((event) => event.type)).toEqual([
          'SUBMITTED',
          'CHANGES_REQUESTED',
        ]);
        // Who acted: the users this timesheet names, nothing else.
        expect(Object.keys(sheet.actors).sort()).toEqual(
          [fx.selfUser1, fx.users.managerA!].sort(),
        );
        expect(sheet.actors[fx.selfUser1]).toContain('Employee1');

        // Resubmitted as reviewed (no body still works for older clients).
        await employee
          .post(`/time/me/timesheets/${sheetId}/submit`)
          .expect(201);
        sheet = await detail();
        expect(sheet.status).toBe('SUBMITTED');
        expect(sheet.segments[0]!.reviewerNote).toBe('Please confirm Tuesday');

        // Never another employee's timesheet.
        const other = await http.as(fx.selfUser2);
        await other.get(`/time/me/timesheets/${sheetId}`).expect(404);
        await other.post(`/time/me/timesheets/${sheetId}/submit`).expect(404);
      }, DEDUCTING_POLICY);
    });

    it('pages the employee’s own corrections and exceptions with their context, without internal notes (C4)', async () => {
      await scenario(async (h) => {
        const { fx, http, tx, clock } = h;
        const entries = [];
        for (const day of ['01', '02', '03']) {
          entries.push(
            await closedEntry(tx, {
              employeeId: fx.employee1,
              employmentAssignmentId: fx.assignmentTeamA,
              clockInAt: toronto(`2027-03-${day}T09:00`),
              clockOutAt: toronto(`2027-03-${day}T13:00`),
              workDate: `2027-03-${day}`,
            }),
          );
        }
        clock.value = toronto('2027-03-04T09:00');
        const employee = await http.as(fx.selfUser1);
        const manager = await http.as(fx.users.managerA!);
        for (const [index, entry] of entries.entries()) {
          await employee
            .post('/time/me/corrections', {
              type: 'CHANGE_CLOCK_OUT',
              timeEntryId: entry.id,
              clockOutAt: `2027-03-0${index + 1}T14:00`,
              reason: `Stayed later ${index}`,
            })
            .expect(201);
        }
        type Correction = {
          id: string;
          employeeId: string;
          status: string;
          workDate: string | null;
          timezone: string | null;
          assignment: { position: { name: string } } | null;
          reviewerNote: string | null;
          reviewerUserId: string | null;
          requestedValues: Record<string, unknown>;
          currentValues: Record<string, unknown>;
          actors: Record<string, string | null>;
        };
        const first = (
          await employee.get('/time/me/corrections?limit=2').expect(200)
        ).body as { corrections: Correction[]; nextAfterId: string | null };
        expect(first.corrections).toHaveLength(2);
        expect(first.nextAfterId).toBeTruthy();
        const second = (
          await employee
            .get(`/time/me/corrections?limit=2&afterId=${first.nextAfterId}`)
            .expect(200)
        ).body as { corrections: Correction[]; nextAfterId: string | null };
        expect(second.corrections).toHaveLength(1);
        expect(second.nextAfterId).toBeNull();
        const all = [...first.corrections, ...second.corrections];
        expect(new Set(all.map((item) => item.id)).size).toBe(3);
        expect(all.map((item) => item.workDate).sort()).toEqual([
          '2027-03-01',
          '2027-03-02',
          '2027-03-03',
        ]);
        expect(all[0]).toMatchObject({
          timezone: 'America/Toronto',
          assignment: { position: { name: 'Team A Associate' } },
        });
        // Older clients: the same key, 50 by default.
        expect(
          (await employee.get('/time/me/corrections').expect(200)).body
            .corrections,
        ).toHaveLength(3);

        // A decision with a note: the reviewer's note and name reach the employee.
        const decided = all.find((item) => item.workDate === '2027-03-02')!;
        await manager
          .post(`/time/corrections/${decided.id}/approve`, {
            reviewerNote: 'Confirmed with the supervisor',
          })
          .expect(201);
        const approved = (
          (
            await employee
              .get('/time/me/corrections?status=APPROVED')
              .expect(200)
          ).body.corrections as Correction[]
        )[0]!;
        expect(approved).toMatchObject({
          id: decided.id,
          status: 'APPROVED',
          reviewerNote: 'Confirmed with the supervisor',
          reviewerUserId: fx.users.managerA,
        });
        expect(Object.keys(approved.actors).sort()).toEqual(
          [fx.selfUser1, fx.users.managerA!].sort(),
        );
        await employee.get('/time/me/corrections?status=WHATEVER').expect(400);

        // Exceptions: closed by a manager, the method and who, not the internal note.
        const exception = (type: string, entryId: string, minutes: number) =>
          tx.attendanceException.create({
            data: {
              employeeId: fx.employee1,
              employmentAssignmentId: fx.assignmentTeamA,
              timeEntryId: entryId,
              type: type as never,
              severity: 'REVIEW',
              workflowImpact: 'NON_BLOCKING',
              detectedAt: new Date(
                toronto('2027-03-03T20:00').getTime() + minutes * 60_000,
              ),
            },
          });
        const long = await exception('LONG_SHIFT', entries[0]!.id, 1);
        await exception('LONG_SHIFT', entries[1]!.id, 2);
        await exception('LONG_SHIFT', entries[2]!.id, 3);
        await tx.attendanceException.create({
          data: {
            employeeId: fx.employee2,
            type: 'LONG_SHIFT',
            severity: 'REVIEW',
            workflowImpact: 'NON_BLOCKING',
            detectedAt: toronto('2027-03-03T20:00'),
          },
        });
        await manager
          .post(`/time/exceptions/${long.id}/resolve`, {
            note: 'Internal: discussed with payroll',
          })
          .expect(200);
        type Exception = {
          id: string;
          employeeId: string;
          status: string;
          workDate: string | null;
          resolutionMethod: string | null;
          resolvedByUserId: string | null;
          actors: Record<string, string | null>;
        };
        const page = (
          await employee.get('/time/me/exceptions?limit=2').expect(200)
        ).body as { exceptions: Exception[]; nextAfterId: string | null };
        expect(page.exceptions).toHaveLength(2);
        const rest = (
          await employee
            .get(`/time/me/exceptions?limit=2&afterId=${page.nextAfterId}`)
            .expect(200)
        ).body as { exceptions: Exception[]; nextAfterId: string | null };
        const exceptions = [...page.exceptions, ...rest.exceptions];
        expect(exceptions).toHaveLength(3);
        expect(
          exceptions.every((item) => item.employeeId === fx.employee1),
        ).toBe(true);
        const resolved = exceptions.find((item) => item.id === long.id)!;
        expect(resolved).toMatchObject({
          status: 'RESOLVED',
          workDate: '2027-03-01',
          resolutionMethod: 'MANAGER_RESOLUTION',
          resolvedByUserId: fx.users.managerA,
        });
        expect(Object.keys(resolved.actors)).toEqual([fx.users.managerA]);
        expect(JSON.stringify(exceptions)).not.toContain('Internal: discussed');
        expect(resolved).not.toHaveProperty('resolutionNote');
        expect(
          (
            await employee
              .get('/time/me/exceptions?status=RESOLVED')
              .expect(200)
          ).body.exceptions.map((item: Exception) => item.id),
        ).toEqual([long.id]);

        // Another employee sees none of these.
        const other = await http.as(fx.selfUser2);
        expect(
          (await other.get('/time/me/corrections').expect(200)).body
            .corrections,
        ).toEqual([]);
        expect(
          (await other.get('/time/me/exceptions').expect(200)).body.exceptions,
        ).toHaveLength(1);
      });
    });

    it('refuses a request when filed if it could never be approved, by the policy of its work date (C5, C10)', async () => {
      await scenario(async (h) => {
        const { fx, http, tx, clock } = h;
        const entry = (assignment: string, day: string) =>
          closedEntry(tx, {
            employeeId: fx.employee1,
            employmentAssignmentId: assignment,
            clockInAt: toronto(`2027-03-${day}T09:00`),
            clockOutAt: toronto(`2027-03-${day}T13:00`),
            workDate: `2027-03-${day}`,
          });
        const early = await entry(fx.assignmentTeamA, '02');
        const late = await entry(fx.assignmentTeamA, '04');
        const orgB = await entry(h.orgBAssignment, '03');
        // Employee requests end on March 4 for Team A.
        await assignmentLayer(
          tx,
          fx.assignmentTeamA,
          { correction: { employeeRequestsEnabled: false } },
          '2027-03-04',
        );
        // Dept B records presence by sign-in: it can never hold time entries.
        await assignmentLayer(tx, fx.assignmentDeptB, {
          attendance: { trackingMode: 'SIGN_IN_ONLY' },
        });
        clock.value = toronto('2027-03-05T09:00');
        const employee = await http.as(fx.selfUser1);
        const request = (body: Record<string, unknown>) =>
          employee.post('/time/me/corrections', {
            reason: 'Fix my time',
            ...body,
          });
        // The policy of the entry's work date decides (it used to be today's).
        await request({
          type: 'CHANGE_CLOCK_OUT',
          timeEntryId: early.id,
          clockOutAt: '2027-03-02T14:00',
        }).expect(201);
        expect(
          (
            await request({
              type: 'CHANGE_CLOCK_OUT',
              timeEntryId: late.id,
              clockOutAt: '2027-03-04T14:00',
            }).expect(403)
          ).body.code,
        ).toBe('TIME_CORRECTION_REQUESTS_DISABLED');
        // Sign-in-only work can't receive an entry.
        expect(
          (
            await request({
              type: 'ADD_MISSING_TIME_ENTRY',
              employmentAssignmentId: fx.assignmentDeptB,
              startAt: '2027-03-01T15:00',
              endAt: '2027-03-01T17:00',
            }).expect(409)
          ).body.code,
        ).toBe('ATTENDANCE_TRACKING_MODE_MISMATCH');
        // Attendance switched off for Organization B: no new request there.
        await attendanceOff(tx, fx.orgB);
        expect(
          (
            await request({
              type: 'CHANGE_CLOCK_OUT',
              timeEntryId: orgB.id,
              clockOutAt: '2027-03-03T14:00',
            }).expect(403)
          ).body.code,
        ).toBe('FEATURE_DISABLED');
        expect(
          await tx.timeCorrectionRequest.count({
            where: { employeeId: fx.employee1 },
          }),
        ).toBe(1);
        // …while its records stay readable.
        expect(
          (
            (
              await employee
                .get(`/time/me/entries?organizationId=${fx.orgB}`)
                .expect(200)
            ).body.items as Array<{ id: string }>
          ).map((item) => item.id),
        ).toEqual([orgB.id]);
      });
    });
    it('validates the new self-service inputs over HTTP (C7, C8)', async () => {
      await scenario(async (h) => {
        const { fx, http } = h;
        const employee = await http.as(fx.selfUser1);
        await employee
          .post('/time/me/sign-in', {
            employmentAssignmentId: fx.assignmentTeamA,
            scheduledShiftId: 'not-a-uuid',
          })
          .expect(400);
        await employee
          .get('/time/me/expected-attendance?from=03/01/2027')
          .expect(400);
        await employee
          .get('/time/me/expected-attendance?from=2027-01-01&to=2027-03-03')
          .expect(400);
        expect(
          (
            await employee
              .get('/time/me/expected-attendance?from=2027-03-01&to=2027-03-07')
              .expect(200)
          ).body,
        ).toEqual({
          from: '2027-03-01',
          to: '2027-03-07',
          items: [],
          // Batch 4F (Q3): bounded, and says whether the range held more.
          truncated: false,
          limit: 1000,
          attendanceDisabledOrganizationIds: [],
        });
      });
    });
    it('asks for the occurrence of a repeated local time in an employee request, keeps the chosen instant pending until a manager approves (D6, review)', async () => {
      await scenario(async (h) => {
        const { fx, http, tx, clock } = h;
        // Saturday 6 Nov 2027, 23:00 EDT until Sunday 03:00 EST (clocks went back at 02:00).
        const entry = await closedEntry(tx, {
          employeeId: fx.employee1,
          employmentAssignmentId: fx.assignmentTeamA,
          clockInAt: new Date('2027-11-07T03:00:00.000Z'),
          clockOutAt: new Date('2027-11-07T08:00:00.000Z'),
          workDate: '2027-11-06',
        });
        clock.value = new Date('2027-11-08T15:00:00.000Z');
        const employee = await http.as(fx.selfUser1);
        const request = (clockOutAt: string) =>
          employee.post('/time/me/corrections', {
            type: 'CHANGE_CLOCK_OUT',
            timeEntryId: entry.id,
            clockOutAt,
            reason: 'Left during the repeated hour',
          });

        // 01:30 happens twice that night: refused, with both occurrences.
        const ambiguous = await request('2027-11-07T01:30').expect(409);
        expect(ambiguous.body).toMatchObject({
          code: 'TIME_LOCAL_TIME_AMBIGUOUS',
          occurrences: [
            {
              value: '2027-11-07T01:30-04:00',
              instant: '2027-11-07T05:30:00.000Z',
            },
            {
              value: '2027-11-07T01:30-05:00',
              instant: '2027-11-07T06:30:00.000Z',
            },
          ],
        });
        // An offset that is not the zone's at that time: refused.
        expect(
          (await request('2027-11-07T01:30-03:00').expect(400)).body.code,
        ).toBe('TIME_LOCAL_TIME_OFFSET_MISMATCH');
        expect(
          await tx.timeCorrectionRequest.count({
            where: { employeeId: fx.employee1 },
          }),
        ).toBe(0);

        // The second occurrence, explicitly: accepted and pending.
        const accepted = (await request('2027-11-07T01:30-05:00').expect(201))
          .body as {
          id: string;
          status: string;
          requestedValues: { clockOutAt: string };
        };
        expect(accepted.status).toBe('PENDING');
        const stored = await tx.timeCorrectionRequest.findUniqueOrThrow({
          where: { id: accepted.id },
        });
        // Stored as sent: an offset-qualified time naming exactly one instant.
        const requested = (stored.requestedValues as { clockOutAt: string })
          .clockOutAt;
        expect(requested).toBe('2027-11-07T01:30-05:00');
        expect(new Date(requested).toISOString()).toBe(
          '2027-11-07T06:30:00.000Z',
        );
        // Nothing changes until a manager approves (never the employee).
        expect(
          (await tx.timeEntry.findUniqueOrThrow({ where: { id: entry.id } }))
            .clockOutAt,
        ).toEqual(new Date('2027-11-07T08:00:00.000Z'));
        await employee
          .post(`/time/corrections/${accepted.id}/approve`, {})
          .expect(403);
        const manager = await http.as(fx.users.managerA!);
        await manager
          .post(`/time/corrections/${accepted.id}/approve`, {})
          .expect(201);
        const corrected = await employee.get('/time/me/entries').expect(200);
        expect(
          (
            corrected.body.items as Array<{ id: string; clockOutAt: string }>
          ).find((item) => item.id === entry.id)?.clockOutAt,
        ).toBe('2027-11-07T06:30:00.000Z');
      });
    });
  },
);
