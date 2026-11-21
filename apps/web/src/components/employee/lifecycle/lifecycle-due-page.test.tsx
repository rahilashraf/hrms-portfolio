import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthApiError } from '../../../lib/auth/types';
import type { LifecycleDue } from '../../../lib/employee/types';
import { expectNoAxeViolations } from '../../../test/axe';
import { LifecycleDuePage } from './lifecycle-due-page';

const mocks = vi.hoisted(() => ({
  lifecycleDue: vi.fn(),
  applyAssignmentEnd: vi.fn(),
  workspace: { current: {} as Record<string, unknown> },
  permissions: { current: ['employee.manage'] as string[] },
}));
vi.mock('../../../lib/employee/api', () => ({
  employeeApi: {
    lifecycleDue: mocks.lifecycleDue,
    applyAssignmentEnd: mocks.applyAssignmentEnd,
  },
}));
vi.mock('../../../providers/workspace-provider', () => ({
  useWorkspace: () => mocks.workspace.current,
}));
vi.mock('../../../providers/auth-provider', () => ({
  useAuth: () => ({
    authorizationLoading: false,
    authorization: {
      userId: 'hr-1',
      permissions: mocks.permissions.current.map((key) => ({
        key,
        scopes: [{ type: 'ORGANIZATION', id: 'org-a' }],
      })),
    },
  }),
}));
// The impact preview has its own tests; here it only shows which end it previews.
vi.mock('./assignment-impact-preview', () => ({
  AssignmentImpactPreview: ({
    assignmentId,
    endDate,
  }: {
    assignmentId: string;
    endDate: string;
  }) => (
    <p>
      Impact of ending {assignmentId} on {endDate}
    </p>
  ),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const organization = (id: string, name: string, permissions: string[]) => ({
  id,
  name,
  code: id,
  timezone: 'America/Toronto',
  branding: null,
  enabledModules: [],
  permissions,
  isEmployee: false,
  isManager: false,
});

const row = {
  employeeNumber: 'EMP-000002',
  employeeName: 'Grace Hopper',
  positionName: 'Org Associate',
  timezone: 'America/Toronto',
  organizationId: 'org-a',
  organizationName: 'Northwind Academy',
  employmentType: 'PART_TIME' as const,
  isPrimary: false,
  startDate: '2026-01-01',
  localToday: '2026-11-04',
};

function due(overrides: Partial<LifecycleDue> = {}): LifecycleDue {
  return {
    organizationId: 'org-a',
    terminations: [
      {
        terminationId: 'term-9',
        employeeId: 'emp-9',
        employeeNumber: 'EMP-000009',
        employeeName: 'Alan Turing',
        terminationDate: '2026-10-31',
      },
    ],
    assignmentEnds: [
      {
        ...row,
        employmentAssignmentId: 'asg-overdue',
        employeeId: 'emp-2',
        endDate: '2026-11-01',
        daysOverdue: 3,
      },
    ],
    upcomingAssignmentEnds: [
      {
        ...row,
        employmentAssignmentId: 'asg-soon',
        employeeId: 'emp-2',
        positionName: 'Team A Associate',
        endDate: '2026-11-10',
        daysUntilEnd: 6,
        scheduledTerminationId: null,
      },
      {
        ...row,
        employmentAssignmentId: 'asg-term',
        employeeId: 'emp-1',
        employeeName: 'Ada Lovelace',
        employeeNumber: 'EMP-000001',
        endDate: '2026-11-20',
        daysUntilEnd: 16,
        scheduledTerminationId: 'term-1',
      },
    ],
    upcomingDays: 30,
    truncated: false,
    limit: 500,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.permissions.current = ['employee.manage'];
  mocks.workspace.current = {
    organizations: [
      organization('org-a', 'Northwind Academy', ['employee.manage', 'employee.read']),
      organization('org-r', 'Read Only School', ['employee.read']),
      organization('org-b', 'Second Campus', ['employee.manage']),
    ],
    selectedOrganization: organization('org-a', 'Northwind Academy', ['employee.manage']),
  };
  mocks.lifecycleDue.mockResolvedValue(due());
  mocks.applyAssignmentEnd.mockResolvedValue({ id: 'asg-overdue', status: 'ENDED' });
});
afterEach(cleanup);

describe('LifecycleDuePage (R4-A.1)', () => {
  it('lists overdue and upcoming ends separately, for organizations the user manages', async () => {
    render(<LifecycleDuePage />);
    const overdue = await screen.findByRole('table', { name: 'Assignments past their end date' });
    expect(mocks.lifecycleDue).toHaveBeenCalledWith('org-a', 30);
    expect(within(overdue).getByText('Grace Hopper')).toBeInTheDocument();
    expect(within(overdue).getByText('3 days')).toBeInTheDocument();
    expect(within(overdue).getByText(/Last working day · America\/Toronto/)).toBeInTheDocument();

    const soon = screen.getByRole('table', { name: 'Assignments ending soon' });
    expect(within(soon).getByText('6 days')).toBeInTheDocument();
    // Only the organizations where the user manages employees are offered.
    const select = screen.getByLabelText('Organization');
    expect(
      within(select)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Northwind Academy', 'Second Campus']);
    // Due terminations go to the termination workflow on the profile.
    expect(screen.getByRole('link', { name: /Open termination for Alan Turing/ })).toHaveAttribute(
      'href',
      '/admin/employees/emp-9',
    );
  });

  it('links an end that belongs to a scheduled termination there, with no apply action', async () => {
    render(<LifecycleDuePage />);
    const soon = await screen.findByRole('table', { name: 'Assignments ending soon' });
    const termRow = within(soon).getByRole('row', { name: /Ada Lovelace/ });
    expect(within(termRow).getByText('Ends with scheduled termination')).toBeInTheDocument();
    expect(
      within(termRow).getByRole('link', { name: /Open termination for Ada Lovelace/ }),
    ).toHaveAttribute('href', '/admin/employees/emp-1');
    // Nothing in the upcoming list can be applied.
    expect(within(soon).queryByRole('button')).not.toBeInTheDocument();
  });

  it('reloads with the chosen window and organization', async () => {
    render(<LifecycleDuePage />);
    await screen.findByRole('table', { name: 'Assignments ending soon' });
    fireEvent.change(screen.getByLabelText('Show assignments ending within'), {
      target: { value: '90' },
    });
    await waitFor(() => expect(mocks.lifecycleDue).toHaveBeenLastCalledWith('org-a', 90));
    fireEvent.change(screen.getByLabelText('Organization'), { target: { value: 'org-b' } });
    await waitFor(() => expect(mocks.lifecycleDue).toHaveBeenLastCalledWith('org-b', 90));
  });

  it('shows the assignment and its impact before applying, applies only that end, then refreshes', async () => {
    render(<LifecycleDuePage />);
    fireEvent.click(
      await screen.findByRole('button', {
        name: /Review and apply end for Grace Hopper, Org Associate/,
      }),
    );
    const dialog = screen.getByRole('alertdialog', { name: 'Apply this assignment end?' });
    expect(dialog).toHaveTextContent('the employee stays employed');
    expect(dialog).toHaveTextContent('Impact of ending asg-overdue on 2026-11-01');
    // The safe choice has focus; cancelling changes nothing.
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(mocks.applyAssignmentEnd).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /Review and apply end for Grace Hopper/ }));
    mocks.lifecycleDue.mockResolvedValueOnce(due({ assignmentEnds: [] }));
    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Apply end' }),
    );
    await waitFor(() =>
      expect(mocks.applyAssignmentEnd).toHaveBeenCalledWith('emp-2', 'asg-overdue'),
    );
    expect(mocks.applyAssignmentEnd).toHaveBeenCalledTimes(1);
    expect(
      await screen.findByText(
        /has ended\. The employee’s employment and other assignments are unchanged/,
      ),
    ).toBeInTheDocument();
    expect(await screen.findByText('No assignment is past its end date.')).toBeInTheDocument();
    expect(mocks.lifecycleDue).toHaveBeenCalledTimes(2);
  });

  it('keeps the dialog open with the API refusal', async () => {
    mocks.applyAssignmentEnd.mockRejectedValue(
      new AuthApiError(
        'conflict',
        409,
        'This assignment ends with a scheduled termination; apply the termination instead.',
        {},
      ),
    );
    render(<LifecycleDuePage />);
    fireEvent.click(await screen.findByRole('button', { name: /Review and apply end/ }));
    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Apply end' }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(/apply the termination instead/);
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });

  it('shows empty states and the load error', async () => {
    mocks.lifecycleDue.mockResolvedValueOnce(
      due({ terminations: [], assignmentEnds: [], upcomingAssignmentEnds: [] }),
    );
    render(<LifecycleDuePage />);
    expect(await screen.findByText('No assignment is past its end date.')).toBeInTheDocument();
    expect(screen.getByText('No assignment ends in the next 30 days.')).toBeInTheDocument();
    expect(screen.getByText('No scheduled termination is due.')).toBeInTheDocument();
    cleanup();
    mocks.lifecycleDue.mockRejectedValueOnce(new AuthApiError('unexpected', 500, 'Down', {}));
    render(<LifecycleDuePage />);
    expect(await screen.findByText(/Down|Unable to load lifecycle changes/)).toBeInTheDocument();
  });

  it('is denied without employee.manage and has no axe violations', async () => {
    const { container } = render(<LifecycleDuePage />);
    await screen.findByRole('table', { name: 'Assignments ending soon' });
    await expectNoAxeViolations(container);
    cleanup();
    mocks.permissions.current = ['employee.read'];
    render(<LifecycleDuePage />);
    expect(
      screen.getByText('You do not have permission to manage employee lifecycle changes.'),
    ).toBeInTheDocument();
    expect(mocks.lifecycleDue).toHaveBeenCalledTimes(1);
  });
});
