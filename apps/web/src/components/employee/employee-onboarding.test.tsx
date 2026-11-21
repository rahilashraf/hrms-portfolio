import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthApiError } from '../../lib/auth/types';
import { EmployeeOnboardingPage } from './employee-onboarding';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  listPersonOptions: vi.fn(),
  listPositionOptions: vi.fn(),
  useAuth: vi.fn(),
  routerPush: vi.fn(),
}));

vi.mock('../../lib/employee/api', () => ({
  employeeApi: {
    create: mocks.create,
    listPersonOptions: mocks.listPersonOptions,
    listPositionOptions: mocks.listPositionOptions,
  },
}));
vi.mock('../../providers/auth-provider', () => ({ useAuth: mocks.useAuth }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.routerPush }) }));

const position = {
  id: 'position-1',
  name: 'Platform Engineer',
  code: 'PE-1',
  jobTitle: { id: 'job-1', name: 'Engineer', code: 'ENG' },
  organization: { id: 'org-1', name: 'Acme', code: 'ACME' },
  placement: { type: 'TEAM' as const, id: 'team-1', name: 'Platform', code: 'PLAT' },
  workLocation: { id: 'location-1', name: 'HQ', code: 'HQ' },
};

const availablePerson = {
  id: 'person-1',
  firstName: 'Ada',
  middleName: null,
  lastName: 'Lovelace',
  preferredName: null,
  personalEmail: 'ada@example.com',
  hasEmployee: false,
  hasUser: true,
};

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.create.mockResolvedValue({
    id: 'employee-1',
    employeeNumber: 'EMP-000001',
    status: 'ACTIVE',
    person: {},
  });
  mocks.listPersonOptions.mockResolvedValue({
    items: [
      availablePerson,
      {
        ...availablePerson,
        id: 'person-2',
        firstName: 'Grace',
        lastName: 'Hopper',
        personalEmail: 'grace@example.com',
        hasEmployee: true,
      },
    ],
    nextAfterId: null,
  });
  mocks.listPositionOptions.mockResolvedValue({ items: [position], nextAfterId: null });
  mocks.useAuth.mockReturnValue({
    authorizationLoading: false,
    authorization: { permissions: [{ key: 'employee.manage', scopes: [{ type: 'SYSTEM' }] }] },
    can: vi.fn(() => true),
  });
});

afterEach(cleanup);

function fillNewPerson() {
  fireEvent.change(screen.getByLabelText('First name'), { target: { value: ' Ada ' } });
  fireEvent.change(screen.getByLabelText('Last name'), { target: { value: ' Lovelace ' } });
  fireEvent.change(screen.getByLabelText('Personal email'), {
    target: { value: ' ada@example.com ' },
  });
  fireEvent.change(screen.getByLabelText('Phone'), { target: { value: ' 555-0100 ' } });
  fireEvent.change(screen.getByLabelText('Hire date'), { target: { value: '2026-10-02' } });
}

async function selectPosition() {
  await waitFor(() =>
    expect(screen.getByRole('button', { name: /Platform Engineer/ })).toBeInTheDocument(),
  );
  fireEvent.click(screen.getByRole('button', { name: /Platform Engineer/ }));
}

describe('EmployeeOnboardingPage', () => {
  it('creates a SYSTEM new Person Employee without assignment and redirects', async () => {
    render(<EmployeeOnboardingPage />);
    expect(screen.getByRole('button', { name: 'New person' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Existing person' })).toBeInTheDocument();
    expect(screen.getByLabelText('Employee number (optional)')).toHaveAttribute(
      'placeholder',
      'Leave blank to auto-generate',
    );
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Manager')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Create employee' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('First name is required.');

    fillNewPerson();
    fireEvent.click(screen.getByRole('button', { name: 'Create employee' }));

    await waitFor(() =>
      expect(mocks.create).toHaveBeenCalledWith({
        person: {
          firstName: 'Ada',
          lastName: 'Lovelace',
          personalEmail: 'ada@example.com',
          phone: '555-0100',
        },
        hireDate: '2026-10-02',
      }),
    );
    expect(mocks.create.mock.calls[0]![0]).not.toHaveProperty('employeeNumber');
    expect(mocks.routerPush).toHaveBeenCalledWith('/admin/employees/employee-1');
  });

  it('sends a trimmed custom employee number when provided', async () => {
    render(<EmployeeOnboardingPage />);
    fillNewPerson();
    fireEvent.change(screen.getByLabelText('Employee number (optional)'), {
      target: { value: ' TUT-001 ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create employee' }));

    await waitFor(() =>
      expect(mocks.create).toHaveBeenCalledWith(
        expect.objectContaining({
          employeeNumber: 'TUT-001',
        }),
      ),
    );
  });

  it('creates a SYSTEM Employee with an initial assignment and literal date-only values', async () => {
    render(<EmployeeOnboardingPage />);
    fillNewPerson();
    fireEvent.click(screen.getByLabelText('Create with initial assignment'));
    await selectPosition();
    expect(screen.getByLabelText('Primary assignment')).toBeChecked();
    fireEvent.change(screen.getByLabelText('Employment type'), { target: { value: 'FULL_TIME' } });
    fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '2026-10-02' } });
    fireEvent.change(screen.getByLabelText('End date'), { target: { value: '2026-12-31' } });

    fireEvent.click(screen.getByRole('button', { name: 'Create employee' }));

    await waitFor(() =>
      expect(mocks.create).toHaveBeenCalledWith(
        expect.objectContaining({
          hireDate: '2026-10-02',
          initialPositionId: 'position-1',
          initialEmploymentType: 'FULL_TIME',
          initialStartDate: '2026-10-02',
          initialEndDate: '2026-12-31',
          initialPrimary: true,
        }),
      ),
    );
  });

  it('uses the SYSTEM existing Person picker and disables already-employed people', async () => {
    render(<EmployeeOnboardingPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Existing person' }));
    await waitFor(() => expect(mocks.listPersonOptions).toHaveBeenCalledWith({ limit: 10 }));
    expect(await screen.findByText('ada@example.com')).toBeInTheDocument();
    expect(screen.getByText('Already has an employee record')).toBeInTheDocument();
    expect(screen.queryByText(/login/i)).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Search people'), { target: { value: 'Ada' } });
    await waitFor(
      () => expect(mocks.listPersonOptions).toHaveBeenCalledWith({ search: 'Ada', limit: 10 }),
      { timeout: 1000 },
    );
    fireEvent.click(screen.getByRole('button', { name: /Ada Lovelace/ }));
    fireEvent.change(screen.getByLabelText('Hire date'), { target: { value: '2026-10-02' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create employee' }));

    await waitFor(() =>
      expect(mocks.create).toHaveBeenCalledWith({
        personId: 'person-1',
        hireDate: '2026-10-02',
      }),
    );
    expect(mocks.create.mock.calls[0]![0]).not.toHaveProperty('person');
  });

  it('requires scoped managers to create a new Person with an initial assignment', async () => {
    mocks.useAuth.mockReturnValue({
      authorizationLoading: false,
      authorization: {
        permissions: [{ key: 'employee.manage', scopes: [{ type: 'TEAM', id: 'team-1' }] }],
      },
      can: vi.fn(() => false),
    });

    render(<EmployeeOnboardingPage />);
    expect(screen.queryByRole('button', { name: 'Existing person' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Create with initial assignment')).not.toBeInTheDocument();
    await waitFor(() => expect(mocks.listPositionOptions).toHaveBeenCalledWith({ limit: 10 }));

    fillNewPerson();
    fireEvent.click(screen.getByRole('button', { name: 'Create employee' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Position is required for the initial assignment.',
    );

    await selectPosition();
    fireEvent.change(screen.getByLabelText('Employment type'), { target: { value: 'PART_TIME' } });
    fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '2026-10-03' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create employee' }));

    await waitFor(() =>
      expect(mocks.create).toHaveBeenCalledWith(
        expect.objectContaining({
          initialPositionId: 'position-1',
          initialEmploymentType: 'PART_TIME',
          initialStartDate: '2026-10-03',
          initialPrimary: true,
        }),
      ),
    );
  });

  it('surfaces validation, forbidden, conflict, and service errors', async () => {
    for (const [error, message] of [
      [
        new AuthApiError('validation', 400, 'firstName must not be empty'),
        'firstName must not be empty',
      ],
      [new AuthApiError('forbidden', 403), 'You do not have permission to manage employees.'],
      [
        new AuthApiError('conflict', 409, 'Person is already an employee.'),
        'Person is already an employee.',
      ],
      [
        new AuthApiError('conflict', 409, 'Employee number is already in use.'),
        'Employee number is already in use.',
      ],
      [
        new AuthApiError('service-unavailable', 500),
        'The Employee service is unavailable. Please try again.',
      ],
    ] as const) {
      mocks.create.mockRejectedValueOnce(error);
      const { unmount } = render(<EmployeeOnboardingPage />);
      fillNewPerson();
      fireEvent.click(screen.getByRole('button', { name: 'Create employee' }));
      expect(await screen.findByRole('alert')).toHaveTextContent(message);
      unmount();
      cleanup();
    }
  });

  it('loads more option pages', async () => {
    mocks.listPositionOptions
      .mockResolvedValueOnce({ items: [position], nextAfterId: 'position-1' })
      .mockResolvedValueOnce({
        items: [{ ...position, id: 'position-2', name: 'Support Lead' }],
        nextAfterId: null,
      });
    render(<EmployeeOnboardingPage />);
    fireEvent.click(screen.getByLabelText('Create with initial assignment'));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Load more positions' })).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Load more positions' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Support Lead/ })).toBeInTheDocument(),
    );
    expect(mocks.listPositionOptions).toHaveBeenNthCalledWith(2, {
      limit: 10,
      afterId: 'position-1',
    });
  });
});
