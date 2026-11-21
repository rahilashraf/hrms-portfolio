import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthApiError } from '../../../lib/auth/types';
import type {
  BenefitPlan,
  BenefitPlanDetail,
  BenefitRate,
  PlanActions,
} from '../../../lib/benefits/types';
import { BenefitsAdminPage } from '../benefits-admin-page';

const navigate = vi.hoisted(() => vi.fn());
const mocks = vi.hoisted(() => ({
  api: {
    organizations: vi.fn(),
    plans: vi.fn(),
    plan: vi.fn(),
    createPlan: vi.fn(),
    updatePlan: vi.fn(),
    transitionPlan: vi.fn(),
    discontinuePlan: vi.fn(),
    addOption: vi.fn(),
    updateOption: vi.fn(),
    archiveOption: vi.fn(),
    addRate: vi.fn(),
    correctRate: vi.fn(),
    addRule: vi.fn(),
    endRule: vi.fn(),
    attention: vi.fn(),
    options: vi.fn(),
  },
  useAuth: vi.fn(),
}));

vi.mock('../../../lib/benefits/api', () => ({ benefitsApi: mocks.api }));
vi.mock('../../../providers/auth-provider', () => ({ useAuth: mocks.useAuth }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: navigate }) }));

const api = mocks.api;

const organization = (id: string, name: string) => ({
  id,
  name,
  code: name.toUpperCase(),
  timezone: 'America/Toronto',
  actions: { canManagePlans: true },
});

const ACTIONS: PlanActions = {
  canEdit: true,
  canEditStart: false,
  canActivate: false,
  canClose: true,
  canArchive: false,
  canManageOptions: true,
  canManageRates: true,
  canManageEligibility: true,
};

const plan = (overrides: Partial<BenefitPlan> = {}): BenefitPlan => ({
  id: 'plan-1',
  organizationId: 'org-1',
  code: 'HEALTH',
  name: 'Health',
  description: 'Extended health',
  benefitType: 'HEALTH',
  providerName: 'Carrier',
  providerReference: 'GRP-1',
  currency: 'CAD',
  status: 'ACTIVE',
  effectiveFrom: '2026-01-01',
  effectiveTo: null,
  employerContributionTaxable: false,
  showEmployerCostToEmployee: true,
  dependentChildMaxAge: 21,
  archived: false,
  optionCount: 2,
  actions: ACTIONS,
  ...overrides,
});

const rate = (overrides: Partial<BenefitRate> = {}): BenefitRate => ({
  id: 'rate-1',
  optionId: 'opt-family',
  effectiveFrom: '2026-01-01',
  effectiveTo: null,
  frequency: 'MONTHLY',
  employeeAmount: '25.00',
  employerAmount: '75.00',
  currency: 'CAD',
  recordType: 'INITIAL',
  supersededAt: null,
  reason: null,
  actions: { canCorrect: true },
  ...overrides,
});

const detail = (overrides: Partial<BenefitPlanDetail> = {}): BenefitPlanDetail => ({
  ...plan(),
  organization: { id: 'org-1', name: 'Acme', timezone: 'America/Toronto' },
  asOf: '2026-03-15',
  actions: ACTIONS,
  options: [
    {
      id: 'opt-family',
      planId: 'plan-1',
      code: 'FAMILY',
      name: 'Family',
      coverageLevel: 'FAMILY',
      sortOrder: 1,
      archived: false,
      currentAndFutureEnrollments: 0,
      actions: { canEdit: true, canArchive: true },
    },
    {
      id: 'opt-old',
      planId: 'plan-1',
      code: 'OLD',
      name: 'Old',
      coverageLevel: 'EMPLOYEE_ONLY',
      sortOrder: 2,
      archived: true,
      currentAndFutureEnrollments: 0,
      actions: { canEdit: false, canArchive: false },
    },
  ],
  rates: [
    rate(),
    rate({
      id: 'rate-0',
      employeeAmount: '20.00',
      supersededAt: '2026-02-01T00:00:00Z',
      reason: 'Carrier invoice',
      actions: { canCorrect: false },
    }),
    rate({ id: 'rate-old', optionId: 'opt-old', actions: { canCorrect: false } }),
  ],
  eligibilityRules: [
    {
      id: 'rule-1',
      effectiveFrom: '2026-01-01',
      effectiveTo: null,
      organizationalUnitId: null,
      includeSubunits: true,
      departmentId: 'dept-a',
      departmentName: 'Dept A',
      positionId: null,
      employmentTypes: ['FULL_TIME'],
      minimumServiceDays: null,
    },
  ],
  ...overrides,
});

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  mocks.useAuth.mockReturnValue({
    authorizationLoading: false,
    authorization: {
      permissions: ['benefit.plan.manage', 'benefit.read'].map((key) => ({
        key,
        scopes: [{ type: 'ORGANIZATION', id: 'org-1' }],
      })),
    },
  });
  api.organizations.mockResolvedValue({ items: [organization('org-1', 'Acme')] });
  api.plans.mockResolvedValue({ items: [plan()] });
  api.attention.mockResolvedValue({ items: [] });
  api.plan.mockResolvedValue(detail());
  api.options.mockResolvedValue({ items: [], nextAfterId: null });
});

afterEach(cleanup);

async function openPlan() {
  render(<BenefitsAdminPage />);
  fireEvent.click(await screen.findByRole('button', { name: 'Open Health' }));
  return screen.findByRole('region', { name: 'Health plan' });
}

const refusal = (status: number, code: string, message = 'Refused') =>
  new AuthApiError('conflict', status, message, { code });

describe('Benefits administration (Batch 7C)', () => {
  it('creates a plan with every field, and lists archived plans on request', async () => {
    api.createPlan.mockResolvedValue({});
    render(<BenefitsAdminPage />);
    const form = await screen.findByRole('form', { name: 'Create benefit plan' });
    const fill = (name: string, value: string) =>
      fireEvent.change(within(form).getByLabelText(name), { target: { value } });
    fill('Code', 'DENTAL');
    fill('Name', 'Dental');
    fill('Effective from', '2026-05-01');
    fill('Effective to (optional)', '2027-04-30');
    fill('Provider (optional)', 'Carrier');
    fill('Provider reference (optional)', 'GRP-9');
    fill('Description (optional)', 'Basic dental');
    fill('Children covered up to age (optional)', '21');
    fireEvent.click(within(form).getByLabelText('Show the employer cost to employees'));
    fireEvent.click(within(form).getByRole('button', { name: 'Create plan' }));
    await waitFor(() =>
      expect(api.createPlan).toHaveBeenCalledWith({
        organizationId: 'org-1',
        code: 'DENTAL',
        name: 'Dental',
        benefitType: 'HEALTH',
        currency: 'CAD',
        effectiveFrom: '2026-05-01',
        effectiveTo: '2027-04-30',
        description: 'Basic dental',
        providerName: 'Carrier',
        providerReference: 'GRP-9',
        dependentChildMaxAge: 21,
        showEmployerCostToEmployee: true,
        employerContributionTaxable: false,
      }),
    );
    fireEvent.click(screen.getByLabelText('Show archived plans'));
    await waitFor(() => expect(api.plans).toHaveBeenLastCalledWith('org-1', true));
  });

  it('edits a plan with only the fields the API accepts (start only for a draft)', async () => {
    api.updatePlan.mockResolvedValue({});
    const region = await openPlan();
    expect(within(region).getByText('GRP-1')).toBeInTheDocument();
    fireEvent.click(within(region).getByRole('button', { name: 'Edit plan' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit Health' });
    expect(within(dialog).queryByLabelText('Effective from')).not.toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('Provider reference'), {
      target: { value: 'GRP-2' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save plan' }));
    await waitFor(() =>
      expect(api.updatePlan).toHaveBeenCalledWith('plan-1', {
        name: 'Health',
        description: 'Extended health',
        providerName: 'Carrier',
        providerReference: 'GRP-2',
        dependentChildMaxAge: 21,
        showEmployerCostToEmployee: true,
        employerContributionTaxable: false,
      }),
    );
    const sent = api.updatePlan.mock.calls[0]![1] as Record<string, unknown>;
    for (const key of ['code', 'organizationId', 'currency', 'benefitType', 'effectiveTo'])
      expect(sent).not.toHaveProperty(key);
  });

  it('confirms plan transitions and discontinues only with a reason, keeping elections by default', async () => {
    api.transitionPlan.mockResolvedValue({});
    api.discontinuePlan.mockResolvedValue({});
    const region = await openPlan();
    fireEvent.click(within(region).getByRole('button', { name: 'Close to new elections' }));
    expect(api.transitionPlan).not.toHaveBeenCalled();
    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Close plan' }),
    );
    await waitFor(() => expect(api.transitionPlan).toHaveBeenCalledWith('plan-1', 'close'));

    fireEvent.click(await screen.findByRole('button', { name: 'Discontinue…' }));
    const dialog = screen.getByRole('dialog', { name: 'Discontinue Health?' });
    const submit = within(dialog).getByRole('button', { name: 'Discontinue plan' });
    fireEvent.change(within(dialog).getByLabelText('Last day of the plan'), {
      target: { value: '2026-12-31' },
    });
    expect(submit).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Reason'), {
      target: { value: 'Carrier exit' },
    });
    expect(
      within(dialog).getByRole('checkbox', { name: /Also end every election/ }),
    ).not.toBeChecked();
    fireEvent.click(submit);
    await waitFor(() =>
      expect(api.discontinuePlan).toHaveBeenCalledWith('plan-1', {
        effectiveTo: '2026-12-31',
        endElections: false,
        reason: 'Carrier exit',
      }),
    );
  });

  it('corrects only correctable rates, with a reason, and shows the rate history', async () => {
    api.correctRate.mockRejectedValueOnce(refusal(409, 'BENEFIT_ARCHIVED'));
    api.correctRate.mockResolvedValueOnce({});
    const region = await openPlan();
    expect(within(region).getByText(/Superseded rates \(1\)/)).toBeInTheDocument();
    expect(within(region).getAllByRole('button', { name: /^Correct / })).toHaveLength(1);
    fireEvent.click(
      within(region).getByRole('button', { name: 'Correct Family rate from 01/01/2026' }),
    );
    const dialog = screen.getByRole('dialog', { name: 'Correct the Family rate' });
    fireEvent.change(within(dialog).getByLabelText('Employee amount (CAD)'), {
      target: { value: '26.00' },
    });
    const submit = within(dialog).getByRole('button', { name: 'Correct rate' });
    expect(submit).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Reason for the correction'), {
      target: { value: 'Carrier invoice' },
    });
    fireEvent.click(submit);
    // The refusal is explained next to the fields.
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/archived/);
    fireEvent.click(submit);
    await waitFor(() => expect(api.correctRate).toHaveBeenCalledTimes(2));
    expect(api.correctRate).toHaveBeenLastCalledWith('rate-1', {
      effectiveFrom: '2026-01-01',
      effectiveTo: null,
      frequency: 'MONTHLY',
      employeeAmount: '26.00',
      employerAmount: '75.00',
      reason: 'Carrier invoice',
    });
  });

  it('adds a rate with an end date and explains a rate-gap refusal', async () => {
    api.addRate.mockRejectedValueOnce(refusal(409, 'BENEFIT_RATE_GAP_EXCEEDED'));
    await openPlan();
    const form = screen.getByRole('form', { name: 'Add rate' });
    fireEvent.change(within(form).getByLabelText('Rate effective from'), {
      target: { value: '2025-10-01' },
    });
    fireEvent.change(within(form).getByLabelText('Rate effective to (optional)'), {
      target: { value: '2025-12-31' },
    });
    fireEvent.change(within(form).getByLabelText('Employee amount'), {
      target: { value: '20' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Add rate' }));
    await waitFor(() =>
      expect(api.addRate).toHaveBeenCalledWith('opt-family', {
        effectiveFrom: '2025-10-01',
        effectiveTo: '2025-12-31',
        frequency: 'MONTHLY',
        employeeAmount: '20',
        employerAmount: '0.00',
      }),
    );
    expect(await screen.findByText(/A later rate starts before this one/)).toBeInTheDocument();
  });

  it('edits and archives options with row context, after confirmation', async () => {
    api.updateOption.mockResolvedValue({});
    api.archiveOption.mockResolvedValue({});
    const region = await openPlan();
    expect(within(region).queryByRole('button', { name: 'Edit option Old' })).toBeNull();
    fireEvent.click(within(region).getByRole('button', { name: 'Edit option Family' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit option Family' });
    fireEvent.change(within(dialog).getByLabelText('Option name'), {
      target: { value: 'Family plus' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save option' }));
    await waitFor(() =>
      expect(api.updateOption).toHaveBeenCalledWith('opt-family', {
        name: 'Family plus',
        sortOrder: 1,
      }),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Archive option Family' }));
    expect(api.archiveOption).not.toHaveBeenCalled();
    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Archive option' }),
    );
    await waitFor(() => expect(api.archiveOption).toHaveBeenCalledWith('opt-family'));
  });

  it('adds eligibility rules from named pickers and ends a rule with a confirmed date', async () => {
    api.options.mockImplementation((_org: string, kind: string) =>
      Promise.resolve({
        items:
          kind === 'department'
            ? [{ id: 'dept-b', label: 'Dept B', description: 'DB' }]
            : kind === 'position'
              ? [{ id: 'pos-1', label: 'Teacher' }]
              : [],
        nextAfterId: null,
      }),
    );
    api.addRule.mockResolvedValue({});
    api.endRule.mockResolvedValue({});
    const region = await openPlan();
    expect(within(region).getByText(/Department: Dept A/)).toBeInTheDocument();
    const form = screen.getByRole('form', { name: 'Add eligibility rule' });
    fireEvent.change(within(form).getByLabelText('Rule effective from'), {
      target: { value: '2026-06-01' },
    });
    fireEvent.focus(within(form).getByRole('combobox', { name: 'Department (optional)' }));
    fireEvent.click(await screen.findByRole('option', { name: /Dept B/ }));
    fireEvent.focus(within(form).getByRole('combobox', { name: 'Position (optional)' }));
    fireEvent.click(await screen.findByRole('option', { name: /Teacher/ }));
    fireEvent.click(within(form).getByLabelText(/^Part/));
    fireEvent.click(within(form).getByRole('button', { name: 'Add rule' }));
    await waitFor(() =>
      expect(api.addRule).toHaveBeenCalledWith('plan-1', {
        effectiveFrom: '2026-06-01',
        effectiveTo: null,
        organizationalUnitId: null,
        includeSubunits: true,
        departmentId: 'dept-b',
        positionId: 'pos-1',
        employmentTypes: ['PART_TIME'],
        minimumServiceDays: null,
      }),
    );
    expect(api.options).toHaveBeenCalledWith('org-1', 'department', expect.anything());
    fireEvent.click(await screen.findByRole('button', { name: /^End rule from 2026-01-01/ }));
    const dialog = screen.getByRole('dialog', { name: 'End this eligibility rule?' });
    fireEvent.change(within(dialog).getByLabelText('Last day of the rule'), {
      target: { value: '2026-05-31' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'End rule' }));
    await waitFor(() => expect(api.endRule).toHaveBeenCalledWith('rule-1', '2026-05-31'));
  });

  it('never shows the previous organization’s plans after switching', async () => {
    api.organizations.mockResolvedValue({
      items: [organization('org-1', 'Acme'), organization('org-2', 'Beta')],
    });
    let resolveSlow: (value: unknown) => void = () => undefined;
    api.plans.mockImplementation((organizationId: string) =>
      organizationId === 'org-1'
        ? new Promise((resolve) => {
            resolveSlow = resolve;
          })
        : Promise.resolve({ items: [plan({ id: 'plan-b', name: 'Beta dental' })] }),
    );
    render(<BenefitsAdminPage />);
    fireEvent.change(await screen.findByLabelText('Organization'), {
      target: { value: 'org-2' },
    });
    expect(await screen.findByRole('button', { name: 'Open Beta dental' })).toBeInTheDocument();
    resolveSlow({ items: [plan()] });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole('button', { name: 'Open Health' })).not.toBeInTheDocument();
  });

  it('says Benefits is turned off and retries, separately from the attention list', async () => {
    api.plans.mockRejectedValueOnce(
      new AuthApiError('forbidden', 403, 'Disabled', { code: 'FEATURE_DISABLED' }),
    );
    render(<BenefitsAdminPage />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/turned off/);
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('button', { name: 'Open Health' })).toBeInTheDocument();
    expect(screen.getByRole('tabpanel')).toBeInTheDocument();
  });
});
