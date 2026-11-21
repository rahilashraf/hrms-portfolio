import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthApiError } from '../../lib/auth/types';
import { expectNoAxeViolations } from '../../test/axe';
import { MyPayPage } from './my-pay-page';
import { PayrollAdminPage } from './payroll-admin-page';
import { PayrollRunPage } from './payroll-run-page';

const mocks = vi.hoisted(() => ({
  api: {
    myPay: vi.fn(),
    payslip: vi.fn(),
    organizations: vi.fn(),
    payGroups: vi.fn(),
    calendars: vi.fn(),
    createCalendar: vi.fn(),
    setSalaryUnpaidLeaveRule: vi.fn(),
    periods: vi.fn(),
    generatePeriods: vi.fn(),
    materializeTimesheets: vi.fn(),
    runs: vi.fn(),
    createRun: vi.fn(),
    run: vi.fn(),
    issues: vi.fn(),
    employee: vi.fn(),
    freshness: vi.fn(),
    calculate: vi.fn(),
    approve: vi.fn(),
    finalize: vi.fn(),
    void: vi.fn(),
    addManualLine: vi.fn(),
    reverseManualLine: vi.fn(),
    retroPreview: vi.fn(),
    createRetroAdjustments: vi.fn(),
    resolveBenefitDifference: vi.fn(),
    adjustments: vi.fn(),
    cancelAdjustment: vi.fn(),
    createAdjustment: vi.fn(),
    updateCalendar: vi.fn(),
    endCalendar: vi.fn(),
    payGroupMembers: vi.fn(),
  },
  useAuth: vi.fn(),
}));

vi.mock('../../lib/payroll/api', () => ({ payrollApi: mocks.api }));
vi.mock('../../providers/auth-provider', () => ({ useAuth: mocks.useAuth }));

const api = mocks.api;
const auth = (keys: string[]) =>
  mocks.useAuth.mockReturnValue({
    authorizationLoading: false,
    authorization: {
      permissions: keys.map((key) => ({ key, scopes: [{ type: 'ORGANIZATION', id: 'org-1' }] })),
    },
  });

const actions = (overrides: Record<string, boolean> = {}) => ({
  canRead: true,
  canManage: false,
  canCalculate: false,
  canApprove: false,
  canFinalize: false,
  canAdjust: false,
  ...overrides,
});

const runSummary = (overrides: Record<string, unknown> = {}) => ({
  id: 'run-1',
  organizationId: 'org-1',
  status: 'CALCULATED',
  currency: 'CAD',
  payGroup: { id: 'group-1', code: 'BW', name: 'Biweekly' },
  period: {
    id: 'period-1',
    periodStart: '2026-10-04',
    periodEnd: '2026-10-17',
    payDate: '2026-10-22',
    status: 'PROCESSING',
    timezone: 'America/Toronto',
  },
  calculatedAt: '2026-10-18T12:00:00.000Z',
  calculationVersion: 'PAYROLL_GROSS_V1',
  sourceFingerprint: 'abc',
  approvedAt: null,
  finalizedAt: null,
  voidedAt: null,
  voidReason: null,
  statutoryStatus: 'NOT_CALCULATED',
  totals: {
    grossAmount: '2196.00',
    deductionAmount: '0.00',
    employerContributionAmount: '0.00',
    netAmount: null,
    netStatus: 'STATUTORY_NOT_CALCULATED',
  },
  employeeCount: 2,
  ...overrides,
});

const runDetail = (runActions: Record<string, boolean> = {}, overrides = {}) => ({
  ...runSummary(overrides),
  organization: { id: 'org-1', name: 'Camp' },
  issueCounts: { ERROR: 0, WARNING: 1, INFO: 1 },
  employees: [
    {
      id: 're-1',
      employeeId: 'employee-1',
      employeeNumber: 'E-1',
      displayName: 'Ada Lovelace',
      grossAmount: '196.00',
      deductionAmount: '0.00',
      employerContributionAmount: '0.00',
      assignments: [
        {
          id: 'ra-1',
          employmentAssignmentId: 'assignment-1',
          positionName: 'Counsellor',
          employmentType: 'PART_TIME',
          grossAmount: '196.00',
          deductionAmount: '0.00',
          employerContributionAmount: '0.00',
        },
      ],
    },
  ],
  actions: {
    canCalculate: false,
    canApprove: false,
    canFinalize: false,
    canVoid: false,
    canAddManualLines: false,
    canAdjust: false,
    ...runActions,
  },
});

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  api.issues.mockResolvedValue({
    items: [
      {
        id: 'issue-1',
        severity: 'INFO',
        code: 'NET_PAY_NOT_CALCULATED',
        message: 'Statutory deductions are not calculated.',
        metadata: null,
        employee: null,
        assignment: null,
      },
    ],
  });
  api.adjustments.mockResolvedValue({ items: [] });
});
afterEach(cleanup);

describe('MyPayPage', () => {
  it('lists finalized pay and opens a pay statement without any net pay figure', async () => {
    api.myPay.mockResolvedValue({
      netPayExplanation: 'Net pay is not shown.',
      items: [
        {
          id: 're-1',
          payrollRunId: 'run-1',
          employer: 'Camp',
          currency: 'CAD',
          payDate: '2026-10-22',
          periodStart: '2026-10-04',
          periodEnd: '2026-10-17',
          grossAmount: '2000.00',
          deductionAmount: '50.00',
          netAmount: null,
        },
      ],
    });
    api.payslip.mockResolvedValue({
      id: 're-1',
      employer: { name: 'Camp' },
      employee: { displayName: 'Ada Lovelace', employeeNumber: 'E-1' },
      payGroup: 'Biweekly',
      period: { periodStart: '2026-10-04', periodEnd: '2026-10-17', payDate: '2026-10-22' },
      currency: 'CAD',
      finalizedAt: '2026-10-20T00:00:00.000Z',
      earnings: [
        {
          id: 'line-1',
          positionName: 'Counsellor',
          type: 'REGULAR_SALARY',
          description: 'Salary',
          workDate: null,
          periodFrom: '2026-10-04',
          periodTo: '2026-10-17',
          hours: null,
          rateAmount: '52000.0000',
          amount: '2000.00',
        },
      ],
      deductions: [{ id: 'd-1', category: 'MANUAL', description: 'Uniform', amount: '50.00' }],
      employerContributions: [],
      totals: {
        grossAmount: '2000.00',
        deductionAmount: '50.00',
        employerContributionAmount: '0.00',
        paidHours: '0.00',
        netAmount: null,
        netStatus: 'STATUTORY_NOT_CALCULATED',
        netPayExplanation: 'Statutory deductions are not calculated.',
      },
      yearToDate: { currency: 'CAD', grossAmount: '5000.00', deductionAmount: '50.00' },
    });
    render(<MyPayPage />);
    const table = await screen.findByRole('table');
    expect(within(table).getByText('CAD 2,000.00')).toBeInTheDocument();
    fireEvent.click(
      within(table).getByRole('button', { name: 'View pay statement for 10/22/2026' }),
    );
    const slip = await screen.findByRole('article', {
      name: 'Pay statement for Ada Lovelace, pay date 10/22/2026',
    });
    expect(within(slip).getByText('Uniform')).toBeInTheDocument();
    expect(within(slip).getByText('Manual deduction')).toBeInTheDocument();
    expect(within(slip).getByText('CAD 5,000.00')).toBeInTheDocument();
    expect(within(slip).getByText('Net pay').nextElementSibling).toHaveTextContent(
      'Not calculated',
    );
    expect(
      within(slip).getByText(/Statutory deductions .* are not\s+calculated/),
    ).toBeInTheDocument();
    expect(within(slip).queryByText(/Preview/)).toBeNull();
    expect(api.payslip).toHaveBeenCalledWith('re-1');
    // Batch 6A: printable (browser print / Save as PDF).
    const print = vi.spyOn(window, 'print').mockImplementation(() => undefined);
    fireEvent.click(within(slip).getByRole('button', { name: 'Print or save as PDF' }));
    expect(print).toHaveBeenCalledTimes(1);
    print.mockRestore();
  });

  it('explains when the account is not an employee', async () => {
    api.myPay.mockRejectedValue(new AuthApiError('forbidden', 403));
    render(<MyPayPage />);
    expect(await screen.findByText(/not linked to an employee record/)).toBeInTheDocument();
  });
});

describe('PayrollAdminPage', () => {
  it('denies access without a payroll permission (compensation access is not enough)', () => {
    auth(['compensation.manage', 'employee.read']);
    render(<PayrollAdminPage />);
    expect(screen.getByRole('heading', { name: 'Access denied' })).toBeInTheDocument();
    expect(api.organizations).not.toHaveBeenCalled();
  });

  it('shows runs and offers writes only for the actions the API reports', async () => {
    auth(['payroll.read']);
    api.organizations.mockResolvedValue({
      items: [
        {
          id: 'org-1',
          name: 'Camp',
          code: 'CAMP',
          timezone: 'America/Toronto',
          actions: actions(),
        },
      ],
    });
    api.payGroups.mockResolvedValue({
      items: [
        {
          id: 'group-1',
          organizationId: 'org-1',
          code: 'BW',
          name: 'Biweekly',
          archived: false,
          periodCount: 1,
          currentCalendar: null,
        },
      ],
    });
    api.calendars.mockResolvedValue({ items: [] });
    api.periods.mockResolvedValue({ items: [] });
    api.runs.mockResolvedValue({ items: [runSummary()] });
    render(<PayrollAdminPage />);
    expect(await screen.findByRole('note')).toHaveTextContent(/Net pay is not shown/);
    fireEvent.click(await screen.findByRole('tab', { name: 'Runs' }));
    const table = await screen.findByRole('table');
    expect(within(table).getByRole('link', { name: '10/04/2026 – 10/17/2026' })).toHaveAttribute(
      'href',
      '/admin/payroll/runs/run-1',
    );
    expect(within(table).getByText('CAD 2,196.00')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Calendars' }));
    expect(screen.queryByRole('form', { name: 'New pay calendar' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Pay periods' }));
    expect(screen.queryByRole('form', { name: 'Generate pay periods' })).not.toBeInTheDocument();
  });

  it('lets a payroll manager generate periods', async () => {
    auth(['payroll.manage']);
    api.organizations.mockResolvedValue({
      items: [
        {
          id: 'org-1',
          name: 'Camp',
          code: 'CAMP',
          timezone: 'America/Toronto',
          actions: actions({ canManage: true }),
        },
      ],
    });
    api.payGroups.mockResolvedValue({
      items: [
        {
          id: 'group-1',
          organizationId: 'org-1',
          code: 'BW',
          name: 'Biweekly',
          archived: false,
          periodCount: 0,
          currentCalendar: null,
        },
      ],
    });
    api.calendars.mockResolvedValue({ items: [] });
    api.periods.mockResolvedValue({ items: [] });
    api.runs.mockResolvedValue({ items: [] });
    api.generatePeriods.mockResolvedValue({ created: [] });
    render(<PayrollAdminPage />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Pay periods' }));
    const form = screen.getByRole('form', { name: 'Generate pay periods' });
    fireEvent.change(within(form).getByLabelText('Generate through'), {
      target: { value: '2026-12-31' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Generate periods' }));
    await waitFor(() => expect(api.generatePeriods).toHaveBeenCalledWith('group-1', '2026-12-31'));
    expect(await screen.findByText('Pay periods generated.')).toBeInTheDocument();
  });
});

describe('Unpaid leave rule on a pay calendar', () => {
  const calendar = {
    id: 'cal-1',
    organizationId: 'org-1',
    payGroupId: 'group-1',
    cadence: 'BIWEEKLY',
    timezone: 'America/Toronto',
    anchorDate: '2026-10-04',
    payDateOffsetDays: 5,
    processingCutoffOffsetDays: 2,
    effectiveFrom: '2026-10-04',
    effectiveTo: null,
    salaryUnpaidLeaveRule: 'UNCONFIGURED',
    salaryStandardAnnualHours: null,
    periodCount: 1,
    payGroup: { id: 'group-1', code: 'BW', name: 'Biweekly' },
    actions: { canUpdate: true, canEnd: true },
  };

  function setup(keys: string[], canManage: boolean) {
    auth(keys);
    api.organizations.mockResolvedValue({
      items: [
        {
          id: 'org-1',
          name: 'Camp',
          code: 'CAMP',
          timezone: 'America/Toronto',
          actions: actions({ canManage }),
        },
      ],
    });
    api.payGroups.mockResolvedValue({ items: [] });
    api.calendars.mockResolvedValue({ items: [calendar] });
    api.periods.mockResolvedValue({ items: [] });
    api.runs.mockResolvedValue({ items: [] });
  }

  it('lets a payroll manager set the hourly-equivalent rule, validating the hours first', async () => {
    setup(['payroll.manage'], true);
    api.setSalaryUnpaidLeaveRule.mockResolvedValue({
      ...calendar,
      salaryUnpaidLeaveRule: 'HOURLY_EQUIVALENT',
      salaryStandardAnnualHours: '2080.00',
    });
    render(<PayrollAdminPage />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Calendars' }));
    fireEvent.click(
      await screen.findByRole('button', { name: 'Configure unpaid leave rule for Biweekly' }),
    );
    const form = screen.getByRole('form', { name: 'Unpaid leave rule for Biweekly' });
    fireEvent.click(within(form).getByLabelText(/Hourly equivalent/));
    const hours = within(form).getByLabelText('Standard paid hours per year');
    fireEvent.change(hours, { target: { value: '9000' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save rule' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent('from 1 to 8784');
    expect(hours).toHaveAttribute('aria-invalid', 'true');
    expect(api.setSalaryUnpaidLeaveRule).not.toHaveBeenCalled();

    fireEvent.change(hours, { target: { value: '2080' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save rule' }));
    await waitFor(() =>
      expect(api.setSalaryUnpaidLeaveRule).toHaveBeenCalledWith('cal-1', {
        rule: 'HOURLY_EQUIVALENT',
        standardAnnualHours: '2080',
      }),
    );
    expect(
      await screen.findByText('Unpaid leave rule saved. Recalculate the affected payroll runs.'),
    ).toBeInTheDocument();
  });

  it('sends no hours when the rule is cleared', async () => {
    setup(['payroll.manage'], true);
    api.calendars.mockResolvedValue({
      items: [
        {
          ...calendar,
          salaryUnpaidLeaveRule: 'HOURLY_EQUIVALENT',
          salaryStandardAnnualHours: '2080.00',
        },
      ],
    });
    api.setSalaryUnpaidLeaveRule.mockResolvedValue(calendar);
    render(<PayrollAdminPage />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Calendars' }));
    fireEvent.click(
      await screen.findByRole('button', { name: 'Configure unpaid leave rule for Biweekly' }),
    );
    const form = screen.getByRole('form', { name: 'Unpaid leave rule for Biweekly' });
    fireEvent.click(within(form).getByLabelText(/Not configured/));
    fireEvent.click(within(form).getByRole('button', { name: 'Save rule' }));
    await waitFor(() =>
      expect(api.setSalaryUnpaidLeaveRule).toHaveBeenCalledWith('cal-1', {
        rule: 'UNCONFIGURED',
        standardAnnualHours: null,
      }),
    );
  });

  it('offers no rule change to a payroll reader', async () => {
    setup(['payroll.read'], false);
    render(<PayrollAdminPage />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Calendars' }));
    expect(await screen.findByText('Not configured')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Configure unpaid leave rule/ })).toBeNull();
  });

  it('points a blocked run to the pay calendar rule', async () => {
    auth(['payroll.read']);
    api.run.mockResolvedValue(runDetail());
    api.issues.mockResolvedValue({
      items: [
        {
          id: 'issue-2',
          severity: 'ERROR',
          code: 'SALARY_UNPAID_LEAVE_REQUIRES_RULE',
          message:
            'Unpaid leave was taken on salaried days, but the payroll calendar has no rule for reducing a salary.',
          metadata: null,
          employee: null,
          assignment: null,
        },
      ],
    });
    render(<PayrollRunPage runId="run-1" />);
    expect(
      await screen.findByText('This run needs an unpaid leave rule before it can be approved.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Configure the pay calendar' })).toHaveAttribute(
      'href',
      '/admin/payroll?tab=calendars',
    );
  });
});

describe('PayrollRunPage', () => {
  it('shows only the lifecycle actions the backend allows', async () => {
    auth(['payroll.read', 'payroll.approve']);
    api.run.mockResolvedValue(runDetail({ canApprove: true }));
    api.approve.mockResolvedValue(runDetail());
    render(<PayrollRunPage runId="run-1" />);
    const approve = await screen.findByRole('button', { name: 'Approve' });
    expect(screen.queryByRole('button', { name: 'Finalize' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Recalculate' })).not.toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Void run' })).not.toBeInTheDocument();
    // Batch 6A: approval is confirmed first, like finalization.
    fireEvent.click(approve);
    let dialog = await screen.findByRole('alertdialog', { name: 'Approve this payroll run?' });
    expect(dialog).toHaveTextContent(/Biweekly CAD run for 10\/04\/2026 – 10\/17\/2026/);
    expect(dialog).toHaveTextContent(/gross CAD 2,196.00, 1 employee\(s\), 1 warning\(s\)/);
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(api.approve).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve run' }));
    await waitFor(() => expect(api.approve).toHaveBeenCalledWith('run-1'));
    expect(await screen.findByText('Run approved.')).toBeInTheDocument();
  });

  it('finalizes a run only after confirmation that names the pay group and period', async () => {
    auth(['payroll.read', 'payroll.approve']);
    api.run.mockResolvedValue(runDetail({ canFinalize: true }));
    api.finalize.mockResolvedValue(runDetail());
    render(<PayrollRunPage runId="run-1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Finalize' }));
    let dialog = await screen.findByRole('alertdialog', { name: 'Finalize this payroll run?' });
    expect(dialog).toHaveTextContent(/can no longer be recalculated or edited/);
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(api.finalize).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Finalize' }));
    dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Finalize run' }));
    await waitFor(() => expect(api.finalize).toHaveBeenCalledWith('run-1'));
    expect(await screen.findByText('Run finalized.')).toBeInTheDocument();
  });

  it('reports a stale run instead of approving it', async () => {
    auth(['payroll.read', 'payroll.approve']);
    api.run.mockResolvedValue(runDetail({ canApprove: true }));
    api.approve.mockRejectedValue(
      new AuthApiError(
        'conflict',
        409,
        'Source data changed after the run was calculated; it must be recalculated (and approved again).',
      ),
    );
    render(<PayrollRunPage runId="run-1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Approve run' }),
    );
    expect(await screen.findByText(/must be recalculated/)).toBeInTheDocument();
  });

  it('shows validation results and summary without a net pay figure', async () => {
    auth(['payroll.read']);
    api.run.mockResolvedValue(runDetail());
    render(<PayrollRunPage runId="run-1" />);
    expect(
      await screen.findByText('Not calculated (statutory deductions are not calculated)'),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Validation' }));
    expect(await screen.findByText('NET_PAY_NOT_CALCULATED')).toBeInTheDocument();
  });

  it('adds a manual line for a payroll adjuster', async () => {
    auth(['payroll.read', 'payroll.adjust']);
    api.run.mockResolvedValue(runDetail({ canAddManualLines: true, canAdjust: true }));
    api.employee.mockResolvedValue({
      id: 're-1',
      employeeId: 'employee-1',
      employeeNumber: 'E-1',
      displayName: 'Ada Lovelace',
      grossAmount: '196.00',
      deductionAmount: '0.00',
      employerContributionAmount: '0.00',
      assignments: [
        {
          id: 'ra-1',
          employmentAssignmentId: 'assignment-1',
          positionName: 'Counsellor',
          employmentType: 'PART_TIME',
          grossAmount: '196.00',
          deductionAmount: '0.00',
          employerContributionAmount: '0.00',
          timezone: 'America/Toronto',
          sourceFingerprint: 'x',
          earnings: [],
          deductions: [],
          employerContributions: [],
          issues: [],
        },
      ],
    });
    api.addManualLine.mockResolvedValue(runDetail());
    render(<PayrollRunPage runId="run-1" />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Earnings' }));
    const form = await screen.findByRole('form', { name: 'Add manual line' });
    fireEvent.change(within(form).getByLabelText('Amount'), { target: { value: '0' } });
    fireEvent.change(within(form).getByLabelText('Description'), { target: { value: 'Bonus' } });
    fireEvent.change(within(form).getByLabelText('Reason'), { target: { value: 'Great summer' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Add line' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent(/positive amount/);
    expect(api.addManualLine).not.toHaveBeenCalled();
    fireEvent.change(within(form).getByLabelText('Amount'), { target: { value: '150' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Add line' }));
    await waitFor(() =>
      expect(api.addManualLine).toHaveBeenCalledWith('run-1', {
        payrollRunAssignmentId: 'ra-1',
        kind: 'EARNING',
        amount: '150',
        description: 'Bonus',
        reason: 'Great summer',
      }),
    );
  });
});

describe('Batch 6A payroll completion', () => {
  const organization = (overrides: Record<string, boolean> = {}) => ({
    items: [
      {
        id: 'org-1',
        name: 'Camp',
        code: 'CAMP',
        timezone: 'America/Toronto',
        actions: actions(overrides),
      },
    ],
  });
  const group = {
    id: 'group-1',
    organizationId: 'org-1',
    code: 'BW',
    name: 'Biweekly',
    archived: false,
    periodCount: 1,
    currentCalendar: null,
  };
  const calendar = (overrides: Record<string, unknown> = {}) => ({
    id: 'cal-1',
    organizationId: 'org-1',
    payGroupId: 'group-1',
    cadence: 'BIWEEKLY',
    timezone: 'America/Toronto',
    anchorDate: '2026-10-04',
    payDateOffsetDays: 5,
    processingCutoffOffsetDays: 2,
    effectiveFrom: '2026-10-04',
    effectiveTo: null,
    salaryUnpaidLeaveRule: 'UNCONFIGURED',
    salaryStandardAnnualHours: null,
    periodCount: 0,
    payGroup: { id: 'group-1', code: 'BW', name: 'Biweekly' },
    actions: { canUpdate: true, canEnd: true },
    ...overrides,
  });
  const period = {
    id: 'period-1',
    organizationId: 'org-1',
    payGroupId: 'group-1',
    payrollCalendarId: 'cal-1',
    periodStart: '2026-10-04',
    periodEnd: '2026-10-17',
    payDate: '2026-10-22',
    processingCutoffAt: '2026-10-20T04:00:00.000Z',
    timezone: 'America/Toronto',
    status: 'OPEN',
    timePeriodId: 'tp-1',
    timesheetsMaterializedAt: null,
    payGroup: { code: 'BW', name: 'Biweekly' },
  };

  function admin(keys: string[], overrides: Record<string, boolean>) {
    auth(keys);
    api.organizations.mockResolvedValue(organization(overrides));
    api.payGroups.mockResolvedValue({ items: [group] });
    api.calendars.mockResolvedValue({ items: [] });
    api.periods.mockResolvedValue({ items: [] });
    api.runs.mockResolvedValue({ items: [] });
    api.adjustments.mockResolvedValue({ items: [] });
  }

  it('edits a calendar without periods and ends one with periods no earlier than its last period', async () => {
    admin(['payroll.manage'], { canManage: true });
    api.calendars.mockResolvedValue({
      items: [
        calendar(),
        calendar({
          id: 'cal-2',
          periodCount: 1,
          actions: { canUpdate: false, canEnd: true },
          payGroup: { id: 'group-2', code: 'MO', name: 'Monthly' },
        }),
      ],
    });
    api.periods.mockResolvedValue({ items: [{ ...period, payrollCalendarId: 'cal-2' }] });
    api.updateCalendar.mockResolvedValue(calendar());
    api.endCalendar.mockResolvedValue(calendar());
    render(<PayrollAdminPage />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Calendars' }));

    // Rules are editable only without periods.
    expect(screen.queryByRole('button', { name: 'Edit calendar for Monthly' })).toBeNull();
    expect(screen.getByText('Rules fixed: periods generated')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Edit calendar for Biweekly' }));
    let dialog = await screen.findByRole('dialog', { name: 'Edit Biweekly calendar' });
    fireEvent.change(within(dialog).getByLabelText('Pay date offset (days)'), {
      target: { value: '6' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save calendar' }));
    await waitFor(() =>
      expect(api.updateCalendar).toHaveBeenCalledWith('cal-1', {
        cadence: 'BIWEEKLY',
        timezone: 'America/Toronto',
        anchorDate: '2026-10-04',
        payDateOffsetDays: 6,
        processingCutoffOffsetDays: 2,
        effectiveFrom: '2026-10-04',
        effectiveTo: null,
      }),
    );
    expect(await screen.findByText('Pay calendar updated.')).toBeInTheDocument();

    // Ending a calendar with periods: confirmation names them and the earliest end date.
    fireEvent.click(screen.getByRole('button', { name: 'End calendar for Monthly' }));
    dialog = await screen.findByRole('dialog', { name: 'End the Monthly calendar?' });
    expect(dialog).toHaveTextContent(
      /1 pay period has been generated, the last ending 10\/17\/2026/,
    );
    const date = within(dialog).getByLabelText('Last day of the calendar');
    expect(date).toHaveAttribute('min', '2026-10-17');
    fireEvent.change(date, { target: { value: '2026-10-10' } });
    expect(within(dialog).getByRole('button', { name: 'End calendar' })).toBeDisabled();
    expect(date).toHaveAttribute('aria-invalid', 'true');
    fireEvent.change(date, { target: { value: '2026-12-31' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'End calendar' }));
    await waitFor(() => expect(api.endCalendar).toHaveBeenCalledWith('cal-2', '2026-12-31'));
    expect(await screen.findByText('Pay calendar ends 12/31/2026.')).toBeInTheDocument();
  });

  it('keeps a rejected calendar end in the dialog with the API message', async () => {
    admin(['payroll.manage'], { canManage: true });
    api.calendars.mockResolvedValue({ items: [calendar()] });
    api.endCalendar.mockRejectedValue(
      new AuthApiError('conflict', 409, 'The calendar cannot end before its last pay period.'),
    );
    render(<PayrollAdminPage />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Calendars' }));
    fireEvent.click(screen.getByRole('button', { name: 'End calendar for Biweekly' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent(/No pay periods have been generated/);
    fireEvent.change(within(dialog).getByLabelText('Last day of the calendar'), {
      target: { value: '2026-12-31' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'End calendar' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'The calendar cannot end before its last pay period.',
    );
  });

  it('lists every currency run of a period whatever currency new runs use', async () => {
    admin(['payroll.manage'], { canManage: true });
    api.periods.mockResolvedValue({ items: [period] });
    api.runs.mockResolvedValue({
      items: [
        runSummary(),
        runSummary({ id: 'run-usd', currency: 'USD', status: 'DRAFT' }),
        runSummary({ id: 'run-void', currency: 'EUR', status: 'VOIDED' }),
      ],
    });
    api.createRun.mockResolvedValue(runDetail());
    render(<PayrollAdminPage />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Pay periods' }));
    const table = await screen.findByRole('table');
    const runLinks = () =>
      within(table)
        .getAllByRole('link')
        .map((link) => link.textContent);
    expect(runLinks()).toEqual(['Open CAD run', 'Open USD run']);
    // Both currencies have a run: none offered; changing the currency hides no run.
    expect(within(table).queryByRole('button', { name: /Create/ })).toBeNull();
    const currency = screen.getByLabelText('Currency for new runs');
    fireEvent.change(currency, { target: { value: 'eur' } });
    expect(runLinks()).toEqual(['Open CAD run', 'Open USD run']);
    fireEvent.click(within(table).getByRole('button', { name: 'Create EUR run' }));
    await waitFor(() => expect(api.createRun).toHaveBeenCalledWith('period-1', 'EUR'));
    fireEvent.change(currency, { target: { value: 'E' } });
    expect(currency).toHaveAttribute('aria-invalid', 'true');
    expect(within(table).getByRole('button', { name: /Create/ })).toBeDisabled();
  });

  it('creates an off-cycle adjustment with pickers and cancels a pending one with a reason', async () => {
    admin(['payroll.read', 'payroll.adjust'], { canAdjust: true });
    const pending = {
      id: 'adj-1',
      payGroupId: 'group-1',
      employeeId: 'employee-1',
      employmentAssignmentId: 'assignment-1',
      currency: 'CAD',
      kind: 'EARNING',
      amount: '150.00',
      description: 'Referral bonus',
      reason: 'Policy',
      status: 'PENDING',
      sourceRunId: null,
      payrollRunId: null,
      retroactive: false,
      createdAt: '2026-10-18T12:00:00.000Z',
      displayName: 'Ada Lovelace',
      employeeNumber: 'E-1',
      positionName: 'Counsellor',
    };
    api.adjustments.mockResolvedValue({ items: [pending] });
    api.payGroupMembers.mockResolvedValue({
      items: [
        {
          employmentAssignmentId: 'assignment-1',
          employeeId: 'employee-1',
          employeeNumber: 'E-1',
          displayName: 'Ada Lovelace',
          positionName: 'Counsellor',
          assignmentStatus: 'ACTIVE',
          currencies: ['CAD'],
        },
        {
          employmentAssignmentId: 'assignment-2',
          employeeId: 'employee-2',
          employeeNumber: 'E-2',
          displayName: 'Grace Hopper',
          positionName: 'Director',
          assignmentStatus: 'ACTIVE',
          currencies: ['CAD', 'USD'],
        },
      ],
    });
    api.createAdjustment.mockResolvedValue(pending);
    api.cancelAdjustment.mockResolvedValue({ ...pending, status: 'CANCELLED' });
    render(<PayrollAdminPage />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Adjustments' }));
    await waitFor(() =>
      expect(api.adjustments).toHaveBeenCalledWith('org-1', { status: 'PENDING' }),
    );
    expect(await screen.findByText('Referral bonus')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'New adjustment' }));
    const dialog = await screen.findByRole('dialog', { name: 'New off-cycle adjustment' });
    await waitFor(() => expect(api.payGroupMembers).toHaveBeenCalledWith('group-1'));
    const picker = await within(dialog).findByLabelText('Employee and assignment');
    expect(
      within(picker as HTMLElement)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Ada Lovelace · E-1 · Counsellor', 'Grace Hopper · E-2 · Director']);
    fireEvent.change(picker, { target: { value: 'assignment-2' } });
    fireEvent.change(within(dialog).getByLabelText('Currency'), { target: { value: 'USD' } });
    fireEvent.click(within(dialog).getByLabelText('Deduction'));
    const amount = within(dialog).getByLabelText(/^Amount/);
    fireEvent.change(amount, { target: { value: '-5' } });
    expect(amount).toHaveAttribute('aria-invalid', 'true');
    expect(within(dialog).getByRole('button', { name: 'Create adjustment' })).toBeDisabled();
    fireEvent.change(amount, { target: { value: '40.50' } });
    fireEvent.change(within(dialog).getByLabelText(/^Description/), {
      target: { value: 'Equipment' },
    });
    fireEvent.change(within(dialog).getByLabelText(/^Reason/), {
      target: { value: 'Laptop not returned' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create adjustment' }));
    await waitFor(() =>
      expect(api.createAdjustment).toHaveBeenCalledWith({
        payGroupId: 'group-1',
        employmentAssignmentId: 'assignment-2',
        currency: 'USD',
        kind: 'DEDUCTION',
        amount: '40.50',
        description: 'Equipment',
        reason: 'Laptop not returned',
      }),
    );
    expect(await screen.findByText(/Adjustment created/)).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole('button', { name: 'Cancel adjustment Referral bonus for Ada Lovelace' }),
    );
    const confirm = await screen.findByRole('alertdialog', { name: 'Cancel this adjustment?' });
    const button = within(confirm).getByRole('button', { name: 'Cancel adjustment' });
    expect(button).toBeDisabled();
    fireEvent.change(within(confirm).getByLabelText(/Reason/), {
      target: { value: 'Paid outside payroll' },
    });
    fireEvent.click(button);
    await waitFor(() =>
      expect(api.cancelAdjustment).toHaveBeenCalledWith('adj-1', 'Paid outside payroll'),
    );
    expect(await screen.findByText('Adjustment cancelled.')).toBeInTheDocument();
  });

  it('offers no adjustment writes to a payroll reader, and links the register only with reporting access', async () => {
    admin(['payroll.read'], {});
    api.adjustments.mockResolvedValue({ items: [] });
    render(<PayrollAdminPage />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Adjustments' }));
    expect(await screen.findByText('No adjustments.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New adjustment' })).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Runs' }));
    expect(screen.queryByRole('link', { name: /Payroll register/ })).toBeNull();
    cleanup();

    admin(['payroll.read', 'report.read'], {});
    render(<PayrollAdminPage />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Runs' }));
    expect(await screen.findByRole('link', { name: /Payroll register/ })).toHaveAttribute(
      'href',
      '/reports/payroll.register?organizationId=org-1',
    );
  });

  it('shows a permission error from the adjustment list instead of an empty list', async () => {
    admin(['payroll.read'], {});
    api.adjustments.mockRejectedValue(new AuthApiError('forbidden', 403));
    render(<PayrollAdminPage />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Adjustments' }));
    expect(
      await screen.findByText('You do not have permission for this payroll action.'),
    ).toBeInTheDocument();
  });

  it('prints an administrator payslip with adjustment lines and benefit deductions', async () => {
    auth(['payroll.read']);
    api.run.mockResolvedValue(runDetail({}, { status: 'FINALIZED' }));
    api.employee.mockResolvedValue({
      id: 're-1',
      employeeId: 'employee-1',
      employeeNumber: 'E-1',
      displayName: 'Ada Lovelace',
      grossAmount: '346.00',
      deductionAmount: '60.00',
      employerContributionAmount: '20.00',
      assignments: [
        {
          id: 'ra-1',
          employmentAssignmentId: 'assignment-1',
          positionName: 'Counsellor',
          employmentType: 'PART_TIME',
          grossAmount: '346.00',
          deductionAmount: '60.00',
          employerContributionAmount: '20.00',
          timezone: 'America/Toronto',
          sourceFingerprint: 'x',
          earnings: [
            {
              id: 'e-1',
              origin: 'CALCULATED',
              type: 'REGULAR_HOURLY',
              description: 'Regular hours',
              workDate: '2026-10-05',
              periodFrom: null,
              periodTo: null,
              quantity: '480',
              quantityUnit: 'MINUTES',
              rateAmount: '24.5000',
              amount: '196.00',
              currency: 'CAD',
              calculationRule: 'R',
              reason: null,
              reversesLineId: null,
            },
            {
              id: 'e-2',
              origin: 'ADJUSTMENT',
              type: 'RETRO_ADJUSTMENT',
              description: 'Referral bonus',
              workDate: null,
              periodFrom: null,
              periodTo: null,
              quantity: null,
              quantityUnit: null,
              rateAmount: null,
              amount: '150.00',
              currency: 'CAD',
              calculationRule: 'PAYROLL_ADJUSTMENT',
              reason: null,
              reversesLineId: null,
            },
          ],
          deductions: [
            {
              id: 'd-1',
              category: 'BENEFIT',
              code: null,
              description: 'Dental plan',
              amount: '20.00',
              currency: 'CAD',
              reason: null,
              reversesLineId: null,
            },
            {
              id: 'd-2',
              category: 'ADJUSTMENT',
              code: null,
              description: 'Equipment',
              amount: '40.00',
              currency: 'CAD',
              reason: null,
              reversesLineId: null,
            },
          ],
          employerContributions: [
            {
              id: 'c-1',
              category: 'BENEFIT',
              code: null,
              description: 'Dental plan (employer)',
              amount: '20.00',
              currency: 'CAD',
              reason: null,
              reversesLineId: null,
            },
          ],
          issues: [],
        },
      ],
    });
    render(<PayrollRunPage runId="run-1" />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Employees' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Payslip for Ada Lovelace' }));
    const slip = await screen.findByRole('article', {
      name: 'Pay statement for Ada Lovelace, pay date 10/22/2026',
    });
    expect(api.employee).toHaveBeenCalledWith('run-1', 're-1');
    expect(within(slip).getByText('Adjustment · Counsellor')).toBeInTheDocument();
    expect(within(slip).getByText('8.00')).toBeInTheDocument();
    expect(within(slip).getByText('Benefit deduction')).toBeInTheDocument();
    expect(within(slip).getByText('Adjustment')).toBeInTheDocument();
    expect(within(slip).getByText('CAD 346.00')).toBeInTheDocument();
    expect(
      within(slip).getByText(/Employer contributions \(not deducted from pay\)/),
    ).toBeInTheDocument();
    expect(within(slip).queryByText(/Preview/)).toBeNull();
    expect(
      within(slip).getByText(/gross\s+less recorded deductions is not net pay/),
    ).toBeInTheDocument();
  });

  it('marks an unfinalized run payslip as a preview', async () => {
    auth(['payroll.read']);
    api.run.mockResolvedValue(runDetail());
    api.employee.mockResolvedValue({
      id: 're-1',
      employeeId: 'employee-1',
      employeeNumber: 'E-1',
      displayName: 'Ada Lovelace',
      grossAmount: '196.00',
      deductionAmount: '0.00',
      employerContributionAmount: '0.00',
      assignments: [],
    });
    render(<PayrollRunPage runId="run-1" />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Payslip' }));
    const slip = await screen.findByRole('article');
    expect(
      within(slip).getByText(/Preview — this run is calculated, not finalized/),
    ).toBeInTheDocument();
  });
});

describe('Batch 7C benefit retro differences', () => {
  it('shows an unresolved benefit difference and resolves it with a deduction adjustment', async () => {
    auth(['payroll.read', 'payroll.adjust']);
    api.run.mockResolvedValue(runDetail({ canAdjust: true }, { status: 'FINALIZED' }));
    api.adjustments.mockResolvedValue({ items: [] });
    const item = {
      employmentAssignmentId: 'assignment-1',
      displayName: 'Ada Lovelace',
      blocked: false,
      blockingCodes: [],
      finalizedGross: '2000.00',
      currentGross: '2000.00',
      alreadyAdjusted: '0.00',
      difference: '0.00',
      benefitDifference: {
        employeeDeductions: '11.54',
        employerContributions: '0.00',
        resolved: false,
      },
      warnings: ['BENEFIT_DIFFERENCE_UNRESOLVED'],
      lines: [],
    };
    api.retroPreview.mockResolvedValueOnce({ payrollRunId: 'run-1', items: [item] });
    api.retroPreview.mockResolvedValue({
      payrollRunId: 'run-1',
      items: [
        {
          ...item,
          benefitDifference: { ...item.benefitDifference, resolved: true },
          warnings: [],
        },
      ],
    });
    api.createAdjustment.mockResolvedValue({ id: 'adj-1' });
    api.resolveBenefitDifference.mockResolvedValue({ resolved: true, alreadyResolved: false });
    render(<PayrollRunPage runId="run-1" />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Adjustments' }));
    const table = await screen.findByRole('region', { name: 'Retroactive differences' });
    expect(table).toHaveTextContent('Needs a decision');
    // Not "still matches": a benefit-only difference is never treated as nothing to do.
    expect(screen.queryByText('The finalized run still matches its sources.')).toBeNull();
    fireEvent.click(
      screen.getByRole('button', { name: 'Resolve benefit difference for Ada Lovelace' }),
    );
    const dialog = await screen.findByRole('dialog', {
      name: 'Resolve benefit difference for Ada Lovelace',
    });
    const submit = within(dialog).getByRole('button', { name: 'Create adjustment and resolve' });
    expect(submit).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Reason'), {
      target: { value: 'Carrier rate corrected' },
    });
    fireEvent.click(submit);
    await waitFor(() =>
      expect(api.resolveBenefitDifference).toHaveBeenCalledWith('run-1', {
        employmentAssignmentId: 'assignment-1',
        outcome: 'ADJUSTED',
        reason: 'Carrier rate corrected',
        adjustment: { amount: '11.54', description: 'Benefit deduction correction' },
      }),
    );
    // One atomic request: no separate adjustment is created by the page.
    expect(api.createAdjustment).not.toHaveBeenCalled();
    expect(await screen.findByText('Resolved')).toBeInTheDocument();
  });

  it('asks for the pay adjustments first when the gross pay also changed', async () => {
    auth(['payroll.read', 'payroll.adjust']);
    api.run.mockResolvedValue(runDetail({ canAdjust: true }, { status: 'FINALIZED' }));
    api.adjustments.mockResolvedValue({ items: [] });
    api.retroPreview.mockResolvedValue({
      payrollRunId: 'run-1',
      items: [
        {
          employmentAssignmentId: 'assignment-1',
          displayName: 'Ada Lovelace',
          blocked: false,
          blockingCodes: [],
          finalizedGross: '2000.00',
          currentGross: '2100.00',
          alreadyAdjusted: '0.00',
          difference: '100.00',
          benefitDifference: {
            employeeDeductions: '11.54',
            employerContributions: '0.00',
            resolved: false,
          },
          warnings: ['BENEFIT_DIFFERENCE_UNRESOLVED'],
          lines: [],
        },
      ],
    });
    render(<PayrollRunPage runId="run-1" />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Adjustments' }));
    expect(
      await screen.findByText(/create the retroactive pay adjustments first/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Resolve benefit difference/ })).toBeNull();
  });

  it('offers no resolution to a payroll reader', async () => {
    auth(['payroll.read']);
    api.run.mockResolvedValue(runDetail({}, { status: 'FINALIZED' }));
    api.adjustments.mockResolvedValue({ items: [] });
    api.retroPreview.mockResolvedValue({
      payrollRunId: 'run-1',
      items: [
        {
          employmentAssignmentId: 'assignment-1',
          displayName: 'Ada Lovelace',
          blocked: false,
          blockingCodes: [],
          finalizedGross: '2000.00',
          currentGross: '2000.00',
          alreadyAdjusted: '0.00',
          difference: '0.00',
          benefitDifference: {
            employeeDeductions: '0.00',
            employerContributions: '5.00',
            resolved: false,
          },
          warnings: ['BENEFIT_DIFFERENCE_UNRESOLVED'],
          lines: [],
        },
      ],
    });
    render(<PayrollRunPage runId="run-1" />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Adjustments' }));
    expect(
      await screen.findByText('Someone with payroll adjustment access resolves these.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Resolve benefit difference/ })).toBeNull();
  });
});

describe('Security remediation M2: payroll dual control', () => {
  const blocked = (
    reasons: { approveBlockedReason?: string | null; finalizeBlockedReason?: string | null },
    overrides: Record<string, unknown> = {},
  ) => {
    const base = runDetail({}, overrides);
    return { ...base, ...overrides, actions: { ...base.actions, ...reasons } };
  };

  it('shows who prepared the run and explains why the calculator cannot approve it', async () => {
    auth(['payroll.read', 'payroll.calculate', 'payroll.approve']);
    api.run.mockResolvedValue(
      blocked(
        { approveBlockedReason: 'CALCULATED_BY_YOU' },
        {
          dualControl: true,
          calculatedBy: { userId: 'user-1', name: 'Pat Preparer' },
          approvedBy: null,
          finalizedBy: null,
        },
      ),
    );
    const { container } = render(<PayrollRunPage runId="run-1" />);
    expect(
      await screen.findByText(
        'You calculated this run: another administrator must approve and finalize it.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Summary' }));
    expect(screen.getByText('Calculated by')).toBeInTheDocument();
    expect(screen.getByText('Pat Preparer')).toBeInTheDocument();
    expect(screen.getByText('Dual control')).toBeInTheDocument();
    expect(screen.queryByText('Dual control is disabled for this organization.')).toBeNull();
    await expectNoAxeViolations(container);
  });

  it('says plainly when dual control is disabled for the organization', async () => {
    auth(['payroll.read', 'payroll.approve']);
    api.run.mockResolvedValue(
      blocked({}, { dualControl: false, calculatedBy: { userId: 'user-1', name: null } }),
    );
    render(<PayrollRunPage runId="run-1" />);
    expect(
      await screen.findByText('Dual control is disabled for this organization.'),
    ).toBeInTheDocument();
  });

  it('explains a finalization blocked for want of an independent approval', async () => {
    auth(['payroll.read', 'payroll.finalize']);
    api.run.mockResolvedValue(
      blocked(
        { finalizeBlockedReason: 'INDEPENDENT_APPROVAL_REQUIRED' },
        { status: 'APPROVED', dualControl: true },
      ),
    );
    render(<PayrollRunPage runId="run-1" />);
    expect(
      await screen.findByText(/approval was not independent of its preparation/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Finalize' })).not.toBeInTheDocument();
  });

  it('shows the server refusal when a stale page lets the calculator try to approve', async () => {
    auth(['payroll.read', 'payroll.approve']);
    api.run.mockResolvedValue(runDetail({ canApprove: true }, { dualControl: true }));
    api.approve.mockRejectedValue(
      new AuthApiError('forbidden', 403, undefined, {
        code: 'PAYROLL_SEPARATION_OF_DUTIES',
        reason: 'CALCULATED_BY_YOU',
        message: 'Refused.',
      }),
    );
    render(<PayrollRunPage runId="run-1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve run' }));
    expect(
      await screen.findByText(
        'You calculated this run: another administrator must approve and finalize it.',
      ),
    ).toBeInTheDocument();
  });

  it('shows the dual-control state on the payroll administration page', async () => {
    auth(['payroll.read']);
    api.organizations.mockResolvedValue({
      items: [
        {
          id: 'org-1',
          name: 'Camp',
          code: 'CAMP',
          timezone: 'America/Toronto',
          actions: actions(),
        },
      ],
    });
    api.payGroups.mockResolvedValue({ items: [] });
    api.calendars.mockResolvedValue({ items: [] });
    api.periods.mockResolvedValue({ items: [] });
    api.runs.mockResolvedValue({ items: [], dualControl: false });
    render(<PayrollAdminPage />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Runs' }));
    expect(
      await screen.findByText('Dual control is disabled for this organization.'),
    ).toBeInTheDocument();
  });
});
