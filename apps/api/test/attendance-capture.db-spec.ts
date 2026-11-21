import {
  ConflictException,
  ForbiddenException,
  HttpException,
} from '@nestjs/common';
import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  formatDate,
  addDays,
  currentDates,
} from '../src/common/domain-support.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { TimePolicyService } from '../src/time/time-policy.service.js';
import type { KioskDevice } from '../src/time/time.service.js';
import {
  createSchedulingFixtures,
  ctx,
  rejection,
  rollbackClient,
  type SchedulingFixtures,
  type Tx,
} from './support/scheduling-fixtures.js';
import {
  FixedClock,
  seedTimePolicy,
  TIME_PERMISSIONS,
  timeServices,
  toronto,
} from './support/time-fixtures.js';

config({ path: '../../.env' });

class RollbackFixtures extends Error {}

const USERS = {
  self1: [{ permissions: ['time.clock'], scope: 'org' as const }],
  timeManager: [
    {
      permissions: [...TIME_PERMISSIONS, 'time.manage_policy'],
      scope: 'org' as const,
    },
  ],
  teamPolicyAdmin: [
    { permissions: ['time.manage_policy'], scope: 'teamA' as const },
  ],
  deviceAdmin: [{ permissions: ['time.device.manage'], scope: 'org' as const }],
};

interface Harness {
  tx: Tx;
  fx: SchedulingFixtures;
  clock: FixedClock;
  svc: ReturnType<typeof timeServices>;
  kiosk: KioskDevice;
}

const body = (error: unknown) => (error as HttpException).getResponse();

/**
 * Phase 9.5 Batches 2–3: attendance tracking and capture modes are enforced on the server for
 * every capture channel, kiosk capture is recorded as such, corrections never put time on
 * sign-in-only assignments, and policy layers are administered without rewriting history.
 */
describe('Attendance capture modes (database)', () => {
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
            'time.device.manage',
          ]);
          await seedTimePolicy(tx, fx.orgA);
          const clock = new FixedClock();
          const svc = timeServices(rollbackClient(tx), clock);
          const device = await tx.attendanceDevice.create({
            data: {
              organizationId: fx.orgA,
              physicalSiteId: fx.physicalSiteToronto,
              name: 'Front desk',
              credentialHash: `hash-${fx.suffix}`,
              credentialIssuedAt: new Date(),
            },
          });
          const kiosk = {
            id: device.id,
            organizationId: device.organizationId,
            physicalSiteId: device.physicalSiteId,
          };
          await run({ tx, fx, clock, svc, kiosk });
          throw new RollbackFixtures();
        },
        { timeout: 60_000 },
      ),
    ).rejects.toBeInstanceOf(RollbackFixtures);
  }

  /** An assignment-level attendance layer (inheriting everything else). */
  const assignmentModes = (
    tx: Tx,
    assignmentId: string,
    attendance: Record<string, unknown>,
    effectiveFrom = '2026-01-01',
  ) =>
    tx.timeAttendancePolicy.create({
      data: {
        scopeType: 'EMPLOYMENT_ASSIGNMENT',
        employmentAssignmentId: assignmentId,
        effectiveFrom: new Date(`${effectiveFrom}T00:00:00.000Z`),
        config: { attendance } as object,
      },
    });

  it('enforces KIOSK_ONLY on the server and records kiosk capture as such', async () => {
    await scenario(async ({ tx, fx, svc, clock, kiosk }) => {
      await assignmentModes(tx, fx.assignmentTeamA, {
        captureMode: 'KIOSK_ONLY',
      });
      const self = ctx(fx.selfUser1);
      clock.value = toronto('2027-03-02T09:00');

      // Self-service: not offered, and refused whether or not the assignment is named.
      const status = await svc.time.status(fx.selfUser1);
      expect(
        status.eligibleAssignments.map((a: { id: string }) => a.id),
      ).not.toContain(fx.assignmentTeamA);
      expect(status.attendanceModes).toContainEqual({
        employmentAssignmentId: fx.assignmentTeamA,
        trackingMode: 'TIME_CLOCK',
        captureMode: 'KIOSK_ONLY',
      });
      for (const attempt of [
        () => svc.time.clockIn(fx.selfUser1, fx.assignmentTeamA, self),
        () => svc.time.clockIn(fx.selfUser1, undefined, self),
      ]) {
        const error = await rejection(attempt());
        expect(error).toBeInstanceOf(ForbiddenException);
        expect(body(error)).toMatchObject({
          code: 'ATTENDANCE_CAPTURE_KIOSK_ONLY',
        });
      }

      // The kiosk records it: KIOSK sources, the device on every punch, audit names the device.
      await svc.time.kioskClockIn(kiosk, fx.employee1, fx.assignmentTeamA, {
        userAgent: 'kiosk',
      });
      const entry = await tx.timeEntry.findFirstOrThrow({
        where: { employeeId: fx.employee1 },
      });
      expect(entry.source).toBe('KIOSK');
      const punch = await tx.timePunch.findFirstOrThrow({
        where: { timeEntryId: entry.id },
      });
      expect(punch).toMatchObject({
        source: 'KIOSK',
        attendanceDeviceId: kiosk.id,
      });
      const audit = await tx.auditLog.findFirstOrThrow({
        where: { action: 'TIME_CLOCKED_IN', entityId: entry.id },
      });
      expect(audit.actorUserId).toBeNull();
      expect(audit.metadata).toMatchObject({
        capture: { channel: 'KIOSK', attendanceDeviceId: kiosk.id },
      });

      // Clocking out remotely is refused too; at the kiosk it works.
      clock.value = toronto('2027-03-02T12:00');
      expect(
        body(await rejection(svc.time.clockOut(fx.selfUser1, self))),
      ).toMatchObject({
        code: 'ATTENDANCE_CAPTURE_KIOSK_ONLY',
      });
      await svc.time.kioskClockOut(kiosk, fx.employee1, {});
      const closed = await tx.timeEntry.findUniqueOrThrow({
        where: { id: entry.id },
      });
      expect(closed.status).toBe('CLOSED');
      expect(
        await tx.timePunch.count({
          where: {
            timeEntryId: entry.id,
            source: 'KIOSK',
            attendanceDeviceId: kiosk.id,
          },
        }),
      ).toBe(2);

      // A self-service correction of kiosk time never auto-approves.
      await tx.timeAttendancePolicy.create({
        data: {
          scopeType: 'EMPLOYMENT_ASSIGNMENT',
          employmentAssignmentId: fx.assignmentTeamA,
          effectiveFrom: new Date('2027-03-01T00:00:00.000Z'),
          config: {
            attendance: { captureMode: 'KIOSK_ONLY' },
            correction: {
              employeeRequestsEnabled: true,
              approvalMode: 'NO_APPROVAL_REQUIRED',
            },
          },
        },
      });
      clock.value = toronto('2027-03-02T13:00');
      const request = (await svc.time.requestCorrection(
        fx.selfUser1,
        {
          type: 'CHANGE_CLOCK_OUT',
          reason: 'Left later',
          timeEntryId: entry.id,
          clockOutAt: '2027-03-02T12:30',
        },
        self,
      )) as { status: string };
      expect(request.status).toBe('PENDING');
    });
  });

  it('keeps self-service-only assignments off the kiosk and applies the kiosk location rule', async () => {
    await scenario(async ({ tx, fx, svc, clock, kiosk }) => {
      clock.value = toronto('2027-03-02T09:00');
      // Default capture is SELF_SERVICE: the kiosk refuses.
      expect(
        body(
          await rejection(
            svc.time.kioskClockIn(kiosk, fx.employee1, fx.assignmentTeamA, {}),
          ),
        ),
      ).toMatchObject({ code: 'ATTENDANCE_CAPTURE_SELF_SERVICE_ONLY' });
      // Either channel; but only at kiosks of the assignment's own physical site.
      await assignmentModes(tx, fx.assignmentTeamA, {
        captureMode: 'KIOSK_OR_SELF_SERVICE',
        kioskLocationRule: 'ASSIGNMENT_WORK_LOCATION',
      });
      const position = await tx.position.findUniqueOrThrow({
        where: { id: fx.positionTeamA },
      });
      const otherSite =
        position.workLocationId === fx.workLocationToronto
          ? fx.physicalSiteOttawa
          : fx.physicalSiteToronto;
      const elsewhere = await tx.attendanceDevice.create({
        data: {
          organizationId: fx.orgA,
          physicalSiteId: otherSite,
          name: 'Elsewhere',
        },
      });
      expect(
        body(
          await rejection(
            svc.time.kioskClockIn(
              {
                id: elsewhere.id,
                organizationId: fx.orgA,
                physicalSiteId: otherSite,
              },
              fx.employee1,
              fx.assignmentTeamA,
              {},
            ),
          ),
        ),
      ).toMatchObject({ code: 'ATTENDANCE_KIOSK_LOCATION_NOT_ALLOWED' });
      // Self-service still works under KIOSK_OR_SELF_SERVICE.
      await svc.time.clockIn(
        fx.selfUser1,
        fx.assignmentTeamA,
        ctx(fx.selfUser1),
      );
      expect(
        (
          await tx.timeEntry.findFirstOrThrow({
            where: { employeeId: fx.employee1 },
          })
        ).source,
      ).toBe('LIVE_CLOCK');
    });
  });

  it('refuses kiosk capture from an inactive device or another organization', async () => {
    await scenario(async ({ tx, fx, svc, clock, kiosk }) => {
      await assignmentModes(tx, fx.assignmentTeamA, {
        captureMode: 'KIOSK_ONLY',
      });
      clock.value = toronto('2027-03-02T09:00');
      await tx.attendanceDevice.update({
        where: { id: kiosk.id },
        data: { status: 'DISABLED' },
      });
      expect(
        body(
          await rejection(
            svc.time.kioskClockIn(kiosk, fx.employee1, fx.assignmentTeamA, {}),
          ),
        ),
      ).toMatchObject({ code: 'KIOSK_DEVICE_INACTIVE' });
      await tx.attendanceDevice.update({
        where: { id: kiosk.id },
        data: { status: 'ACTIVE' },
      });
      const orgBSite = await tx.physicalSite.create({
        data: {
          organizationId: fx.orgB,
          name: `B site ${fx.suffix}`,
        },
      });
      const orgBKiosk = await tx.attendanceDevice.create({
        data: {
          organizationId: fx.orgB,
          physicalSiteId: orgBSite.id,
          name: 'B kiosk',
        },
      });
      const error = await rejection(
        svc.time.kioskClockIn(
          {
            id: orgBKiosk.id,
            organizationId: fx.orgB,
            physicalSiteId: orgBSite.id,
          },
          fx.employee1,
          fx.assignmentTeamA,
          {},
        ),
      );
      expect(error).toBeInstanceOf(ForbiddenException);
      expect(
        await tx.timeEntry.count({ where: { employeeId: fx.employee1 } }),
      ).toBe(0);
    });
  });

  it('never opens time entries on SIGN_IN_ONLY assignments, but always lets open work close', async () => {
    await scenario(async ({ tx, fx, svc, clock, kiosk }) => {
      const self = ctx(fx.selfUser1);
      const manager = ctx(fx.users.timeManager!);
      clock.value = toronto('2027-03-02T09:00');
      await svc.time.clockIn(fx.selfUser1, fx.assignmentTeamA, self);
      // From today the assignment tracks presence by sign-in only.
      await assignmentModes(
        tx,
        fx.assignmentTeamA,
        { trackingMode: 'SIGN_IN_ONLY', captureMode: 'KIOSK_OR_SELF_SERVICE' },
        '2027-03-02',
      );
      clock.value = toronto('2027-03-02T10:00');
      expect(
        body(await rejection(svc.time.startBreak(fx.selfUser1, self))),
      ).toMatchObject({
        code: 'ATTENDANCE_TRACKING_MODE_MISMATCH',
      });
      // The open entry still closes.
      await svc.time.clockOut(fx.selfUser1, self);
      // No new clocking, through either channel.
      for (const attempt of [
        () => svc.time.clockIn(fx.selfUser1, fx.assignmentTeamA, self),
        () =>
          svc.time.kioskClockIn(kiosk, fx.employee1, fx.assignmentTeamA, {}),
      ]) {
        const error = await rejection(attempt());
        expect(error).toBeInstanceOf(ConflictException);
        expect(body(error)).toMatchObject({
          code: 'ATTENDANCE_TRACKING_MODE_MISMATCH',
        });
      }
      // Nor can a manager add payable time there, or move an entry onto it (the day after, as
      // Batch 4A refuses time in the future).
      clock.value = toronto('2027-03-04T09:00');
      expect(
        body(
          await rejection(
            svc.time.addEntry(
              fx.users.timeManager!,
              fx.employee1,
              {
                employmentAssignmentId: fx.assignmentTeamA,
                startAt: '2027-03-03T09:00',
                endAt: '2027-03-03T10:00',
                reason: 'Forgot to clock',
              },
              manager,
            ),
          ),
        ),
      ).toMatchObject({ code: 'ATTENDANCE_TRACKING_MODE_MISMATCH' });
      await tx.organization.update({
        where: { id: fx.orgA },
        data: { timezone: 'America/Toronto' },
      });
      const added = await svc.time.addEntry(
        fx.users.timeManager!,
        fx.employee1,
        {
          employmentAssignmentId: fx.assignmentDeptB,
          startAt: '2027-03-03T09:00',
          endAt: '2027-03-03T10:00',
          reason: 'Kiosk was down',
        },
        manager,
      );
      expect(added).toMatchObject({
        source: 'MANAGER_DIRECT',
        reason: 'Kiosk was down',
      });
      const manual = await tx.timeEntry.findUniqueOrThrow({
        where: { id: added.timeEntryId! },
      });
      expect(manual.source).toBe('MANUAL');
      expect(
        await tx.timePunch.count({ where: { timeEntryId: manual.id } }),
      ).toBe(0);
      expect(
        body(
          await rejection(
            svc.time.correctEntry(
              fx.users.timeManager!,
              manual.id,
              {
                type: 'CHANGE_ASSIGNMENT',
                reason: 'Other job',
                targetEmploymentAssignmentId: fx.assignmentTeamA,
              },
              manager,
            ),
          ),
        ),
      ).toMatchObject({ code: 'ATTENDANCE_TRACKING_MODE_MISMATCH' });
    });
  });

  it('administers policy layers: validated, scoped, never overlapping, never retroactive', async () => {
    await scenario(async ({ tx, fx, svc }) => {
      const policies = new TimePolicyService(
        rollbackClient(tx),
        svc.authorization,
        svc.targets,
        svc.audit,
      );
      const manager = ctx(fx.users.timeManager!);
      const today = formatDate(currentDates().latest);
      const later = formatDate(addDays(currentDates().latest, 30));
      const created = await policies.create(
        fx.users.timeManager!,
        {
          scopeType: 'TEAM',
          teamId: fx.teamA,
          effectiveFrom: today,
          config: {
            attendance: {
              trackingMode: 'SIGN_IN_ONLY',
              captureMode: 'KIOSK_ONLY',
            },
          },
        },
        manager,
      );
      expect(created).toMatchObject({
        scopeType: 'TEAM',
        organizationId: fx.orgA,
        effectiveTo: null,
      });
      // Invalid config, overlap and retroactive starts are refused.
      expect(
        body(
          await rejection(
            policies.create(
              fx.users.timeManager!,
              {
                scopeType: 'TEAM',
                teamId: fx.teamA,
                effectiveFrom: later,
                config: { attendance: { captureMode: 'X' } },
              },
              manager,
            ),
          ),
        ),
      ).toMatchObject({ code: 'TIME_POLICY_CONFIG_INVALID' });
      expect(
        body(
          await rejection(
            policies.create(
              fx.users.timeManager!,
              {
                scopeType: 'TEAM',
                teamId: fx.teamA,
                effectiveFrom: later,
                config: {},
              },
              manager,
            ),
          ),
        ),
      ).toMatchObject({
        code: 'TIME_POLICY_OVERLAP',
        conflictingPolicyId: created.id,
      });
      expect(
        body(
          await rejection(
            policies.create(
              fx.users.timeManager!,
              {
                scopeType: 'DEPARTMENT',
                departmentId: fx.deptB,
                effectiveFrom: '2020-01-01',
                config: {},
              },
              manager,
            ),
          ),
        ),
      ).toMatchObject({ code: 'TIME_POLICY_RETROACTIVE' });
      // Changing it: end the layer, then add the next one.
      await policies.end(
        fx.users.timeManager!,
        created.id,
        { effectiveTo: formatDate(addDays(currentDates().latest, 29)) },
        manager,
      );
      const next = await policies.create(
        fx.users.timeManager!,
        {
          scopeType: 'TEAM',
          teamId: fx.teamA,
          effectiveFrom: later,
          config: { attendance: { captureMode: 'SELF_SERVICE' } },
        },
        manager,
      );
      // Only a layer that has not started anywhere can be withdrawn.
      expect(
        body(
          await rejection(
            policies.archive(fx.users.timeManager!, created.id, manager),
          ),
        ),
      ).toMatchObject({
        code: 'TIME_POLICY_STARTED',
      });
      expect(
        (await policies.archive(fx.users.timeManager!, next.id, manager))
          .archivedAt,
      ).not.toBeNull();
      // Scoped: a Team A administrator manages Team A layers, not the organization's.
      await policies.create(
        fx.users.teamPolicyAdmin!,
        {
          scopeType: 'EMPLOYMENT_ASSIGNMENT',
          employmentAssignmentId: fx.assignmentTeamA,
          effectiveFrom: later,
          config: { attendance: { captureMode: 'KIOSK_ONLY' } },
        },
        ctx(fx.users.teamPolicyAdmin!),
      );
      expect(
        await rejection(
          policies.create(
            fx.users.teamPolicyAdmin!,
            {
              scopeType: 'ORGANIZATION',
              organizationId: fx.orgA,
              effectiveFrom: later,
              config: {},
            },
            ctx(fx.users.teamPolicyAdmin!),
          ),
        ),
      ).toBeInstanceOf(ForbiddenException);
      const listed = await policies.list(fx.users.teamPolicyAdmin!, {
        organizationId: fx.orgA,
      });
      const byScope = (scopeType: string) =>
        listed.items.filter((item) => item.scopeType === scopeType);
      expect(
        byScope('ORGANIZATION').every((item) => !item.actions.canEnd),
      ).toBe(true);
      expect(
        byScope('EMPLOYMENT_ASSIGNMENT').some(
          (item) => item.actions.canArchive,
        ),
      ).toBe(true);
      expect(
        await tx.auditLog.count({
          where: {
            action: {
              in: [
                'TIME_POLICY_CREATED',
                'TIME_POLICY_ENDED',
                'TIME_POLICY_ARCHIVED',
              ],
            },
            entityType: 'TimeAttendancePolicy',
          },
        }),
      ).toBeGreaterThanOrEqual(5);
    });
  });
  it('lists the organizations reachable through Time administration grants', async () => {
    await scenario(async ({ tx, fx, svc }) => {
      const policies = new TimePolicyService(
        rollbackClient(tx),
        svc.authorization,
        svc.targets,
        svc.audit,
      );
      const sharedSite = await tx.physicalSite.create({
        data: { organizationId: fx.orgA, name: `Shared site ${fx.suffix}` },
      });
      await tx.workLocation.updateMany({
        where: { id: { in: [fx.workLocationToronto, fx.workLocationOttawa] } },
        data: { physicalSiteId: sharedSite.id },
      });
      const orphanSite = await tx.physicalSite.create({
        data: { organizationId: fx.orgA, name: `Orphan site ${fx.suffix}` },
      });
      const archivedOnlySite = await tx.physicalSite.create({
        data: {
          organizationId: fx.orgA,
          name: `Archived-only site ${fx.suffix}`,
        },
      });
      await tx.workLocation.create({
        data: {
          organizationId: fx.orgA,
          physicalSiteId: archivedOnlySite.id,
          name: 'Archived only',
          code: `ARCH-${fx.suffix}`,
          timezone: 'America/Toronto',
          archivedAt: new Date(),
        },
      });
      const foreignSite = await tx.physicalSite.create({
        data: { organizationId: fx.orgB, name: `Foreign site ${fx.suffix}` },
      });
      await tx.workLocation.create({
        data: {
          organizationId: fx.orgB,
          physicalSiteId: foreignSite.id,
          name: 'Foreign active',
          code: `FA-${fx.suffix}`,
          timezone: 'UTC',
        },
      });
      // Organization-wide Time grants: every action except device management.
      const manager = await policies.organizations(fx.users.timeManager!);
      expect(manager.items.map((o) => o.id)).toEqual([fx.orgA]);
      expect(manager.items[0]!.actions).toEqual({
        canViewSignIns: true,
        canCorrectSignIns: true,
        canManageDevices: false,
        canManagePolicies: true,
        canManagePins: false,
        // Batch 4E-1 (G4): the manager review capabilities of the same grants.
        canViewAttendance: true,
        canCorrectTime: true,
        canReviewExceptions: true,
        canReviewCorrections: true,
        canApproveTimesheets: true,
        canManageTimesheets: true,
        canManagePeriods: true,
      });
      // A team grant reaches its organization, but never organization-level device management.
      const team = await policies.organizations(fx.users.teamPolicyAdmin!);
      expect(team.items.map((o) => o.id)).toEqual([fx.orgA]);
      expect(team.items[0]!.actions).toMatchObject({
        canViewSignIns: false,
        canManagePolicies: true,
        canManageDevices: false,
      });
      expect(manager.items[0]!.workLocations).toEqual([]);
      // Organization-level device management also lists the kiosk locations.
      const devices = await policies.organizations(fx.users.deviceAdmin!);
      expect(devices.items[0]!.actions).toMatchObject({
        canManageDevices: true,
        canViewSignIns: false,
      });
      expect(devices.items[0]!.workLocations.map((l) => l.id)).toEqual(
        expect.arrayContaining([fx.workLocationToronto, fx.workLocationOttawa]),
      );
      expect(devices.items[0]!.physicalSites.map((site) => site.id)).toEqual([
        sharedSite.id,
      ]);
      expect(
        devices.items[0]!.physicalSites.map((site) => site.id),
      ).not.toEqual(
        expect.arrayContaining([
          orphanSite.id,
          archivedOnlySite.id,
          foreignSite.id,
          fx.physicalSiteToronto,
          fx.physicalSiteOttawa,
        ]),
      );
      // Clocking in is not administration.
      expect((await policies.organizations(fx.users.self1!)).items).toEqual([]);
    });
  });

  it('allows a kiosk to serve multiple work locations mapped to the same physical site', async () => {
    await scenario(async ({ tx, fx, svc, clock, kiosk }) => {
      await assignmentModes(tx, fx.assignmentTeamA, {
        captureMode: 'KIOSK_OR_SELF_SERVICE',
        kioskLocationRule: 'ASSIGNMENT_WORK_LOCATION',
      });
      await tx.workLocation.update({
        where: { id: fx.workLocationOttawa },
        data: { physicalSiteId: fx.physicalSiteToronto },
      });
      await tx.position.update({
        where: { id: fx.positionTeamA },
        data: { workLocationId: fx.workLocationOttawa },
      });
      clock.value = toronto('2027-03-02T09:00');

      await svc.time.kioskClockIn(kiosk, fx.employee1, fx.assignmentTeamA, {});

      const entry = await tx.timeEntry.findFirstOrThrow({
        where: { employeeId: fx.employee1 },
      });
      expect(entry.source).toBe('KIOSK');
    });
  });

  it('keeps kiosk-only open work off remote missed clock-out resolution', async () => {
    await scenario(async ({ tx, fx, svc, clock, kiosk }) => {
      await assignmentModes(tx, fx.assignmentTeamA, {
        captureMode: 'KIOSK_ONLY',
      });
      clock.value = toronto('2027-03-02T09:00');
      await svc.time.kioskClockIn(kiosk, fx.employee1, fx.assignmentTeamA, {});
      clock.value = toronto('2027-03-03T03:00');
      await svc.time.scanOpenTimeEntriesForExceptions();
      const missed = await tx.attendanceException.findFirstOrThrow({
        where: {
          employeeId: fx.employee1,
          type: 'MISSING_CLOCK_OUT',
          status: 'OPEN',
        },
      });
      expect((await svc.time.status(fx.selfUser1)).availableActions).toEqual(
        [],
      );
      expect(
        body(
          await rejection(
            svc.time.resolveMissedClockOut(
              fx.selfUser1,
              missed.id,
              '2027-03-02T17:00',
              ctx(fx.selfUser1),
            ),
          ),
        ),
      ).toMatchObject({ code: 'ATTENDANCE_CAPTURE_KIOSK_ONLY' });
      expect(
        await tx.timeEntry.count({
          where: { employeeId: fx.employee1, status: 'OPEN' },
        }),
      ).toBe(1);
    });
  });

  it('corrects an entry in its recorded timezone, not a later resolution', async () => {
    await scenario(async ({ tx, fx, svc, clock }) => {
      const self = ctx(fx.selfUser1);
      clock.value = toronto('2027-03-02T20:00');
      await svc.time.clockIn(fx.selfUser1, fx.assignmentTeamA, self);
      clock.value = toronto('2027-03-02T23:00');
      await svc.time.clockOut(fx.selfUser1, self);
      const entry = await tx.timeEntry.findFirstOrThrow({
        where: { employeeId: fx.employee1, status: 'CLOSED' },
      });
      expect(entry.timezone).toBe('America/Toronto');
      // The work location's timezone changes after the entry was recorded.
      const assignment = await tx.employmentAssignment.findUniqueOrThrow({
        where: { id: fx.assignmentTeamA },
        include: { position: true },
      });
      await tx.workLocation.update({
        where: { id: assignment.position.workLocationId! },
        data: { timezone: 'Asia/Tokyo' },
      });
      clock.value = toronto('2027-03-03T09:00');
      await svc.time.correctEntry(
        fx.users.timeManager!,
        entry.id,
        {
          type: 'CHANGE_CLOCK_OUT',
          reason: 'Left later',
          clockOutAt: '2027-03-02T23:30',
        },
        ctx(fx.users.timeManager!),
      );
      const corrected = await tx.timeEntry.findUniqueOrThrow({
        where: { id: entry.id },
      });
      expect(corrected).toMatchObject({
        timezone: 'America/Toronto',
        workDate: entry.workDate,
        clockOutAt: toronto('2027-03-02T23:30'),
      });
    });
  });
});
