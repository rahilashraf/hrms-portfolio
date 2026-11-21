import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service.js';
import type { PublishEventsOutcome } from '../src/notifications/notifications-events.js';
import {
  noticesOf,
  primeEventCheckpoints,
  publishEvents,
  transactionStart,
} from './support/event-notification-fixtures.js';
import { featureServices, setModule } from './support/features-fixtures.js';
import {
  FixedClock,
  grantMinutes,
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
  rollbackClient,
  violation,
  type SchedulingFixtures,
  type Tx,
} from './support/scheduling-fixtures.js';

config({ path: '../../.env' });

class RollbackFixtures extends Error {}

const SOURCE = 'events.leave-request';

/** Distinctive private texts that must never reach a notification. */
const SECRET_REASON = 'Secret-reason-surgery';
const SECRET_NOTE = 'Secret-decision-note';

/**
 * Batch 8 (N6, N7) — leave event notifications. The LEAVE source reads committed
 * LeaveRequestEvent rows and publishes to approvers (scoped leave.approve holders of the
 * request's assignment) or to the employee, never to the actor.
 *
 * Every event of a scenario carries the scenario transaction's `now()`, so a cursor left by an
 * earlier run inside the same scenario could sit after a later event's random id: `publish`
 * re-primes the checkpoint before each run and relies on the dedupe keys for earlier events.
 */
const USERS = {
  ...LEAVE_USERS,
  // Employee 2 (self2) approves Team A; hr / hr2 approve at organization scope.
  unitApprover: [
    { permissions: ['leave.approve'], scope: 'unitChild' as const },
  ],
  deptAApprover: [{ permissions: ['leave.approve'], scope: 'deptA' as const }],
  deptBApprover: [{ permissions: ['leave.approve'], scope: 'deptB' as const }],
  /** Team A and organization grants: exactly one notice. */
  overlap: [
    { permissions: ['leave.approve'], scope: 'teamA' as const },
    { permissions: ['leave.approve', 'leave.read'], scope: 'org' as const },
  ],
  revoked: [{ permissions: ['leave.approve'], scope: 'org' as const }],
  disabled: [{ permissions: ['leave.approve'], scope: 'org' as const }],
  archived: [{ permissions: ['leave.approve'], scope: 'org' as const }],
  archivedRole: [{ permissions: ['leave.approve'], scope: 'org' as const }],
  /** Leave reader without leave.approve. */
  orgReader: [{ permissions: ['leave.read'], scope: 'org' as const }],
  featureAdmin: [{ permissions: ['feature.manage'], scope: 'org' as const }],
};

interface Harness {
  tx: Tx;
  fx: SchedulingFixtures;
  svc: LeaveServices;
  types: Awaited<ReturnType<typeof seedLeaveConfig>>;
  /** Users with leave.approve SYSTEM scope only, and TEAM scope on another team (Team B). */
  systemAdmin: string;
  teamBApprover: string;
  /** Every authorized approver of Employee 1's Team A assignment (Employee 1 excluded). */
  teamAApprovers: string[];
  /** Users that hold some leave.approve but must never be notified for Team A leave. */
  neverApprovers: string[];
  /** Re-primes the leave checkpoint to the scenario start and runs the publisher. */
  publish: () => Promise<PublishEventsOutcome['sources'][number]>;
}

describe('Batch 8 leave event notifications (database)', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService(process.env.DATABASE_URL!);
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  async function grantRole(
    tx: Tx,
    userId: string,
    scope: {
      scopeType: 'SYSTEM' | 'ORGANIZATION' | 'ORGANIZATIONAL_UNIT' | 'TEAM';
      organizationId?: string;
      organizationalUnitId?: string;
      teamId?: string;
    },
    suffix: string,
    window: { startsAt?: Date; expiresAt?: Date } = {},
  ) {
    const permission = await tx.permission.findUniqueOrThrow({
      where: { key: 'leave.approve' },
    });
    // SYSTEM grants go through the one reserved System Owner role (a database check).
    const role =
      scope.scopeType === 'SYSTEM'
        ? ((await tx.role.findFirst({ where: { isSystemOwner: true } })) ??
          (await tx.role.create({
            data: {
              organizationId: null,
              code: 'SYSTEM_OWNER',
              name: 'System Owner',
              isSystemOwner: true,
            },
          })))
        : await tx.role.create({
            data: {
              organizationId: scope.organizationId!,
              code: `B8L-${scope.scopeType}-${suffix}-${userId.slice(0, 8)}`,
              name: 'Batch 8 leave role',
            },
          });
    await tx.rolePermission.upsert({
      where: {
        roleId_permissionId: { roleId: role.id, permissionId: permission.id },
      },
      create: { roleId: role.id, permissionId: permission.id },
      update: {},
    });
    await tx.roleAssignment.create({
      data: {
        userId,
        roleId: role.id,
        roleOrganizationId: scope.organizationId ?? null,
        ...scope,
        ...window,
      },
    });
  }

  async function newUser(tx: Tx, label: string, suffix: string) {
    const person = await tx.person.create({ data: {} });
    return (
      await tx.user.create({
        data: {
          personId: person.id,
          email: `b8l-${label}-${suffix.toLowerCase()}@example.com`,
          status: 'ACTIVE',
        },
      })
    ).id;
  }

  async function scenario(run: (h: Harness) => Promise<void>) {
    await expect(
      prisma.$transaction(
        async (tx) => {
          try {
            const fx = await createSchedulingFixtures(tx, USERS, [
              ...LEAVE_PERMISSIONS,
              ...TIME_PERMISSIONS,
              'feature.manage',
            ]);
            const client = rollbackClient(tx);
            const svc = leaveServices(client, new FixedClock());
            const types = await seedLeaveConfig(tx, fx, svc);
            await grantMinutes(
              svc,
              fx,
              fx.assignmentTeamA,
              types.vacation.id,
              4800,
            );
            const u = fx.users;
            // Revoked, expired, archived-role grants; disabled and archived accounts.
            const now = Date.now();
            await tx.roleAssignment.updateMany({
              where: { userId: u.revoked },
              data: { revokedAt: new Date(now) },
            });
            // Role assignment windows are immutable history: the expired grant is created so.
            const expired = await newUser(tx, 'expired', fx.suffix);
            await grantRole(
              tx,
              expired,
              { scopeType: 'ORGANIZATION', organizationId: fx.orgA },
              fx.suffix,
              {
                startsAt: new Date(now - 3_600_000),
                expiresAt: new Date(now - 60_000),
              },
            );
            await tx.role.updateMany({
              where: { assignments: { some: { userId: u.archivedRole } } },
              data: { archivedAt: new Date(now) },
            });
            await tx.user.update({
              where: { id: u.disabled },
              data: { status: 'DISABLED' },
            });
            await tx.user.update({
              where: { id: u.archived },
              data: { status: 'ARCHIVED', archivedAt: new Date(now) },
            });
            // SYSTEM-only approver; a Team B (Dept A) approver.
            const systemAdmin = await newUser(tx, 'system', fx.suffix);
            await grantRole(
              tx,
              systemAdmin,
              { scopeType: 'SYSTEM' },
              fx.suffix,
            );
            const teamB = await tx.team.create({
              data: {
                organizationId: fx.orgA,
                departmentId: fx.deptA,
                name: 'Team B',
                code: `TB-${fx.suffix}`,
              },
            });
            const teamBApprover = await newUser(tx, 'teamb', fx.suffix);
            await grantRole(
              tx,
              teamBApprover,
              { scopeType: 'TEAM', organizationId: fx.orgA, teamId: teamB.id },
              fx.suffix,
            );
            const start = await transactionStart(tx);
            await primeEventCheckpoints(tx, [SOURCE], start);
            await run({
              tx,
              fx,
              svc,
              types,
              systemAdmin,
              teamBApprover,
              teamAApprovers: [
                u.hr!,
                u.hr2!,
                fx.selfUser2,
                u.teamApprover!,
                u.unitApprover!,
                u.deptAApprover!,
                u.overlap!,
              ].sort(),
              neverApprovers: [
                systemAdmin,
                teamBApprover,
                u.deptBApprover!,
                u.outsider!,
                u.revoked!,
                expired,
                u.disabled!,
                u.archived!,
                u.archivedRole!,
                u.orgReader!,
                u.deptBReader!,
                u.admin!,
              ],
              publish: async () => {
                await primeEventCheckpoints(tx, [SOURCE], start);
                const outcome = await publishEvents(client, [SOURCE]);
                const source = outcome.sources.find(
                  (s) => s.source === SOURCE,
                )!;
                expect(source.failed).toEqual([]);
                return source;
              },
            }).catch((error: unknown) => {
              console.error(
                'SCENARIO FAILURE:',
                error instanceof Error ? error.message : error,
              );
              throw error;
            });
            throw new RollbackFixtures();
          } catch (error) {
            // Surface setup failures too (the outer assertion only sees the error type).
            if (!(error instanceof RollbackFixtures))
              console.error('SCENARIO SETUP FAILURE:', error);
            throw error;
          }
        },
        { timeout: 120_000 },
      ),
    ).rejects.toBeInstanceOf(RollbackFixtures);
  }

  const request = (
    assignment: string,
    leaveTypeId: string,
    startDate: string,
    endDate = startDate,
    extra: Record<string, unknown> = {},
  ) => ({
    employmentAssignmentId: assignment,
    leaveTypeId,
    startDate,
    endDate,
    ...extra,
  });

  /** Notices of a type about one request, as sorted recipient ids. */
  async function recipients(
    tx: Tx,
    fx: SchedulingFixtures,
    type: string,
    requestId: string,
  ) {
    return (await noticesOf(tx, fx.orgA, type))
      .filter((n) => n.sourceEntityId === requestId)
      .map((n) => n.recipientUserId)
      .sort();
  }

  async function notices(
    tx: Tx,
    fx: SchedulingFixtures,
    type: string,
    requestId: string,
  ) {
    return (await noticesOf(tx, fx.orgA, type)).filter(
      (n) => n.sourceEntityId === requestId,
    );
  }

  /** Every notice about a request (any type, any organization). */
  function allAbout(tx: Tx, requestId: string) {
    return tx.notification.findMany({
      where: { sourceEntityId: requestId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  }

  function expectPrivate(
    rows: Array<{ title: string; body: string }>,
    leaked: string[],
  ) {
    for (const row of rows) {
      // The employee name carries the random fixture suffix (hex): leave it out of the check.
      const text = `${row.title}\n${row.body}`.replace(/Employee\d \w+/g, '');
      for (const value of leaked) expect(text).not.toContain(value);
      expect(text).not.toMatch(/minute|hour|balance/i);
    }
  }

  // ─── Submitted: the N7 approver matrix ────────────────────────────────────

  it('notifies exactly the scoped approvers of a self-submitted request', async () => {
    await scenario(
      async ({
        tx,
        fx,
        svc,
        types,
        teamAApprovers,
        neverApprovers,
        publish,
      }) => {
        const submitted = await svc.requests.submitOwn(
          fx.selfUser1,
          request(
            fx.assignmentTeamA,
            types.vacation.id,
            '2027-03-08',
            '2027-03-10',
            { reason: SECRET_REASON },
          ),
          ctx(fx.selfUser1),
        );
        expect(submitted.status).toBe('PENDING');
        const outcome = await publish();
        expect(outcome.events).toBe(1);
        expect(outcome.created).toBe(teamAApprovers.length);

        const rows = await notices(
          tx,
          fx,
          'leave.request-submitted',
          submitted.requestId,
        );
        expect(rows.map((n) => n.recipientUserId).sort()).toEqual(
          teamAApprovers,
        );
        // Not the employee; nobody without an applicable scoped grant.
        expect(rows.map((n) => n.recipientUserId)).not.toContain(fx.selfUser1);
        for (const user of neverApprovers)
          expect(rows.map((n) => n.recipientUserId)).not.toContain(user);
        // Overlapping team + organization grants: one notice.
        expect(
          rows.filter((n) => n.recipientUserId === fx.users.overlap).length,
        ).toBe(1);
        for (const row of rows) {
          expect(row.link).toBe('/admin/leave');
          expect(row.organizationId).toBe(fx.orgA);
          expect(row.sourceEntityType).toBe('LeaveRequest');
          expect(row.body).toContain(`Employee1 ${fx.suffix}`);
          expect(row.body).toContain('2027-03-08');
          expect(row.body).toContain('2027-03-10');
        }
        expectPrivate(rows, [
          'Vacation',
          'VAC',
          SECRET_REASON,
          '480',
          '1440',
          '4800',
        ]);
        // Nothing else was published about it.
        expect((await allAbout(tx, submitted.requestId)).length).toBe(
          teamAApprovers.length,
        );

        // Employee 2 approves Team A but is never notified of their own request.
        const own2 = await svc.requests.submitOwn(
          fx.selfUser2,
          request(fx.otherTeamA, types.personal.id, '2027-03-22'),
          ctx(fx.selfUser2),
        );
        // A grant on the parent (root) unit of Team A's unit: notified exactly when the leave
        // service itself lets that user decide the request.
        const rootApprover = await newUser(tx, 'root', fx.suffix);
        await grantRole(
          tx,
          rootApprover,
          {
            scopeType: 'ORGANIZATIONAL_UNIT',
            organizationId: fx.orgA,
            organizationalUnitId: fx.unitRoot,
          },
          fx.suffix,
        );
        const rootMayApprove = await svc.access
          .requireAssignmentPermission(
            rootApprover,
            fx.otherTeamA,
            'leave.approve',
          )
          .then(
            () => true,
            () => false,
          );
        // Unit grants reach descendant units' teams.
        expect(rootMayApprove).toBe(true);
        await publish();
        expect(
          await recipients(tx, fx, 'leave.request-submitted', own2.requestId),
        ).toEqual(
          [
            ...teamAApprovers.filter((id) => id !== fx.selfUser2),
            ...(rootMayApprove ? [rootApprover] : []),
          ].sort(),
        );

        // Dept B assignment: only organization, Dept B approvers (no unit / Team A ones).
        const deptB = await svc.requests.submitOwn(
          fx.selfUser1,
          request(fx.assignmentDeptB, types.personal.id, '2027-03-15'),
          ctx(fx.selfUser1),
        );
        await publish();
        expect(
          await recipients(tx, fx, 'leave.request-submitted', deptB.requestId),
        ).toEqual(
          [
            fx.users.hr!,
            fx.users.hr2!,
            fx.users.overlap!,
            fx.users.deptBApprover!,
          ].sort(),
        );
      },
    );
  });

  it('notifies approvers and the employee of leave submitted on their behalf', async () => {
    await scenario(
      async ({
        tx,
        fx,
        svc,
        types,
        teamAApprovers,
        neverApprovers,
        publish,
      }) => {
        const actor = fx.users.teamApprover!;
        const pending = await svc.requests.createOnBehalf(
          actor,
          request(
            fx.assignmentTeamA,
            types.personal.id,
            '2027-03-08',
            '2027-03-09',
            {
              reason: SECRET_REASON,
            },
          ),
          ctx(actor),
        );
        expect(pending.status).toBe('PENDING');
        // Recorded and approved at once: SUBMITTED is no longer pending when published.
        const approved = await svc.requests.createOnBehalf(
          fx.users.hr!,
          {
            ...request(fx.assignmentTeamA, types.personal.id, '2027-03-15'),
            approve: true,
            note: SECRET_NOTE,
          },
          ctx(fx.users.hr!),
        );
        expect(approved.status).toBe('APPROVED');
        await publish();

        const rows = await notices(
          tx,
          fx,
          'leave.request-submitted',
          pending.requestId,
        );
        expect(rows.map((n) => n.recipientUserId).sort()).toEqual(
          [...teamAApprovers.filter((id) => id !== actor), fx.selfUser1].sort(),
        );
        for (const row of rows)
          expect(row.link).toBe(
            row.recipientUserId === fx.selfUser1 ? '/leave' : '/admin/leave',
          );
        for (const user of neverApprovers)
          expect(rows.map((n) => n.recipientUserId)).not.toContain(user);
        expectPrivate(rows, ['Personal', 'PERS', SECRET_REASON]);

        // Already approved: no approver gets SUBMITTED; the employee is told it was recorded
        // and approved.
        expect(
          await recipients(
            tx,
            fx,
            'leave.request-submitted',
            approved.requestId,
          ),
        ).toEqual([fx.selfUser1]);
        expect(
          await recipients(
            tx,
            fx,
            'leave.request-approved',
            approved.requestId,
          ),
        ).toEqual([fx.selfUser1]);
        expectPrivate(await allAbout(tx, approved.requestId), [
          SECRET_NOTE,
          'Personal',
        ]);
      },
    );
  });

  // ─── Decisions ────────────────────────────────────────────────────────────

  it('tells only the employee about approvals and rejections', async () => {
    await scenario(async ({ tx, fx, svc, types, teamAApprovers, publish }) => {
      const self1 = ctx(fx.selfUser1);
      const toApprove = await svc.requests.submitOwn(
        fx.selfUser1,
        request(
          fx.assignmentTeamA,
          types.vacation.id,
          '2027-03-08',
          '2027-03-09',
          {
            reason: SECRET_REASON,
          },
        ),
        self1,
      );
      const toReject = await svc.requests.submitOwn(
        fx.selfUser1,
        request(
          fx.assignmentTeamA,
          types.vacation.id,
          '2027-03-15',
          '2027-03-16',
        ),
        self1,
      );
      await svc.requests.approve(
        fx.users.hr!,
        toApprove.requestId,
        { note: SECRET_NOTE },
        ctx(fx.users.hr!),
      );
      await svc.requests.reject(
        fx.users.teamApprover!,
        toReject.requestId,
        { note: SECRET_NOTE },
        ctx(fx.users.teamApprover!),
      );
      await publish();

      const approved = await notices(
        tx,
        fx,
        'leave.request-approved',
        toApprove.requestId,
      );
      expect(approved.map((n) => n.recipientUserId)).toEqual([fx.selfUser1]);
      expect(approved[0]!.link).toBe('/leave');
      expect(approved[0]!.body).toContain('2027-03-08');
      expect(approved[0]!.body).toContain('2027-03-09');
      const rejected = await notices(
        tx,
        fx,
        'leave.request-rejected',
        toReject.requestId,
      );
      expect(rejected.map((n) => n.recipientUserId)).toEqual([fx.selfUser1]);
      expect(rejected[0]!.link).toBe('/leave');
      // The decided requests are no longer pending: approvers got no SUBMITTED for them.
      expect(
        await recipients(
          tx,
          fx,
          'leave.request-submitted',
          toApprove.requestId,
        ),
      ).toEqual([]);
      expect(
        await recipients(tx, fx, 'leave.request-rejected', toApprove.requestId),
      ).toEqual([]);
      for (const user of teamAApprovers) {
        expect(approved.map((n) => n.recipientUserId)).not.toContain(user);
        expect(rejected.map((n) => n.recipientUserId)).not.toContain(user);
      }
      expectPrivate(
        [
          ...(await allAbout(tx, toApprove.requestId)),
          ...(await allAbout(tx, toReject.requestId)),
        ],
        ['Vacation', 'VAC', SECRET_REASON, SECRET_NOTE, '960', '4800'],
      );
    });
  });

  // ─── Cancellations and shortening ─────────────────────────────────────────

  it('routes cancellations and shortenings by who acted', async () => {
    await scenario(async ({ tx, fx, svc, types, teamAApprovers, publish }) => {
      const self1 = ctx(fx.selfUser1);
      const hr = ctx(fx.users.hr!);
      const submit = (start: string, end: string) =>
        svc.requests.submitOwn(
          fx.selfUser1,
          request(fx.assignmentTeamA, types.vacation.id, start, end, {
            reason: SECRET_REASON,
          }),
          self1,
        );

      // 1. The employee withdraws a pending request → approvers.
      const withdrawn = await submit('2027-03-08', '2027-03-08');
      await svc.requests.cancelOwn(
        fx.selfUser1,
        withdrawn.requestId,
        { reason: SECRET_REASON },
        self1,
      );
      // 2. The employee cancels approved future leave (an amendment of type CANCEL) → approvers,
      //    exactly once (the AMENDED event is skipped).
      const ownCancel = await submit('2027-03-15', '2027-03-16');
      await svc.requests.approve(fx.users.hr!, ownCancel.requestId, {}, hr);
      expect(
        await svc.requests.cancelOwn(
          fx.selfUser1,
          ownCancel.requestId,
          { reason: SECRET_REASON },
          self1,
        ),
      ).toMatchObject({ status: 'CANCELLED' });
      // 3. HR cancels approved leave entirely through amend (CANCEL) → the employee, once.
      const hrCancel = await submit('2027-03-22', '2027-03-23');
      await svc.requests.approve(fx.users.hr!, hrCancel.requestId, {}, hr);
      expect(
        await svc.requests.amend(
          fx.users.hr!,
          hrCancel.requestId,
          { reason: SECRET_REASON },
          hr,
        ),
      ).toMatchObject({ status: 'CANCELLED' });
      // 4. HR shortens approved leave (SHORTEN, 2 of 3 days) → the employee, "changed".
      const hrShorten = await submit('2027-03-29', '2027-03-31');
      await svc.requests.approve(fx.users.hr!, hrShorten.requestId, {}, hr);
      expect(
        await svc.requests.amend(
          fx.users.hr!,
          hrShorten.requestId,
          { reason: SECRET_REASON, cancelFrom: '2027-03-30' },
          hr,
        ),
      ).toMatchObject({ status: 'APPROVED' });
      // 5. The employee cancels the rest of leave already started (SHORTEN, 1 of 3 days)
      //    → approvers, "changed".
      const ownShorten = await submit('2027-04-05', '2027-04-07');
      await svc.requests.approve(fx.users.hr!, ownShorten.requestId, {}, hr);
      const realNow = svc.requests.now;
      svc.requests.now = () => new Date('2027-04-06T15:00:00.000Z');
      try {
        expect(
          await svc.requests.cancelOwn(
            fx.selfUser1,
            ownShorten.requestId,
            { reason: SECRET_REASON },
            self1,
          ),
        ).toMatchObject({ status: 'APPROVED' });
      } finally {
        svc.requests.now = realNow;
      }
      const amendments = await tx.leaveRequestAmendment.findMany({
        where: {
          requestId: {
            in: [
              ownCancel.requestId,
              hrCancel.requestId,
              hrShorten.requestId,
              ownShorten.requestId,
            ],
          },
        },
      });
      expect(
        Object.fromEntries(amendments.map((a) => [a.requestId, a.type])),
      ).toEqual({
        [ownCancel.requestId]: 'CANCEL',
        [hrCancel.requestId]: 'CANCEL',
        [hrShorten.requestId]: 'SHORTEN',
        [ownShorten.requestId]: 'SHORTEN',
      });
      const outcome = await publish();
      expect(outcome.failed).toEqual([]);

      const cancelled = (id: string) =>
        recipients(tx, fx, 'leave.request-cancelled', id);
      const changed = (id: string) =>
        recipients(tx, fx, 'leave.request-changed', id);

      expect(await cancelled(withdrawn.requestId)).toEqual(teamAApprovers);
      expect(await cancelled(ownCancel.requestId)).toEqual(teamAApprovers);
      expect(await changed(ownCancel.requestId)).toEqual([]);
      expect(await cancelled(hrCancel.requestId)).toEqual([fx.selfUser1]);
      expect(await changed(hrCancel.requestId)).toEqual([]);
      expect(await cancelled(hrShorten.requestId)).toEqual([]);
      expect(await changed(hrShorten.requestId)).toEqual([fx.selfUser1]);
      expect(await cancelled(ownShorten.requestId)).toEqual([]);
      expect(await changed(ownShorten.requestId)).toEqual(teamAApprovers);

      // Links follow the recipient: approvers → /admin/leave, the employee → /leave.
      for (const row of await notices(
        tx,
        fx,
        'leave.request-cancelled',
        ownCancel.requestId,
      ))
        expect(row.link).toBe('/admin/leave');
      const [hrCancelRow] = await notices(
        tx,
        fx,
        'leave.request-cancelled',
        hrCancel.requestId,
      );
      expect(hrCancelRow!.link).toBe('/leave');
      expect(hrCancelRow!.body).toContain(`Employee1 ${fx.suffix}`);
      expect(hrCancelRow!.body).toContain('2027-03-22');

      // cancelledDayCount: 2 days by HR, 1 day by the employee.
      const [hrShortenRow] = await notices(
        tx,
        fx,
        'leave.request-changed',
        hrShorten.requestId,
      );
      expect(hrShortenRow!.link).toBe('/leave');
      expect(hrShortenRow!.body).toContain('2 day(s)');
      expect(hrShortenRow!.body).toContain('2027-03-29');
      expect(hrShortenRow!.body).toContain('2027-03-31');
      const ownShortenRows = await notices(
        tx,
        fx,
        'leave.request-changed',
        ownShorten.requestId,
      );
      for (const row of ownShortenRows) {
        expect(row.link).toBe('/admin/leave');
        expect(row.body).toContain('1 day(s)');
      }

      const ids = [
        withdrawn.requestId,
        ownCancel.requestId,
        hrCancel.requestId,
        hrShorten.requestId,
        ownShorten.requestId,
      ];
      const all = (await Promise.all(ids.map((id) => allAbout(tx, id)))).flat();
      expectPrivate(all, [
        'Vacation',
        'VAC',
        SECRET_REASON,
        '960',
        '1440',
        '4800',
      ]);
    });
  });

  // ─── Dedupe and replay ────────────────────────────────────────────────────

  it('publishes each event once: replays and no-op retries create nothing', async () => {
    await scenario(async ({ tx, fx, svc, types, teamAApprovers, publish }) => {
      const self1 = ctx(fx.selfUser1);
      const hr = ctx(fx.users.hr!);
      const first = await svc.requests.submitOwn(
        fx.selfUser1,
        request(fx.assignmentTeamA, types.vacation.id, '2027-03-08'),
        self1,
      );
      await svc.requests.approve(fx.users.hr!, first.requestId, {}, hr);
      const initial = await publish();
      expect(initial.events).toBe(2);
      // Approved before the run: only the approval notice (SUBMITTED is no longer pending).
      expect(initial.created).toBe(1);
      const total = () =>
        tx.notification.count({ where: { organizationId: fx.orgA } });
      const count = await total();

      // The same run again from the saved cursor: no events left.
      const again = await publishEvents(rollbackClient(tx), [SOURCE]);
      expect(again.sources[0]).toMatchObject({ events: 0, created: 0 });
      // A full replay from the scenario start: everything already exists.
      const replay = await publish();
      expect(replay).toMatchObject({ events: 2, created: 0, existing: 1 });
      expect(await total()).toBe(count);

      // A no-op retry of the approval is refused and records no event.
      const retry = await violation(tx, () =>
        svc.requests.approve(fx.users.hr!, first.requestId, {}, hr),
      );
      expect(
        (retry as { getResponse(): Record<string, unknown> }).getResponse(),
      ).toMatchObject({ code: 'LEAVE_REQUEST_NOT_PENDING' });
      expect(await publish()).toMatchObject({ events: 2, created: 0 });
      expect(await total()).toBe(count);

      // A repeated real transition (a new request for other dates) gets its own notices.
      const second = await svc.requests.submitOwn(
        fx.selfUser1,
        request(fx.assignmentTeamA, types.vacation.id, '2027-03-09'),
        self1,
      );
      const next = await publish();
      expect(next.events).toBe(3);
      expect(next.created).toBe(teamAApprovers.length);
      expect(
        await recipients(tx, fx, 'leave.request-submitted', second.requestId),
      ).toEqual(teamAApprovers);
      // Dedupe keys are per event and recipient.
      const keys = (
        await noticesOf(tx, fx.orgA, 'leave.request-submitted')
      ).map((n) => `${n.recipientUserId}|${n.dedupeKey}`);
      expect(new Set(keys).size).toBe(keys.length);
      expect(await total()).toBe(count + teamAApprovers.length);
    });
  });

  // ─── Module gate and organization isolation ───────────────────────────────

  it('publishes nothing while LEAVE is disabled, and never across organizations', async () => {
    await scenario(async ({ tx, fx, svc, types, teamAApprovers, publish }) => {
      const submitted = await svc.requests.submitOwn(
        fx.selfUser1,
        request(fx.assignmentTeamA, types.vacation.id, '2027-03-08'),
        ctx(fx.selfUser1),
      );
      const features = featureServices(rollbackClient(tx));
      await setModule(features, fx, 'LEAVE', false);
      const gated = await publish();
      expect(gated).toMatchObject({ events: 1, created: 0 });
      expect(gated.skipped).toBe(teamAApprovers.length);
      expect(await allAbout(tx, submitted.requestId)).toEqual([]);
      // The skipped event is behind the cursor; a run after re-enabling (from the saved
      // cursor) publishes no old events.
      await setModule(features, fx, 'LEAVE', true);
      const after = await publishEvents(rollbackClient(tx), [SOURCE]);
      expect(after.sources[0]).toMatchObject({ events: 0, created: 0 });

      // Isolation: Org B's leave approver never receives Org A notices.
      const other = await svc.requests.submitOwn(
        fx.selfUser1,
        request(fx.assignmentTeamA, types.vacation.id, '2027-03-15'),
        ctx(fx.selfUser1),
      );
      await svc.requests.approve(
        fx.users.hr!,
        other.requestId,
        {},
        ctx(fx.users.hr!),
      );
      const third = await svc.requests.submitOwn(
        fx.selfUser1,
        request(fx.assignmentTeamA, types.vacation.id, '2027-03-22'),
        ctx(fx.selfUser1),
      );
      await publish();
      expect(
        await recipients(tx, fx, 'leave.request-submitted', third.requestId),
      ).toEqual(teamAApprovers);
      expect(
        await tx.notification.count({
          where: { recipientUserId: fx.users.outsider },
        }),
      ).toBe(0);
      expect(
        await tx.notification.count({ where: { organizationId: fx.orgB } }),
      ).toBe(0);
      for (const id of [other.requestId, third.requestId])
        for (const row of await allAbout(tx, id))
          expect(row.organizationId).toBe(fx.orgA);
    });
  });
});
