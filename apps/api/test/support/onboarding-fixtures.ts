import { AuditService } from '../../src/audit/audit.service.js';
import type { DocumentAcknowledgementContract } from '../../src/documents/document-storage.contract.js';
import { AuthorizationService } from '../../src/authorization/authorization.service.js';
import type { PrismaService } from '../../src/database/prisma.service.js';
import { OnboardingAccessService } from '../../src/onboarding/onboarding-access.service.js';
import { OnboardingClock } from '../../src/onboarding/onboarding-common.js';
import { OnboardingTaskService } from '../../src/onboarding/onboarding-task.service.js';
import { OnboardingTemplateService } from '../../src/onboarding/onboarding-template.service.js';
import { OnboardingWorkflowService } from '../../src/onboarding/onboarding-workflow.service.js';
import {
  ctx,
  type SchedulingFixtures,
  type Tx,
  type UserSpec,
} from './scheduling-fixtures.js';

export const ONBOARDING_PERMISSION_KEYS = [
  'onboarding.read',
  'onboarding.manage',
  'offboarding.read',
  'offboarding.manage',
  'onboarding.template.manage',
] as const;

/** Users of onboarding specs: workflow access is never implied by HR, recruitment or a reporting line. */
export const ONBOARDING_USERS: Record<string, UserSpec[]> = {
  templateAdmin: [
    { permissions: ['onboarding.template.manage'], scope: 'org' },
  ],
  onboardingHr: [
    { permissions: ['onboarding.read', 'onboarding.manage'], scope: 'org' },
  ],
  offboardingHr: [
    { permissions: ['offboarding.read', 'offboarding.manage'], scope: 'org' },
  ],
  onboardingReader: [{ permissions: ['onboarding.read'], scope: 'org' }],
  teamOnboarding: [
    { permissions: ['onboarding.read', 'onboarding.manage'], scope: 'teamA' },
  ],
  deptBOnboarding: [
    { permissions: ['onboarding.read', 'onboarding.manage'], scope: 'deptB' },
  ],
  teamTemplate: [
    { permissions: ['onboarding.template.manage'], scope: 'teamA' },
  ],
  hr: [
    {
      permissions: [
        'employee.read',
        'employee.manage',
        'recruitment.read',
        'recruitment.manage',
        'recruitment.hire',
        'performance.read',
        'compensation.manage',
      ],
      scope: 'org',
    },
  ],
  orgBAdmin: [{ permissions: ONBOARDING_PERMISSION_KEYS, scope: 'orgB' }],
  /** An IT/facilities user with no permissions: owns specific-user tasks only. */
  // Works in Org A without any permission (a role with none): may own onboarding tasks.
  itDesk: [{ permissions: [], scope: 'org' }],
  /** Employee 1's own account with full onboarding rights: never manages their own workflow. */
  self1: [{ permissions: ONBOARDING_PERMISSION_KEYS, scope: 'org' }],
};

export class FixedOnboardingClock extends OnboardingClock {
  value = new Date('2026-03-15T16:00:00.000Z');

  override now() {
    return this.value;
  }
}

export function onboardingServices(
  prisma: PrismaService,
  clock: OnboardingClock,
  documents?: DocumentAcknowledgementContract,
) {
  const authorization = new AuthorizationService(prisma);
  const access = new OnboardingAccessService(prisma, authorization);
  const audit = new AuditService(prisma);
  const templates = new OnboardingTemplateService(prisma, access, audit, clock);
  const workflows = new OnboardingWorkflowService(prisma, access, audit, clock);
  const tasks = new OnboardingTaskService(
    prisma,
    access,
    audit,
    clock,
    workflows,
    documents,
  );
  return { access, templates, workflows, tasks };
}

export type OnboardingServices = ReturnType<typeof onboardingServices>;

/** Employee 2's team-A assignment manages employee 1's team-A assignment. */
export async function withManager(tx: Tx, fx: SchedulingFixtures) {
  await tx.employmentAssignment.update({
    where: { id: fx.assignmentTeamA },
    data: { managerAssignmentId: fx.otherTeamA },
  });
}

export const onboardingTasks = (fx: SchedulingFixtures) => [
  {
    title: 'Sign employment paperwork',
    category: 'PAPERWORK' as const,
    ownerType: 'EMPLOYEE' as const,
    dueOffsetDays: -3,
    evidenceRequired: true,
  },
  {
    title: 'Acknowledge the Staff Handbook',
    category: 'POLICY' as const,
    ownerType: 'EMPLOYEE' as const,
    dueOffsetDays: 5,
    acknowledgementRequired: true,
    acknowledgementStatement:
      'I have received and read the Staff Handbook 2026.',
    referenceType: 'GOOGLE_DOC' as const,
    referenceUrl: 'https://docs.google.com/document/d/handbook-2026',
    referenceExternalId: 'handbook-2026',
    referenceLabel: 'Staff Handbook 2026',
  },
  {
    title: 'Complete the Code of Conduct form',
    category: 'TRAINING' as const,
    ownerType: 'EMPLOYEE' as const,
    dueOffsetDays: 7,
    referenceType: 'GOOGLE_FORM' as const,
    referenceExternalId: 'coc-form-1',
    referenceUrl: 'https://docs.google.com/forms/d/coc-form-1',
  },
  {
    title: 'Supervisor welcome meeting',
    category: 'MEETING' as const,
    ownerType: 'MANAGER' as const,
    dueOffsetDays: 1,
  },
  {
    title: 'Set up accounts',
    category: 'ACCOUNT_ACCESS' as const,
    ownerType: 'SPECIFIC_USER' as const,
    ownerUserId: fx.users.itDesk!,
    dueOffsetDays: -1,
    systemAction: 'PROVISION_HRMS_ACCOUNT' as const,
  },
  {
    title: 'Payroll information',
    category: 'PAYROLL' as const,
    ownerType: 'HR' as const,
    dueOffsetDays: 0,
    required: false,
  },
];

/** An active ONBOARDING template (the default) with the tasks above. */
export async function activeTemplate(
  svc: OnboardingServices,
  fx: SchedulingFixtures,
  options: {
    kind?: 'ONBOARDING' | 'OFFBOARDING';
    code?: string;
    tasks?: ReturnType<typeof onboardingTasks>;
    makeDefault?: boolean;
  } = {},
) {
  const admin = ctx(fx.users.templateAdmin!);
  const template = await svc.templates.create(
    {
      organizationId: fx.orgA,
      kind: options.kind ?? 'ONBOARDING',
      code: options.code ?? 'TEACHER-ONBOARDING',
      name:
        options.kind === 'OFFBOARDING'
          ? 'Staff offboarding'
          : 'Teacher onboarding',
      tasks: options.tasks ?? onboardingTasks(fx),
    },
    admin,
  );
  await svc.templates.activate(template.id, admin);
  return options.makeDefault === false
    ? template
    : svc.templates.setDefault(template.id, admin);
}

export const offboardingTasks = (fx: SchedulingFixtures) => [
  {
    title: 'Return laptop and keys',
    category: 'EQUIPMENT' as const,
    ownerType: 'EMPLOYEE' as const,
    dueOffsetDays: 0,
    systemAction: 'COLLECT_EQUIPMENT' as const,
  },
  {
    title: 'Disable HRMS and Google accounts',
    category: 'ACCOUNT_ACCESS' as const,
    ownerType: 'SPECIFIC_USER' as const,
    ownerUserId: fx.users.itDesk!,
    dueOffsetDays: 1,
    systemAction: 'DISABLE_EXTERNAL_ACCOUNT' as const,
  },
  {
    title: 'Exit interview',
    category: 'MEETING' as const,
    ownerType: 'HR' as const,
    dueOffsetDays: -2,
  },
  {
    title: 'Final payroll review',
    category: 'PAYROLL' as const,
    ownerType: 'HR' as const,
    dueOffsetDays: 3,
    evidenceRequired: true,
  },
];
