import { randomUUID } from 'node:crypto';
import { closeCompensation } from './payroll-fixtures.js';
import { AuditService } from '../../src/audit/audit.service.js';
import { AuthorizationService } from '../../src/authorization/authorization.service.js';
import type { PrismaService } from '../../src/database/prisma.service.js';
import { DocumentsAccessService } from '../../src/documents/documents-access.service.js';
import type { GoogleSheetsExportService } from '../../src/integrations/google/google-workspace.adapters.js';
import { RecruitmentAccessService } from '../../src/recruitment/recruitment-access.service.js';
import { BenefitsReportService } from '../../src/reporting/benefits-report.service.js';
import { CompensationReportService } from '../../src/reporting/compensation-report.service.js';
import { DocumentsReportService } from '../../src/reporting/documents-report.service.js';
import { LeaveReportService } from '../../src/reporting/leave-report.service.js';
import { PayrollReportService } from '../../src/reporting/payroll-report.service.js';
import { PerformanceReportService } from '../../src/reporting/performance-report.service.js';
import { RecruitmentReportService } from '../../src/reporting/recruitment-report.service.js';
import { ReportingAccessService } from '../../src/reporting/reporting-access.service.js';
import { ReportingClock } from '../../src/reporting/reporting-common.js';
import { ReportingService } from '../../src/reporting/reporting.service.js';
import { SchedulingReportService } from '../../src/reporting/scheduling-report.service.js';
import { TimeReportService } from '../../src/reporting/time-report.service.js';
import { WorkflowReportService } from '../../src/reporting/workflow-report.service.js';
import { WorkforceReportService } from '../../src/reporting/workforce-report.service.js';
import { GOOGLE_USERS } from './google-fixtures.js';
import type {
  SchedulingFixtures,
  Tx,
  UserSpec,
} from './scheduling-fixtures.js';

export const d = (value: string) => new Date(`${value}T00:00:00.000Z`);
const at = (value: string) => new Date(value);

const DOMAIN_READS = [
  'employee.read',
  'time.view',
  'schedule.read',
  'leave.read',
  'compensation.read',
  'payroll.read',
  'benefit.read',
  'performance.read',
  'recruitment.read',
  'onboarding.read',
  'document.read',
] as const;

/**
 * Users of the reporting specs. report.read / report.export never grant data by themselves;
 * every report also needs its source permission over the same scope.
 */
export const REPORTING_USERS: Record<string, UserSpec[]> = {
  /** Organization-wide HR analyst: every domain read except offboarding and confidential documents. */
  hr: [
    {
      permissions: ['report.read', 'report.export', ...DOMAIN_READS],
      scope: 'org',
    },
  ],
  /** Team A lead: team-scoped reports and domain reads, no export. */
  teamLead: [
    {
      permissions: [
        'report.read',
        'employee.read',
        'time.view',
        'leave.read',
        'compensation.read',
        'payroll.read',
        'performance.read',
        'recruitment.read',
        'document.read',
      ],
      scope: 'teamA',
    },
  ],
  /** Dept A reader: employee.read and report.read over Dept A (Team A included). */
  deptReader: [
    { permissions: ['report.read', 'employee.read'], scope: 'deptA' },
  ],
  /** report.read alone grants nothing. */
  reportOnly: [{ permissions: ['report.read', 'report.export'], scope: 'org' }],
  /** Domain reads without report.read. */
  sourceOnly: [{ permissions: [...DOMAIN_READS], scope: 'org' }],
  /** report.read on Team A, employee.read on Dept B: no scope holds both. */
  split: [
    { permissions: ['report.read'], scope: 'teamA' },
    { permissions: ['employee.read'], scope: 'deptB' },
  ],
  offboarder: [
    { permissions: ['report.read', 'offboarding.read'], scope: 'org' },
  ],
  docsConfidential: [
    {
      permissions: [
        'report.read',
        'document.read',
        'document.confidential.read',
      ],
      scope: 'org',
    },
  ],
  orgBAdmin: [
    {
      permissions: ['report.read', 'report.export', ...DOMAIN_READS],
      scope: 'orgB',
    },
  ],
  /** Employee 1 themselves, with organization-wide performance and recruitment reporting. */
  self1: [
    {
      permissions: [
        'report.read',
        'performance.read',
        'recruitment.read',
        'employee.read',
      ],
      scope: 'org',
    },
  ],
  googleAdmin: GOOGLE_USERS.googleAdmin!,
};

export class FixedReportingClock extends ReportingClock {
  value = new Date('2026-10-06T16:00:00.000Z');
  override now() {
    return this.value;
  }
}

export function reportingServices(
  prisma: PrismaService,
  clock: ReportingClock,
  sheets: GoogleSheetsExportService,
) {
  const authorization = new AuthorizationService(prisma);
  const access = new ReportingAccessService(
    prisma,
    authorization,
    new DocumentsAccessService(prisma, authorization),
    new RecruitmentAccessService(prisma, authorization),
    clock,
  );
  return new ReportingService(
    prisma,
    access,
    new AuditService(prisma),
    sheets,
    new WorkforceReportService(prisma),
    new TimeReportService(prisma),
    new SchedulingReportService(prisma),
    new LeaveReportService(prisma),
    new CompensationReportService(prisma),
    new PayrollReportService(prisma),
    new BenefitsReportService(prisma),
    new PerformanceReportService(prisma),
    new RecruitmentReportService(prisma),
    new WorkflowReportService(prisma),
    new DocumentsReportService(prisma),
  );
}

export interface ReportingWorld {
  employees: Record<string, string>;
  /** Assignment ids per employee label (E1 has `E1` (Team A) and `E1B` (Dept B), E2 has `E2` and `E2O`). */
  assignments: Record<string, string>;
  positionDeptA: string;
  positionOrgB: string;
  openings: Record<string, string>;
  cycleId: string;
}

/**
 * A known dataset across every reporting area (Organization A, plus one Organization B
 * employee), written straight into the domain tables inside the rollback transaction. Domain
 * lifecycle triggers (and FK triggers) are suspended for the seeding only, as test cleanup
 * does: the reports read these tables and the seeded rows have the shapes the domains write.
 *
 * Team A (Dept A, child unit): E1, E2, T3, T4, T5 (from 2026-01-01), T6 (hired 2026-03-10),
 * T7 (terminated 2026-05-15) — FULL_TIME. Dept A (no team): A1 FULL_TIME. Dept B: E1's second
 * assignment and B1–B5, PART_TIME. Organization level: E2's second assignment (PART_TIME).
 */
export async function seedReportingWorld(
  tx: Tx,
  fx: SchedulingFixtures,
): Promise<ReportingWorld> {
  await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
  await tx.organization.update({
    where: { id: fx.orgA },
    data: { timezone: 'America/Toronto' },
  });
  const code = (prefix: string) => `${prefix}-${fx.suffix}`;
  const jobTitle = await tx.jobTitle.findFirstOrThrow({
    where: { organizationId: fx.orgA },
  });
  const positionDeptA = (
    await tx.position.create({
      data: {
        organizationId: fx.orgA,
        jobTitleId: jobTitle.id,
        organizationalUnitId: fx.unitChild,
        departmentId: fx.deptA,
        name: 'Dept A Analyst',
        code: code('PDA'),
      },
    })
  ).id;
  const jobTitleB = await tx.jobTitle.create({
    data: { organizationId: fx.orgB, name: 'B title', code: code('JB') },
  });
  const positionOrgB = (
    await tx.position.create({
      data: {
        organizationId: fx.orgB,
        jobTitleId: jobTitleB.id,
        name: 'Org B role',
        code: code('POB'),
      },
    })
  ).id;

  const employees: Record<string, string> = {
    E1: fx.employee1,
    E2: fx.employee2,
  };
  const assignments: Record<string, string> = {
    E1: fx.assignmentTeamA,
    E1B: fx.assignmentDeptB,
    E2: fx.otherTeamA,
    E2O: fx.orgLevel,
  };
  const hire = async (
    label: string,
    positionId: string,
    type: 'FULL_TIME' | 'PART_TIME',
    options: { start?: string; end?: string } = {},
  ) => {
    const person = await tx.person.create({
      data: { firstName: label, lastName: fx.suffix },
    });
    const start = d(options.start ?? '2026-01-01');
    const employee = await tx.employee.create({
      data: {
        personId: person.id,
        employeeNumber: code(label),
        hireDate: start,
        ...(options.end
          ? { status: 'TERMINATED', terminationDate: d(options.end) }
          : {}),
      },
    });
    const assignment = await tx.employmentAssignment.create({
      data: {
        employeeId: employee.id,
        positionId,
        employmentType: type,
        status: options.end ? 'ENDED' : 'ACTIVE',
        isPrimary: true,
        startDate: start,
        endDate: options.end ? d(options.end) : null,
      },
    });
    employees[label] = employee.id;
    assignments[label] = assignment.id;
  };
  for (const label of ['T3', 'T4', 'T5'])
    await hire(label, fx.positionTeamA, 'FULL_TIME');
  await hire('T6', fx.positionTeamA, 'FULL_TIME', { start: '2026-03-10' });
  await hire('T7', fx.positionTeamA, 'FULL_TIME', { end: '2026-05-15' });
  await hire('A1', positionDeptA, 'FULL_TIME');
  for (const label of ['B1', 'B2', 'B3', 'B4', 'B5'])
    await hire(label, fx.positionDeptB, 'PART_TIME');
  await hire('X1', positionOrgB, 'FULL_TIME');

  const creator = fx.users.hr!;

  // ─── Compensation (HOURLY CAD unless noted) ──────────────────────────────
  const rates: Array<[string, 'HOURLY' | 'SALARY', string, string?]> = [
    ['E1', 'HOURLY', '20'],
    ['E2', 'HOURLY', '21'],
    ['T3', 'HOURLY', '22'],
    ['T4', 'HOURLY', '23'],
    ['T5', 'HOURLY', '24'],
    ['T6', 'HOURLY', '31'],
    ['A1', 'HOURLY', '33'],
    ['B1', 'HOURLY', '15'],
    ['B2', 'HOURLY', '16'],
    ['B3', 'HOURLY', '17'],
    ['B4', 'HOURLY', '18'],
    ['B5', 'HOURLY', '19'],
    ['E1B', 'HOURLY', '41'],
    ['E2O', 'SALARY', '60000'],
    ['T7', 'HOURLY', '25', '2026-05-15'],
  ];
  for (const [label, payBasis, rateAmount, effectiveTo] of rates) {
    await tx.compensationRecord.create({
      data: {
        employmentAssignmentId: assignments[label]!,
        organizationId: fx.orgA,
        recordType: 'INITIAL',
        payBasis,
        rateAmount,
        currency: 'CAD',
        effectiveFrom: label === 'T6' ? d('2026-03-10') : d('2026-01-01'),
        effectiveTo: effectiveTo ? d(effectiveTo) : null,
      },
    });
  }
  // A raise in April for T3 (the initial record now ends in March).
  // M2: closed the way the application does (a closure entry naming who closed it).
  for (const record of await tx.compensationRecord.findMany({
    where: { employmentAssignmentId: assignments.T3! },
    select: { id: true },
  }))
    await closeCompensation(tx, record.id, d('2026-03-31'), creator);
  await tx.compensationRecord.create({
    data: {
      employmentAssignmentId: assignments.T3!,
      organizationId: fx.orgA,
      recordType: 'CHANGE',
      payBasis: 'HOURLY',
      rateAmount: '22.5',
      currency: 'CAD',
      effectiveFrom: d('2026-04-01'),
    },
  });

  // ─── Payroll: two finalized periods, one draft run ───────────────────────
  const group = await tx.payGroup.create({
    data: { organizationId: fx.orgA, code: code('PG'), name: 'Biweekly' },
  });
  const calendar = await tx.payrollCalendar.create({
    data: {
      organizationId: fx.orgA,
      payGroupId: group.id,
      cadence: 'BIWEEKLY',
      timezone: 'America/Toronto',
      anchorDate: d('2026-02-15'),
      payDateOffsetDays: 5,
      processingCutoffOffsetDays: 2,
      effectiveFrom: d('2026-02-15'),
    },
  });
  const period = async (start: string, end: string, payDate: string) => {
    const timePeriod = await tx.timePeriod.create({
      data: {
        organizationId: fx.orgA,
        startDate: d(start),
        endDate: d(end),
        status: 'LOCKED',
        openedAt: at(`${start}T05:00:00Z`),
        closedAt: at(`${payDate}T05:00:00Z`),
        lockedAt: at(`${payDate}T06:00:00Z`),
      },
    });
    return tx.payrollPeriod.create({
      data: {
        organizationId: fx.orgA,
        payGroupId: group.id,
        payrollCalendarId: calendar.id,
        periodStart: d(start),
        periodEnd: d(end),
        payDate: d(payDate),
        processingCutoffAt: at(`${payDate}T12:00:00.000Z`),
        timezone: 'America/Toronto',
        status: 'FINALIZED',
        timePeriodId: timePeriod.id,
      },
    });
  };
  const runOf = async (
    periodId: string,
    status: 'FINALIZED' | 'DRAFT',
    paid: Array<[string, string, number, number, number]>,
  ) => {
    const run = await tx.payrollRun.create({
      data: {
        organizationId: fx.orgA,
        payrollPeriodId: periodId,
        payGroupId: group.id,
        currency: 'CAD',
        status,
        createdByUserId: creator,
        ...(status === 'FINALIZED'
          ? {
              calculatedAt: at('2026-03-01T10:00:00Z'),
              calculationVersion: 'v1',
              sourceFingerprint: 'fingerprint',
              approvedAt: at('2026-03-01T11:00:00Z'),
              approvedByUserId: creator,
              finalizedAt: at('2026-03-01T12:00:00Z'),
              finalizedByUserId: creator,
              grossAmount: paid.reduce((sum, row) => sum + row[2], 0),
              deductionAmount: paid.reduce((sum, row) => sum + row[3], 0),
              employerContributionAmount: paid.reduce(
                (sum, row) => sum + row[4],
                0,
              ),
            }
          : {}),
      },
    });
    const runAssignments: Record<string, string> = {};
    for (const [
      label,
      assignmentLabel,
      gross,
      deductions,
      contributions,
    ] of paid) {
      const assignment = await tx.employmentAssignment.findUniqueOrThrow({
        where: { id: assignments[assignmentLabel]! },
        include: { position: true },
      });
      const runEmployee = await tx.payrollRunEmployee.upsert({
        where: {
          payrollRunId_employeeId: {
            payrollRunId: run.id,
            employeeId: employees[label]!,
          },
        },
        create: {
          payrollRunId: run.id,
          employeeId: employees[label]!,
          employeeNumber: label,
          displayName: label,
        },
        update: {},
      });
      const row = await tx.payrollRunAssignment.create({
        data: {
          payrollRunId: run.id,
          payrollRunEmployeeId: runEmployee.id,
          employeeId: employees[label]!,
          employmentAssignmentId: assignment.id,
          organizationId: fx.orgA,
          positionId: assignment.positionId,
          positionName: assignment.position.name,
          employmentType: assignment.employmentType,
          assignmentStatus: assignment.status,
          assignmentStartDate: assignment.startDate,
          grossAmount: gross,
          deductionAmount: deductions,
          employerContributionAmount: contributions,
        },
      });
      runAssignments[assignmentLabel] = row.id;
    }
    return { run, runAssignments };
  };
  const p1 = await period('2026-02-15', '2026-02-28', '2026-03-06');
  const p2 = await period('2026-03-01', '2026-03-14', '2026-03-20');
  const team = ['E1', 'E2', 'T3', 'T4', 'T5'];
  const deptB = ['B1', 'B2', 'B3'];
  const run1 = await runOf(p1.id, 'FINALIZED', [
    ...team.map(
      (l) => [l, l, 1000, 200, 100] as [string, string, number, number, number],
    ),
    ...deptB.map(
      (l) => [l, l, 500, 50, 25] as [string, string, number, number, number],
    ),
    ['E2', 'E2O', 300, 30, 10],
  ]);
  await runOf(p2.id, 'FINALIZED', [
    ...team.map(
      (l) => [l, l, 1100, 200, 100] as [string, string, number, number, number],
    ),
    ...deptB.map(
      (l) => [l, l, 500, 50, 25] as [string, string, number, number, number],
    ),
  ]);
  // A draft (not finalized) run of a later period is never reported.
  const p3 = await period('2026-03-15', '2026-03-28', '2026-04-03');
  await runOf(p3.id, 'DRAFT', [['T3', 'T3', 99_999, 0, 0]]);

  // ─── Benefits ────────────────────────────────────────────────────────────
  const plan = await tx.benefitPlan.create({
    data: {
      organizationId: fx.orgA,
      code: code('HEALTH'),
      name: 'Health',
      benefitType: 'HEALTH',
      currency: 'CAD',
      status: 'ACTIVE',
      effectiveFrom: d('2026-01-01'),
    },
  });
  const option = await tx.benefitCoverageOption.create({
    data: {
      planId: plan.id,
      code: 'EE',
      name: 'Employee only',
      coverageLevel: 'EMPLOYEE_ONLY',
    },
  });
  const rate = await tx.benefitRate.create({
    data: {
      planId: plan.id,
      optionId: option.id,
      effectiveFrom: d('2026-01-01'),
      frequency: 'PER_PAY_PERIOD',
      employeeAmount: '50',
      employerAmount: '100',
      recordType: 'INITIAL',
    },
  });
  const enrollments: Record<string, string> = {};
  for (const [label, electionType] of [
    ['E1', 'ENROLLED'],
    ['E2', 'ENROLLED'],
    ['T3', 'ENROLLED'],
    ['T4', 'ENROLLED'],
    ['T5', 'ENROLLED'],
    ['T6', 'WAIVED'],
    ['B1', 'ENROLLED'],
  ] as const) {
    enrollments[label] = (
      await tx.benefitEnrollment.create({
        data: {
          employeeId: employees[label]!,
          employmentAssignmentId: assignments[label]!,
          organizationId: fx.orgA,
          planId: plan.id,
          optionId: electionType === 'ENROLLED' ? option.id : null,
          electionType,
          recordType: 'INITIAL',
          coverageStart: d('2026-01-01'),
          electedOn: d('2025-12-15'),
        },
      })
    ).id;
  }
  for (const label of ['E1', 'E2', 'T3', 'T4', 'T5', 'B1']) {
    const runAssignmentId = run1.runAssignments[label]!;
    const snapshot = await tx.payrollBenefitSnapshot.create({
      data: {
        payrollRunId: run1.run.id,
        payrollRunAssignmentId: runAssignmentId,
        benefitEnrollmentId: enrollments[label]!,
        planId: plan.id,
        planCode: plan.code,
        planName: plan.name,
        benefitType: 'HEALTH',
        optionId: option.id,
        optionCode: option.code,
        coverageLevel: 'EMPLOYEE_ONLY',
        rateId: rate.id,
        frequency: 'PER_PAY_PERIOD',
        employeeAmount: '50',
        employerAmount: '100',
        currency: 'CAD',
        employerContributionTaxable: false,
        coveredFrom: d('2026-02-15'),
        coveredTo: d('2026-02-28'),
      },
    });
    await tx.payrollDeductionLine.create({
      data: {
        payrollRunId: run1.run.id,
        payrollRunAssignmentId: runAssignmentId,
        category: 'BENEFIT',
        description: 'Health',
        amount: '50',
        currency: 'CAD',
        benefitSnapshotId: snapshot.id,
      },
    });
    await tx.payrollEmployerContributionLine.create({
      data: {
        payrollRunId: run1.run.id,
        payrollRunAssignmentId: runAssignmentId,
        category: 'BENEFIT',
        description: 'Health',
        amount: '100',
        currency: 'CAD',
        benefitSnapshotId: snapshot.id,
      },
    });
  }

  // ─── Performance ─────────────────────────────────────────────────────────
  const cycle = await tx.performanceCycle.create({
    data: {
      organizationId: fx.orgA,
      code: code('C1'),
      name: 'H1 2026',
      status: 'OPEN',
      openedAt: at('2026-07-01T12:00:00Z'),
      scoringMode: 'NONE',
      overallRatingEnabled: true,
      templateId: randomUUID(),
      periodStart: d('2026-01-01'),
      periodEnd: d('2026-06-30'),
      windowStart: d('2026-07-01'),
      windowEnd: d('2026-10-31'),
      selfReviewDueDate: d('2026-09-15'),
      reviewerDueDate: d('2026-09-30'),
    },
  });
  const review = async (label: string, rating: number | null) =>
    tx.performanceReview.create({
      data: {
        cycleId: cycle.id,
        organizationId: fx.orgA,
        employeeId: employees[label]!,
        employmentAssignmentId: assignments[label]!,
        status: rating === null ? 'IN_PROGRESS' : 'FINALIZED',
        selfStatus: rating === null ? 'NOT_STARTED' : 'SUBMITTED',
        reviewerStatus: rating === null ? 'IN_PROGRESS' : 'SUBMITTED',
        ...(rating === null
          ? {}
          : {
              overallRatingValue: rating,
              overallRatingLabel: `Level ${rating}`,
              finalizedAt: at('2026-08-01T12:00:00Z'),
              selfSubmittedAt: at('2026-07-15T12:00:00Z'),
              reviewerSubmittedAt: at('2026-07-20T12:00:00Z'),
            }),
      },
    });
  for (const label of ['E1', 'E2', 'T3', 'T4', 'T5']) await review(label, 3);
  for (const label of ['T6', 'B1', 'B2']) await review(label, 4);
  await review('B3', 5);
  for (const label of ['B4', 'B5']) await review(label, null);
  const goal = (
    label: string,
    status: 'COMPLETED' | 'NOT_STARTED' | 'IN_PROGRESS',
    dueDate: string,
  ) =>
    tx.performanceGoal.create({
      data: {
        organizationId: fx.orgA,
        employeeId: employees[label]!,
        employmentAssignmentId: assignments[label]!,
        title: `Goal ${label}`,
        startDate: d('2026-01-15'),
        dueDate: d(dueDate),
        status,
        ...(status === 'COMPLETED'
          ? { completedAt: at('2026-04-20T12:00:00Z'), progressPercent: 100 }
          : {}),
      },
    });
  await goal('E1', 'COMPLETED', '2026-05-01');
  await goal('T3', 'NOT_STARTED', '2026-05-01');
  await goal('T4', 'IN_PROGRESS', '2026-12-01');
  await goal('B1', 'IN_PROGRESS', '2026-06-01');
  const evidence = (
    label: string,
    kind: 'ASSESSMENT' | 'TRAINING' | 'CERTIFICATION',
    provider: 'GOOGLE_FORMS' | 'MANUAL',
    passed: boolean | null,
  ) =>
    tx.performanceEvidence.create({
      data: {
        organizationId: fx.orgA,
        employeeId: employees[label]!,
        provider,
        kind,
        channel: provider === 'MANUAL' ? 'MANUAL' : 'IMPORT',
        title: `${kind} ${label}`,
        completedAt: at('2026-03-15T15:00:00Z'),
        passed,
        ...(passed === null
          ? {}
          : {
              score: passed ? '9' : '3',
              maxScore: '10',
              percentage: passed ? '90' : '30',
            }),
      },
    });
  for (const label of ['E1', 'E2', 'T3', 'T4'])
    await evidence(label, 'ASSESSMENT', 'GOOGLE_FORMS', true);
  await evidence('T5', 'ASSESSMENT', 'GOOGLE_FORMS', false);
  await evidence('B1', 'TRAINING', 'MANUAL', null);
  await evidence('B2', 'CERTIFICATION', 'MANUAL', null);

  // ─── Recruitment ─────────────────────────────────────────────────────────
  const stage = async (
    stageCode: string,
    kind: 'APPLIED' | 'INTERVIEW' | 'OFFER',
    sortOrder: number,
  ) =>
    (
      await tx.recruitmentStage.create({
        data: {
          organizationId: fx.orgA,
          code: stageCode,
          name: stageCode,
          kind,
          sortOrder,
        },
      })
    ).id;
  const s1 = await stage('APPLIED', 'APPLIED', 1);
  const s2 = await stage('INTERVIEW', 'INTERVIEW', 2);
  const s3 = await stage('OFFER', 'OFFER', 3);
  const opening = async (label: string, placement: Record<string, string>) =>
    (
      await tx.jobOpening.create({
        data: {
          organizationId: fx.orgA,
          code: code(label),
          title: `Opening ${label}`,
          employmentType: 'FULL_TIME',
          openingCount: 2,
          hiredCount: label === 'O1' ? 1 : 0,
          status: 'OPEN',
          openedAt: at('2026-02-01T12:00:00Z'),
          ...placement,
        },
      })
    ).id;
  const openings = {
    O1: await opening('O1', {
      organizationalUnitId: fx.unitChild,
      departmentId: fx.deptA,
      teamId: fx.teamA,
      positionId: fx.positionTeamA,
    }),
    O2: await opening('O2', { departmentId: fx.deptB }),
  };
  const application = async (
    label: string,
    openingId: string,
    stageId: string,
    source: 'REFERRAL' | 'JOB_BOARD' | 'DIRECT',
    status: 'ACTIVE' | 'HIRED' | 'REJECTED',
    internalEmployeeId: string | null = null,
  ) => {
    const candidate = await tx.recruitmentCandidate.create({
      data: {
        organizationId: fx.orgA,
        firstName: label,
        lastName: 'Candidate',
        source,
        internalEmployeeId,
      },
    });
    return (
      await tx.recruitmentApplication.create({
        data: {
          organizationId: fx.orgA,
          candidateId: candidate.id,
          openingId,
          stageId,
          status,
          source,
          appliedAt: at('2026-03-01T14:00:00Z'),
          ...(status === 'REJECTED'
            ? { dispositionAt: at('2026-03-03T14:00:00Z') }
            : {}),
        },
      })
    ).id;
  };
  const c1 = await application('C1', openings.O1, s2, 'REFERRAL', 'ACTIVE');
  const c2 = await application('C2', openings.O1, s3, 'JOB_BOARD', 'HIRED');
  // Employee 1's own (internal) candidacy.
  await application('C3', openings.O1, s1, 'REFERRAL', 'ACTIVE', fx.employee1);
  await application('C4', openings.O2, s1, 'DIRECT', 'REJECTED');
  const transition = (
    applicationId: string,
    fromStageId: string | null,
    toStageId: string,
    createdAt: string,
  ) =>
    tx.recruitmentStageTransition.create({
      data: {
        applicationId,
        fromStageId,
        toStageId,
        toStageName: toStageId,
        createdAt: at(createdAt),
      },
    });
  await transition(c1, null, s1, '2026-03-01T15:00:00Z');
  await transition(c1, s1, s2, '2026-03-05T15:00:00Z');
  await transition(c2, null, s1, '2026-03-02T15:00:00Z');
  await transition(c2, s1, s2, '2026-03-04T15:00:00Z');
  await transition(c2, s2, s3, '2026-03-10T15:00:00Z');
  const offer = (applicationId: string, status: 'ACCEPTED' | 'DECLINED') =>
    tx.recruitmentOffer.create({
      data: {
        organizationId: fx.orgA,
        applicationId,
        positionId: fx.positionTeamA,
        employmentType: 'FULL_TIME',
        startDate: d('2026-04-01'),
        payBasis: 'HOURLY',
        rateAmount: '25',
        currency: 'CAD',
        status,
        approvedAt: at('2026-03-08T16:00:00Z'),
        sentAt: at('2026-03-08T17:00:00Z'),
        respondedAt: at('2026-03-09T17:00:00Z'),
        createdAt: at('2026-03-08T15:00:00Z'),
      },
    });
  await offer(c2, 'ACCEPTED');
  await offer(c1, 'DECLINED');

  // ─── Onboarding / offboarding ────────────────────────────────────────────
  const workflow = (
    label: string,
    kind: 'ONBOARDING' | 'OFFBOARDING',
    startedAt: string,
    completedAt: string | null,
  ) =>
    tx.employeeWorkflow.create({
      data: {
        organizationId: fx.orgA,
        kind,
        employeeId: employees[label]!,
        employmentAssignmentId: assignments[label]!,
        templateName: `${kind} checklist`,
        status: completedAt ? 'COMPLETED' : 'ACTIVE',
        anchorDate: d(startedAt.slice(0, 10)),
        startedAt: at(startedAt),
        completedAt: completedAt ? at(completedAt) : null,
        reason: kind === 'OFFBOARDING' ? 'Confidential departure reason' : null,
        plannedEndDate: kind === 'OFFBOARDING' ? d('2026-05-15') : null,
      },
    });
  await workflow(
    'T6',
    'ONBOARDING',
    '2026-03-10T14:00:00Z',
    '2026-03-20T14:00:00Z',
  );
  const pending = await workflow(
    'A1',
    'ONBOARDING',
    '2026-02-15T14:00:00Z',
    null,
  );
  await tx.employeeWorkflowTask.create({
    data: {
      workflowId: pending.id,
      organizationId: fx.orgA,
      sortOrder: 1,
      title: 'Sign agreement',
      category: 'PAPERWORK',
      ownerType: 'EMPLOYEE',
      dueDate: d('2026-03-01'),
      required: true,
      evidenceRequired: false,
      acknowledgementRequired: false,
      systemAction: 'NONE',
    },
  });
  await workflow(
    'T7',
    'OFFBOARDING',
    '2026-05-01T14:00:00Z',
    '2026-05-15T14:00:00Z',
  );

  // ─── Documents ───────────────────────────────────────────────────────────
  const type = async (
    typeCode: string,
    defaultConfidentiality: 'MANAGER_VISIBLE' | 'HR_ONLY' | 'RESTRICTED',
  ) =>
    (
      await tx.documentType.create({
        data: {
          organizationId: fx.orgA,
          code: typeCode,
          name: typeCode,
          category: 'CERTIFICATION',
          defaultConfidentiality,
          expiryTracked: true,
        },
      })
    ).id;
  const cert = await type('CERT', 'MANAGER_VISIBLE');
  const background = await type('BG', 'HR_ONLY');
  const identification = await type('ID', 'RESTRICTED');
  await tx.documentRequirement.create({
    data: {
      organizationId: fx.orgA,
      typeId: cert,
      employmentType: 'FULL_TIME',
    },
  });
  await tx.documentRequirement.create({
    data: {
      organizationId: fx.orgA,
      typeId: background,
      departmentId: fx.deptB,
    },
  });
  const document = async (
    label: string,
    typeId: string,
    confidentiality: 'MANAGER_VISIBLE' | 'HR_ONLY' | 'RESTRICTED',
    expiresOn: string,
  ) => {
    const row = await tx.employeeDocument.create({
      data: {
        organizationId: fx.orgA,
        employeeId: employees[label]!,
        typeId,
        title: `${label} document`,
        confidentiality,
        source: 'HR',
      },
    });
    await tx.employeeDocumentVersion.create({
      data: {
        documentId: row.id,
        versionNumber: 1,
        provider: 'MANUAL_REFERENCE',
        expiresOn: d(expiresOn),
      },
    });
  };
  await document('E2', cert, 'MANAGER_VISIBLE', '2026-10-20');
  await document('T3', cert, 'MANAGER_VISIBLE', '2026-09-01');
  await document('T4', cert, 'MANAGER_VISIBLE', '2027-06-01');
  await document('B1', background, 'HR_ONLY', '2026-08-01');
  await document('T5', identification, 'RESTRICTED', '2026-10-10');
  const policy = await tx.policyDocument.create({
    data: {
      organizationId: fx.orgA,
      code: code('CONDUCT'),
      title: 'Code of conduct',
      status: 'PUBLISHED',
      acknowledgementRequired: true,
    },
  });
  const version = await tx.policyDocumentVersion.create({
    data: {
      policyId: policy.id,
      organizationId: fx.orgA,
      versionNumber: 1,
      versionLabel: 'v1',
      provider: 'MANUAL_REFERENCE',
      publishedAt: at('2026-02-01T12:00:00Z'),
      publishedByUserId: creator,
    },
  });
  for (const label of ['E1', 'T3']) {
    await tx.documentAcknowledgement.create({
      data: {
        organizationId: fx.orgA,
        policyVersionId: version.id,
        employeeId: employees[label]!,
        acknowledgedByUserId: creator,
        statement: 'I have read it.',
        source: 'SELF_SERVICE',
      },
    });
  }

  // ─── Time, scheduling and leave ──────────────────────────────────────────
  const schedule = await tx.schedule.create({
    data: {
      scopeType: 'TEAM',
      organizationId: fx.orgA,
      teamId: fx.teamA,
      name: 'March',
      periodStart: d('2026-03-02'),
      periodEnd: d('2026-03-08'),
      type: 'STANDARD',
      status: 'PUBLISHED',
      publishedAt: at('2026-02-25T12:00:00Z'),
      publishedByUserId: creator,
    },
  });
  const shift = async (label: string, workDate: string) => {
    const row = await tx.scheduledShift.create({
      data: {
        scheduleId: schedule.id,
        employmentAssignmentId: assignments[label]!,
        workDate: d(workDate),
        startsAt: at(`${workDate}T14:00:00Z`),
        endsAt: at(`${workDate}T22:00:00Z`),
        timezone: 'America/Toronto',
      },
    });
    const revision = await tx.scheduledShiftRevision.create({
      data: {
        scheduledShiftId: row.id,
        revisionNumber: 1,
        revisionType: 'PUBLISHED_BASELINE',
        employmentAssignmentId: row.employmentAssignmentId,
        workDate: row.workDate,
        startsAt: row.startsAt,
        endsAt: row.endsAt,
        timezone: row.timezone,
        status: 'ACTIVE',
        sourceType: 'MANUAL',
        changedByUserId: creator,
      },
    });
    return { id: row.id, revisionId: revision.id };
  };
  const workedShift = await shift('E1', '2026-03-02');
  await shift('T3', '2026-03-05');
  const entry = async (
    label: string,
    workDate: string,
    hours: number | null,
    options: {
      shift?: { id: string; revisionId: string };
      voided?: boolean;
      unpaidBreak?: boolean;
    } = {},
  ) => {
    const clockInAt = at(`${workDate}T14:00:00Z`);
    const row = await tx.timeEntry.create({
      data: {
        employeeId: employees[label]!,
        employmentAssignmentId: assignments[label]!,
        clockInAt,
        clockOutAt:
          hours === null
            ? null
            : new Date(clockInAt.getTime() + hours * 3_600_000),
        timezone: 'America/Toronto',
        workDate: d(workDate),
        status: options.voided ? 'VOIDED' : hours === null ? 'OPEN' : 'CLOSED',
        source: 'MANUAL',
        scheduledShiftId: options.shift?.id ?? null,
        scheduledShiftRevisionId: options.shift?.revisionId ?? null,
      },
    });
    if (options.unpaidBreak) {
      await tx.breakEntry.create({
        data: {
          timeEntryId: row.id,
          startAt: at(`${workDate}T18:00:00Z`),
          endAt: at(`${workDate}T18:30:00Z`),
          payType: 'UNPAID',
        },
      });
    }
    return row.id;
  };
  const e1Entry = await entry('E1', '2026-03-02', 8, {
    shift: workedShift,
    unpaidBreak: true,
  });
  const t3Entry = await entry('T3', '2026-03-03', 8);
  const b1Entry = await entry('B1', '2026-03-02', 4);
  await entry('T4', '2026-03-04', null);
  await entry('T5', '2026-03-04', 8, { voided: true });
  await tx.attendanceException.create({
    data: {
      employeeId: employees.E1!,
      employmentAssignmentId: assignments.E1!,
      timeEntryId: e1Entry,
      type: 'LATE_ARRIVAL',
      severity: 'REVIEW',
      workflowImpact: 'NON_BLOCKING',
      status: 'OPEN',
      detectedAt: at('2026-03-02T15:00:00Z'),
    },
  });
  await tx.attendanceException.create({
    data: {
      employeeId: employees.B1!,
      employmentAssignmentId: assignments.B1!,
      timeEntryId: b1Entry,
      type: 'MISSING_CLOCK_OUT',
      severity: 'ACTION_REQUIRED',
      workflowImpact: 'SUBMISSION_BLOCKING',
      status: 'RESOLVED',
      detectedAt: at('2026-03-03T15:00:00Z'),
      resolvedAt: at('2026-03-04T15:00:00Z'),
      resolutionMethod: 'MANAGER_RESOLUTION',
    },
  });
  await tx.timeCorrectionRequest.create({
    data: {
      employeeId: employees.T3!,
      requestorUserId: creator,
      employmentAssignmentId: assignments.T3!,
      timeEntryId: t3Entry,
      type: 'CHANGE_CLOCK_OUT',
      status: 'APPROVED',
      reviewerUserId: creator,
      reviewedAt: at('2026-03-05T15:00:00Z'),
      reason: 'Forgot',
      requestedValues: {},
      requestedAt: at('2026-03-04T15:00:00Z'),
    },
  });

  const vacation = await tx.leaveType.create({
    data: {
      organizationId: fx.orgA,
      code: 'VAC',
      name: 'Vacation',
      classification: 'PAID',
    },
  });
  const account = await tx.leaveAccount.create({
    data: {
      employeeId: employees.T3!,
      employmentAssignmentId: assignments.T3!,
      leaveTypeId: vacation.id,
    },
  });
  const ledger = (
    entryType: 'GRANT' | 'USAGE',
    amountMinutes: number,
    effectiveDate: string,
    usage: { requestId: string; dayId: string } | null = null,
  ) =>
    tx.leaveLedgerEntry.create({
      data: {
        accountId: account.id,
        employeeId: employees.T3!,
        employmentAssignmentId: assignments.T3!,
        leaveTypeId: vacation.id,
        entryType,
        amountMinutes,
        effectiveDate: d(effectiveDate),
        sourceType: entryType === 'GRANT' ? 'MANUAL' : 'LEAVE_REQUEST',
        idempotencyKey: `${fx.suffix}-${entryType}-${effectiveDate}`,
        leaveRequestId: usage?.requestId ?? null,
        leaveRequestDayId: usage?.dayId ?? null,
      },
    });
  await ledger('GRANT', 4800, '2026-01-01');
  await ledger('GRANT', 600, '2026-12-01');
  const request = await tx.leaveRequest.create({
    data: {
      employeeId: employees.T3!,
      employmentAssignmentId: assignments.T3!,
      leaveTypeId: vacation.id,
      accountId: account.id,
      status: 'APPROVED',
      startDate: d('2026-03-09'),
      endDate: d('2026-03-10'),
      timezone: 'America/Toronto',
      requestedMinutes: 960,
      approvedMinutes: 960,
      requestedByUserId: creator,
      decidedByUserId: creator,
      decidedAt: at('2026-02-21T15:00:00Z'),
      submittedAt: at('2026-02-20T15:00:00Z'),
    },
  });
  for (const date of ['2026-03-09', '2026-03-10']) {
    const day = await tx.leaveRequestDay.create({
      data: {
        requestId: request.id,
        date: d(date),
        minutes: 480,
        amountSource: 'STANDARD_DAY',
        windowStart: at(`${date}T13:00:00Z`),
        windowEnd: at(`${date}T21:00:00Z`),
        absenceStart: at(`${date}T13:00:00Z`),
        absenceEnd: at(`${date}T21:00:00Z`),
      },
    });
    await ledger('USAGE', -480, date, { requestId: request.id, dayId: day.id });
  }
  const bAccount = await tx.leaveAccount.create({
    data: {
      employeeId: employees.B1!,
      employmentAssignmentId: assignments.B1!,
      leaveTypeId: vacation.id,
    },
  });
  await tx.leaveRequest.create({
    data: {
      employeeId: employees.B1!,
      employmentAssignmentId: assignments.B1!,
      leaveTypeId: vacation.id,
      accountId: bAccount.id,
      status: 'PENDING',
      startDate: d('2026-04-06'),
      endDate: d('2026-04-06'),
      timezone: 'America/Toronto',
      requestedMinutes: 480,
      requestedByUserId: creator,
      submittedAt: at('2026-03-20T15:00:00Z'),
    },
  });

  await tx.$executeRawUnsafe('SET LOCAL session_replication_role = origin');
  return {
    employees,
    assignments,
    positionDeptA,
    positionOrgB,
    openings,
    cycleId: cycle.id,
  };
}
