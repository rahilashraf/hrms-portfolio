import { randomUUID } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '../src/audit/audit.service.js';
import { AuthorizationService } from '../src/authorization/authorization.service.js';
import { PositionAuthorizationTargetResolver } from '../src/authorization/position-authorization-target.resolver.js';
import { RoleManagementService } from '../src/authorization/role-management.service.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { EmployeeAccessService } from '../src/employee/employee-access.service.js';
import { EmployeeDomainService } from '../src/employee/employee-domain.service.js';
import { EmployeeLifecycleService } from '../src/employee/employee-lifecycle.service.js';
import { EmployeeService } from '../src/employee/employee.service.js';
import {
  createSchedulingFixtures,
  ctx,
  rejection,
  rollbackClient,
  type SchedulingFixtures,
  type Tx,
} from './support/scheduling-fixtures.js';

config({ path: '../../.env', quiet: true });

class RollbackFixtures extends Error {}

const MANAGE = ['employee.manage', 'employee.read'];
const USERS = {
  hrA: [{ permissions: MANAGE, scope: 'org' as const }],
  hrB: [{ permissions: MANAGE, scope: 'orgB' as const }],
  teamAHr: [{ permissions: MANAGE, scope: 'teamA' as const }],
  readerA: [{ permissions: ['employee.read'], scope: 'org' as const }],
};
const TORONTO = 'America/Toronto';
const NOW = new Date('2026-11-04T17:00:00.000Z'); // Toronto: Wednesday 2026-11-04, 12:00
const GRANTS_FROM = new Date('2026-01-01T00:00:00.000Z');
const d = (value: string) => new Date(`${value}T00:00:00.000Z`);
const codeOf = (error: unknown) =>
  ((error as HttpException).getResponse?.() as { code?: string } | undefined)
    ?.code;
const statusOf = (error: unknown) => (error as HttpException).getStatus?.();

function services(client: PrismaService) {
  const authorization = new AuthorizationService(client);
  const audit = new AuditService(client);
  const targets = new PositionAuthorizationTargetResolver(client);
  const domain = new EmployeeDomainService(client, audit);
  const access = new EmployeeAccessService(
    client,
    authorization,
    targets,
    audit,
  );
  const lifecycle = new EmployeeLifecycleService(
    client,
    domain,
    access,
    authorization,
    audit,
    new RoleManagementService(client, authorization, audit),
  );
  const employees = new EmployeeService(
    client,
    domain,
    access,
    authorization,
    targets,
    audit,
    lifecycle,
  );
  return { lifecycle, employees };
}

/**
 * Batch R4-A.1 and R4-A.2 (backend): the manual lifecycle panel's data and action, and HR profile
 * edits that clear optional fields with a privacy-preserving before/after audit.
 */
describe('R4-A lifecycle due list and profile edits (database)', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService(process.env.DATABASE_URL!);
    await prisma.$connect();
  });
  afterAll(async () => {
    await prisma?.$disconnect();
  });

  async function scenario(
    run: (h: {
      tx: Tx;
      fx: SchedulingFixtures;
      client: PrismaService;
    }) => Promise<void>,
  ) {
    await expect(
      prisma.$transaction(
        async (tx) => {
          const fx = await createSchedulingFixtures(tx, USERS, undefined, {
            grantsStartAt: GRANTS_FROM,
          });
          await tx.organization.update({
            where: { id: fx.orgA },
            data: { timezone: TORONTO },
          });
          await run({ tx, fx, client: rollbackClient(tx) }).catch(
            (error: unknown) => {
              console.error('SCENARIO FAILURE', error);
              throw error;
            },
          );
          throw new RollbackFixtures();
        },
        { timeout: 120_000 },
      ),
    ).rejects.toBeInstanceOf(RollbackFixtures);
  }

  /** Employee 2 also works in organization B (for the isolation checks). */
  async function orgBAssignment(tx: Tx, fx: SchedulingFixtures, endDate: Date) {
    const jobTitle = await tx.jobTitle.create({
      data: {
        organizationId: fx.orgB,
        name: `R4 B title ${randomUUID().slice(0, 6)}`,
        code: `R4B${randomUUID().slice(0, 6).toUpperCase()}`,
      },
    });
    const position = await tx.position.create({
      data: {
        organizationId: fx.orgB,
        jobTitleId: jobTitle.id,
        name: 'Org B Associate',
        code: `R4P${randomUUID().slice(0, 6).toUpperCase()}`,
      },
    });
    return (
      await tx.employmentAssignment.create({
        data: {
          employeeId: fx.employee2,
          positionId: position.id,
          employmentType: 'PART_TIME',
          status: 'ACTIVE',
          isPrimary: false,
          startDate: d('2026-01-01'),
          endDate,
        },
      })
    ).id;
  }

  describe('R4-A.1 lifecycle due list', () => {
    it('separates overdue from upcoming assignment ends, with what the panel shows', async () => {
      await scenario(async ({ tx, fx, client }) => {
        const { lifecycle } = services(client);
        // Overdue: ended Sunday (its last day); upcoming: in 6 days; beyond 30 days: later.
        await tx.employmentAssignment.update({
          where: { id: fx.orgLevel },
          data: { endDate: d('2026-11-01') },
        });
        await tx.employmentAssignment.update({
          where: { id: fx.otherTeamA },
          data: { endDate: d('2026-11-10') },
        });
        await tx.employmentAssignment.update({
          where: { id: fx.assignmentDeptB },
          data: { endDate: d('2026-12-20') },
        });
        // Ends today (Toronto): upcoming with 0 days left, not overdue.
        await tx.employmentAssignment.update({
          where: { id: fx.assignmentTeamA },
          data: { endDate: d('2026-11-04') },
        });

        const due = await lifecycle.due(fx.users.hrA!, fx.orgA, NOW);
        expect(due.upcomingDays).toBe(30);
        expect(due.assignmentEnds).toEqual([
          expect.objectContaining({
            employmentAssignmentId: fx.orgLevel,
            employeeId: fx.employee2,
            positionName: 'Org Associate',
            organizationId: fx.orgA,
            organizationName: expect.any(String),
            endDate: '2026-11-01',
            localToday: '2026-11-04',
            timezone: TORONTO,
            daysOverdue: 3,
            employmentType: 'PART_TIME',
            isPrimary: false,
            startDate: '2026-01-01',
          }),
        ]);
        expect(
          due.upcomingAssignmentEnds.map((row) => [
            row.employmentAssignmentId,
            row.daysUntilEnd,
            row.scheduledTerminationId,
          ]),
        ).toEqual([
          [fx.assignmentTeamA, 0, null],
          [fx.otherTeamA, 6, null],
        ]);

        // A wider window includes the later end; 0 days means "ending today" only.
        const wide = await lifecycle.due(fx.users.hrA!, fx.orgA, NOW, {
          upcomingDays: 60,
        });
        expect(
          wide.upcomingAssignmentEnds.map((r) => r.employmentAssignmentId),
        ).toContain(fx.assignmentDeptB);
        const today = await lifecycle.due(fx.users.hrA!, fx.orgA, NOW, {
          upcomingDays: 0,
        });
        expect(
          today.upcomingAssignmentEnds.map((r) => r.employmentAssignmentId),
        ).toEqual([fx.assignmentTeamA]);
      });
    });

    it('names the scheduled termination an upcoming end belongs to', async () => {
      await scenario(async ({ fx, client }) => {
        const { lifecycle } = services(client);
        const scheduled = await lifecycle.terminate(
          fx.employee1,
          { terminationDate: '2026-11-20' },
          ctx(fx.users.hrA!),
          NOW,
        );
        const due = await lifecycle.due(fx.users.hrA!, fx.orgA, NOW);
        const ofEmployee1 = due.upcomingAssignmentEnds.filter(
          (row) => row.employeeId === fx.employee1,
        );
        expect(ofEmployee1.length).toBeGreaterThan(0);
        for (const row of ofEmployee1)
          expect(row.scheduledTerminationId).toBe(scheduled.termination.id);
        // Not offered as an assignment end to apply.
        expect(
          due.assignmentEnds.some((row) => row.employeeId === fx.employee1),
        ).toBe(false);
      });
    });

    it('lists only what the caller manages, within the organization asked for', async () => {
      await scenario(async ({ tx, fx, client }) => {
        const { lifecycle } = services(client);
        for (const id of [fx.orgLevel, fx.otherTeamA])
          await tx.employmentAssignment.update({
            where: { id },
            data: { endDate: d('2026-11-01') },
          });
        const inB = await orgBAssignment(tx, fx, d('2026-11-01'));
        const ids = (rows: Array<{ employmentAssignmentId: string }>) =>
          rows.map((row) => row.employmentAssignmentId).sort();

        // Organization A's HR: both of A's, never B's.
        expect(
          ids(
            (await lifecycle.due(fx.users.hrA!, fx.orgA, NOW)).assignmentEnds,
          ),
        ).toEqual([fx.orgLevel, fx.otherTeamA].sort());
        // Team A only: the Team A assignment.
        expect(
          ids(
            (await lifecycle.due(fx.users.teamAHr!, fx.orgA, NOW))
              .assignmentEnds,
          ),
        ).toEqual([fx.otherTeamA]);
        // Organization B's HR sees nothing of A (no names, no organization), only B's own.
        const bInA = await lifecycle.due(fx.users.hrB!, fx.orgA, NOW);
        expect(bInA.assignmentEnds).toEqual([]);
        expect(bInA.upcomingAssignmentEnds).toEqual([]);
        expect(JSON.stringify(bInA)).not.toContain('Org Associate');
        expect(
          ids(
            (await lifecycle.due(fx.users.hrB!, fx.orgB, NOW)).assignmentEnds,
          ),
        ).toEqual([inB]);
        // A reader (no employee.manage) sees nothing to act on.
        const reader = await lifecycle.due(fx.users.readerA!, fx.orgA, NOW);
        expect(reader.assignmentEnds).toEqual([]);
        expect(reader.upcomingAssignmentEnds).toEqual([]);
      });
    });

    it('applies an overdue end without terminating employment, once, within scope', async () => {
      await scenario(async ({ tx, fx, client }) => {
        const { lifecycle } = services(client);
        // Employee 2's org-level assignment is overdue; their Team A assignment continues.
        await tx.employmentAssignment.update({
          where: { id: fx.orgLevel },
          data: { endDate: d('2026-11-01') },
        });
        // Out of scope: Team A HR cannot apply an org-level assignment; B's HR cannot either.
        for (const user of [fx.users.teamAHr!, fx.users.hrB!]) {
          const refused = await rejection(
            lifecycle.applyAssignmentEnd(
              fx.employee2,
              fx.orgLevel,
              ctx(user),
              NOW,
            ),
          );
          expect([403, 404]).toContain(statusOf(refused));
        }
        const ended = await lifecycle.applyAssignmentEnd(
          fx.employee2,
          fx.orgLevel,
          ctx(fx.users.hrA!),
          NOW,
        );
        expect(ended.status).toBe('ENDED');
        const employee = await tx.employee.findUniqueOrThrow({
          where: { id: fx.employee2 },
        });
        expect(employee.status).toBe('ACTIVE');
        expect(employee.terminationDate).toBeNull();
        expect(
          await tx.employeeTermination.count({
            where: { employeeId: fx.employee2 },
          }),
        ).toBe(0);
        expect(
          (
            await tx.employmentAssignment.findUniqueOrThrow({
              where: { id: fx.otherTeamA },
            })
          ).status,
        ).toBe('ACTIVE');
        const audit = await tx.auditLog.findFirstOrThrow({
          where: {
            action: 'EMPLOYMENT_ASSIGNMENT_ENDED',
            entityId: fx.orgLevel,
          },
        });
        expect(audit.metadata).toMatchObject({ source: 'MANUAL' });
        // No longer due; a second apply is refused rather than repeated.
        expect(
          (await lifecycle.due(fx.users.hrA!, fx.orgA, NOW)).assignmentEnds,
        ).toEqual([]);
        expect(
          codeOf(
            await rejection(
              lifecycle.applyAssignmentEnd(
                fx.employee2,
                fx.orgLevel,
                ctx(fx.users.hrA!),
                NOW,
              ),
            ),
          ),
        ).toBe('ASSIGNMENT_END_NOT_DUE');
      });
    });

    it('applies even the last active assignment without terminating the employee', async () => {
      await scenario(async ({ tx, fx, client }) => {
        const { lifecycle } = services(client);
        for (const id of [fx.orgLevel, fx.otherTeamA])
          await tx.employmentAssignment.update({
            where: { id },
            data: { endDate: d('2026-11-01') },
          });
        for (const id of [fx.orgLevel, fx.otherTeamA])
          await lifecycle.applyAssignmentEnd(
            fx.employee2,
            id,
            ctx(fx.users.hrA!),
            NOW,
          );
        const employee = await tx.employee.findUniqueOrThrow({
          where: { id: fx.employee2 },
        });
        expect(employee.status).toBe('ACTIVE');
        expect(employee.terminationDate).toBeNull();
      });
    });

    it('refuses an assignment that is not yet due', async () => {
      await scenario(async ({ tx, fx, client }) => {
        const { lifecycle } = services(client);
        await tx.employmentAssignment.update({
          where: { id: fx.orgLevel },
          data: { endDate: d('2026-11-04') }, // today is still a working day
        });
        expect(
          codeOf(
            await rejection(
              lifecycle.applyAssignmentEnd(
                fx.employee2,
                fx.orgLevel,
                ctx(fx.users.hrA!),
                NOW,
              ),
            ),
          ),
        ).toBe('ASSIGNMENT_END_NOT_DUE');
      });
    });
  });

  describe('R4-A.2 HR profile edits', () => {
    async function setPerson(tx: Tx, employeeId: string) {
      const employee = await tx.employee.findUniqueOrThrow({
        where: { id: employeeId },
      });
      await tx.person.update({
        where: { id: employee.personId },
        data: {
          firstName: 'Ada',
          middleName: 'Augusta',
          lastName: 'Lovelace',
          preferredName: 'Ada',
          personalEmail: 'ada.lovelace@example.com',
          phone: '+1 (416) 555-0134',
        },
      });
      return employee.personId;
    }

    it('clears optional fields with null, leaves omitted fields unchanged, and audits masked before/after values', async () => {
      await scenario(async ({ tx, fx, client }) => {
        const { employees } = services(client);
        const personId = await setPerson(tx, fx.employee2);
        await employees.update(
          fx.employee2,
          {
            middleName: null,
            phone: null,
            personalEmail: 'ada@newmail.example',
            firstName: 'Augusta',
          } as never,
          ctx(fx.users.hrA!),
        );
        const person = await tx.person.findUniqueOrThrow({
          where: { id: personId },
        });
        expect(person).toMatchObject({
          firstName: 'Augusta',
          middleName: null,
          lastName: 'Lovelace',
          preferredName: 'Ada',
          personalEmail: 'ada@newmail.example',
          phone: null,
        });
        const entry = await tx.auditLog.findFirstOrThrow({
          where: { action: 'EMPLOYEE_UPDATED', entityId: fx.employee2 },
          orderBy: { occurredAt: 'desc' },
        });
        expect(entry.metadata).toEqual({
          changed: ['firstName', 'middleName', 'personalEmail', 'phone'],
          cleared: ['middleName', 'phone'],
          changes: {
            firstName: { before: 'A***', after: 'A***' },
            middleName: { before: 'A***', after: null },
            personalEmail: {
              before: 'a***@***.com',
              after: 'a***@***.example',
            },
            phone: { before: '***34', after: null },
          },
          masked: ['firstName', 'middleName', 'personalEmail', 'phone'],
          authority: 'ASSIGNMENTS',
        });
        const stored = JSON.stringify(entry);
        expect(stored).not.toContain('ada.lovelace@');
        expect(stored).not.toContain('ada@newmail');
        expect(stored).not.toContain('Augusta');
        expect(stored).not.toContain('newmail');
        expect(stored).not.toContain('555-0134');
      });
    });

    it('never clears the legal first or last name, and changes nothing when refused', async () => {
      await scenario(async ({ tx, fx, client }) => {
        const { employees } = services(client);
        const personId = await setPerson(tx, fx.employee2);
        for (const input of [
          { firstName: null },
          { lastName: null, phone: null },
          // Only spaces would clear it just as well.
          { lastName: '   ' },
        ]) {
          const refused = await rejection(
            employees.update(fx.employee2, input as never, ctx(fx.users.hrA!)),
          );
          expect(statusOf(refused)).toBe(400);
          expect(codeOf(refused)).toBe('PROFILE_REQUIRED_FIELD');
        }
        expect(
          await tx.person.findUniqueOrThrow({ where: { id: personId } }),
        ).toMatchObject({
          firstName: 'Ada',
          lastName: 'Lovelace',
          phone: '+1 (416) 555-0134',
        });
        expect(
          await tx.auditLog.count({
            where: { action: 'EMPLOYEE_UPDATED', entityId: fx.employee2 },
          }),
        ).toBe(0);
      });
    });

    it('refuses readers, other organizations and partial scope; the employee themself cannot edit', async () => {
      await scenario(async ({ tx, fx, client }) => {
        const { employees } = services(client);
        const personId = await setPerson(tx, fx.employee2);
        await orgBAssignment(tx, fx, d('2027-06-30'));
        // Employee 2 now works in A and B: A's HR alone covers only part of the employment.
        const cases: Array<[string, string]> = [
          ['readerA', fx.users.readerA!],
          ['hrB (other organization)', fx.users.hrB!],
          ['teamAHr (partial)', fx.users.teamAHr!],
          ['hrA (partial: B not covered)', fx.users.hrA!],
        ];
        for (const [, user] of cases) {
          const refused = await rejection(
            employees.update(fx.employee2, { phone: null } as never, ctx(user)),
          );
          expect([403, 404]).toContain(statusOf(refused));
        }
        // An ordinary employee (their own login, no grants) cannot edit their profile here.
        const employee2 = await tx.employee.findUniqueOrThrow({
          where: { id: fx.employee2 },
          include: { person: { include: { user: true } } },
        });
        const selfUser =
          employee2.person.user?.id ??
          (
            await tx.user.create({
              data: {
                personId,
                email: `r4a-self-${randomUUID().slice(0, 8)}@example.invalid`,
                status: 'ACTIVE',
              },
            })
          ).id;
        const self = await rejection(
          employees.update(
            fx.employee2,
            { preferredName: 'Countess' } as never,
            ctx(selfUser),
          ),
        );
        expect([403, 404]).toContain(statusOf(self));
        expect(
          await tx.person.findUniqueOrThrow({ where: { id: personId } }),
        ).toMatchObject({ phone: '+1 (416) 555-0134', preferredName: 'Ada' });
      });
    });

    it('keeps the audit log append-only (no update or delete of an entry)', async () => {
      await scenario(async ({ tx, fx, client }) => {
        const { employees } = services(client);
        await setPerson(tx, fx.employee2);
        await employees.update(
          fx.employee2,
          { preferredName: 'Countess' } as never,
          ctx(fx.users.hrA!),
        );
        const entry = await tx.auditLog.findFirstOrThrow({
          where: { action: 'EMPLOYEE_UPDATED', entityId: fx.employee2 },
        });
        await tx.$executeRawUnsafe('SAVEPOINT r4a_audit');
        const update = await rejection(
          tx.$executeRaw`UPDATE "AuditLog" SET "metadata" = '{}'::jsonb WHERE "id" = ${entry.id}::uuid`,
        );
        expect(update).toBeDefined();
        await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT r4a_audit');
        const remove = await rejection(
          tx.$executeRaw`DELETE FROM "AuditLog" WHERE "id" = ${entry.id}::uuid`,
        );
        expect(remove).toBeDefined();
        await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT r4a_audit');
        expect(
          (await tx.auditLog.findUniqueOrThrow({ where: { id: entry.id } }))
            .metadata,
        ).toMatchObject({
          changes: { preferredName: { before: 'A***', after: 'C***' } },
        });
      });
    });
  });
});
