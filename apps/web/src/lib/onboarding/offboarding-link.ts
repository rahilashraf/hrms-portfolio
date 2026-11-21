/**
 * Batch 5C: a link to the Offboarding "Start" form with the employee, assignment, default
 * template and planned last day preselected. Following it starts nothing: the administrator
 * reviews the form and starts the workflow themselves.
 */
export interface OffboardingPrefill {
  employeeId: string;
  /** The assignment's organization (the Start form is organization-scoped). */
  organizationId?: string | null;
  employmentAssignmentId?: string | null;
  templateId?: string | null;
  plannedEndDate?: string | null;
}

const PARAMS = {
  employeeId: 'offboardEmployee',
  organizationId: 'offboardOrganization',
  employmentAssignmentId: 'offboardAssignment',
  templateId: 'offboardTemplate',
  plannedEndDate: 'offboardEndDate',
} as const;

export function offboardingStartHref(prefill: OffboardingPrefill): string {
  const params = new URLSearchParams();
  for (const [key, name] of Object.entries(PARAMS) as Array<[keyof OffboardingPrefill, string]>) {
    const value = prefill[key];
    if (value) params.set(name, value);
  }
  return `/admin/onboarding?${params.toString()}#start`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Reads a prefill from the page's query string; malformed values are ignored. */
export function readOffboardingPrefill(search: string): OffboardingPrefill | null {
  const params = new URLSearchParams(search);
  const employeeId = params.get(PARAMS.employeeId);
  if (!employeeId || !UUID.test(employeeId)) return null;
  const pick = (name: string, pattern: RegExp) => {
    const value = params.get(name);
    return value && pattern.test(value) ? value : null;
  };
  return {
    employeeId,
    organizationId: pick(PARAMS.organizationId, UUID),
    employmentAssignmentId: pick(PARAMS.employmentAssignmentId, UUID),
    templateId: pick(PARAMS.templateId, UUID),
    plannedEndDate: pick(PARAMS.plannedEndDate, DATE),
  };
}

/**
 * Batch 7A: the same for the "Start onboarding" form — employee, assignment and organization
 * preselected from the employee profile. Following it starts nothing.
 */
export interface OnboardingPrefill {
  employeeId: string;
  organizationId?: string | null;
  employmentAssignmentId?: string | null;
}

const ONBOARDING_PARAMS = {
  employeeId: 'onboardEmployee',
  organizationId: 'onboardOrganization',
  employmentAssignmentId: 'onboardAssignment',
} as const;

export function onboardingStartHref(prefill: OnboardingPrefill): string {
  const params = new URLSearchParams();
  for (const [key, name] of Object.entries(ONBOARDING_PARAMS) as Array<
    [keyof OnboardingPrefill, string]
  >) {
    const value = prefill[key];
    if (value) params.set(name, value);
  }
  return `/admin/onboarding?${params.toString()}#start`;
}

/** Reads an onboarding prefill from the page's query string; malformed values are ignored. */
export function readOnboardingPrefill(search: string): OnboardingPrefill | null {
  const params = new URLSearchParams(search);
  const employeeId = params.get(ONBOARDING_PARAMS.employeeId);
  if (!employeeId || !UUID.test(employeeId)) return null;
  const pick = (name: string) => {
    const value = params.get(name);
    return value && UUID.test(value) ? value : null;
  };
  return {
    employeeId,
    organizationId: pick(ONBOARDING_PARAMS.organizationId),
    employmentAssignmentId: pick(ONBOARDING_PARAMS.employmentAssignmentId),
  };
}
