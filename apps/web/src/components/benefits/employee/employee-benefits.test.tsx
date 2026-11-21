import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthApiError } from '../../../lib/auth/types';
import type {
  Dependent,
  Election,
  EligibilityPlan,
  EmployeeBenefits,
} from '../../../lib/benefits/types';
import { EmployeeBenefitsSection } from '../employee-benefits-section';

const mocks = vi.hoisted(() => ({
  api: {
    employee: vi.fn(),
    dependents: vi.fn(),
    assignmentEligibility: vi.fn(),
    enroll: vi.fn(),
    waive: vi.fn(),
    change: vi.fn(),
    end: vi.fn(),
    rescind: vi.fn(),
    transfer: vi.fn(),
    correct: vi.fn(),
    addDependent: vi.fn(),
    updateDependent: vi.fn(),
    archiveDependent: vi.fn(),
    options: vi.fn(),
  },
}));

vi.mock('../../../lib/benefits/api', () => ({ benefitsApi: mocks.api }));

const api = mocks.api;

const ALL_ACTIONS = {
  canChange: true,
  canEnd: true,
  canTransfer: true,
  canCorrect: true,
  canRescind: true,
};

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
    providerName: null,
    currency: 'CAD',
  },
  option: { id: 'opt-family', code: 'FAMILY', name: 'Family', coverageLevel: 'FAMILY' },
  coverageStart: '2026-02-01',
  coverageEnd: null,
  electedOn: '2026-02-01',
  sponsoringAssignment: { id: 'asg-1', positionName: 'Analyst', organizationName: 'Acme' },
  dependents: [{ id: 'dep-spouse', firstName: 'Sam', lastName: 'Spouse', relationship: 'SPOUSE' }],
  cost: null,
  actions: ALL_ACTIONS,
  ...overrides,
});

const dependent = (overrides: Partial<Dependent> = {}): Dependent => ({
  id: 'dep-spouse',
  employeeId: 'emp-1',
  firstName: 'Sam',
  lastName: 'Spouse',
  relationship: 'SPOUSE',
  dateOfBirth: null,
  relationshipStartDate: null,
  relationshipEndDate: null,
  archived: false,
  canManage: true,
  ...overrides,
});

const plan = (overrides: Partial<EligibilityPlan> = {}): EligibilityPlan => ({
  planId: 'plan-1',
  code: 'HEALTH',
  name: 'Health',
  benefitType: 'HEALTH',
  status: 'ACTIVE',
  options: [
    { id: 'opt-single', code: 'SINGLE', name: 'Single', coverageLevel: 'EMPLOYEE_ONLY' },
    { id: 'opt-family', code: 'FAMILY', name: 'Family', coverageLevel: 'FAMILY' },
  ],
  eligibility: { eligible: true, reasons: [], rules: [] },
  ...overrides,
});

const employee = (items: Election[], canManage = true): EmployeeBenefits => ({
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

function setup(
  items: Election[],
  dependents: Dependent[] = [dependent()],
  options: { canManage?: boolean; eligibility?: EligibilityPlan[] } = {},
) {
  api.employee.mockResolvedValue(employee(items, options.canManage ?? true));
  api.dependents.mockResolvedValue({ items: dependents, canManage: options.canManage ?? true });
  api.assignmentEligibility.mockResolvedValue({ plans: options.eligibility ?? [plan()] });
  render(<EmployeeBenefitsSection employeeId="emp-1" />);
}

const dialog = (name: string | RegExp) => screen.getByRole('dialog', { name });

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
});
afterEach(() => cleanup());

describe('EmployeeBenefitsSection (Batch 7C)', () => {
  it('offers exactly the actions the API allows, with the plan in each label', async () => {
    setup([
      election({
        actions: {
          canChange: false,
          canEnd: true,
          canTransfer: false,
          canCorrect: false,
          canRescind: true,
        },
      }),
    ]);
    expect(await screen.findByRole('button', { name: 'End Health coverage' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Rescind Health election' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Change coverage/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /another assignment/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Correct/ })).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Benefit elections' })).toBeInTheDocument();
  });

  it('never carries one election’s form into another (regression: stale panel state)', async () => {
    setup(
      [
        election(),
        election({
          id: 'enr-2',
          plan: { ...election().plan, id: 'plan-2', name: 'Dental' },
          dependents: [],
          option: { id: 'opt-d', code: 'SINGLE', name: 'Single', coverageLevel: 'EMPLOYEE_ONLY' },
        }),
      ],
      [dependent()],
      { eligibility: [plan(), plan({ planId: 'plan-2', name: 'Dental' })] },
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Change coverage for Health' }));
    const first = dialog('Change Health coverage');
    fireEvent.change(within(first).getByLabelText('Effective from'), {
      target: { value: '2026-06-01' },
    });
    expect(within(first).getByRole('checkbox', { name: /Sam Spouse/ })).toBeChecked();
    fireEvent.click(within(first).getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Change coverage for Dental' }));
    const second = dialog('Change Dental coverage');
    expect(within(second).getByLabelText('Effective from')).toHaveValue('');
    // Dental covers nobody: the spouse is offered but not selected.
    expect(within(second).getByRole('checkbox', { name: /Sam Spouse/ })).not.toBeChecked();
  });

  it('lets a covered dependent who is archived be removed (loss of eligibility)', async () => {
    setup([election()], [dependent({ archived: true })]);
    fireEvent.click(await screen.findByRole('button', { name: 'Change coverage for Health' }));
    const form = dialog('Change Health coverage');
    await waitFor(() =>
      expect(within(form).getByLabelText('Coverage option')).toHaveTextContent('Single'),
    );
    const box = within(form).getByRole('checkbox', { name: /Sam Spouse/ });
    expect(box).toBeChecked();
    expect(box).toBeEnabled();
    expect(within(form).getByText(/Cannot be covered: archived/)).toBeInTheDocument();
    fireEvent.click(box);
    fireEvent.change(within(form).getByLabelText('Effective from'), {
      target: { value: '2026-06-01' },
    });
    fireEvent.change(within(form).getByLabelText('Coverage option'), {
      target: { value: 'opt-single' },
    });
    api.change.mockResolvedValue(election());
    fireEvent.click(within(form).getByRole('button', { name: 'Change coverage' }));
    await waitFor(() =>
      expect(api.change).toHaveBeenCalledWith('enr-1', {
        effectiveDate: '2026-06-01',
        optionId: 'opt-single',
        dependentIds: [],
      }),
    );
    expect(await screen.findByText('Coverage changed.')).toBeInTheDocument();
  });

  it('guides a divorce: records the relationship end, then covers the employee alone from the next day', async () => {
    setup([election()]);
    api.updateDependent.mockResolvedValue(dependent({ relationshipEndDate: '2026-05-31' }));
    api.change.mockResolvedValue(election());
    fireEvent.click(await screen.findByRole('button', { name: 'Remove a dependent from Health' }));
    const form = dialog('Remove a dependent from Health');
    expect(within(form).getByLabelText(/Record the end of the relationship/)).toBeChecked();
    fireEvent.change(within(form).getByLabelText('Relationship ended on'), {
      target: { value: '2026-05-31' },
    });
    expect(within(form).getByLabelText(/Coverage without them from/)).toHaveValue('2026-06-01');
    // The employee alone remains: the employee-only option is suggested.
    await waitFor(() =>
      expect(within(form).getByLabelText('Coverage option')).toHaveValue('opt-single'),
    );
    fireEvent.click(within(form).getByRole('button', { name: 'Remove from coverage' }));
    await waitFor(() => expect(api.change).toHaveBeenCalled());
    expect(api.updateDependent).toHaveBeenCalledWith('dep-spouse', {
      relationshipEndDate: '2026-05-31',
    });
    expect(api.change).toHaveBeenCalledWith('enr-1', {
      effectiveDate: '2026-06-01',
      optionId: 'opt-single',
      dependentIds: [],
    });
    expect(api.updateDependent.mock.invocationCallOrder[0]).toBeLessThan(
      api.change.mock.invocationCallOrder[0]!,
    );
  });

  it('requires a fresh override reason when the assignment is not eligible', async () => {
    setup([election()], [dependent()], {
      eligibility: [plan({ eligibility: { eligible: false, reasons: ['NO_RULE'], rules: [] } })],
    });
    api.change.mockResolvedValue(election());
    fireEvent.click(await screen.findByRole('button', { name: 'Change coverage for Health' }));
    const form = dialog('Change Health coverage');
    const override = await within(form).findByLabelText(/Eligibility override reason/);
    fireEvent.change(within(form).getByLabelText('Effective from'), {
      target: { value: '2026-06-01' },
    });
    const submit = within(form).getByRole('button', { name: 'Change coverage' });
    expect(submit).toBeDisabled();
    fireEvent.change(override, { target: { value: 'Committee exception' } });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    await waitFor(() =>
      expect(api.change).toHaveBeenCalledWith(
        'enr-1',
        expect.objectContaining({ eligibilityOverrideReason: 'Committee exception' }),
      ),
    );
  });

  it('asks for an override when the API answers not eligible', async () => {
    setup([election()]);
    api.change.mockRejectedValueOnce(
      new AuthApiError('conflict', 409, 'Not eligible.', { code: 'BENEFIT_NOT_ELIGIBLE' }),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Change coverage for Health' }));
    const form = dialog('Change Health coverage');
    fireEvent.change(within(form).getByLabelText('Effective from'), {
      target: { value: '2026-06-01' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Change coverage' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent(/override reason/);
    expect(within(form).getByLabelText(/Eligibility override reason/)).toBeInTheDocument();
  });

  it('explains later coverage instead of ending anything silently', async () => {
    setup([
      election(),
      election({
        id: 'enr-2',
        coverageStart: '2026-06-01',
        option: {
          id: 'opt-single',
          code: 'SINGLE',
          name: 'Single',
          coverageLevel: 'EMPLOYEE_ONLY',
        },
        dependents: [],
      }),
    ]);
    api.end.mockRejectedValue(
      new AuthApiError('conflict', 409, 'Coverage continues.', {
        code: 'BENEFIT_LATER_COVERAGE',
        laterElections: 2,
        elections: [{ id: 'enr-2', coverageStart: '2026-06-01', coverageEnd: null }],
      }),
    );
    fireEvent.click((await screen.findAllByRole('button', { name: 'End Health coverage' }))[0]!);
    const form = dialog('End Health coverage?');
    fireEvent.change(within(form).getByLabelText('Last day of coverage'), {
      target: { value: '2026-04-30' },
    });
    fireEvent.change(within(form).getByLabelText(/Reason/), { target: { value: 'Divorce' } });
    fireEvent.click(within(form).getByRole('button', { name: 'End coverage' }));
    const alert = await within(form).findByRole('alert');
    expect(alert).toHaveTextContent(/later election/);
    expect(alert).toHaveTextContent(/Later coverage: Health Single from/);
    expect(alert).toHaveTextContent(/1 later election outside your access/);
    expect(api.end).toHaveBeenCalledWith('enr-1', {
      coverageEnd: '2026-04-30',
      reason: 'Divorce',
    });
    // The dialog stays open; nothing was reported as ended.
    expect(screen.queryByText('Coverage ended.')).not.toBeInTheDocument();
  });

  it('moves sponsorship with a picker of the same employee’s other assignments', async () => {
    setup([election()]);
    api.options.mockResolvedValue({
      items: [
        { id: 'asg-1', label: 'Pat Doe', description: 'E1 · Analyst', employeeId: 'emp-1' },
        { id: 'asg-2', label: 'Pat Doe', description: 'E1 · Lead', employeeId: 'emp-1' },
      ],
      nextAfterId: null,
    });
    api.transfer.mockResolvedValue(election());
    fireEvent.click(
      await screen.findByRole('button', { name: 'Move Health to another assignment' }),
    );
    const form = dialog('Move Health to another assignment');
    const picker = within(form).getByRole('combobox', { name: /New sponsoring assignment/ });
    fireEvent.focus(picker);
    const list = await screen.findByRole('listbox');
    await waitFor(() => expect(within(list).getAllByRole('option')).toHaveLength(1));
    expect(within(list).queryByRole('option', { name: /Analyst/ })).not.toBeInTheDocument();
    fireEvent.click(within(list).getByRole('option', { name: /Lead/ }));
    expect(api.options).toHaveBeenCalledWith(
      'org-1',
      'assignment',
      expect.objectContaining({ employeeId: 'emp-1' }),
    );
    fireEvent.change(within(form).getByLabelText('Effective from'), {
      target: { value: '2026-07-01' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Move sponsorship' }));
    await waitFor(() =>
      expect(api.transfer).toHaveBeenCalledWith('enr-1', {
        employmentAssignmentId: 'asg-2',
        effectiveDate: '2026-07-01',
      }),
    );
  });

  it('corrects an election with a required reason, sending only what changed', async () => {
    setup([election()]);
    api.correct.mockResolvedValue(election());
    fireEvent.click(await screen.findByRole('button', { name: 'Correct Health election' }));
    const form = dialog('Correct Health election');
    const submit = within(form).getByRole('button', { name: 'Save correction' });
    expect(submit).toBeDisabled();
    fireEvent.change(within(form).getByLabelText(/Reason for the correction/), {
      target: { value: 'Entered the wrong start' },
    });
    fireEvent.change(within(form).getByLabelText('Coverage start'), {
      target: { value: '2026-02-15' },
    });
    fireEvent.click(submit);
    await waitFor(() =>
      expect(api.correct).toHaveBeenCalledWith('enr-1', {
        reason: 'Entered the wrong start',
        coverageStart: '2026-02-15',
      }),
    );
  });

  it('rescinds only with a reason, in a confirmation dialog', async () => {
    setup([election()]);
    api.rescind.mockResolvedValue(election());
    fireEvent.click(await screen.findByRole('button', { name: 'Rescind Health election' }));
    const form = dialog('Rescind Health election?');
    const submit = within(form).getByRole('button', { name: 'Rescind election' });
    expect(submit).toBeDisabled();
    fireEvent.change(within(form).getByLabelText(/Reason/), { target: { value: 'Duplicate' } });
    fireEvent.click(submit);
    await waitFor(() => expect(api.rescind).toHaveBeenCalledWith('enr-1', 'Duplicate'));
  });

  it('shows HR notes only when the API shares them', async () => {
    setup([
      election({ endReason: 'Leaving the plan', eligibilityOverrideReason: 'Committee' }),
      election({ id: 'enr-9', plan: { ...election().plan, name: 'Vision' } }),
    ]);
    const notes = await screen.findAllByRole('list', { name: 'HR notes' });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toHaveTextContent('Ended: Leaving the plan');
    expect(notes[0]).toHaveTextContent('Eligibility override: Committee');
  });

  it('records an election: plan load errors are shown, overrides required, no empty option', async () => {
    api.employee.mockResolvedValue(employee([]));
    api.dependents.mockResolvedValue({ items: [], canManage: true });
    api.assignmentEligibility.mockRejectedValueOnce(new AuthApiError('unexpected', 500));
    render(<EmployeeBenefitsSection employeeId="emp-1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Record election' }));
    const form = dialog('Record election');
    expect(await within(form).findByText(/Benefits service is unavailable/)).toBeInTheDocument();
    api.assignmentEligibility.mockResolvedValue({
      plans: [plan({ eligibility: { eligible: false, reasons: ['NO_RULE'], rules: [] } })],
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(within(form).getByLabelText('Plan')).toHaveValue('plan-1'));
    fireEvent.change(within(form).getByLabelText('Coverage starts'), {
      target: { value: '2026-04-01' },
    });
    const submit = within(form).getByRole('button', { name: 'Enroll' });
    expect(submit).toBeDisabled();
    fireEvent.change(within(form).getByLabelText(/Eligibility override reason/), {
      target: { value: 'Executive exception' },
    });
    api.enroll.mockResolvedValue(election());
    fireEvent.click(submit);
    await waitFor(() =>
      expect(api.enroll).toHaveBeenCalledWith({
        employmentAssignmentId: 'asg-1',
        planId: 'plan-1',
        coverageStart: '2026-04-01',
        eligibilityOverrideReason: 'Executive exception',
        optionId: 'opt-single',
        dependentIds: [],
      }),
    );
  });

  it('records a waiver without coverage option or dependents', async () => {
    api.employee.mockResolvedValue(employee([]));
    api.dependents.mockResolvedValue({ items: [], canManage: true });
    api.assignmentEligibility.mockResolvedValue({ plans: [plan()] });
    api.waive.mockResolvedValue(election({ electionType: 'WAIVED', option: null }));
    render(<EmployeeBenefitsSection employeeId="emp-1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Record election' }));
    const form = dialog('Record election');
    await waitFor(() => expect(within(form).getByLabelText('Plan')).toHaveValue('plan-1'));
    fireEvent.change(within(form).getByLabelText('Coverage starts'), {
      target: { value: '2026-04-01' },
    });
    fireEvent.click(within(form).getByLabelText('Employee waives this plan'));
    fireEvent.click(within(form).getByRole('button', { name: 'Record waiver' }));
    await waitFor(() =>
      expect(api.waive).toHaveBeenCalledWith({
        employmentAssignmentId: 'asg-1',
        planId: 'plan-1',
        coverageStart: '2026-04-01',
      }),
    );
    expect(await screen.findByText('Waiver recorded.')).toBeInTheDocument();
  });

  it('loads elections and dependents independently, each with a retry', async () => {
    api.employee.mockResolvedValue(employee([election()]));
    api.dependents.mockRejectedValueOnce(new AuthApiError('unexpected', 500));
    api.assignmentEligibility.mockResolvedValue({ plans: [plan()] });
    render(<EmployeeBenefitsSection employeeId="emp-1" />);
    expect(await screen.findByRole('region', { name: 'Benefit elections' })).toBeInTheDocument();
    const failure = await screen.findByText('Dependents could not be loaded');
    expect(failure).toBeInTheDocument();
    api.dependents.mockResolvedValue({ items: [dependent()], canManage: true });
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('region', { name: 'Recorded dependents' })).toHaveTextContent(
      'Sam Spouse',
    );
  });

  it('says once when the reader has no access, and when Benefits is turned off', async () => {
    api.employee.mockRejectedValue(
      new AuthApiError('forbidden', 403, undefined, { code: 'BENEFIT_PERMISSION_REQUIRED' }),
    );
    api.dependents.mockRejectedValue(new AuthApiError('forbidden', 403));
    render(<EmployeeBenefitsSection employeeId="emp-1" />);
    expect(
      await screen.findByText('You do not have access to this employee’s benefits.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    cleanup();
    api.employee.mockRejectedValue(
      new AuthApiError('forbidden', 403, undefined, { code: 'FEATURE_DISABLED' }),
    );
    render(<EmployeeBenefitsSection employeeId="emp-1" />);
    expect(await screen.findByText(/Benefits is turned off/)).toBeInTheDocument();
  });
});

describe('Dependents (Batch 7C)', () => {
  it('readers see no birth dates and no edit controls; archived dependents on request', async () => {
    api.employee.mockResolvedValue(employee([], false));
    api.dependents.mockResolvedValue({
      items: [dependent({ canManage: false })],
      canManage: false,
    });
    render(<EmployeeBenefitsSection employeeId="emp-1" />);
    const table = await screen.findByRole('region', { name: 'Recorded dependents' });
    expect(within(table).queryByText('Date of birth')).not.toBeInTheDocument();
    expect(within(table).queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add dependent' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Show archived dependents'));
    await waitFor(() => expect(api.dependents).toHaveBeenLastCalledWith('emp-1', true));
  });

  it('respects each dependent’s own scope', async () => {
    api.employee.mockResolvedValue(employee([]));
    api.dependents.mockResolvedValue({
      items: [
        dependent({ canManage: false }),
        dependent({ id: 'dep-2', firstName: 'Kit', relationship: 'CHILD', canManage: true }),
      ],
      canManage: true,
    });
    render(<EmployeeBenefitsSection employeeId="emp-1" />);
    expect(await screen.findByRole('button', { name: 'Edit Kit Spouse' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit Sam Spouse' })).not.toBeInTheDocument();
    expect(screen.getByText('Covered outside your scope')).toBeInTheDocument();
  });

  it('edits relationship dates and explains a history conflict in the dialog', async () => {
    api.employee.mockResolvedValue(employee([]));
    api.dependents.mockResolvedValue({
      items: [dependent({ dateOfBirth: '1990-05-01' })],
      canManage: true,
    });
    api.updateDependent.mockRejectedValueOnce(
      new AuthApiError('conflict', 409, 'x', { code: 'BENEFIT_DEPENDENT_HISTORY_CONFLICT' }),
    );
    render(<EmployeeBenefitsSection employeeId="emp-1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Sam Spouse' }));
    const form = dialog('Edit Sam Spouse');
    expect(within(form).getByLabelText(/Date of birth/)).toHaveValue('1990-05-01');
    fireEvent.change(within(form).getByLabelText(/Relationship start/), {
      target: { value: '2026-06-01' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Save dependent' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent(/recorded coverage invalid/);
    expect(api.updateDependent).toHaveBeenCalledWith('dep-spouse', {
      firstName: 'Sam',
      lastName: 'Spouse',
      relationship: 'SPOUSE',
      relationshipStartDate: '2026-06-01',
      relationshipEndDate: null,
      dateOfBirth: '1990-05-01',
    });
  });

  it('adds a dependent with relationship dates', async () => {
    api.employee.mockResolvedValue(employee([]));
    api.dependents.mockResolvedValue({ items: [], canManage: true });
    api.addDependent.mockResolvedValue(dependent());
    render(<EmployeeBenefitsSection employeeId="emp-1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add dependent' }));
    const form = dialog('Add dependent');
    fireEvent.change(within(form).getByLabelText('First name'), { target: { value: 'Kit' } });
    fireEvent.change(within(form).getByLabelText('Last name'), { target: { value: 'Doe' } });
    fireEvent.change(within(form).getByLabelText('Relationship'), {
      target: { value: 'CHILD' },
    });
    const submit = within(form).getByRole('button', { name: 'Add dependent' });
    expect(submit).toBeDisabled();
    fireEvent.change(within(form).getByLabelText('Date of birth'), {
      target: { value: '2015-07-01' },
    });
    fireEvent.change(within(form).getByLabelText(/Relationship start/), {
      target: { value: '2015-07-01' },
    });
    fireEvent.click(submit);
    await waitFor(() =>
      expect(api.addDependent).toHaveBeenCalledWith('emp-1', {
        firstName: 'Kit',
        lastName: 'Doe',
        relationship: 'CHILD',
        relationshipStartDate: '2015-07-01',
        relationshipEndDate: null,
        dateOfBirth: '2015-07-01',
      }),
    );
    expect(await screen.findByText('Dependent added.')).toBeInTheDocument();
  });
});
