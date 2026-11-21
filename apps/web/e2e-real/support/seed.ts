import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Written by global setup; gitignored and never uploaded (it holds this run's passwords). */
export const SEED_FILE = resolve(__dirname, '../.seed/seed.json');

/** Mirrors RealStackSeed in apps/api/test/real-stack/seed.ts. */
export interface RealStackSeed {
  suffix: string;
  organizationName: string;
  employee: { email: string; password: string; name: string };
  manager: { email: string; password: string; name: string };
  hr: { email: string; password: string; name: string };
  employeeId: string;
  assignmentId: string;
  lifecycleEmployee: { employeeId: string; name: string; email: string };
  transferPositionName: string;
  positionName: string;
  /** The organization's timezone and the reference every date below derives from. */
  timezone: string;
  referenceInstant: string;
  referenceDate: string;
  pastEntry: { workDate: string; clockOut: string; correctedClockOut: string };
  period: { startDate: string; endDate: string };
  organizationId: string;
  exceptionId: string;
  /** Batch 6A: the payroll organization (see RealStackPayrollSeed in the API seed). */
  payroll: {
    organizationId: string;
    organizationName: string;
    admin: { email: string; password: string; name: string };
    /** Security remediation M2: an independent approver, and one who authored the payee's pay. */
    approver: { email: string; password: string; name: string };
    compensationApprover: { email: string; password: string; name: string };
    employee: { email: string; password: string; name: string; employeeNumber: string };
    payGroupName: string;
    payGroupCode: string;
    positionName: string;
    anchorDate: string;
    periodEnd: string;
    payDate: string;
    salaryGross: string;
  };
  /** Batch 6B: the leave organization (see RealStackLeaveSeed in the API seed). */
  leave: {
    organizationId: string;
    organizationName: string;
    admin: { email: string; password: string; name: string };
    taylor: { email: string; password: string; name: string; employeeNumber: string };
    quinn: { email: string; password: string; name: string };
    rowan: { email: string; password: string; name: string };
    teamName: string;
    positionName: string;
    leaveTypeName: string;
    leaveStart: string;
    leaveEnd: string;
    holidayName: string;
  };
  /** Batch 7A: the recruitment organization (see RealStackRecruitmentSeed in the API seed). */
  recruitment: {
    organizationId: string;
    organizationName: string;
    recruiter: { email: string; password: string; name: string };
    hirer: { email: string; password: string; name: string };
    interviewer: { email: string; password: string; name: string };
    teamName: string;
    positionName: string;
    candidate: { firstName: string; lastName: string; email: string };
    templateName: string;
    employeeTaskTitle: string;
    hrTaskTitle: string;
    startDate: string;
  };
  /** Batch 7B: the performance organization (see RealStackPerformanceSeed in the API seed). */
  performance: {
    organizationId: string;
    organizationName: string;
    hr: { email: string; password: string; name: string };
    manager: { email: string; password: string; name: string };
    employee: { email: string; password: string; name: string };
    templateName: string;
    ratingPrompt: string;
    textPrompt: string;
    cycle: {
      periodStart: string;
      periodEnd: string;
      windowStart: string;
      windowEnd: string;
      selfDue: string;
      reviewerDue: string;
    };
  };
  /** Batch 7C: the benefits organization (see RealStackBenefitsSeed in the API seed). */
  benefits: {
    organizationId: string;
    organizationName: string;
    admin: { email: string; password: string; name: string };
    /** Security remediation M2: approves and finalizes (never the preparer). */
    approver: { email: string; password: string; name: string };
    member: { email: string; password: string; name: string; employeeNumber: string };
    departmentName: string;
    positionName: string;
    payGroupName: string;
    anchorDate: string;
    periodEnd: string;
    planStart: string;
  };
  /** Batch 9: the documents organization (see RealStackDocumentsSeed in the API seed). */
  documents: {
    organizationId: string;
    organizationName: string;
    hr: { email: string; password: string; name: string };
    employee: { email: string; password: string; name: string; employeeId: string };
    manager: { email: string; password: string; name: string };
    outsider: { email: string; password: string; name: string };
    typeName: string;
  };
  /** Security remediation M1 (see RealStackM1Seed in the API seed). */
  m1: {
    admin: { email: string; password: string; name: string };
    outsideScope: { employeeId: string; name: string };
    former: { employeeId: string; name: string };
    otherOrganizationName: string;
  };
  /** Security remediation M3 (see RealStackM3Seed in the API seed). */
  m3: {
    admin: { email: string; password: string; name: string };
    leaver: { employeeId: string; name: string; roleName: string };
    keeper: {
      employeeId: string;
      name: string;
      email: string;
      password: string;
      roleName: string;
    };
    invalidated: { employeeId: string; name: string; roleName: string };
  };
  /** Batch R4-A (see RealStackR4aSeed in the API seed). */
  r4a: {
    organizationId: string;
    organizationName: string;
    hr: { email: string; password: string; name: string };
    manager: { email: string; password: string; name: string };
    casey: { email: string; password: string; name: string; employeeId: string };
    lifeguardPositionName: string;
    coachPositionName: string;
    lifeguardAssignmentId: string;
    coachAssignmentId: string;
    sam: { employeeId: string; name: string; officePositionName: string };
    drew: { employeeId: string; name: string; positionName: string };
    holidayName: string;
    otherOrganizationHolidayName: string;
    holidayDate: string;
    changedShift: { workDate: string; exceptionId: string; scheduleName: string };
  };
  /** Batch R5-B (see RealStackR5bSeed in the API seed). */
  r5b: {
    organizationId: string;
    organizationName: string;
    admin: { email: string; password: string; name: string };
    manager: { email: string; password: string; name: string };
    managerDepartment: { id: string; name: string; code: string };
    otherDepartment: { id: string; name: string; code: string };
    jobTitle: { id: string; name: string; code: string };
    workLocation: { id: string; name: string; code: string };
    staffedPosition: { id: string; name: string; code: string };
  };
}

export function readSeed(): RealStackSeed {
  return JSON.parse(readFileSync(SEED_FILE, 'utf8')) as RealStackSeed;
}
