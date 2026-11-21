/** Phase 9 Compensation read and write models (mirrors the API; amounts are decimal strings). */

export type PayBasis = 'HOURLY' | 'SALARY';
export type SalaryArrangement = 'ANNUAL' | 'FIXED_PERIOD' | 'CONTRACT_TOTAL';
export type CompensationRecordType = 'INITIAL' | 'CHANGE' | 'CORRECTION';
export type AssignmentStatus = 'PLANNED' | 'ACTIVE' | 'ENDED' | 'CANCELLED';

export interface PayGroupRef {
  id: string;
  code: string;
  name: string;
}

export interface CompensationRecord {
  id: string;
  employmentAssignmentId: string;
  recordType: CompensationRecordType;
  payBasis: PayBasis;
  /** Exact decimal string with four places, e.g. "24.5000". Never parsed into a JS number. */
  rateAmount: string;
  salaryArrangement: SalaryArrangement | null;
  salaryMonthlyAmount: string | null;
  salaryPaidMonths: number | null;
  salaryContractAmount: string | null;
  salaryPeriodStart: string | null;
  salaryPeriodEnd: string | null;
  currency: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  payGroup: PayGroupRef | null;
  reason: string | null;
  supersedesRecordId: string | null;
  supersededAt: string | null;
  createdAt: string;
}

export interface CompensationTimelineRecord extends CompensationRecord {
  actions: { canCorrect: boolean; canEnd: boolean };
}

export interface CompensationAssignment {
  id: string;
  status: AssignmentStatus;
  employmentType: string;
  isPrimary: boolean;
  startDate: string;
  endDate: string | null;
  employee: { id: string; employeeNumber: string; displayName: string | null };
  position: { id: string; name: string; code: string };
  organization: { id: string; name: string; code: string };
}

export interface CompensationAssignmentView {
  assignment: CompensationAssignment;
  /** The assignment-local date "current" refers to; null when its timezone is unknown. */
  asOf: string | null;
  current: CompensationRecord | null;
  timeline: CompensationTimelineRecord[];
  superseded: CompensationRecord[];
  actions: { canCreate: boolean; canChange: boolean };
}

export interface EmployeeCompensation {
  employeeId: string;
  assignments: CompensationAssignmentView[];
}

export interface CompensationAsOf {
  employmentAssignmentId: string;
  date: string;
  record: CompensationRecord | null;
}

export interface CompensationCreateInput {
  payBasis: PayBasis;
  rateAmount: string;
  salaryArrangement?: SalaryArrangement;
  salaryMonthlyAmount?: string;
  salaryPaidMonths?: number;
  salaryContractAmount?: string;
  salaryPeriodStart?: string;
  salaryPeriodEnd?: string;
  currency: string;
  payGroupId?: string | null;
  effectiveFrom: string;
  effectiveTo?: string;
  reason?: string;
}

export type CompensationChangeInput = Omit<CompensationCreateInput, 'effectiveTo'>;

export interface CompensationCorrectionInput {
  payBasis?: PayBasis;
  rateAmount?: string;
  salaryArrangement?: SalaryArrangement;
  salaryMonthlyAmount?: string;
  salaryPaidMonths?: number;
  salaryContractAmount?: string;
  salaryPeriodStart?: string;
  salaryPeriodEnd?: string;
  currency?: string;
  payGroupId?: string | null;
  effectiveFrom?: string;
  effectiveTo?: string | null;
  reason: string;
}

export interface CompensationEndInput {
  effectiveTo: string;
  reason?: string;
}

export interface CompensationChangeResult {
  record: CompensationRecord;
  previous: CompensationRecord;
}

export interface PayGroup {
  id: string;
  organizationId: string;
  code: string;
  name: string;
  description: string | null;
  archivedAt: string | null;
  actions: { canEdit: boolean; canArchive: boolean };
}

export interface PayGroupOrganization {
  id: string;
  name: string;
  code: string;
  canManagePayGroups: boolean;
}

export interface PayGroupInput {
  organizationId: string;
  code: string;
  name: string;
  description?: string;
}
