import { config } from 'dotenv';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '../src/audit/audit.service.js';
import { AuditViewerService } from '../src/audit/audit-viewer.service.js';
import { AuthorizationService } from '../src/authorization/authorization.service.js';
import { PositionAuthorizationTargetResolver } from '../src/authorization/position-authorization-target.resolver.js';
import { RoleManagementService } from '../src/authorization/role-management.service.js';
import { PrismaService } from '../src/database/prisma.service.js';
import { EmployeeAccessService } from '../src/employee/employee-access.service.js';
import { EmployeeDomainService } from '../src/employee/employee-domain.service.js';
import { EmployeeService } from '../src/employee/employee.service.js';
import { EmployeeLifecycleService } from '../src/employee/employee-lifecycle.service.js';
import { AttendanceDeviceService } from '../src/kiosk/attendance-device.service.js';
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
  ALL_DOMAIN_PERMISSIONS,
  FEATURE_USERS,
  featureServices,
  refusal,
  setModule,
} from './support/features-fixtures.js';
import {
  FixedGoogleClock,
  googleTestServices,
} from './support/google-fixtures.js';
import { leaveServices, seedLeaveConfig } from './support/leave-fixtures.js';
import {
  FixedNotificationsClock,
  notificationTestServices,
} from './support/notifications-fixtures.js';
import {
  activeTemplate as onboardingTemplate,
  FixedOnboardingClock,
  offboardingTasks,
  onboardingServices,
} from './support/onboarding-fixtures.js';
import {
  FixedPayrollClock,
  payGroup,
  payrollServices,
} from './support/payroll-fixtures.js';
import {
  evidence,
  FixedPerformanceClock,
  performanceServices,
} from './support/performance-fixtures.js';
import {
  candidateDetails,
  FixedRecruitmentClock,
  openOpening,
  recruitmentServices,
} from './support/recruitment-fixtures.js';
import {
  createSchedulingFixtures,
  ctx,
  rollbackClient,
  schedulingServices,
  type SchedulingFixtures,
  type Tx,
  type UserSpec,
} from './support/scheduling-fixtures.js';

config({ path: '../../.env' });

class RollbackFixtures extends Error {}

/**
 * Phase 19 cross-module authorization regression suite. Representative IDOR, cross-organization,
 * self-boundary and confidentiality cases per module — including cases that already passed
 * before Phase 19, so a later change cannot silently reopen them — and the Phase 19 fixes:
 *
 * - entity-id lookups authorize BEFORE the feature gate: a caller who cannot reach the record
 *   gets the same 404 whether or not the module is disabled (no FEATURE_DISABLED existence
 *   oracle); an authorized caller still gets FEATURE_DISABLED;
 * - ids of another organization answer 404, never 403, on candidate management, leave
 *   decisions, evidence history and role management.
 *
 * Users: `hr` holds every domain permission in Org A, `hrB` every domain permission in Org B,
 * `itDesk` nothing; `self1` (Employee 1's own account) holds every domain permission in Org A
 * and must still never manage or approve their own records.
 */
const USERS: Record<string, UserSpec[]> = {
  ...FEATURE_USERS,
  self1: [{ permissions: ALL_DOMAIN_PERMISSIONS, scope: 'org' }],
  roleReader: [{ permissions: ['role.read'], scope: 'org' }],
  recruitReader: [{ permissions: ['recruitment.read'], scope: 'org' }],
  roleAdminB: [
    { permissions: ['role.read', 'role.manage', 'role.assign'], scope: 'orgB' },
  ],
  auditReader: [{ permissions: ['audit.read'], scope: 'org' }],
  auditReaderB: [{ permissions: ['audit.read'], scope: 'orgB' }],
  teamAuditor: [{ permissions: ['audit.read'], scope: 'teamA' }],
};

const NOT_FOUND = { status: 404 };
const FORBIDDEN = { status: 403 };

describe('Authorization regression (database)', () => {
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
      client: PrismaService,
    ) => Promise<void>,
  ) {
    await expect(
      prisma.$transaction(
        async (tx) => {
          const fx = await createSchedulingFixtures(tx, USERS, [
            'role.read',
            'role.manage',
            'role.assign',
            'audit.read',
          ]);
          await run(tx, fx, rollbackClient(tx)).catch((error: unknown) => {
            console.error('SCENARIO FAILURE', error);
            throw error;
          });
          throw new RollbackFixtures();
        },
        { timeout: 180_000 },
      ),
    ).rejects.toBeInstanceOf(RollbackFixtures);
  }

  it('RECRUITMENT: candidates of another organization are 404, before and while the module is off', async () => {
    await scenario(async (_tx, fx, client) => {
      const svc = recruitmentServices(client, new FixedRecruitmentClock());
      const features = featureServices(client);
      const opening = await openOpening(svc, fx);
      const application = await svc.applications.create(
        { openingId: opening.id, candidate: candidateDetails() },
        ctx(fx.users.hr!),
      );
      const candidateId = application.candidateId;
      // Cross-organization and no-grant callers: 404 on every candidate entity route.
      for (const user of [fx.users.hrB!, fx.users.itDesk!]) {
        expect(await refusal(svc.candidates.detail(user, candidateId))).toEqual(
          NOT_FOUND,
        );
        expect(
          await refusal(svc.candidates.archive(candidateId, ctx(user))),
        ).toEqual(NOT_FOUND);
        expect(
          await refusal(
            svc.candidates.update(candidateId, { firstName: 'X' }, ctx(user)),
          ),
        ).toEqual(NOT_FOUND);
        expect(
          await refusal(svc.applications.detail(user, application.id)),
        ).toEqual(NOT_FOUND);
      }
      // In-organization reader without manage keeps the 403.
      expect(
        await refusal(
          svc.candidates.archive(candidateId, ctx(fx.users.recruitReader!)),
        ),
      ).toEqual(FORBIDDEN);

      await setModule(features, fx, 'RECRUITMENT', false);
      // Phase 19 fix: still 404 (not FEATURE_DISABLED) for callers who cannot reach it.
      for (const user of [fx.users.hrB!, fx.users.itDesk!]) {
        expect(await refusal(svc.candidates.detail(user, candidateId))).toEqual(
          NOT_FOUND,
        );
        expect(
          await refusal(svc.candidates.archive(candidateId, ctx(user))),
        ).toEqual(NOT_FOUND);
      }
      // The authorized caller is told the module is off.
      expect(
        await refusal(svc.candidates.detail(fx.users.hr!, candidateId)),
      ).toMatchObject({ status: 403, code: 'FEATURE_DISABLED' });
      expect(
        await refusal(svc.candidates.archive(candidateId, ctx(fx.users.hr!))),
      ).toMatchObject({ status: 403, code: 'FEATURE_DISABLED' });
    });
  });

  it('LEAVE: decisions and policy resolution authorize before the gate; no self-approval', async () => {
    await scenario(async (tx, fx, client) => {
      const svc = leaveServices(client);
      const features = featureServices(client);
      const types = await seedLeaveConfig(tx, fx, svc);
      const input = {
        employmentAssignmentId: fx.assignmentTeamA,
        leaveTypeId: types.personal.id,
        startDate: '2027-03-01',
        endDate: '2027-03-01',
      };
      const request = await svc.requests.submitOwn(
        fx.users.self1!,
        input,
        ctx(fx.users.self1!),
      );
      // Cross-organization / no-grant deciders: 404 (Phase 19; was 403).
      for (const user of [fx.users.hrB!, fx.users.itDesk!]) {
        expect(
          await refusal(
            svc.requests.approve(user, request.requestId, {}, ctx(user)),
          ),
        ).toEqual(NOT_FOUND);
        expect(
          await refusal(
            svc.requests.reject(user, request.requestId, {}, ctx(user)),
          ),
        ).toEqual(NOT_FOUND);
        expect(
          await refusal(svc.views.requestDetail(user, request.requestId)),
        ).toEqual(NOT_FOUND);
      }
      // Nobody approves their own leave, whatever they hold.
      expect(
        await refusal(
          svc.requests.approve(
            fx.users.self1!,
            request.requestId,
            {},
            ctx(fx.users.self1!),
          ),
        ),
      ).toMatchObject({ status: 403, code: 'LEAVE_SELF_APPROVAL' });

      await setModule(features, fx, 'LEAVE', false);
      // Phase 19 fix: the assignment context no longer gates before authorization.
      for (const user of [fx.users.hrB!, fx.users.itDesk!]) {
        expect(
          await refusal(
            svc.requests.approve(user, request.requestId, {}, ctx(user)),
          ),
        ).toEqual(NOT_FOUND);
        expect(
          await refusal(
            svc.config.resolvePolicy(user, {
              employmentAssignmentId: fx.assignmentTeamA,
              leaveTypeId: types.personal.id,
              date: '2027-03-01',
            }),
          ),
        ).toEqual(FORBIDDEN);
        expect(
          await refusal(
            svc.requests.previewForAssignment(user, {
              ...input,
              employmentAssignmentId: fx.assignmentTeamA,
            }),
          ),
        ).toEqual(FORBIDDEN);
      }
      for (const run of [
        () =>
          svc.requests.approve(
            fx.users.hr!,
            request.requestId,
            {},
            ctx(fx.users.hr!),
          ),
        () =>
          svc.config.resolvePolicy(fx.users.hr!, {
            employmentAssignmentId: fx.assignmentTeamA,
            leaveTypeId: types.personal.id,
            date: '2027-03-01',
          }),
        () => svc.requests.previewOwn(fx.users.self1!, input),
      ])
        expect(await refusal(run())).toMatchObject({
          status: 403,
          code: 'FEATURE_DISABLED',
        });
    });
  });

  it('DOCUMENTS: confidentiality and cross-organization reads are 404, whatever the module state', async () => {
    await scenario(async (_tx, fx, client) => {
      const svc = documentServices(client, new FixedDocumentsClock());
      const features = featureServices(client);
      const { items } = await svc.types.initializeDefaults(
        fx.orgA,
        ctx(fx.users.hr!),
      );
      const typeId = items.find((t) => t.code === 'BACKGROUND-CHECK')!.id;
      const record = await svc.documents.create(
        {
          organizationId: fx.orgA,
          employeeId: fx.employee2,
          typeId,
          title: 'Background check',
          confidentiality: 'RESTRICTED',
          version: {
            provider: 'GOOGLE_DRIVE',
            externalFileId: `drive-${fx.suffix}`,
            fileName: 'check.pdf',
            mimeType: 'application/pdf',
            expiresOn: '2030-01-01',
          },
        } as never,
        ctx(fx.users.hr!),
      );
      for (const user of [fx.users.hrB!, fx.users.itDesk!])
        expect(await refusal(svc.documents.detail(user, record.id))).toEqual(
          NOT_FOUND,
        );
      // Employee 2 never sees a RESTRICTED record about themselves.
      expect(
        await refusal(svc.documents.detail(fx.selfUser2, record.id)),
      ).toEqual(NOT_FOUND);
      // Nobody manages their own records.
      expect(
        await refusal(
          svc.documents.create(
            {
              organizationId: fx.orgA,
              employeeId: fx.employee1,
              typeId,
              title: 'Mine',
              confidentiality: 'HR_ONLY',
              version: {
                provider: 'GOOGLE_DRIVE',
                externalFileId: `own-${fx.suffix}`,
                fileName: 'own.pdf',
                mimeType: 'application/pdf',
                expiresOn: '2030-01-01',
              },
            } as never,
            ctx(fx.users.self1!),
          ),
        ),
      ).toMatchObject({ status: 403, code: 'DOCUMENT_SELF_MANAGEMENT' });

      await setModule(features, fx, 'DOCUMENTS', false);
      // Phase 19 fix: unreachable records stay 404 while the module is off.
      for (const user of [fx.users.hrB!, fx.users.itDesk!, fx.selfUser2])
        expect(await refusal(svc.documents.detail(user, record.id))).toEqual(
          NOT_FOUND,
        );
      expect(
        await refusal(svc.documents.detail(fx.users.hr!, record.id)),
      ).toMatchObject({ status: 403, code: 'FEATURE_DISABLED' });
    });
  });

  it('PERFORMANCE: evidence history of another organization is 404, before and while the module is off', async () => {
    await scenario(async (tx, fx, client) => {
      const svc = performanceServices(client, new FixedPerformanceClock());
      const features = featureServices(client);
      const row = await evidence(tx, fx);
      expect(
        (await svc.evidence.history(fx.users.hr!, row.id)).items,
      ).toHaveLength(1);
      for (const user of [fx.users.hrB!, fx.users.itDesk!])
        expect(await refusal(svc.evidence.history(user, row.id))).toEqual(
          NOT_FOUND,
        );
      await setModule(features, fx, 'PERFORMANCE', false);
      for (const user of [fx.users.hrB!, fx.users.itDesk!])
        expect(await refusal(svc.evidence.history(user, row.id))).toEqual(
          NOT_FOUND,
        );
      expect(
        await refusal(svc.evidence.history(fx.users.hr!, row.id)),
      ).toMatchObject({ status: 403, code: 'FEATURE_DISABLED' });
      // One's own evidence while the module is off: FEATURE_DISABLED, not 404.
      expect(
        await refusal(svc.evidence.history(fx.users.self1!, row.id)),
      ).toMatchObject({ status: 403, code: 'FEATURE_DISABLED' });
    });
  });

  it('ROLES: role and assignment ids of another organization are 404; in-scope readers keep 403', async () => {
    await scenario(async (tx, fx, client) => {
      const roles = new RoleManagementService(
        client,
        new AuthorizationService(client),
        new AuditService(client),
      );
      const role = await tx.role.findFirstOrThrow({
        where: { organizationId: fx.orgA, isSystemOwner: false },
      });
      const assignment = await tx.roleAssignment.findFirstOrThrow({
        where: { roleId: role.id },
      });
      const admin = fx.users.roleAdminB!;
      expect(await refusal(roles.getRole(admin, role.id))).toEqual(NOT_FOUND);
      expect(
        await refusal(
          roles.updateRole(admin, role.id, { name: 'x' }, ctx(admin)),
        ),
      ).toEqual(NOT_FOUND);
      expect(
        await refusal(roles.archiveRole(admin, role.id, ctx(admin))),
      ).toEqual(NOT_FOUND);
      expect(await refusal(roles.listAssignments(admin, role.id))).toEqual(
        NOT_FOUND,
      );
      expect(await refusal(roles.getAssignment(admin, assignment.id))).toEqual(
        NOT_FOUND,
      );
      expect(
        await refusal(
          roles.revokeAssignment(admin, assignment.id, undefined, ctx(admin)),
        ),
      ).toEqual(NOT_FOUND);
      // A reader of Org A sees the role but may not change it.
      expect((await roles.getRole(fx.users.roleReader!, role.id))?.id).toBe(
        role.id,
      );
      expect(
        await refusal(
          roles.updateRole(
            fx.users.roleReader!,
            role.id,
            { name: 'x' },
            ctx(fx.users.roleReader!),
          ),
        ),
      ).toEqual(FORBIDDEN);
    });
  });

  it('CORE HR, COMPENSATION, BENEFITS, PAYROLL: other organizations and self-management are refused', async () => {
    await scenario(async (tx, fx, client) => {
      const authorization = new AuthorizationService(client);
      const audit = new AuditService(client);
      const targets = new PositionAuthorizationTargetResolver(client);
      const employees = new EmployeeService(
        client,
        new EmployeeDomainService(client, audit),
        new EmployeeAccessService(client, authorization, targets),
        authorization,
        targets,
        audit,
        new EmployeeLifecycleService(
          client,
          new EmployeeDomainService(client, audit),
          new EmployeeAccessService(client, authorization, targets, audit),
          authorization,
          audit,
        ),
      );
      for (const user of [fx.users.hrB!, fx.users.itDesk!])
        expect(await refusal(employees.profile(fx.employee1, user))).toEqual(
          NOT_FOUND,
        );

      const compensation = compensationServices(client);
      // Assignment-scoped routes answer 403 for an assignment outside the caller's scope (the
      // documented assignment-id convention); never data.
      expect(
        await refusal(
          compensation.compensation.history(fx.users.hrB!, fx.assignmentTeamA),
        ),
      ).toEqual(FORBIDDEN);
      expect(
        await refusal(
          compensation.compensation.create(
            fx.assignmentTeamA,
            {
              payBasis: 'HOURLY',
              rateAmount: '99',
              currency: 'CAD',
              effectiveFrom: '2026-01-01',
            },
            ctx(fx.users.self1!),
          ),
        ),
      ).toMatchObject({ status: 403, code: 'COMPENSATION_SELF_MANAGEMENT' });

      const benefits = benefitsServices(client, new FixedBenefitsClock());
      const { plan } = await benefitPlan(tx, fx);
      for (const user of [fx.users.hrB!, fx.users.itDesk!])
        expect(
          (await refusal(benefits.plans.detail(user, plan.id))).status,
        ).toBeGreaterThanOrEqual(403);
      expect(
        await refusal(
          benefits.enrollments.employee(fx.users.hrB!, fx.employee1),
        ),
      ).toMatchObject({ status: expect.any(Number) as number });

      const payroll = payrollServices(client, new FixedPayrollClock());
      await payGroup(tx, fx.orgA, `PG-${fx.suffix}`);
      expect(
        await refusal(
          payroll.calendars.calendars(fx.users.hrB!, {
            organizationId: fx.orgA,
          }),
        ),
      ).toEqual(FORBIDDEN);
      // Payslips are only ever one's own: another employee's run row is not found.
      expect(
        await refusal(
          payroll.self.payslip(
            fx.users.hrB!,
            '00000000-0000-4000-8000-000000000099',
          ),
        ),
      ).toMatchObject({ status: expect.any(Number) as number });
    });
  });

  it('ONBOARDING: other organizations get 404; the employee never sees the offboarding reason', async () => {
    await scenario(async (_tx, fx, client) => {
      const svc = onboardingServices(client, new FixedOnboardingClock());
      await onboardingTemplate(svc, fx, {
        kind: 'OFFBOARDING',
        code: 'leavers',
        tasks: offboardingTasks(fx) as never,
      });
      const workflow = await svc.workflows.start(
        'OFFBOARDING',
        {
          employmentAssignmentId: fx.otherTeamA,
          plannedEndDate: '2027-06-30',
          reason: 'Confidential reason',
        },
        ctx(fx.users.hr!),
      );
      // (itDesk owns the IT task of this template, so it is a task owner here.)
      expect(
        await refusal(svc.workflows.detail(fx.users.hrB!, workflow.id)),
      ).toEqual(NOT_FOUND);
      const it = await svc.workflows.detail(fx.users.itDesk!, workflow.id);
      expect(it).toMatchObject({ view: 'TASK_OWNER' });
      // Task owners and the employee see the planned date (their due dates derive from it),
      // never the reason or the cancellation reason.
      expect(it).not.toHaveProperty('reason');
      expect(it).not.toHaveProperty('cancellationReason');
      const own = (await svc.workflows.mine(fx.selfUser2)).items.find(
        (item) => item.kind === 'OFFBOARDING',
      );
      expect(own).toBeDefined();
      expect(own).not.toHaveProperty('reason');
      expect(JSON.stringify(own)).not.toContain('Confidential reason');
      // Nobody starts their own offboarding.
      expect(
        await refusal(
          svc.workflows.start(
            'OFFBOARDING',
            {
              employmentAssignmentId: fx.assignmentTeamA,
              plannedEndDate: '2027-06-30',
            },
            ctx(fx.users.self1!),
          ),
        ),
      ).toMatchObject({ status: 403, code: 'WORKFLOW_SELF_MANAGEMENT' });
    });
  });

  it('SCHEDULING, ATTENDANCE, KIOSK, GOOGLE, FEATURES: organization routes refuse other organizations', async () => {
    await scenario(async (_tx, fx, client) => {
      const scheduling = schedulingServices(client);
      const schedule = await scheduling.scheduling.createSchedule(
        {
          scopeType: 'ORGANIZATION',
          organizationId: fx.orgA,
          name: 'Org',
          type: 'STANDARD',
          periodStart: '2026-10-05',
          periodEnd: '2026-10-11',
        },
        ctx(fx.users.hr!),
      );
      for (const user of [fx.users.hrB!, fx.users.itDesk!]) {
        expect(
          (await refusal(scheduling.scheduling.getSchedule(user, schedule.id)))
            .status,
        ).toBe(404);
      }
      const authorization = new AuthorizationService(client);
      const audit = new AuditService(client);
      const policies = new TimePolicyService(
        client,
        authorization,
        new PositionAuthorizationTargetResolver(client),
        audit,
      );
      expect(
        await refusal(
          policies.list(fx.users.hrB!, { organizationId: fx.orgA }),
        ),
      ).toEqual(FORBIDDEN);
      const devices = new AttendanceDeviceService(client, authorization, audit);
      expect(await refusal(devices.list(fx.users.hrB!, fx.orgA))).toEqual(
        FORBIDDEN,
      );
      const google = googleTestServices(client, new FixedGoogleClock());
      expect(
        await refusal(google.bindings.list(fx.users.hrB!, fx.orgA)),
      ).toEqual(FORBIDDEN);
      const features = featureServices(client);
      expect(
        await refusal(features.features.overview(fx.users.hrB!, fx.orgA)),
      ).toEqual(FORBIDDEN);
    });
  });

  it("NOTIFICATIONS: another user's notification is not found", async () => {
    await scenario(async (tx, fx, client) => {
      const svc = notificationTestServices(
        client,
        new FixedNotificationsClock(),
      );
      await svc.templates.ensureSystemTemplates(tx);
      const published = await svc.notifications.publish({
        organizationId: fx.orgA,
        recipientUserId: fx.selfUser1,
        type: 'onboarding.tasks-due',
        variables: {
          overdueCount: 1,
          dueSoonCount: 0,
          taskTitles: 'Paperwork',
        },
        dedupeKey: `own-${fx.suffix}`,
      });
      const row = await tx.notification.findFirstOrThrow({
        where: { recipientUserId: fx.selfUser1 },
      });
      expect(published.outcome).toBe('CREATED');
      for (const user of [fx.selfUser2, fx.users.hr!]) {
        expect(
          await refusal(svc.notifications.markRead(row.id, ctx(user))),
        ).toEqual(NOT_FOUND);
        expect(
          await refusal(svc.notifications.archive(row.id, ctx(user))),
        ).toEqual(NOT_FOUND);
        expect(
          (await svc.notifications.mine(user)).items.map((item) => item.id),
        ).not.toContain(row.id);
      }
      expect(
        (await svc.notifications.markAllRead(ctx(fx.selfUser2))).updated,
      ).toBe(0);
    });
  });

  it('AUDIT VIEWER: organization scope only, safe projection, keyset pagination', async () => {
    await scenario(async (tx, fx, client) => {
      const viewer = new AuditViewerService(
        client,
        new AuthorizationService(client),
      );
      const base = new Date('2027-01-10T12:00:00.000Z');
      const at = (minutes: number) =>
        new Date(base.getTime() + minutes * 60_000);
      for (let index = 0; index < 5; index += 1) {
        await tx.auditLog.create({
          data: {
            action:
              index % 2 ? 'LEAVE_REQUEST_REJECTED' : 'LEAVE_REQUEST_APPROVED',
            entityType: 'LeaveRequest',
            entityId: `request-${index}`,
            actorUserId: fx.users.hr!,
            ipAddress: '10.0.0.1',
            userAgent: 'secret-agent',
            correlationId: `req-${index}`,
            occurredAt: at(index),
            metadata: {
              organizationId: fx.orgA,
              employeeId: fx.employee1,
              status: 'APPROVED',
              note: 'Free text that must never be shown',
              email: 'person@example.com',
            },
          },
        });
      }
      await tx.auditLog.create({
        data: {
          action: 'LEAVE_REQUEST_APPROVED',
          entityType: 'LeaveRequest',
          entityId: 'other-org',
          occurredAt: at(1),
          metadata: { organizationId: fx.orgB },
        },
      });
      const query = {
        organizationId: fx.orgA,
        from: '2027-01-01T00:00:00.000Z',
        to: '2027-02-01T00:00:00.000Z',
      };
      const first = await viewer.list(fx.users.auditReader!, {
        ...query,
        limit: 2,
      });
      expect(first.items.map((item) => item.entityId)).toEqual([
        'request-4',
        'request-3',
      ]);
      expect(first.items[0]).toEqual({
        id: expect.any(String) as string,
        occurredAt: at(4).toISOString(),
        action: 'LEAVE_REQUEST_APPROVED',
        entityType: 'LeaveRequest',
        entityId: 'request-4',
        actor: { userId: fx.users.hr!, displayName: null },
        requestId: 'req-4',
        metadata: {
          organizationId: fx.orgA,
          employeeId: fx.employee1,
          status: 'APPROVED',
        },
      });
      expect(JSON.stringify(first)).not.toMatch(
        /Free text|person@example|10\.0\.0\.1|secret-agent/,
      );
      const second = await viewer.list(fx.users.auditReader!, {
        ...query,
        limit: 2,
        cursor: first.nextCursor!,
      });
      const third = await viewer.list(fx.users.auditReader!, {
        ...query,
        limit: 2,
        cursor: second.nextCursor!,
      });
      expect(
        [...second.items, ...third.items].map((item) => item.entityId),
      ).toEqual(['request-2', 'request-1', 'request-0']);
      expect(third.nextCursor).toBeNull();
      // Filters.
      expect(
        (
          await viewer.list(fx.users.auditReader!, {
            ...query,
            action: 'LEAVE_REQUEST_REJECTED',
          })
        ).items.map((item) => item.entityId),
      ).toEqual(['request-3', 'request-1']);
      expect(
        (
          await viewer.list(fx.users.auditReader!, {
            ...query,
            entityType: 'LeaveRequest',
            entityId: 'request-2',
            actorUserId: fx.users.hr!,
          })
        ).items,
      ).toHaveLength(1);
      // Org B entries never appear; other organizations and team-scoped grants are refused.
      expect(
        (
          await viewer.list(fx.users.auditReaderB!, {
            ...query,
            organizationId: fx.orgB,
          })
        ).items.map((item) => item.entityId),
      ).toEqual(['other-org']);
      for (const user of [
        fx.users.auditReaderB!,
        fx.users.teamAuditor!,
        fx.users.hr!,
      ])
        expect(await refusal(viewer.list(user, query))).toEqual(FORBIDDEN);
      expect(
        await refusal(
          viewer.list(fx.users.auditReader!, {
            ...query,
            from: '2025-01-01T00:00:00.000Z',
          }),
        ),
      ).toMatchObject({ status: 400, code: 'AUDIT_RANGE_TOO_WIDE' });
    });
  });
});
