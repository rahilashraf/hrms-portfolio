import { apiRequest } from '../auth/api-client';
import type {
  AttentionItem,
  BenefitOptionKind,
  BenefitPickerOption,
  BenefitOption,
  BenefitOrganization,
  BenefitPlan,
  BenefitPlanDetail,
  BenefitRate,
  CoverageLevel,
  Dependent,
  Election,
  EligibilityPlan,
  EligibilityRule,
  EmployeeBenefits,
  MyEligibility,
  RateFrequency,
  Relationship,
} from './types';

const enc = encodeURIComponent;

function qs(params: Record<string, string | number | boolean | undefined | null>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

function send<T>(method: 'POST' | 'PATCH', path: string, body?: unknown): Promise<T> {
  return apiRequest(path, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

export interface PlanInput {
  organizationId: string;
  code: string;
  name: string;
  benefitType: BenefitPlan['benefitType'];
  currency: string;
  effectiveFrom: string;
  effectiveTo?: string | null;
  providerName?: string | null;
  providerReference?: string | null;
  description?: string | null;
  dependentChildMaxAge?: number | null;
  showEmployerCostToEmployee?: boolean;
  employerContributionTaxable?: boolean;
}

/** Batch 7C — what a plan edit accepts (code, organization, type and currency never change). */
export interface PlanUpdateInput {
  name?: string;
  description?: string | null;
  providerName?: string | null;
  providerReference?: string | null;
  effectiveFrom?: string;
  dependentChildMaxAge?: number | null;
  showEmployerCostToEmployee?: boolean;
  employerContributionTaxable?: boolean;
}

export interface DependentInput {
  firstName: string;
  lastName: string;
  relationship: Relationship;
  dateOfBirth?: string | null;
  relationshipStartDate?: string | null;
  relationshipEndDate?: string | null;
}

export interface RuleInput {
  effectiveFrom: string;
  effectiveTo?: string | null;
  organizationalUnitId?: string | null;
  includeSubunits?: boolean;
  departmentId?: string | null;
  positionId?: string | null;
  employmentTypes?: string[];
  minimumServiceDays?: number | null;
}

export interface RateInput {
  effectiveFrom: string;
  effectiveTo?: string | null;
  frequency: RateFrequency;
  employeeAmount: string;
  employerAmount: string;
  reason?: string;
}

export interface ElectionInput {
  employmentAssignmentId: string;
  planId: string;
  coverageStart: string;
  coverageEnd?: string | null;
  reason?: string;
  eligibilityOverrideReason?: string;
}

export const benefitsApi = {
  // ─── Self-service (own identity; read-only) ──────────────────────────────
  mine(): Promise<{ employeeId: string; items: Election[] }> {
    return apiRequest('/benefits/me');
  },
  myDependents(): Promise<{ items: Dependent[] }> {
    return apiRequest('/benefits/me/dependents');
  },
  myEligibility(): Promise<MyEligibility> {
    return apiRequest('/benefits/me/eligibility');
  },

  // ─── Plans ──────────────────────────────────────────────────────────────
  organizations(): Promise<{ items: BenefitOrganization[] }> {
    return apiRequest('/benefits/organizations');
  },
  plans(organizationId: string, includeArchived = false): Promise<{ items: BenefitPlan[] }> {
    const archived = includeArchived ? '&includeArchived=true' : '';
    return apiRequest(`/benefits/plans?organizationId=${enc(organizationId)}${archived}`);
  },
  plan(planId: string): Promise<BenefitPlanDetail> {
    return apiRequest(`/benefits/plans/${enc(planId)}`);
  },
  createPlan(input: PlanInput): Promise<BenefitPlan> {
    return send('POST', '/benefits/plans', input);
  },
  updatePlan(planId: string, input: PlanUpdateInput): Promise<BenefitPlan> {
    return send('PATCH', `/benefits/plans/${enc(planId)}`, input);
  },
  transitionPlan(planId: string, action: 'activate' | 'close' | 'archive'): Promise<BenefitPlan> {
    return send('POST', `/benefits/plans/${enc(planId)}/${action}`);
  },
  discontinuePlan(
    planId: string,
    input: { effectiveTo: string; endElections: boolean; reason: string },
  ): Promise<unknown> {
    return send('POST', `/benefits/plans/${enc(planId)}/discontinue`, input);
  },
  addOption(
    planId: string,
    input: { code: string; name: string; coverageLevel: CoverageLevel },
  ): Promise<BenefitOption> {
    return send('POST', `/benefits/plans/${enc(planId)}/options`, input);
  },
  updateOption(
    optionId: string,
    input: { name?: string; sortOrder?: number },
  ): Promise<BenefitOption> {
    return send('PATCH', `/benefits/options/${enc(optionId)}`, input);
  },
  archiveOption(optionId: string): Promise<BenefitOption> {
    return send('POST', `/benefits/options/${enc(optionId)}/archive`);
  },
  addRate(optionId: string, input: RateInput): Promise<BenefitRate> {
    return send('POST', `/benefits/options/${enc(optionId)}/rates`, input);
  },
  correctRate(
    rateId: string,
    input: Partial<RateInput> & { reason: string },
  ): Promise<BenefitRate> {
    return send('POST', `/benefits/rates/${enc(rateId)}/correct`, input);
  },
  addRule(planId: string, input: RuleInput): Promise<EligibilityRule> {
    return send('POST', `/benefits/plans/${enc(planId)}/eligibility-rules`, input);
  },
  endRule(ruleId: string, effectiveTo: string): Promise<EligibilityRule> {
    return send('POST', `/benefits/eligibility-rules/${enc(ruleId)}/end`, { effectiveTo });
  },
  attention(organizationId: string): Promise<{ items: AttentionItem[]; truncated?: boolean }> {
    return apiRequest(`/benefits/attention?organizationId=${enc(organizationId)}`);
  },

  /** Batch 7C (C7): module-scoped pickers (assignments, units, departments, positions). */
  options(
    organizationId: string,
    kind: BenefitOptionKind,
    filters: { search?: string; employeeId?: string; limit?: number; afterId?: string } = {},
  ): Promise<{ items: BenefitPickerOption[]; nextAfterId: string | null }> {
    return apiRequest(`/benefits/options${qs({ organizationId, kind, ...filters })}`);
  },

  // ─── Employees ──────────────────────────────────────────────────────────
  employee(employeeId: string, asOf?: string): Promise<EmployeeBenefits> {
    return apiRequest(`/benefits/employees/${enc(employeeId)}/elections${qs({ asOf })}`);
  },
  assignmentEligibility(assignmentId: string): Promise<{ plans: EligibilityPlan[] }> {
    return apiRequest(`/benefits/assignments/${enc(assignmentId)}/eligibility`);
  },
  enroll(input: ElectionInput & { optionId: string; dependentIds?: string[] }): Promise<Election> {
    return send('POST', '/benefits/elections/enroll', input);
  },
  waive(input: ElectionInput): Promise<Election> {
    return send('POST', '/benefits/elections/waive', input);
  },
  change(
    enrollmentId: string,
    input: {
      effectiveDate: string;
      optionId?: string;
      dependentIds?: string[];
      reason?: string;
      eligibilityOverrideReason?: string;
    },
  ): Promise<Election> {
    return send('POST', `/benefits/elections/${enc(enrollmentId)}/change`, input);
  },
  end(enrollmentId: string, input: { coverageEnd: string; reason?: string }): Promise<Election> {
    return send('POST', `/benefits/elections/${enc(enrollmentId)}/end`, input);
  },
  /** Batch 7C: moves sponsorship to another assignment (a fresh override when ineligible). */
  transfer(
    enrollmentId: string,
    input: {
      employmentAssignmentId: string;
      effectiveDate: string;
      reason?: string;
      eligibilityOverrideReason?: string;
    },
  ): Promise<Election> {
    return send('POST', `/benefits/elections/${enc(enrollmentId)}/transfer`, input);
  },
  /** Batch 7C: fixes a mis-recorded election (supersedes it, with a reason). */
  correct(
    enrollmentId: string,
    input: {
      reason: string;
      optionId?: string | null;
      dependentIds?: string[];
      coverageStart?: string;
      coverageEnd?: string | null;
      electedOn?: string;
      employmentAssignmentId?: string;
      eligibilityOverrideReason?: string;
    },
  ): Promise<Election> {
    return send('POST', `/benefits/elections/${enc(enrollmentId)}/correct`, input);
  },
  rescind(enrollmentId: string, reason: string): Promise<Election> {
    return send('POST', `/benefits/elections/${enc(enrollmentId)}/rescind`, { reason });
  },
  dependents(
    employeeId: string,
    includeArchived = false,
  ): Promise<{ items: Dependent[]; canManage: boolean }> {
    return apiRequest(
      `/benefits/employees/${enc(employeeId)}/dependents${qs({
        includeArchived: includeArchived || undefined,
      })}`,
    );
  },
  addDependent(employeeId: string, input: DependentInput): Promise<Dependent> {
    return send('POST', `/benefits/employees/${enc(employeeId)}/dependents`, input);
  },
  updateDependent(dependentId: string, input: Partial<DependentInput>): Promise<Dependent> {
    return send('PATCH', `/benefits/dependents/${enc(dependentId)}`, input);
  },
  archiveDependent(dependentId: string): Promise<Dependent> {
    return send('POST', `/benefits/dependents/${enc(dependentId)}/archive`);
  },
};
