import { describe, expect, it } from 'vitest';
import {
  offboardingStartHref,
  onboardingStartHref,
  readOffboardingPrefill,
  readOnboardingPrefill,
} from './offboarding-link';

const employee = '11111111-1111-4111-8111-111111111111';
const assignment = '22222222-2222-4222-8222-222222222222';

describe('offboarding prefill links (Batch 5C)', () => {
  it('round-trips the employee, organization, assignment, template and planned last day', () => {
    const href = offboardingStartHref({
      employeeId: employee,
      organizationId: assignment,
      employmentAssignmentId: assignment,
      templateId: null,
      plannedEndDate: '2026-11-30',
    });
    expect(href.endsWith('#start')).toBe(true);
    expect(readOffboardingPrefill(href.slice(href.indexOf('?'), href.indexOf('#')))).toEqual({
      employeeId: employee,
      organizationId: assignment,
      employmentAssignmentId: assignment,
      templateId: null,
      plannedEndDate: '2026-11-30',
    });
  });

  it('ignores malformed values and requires an employee', () => {
    expect(readOffboardingPrefill('?offboardAssignment=' + assignment)).toBeNull();
    expect(readOffboardingPrefill('?offboardEmployee=not-a-uuid')).toBeNull();
    expect(
      readOffboardingPrefill(
        `?offboardEmployee=${employee}&offboardAssignment=x&offboardEndDate=30/11/2026`,
      ),
    ).toEqual({
      employeeId: employee,
      organizationId: null,
      employmentAssignmentId: null,
      templateId: null,
      plannedEndDate: null,
    });
  });
});

describe('onboarding prefill links (Batch 7A)', () => {
  it('round-trips the employee, organization and assignment', () => {
    const href = onboardingStartHref({
      employeeId: employee,
      organizationId: assignment,
      employmentAssignmentId: assignment,
    });
    expect(href).toBe(
      `/admin/onboarding?onboardEmployee=${employee}&onboardOrganization=${assignment}&onboardAssignment=${assignment}#start`,
    );
    expect(readOnboardingPrefill(href.slice(href.indexOf('?'), href.indexOf('#')))).toEqual({
      employeeId: employee,
      organizationId: assignment,
      employmentAssignmentId: assignment,
    });
  });

  it('ignores malformed values and requires an employee', () => {
    expect(readOnboardingPrefill('?onboardAssignment=' + assignment)).toBeNull();
    expect(readOnboardingPrefill(`?onboardEmployee=${employee}&onboardAssignment=x`)).toEqual({
      employeeId: employee,
      organizationId: null,
      employmentAssignmentId: null,
    });
    // An offboarding link is not an onboarding prefill.
    expect(readOnboardingPrefill(`?offboardEmployee=${employee}`)).toBeNull();
  });
});
