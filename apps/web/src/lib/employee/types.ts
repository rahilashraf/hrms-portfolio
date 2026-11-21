export type EmployeeStatus = 'ACTIVE' | 'INACTIVE' | 'TERMINATED';
export type EmploymentAssignmentStatus = 'PLANNED' | 'ACTIVE' | 'ENDED' | 'CANCELLED';
export type EmploymentType = 'FULL_TIME' | 'PART_TIME' | 'CASUAL' | 'CONTRACT';

export interface EmployeePersonSummary {
  firstName: string | null;
  middleName: string | null;
  lastName: string | null;
  preferredName: string | null;
}

export interface EmployeePerson extends EmployeePersonSummary {
  personalEmail: string | null;
  phone: string | null;
}

export interface EmployeePlacementSummary {
  type: 'ORGANIZATIONAL_UNIT' | 'DEPARTMENT' | 'TEAM';
  id: string;
  name: string;
  code: string;
}

export interface EmployeeWorkLocationSummary {
  id: string;
  name: string;
  code: string;
}

export interface EmployeeManagerSummary {
  assignmentId: string;
  employeeId: string;
  employeeNumber: string;
  displayName: string;
  positionName: string;
}

export interface EmployeeAssignmentView {
  id: string;
  employmentType: EmploymentType;
  status: EmploymentAssignmentStatus;
  startDate: string;
  endDate: string | null;
  isPrimary: boolean;
  position: { id: string; name: string; code: string };
  jobTitle: { id: string; name: string; code: string };
  organization: { id: string; name: string; code: string };
  placement: EmployeePlacementSummary | null;
  workLocation: EmployeeWorkLocationSummary | null;
  manager: EmployeeManagerSummary | null;
  /** Batch 5B (K7): the manager link is kept but no longer holds (absent on older payloads). */
  managerWarnings?: EmployeeManagerWarning[];
}

export type EmployeeManagerWarning = 'MANAGER_ASSIGNMENT_ENDED' | 'MANAGER_ORGANIZATION_MISMATCH';

export interface EmployeeDirectoryItem {
  id: string;
  employeeNumber: string;
  status: EmployeeStatus;
  /** Batch 5C: set on an ACTIVE employee when a termination is scheduled (never the reason). */
  terminationDate?: string | null;
  person: EmployeePersonSummary;
  displayAssignment: EmployeeAssignmentView | null;
}

export interface EmployeeDirectoryResponse {
  items: EmployeeDirectoryItem[];
  nextAfterId: string | null;
}

export interface EmployeeProfile {
  id: string;
  employeeNumber: string;
  status: EmployeeStatus;
  hireDate: string;
  terminationDate: string | null;
  person: EmployeePerson;
  assignments: {
    current: EmployeeAssignmentView[];
    upcoming: EmployeeAssignmentView[];
    historical: EmployeeAssignmentView[];
    cancelled: EmployeeAssignmentView[];
  };
}

/** My Profile: the signed-in employee's own record (read-only; no cancelled assignments). */
export interface MyEmployeeProfile {
  id: string;
  employeeNumber: string;
  status: EmployeeStatus;
  hireDate: string;
  terminationDate: string | null;
  person: EmployeePerson;
  assignments: {
    current: MyAssignmentView[];
    upcoming: MyAssignmentView[];
    historical: MyAssignmentView[];
  };
}

export type MyAssignmentView = Omit<EmployeeAssignmentView, 'manager'> & {
  manager: { displayName: string | null; positionName: string } | null;
};

export interface EmployeeDirectoryQuery {
  search?: string;
  status?: EmployeeStatus;
  organizationId?: string;
  jobTitleId?: string;
  limit?: number;
  afterId?: string;
}

export interface EmployeePersonInput {
  firstName?: string;
  middleName?: string;
  lastName?: string;
  preferredName?: string;
  personalEmail?: string;
  phone?: string;
}

export interface EmployeeCreateInput {
  personId?: string;
  person?: EmployeePersonInput;
  employeeNumber?: string;
  hireDate: string;
  initialPositionId?: string;
  initialEmploymentType?: EmploymentType;
  initialStartDate?: string;
  initialEndDate?: string;
  initialPrimary?: boolean;
}

/**
 * R4-A.2: an omitted field is unchanged; `null` clears an optional field. The legal first and
 * last name cannot be cleared (the API refuses with PROFILE_REQUIRED_FIELD).
 */
export type EmployeeUpdateInput = {
  [K in keyof EmployeePersonInput]?: EmployeePersonInput[K] | null;
};

export interface EmployeeMutationResponse {
  id: string;
  employeeNumber: string;
  status: EmployeeStatus;
  person: EmployeePersonSummary;
}

export interface EmployeeOptionQuery {
  search?: string;
  limit?: number;
  afterId?: string;
}

export interface EmployeePositionOptionQuery extends EmployeeOptionQuery {
  organizationId?: string;
}

export interface EmployeeOptionResponse<T> {
  items: T[];
  nextAfterId: string | null;
}

export interface EmployeePersonOption extends EmployeePersonSummary {
  id: string;
  personalEmail: string | null;
  hasEmployee: boolean;
  hasUser: boolean;
}

export interface EmployeePositionOption {
  id: string;
  name: string;
  code: string;
  jobTitle: { id: string; name: string; code: string };
  organization: { id: string; name: string; code: string };
  placement: EmployeePlacementSummary | null;
  workLocation: EmployeeWorkLocationSummary | null;
}

export interface EmployeeAssignmentCreateInput {
  positionId: string;
  employmentType: EmploymentType;
  startDate: string;
  endDate?: string;
  isPrimary?: boolean;
}

export interface EmployeeAssignmentUpdateInput {
  employmentType: EmploymentType;
  startDate: string;
  endDate?: string;
}

export interface EmployeeAssignmentEndInput {
  endDate: string;
}

export interface EmployeeAssignmentPrimaryInput {
  isPrimary: boolean;
}

export interface EmployeeAssignmentManagerInput {
  managerAssignmentId: string | null;
}

export interface EmployeeTerminationInput {
  /** The last day of employment (inclusive). */
  terminationDate: string;
  /** Restricted: shown only to those who may manage the employee. */
  reason?: string;
  /**
   * Legacy (before M3). Stored but keeps nothing: every System-level grant needs an explicit
   * decision in grantDecisions instead.
   */
  acknowledgeSystemGrants?: boolean;
  /** M3: what happens to each role grant when the termination applies (default: revoke). */
  grantDecisions?: TerminationGrantDecisionInput[];
}

/** M3: revoke a grant when the termination applies, or request to keep it until a date. */
export type TerminationGrantDecisionInput =
  | { roleAssignmentId: string; decision: 'REVOKE' }
  | {
      roleAssignmentId: string;
      decision: 'KEEP';
      /** 10–500 characters. */
      reason: string;
      /** ISO instant with offset; at most 30 days after the last day. */
      keepUntil: string;
    };

/**
 * M3: what will (or did) happen to a grant. KEEP is an approved keep; KEEP_PENDING awaits
 * approval (revoked at application unless approved; a System-level grant blocks instead);
 * DECISION_REQUIRED is a System-level grant with no decision yet.
 */
export type TerminationGrantOutcome =
  | 'REVOKE'
  | 'KEEP'
  | 'KEEP_PENDING'
  /** An approved keep that no longer passes revalidation: revoked, or (System-level) blocking. */
  | 'KEEP_INVALID'
  | 'DECISION_REQUIRED'
  | 'REVOKED'
  | 'RETAINED'
  | 'ALREADY_REVOKED';

export type TerminationGrantDecisionStatus =
  'DECIDED' | 'REQUESTED' | 'APPROVED' | 'REJECTED' | 'CANCELLED';

export interface TerminationGrantItem {
  roleAssignmentId: string;
  roleName: string;
  scopeType: string;
  system: boolean;
  organizationId: string | null;
  organizationName: string | null;
  /** The grant's own expiry, if any (a keep never extends it). */
  expiresAt: string | null;
  outcome: TerminationGrantOutcome;
}

/** M3: the termination preview's grant section (nothing is recorded). */
export interface TerminationGrantChanges {
  grants: TerminationGrantItem[];
  /** Grants outside the termination remain (yes/no only; never described). */
  otherAccessRemains: boolean;
  /** null when the employee has no login. */
  loginWillBeDisabled: boolean | null;
  /** System-level grants that need an explicit decision. */
  decisionsRequired: string[];
  /** The latest a keep may run to (30 days after the last day). */
  keepLimit: string;
}

export interface TerminationGrantDecision {
  id: string;
  decision: 'REVOKE' | 'KEEP';
  status: TerminationGrantDecisionStatus;
  reason: string | null;
  keepUntil: string | null;
  requestedByUserId: string | null;
  requestedByName: string | null;
  requestedAt: string;
  reviewedByUserId: string | null;
  reviewedByName: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  appliedAt: string | null;
  outcome: 'REVOKED' | 'RETAINED' | 'ALREADY_REVOKED' | null;
  retainedRoleAssignmentId: string | null;
  retainedUntil: string | null;
  /**
   * Final M3 change: why an approved keep was not honoured when the termination applied (a safe
   * category); null otherwise. Absent on older API versions.
   */
  revalidationFailure?:
    'APPROVER_NOT_AUTHORIZED' | 'ROLE_INELIGIBLE' | 'KEEP_LIMIT_EXCEEDED' | 'SELF_APPROVAL' | null;
}

/** M3: GET …/terminations/:id/grants. */
export interface TerminationGrantList {
  grants: Array<TerminationGrantItem & { decision: TerminationGrantDecision | null }>;
  otherAccessRemains: boolean;
  /** Scheduled terminations only; null afterwards or without a login. */
  loginWillBeDisabled: boolean | null;
  /** System-level grants that stop the termination from applying. */
  blocking: Array<{
    roleAssignmentId: string;
    code:
      | 'TERMINATION_GRANT_DECISION_REQUIRED'
      | 'TERMINATION_KEEP_APPROVAL_REQUIRED'
      | 'TERMINATION_KEEP_APPROVAL_INVALID';
  }>;
  keepLimit: string;
}

/** Batch 5A: a rehire always creates the new assignment (after the last day of employment). */
export interface EmployeeRehireInput {
  assignment: {
    positionId: string;
    employmentType: EmploymentType;
    startDate: string;
    endDate?: string;
    isPrimary?: boolean;
    managerAssignmentId?: string;
  };
  reason?: string;
}

export type EmployeeTerminationStatus = 'SCHEDULED' | 'APPLIED' | 'CANCELLED' | 'SUPERSEDED';

/** One termination in the employee's append-only history. */
export interface EmployeeTermination {
  id: string;
  employeeId: string;
  terminationDate: string;
  status: EmployeeTerminationStatus;
  /** Present only for those who may manage the employee (R7); absent otherwise. */
  reason?: string | null;
  systemGrantsAcknowledged: boolean;
  recordedByUserId: string | null;
  recordedAt: string;
  appliedAt: string | null;
  appliedSource: string | null;
  cancelledAt: string | null;
  cancelledByUserId: string | null;
  supersededById: string | null;
  rehireAssignmentId: string | null;
  rehiredAt: string | null;
  assignments: Array<{
    employmentAssignmentId: string;
    action: string;
    previousStatus: string;
    previousEndDate: string | null;
    appliedAt: string | null;
  }>;
}

/** Batch 5A: a termination is SCHEDULED until its date has passed, then APPLIED. */
export interface EmployeeTerminationResult {
  termination: EmployeeTermination;
  employee: { id: string; status: EmployeeStatus; terminationDate: string | null };
  /** M3: grant outcomes once applied (absent on older API versions). */
  grants?: { revoked: number; retained: number; alreadyRevoked: number };
  /**
   * M3: while scheduled, the System-level grants that stop it from applying (no decision, or a
   * keep awaiting approval). The person keeps their access until this is resolved.
   */
  applyBlockedBy?: {
    code: 'TERMINATION_GRANT_DECISION_REQUIRED' | 'TERMINATION_KEEP_APPROVAL_REQUIRED' | string;
    roleAssignmentIds: string[];
  } | null;
}

export type GrantRelation = 'SYSTEM' | 'CURRENT_EMPLOYMENT' | 'ENDED_EMPLOYMENT' | 'NO_EMPLOYMENT';

/** Batch 5E: why a listed grant authorizes nothing. */
export type GrantInactiveReason = 'ORGANIZATION_ARCHIVED' | 'ROLE_ARCHIVED';

/** The employee's login and role grants, as far as the caller may see them (R2/R3). */
export interface EmployeeAccessSummary {
  userId: string;
  loginStatus: string;
  activeSessions: number;
  grants: Array<{
    roleAssignmentId: string;
    roleName: string;
    scopeType: string;
    organizationId: string | null;
    organizationName: string | null;
    relation: GrantRelation;
    revocable: boolean;
    /**
     * Batch 5E: set when the grant authorizes nothing because its organization or its role is
     * archived (it is still listed, and may be revoked as clean-up). Absent on older API
     * versions.
     */
    inactiveReason?: GrantInactiveReason | null;
    /** M3: a grant kept after a termination (an approved, expiring exception). */
    retention?: {
      terminationId: string;
      keepUntil: string | null;
      approvalStatus: TerminationGrantDecisionStatus;
      requestedByUserId: string | null;
      approvedByUserId: string | null;
    } | null;
  }>;
  /** M3: grants a termination revoked (as far as the caller may see them). */
  revokedByTermination?: Array<{
    roleAssignmentId: string;
    roleName: string;
    scopeType: string;
    organizationName: string | null;
    revokedAt: string | null;
  }>;
  /** Grants the caller may not see (counted, never described). */
  hiddenGrants: number;
  systemGrants: number;
  hasEffectiveAuthorization: boolean;
}

export interface EmployeeAccessReview {
  employeeId: string;
  employeeStatus: EmployeeStatus;
  /** null when the employee has no login. */
  access: EmployeeAccessSummary | null;
}

export interface EmployeeRevokeGrantsResult {
  employeeId: string;
  /** Batch 5E: the grants this request revoked (not those someone else revoked first). */
  revoked: string[];
  /**
   * Batch 5E: requested grants that were already revoked (by someone else, or a moment
   * earlier); left as they are. Absent on older API versions.
   */
  alreadyRevoked?: string[];
  loginDisabled: boolean;
}

export type TerminationBlocker =
  | {
      kind: 'APPROVED_TIMESHEET';
      employmentAssignmentId: string;
      periodStart: string;
      periodEnd: string;
    }
  | {
      kind: 'FINALIZED_PAYROLL';
      employmentAssignmentId: string;
      payrollRunId: string;
      periodStart: string;
      periodEnd: string;
    }
  | { kind: 'TIME_RECORDED' | 'SIGN_INS_RECORDED'; employmentAssignmentId: string; count: number };

/** GET /employees/:id/termination-preview (nothing is changed). */
export interface EmployeeTerminationPreview {
  employeeId: string;
  terminationDate: string;
  /** true: the date is today or later somewhere, so the termination is scheduled. */
  scheduled: boolean;
  assignments: Array<{
    employmentAssignmentId: string;
    positionName: string;
    organizationId: string;
    organizationName: string;
    timezone: string;
    status: EmploymentAssignmentStatus;
    startDate: string;
    endDate: string | null;
    action: 'END' | 'CANCEL' | string;
    newEndDate: string | null;
    effectiveFrom: string;
  }>;
  blockers: TerminationBlocker[];
  followUps: {
    openTimeEntries: number;
    futurePublishedShifts: number;
    pendingLeaveRequests: number;
    approvedLeaveAfterTermination: number;
    /** Batch 7C: null when the reader has no benefits access. */
    openBenefitEnrollments: number | null;
    openPerformanceReviews: number;
  };
  access: EmployeeAccessSummary | null;
  /** M3: what the termination does with the grants (absent on older API versions). */
  grantChanges?: TerminationGrantChanges;
}

export interface EmployeeStatusChangeResult {
  employeeId: string;
  status: EmployeeStatus;
}

export interface EmployeeRehireResult {
  employee: {
    id: string;
    employeeNumber: string;
    status: EmployeeStatus;
    hireDate: string;
    terminationDate: string | null;
  };
  assignment: { id: string; startDate: string; endDate: string | null };
  terminationId: string | null;
}

export interface EmployeeTransferInput {
  positionId: string;
  /** The first day in the new position; the current assignment ends the day before. */
  effectiveDate: string;
  employmentType?: EmploymentType;
  endDate?: string;
  isPrimary?: boolean;
  /** Omit to carry the current manager when still valid; null for none. */
  managerAssignmentId?: string | null;
  reason?: string;
}

export type ManagerDroppedReason =
  | 'MANAGER_ASSIGNMENT_ENDED'
  | 'MANAGER_ORGANIZATION_MISMATCH'
  | 'MANAGER_NOT_VALID_FOR_NEW_ASSIGNMENT';

export interface EmployeeTransferResult {
  replayed: boolean;
  sourceAssignment: { id: string; endDate: string | null; status: EmploymentAssignmentStatus };
  destinationAssignment: {
    id: string;
    positionId: string;
    startDate: string;
    endDate: string | null;
    status: EmploymentAssignmentStatus;
    isPrimary: boolean;
  };
  /** Compensation is never copied: the new assignment needs its own record. */
  compensationRequired: boolean;
  sourceHadCompensation: boolean;
  primaryCarried: boolean;
  manager: {
    managerAssignmentId: string | null;
    carried: boolean;
    droppedReason: ManagerDroppedReason | null;
  };
}

/** A list capped at `limit` with its exact `total`. */
export interface BoundedList<T> {
  total: number;
  items: T[];
  truncated: boolean;
  limit: number;
}

/**
 * GET /employees/:id/assignments/:aid/impact — what ending the assignment on `endDate` would
 * leave behind. Each section is null when the caller may not read that module.
 */
export interface AssignmentImpact {
  employeeId: string;
  employmentAssignmentId: string;
  organizationId: string;
  timezone: string;
  endDate: string;
  blocked: boolean;
  blockers: TerminationBlocker[];
  attendance: {
    openTimeEntries: BoundedList<{ id: string; workDate: string; clockInAt: string }>;
  } | null;
  scheduling: { futurePublishedShifts: BoundedList<{ id: string; workDate: string }> } | null;
  leave: {
    pending: BoundedList<{ id: string; startDate: string; endDate: string }>;
    approvedAfterEnd: BoundedList<{ id: string; startDate: string; endDate: string }>;
  } | null;
  compensation: {
    recordsBeyondEnd: BoundedList<{
      id: string;
      effectiveFrom: string;
      effectiveTo: string | null;
      payGroupId: string | null;
    }>;
  } | null;
  payroll: { openPayrollRuns: number } | null;
  benefits: {
    enrollmentsBeyondEnd: BoundedList<{
      id: string;
      coverageStart: string;
      coverageEnd: string | null;
    }>;
  } | null;
  managerRelationships: {
    visibleDirectReports: Array<{ employmentAssignmentId: string; employeeId: string }>;
    visibleDirectReportCount: number;
    truncated: boolean;
    limit: number;
  };
  employment: {
    otherCurrentAssignments: Array<{
      employmentAssignmentId: string;
      status: EmploymentAssignmentStatus;
      positionName: string;
      organizationId: string;
    }>;
    /** null when the caller cannot see the whole organization. */
    remainsEmployedInOrganization: boolean | null;
    /** null unless the caller reads employees at System scope. */
    endsLastCurrentEmployment: boolean | null;
  };
  access: { loginStatus: string | null; grantsInOrganization: number; changesAccess: false } | null;
  offboarding: {
    employeeId: string;
    employmentAssignmentId: string;
    plannedEndDate: string;
    defaultTemplate: { id: string; name: string } | null;
    openWorkflowId: string | null;
  } | null;
}

export interface EmployeeAssignmentMutationResponse {
  id: string;
  employeeId: string;
  positionId: string;
  employmentType: EmploymentType;
  status: EmploymentAssignmentStatus;
  startDate: string;
  endDate: string | null;
  isPrimary: boolean;
  managerAssignmentId: string | null;
}

/** PLANNED → ACTIVE; ALREADY_ACTIVE when an earlier request (or the worker) already did it. */
export interface EmployeeAssignmentActivationResponse {
  outcome: 'ACTIVATED' | 'ALREADY_ACTIVE';
  activatedOn: string;
  timezone: string;
  assignment: {
    id: string;
    employeeId: string;
    positionId: string;
    status: EmploymentAssignmentStatus;
    startDate: string;
    endDate: string | null;
  };
}

/**
 * Managers for an existing assignment, or (Batch 5C) for a new one not created yet — its
 * position and dates, with the employee's own assignments left out.
 */
export type EmployeeManagerAssignmentOptionQuery = EmployeeOptionQuery &
  (
    | { subordinateAssignmentId: string }
    | { positionId: string; startDate: string; endDate?: string; employeeId?: string }
  );

export interface EmployeeManagerAssignmentOption {
  assignmentId: string;
  employeeId: string;
  employeeNumber: string;
  displayName: string;
  position: { id: string; name: string; code: string };
  jobTitle: { id: string; name: string; code: string };
  organization: { id: string; name: string; code: string };
  startDate: string;
  endDate: string | null;
  status: EmploymentAssignmentStatus;
}

/** GET /employees/:employeeId/capabilities — UI hints only; the API stays authoritative. */
export interface EmployeeCapabilities {
  employeeId: string;
  organizationIds: string[];
  tabs: {
    overview: boolean;
    employment: boolean;
    compensation: boolean;
    time: boolean;
    leave: boolean;
    benefits: boolean;
    documents: boolean;
    performance: boolean;
  };
  actions: {
    edit: boolean;
    changePosition: boolean;
    assignManager: boolean;
    addCompensation: boolean;
    manageDocuments: boolean;
    startOffboarding: boolean;
    /** Batch 7A: onboarding.manage over a planned or active assignment, never oneself. */
    startOnboarding?: boolean;
    /**
     * Batch 5C: terminate, scheduled-termination changes, rehire, inactive and reactivation
     * (employee.manage over every assignment in effect, never one's own employment except at
     * System scope). Absent on older API versions.
     */
    manageLifecycle?: boolean;
  };
}

export type EmployeeAccountStatus =
  'NOT_INVITED' | 'INVITED' | 'INVITATION_EXPIRED' | 'ACTIVE' | 'LOCKED' | 'DISABLED' | 'ARCHIVED';

/** An employee's login access (GET /employees/:id/account). */
export interface EmployeeAccount {
  employeeId: string;
  status: EmployeeAccountStatus;
  email: string | null;
  invitationExpiresAt: string | null;
  lastLoginAt: string | null;
  /** Batch 2: account security state (no addresses or devices). */
  mustChangePassword: boolean;
  lockedUntil: string | null;
  activeSessionCount: number;
  actions: Record<EmployeeAccountAction, boolean>;
  /**
   * Security remediation M1: the same answer per action, with a safe reason when the login's
   * state allows the action but the administrator's scope does not (no reason when the state
   * alone rules it out). Presentation hints only: the API re-checks every action.
   */
  capabilities?: Record<EmployeeAccountAction, EmployeeAccountCapability>;
}

export type EmployeeAccountAction =
  | 'invite'
  | 'resend'
  | 'cancel'
  | 'disable'
  | 'enable'
  | 'requirePasswordChange'
  | 'sendPasswordReset'
  | 'signOut'
  | 'unlock';

/** Why an M1 policy refuses an action (names no organization, role or person). */
export type EmployeeAccountScopeReason =
  'NO_CURRENT_ASSIGNMENT' | 'PROTECTIVE_WINDOW_ENDED' | 'ACCESS_OUTSIDE_SCOPE';

export interface EmployeeAccountCapability {
  allowed: boolean;
  reason: EmployeeAccountScopeReason | null;
}

// ─── R4-A.1: manual lifecycle due list (GET /employees/lifecycle/due) ──────────

/** One assignment row: who, where, and the dates in the assignment's own time zone. */
export interface LifecycleAssignmentRow {
  employmentAssignmentId: string;
  employeeId: string;
  employeeNumber: string;
  employeeName: string | null;
  positionName: string;
  /** The last working day (date only). */
  endDate: string;
  timezone: string;
  organizationId: string;
  organizationName: string;
  employmentType: EmploymentType;
  isPrimary: boolean;
  startDate: string;
  /** The assignment's business date now. */
  localToday: string;
}

export interface LifecycleDue {
  organizationId: string;
  terminations: Array<{
    terminationId: string;
    employeeId: string;
    employeeNumber: string;
    employeeName: string | null;
    terminationDate: string;
  }>;
  /** Past their end date and still ACTIVE: an HR user applies the end. */
  assignmentEnds: Array<LifecycleAssignmentRow & { daysOverdue: number }>;
  /** Ending within `upcomingDays`; one in a scheduled termination ends with it. */
  upcomingAssignmentEnds: Array<
    LifecycleAssignmentRow & { daysUntilEnd: number; scheduledTerminationId: string | null }
  >;
  upcomingDays: number;
  truncated: boolean;
  limit: number;
}
