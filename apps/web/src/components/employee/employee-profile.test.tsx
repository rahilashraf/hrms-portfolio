import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthApiError } from '../../lib/auth/types';
import { EmployeeProfilePage } from './employee-profile';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  update: vi.fn(),
  listPositionOptions: vi.fn(),
  listManagerAssignmentOptions: vi.fn(),
  createAssignment: vi.fn(),
  updateAssignment: vi.fn(),
  endAssignment: vi.fn(),
  cancelAssignment: vi.fn(),
  activateAssignment: vi.fn(),
  setAssignmentPrimary: vi.fn(),
  setAssignmentManager: vi.fn(),
  terminate: vi.fn(),
  rehire: vi.fn(),
  capabilities: vi.fn(),
  terminations: vi.fn(),
  terminationPreview: vi.fn(),
  terminationGrants: vi.fn(),
  cancelTermination: vi.fn(),
  rescheduleTermination: vi.fn(),
  applyTermination: vi.fn(),
  inactivate: vi.fn(),
  reactivate: vi.fn(),
  accessReview: vi.fn(),
  revokeGrants: vi.fn(),
  transferAssignment: vi.fn(),
  assignmentImpact: vi.fn(),
  useAuth: vi.fn(),
}));
vi.mock('../../lib/employee/api', () => ({
  employeeApi: {
    get: mocks.get,
    update: mocks.update,
    listPositionOptions: mocks.listPositionOptions,
    listManagerAssignmentOptions: mocks.listManagerAssignmentOptions,
    createAssignment: mocks.createAssignment,
    updateAssignment: mocks.updateAssignment,
    endAssignment: mocks.endAssignment,
    cancelAssignment: mocks.cancelAssignment,
    activateAssignment: mocks.activateAssignment,
    setAssignmentPrimary: mocks.setAssignmentPrimary,
    setAssignmentManager: mocks.setAssignmentManager,
    terminate: mocks.terminate,
    rehire: mocks.rehire,
    capabilities: mocks.capabilities,
    terminations: mocks.terminations,
    terminationPreview: mocks.terminationPreview,
    terminationGrants: mocks.terminationGrants,
    cancelTermination: mocks.cancelTermination,
    rescheduleTermination: mocks.rescheduleTermination,
    applyTermination: mocks.applyTermination,
    inactivate: mocks.inactivate,
    reactivate: mocks.reactivate,
    accessReview: mocks.accessReview,
    revokeGrants: mocks.revokeGrants,
    transferAssignment: mocks.transferAssignment,
    assignmentImpact: mocks.assignmentImpact,
  },
}));
vi.mock('../../providers/auth-provider', () => ({ useAuth: mocks.useAuth }));
vi.mock('../benefits/employee-benefits-section', () => ({
  EmployeeBenefitsSection: () => <section aria-label="Benefits section">benefits</section>,
}));
vi.mock('../documents/employee-documents-section', () => ({
  EmployeeDocumentsSection: () => <section aria-label="Documents section">documents</section>,
}));
vi.mock('../performance/employee-performance-section', () => ({
  EmployeePerformanceSection: () => <section aria-label="Performance section">performance</section>,
}));
vi.mock('../compensation/employee-compensation-section', () => ({
  EmployeeCompensationSection: ({ employeeId }: { employeeId: string }) => (
    <section aria-label="Compensation section">compensation for {employeeId}</section>
  ),
}));

const makeAssignment = (overrides = {}) => ({
  id: 'assignment-1',
  employmentType: 'FULL_TIME',
  status: 'ACTIVE',
  startDate: '2026-09-01',
  endDate: null,
  isPrimary: true,
  position: { id: 'position-1', name: 'Platform Engineer', code: 'PE-1' },
  jobTitle: { id: 'job-1', name: 'Engineer', code: 'ENG' },
  organization: { id: 'org-1', name: 'Acme', code: 'ACME' },
  placement: { type: 'TEAM', id: 'team-1', name: 'Platform', code: 'PLAT' },
  workLocation: { id: 'location-1', name: 'HQ', code: 'HQ' },
  manager: {
    assignmentId: 'manager-1',
    employeeId: 'manager-1',
    employeeNumber: 'EMP-2',
    displayName: 'Grace Hopper',
    positionName: 'Engineering Manager',
  },
  ...overrides,
});

const profile = {
  id: 'employee-1',
  employeeNumber: 'EMP-000001',
  status: 'ACTIVE',
  hireDate: '2026-09-01',
  terminationDate: null,
  person: {
    firstName: 'Augusta',
    middleName: null,
    lastName: 'Lovelace',
    preferredName: 'Ada',
    personalEmail: 'ada@example.com',
    phone: '555-0100',
  },
  assignments: { current: [makeAssignment()], upcoming: [], historical: [], cancelled: [] },
};

const positionOption = {
  id: 'position-2',
  name: 'Support Lead',
  code: 'SL-1',
  jobTitle: { id: 'job-2', name: 'Lead', code: 'LEAD' },
  organization: { id: 'org-1', name: 'Acme', code: 'ACME' },
  placement: { type: 'TEAM' as const, id: 'team-1', name: 'Platform', code: 'PLAT' },
  workLocation: null,
};

const managerOption = {
  assignmentId: 'manager-option-1',
  employeeId: 'manager-employee-1',
  employeeNumber: 'EMP-000002',
  displayName: 'Grace Hopper',
  position: { id: 'position-manager', name: 'Engineering Manager', code: 'EM-1' },
  jobTitle: { id: 'job-manager', name: 'Manager', code: 'MGR' },
  organization: { id: 'org-1', name: 'Acme', code: 'ACME' },
  startDate: '2026-01-01',
  endDate: null,
  status: 'ACTIVE',
};

function termination(overrides: Record<string, unknown> = {}) {
  return {
    id: 't-1',
    employeeId: 'employee-1',
    terminationDate: '2026-12-31',
    status: 'SCHEDULED',
    systemGrantsAcknowledged: false,
    recordedByUserId: 'user-hr',
    recordedAt: '2026-11-04T17:00:00.000Z',
    appliedAt: null,
    appliedSource: null,
    cancelledAt: null,
    cancelledByUserId: null,
    supersededById: null,
    rehireAssignmentId: null,
    rehiredAt: null,
    assignments: [],
    ...overrides,
  };
}

function preview(date: string, overrides: Record<string, unknown> = {}) {
  return {
    employeeId: 'employee-1',
    terminationDate: date,
    scheduled: true,
    assignments: [
      {
        employmentAssignmentId: 'assignment-1',
        positionName: 'Platform Engineer',
        organizationId: 'org-1',
        organizationName: 'Acme',
        timezone: 'America/Toronto',
        status: 'ACTIVE',
        startDate: '2026-09-01',
        endDate: null,
        action: 'END',
        newEndDate: date,
        effectiveFrom: date,
      },
    ],
    blockers: [],
    followUps: {
      openTimeEntries: 0,
      futurePublishedShifts: 2,
      pendingLeaveRequests: 0,
      approvedLeaveAfterTermination: 0,
      openBenefitEnrollments: 0,
      openPerformanceReviews: 0,
    },
    access: null,
    ...overrides,
  };
}

/** Opens the profile on a tab through the URL hash (the workspace tabs are URL-synced). */
function atTab(tab: string) {
  window.history.replaceState(null, '', `/admin/employees/employee-1#${tab}`);
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  window.history.replaceState(null, '', '/admin/employees/employee-1');
  mocks.useAuth.mockReturnValue({
    authorizationLoading: false,
    authorization: {
      permissions: [{ key: 'employee.read', scopes: [{ type: 'TEAM', id: 'team-1' }] }],
    },
    can: vi.fn(() => false),
  });
  mocks.get.mockResolvedValue(profile);
  mocks.terminations.mockResolvedValue({ items: [] });
  mocks.terminationGrants.mockResolvedValue({
    grants: [],
    otherAccessRemains: false,
    loginWillBeDisabled: true,
    blocking: [],
    keepLimit: '2100-01-31T05:00:00.000Z',
  });
  mocks.accessReview.mockResolvedValue({
    employeeId: 'employee-1',
    employeeStatus: 'ACTIVE',
    access: null,
  });
  mocks.update.mockResolvedValue({ id: 'employee-1' });
  mocks.listPositionOptions.mockResolvedValue({ items: [positionOption], nextAfterId: null });
  mocks.listManagerAssignmentOptions.mockResolvedValue({
    items: [managerOption],
    nextAfterId: null,
  });
  mocks.createAssignment.mockResolvedValue({ id: 'assignment-new' });
  mocks.updateAssignment.mockResolvedValue({ id: 'assignment-1' });
  mocks.endAssignment.mockResolvedValue({ id: 'assignment-1' });
  mocks.cancelAssignment.mockResolvedValue({ id: 'assignment-1' });
  mocks.setAssignmentPrimary.mockResolvedValue({ id: 'assignment-1' });
  mocks.setAssignmentManager.mockResolvedValue({ id: 'assignment-1' });
  mocks.terminate.mockResolvedValue({ id: 'employee-1' });
  mocks.rehire.mockResolvedValue({ id: 'employee-1' });
  // Unavailable capabilities: the profile degrades to the permission checks.
  mocks.capabilities.mockRejectedValue(new AuthApiError('service-unavailable', 503));
});

afterEach(cleanup);

describe('EmployeeProfilePage', () => {
  it('renders overview, assignment details, manager, placement, location, and date-only values', async () => {
    render(<EmployeeProfilePage employeeId="employee-1" />);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Ada' })).toBeInTheDocument());
    expect(screen.getAllByText('EMP-000001').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Active').length).toBeGreaterThan(0);
    expect(screen.getByText('Sep 1, 2026')).toBeInTheDocument();
    expect(screen.getByText('ada@example.com')).toBeInTheDocument();
    expect(screen.getByText('555-0100')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(screen.getByRole('tab', { name: 'Employment' }));
    expect(window.location.hash).toBe('#employment');
    expect(screen.getByText('Current employment')).toBeInTheDocument();
    expect(screen.getByText('Platform Engineer')).toBeInTheDocument();
    expect(screen.getByText('Engineer · Acme')).toBeInTheDocument();
    expect(screen.getByText('Full Time')).toBeInTheDocument();
    expect(screen.getByText('Primary assignment')).toBeInTheDocument();
    expect(screen.getByText('Platform')).toBeInTheDocument();
    expect(screen.getByText('HQ')).toBeInTheDocument();
    expect(screen.getAllByText('Grace Hopper').length).toBeGreaterThan(0);
  });

  it('uses backend assignment groups and omits empty groups', async () => {
    mocks.get.mockResolvedValue({
      ...profile,
      assignments: {
        current: [makeAssignment()],
        upcoming: [makeAssignment({ id: 'upcoming', status: 'PLANNED' })],
        historical: [makeAssignment({ id: 'history', status: 'ENDED', endDate: '2026-09-30' })],
        cancelled: [],
      },
    });
    atTab('employment');
    render(<EmployeeProfilePage employeeId="employee-1" />);
    await waitFor(() => expect(screen.getByText('Upcoming employment')).toBeInTheDocument());
    expect(screen.getByText('Employment history')).toBeInTheDocument();
    expect(screen.queryByText('Cancelled employment')).not.toBeInTheDocument();
  });

  it('renders placement types and omits null placement, location, and manager', async () => {
    mocks.get.mockResolvedValue({
      ...profile,
      assignments: {
        current: [
          makeAssignment({
            id: 'unit',
            placement: {
              type: 'ORGANIZATIONAL_UNIT',
              id: 'unit',
              name: 'Technology',
              code: 'TECH',
            },
            workLocation: null,
            manager: null,
          }),
        ],
        upcoming: [
          makeAssignment({
            id: 'department',
            placement: { type: 'DEPARTMENT', id: 'department', name: 'Engineering', code: 'ENG' },
            manager: null,
            workLocation: null,
          }),
        ],
        historical: [
          makeAssignment({ id: 'none', placement: null, manager: null, workLocation: null }),
        ],
        cancelled: [],
      },
    });
    atTab('employment');
    render(<EmployeeProfilePage employeeId="employee-1" />);
    await waitFor(() => expect(screen.getByText('Technology')).toBeInTheDocument());
    expect(screen.getByText('Business unit')).toBeInTheDocument();
    expect(screen.getByText('Engineering')).toBeInTheDocument();
    expect(screen.getByText('Department')).toBeInTheDocument();
    expect(screen.queryByText('Grace Hopper')).not.toBeInTheDocument();
    expect(screen.queryByText('HQ')).not.toBeInTheDocument();
  });

  it('renders terminated and fully unassigned employees without management actions', async () => {
    mocks.get.mockResolvedValue({
      ...profile,
      status: 'TERMINATED',
      terminationDate: '2026-09-30',
      assignments: { current: [], upcoming: [], historical: [], cancelled: [] },
    });
    render(<EmployeeProfilePage employeeId="employee-1" />);
    await waitFor(() => expect(screen.getAllByText('Terminated').length).toBeGreaterThan(0));
    expect(screen.getByText('Sep 30, 2026')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Employment' }));
    expect(screen.getByText('No visible employment.')).toBeInTheDocument();
    for (const label of [
      'Create Employee',
      'Edit',
      'Add assignment',
      'End assignment',
      'Cancel assignment',
      'Terminate',
      'Rehire',
    ]) {
      expect(screen.queryByRole('button', { name: label })).not.toBeInTheDocument();
    }
  });

  it('adds assignments for SYSTEM and scoped managers with management Position options', async () => {
    mocks.useAuth.mockReturnValue({
      authorizationLoading: false,
      authorization: {
        permissions: [
          { key: 'employee.read', scopes: [{ type: 'TEAM', id: 'team-1' }] },
          { key: 'employee.manage', scopes: [{ type: 'TEAM', id: 'team-1' }] },
        ],
      },
      can: vi.fn(() => false),
    });
    mocks.get.mockResolvedValueOnce(profile).mockResolvedValueOnce({
      ...profile,
      assignments: {
        ...profile.assignments,
        upcoming: [
          makeAssignment({
            id: 'assignment-new',
            position: { id: 'position-2', name: 'Support Lead', code: 'SL-1' },
            isPrimary: false,
          }),
        ],
      },
    });
    atTab('employment');
    render(<EmployeeProfilePage employeeId="employee-1" />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Add assignment' })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getAllByRole('button', { name: 'Add assignment' }).at(-1)!);
    await waitFor(() => expect(mocks.listPositionOptions).toHaveBeenCalledWith({ limit: 10 }));
    expect(screen.queryByLabelText('Manager')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Status')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Primary assignment')).not.toBeChecked();

    fireEvent.click(screen.getAllByRole('button', { name: 'Add assignment' }).at(-1)!);
    expect(await screen.findByRole('alert')).toHaveTextContent('Position is required.');
    fireEvent.click(screen.getByRole('button', { name: /Support Lead/ }));
    fireEvent.change(screen.getByLabelText('Employment type'), { target: { value: 'CONTRACT' } });
    fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '2026-11-01' } });
    fireEvent.change(screen.getByLabelText('End date'), { target: { value: '2026-10-31' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Add assignment' }).at(-1)!);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'End date must be on or after start date.',
    );
    fireEvent.change(screen.getByLabelText('End date'), { target: { value: '2026-12-31' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Add assignment' }).at(-1)!);

    await waitFor(() =>
      expect(mocks.createAssignment).toHaveBeenCalledWith('employee-1', {
        positionId: 'position-2',
        employmentType: 'CONTRACT',
        startDate: '2026-11-01',
        endDate: '2026-12-31',
        isPrimary: false,
      }),
    );
    await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('Assignment added.')).toBeInTheDocument();
  });

  it('shows a zero manageable Position state while adding assignments', async () => {
    mocks.useAuth.mockReturnValue({
      authorizationLoading: false,
      authorization: {
        permissions: [
          { key: 'employee.read', scopes: [{ type: 'SYSTEM' }] },
          { key: 'employee.manage', scopes: [{ type: 'SYSTEM' }] },
        ],
      },
      can: vi.fn(() => true),
    });
    mocks.listPositionOptions.mockResolvedValue({ items: [], nextAfterId: null });
    atTab('employment');
    render(<EmployeeProfilePage employeeId="employee-1" />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Add assignment' })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add assignment' }));
    expect(
      await screen.findByText('No manageable positions are currently available.'),
    ).toBeInTheDocument();
  });

  it('corrects, ends, cancels, and updates primary with success refetches', async () => {
    mocks.useAuth.mockReturnValue({
      authorizationLoading: false,
      authorization: {
        permissions: [
          { key: 'employee.read', scopes: [{ type: 'SYSTEM' }] },
          { key: 'employee.manage', scopes: [{ type: 'SYSTEM' }] },
        ],
      },
      can: vi.fn(() => true),
    });
    mocks.get
      .mockResolvedValueOnce({
        ...profile,
        assignments: {
          current: [makeAssignment({ id: 'active', isPrimary: true })],
          upcoming: [
            makeAssignment({
              id: 'future',
              status: 'PLANNED',
              startDate: '9999-01-01',
              isPrimary: false,
            }),
          ],
          historical: [
            makeAssignment({
              id: 'ended',
              status: 'ENDED',
              endDate: '2026-09-30',
              isPrimary: true,
            }),
          ],
          cancelled: [makeAssignment({ id: 'cancelled', status: 'CANCELLED', isPrimary: false })],
        },
      })
      .mockResolvedValue({
        ...profile,
        assignments: {
          current: [makeAssignment({ id: 'active', isPrimary: false })],
          upcoming: [
            makeAssignment({
              id: 'future',
              status: 'PLANNED',
              startDate: '9999-01-01',
              isPrimary: false,
            }),
          ],
          historical: [
            makeAssignment({
              id: 'ended',
              status: 'ENDED',
              endDate: '2026-09-30',
              isPrimary: true,
            }),
          ],
          cancelled: [makeAssignment({ id: 'cancelled', status: 'CANCELLED', isPrimary: false })],
        },
      });
    atTab('employment');
    render(<EmployeeProfilePage employeeId="employee-1" />);
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: 'Correct assignment' }).length).toBe(3),
    );
    expect(screen.getAllByRole('button', { name: 'End assignment' })).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Cancel assignment' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Unset primary' })).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Set primary' })).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole('button', { name: 'Correct assignment' })[0]!);
    expect(screen.getByRole('heading', { name: 'Correct assignment' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Position')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Manager')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Employment type'), { target: { value: 'PART_TIME' } });
    fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '2026-09-02' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save correction' }));
    await waitFor(() =>
      expect(mocks.updateAssignment).toHaveBeenCalledWith('employee-1', 'active', {
        employmentType: 'PART_TIME',
        startDate: '2026-09-02',
      }),
    );
    expect(await screen.findByText('Assignment updated.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'End assignment' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'End assignment' }).at(-1)!);
    expect(await screen.findByRole('alert')).toHaveTextContent('End date is required.');
    fireEvent.change(screen.getByLabelText('End date'), { target: { value: '2026-09-01' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'End assignment' }).at(-1)!);
    await waitFor(() =>
      expect(mocks.endAssignment).toHaveBeenCalledWith('employee-1', 'active', {
        endDate: '2026-09-01',
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Cancel assignment' }));
    expect(
      screen.getByText(
        'This cancels a planned assignment before it takes effect. It does not delete the assignment record.',
      ),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm cancel' }));
    await waitFor(() =>
      expect(mocks.cancelAssignment).toHaveBeenCalledWith('employee-1', 'future'),
    );

    fireEvent.click(screen.getAllByRole('button', { name: 'Set primary' }).at(-1)!);
    await waitFor(() =>
      expect(mocks.setAssignmentPrimary).toHaveBeenCalledWith('employee-1', 'future', {
        isPrimary: true,
      }),
    );
  });

  it('activates a due planned assignment after confirmation, and only offers it where eligible', async () => {
    mocks.useAuth.mockReturnValue({
      authorizationLoading: false,
      authorization: {
        permissions: [
          { key: 'employee.read', scopes: [{ type: 'SYSTEM' }] },
          { key: 'employee.manage', scopes: [{ type: 'SYSTEM' }] },
        ],
      },
      can: vi.fn(() => true),
    });
    const withAssignments = (current: ReturnType<typeof makeAssignment>[]) => ({
      ...profile,
      assignments: {
        current,
        upcoming: [
          makeAssignment({
            id: 'future',
            status: 'PLANNED',
            startDate: '2099-01-01',
            isPrimary: false,
          }),
        ],
        historical: [
          makeAssignment({
            id: 'expired',
            status: 'PLANNED',
            startDate: '2020-01-01',
            endDate: '2020-06-30',
            isPrimary: false,
          }),
        ],
        cancelled: [],
      },
    });
    mocks.get
      .mockResolvedValueOnce(
        withAssignments([
          makeAssignment({ id: 'active' }),
          makeAssignment({
            id: 'due',
            status: 'PLANNED',
            startDate: '2026-09-01',
            isPrimary: false,
          }),
        ]),
      )
      .mockResolvedValue(
        withAssignments([
          makeAssignment({ id: 'active' }),
          makeAssignment({
            id: 'due',
            status: 'ACTIVE',
            startDate: '2026-09-01',
            isPrimary: false,
          }),
        ]),
      );
    mocks.activateAssignment
      .mockRejectedValueOnce(
        new AuthApiError(
          'conflict',
          409,
          'The assignment starts on 2026-09-01; it can be activated from that date (America/Toronto).',
        ),
      )
      .mockResolvedValueOnce({ outcome: 'ACTIVATED' });
    atTab('employment');
    render(<EmployeeProfilePage employeeId="employee-1" />);

    // Only the started, unexpired planned assignment can be activated.
    const activate = await screen.findAllByRole('button', { name: 'Activate assignment' });
    expect(activate).toHaveLength(1);
    fireEvent.click(activate[0]!);
    expect(screen.getByRole('heading', { name: 'Activate assignment' })).toBeInTheDocument();
    expect(mocks.activateAssignment).not.toHaveBeenCalled();

    // A refusal is shown and nothing changes.
    fireEvent.click(screen.getByRole('button', { name: 'Confirm activation' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The assignment starts on 2026-09-01; it can be activated from that date (America/Toronto).',
    );
    expect(mocks.get).toHaveBeenCalledTimes(1);

    // Confirming again activates it and refreshes the employment data.
    fireEvent.click(screen.getByRole('button', { name: 'Confirm activation' }));
    await waitFor(() =>
      expect(mocks.activateAssignment).toHaveBeenLastCalledWith('employee-1', 'due'),
    );
    expect(await screen.findByText('Assignment activated.')).toBeInTheDocument();
    expect(mocks.get).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('button', { name: 'Activate assignment' })).not.toBeInTheDocument();
  });

  it('never offers activation for an inactive employee', async () => {
    mocks.useAuth.mockReturnValue({
      authorizationLoading: false,
      authorization: {
        permissions: [
          { key: 'employee.read', scopes: [{ type: 'SYSTEM' }] },
          { key: 'employee.manage', scopes: [{ type: 'SYSTEM' }] },
        ],
      },
      can: vi.fn(() => true),
    });
    mocks.get.mockResolvedValue({
      ...profile,
      status: 'INACTIVE',
      assignments: {
        current: [makeAssignment({ id: 'due', status: 'PLANNED', startDate: '2026-09-01' })],
        upcoming: [],
        historical: [],
        cancelled: [],
      },
    });
    atTab('employment');
    render(<EmployeeProfilePage employeeId="employee-1" />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Correct assignment' })).toBeInTheDocument(),
    );
    expect(screen.queryByRole('button', { name: 'Activate assignment' })).not.toBeInTheDocument();
  });

  it('Batch 5E: never offers Add assignment or Change position for an inactive employee', async () => {
    mocks.useAuth.mockReturnValue({
      authorizationLoading: false,
      authorization: {
        permissions: [
          { key: 'employee.read', scopes: [{ type: 'SYSTEM' }] },
          { key: 'employee.manage', scopes: [{ type: 'SYSTEM' }] },
        ],
      },
      can: vi.fn(() => true),
    });
    mocks.get.mockResolvedValue({ ...profile, status: 'INACTIVE' });
    atTab('employment');
    render(<EmployeeProfilePage employeeId="employee-1" />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Correct assignment' })).toBeInTheDocument(),
    );
    expect(screen.queryByRole('button', { name: 'Add assignment' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Change position' })).not.toBeInTheDocument();
  });

  it("Batch 5E (D1): follows the changePosition capability, which is false on one's own record", async () => {
    mocks.useAuth.mockReturnValue({
      authorizationLoading: false,
      authorization: {
        permissions: [
          { key: 'employee.read', scopes: [{ type: 'TEAM', id: 'team-1' }] },
          { key: 'employee.manage', scopes: [{ type: 'TEAM', id: 'team-1' }] },
        ],
      },
      can: vi.fn(() => false),
    });
    mocks.capabilities.mockResolvedValue(capabilities({}, { changePosition: false }));
    atTab('employment');
    render(<EmployeeProfilePage employeeId="employee-1" />);
    await waitFor(() => expect(mocks.capabilities).toHaveBeenCalledWith('employee-1'));
    await screen.findByRole('heading', { name: 'Ada' });
    expect(screen.queryByRole('button', { name: 'Add assignment' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Change position' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Correct assignment' })).not.toBeInTheDocument();
  });

  it('shows assignment mutation errors from backend responses', async () => {
    mocks.useAuth.mockReturnValue({
      authorizationLoading: false,
      authorization: {
        permissions: [
          { key: 'employee.read', scopes: [{ type: 'SYSTEM' }] },
          { key: 'employee.manage', scopes: [{ type: 'SYSTEM' }] },
        ],
      },
      can: vi.fn(() => true),
    });
    mocks.setAssignmentPrimary.mockRejectedValueOnce(
      new AuthApiError('conflict', 409, 'Primary assignments may not overlap.'),
    );
    atTab('employment');
    render(<EmployeeProfilePage employeeId="employee-1" />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Unset primary' })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Unset primary' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Primary assignments may not overlap.',
    );

    mocks.setAssignmentPrimary.mockRejectedValueOnce(new AuthApiError('forbidden', 403));
    fireEvent.click(screen.getByRole('button', { name: 'Unset primary' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'You do not have permission to manage this assignment.',
    );
  });

  it('sets, changes, and clears assignment managers for scoped managers with refetches', async () => {
    mocks.useAuth.mockReturnValue({
      authorizationLoading: false,
      authorization: {
        permissions: [
          { key: 'employee.read', scopes: [{ type: 'TEAM', id: 'team-1' }] },
          { key: 'employee.manage', scopes: [{ type: 'TEAM', id: 'team-1' }] },
        ],
      },
      can: vi.fn(() => false),
    });
    mocks.get.mockResolvedValue({
      ...profile,
      assignments: {
        current: [makeAssignment({ id: 'active', manager: null })],
        upcoming: [
          makeAssignment({
            id: 'future',
            status: 'PLANNED',
            startDate: '9999-01-01',
            isPrimary: false,
            manager: null,
          }),
        ],
        historical: [makeAssignment({ id: 'ended', status: 'ENDED', endDate: '2026-09-30' })],
        cancelled: [makeAssignment({ id: 'cancelled', status: 'CANCELLED', isPrimary: false })],
      },
    });

    atTab('employment');
    render(<EmployeeProfilePage employeeId="employee-1" />);
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: 'Correct assignment' })).toHaveLength(3),
    );
    expect(screen.getAllByRole('button', { name: 'Set manager' })).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Change manager' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clear manager' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Terminate employee' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Rehire employee' })).not.toBeInTheDocument();

    fireEvent.click(screen.getAllByRole('button', { name: 'Set manager' })[0]!);
    await waitFor(() =>
      expect(mocks.listManagerAssignmentOptions).toHaveBeenCalledWith({
        subordinateAssignmentId: 'active',
        limit: 10,
      }),
    );
    fireEvent.click(await screen.findByRole('button', { name: /Grace Hopper/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save manager' }));
    await waitFor(() =>
      expect(mocks.setAssignmentManager).toHaveBeenCalledWith('employee-1', 'active', {
        managerAssignmentId: 'manager-option-1',
      }),
    );
    await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('Manager updated.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Clear manager' }));
    expect(
      screen.getByText(
        'This clears the manager from this assignment and preserves the assignment history.',
      ),
    ).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Clear manager' }).at(-1)!);
    await waitFor(() =>
      expect(mocks.setAssignmentManager).toHaveBeenLastCalledWith('employee-1', 'ended', {
        managerAssignmentId: null,
      }),
    );
    expect(await screen.findByText('Manager cleared.')).toBeInTheDocument();
  });

  it('surfaces manager mutation errors from backend responses', async () => {
    mocks.useAuth.mockReturnValue({
      authorizationLoading: false,
      authorization: {
        permissions: [
          { key: 'employee.read', scopes: [{ type: 'SYSTEM' }] },
          { key: 'employee.manage', scopes: [{ type: 'SYSTEM' }] },
        ],
      },
      can: vi.fn(() => true),
    });
    mocks.get.mockResolvedValue({
      ...profile,
      assignments: {
        current: [makeAssignment({ id: 'active', manager: null })],
        upcoming: [],
        historical: [],
        cancelled: [],
      },
    });
    mocks.setAssignmentManager.mockRejectedValueOnce(
      new AuthApiError('validation', 400, 'Manager relationship would create a cycle.'),
    );
    atTab('employment');
    render(<EmployeeProfilePage employeeId="employee-1" />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Set manager' })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Set manager' }));
    fireEvent.click(await screen.findByRole('button', { name: /Grace Hopper/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save manager' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Manager relationship would create a cycle.',
    );
  });

  it('Batch 5C: terminates through the preview dialog, then rehires into a new assignment', async () => {
    const can = vi.fn((permission: string) => permission === 'employee.manage');
    mocks.useAuth.mockReturnValue({
      authorizationLoading: false,
      authorization: {
        permissions: [
          { key: 'employee.read', scopes: [{ type: 'SYSTEM' }] },
          { key: 'employee.manage', scopes: [{ type: 'SYSTEM' }] },
        ],
      },
      can,
    });
    const terminatedProfile = {
      ...profile,
      status: 'TERMINATED',
      terminationDate: '2026-10-31',
      assignments: {
        current: [],
        upcoming: [],
        historical: [makeAssignment({ id: 'ended', status: 'ENDED', endDate: '2026-10-31' })],
        cancelled: [makeAssignment({ id: 'cancelled', status: 'CANCELLED', isPrimary: false })],
      },
    };
    const rehiredProfile = { ...profile, status: 'ACTIVE', terminationDate: null };
    mocks.get
      .mockResolvedValueOnce(profile)
      .mockResolvedValueOnce(terminatedProfile)
      .mockResolvedValueOnce(rehiredProfile);
    mocks.terminationPreview.mockImplementation(async (_id: string, date: string) =>
      preview(date, { scheduled: false }),
    );
    mocks.terminate.mockResolvedValue({
      termination: termination({ status: 'APPLIED', terminationDate: '2026-10-31' }),
      employee: { id: 'employee-1', status: 'TERMINATED', terminationDate: '2026-10-31' },
    });
    mocks.rehire.mockResolvedValue({
      employee: { id: 'employee-1', status: 'ACTIVE' },
      assignment: { id: 'new' },
      terminationId: 't-1',
    });

    atTab('employment');
    render(<EmployeeProfilePage employeeId="employee-1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Terminate employee' }));
    const dialog = screen.getByRole('dialog', { name: 'Terminate employee' });
    expect(dialog).toHaveTextContent(/inclusive/);
    expect(dialog).toHaveTextContent(
      /role grants in the organizations it ends are revoked unless an approved exception keeps one/,
    );
    // A date before the hire date is refused before any request.
    fireEvent.change(screen.getByLabelText('Last day of employment'), {
      target: { value: '2026-08-31' },
    });
    expect(screen.getByText(/cannot be before the hire date/)).toBeInTheDocument();
    expect(mocks.terminationPreview).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Last day of employment'), {
      target: { value: '2026-10-31' },
    });
    fireEvent.change(screen.getByLabelText(/^Reason/), { target: { value: 'Private detail' } });
    expect(
      await screen.findByText(/Immediate: Oct 31, 2026 has already passed/),
    ).toBeInTheDocument();
    const submit = screen.getByRole('button', { name: 'Terminate now' });
    expect(submit).toBeDisabled();
    fireEvent.click(screen.getByLabelText(/employment ends now/));
    fireEvent.click(screen.getByRole('button', { name: 'Terminate now' }));
    await waitFor(() =>
      expect(mocks.terminate).toHaveBeenCalledWith('employee-1', {
        terminationDate: '2026-10-31',
        reason: 'Private detail',
      }),
    );
    expect(await screen.findByText(/Employee terminated\./)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add assignment' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Terminate employee' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Correct assignment' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Rehire employee' }));
    const rehire = screen.getByRole('dialog', { name: 'Rehire employee' });
    expect(rehire).toHaveTextContent(/Sign-in access and role grants are not restored/);
    // The start date defaults to the day after the last day.
    expect(screen.getByLabelText('Start date')).toHaveValue('2026-11-01');
    fireEvent.click(screen.getAllByRole('button', { name: 'Rehire employee' }).at(-1)!);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Choose the position for the new assignment.',
    );
    fireEvent.click(await screen.findByRole('button', { name: /Support Lead/ }));
    fireEvent.change(screen.getByLabelText('Employment type'), { target: { value: 'FULL_TIME' } });
    fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '2026-10-31' } });
    expect(await screen.findByRole('alert')).toHaveTextContent(/must start after the last day/);
    fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '2027-01-15' } });
    fireEvent.click(screen.getByRole('button', { name: 'Choose manager' }));
    await waitFor(() =>
      expect(mocks.listManagerAssignmentOptions).toHaveBeenCalledWith(
        expect.objectContaining({
          positionId: 'position-2',
          startDate: '2027-01-15',
          employeeId: 'employee-1',
        }),
      ),
    );
    fireEvent.click(await screen.findByRole('button', { name: /Grace Hopper/ }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Rehire employee' }).at(-1)!);
    await waitFor(() =>
      expect(mocks.rehire).toHaveBeenCalledWith('employee-1', {
        assignment: {
          positionId: 'position-2',
          employmentType: 'FULL_TIME',
          startDate: '2027-01-15',
          isPrimary: true,
          managerAssignmentId: 'manager-option-1',
        },
      }),
    );
    expect(await screen.findByText(/Employee rehired into the new assignment/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add assignment' })).toBeInTheDocument();
  });

  it('Batch 5C: schedules a future termination, shows the banner, and cancels it', async () => {
    mocks.useAuth.mockReturnValue({
      authorizationLoading: false,
      authorization: {
        permissions: [
          { key: 'employee.read', scopes: [{ type: 'SYSTEM' }] },
          { key: 'employee.manage', scopes: [{ type: 'SYSTEM' }] },
        ],
      },
      can: vi.fn((permission: string) => permission === 'employee.manage'),
    });
    const scheduled = { ...profile, terminationDate: '2099-12-31' };
    mocks.get
      .mockResolvedValueOnce(profile)
      .mockResolvedValueOnce(scheduled)
      .mockResolvedValue(profile);
    mocks.terminations
      .mockResolvedValueOnce({ items: [] })
      .mockResolvedValueOnce({
        items: [termination({ terminationDate: '2099-12-31', reason: 'Private detail' })],
      })
      .mockResolvedValue({ items: [termination({ status: 'CANCELLED' })] });
    mocks.terminationPreview.mockImplementation(async (_id: string, date: string) =>
      preview(date, { scheduled: true }),
    );
    mocks.terminate.mockResolvedValueOnce({
      termination: termination({ terminationDate: '2099-12-31' }),
      employee: { id: 'employee-1', status: 'ACTIVE', terminationDate: '2099-12-31' },
      applyBlockedBy: {
        code: 'TERMINATION_KEEP_APPROVAL_REQUIRED',
        roleAssignmentIds: ['grant-owner'],
      },
    });
    mocks.cancelTermination.mockResolvedValueOnce({
      termination: termination({ status: 'CANCELLED' }),
      employee: { id: 'employee-1', status: 'ACTIVE', terminationDate: null },
    });
    atTab('employment');
    render(<EmployeeProfilePage employeeId="employee-1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Terminate employee' }));
    fireEvent.change(screen.getByLabelText('Last day of employment'), {
      target: { value: '2099-12-31' },
    });
    expect(await screen.findByText(/Scheduled: the employee keeps working/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Schedule termination' }));
    expect(
      await screen.findByText(/Termination scheduled: last day Dec 31, 2099 \(inclusive\)/),
    ).toBeInTheDocument();
    // M3: the result says when a System-level role still stops it from applying.
    expect(
      screen.getByText(/It cannot apply until a System administrator decides on/),
    ).toHaveTextContent(/the employee keeps all their access/);
    const banner = await screen.findByRole('status', { name: 'Scheduled termination' });
    expect(banner).toHaveTextContent(/keeps working through the last day/);
    expect(banner).not.toHaveTextContent('Private detail');
    expect(screen.getAllByText(/Termination scheduled/).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'Terminate employee' })).not.toBeInTheDocument();
    // New assignments are refused while a termination is scheduled.
    expect(screen.queryByRole('button', { name: 'Add assignment' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Change position' })).not.toBeInTheDocument();
    // History shows the restricted reason only because the API returned it.
    expect(await screen.findByText('Private detail')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel termination' }));
    fireEvent.click(
      within(screen.getByRole('dialog', { name: /Cancel the scheduled termination/ })).getByRole(
        'button',
        { name: 'Cancel termination' },
      ),
    );
    await waitFor(() =>
      expect(mocks.cancelTermination).toHaveBeenCalledWith('employee-1', 't-1', {}),
    );
    expect(await screen.findByText(/Scheduled termination cancelled/)).toBeInTheDocument();
  });

  it('shows SYSTEM-only profile correction and refetches after update', async () => {
    mocks.useAuth.mockReturnValue({
      authorizationLoading: false,
      authorization: {
        permissions: [
          { key: 'employee.read', scopes: [{ type: 'SYSTEM' }] },
          { key: 'employee.manage', scopes: [{ type: 'SYSTEM' }] },
        ],
      },
      can: vi.fn((permission: string) => permission === 'employee.manage'),
    });
    mocks.get.mockResolvedValueOnce(profile).mockResolvedValueOnce({
      ...profile,
      person: { ...profile.person, firstName: 'Ada', preferredName: 'Countess' },
    });
    render(<EmployeeProfilePage employeeId="employee-1" />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Edit employee' })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Edit employee' }));

    expect(screen.getByRole('heading', { name: 'Edit profile' })).toBeInTheDocument();
    expect(screen.getByLabelText('First name')).toHaveValue('Augusta');
    expect(screen.queryByLabelText('Employee number')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Hire date')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Status')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Termination date')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('User')).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('First name'), { target: { value: ' Ada ' } });
    fireEvent.change(screen.getByLabelText('Preferred name'), { target: { value: ' Countess ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));

    await waitFor(() =>
      // R4-A.2: only the changed fields are sent.
      expect(mocks.update).toHaveBeenCalledWith('employee-1', {
        firstName: 'Ada',
        preferredName: 'Countess',
      }),
    );
    await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('Profile updated.')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Edit employee' })).not.toBeInTheDocument();
  });

  it('hides profile correction for scoped managers and cancels without mutation', async () => {
    mocks.useAuth.mockReturnValue({
      authorizationLoading: false,
      authorization: {
        permissions: [
          { key: 'employee.read', scopes: [{ type: 'TEAM', id: 'team-1' }] },
          { key: 'employee.manage', scopes: [{ type: 'TEAM', id: 'team-1' }] },
        ],
      },
      can: vi.fn(() => false),
    });
    const scoped = render(<EmployeeProfilePage employeeId="employee-1" />);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Ada' })).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Edit employee' })).not.toBeInTheDocument();
    scoped.unmount();
    cleanup();

    mocks.useAuth.mockReturnValue({
      authorizationLoading: false,
      authorization: {
        permissions: [
          { key: 'employee.read', scopes: [{ type: 'SYSTEM' }] },
          { key: 'employee.manage', scopes: [{ type: 'SYSTEM' }] },
        ],
      },
      can: vi.fn(() => true),
    });
    render(<EmployeeProfilePage employeeId="employee-1" />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Edit employee' })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Edit employee' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('surfaces profile correction errors', async () => {
    mocks.useAuth.mockReturnValue({
      authorizationLoading: false,
      authorization: {
        permissions: [
          { key: 'employee.read', scopes: [{ type: 'SYSTEM' }] },
          { key: 'employee.manage', scopes: [{ type: 'SYSTEM' }] },
        ],
      },
      can: vi.fn(() => true),
    });
    mocks.update.mockRejectedValueOnce(new AuthApiError('forbidden', 403));
    render(<EmployeeProfilePage employeeId="employee-1" />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Edit employee' })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Edit employee' }));
    fireEvent.change(screen.getByLabelText('Phone'), { target: { value: '555-0199' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'You do not have permission to manage employees.',
    );
  });

  it('shows compensation only to holders of a compensation permission, never for employee.* alone', async () => {
    mocks.useAuth.mockReturnValue({
      authorizationLoading: false,
      authorization: {
        permissions: [
          { key: 'employee.read', scopes: [{ type: 'SYSTEM' }] },
          { key: 'employee.manage', scopes: [{ type: 'SYSTEM' }] },
        ],
      },
      can: vi.fn(() => true),
    });
    render(<EmployeeProfilePage employeeId="employee-1" />);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Ada' })).toBeInTheDocument());
    expect(screen.queryByRole('region', { name: 'Compensation section' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Compensation' })).not.toBeInTheDocument();
    cleanup();

    mocks.useAuth.mockReturnValue({
      authorizationLoading: false,
      authorization: {
        permissions: [
          { key: 'employee.read', scopes: [{ type: 'TEAM', id: 'team-1' }] },
          { key: 'compensation.read', scopes: [{ type: 'TEAM', id: 'team-1' }] },
        ],
      },
      can: vi.fn(() => false),
    });
    render(<EmployeeProfilePage employeeId="employee-1" />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Compensation' }));
    expect(await screen.findByRole('region', { name: 'Compensation section' })).toHaveTextContent(
      'compensation for employee-1',
    );
  });

  it('uses anti-disclosure not-found and Forbidden presentations', async () => {
    mocks.get.mockRejectedValueOnce(new AuthApiError('unexpected', 404));
    render(<EmployeeProfilePage employeeId="missing" />);
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Employee not found' })).toBeInTheDocument(),
    );
    expect(
      screen.getByText(
        'This employee may not exist or may not be available in your authorized scope.',
      ),
    ).toBeInTheDocument();

    mocks.get.mockRejectedValueOnce(new AuthApiError('forbidden', 403));
    render(<EmployeeProfilePage employeeId="forbidden" />);
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Access denied' })).toBeInTheDocument(),
    );
  });
});

const capabilities = (
  tabs: Partial<Record<string, boolean>> = {},
  actions: Partial<Record<string, boolean>> = {},
) => ({
  employeeId: 'employee-1',
  organizationIds: ['org-1'],
  tabs: {
    overview: true,
    employment: true,
    compensation: false,
    time: false,
    leave: false,
    benefits: false,
    documents: false,
    performance: false,
    ...tabs,
  },
  actions: {
    edit: false,
    changePosition: false,
    assignManager: false,
    addCompensation: false,
    manageDocuments: false,
    startOffboarding: false,
    ...actions,
  },
});

describe('EmployeeProfilePage workspace (capabilities)', () => {
  const tabNames = () => screen.getAllByRole('tab').map((tab) => tab.textContent);

  it('Batch 7A: with only ended assignments, Start offboarding preselects the latest one', async () => {
    mocks.get.mockResolvedValue({
      ...profile,
      assignments: {
        current: [],
        upcoming: [],
        historical: [
          makeAssignment({ id: 'older', status: 'ENDED', endDate: '2026-06-30' }),
          makeAssignment({ id: 'latest', status: 'ENDED', endDate: '2026-09-30' }),
        ],
        cancelled: [],
      },
    });
    mocks.capabilities.mockResolvedValue(capabilities({}, { startOffboarding: true }));
    render(<EmployeeProfilePage employeeId="employee-1" />);
    await screen.findByRole('heading', { name: 'Ada' });
    expect(screen.getByRole('link', { name: 'Start offboarding' })).toHaveAttribute(
      'href',
      '/admin/onboarding?offboardEmployee=employee-1&offboardOrganization=org-1&offboardAssignment=latest&offboardEndDate=2026-09-30#start',
    );
  });

  it('shows only the tabs and contextual actions the capabilities allow', async () => {
    mocks.capabilities.mockResolvedValue(capabilities());
    render(<EmployeeProfilePage employeeId="employee-1" />);
    await waitFor(() => expect(mocks.capabilities).toHaveBeenCalledWith('employee-1'));
    await screen.findByRole('heading', { name: 'Ada' });
    expect(tabNames()).toEqual(['Overview', 'Employment']);
    for (const label of [
      'Edit employee',
      'Change position',
      'Assign manager',
      'Add compensation',
      'Manage documents',
      'Start offboarding',
      'Start onboarding',
      'Terminate employee',
    ]) {
      expect(screen.queryByRole('button', { name: label })).not.toBeInTheDocument();
      expect(screen.queryByRole('link', { name: label })).not.toBeInTheDocument();
    }
    cleanup();

    mocks.capabilities.mockResolvedValue(
      capabilities(
        {
          compensation: true,
          time: true,
          leave: true,
          benefits: true,
          documents: true,
          performance: true,
        },
        {
          edit: true,
          changePosition: true,
          assignManager: true,
          addCompensation: true,
          manageDocuments: true,
          startOffboarding: true,
          startOnboarding: true,
        },
      ),
    );
    render(<EmployeeProfilePage employeeId="employee-1" />);
    await screen.findByRole('heading', { name: 'Ada' });
    expect(tabNames()).toEqual([
      'Overview',
      'Employment',
      'Compensation',
      'Time',
      'Leave',
      'Benefits',
      'Documents',
      'Performance',
    ]);
    for (const label of [
      'Edit employee',
      'Change position',
      'Assign manager',
      'Add compensation',
      'Manage documents',
    ])
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    // Batch 5C: the offboarding form opens with the employee and assignment preselected.
    expect(screen.getByRole('link', { name: 'Start offboarding' })).toHaveAttribute(
      'href',
      '/admin/onboarding?offboardEmployee=employee-1&offboardOrganization=org-1&offboardAssignment=assignment-1#start',
    );
    // Batch 7A: the onboarding form opens preselected too; following the link starts nothing.
    expect(screen.getByRole('link', { name: 'Start onboarding' })).toHaveAttribute(
      'href',
      '/admin/onboarding?onboardEmployee=employee-1&onboardOrganization=org-1&onboardAssignment=assignment-1#start',
    );
    // Capabilities win over the permission snapshot (which holds no employee.manage here).
    expect(screen.getByRole('button', { name: 'Terminate employee' })).toBeInTheDocument();
  });

  it('wires contextual actions to the existing flows and tabs', async () => {
    mocks.capabilities.mockResolvedValue(
      capabilities(
        { compensation: true, documents: true },
        { changePosition: true, assignManager: true, addCompensation: true, manageDocuments: true },
      ),
    );
    render(<EmployeeProfilePage employeeId="employee-1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add compensation' }));
    expect(screen.getByRole('tab', { name: 'Compensation' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByRole('region', { name: 'Compensation section' })).toBeInTheDocument();
    expect(window.location.hash).toBe('#compensation');

    fireEvent.click(screen.getByRole('button', { name: 'Manage documents' }));
    expect(screen.getByRole('region', { name: 'Documents section' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Assign manager' }));
    expect(screen.getByRole('tab', { name: 'Employment' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByRole('heading', { name: 'Change manager' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Change position' }));
    await waitFor(() => expect(mocks.listPositionOptions).toHaveBeenCalled());
    expect(screen.getByLabelText('Employment type')).toBeInTheDocument();
  });

  it('shows Add assignment for zero-assignment employees when capabilities allow bootstrap', async () => {
    mocks.capabilities.mockResolvedValue(capabilities({}, { changePosition: true }));
    mocks.get.mockResolvedValue({
      ...profile,
      assignments: { current: [], upcoming: [], historical: [], cancelled: [] },
    });
    atTab('employment');

    render(<EmployeeProfilePage employeeId="employee-1" />);

    expect(await screen.findByText('No visible employment.')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Add assignment' })).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Change position' })).not.toBeInTheDocument();
  });

  it('hides Add assignment for zero-assignment employees when capabilities deny bootstrap', async () => {
    mocks.capabilities.mockResolvedValue(capabilities({}, { changePosition: false }));
    mocks.get.mockResolvedValue({
      ...profile,
      assignments: { current: [], upcoming: [], historical: [], cancelled: [] },
    });
    atTab('employment');

    render(<EmployeeProfilePage employeeId="employee-1" />);

    expect(await screen.findByText('No visible employment.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add assignment' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Change position' })).not.toBeInTheDocument();
  });

  it('opens the tab named in the URL and moves between tabs with the keyboard', async () => {
    mocks.capabilities.mockResolvedValue(capabilities({ benefits: true, performance: true }));
    atTab('benefits');
    render(<EmployeeProfilePage employeeId="employee-1" />);
    const benefits = await screen.findByRole('tab', { name: 'Benefits' });
    expect(benefits).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', benefits.id);
    expect(screen.getByRole('region', { name: 'Benefits section' })).toBeInTheDocument();
    expect(benefits).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('tabindex', '-1');

    benefits.focus();
    fireEvent.keyDown(benefits, { key: 'ArrowRight' });
    const performance = screen.getByRole('tab', { name: 'Performance' });
    expect(performance).toHaveAttribute('aria-selected', 'true');
    expect(performance).toHaveFocus();
    expect(window.location.hash).toBe('#performance');
    fireEvent.keyDown(performance, { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: 'End' });
    expect(screen.getByRole('tab', { name: 'Performance' })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: 'Home' });
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' });
    expect(screen.getByRole('tab', { name: 'Performance' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('ignores a URL tab the capabilities do not allow', async () => {
    mocks.capabilities.mockResolvedValue(capabilities());
    atTab('compensation');
    render(<EmployeeProfilePage employeeId="employee-1" />);
    expect(await screen.findByRole('tab', { name: 'Overview' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.queryByRole('region', { name: 'Compensation section' })).not.toBeInTheDocument();
  });
});
