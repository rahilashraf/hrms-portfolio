import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service.js';
import {
  createSchedulingFixtures,
  type SchedulingFixtures,
  type Tx,
} from './support/scheduling-fixtures.js';
import {
  FixedClock,
  seedTimePolicy,
  TIME_PERMISSIONS,
  toronto,
} from './support/time-fixtures.js';
import { withTimeHttp, type TimeHttp } from './support/time-http.js';

config({ path: '../../.env' });

class RollbackFixtures extends Error {}

const USERS = {
  self1: [{ permissions: ['time.clock'], scope: 'org' as const }],
  managerA: [
    {
      permissions: [...TIME_PERMISSIONS, 'time.manage_policy'],
      scope: 'org' as const,
    },
  ],
  managerB: [{ permissions: TIME_PERMISSIONS, scope: 'orgB' as const }],
  /** Loses their grant in the test: history must not resurrect it. */
  formerManager: [{ permissions: TIME_PERMISSIONS, scope: 'org' as const }],
};

interface Harness {
  tx: Tx;
  fx: SchedulingFixtures;
  clock: FixedClock;
  http: TimeHttp;
}

const FEATURE_DISABLED = { code: 'FEATURE_DISABLED', module: 'ATTENDANCE' };

/**
 * Batch 4F (C10, decision Q1, Option A) — the history of an organization whose Time &
 * attendance module is disabled stays readable by the people who could already read it, and
 * nothing more:
 *
 * - the employee's own My Time reads (purpose-based, identity unchanged);
 * - managers only with the opt-in includeDisabledOrganizations flag, still through their current
 *   grants (a revoked grant reads nothing; another organization's manager reads nothing);
 * - every action stays 403 FEATURE_DISABLED (employee and manager), operational views stay off.
 */
describe(
  'Batch 4F historical reads (database, HTTP)',
  { timeout: 180_000 },
  () => {
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
            const fx = await createSchedulingFixtures(tx, USERS, [
              ...TIME_PERMISSIONS,
              'time.manage_policy',
            ]);
            await seedTimePolicy(tx, fx.orgA);
            const clock = new FixedClock();
            await withTimeHttp(tx, clock, async (http) => {
              try {
                await run({ tx, fx, clock, http });
              } catch (error) {
                console.error('SCENARIO FAILURE', error);
                throw error;
              }
            });
            throw new RollbackFixtures();
          },
          { timeout: 150_000 },
        ),
      ).rejects.toBeInstanceOf(RollbackFixtures);
    }

    const disableAttendance = (tx: Tx, organizationId: string) =>
      tx.organizationModuleSetting.upsert({
        where: {
          organizationId_module: { organizationId, module: 'ATTENDANCE' },
        },
        create: { organizationId, module: 'ATTENDANCE', enabled: false },
        update: { enabled: false, version: { increment: 1 } },
      });

    it('keeps authorized history readable and every action refused when Attendance is disabled', async () => {
      await scenario(async ({ fx, clock, http, tx }) => {
        const employee = await http.as(fx.selfUser1);
        const manager = await http.as(fx.users.managerA!);

        // History while enabled: an entry, a pending correction, a timesheet and a sign-in.
        clock.value = toronto('2027-03-02T09:00');
        await employee
          .post('/time/me/clock-in', {
            employmentAssignmentId: fx.assignmentTeamA,
          })
          .expect(201);
        clock.value = toronto('2027-03-02T12:00');
        await employee.post('/time/me/clock-out').expect(201);
        const entryId = (
          (await employee.get('/time/me/entries').expect(200)).body
            .items as Array<{
            id: string;
          }>
        )[0]!.id;
        clock.value = toronto('2027-03-02T15:00');
        const correction = (
          await employee
            .post('/time/me/corrections', {
              type: 'CHANGE_CLOCK_OUT',
              timeEntryId: entryId,
              clockOutAt: '2027-03-02T12:30',
              reason: 'Stayed later',
            })
            .expect(201)
        ).body.id as string;
        await manager
          .post('/time/periods/generate', {
            organizationId: fx.orgA,
            startDate: '2027-03-01',
            cadence: 'WEEKLY',
          })
          .expect(201);
        const period = await tx.timePeriod.findFirstOrThrow({
          where: { organizationId: fx.orgA },
        });
        const sheet = await tx.timesheet.create({
          data: { employeeId: fx.employee1, timePeriodId: period.id },
        });
        await employee.get(`/time/me/timesheets/${sheet.id}`).expect(200);
        const signIn = await tx.attendanceSignIn.create({
          data: {
            employeeId: fx.employee1,
            employmentAssignmentId: fx.assignmentTeamA,
            signedInAt: toronto('2027-03-03T09:00'),
            timezone: 'America/Toronto',
            workDate: new Date('2027-03-03T00:00:00.000Z'),
            source: 'MANUAL',
            recordedByUserId: fx.users.managerA!,
            reason: 'Seeded',
          },
        });
        const sheetBefore = await tx.timesheet.findUniqueOrThrow({
          where: { id: sheet.id },
        });

        await disableAttendance(tx, fx.orgA);
        clock.value = toronto('2027-03-04T09:00');

        // ── Employee: own history readable, marked; actions refused. ──
        const entries = await employee.get('/time/me/entries').expect(200);
        expect(entries.body.items.map((e: { id: string }) => e.id)).toEqual([
          entryId,
        ]);
        expect(entries.body.attendanceDisabledOrganizationIds).toEqual([
          fx.orgA,
        ]);
        const corrections = await employee
          .get('/time/me/corrections')
          .expect(200);
        expect(
          corrections.body.corrections.map((c: { id: string }) => c.id),
        ).toEqual([correction]);
        expect(corrections.body.attendanceDisabledOrganizationIds).toEqual([
          fx.orgA,
        ]);
        await employee
          .get('/time/me/exceptions')
          .expect(200)
          .expect((r) =>
            expect(r.body.attendanceDisabledOrganizationIds).toEqual([fx.orgA]),
          );
        const sheets = await employee.get('/time/me/timesheets').expect(200);
        expect(sheets.body.timesheets.map((t: { id: string }) => t.id)).toEqual(
          [sheet.id],
        );
        const detail = await employee
          .get(`/time/me/timesheets/${sheet.id}`)
          .expect(200);
        expect(detail.body).toMatchObject({
          id: sheet.id,
          attendanceEnabled: false,
        });
        // Read as stored: reading a disabled organization's timesheet writes nothing.
        expect(
          (await tx.timesheet.findUniqueOrThrow({ where: { id: sheet.id } }))
            .updatedAt,
        ).toEqual(sheetBefore.updatedAt);
        const signIns = await employee
          .get('/time/me/sign-ins?from=2027-03-01&to=2027-03-04')
          .expect(200);
        expect(signIns.body.items.map((s: { id: string }) => s.id)).toEqual([
          signIn.id,
        ]);
        expect(signIns.body.attendanceDisabledOrganizationIds).toEqual([
          fx.orgA,
        ]);
        const expected = await employee
          .get('/time/me/expected-attendance?from=2027-03-01&to=2027-03-04')
          .expect(200);
        expect(expected.body.attendanceDisabledOrganizationIds).toEqual([
          fx.orgA,
        ]);
        // Operational status and every action: 403 FEATURE_DISABLED.
        for (const response of [
          await employee.get('/time/me/status'),
          await employee.post('/time/me/clock-in', {
            employmentAssignmentId: fx.assignmentTeamA,
          }),
          await employee.post('/time/me/corrections', {
            type: 'CHANGE_CLOCK_OUT',
            timeEntryId: entryId,
            clockOutAt: '2027-03-02T12:45',
            reason: 'Again',
          }),
          await employee.post(`/time/me/corrections/${correction}/cancel`),
          await employee.post(`/time/me/timesheets/${sheet.id}/submit`),
          await employee.post('/time/me/sign-in', {
            employmentAssignmentId: fx.assignmentTeamA,
          }),
        ]) {
          expect(response.status).toBe(403);
          expect(response.body).toMatchObject(FEATURE_DISABLED);
        }

        // ── Manager: nothing without the flag (unchanged); history with it. ──
        const listPaths = [
          ['/time/manage/entries', 'items'],
          ['/time/manage/exceptions', 'items'],
          ['/time/manage/corrections', 'items'],
          ['/time/manage/timesheets', 'items'],
        ] as const;
        for (const [path] of listPaths) {
          const plain = await manager
            .get(`${path}?organizationId=${fx.orgA}`)
            .expect(200);
          expect(plain.body.items, path).toEqual([]);
        }
        const history = (path: string, user = manager) =>
          user
            .get(
              `${path}?organizationId=${fx.orgA}&includeDisabledOrganizations=true`,
            )
            .expect(200);
        const managedEntries = await history('/time/manage/entries');
        expect(
          managedEntries.body.items.map((e: { id: string }) => e.id),
        ).toEqual([entryId]);
        expect(managedEntries.body.attendanceDisabledOrganizationIds).toEqual([
          fx.orgA,
        ]);
        const managedCorrections = await history('/time/manage/corrections');
        expect(
          managedCorrections.body.items.map((c: { id: string }) => c.id),
        ).toEqual([correction]);
        const managedSheets = await history('/time/manage/timesheets');
        expect(
          managedSheets.body.items.map((t: { id: string }) => t.id),
        ).toEqual([sheet.id]);
        const range = `organizationId=${fx.orgA}&from=2027-03-01&to=2027-03-04`;
        await manager
          .get(`/time/manage/sign-ins?${range}`)
          .expect(403)
          .expect((r) => expect(r.body).toMatchObject(FEATURE_DISABLED));
        const managedSignIns = await manager
          .get(
            `/time/manage/sign-ins?${range}&includeDisabledOrganizations=true`,
          )
          .expect(200);
        expect(managedSignIns.body.items).toHaveLength(1);
        expect(managedSignIns.body.items[0].actions).toEqual({
          canVoid: false,
          canCorrect: false,
        });
        expect(managedSignIns.body.attendanceDisabledOrganizationIds).toEqual([
          fx.orgA,
        ]);
        // Operational views stay off: they refuse the history flag outright, and answer the
        // feature state without it.
        await manager
          .get(
            `/time/manage/expected-sign-ins?${range}&includeDisabledOrganizations=true`,
          )
          .expect(400);
        await manager
          .get(`/time/manage/expected-sign-ins?${range}`)
          .expect(403)
          .expect((r) => expect(r.body).toMatchObject(FEATURE_DISABLED));
        expect(
          (
            await manager
              .get(`/time/manage/current?organizationId=${fx.orgA}`)
              .expect(200)
          ).body.items,
        ).toEqual([]);
        // Periods: only with the flag, marked read-only.
        expect(
          (
            await manager
              .get(`/time/periods?organizationId=${fx.orgA}`)
              .expect(200)
          ).body.items,
        ).toEqual([]);
        const periods = await manager
          .get(
            `/time/periods?organizationId=${fx.orgA}&includeDisabledOrganizations=true`,
          )
          .expect(200);
        expect(periods.body.items).toEqual([
          expect.objectContaining({ id: period.id, attendanceEnabled: false }),
        ]);
        expect(periods.body.attendanceDisabledOrganizationIds).toEqual([
          fx.orgA,
        ]);
        // The organization picker lists it read-only only when asked.
        const picker = await manager
          .get('/time/manage/organizations')
          .expect(200);
        expect(
          picker.body.items.some((o: { id: string }) => o.id === fx.orgA),
        ).toBe(false);
        const historicalPicker = await manager
          .get('/time/manage/organizations?includeDisabledOrganizations=true')
          .expect(200);
        const orgA = historicalPicker.body.items.find(
          (o: { id: string }) => o.id === fx.orgA,
        );
        expect(orgA).toMatchObject({
          attendanceEnabled: false,
          actions: {
            canViewAttendance: true,
            canCorrectTime: false,
            canReviewCorrections: false,
            canApproveTimesheets: false,
            canManageTimesheets: false,
            canManagePeriods: false,
            canManagePolicies: false,
          },
        });

        // Every manager action is refused.
        for (const response of [
          await manager.post(`/time/entries/${entryId}/correct`, {
            type: 'CHANGE_CLOCK_OUT',
            clockOutAt: '2027-03-02T13:00',
            reason: 'Fix',
          }),
          await manager.post(`/time/corrections/${correction}/approve`, {}),
          await manager.post(`/time/sign-ins/${signIn.id}/void`, {
            reason: 'Fix',
          }),
          await manager.post('/time/periods/generate', {
            organizationId: fx.orgA,
            startDate: '2027-04-05',
            cadence: 'WEEKLY',
          }),
          await manager.post(
            `/time/periods/${period.id}/materialize-timesheets`,
          ),
        ]) {
          expect(response.status).toBe(403);
          expect(response.body).toMatchObject(FEATURE_DISABLED);
        }
        expect(
          (
            await tx.timeCorrectionRequest.findUniqueOrThrow({
              where: { id: correction },
            })
          ).status,
        ).toBe('PENDING');

        // ── No new authority: another organization's manager and a revoked grant read nothing. ──
        const managerB = await http.as(fx.users.managerB!);
        for (const [path] of listPaths) {
          expect((await history(path, managerB)).body.items, path).toEqual([]);
        }
        await managerB
          .get(
            `/time/manage/sign-ins?${range}&includeDisabledOrganizations=true`,
          )
          .expect(403);
        await tx.roleAssignment.deleteMany({
          where: { userId: fx.users.formerManager! },
        });
        const former = await http.as(fx.users.formerManager!);
        for (const [path] of listPaths) {
          expect((await history(path, former)).body.items, path).toEqual([]);
        }
        await former
          .get(
            `/time/manage/sign-ins?${range}&includeDisabledOrganizations=true`,
          )
          .expect(403);
      });
    });
  },
);
