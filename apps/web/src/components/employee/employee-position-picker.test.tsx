import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EmployeePositionPicker } from './employee-position-picker';

const mocks = vi.hoisted(() => ({ listPositionOptions: vi.fn() }));
vi.mock('../../lib/employee/api', () => ({
  employeeApi: { listPositionOptions: mocks.listPositionOptions },
}));

const position = {
  id: 'position-1',
  name: 'Platform Engineer',
  code: 'PE-1',
  jobTitle: { id: 'job-1', name: 'Engineer', code: 'ENG' },
  organization: { id: 'org-1', name: 'Acme', code: 'ACME' },
  placement: { type: 'TEAM' as const, id: 'team-1', name: 'Platform', code: 'PLAT' },
  workLocation: { id: 'location-1', name: 'HQ', code: 'HQ' },
};

describe('EmployeePositionPicker', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    mocks.listPositionOptions.mockResolvedValue({ items: [position], nextAfterId: null });
  });

  afterEach(cleanup);

  it('loads manageable positions, searches backend, and emits selected values', async () => {
    const onSelect = vi.fn();
    render(<EmployeePositionPicker selected={null} onSelect={onSelect} />);

    await waitFor(() => expect(mocks.listPositionOptions).toHaveBeenCalledWith({ limit: 10 }));
    expect(screen.getByText('Platform Engineer')).toBeInTheDocument();
    expect(screen.getByText('Engineer · Acme')).toBeInTheDocument();
    expect(screen.getByText('Team: Platform · HQ')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Search positions'), { target: { value: 'Engineer' } });
    await waitFor(
      () =>
        expect(mocks.listPositionOptions).toHaveBeenCalledWith({ search: 'Engineer', limit: 10 }),
      { timeout: 1000 },
    );

    fireEvent.click(screen.getByRole('button', { name: /Platform Engineer/ }));
    expect(onSelect).toHaveBeenCalledWith(position);
  });

  it('loads more pages and shows an empty manageable Position state', async () => {
    mocks.listPositionOptions
      .mockResolvedValueOnce({ items: [position], nextAfterId: 'position-1' })
      .mockResolvedValueOnce({
        items: [{ ...position, id: 'position-2', name: 'Support Lead' }],
        nextAfterId: null,
      });
    render(<EmployeePositionPicker selected={position} onSelect={vi.fn()} />);

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Load more positions' })).toBeInTheDocument(),
    );
    expect(screen.getByText('Selected')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Load more positions' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Support Lead/ })).toBeInTheDocument(),
    );
    expect(mocks.listPositionOptions).toHaveBeenNthCalledWith(2, {
      limit: 10,
      afterId: 'position-1',
    });

    cleanup();
    mocks.listPositionOptions.mockResolvedValue({ items: [], nextAfterId: null });
    render(<EmployeePositionPicker selected={null} onSelect={vi.fn()} />);
    expect(
      await screen.findByText('No manageable positions are currently available.'),
    ).toBeInTheDocument();
  });
});
