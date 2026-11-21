import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { expectNoAxeViolations } from '../../test/axe';
import { AssignmentIdPicker } from './assignment-id-picker';

const mocks = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn() }));
vi.mock('../../lib/employee/api', () => ({ employeeApi: mocks }));

const assignment = (id: string, organizationId: string, position: string) => ({
  id,
  status: 'ACTIVE',
  isPrimary: id === 'asg-1',
  startDate: '2026-01-01',
  position: { id: `pos-${id}`, name: position },
  organization: { id: organizationId, name: organizationId === 'org-1' ? 'Northwind' : 'Other' },
});

function Harness() {
  const [value, setValue] = useState('');
  return (
    <>
      <AssignmentIdPicker
        label="Employment"
        organizationId="org-1"
        required
        value={value}
        onChange={setValue}
      />
      <output aria-label="Value">{value || 'none'}</output>
    </>
  );
}

afterEach(cleanup);

describe('AssignmentIdPicker', () => {
  it('finds the employee, then offers only their assignments in the organization', async () => {
    mocks.list.mockResolvedValue({
      items: [
        {
          id: 'emp-1',
          employeeNumber: 'E-1',
          status: 'ACTIVE',
          person: { firstName: 'Ada', lastName: 'Lovelace', middleName: null, preferredName: null },
          displayAssignment: null,
        },
      ],
      nextAfterId: null,
    });
    mocks.get.mockResolvedValue({
      assignments: {
        current: [assignment('asg-1', 'org-1', 'Analyst'), assignment('asg-2', 'org-2', 'Coach')],
        upcoming: [],
      },
    });
    const { container } = render(<Harness />);
    const search = screen.getByRole('combobox', { name: /^Employment — employee/ });
    fireEvent.change(search, { target: { value: 'ada' } });
    fireEvent.click(await screen.findByRole('option', { name: /Ada Lovelace/ }));
    await waitFor(() =>
      expect(mocks.list).toHaveBeenCalledWith(
        expect.objectContaining({ search: 'ada', organizationId: 'org-1', status: 'ACTIVE' }),
      ),
    );
    const select = await screen.findByLabelText('Employment — assignment');
    await waitFor(() => expect(within(select).getAllByRole('option')).toHaveLength(3));
    expect(within(select).getByRole('option', { name: /Coach · Other/ })).toBeDisabled();
    fireEvent.change(select, { target: { value: 'asg-1' } });
    expect(screen.getByLabelText('Value')).toHaveTextContent('asg-1');
    await expectNoAxeViolations(container);
  });

  it('accepts a typed assignment ID instead', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Enter an assignment ID instead' }));
    fireEvent.change(screen.getByLabelText(/^Employment \(assignment ID\)/), {
      target: { value: ' asg-9 ' },
    });
    expect(screen.getByLabelText('Value')).toHaveTextContent('asg-9');
    fireEvent.click(screen.getByRole('button', { name: 'Search employees instead' }));
    expect(screen.getByLabelText('Value')).toHaveTextContent('none');
  });
});
