import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { expectNoAxeViolations } from '../../test/axe';
import { AuthApiError } from '../../lib/auth/types';
import type { CompensationAssignmentView } from '../../lib/compensation/types';
import { CompensationOnDate } from './compensation-shared';
import { EmployeeCompensationSection } from './employee-compensation-section';
import { MyCompensationPage } from './my-compensation-page';
import { PayGroupAdminPage } from './pay-group-admin-page';

const mocks = vi.hoisted(() => ({
  me: vi.fn(),
  employee: vi.fn(),
  create: vi.fn(),
  change: vi.fn(),
  correct: vi.fn(),
  end: vi.fn(),
  asOf: vi.fn(),
  payGroupOrganizations: vi.fn(),
  payGroups: vi.fn(),
  createPayGroup: vi.fn(),
  updatePayGroup: vi.fn(),
  archivePayGroup: vi.fn(),
  useAuth: vi.fn(),
}));

vi.mock('../../lib/compensation/api', () => ({
  compensationApi: {
    me: mocks.me,
    employee: mocks.employee,
    create: mocks.create,
    change: mocks.change,
    correct: mocks.correct,
    end: mocks.end,
    asOf: mocks.asOf,
    payGroupOrganizations: mocks.payGroupOrganizations,
    payGroups: mocks.payGroups,
    createPayGroup: mocks.createPayGroup,
    updatePayGroup: mocks.updatePayGroup,
    archivePayGroup: mocks.archivePayGroup,
  },
}));
vi.mock('../../providers/auth-provider', () => ({ useAuth: mocks.useAuth }));

const payGroup = { id: 'group-1', code: 'HBL-BIWEEKLY', name: 'HBL Biweekly' };

const record = (overrides: Record<string, unknown> = {}) => ({
  id: 'record-1',
  employmentAssignmentId: 'assignment-1',
  recordType: 'INITIAL',
  payBasis: 'HOURLY',
  rateAmount: '24.5000',
  salaryArrangement: null,
  salaryMonthlyAmount: null,
  salaryPaidMonths: null,
  salaryContractAmount: null,
  salaryPeriodStart: null,
  salaryPeriodEnd: null,
  currency: 'CAD',
  effectiveFrom: '2026-01-01',
  effectiveTo: '2026-06-30',
  payGroup,
  reason: null,
  supersedesRecordId: null,
  supersededAt: null,
  createdAt: '2026-01-02T00:00:00.000Z',
  actions: { canCorrect: true, canEnd: true },
  ...overrides,
});

const raise = record({
  id: 'record-2',
  recordType: 'CHANGE',
  rateAmount: '26.0000',
  effectiveFrom: '2026-07-01',
  effectiveTo: null,
  reason: 'Annual review',
});

const view = (overrides: Record<string, unknown> = {}) => ({
  assignment: {
    id: 'assignment-1',
    status: 'ACTIVE',
    employmentType: 'FULL_TIME',
    isPrimary: true,
    startDate: '2026-01-01',
    endDate: null,
    employee: { id: 'employee-1', employeeNumber: 'E-1', displayName: 'Ada Lovelace' },
    position: { id: 'position-1', name: 'Counsellor', code: 'COUN' },
    organization: { id: 'org-1', name: 'Camp', code: 'CAMP' },
  },
  asOf: '2026-10-05',
  current: raise,
  timeline: [record(), raise],
  superseded: [],
  actions: { canCreate: true, canChange: true },
  ...overrides,
});

const readOnly = (value: ReturnType<typeof view>) => ({
  ...value,
  timeline: value.timeline.map((r) => ({ ...r, actions: { canCorrect: false, canEnd: false } })),
  actions: { canCreate: false, canChange: false },
});

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.employee.mockResolvedValue({ employeeId: 'employee-1', assignments: [view()] });
  mocks.payGroups.mockResolvedValue({
    items: [
      {
        ...payGroup,
        organizationId: 'org-1',
        description: null,
        archivedAt: null,
        actions: { canEdit: true, canArchive: true },
      },
    ],
  });
  mocks.change.mockResolvedValue({ record: raise, previous: record() });
  mocks.correct.mockResolvedValue(record());
  mocks.end.mockResolvedValue(record());
  mocks.create.mockResolvedValue(record());
});
afterEach(cleanup);

describe('EmployeeCompensationSection', () => {
  it('shows the current rate, the history and the management actions the API allows', async () => {
    render(<EmployeeCompensationSection employeeId="employee-1" />);
    const card = await screen.findByRole('article', { name: 'Compensation for Counsellor · Camp' });
    expect(within(card).getAllByText('CAD 26.00 / hour').length).toBeGreaterThan(0);
    expect(within(card).getByText('07/01/2026 – ongoing', { selector: 'dd' })).toBeInTheDocument();
    const table = within(card).getByRole('table');
    expect(within(table).getByText('01/01/2026 – 06/30/2026')).toBeInTheDocument();
    expect(within(table).getByText('Annual review')).toBeInTheDocument();
    expect(within(table).getByText('Current')).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Change compensation' })).toBeInTheDocument();
    expect(within(card).getAllByRole('button', { name: /^Correct record/ })).toHaveLength(2);
  });

  it('hides every write action for read-only access', async () => {
    mocks.employee.mockResolvedValue({ employeeId: 'employee-1', assignments: [readOnly(view())] });
    render(<EmployeeCompensationSection employeeId="employee-1" />);
    await screen.findByRole('table');
    expect(screen.queryByRole('button', { name: 'Change compensation' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add compensation' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Correct record/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Actions' })).not.toBeInTheDocument();
  });

  it('submits a change with the amount as a string, validates it first and refreshes', async () => {
    render(<EmployeeCompensationSection employeeId="employee-1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Change compensation' }));
    const form = screen.getByRole('form', { name: 'Change compensation' });
    fireEvent.change(within(form).getByLabelText('Hourly rate'), {
      target: { value: '27.123456' },
    });
    fireEvent.change(within(form).getByLabelText('Effective from'), {
      target: { value: '2026-11-01' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Save change' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent('up to 4 decimals');
    expect(mocks.change).not.toHaveBeenCalled();

    fireEvent.change(within(form).getByLabelText('Hourly rate'), { target: { value: '27.25' } });
    fireEvent.change(within(form).getByLabelText('Reason (optional)'), {
      target: { value: 'Promotion' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Save change' }));
    await waitFor(() =>
      expect(mocks.change).toHaveBeenCalledWith('assignment-1', {
        payBasis: 'HOURLY',
        rateAmount: '27.25',
        currency: 'CAD',
        effectiveFrom: '2026-11-01',
        reason: 'Promotion',
      }),
    );
    expect(await screen.findByText('Compensation changed.')).toBeInTheDocument();
    expect(mocks.employee).toHaveBeenCalledTimes(2);
  });

  it('requires a reason for a correction and sends only the corrected fields', async () => {
    render(<EmployeeCompensationSection employeeId="employee-1" />);
    fireEvent.click((await screen.findAllByRole('button', { name: /^Correct record/ }))[0]!);
    const form = screen.getByRole('form', { name: 'Correct compensation record' });
    fireEvent.change(within(form).getByLabelText('Hourly rate'), { target: { value: '24.75' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save correction' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent(
      'A correction needs a reason.',
    );
    fireEvent.change(within(form).getByLabelText('Reason'), {
      target: { value: 'Offer letter said 24.75' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Save correction' }));
    await waitFor(() =>
      expect(mocks.correct).toHaveBeenCalledWith('assignment-1', 'record-1', {
        reason: 'Offer letter said 24.75',
        rateAmount: '24.75',
      }),
    );
  });

  it('keeps a contract-total correction’s rate and contract metadata in step', async () => {
    const contract = record({
      payBasis: 'SALARY',
      rateAmount: '40000.0000',
      salaryArrangement: 'CONTRACT_TOTAL',
      salaryContractAmount: '40000.0000',
      salaryPeriodStart: '2026-09-01',
      salaryPeriodEnd: '2027-06-30',
      effectiveFrom: '2026-09-01',
      effectiveTo: '2027-06-30',
    });
    mocks.employee.mockResolvedValue({
      employeeId: 'employee-1',
      assignments: [view({ current: contract, timeline: [contract] })],
    });
    render(<EmployeeCompensationSection employeeId="employee-1" />);
    fireEvent.click((await screen.findAllByRole('button', { name: /^Correct record/ }))[0]!);
    const form = screen.getByRole('form', { name: 'Correct compensation record' });
    fireEvent.change(within(form).getByLabelText('Contract total'), {
      target: { value: '42000' },
    });
    fireEvent.change(within(form).getByLabelText('Reason'), {
      target: { value: 'Signed contract says 42000' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Save correction' }));
    await waitFor(() =>
      expect(mocks.correct).toHaveBeenCalledWith('assignment-1', 'record-1', {
        reason: 'Signed contract says 42000',
        rateAmount: '42000',
        salaryArrangement: 'CONTRACT_TOTAL',
        salaryContractAmount: '42000',
        salaryPeriodStart: '2026-09-01',
        salaryPeriodEnd: '2027-06-30',
      }),
    );
  });

  it('re-derives a fixed-period correction from the monthly salary', async () => {
    const fixed = record({
      payBasis: 'SALARY',
      rateAmount: '4000.0000',
      salaryArrangement: 'FIXED_PERIOD',
      salaryMonthlyAmount: '4000.0000',
      salaryPaidMonths: 10,
      salaryContractAmount: '40000.0000',
      salaryPeriodStart: '2026-09-01',
      salaryPeriodEnd: '2027-06-30',
      effectiveFrom: '2026-09-01',
      effectiveTo: '2027-06-30',
    });
    mocks.employee.mockResolvedValue({
      employeeId: 'employee-1',
      assignments: [view({ current: fixed, timeline: [fixed] })],
    });
    render(<EmployeeCompensationSection employeeId="employee-1" />);
    fireEvent.click((await screen.findAllByRole('button', { name: /^Correct record/ }))[0]!);
    const form = screen.getByRole('form', { name: 'Correct compensation record' });
    expect(within(form).getByLabelText('Contract total')).toHaveValue('40,000.00');
    fireEvent.change(within(form).getByLabelText('Monthly salary'), {
      target: { value: '4200' },
    });
    expect(within(form).getByLabelText('Contract total')).toHaveValue('42,000.00');
    expect(within(form).getByLabelText('Paid through')).toHaveValue('06/30/2027');
    fireEvent.change(within(form).getByLabelText('Reason'), { target: { value: 'Typo' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save correction' }));
    await waitFor(() =>
      expect(mocks.correct).toHaveBeenCalledWith('assignment-1', 'record-1', {
        reason: 'Typo',
        rateAmount: '4200',
        salaryArrangement: 'FIXED_PERIOD',
        salaryMonthlyAmount: '4200',
        salaryPaidMonths: 10,
        salaryContractAmount: '42000',
        salaryPeriodStart: '2026-09-01',
        salaryPeriodEnd: '2027-06-30',
      }),
    );
  });

  it('changes an annual salary into a fixed period starting on its paid period start', async () => {
    const annual = record({
      payBasis: 'SALARY',
      rateAmount: '62000.0000',
      salaryArrangement: 'ANNUAL',
      effectiveTo: null,
    });
    mocks.employee.mockResolvedValue({
      employeeId: 'employee-1',
      assignments: [view({ current: annual, timeline: [annual] })],
    });
    render(<EmployeeCompensationSection employeeId="employee-1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Change compensation' }));
    const form = screen.getByRole('form', { name: 'Change compensation' });
    fireEvent.change(within(form).getByLabelText('Salary arrangement'), {
      target: { value: 'FIXED_PERIOD' },
    });
    fireEvent.change(within(form).getByLabelText('Monthly salary'), {
      target: { value: '4000' },
    });
    fireEvent.change(within(form).getByLabelText('Paid months'), { target: { value: '10' } });
    fireEvent.change(within(form).getByLabelText('Paid period start'), {
      target: { value: '2026-09-01' },
    });
    expect(within(form).queryByLabelText('Effective from')).not.toBeInTheDocument();
    fireEvent.click(within(form).getByRole('button', { name: 'Save change' }));
    await waitFor(() =>
      expect(mocks.change).toHaveBeenCalledWith('assignment-1', {
        payBasis: 'SALARY',
        rateAmount: '4000',
        salaryArrangement: 'FIXED_PERIOD',
        salaryMonthlyAmount: '4000',
        salaryPaidMonths: 10,
        salaryContractAmount: '40000',
        salaryPeriodStart: '2026-09-01',
        salaryPeriodEnd: '2027-06-30',
        currency: 'CAD',
        effectiveFrom: '2026-09-01',
      }),
    );
  });

  it('shows the server’s conflict message and keeps the form open', async () => {
    mocks.end.mockRejectedValueOnce(
      new AuthApiError(
        'conflict',
        409,
        'Ending only moves a period’s end earlier; correct the record to extend it.',
      ),
    );
    render(<EmployeeCompensationSection employeeId="employee-1" />);
    fireEvent.click((await screen.findAllByRole('button', { name: /^End record/ }))[0]!);
    const form = screen.getByRole('form', { name: 'End compensation period' });
    fireEvent.change(within(form).getByLabelText('Last effective date'), {
      target: { value: '2026-07-31' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'End period' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent(
      'Ending only moves a period’s end earlier',
    );
    expect(mocks.end).toHaveBeenCalledWith('assignment-1', 'record-1', {
      effectiveTo: '2026-07-31',
    });
  });

  it('adds a first period from the assignment start', async () => {
    mocks.employee.mockResolvedValue({
      employeeId: 'employee-1',
      assignments: [
        view({ current: null, timeline: [], actions: { canCreate: true, canChange: false } }),
      ],
    });
    render(<EmployeeCompensationSection employeeId="employee-1" />);
    expect(
      await screen.findByText('No compensation recorded for this assignment.'),
    ).toBeInTheDocument();
    expect(screen.getByText('No compensation is in effect on 10/05/2026.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add compensation' }));
    const form = screen.getByRole('form', { name: 'Add compensation' });
    fireEvent.change(within(form).getByLabelText('Pay basis'), { target: { value: 'SALARY' } });
    fireEvent.change(within(form).getByLabelText('Annual salary'), { target: { value: '62000' } });
    fireEvent.change(within(form).getByLabelText('Currency'), { target: { value: 'cad' } });
    await waitFor(() =>
      expect(within(form).getByRole('option', { name: /HBL Biweekly/ })).toBeInTheDocument(),
    );
    fireEvent.change(within(form).getByLabelText('Pay group'), { target: { value: 'group-1' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Add compensation' }));
    await waitFor(() =>
      expect(mocks.create).toHaveBeenCalledWith('assignment-1', {
        payBasis: 'SALARY',
        rateAmount: '62000',
        salaryArrangement: 'ANNUAL',
        currency: 'CAD',
        payGroupId: 'group-1',
        effectiveFrom: '2026-01-01',
      }),
    );
  });

  it('submits fixed-period salary arrangement metadata', async () => {
    mocks.employee.mockResolvedValue({
      employeeId: 'employee-1',
      assignments: [
        view({ current: null, timeline: [], actions: { canCreate: true, canChange: false } }),
      ],
    });
    render(<EmployeeCompensationSection employeeId="employee-1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add compensation' }));
    const form = screen.getByRole('form', { name: 'Add compensation' });
    fireEvent.change(within(form).getByLabelText('Pay basis'), { target: { value: 'SALARY' } });
    fireEvent.change(within(form).getByLabelText('Salary arrangement'), {
      target: { value: 'FIXED_PERIOD' },
    });
    fireEvent.change(within(form).getByLabelText('Monthly salary'), {
      target: { value: '4000' },
    });
    fireEvent.change(within(form).getByLabelText('Paid months'), { target: { value: '10' } });
    fireEvent.change(within(form).getByLabelText('Paid period start'), {
      target: { value: '2026-09-01' },
    });
    // Contract total and paid-through date are derived and read-only; no effective dates typed.
    expect(within(form).getByLabelText('Contract total')).toHaveValue('40,000.00');
    expect(within(form).getByLabelText('Contract total')).toHaveAttribute('readonly');
    expect(within(form).getByLabelText('Paid through')).toHaveValue('06/30/2027');
    expect(within(form).getByLabelText('Paid through')).toHaveAttribute('readonly');
    expect(within(form).queryByLabelText('Effective from')).not.toBeInTheDocument();
    expect(within(form).queryByLabelText('Effective to (optional)')).not.toBeInTheDocument();
    expect(
      within(form).getByText('Effective 09/01/2026 – 06/30/2027 — the paid period.'),
    ).toBeInTheDocument();
    fireEvent.change(within(form).getByLabelText('Currency'), { target: { value: 'cad' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Add compensation' }));
    await waitFor(() =>
      expect(mocks.create).toHaveBeenCalledWith('assignment-1', {
        payBasis: 'SALARY',
        rateAmount: '4000',
        salaryArrangement: 'FIXED_PERIOD',
        salaryMonthlyAmount: '4000',
        salaryPaidMonths: 10,
        salaryContractAmount: '40000',
        salaryPeriodStart: '2026-09-01',
        salaryPeriodEnd: '2027-06-30',
        currency: 'CAD',
        payGroupId: null,
        effectiveFrom: '2026-09-01',
        effectiveTo: '2027-06-30',
      }),
    );
  });

  it('requires a fixed-period salary to start on the first day of a month', async () => {
    mocks.employee.mockResolvedValue({
      employeeId: 'employee-1',
      assignments: [
        view({ current: null, timeline: [], actions: { canCreate: true, canChange: false } }),
      ],
    });
    render(<EmployeeCompensationSection employeeId="employee-1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add compensation' }));
    const form = screen.getByRole('form', { name: 'Add compensation' });
    fireEvent.change(within(form).getByLabelText('Pay basis'), { target: { value: 'SALARY' } });
    fireEvent.change(within(form).getByLabelText('Salary arrangement'), {
      target: { value: 'FIXED_PERIOD' },
    });
    fireEvent.change(within(form).getByLabelText('Monthly salary'), {
      target: { value: '4000' },
    });
    fireEvent.change(within(form).getByLabelText('Paid months'), { target: { value: '10' } });
    fireEvent.change(within(form).getByLabelText('Paid period start'), {
      target: { value: '2026-09-15' },
    });
    expect(within(form).getByLabelText('Paid through')).toHaveValue('');
    fireEvent.change(within(form).getByLabelText('Currency'), { target: { value: 'cad' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Add compensation' }));
    expect(
      await within(form).findByText('The paid period must start on the first day of a month.'),
    ).toBeInTheDocument();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('explains an unknown timezone and lists corrected records', async () => {
    mocks.employee.mockResolvedValue({
      employeeId: 'employee-1',
      assignments: [
        view({
          asOf: null,
          current: null,
          superseded: [
            record({ id: 'old', rateAmount: '24.0000', supersededAt: '2026-02-01T00:00:00.000Z' }),
          ],
        }),
      ],
    });
    render(<EmployeeCompensationSection employeeId="employee-1" />);
    expect(await screen.findByText(/has no timezone/)).toBeInTheDocument();
    expect(screen.getByText('Corrected records (1)')).toBeInTheDocument();
  });

  it('renders forbidden and error states', async () => {
    mocks.employee.mockRejectedValueOnce(new AuthApiError('forbidden', 403));
    render(<EmployeeCompensationSection employeeId="employee-1" />);
    expect(
      await screen.findByText('You do not have access to this employee’s compensation.'),
    ).toBeInTheDocument();
    cleanup();
    mocks.employee.mockRejectedValueOnce(new AuthApiError('unexpected', 503));
    render(<EmployeeCompensationSection employeeId="employee-1" />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The Compensation service is unavailable',
    );
  });
});

describe('MyCompensationPage', () => {
  it('shows one’s own pay read-only', async () => {
    mocks.me.mockResolvedValue({ employeeId: 'employee-1', assignments: [readOnly(view())] });
    render(<MyCompensationPage />);
    expect(await screen.findByRole('heading', { name: 'Counsellor · Camp' })).toBeInTheDocument();
    expect(screen.getAllByText('CAD 26.00 / hour').length).toBeGreaterThan(0);
    // Read-only: the only control is the date lookup (Batch R3.4), never a change action.
    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual(['Show']);
  });

  it('explains when the account is not an employee', async () => {
    mocks.me.mockRejectedValue(new AuthApiError('forbidden', 403));
    render(<MyCompensationPage />);
    expect(await screen.findByText(/not linked to an employee record/)).toBeInTheDocument();
  });

  it('shows an empty state without assignments', async () => {
    mocks.me.mockResolvedValue({ employeeId: 'employee-1', assignments: [] });
    render(<MyCompensationPage />);
    expect(
      await screen.findByText('You have no assignments with compensation yet.'),
    ).toBeInTheDocument();
  });
});

describe('Compensation on a date (Batch R3.4)', () => {
  async function lookUp(date?: string) {
    const section = await screen.findByRole('region', {
      name: 'Compensation on a date for Counsellor · Camp',
    });
    const input = within(section).getByLabelText('Compensation on date');
    if (date !== undefined) fireEvent.change(input, { target: { value: date } });
    fireEvent.click(within(section).getByRole('button', { name: 'Show' }));
    return section;
  }

  it('starts at the assignment’s today and labels the record in effect as current', async () => {
    mocks.me.mockResolvedValue({ employeeId: 'employee-1', assignments: [readOnly(view())] });
    mocks.asOf.mockResolvedValue({
      employmentAssignmentId: 'assignment-1',
      date: '2026-10-05',
      record: raise,
    });
    render(<MyCompensationPage />);
    const section = await lookUp();
    expect(mocks.asOf).toHaveBeenCalledWith('assignment-1', '2026-10-05');
    expect(await within(section).findByText('Current')).toBeInTheDocument();
    expect(section).toHaveTextContent('On 10/05/2026 (today)');
    expect(within(section).getByText('CAD 26.00 / hour')).toBeInTheDocument();
  });

  // A new view object each time, as a reload returns.
  const freshView = () => view() as unknown as CompensationAssignmentView;

  it('announces each lookup once: no live region inside another (R4-A.7)', async () => {
    let resolve!: (value: unknown) => void;
    mocks.asOf.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    const { container } = render(<CompensationOnDate view={freshView()} />);
    const section = await lookUp();
    const polite = section.querySelector('[aria-live="polite"]')!;
    expect(polite).toHaveTextContent(/Looking up/);
    // Nothing inside the polite region announces on its own.
    expect(polite.querySelectorAll('[role="status"], [role="alert"], [aria-live]')).toHaveLength(0);
    resolve({ employmentAssignmentId: 'assignment-1', date: '2026-10-05', record: raise });
    expect(await within(polite as HTMLElement).findByText('CAD 26.00 / hour')).toBeInTheDocument();

    // A failure is one alert, outside the polite region.
    mocks.asOf.mockRejectedValueOnce(new AuthApiError('forbidden', 403));
    fireEvent.click(within(section).getByRole('button', { name: 'Show' }));
    const alert = await within(section).findByRole('alert');
    expect(polite.contains(alert)).toBe(false);
    expect(within(section).getAllByRole('alert')).toHaveLength(1);
    await expectNoAxeViolations(container);
  });

  it('drops a shown or pending result once the view is reloaded (e.g. after a correction)', async () => {
    mocks.asOf.mockResolvedValueOnce({
      employmentAssignmentId: 'assignment-1',
      date: '2026-10-05',
      record: raise,
    });
    const { rerender } = render(<CompensationOnDate view={freshView()} />);
    let section = await lookUp();
    expect(await within(section).findByText('CAD 26.00 / hour')).toBeInTheDocument();

    // The same assignment, reloaded: the earlier answer may be out of date.
    rerender(<CompensationOnDate view={freshView()} />);
    section = screen.getByRole('region', { name: 'Compensation on a date for Counsellor · Camp' });
    expect(within(section).queryByText('CAD 26.00 / hour')).not.toBeInTheDocument();
    expect(within(section).queryByText('Current')).not.toBeInTheDocument();

    // A response still in flight when the view reloads is not shown either.
    let resolve!: (value: unknown) => void;
    mocks.asOf.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    await lookUp();
    rerender(<CompensationOnDate view={freshView()} />);
    resolve({ employmentAssignmentId: 'assignment-1', date: '2026-10-05', record: raise });
    await waitFor(() => expect(mocks.asOf).toHaveBeenCalledTimes(2));
    await new Promise((r) => setTimeout(r, 0));
    expect(within(section).queryByText('CAD 26.00 / hour')).not.toBeInTheDocument();
    expect(within(section).queryByRole('status')).not.toBeInTheDocument();
  });

  it('distinguishes historical and future-effective records, sending the date unchanged', async () => {
    mocks.me.mockResolvedValue({ employeeId: 'employee-1', assignments: [readOnly(view())] });
    mocks.asOf.mockResolvedValueOnce({
      employmentAssignmentId: 'assignment-1',
      date: '2026-03-15',
      record: record(),
    });
    render(<MyCompensationPage />);
    let section = await lookUp('2026-03-15');
    expect(mocks.asOf).toHaveBeenLastCalledWith('assignment-1', '2026-03-15');
    expect(await within(section).findByText('Historical (ended)')).toBeInTheDocument();
    expect(section).toHaveTextContent('On 03/15/2026 (a past date)');
    expect(within(section).getByText('CAD 24.50 / hour')).toBeInTheDocument();

    mocks.asOf.mockResolvedValueOnce({
      employmentAssignmentId: 'assignment-1',
      date: '2027-01-01',
      record: record({
        id: 'record-3',
        rateAmount: '28.0000',
        effectiveFrom: '2027-01-01',
        effectiveTo: null,
      }),
    });
    section = await lookUp('2027-01-01');
    expect(await within(section).findByText('Future-effective')).toBeInTheDocument();
    expect(section).toHaveTextContent('On 01/01/2027 (a future date)');
  });

  it('says when no record covers the date, and shows errors', async () => {
    mocks.me.mockResolvedValue({ employeeId: 'employee-1', assignments: [readOnly(view())] });
    mocks.asOf.mockResolvedValueOnce({
      employmentAssignmentId: 'assignment-1',
      date: '2025-06-01',
      record: null,
    });
    render(<MyCompensationPage />);
    let section = await lookUp('2025-06-01');
    expect(
      await within(section).findByText('No compensation was in effect on that date.'),
    ).toBeInTheDocument();

    mocks.asOf.mockRejectedValueOnce(new AuthApiError('forbidden', 403));
    section = await lookUp('2026-02-01');
    expect(await within(section).findByRole('alert')).toBeInTheDocument();
    expect(within(section).queryByText('Current')).not.toBeInTheDocument();
  });

  it('asks for a date when none is chosen, without calling the API', async () => {
    mocks.me.mockResolvedValue({
      employeeId: 'employee-1',
      assignments: [readOnly(view({ asOf: null }))],
    });
    render(<MyCompensationPage />);
    const section = await screen.findByRole('region', {
      name: 'Compensation on a date for Counsellor · Camp',
    });
    fireEvent.submit(within(section).getByLabelText('Compensation on date').closest('form')!);
    expect(within(section).getByRole('alert')).toHaveTextContent('Choose a date.');
    expect(mocks.asOf).not.toHaveBeenCalled();
  });

  it('is offered on the employee profile and has no axe violations', async () => {
    mocks.employee.mockResolvedValue({ employeeId: 'employee-1', assignments: [view()] });
    mocks.asOf.mockResolvedValue({
      employmentAssignmentId: 'assignment-1',
      date: '2026-10-05',
      record: raise,
    });
    render(<EmployeeCompensationSection employeeId="employee-1" />);
    const section = await lookUp();
    await within(section).findByText('Current');
    await expectNoAxeViolations(section);
  });
});

describe('PayGroupAdminPage', () => {
  const auth = (keys: string[]) =>
    mocks.useAuth.mockReturnValue({
      authorizationLoading: false,
      authorization: {
        permissions: keys.map((key) => ({ key, scopes: [{ type: 'ORGANIZATION', id: 'org-1' }] })),
      },
      can: vi.fn(() => false),
    });

  it('is forbidden without a compensation permission', () => {
    auth(['employee.read', 'employee.manage']);
    render(<PayGroupAdminPage />);
    expect(screen.getByRole('heading', { name: 'Access denied' })).toBeInTheDocument();
    expect(mocks.payGroupOrganizations).not.toHaveBeenCalled();
  });

  it('lets an organization manager create, edit and archive pay groups', async () => {
    auth(['compensation.manage']);
    mocks.payGroupOrganizations.mockResolvedValue({
      items: [{ id: 'org-1', name: 'Camp', code: 'CAMP', canManagePayGroups: true }],
    });
    mocks.createPayGroup.mockResolvedValue({});
    mocks.updatePayGroup.mockResolvedValue({});
    mocks.archivePayGroup.mockResolvedValue({});
    render(<PayGroupAdminPage />);
    expect(await screen.findByText('HBL Biweekly')).toBeInTheDocument();
    expect(mocks.payGroups).toHaveBeenCalledWith('org-1', false);

    const form = screen.getByRole('form', { name: 'New pay group' });
    fireEvent.change(within(form).getByLabelText('Code'), { target: { value: 'hbl monthly' } });
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'HBL Monthly' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Add pay group' }));
    await waitFor(() =>
      expect(mocks.createPayGroup).toHaveBeenCalledWith({
        organizationId: 'org-1',
        code: 'hbl monthly',
        name: 'HBL Monthly',
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: /^Edit / }));
    const edit = screen.getByRole('form', { name: 'Edit pay group HBL-BIWEEKLY' });
    fireEvent.change(within(edit).getByLabelText('Name'), { target: { value: 'HBL Bi-weekly' } });
    fireEvent.click(within(edit).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(mocks.updatePayGroup).toHaveBeenCalledWith('group-1', {
        name: 'HBL Bi-weekly',
        description: '',
      }),
    );

    // Archiving asks through the shared ConfirmDialog (no window.confirm).
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    const dialog = await screen.findByRole('alertdialog', {
      name: 'Archive pay group HBL Biweekly?',
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(mocks.archivePayGroup).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Archive pay group',
      }),
    );
    await waitFor(() => expect(mocks.archivePayGroup).toHaveBeenCalledWith('group-1'));
  });

  it('is read-only for readers', async () => {
    auth(['compensation.read']);
    mocks.payGroupOrganizations.mockResolvedValue({
      items: [{ id: 'org-1', name: 'Camp', code: 'CAMP', canManagePayGroups: false }],
    });
    mocks.payGroups.mockResolvedValue({
      items: [
        {
          ...payGroup,
          organizationId: 'org-1',
          description: null,
          archivedAt: null,
          actions: { canEdit: false, canArchive: false },
        },
      ],
    });
    render(<PayGroupAdminPage />);
    expect(await screen.findByText('HBL Biweekly')).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'New pay group' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Edit / })).not.toBeInTheDocument();
  });
});
