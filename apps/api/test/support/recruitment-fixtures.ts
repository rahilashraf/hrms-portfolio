import { AuditService } from '../../src/audit/audit.service.js';
import { AuthorizationService } from '../../src/authorization/authorization.service.js';
import { PositionAuthorizationTargetResolver } from '../../src/authorization/position-authorization-target.resolver.js';
import { CompensationAccessService } from '../../src/compensation/compensation-access.service.js';
import { CompensationService } from '../../src/compensation/compensation.service.js';
import type { PrismaService } from '../../src/database/prisma.service.js';
import { EmployeeAccessService } from '../../src/employee/employee-access.service.js';
import { EmployeeDomainService } from '../../src/employee/employee-domain.service.js';
import { RecruitmentAccessService } from '../../src/recruitment/recruitment-access.service.js';
import { RecruitmentApplicationService } from '../../src/recruitment/recruitment-application.service.js';
import { RecruitmentCandidateService } from '../../src/recruitment/recruitment-candidate.service.js';
import { RecruitmentClock } from '../../src/recruitment/recruitment-common.js';
import { RecruitmentDashboardService } from '../../src/recruitment/recruitment-dashboard.service.js';
import { RecruitmentHireService } from '../../src/recruitment/recruitment-hire.service.js';
import { RecruitmentIntakeService } from '../../src/recruitment/recruitment-intake.service.js';
import { RecruitmentInterviewService } from '../../src/recruitment/recruitment-interview.service.js';
import { RecruitmentOfferService } from '../../src/recruitment/recruitment-offer.service.js';
import { RecruitmentOpeningService } from '../../src/recruitment/recruitment-opening.service.js';
import { RecruitmentStageService } from '../../src/recruitment/recruitment-stage.service.js';
import {
  ctx,
  type SchedulingFixtures,
  type Tx,
  type UserSpec,
} from './scheduling-fixtures.js';

export const RECRUITMENT_PERMISSION_KEYS = [
  'recruitment.read',
  'recruitment.manage',
  'recruitment.offer.approve',
  'recruitment.hire',
  'recruitment.pipeline.manage',
  'recruitment.intake.manage',
] as const;

/** Users of recruitment specs: recruitment access is never implied by HR, pay or performance. */
export const RECRUITMENT_USERS: Record<string, UserSpec[]> = {
  recruiter: [
    { permissions: ['recruitment.read', 'recruitment.manage'], scope: 'org' },
  ],
  reader: [{ permissions: ['recruitment.read'], scope: 'org' }],
  approver: [
    {
      permissions: ['recruitment.read', 'recruitment.offer.approve'],
      scope: 'org',
    },
  ],
  hiringAdmin: [
    { permissions: RECRUITMENT_PERMISSION_KEYS, scope: 'org' },
    {
      permissions: [
        'employee.read',
        'employee.manage',
        'compensation.read',
        'compensation.manage',
      ],
      scope: 'org',
    },
  ],
  hirerWithoutCoreHr: [
    { permissions: RECRUITMENT_PERMISSION_KEYS, scope: 'org' },
  ],
  teamRecruiter: [
    { permissions: ['recruitment.read', 'recruitment.manage'], scope: 'teamA' },
  ],
  deptBReader: [{ permissions: ['recruitment.read'], scope: 'deptB' }],
  pipelineAdmin: [
    { permissions: ['recruitment.pipeline.manage'], scope: 'org' },
  ],
  intakeAdmin: [{ permissions: ['recruitment.intake.manage'], scope: 'org' }],
  teamPipeline: [
    {
      permissions: ['recruitment.pipeline.manage', 'recruitment.intake.manage'],
      scope: 'teamA',
    },
  ],
  hr: [
    {
      permissions: [
        'employee.read',
        'employee.manage',
        'compensation.read',
        'compensation.manage',
        'performance.read',
        'performance.manage',
        'benefit.read',
        'payroll.read',
      ],
      scope: 'org',
    },
  ],
  orgBAdmin: [{ permissions: RECRUITMENT_PERMISSION_KEYS, scope: 'orgB' }],
  /** Employee 1's own account with full recruitment rights: never reaches their own candidacy. */
  self1: [
    { permissions: RECRUITMENT_PERMISSION_KEYS, scope: 'org' },
    { permissions: ['employee.read', 'employee.manage'], scope: 'org' },
  ],
};

export class FixedRecruitmentClock extends RecruitmentClock {
  value = new Date('2026-03-15T16:00:00.000Z');

  override now() {
    return this.value;
  }
}

export function recruitmentServices(
  prisma: PrismaService,
  clock: RecruitmentClock,
) {
  const authorization = new AuthorizationService(prisma);
  const access = new RecruitmentAccessService(prisma, authorization);
  const audit = new AuditService(prisma);
  const stages = new RecruitmentStageService(prisma, access, audit, clock);
  const openings = new RecruitmentOpeningService(
    prisma,
    access,
    audit,
    clock,
    stages,
  );
  const candidates = new RecruitmentCandidateService(
    prisma,
    access,
    audit,
    clock,
  );
  const applications = new RecruitmentApplicationService(
    prisma,
    access,
    audit,
    clock,
    candidates,
    stages,
  );
  const interviews = new RecruitmentInterviewService(
    prisma,
    access,
    audit,
    clock,
    applications,
  );
  const offers = new RecruitmentOfferService(
    prisma,
    audit,
    clock,
    applications,
  );
  const compensation = new CompensationService(
    prisma,
    new CompensationAccessService(prisma, authorization),
    audit,
  );
  const hires = new RecruitmentHireService(
    prisma,
    audit,
    clock,
    applications,
    new EmployeeDomainService(prisma, audit),
    new EmployeeAccessService(
      prisma,
      authorization,
      new PositionAuthorizationTargetResolver(prisma),
    ),
    compensation,
  );
  const intake = new RecruitmentIntakeService(
    prisma,
    access,
    audit,
    clock,
    candidates,
    applications,
  );
  const dashboard = new RecruitmentDashboardService(prisma, access, clock);
  return {
    access,
    stages,
    openings,
    candidates,
    applications,
    interviews,
    offers,
    hires,
    intake,
    dashboard,
    compensation,
  };
}

export type RecruitmentServices = ReturnType<typeof recruitmentServices>;

export const openingInput = (
  fx: SchedulingFixtures,
  overrides: Record<string, unknown> = {},
) => ({
  organizationId: fx.orgA,
  code: 'REQ-TEACH-1',
  title: 'Grade 3 Teacher',
  employmentType: 'FULL_TIME' as const,
  positionId: fx.positionOrg,
  openingCount: 1,
  ...overrides,
});

/** A created and opened opening (by the hiring admin). */
export async function openOpening(
  svc: RecruitmentServices,
  fx: SchedulingFixtures,
  overrides: Record<string, unknown> = {},
) {
  const admin = ctx(fx.users.hiringAdmin!);
  const opening = await svc.openings.create(openingInput(fx, overrides), admin);
  return svc.openings.transition(opening.id, 'open', null, admin);
}

export const candidateDetails = (overrides: Record<string, unknown> = {}) => ({
  firstName: 'Ada',
  lastName: 'Lovelace',
  email: 'ada.candidate@example.com',
  phone: '+1 555 0100',
  ...overrides,
});

/** An open opening, an application to it and its accepted offer on a free position. */
export async function acceptedOffer(
  svc: RecruitmentServices,
  fx: SchedulingFixtures,
  options: {
    positionId: string;
    openingOverrides?: Record<string, unknown>;
    candidate?: Record<string, unknown>;
    startDate?: string;
    openingId?: string;
  },
) {
  const admin = ctx(fx.users.hiringAdmin!);
  const openingId =
    options.openingId ??
    (
      await openOpening(svc, fx, {
        positionId: options.positionId,
        ...options.openingOverrides,
      })
    ).id;
  const application = await svc.applications.create(
    { openingId, candidate: candidateDetails(options.candidate) },
    admin,
  );
  const offer = await svc.offers.create(
    application.id,
    {
      positionId: options.positionId,
      employmentType: 'FULL_TIME',
      startDate: options.startDate ?? '2026-04-01',
      payBasis: 'SALARY',
      rateAmount: '62000.00',
      currency: 'CAD',
      expiresOn: '2026-03-25',
      candidateTerms: 'Full-time Grade 3 teacher.',
    },
    admin,
  );
  for (const action of ['approve', 'send', 'accept'] as const) {
    await svc.offers.act(offer.id, action, null, admin);
  }
  return {
    openingId,
    applicationId: application.id,
    candidateId: application.candidateId,
    offerId: offer.id,
  };
}

/** A vacant position of organization A (optionally on Team A) for hires. */
export async function vacantPosition(
  tx: Tx,
  fx: SchedulingFixtures,
  options: { team?: boolean; code?: string } = {},
) {
  const jobTitle = await tx.jobTitle.findFirstOrThrow({
    where: { organizationId: fx.orgA },
  });
  const position = await tx.position.create({
    data: {
      organizationId: fx.orgA,
      jobTitleId: jobTitle.id,
      name: 'Vacant teacher position',
      code:
        options.code ??
        `VAC-${Math.random().toString(36).slice(2, 10).toUpperCase()}`,
      ...(options.team
        ? {
            organizationalUnitId: fx.unitChild,
            departmentId: fx.deptA,
            teamId: fx.teamA,
          }
        : {}),
    },
  });
  return position.id;
}

type ApplicationDetail = Awaited<
  ReturnType<RecruitmentApplicationService['detail']>
>;
/** The FULL view of an application (typed: the union narrowed for assertions). */
export type FullApplicationDetail = Extract<
  ApplicationDetail,
  { screening: unknown }
>;

export async function detailOf(
  svc: RecruitmentServices,
  userId: string,
  applicationId: string,
) {
  return (await svc.applications.detail(
    userId,
    applicationId,
  )) as FullApplicationDetail;
}
