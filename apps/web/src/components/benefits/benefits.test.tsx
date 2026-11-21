import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthApiError } from '../../lib/auth/types';
import type { Election, EligibilityPlan } from '../../lib/benefits/types';
import { BenefitsAdminPage } from './benefits-admin-page';
import { EmployeeBenefitsSection } from './employee-benefits-section';
import { MyBenefitsPage } from './my-benefits-page';

const navigate = vi.hoisted(() => vi.fn());
const mocks = vi.hoisted(() => ({
  api: {
    mine: vi.fn(),
    myDependents: vi.fn(),
    myEligibility: vi.fn(),
    organizations: vi.fn(),
    plans: vi.fn(),
    plan: vi.fn(),
    createPlan: vi.fn(),
    updatePlan: vi.fn(),
    transitionPlan: vi.fn(),
    discontinuePlan: vi.fn(),
    addOption: vi.fn(),
    archiveOption: vi.fn(),
    addRate: vi.fn(),
    correctRate: vi.fn(),
    addRule: vi.fn(),
    endRule: vi.fn(),
    attention: vi.fn(),
    employee: vi.fn(),
    assignmentEligibility: vi.fn(),
    enroll: vi.fn(),
    waive: vi.fn(),
    change: vi.fn(),
    end: vi.fn(),
    rescind: vi.fn(),
    dependents: vi.fn(),
    addDependent: vi.fn(),
    archiveDependent: vi.fn(),
  },
  useAuth: vi.fn(),
}));

vi.mock('../../lib/benefits/api', () => ({ benefitsApi: mocks.api }));
vi.mock('../../providers/auth-provider', () => ({ useAuth: mocks.useAuth }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: navigate }) }));

const api = mocks.api;
const auth = (keys: string[]) =>
  mocks.useAuth.mockReturnValue({
    authorizationLoading: false,
    authorization: {
      permissions: keys.map((key) => ({ key, scopes: [{ type: 'ORGANIZATION', id: 'org-1' }] })),
    },
  });

const election = (overrides: Partial<Election> = {}): Election => ({
  id: 'enr-1',
  status: 'ACTIVE',
  electionType: 'ENROLLED',
  recordType: 'INITIAL',
  plan: {
    id: 'plan-1',
    code: 'HEALTH',
    name: 'Health',
    benefitType: 'HEALTH',
    providerName: 'Carrier Co',
    currency: 'CAD',
  },
  option: { id: 'opt-1', code: 'SINGLE', name: 'Single', coverageLevel: 'EMPLOYEE_ONLY' },
  coverageStart: '2026-01-01',
  coverageEnd: null,
  electedOn: '2026-01-01',
  sponsoringAssignment: { id: 'asg-1', positionName: 'Analyst', organizationName: 'Acme' },
  dependents: [],
  cost: {
    rateId: 'rate-1',
    asOf: '2026-03-15',
    frequency: 'MONTHLY',
    currency: 'CAD',
    employeeAmount: '25.00',
    employerAmount: null,
  },
  ...overrides,
});

const eligibilityPlan = (overrides: Partial<EligibilityPlan> = {}): EligibilityPlan => ({
  planId: 'plan-2',
  code: 'DENTAL',
  name: 'Dental plus',
  benefitType: 'DENTAL',
  status: 'ACTIVE',
  options: [{ id: 'opt-d', code: 'SINGLE', name: 'Dental single', coverageLevel: 'EMPLOYEE_ONLY' }],
  eligibility: { eligible: true, reasons: [], rules: [] },
  ...overrides,
});

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  mocks.useAuth.mockReset();
});

// Batch 10E-2: tab clicks now write the section into the URL (#hash); every test starts from a
// clean address so one test's tab does not open the next.
afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
});

describe('MyBenefitsPage', () => {
  it('shows own coverage read-only with only eligible, unelected plans offered', async () => {
    api.mine.mockResolvedValue({
      employeeId: 'emp-1',
      items: [
        election(),
        election({
          id: 'enr-old',
          status: 'ENDED',
          coverageEnd: '2025-12-31',
          plan: { ...election().plan, id: 'plan-9', name: 'Old vision' },
        }),
      ],
    });
    api.myDependents.mockResolvedValue({
      items: [
        {
          id: 'dep-1',
          employeeId: 'emp-1',
          firstName: 'Sam',
          lastName: 'Doe',
          relationship: 'CHILD',
          dateOfBirth: '2015-04-01',
          relationshipStartDate: null,
          relationshipEndDate: null,
          archived: false,
        },
      ],
    });
    api.myEligibility.mockResolvedValue({
      items: [
        {
          assignmentId: 'asg-1',
          positionName: 'Analyst',
          organization: 'Acme',
          date: '2026-03-15',
          plans: [
            eligibilityPlan(),
            eligibilityPlan({ planId: 'plan-1', name: 'Health' }),
            eligibilityPlan({
              planId: 'plan-3',
              name: 'Executive life',
              eligibility: { eligible: false, reasons: ['NO_MATCHING_RULE'], rules: [] },
            }),
          ],
        },
      ],
    });
    render(<MyBenefitsPage />);
    // Each part loads on its own and its region (with a loading line) renders before its data:
    // wait for the data itself, not for the region (Batch R3.5: this raced under load).
    const current = await screen.findByRole('region', { name: 'Current and upcoming' });
    expect(await within(current).findByText('Health')).toBeInTheDocument();
    expect(within(current).getByText('CAD 25.00 monthly')).toBeInTheDocument();
    // "Offered" appears only once both the elections and the eligibility have loaded.
    const offered = await screen.findByRole('region', { name: 'Plans you are eligible for' });
    expect(await within(offered).findByText('Dental plus')).toBeInTheDocument();
    expect(within(offered).queryByText('Executive life')).not.toBeInTheDocument();
    expect(within(offered).queryByText('Health')).not.toBeInTheDocument();
    expect(await screen.findByRole('region', { name: 'Past coverage' })).toHaveTextContent(
      'Old vision',
    );
    expect(await screen.findByText('Sam Doe')).toBeInTheDocument();
    // Self-service is read-only in Phase 11.
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('explains when the account has no employee record', async () => {
    api.mine.mockRejectedValue(
      new AuthApiError('forbidden', 403, undefined, { code: 'BENEFIT_NOT_AN_EMPLOYEE' }),
    );
    api.myDependents.mockResolvedValue({ items: [] });
    api.myEligibility.mockResolvedValue({ items: [] });
    render(<MyBenefitsPage />);
    expect(await screen.findByText(/not linked to an employee record/)).toBeInTheDocument();
  });
});

describe('EmployeeBenefitsSection', () => {
  const employee = (canManage: boolean, items: Election[]) => ({
    employeeId: 'emp-1',
    canManage,
    sponsoringAssignments: [
      {
        id: 'asg-1',
        positionName: 'Analyst',
        organizationId: 'org-1',
        status: 'ACTIVE',
        startDate: '2025-01-01',
        endDate: null,
      },
    ],
    items,
  });

  it('shows elections, flags and history without write controls for readers', async () => {
    api.employee.mockResolvedValue(
      employee(false, [
        election({ flags: ['SPONSOR_NOT_ON_PAYROLL'] }),
        election({ id: 'enr-x', status: 'SUPERSEDED', supersessionReason: 'Entered in error' }),
      ]),
    );
    api.dependents.mockResolvedValue({ items: [], canManage: false });
    render(<EmployeeBenefitsSection employeeId="emp-1" />);
    expect(
      await screen.findByText('Sponsoring assignment is not on payroll', { exact: false }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Entered in error/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Record election' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Change' })).not.toBeInTheDocument();
  });

  it('records a waiver without coverage option or dependents', async () => {
    api.employee.mockResolvedValue(employee(true, []));
    api.dependents.mockResolvedValue({ items: [], canManage: true });
    api.assignmentEligibility.mockResolvedValue({ plans: [eligibilityPlan()] });
    api.waive.mockResolvedValue(
      election({ electionType: 'WAIVED', status: 'WAIVED', option: null }),
    );
    render(<EmployeeBenefitsSection employeeId="emp-1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Record election' }));
    const form = await screen.findByRole('dialog', { name: 'Record election' });
    await waitFor(() => expect(within(form).getByLabelText('Plan')).toHaveValue('plan-2'));
    fireEvent.change(within(form).getByLabelText('Coverage starts'), {
      target: { value: '2026-04-01' },
    });
    fireEvent.click(within(form).getByLabelText('Employee waives this plan'));
    fireEvent.click(within(form).getByRole('button', { name: 'Record waiver' }));
    await waitFor(() =>
      expect(api.waive).toHaveBeenCalledWith({
        employmentAssignmentId: 'asg-1',
        planId: 'plan-2',
        coverageStart: '2026-04-01',
      }),
    );
    expect(api.enroll).not.toHaveBeenCalled();
    expect(await screen.findByText('Waiver recorded.')).toBeInTheDocument();
  });

  it('requires an override reason field only when the assignment is not eligible', async () => {
    api.employee.mockResolvedValue(employee(true, []));
    api.dependents.mockResolvedValue({ items: [], canManage: true });
    api.assignmentEligibility.mockResolvedValue({
      plans: [
        eligibilityPlan({
          eligibility: { eligible: false, reasons: ['NO_MATCHING_RULE'], rules: [] },
        }),
      ],
    });
    api.enroll.mockRejectedValue(new AuthApiError('conflict', 409, 'Not eligible.'));
    render(<EmployeeBenefitsSection employeeId="emp-1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Record election' }));
    const form = await screen.findByRole('dialog', { name: 'Record election' });
    const override = await within(form).findByLabelText(/Eligibility override reason/);
    fireEvent.change(override, { target: { value: 'Executive exception' } });
    fireEvent.change(within(form).getByLabelText('Coverage starts'), {
      target: { value: '2026-04-01' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Enroll' }));
    await waitFor(() =>
      expect(api.enroll).toHaveBeenCalledWith({
        employmentAssignmentId: 'asg-1',
        planId: 'plan-2',
        coverageStart: '2026-04-01',
        eligibilityOverrideReason: 'Executive exception',
        optionId: 'opt-d',
        dependentIds: [],
      }),
    );
  });

  it('offers only the lifecycle actions the API allows', async () => {
    api.employee.mockResolvedValue(
      employee(true, [
        election({
          actions: {
            canChange: false,
            canEnd: true,
            canTransfer: false,
            canCorrect: false,
            canRescind: true,
          },
        }),
      ]),
    );
    api.dependents.mockResolvedValue({ items: [], canManage: true });
    render(<EmployeeBenefitsSection employeeId="emp-1" />);
    expect(await screen.findByRole('button', { name: 'End Health coverage' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Rescind Health election' })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Change coverage for Health' }),
    ).not.toBeInTheDocument();
  });
});

describe('BenefitsAdminPage', () => {
  const organization = (canManagePlans: boolean) => ({
    id: 'org-1',
    name: 'Acme',
    code: 'ACME',
    timezone: 'America/Toronto',
    actions: { canManagePlans },
  });

  it('is forbidden without a benefit permission, even for payroll and HR roles', () => {
    auth(['payroll.manage', 'employee.manage', 'compensation.manage']);
    render(<BenefitsAdminPage />);
    expect(screen.getByText('You do not have permission to view benefits.')).toBeInTheDocument();
    expect(api.organizations).not.toHaveBeenCalled();
  });

  it('lists plans read-only for benefit readers and shows attention items', async () => {
    auth(['benefit.read']);
    api.organizations.mockResolvedValue({ items: [organization(false)] });
    api.plans.mockResolvedValue({
      items: [
        {
          id: 'plan-1',
          organizationId: 'org-1',
          code: 'HEALTH',
          name: 'Health',
          description: null,
          benefitType: 'HEALTH',
          providerName: null,
          providerReference: null,
          currency: 'CAD',
          status: 'ACTIVE',
          effectiveFrom: '2026-01-01',
          effectiveTo: null,
          employerContributionTaxable: false,
          showEmployerCostToEmployee: false,
          dependentChildMaxAge: 21,
          archived: false,
          optionCount: 2,
        },
      ],
    });
    api.attention.mockResolvedValue({
      items: [
        {
          enrollmentId: 'enr-1',
          employeeId: 'emp-1',
          employeeNumber: 'E-1',
          displayName: 'Ada Lovelace',
          plan: { id: 'plan-1', code: 'HEALTH', name: 'Health' },
          coverageStart: '2026-01-01',
          coverageEnd: null,
          flags: ['ELIGIBILITY_LOST'],
        },
      ],
    });
    render(<BenefitsAdminPage />);
    expect(await screen.findByRole('button', { name: 'Open Health' })).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Create benefit plan' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Needs attention' }));
    // Batch 7C: each section loads on its own.
    expect(await screen.findByRole('link', { name: 'Ada Lovelace' })).toHaveAttribute(
      'href',
      '/admin/benefits/employees/emp-1',
    );
    expect(screen.getByText(/No longer eligible/)).toBeInTheDocument();
  });

  it('lets plan managers create plans and add rates as decimal strings', async () => {
    auth(['benefit.plan.manage']);
    api.organizations.mockResolvedValue({ items: [organization(true)] });
    api.plans.mockResolvedValue({ items: [] });
    api.attention.mockResolvedValue({ items: [] });
    api.createPlan.mockResolvedValue({});
    render(<BenefitsAdminPage />);
    const form = await screen.findByRole('form', { name: 'Create benefit plan' });
    fireEvent.change(within(form).getByLabelText('Code'), { target: { value: 'DENTAL' } });
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'Dental' } });
    fireEvent.change(within(form).getByLabelText('Effective from'), {
      target: { value: '2026-05-01' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Create plan' }));
    await waitFor(() =>
      expect(api.createPlan).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: 'org-1',
          code: 'DENTAL',
          benefitType: 'HEALTH',
          currency: 'CAD',
          effectiveFrom: '2026-05-01',
        }),
      ),
    );
    expect(await screen.findByText('Benefit plan created.')).toBeInTheDocument();
  });
});
