/** Phase 11 Benefits read and write models (mirror the API; money is a decimal string). */

export type BenefitType =
  'HEALTH' | 'DENTAL' | 'VISION' | 'LIFE' | 'DISABILITY' | 'RETIREMENT' | 'WELLNESS' | 'OTHER';
export type BenefitPlanStatus = 'DRAFT' | 'ACTIVE' | 'CLOSED';
export type CoverageLevel =
  'EMPLOYEE_ONLY' | 'EMPLOYEE_SPOUSE' | 'EMPLOYEE_CHILDREN' | 'FAMILY' | 'CUSTOM';
export type RateFrequency = 'PER_PAY_PERIOD' | 'MONTHLY' | 'ANNUAL';
export type Relationship = 'SPOUSE' | 'CHILD' | 'OTHER';
export type ElectionStatus = 'PENDING' | 'ACTIVE' | 'ENDED' | 'WAIVED' | 'SUPERSEDED';

export interface BenefitOrganization {
  id: string;
  name: string;
  code: string;
  timezone: string | null;
  actions: { canManagePlans: boolean };
}

export interface PlanActions {
  canEdit: boolean;
  /** Batch 7C: the start date moves only while the plan is a draft. */
  canEditStart?: boolean;
  canActivate: boolean;
  canClose: boolean;
  canArchive: boolean;
  canManageOptions: boolean;
  canManageRates: boolean;
  canManageEligibility: boolean;
}

export interface BenefitPlan {
  id: string;
  organizationId: string;
  code: string;
  name: string;
  description: string | null;
  benefitType: BenefitType;
  providerName: string | null;
  providerReference: string | null;
  currency: string;
  status: BenefitPlanStatus;
  effectiveFrom: string;
  effectiveTo: string | null;
  employerContributionTaxable: boolean;
  showEmployerCostToEmployee: boolean;
  dependentChildMaxAge: number | null;
  archived: boolean;
  optionCount?: number;
  actions?: PlanActions;
}

export interface BenefitOption {
  id: string;
  planId: string;
  code: string;
  name: string;
  coverageLevel: CoverageLevel;
  sortOrder: number;
  archived: boolean;
  currentAndFutureEnrollments?: number;
  actions?: { canEdit: boolean; canArchive: boolean };
}

export interface BenefitRate {
  id: string;
  optionId: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  frequency: RateFrequency;
  employeeAmount: string;
  employerAmount: string;
  currency: string;
  recordType: 'INITIAL' | 'CHANGE' | 'CORRECTION';
  supersededAt: string | null;
  reason: string | null;
  supersedesRateId?: string | null;
  createdAt?: string;
  /** Batch 7C: what the API accepts for this rate. */
  actions?: { canCorrect: boolean };
}

export interface EligibilityRule {
  id: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  organizationalUnitId: string | null;
  organizationalUnitName?: string | null;
  includeSubunits: boolean;
  departmentId: string | null;
  departmentName?: string | null;
  positionId: string | null;
  positionName?: string | null;
  employmentTypes: string[];
  minimumServiceDays: number | null;
}

export interface BenefitPlanDetail extends BenefitPlan {
  organization: { id: string; name: string; timezone: string | null };
  asOf: string;
  actions: PlanActions;
  options: BenefitOption[];
  rates: BenefitRate[];
  eligibilityRules: EligibilityRule[];
}

export interface Dependent {
  id: string;
  employeeId: string;
  firstName: string;
  lastName: string;
  relationship: Relationship;
  dateOfBirth: string | null;
  relationshipStartDate: string | null;
  relationshipEndDate: string | null;
  archived: boolean;
  /** Batch 7C (C4): whether the reader may change this dependent (every sponsor in scope). */
  canManage?: boolean;
}

export interface ElectionCost {
  rateId: string;
  asOf: string;
  frequency: RateFrequency;
  currency: string;
  employeeAmount: string;
  employerAmount: string | null;
}

export interface Election {
  id: string;
  status: ElectionStatus;
  electionType: 'ENROLLED' | 'WAIVED';
  recordType: 'INITIAL' | 'CHANGE' | 'CORRECTION';
  plan: {
    id: string;
    code: string;
    name: string;
    benefitType: BenefitType;
    providerName: string | null;
    currency: string;
  };
  option: { id: string; code: string; name: string; coverageLevel: CoverageLevel } | null;
  coverageStart: string;
  coverageEnd: string | null;
  electedOn: string;
  sponsoringAssignment: { id: string; positionName: string; organizationName: string };
  dependents: Array<{
    id: string;
    firstName: string;
    lastName: string;
    relationship: Relationship;
  }>;
  cost: ElectionCost | null;
  reason?: string | null;
  eligibilityOverrideReason?: string | null;
  supersededAt?: string | null;
  supersessionReason?: string | null;
  /** Batch 7C (C1): why coverage was ended (HR note; administrators only). */
  endReason?: string | null;
  supersedesEnrollmentId?: string | null;
  createdAt?: string;
  flags?: string[];
  actions?: {
    canChange: boolean;
    canEnd: boolean;
    canTransfer: boolean;
    canCorrect: boolean;
    canRescind: boolean;
  };
}

export interface EmployeeBenefits {
  employeeId: string;
  /** Batch 7C: who this is (no employee.read needed). */
  employee?: { displayName: string; employeeNumber: string };
  canManage: boolean;
  sponsoringAssignments: Array<{
    id: string;
    positionName: string;
    organizationId: string;
    status: string;
    startDate: string;
    endDate: string | null;
  }>;
  items: Election[];
}

export interface EligibilityPlan {
  planId: string;
  code: string;
  name: string;
  benefitType: BenefitType;
  status: BenefitPlanStatus;
  options: Array<{ id: string; code: string; name: string; coverageLevel: CoverageLevel }>;
  eligibility: {
    eligible: boolean;
    reasons: string[];
    rules: Array<{ ruleId: string; matched: boolean; failed: string[] }>;
  };
}

export interface MyEligibility {
  items: Array<{
    assignmentId: string;
    positionName: string;
    organization: string;
    date: string;
    plans: EligibilityPlan[];
  }>;
}

export interface AttentionItem {
  enrollmentId: string;
  employeeId: string;
  employeeNumber: string;
  displayName: string;
  plan: { id: string; code: string; name: string };
  coverageStart: string;
  coverageEnd: string | null;
  flags: string[];
}

/** Batch 7C (C7) — picker options from GET /benefits/options. */
export type BenefitOptionKind = 'employee' | 'assignment' | 'unit' | 'department' | 'position';

export interface BenefitPickerOption {
  id: string;
  label: string;
  description?: string;
  employeeId?: string;
}
