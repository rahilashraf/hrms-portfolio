import type { HttpException } from '@nestjs/common';
import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service.js';
import { AuditService } from '../src/audit/audit.service.js';
import { AuthorizationService } from '../src/authorization/authorization.service.js';
import { PositionAuthorizationTargetResolver } from '../src/authorization/position-authorization-target.resolver.js';
import { EmployeeAccessService } from '../src/employee/employee-access.service.js';
import { EmployeeDomainService } from '../src/employee/employee-domain.service.js';
import { EmployeeLifecycleService } from '../src/employee/employee-lifecycle.service.js';
import {
  BENEFIT_PERMISSION_KEYS,
  BENEFIT_USERS,
  benefitsServices,
  FixedBenefitsClock,
  healthPlan,
  type BenefitsServices,
} from './support/benefits-fixtures.js';
import {
  createSchedulingFixtures,
  ctx,
  rejection,
  rollbackClient,
  violation,
  type SchedulingFixtures,
  type Tx,
} from './support/scheduling-fixtures.js';

config({ path: '../../.env' });

class RollbackFixtures extends Error {}

/** Employee 2 (self2) also administers benefits; benefitsCoreHr is Core HR and benefits. */
const USERS = {
  ...BENEFIT_USERS,
  self2: [{ permissions: BENEFIT_PERMISSION_KEYS, scope: 'org' as const }],
  benefitsCoreHr: [
    {
      permissions: [
        'employee.read',
        'employee.manage',
        'benefit.read',
        'benefit.manage',
      ],
      scope: 'org' as const,
    },
  ],
};

function lifecycleService(client: PrismaService | Tx) {
  const prismaClient = client as PrismaService;
  const authorization = new AuthorizationService(prismaClient);
  const audit = new AuditService(prismaClient);
  const targets = new PositionAuthorizationTargetResolver(prismaClient);
  return new EmployeeLifecycleService(
    prismaClient,
    new EmployeeDomainService(prismaClient, audit),
    new EmployeeAccessService(prismaClient, authorization, targets, audit),
    authorization,
    audit,
  );
}

const failure = async (promise: Promise<unknown>) => {
  const error = (await rejection(promise)) as HttpException;
  const body = error.getResponse?.() as { code?: string } | undefined;
  return { status: error.getStatus?.(), code: body?.code };
};

/**
 * Batch 7C — Benefits security and integrity findings (approved audit B1–B17, decisions
 * C1–C10). Each test failed on the code before its fix. Clock: 2026-03-15 (Toronto).
 */
describe('Batch 7C benefits security findings (database)', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService(process.env.DATABASE_URL!);
    await prisma.$connect();
  });
  afterAll(async () => {
    await prisma?.$disconnect();
  });

  async function scenario(
    run: (
      tx: Tx,
      fx: SchedulingFixtures,
      svc: BenefitsServices,
      clock: FixedBenefitsClock,
    ) => Promise<void>,
  ) {
    await expect(
      prisma.$transaction(
        async (tx) => {
          const fx = await createSchedulingFixtures(tx, USERS);
          await tx.organization.update({
            where: { id: fx.orgA },
            data: { timezone: 'America/Toronto' },
          });
          const clock = new FixedBenefitsClock();
          const svc = benefitsServices(rollbackClient(tx), clock);
          await run(tx, fx, svc, clock).catch((error: unknown) => {
            console.error('SCENARIO FAILURE', error);
            throw error;
          });
          throw new RollbackFixtures();
        },
        { timeout: 120_000 },
      ),
    ).rejects.toBeInstanceOf(RollbackFixtures);
  }

  /** Employee 1 also works in organization B; a plan there, administered by orgBAdmin. */
  async function secondOrganization(
    tx: Tx,
    fx: SchedulingFixtures,
    svc: BenefitsServices,
  ) {
    const jobTitle = await tx.jobTitle.create({
      data: {
        organizationId: fx.orgB,
        name: 'B Associate',
        code: `JB${fx.suffix}`,
      },
    });
    const position = await tx.position.create({
      data: {
        organizationId: fx.orgB,
        jobTitleId: jobTitle.id,
        name: 'B Associate',
        code: `PB${fx.suffix}`,
      },
    });
    const assignmentB = (
      await tx.employmentAssignment.create({
        data: {
          employeeId: fx.employee1,
          positionId: position.id,
          employmentType: 'PART_TIME',
          status: 'ACTIVE',
          isPrimary: false,
          startDate: new Date('2026-01-01T00:00:00.000Z'),
        },
      })
    ).id;
    const admin = ctx(fx.users.orgBAdmin!);
    const plan = await svc.plans.create(
      {
        organizationId: fx.orgB,
        code: 'B-HEALTH',
        name: 'B Health',
        benefitType: 'HEALTH',
        currency: 'CAD',
        effectiveFrom: '2026-01-01',
      },
      admin,
    );
    const spouseOption = await svc.plans.addOption(
      plan.id,
      { code: 'SPOUSE', name: 'With spouse', coverageLevel: 'EMPLOYEE_SPOUSE' },
      admin,
    );
    await svc.rates.addRate(
      spouseOption.id,
      {
        effectiveFrom: '2026-01-01',
        frequency: 'MONTHLY',
        employeeAmount: '40',
        employerAmount: '60',
      },
      admin,
    );
    await svc.plans.transition(plan.id, 'ACTIVE', admin);
    return { assignmentB, plan, spouseOption, admin };
  }

  it('B3/C4: dependent changes need scope over every assignment sponsoring their coverage; birth dates stay with managers', async () => {
    await scenario(async (tx, fx, svc) => {
      const b = await secondOrganization(tx, fx, svc);
      const spouse = await svc.dependents.create(
        fx.employee1,
        {
          firstName: 'Sam',
          lastName: 'Spouse',
          relationship: 'SPOUSE',
          dateOfBirth: '1990-05-01',
        },
        b.admin,
      );
      const child = await svc.dependents.create(
        fx.employee1,
        {
          firstName: 'Kit',
          lastName: 'Child',
          relationship: 'CHILD',
          dateOfBirth: '2015-07-01',
        },
        ctx(fx.users.benefitsAdmin!),
      );
      // The spouse is covered only through Employee 1's organization B assignment.
      await svc.enrollments.enroll(
        {
          employmentAssignmentId: b.assignmentB,
          planId: b.plan.id,
          optionId: b.spouseOption.id,
          coverageStart: '2026-02-01',
          dependentIds: [spouse.id],
        },
        b.admin,
      );
      const teamManager = ctx(fx.users.teamManager!);
      // A Team A manager never changes coverage sponsored in organization B.
      expect(
        await failure(
          svc.dependents.update(
            spouse.id,
            { firstName: 'Samuel' },
            teamManager,
          ),
        ),
      ).toMatchObject({ status: 403 });
      expect(
        await failure(svc.dependents.archive(spouse.id, teamManager)),
      ).toMatchObject({ status: 403 });
      // An uncovered dependent of an employee they administer stays theirs to maintain.
      await svc.dependents.update(
        child.id,
        { firstName: 'Kitty' },
        teamManager,
      );
      // Organization B's administrator maintains the spouse.
      await svc.dependents.update(spouse.id, { firstName: 'Samuel' }, b.admin);

      // Reads: readers see no birth dates, and nothing covered only outside their scope.
      const asReader = await svc.dependents.list(
        fx.users.reader!,
        fx.employee1,
      );
      expect(asReader.items.map((row) => row.firstName)).toEqual(['Kitty']);
      expect(asReader.items[0]!.dateOfBirth).toBeNull();
      const asManager = await svc.dependents.list(
        fx.users.benefitsAdmin!,
        fx.employee1,
      );
      expect(asManager.items.map((row) => row.dateOfBirth)).toEqual([
        '2015-07-01',
      ]);
      const asOrgB = await svc.dependents.list(
        fx.users.orgBAdmin!,
        fx.employee1,
      );
      expect(asOrgB.items.map((row) => row.firstName).sort()).toEqual([
        'Kitty',
        'Samuel',
      ]);
      // The employee reads their own, birth dates included.
      expect(
        (await svc.dependents.mine(fx.selfUser1)).items.map(
          (row) => row.dateOfBirth,
        ),
      ).toContain('1990-05-01');
    });
  });

  it('B4/C3: transfer, change and correction re-check eligibility; overrides are never inherited', async () => {
    await scenario(async (tx, fx, svc) => {
      const { plan, single, admin } = await healthPlan(svc, fx);
      // Only Department A (Team A's department) is eligible.
      await svc.eligibility.addRule(
        plan.id,
        { effectiveFrom: '2026-01-01', departmentId: fx.deptA },
        admin,
      );
      const hr = ctx(fx.users.benefitsAdmin!);
      const election = await svc.enrollments.enroll(
        {
          employmentAssignmentId: fx.assignmentTeamA,
          planId: plan.id,
          optionId: single.id,
          coverageStart: '2026-02-01',
        },
        hr,
      );
      // Department B is not eligible: a transfer needs a fresh override reason.
      expect(
        await failure(
          svc.enrollments.transfer(
            election.id,
            {
              employmentAssignmentId: fx.assignmentDeptB,
              effectiveDate: '2026-03-01',
            },
            hr,
          ),
        ),
      ).toEqual({ status: 409, code: 'BENEFIT_NOT_ELIGIBLE' });
      const moved = await svc.enrollments.transfer(
        election.id,
        {
          employmentAssignmentId: fx.assignmentDeptB,
          effectiveDate: '2026-03-01',
          eligibilityOverrideReason: 'Approved by the plan committee',
        },
        hr,
      );
      expect(
        (
          await tx.benefitEnrollment.findUniqueOrThrow({
            where: { id: moved.id },
          })
        ).eligibilityOverrideReason,
      ).toBe('Approved by the plan committee');
      // A later change on the overridden segment gives its own reason; none is inherited.
      expect(
        await failure(
          svc.enrollments.change(
            moved.id,
            { effectiveDate: '2026-03-10', reason: 'New plan year' },
            hr,
          ),
        ),
      ).toEqual({ status: 409, code: 'BENEFIT_NOT_ELIGIBLE' });
      expect(
        await failure(
          svc.enrollments.correct(
            moved.id,
            { reason: 'Wrong start', coverageStart: '2026-03-02' },
            hr,
          ),
        ),
      ).toEqual({ status: 409, code: 'BENEFIT_NOT_ELIGIBLE' });
      await svc.enrollments.correct(
        moved.id,
        {
          reason: 'Wrong start',
          coverageStart: '2026-03-02',
          eligibilityOverrideReason: 'Approved again',
        },
        hr,
      );
    });
  });

  it('B5: a rate of an archived option or plan is never corrected', async () => {
    await scenario(async (tx, fx, svc) => {
      const { plan, single, family, admin } = await healthPlan(svc, fx);
      const rateOf = async (optionId: string) =>
        (
          await tx.benefitRate.findFirstOrThrow({
            where: { optionId, supersededAt: null },
          })
        ).id;
      await svc.plans.archiveOption(family.id, admin);
      expect(
        await failure(
          svc.rates.correctRate(
            await rateOf(family.id),
            { employeeAmount: '30', reason: 'Carrier invoice' },
            admin,
          ),
        ),
      ).toEqual({ status: 409, code: 'BENEFIT_ARCHIVED' });
      await svc.plans.transition(plan.id, 'CLOSED', admin);
      await svc.plans.archive(plan.id, admin);
      expect(
        await failure(
          svc.rates.correctRate(
            await rateOf(single.id),
            { employeeAmount: '30', reason: 'Carrier invoice' },
            admin,
          ),
        ),
      ).toEqual({ status: 409, code: 'BENEFIT_ARCHIVED' });
    });
  });

  it('B7/C5: change, end and transfer act on live segments only; history goes through correction', async () => {
    await scenario(async (tx, fx, svc) => {
      const { plan, single } = await healthPlan(svc, fx);
      const hr = ctx(fx.users.benefitsAdmin!);
      // Coverage January → February, already over on 2026-03-15.
      const past = await svc.enrollments.enroll(
        {
          employmentAssignmentId: fx.assignmentTeamA,
          planId: plan.id,
          optionId: single.id,
          coverageStart: '2026-01-01',
          coverageEnd: '2026-02-28',
        },
        hr,
      );
      const historical = { status: 409, code: 'BENEFIT_ELECTION_HISTORICAL' };
      expect(
        await failure(
          svc.enrollments.change(
            past.id,
            { effectiveDate: '2026-02-01', reason: 'Late notice' },
            hr,
          ),
        ),
      ).toEqual(historical);
      expect(
        await failure(
          svc.enrollments.end(past.id, { coverageEnd: '2026-01-31' }, hr),
        ),
      ).toEqual(historical);
      expect(
        await failure(
          svc.enrollments.transfer(
            past.id,
            {
              employmentAssignmentId: fx.assignmentDeptB,
              effectiveDate: '2026-02-01',
            },
            hr,
          ),
        ),
      ).toEqual(historical);
      // The correction workflow (with its reason) still fixes history.
      await svc.enrollments.correct(
        past.id,
        { reason: 'Ended earlier', coverageEnd: '2026-01-31' },
        hr,
      );
    });
  });

  it('B8/C5: dependent edits that would invalidate covered history are refused', async () => {
    await scenario(async (tx, fx, svc) => {
      const { plan, family } = await healthPlan(svc, fx);
      const hr = ctx(fx.users.benefitsAdmin!);
      const spouse = await svc.dependents.create(
        fx.employee1,
        {
          firstName: 'Sam',
          lastName: 'Spouse',
          relationship: 'SPOUSE',
          relationshipStartDate: '2020-06-01',
        },
        hr,
      );
      const child = await svc.dependents.create(
        fx.employee1,
        {
          firstName: 'Kit',
          lastName: 'Child',
          relationship: 'CHILD',
          dateOfBirth: '2010-07-01',
        },
        hr,
      );
      await svc.enrollments.enroll(
        {
          employmentAssignmentId: fx.assignmentTeamA,
          planId: plan.id,
          optionId: family.id,
          coverageStart: '2026-02-01',
          dependentIds: [spouse.id, child.id],
        },
        hr,
      );
      const conflict = {
        status: 409,
        code: 'BENEFIT_DEPENDENT_HISTORY_CONFLICT',
      };
      expect(
        await failure(
          svc.dependents.update(
            spouse.id,
            { relationshipStartDate: '2026-06-01' },
            hr,
          ),
        ),
      ).toEqual(conflict);
      // Older than the plan's age limit (21) on the coverage start.
      expect(
        await failure(
          svc.dependents.update(child.id, { dateOfBirth: '2000-01-01' }, hr),
        ),
      ).toEqual(conflict);
      // A divorce after coverage started is recorded (coverage is then changed explicitly).
      await svc.dependents.update(
        spouse.id,
        { relationshipEndDate: '2026-05-31' },
        hr,
      );
      expect(
        await failure(
          svc.dependents.update(
            spouse.id,
            { relationshipEndDate: '2026-01-15' },
            hr,
          ),
        ),
      ).toEqual(conflict);
    });
  });

  it('B1: records of another organization read as missing; within it the permission is reported', async () => {
    await scenario(async (tx, fx, svc) => {
      const { plan, single, admin } = await healthPlan(svc, fx);
      const hr = ctx(fx.users.benefitsAdmin!);
      const election = await svc.enrollments.enroll(
        {
          employmentAssignmentId: fx.assignmentTeamA,
          planId: plan.id,
          optionId: single.id,
          coverageStart: '2026-02-01',
        },
        hr,
      );
      const rate = await tx.benefitRate.findFirstOrThrow({
        where: { optionId: single.id },
      });
      const outsider = fx.users.orgBAdmin!;
      const asOutsider = ctx(outsider);
      const missing = { status: 404, code: undefined };
      for (const attempt of [
        () => svc.plans.detail(outsider, plan.id),
        () => svc.plans.update(plan.id, { name: 'X' }, asOutsider),
        () => svc.plans.transition(plan.id, 'CLOSED', asOutsider),
        () => svc.plans.archive(plan.id, asOutsider),
        () =>
          svc.plans.addOption(
            plan.id,
            { code: 'X', name: 'X', coverageLevel: 'EMPLOYEE_ONLY' },
            asOutsider,
          ),
        () => svc.plans.updateOption(single.id, { name: 'X' }, asOutsider),
        () => svc.plans.archiveOption(single.id, asOutsider),
        () =>
          svc.rates.addRate(
            single.id,
            {
              effectiveFrom: '2026-06-01',
              frequency: 'MONTHLY',
              employeeAmount: '1',
              employerAmount: '1',
            },
            asOutsider,
          ),
        () =>
          svc.rates.correctRate(
            rate.id,
            { employeeAmount: '1', reason: 'X' },
            asOutsider,
          ),
        () =>
          svc.eligibility.addRule(
            plan.id,
            { effectiveFrom: '2026-01-01' },
            asOutsider,
          ),
        () =>
          svc.enrollments.end(
            election.id,
            { coverageEnd: '2026-05-31' },
            asOutsider,
          ),
        () => svc.enrollments.rescind(election.id, { reason: 'X' }, asOutsider),
        () => svc.enrollments.employee(outsider, fx.employee1),
        () => svc.dependents.list(outsider, fx.employee1),
        () =>
          svc.enrollments.discontinuePlan(
            plan.id,
            { effectiveTo: '2026-12-31', endElections: true, reason: 'X' },
            asOutsider,
          ),
      ]) {
        expect(await failure(attempt())).toEqual(missing);
      }
      // Organization B's administrator enrolling with an organization A plan: missing too.
      const b = await secondOrganization(tx, fx, svc);
      expect(
        await failure(
          svc.enrollments.enroll(
            {
              employmentAssignmentId: b.assignmentB,
              planId: plan.id,
              optionId: single.id,
              coverageStart: '2026-02-01',
            },
            b.admin,
          ),
        ),
      ).toEqual(missing);
      // Within the organization, the missing permission is what is reported.
      expect(
        await failure(
          svc.plans.update(plan.id, { name: 'X' }, ctx(fx.users.reader!)),
        ),
      ).toEqual({ status: 403, code: 'BENEFIT_PERMISSION_REQUIRED' });
      expect(
        await failure(
          svc.enrollments.end(
            election.id,
            { coverageEnd: '2026-05-31' },
            ctx(fx.users.reader!),
          ),
        ),
      ).toEqual({ status: 403, code: 'BENEFIT_PERMISSION_REQUIRED' });
      void admin;
    });
  });

  it('C1/B2: free-text reasons stay on protected records, never in audit metadata', async () => {
    await scenario(async (tx, fx, svc) => {
      const { plan, single, family, admin } = await healthPlan(svc, fx);
      const hr = ctx(fx.users.benefitsAdmin!);
      const enroll = (assignment: string, optionId = single.id) =>
        svc.enrollments.enroll(
          {
            employmentAssignmentId: assignment,
            planId: plan.id,
            optionId,
            coverageStart: '2026-02-01',
          },
          hr,
        );
      const first = await enroll(fx.assignmentTeamA);
      const ended = await svc.enrollments.end(
        first.id,
        { coverageEnd: '2026-05-31', reason: 'Divorce finalized' },
        hr,
      );
      expect(ended).toMatchObject({ endReason: 'Divorce finalized' });
      const second = await enroll(fx.otherTeamA);
      await svc.enrollments.correct(
        second.id,
        {
          reason: 'Spouse died',
          optionId: single.id,
          coverageStart: '2026-02-02',
        },
        hr,
      );
      const rate = await tx.benefitRate.findFirstOrThrow({
        where: { optionId: family.id, supersededAt: null },
      });
      await svc.rates.correctRate(
        rate.id,
        { employeeAmount: '30', reason: 'Carrier invoice 4411' },
        admin,
      );
      const audits = await tx.auditLog.findMany({
        where: {
          action: {
            in: [
              'BENEFIT_ELECTION_ENDED',
              'BENEFIT_ELECTION_CORRECTED',
              'BENEFIT_RATE_CORRECTED',
            ],
          },
          actorUserId: { in: [fx.users.benefitsAdmin!, fx.users.planAdmin!] },
        },
      });
      expect(audits).toHaveLength(3);
      const text = JSON.stringify(audits.map((a) => a.metadata));
      for (const secret of ['Divorce', 'Spouse died', 'Carrier invoice 4411'])
        expect(text).not.toContain(secret);
      expect(
        audits.map(
          (a) => (a.metadata as { reasonProvided?: boolean }).reasonProvided,
        ),
      ).toEqual([true, true, true]);
      // The end reason is an HR note: never to the employee, never on its own.
      const own = await svc.enrollments.mine(fx.selfUser1);
      expect(JSON.stringify(own)).not.toContain('Divorce');
      // Never on its own (the trigger refuses it); the recorded reason stays.
      expect(
        await violation(tx, () =>
          tx.benefitEnrollment.update({
            where: { id: first.id },
            data: { endReason: 'Rewritten' },
          }),
        ),
      ).toBeTruthy();
      expect(
        (
          await tx.benefitEnrollment.findUniqueOrThrow({
            where: { id: first.id },
          })
        ).endReason,
      ).toBe('Divorce finalized');
    });
  });

  it('C6/B9: plan discontinuation never ends the actor’s own coverage; self reads carry no HR notes', async () => {
    await scenario(async (tx, fx, svc) => {
      const { plan, single } = await healthPlan(svc, fx);
      const hr = ctx(fx.users.benefitsAdmin!);
      await svc.enrollments.enroll(
        {
          employmentAssignmentId: fx.otherTeamA,
          planId: plan.id,
          optionId: single.id,
          coverageStart: '2026-02-01',
          eligibilityOverrideReason: 'Confidential medical exception',
        },
        hr,
      );
      // Employee 2 (self2) also administers plans and benefits.
      expect(
        await failure(
          svc.enrollments.discontinuePlan(
            plan.id,
            {
              effectiveTo: '2026-06-30',
              endElections: true,
              reason: 'Carrier exit',
            },
            ctx(fx.selfUser2),
          ),
        ),
      ).toEqual({ status: 403, code: 'BENEFIT_SELF_MANAGEMENT' });
      // Their own elections through the administrative path: no HR notes.
      const own = await svc.enrollments.employee(fx.selfUser2, fx.employee2);
      expect(JSON.stringify(own)).not.toContain('Confidential medical');
      // Another administrator may.
      await svc.enrollments.discontinuePlan(
        plan.id,
        {
          effectiveTo: '2026-06-30',
          endElections: true,
          reason: 'Carrier exit',
        },
        ctx(fx.users.planAdmin!),
      );
    });
  });

  it('C8/B14: ending coverage with a later segment is refused with what to resolve', async () => {
    await scenario(async (tx, fx, svc) => {
      const { plan, single, family } = await healthPlan(svc, fx);
      const hr = ctx(fx.users.benefitsAdmin!);
      const spouse = await svc.dependents.create(
        fx.employee1,
        { firstName: 'Sam', lastName: 'Spouse', relationship: 'SPOUSE' },
        hr,
      );
      const first = await svc.enrollments.enroll(
        {
          employmentAssignmentId: fx.assignmentTeamA,
          planId: plan.id,
          optionId: single.id,
          coverageStart: '2026-02-01',
        },
        hr,
      );
      // From June: family coverage (a later segment); then the first is ended in April.
      const later = await svc.enrollments.change(
        first.id,
        {
          effectiveDate: '2026-06-01',
          optionId: family.id,
          dependentIds: [spouse.id],
        },
        hr,
      );
      const refused = (await rejection(
        svc.enrollments.end(first.id, { coverageEnd: '2026-04-30' }, hr),
      )) as HttpException;
      expect(refused.getResponse()).toMatchObject({
        code: 'BENEFIT_LATER_COVERAGE',
        laterElections: 1,
        elections: [{ id: later.id, coverageStart: '2026-06-01' }],
      });
      // Nothing was ended silently.
      expect(
        (
          await tx.benefitEnrollment.findUniqueOrThrow({
            where: { id: later.id },
          })
        ).coverageEnd,
      ).toBeNull();
    });
  });

  it('B10: error details never name elections outside the caller’s scope', async () => {
    await scenario(async (tx, fx, svc) => {
      const { plan, single } = await healthPlan(svc, fx);
      // Employee 1 is covered through the Department B assignment (outside Team A).
      await svc.enrollments.enroll(
        {
          employmentAssignmentId: fx.assignmentDeptB,
          planId: plan.id,
          optionId: single.id,
          coverageStart: '2026-02-01',
        },
        ctx(fx.users.benefitsAdmin!),
      );
      const refused = (await rejection(
        svc.enrollments.enroll(
          {
            employmentAssignmentId: fx.assignmentTeamA,
            planId: plan.id,
            optionId: single.id,
            coverageStart: '2026-03-01',
          },
          ctx(fx.users.teamManager!),
        ),
      )) as HttpException;
      const body = refused.getResponse() as Record<string, unknown>;
      expect(body.code).toBe('BENEFIT_ELECTION_OVERLAP');
      expect(body.enrollmentId).toBeUndefined();
      expect(body.coverageStart).toBeUndefined();
    });
  });

  it('B12/B5: an archived plan’s options are history', async () => {
    await scenario(async (tx, fx, svc) => {
      const { plan, single, admin } = await healthPlan(svc, fx);
      await svc.plans.transition(plan.id, 'CLOSED', admin);
      await svc.plans.archive(plan.id, admin);
      expect(
        await failure(svc.plans.updateOption(single.id, { name: 'X' }, admin)),
      ).toEqual({ status: 409, code: 'BENEFIT_ARCHIVED' });
      expect(await failure(svc.plans.archiveOption(single.id, admin))).toEqual({
        status: 409,
        code: 'BENEFIT_ARCHIVED',
      });
    });
  });

  it('B15: the termination preview counts live elections, for benefits readers only', async () => {
    await scenario(async (tx, fx, svc) => {
      const { plan, single } = await healthPlan(svc, fx);
      const hr = ctx(fx.users.benefitsAdmin!);
      const election = await svc.enrollments.enroll(
        {
          employmentAssignmentId: fx.assignmentTeamA,
          planId: plan.id,
          optionId: single.id,
          coverageStart: '2026-02-01',
        },
        hr,
      );
      await svc.enrollments.rescind(
        election.id,
        { reason: 'Entered by mistake' },
        hr,
      );
      const lifecycle = lifecycleService(rollbackClient(tx));
      // A Core HR administrator with benefit.read too, and one without.
      const withBenefits = await lifecycle.terminationPreview(
        fx.employee1,
        '2026-06-30',
        fx.users.benefitsCoreHr!,
      );
      expect(withBenefits.followUps.openBenefitEnrollments).toBe(0);
      const without = await lifecycle.terminationPreview(
        fx.employee1,
        '2026-06-30',
        fx.users.hr!,
      );
      expect(without.followUps.openBenefitEnrollments).toBeNull();
    });
  });

  it('review fixes: end reasons are never lost; an unrelated later election never blocks an end', async () => {
    await scenario(async (tx, fx, svc) => {
      const { plan, single, family } = await healthPlan(svc, fx);
      const hr = ctx(fx.users.benefitsAdmin!);
      const spouse = await svc.dependents.create(
        fx.employee1,
        { firstName: 'Sam', lastName: 'Spouse', relationship: 'SPOUSE' },
        hr,
      );
      const first = await svc.enrollments.enroll(
        {
          employmentAssignmentId: fx.assignmentTeamA,
          planId: plan.id,
          optionId: family.id,
          coverageStart: '2026-02-01',
          dependentIds: [spouse.id],
        },
        hr,
      );
      await svc.enrollments.end(
        first.id,
        { coverageEnd: '2026-12-31', reason: 'Divorce' },
        hr,
      );
      // Ended earlier again without a reason: the recorded one is kept.
      const again = await svc.enrollments.end(
        first.id,
        { coverageEnd: '2026-11-30' },
        hr,
      );
      expect(again).toMatchObject({ endReason: 'Divorce' });
      // A change splits it: the continuation carries the recorded end and its reason.
      const continued = await svc.enrollments.change(
        first.id,
        {
          effectiveDate: '2026-06-01',
          optionId: single.id,
          dependentIds: [],
        },
        hr,
      );
      expect(continued).toMatchObject({
        coverageEnd: '2026-11-30',
        endReason: 'Divorce',
      });
      // The reason moved with the end: the earlier segment ended because of the change.
      expect(
        (
          await tx.benefitEnrollment.findUniqueOrThrow({
            where: { id: first.id },
          })
        ).endReason,
      ).toBeNull();
      // The database never lets a recorded reason be erased on its own.
      expect(
        await violation(tx, () =>
          tx.benefitEnrollment.update({
            where: { id: continued.id },
            data: { endReason: null },
          }),
        ),
      ).toBeTruthy();
      // An unrelated election after a gap is not a continuation: ending is allowed.
      const second = await svc.enrollments.enroll(
        {
          employmentAssignmentId: fx.otherTeamA,
          planId: plan.id,
          optionId: single.id,
          coverageStart: '2026-02-01',
          coverageEnd: '2026-04-30',
        },
        hr,
      );
      await svc.enrollments.enroll(
        {
          employmentAssignmentId: fx.otherTeamA,
          planId: plan.id,
          optionId: single.id,
          coverageStart: '2026-07-01',
        },
        hr,
      );
      await svc.enrollments.end(second.id, { coverageEnd: '2026-03-31' }, hr);
    });
  });
});
