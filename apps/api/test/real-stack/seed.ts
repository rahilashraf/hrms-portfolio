import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ConfigService } from '@nestjs/config';
import { isIanaTimezone } from '../../src/common/timezone.js';
import { AuthorizationCatalogService } from '../../src/authorization/authorization-catalog.service.js';
import { PrismaService } from '../../src/database/prisma.service.js';
import { DEFAULT_STAGES } from '../../src/recruitment/recruitment-domain.js';
import { PasswordHasherService } from '../../src/security/password-hasher.service.js';
import {
  planRealStackDates,
  REAL_STACK_DEFAULT_TIMEZONE,
  referenceInstantFrom,
  type RealStackDatePlan,
} from './dates.js';
import {
  assertDisposableDatabase,
  assertDisposableDatabaseUrl,
  REAL_STACK_EMAIL_DOMAIN,
  REAL_STACK_ORGANIZATION_CODE_PREFIX,
} from './disposable-database.js';

/**
 * Real-stack Playwright seed (Batch 4, PR 4.0): one new organization per run with an employee
 * and a time manager who sign in with passwords, a live-clock attendance policy, one closed
 * attendance record the day before the reference date, and a timesheet around it. Everything is
 * created with a random suffix, so runs never collide and nothing existing is read or changed.
 * The browser specs read the result from the JSON file this writes (REAL_STACK_SEED_FILE).
 *
 * Dates: every date comes from one reference instant (REAL_STACK_REFERENCE_INSTANT, else now) and
 * one timezone (REAL_STACK_TIMEZONE, default America/Toronto) through planRealStackDates, and is
 * written to the seed file; the specs never read the clock themselves.
 *
 * Safety: refuses to run unless the database is a provably disposable test database (see
 * disposable-database.ts: REAL_STACK_E2E=1, not production, this machine, a `*_disposable` name,
 * the disposable marker, and no data but earlier real-stack seeds). It never deletes anything,
 * so seeded data stays in the disposable database until that database is dropped or recreated.
 *
 * Usage (from apps/api): REAL_STACK_E2E=1 REAL_STACK_SEED_FILE=<path> tsx test/real-stack/seed.ts
 */

/** Batch 9: a records administrator — every document permission, and employee profiles. */
const DOCUMENTS_HR_PERMISSIONS = [
  'employee.read',
  'document.read',
  'document.confidential.read',
  'document.restricted.read',
  'document.manage',
  'document.type.manage',
  'document.policy.manage',
] as const;
/** Batch 9: a manager who reads documents up to manager-visible only (no HR-only access). */
const DOCUMENTS_MANAGER_PERMISSIONS = [
  'employee.read',
  'document.read',
] as const;

/** Employee self-service, as an employee role would grant it. */
const EMPLOYEE_PERMISSIONS = ['time.clock'] as const;
/** A time manager over the organization. */
const MANAGER_PERMISSIONS = [
  'time.view',
  'time.correct',
  'time.approve',
  'time.timesheet.approve',
  'time.timesheet.manage',
  // Batch 4E-2: replaces an organization policy from a date and inspects the effective policy.
  'time.manage_policy',
  'employee.read',
] as const;
/**
 * Batch 5C: an HR administrator of the organization (employee lifecycle, structure and physical
 * sites, the access review). Never the employee themselves.
 */
const HR_PERMISSIONS = [
  'employee.read',
  'employee.manage',
  'organization.read',
  'organization.manage',
  'role.read',
  // Batch 5D: revokes an ended employee's grants in the access review.
  'role.assign',
] as const;

/**
 * Batch 6A: a payroll administrator of the payroll organization (configuration, runs,
 * adjustments, approval and finalization) who also reads reports (the payroll register).
 */
const PAYROLL_ADMIN_PERMISSIONS = [
  'payroll.read',
  'payroll.manage',
  'payroll.calculate',
  'payroll.approve',
  'payroll.finalize',
  'payroll.adjust',
  'report.read',
  'report.export',
] as const;

/**
 * Batch R5-B: organization structure management (granted organization-wide to the structure
 * administrator, and at one department's scope to the structure manager).
 */
const STRUCTURE_PERMISSIONS = [
  'organization.read',
  'organization.manage',
] as const;

/** A YYYY-MM-DD date `days` after another (calendar arithmetic). */
function addDays(date: string, days: number) {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! + days))
    .toISOString()
    .slice(0, 10);
}

export interface RealStackPayrollSeed {
  organizationId: string;
  organizationName: string;
  /** Prepares payroll (and, with dual control, never approves what they prepared). */
  admin: { email: string; password: string; name: string };
  /** Security remediation M2: an independent approver (approves and finalizes only). */
  approver: { email: string; password: string; name: string };
  /**
   * M2: may approve, but authored the payee's compensation (seeded): refused approval of a
   * run paying it (COMPENSATION_CHANGED_BY_YOU).
   */
  compensationApprover: { email: string; password: string; name: string };
  /** A salaried employee (52,000 CAD a year, so 2,000.00 a bi-weekly period) who signs in. */
  employee: {
    email: string;
    password: string;
    name: string;
    employeeNumber: string;
  };
  payGroupName: string;
  payGroupCode: string;
  positionName: string;
  /** The bi-weekly calendar's first period, entirely in the past of the reference date. */
  anchorDate: string;
  periodEnd: string;
  payDate: string;
  salaryGross: string;
}

/** Security remediation M2: an independent payroll approver (no preparation permissions). */
const PAYROLL_APPROVER_PERMISSIONS = [
  'payroll.read',
  'payroll.approve',
  'payroll.finalize',
] as const;

/** Batch 6B: a leave administrator (records and decides leave; finds employees). */
const LEAVE_ADMIN_PERMISSIONS = [
  'leave.read',
  'leave.approve',
  'leave.manage_policy',
  'employee.read',
  // Batch 8: reads the organization's notification delivery log (real-stack check).
  'notification.delivery.read',
] as const;
/** Batch 6B: employee leave self-service. */
const LEAVE_SELF_PERMISSIONS = ['leave.request'] as const;

/** Batch 7A: the standard Recruiter role template (no employee.read, no role.assign). */
const RECRUITER_PERMISSIONS = [
  'recruitment.read',
  'recruitment.manage',
  'recruitment.pipeline.manage',
  'recruitment.intake.manage',
] as const;
/** Batch 7A: approves offers, converts hires and onboards them. */
const HIRER_PERMISSIONS = [
  'recruitment.read',
  'recruitment.manage',
  'recruitment.offer.approve',
  'recruitment.hire',
  'employee.read',
  'employee.manage',
  'compensation.read',
  'compensation.manage',
  'onboarding.read',
  'onboarding.manage',
] as const;

/**
 * Batch 7C: a benefits administrator (plans, rates, eligibility, elections, dependents) who also
 * runs payroll for the benefits organization (no employee.read: the pickers are Benefits').
 */
const BENEFITS_ADMIN_PERMISSIONS = [
  'benefit.read',
  'benefit.manage',
  'benefit.plan.manage',
  'payroll.read',
  'payroll.manage',
  'payroll.calculate',
  'payroll.approve',
  'payroll.finalize',
  'payroll.adjust',
] as const;

/** Batch 7B: a performance administrator (cycles, templates, evidence, reviews, reports). */
const PERFORMANCE_HR_PERMISSIONS = [
  'performance.read',
  'performance.manage',
  'performance.cycle.manage',
  'performance.template.manage',
  'performance.evidence.manage',
  'report.read',
] as const;

/** The first Monday on or after a date. */
function mondayOnOrAfter(date: string) {
  const day = new Date(`${date}T00:00:00.000Z`).getUTCDay();
  return addDays(date, (8 - day) % 7);
}

export interface RealStackLeaveSeed {
  organizationId: string;
  organizationName: string;
  admin: { email: string; password: string; name: string };
  /** Taylor and Quinn share a team; Rowan is in another team of the same organization. */
  taylor: {
    email: string;
    password: string;
    name: string;
    employeeNumber: string;
  };
  quinn: { email: string; password: string; name: string };
  rowan: { email: string; password: string; name: string };
  teamName: string;
  positionName: string;
  leaveTypeName: string;
  /** A future Monday and Tuesday; the Tuesday is a holiday. */
  leaveStart: string;
  leaveEnd: string;
  holidayName: string;
}

export interface RealStackRecruitmentSeed {
  organizationId: string;
  organizationName: string;
  /** A standard Recruiter: builds the opening and schedules the interview from pickers only. */
  recruiter: { email: string; password: string; name: string };
  /** Approves and sends the offer, converts the hire and starts onboarding. */
  hirer: { email: string; password: string; name: string };
  /** An employee with an account: the hiring manager and the interviewer. */
  interviewer: { email: string; password: string; name: string };
  teamName: string;
  positionName: string;
  candidate: { firstName: string; lastName: string; email: string };
  templateName: string;
  employeeTaskTitle: string;
  hrTaskTitle: string;
  /** A future start date for the offer (the hire starts PLANNED). */
  startDate: string;
}

export interface RealStackPerformanceSeed {
  organizationId: string;
  organizationName: string;
  /** Performance administrator (no employee record, no Core HR permissions). */
  hr: { email: string; password: string; name: string };
  /** Pat's manager: the DIRECT_MANAGER reviewer. */
  manager: { email: string; password: string; name: string };
  employee: { email: string; password: string; name: string };
  templateName: string;
  ratingPrompt: string;
  textPrompt: string;
  /** Cycle dates around the reference date (the window is open "today"). */
  cycle: {
    periodStart: string;
    periodEnd: string;
    windowStart: string;
    windowEnd: string;
    selfDue: string;
    reviewerDue: string;
  };
}

/**
 * Batch 9: a documents organization — an HR records administrator (every document permission),
 * an employee, a manager who reads only up to manager-visible documents, and an administrator
 * of another organization (who must never reach this one's files).
 */
export interface RealStackDocumentsSeed {
  organizationId: string;
  organizationName: string;
  hr: { email: string; password: string; name: string };
  employee: {
    email: string;
    password: string;
    name: string;
    employeeId: string;
  };
  manager: { email: string; password: string; name: string };
  outsider: { email: string; password: string; name: string };
  typeName: string;
}

/** Batch 7C: a benefits organization with a salaried member on a pay group. */
export interface RealStackBenefitsSeed {
  organizationId: string;
  organizationName: string;
  admin: { email: string; password: string; name: string };
  /** Security remediation M2: approves and finalizes the benefits organization's payroll. */
  approver: { email: string; password: string; name: string };
  member: {
    email: string;
    password: string;
    name: string;
    employeeNumber: string;
  };
  departmentName: string;
  positionName: string;
  payGroupName: string;
  /** The bi-weekly calendar's first period (ended before the reference date). */
  anchorDate: string;
  periodEnd: string;
  planStart: string;
}

/**
 * Batch R4-A: an organization of its own (so the other flows are untouched) with an employee
 * holding two simultaneous assignments, an assignment past its end date, a holiday, and a
 * published shift corrected after attendance was recorded against it, with its own HR
 * administrator and time manager.
 */
export interface RealStackR4aSeed {
  organizationId: string;
  organizationName: string;
  hr: { email: string; password: string; name: string };
  manager: { email: string; password: string; name: string };
  casey: { email: string; password: string; name: string; employeeId: string };
  lifeguardPositionName: string;
  coachPositionName: string;
  lifeguardAssignmentId: string;
  coachAssignmentId: string;
  /** Sam: an office assignment past its end date, and a coach assignment that continues. */
  sam: { employeeId: string; name: string; officePositionName: string };
  /** Drew: one assignment, terminated by the spec (an end that belongs to a termination). */
  drew: { employeeId: string; name: string; positionName: string };
  holidayName: string;
  /** A holiday of the main organization on the same date: never shown for this one. */
  otherOrganizationHolidayName: string;
  holidayDate: string;
  changedShift: { workDate: string; exceptionId: string; scheduleName: string };
}

/**
 * Batch R5-B: Positions in an organization of its own — two departments, an active job title and
 * work location, and a position staffed by an employee (employment history: its identity can no
 * longer change, its name can). The administrator manages the whole structure; the manager reads
 * it all but manages the Operations department only (the demo's structure-manager shape).
 */
export interface RealStackR5bSeed {
  organizationId: string;
  organizationName: string;
  admin: { email: string; password: string; name: string };
  manager: { email: string; password: string; name: string };
  managerDepartment: { id: string; name: string; code: string };
  /** Holds the staffed position: outside the manager's department. */
  otherDepartment: { id: string; name: string; code: string };
  jobTitle: { id: string; name: string; code: string };
  workLocation: { id: string; name: string; code: string };
  staffedPosition: { id: string; name: string; code: string };
}

export interface RealStackSeed {
  suffix: string;
  organizationName: string;
  employee: { email: string; password: string; name: string };
  manager: { email: string; password: string; name: string };
  /** Batch 5C: an HR administrator (lifecycle, structure, physical sites). */
  hr: { email: string; password: string; name: string };
  /** Batch 5C: the seeded employee's record and assignment. */
  employeeId: string;
  assignmentId: string;
  /**
   * Batch 5D: a second employee for the destructive lifecycle flow (transfer, immediate
   * termination, access review, revocation, rehire) — never the attendance employee.
   */
  lifecycleEmployee: { employeeId: string; name: string; email: string };
  /** The position the lifecycle employee is transferred into. */
  transferPositionName: string;
  positionName: string;
  /** The organization's timezone and the reference every date below derives from. */
  timezone: string;
  referenceInstant: string;
  referenceDate: string;
  pastEntry: { workDate: string; clockOut: string; correctedClockOut: string };
  /**
   * The ended week the flow works in. Batch 4C: the organization has no payroll; the browser
   * flow generates this period and its timesheets through the attendance-only Time routes.
   */
  period: { startDate: string; endDate: string };
  organizationId: string;
  /** A LONG_SHIFT review exception on the past record, which the manager resolves (Batch 4C). */
  exceptionId: string;
  /** Batch 6A: a separate organization for the payroll flow (no production data). */
  payroll: RealStackPayrollSeed;
  /** Batch 6B: a separate organization for the leave flow (no production data). */
  leave: RealStackLeaveSeed;
  /** Batch 7A: a separate organization for recruitment to onboarding (no production data). */
  recruitment: RealStackRecruitmentSeed;
  /** Batch 7B: a separate organization for a performance review cycle (no production data). */
  performance: RealStackPerformanceSeed;
  /** Batch 7C: a separate organization for benefits and their payroll (no production data). */
  benefits: RealStackBenefitsSeed;
  /** Batch 9: a separate organization for document files (no production data). */
  documents: RealStackDocumentsSeed;
  /** Security remediation M1: cross-organization login-access administration. */
  m1: RealStackM1Seed;
  /** Security remediation M3: termination revokes the grants in the terminated organization. */
  m3: RealStackM3Seed;
  /** Batch R4-A: the workflow-completion organization (see RealStackR4aSeed). */
  r4a: RealStackR4aSeed;
  /** Batch R5-B: the Positions organization (see RealStackR5bSeed). */
  r5b: RealStackR5bSeed;
}

/**
 * Security remediation M3: an administrator of its own organization (employee and role
 * management) and an employee there whose login holds one role in that organization only.
 */
export interface RealStackM3Seed {
  admin: { email: string; password: string; name: string };
  leaver: { employeeId: string; name: string; roleName: string };
  /**
   * Decision A: a terminated employee whose approved, applied keep ended an hour ago and has
   * not been reconciled — the login is still enabled until the reconciliation job runs.
   */
  keeper: {
    employeeId: string;
    name: string;
    email: string;
    password: string;
    roleName: string;
  };
  /**
   * Final M3 change: a due scheduled termination with an approved KEEP whose approver has since
   * lost their authority — applying it must revoke the grant, not retain it.
   */
  invalidated: { employeeId: string; name: string; roleName: string };
}

/**
 * Security remediation M1: a login-access administrator of its own organization only; an
 * employee there whose login also holds a role in the payroll organization (outside the
 * administrator's scope); and a former employee whose assignment ended ten days ago.
 */
export interface RealStackM1Seed {
  admin: { email: string; password: string; name: string };
  outsideScope: { employeeId: string; name: string };
  former: { employeeId: string; name: string };
  /** Never shown to the administrator. */
  otherOrganizationName: string;
}

export async function seedRealStack(
  prisma: PrismaService,
  passwords: PasswordHasherService,
  dates: RealStackDatePlan,
): Promise<RealStackSeed> {
  await new AuthorizationCatalogService(prisma).sync();
  const suffix = randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase();
  const password = `Rs-${randomBytes(9).toString('base64url')}-9`;
  const passwordHash = await passwords.hashPassword(password);
  const now = new Date(dates.referenceInstant);
  const dateColumn = (date: string) => new Date(`${date}T00:00:00.000Z`);

  return prisma.$transaction(
    async (tx) => {
      const organization = await tx.organization.create({
        data: {
          name: `Real Stack Org ${suffix}`,
          code: `${REAL_STACK_ORGANIZATION_CODE_PREFIX}${suffix}`,
          timezone: dates.timezone,
        },
      });
      const jobTitle = await tx.jobTitle.create({
        data: {
          organizationId: organization.id,
          name: 'Associate',
          code: `RSJ-${suffix}`,
        },
      });
      const positionName = `Front Desk Associate ${suffix}`;
      const position = await tx.position.create({
        data: {
          organizationId: organization.id,
          jobTitleId: jobTitle.id,
          name: positionName,
          code: `RSP-${suffix}`,
        },
      });
      await tx.timeAttendancePolicy.create({
        data: {
          scopeType: 'ORGANIZATION',
          organizationId: organization.id,
          effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
          config: {
            clock: { mode: 'LIVE_CLOCK' },
            breaks: { mode: 'MANUAL_PUNCH' },
            correction: { employeeRequestsEnabled: true },
          },
        },
      });

      const permissionIds = async (keys: readonly string[]) => {
        const rows = await tx.permission.findMany({
          where: { key: { in: [...keys] } },
          select: { id: true, key: true },
        });
        const missing = keys.filter(
          (key) => !rows.some((row) => row.key === key),
        );
        if (missing.length > 0) {
          throw new Error(`Unknown permissions: ${missing.join(', ')}`);
        }
        return rows.map((row) => row.id);
      };
      const grant = async (
        userId: string,
        label: string,
        keys: readonly string[],
        organizationId: string = organization.id,
      ) => {
        const role = await tx.role.create({
          data: {
            organizationId,
            code: `RS-${label}-${suffix}`,
            name: `Real stack ${label}`,
          },
        });
        for (const permissionId of await permissionIds(keys)) {
          await tx.rolePermission.create({
            data: { roleId: role.id, permissionId },
          });
        }
        await tx.roleAssignment.create({
          data: {
            userId,
            roleId: role.id,
            roleOrganizationId: organizationId,
            scopeType: 'ORGANIZATION',
            organizationId,
          },
        });
      };
      const account = async (
        label: string,
        firstName: string,
        lastName: string,
      ) => {
        const email = `${label}-${suffix.toLowerCase()}${REAL_STACK_EMAIL_DOMAIN}`;
        const person = await tx.person.create({
          data: { firstName, lastName, personalEmail: email },
        });
        const user = await tx.user.create({
          data: {
            personId: person.id,
            email,
            passwordHash,
            status: 'ACTIVE',
            emailVerifiedAt: now,
            passwordChangedAt: now,
            mustChangePassword: false,
          },
        });
        return { personId: person.id, userId: user.id, email };
      };

      const employeeAccount = await account(
        'employee',
        'Riley',
        `Tester${suffix}`,
      );
      const employee = await tx.employee.create({
        data: {
          personId: employeeAccount.personId,
          employeeNumber: `RS${suffix}`,
          hireDate: new Date('2026-01-01T00:00:00.000Z'),
        },
      });
      const assignment = await tx.employmentAssignment.create({
        data: {
          employeeId: employee.id,
          positionId: position.id,
          employmentType: 'FULL_TIME',
          status: 'ACTIVE',
          isPrimary: true,
          startDate: new Date('2026-01-01T00:00:00.000Z'),
        },
      });
      await grant(employeeAccount.userId, 'EMP', EMPLOYEE_PERMISSIONS);

      const managerAccount = await account(
        'manager',
        'Morgan',
        `Lead${suffix}`,
      );
      await grant(managerAccount.userId, 'MGR', MANAGER_PERMISSIONS);
      const hrAccount = await account('hr', 'Harper', `Admin${suffix}`);
      await grant(hrAccount.userId, 'HR', HR_PERMISSIONS);

      // Batch 5D: Jordan, with a login and a self-service grant, in a second organization (so
      // the attendance flow's organization is untouched), with an empty position to be
      // transferred into. HR administers both organizations.
      const lifecycleOrganization = await tx.organization.create({
        data: {
          name: `Real Stack Lifecycle Org ${suffix}`,
          code: `${REAL_STACK_ORGANIZATION_CODE_PREFIX}L${suffix}`,
          timezone: dates.timezone,
        },
      });
      const lifecycleJobTitle = await tx.jobTitle.create({
        data: {
          organizationId: lifecycleOrganization.id,
          name: 'Coordinator',
          code: `RSJL-${suffix}`,
        },
      });
      await grant(
        hrAccount.userId,
        'HRL',
        HR_PERMISSIONS,
        lifecycleOrganization.id,
      );
      const jordanPosition = await tx.position.create({
        data: {
          organizationId: lifecycleOrganization.id,
          jobTitleId: lifecycleJobTitle.id,
          name: `Office Coordinator ${suffix}`,
          code: `RSO-${suffix}`,
        },
      });
      const transferPositionName = `Records Lead ${suffix}`;
      await tx.position.create({
        data: {
          organizationId: lifecycleOrganization.id,
          jobTitleId: lifecycleJobTitle.id,
          name: transferPositionName,
          code: `RSR-${suffix}`,
        },
      });
      const jordanAccount = await account(
        'jordan',
        'Jordan',
        `Lifecycle${suffix}`,
      );
      const jordan = await tx.employee.create({
        data: {
          personId: jordanAccount.personId,
          employeeNumber: `RSJ${suffix}`,
          hireDate: new Date('2026-01-01T00:00:00.000Z'),
        },
      });
      await tx.employmentAssignment.create({
        data: {
          employeeId: jordan.id,
          positionId: jordanPosition.id,
          employmentType: 'FULL_TIME',
          status: 'ACTIVE',
          isPrimary: true,
          startDate: new Date('2026-01-01T00:00:00.000Z'),
        },
      });
      await grant(
        jordanAccount.userId,
        'JORDAN',
        EMPLOYEE_PERMISSIONS,
        lifecycleOrganization.id,
      );

      // The day before the reference date, 09:00–12:00 local, as if recorded by a manager; the
      // employee corrects its end.
      const pastEntry = await tx.timeEntry.create({
        data: {
          employeeId: employee.id,
          employmentAssignmentId: assignment.id,
          clockInAt: dates.pastEntry.clockInAt,
          clockOutAt: dates.pastEntry.clockOutAt,
          timezone: dates.timezone,
          workDate: dateColumn(dates.pastEntry.workDate),
          status: 'CLOSED',
          source: 'MANUAL',
        },
      });

      // Batch 4C: no time period or timesheet here (nor any payroll): the flow creates them
      // through POST /time/periods/generate and /materialize-timesheets. The past record
      // carries one review exception for the manager to resolve.
      const exception = await tx.attendanceException.create({
        data: {
          employeeId: employee.id,
          employmentAssignmentId: assignment.id,
          timeEntryId: pastEntry.id,
          type: 'LONG_SHIFT',
          severity: 'REVIEW',
          workflowImpact: 'NON_BLOCKING',
          detectedAt: now,
          reason: 'The shift was longer than expected.',
        },
      });

      // Batch 6A: payroll in its own organization — an administrator, a salaried employee in a
      // pay group, and nothing else (the browser flow creates the calendar, the period, the run
      // and the adjustments). The first period starts four weeks before the reference date, so
      // it has ended and been paid by then.
      const payrollOrganization = await tx.organization.create({
        data: {
          name: `Real Stack Payroll Org ${suffix}`,
          code: `${REAL_STACK_ORGANIZATION_CODE_PREFIX}P${suffix}`,
          timezone: dates.timezone,
        },
      });
      const payrollJobTitle = await tx.jobTitle.create({
        data: {
          organizationId: payrollOrganization.id,
          name: 'Analyst',
          code: `RSJP-${suffix}`,
        },
      });
      const payrollPositionName = `Payroll Analyst ${suffix}`;
      const payrollPosition = await tx.position.create({
        data: {
          organizationId: payrollOrganization.id,
          jobTitleId: payrollJobTitle.id,
          name: payrollPositionName,
          code: `RSPP-${suffix}`,
        },
      });
      const payGroupCode = `RSBW-${suffix}`;
      const payGroup = await tx.payGroup.create({
        data: {
          organizationId: payrollOrganization.id,
          code: payGroupCode,
          name: `Bi-weekly ${suffix}`,
        },
      });
      const payrollAdminAccount = await account(
        'payroll',
        'Parker',
        `Payroll${suffix}`,
      );
      await grant(
        payrollAdminAccount.userId,
        'PAY',
        PAYROLL_ADMIN_PERMISSIONS,
        payrollOrganization.id,
      );
      // M2: an independent approver, and an approver who authored the payee's compensation.
      const payrollApproverAccount = await account(
        'payapprover',
        'Quinn',
        `Approver${suffix}`,
      );
      await grant(
        payrollApproverAccount.userId,
        'PAYAPP',
        PAYROLL_APPROVER_PERMISSIONS,
        payrollOrganization.id,
      );
      const compensationApproverAccount = await account(
        'compapprover',
        'Casey',
        `Compensation${suffix}`,
      );
      await grant(
        compensationApproverAccount.userId,
        'PAYCMP',
        PAYROLL_APPROVER_PERMISSIONS,
        payrollOrganization.id,
      );
      const payeeAccount = await account('payee', 'Avery', `Payee${suffix}`);
      const payee = await tx.employee.create({
        data: {
          personId: payeeAccount.personId,
          employeeNumber: `RSP${suffix}`,
          hireDate: new Date('2026-01-01T00:00:00.000Z'),
        },
      });
      const payeeAssignment = await tx.employmentAssignment.create({
        data: {
          employeeId: payee.id,
          positionId: payrollPosition.id,
          employmentType: 'FULL_TIME',
          status: 'ACTIVE',
          isPrimary: true,
          startDate: new Date('2026-01-01T00:00:00.000Z'),
        },
      });
      await tx.compensationRecord.create({
        data: {
          employmentAssignmentId: payeeAssignment.id,
          organizationId: payrollOrganization.id,
          recordType: 'INITIAL',
          payBasis: 'SALARY',
          salaryArrangement: 'ANNUAL',
          rateAmount: '52000',
          currency: 'CAD',
          effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
          payGroupId: payGroup.id,
          // M2: authored by someone who may approve payroll (refused for this run).
          createdByUserId: compensationApproverAccount.userId,
        },
      });
      await grant(
        payeeAccount.userId,
        'PAYEE',
        EMPLOYEE_PERMISSIONS,
        payrollOrganization.id,
      );
      // Batch 6B: leave in its own organization — a leave administrator, two teammates and one
      // employee of another team, a leave type with an organization policy, and a holiday.
      const leaveOrganization = await tx.organization.create({
        data: {
          name: `Real Stack Leave Org ${suffix}`,
          code: `${REAL_STACK_ORGANIZATION_CODE_PREFIX}V${suffix}`,
          timezone: dates.timezone,
        },
      });
      const leaveJobTitle = await tx.jobTitle.create({
        data: {
          organizationId: leaveOrganization.id,
          name: 'Officer',
          code: `RSJV-${suffix}`,
        },
      });
      const team = (name: string, code: string) =>
        tx.team.create({
          data: { organizationId: leaveOrganization.id, name, code },
        });
      const frontOffice = await team(
        `Front Office ${suffix}`,
        `RSTF-${suffix}`,
      );
      const backOffice = await team(`Back Office ${suffix}`, `RSTB-${suffix}`);
      const leavePosition = (name: string, code: string, teamId: string) =>
        tx.position.create({
          data: {
            organizationId: leaveOrganization.id,
            jobTitleId: leaveJobTitle.id,
            teamId,
            name,
            code,
          },
        });
      const frontPositionName = `Front Officer ${suffix}`;
      const frontPosition = await leavePosition(
        frontPositionName,
        `RSPF-${suffix}`,
        frontOffice.id,
      );
      const backPosition = await leavePosition(
        `Back Officer ${suffix}`,
        `RSPB-${suffix}`,
        backOffice.id,
      );
      const leaveEmployee = async (
        label: string,
        firstName: string,
        lastName: string,
        positionId: string,
      ) => {
        const login = await account(label, firstName, lastName);
        const employee = await tx.employee.create({
          data: {
            personId: login.personId,
            employeeNumber: `RS${label.slice(0, 2).toUpperCase()}${suffix}`,
            hireDate: new Date('2026-01-01T00:00:00.000Z'),
          },
        });
        await tx.employmentAssignment.create({
          data: {
            employeeId: employee.id,
            positionId,
            employmentType: 'FULL_TIME',
            status: 'ACTIVE',
            isPrimary: true,
            startDate: new Date('2026-01-01T00:00:00.000Z'),
          },
        });
        await grant(
          login.userId,
          `L${label.slice(0, 3).toUpperCase()}`,
          LEAVE_SELF_PERMISSIONS,
          leaveOrganization.id,
        );
        return { ...login, employee, name: `${firstName} ${lastName}` };
      };
      const taylor = await leaveEmployee(
        'taylor',
        'Taylor',
        `Absent${suffix}`,
        frontPosition.id,
      );
      const quinn = await leaveEmployee(
        'quinn',
        'Quinn',
        `Teammate${suffix}`,
        frontPosition.id,
      );
      const rowan = await leaveEmployee(
        'rowan',
        'Rowan',
        `Elsewhere${suffix}`,
        backPosition.id,
      );
      const leaveAdmin = await account('leaveadmin', 'Lee', `Leave${suffix}`);
      await grant(
        leaveAdmin.userId,
        'LADM',
        LEAVE_ADMIN_PERMISSIONS,
        leaveOrganization.id,
      );
      const leaveTypeName = `Family leave ${suffix}`;
      const leaveType = await tx.leaveType.create({
        data: {
          organizationId: leaveOrganization.id,
          code: `FAM${suffix}`,
          name: leaveTypeName,
          classification: 'UNPAID',
          tracksBalance: false,
        },
      });
      await tx.leavePolicy.create({
        data: {
          leaveTypeId: leaveType.id,
          organizationId: leaveOrganization.id,
          scopeType: 'ORGANIZATION',
          effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
        },
      });
      const leaveStart = mondayOnOrAfter(addDays(dates.referenceDate, 7));
      const leaveEnd = addDays(leaveStart, 1);
      const holidayName = `Founders Day ${suffix}`;
      await tx.organizationHoliday.create({
        data: {
          organizationId: leaveOrganization.id,
          date: new Date(`${leaveEnd}T00:00:00.000Z`),
          name: holidayName,
          kind: 'STATUTORY_HOLIDAY',
        },
      });

      // Batch 7A: recruitment to onboarding in its own organization — a standard Recruiter, a
      // hirer who also onboards, an employee who is hiring manager and interviewer, a vacant
      // position in a team, the default hiring stages and a default onboarding template.
      const recruitmentOrganization = await tx.organization.create({
        data: {
          name: `Real Stack Recruitment Org ${suffix}`,
          code: `${REAL_STACK_ORGANIZATION_CODE_PREFIX}R${suffix}`,
          timezone: dates.timezone,
        },
      });
      const recruitmentJobTitle = await tx.jobTitle.create({
        data: {
          organizationId: recruitmentOrganization.id,
          name: 'Educator',
          code: `RSJR-${suffix}`,
        },
      });
      const learningTeam = await tx.team.create({
        data: {
          organizationId: recruitmentOrganization.id,
          name: `Learning Team ${suffix}`,
          code: `RSTR-${suffix}`,
        },
      });
      const teacherPositionName = `Teacher ${suffix}`;
      await tx.position.create({
        data: {
          organizationId: recruitmentOrganization.id,
          jobTitleId: recruitmentJobTitle.id,
          teamId: learningTeam.id,
          name: teacherPositionName,
          code: `RSPT-${suffix}`,
        },
      });
      const leadPosition = await tx.position.create({
        data: {
          organizationId: recruitmentOrganization.id,
          jobTitleId: recruitmentJobTitle.id,
          teamId: learningTeam.id,
          name: `Lead Teacher ${suffix}`,
          code: `RSPL-${suffix}`,
        },
      });
      const interviewerAccount = await account(
        'sam',
        'Sam',
        `Interviewer${suffix}`,
      );
      const interviewerEmployee = await tx.employee.create({
        data: {
          personId: interviewerAccount.personId,
          employeeNumber: `RSSM${suffix}`,
          hireDate: new Date('2026-01-01T00:00:00.000Z'),
        },
      });
      await tx.employmentAssignment.create({
        data: {
          employeeId: interviewerEmployee.id,
          positionId: leadPosition.id,
          employmentType: 'FULL_TIME',
          status: 'ACTIVE',
          isPrimary: true,
          startDate: new Date('2026-01-01T00:00:00.000Z'),
        },
      });
      const recruiterAccount = await account(
        'recruiter',
        'Robin',
        `Recruit${suffix}`,
      );
      await grant(
        recruiterAccount.userId,
        'RREC',
        RECRUITER_PERMISSIONS,
        recruitmentOrganization.id,
      );
      const hirerAccount = await account('hirer', 'Hollis', `Hire${suffix}`);
      await grant(
        hirerAccount.userId,
        'RHIR',
        HIRER_PERMISSIONS,
        recruitmentOrganization.id,
      );
      for (const [index, stage] of DEFAULT_STAGES.entries()) {
        await tx.recruitmentStage.create({
          data: {
            organizationId: recruitmentOrganization.id,
            code: stage.code,
            name: stage.name,
            kind: stage.kind,
            sortOrder: (index + 1) * 10,
          },
        });
      }
      const templateName = `New teacher onboarding ${suffix}`;
      const employeeTaskTitle = `Sign the employment agreement ${suffix}`;
      const hrTaskTitle = `Prepare classroom keys ${suffix}`;
      const template = await tx.workflowTemplate.create({
        data: {
          organizationId: recruitmentOrganization.id,
          kind: 'ONBOARDING',
          code: `RSOB-${suffix}`,
          name: templateName,
        },
      });
      for (const [index, task] of [
        {
          title: employeeTaskTitle,
          category: 'PAPERWORK' as const,
          ownerType: 'EMPLOYEE' as const,
        },
        {
          title: hrTaskTitle,
          category: 'EQUIPMENT' as const,
          ownerType: 'HR' as const,
        },
      ].entries()) {
        await tx.workflowTemplateTask.create({
          data: {
            templateId: template.id,
            organizationId: recruitmentOrganization.id,
            sortOrder: (index + 1) * 10,
            dueOffsetDays: 0,
            ...task,
          },
        });
      }
      await tx.workflowTemplate.update({
        where: { id: template.id },
        data: { status: 'ACTIVE', activatedAt: now, isDefault: true },
      });

      // Batch 7B: performance in its own organization — an administrator, a manager and their
      // report (both with accounts), an active four-point scale and an active template.
      const performanceOrganization = await tx.organization.create({
        data: {
          name: `Real Stack Performance Org ${suffix}`,
          code: `${REAL_STACK_ORGANIZATION_CODE_PREFIX}K${suffix}`,
          timezone: dates.timezone,
        },
      });
      const performanceJobTitle = await tx.jobTitle.create({
        data: {
          organizationId: performanceOrganization.id,
          name: 'Teacher',
          code: `RSJP-${suffix}`,
        },
      });
      const performanceTeam = await tx.team.create({
        data: {
          organizationId: performanceOrganization.id,
          name: `Grade Team ${suffix}`,
          code: `RSTP-${suffix}`,
        },
      });
      const performancePosition = (name: string, code: string) =>
        tx.position.create({
          data: {
            organizationId: performanceOrganization.id,
            jobTitleId: performanceJobTitle.id,
            teamId: performanceTeam.id,
            name,
            code,
          },
        });
      const headPosition = await performancePosition(
        `Head Teacher ${suffix}`,
        `RSPH-${suffix}`,
      );
      const classPosition = await performancePosition(
        `Class Teacher ${suffix}`,
        `RSPC-${suffix}`,
      );
      const performanceEmployee = async (
        label: string,
        firstName: string,
        lastName: string,
        positionId: string,
        managerAssignmentId: string | null,
      ) => {
        const login = await account(label, firstName, lastName);
        const employee = await tx.employee.create({
          data: {
            personId: login.personId,
            employeeNumber: `RS${label.slice(0, 2).toUpperCase()}P${suffix}`,
            hireDate: new Date('2026-01-01T00:00:00.000Z'),
          },
        });
        const assignment = await tx.employmentAssignment.create({
          data: {
            employeeId: employee.id,
            positionId,
            employmentType: 'FULL_TIME',
            status: 'ACTIVE',
            isPrimary: true,
            startDate: new Date('2026-01-01T00:00:00.000Z'),
            managerAssignmentId,
          },
        });
        return { ...login, assignment, name: `${firstName} ${lastName}` };
      };
      const mel = await performanceEmployee(
        'mel',
        'Mel',
        `Manager${suffix}`,
        headPosition.id,
        null,
      );
      const pat = await performanceEmployee(
        'pat',
        'Pat',
        `Performer${suffix}`,
        classPosition.id,
        null,
      );
      await tx.employmentAssignment.update({
        where: { id: pat.assignment.id },
        data: { managerAssignmentId: mel.assignment.id },
      });
      const performanceHr = await account(
        'perfhr',
        'Hayden',
        `Review${suffix}`,
      );
      await grant(
        performanceHr.userId,
        'PHR',
        PERFORMANCE_HR_PERMISSIONS,
        performanceOrganization.id,
      );
      const performanceScale = await tx.performanceRatingScale.create({
        data: {
          organizationId: performanceOrganization.id,
          code: `RS4-${suffix}`,
          name: `Four point ${suffix}`,
        },
      });
      for (const [value, label] of [
        [1, 'Developing'],
        [2, 'Meets'],
        [3, 'Exceeds'],
        [4, 'Exceptional'],
      ] as const) {
        await tx.performanceRatingScaleLevel.create({
          data: { scaleId: performanceScale.id, value, label },
        });
      }
      await tx.performanceRatingScale.update({
        where: { id: performanceScale.id },
        data: { status: 'ACTIVE', activatedAt: now },
      });
      const performanceTemplateName = `Teacher review ${suffix}`;
      const performanceTemplate = await tx.performanceTemplate.create({
        data: {
          organizationId: performanceOrganization.id,
          code: `RSTR-${suffix}`,
          name: performanceTemplateName,
          scoringMode: 'NONE',
          ratingScaleId: performanceScale.id,
          overallRatingEnabled: true,
        },
      });
      const performanceSection = await tx.performanceTemplateSection.create({
        data: {
          templateId: performanceTemplate.id,
          title: 'Practice',
          sortOrder: 1,
        },
      });
      const ratingPrompt = `Classroom practice ${suffix}`;
      const textPrompt = `Highlights ${suffix}`;
      for (const [index, item] of [
        {
          itemType: 'RATING' as const,
          prompt: ratingPrompt,
          ratingScaleId: performanceScale.id,
        },
        { itemType: 'TEXT' as const, prompt: textPrompt },
      ].entries()) {
        await tx.performanceTemplateItem.create({
          data: {
            templateId: performanceTemplate.id,
            sectionId: performanceSection.id,
            organizationId: performanceOrganization.id,
            sortOrder: index + 1,
            respondent: 'BOTH',
            required: true,
            ...item,
          },
        });
      }
      await tx.performanceTemplate.update({
        where: { id: performanceTemplate.id },
        data: { status: 'ACTIVE', activatedAt: now },
      });
      const year = dates.referenceDate.slice(0, 4);

      // Batch 7C: benefits in their own organization — an administrator (benefits and payroll)
      // and a salaried member in a department (eligibility) on a pay group. The browser flow
      // creates the plan, its rates and rule, the dependent, the election and the payroll run.
      const benefitsOrganization = await tx.organization.create({
        data: {
          name: `Real Stack Benefits Org ${suffix}`,
          code: `${REAL_STACK_ORGANIZATION_CODE_PREFIX}B${suffix}`,
          timezone: dates.timezone,
        },
      });
      const benefitsJobTitle = await tx.jobTitle.create({
        data: {
          organizationId: benefitsOrganization.id,
          name: 'Coordinator',
          code: `RSJB-${suffix}`,
        },
      });
      const benefitsDepartmentName = `Member Services ${suffix}`;
      const benefitsDepartment = await tx.department.create({
        data: {
          organizationId: benefitsOrganization.id,
          name: benefitsDepartmentName,
          code: `RSDB-${suffix}`,
        },
      });
      await tx.department.create({
        data: {
          organizationId: benefitsOrganization.id,
          name: `Facilities ${suffix}`,
          code: `RSDF-${suffix}`,
        },
      });
      const benefitsPositionName = `Member Coordinator ${suffix}`;
      const benefitsPosition = await tx.position.create({
        data: {
          organizationId: benefitsOrganization.id,
          jobTitleId: benefitsJobTitle.id,
          departmentId: benefitsDepartment.id,
          name: benefitsPositionName,
          code: `RSPM-${suffix}`,
        },
      });
      const benefitsPayGroup = await tx.payGroup.create({
        data: {
          organizationId: benefitsOrganization.id,
          code: `RSBB-${suffix}`,
          name: `Benefits bi-weekly ${suffix}`,
        },
      });
      const benefitsAdmin = await account(
        'benefits',
        'Blair',
        `Benefits${suffix}`,
      );
      await grant(
        benefitsAdmin.userId,
        'BEN',
        BENEFITS_ADMIN_PERMISSIONS,
        benefitsOrganization.id,
      );
      // M2: the benefits organization's payroll is approved by someone else.
      const benefitsApprover = await account(
        'benapprover',
        'Drew',
        `Approver${suffix}`,
      );
      await grant(
        benefitsApprover.userId,
        'BENAPP',
        PAYROLL_APPROVER_PERMISSIONS,
        benefitsOrganization.id,
      );
      const memberAccount = await account(
        'member',
        'Morgan',
        `Member${suffix}`,
      );
      const member = await tx.employee.create({
        data: {
          personId: memberAccount.personId,
          employeeNumber: `RSB${suffix}`,
          hireDate: new Date('2026-01-01T00:00:00.000Z'),
        },
      });
      const memberAssignment = await tx.employmentAssignment.create({
        data: {
          employeeId: member.id,
          positionId: benefitsPosition.id,
          employmentType: 'FULL_TIME',
          status: 'ACTIVE',
          isPrimary: true,
          startDate: new Date('2026-01-01T00:00:00.000Z'),
        },
      });
      await tx.compensationRecord.create({
        data: {
          employmentAssignmentId: memberAssignment.id,
          organizationId: benefitsOrganization.id,
          recordType: 'INITIAL',
          payBasis: 'SALARY',
          salaryArrangement: 'ANNUAL',
          rateAmount: '52000',
          currency: 'CAD',
          effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
          payGroupId: benefitsPayGroup.id,
        },
      });
      await grant(
        memberAccount.userId,
        'MEMBER',
        EMPLOYEE_PERMISSIONS,
        benefitsOrganization.id,
      );

      // Batch 9: documents in their own organization. The browser flow uploads, reclassifies,
      // versions and downloads; another organization's administrator is refused.
      const documentsOrganization = await tx.organization.create({
        data: {
          name: `Real Stack Documents Org ${suffix}`,
          code: `${REAL_STACK_ORGANIZATION_CODE_PREFIX}D${suffix}`,
          timezone: dates.timezone,
        },
      });
      const documentsJobTitle = await tx.jobTitle.create({
        data: {
          organizationId: documentsOrganization.id,
          name: 'Records clerk',
          code: `RSJD-${suffix}`,
        },
      });
      const documentsPosition = await tx.position.create({
        data: {
          organizationId: documentsOrganization.id,
          jobTitleId: documentsJobTitle.id,
          name: `Records Clerk ${suffix}`,
          code: `RSPD-${suffix}`,
        },
      });
      const documentTypeName = `Employment agreement ${suffix}`;
      await tx.documentType.create({
        data: {
          organizationId: documentsOrganization.id,
          code: 'EMPLOYMENT-AGREEMENT',
          name: documentTypeName,
          category: 'EMPLOYMENT_AGREEMENT',
          defaultConfidentiality: 'EMPLOYEE_VISIBLE',
        },
      });
      const documentsHr = await account('dochr', 'Drew', `Records${suffix}`);
      await grant(
        documentsHr.userId,
        'DOCHR',
        DOCUMENTS_HR_PERMISSIONS,
        documentsOrganization.id,
      );
      const documentsEmployeeAccount = await account(
        'docemp',
        'Ellis',
        `Docs${suffix}`,
      );
      const documentsEmployee = await tx.employee.create({
        data: {
          personId: documentsEmployeeAccount.personId,
          employeeNumber: `RSD${suffix}`,
          hireDate: new Date('2026-01-01T00:00:00.000Z'),
        },
      });
      await tx.employmentAssignment.create({
        data: {
          employeeId: documentsEmployee.id,
          positionId: documentsPosition.id,
          employmentType: 'FULL_TIME',
          status: 'ACTIVE',
          isPrimary: true,
          startDate: new Date('2026-01-01T00:00:00.000Z'),
        },
      });
      await grant(
        documentsEmployeeAccount.userId,
        'DOCEMP',
        EMPLOYEE_PERMISSIONS,
        documentsOrganization.id,
      );
      const documentsManager = await account('docmgr', 'Mika', `Lead${suffix}`);
      await grant(
        documentsManager.userId,
        'DOCMGR',
        DOCUMENTS_MANAGER_PERMISSIONS,
        documentsOrganization.id,
      );
      const documentsOutsider = await account(
        'docout',
        'Oakley',
        `Outside${suffix}`,
      );
      await grant(
        documentsOutsider.userId,
        'DOCOUT',
        DOCUMENTS_HR_PERMISSIONS,
        benefitsOrganization.id,
      );

      // Security remediation M1 (see RealStackM1Seed), in its own organization so the other
      // flows' organizations (and their timesheet counts) are untouched.
      const m1Organization = await tx.organization.create({
        data: {
          name: `Real Stack M1 Org ${suffix}`,
          code: `${REAL_STACK_ORGANIZATION_CODE_PREFIX}M${suffix}`,
          timezone: dates.timezone,
        },
      });
      const m1JobTitle = await tx.jobTitle.create({
        data: {
          organizationId: m1Organization.id,
          name: 'Associate',
          code: `RSMJ-${suffix}`,
        },
      });
      const m1Position = await tx.position.create({
        data: {
          organizationId: m1Organization.id,
          jobTitleId: m1JobTitle.id,
          name: `M1 Associate ${suffix}`,
          code: `RSMP-${suffix}`,
        },
      });
      const m1Admin = await account('m1admin', 'Avery', `Access${suffix}`);
      await grant(
        m1Admin.userId,
        'M1ADMIN',
        ['employee.read', 'employee.account.manage'],
        m1Organization.id,
      );
      const m1Employee = async (
        label: string,
        firstName: string,
        assignment: { status: 'ACTIVE' | 'ENDED'; endDate?: string },
      ) => {
        const login = await account(label, firstName, `M1${suffix}`);
        const row = await tx.employee.create({
          data: {
            personId: login.personId,
            employeeNumber: `RS${label.toUpperCase()}${suffix}`,
            hireDate: new Date('2026-01-01T00:00:00.000Z'),
          },
        });
        await tx.employmentAssignment.create({
          data: {
            employeeId: row.id,
            positionId: m1Position.id,
            employmentType: 'FULL_TIME',
            status: assignment.status,
            isPrimary: true,
            startDate: new Date('2026-01-01T00:00:00.000Z'),
            ...(assignment.endDate
              ? { endDate: dateColumn(assignment.endDate) }
              : {}),
          },
        });
        return { ...login, employeeId: row.id };
      };
      const m1Outside = await m1Employee('m1outside', 'Sky', {
        status: 'ACTIVE',
      });
      await grant(
        m1Outside.userId,
        'M1OUT',
        ['employee.read'],
        payrollOrganization.id,
      );
      const m1Former = await m1Employee('m1former', 'Blake', {
        status: 'ENDED',
        endDate: addDays(dates.referenceDate, -10),
      });

      // Security remediation M3 (see RealStackM3Seed), in its own organization.
      const m3Organization = await tx.organization.create({
        data: {
          name: `Real Stack M3 Org ${suffix}`,
          code: `${REAL_STACK_ORGANIZATION_CODE_PREFIX}T${suffix}`,
          timezone: dates.timezone,
        },
      });
      const m3JobTitle = await tx.jobTitle.create({
        data: {
          organizationId: m3Organization.id,
          name: 'Coordinator',
          code: `RSTJ-${suffix}`,
        },
      });
      const m3Position = await tx.position.create({
        data: {
          organizationId: m3Organization.id,
          jobTitleId: m3JobTitle.id,
          name: `M3 Coordinator ${suffix}`,
          code: `RSTP-${suffix}`,
        },
      });
      const m3Admin = await account('m3admin', 'Rowan', `Offboard${suffix}`);
      await grant(
        m3Admin.userId,
        'M3ADMIN',
        ['employee.read', 'employee.manage', 'role.read', 'role.assign'],
        m3Organization.id,
      );
      const m3Leaver = await account('m3leaver', 'Quinn', `M3${suffix}`);
      const m3LeaverEmployee = await tx.employee.create({
        data: {
          personId: m3Leaver.personId,
          employeeNumber: `RSM3LEAVER${suffix}`,
          hireDate: new Date('2026-01-01T00:00:00.000Z'),
        },
      });
      await tx.employmentAssignment.create({
        data: {
          employeeId: m3LeaverEmployee.id,
          positionId: m3Position.id,
          employmentType: 'FULL_TIME',
          status: 'ACTIVE',
          isPrimary: true,
          startDate: new Date('2026-01-01T00:00:00.000Z'),
        },
      });
      await grant(
        m3Leaver.userId,
        'M3ROLE',
        ['employee.read'],
        m3Organization.id,
      );
      // Decision A (see RealStackM3Seed.keeper): terminated five days ago; the KEEP was requested
      // by the M3 administrator and approved by another; its replacement grant ended an hour ago.
      const m3Approver = await account(
        'm3approver',
        'Sasha',
        `Approve${suffix}`,
      );
      await grant(
        m3Approver.userId,
        'M3APPROVER',
        ['employee.read', 'employee.manage', 'role.read', 'role.assign'],
        m3Organization.id,
      );
      const m3Keeper = await account('m3keeper', 'Parker', `M3${suffix}`);
      const lastDay = dateColumn(addDays(dates.referenceDate, -5));
      const m3KeeperEmployee = await tx.employee.create({
        data: {
          personId: m3Keeper.personId,
          employeeNumber: `RSM3KEEPER${suffix}`,
          hireDate: new Date('2026-01-01T00:00:00.000Z'),
          status: 'TERMINATED',
          terminationDate: lastDay,
        },
      });
      await tx.employmentAssignment.create({
        data: {
          employeeId: m3KeeperEmployee.id,
          positionId: m3Position.id,
          employmentType: 'FULL_TIME',
          status: 'ENDED',
          isPrimary: true,
          startDate: new Date('2026-01-01T00:00:00.000Z'),
          endDate: lastDay,
        },
      });
      const keepRole = await tx.role.create({
        data: {
          organizationId: m3Organization.id,
          code: `RS-M3KEEP-${suffix}`,
          name: 'Real stack M3KEEP',
        },
      });
      for (const permissionId of await permissionIds(['employee.read'])) {
        await tx.rolePermission.create({
          data: { roleId: keepRole.id, permissionId },
        });
      }
      const appliedAt = new Date(now.getTime() - 4 * 86_400_000);
      const keptUntil = new Date(now.getTime() - 3_600_000);
      const keepGrant = {
        userId: m3Keeper.userId,
        roleId: keepRole.id,
        roleOrganizationId: m3Organization.id,
        scopeType: 'ORGANIZATION' as const,
        organizationId: m3Organization.id,
      };
      const original = await tx.roleAssignment.create({
        data: {
          ...keepGrant,
          startsAt: new Date('2026-01-01T00:00:00.000Z'),
          revokedAt: appliedAt,
          revocationReason: 'employment_terminated',
        },
      });
      const replacement = await tx.roleAssignment.create({
        data: { ...keepGrant, startsAt: appliedAt, expiresAt: keptUntil },
      });
      const keeperTermination = await tx.employeeTermination.create({
        data: {
          employeeId: m3KeeperEmployee.id,
          terminationDate: lastDay,
          status: 'APPLIED',
          recordedByUserId: m3Admin.userId,
          recordedAt: new Date(appliedAt.getTime() - 86_400_000),
          appliedAt,
          appliedSource: 'MANUAL',
        },
      });
      // Final M3 change (see RealStackM3Seed.invalidated).
      const m3Stale = await account('m3stale', 'Robin', `Stale${suffix}`);
      const staleRole = await tx.role.create({
        data: {
          organizationId: m3Organization.id,
          code: `RS-M3STALE-${suffix}`,
          name: 'Real stack M3STALE',
        },
      });
      for (const permissionId of await permissionIds([
        'employee.read',
        'employee.manage',
        'role.read',
        'role.assign',
      ])) {
        await tx.rolePermission.create({
          data: { roleId: staleRole.id, permissionId },
        });
      }
      await tx.roleAssignment.create({
        data: {
          userId: m3Stale.userId,
          roleId: staleRole.id,
          roleOrganizationId: m3Organization.id,
          scopeType: 'ORGANIZATION',
          organizationId: m3Organization.id,
          startsAt: new Date('2026-01-01T00:00:00.000Z'),
          // Approved the keep, then lost the authority.
          revokedAt: new Date(now.getTime() - 3_600_000),
        },
      });
      const m3Invalidated = await account('m3invalid', 'Casey', `M3${suffix}`);
      const invalidLastDay = dateColumn(addDays(dates.referenceDate, -2));
      const m3InvalidatedEmployee = await tx.employee.create({
        data: {
          personId: m3Invalidated.personId,
          employeeNumber: `RSM3INVALID${suffix}`,
          hireDate: new Date('2026-01-01T00:00:00.000Z'),
          terminationDate: invalidLastDay,
        },
      });
      const invalidatedAssignment = await tx.employmentAssignment.create({
        data: {
          employeeId: m3InvalidatedEmployee.id,
          positionId: m3Position.id,
          employmentType: 'FULL_TIME',
          status: 'ACTIVE',
          isPrimary: true,
          startDate: new Date('2026-01-01T00:00:00.000Z'),
          endDate: invalidLastDay,
        },
      });
      const invalidRole = await tx.role.create({
        data: {
          organizationId: m3Organization.id,
          code: `RS-M3INVALID-${suffix}`,
          name: 'Real stack M3INVALID',
        },
      });
      for (const permissionId of await permissionIds(['employee.read'])) {
        await tx.rolePermission.create({
          data: { roleId: invalidRole.id, permissionId },
        });
      }
      const invalidGrant = await tx.roleAssignment.create({
        data: {
          userId: m3Invalidated.userId,
          roleId: invalidRole.id,
          roleOrganizationId: m3Organization.id,
          scopeType: 'ORGANIZATION',
          organizationId: m3Organization.id,
          startsAt: new Date('2026-01-01T00:00:00.000Z'),
        },
      });
      const invalidTermination = await tx.employeeTermination.create({
        data: {
          employeeId: m3InvalidatedEmployee.id,
          terminationDate: invalidLastDay,
          recordedByUserId: m3Admin.userId,
          recordedAt: new Date(now.getTime() - 3 * 86_400_000),
        },
      });
      await tx.employeeTerminationAssignment.create({
        data: {
          terminationId: invalidTermination.id,
          employmentAssignmentId: invalidatedAssignment.id,
          action: 'END',
          previousStatus: 'ACTIVE',
          previousEndDate: null,
        },
      });
      await tx.employeeTerminationGrantDecision.create({
        data: {
          terminationId: invalidTermination.id,
          roleAssignmentId: invalidGrant.id,
          decision: 'KEEP',
          status: 'APPROVED',
          reason: 'Handing over the open requests',
          keepUntil: new Date(now.getTime() + 5 * 86_400_000),
          requestedByUserId: m3Admin.userId,
          requestedAt: new Date(now.getTime() - 3 * 86_400_000),
          reviewedByUserId: m3Stale.userId,
          reviewedAt: new Date(now.getTime() - 2 * 86_400_000),
        },
      });

      await tx.employeeTerminationGrantDecision.create({
        data: {
          terminationId: keeperTermination.id,
          roleAssignmentId: original.id,
          decision: 'KEEP',
          status: 'APPROVED',
          reason: 'Handing over the open requests',
          keepUntil: keptUntil,
          requestedByUserId: m3Admin.userId,
          requestedAt: new Date(appliedAt.getTime() - 86_400_000),
          reviewedByUserId: m3Approver.userId,
          reviewedAt: new Date(appliedAt.getTime() - 3_600_000),
          appliedAt,
          outcome: 'RETAINED',
          retainedRoleAssignmentId: replacement.id,
        },
      });

      const anchorDate = addDays(dates.referenceDate, -28);
      const periodEnd = addDays(anchorDate, 13);

      // ─── Batch R4-A ─────────────────────────────────────────────────────────────
      const r4aOrganization = await tx.organization.create({
        data: {
          name: `Real Stack R4A Org ${suffix}`,
          code: `${REAL_STACK_ORGANIZATION_CODE_PREFIX}A${suffix}`,
          timezone: dates.timezone,
        },
      });
      const r4aJobTitle = await tx.jobTitle.create({
        data: {
          organizationId: r4aOrganization.id,
          name: 'Aquatics',
          code: `RSJA-${suffix}`,
        },
      });
      const r4aPosition = (name: string, code: string) =>
        tx.position.create({
          data: {
            organizationId: r4aOrganization.id,
            jobTitleId: r4aJobTitle.id,
            name,
            code: `${code}-${suffix}`,
          },
        });
      const lifeguardPositionName = `Lifeguard ${suffix}`;
      const coachPositionName = `Swim Coach ${suffix}`;
      const officePositionName = `Pool Office ${suffix}`;
      const drewPositionName = `Pool Attendant ${suffix}`;
      const lifeguardPosition = await r4aPosition(
        lifeguardPositionName,
        'RSAL',
      );
      const coachPosition = await r4aPosition(coachPositionName, 'RSAC');
      const officePosition = await r4aPosition(officePositionName, 'RSAO');
      const drewPosition = await r4aPosition(drewPositionName, 'RSAD');
      await tx.timeAttendancePolicy.create({
        data: {
          scopeType: 'ORGANIZATION',
          organizationId: r4aOrganization.id,
          effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
          config: {
            clock: { mode: 'LIVE_CLOCK' },
            breaks: { mode: 'MANUAL_PUNCH' },
            correction: { employeeRequestsEnabled: true },
          },
        },
      });
      // Its own HR administrator and time manager (separate logins, so the other flows' login
      // rate limits are untouched; scheduling read for the manager's grid and shift history).
      const r4aHr = await account('r4ahr', 'Avery', `People${suffix}`);
      await grant(r4aHr.userId, 'HRA', HR_PERMISSIONS, r4aOrganization.id);
      const r4aManager = await account('r4amgr', 'Blake', `Shifts${suffix}`);
      await grant(
        r4aManager.userId,
        'MGRA',
        [...MANAGER_PERMISSIONS, 'schedule.read'],
        r4aOrganization.id,
      );
      const r4aAssignment = (
        employeeId: string,
        positionId: string,
        isPrimary: boolean,
        endDate: string | null = null,
      ) =>
        tx.employmentAssignment.create({
          data: {
            employeeId,
            positionId,
            employmentType: isPrimary ? 'FULL_TIME' : 'PART_TIME',
            status: 'ACTIVE',
            isPrimary,
            startDate: new Date('2026-01-01T00:00:00.000Z'),
            ...(endDate ? { endDate: dateColumn(endDate) } : {}),
          },
        });
      // Casey: two simultaneous assignments in this organization.
      const caseyAccount = await account('casey', 'Casey', `Cover${suffix}`);
      const casey = await tx.employee.create({
        data: {
          personId: caseyAccount.personId,
          employeeNumber: `RSR4C${suffix}`,
          hireDate: new Date('2026-01-01T00:00:00.000Z'),
        },
      });
      const lifeguard = await r4aAssignment(
        casey.id,
        lifeguardPosition.id,
        true,
      );
      const coach = await r4aAssignment(casey.id, coachPosition.id, false);
      await grant(
        caseyAccount.userId,
        'CASEY',
        EMPLOYEE_PERMISSIONS,
        r4aOrganization.id,
      );
      // Sam: the office assignment ended three days ago (still ACTIVE: no automation); coaching
      // continues, so applying the end must leave Sam employed.
      const samPerson = await tx.person.create({
        data: { firstName: 'Sam', lastName: `Overdue${suffix}` },
      });
      const sam = await tx.employee.create({
        data: {
          personId: samPerson.id,
          employeeNumber: `RSR4S${suffix}`,
          hireDate: new Date('2026-01-01T00:00:00.000Z'),
        },
      });
      await r4aAssignment(
        sam.id,
        officePosition.id,
        false,
        addDays(dates.referenceDate, -3),
      );
      await r4aAssignment(sam.id, coachPosition.id, true);
      // Drew: one assignment; the spec schedules Drew's termination through the API.
      const drewPerson = await tx.person.create({
        data: { firstName: 'Drew', lastName: `Leaving${suffix}` },
      });
      const drew = await tx.employee.create({
        data: {
          personId: drewPerson.id,
          employeeNumber: `RSR4D${suffix}`,
          hireDate: new Date('2026-01-01T00:00:00.000Z'),
        },
      });
      await r4aAssignment(drew.id, drewPosition.id, true);
      // Holidays on the reference date: this organization's, and the main organization's.
      const r4aHolidayName = `Pool Founders Day ${suffix}`;
      const otherOrganizationHolidayName = `Front Desk Day ${suffix}`;
      await tx.organizationHoliday.create({
        data: {
          organizationId: r4aOrganization.id,
          date: dateColumn(dates.referenceDate),
          name: r4aHolidayName,
          kind: 'STATUTORY_HOLIDAY',
        },
      });
      await tx.organizationHoliday.create({
        data: {
          organizationId: organization.id,
          date: dateColumn(dates.referenceDate),
          name: otherOrganizationHolidayName,
          kind: 'STATUTORY_HOLIDAY',
        },
      });
      // A published shift two days ago, r4aCorrected (revision 2) after Casey's attendance was
      // recorded against revision 1: the review signal the scheduling service raises.
      const shiftDate = addDays(dates.referenceDate, -2);
      const scheduleName = `Pool week ${suffix}`;
      const schedule = await tx.schedule.create({
        data: {
          scopeType: 'ORGANIZATION',
          organizationId: r4aOrganization.id,
          name: scheduleName,
          periodStart: dateColumn(addDays(shiftDate, -1)),
          periodEnd: dateColumn(addDays(shiftDate, 1)),
          type: 'AD_HOC',
          status: 'PUBLISHED',
          publishedAt: now,
          publishedByUserId: r4aManager.userId,
        },
      });
      const r4aOriginal = {
        startsAt: new Date(`${shiftDate}T13:00:00.000Z`),
        endsAt: new Date(`${shiftDate}T21:00:00.000Z`),
      };
      const r4aCorrected = {
        startsAt: new Date(`${shiftDate}T14:00:00.000Z`),
        endsAt: new Date(`${shiftDate}T20:00:00.000Z`),
      };
      const shift = await tx.scheduledShift.create({
        data: {
          scheduleId: schedule.id,
          employmentAssignmentId: lifeguard.id,
          workDate: dateColumn(shiftDate),
          ...r4aCorrected,
          timezone: dates.timezone,
        },
      });
      const revision = (
        revisionNumber: number,
        revisionType: 'PUBLISHED_BASELINE' | 'CORRECTED',
        window: { startsAt: Date; endsAt: Date },
        reason: string | null,
      ) =>
        tx.scheduledShiftRevision.create({
          data: {
            scheduledShiftId: shift.id,
            revisionNumber,
            revisionType,
            employmentAssignmentId: lifeguard.id,
            workDate: dateColumn(shiftDate),
            ...window,
            timezone: dates.timezone,
            status: 'ACTIVE',
            sourceType: 'MANUAL',
            reason,
            changedByUserId: r4aManager.userId,
          },
        });
      const first = await revision(1, 'PUBLISHED_BASELINE', r4aOriginal, null);
      const second = await revision(
        2,
        'CORRECTED',
        r4aCorrected,
        'Pool opened late',
      );
      const caseyEntry = await tx.timeEntry.create({
        data: {
          employeeId: casey.id,
          employmentAssignmentId: lifeguard.id,
          clockInAt: r4aOriginal.startsAt,
          clockOutAt: r4aOriginal.endsAt,
          timezone: dates.timezone,
          workDate: dateColumn(shiftDate),
          status: 'CLOSED',
          source: 'MANUAL',
          scheduledShiftId: shift.id,
          scheduledShiftRevisionId: first.id,
        },
      });
      const changedException = await tx.attendanceException.create({
        data: {
          employeeId: casey.id,
          employmentAssignmentId: lifeguard.id,
          timeEntryId: caseyEntry.id,
          type: 'SCHEDULE_CHANGED_AFTER_ATTENDANCE',
          severity: 'REVIEW',
          workflowImpact: 'NON_BLOCKING',
          status: 'OPEN',
          detectedAt: now,
          reason:
            'The scheduled shift was r4aCorrected after attendance was interpreted against it.',
          metadata: {
            scheduledShiftId: shift.id,
            interpretedRevisionId: first.id,
            interpretedRevisionNumber: 1,
            interpretedStartsAt: r4aOriginal.startsAt.toISOString(),
            interpretedEndsAt: r4aOriginal.endsAt.toISOString(),
            currentRevisionId: second.id,
            currentRevisionNumber: 2,
            currentRevisionType: 'CORRECTED',
            currentStatus: 'ACTIVE',
            currentStartsAt: r4aCorrected.startsAt.toISOString(),
            currentEndsAt: r4aCorrected.endsAt.toISOString(),
            change: 'CORRECTED',
          },
        },
      });

      // ─── Batch R5-B ─────────────────────────────────────────────────────────────
      // Positions in an organization of its own (see RealStackR5bSeed): two departments, an
      // active job title and work location, a staffed position in Finance, a structure
      // administrator over the organization, and a structure manager of Operations only.
      const r5bOrganization = await tx.organization.create({
        data: {
          name: `Real Stack R5B Org ${suffix}`,
          code: `${REAL_STACK_ORGANIZATION_CODE_PREFIX}S${suffix}`,
          timezone: dates.timezone,
        },
      });
      const r5bJobTitle = await tx.jobTitle.create({
        data: {
          organizationId: r5bOrganization.id,
          name: `Analyst ${suffix}`,
          code: `RSJS-${suffix}`,
        },
      });
      const r5bWorkLocation = await tx.workLocation.create({
        data: {
          organizationId: r5bOrganization.id,
          name: `Head Office ${suffix}`,
          code: `RSWS-${suffix}`,
          timezone: dates.timezone,
        },
      });
      const r5bDepartment = (name: string, code: string) =>
        tx.department.create({
          data: { organizationId: r5bOrganization.id, name, code },
        });
      const r5bOperations = await r5bDepartment(
        `Operations ${suffix}`,
        `RSDO-${suffix}`,
      );
      const r5bFinance = await r5bDepartment(
        `Finance ${suffix}`,
        `RSDN-${suffix}`,
      );
      const r5bStaffedPosition = await tx.position.create({
        data: {
          organizationId: r5bOrganization.id,
          jobTitleId: r5bJobTitle.id,
          workLocationId: r5bWorkLocation.id,
          departmentId: r5bFinance.id,
          name: `Finance Analyst ${suffix}`,
          code: `RSPS-${suffix}`,
        },
      });
      // Employment history on the position: its identity (job title, work location, placement)
      // can no longer change, but its name can.
      const r5bPerson = await tx.person.create({
        data: { firstName: 'Ellis', lastName: `Staffed${suffix}` },
      });
      const r5bEmployee = await tx.employee.create({
        data: {
          personId: r5bPerson.id,
          employeeNumber: `RSR5B${suffix}`,
          hireDate: new Date('2026-01-01T00:00:00.000Z'),
        },
      });
      await tx.employmentAssignment.create({
        data: {
          employeeId: r5bEmployee.id,
          positionId: r5bStaffedPosition.id,
          employmentType: 'FULL_TIME',
          status: 'ACTIVE',
          isPrimary: true,
          startDate: new Date('2026-01-01T00:00:00.000Z'),
        },
      });
      const r5bAdmin = await account(
        'r5badmin',
        'Morgan',
        `Structure${suffix}`,
      );
      await grant(
        r5bAdmin.userId,
        'STRA',
        STRUCTURE_PERMISSIONS,
        r5bOrganization.id,
      );
      // Like the demo's structure manager: reads the whole structure, manages one department.
      const r5bManager = await account('r5bmgr', 'Dana', `Operations${suffix}`);
      await grant(
        r5bManager.userId,
        'STRV',
        ['organization.read'],
        r5bOrganization.id,
      );
      const r5bManagerRole = await tx.role.create({
        data: {
          organizationId: r5bOrganization.id,
          code: `RS-STRD-${suffix}`,
          name: 'Real stack STRD',
        },
      });
      for (const permissionId of await permissionIds(STRUCTURE_PERMISSIONS)) {
        await tx.rolePermission.create({
          data: { roleId: r5bManagerRole.id, permissionId },
        });
      }
      await tx.roleAssignment.create({
        data: {
          userId: r5bManager.userId,
          roleId: r5bManagerRole.id,
          roleOrganizationId: r5bOrganization.id,
          scopeType: 'DEPARTMENT',
          organizationId: r5bOrganization.id,
          departmentId: r5bOperations.id,
        },
      });

      return {
        suffix,
        organizationName: organization.name,
        employee: {
          email: employeeAccount.email,
          password,
          name: `Riley Tester${suffix}`,
        },
        manager: {
          email: managerAccount.email,
          password,
          name: `Morgan Lead${suffix}`,
        },
        hr: { email: hrAccount.email, password, name: `Harper Admin${suffix}` },
        m1: {
          admin: {
            email: m1Admin.email,
            password,
            name: `Avery Access${suffix}`,
          },
          outsideScope: {
            employeeId: m1Outside.employeeId,
            name: `Sky M1${suffix}`,
          },
          former: {
            employeeId: m1Former.employeeId,
            name: `Blake M1${suffix}`,
          },
          otherOrganizationName: payrollOrganization.name,
        },
        m3: {
          admin: {
            email: m3Admin.email,
            password,
            name: `Rowan Offboard${suffix}`,
          },
          leaver: {
            employeeId: m3LeaverEmployee.id,
            name: `Quinn M3${suffix}`,
            roleName: 'Real stack M3ROLE',
          },
          invalidated: {
            employeeId: m3InvalidatedEmployee.id,
            name: `Casey M3${suffix}`,
            roleName: 'Real stack M3INVALID',
          },
          keeper: {
            employeeId: m3KeeperEmployee.id,
            name: `Parker M3${suffix}`,
            email: m3Keeper.email,
            password,
            roleName: 'Real stack M3KEEP',
          },
        },
        employeeId: employee.id,
        assignmentId: assignment.id,
        lifecycleEmployee: {
          employeeId: jordan.id,
          name: `Jordan Lifecycle${suffix}`,
          email: jordanAccount.email,
        },
        transferPositionName,
        positionName,
        timezone: dates.timezone,
        referenceInstant: dates.referenceInstant,
        referenceDate: dates.referenceDate,
        pastEntry: {
          workDate: dates.pastEntry.workDate,
          clockOut: '12:00',
          correctedClockOut: dates.pastEntry.correctedClockOutLocal,
        },
        period: dates.period,
        organizationId: organization.id,
        exceptionId: exception.id,
        payroll: {
          organizationId: payrollOrganization.id,
          organizationName: payrollOrganization.name,
          admin: {
            email: payrollAdminAccount.email,
            password,
            name: `Parker Payroll${suffix}`,
          },
          approver: {
            email: payrollApproverAccount.email,
            password,
            name: `Quinn Approver${suffix}`,
          },
          compensationApprover: {
            email: compensationApproverAccount.email,
            password,
            name: `Casey Compensation${suffix}`,
          },
          employee: {
            email: payeeAccount.email,
            password,
            name: `Avery Payee${suffix}`,
            employeeNumber: payee.employeeNumber,
          },
          payGroupName: payGroup.name,
          payGroupCode,
          positionName: payrollPositionName,
          anchorDate,
          periodEnd,
          payDate: addDays(periodEnd, 5),
          salaryGross: '2000.00',
        },
        leave: {
          organizationId: leaveOrganization.id,
          organizationName: leaveOrganization.name,
          admin: {
            email: leaveAdmin.email,
            password,
            name: `Lee Leave${suffix}`,
          },
          taylor: {
            email: taylor.email,
            password,
            name: taylor.name,
            employeeNumber: taylor.employee.employeeNumber,
          },
          quinn: { email: quinn.email, password, name: quinn.name },
          rowan: { email: rowan.email, password, name: rowan.name },
          teamName: frontOffice.name,
          positionName: frontPositionName,
          leaveTypeName,
          leaveStart,
          leaveEnd,
          holidayName,
        },
        recruitment: {
          organizationId: recruitmentOrganization.id,
          organizationName: recruitmentOrganization.name,
          recruiter: {
            email: recruiterAccount.email,
            password,
            name: `Robin Recruit${suffix}`,
          },
          hirer: {
            email: hirerAccount.email,
            password,
            name: `Hollis Hire${suffix}`,
          },
          interviewer: {
            email: interviewerAccount.email,
            password,
            name: `Sam Interviewer${suffix}`,
          },
          teamName: learningTeam.name,
          positionName: teacherPositionName,
          candidate: {
            firstName: 'Casey',
            lastName: `Candidate${suffix}`,
            email: `casey-${suffix.toLowerCase()}${REAL_STACK_EMAIL_DOMAIN}`,
          },
          templateName,
          employeeTaskTitle,
          hrTaskTitle,
          startDate: addDays(dates.referenceDate, 14),
        },
        benefits: {
          organizationId: benefitsOrganization.id,
          organizationName: benefitsOrganization.name,
          admin: {
            email: benefitsAdmin.email,
            password,
            name: `Blair Benefits${suffix}`,
          },
          approver: {
            email: benefitsApprover.email,
            password,
            name: `Drew Approver${suffix}`,
          },
          member: {
            email: memberAccount.email,
            password,
            name: `Morgan Member${suffix}`,
            employeeNumber: member.employeeNumber,
          },
          departmentName: benefitsDepartmentName,
          positionName: benefitsPositionName,
          payGroupName: benefitsPayGroup.name,
          anchorDate,
          periodEnd,
          planStart: `${year}-01-01`,
        },
        documents: {
          organizationId: documentsOrganization.id,
          organizationName: documentsOrganization.name,
          hr: {
            email: documentsHr.email,
            password,
            name: `Drew Records${suffix}`,
          },
          employee: {
            email: documentsEmployeeAccount.email,
            password,
            name: `Ellis Docs${suffix}`,
            employeeId: documentsEmployee.id,
          },
          manager: {
            email: documentsManager.email,
            password,
            name: `Mika Lead${suffix}`,
          },
          outsider: {
            email: documentsOutsider.email,
            password,
            name: `Oakley Outside${suffix}`,
          },
          typeName: documentTypeName,
        },
        r4a: {
          organizationId: r4aOrganization.id,
          organizationName: r4aOrganization.name,
          hr: { email: r4aHr.email, password, name: `Avery People${suffix}` },
          manager: {
            email: r4aManager.email,
            password,
            name: `Blake Shifts${suffix}`,
          },
          casey: {
            email: caseyAccount.email,
            password,
            name: `Casey Cover${suffix}`,
            employeeId: casey.id,
          },
          lifeguardPositionName,
          coachPositionName,
          lifeguardAssignmentId: lifeguard.id,
          coachAssignmentId: coach.id,
          sam: {
            employeeId: sam.id,
            name: `Sam Overdue${suffix}`,
            officePositionName,
          },
          drew: {
            employeeId: drew.id,
            name: `Drew Leaving${suffix}`,
            positionName: drewPositionName,
          },
          holidayName: r4aHolidayName,
          otherOrganizationHolidayName,
          holidayDate: dates.referenceDate,
          changedShift: {
            workDate: shiftDate,
            exceptionId: changedException.id,
            scheduleName,
          },
        },
        r5b: {
          organizationId: r5bOrganization.id,
          organizationName: r5bOrganization.name,
          admin: {
            email: r5bAdmin.email,
            password,
            name: `Morgan Structure${suffix}`,
          },
          manager: {
            email: r5bManager.email,
            password,
            name: `Dana Operations${suffix}`,
          },
          managerDepartment: {
            id: r5bOperations.id,
            name: r5bOperations.name,
            code: r5bOperations.code,
          },
          otherDepartment: {
            id: r5bFinance.id,
            name: r5bFinance.name,
            code: r5bFinance.code,
          },
          jobTitle: {
            id: r5bJobTitle.id,
            name: r5bJobTitle.name,
            code: r5bJobTitle.code,
          },
          workLocation: {
            id: r5bWorkLocation.id,
            name: r5bWorkLocation.name,
            code: r5bWorkLocation.code,
          },
          staffedPosition: {
            id: r5bStaffedPosition.id,
            name: r5bStaffedPosition.name,
            code: r5bStaffedPosition.code,
          },
        },
        performance: {
          organizationId: performanceOrganization.id,
          organizationName: performanceOrganization.name,
          hr: {
            email: performanceHr.email,
            password,
            name: `Hayden Review${suffix}`,
          },
          manager: { email: mel.email, password, name: mel.name },
          employee: { email: pat.email, password, name: pat.name },
          templateName: performanceTemplateName,
          ratingPrompt,
          textPrompt,
          cycle: {
            periodStart: `${year}-01-01`,
            periodEnd: `${year}-12-31`,
            windowStart: addDays(dates.referenceDate, -3),
            windowEnd: addDays(dates.referenceDate, 30),
            selfDue: addDays(dates.referenceDate, 7),
            reviewerDue: addDays(dates.referenceDate, 14),
          },
        },
      };
    },
    { timeout: 60_000 },
  );
}

async function main() {
  // Layer 1 before connecting; layer 2 once connected (disposable-database.ts).
  const { url: databaseUrl } = assertDisposableDatabaseUrl(process.env);
  const output = process.env.REAL_STACK_SEED_FILE;
  if (!output) throw new Error('REAL_STACK_SEED_FILE is required.');
  const timezone =
    process.env.REAL_STACK_TIMEZONE || REAL_STACK_DEFAULT_TIMEZONE;
  // The API's own validator, so a timezone the application refuses fails here, clearly, instead
  // of as a missing Clock In button. Batch 4D (D-A) fixed the alias defect: current names such
  // as Asia/Kolkata are accepted like their legacy spellings.
  if (!isIanaTimezone(timezone)) {
    throw new Error(
      `REAL_STACK_TIMEZONE "${timezone}" is not a timezone the API accepts.`,
    );
  }
  const dates = planRealStackDates(referenceInstantFrom(process.env), timezone);
  const defaults: Record<string, string> = {
    ARGON2_MEMORY_COST_KIB: '65536',
    ARGON2_TIME_COST: '3',
    ARGON2_PARALLELISM: '1',
  };
  const config = {
    getOrThrow: (key: string) => Number(process.env[key] ?? defaults[key]),
  } as unknown as ConfigService;
  const prisma = new PrismaService(databaseUrl);
  try {
    await prisma.$connect();
    await assertDisposableDatabase(prisma, process.env);
    const seed = await seedRealStack(
      prisma,
      new PasswordHasherService(config),
      dates,
    );
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, JSON.stringify(seed, null, 2));
    console.info(`Real-stack seed ${seed.suffix} written to ${output}.`);
  } finally {
    await prisma.$disconnect();
  }
}

if (
  process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href
) {
  await main();
}
