import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/database/prisma.service.js';
import {
  sendExpiryReminders,
  verifyDocumentReferences,
} from '../src/documents/documents-jobs.js';
import { StorageAdapterUnavailableError } from '../src/documents/document-storage.contract.js';
import { sendTaskReminders } from '../src/onboarding/onboarding-jobs.js';
import { preparePayrollPeriods } from '../src/payroll/payroll-jobs.js';
import { sendPerformanceReminders } from '../src/performance/performance-jobs.js';
import {
  expireRecruitmentOffers,
  syncRecruitmentApplications,
} from '../src/recruitment/recruitment-jobs.js';
import { runExtendGeneratedShiftsJob } from '../src/scheduling/generation-job.js';
import { TimePolicyService } from '../src/time/time-policy.service.js';
import {
  benefitPlan,
  benefitsServices,
  FixedBenefitsClock,
} from './support/benefits-fixtures.js';
import { compensationServices } from './support/compensation-fixtures.js';
import {
  documentServices,
  FixedDocumentsClock,
} from './support/documents-fixtures.js';
import {
  disabled,
  FEATURE_USERS,
  featureServices,
  refusal,
  setModule,
  setSetting,
  type FeatureServices,
} from './support/features-fixtures.js';
import {
  connectOAuth,
  FixedGoogleClock,
  formInfo,
  googleTestServices,
} from './support/google-fixtures.js';
import { leaveServices, seedLeaveConfig } from './support/leave-fixtures.js';
import {
  FixedNotificationsClock,
  notificationTestServices,
  RecordingTransport,
} from './support/notifications-fixtures.js';
import {
  activeTemplate as onboardingTemplate,
  FixedOnboardingClock,
  onboardingServices,
} from './support/onboarding-fixtures.js';
import {
  FixedPayrollClock,
  payGroup,
  payrollServices,
} from './support/payroll-fixtures.js';
import {
  activeTemplate as performanceTemplate,
  cycleInput,
  FixedPerformanceClock,
  performanceServices,
} from './support/performance-fixtures.js';
import {
  FixedRecruitmentClock,
  openOpening,
  recruitmentServices,
} from './support/recruitment-fixtures.js';
import {
  FixedReportingClock,
  reportingServices,
} from './support/reporting-fixtures.js';
import {
  createSchedulingFixtures,
  ctx,
  rollbackClient,
  schedulingServices,
  type SchedulingFixtures,
  type Tx,
} from './support/scheduling-fixtures.js';
import {
  FixedClock as FixedTimeClock,
  seedTimePolicy,
  timeServices,
} from './support/time-fixtures.js';

config({ path: '../../.env' });

class RollbackFixtures extends Error {}

/**
 * Phase 18 enforcement: disabling a module refuses its service entry points (reads, writes and
 * entity-id routes) for that organization only, with 403 { code: FEATURE_DISABLED, module };
 * jobs skip the organization and report it; data is never touched and re-enabling restores
 * access; self-service settings refuse with SETTING_DISABLED.
 */
describe('Feature enforcement (database)', () => {
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
      features: FeatureServices,
      client: PrismaService,
    ) => Promise<void>,
  ) {
    await expect(
      prisma.$transaction(
        async (tx) => {
          const fx = await createSchedulingFixtures(tx, FEATURE_USERS);
          const client = rollbackClient(tx);
          await run(tx, fx, featureServices(client), client).catch(
            (error: unknown) => {
              console.error('SCENARIO FAILURE', error);
              throw error;
            },
          );
          throw new RollbackFixtures();
        },
        { timeout: 180_000 },
      ),
    ).rejects.toBeInstanceOf(RollbackFixtures);
  }

  it('LEAVE: configuration, self-service, approvals and the entitlement job', async () => {
    await scenario(async (tx, fx, features, client) => {
      const svc = leaveServices(client);
      const hr = ctx(fx.users.hr!);
      const types = await seedLeaveConfig(tx, fx, svc);
      const request = {
        employmentAssignmentId: fx.assignmentTeamA,
        leaveTypeId: types.vacation.id,
        startDate: '2027-03-08',
        endDate: '2027-03-08',
      };
      await svc.requests.previewOwn(fx.users.self1!, request);

      await setModule(features, fx, 'LEAVE', false);
      const off = disabled('LEAVE');
      // Organization reads and writes.
      expect(
        await refusal(
          svc.config.listTypes(fx.users.hr!, { organizationId: fx.orgA }),
        ),
      ).toEqual(off);
      expect(
        await refusal(
          svc.config.createType(
            {
              organizationId: fx.orgA,
              code: 'SICK',
              name: 'Sick',
              classification: 'PAID',
            },
            hr,
          ),
        ),
      ).toEqual(off);
      // Entity-id routes (load entity → organization → gate).
      expect(
        await refusal(
          svc.config.getPolicy(fx.users.hr!, types.vacationPolicy.id),
        ),
      ).toEqual(off);
      expect(
        await refusal(
          svc.config.updateType(types.vacation.id, { name: 'Holidays' }, hr),
        ),
      ).toEqual(off);
      // Self-service on an assignment of the organization.
      expect(
        await refusal(svc.requests.previewOwn(fx.users.self1!, request)),
      ).toEqual(off);
      expect(
        await refusal(
          svc.requests.submitOwn(
            fx.users.self1!,
            request,
            ctx(fx.users.self1!),
          ),
        ),
      ).toEqual(off);
      expect((await svc.views.me(fx.users.self1!)).assignments ?? []).toEqual(
        [],
      );
      // Organization pickers no longer offer it; queues are refused.
      expect(
        (await svc.views.organizations(fx.users.hr!)).items.map((o) => o.id),
      ).not.toContain(fx.orgA);
      expect(
        await refusal(
          svc.views.queue(fx.users.hr!, { organizationId: fx.orgA }),
        ),
      ).toEqual(off);

      // Another organization is unaffected.
      await svc.config.createType(
        {
          organizationId: fx.orgB,
          code: 'VAC',
          name: 'Vacation',
          classification: 'PAID',
        },
        ctx(fx.users.hrB!),
      );

      // The entitlement job skips the organization and reports it.
      const outcome = await svc.entitlements.processEntitlements({
        organizationId: fx.orgA,
      });
      expect(outcome.skippedOrganizations).toEqual([fx.orgA]);
      expect(outcome.accounts).toBe(0);

      // Nothing was deleted; re-enabling restores access.
      expect(
        await tx.leaveType.count({ where: { organizationId: fx.orgA } }),
      ).toBe(2);
      await setModule(features, fx, 'LEAVE', true);
      expect(
        (await svc.config.listTypes(fx.users.hr!, { organizationId: fx.orgA }))
          .items,
      ).toHaveLength(2);
      await svc.requests.previewOwn(fx.users.self1!, request);
    });
  });

  it('COMPENSATION (and the PAYROLL dependency): pay groups, records and self-service', async () => {
    await scenario(async (tx, fx, features, client) => {
      const svc = compensationServices(client);
      const hr = ctx(fx.users.hr!);
      const group = await svc.payGroups.create(
        { organizationId: fx.orgA, code: 'MONTHLY', name: 'Monthly' },
        hr,
      );
      await svc.compensation.create(
        fx.assignmentTeamA,
        {
          payBasis: 'SALARY',
          rateAmount: '60000',
          currency: 'CAD',
          effectiveFrom: '2026-01-01',
          payGroupId: group.id,
        },
        hr,
      );
      // Payroll depends on Compensation: refused until Payroll is off.
      expect(
        await refusal(setModule(features, fx, 'COMPENSATION', false)),
      ).toMatchObject({ status: 409, code: 'FEATURE_DEPENDENTS_ENABLED' });
      await setModule(features, fx, 'PAYROLL', false);
      await setModule(features, fx, 'COMPENSATION', false);
      const off = disabled('COMPENSATION');
      expect(
        await refusal(
          svc.payGroups.list(fx.users.hr!, { organizationId: fx.orgA }),
        ),
      ).toEqual(off);
      expect(
        await refusal(
          svc.payGroups.create(
            { organizationId: fx.orgA, code: 'WEEKLY', name: 'Weekly' },
            hr,
          ),
        ),
      ).toEqual(off);
      expect(await refusal(svc.payGroups.archive(group.id, hr))).toEqual(off);
      expect(
        await refusal(
          svc.compensation.history(fx.users.hr!, fx.assignmentTeamA),
        ),
      ).toEqual(off);
      expect(
        await refusal(svc.compensation.employee(fx.users.hr!, fx.employee1)),
      ).toEqual(off);
      expect(await refusal(svc.compensation.me(fx.users.self1!))).toEqual(off);
      expect(
        (await svc.payGroups.organizations(fx.users.hr!)).items.map(
          (o) => o.id,
        ),
      ).not.toContain(fx.orgA);
      // Org B is unaffected.
      await svc.payGroups.create(
        { organizationId: fx.orgB, code: 'WEEKLY', name: 'Weekly' },
        ctx(fx.users.hrB!),
      );
      // Data intact; re-enabling restores.
      expect(
        await tx.compensationRecord.count({
          where: { employmentAssignmentId: fx.assignmentTeamA },
        }),
      ).toBe(1);
      await setModule(features, fx, 'COMPENSATION', true);
      expect(
        (await svc.compensation.history(fx.users.hr!, fx.assignmentTeamA))
          .timeline,
      ).toHaveLength(1);
    });
  });

  it('PAYROLL: calendars, runs, self-service payslips and period preparation', async () => {
    await scenario(async (tx, fx, features, client) => {
      const clock = new FixedPayrollClock();
      const svc = payrollServices(client, clock);
      const group = await payGroup(tx, fx.orgA, `PG-${fx.suffix}`);
      const calendarInput = {
        payGroupId: group.id,
        cadence: 'BIWEEKLY' as const,
        timezone: 'America/Toronto',
        anchorDate: '2026-10-04',
        payDateOffsetDays: 5,
        processingCutoffOffsetDays: 2,
        effectiveFrom: '2026-10-04',
      };
      await svc.calendars.createCalendar(calendarInput, ctx(fx.users.hr!));
      await setModule(features, fx, 'PAYROLL', false);
      const off = disabled('PAYROLL');
      expect(
        await refusal(
          svc.calendars.calendars(fx.users.hr!, { organizationId: fx.orgA }),
        ),
      ).toEqual(off);
      expect(
        await refusal(
          svc.calendars.periods(fx.users.hr!, { organizationId: fx.orgA }),
        ),
      ).toEqual(off);
      expect(
        await refusal(
          svc.calendars.generatePeriods(
            { payGroupId: group.id, throughDate: '2026-11-20' },
            ctx(fx.users.hr!),
          ),
        ),
      ).toEqual(off);
      expect(
        await refusal(
          svc.reads.runs(fx.users.hr!, { organizationId: fx.orgA }),
        ),
      ).toEqual(off);
      expect((await svc.self.myPay(fx.users.self1!)).items).toEqual([]);
      expect(
        (await svc.access.organizations(fx.users.hr!)).items.map((o) => o.id),
      ).not.toContain(fx.orgA);
      // The preparation job skips the organization (no periods generated).
      const outcome = await preparePayrollPeriods(client, clock);
      expect(outcome.skippedOrganizations).toContain(fx.orgA);
      expect(
        await tx.payrollPeriod.count({ where: { organizationId: fx.orgA } }),
      ).toBe(0);
      // Org B unaffected.
      const groupB = await payGroup(tx, fx.orgB, `PGB-${fx.suffix}`);
      await svc.calendars.createCalendar(
        { ...calendarInput, payGroupId: groupB.id },
        ctx(fx.users.hrB!),
      );
      await setModule(features, fx, 'PAYROLL', true);
      expect(
        (
          await svc.calendars.calendars(fx.users.hr!, {
            organizationId: fx.orgA,
          })
        ).items,
      ).toHaveLength(1);
    });
  });

  it('SCHEDULING: schedules, views, policies and the generation job', async () => {
    await scenario(async (tx, fx, features, client) => {
      const svc = schedulingServices(client);
      const admin = ctx(fx.users.hr!);
      const schedule = await svc.scheduling.createSchedule(
        {
          scopeType: 'ORGANIZATION',
          organizationId: fx.orgA,
          name: 'Org',
          type: 'STANDARD',
          periodStart: '2026-10-05',
          periodEnd: '2026-10-11',
        },
        admin,
      );
      await setModule(features, fx, 'SCHEDULING', false);
      const off = disabled('SCHEDULING');
      expect(
        await refusal(
          svc.scheduling.createSchedule(
            {
              scopeType: 'ORGANIZATION',
              organizationId: fx.orgA,
              name: 'Next',
              type: 'STANDARD',
              periodStart: '2026-10-12',
              periodEnd: '2026-10-18',
            },
            admin,
          ),
        ),
      ).toEqual(off);
      expect(
        await refusal(svc.scheduling.getSchedule(fx.users.hr!, schedule.id)),
      ).toEqual(off);
      expect(
        await refusal(
          svc.scheduling.updateSchedule(schedule.id, { name: 'x' }, admin),
        ),
      ).toEqual(off);
      expect(
        await refusal(svc.scheduling.listShifts(fx.users.hr!, schedule.id)),
      ).toEqual(off);
      expect(
        (
          await svc.scheduling.listSchedules(fx.users.hr!, {
            organizationId: fx.orgA,
          })
        ).items,
      ).toEqual([]);
      expect(
        await refusal(
          svc.policies.createPolicy(
            {
              scopeType: 'ORGANIZATION',
              organizationId: fx.orgA,
              effectiveFrom: '2027-01-01',
              generationHorizonDays: 30,
            } as never,
            admin,
          ),
        ),
      ).toEqual(off);
      // The generation job skips the organization.
      const outcome = await runExtendGeneratedShiftsJob(
        { organizationId: fx.orgA },
        { prisma: client },
      );
      expect(outcome.skippedOrganizations).toEqual([fx.orgA]);
      expect(outcome.patterns).toBe(0);
      // Org B unaffected; re-enabling restores.
      await svc.scheduling.createSchedule(
        {
          scopeType: 'ORGANIZATION',
          organizationId: fx.orgB,
          name: 'B',
          type: 'STANDARD',
          periodStart: '2026-10-05',
          periodEnd: '2026-10-11',
        },
        ctx(fx.users.hrB!),
      );
      await setModule(features, fx, 'SCHEDULING', true);
      expect(
        (await svc.scheduling.getSchedule(fx.users.hr!, schedule.id)).id,
      ).toBe(schedule.id);
      void tx;
    });
  });

  it('ATTENDANCE: self clocking, management, policies and the open-entry scan', async () => {
    await scenario(async (tx, fx, features, client) => {
      const clock = new FixedTimeClock();
      const svc = timeServices(client, clock);
      await seedTimePolicy(tx, fx.orgA);
      const policies = new TimePolicyService(
        client,
        svc.authorization,
        svc.targets,
        svc.audit,
      );
      await svc.time.status(fx.users.self1!);
      // Payroll depends on attendance.
      expect(
        await refusal(setModule(features, fx, 'ATTENDANCE', false)),
      ).toMatchObject({ status: 409, code: 'FEATURE_DEPENDENTS_ENABLED' });
      await setModule(features, fx, 'PAYROLL', false);
      await setModule(features, fx, 'ATTENDANCE', false);
      const off = disabled('ATTENDANCE');
      expect(await refusal(svc.time.status(fx.users.self1!))).toEqual(off);
      expect(
        await refusal(
          svc.time.clockIn(
            fx.users.self1!,
            fx.assignmentTeamA,
            ctx(fx.users.self1!),
          ),
        ),
      ).toEqual(off);
      expect(
        await refusal(policies.list(fx.users.hr!, { organizationId: fx.orgA })),
      ).toEqual(off);
      expect(
        await refusal(
          svc.time.generateTimePeriods(
            fx.users.hr!,
            {
              organizationId: fx.orgA,
              cadence: 'WEEKLY',
              startDate: '2026-10-05',
            } as never,
            ctx(fx.users.hr!),
          ),
        ),
      ).toEqual(off);
      expect(
        (await policies.organizations(fx.users.hr!)).items.map((o) => o.id),
      ).not.toContain(fx.orgA);
      // The scan job skips the organization.
      const scan = await svc.time.scanOpenTimeEntriesForExceptions();
      expect(scan.skippedOrganizations).toContain(fx.orgA);
      // Org B unaffected; re-enabling restores self-service.
      await policies.list(fx.users.hrB!, { organizationId: fx.orgB });
      await setModule(features, fx, 'ATTENDANCE', true);
      await svc.time.clockIn(
        fx.users.self1!,
        fx.assignmentTeamA,
        ctx(fx.users.self1!),
      );
      expect((await svc.time.status(fx.users.self1!)).state).not.toBe(
        'OFF_CLOCK',
      );
    });
  });

  it('BENEFITS: plans, elections and self-service', async () => {
    await scenario(async (tx, fx, features, client) => {
      const svc = benefitsServices(client, new FixedBenefitsClock());
      const { plan } = await benefitPlan(tx, fx);
      await svc.plans.detail(fx.users.hr!, plan.id);
      await setModule(features, fx, 'BENEFITS', false);
      const off = disabled('BENEFITS');
      expect(
        await refusal(
          svc.plans.list(fx.users.hr!, { organizationId: fx.orgA }),
        ),
      ).toEqual(off);
      expect(
        await refusal(
          svc.plans.create(
            {
              organizationId: fx.orgA,
              code: 'DENTAL',
              name: 'Dental',
              benefitType: 'DENTAL',
              currency: 'CAD',
              effectiveFrom: '2026-01-01',
            },
            ctx(fx.users.hr!),
          ),
        ),
      ).toEqual(off);
      expect(await refusal(svc.plans.detail(fx.users.hr!, plan.id))).toEqual(
        off,
      );
      expect(
        await refusal(svc.plans.archive(plan.id, ctx(fx.users.hr!))),
      ).toEqual(off);
      expect(
        await refusal(svc.enrollments.employee(fx.users.hr!, fx.employee1)),
      ).toEqual(off);
      expect((await svc.enrollments.mine(fx.users.self1!)).items).toEqual([]);
      expect(await refusal(svc.dependents.mine(fx.users.self1!))).toEqual(off);
      // Org B unaffected.
      await svc.plans.create(
        {
          organizationId: fx.orgB,
          code: 'DENTAL',
          name: 'Dental',
          benefitType: 'DENTAL',
          currency: 'CAD',
          effectiveFrom: '2026-01-01',
        },
        ctx(fx.users.hrB!),
      );
      await setModule(features, fx, 'BENEFITS', true);
      expect((await svc.plans.detail(fx.users.hr!, plan.id)).id).toBe(plan.id);
    });
  });

  it('PERFORMANCE: configuration, cycles, reviews, self review setting and jobs', async () => {
    await scenario(async (tx, fx, features, client) => {
      const svc = performanceServices(client, new FixedPerformanceClock());
      const { template } = await performanceTemplate(svc, fx);
      const cycle = await svc.cycles.create(
        cycleInput(fx, template.id),
        ctx(fx.users.hr!),
      );
      // performance.selfReview: new cycles may not ask for self reviews; they default to none.
      await setSetting(features, fx, 'performance.selfReview', false);
      expect(
        await refusal(
          svc.cycles.create(
            cycleInput(fx, template.id, {
              code: 'annual-2027',
              selfReviewEnabled: true,
            }),
            ctx(fx.users.hr!),
          ),
        ),
      ).toEqual({
        status: 403,
        code: 'SETTING_DISABLED',
        key: 'performance.selfReview',
      });
      const noSelf = await svc.cycles.create(
        cycleInput(fx, template.id, { code: 'annual-2028' }),
        ctx(fx.users.hr!),
      );
      expect(noSelf).toMatchObject({ selfReviewEnabled: false });
      // The draft created before asks for self reviews: it is not launched while off.
      expect(
        await refusal(svc.cycles.open(cycle.id, ctx(fx.users.hr!))),
      ).toMatchObject({ status: 403, code: 'SETTING_DISABLED' });

      await setModule(features, fx, 'PERFORMANCE', false);
      const off = disabled('PERFORMANCE');
      expect(
        await refusal(svc.config.competencies(fx.users.hr!, fx.orgA)),
      ).toEqual(off);
      expect(
        await refusal(
          svc.config.createCompetency(
            { organizationId: fx.orgA, code: 'lead', name: 'Leadership' },
            ctx(fx.users.hr!),
          ),
        ),
      ).toEqual(off);
      expect(await refusal(svc.cycles.detail(fx.users.hr!, cycle.id))).toEqual(
        off,
      );
      expect(await refusal(svc.cycles.reviews(fx.users.hr!, cycle.id))).toEqual(
        off,
      );
      expect(
        await refusal(svc.goals.forEmployee(fx.users.hr!, fx.employee1)),
      ).toEqual(off);
      expect((await svc.goals.mine(fx.users.self1!)).items).toEqual([]);
      expect((await svc.evidence.mine(fx.users.self1!)).items).toEqual([]);
      expect((await svc.history.mine(fx.users.self1!)).items).toEqual([]);
      expect((await svc.reviews.queue(fx.users.self1!)).items).toEqual([]);
      expect(
        (await svc.access.organizations(fx.users.hr!)).items.map((o) => o.id),
      ).not.toContain(fx.orgA);
      // Jobs skip the organization.
      const reminders = await sendPerformanceReminders(client);
      expect(reminders.skippedOrganizations).toContain(fx.orgA);
      // Org B unaffected.
      await svc.config.createCompetency(
        { organizationId: fx.orgB, code: 'lead', name: 'Leadership' },
        ctx(fx.users.hrB!),
      );
      await setModule(features, fx, 'PERFORMANCE', true);
      expect((await svc.cycles.detail(fx.users.hr!, cycle.id)).id).toBe(
        cycle.id,
      );
      void tx;
    });
  });

  it('RECRUITMENT: pipeline, openings, candidates, intake setting and jobs', async () => {
    await scenario(async (tx, fx, features, client) => {
      const svc = recruitmentServices(client, new FixedRecruitmentClock());
      const opening = await openOpening(svc, fx);
      const source = await svc.intake.createSource(
        {
          organizationId: fx.orgA,
          code: 'manual-import',
          name: 'Manual import',
          provider: 'MANUAL_IMPORT',
        } as never,
        ctx(fx.users.hr!),
      );
      // recruitment.externalIntake off: the ingestion contract refuses (imports and syncs).
      await setSetting(features, fx, 'recruitment.externalIntake', false);
      expect(
        await refusal(svc.intake.ingest(source.id, [], 'IMPORT', fx.users.hr!)),
      ).toEqual({
        status: 403,
        code: 'SETTING_DISABLED',
        key: 'recruitment.externalIntake',
      });
      expect(
        (await syncRecruitmentApplications(client)).skippedOrganizations,
      ).toContain(fx.orgA);
      await setSetting(features, fx, 'recruitment.externalIntake', true);
      await svc.intake.ingest(source.id, [], 'IMPORT', fx.users.hr!);

      await setModule(features, fx, 'RECRUITMENT', false);
      const off = disabled('RECRUITMENT');
      expect(await refusal(svc.stages.list(fx.users.hr!, fx.orgA))).toEqual(
        off,
      );
      expect(
        await refusal(
          svc.stages.initializeDefaults(fx.orgA, ctx(fx.users.hr!)),
        ),
      ).toEqual(off);
      expect(
        await refusal(svc.openings.detail(fx.users.hr!, opening.id)),
      ).toEqual(off);
      expect(
        await refusal(
          svc.openings.transition(opening.id, 'hold', null, ctx(fx.users.hr!)),
        ),
      ).toEqual(off);
      expect(await refusal(svc.openings.list(fx.users.hr!, fx.orgA))).toEqual(
        off,
      );
      expect(await refusal(svc.candidates.list(fx.users.hr!, fx.orgA))).toEqual(
        off,
      );
      expect(
        await refusal(svc.intake.ingest(source.id, [], 'IMPORT', fx.users.hr!)),
      ).toEqual(off);
      expect(
        (await svc.access.organizations(fx.users.hr!)).items.map((o) => o.id),
      ).not.toContain(fx.orgA);
      // Jobs skip the organization.
      expect(
        (await expireRecruitmentOffers(client)).skippedOrganizations,
      ).toContain(fx.orgA);
      // Org B unaffected; re-enabling restores.
      await svc.stages.initializeDefaults(fx.orgB, ctx(fx.users.hrB!));
      await setModule(features, fx, 'RECRUITMENT', true);
      expect((await svc.openings.detail(fx.users.hr!, opening.id)).id).toBe(
        opening.id,
      );
      void tx;
    });
  });

  it('ONBOARDING: templates, workflows, tasks, the employee completion setting and reminders', async () => {
    await scenario(async (tx, fx, features, client) => {
      const svc = onboardingServices(client, new FixedOnboardingClock());
      await onboardingTemplate(svc, fx);
      const workflow = await svc.workflows.start(
        'ONBOARDING',
        { employmentAssignmentId: fx.assignmentTeamA },
        ctx(fx.users.hr!),
      );
      const paperwork = workflow.tasks.find(
        (task: { title: string }) => task.title === 'Sign employment paperwork',
      )!;
      // onboarding.employeeTaskCompletion off: the employee no longer works their own tasks.
      await setSetting(
        features,
        fx,
        'onboarding.employeeTaskCompletion',
        false,
      );
      expect(
        await refusal(svc.tasks.start(paperwork.id, ctx(fx.users.self1!))),
      ).toEqual({
        status: 403,
        code: 'SETTING_DISABLED',
        key: 'onboarding.employeeTaskCompletion',
      });
      expect(
        await refusal(
          svc.tasks.complete(
            paperwork.id,
            { evidenceReference: 'https://drive.google.com/file/d/contract' },
            ctx(fx.users.self1!),
          ),
        ),
      ).toMatchObject({ status: 403, code: 'SETTING_DISABLED' });
      // HR may still complete on the employee's behalf.
      await svc.tasks.complete(
        paperwork.id,
        { evidenceReference: 'https://drive.google.com/file/d/contract' },
        ctx(fx.users.hr!),
      );
      await setSetting(features, fx, 'onboarding.employeeTaskCompletion', true);

      await setModule(features, fx, 'ONBOARDING', false);
      const off = disabled('ONBOARDING');
      expect(await refusal(svc.templates.list(fx.users.hr!, fx.orgA))).toEqual(
        off,
      );
      expect(
        await refusal(
          svc.templates.create(
            {
              organizationId: fx.orgA,
              kind: 'OFFBOARDING',
              code: 'LEAVERS',
              name: 'Leavers',
              tasks: [],
            } as never,
            ctx(fx.users.hr!),
          ),
        ),
      ).toEqual(off);
      expect(
        await refusal(svc.workflows.detail(fx.users.hr!, workflow.id)),
      ).toEqual(off);
      expect(
        await refusal(svc.workflows.detail(fx.users.self1!, workflow.id)),
      ).toEqual(off);
      expect(
        await refusal(
          svc.workflows.dashboard(fx.users.hr!, fx.orgA, 'ONBOARDING'),
        ),
      ).toEqual(off);
      expect((await svc.workflows.mine(fx.users.self1!)).items).toEqual([]);
      expect(
        (await svc.workflows.employeeWorkflows(fx.users.hr!, fx.employee1))
          .items,
      ).toEqual([]);
      expect(
        await refusal(
          svc.tasks.completeFromSubmissions(fx.orgA, 'GOOGLE_FORM', [], null),
        ),
      ).toEqual(off);
      // Reminders skip the organization.
      const reminders = await sendTaskReminders(client, []);
      expect(reminders.skippedOrganizations).toContain(fx.orgA);
      // Workflow data intact; re-enabling restores.
      expect(
        await tx.employeeWorkflow.count({ where: { id: workflow.id } }),
      ).toBe(1);
      await setModule(features, fx, 'ONBOARDING', true);
      expect((await svc.workflows.detail(fx.users.hr!, workflow.id)).id).toBe(
        workflow.id,
      );
    });
  });

  it('DOCUMENTS: types, records, policies, self-service provide setting and jobs', async () => {
    await scenario(async (tx, fx, features, client) => {
      const svc = documentServices(client, new FixedDocumentsClock());
      const { items } = await svc.types.initializeDefaults(
        fx.orgA,
        ctx(fx.users.hr!),
      );
      const typeOf = (code: string) => items.find((t) => t.code === code)!.id;
      const record = await svc.documents.create(
        {
          organizationId: fx.orgA,
          employeeId: fx.employee2,
          typeId: typeOf('CERTIFICATION'),
          title: 'First aid',
          confidentiality: 'MANAGER_VISIBLE',
          version: {
            provider: 'GOOGLE_DRIVE',
            externalFileId: `drive-${fx.suffix}`,
            fileName: 'first-aid.pdf',
            mimeType: 'application/pdf',
            expiresOn: '2026-03-20',
          },
        } as never,
        ctx(fx.users.hr!),
      );
      const provide = () =>
        svc.documents.provide(
          {
            organizationId: fx.orgA,
            typeId: typeOf('CERTIFICATION'),
            title: 'My first aid',
            version: {
              provider: 'GOOGLE_DRIVE',
              externalFileId: `mine-${fx.suffix}`,
              fileName: 'mine.pdf',
              mimeType: 'application/pdf',
              expiresOn: '2030-01-01',
            },
          } as never,
          ctx(fx.users.self1!),
        );
      // documents.selfServiceProvide off: employees cannot provide (or version) their records.
      await setSetting(features, fx, 'documents.selfServiceProvide', false);
      expect(await refusal(provide())).toEqual({
        status: 403,
        code: 'SETTING_DISABLED',
        key: 'documents.selfServiceProvide',
      });
      await setSetting(features, fx, 'documents.selfServiceProvide', true);
      await provide();

      // Google Drive reference checks honour google.drive.verify.
      const checked: string[] = [];
      const adapter = {
        provider: 'GOOGLE_DRIVE' as const,
        checkReference: async (input: { organizationId: string }) => {
          checked.push(input.organizationId);
          if (input.organizationId !== fx.orgA)
            throw new StorageAdapterUnavailableError('OTHER_ORGANIZATION');
          return 'AVAILABLE' as const;
        },
      };
      await setSetting(features, fx, 'google.drive.verify', false);
      await verifyDocumentReferences(client, [adapter as never]);
      expect(checked).not.toContain(fx.orgA);
      await setSetting(features, fx, 'google.drive.verify', true);
      await verifyDocumentReferences(client, [adapter as never]);
      expect(checked).toContain(fx.orgA);

      await setModule(features, fx, 'DOCUMENTS', false);
      const off = disabled('DOCUMENTS');
      expect(await refusal(svc.types.list(fx.users.hr!, fx.orgA))).toEqual(off);
      expect(
        await refusal(
          svc.types.create(
            {
              organizationId: fx.orgA,
              code: 'badge',
              name: 'Badge',
              category: 'OTHER',
              defaultConfidentiality: 'HR_ONLY',
            },
            ctx(fx.users.hr!),
          ),
        ),
      ).toEqual(off);
      expect(
        await refusal(svc.documents.detail(fx.users.hr!, record.id)),
      ).toEqual(off);
      expect(
        await refusal(
          svc.documents.archive(record.id, 'Superseded', ctx(fx.users.hr!)),
        ),
      ).toEqual(off);
      expect(
        await refusal(svc.documents.expiryDashboard(fx.users.hr!, fx.orgA)),
      ).toEqual(off);
      expect(await refusal(svc.policies.list(fx.users.hr!, fx.orgA))).toEqual(
        off,
      );
      expect(await refusal(provide())).toEqual(off);
      expect((await svc.documents.mine(fx.users.self1!)).items).toEqual([]);
      expect(
        (await svc.documents.employeeRecords(fx.users.hr!, fx.employee2)).items,
      ).toEqual([]);
      expect(
        await refusal(
          svc.documents.validDocumentOfType(client, {
            organizationId: fx.orgA,
            employeeId: fx.employee2,
            typeId: typeOf('CERTIFICATION'),
          }),
        ),
      ).toEqual(off);
      expect(
        (await svc.access.organizations(fx.users.hr!)).items.map((o) => o.id),
      ).not.toContain(fx.orgA);
      // Jobs skip the organization.
      const delivered: string[] = [];
      const expiry = await sendExpiryReminders(client, [
        {
          deliver: async (digests) => {
            delivered.push(...digests.map((d) => d.organizationId));
          },
        },
      ]);
      expect(expiry.skippedOrganizations).toContain(fx.orgA);
      expect(delivered).not.toContain(fx.orgA);
      const verify = await verifyDocumentReferences(client, [adapter as never]);
      expect(verify.skippedOrganizations).toContain(fx.orgA);
      // Data intact; re-enabling restores.
      expect(
        await tx.employeeDocument.count({ where: { organizationId: fx.orgA } }),
      ).toBe(2);
      await setModule(features, fx, 'DOCUMENTS', true);
      expect((await svc.documents.detail(fx.users.hr!, record.id)).id).toBe(
        record.id,
      );
    });
  });

  it('NOTIFICATIONS: email off (mandatory included), in-app kept, administration refused, delivery skipped', async () => {
    await scenario(async (tx, fx, features, client) => {
      const clock = new FixedNotificationsClock();
      const svc = notificationTestServices(client, clock);
      await svc.templates.ensureSystemTemplates(tx);
      const publish = (type: string, key: string, variables = {}) =>
        svc.notifications.publish({
          organizationId: fx.orgA,
          recipientUserId: fx.selfUser1,
          type,
          variables,
          dedupeKey: `${key}-${fx.suffix}`,
        });
      const before = await publish('onboarding.tasks-due', 'before', {
        overdueCount: 1,
        dueSoonCount: 0,
        taskTitles: 'Paperwork',
      });
      expect(before.outcome).toBe('CREATED');

      await setModule(features, fx, 'NOTIFICATIONS', false);
      const off = disabled('NOTIFICATIONS');
      expect(
        await refusal(svc.settings.organizationSettings(fx.users.hr!, fx.orgA)),
      ).toEqual(off);
      expect(await refusal(svc.templates.list(fx.users.hr!, fx.orgA))).toEqual(
        off,
      );
      // In-app notices are still recorded — the mandatory HR_REQUIRED one included — but
      // their email is suppressed.
      for (const [type, key, variables] of [
        [
          'onboarding.tasks-due',
          'during',
          { overdueCount: 2, dueSoonCount: 0, taskTitles: 'Paperwork' },
        ],
        ['documents.required-missing', 'mandatory', { missingCount: 1 }],
      ] as const) {
        const result = await publish(type, key, variables);
        expect(result.outcome).toBe('CREATED');
        if (result.outcome !== 'CREATED') throw new Error('unexpected');
        const deliveries = await tx.notificationDelivery.findMany({
          where: { notificationId: result.notification.id },
        });
        expect(deliveries.find((d) => d.channel === 'IN_APP')).toMatchObject({
          status: 'SENT',
        });
        expect(deliveries.find((d) => d.channel === 'EMAIL')).toMatchObject({
          status: 'SUPPRESSED',
          suppressedReason: 'ORGANIZATION_EMAIL_DISABLED',
        });
      }
      // The inbox stays readable.
      expect(
        (await svc.notifications.mine(fx.selfUser1, {})).items.length,
      ).toBeGreaterThanOrEqual(3);
      // The delivery job skips the organization: the earlier pending email is left untouched.
      const transport = new RecordingTransport();
      const outcome = await svc
        .delivery(transport)
        .deliverPending({ organizationIds: [fx.orgA] });
      expect(outcome.skippedOrganizations).toEqual([fx.orgA]);
      expect(outcome.claimed).toBe(0);
      expect(transport.sent).toHaveLength(0);
      if (before.outcome !== 'CREATED') throw new Error('unexpected');
      expect(
        await tx.notificationDelivery.findFirstOrThrow({
          where: { notificationId: before.notification.id, channel: 'EMAIL' },
        }),
      ).toMatchObject({ status: 'PENDING' });
      // Org B is unaffected.
      await svc.settings.organizationSettings(fx.users.hrB!, fx.orgB);
    });
  });

  it('a disabled source module produces no (non-mandatory) notifications', async () => {
    await scenario(async (tx, fx, features, client) => {
      const svc = notificationTestServices(
        client,
        new FixedNotificationsClock(),
      );
      await svc.templates.ensureSystemTemplates(tx);
      await setModule(features, fx, 'ONBOARDING', false);
      expect(
        await svc.notifications.publish({
          organizationId: fx.orgA,
          recipientUserId: fx.selfUser1,
          type: 'onboarding.tasks-due',
          variables: { overdueCount: 1, dueSoonCount: 0, taskTitles: 'x' },
          dedupeKey: `skipped-${fx.suffix}`,
        }),
      ).toEqual({ outcome: 'REJECTED', reason: 'FEATURE_DISABLED' });
      await setModule(features, fx, 'DOCUMENTS', false);
      // Mandatory notices are never suppressed in-app.
      expect(
        (
          await svc.notifications.publish({
            organizationId: fx.orgA,
            recipientUserId: fx.selfUser1,
            type: 'documents.required-missing',
            variables: { missingCount: 1 },
            dedupeKey: `mandatory-${fx.suffix}`,
          })
        ).outcome,
      ).toBe('CREATED');
    });
  });

  it('GOOGLE_WORKSPACE: connection, bindings, sync settings and jobs', async () => {
    await scenario(async (tx, fx, features, client) => {
      const clock = new FixedGoogleClock();
      const svc = googleTestServices(client, clock);
      const recruitment = recruitmentServices(
        client,
        new FixedRecruitmentClock(),
      );
      await openOpening(recruitment, fx);
      const formId = `apply-form-${fx.suffix}`;
      const source = await recruitment.intake.createSource(
        {
          organizationId: fx.orgA,
          code: 'staff-form',
          name: 'Staff application',
          provider: 'GOOGLE_FORMS',
          externalResourceId: formId,
        },
        ctx(fx.users.hr!),
      );
      await connectOAuth(svc, fx.orgA, fx.users.hr!, ['FORMS']);
      svc.fake.forms.set(formId, formInfo(formId));
      const binding = await svc.bindings.create(
        {
          organizationId: fx.orgA,
          formId,
          target: 'RECRUITMENT_INTAKE',
          recruitmentSourceId: source.id,
          mapping: {
            schemaVersion: 1,
            fields: [
              { questionId: 'q-first', field: 'candidate.firstName' },
              { questionId: 'q-last', field: 'candidate.lastName' },
              { questionId: 'q-opening', field: 'openingCode' },
            ],
          },
        },
        ctx(fx.users.hr!),
      );
      // google.sync.recruitmentIntake off: manual syncs refused, scheduled ones skipped.
      await setSetting(features, fx, 'google.sync.recruitmentIntake', false);
      expect(
        await refusal(svc.sync.syncManually(binding.id, ctx(fx.users.hr!))),
      ).toEqual({
        status: 403,
        code: 'SETTING_DISABLED',
        key: 'google.sync.recruitmentIntake',
      });
      expect(await svc.sync.syncDue()).toMatchObject({
        skipped: 1,
        succeeded: 0,
      });
      expect(
        await tx.googleSyncRun.count({ where: { bindingId: binding.id } }),
      ).toBe(0);
      await setSetting(features, fx, 'google.sync.recruitmentIntake', true);
      // The target module disabled: refused as FEATURE_DISABLED for that module.
      await setModule(features, fx, 'RECRUITMENT', false);
      expect(
        await refusal(svc.sync.syncManually(binding.id, ctx(fx.users.hr!))),
      ).toEqual(disabled('RECRUITMENT'));
      await setModule(features, fx, 'RECRUITMENT', true);

      await setModule(features, fx, 'GOOGLE_WORKSPACE', false);
      const off = disabled('GOOGLE_WORKSPACE');
      expect(
        await refusal(svc.connections.status(fx.users.hr!, fx.orgA)),
      ).toEqual(off);
      expect(await refusal(svc.bindings.list(fx.users.hr!, fx.orgA))).toEqual(
        off,
      );
      expect(
        await refusal(
          svc.bindings.update(
            binding.id,
            { enabled: false },
            ctx(fx.users.hr!),
          ),
        ),
      ).toEqual(off);
      expect(
        await refusal(svc.sync.syncManually(binding.id, ctx(fx.users.hr!))),
      ).toEqual(off);
      expect(
        (await svc.access.organizations(fx.users.hr!)).items.map((o) => o.id),
      ).not.toContain(fx.orgA);
      // Adapters treat the organization as not connected.
      expect(await svc.runtime.connectionFor(fx.orgA, 'FORMS')).toBeNull();
      // Jobs skip the organization.
      expect((await svc.sync.syncDue()).skippedOrganizations).toContain(
        fx.orgA,
      );
      expect((await svc.connections.checkAll()).skippedOrganizations).toContain(
        fx.orgA,
      );
      // The connection itself is untouched; re-enabling restores.
      expect(
        await tx.googleWorkspaceConnection.count({
          where: { organizationId: fx.orgA, status: 'ACTIVE' },
        }),
      ).toBe(1);
      await setModule(features, fx, 'GOOGLE_WORKSPACE', true);
      expect(
        (await svc.connections.status(fx.users.hr!, fx.orgA)).connection,
      ).toMatchObject({ status: 'ACTIVE' });
    });
  });

  it('REPORTING: the area itself, and reports of disabled source modules', async () => {
    await scenario(async (_tx, fx, features, client) => {
      const google = googleTestServices(client, new FixedGoogleClock());
      const svc = reportingServices(
        client,
        new FixedReportingClock(),
        google.sheets,
      );
      const areas = async () =>
        (await svc.catalog(fx.users.hr!, fx.orgA)).items.map((a) => a.area);
      expect(await areas()).toEqual(
        expect.arrayContaining(['workforce', 'performance', 'payroll']),
      );
      await setModule(features, fx, 'PERFORMANCE', false);
      expect(await areas()).not.toContain('performance');
      expect(await areas()).toContain('workforce');
      expect(
        await refusal(svc.run(fx.users.hr!, 'performance.goals', fx.orgA, {})),
      ).toEqual(disabled('PERFORMANCE'));
      await svc.run(fx.users.hr!, 'workforce.assignment_status', fx.orgA, {});
      // scheduling.adherence also reads Time & attendance.
      await setModule(features, fx, 'PAYROLL', false);
      await setModule(features, fx, 'ATTENDANCE', false);
      expect(await areas()).not.toContain('time');
      expect(
        (await svc.catalog(fx.users.hr!, fx.orgA)).items
          .flatMap((a) => a.reports as Array<{ key: string }>)
          .map((r) => r.key),
      ).not.toContain('scheduling.adherence');

      await setModule(features, fx, 'REPORTING', false);
      const off = disabled('REPORTING');
      expect(await refusal(svc.catalog(fx.users.hr!, fx.orgA))).toEqual(off);
      expect(
        await refusal(
          svc.run(fx.users.hr!, 'workforce.assignment_status', fx.orgA, {}),
        ),
      ).toEqual(off);
      expect(
        await refusal(
          svc.exportCsv(
            'workforce.assignment_status',
            fx.orgA,
            {},
            ctx(fx.users.hr!),
          ),
        ),
      ).toEqual(off);
      expect(
        (await svc.organizations(fx.users.hr!)).items.map((o) => o.id),
      ).not.toContain(fx.orgA);
      // Org B is unaffected.
      expect(
        (await svc.catalog(fx.users.hrB!, fx.orgB)).items.length,
      ).toBeGreaterThan(0);
    });
  });

  it('the admin overview shows the linked sections through their own services', async () => {
    await scenario(async (tx, fx, features) => {
      await seedTimePolicy(tx, fx.orgA);
      // A feature admin who also administers attendance and notifications.
      const both = await tx.roleAssignment.findFirstOrThrow({
        where: { userId: fx.users.hr! },
      });
      await tx.roleAssignment.create({
        data: {
          userId: fx.users.featureAdmin!,
          roleId: both.roleId,
          roleOrganizationId: both.roleOrganizationId,
          scopeType: 'ORGANIZATION',
          organizationId: fx.orgA,
          startsAt: both.startsAt,
        } as never,
      });
      const overview = await features.features.overview(
        fx.users.featureAdmin!,
        fx.orgA,
      );
      expect(overview.linked.timeAttendance).toMatchObject({
        available: true,
        endpoint: `/time/policies?organizationId=${fx.orgA}`,
        organizationLayer: {
          attendance: { trackingMode: 'TIME_CLOCK' },
          clockMode: 'LIVE_CLOCK',
        },
      });
      expect(overview.linked.notifications).toMatchObject({
        available: true,
        emailEnabled: true,
        suppressMandatoryEmail: false,
      });
      await setModule(features, fx, 'NOTIFICATIONS', false);
      expect(
        (await features.features.overview(fx.users.featureAdmin!, fx.orgA))
          .linked.notifications,
      ).toEqual({ available: false, reason: 'FEATURE_DISABLED' });
    });
  });
});
