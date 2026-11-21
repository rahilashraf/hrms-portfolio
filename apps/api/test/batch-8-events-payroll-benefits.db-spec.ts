import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service.js';
import {
  BENEFIT_USERS,
  benefitsServices,
  FixedBenefitsClock,
  healthPlan,
  type BenefitsServices,
} from './support/benefits-fixtures.js';
import {
  noticesOf,
  primeEventCheckpoints,
  publishEvents,
  transactionStart,
} from './support/event-notification-fixtures.js';
import {
  d,
  FixedPayrollClock,
  payrollServices,
  type PayrollServices,
} from './support/payroll-fixtures.js';
import {
  compensation,
  PAYROLL_WORLD_USERS,
  world,
  type World,
} from './support/payroll-world.js';
import {
  createSchedulingFixtures,
  ctx,
  rollbackClient,
  type SchedulingFixtures,
  type Tx,
} from './support/scheduling-fixtures.js';

config({ path: '../../.env' });

class RollbackFixtures extends Error {}

const PAYROLL_SOURCE = 'events.payroll-finalized';
const BENEFIT_SOURCE = 'events.benefit-election';
const PAYSLIP = 'payroll.payslip-available';
const ELECTION = 'benefits.election-changed';

const USERS = {
  ...PAYROLL_WORLD_USERS,
  ...BENEFIT_USERS,
  hr: [...PAYROLL_WORLD_USERS.hr, ...BENEFIT_USERS.hr!],
};

/** Words that must never reach a benefits notice (plan, option, dependent, reasons, notes). */
const SECRET_REASON = 'Confidential-Carrier-Dispute';

interface Scenario {
  tx: Tx;
  fx: SchedulingFixtures;
  client: PrismaService;
  pay: PayrollServices;
  payrollClock: FixedPayrollClock;
  ben: BenefitsServices;
}

interface Staff {
  employeeId: string;
  userId: string;
  assignmentId: string;
}

/** Extra employees (with an active account) on the Team A position of Organization A. */
async function staff(
  tx: Tx,
  fx: SchedulingFixtures,
  count: number,
  options: { payGroupId?: string; positionId?: string; label?: string } = {},
): Promise<Staff[]> {
  const rows: Staff[] = [];
  const label = options.label ?? 'S';
  for (let index = 0; index < count; index += 1) {
    const person = await tx.person.create({
      data: { firstName: `Bulk${label}${index}`, lastName: fx.suffix },
    });
    const employee = await tx.employee.create({
      data: {
        personId: person.id,
        employeeNumber: `B8${label}${index}-${fx.suffix}`,
        hireDate: d('2026-01-01'),
      },
    });
    const user = await tx.user.create({
      data: {
        personId: person.id,
        email: `b8-${label.toLowerCase()}${index}-${fx.suffix.toLowerCase()}@example.com`,
        status: 'ACTIVE',
      },
    });
    const assignment = await tx.employmentAssignment.create({
      data: {
        employeeId: employee.id,
        positionId: options.positionId ?? fx.positionTeamA,
        employmentType: 'FULL_TIME',
        status: 'ACTIVE',
        isPrimary: true,
        startDate: d('2026-01-01'),
      },
    });
    if (options.payGroupId) {
      // Distinct salaries, so every payslip has its own amounts.
      await compensation(tx, fx, assignment.id, {
        payBasis: 'SALARY',
        rateAmount: String(41_000 + index * 1_337),
        payGroupId: options.payGroupId,
      });
    }
    rows.push({
      employeeId: employee.id,
      userId: user.id,
      assignmentId: assignment.id,
    });
  }
  return rows;
}

/** Creates, calculates, approves and finalizes the world's run (finalized "now"). */
async function finalizedRun(w: World, clock: FixedPayrollClock) {
  const run = await w.svc.runs.createRun(
    { payrollPeriodId: w.periodId, currency: 'CAD' },
    w.admin,
  );
  await w.svc.runs.calculate(run.id, w.admin);
  await w.svc.lifecycle.approve(run.id, ctx(w.fx.users.approver!));
  // The run is finalized at the real time, after the primed checkpoint.
  clock.value = new Date();
  await w.svc.lifecycle.finalize(run.id, ctx(w.fx.users.finalizer!));
  return run.id;
}

const runEmployees = (tx: Tx, runId: string) =>
  tx.payrollRunEmployee.findMany({
    where: { payrollRunId: runId },
    include: {
      employee: {
        select: { person: { select: { user: { select: { id: true } } } } },
      },
    },
  });

const sourceOutcome = (
  outcome: Awaited<ReturnType<typeof publishEvents>>,
  key: string,
) => outcome.sources.find((row) => row.source === key)!;

const PAYSLIP_TITLE = 'Your pay statement is available';
const payslipBody = (start: string, end: string, payDate: string) =>
  `Your pay statement for ${start} to ${end} (pay date ${payDate}) is available.`;

/** A notice's text must carry no amount: nothing numeric is left once the dates are removed. */
function assertNoAmounts(
  notice: { title: string; body: string },
  dates: readonly string[],
  amounts: readonly string[],
) {
  for (const text of [notice.title, notice.body]) {
    for (const amount of amounts) {
      expect(text).not.toContain(amount);
    }
    let stripped = text;
    for (const date of dates) stripped = stripped.replaceAll(date, '');
    expect(stripped).not.toMatch(/\d/);
    expect(text).not.toMatch(/\$|CAD|USD|€|£/);
  }
}

/**
 * Wraps the scenario client so that the publisher's Notification inserts fail (as a crashed
 * worker would) after `inserts` succeeded. The error is thrown before the statement is sent,
 * so the scenario transaction stays usable.
 */
function crashingClient(tx: Tx, inserts: number) {
  let count = 0;
  const proxy: PrismaService = new Proxy(tx, {
    get(target, property, receiver) {
      if (property === '$transaction')
        return (run: (client: unknown) => Promise<unknown>) => run(proxy);
      if (property === '$queryRaw') {
        return (query: unknown, ...values: unknown[]) => {
          const text =
            (query as { sql?: string }).sql ??
            (Array.isArray(query) ? query.join('?') : '');
          if (text.includes('INSERT INTO "Notification"')) {
            count += 1;
            if (count > inserts)
              return Promise.reject(new Error('Simulated worker crash'));
          }
          return (
            target.$queryRaw as unknown as (...args: unknown[]) => unknown
          ).call(target, query, ...values);
        };
      }
      return Reflect.get(target, property, receiver) as unknown;
    },
  }) as unknown as PrismaService;
  return proxy;
}

/** A plan in any organization, created by the given administrator (SINGLE option, 25/75). */
async function planIn(
  svc: BenefitsServices,
  organizationId: string,
  actorUserId: string,
  code: string,
) {
  const admin = ctx(actorUserId);
  const plan = await svc.plans.create(
    {
      organizationId,
      code,
      name: 'Platinum Vision',
      benefitType: 'HEALTH',
      currency: 'CAD',
      effectiveFrom: '2026-01-01',
    },
    admin,
  );
  const single = await svc.plans.addOption(
    plan.id,
    { code: 'SINGLE', name: 'Solo Premium', coverageLevel: 'EMPLOYEE_ONLY' },
    admin,
  );
  await svc.rates.addRate(
    single.id,
    {
      effectiveFrom: '2026-01-01',
      frequency: 'MONTHLY',
      employeeAmount: '31',
      employerAmount: '69',
    },
    admin,
  );
  await svc.plans.transition(plan.id, 'ACTIVE', admin);
  return { plan, single };
}

/** The audit entries a benefits notice is published from, for some elections. */
const electionAudits = (tx: Tx, electionIds: readonly string[]) =>
  tx.auditLog.findMany({
    where: {
      entityType: 'BenefitEnrollment',
      entityId: { in: [...electionIds] },
    },
    orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
  });

/** Every benefits notice must name no plan, option, dependent, reason or cost. */
function assertBenefitPrivacy(notice: { title: string; body: string }) {
  for (const text of [notice.title, notice.body]) {
    for (const word of [
      'Health',
      'Platinum',
      'Vision',
      'Single',
      'Solo',
      'Family',
      'Premium',
      'Sam',
      'Spouse',
      SECRET_REASON,
      'Clerical',
      'Wrong',
      '25',
      '75',
      '31',
      '69',
      '$',
      'CAD',
    ]) {
      expect(text).not.toContain(word);
    }
  }
  expect(notice.title).toBe('Your benefit elections were updated');
  expect(notice.body).toMatch(
    /^Your benefit elections were updated \(effective \d{4}-\d{2}-\d{2}\)\. Review them in My Benefits\.$/,
  );
}

const effectiveOf = (body: string) =>
  /effective (\d{4}-\d{2}-\d{2})/.exec(body)?.[1] ?? null;

/**
 * Batch 8 (N1) — durable event notifications for payroll finalization and benefit elections.
 * Each scenario primes the two checkpoints at its own start, runs the real business
 * operations, then runs the event publisher as the worker would. Everything rolls back.
 */
describe('Batch 8 event notifications: payroll and benefits (database)', () => {
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService(process.env.DATABASE_URL!);
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  async function scenario(run: (s: Scenario) => Promise<void>) {
    await expect(
      prisma.$transaction(
        async (tx) => {
          await primeEventCheckpoints(
            tx,
            [PAYROLL_SOURCE, BENEFIT_SOURCE],
            await transactionStart(tx),
          );
          const fx = await createSchedulingFixtures(tx, USERS);
          await tx.organization.update({
            where: { id: fx.orgA },
            data: { timezone: 'America/Toronto' },
          });
          const client = rollbackClient(tx);
          const payrollClock = new FixedPayrollClock();
          await run({
            tx,
            fx,
            client,
            payrollClock,
            pay: payrollServices(client, payrollClock),
            ben: benefitsServices(client, new FixedBenefitsClock()),
          }).catch((error: unknown) => {
            console.error('SCENARIO FAILURE', error);
            throw error;
          });
          throw new RollbackFixtures();
        },
        { timeout: 300_000 },
      ),
    ).rejects.toBeInstanceOf(RollbackFixtures);
  }

  it('payroll: a finalized run notifies each employee once, with dates only and no amounts', async () => {
    await scenario(async ({ tx, fx, client, pay, payrollClock, ben }) => {
      const w = await world(tx, fx, pay);
      const extra = await staff(tx, fx, 4, { payGroupId: w.payGroupId });
      // Employee 2 has a health election, so the run has benefit deductions too.
      const { plan, single } = await healthPlan(ben, fx);
      await ben.enrollments.enroll(
        {
          employmentAssignmentId: fx.otherTeamA,
          planId: plan.id,
          optionId: single.id,
          coverageStart: '2026-02-01',
        },
        ctx(fx.users.benefitsAdmin!),
      );
      const runId = await finalizedRun(w, payrollClock);
      // Nothing is published by the finalization itself: fan-out is the worker's.
      expect(await noticesOf(tx, fx.orgA, PAYSLIP)).toHaveLength(0);

      const employees = await runEmployees(tx, runId);
      expect(employees).toHaveLength(6);
      expect(
        employees.some((row) => Number(row.deductionAmount) > 0),
        'some run employee has deductions',
      ).toBe(true);
      const period = await tx.payrollPeriod.findUniqueOrThrow({
        where: { id: w.periodId },
      });
      const dates = [period.periodStart, period.periodEnd, period.payDate].map(
        (date) => date.toISOString().slice(0, 10),
      );
      expect(dates).toEqual(['2026-10-04', '2026-10-17', '2026-10-22']);
      const run = await tx.payrollRun.findUniqueOrThrow({
        where: { id: runId },
      });
      const amounts = [
        ...employees.flatMap((row) => [
          row.grossAmount,
          row.deductionAmount,
          row.employerContributionAmount,
        ]),
        run.grossAmount,
      ]
        .filter((value) => value !== null && Number(value) !== 0)
        .flatMap((value) => {
          const fixed = Number(value).toFixed(2);
          return [
            fixed,
            Number(value).toLocaleString('en-CA', {
              minimumFractionDigits: 2,
            }),
          ];
        });
      expect(amounts.length).toBeGreaterThan(0);

      const first = sourceOutcome(
        await publishEvents(client, [PAYROLL_SOURCE]),
        PAYROLL_SOURCE,
      );
      expect(first).toMatchObject({
        events: 1,
        created: 6,
        existing: 0,
        skipped: 0,
        failed: [],
      });
      const notices = await noticesOf(tx, fx.orgA, PAYSLIP);
      expect(notices).toHaveLength(6);
      const expectedUsers = [
        fx.users.self1!,
        fx.users.self2!,
        ...extra.map((row) => row.userId),
      ].sort();
      expect(notices.map((row) => row.recipientUserId).sort()).toEqual(
        expectedUsers,
      );
      const byEmployeeRow = new Map(
        employees.map((row) => [row.id, row.employee.person.user!.id]),
      );
      for (const notice of notices) {
        expect(notice).toMatchObject({
          organizationId: fx.orgA,
          type: PAYSLIP,
          category: 'PAYROLL',
          link: '/pay',
          sourceDomain: 'PAYROLL',
          sourceEntityType: 'PayrollRunEmployee',
          dedupeKey: `${PAYSLIP}:${notice.sourceEntityId}`,
          title: PAYSLIP_TITLE,
          body: payslipBody(dates[0]!, dates[1]!, dates[2]!),
        });
        // Addressed to the employee of that payslip.
        expect(byEmployeeRow.get(notice.sourceEntityId!)).toBe(
          notice.recipientUserId,
        );
        assertNoAmounts(notice, dates, amounts);
      }
      // Payroll approvers, finalizers and administrators are not notified.
      for (const user of ['payrollAdmin', 'approver', 'finalizer'])
        expect(
          notices.some((row) => row.recipientUserId === fx.users[user]),
        ).toBe(false);

      // Publishing again creates nothing.
      const again = sourceOutcome(
        await publishEvents(client, [PAYROLL_SOURCE]),
        PAYROLL_SOURCE,
      );
      expect(again).toMatchObject({ events: 0, created: 0, failed: [] });
      expect(await noticesOf(tx, fx.orgA, PAYSLIP)).toHaveLength(6);
    });
  });

  it('payroll: a large fan-out (30 employees) resumes after a crash without duplicates', async () => {
    await scenario(async ({ tx, fx, client, pay, payrollClock }) => {
      const w = await world(tx, fx, pay);
      const extra = await staff(tx, fx, 28, { payGroupId: w.payGroupId });
      const runId = await finalizedRun(w, payrollClock);
      const employees = await runEmployees(tx, runId);
      expect(employees).toHaveLength(30);
      const finalizedAt = (
        await tx.payrollRun.findUniqueOrThrow({ where: { id: runId } })
      ).finalizedAt!;
      const checkpoint = () =>
        tx.notificationProducerCheckpoint.findUniqueOrThrow({
          where: { producerKey: PAYROLL_SOURCE },
        });
      const primed = await checkpoint();

      // A worker crashes after 11 of the 30 notices of the event.
      const crashed = sourceOutcome(
        await publishEvents(crashingClient(tx, 11), [PAYROLL_SOURCE], {
          pageSize: 1,
          maxEvents: 1,
        }),
        PAYROLL_SOURCE,
      );
      expect(crashed).toMatchObject({ events: 0, created: 11 });
      expect(crashed.failed).toHaveLength(1);
      expect(crashed.failed[0]!.message).toContain('Simulated worker crash');
      expect(await noticesOf(tx, fx.orgA, PAYSLIP)).toHaveLength(11);
      // The checkpoint stays before the event.
      const held = await checkpoint();
      expect(held.cursorAt.getTime()).toBe(primed.cursorAt.getTime());
      expect(held.cursorAt.getTime()).toBeLessThan(finalizedAt.getTime());

      // The next run repeats the event: only the missing 19 are created.
      const resumed = sourceOutcome(
        await publishEvents(client, [PAYROLL_SOURCE], {
          pageSize: 1,
          maxEvents: 1,
        }),
        PAYROLL_SOURCE,
      );
      expect(resumed).toMatchObject({
        events: 1,
        created: 19,
        existing: 11,
        skipped: 0,
        failed: [],
      });
      expect((await checkpoint()).cursorId).toBe(runId);

      // Nothing is left; a replay from scratch (checkpoint primed again) creates nothing.
      expect(
        sourceOutcome(
          await publishEvents(client, [PAYROLL_SOURCE], {
            pageSize: 1,
            maxEvents: 1,
          }),
          PAYROLL_SOURCE,
        ),
      ).toMatchObject({ events: 0, created: 0 });
      await primeEventCheckpoints(
        tx,
        [PAYROLL_SOURCE],
        await transactionStart(tx),
      );
      expect(
        sourceOutcome(
          await publishEvents(client, [PAYROLL_SOURCE], { pageSize: 2 }),
          PAYROLL_SOURCE,
        ),
      ).toMatchObject({ events: 1, created: 0, existing: 30, failed: [] });

      const notices = await noticesOf(tx, fx.orgA, PAYSLIP);
      expect(notices).toHaveLength(30);
      expect(new Set(notices.map((row) => row.recipientUserId)).size).toBe(30);
      expect(new Set(notices.map((row) => row.sourceEntityId))).toEqual(
        new Set(employees.map((row) => row.id)),
      );
      expect(notices.map((row) => row.recipientUserId).sort()).toEqual(
        [
          fx.users.self1!,
          fx.users.self2!,
          ...extra.map((row) => row.userId),
        ].sort(),
      );
      for (const notice of notices)
        expect(notice.body).toBe(
          payslipBody('2026-10-04', '2026-10-17', '2026-10-22'),
        );
    });
  });

  it('payroll: nothing is published while the PAYROLL module is disabled', async () => {
    await scenario(async ({ tx, fx, client, pay, payrollClock }) => {
      const w = await world(tx, fx, pay);
      await staff(tx, fx, 2, { payGroupId: w.payGroupId });
      await finalizedRun(w, payrollClock);
      await tx.organizationModuleSetting.create({
        data: { organizationId: fx.orgA, module: 'PAYROLL', enabled: false },
      });
      const outcome = sourceOutcome(
        await publishEvents(client, [PAYROLL_SOURCE]),
        PAYROLL_SOURCE,
      );
      expect(outcome).toMatchObject({
        events: 1,
        created: 0,
        skipped: 4,
        failed: [],
      });
      expect(await noticesOf(tx, fx.orgA, PAYSLIP)).toHaveLength(0);
      expect(
        await tx.notification.count({
          where: { type: PAYSLIP, organizationId: fx.orgA },
        }),
      ).toBe(0);
      // Publishing again still publishes nothing.
      await publishEvents(client, [PAYROLL_SOURCE]);
      expect(await noticesOf(tx, fx.orgA, PAYSLIP)).toHaveLength(0);
    });
  });

  it('benefits: enroll, waive, change, end, transfer, correct and rescind each notify the employee once', async () => {
    await scenario(async ({ tx, fx, client, ben }) => {
      const { plan, single, family } = await healthPlan(ben, fx);
      const dental = await healthPlan(ben, fx, 'DENTAL');
      const hr = ctx(fx.users.benefitsAdmin!);
      const spouse = await ben.dependents.create(
        fx.employee1,
        { firstName: 'Sam', lastName: 'Spouse', relationship: 'SPOUSE' },
        hr,
      );
      // Employee 1: enroll, change (to family), end.
      const enrolled = await ben.enrollments.enroll(
        {
          employmentAssignmentId: fx.assignmentTeamA,
          planId: plan.id,
          optionId: single.id,
          coverageStart: '2026-02-01',
          reason: SECRET_REASON,
        },
        hr,
      );
      const changed = await ben.enrollments.change(
        enrolled.id,
        {
          effectiveDate: '2026-04-01',
          optionId: family.id,
          dependentIds: [spouse.id],
          reason: SECRET_REASON,
        },
        hr,
      );
      await ben.enrollments.end(
        changed.id,
        { coverageEnd: '2026-09-30', reason: SECRET_REASON },
        hr,
      );
      // Employee 1: a dental election rescinded.
      const mistaken = await ben.enrollments.enroll(
        {
          employmentAssignmentId: fx.assignmentTeamA,
          planId: dental.plan.id,
          optionId: dental.single.id,
          coverageStart: '2026-06-01',
        },
        hr,
      );
      await ben.enrollments.rescind(
        mistaken.id,
        { reason: `Wrong plan ${SECRET_REASON}` },
        hr,
      );
      // Employee 2: waive (January), enroll (February), transfer (May), correct the waiver.
      const waiver = await ben.enrollments.waive(
        {
          employmentAssignmentId: fx.otherTeamA,
          planId: plan.id,
          coverageStart: '2026-01-01',
          coverageEnd: '2026-01-31',
          reason: SECRET_REASON,
        },
        hr,
      );
      const second = await ben.enrollments.enroll(
        {
          employmentAssignmentId: fx.otherTeamA,
          planId: plan.id,
          optionId: single.id,
          coverageStart: '2026-02-01',
        },
        hr,
      );
      const moved = await ben.enrollments.transfer(
        second.id,
        {
          employmentAssignmentId: fx.orgLevel,
          effectiveDate: '2026-05-01',
          reason: SECRET_REASON,
        },
        hr,
      );
      const corrected = await ben.enrollments.correct(
        waiver.id,
        { reason: `Clerical ${SECRET_REASON}`, coverageStart: '2026-01-05' },
        hr,
      );
      const elections = await tx.benefitEnrollment.findMany({
        where: { organizationId: fx.orgA },
        select: { id: true },
      });
      const audits = (
        await electionAudits(
          tx,
          elections.map((row) => row.id),
        )
      ).filter((row) => row.action.startsWith('BENEFIT_'));
      const expected: Record<string, [string, string, string]> = {};
      const expect1 = (
        action: string,
        entityId: string,
        user: string,
        date: string,
      ) => {
        const audit = audits.filter(
          (row) => row.action === action && row.entityId === entityId,
        );
        expect(audit, `${action} ${entityId}`).toHaveLength(1);
        expected[`${ELECTION}:${audit[0]!.id}`] = [action, user, date];
      };
      const self1 = fx.users.self1!;
      const self2 = fx.users.self2!;
      expect1('BENEFIT_ENROLLED', enrolled.id, self1, '2026-02-01');
      expect1('BENEFIT_ELECTION_CHANGED', changed.id, self1, '2026-04-01');
      expect1('BENEFIT_ELECTION_ENDED', changed.id, self1, '2026-09-30');
      expect1('BENEFIT_ENROLLED', mistaken.id, self1, '2026-06-01');
      expect1('BENEFIT_ELECTION_RESCINDED', mistaken.id, self1, '2026-06-01');
      expect1('BENEFIT_WAIVED', waiver.id, self2, '2026-01-01');
      expect1('BENEFIT_ENROLLED', second.id, self2, '2026-02-01');
      expect1('BENEFIT_ELECTION_TRANSFERRED', moved.id, self2, '2026-05-01');
      expect1('BENEFIT_ELECTION_CORRECTED', corrected.id, self2, '2026-01-05');
      expect(audits).toHaveLength(9);

      const outcome = sourceOutcome(
        await publishEvents(client, [BENEFIT_SOURCE], { pageSize: 4 }),
        BENEFIT_SOURCE,
      );
      expect(outcome).toMatchObject({ created: 9, skipped: 0, failed: [] });
      const notices = await noticesOf(tx, fx.orgA, ELECTION);
      expect(notices).toHaveLength(9);
      const actual = Object.fromEntries(
        notices.map((row) => [
          row.dedupeKey,
          [
            expected[row.dedupeKey]?.[0] ?? 'UNEXPECTED',
            row.recipientUserId,
            effectiveOf(row.body),
          ],
        ]),
      );
      expect(actual).toEqual(expected);
      for (const notice of notices) {
        expect(notice).toMatchObject({
          organizationId: fx.orgA,
          category: 'BENEFITS',
          link: '/benefits',
          sourceEntityType: 'BenefitEnrollment',
        });
        assertBenefitPrivacy(notice);
      }
      // The administrator who acted is never notified.
      expect(
        notices.some((row) => row.recipientUserId === fx.users.benefitsAdmin),
      ).toBe(false);

      // An entry whose actor is the employee themself notifies nobody.
      await tx.auditLog.create({
        data: {
          action: 'BENEFIT_ENROLLED',
          actorUserId: self1,
          entityType: 'BenefitEnrollment',
          entityId: enrolled.id,
          metadata: { organizationId: fx.orgA },
        },
      });
      const again = sourceOutcome(
        await publishEvents(client, [BENEFIT_SOURCE]),
        BENEFIT_SOURCE,
      );
      expect(again).toMatchObject({ events: 1, created: 0, failed: [] });
      expect(await noticesOf(tx, fx.orgA, ELECTION)).toHaveLength(9);
    });
  });

  it('benefits: the effective date of an end is the one that end recorded, even after a later change', async () => {
    await scenario(async ({ tx, fx, client, ben }) => {
      const { plan, single, family } = await healthPlan(ben, fx);
      const hr = ctx(fx.users.benefitsAdmin!);
      const spouse = await ben.dependents.create(
        fx.employee1,
        { firstName: 'Sam', lastName: 'Spouse', relationship: 'SPOUSE' },
        hr,
      );
      const enrolled = await ben.enrollments.enroll(
        {
          employmentAssignmentId: fx.assignmentTeamA,
          planId: plan.id,
          optionId: single.id,
          coverageStart: '2026-02-01',
        },
        hr,
      );
      // Coverage is ended on 2026-12-31 ...
      await ben.enrollments.end(enrolled.id, { coverageEnd: '2026-12-31' }, hr);
      // ... and later changed from June (the worker has not run in between).
      await ben.enrollments.change(
        enrolled.id,
        {
          effectiveDate: '2026-06-01',
          optionId: family.id,
          dependentIds: [spouse.id],
        },
        hr,
      );
      const [ended] = (await electionAudits(tx, [enrolled.id])).filter(
        (row) => row.action === 'BENEFIT_ELECTION_ENDED',
      );
      expect(ended!.metadata).toMatchObject({ coverageEnd: '2026-12-31' });
      await publishEvents(client, [BENEFIT_SOURCE]);
      const notice = (await noticesOf(tx, fx.orgA, ELECTION)).find(
        (row) => row.dedupeKey === `${ELECTION}:${ended!.id}`,
      );
      expect(notice).toBeDefined();
      // The end recorded 2026-12-31; the election row now ends 2026-05-31 (split by the change).
      expect(effectiveOf(notice!.body)).toBe('2026-12-31');
    });
  });

  it('benefits: a plan discontinuation notifies every affected employee once, with resumable small pages', async () => {
    await scenario(async ({ tx, fx, client, ben }) => {
      const { plan, single } = await healthPlan(ben, fx);
      const hr = ctx(fx.users.benefitsAdmin!);
      const extra = await staff(tx, fx, 4);
      const enroll = (assignmentId: string, start: string, end?: string) =>
        ben.enrollments.enroll(
          {
            employmentAssignmentId: assignmentId,
            planId: plan.id,
            optionId: single.id,
            coverageStart: start,
            coverageEnd: end ?? null,
          },
          hr,
        );
      // Ended by the discontinuation (coverage reaches past 2026-06-30).
      const endedRows = [
        {
          election: await enroll(fx.assignmentTeamA, '2026-02-01'),
          user: fx.users.self1!,
        },
        {
          election: await enroll(extra[0]!.assignmentId, '2026-03-01'),
          user: extra[0]!.userId,
        },
        {
          election: await enroll(
            extra[1]!.assignmentId,
            '2026-01-01',
            '2026-12-31',
          ),
          user: extra[1]!.userId,
        },
      ];
      // A waiver reaching past the date is ended too.
      const waiver = await ben.enrollments.waive(
        {
          employmentAssignmentId: extra[2]!.assignmentId,
          planId: plan.id,
          coverageStart: '2026-01-01',
        },
        hr,
      );
      endedRows.push({ election: waiver, user: extra[2]!.userId });
      // Rescinded: starts after the plan's new end.
      const rescindedRows = [
        {
          election: await enroll(fx.otherTeamA, '2026-08-01'),
          user: fx.users.self2!,
        },
      ];
      // Not affected: ends before the date.
      const untouched = await enroll(
        extra[3]!.assignmentId,
        '2026-01-01',
        '2026-05-31',
      );

      // The elections' own notices are published first.
      const enrollOutcome = sourceOutcome(
        await publishEvents(client, [BENEFIT_SOURCE]),
        BENEFIT_SOURCE,
      );
      expect(enrollOutcome).toMatchObject({ events: 6, created: 6 });

      const result = await ben.enrollments.discontinuePlan(
        plan.id,
        {
          effectiveTo: '2026-06-30',
          endElections: true,
          reason: SECRET_REASON,
        },
        ctx(fx.users.planAdmin!),
      );
      expect(result).toMatchObject({
        electionsEnded: 4,
        electionsRescinded: 1,
      });
      const affected = [...endedRows, ...rescindedRows];
      const discontinued = await tx.auditLog.findMany({
        where: {
          action: 'BENEFIT_ELECTION_DISCONTINUED',
          entityType: 'BenefitEnrollment',
          entityId: {
            in: [...affected.map((row) => row.election.id), untouched.id],
          },
        },
      });
      // One entry per affected election, none for the untouched one.
      expect(discontinued).toHaveLength(5);
      expect(discontinued.map((row) => row.entityId).sort()).toEqual(
        affected.map((row) => row.election.id).sort(),
      );
      for (const row of discontinued) {
        const rescinded = rescindedRows.some(
          (item) => item.election.id === row.entityId,
        );
        expect(row.metadata).toMatchObject({
          outcome: rescinded ? 'RESCINDED' : 'ENDED',
          effectiveTo: '2026-06-30',
        });
        expect(JSON.stringify(row.metadata)).not.toContain(SECRET_REASON);
      }

      // Small pages and a per-run limit: several runs, each resuming where the last stopped.
      const runs: number[] = [];
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const outcome = sourceOutcome(
          await publishEvents(client, [BENEFIT_SOURCE], {
            pageSize: 1,
            maxEvents: 2,
          }),
          BENEFIT_SOURCE,
        );
        expect(outcome.failed).toEqual([]);
        expect(outcome.existing).toBe(0);
        runs.push(outcome.events);
        if (outcome.events === 0) break;
      }
      expect(runs).toEqual([2, 2, 1, 0]);

      const keys = new Set(discontinued.map((row) => `${ELECTION}:${row.id}`));
      const notices = (await noticesOf(tx, fx.orgA, ELECTION)).filter((row) =>
        keys.has(row.dedupeKey),
      );
      expect(notices).toHaveLength(5);
      const byUser = new Map(
        notices.map((row) => [row.recipientUserId, effectiveOf(row.body)]),
      );
      expect(byUser.size).toBe(5);
      for (const row of endedRows)
        expect(byUser.get(row.user)).toBe('2026-06-30');
      for (const row of rescindedRows)
        expect(byUser.get(row.user)).toBe('2026-08-01');
      expect(byUser.has(extra[3]!.userId)).toBe(false);
      for (const notice of notices) {
        expect(notice.sourceEntityType).toBe('BenefitEnrollment');
        assertBenefitPrivacy(notice);
      }
      // All in all: 6 election notices and 5 discontinuation notices, nothing twice.
      expect(await noticesOf(tx, fx.orgA, ELECTION)).toHaveLength(11);
      expect(
        sourceOutcome(
          await publishEvents(client, [BENEFIT_SOURCE]),
          BENEFIT_SOURCE,
        ),
      ).toMatchObject({ events: 0, created: 0 });
      expect(await noticesOf(tx, fx.orgA, ELECTION)).toHaveLength(11);
    });
  });

  it('isolation: another organization’s employees get nothing; publishing twice creates nothing new', async () => {
    await scenario(async ({ tx, fx, client, pay, payrollClock, ben }) => {
      // Organization B: an employee with an account and a benefit election of their own.
      const jobTitle = await tx.jobTitle.create({
        data: {
          organizationId: fx.orgB,
          name: 'B Associate',
          code: `JB-${fx.suffix}`,
        },
      });
      const positionB = await tx.position.create({
        data: {
          organizationId: fx.orgB,
          jobTitleId: jobTitle.id,
          name: 'B Associate',
          code: `PBA-${fx.suffix}`,
        },
      });
      const [employeeB] = await staff(tx, fx, 1, {
        positionId: positionB.id,
        label: 'B',
      });
      const planB = await planIn(ben, fx.orgB, fx.users.orgBAdmin!, 'VISION-B');
      const electionB = await ben.enrollments.enroll(
        {
          employmentAssignmentId: employeeB!.assignmentId,
          planId: planB.plan.id,
          optionId: planB.single.id,
          coverageStart: '2026-03-01',
        },
        ctx(fx.users.orgBAdmin!),
      );
      // Organization A: a finalized payroll run and a benefit election.
      const w = await world(tx, fx, pay);
      const extraA = await staff(tx, fx, 2, { payGroupId: w.payGroupId });
      const { plan, single } = await healthPlan(ben, fx);
      // Employee 2 (salaried): Employee 1 is hourly with no time, so a deduction would be an error.
      const electionA = await ben.enrollments.enroll(
        {
          employmentAssignmentId: fx.otherTeamA,
          planId: plan.id,
          optionId: single.id,
          coverageStart: '2026-02-01',
        },
        ctx(fx.users.benefitsAdmin!),
      );
      await finalizedRun(w, payrollClock);

      const first = await publishEvents(client, [
        PAYROLL_SOURCE,
        BENEFIT_SOURCE,
      ]);
      expect(sourceOutcome(first, PAYROLL_SOURCE)).toMatchObject({
        created: 4,
        failed: [],
      });
      expect(sourceOutcome(first, BENEFIT_SOURCE)).toMatchObject({
        created: 2,
        failed: [],
      });
      const orgAUsers = new Set([
        fx.users.self1!,
        fx.users.self2!,
        ...extraA.map((row) => row.userId),
      ]);
      const ours = await tx.notification.findMany({
        where: { organizationId: { in: [fx.orgA, fx.orgB] } },
      });
      // Organization B's employee: only their own election, in Organization B.
      const toB = ours.filter(
        (row) => row.recipientUserId === employeeB!.userId,
      );
      expect(toB).toHaveLength(1);
      expect(toB[0]).toMatchObject({
        organizationId: fx.orgB,
        type: ELECTION,
        sourceEntityId: electionB.id,
      });
      assertBenefitPrivacy(toB[0]!);
      // Organization B has no other notice; Organization A's go to its employees only.
      expect(ours.filter((row) => row.organizationId === fx.orgB)).toHaveLength(
        1,
      );
      const inA = ours.filter((row) => row.organizationId === fx.orgA);
      expect(inA).toHaveLength(5);
      for (const row of inA)
        expect(orgAUsers.has(row.recipientUserId)).toBe(true);
      expect(
        inA
          .filter((row) => row.type === ELECTION)
          .map((row) => row.sourceEntityId),
      ).toEqual([electionA.id]);
      expect(inA.filter((row) => row.type === PAYSLIP)).toHaveLength(4);
      // Organization B's administrators (and Organization A's) receive nothing.
      for (const user of [
        'orgBAdmin',
        'orgBPayroll',
        'benefitsAdmin',
        'planAdmin',
      ])
        expect(ours.some((row) => row.recipientUserId === fx.users[user])).toBe(
          false,
        );

      // Publishing twice creates nothing new.
      const second = await publishEvents(client, [
        PAYROLL_SOURCE,
        BENEFIT_SOURCE,
      ]);
      for (const key of [PAYROLL_SOURCE, BENEFIT_SOURCE])
        expect(sourceOutcome(second, key)).toMatchObject({
          events: 0,
          created: 0,
        });
      expect(
        await tx.notification.count({
          where: { organizationId: { in: [fx.orgA, fx.orgB] } },
        }),
      ).toBe(6);
    });
  });
});
