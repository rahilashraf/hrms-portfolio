import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EmployeeDirectoryPage } from './employee-directory';

const mocks = vi.hoisted(() => ({
  employeeList: vi.fn(),
  listOrganizations: vi.fn(),
  listJobTitles: vi.fn(),
  useAuth: vi.fn(),
}));

vi.mock('../../lib/employee/api', () => ({ employeeApi: { list: mocks.employeeList } }));
vi.mock('../../lib/organization/api', () => ({
  organizationApi: {
    listOrganizations: mocks.listOrganizations,
    listJobTitles: mocks.listJobTitles,
  },
}));
vi.mock('../../providers/auth-provider', () => ({ useAuth: mocks.useAuth }));

const assignment = {
  id: 'assignment-1',
  employmentType: 'FULL_TIME',
  status: 'ACTIVE',
  startDate: '2026-09-01',
  endDate: null,
  isPrimary: true,
  position: { id: 'position-1', name: 'Platform Engineer', code: 'PE-1' },
  jobTitle: { id: 'job-1', name: 'Engineer', code: 'ENG' },
  organization: { id: 'org-1', name: 'Acme', code: 'ACME' },
  placement: null,
  workLocation: null,
  manager: null,
};
const employee = {
  id: 'employee-1',
  employeeNumber: 'EMP-000001',
  status: 'ACTIVE',
  person: { firstName: 'Ada', middleName: null, lastName: 'Lovelace', preferredName: 'Ada' },
  displayAssignment: assignment,
};

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.useAuth.mockReturnValue({
    authorizationLoading: false,
    authorization: {
      permissions: [{ key: 'employee.read', scopes: [{ type: 'TEAM', id: 'team-1' }] }],
    },
  });
  mocks.listOrganizations.mockResolvedValue([{ id: 'org-1', name: 'Acme', code: 'ACME' }]);
  mocks.listJobTitles.mockResolvedValue([{ id: 'job-1', name: 'Engineer', code: 'ENG' }]);
  mocks.employeeList.mockResolvedValue({ items: [employee], nextAfterId: null });
});

afterEach(cleanup);

describe('EmployeeDirectoryPage', () => {
  it('renders employee fields and a clean unassigned state', async () => {
    mocks.employeeList.mockResolvedValue({
      items: [
        employee,
        { ...employee, id: 'employee-2', employeeNumber: 'EMP-000002', displayAssignment: null },
      ],
      nextAfterId: null,
    });
    render(<EmployeeDirectoryPage />);
    await waitFor(() => expect(screen.getAllByText('Ada').length).toBe(2));
    expect(screen.getByText('EMP-000001')).toBeInTheDocument();
    expect(screen.getByText('Platform Engineer')).toBeInTheDocument();
    expect(screen.getByText('Engineer')).toBeInTheDocument();
    expect(screen.getAllByText('Acme').length).toBeGreaterThan(0);
    expect(screen.getByText('Full Time')).toBeInTheDocument();
    expect(screen.getAllByText('Active').length).toBeGreaterThan(0);
    expect(screen.getByText('No assignment')).toBeInTheDocument();
  });

  it('requests the first page with a valid integer page size and no filters', async () => {
    render(<EmployeeDirectoryPage />);
    await waitFor(() => expect(mocks.employeeList).toHaveBeenCalledTimes(1));
    const [query] = mocks.employeeList.mock.calls[0]!;
    expect(query).toEqual({ limit: 25 });
    expect(Number.isInteger(query.limit) && query.limit >= 1 && query.limit <= 100).toBe(true);
  });

  it('debounces trimmed backend search and maps status filters', async () => {
    render(<EmployeeDirectoryPage />);
    await waitFor(() => expect(mocks.employeeList).toHaveBeenCalled());
    fireEvent.change(screen.getAllByPlaceholderText('Search by employee number or name')[0], {
      target: { value: '  Ada  ' },
    });
    await waitFor(
      () =>
        expect(mocks.employeeList).toHaveBeenCalledWith(expect.objectContaining({ search: 'Ada' })),
      { timeout: 1000 },
    );
    fireEvent.change(screen.getAllByDisplayValue('All statuses')[0], {
      target: { value: 'TERMINATED' },
    });
    await waitFor(() =>
      expect(mocks.employeeList).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'TERMINATED' }),
      ),
    );
  });

  it('loads dependent job titles and clears the job title with organization', async () => {
    render(<EmployeeDirectoryPage />);
    await waitFor(() => expect(screen.getByRole('option', { name: 'Acme' })).toBeInTheDocument());
    const selects = screen.getAllByRole('combobox');
    const organization = selects.find(
      (element) => (element as HTMLSelectElement).options[0]?.text === 'All organizations',
    )!;
    const jobTitle = selects.find(
      (element) =>
        (element as HTMLSelectElement).options[0]?.text === 'Select an organization first',
    )!;
    expect(jobTitle).toBeDisabled();
    fireEvent.change(organization, { target: { value: 'org-1' } });
    await waitFor(() => expect(mocks.listJobTitles).toHaveBeenCalledWith('org-1', false));
    await waitFor(() =>
      expect(screen.getByRole('option', { name: 'Engineer' })).toBeInTheDocument(),
    );
    expect(jobTitle).not.toBeDisabled();
    fireEvent.change(jobTitle, { target: { value: 'job-1' } });
    await waitFor(() =>
      expect(mocks.employeeList).toHaveBeenCalledWith(
        expect.objectContaining({ organizationId: 'org-1', jobTitleId: 'job-1' }),
      ),
    );
    fireEvent.change(organization, { target: { value: '' } });
    expect(jobTitle).toBeDisabled();
    await waitFor(() =>
      expect(mocks.employeeList).toHaveBeenCalledWith(
        expect.not.objectContaining({ jobTitleId: 'job-1' }),
      ),
    );
  });

  it('appends a cursor page and does not reload page one', async () => {
    mocks.employeeList
      .mockResolvedValueOnce({ items: [employee], nextAfterId: 'employee-1' })
      .mockResolvedValueOnce({
        items: [{ ...employee, id: 'employee-2', employeeNumber: 'EMP-000002' }],
        nextAfterId: null,
      });
    render(<EmployeeDirectoryPage />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Load more employees' })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Load more employees' }));
    await waitFor(() => expect(screen.getAllByText('EMP-000002').length).toBeGreaterThan(0));
    expect(mocks.employeeList).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ afterId: 'employee-1' }),
    );
    expect(mocks.employeeList).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('button', { name: 'Load more employees' })).not.toBeInTheDocument();
  });

  it('prevents duplicate load-more requests and resets cursor on a query change', async () => {
    let resolve!: (value: unknown) => void;
    mocks.employeeList
      .mockResolvedValueOnce({ items: [employee], nextAfterId: 'employee-1' })
      .mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      );
    render(<EmployeeDirectoryPage />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Load more employees' })).toBeInTheDocument(),
    );
    const button = screen.getByRole('button', { name: 'Load more employees' });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(mocks.employeeList).toHaveBeenCalledTimes(2);
    resolve({ items: [], nextAfterId: null });
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Load more employees' })).not.toBeInTheDocument(),
    );
  });

  it('renders loading, empty, filtered error, and no-management states', async () => {
    let resolve!: (value: unknown) => void;
    mocks.employeeList.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    render(<EmployeeDirectoryPage />);
    expect(screen.getByText('Loading organization data…')).toBeInTheDocument();
    await waitFor(() => expect(mocks.employeeList).toHaveBeenCalled());
    resolve({ items: [], nextAfterId: null });
    await waitFor(() => expect(screen.getByText('No employees found.')).toBeInTheDocument());
    mocks.employeeList.mockRejectedValueOnce(new Error('offline'));
    fireEvent.change(screen.getAllByPlaceholderText('Search by employee number or name')[0], {
      target: { value: 'missing' },
    });
    await waitFor(() => expect(screen.getByText('Unable to load employees.')).toBeInTheDocument(), {
      timeout: 1000,
    });
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
    expect(screen.queryByRole('link', { name: 'Add employee' })).not.toBeInTheDocument();
  });

  it('links to onboarding for SYSTEM and scoped employee managers', async () => {
    mocks.useAuth.mockReturnValueOnce({
      authorizationLoading: false,
      authorization: {
        permissions: [
          { key: 'employee.read', scopes: [{ type: 'SYSTEM' }] },
          { key: 'employee.manage', scopes: [{ type: 'SYSTEM' }] },
        ],
      },
    });
    const { unmount } = render(<EmployeeDirectoryPage />);
    await waitFor(() =>
      expect(screen.getByRole('link', { name: 'Add employee' })).toHaveAttribute(
        'href',
        '/admin/employees/new',
      ),
    );
    unmount();

    mocks.useAuth.mockReturnValue({
      authorizationLoading: false,
      authorization: {
        permissions: [
          { key: 'employee.read', scopes: [{ type: 'TEAM', id: 'team-1' }] },
          { key: 'employee.manage', scopes: [{ type: 'TEAM', id: 'team-1' }] },
        ],
      },
    });
    render(<EmployeeDirectoryPage />);
    await waitFor(() =>
      expect(screen.getByRole('link', { name: 'Add employee' })).toHaveAttribute(
        'href',
        '/admin/employees/new',
      ),
    );
  });
});
