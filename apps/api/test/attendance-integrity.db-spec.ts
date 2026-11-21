import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service.js';
import {
  createSchedulingFixtures,
  violation,
  type SchedulingFixtures,
  type Tx,
} from './support/scheduling-fixtures.js';

config({ path: '../../.env' });

class RollbackFixtures extends Error {}

/** The database's own message (Prisma reports restrict_violation as a foreign key error). */
const message = (error: unknown) => {
  const cause = (
    error as {
      meta?: { driverAdapterError?: { cause?: { originalMessage?: string } } };
    }
  )?.meta?.driverAdapterError?.cause;
  return cause?.originalMessage ?? String((error as Error)?.message ?? error);
};

/**
 * Phase 9.5 database invariants, independent of the services: devices, credentials and
 * sign-ins keep their history, kiosk attendance always names an active device of the right
 * organization, and presence never carries clock exceptions.
 */
describe('Attendance kiosk integrity (database)', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService(process.env.DATABASE_URL!);
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  async function scenario(
    run: (tx: Tx, fx: SchedulingFixtures) => Promise<void>,
  ) {
    await expect(
      prisma.$transaction(
        async (tx) => {
          const fx = await createSchedulingFixtures(tx, {});
          await run(tx, fx);
          throw new RollbackFixtures();
        },
        { timeout: 60_000 },
      ),
    ).rejects.toBeInstanceOf(RollbackFixtures);
  }

  const device = (tx: Tx, fx: SchedulingFixtures, name = 'Front desk') =>
    tx.attendanceDevice.create({
      data: {
        organizationId: fx.orgA,
        physicalSiteId: fx.physicalSiteToronto,
        name,
        credentialHash: `hash-${name}-${fx.suffix}`,
        credentialIssuedAt: new Date(),
      },
    });

  const signIn = (
    fx: SchedulingFixtures,
    data: Record<string, unknown> = {},
  ) => ({
    employeeId: fx.employee1,
    employmentAssignmentId: fx.assignmentTeamA,
    signedInAt: new Date('2027-03-02T17:30:00.000Z'),
    timezone: 'America/Toronto',
    workDate: new Date('2027-03-02T00:00:00.000Z'),
    source: 'LIVE_CLOCK' as const,
    ...data,
  });

  it('keeps devices at a usable site, final once revoked, and never deleted', async () => {
    await scenario(async (tx, fx) => {
      // Another organization's site cannot be attached to this organization's device.
      const orgBSite = await tx.physicalSite.create({
        data: {
          organizationId: fx.orgB,
          name: `B site ${fx.suffix}`,
        },
      });
      expect(
        await violation(tx, () =>
          tx.attendanceDevice.create({
            data: {
              organizationId: fx.orgA,
              physicalSiteId: orgBSite.id,
              name: 'Y',
            },
          }),
        ),
      ).toBeTruthy();

      const kiosk = await device(tx, fx);
      // Revocation must record when and why, and drop the secret.
      expect(
        await violation(tx, () =>
          tx.attendanceDevice.update({
            where: { id: kiosk.id },
            data: { status: 'REVOKED', revokedAt: new Date() },
          }),
        ),
      ).toBeTruthy();
      await tx.attendanceDevice.update({
        where: { id: kiosk.id },
        data: {
          status: 'REVOKED',
          revokedAt: new Date(),
          revokedReason: 'Stolen',
          credentialHash: null,
          credentialIssuedAt: null,
        },
      });
      expect(
        message(
          await violation(tx, () =>
            tx.attendanceDevice.update({
              where: { id: kiosk.id },
              data: { name: 'Again' },
            }),
          ),
        ),
      ).toMatch(/revoked attendance device is final/);
      expect(
        message(
          await violation(tx, () =>
            tx.attendanceDevice.delete({ where: { id: kiosk.id } }),
          ),
        ),
      ).toMatch(/never deleted/);
    });
  });

  it('keeps one active credential per employee, hashed, with a fixed secret', async () => {
    await scenario(async (tx, fx) => {
      const pin = await tx.attendanceCredential.create({
        data: {
          employeeId: fx.employee1,
          type: 'PIN',
          secretHash: '$argon2id$x',
        },
      });
      // A PIN needs a hash; a second active PIN is refused.
      expect(
        await violation(tx, () =>
          tx.attendanceCredential.create({
            data: { employeeId: fx.employee2, type: 'PIN' },
          }),
        ),
      ).toBeTruthy();
      expect(
        await violation(tx, () =>
          tx.attendanceCredential.create({
            data: {
              employeeId: fx.employee1,
              type: 'PIN',
              secretHash: '$argon2id$y',
            },
          }),
        ),
      ).toBeTruthy();
      // The secret never changes in place; lockout counters may.
      expect(
        message(
          await violation(tx, () =>
            tx.attendanceCredential.update({
              where: { id: pin.id },
              data: { secretHash: '$argon2id$z' },
            }),
          ),
        ),
      ).toMatch(/secret is fixed/);
      await tx.attendanceCredential.update({
        where: { id: pin.id },
        data: { failedAttempts: 3 },
      });
      // A reset: revoke, then issue anew. Revoked credentials are frozen and never deleted.
      await tx.attendanceCredential.update({
        where: { id: pin.id },
        data: {
          status: 'REVOKED',
          revokedAt: new Date(),
          revokedReason: 'Reset',
        },
      });
      await tx.attendanceCredential.create({
        data: {
          employeeId: fx.employee1,
          type: 'PIN',
          secretHash: '$argon2id$new',
        },
      });
      expect(
        message(
          await violation(tx, () =>
            tx.attendanceCredential.update({
              where: { id: pin.id },
              data: { failedAttempts: 0 },
            }),
          ),
        ),
      ).toMatch(/revoked attendance credential is final/);
      expect(
        message(
          await violation(tx, () =>
            tx.attendanceCredential.delete({ where: { id: pin.id } }),
          ),
        ),
      ).toMatch(/never deleted/);
    });
  });

  it('records sign-ins with an explicit source, never edits or deletes them, and only voids once', async () => {
    await scenario(async (tx, fx) => {
      const kiosk = await device(tx, fx);
      // KIOSK names its device; nothing else does. MANUAL names who and why.
      expect(
        await violation(tx, () =>
          tx.attendanceSignIn.create({ data: signIn(fx, { source: 'KIOSK' }) }),
        ),
      ).toBeTruthy();
      expect(
        await violation(tx, () =>
          tx.attendanceSignIn.create({
            data: signIn(fx, { attendanceDeviceId: kiosk.id }),
          }),
        ),
      ).toBeTruthy();
      expect(
        await violation(tx, () =>
          tx.attendanceSignIn.create({
            data: signIn(fx, { source: 'MANUAL' }),
          }),
        ),
      ).toBeTruthy();
      const kioskSignIn = await tx.attendanceSignIn.create({
        data: signIn(fx, {
          source: 'KIOSK',
          attendanceDeviceId: kiosk.id,
          workLocationId: fx.workLocationToronto,
        }),
      });
      // Immutable: no edits, no deletes.
      expect(
        message(
          await violation(tx, () =>
            tx.attendanceSignIn.update({
              where: { id: kioskSignIn.id },
              data: { signedInAt: new Date() },
            }),
          ),
        ),
      ).toMatch(/only be voided/);
      expect(
        message(
          await violation(tx, () =>
            tx.attendanceSignIn.delete({ where: { id: kioskSignIn.id } }),
          ),
        ),
      ).toMatch(/never deleted/);
      // A void records who and why, once.
      expect(
        await violation(tx, () =>
          tx.attendanceSignIn.update({
            where: { id: kioskSignIn.id },
            data: { status: 'VOIDED', voidedAt: new Date() },
          }),
        ),
      ).toBeTruthy();
      await tx.attendanceSignIn.update({
        where: { id: kioskSignIn.id },
        data: {
          status: 'VOIDED',
          voidedAt: new Date(),
          voidedByUserId: fx.selfUser2,
          voidReason: 'Duplicate',
        },
      });
      expect(
        message(
          await violation(tx, () =>
            tx.attendanceSignIn.update({
              where: { id: kioskSignIn.id },
              data: { voidReason: 'Changed' },
            }),
          ),
        ),
      ).toMatch(/only be voided, once/);
      // A replacement is MANUAL and links what it replaces.
      await tx.attendanceSignIn.create({
        data: signIn(fx, {
          source: 'MANUAL',
          recordedByUserId: fx.selfUser2,
          reason: 'Signed in on paper',
          replacesSignInId: kioskSignIn.id,
        }),
      });
      // Idempotency keys are unique per employee.
      await tx.attendanceSignIn.create({
        data: signIn(fx, { idempotencyKey: 'k-1' }),
      });
      expect(
        await violation(tx, () =>
          tx.attendanceSignIn.create({
            data: signIn(fx, { idempotencyKey: 'k-1' }),
          }),
        ),
      ).toBeTruthy();
    });
  });

  it('accepts kiosk attendance only from an active device of the assignment organization', async () => {
    await scenario(async (tx, fx) => {
      const kiosk = await device(tx, fx);
      await tx.attendanceDevice.update({
        where: { id: kiosk.id },
        data: { status: 'DISABLED' },
      });
      expect(
        message(
          await violation(tx, () =>
            tx.attendanceSignIn.create({
              data: signIn(fx, {
                source: 'KIOSK',
                attendanceDeviceId: kiosk.id,
              }),
            }),
          ),
        ),
      ).toMatch(/Only an active attendance device/);
      expect(
        message(
          await violation(tx, () =>
            tx.timePunch.create({
              data: {
                employeeId: fx.employee1,
                employmentAssignmentId: fx.assignmentTeamA,
                type: 'CLOCK_IN',
                occurredAt: new Date(),
                timezone: 'America/Toronto',
                source: 'KIOSK',
                attendanceDeviceId: kiosk.id,
              },
            }),
          ),
        ),
      ).toMatch(/Only an active attendance device/);
      // A KIOSK punch always names its device.
      expect(
        await violation(tx, () =>
          tx.timePunch.create({
            data: {
              employeeId: fx.employee1,
              employmentAssignmentId: fx.assignmentTeamA,
              type: 'CLOCK_IN',
              occurredAt: new Date(),
              timezone: 'America/Toronto',
              source: 'KIOSK',
            },
          }),
        ),
      ).toBeTruthy();
      // Another organization's device never records Org A attendance.
      const orgBSite = await tx.physicalSite.create({
        data: {
          organizationId: fx.orgB,
          name: `B site 2 ${fx.suffix}`,
        },
      });
      const orgBKiosk = await tx.attendanceDevice.create({
        data: {
          organizationId: fx.orgB,
          physicalSiteId: orgBSite.id,
          name: 'B kiosk',
        },
      });
      expect(
        message(
          await violation(tx, () =>
            tx.attendanceSignIn.create({
              data: signIn(fx, {
                source: 'KIOSK',
                attendanceDeviceId: orgBKiosk.id,
              }),
            }),
          ),
        ),
      ).toMatch(/its own organization/);
      // No attendance on a cancelled assignment.
      await tx.employmentAssignment.update({
        where: { id: fx.orgLevel },
        data: { status: 'CANCELLED' },
      });
      expect(
        message(
          await violation(tx, () =>
            tx.attendanceSignIn.create({
              data: signIn(fx, {
                employeeId: fx.employee2,
                employmentAssignmentId: fx.orgLevel,
              }),
            }),
          ),
        ),
      ).toMatch(/cancelled assignment/);
    });
  });

  it('links presence exceptions to sign-ins only, and clock exceptions never to sign-ins', async () => {
    await scenario(async (tx, fx) => {
      const presence = await tx.attendanceSignIn.create({ data: signIn(fx) });
      const base = {
        employeeId: fx.employee1,
        employmentAssignmentId: fx.assignmentTeamA,
        severity: 'REVIEW' as const,
        workflowImpact: 'NON_BLOCKING' as const,
      };
      await tx.attendanceException.create({
        data: {
          ...base,
          attendanceSignInId: presence.id,
          type: 'LATE_SIGN_IN',
        },
      });
      // One open per sign-in and type.
      expect(
        await violation(tx, () =>
          tx.attendanceException.create({
            data: {
              ...base,
              attendanceSignInId: presence.id,
              type: 'LATE_SIGN_IN',
            },
          }),
        ),
      ).toBeTruthy();
      // A sign-in never carries clock-out (or any time-entry) exceptions...
      for (const type of [
        'MISSING_CLOCK_OUT',
        'OPEN_BREAK_AUTO_CLOSED',
        'LATE_ARRIVAL',
      ] as const) {
        expect(
          await violation(tx, () =>
            tx.attendanceException.create({
              data: { ...base, attendanceSignInId: presence.id, type },
            }),
          ),
        ).toBeTruthy();
      }
      // ...and presence signals need a sign-in.
      expect(
        await violation(tx, () =>
          tx.attendanceException.create({
            data: {
              ...base,
              employmentAssignmentId: null,
              type: 'UNSCHEDULED_SIGN_IN',
            },
          }),
        ),
      ).toBeTruthy();
    });
  });
});
