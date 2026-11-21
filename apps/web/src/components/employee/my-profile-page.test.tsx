import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthApiError } from '../../lib/auth/types';
import { MyProfilePage } from './my-profile-page';

const mocks = vi.hoisted(() => ({ me: vi.fn() }));
vi.mock('../../lib/employee/api', () => ({ employeeApi: mocks }));

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
});
afterEach(cleanup);

const assignment = {
  id: 'a1',
  employmentType: 'PART_TIME',
  status: 'ACTIVE',
  startDate: '2026-01-05',
  endDate: null,
  isPrimary: true,
  position: { id: 'p1', name: 'Lifeguard', code: 'LG' },
  jobTitle: { id: 'j1', name: 'Lifeguard I', code: 'LG1' },
  organization: { id: 'o1', name: 'Aquatics', code: 'AQ' },
  placement: null,
  workLocation: { id: 'w1', name: 'Main pool', code: 'MP' },
  manager: { displayName: 'Grace Hopper', positionName: 'Head of Aquatics' },
};

describe('MyProfilePage', () => {
  it('shows one’s own record read-only, without edit controls', async () => {
    mocks.me.mockResolvedValue({
      id: 'e1',
      employeeNumber: 'EMP-7',
      status: 'ACTIVE',
      hireDate: '2026-01-05',
      terminationDate: null,
      person: {
        firstName: 'Ada',
        middleName: null,
        lastName: 'Lovelace',
        preferredName: null,
        personalEmail: 'ada@example.com',
        phone: null,
      },
      assignments: { current: [assignment], upcoming: [], historical: [] },
    });
    render(<MyProfilePage />);

    expect(await screen.findByRole('heading', { name: 'Ada Lovelace' })).toBeInTheDocument();
    expect(screen.getByText('EMP-7')).toBeInTheDocument();
    expect(screen.getByText('ada@example.com')).toBeInTheDocument();
    expect(screen.getByText('Lifeguard I')).toBeInTheDocument();
    expect(screen.getByText('Grace Hopper (Head of Aquatics)')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(mocks.me).toHaveBeenCalledWith();
  });

  it('explains an account without an employee record', async () => {
    mocks.me.mockRejectedValue(new AuthApiError('unexpected', 404));
    render(<MyProfilePage />);
    expect(await screen.findByText(/not linked to an employee record/)).toBeInTheDocument();
  });
});
