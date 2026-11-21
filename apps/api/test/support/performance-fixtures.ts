import type { HttpException } from '@nestjs/common';
import { AuditService } from '../../src/audit/audit.service.js';
import { AuthorizationService } from '../../src/authorization/authorization.service.js';
import type { PrismaService } from '../../src/database/prisma.service.js';
import { PerformanceAccessService } from '../../src/performance/performance-access.service.js';
import { PerformanceClock } from '../../src/performance/performance-common.js';
import { PerformanceConfigService } from '../../src/performance/performance-config.service.js';
import { PerformanceCycleService } from '../../src/performance/performance-cycle.service.js';
import { PerformanceEvidenceService } from '../../src/performance/performance-evidence.service.js';
import { PerformanceGoalService } from '../../src/performance/performance-goal.service.js';
import { PerformanceHistoryService } from '../../src/performance/performance-history.service.js';
import { PerformanceReviewLifecycleService } from '../../src/performance/performance-review-lifecycle.service.js';
import { PerformanceReviewService } from '../../src/performance/performance-review.service.js';
import { d } from './payroll-fixtures.js';
import {
  ctx,
  rejection,
  type SchedulingFixtures,
  type Tx,
  type UserSpec,
} from './scheduling-fixtures.js';

/** Raw rows for performance database specs (no services). */

export async function ratingScale(
  tx: Tx,
  fx: SchedulingFixtures,
  options: { code?: string; activate?: boolean; organizationId?: string } = {},
) {
  const scale = await tx.performanceRatingScale.create({
    data: {
      organizationId: options.organizationId ?? fx.orgA,
      code: options.code ?? 'FIVE',
      name: 'Five point',
    },
  });
  for (const [value, label] of [
    [1, 'Needs Improvement'],
    [2, 'Developing'],
    [3, 'Meets Expectations'],
    [4, 'Exceeds Expectations'],
    [5, 'Exceptional'],
  ] as const) {
    await tx.performanceRatingScaleLevel.create({
      data: { scaleId: scale.id, value, label },
    });
  }
  if (options.activate === false) return scale;
  return tx.performanceRatingScale.update({
    where: { id: scale.id },
    data: { status: 'ACTIVE', activatedAt: new Date() },
  });
}

/** An active template: one section with a reviewer RATING item and a BOTH TEXT item. */
export async function template(
  tx: Tx,
  fx: SchedulingFixtures,
  scaleId: string,
  options: { code?: string; activate?: boolean } = {},
) {
  const row = await tx.performanceTemplate.create({
    data: {
      organizationId: fx.orgA,
      code: options.code ?? 'ANNUAL',
      name: 'Annual review',
      ratingScaleId: scaleId,
      overallRatingEnabled: true,
    },
  });
  const section = await tx.performanceTemplateSection.create({
    data: { templateId: row.id, title: 'Competencies', sortOrder: 1 },
  });
  const ratingItem = await tx.performanceTemplateItem.create({
    data: {
      templateId: row.id,
      sectionId: section.id,
      organizationId: fx.orgA,
      sortOrder: 1,
      itemType: 'RATING',
      prompt: 'Communication',
      respondent: 'REVIEWER',
      required: true,
      ratingScaleId: scaleId,
    },
  });
  const textItem = await tx.performanceTemplateItem.create({
    data: {
      templateId: row.id,
      sectionId: section.id,
      organizationId: fx.orgA,
      sortOrder: 2,
      itemType: 'TEXT',
      prompt: 'Highlights',
      respondent: 'BOTH',
    },
  });
  if (options.activate === false)
    return { template: row, section, ratingItem, textItem };
  const active = await tx.performanceTemplate.update({
    where: { id: row.id },
    data: { status: 'ACTIVE', activatedAt: new Date() },
  });
  return { template: active, section, ratingItem, textItem };
}

export function cycle(
  tx: Tx,
  fx: SchedulingFixtures,
  templateId: string,
  code = 'ANNUAL-2026',
) {
  return tx.performanceCycle.create({
    data: {
      organizationId: fx.orgA,
      code,
      name: 'Annual 2026',
      templateId,
      periodStart: d('2026-01-01'),
      periodEnd: d('2026-12-31'),
      windowStart: d('2026-11-01'),
      windowEnd: d('2026-12-15'),
    },
  });
}

/** Snapshots a form (one section, a RATING and a TEXT item) and opens the cycle. */
export async function openCycle(tx: Tx, cycleId: string) {
  const section = await tx.performanceFormSection.create({
    data: { cycleId, sortOrder: 1, title: 'Competencies' },
  });
  const ratingItem = await tx.performanceFormItem.create({
    data: {
      cycleId,
      sectionId: section.id,
      sortOrder: 1,
      itemType: 'RATING',
      prompt: 'Communication',
      respondent: 'REVIEWER',
      required: true,
      scaleLevels: [
        { value: 1, label: 'Low', description: null },
        { value: 5, label: 'High', description: null },
      ],
    },
  });
  const textItem = await tx.performanceFormItem.create({
    data: {
      cycleId,
      sectionId: section.id,
      sortOrder: 2,
      itemType: 'TEXT',
      prompt: 'Highlights',
      respondent: 'BOTH',
      required: false,
    },
  });
  const evidenceItem = await tx.performanceFormItem.create({
    data: {
      cycleId,
      sectionId: section.id,
      sortOrder: 3,
      itemType: 'EVIDENCE_REFERENCE',
      prompt: 'Training evidence',
      respondent: 'REVIEWER',
      required: false,
    },
  });
  const opened = await tx.performanceCycle.update({
    where: { id: cycleId },
    data: {
      status: 'OPEN',
      openedAt: new Date(),
      scoringMode: 'NONE',
      overallRatingEnabled: false,
    },
  });
  return { cycle: opened, section, ratingItem, textItem, evidenceItem };
}

export function review(
  tx: Tx,
  fx: SchedulingFixtures,
  cycleId: string,
  overrides: Partial<{
    employeeId: string;
    assignmentId: string;
    reviewerEmployeeId: string | null;
  }> = {},
) {
  const reviewer =
    overrides.reviewerEmployeeId === undefined
      ? fx.employee2
      : overrides.reviewerEmployeeId;
  return tx.performanceReview.create({
    data: {
      cycleId,
      organizationId: fx.orgA,
      employeeId: overrides.employeeId ?? fx.employee1,
      employmentAssignmentId: overrides.assignmentId ?? fx.assignmentTeamA,
      selfStatus: 'NOT_STARTED',
      reviewerEmployeeId: reviewer,
      reviewerSource: reviewer ? 'ASSIGNED' : null,
    },
  });
}

/** Employee 2 also works in organization B (for cross-organization checks). */
export async function orgBAssignment(tx: Tx, fx: SchedulingFixtures) {
  const jobTitle = await tx.jobTitle.create({
    data: { organizationId: fx.orgB, name: 'B title', code: `JB-${fx.suffix}` },
  });
  const position = await tx.position.create({
    data: {
      organizationId: fx.orgB,
      jobTitleId: jobTitle.id,
      name: 'B position',
      code: `PB-${fx.suffix}`,
    },
  });
  const assignment = await tx.employmentAssignment.create({
    data: {
      employeeId: fx.employee2,
      positionId: position.id,
      employmentType: 'FULL_TIME',
      status: 'ACTIVE',
      isPrimary: false,
      startDate: d('2026-01-01'),
    },
  });
  return assignment.id;
}

export function evidence(
  tx: Tx,
  fx: SchedulingFixtures,
  overrides: Partial<{
    organizationId: string;
    employeeId: string;
    assignmentId: string | null;
    externalResultId: string | null;
    score: string;
  }> = {},
) {
  const externalResultId =
    overrides.externalResultId === undefined
      ? 'response-1'
      : overrides.externalResultId;
  return tx.performanceEvidence.create({
    data: {
      organizationId: overrides.organizationId ?? fx.orgA,
      employeeId: overrides.employeeId ?? fx.employee1,
      employmentAssignmentId:
        overrides.assignmentId === undefined ? null : overrides.assignmentId,
      provider: 'GOOGLE_FORMS',
      kind: 'ASSESSMENT',
      channel: 'IMPORT',
      title: 'Code of Conduct quiz',
      externalResourceId: externalResultId ? 'form-1' : null,
      externalResultId,
      completedAt: new Date('2026-09-01T10:00:00Z'),
      score: overrides.score ?? '17',
      maxScore: '20',
      percentage: '85',
      passed: true,
    },
  });
}

// ─── Services ────────────────────────────────────────────────────────────────

export const PERFORMANCE_PERMISSION_KEYS = [
  'performance.read',
  'performance.manage',
  'performance.template.manage',
  'performance.cycle.manage',
  'performance.evidence.manage',
] as const;

/** Users of performance specs: performance access is never implied by HR, payroll or benefits. */
export const PERFORMANCE_USERS: Record<string, UserSpec[]> = {
  templateAdmin: [
    { permissions: ['performance.template.manage'], scope: 'org' },
  ],
  cycleAdmin: [{ permissions: ['performance.cycle.manage'], scope: 'org' }],
  evidenceAdmin: [
    { permissions: ['performance.evidence.manage'], scope: 'org' },
  ],
  hrAdmin: [{ permissions: PERFORMANCE_PERMISSION_KEYS, scope: 'org' }],
  reader: [{ permissions: ['performance.read'], scope: 'org' }],
  teamManager: [
    { permissions: ['performance.read', 'performance.manage'], scope: 'teamA' },
  ],
  teamTemplate: [
    { permissions: ['performance.template.manage'], scope: 'teamA' },
  ],
  hr: [
    {
      permissions: [
        'employee.read',
        'employee.manage',
        'compensation.read',
        'compensation.manage',
        'payroll.read',
        'benefit.read',
        'benefit.manage',
      ],
      scope: 'org',
    },
  ],
  orgBAdmin: [{ permissions: PERFORMANCE_PERMISSION_KEYS, scope: 'orgB' }],
};

export class FixedPerformanceClock extends PerformanceClock {
  value = new Date('2026-11-15T16:00:00.000Z');

  override now() {
    return this.value;
  }
}

export function performanceServices(
  prisma: PrismaService,
  clock: PerformanceClock,
) {
  const authorization = new AuthorizationService(prisma);
  const access = new PerformanceAccessService(prisma, authorization);
  const audit = new AuditService(prisma);
  const config = new PerformanceConfigService(prisma, access, audit);
  const cycles = new PerformanceCycleService(prisma, access, audit, clock);
  const reviews = new PerformanceReviewService(prisma, access, audit, clock);
  const goals = new PerformanceGoalService(prisma, access, audit, clock);
  const evidence = new PerformanceEvidenceService(prisma, access, audit, clock);
  const lifecycle = new PerformanceReviewLifecycleService(
    prisma,
    access,
    audit,
    clock,
    reviews,
  );
  const history = new PerformanceHistoryService(prisma, access, clock);
  return {
    lifecycle,
    history,
    authorization,
    access,
    audit,
    clock,
    config,
    cycles,
    reviews,
    goals,
    evidence,
  };
}

export type PerformanceServices = ReturnType<typeof performanceServices>;

/** An active five-point scale and an active weighted template (60/40) with self items. */
export async function activeTemplate(
  svc: PerformanceServices,
  fx: SchedulingFixtures,
  options: { code?: string; scoringMode?: 'NONE' | 'WEIGHTED_AVERAGE' } = {},
) {
  const admin = ctx(fx.users.templateAdmin!);
  const scale = await svc.config.createScale(
    {
      organizationId: fx.orgA,
      code: `${options.code ?? 'ANNUAL'}-SCALE`,
      name: 'Five point',
      levels: [
        { value: 1, label: 'Needs Improvement', description: null },
        { value: 2, label: 'Developing', description: null },
        { value: 3, label: 'Meets Expectations', description: null },
        { value: 4, label: 'Exceeds Expectations', description: null },
        { value: 5, label: 'Exceptional', description: null },
      ],
    },
    admin,
  );
  await svc.config.transitionScale(scale.id, 'ACTIVE', admin);
  const competency = await svc.config.createCompetency(
    {
      organizationId: fx.orgA,
      code: `${options.code ?? 'ANNUAL'}-COMM`,
      name: 'Communication',
    },
    admin,
  );
  const weighted =
    (options.scoringMode ?? 'WEIGHTED_AVERAGE') === 'WEIGHTED_AVERAGE';
  const template = await svc.config.createTemplate(
    {
      organizationId: fx.orgA,
      code: options.code ?? 'ANNUAL',
      name: 'Annual review',
      scoringMode: weighted ? 'WEIGHTED_AVERAGE' : 'NONE',
      ratingScaleId: scale.id,
      overallRatingEnabled: true,
      sections: [
        {
          title: 'Competencies',
          items: [
            {
              itemType: 'RATING',
              prompt: 'Communication',
              respondent: 'BOTH',
              required: true,
              weight: weighted ? '60' : null,
              competencyId: competency.id,
            },
            {
              itemType: 'RATING',
              prompt: 'Reliability',
              respondent: 'REVIEWER',
              weight: weighted ? '40' : null,
            },
          ],
        },
        {
          title: 'Reflection',
          items: [
            {
              itemType: 'TEXT',
              prompt: 'Highlights',
              respondent: 'BOTH',
              required: true,
            },
            {
              itemType: 'YES_NO',
              prompt: 'Completed training?',
              respondent: 'SELF',
            },
            {
              itemType: 'GOAL_PROGRESS',
              prompt: 'Goal progress',
              respondent: 'REVIEWER',
            },
            {
              itemType: 'EVIDENCE_REFERENCE',
              prompt: 'Assessments',
              respondent: 'REVIEWER',
            },
          ],
        },
      ],
    },
    admin,
  );
  await svc.config.transitionTemplate(template.id, 'ACTIVE', admin);
  return { admin, scale, competency, template };
}

/** Status and domain code of an expected service failure. */
export async function failure(promise: Promise<unknown>) {
  const error = (await rejection(promise)) as HttpException;
  const body = error.getResponse?.() as { code?: string } | undefined;
  return { status: error.getStatus?.(), code: body?.code };
}

/** A cycle for 2026 (window 2026-11-01 – 12-15, self due 11-10, reviewer due 12-01). */
export const cycleInput = (
  fx: SchedulingFixtures,
  templateId: string,
  overrides = {},
) => ({
  organizationId: fx.orgA,
  code: 'annual-2026',
  name: 'Annual review 2026',
  templateId,
  periodStart: '2026-01-01',
  periodEnd: '2026-12-31',
  windowStart: '2026-11-01',
  windowEnd: '2026-12-15',
  selfReviewDueDate: '2026-11-10',
  reviewerDueDate: '2026-12-01',
  ...overrides,
});

/**
 * An open weighted cycle reviewing Employee 1's Team A assignment, whose manager (and so
 * reviewer) is Employee 2. Self user: fx.selfUser1; reviewer user: fx.selfUser2.
 */
export async function openReview(
  tx: Tx,
  svc: PerformanceServices,
  fx: SchedulingFixtures,
  options: {
    scoringMode?: 'NONE' | 'WEIGHTED_AVERAGE';
    selfReviewEnabled?: boolean;
  } = {},
) {
  const configured = await activeTemplate(svc, fx, {
    scoringMode: options.scoringMode,
  });
  await tx.employmentAssignment.update({
    where: { id: fx.assignmentTeamA },
    data: { managerAssignmentId: fx.otherTeamA },
  });
  const admin = ctx(fx.users.cycleAdmin!);
  const cycle = await svc.cycles.create(
    cycleInput(fx, configured.template.id, {
      selfReviewEnabled: options.selfReviewEnabled ?? true,
    }),
    admin,
  );
  await svc.cycles.addReviews(
    cycle.id,
    { assignmentIds: [fx.assignmentTeamA] },
    admin,
  );
  await svc.cycles.open(cycle.id, admin);
  const review = await tx.performanceReview.findFirstOrThrow({
    where: { cycleId: cycle.id },
  });
  const items = await tx.performanceFormItem.findMany({
    where: { cycleId: cycle.id },
    orderBy: [{ section: { sortOrder: 'asc' } }, { sortOrder: 'asc' }],
  });
  const item = (prompt: string) =>
    items.find((row) => row.prompt === prompt)!.id;
  return {
    ...configured,
    cycle,
    review,
    items: {
      communication: item('Communication'),
      reliability: item('Reliability'),
      highlights: item('Highlights'),
      training: item('Completed training?'),
      goals: item('Goal progress'),
      evidence: item('Assessments'),
    },
    self: ctx(fx.selfUser1),
    reviewer: ctx(fx.selfUser2),
  };
}
