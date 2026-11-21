import { randomUUID } from 'node:crypto';
import { AuditService } from '../../src/audit/audit.service.js';
import { AuthorizationService } from '../../src/authorization/authorization.service.js';
import { PositionAuthorizationTargetResolver } from '../../src/authorization/position-authorization-target.resolver.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import type { Prisma } from '../../src/generated/prisma/client.js';
import { EmployeeSchedulePatternService } from '../../src/scheduling/employee-schedule-pattern.service.js';
import { SchedulePolicyResolver } from '../../src/scheduling/schedule-policy-resolver.js';
import { SchedulePolicyService } from '../../src/scheduling/schedule-policy.service.js';
import { ScheduleRuleSetService } from '../../src/scheduling/schedule-rule-set.service.js';
import { SchedulingDomainService } from '../../src/scheduling/scheduling-domain.service.js';
import { SchedulingService } from '../../src/scheduling/scheduling.service.js';
import { ShiftGenerationService } from '../../src/scheduling/shift-generation.service.js';

/**
 * Shared database fixtures for the Phase 7 Batch 7–10 specs: one organization with a nested unit
 * hierarchy (root → child), Dept A under the child unit, Team A under Dept A, a Dept B with no
 * unit, and a second organization. Employee 1 works on Team A and in Dept B; Employee 2 works on
 * Team A and in an organization-level position. Each Employee has a linked self-service User.
 */
export type Tx = Prisma.TransactionClient;

export const ALL_SCHEDULE_PERMISSIONS = [
  'schedule.read',
  'schedule.manage',
  'schedule.override_conflict',
  'schedule.publish',
  'schedule.manage_templates',
  'schedule.manage_patterns',
  'schedule.manage_policy',
] as const;

export type GrantScope =
  'org' | 'unitChild' | 'deptA' | 'deptB' | 'teamA' | 'orgB';

export interface UserSpec {
  permissions: readonly string[];
  scope: GrantScope;
}

export interface SchedulingFixtures {
  suffix: string;
  orgA: string;
  orgB: string;
  unitRoot: string;
  unitChild: string;
  deptA: string;
  deptB: string;
  teamA: string;
  positionTeamA: string;
  positionDeptB: string;
  positionOrg: string;
  employee1: string;
  employee2: string;
  /** Employee 1. */
  assignmentTeamA: string;
  assignmentDeptB: string;
  /** Employee 2. */
  otherTeamA: string;
  orgLevel: string;
  physicalSiteToronto: string;
  physicalSiteOttawa: string;
  workLocationToronto: string;
  workLocationOttawa: string;
  /** Linked self-service users of Employee 1 and Employee 2 (no grants unless requested). */
  selfUser1: string;
  selfUser2: string;
  users: Record<string, string>;
}

export function schedulingServices(prisma: PrismaService) {
  const domain = new SchedulingDomainService();
  const authorization = new AuthorizationService(prisma);
  const targets = new PositionAuthorizationTargetResolver(prisma);
  const audit = new AuditService(prisma);
  const policies = new SchedulePolicyResolver(prisma, targets);
  return {
    domain,
    authorization,
    targets,
    audit,
    policyResolver: policies,
    scheduling: new SchedulingService(
      prisma,
      domain,
      authorization,
      targets,
      audit,
      policies,
    ),
    patterns: new EmployeeSchedulePatternService(
      prisma,
      authorization,
      targets,
      domain,
      new ScheduleRuleSetService(domain),
      audit,
    ),
    generation: new ShiftGenerationService(
      prisma,
      authorization,
      targets,
      domain,
      audit,
      policies,
    ),
    policies: new SchedulePolicyService(
      prisma,
      domain,
      authorization,
      targets,
      policies,
      audit,
    ),
  };
}

export const ctx = (actorUserId: string, correlationId = 'phase7-db-spec') => ({
  actorUserId,
  ipAddress: '127.0.0.1',
  userAgent: 'vitest',
  correlationId,
});

/** Routes a service's own $transaction calls into the test transaction so it rolls back. */
export function rollbackClient(tx: Tx) {
  return new Proxy(tx, {
    get(target, property, receiver) {
      if (property === '$transaction') {
        return (run: (client: Tx) => Promise<unknown>) => run(tx);
      }
      return Reflect.get(target, property, receiver);
    },
  }) as unknown as PrismaService;
}

export async function rejection(promise: Promise<unknown>) {
  return promise.then(
    () => {
      throw new Error('Expected the operation to be rejected.');
    },
    (error: unknown) => error,
  );
}

/** Each violation runs in a savepoint so the scenario transaction stays usable. */
export async function violation(tx: Tx, run: () => Promise<unknown>) {
  await tx.$executeRawUnsafe('SAVEPOINT fixture_check');
  const error = await rejection(run());
  await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT fixture_check');
  return error;
}

/** Toronto shift input; EST (-05:00) before 2027-03-14, EDT (-04:00) from then. */
export function torontoShift(
  assignmentId: string,
  workDate: string,
  start: string,
  end: string,
  offset = '-05:00',
  endDate = workDate,
) {
  return {
    employmentAssignmentId: assignmentId,
    timezone: 'America/Toronto',
    workDate,
    startsAt: `${workDate}T${start}:00${offset}`,
    endsAt: `${endDate}T${end}:00${offset}`,
  };
}

export async function createSchedulingFixtures(
  tx: Tx,
  userSpecs: Record<string, UserSpec[]>,
  extraPermissions: readonly string[] = [],
  options: {
    /**
     * Explicit `startsAt` for the fixture's role grants. Without it they take the database
     * default (the real time of the run), so a spec that evaluates authorization at a fixed
     * instant must pass a value at or before that instant.
     */
    grantsStartAt?: Date;
  } = {},
): Promise<SchedulingFixtures> {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase();
  const code = (prefix: string) => `${prefix}-${suffix}`;
  const keys = [
    ...new Set([
      ...ALL_SCHEDULE_PERMISSIONS,
      ...extraPermissions,
      ...Object.values(userSpecs).flatMap((specs) =>
        specs.flatMap((spec) => spec.permissions),
      ),
    ]),
  ];
  const permissionIds = Object.fromEntries(
    await Promise.all(
      keys.map(async (key) => [
        key,
        (
          await tx.permission.upsert({
            where: { key },
            create: { key, name: key, isActive: true },
            update: { isActive: true },
          })
        ).id,
      ]),
    ),
  ) as Record<string, string>;

  const orgA = await tx.organization.create({
    data: { name: 'Phase 7 Org A', code: code('PA') },
  });
  const orgB = await tx.organization.create({
    data: { name: 'Phase 7 Org B', code: code('PB') },
  });
  const unitRoot = await tx.organizationalUnit.create({
    data: { organizationId: orgA.id, name: 'Root unit', code: code('UR') },
  });
  const unitChild = await tx.organizationalUnit.create({
    data: {
      organizationId: orgA.id,
      parentUnitId: unitRoot.id,
      name: 'Child unit',
      code: code('UC'),
    },
  });
  const deptA = await tx.department.create({
    data: {
      organizationId: orgA.id,
      organizationalUnitId: unitChild.id,
      name: 'Dept A',
      code: code('DA'),
    },
  });
  const deptB = await tx.department.create({
    data: { organizationId: orgA.id, name: 'Dept B', code: code('DB') },
  });
  const teamA = await tx.team.create({
    data: {
      organizationId: orgA.id,
      departmentId: deptA.id,
      name: 'Team A',
      code: code('TA'),
    },
  });
  const jobTitle = await tx.jobTitle.create({
    data: { organizationId: orgA.id, name: 'Associate', code: code('JA') },
  });
  const torontoSite = await tx.physicalSite.create({
    data: { organizationId: orgA.id, name: 'Toronto Site' },
  });
  const ottawaSite = await tx.physicalSite.create({
    data: { organizationId: orgA.id, name: 'Ottawa Site' },
  });
  const toronto = await tx.workLocation.create({
    data: {
      organizationId: orgA.id,
      physicalSiteId: torontoSite.id,
      name: 'Toronto',
      code: code('WTO'),
      timezone: 'America/Toronto',
    },
  });
  const ottawa = await tx.workLocation.create({
    data: {
      organizationId: orgA.id,
      physicalSiteId: ottawaSite.id,
      name: 'Ottawa',
      code: code('WOT'),
      timezone: 'America/Toronto',
    },
  });
  const position = (name: string, data: Record<string, string>) =>
    tx.position.create({
      data: {
        organizationId: orgA.id,
        jobTitleId: jobTitle.id,
        name,
        code: code(name.replaceAll(' ', '').toUpperCase().slice(0, 6)),
        ...data,
      },
    });
  const positionTeamA = await position('Team A Associate', {
    organizationalUnitId: unitChild.id,
    departmentId: deptA.id,
    teamId: teamA.id,
    // A WorkLocation is placement data only; it is never a policy parent.
    workLocationId: toronto.id,
  });
  const positionDeptB = await position('Dept B Associate', {
    departmentId: deptB.id,
  });
  const positionOrg = await position('Org Associate', {});

  const scopeGrant = (scope: GrantScope) => {
    switch (scope) {
      case 'org':
        return { scopeType: 'ORGANIZATION' as const, organizationId: orgA.id };
      case 'orgB':
        return { scopeType: 'ORGANIZATION' as const, organizationId: orgB.id };
      case 'unitChild':
        return {
          scopeType: 'ORGANIZATIONAL_UNIT' as const,
          organizationId: orgA.id,
          organizationalUnitId: unitChild.id,
        };
      case 'deptA':
        return {
          scopeType: 'DEPARTMENT' as const,
          organizationId: orgA.id,
          departmentId: deptA.id,
        };
      case 'deptB':
        return {
          scopeType: 'DEPARTMENT' as const,
          organizationId: orgA.id,
          departmentId: deptB.id,
        };
      case 'teamA':
        return {
          scopeType: 'TEAM' as const,
          organizationId: orgA.id,
          teamId: teamA.id,
        };
    }
  };
  const grant = async (userId: string, spec: UserSpec) => {
    const scope = scopeGrant(spec.scope);
    const role = await tx.role.create({
      data: {
        organizationId: scope.organizationId,
        code: code(`R${randomUUID().slice(0, 6)}`),
        name: 'Phase 7 role',
      },
    });
    for (const key of spec.permissions) {
      await tx.rolePermission.create({
        data: { roleId: role.id, permissionId: permissionIds[key]! },
      });
    }
    await tx.roleAssignment.create({
      data: {
        userId,
        roleId: role.id,
        roleOrganizationId: scope.organizationId,
        ...scope,
        ...(options.grantsStartAt ? { startsAt: options.grantsStartAt } : {}),
      },
    });
  };
  const user = async (label: string, personId?: string) => {
    const person = personId ?? (await tx.person.create({ data: {} })).id;
    return (
      await tx.user.create({
        data: {
          personId: person,
          email: `p7-${label}-${suffix.toLowerCase()}@example.com`,
          status: 'ACTIVE',
        },
      })
    ).id;
  };

  const employee = async (index: number) => {
    const person = await tx.person.create({
      data: { firstName: `Employee${index}`, lastName: suffix },
    });
    const row = await tx.employee.create({
      data: {
        personId: person.id,
        employeeNumber: code(`E${index}`),
        hireDate: new Date('2026-01-01T00:00:00.000Z'),
      },
    });
    return { id: row.id, personId: person.id };
  };
  const assignment = async (
    employeeId: string,
    positionId: string,
    isPrimary: boolean,
  ) =>
    (
      await tx.employmentAssignment.create({
        data: {
          employeeId,
          positionId,
          employmentType: isPrimary ? 'FULL_TIME' : 'PART_TIME',
          status: 'ACTIVE',
          isPrimary,
          startDate: new Date('2026-01-01T00:00:00.000Z'),
        },
      })
    ).id;
  const first = await employee(1);
  const second = await employee(2);

  const users: Record<string, string> = {};
  for (const [label, specs] of Object.entries(userSpecs)) {
    const id =
      label === 'self1'
        ? await user(label, first.personId)
        : label === 'self2'
          ? await user(label, second.personId)
          : await user(label);
    for (const spec of specs) await grant(id, spec);
    users[label] = id;
  }

  return {
    suffix,
    orgA: orgA.id,
    orgB: orgB.id,
    unitRoot: unitRoot.id,
    unitChild: unitChild.id,
    deptA: deptA.id,
    deptB: deptB.id,
    teamA: teamA.id,
    positionTeamA: positionTeamA.id,
    positionDeptB: positionDeptB.id,
    positionOrg: positionOrg.id,
    employee1: first.id,
    employee2: second.id,
    assignmentTeamA: await assignment(first.id, positionTeamA.id, true),
    assignmentDeptB: await assignment(first.id, positionDeptB.id, false),
    otherTeamA: await assignment(second.id, positionTeamA.id, true),
    orgLevel: await assignment(second.id, positionOrg.id, false),
    physicalSiteToronto: torontoSite.id,
    physicalSiteOttawa: ottawaSite.id,
    workLocationToronto: toronto.id,
    workLocationOttawa: ottawa.id,
    selfUser1: users.self1 ?? (await user('self1', first.personId)),
    selfUser2: users.self2 ?? (await user('self2', second.personId)),
    users,
  };
}

/** Removes committed fixtures and everything Phase 6–7 wrote for them, in foreign-key order. */
export async function cleanupSchedulingFixtures(
  prisma: PrismaService,
  fx: SchedulingFixtures,
) {
  const organizationIds = [fx.orgA, fx.orgB];
  const userIds = [...Object.values(fx.users), fx.selfUser1, fx.selfUser2];
  const employeeIds = [fx.employee1, fx.employee2];
  await prisma.$transaction(
    async (tx) => {
      // History tables (punches, leave, compensation, sign-ins, devices, credentials) are
      // undeletable by trigger. Test cleanup alone suspends triggers, for this transaction only
      // and without table locks (unlike ALTER TABLE ... DISABLE TRIGGER, which deadlocks with
      // concurrent spec files).
      await tx.$executeRawUnsafe(
        'SET LOCAL session_replication_role = replica',
      );
      const schedules = (
        await tx.schedule.findMany({
          where: { organizationId: { in: organizationIds } },
          select: { id: true },
        })
      ).map((row) => row.id);
      const shifts = (
        await tx.scheduledShift.findMany({
          where: { scheduleId: { in: schedules } },
          select: { id: true },
        })
      ).map((row) => row.id);
      const patterns = (
        await tx.employeeSchedulePattern.findMany({
          where: { employmentAssignment: { employeeId: { in: employeeIds } } },
          select: { id: true },
        })
      ).map((row) => row.id);
      const templates = (
        await tx.scheduleTemplate.findMany({
          where: { organizationId: { in: organizationIds } },
          select: { id: true },
        })
      ).map((row) => row.id);
      const policies = (
        await tx.schedulePolicy.findMany({
          where: { organizationId: { in: organizationIds } },
          select: { id: true },
        })
      ).map((row) => row.id);
      const entries = (
        await tx.timeEntry.findMany({
          where: { employeeId: { in: employeeIds } },
          select: { id: true },
        })
      ).map((row) => row.id);
      await tx.auditLog.deleteMany({
        where: {
          OR: [
            {
              entityId: {
                in: [
                  ...schedules,
                  ...shifts,
                  ...patterns,
                  ...templates,
                  ...policies,
                  ...entries,
                ],
              },
            },
            { actorUserId: { in: userIds } },
          ],
        },
      });
      // Feature management (Phase 18): change history, settings, module switches.
      const featureScope = { organizationId: { in: organizationIds } };
      await tx.organizationSettingChange.deleteMany({ where: featureScope });
      await tx.organizationSetting.deleteMany({ where: featureScope });
      await tx.organizationModuleSetting.deleteMany({ where: featureScope });
      // Branding (Phase 20).
      await tx.organizationBranding.deleteMany({ where: featureScope });
      // Google Workspace (Phase 16.5): runs, bindings, OAuth states, connections.
      const googleScope = { organizationId: { in: organizationIds } };
      await tx.googleSyncRun.deleteMany({ where: googleScope });
      await tx.googleFormBinding.deleteMany({ where: googleScope });
      await tx.googleOAuthState.deleteMany({ where: googleScope });
      await tx.googleWorkspaceConnection.deleteMany({ where: googleScope });
      // Notifications (Phase 16): attempts, deliveries, notifications, templates, settings.
      const notificationScope = {
        OR: [
          { organizationId: { in: organizationIds } },
          { notification: { recipientUserId: { in: userIds } } },
        ],
      };
      await tx.notificationDeliveryAttempt.deleteMany({
        where: { delivery: notificationScope },
      });
      await tx.notificationDelivery.deleteMany({ where: notificationScope });
      await tx.notification.deleteMany({
        where: {
          OR: [
            { organizationId: { in: organizationIds } },
            { recipientUserId: { in: userIds } },
          ],
        },
      });
      await tx.notificationTemplate.deleteMany({
        where: { organizationId: { in: organizationIds } },
      });
      await tx.organizationNotificationSetting.deleteMany({
        where: { organizationId: { in: organizationIds } },
      });
      await tx.organizationNotificationPolicy.deleteMany({
        where: { organizationId: { in: organizationIds } },
      });
      await tx.notificationPreference.deleteMany({
        where: { userId: { in: userIds } },
      });
      await tx.leaveLedgerEntry.deleteMany({
        where: { employeeId: { in: employeeIds } },
      });
      await tx.leaveRequestEvent.deleteMany({
        where: { request: { employeeId: { in: employeeIds } } },
      });
      await tx.leaveRequestDay.deleteMany({
        where: { request: { employeeId: { in: employeeIds } } },
      });
      await tx.leaveRequestAmendment.deleteMany({
        where: { request: { employeeId: { in: employeeIds } } },
      });
      await tx.leaveRequest.deleteMany({
        where: { employeeId: { in: employeeIds } },
      });
      await tx.leaveAccount.deleteMany({
        where: { employeeId: { in: employeeIds } },
      });
      // Documents (Phase 15): acknowledgements, versions, documents, policies, requirements, types.
      const documentOrg = { organizationId: { in: organizationIds } };
      await tx.employeeWorkflowTask.updateMany({
        where: documentOrg,
        data: { documentAcknowledgementId: null },
      });
      await tx.documentAcknowledgement.deleteMany({ where: documentOrg });
      await tx.employeeDocumentVersion.deleteMany({
        where: { document: documentOrg },
      });
      await tx.employeeDocument.deleteMany({ where: documentOrg });
      await tx.policyDocumentVersion.deleteMany({ where: documentOrg });
      await tx.policyDocument.deleteMany({ where: documentOrg });
      await tx.documentRequirement.deleteMany({ where: documentOrg });
      await tx.documentType.deleteMany({ where: documentOrg });
      // Onboarding & offboarding (Phase 14): workflows, their tasks and events; templates.
      const workflowOrg = { organizationId: { in: organizationIds } };
      await tx.employeeWorkflowEvent.deleteMany({
        where: { workflow: workflowOrg },
      });
      await tx.employeeWorkflowTask.deleteMany({ where: workflowOrg });
      await tx.employeeWorkflow.deleteMany({ where: workflowOrg });
      await tx.workflowTemplateTask.deleteMany({ where: workflowOrg });
      await tx.workflowTemplate.deleteMany({ where: workflowOrg });
      // Recruitment (Phase 13): everything of the organizations, then the Core HR rows that
      // hire conversion created (assignments, and employees/persons it created).
      const recruitmentOrg = { organizationId: { in: organizationIds } };
      const hires = await tx.recruitmentHire.findMany({
        where: recruitmentOrg,
      });
      await tx.recruitmentHire.deleteMany({ where: recruitmentOrg });
      await tx.recruitmentActivity.deleteMany({ where: recruitmentOrg });
      await tx.recruitmentIntakeSubmission.deleteMany({
        where: recruitmentOrg,
      });
      await tx.recruitmentIntakeSource.deleteMany({ where: recruitmentOrg });
      await tx.recruitmentCandidateDocument.deleteMany({
        where: recruitmentOrg,
      });
      while (
        (
          await tx.recruitmentInterviewFeedback.deleteMany({
            where: { interview: recruitmentOrg, supersededBy: null },
          })
        ).count > 0
      );
      await tx.recruitmentInterviewer.deleteMany({
        where: { interview: recruitmentOrg },
      });
      await tx.recruitmentInterview.deleteMany({ where: recruitmentOrg });
      await tx.recruitmentOffer.deleteMany({ where: recruitmentOrg });
      await tx.recruitmentScreening.deleteMany({
        where: { application: recruitmentOrg },
      });
      await tx.recruitmentStageTransition.deleteMany({
        where: { application: recruitmentOrg },
      });
      await tx.recruitmentApplication.deleteMany({ where: recruitmentOrg });
      await tx.recruitmentCandidate.deleteMany({
        where: { ...recruitmentOrg, mergedIntoCandidateId: { not: null } },
      });
      await tx.recruitmentCandidate.deleteMany({ where: recruitmentOrg });
      await tx.jobOpeningEvent.deleteMany({
        where: { opening: recruitmentOrg },
      });
      await tx.jobOpening.deleteMany({ where: recruitmentOrg });
      await tx.recruitmentStage.deleteMany({ where: recruitmentOrg });
      const hiredAssignments = hires.map((hire) => hire.employmentAssignmentId);
      await tx.compensationRecord.deleteMany({
        where: { employmentAssignmentId: { in: hiredAssignments } },
      });
      await tx.employmentAssignment.deleteMany({
        where: { id: { in: hiredAssignments } },
      });
      const createdEmployees = hires.filter((hire) => hire.createdEmployee);
      await tx.employee.deleteMany({
        where: { id: { in: createdEmployees.map((hire) => hire.employeeId) } },
      });
      await tx.person.deleteMany({
        where: { id: { in: createdEmployees.map((hire) => hire.personId) } },
      });
      // Performance (Phase 12): everything of the organizations, children first.
      const performanceOrg = { organizationId: { in: organizationIds } };
      const performanceReview = { review: performanceOrg };
      await tx.performanceReviewEvidence.deleteMany({
        where: performanceReview,
      });
      await tx.performanceReviewGoal.deleteMany({ where: performanceReview });
      await tx.performanceReviewAcknowledgement.deleteMany({
        where: performanceReview,
      });
      await tx.performanceReviewEvent.deleteMany({ where: performanceReview });
      await tx.performanceReviewResponse.deleteMany({
        where: performanceReview,
      });
      await tx.performanceReview.deleteMany({ where: performanceOrg });
      await tx.performanceFormItem.deleteMany({
        where: { cycle: performanceOrg },
      });
      await tx.performanceFormSection.deleteMany({
        where: { cycle: performanceOrg },
      });
      await tx.performanceCycle.deleteMany({ where: performanceOrg });
      await tx.performanceTemplateItem.deleteMany({ where: performanceOrg });
      await tx.performanceTemplateSection.deleteMany({
        where: { template: performanceOrg },
      });
      await tx.performanceTemplate.deleteMany({ where: performanceOrg });
      await tx.performanceRatingScaleLevel.deleteMany({
        where: { scale: performanceOrg },
      });
      await tx.performanceRatingScale.deleteMany({ where: performanceOrg });
      await tx.performanceCompetency.deleteMany({ where: performanceOrg });
      await tx.performanceGoal.deleteMany({ where: performanceOrg });
      await tx.performanceEvidenceIntake.deleteMany({ where: performanceOrg });
      // Newest revisions first (each supersedes the one before).
      while (
        (
          await tx.performanceEvidence.deleteMany({
            where: { ...performanceOrg, supersededBy: null },
          })
        ).count > 0
      );
      await tx.performanceEvidenceSource.deleteMany({ where: performanceOrg });
      // Benefits (Phase 11): elections and dependents of the employees, plans of the orgs.
      await tx.benefitEnrollmentDependent.deleteMany({
        where: { employeeId: { in: employeeIds } },
      });
      await tx.benefitEnrollment.deleteMany({
        where: {
          OR: [
            { employeeId: { in: employeeIds } },
            { organizationId: { in: organizationIds } },
          ],
        },
      });
      await tx.benefitDependent.deleteMany({
        where: { employeeId: { in: employeeIds } },
      });
      await tx.benefitEligibilityRule.deleteMany({
        where: { organizationId: { in: organizationIds } },
      });
      await tx.benefitRate.deleteMany({
        where: { plan: { organizationId: { in: organizationIds } } },
      });
      await tx.benefitCoverageOption.deleteMany({
        where: { plan: { organizationId: { in: organizationIds } } },
      });
      await tx.benefitPlan.deleteMany({
        where: { organizationId: { in: organizationIds } },
      });
      await tx.compensationRecord.deleteMany({
        where: { organizationId: { in: organizationIds } },
      });
      // Payroll (Phase 10): everything hangs off runs, periods and calendars of the organization.
      const payrollRun = {
        run: { organizationId: { in: organizationIds } },
      };
      await tx.payrollValidationIssue.deleteMany({ where: payrollRun });
      await tx.payrollSourceClaim.deleteMany({ where: payrollRun });
      await tx.payrollDeductionLine.deleteMany({ where: payrollRun });
      await tx.payrollEmployerContributionLine.deleteMany({
        where: payrollRun,
      });
      await tx.payrollBenefitSnapshot.deleteMany({ where: payrollRun });
      await tx.payrollEarningLine.deleteMany({
        where: { ...payrollRun, origin: 'ADJUSTMENT' },
      });
      await tx.payrollAdjustment.deleteMany({
        where: { organizationId: { in: organizationIds } },
      });
      await tx.payrollEarningLine.deleteMany({
        where: { ...payrollRun, reversesLineId: { not: null } },
      });
      await tx.payrollEarningLine.deleteMany({ where: payrollRun });
      await tx.payrollCompensationSnapshot.deleteMany({ where: payrollRun });
      await tx.payrollTimeSnapshot.deleteMany({ where: payrollRun });
      await tx.payrollLeaveSnapshot.deleteMany({ where: payrollRun });
      await tx.payrollPresenceSnapshot.deleteMany({ where: payrollRun });
      await tx.payrollRunAssignment.deleteMany({
        where: { runEmployee: payrollRun },
      });
      await tx.payrollRunEmployee.deleteMany({ where: payrollRun });
      await tx.payrollRun.deleteMany({
        where: { organizationId: { in: organizationIds } },
      });
      await tx.payrollPeriod.deleteMany({
        where: { organizationId: { in: organizationIds } },
      });
      await tx.payrollCalendar.deleteMany({
        where: { organizationId: { in: organizationIds } },
      });
      await tx.payGroup.deleteMany({
        where: { organizationId: { in: organizationIds } },
      });
      await tx.leavePolicy.deleteMany({
        where: { organizationId: { in: organizationIds } },
      });
      await tx.leaveType.deleteMany({
        where: { organizationId: { in: organizationIds } },
      });
      await tx.organizationHoliday.deleteMany({
        where: { organizationId: { in: organizationIds } },
      });
      await tx.timesheetSegment.deleteMany({
        where: { timesheet: { employeeId: { in: employeeIds } } },
      });
      await tx.timesheetEvent.deleteMany({
        where: { timesheet: { employeeId: { in: employeeIds } } },
      });
      await tx.timesheet.deleteMany({
        where: { employeeId: { in: employeeIds } },
      });
      await tx.timePeriod.deleteMany({
        where: { organizationId: { in: organizationIds } },
      });
      await tx.attendanceException.deleteMany({
        where: { employeeId: { in: employeeIds } },
      });
      // Batch 4D: sign-outs reference their sign-ins.
      await tx.attendanceSignOut.deleteMany({
        where: { employeeId: { in: employeeIds } },
      });
      await tx.attendanceSignIn.updateMany({
        where: { employeeId: { in: employeeIds } },
        data: { replacesSignInId: null },
      });
      await tx.attendanceSignIn.deleteMany({
        where: { employeeId: { in: employeeIds } },
      });
      await tx.attendanceCredential.deleteMany({
        where: { employeeId: { in: employeeIds } },
      });
      await tx.timePunch.deleteMany({
        where: { employeeId: { in: employeeIds } },
      });
      await tx.attendanceDevice.deleteMany({
        where: { organizationId: { in: organizationIds } },
      });
      await tx.breakEntry.deleteMany({
        where: { timeEntryId: { in: entries } },
      });
      await tx.timeEntryAssignmentCoverage.deleteMany({
        where: { timeEntryId: { in: entries } },
      });
      await tx.timeEntry.deleteMany({ where: { id: { in: entries } } });
      await tx.scheduleConflictOverride.deleteMany({
        where: { scheduledShiftId: { in: shifts } },
      });
      await tx.scheduledShiftRevision.deleteMany({
        where: { scheduledShiftId: { in: shifts } },
      });
      await tx.scheduledShift.deleteMany({ where: { id: { in: shifts } } });
      await tx.schedule.deleteMany({ where: { id: { in: schedules } } });
      await tx.employeeSchedulePatternRule.deleteMany({
        where: { employeeSchedulePatternId: { in: patterns } },
      });
      await tx.employeeSchedulePattern.deleteMany({
        where: { id: { in: patterns } },
      });
      await tx.scheduleTemplateRule.deleteMany({
        where: { scheduleTemplateId: { in: templates } },
      });
      await tx.scheduleTemplate.deleteMany({
        where: { id: { in: templates } },
      });
      await tx.schedulePolicy.deleteMany({ where: { id: { in: policies } } });
      await tx.timeAttendancePolicy.deleteMany({
        where: {
          OR: [
            { organizationId: { in: organizationIds } },
            { employmentAssignment: { employeeId: { in: employeeIds } } },
          ],
        },
      });
      const persons = await tx.user.findMany({
        where: { id: { in: userIds } },
        select: { personId: true },
      });
      await tx.roleAssignment.deleteMany({
        where: { userId: { in: userIds } },
      });
      await tx.user.deleteMany({ where: { id: { in: userIds } } });
      const roles = await tx.role.findMany({
        where: { organizationId: { in: organizationIds } },
        select: { id: true },
      });
      await tx.rolePermission.deleteMany({
        where: { roleId: { in: roles.map((row) => row.id) } },
      });
      await tx.role.deleteMany({
        where: { organizationId: { in: organizationIds } },
      });
      const employees = await tx.employee.findMany({
        where: { id: { in: employeeIds } },
        select: { personId: true },
      });
      // Batch 5A: termination history (undeletable by trigger; suspended above).
      await tx.employeeTerminationAssignment.deleteMany({
        where: { termination: { employeeId: { in: employeeIds } } },
      });
      await tx.employeeTermination.deleteMany({
        where: { employeeId: { in: employeeIds } },
      });
      await tx.employmentAssignment.deleteMany({
        where: { employeeId: { in: employeeIds } },
      });
      await tx.employee.deleteMany({ where: { id: { in: employeeIds } } });
      await tx.person.deleteMany({
        where: {
          id: { in: [...persons, ...employees].map((row) => row.personId) },
        },
      });
      await tx.position.deleteMany({ where: { organizationId: fx.orgA } });
      await tx.jobTitle.deleteMany({ where: { organizationId: fx.orgA } });
      await tx.workLocation.deleteMany({ where: { organizationId: fx.orgA } });
      await tx.physicalSite.deleteMany({ where: { organizationId: fx.orgA } });
      await tx.team.deleteMany({ where: { organizationId: fx.orgA } });
      await tx.department.deleteMany({ where: { organizationId: fx.orgA } });
      await tx.organizationalUnit.deleteMany({
        where: { organizationId: fx.orgA, parentUnitId: { not: null } },
      });
      await tx.organizationalUnit.deleteMany({
        where: { organizationId: fx.orgA },
      });
      await tx.organization.deleteMany({
        where: { id: { in: organizationIds } },
      });
    },
    { timeout: 60_000 },
  );
}
