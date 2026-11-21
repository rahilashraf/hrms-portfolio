import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthApiError } from '../../../lib/auth/types';
import type {
  AssignmentImpact,
  EmployeeAssignmentView,
  EmployeeProfile,
} from '../../../lib/employee/types';
import { AccessReviewSection } from './access-review';
import { AssignmentImpactPreview, AssignmentImpactView } from './assignment-impact-preview';
import { StatusChangeDialog } from './status-change';
import { TransferDialog, transferSummary, validateTransfer } from './transfer';
import { validateRehire } from './rehire';

const mocks = vi.hoisted(() => ({
  assignmentImpact: vi.fn(),
  accessReview: vi.fn(),
  revokeGrants: vi.fn(),
  inactivate: vi.fn(),
  reactivate: vi.fn(),
  transferAssignment: vi.fn(),
  listPositionOptions: vi.fn(),
  listManagerAssignmentOptions: vi.fn(),
}));
vi.mock('../../../lib/employee/api', () => ({ employeeApi: mocks }));

const list = <T,>(items: T[], total = items.length, limit = 50) => ({
  total,
  items,
  truncated: total > items.length,
  limit,
});

function impact(overrides: Partial<AssignmentImpact> = {}): AssignmentImpact {
  return {
    employeeId: 'employee-1',
    employmentAssignmentId: 'assignment-1',
    organizationId: 'org-1',
    timezone: 'Asia/Kolkata',
    endDate: '2026-11-30',
    blocked: false,
    blockers: [],
    attendance: { openTimeEntries: list([]) },
    scheduling: {
      futurePublishedShifts: list(
        Array.from({ length: 50 }, (_, i) => ({ id: `s${i}`, workDate: '2026-12-01' })),
        120,
      ),
    },
    leave: { pending: list([]), approvedAfterEnd: list([]) },
    compensation: { recordsBeyondEnd: list([]) },
    payroll: { openPayrollRuns: 0 },
    benefits: { enrollmentsBeyondEnd: list([]) },
    managerRelationships: {
      visibleDirectReports: [],
      visibleDirectReportCount: 0,
      truncated: false,
      limit: 200,
    },
    employment: {
      otherCurrentAssignments: [],
      remainsEmployedInOrganization: null,
      endsLastCurrentEmployment: null,
    },
    access: { loginStatus: 'ACTIVE', grantsInOrganization: 2, changesAccess: false },
    offboarding: {
      employeeId: 'employee-1',
      employmentAssignmentId: 'assignment-1',
      plannedEndDate: '2026-11-30',
      defaultTemplate: { id: '11111111-1111-4111-8111-111111111111', name: 'Standard exit' },
      openWorkflowId: null,
    },
    ...overrides,
  };
}

const assignment: EmployeeAssignmentView = {
  id: 'assignment-1',
  employmentType: 'FULL_TIME',
  status: 'ACTIVE',
  startDate: '2026-01-01',
  endDate: null,
  isPrimary: true,
  position: { id: 'position-1', name: 'Platform Engineer', code: 'PE-1' },
  jobTitle: { id: 'job-1', name: 'Engineer', code: 'ENG' },
  organization: { id: 'org-1', name: 'Acme', code: 'ACME' },
  placement: null,
  workLocation: null,
  manager: {
    assignmentId: 'manager-1',
    employeeId: 'manager-employee',
    employeeNumber: 'EMP-2',
    displayName: 'Grace Hopper',
    positionName: 'Engineering Manager',
  },
};

const profile: EmployeeProfile = {
  id: 'employee-1',
  employeeNumber: 'EMP-1',
  status: 'TERMINATED',
  hireDate: '2026-01-01',
  terminationDate: '2026-10-31',
  person: {
    firstName: 'Ada',
    middleName: null,
    lastName: 'Lovelace',
    preferredName: null,
    personalEmail: null,
    phone: null,
  },
  assignments: { current: [], upcoming: [], historical: [assignment], cancelled: [] },
};

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
});
afterEach(() => cleanup());

describe('AssignmentImpactView', () => {
  it('shows exact totals, capped lists and empty sections, and lists hidden sections without inferring them', () => {
    render(
      <AssignmentImpactView
        impact={impact({ compensation: null, payroll: null, benefits: null, access: null })}
      />,
    );
    expect(screen.getByText('No open time entries.')).toBeInTheDocument();
    expect(screen.getByText('120 published shifts after the last day')).toBeInTheDocument();
    expect(screen.getByText(/showing the first 50 of 120/)).toBeInTheDocument();
    expect(
      screen.getByText(/Not shown with your access: compensation, payroll, benefits, access/),
    ).toBeInTheDocument();
    // A hidden section is never presented as empty.
    expect(screen.queryByText(/compensation record/)).not.toBeInTheDocument();
    expect(screen.queryByText(/payroll run/)).not.toBeInTheDocument();
    // Withheld conclusions are not drawn.
    expect(screen.queryByText(/no other employment in this organization/)).not.toBeInTheDocument();
    expect(screen.queryByText(/last current assignment/)).not.toBeInTheDocument();
  });

  it('lists blockers it may see, and says when blockers exist that it may not see', () => {
    const { rerender } = render(
      <AssignmentImpactView
        impact={impact({
          blocked: true,
          blockers: [
            {
              kind: 'APPROVED_TIMESHEET',
              employmentAssignmentId: 'assignment-1',
              periodStart: '2026-11-16',
              periodEnd: '2026-11-29',
            },
          ],
        })}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(
      /Approved timesheet: Nov 16, 2026 – Nov 29, 2026/,
    );
    rerender(<AssignmentImpactView impact={impact({ blocked: true, blockers: [] })} />);
    expect(screen.getByRole('alert')).toHaveTextContent(/You do not have access to see which ones/);
  });

  it('suggests termination for the last assignment and links offboarding without starting it', () => {
    const { rerender } = render(
      <AssignmentImpactView
        impact={impact({
          employment: {
            otherCurrentAssignments: [],
            remainsEmployedInOrganization: false,
            endsLastCurrentEmployment: true,
          },
        })}
      />,
    );
    expect(screen.getByText(/last current assignment/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Review offboarding' })).toHaveAttribute(
      'href',
      '/admin/onboarding?offboardEmployee=employee-1&offboardOrganization=org-1&offboardAssignment=assignment-1&offboardTemplate=11111111-1111-4111-8111-111111111111&offboardEndDate=2026-11-30#start',
    );
    expect(screen.getByText(/never starts automatically/)).toBeInTheDocument();
    rerender(
      <AssignmentImpactView
        impact={impact({
          offboarding: { ...impact().offboarding!, openWorkflowId: 'workflow-9' },
        })}
      />,
    );
    expect(screen.getByRole('link', { name: 'Open the workflow' })).toHaveAttribute(
      'href',
      '/onboarding/workflows/workflow-9',
    );
    expect(screen.queryByRole('link', { name: 'Review offboarding' })).not.toBeInTheDocument();
  });
});

describe('AssignmentImpactPreview', () => {
  it('loads, reports errors with retry, and asks for a date first', async () => {
    const { rerender } = render(
      <AssignmentImpactPreview employeeId="employee-1" assignmentId="assignment-1" endDate="" />,
    );
    expect(screen.getByText(/Choose a date/)).toBeInTheDocument();
    expect(mocks.assignmentImpact).not.toHaveBeenCalled();
    mocks.assignmentImpact
      .mockRejectedValueOnce(new AuthApiError('unexpected', 503))
      .mockResolvedValueOnce(impact());
    rerender(
      <AssignmentImpactPreview
        employeeId="employee-1"
        assignmentId="assignment-1"
        endDate="2026-11-30"
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent(/Checking what this change would affect/);
    const error = await screen.findByRole('alert');
    expect(error).toHaveTextContent('Impact preview unavailable');
    fireEvent.click(within(error).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText(/Impact of ending on Nov 30, 2026/)).toBeInTheDocument();
    expect(mocks.assignmentImpact).toHaveBeenLastCalledWith(
      'employee-1',
      'assignment-1',
      '2026-11-30',
    );
  });
});

describe('AccessReviewSection', () => {
  const review = {
    employeeId: 'employee-1',
    employeeStatus: 'TERMINATED',
    access: {
      userId: 'user-1',
      loginStatus: 'ACTIVE',
      activeSessions: 0,
      grants: [
        {
          roleAssignmentId: 'grant-1',
          roleName: 'HR Admin',
          scopeType: 'ORGANIZATION',
          organizationId: 'org-1',
          organizationName: 'Acme',
          relation: 'ENDED_EMPLOYMENT',
          revocable: true,
        },
        {
          roleAssignmentId: 'grant-2',
          roleName: 'Reader',
          scopeType: 'ORGANIZATION',
          organizationId: 'org-2',
          organizationName: 'Beta',
          relation: 'NO_EMPLOYMENT',
          revocable: false,
        },
      ],
      hiddenGrants: 3,
      systemGrants: 0,
      hasEffectiveAuthorization: true,
    },
  };

  it('separates employment from login, warns about shared and cross-organization access, and never revokes without confirmation', async () => {
    mocks.accessReview.mockResolvedValue(review);
    mocks.revokeGrants.mockResolvedValue({
      employeeId: 'employee-1',
      revoked: ['grant-1'],
      loginDisabled: true,
    });
    render(<AccessReviewSection profile={profile} />);
    expect(await screen.findByText('HR Admin')).toBeInTheDocument();
    expect(screen.getByText('Terminated')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(
      screen.getByText(/login is still active because role grants remain/),
    ).toBeInTheDocument();
    expect(screen.getByText(/shared by all of the person/)).toBeInTheDocument();
    expect(screen.getByText(/span more than one organization/)).toBeInTheDocument();
    expect(screen.getByText(/3 more grants outside your access are not shown/)).toBeInTheDocument();
    expect(screen.getByText('Ended employment')).toBeInTheDocument();
    // Only revocable grants can be selected.
    expect(screen.getAllByRole('checkbox')).toHaveLength(1);
    expect(mocks.revokeGrants).not.toHaveBeenCalled();
    const revoke = screen.getByRole('button', { name: 'Revoke selected (0)' });
    expect(revoke).toBeDisabled();
    fireEvent.click(screen.getByLabelText('HR Admin'));
    fireEvent.click(screen.getByRole('button', { name: 'Revoke selected (1)' }));
    const dialog = screen.getByRole('dialog', { name: 'Revoke 1 grant?' });
    expect(dialog).toHaveTextContent(/login is disabled/);
    expect(mocks.revokeGrants).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Revoke grants' }));
    await waitFor(() =>
      expect(mocks.revokeGrants).toHaveBeenCalledWith('employee-1', {
        roleAssignmentIds: ['grant-1'],
      }),
    );
    expect(await screen.findByText(/the login was disabled/)).toBeInTheDocument();
  });

  it('reports a missing login and load errors', async () => {
    mocks.accessReview
      .mockRejectedValueOnce(new AuthApiError('forbidden', 404))
      .mockResolvedValueOnce({ ...review, access: null });
    render(<AccessReviewSection profile={profile} />);
    const error = await screen.findByRole('alert');
    fireEvent.click(within(error).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('This employee has no login.')).toBeInTheDocument();
  });
});

describe('AccessReviewSection (Batch 5E)', () => {
  const grant = (id: string, overrides: Record<string, unknown> = {}) => ({
    roleAssignmentId: id,
    roleName: `Role ${id}`,
    scopeType: 'ORGANIZATION',
    organizationId: 'org-1',
    organizationName: 'Acme',
    relation: 'ENDED_EMPLOYMENT',
    revocable: true,
    inactiveReason: null,
    ...overrides,
  });
  const reviewOf = (grants: unknown[], overrides: Record<string, unknown> = {}) => ({
    employeeId: 'employee-1',
    employeeStatus: 'TERMINATED',
    access: {
      userId: 'user-1',
      loginStatus: 'ACTIVE',
      activeSessions: 0,
      grants,
      hiddenGrants: 0,
      systemGrants: 0,
      hasEffectiveAuthorization: true,
      ...overrides,
    },
  });
  const other = { userId: 'admin-1', systemEmployeeManage: false };

  it('reports what this request revoked apart from what someone else revoked first', async () => {
    mocks.accessReview.mockResolvedValue(reviewOf([grant('g1'), grant('g2')]));
    mocks.revokeGrants.mockResolvedValue({
      employeeId: 'employee-1',
      revoked: ['g1'],
      alreadyRevoked: ['g2'],
      loginDisabled: false,
    });
    render(<AccessReviewSection profile={profile} viewer={other} />);
    fireEvent.click(await screen.findByLabelText('Role g1'));
    fireEvent.click(screen.getByLabelText('Role g2'));
    fireEvent.click(screen.getByRole('button', { name: 'Revoke selected (2)' }));
    const dialog = screen.getByRole('dialog', { name: 'Revoke 2 grants?' });
    expect(dialog).toHaveTextContent(/if any cannot be revoked, none is/);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Revoke grants' }));
    const status = await screen.findByText(/1 grant revoked\./);
    expect(status).toHaveTextContent(
      '1 selected grant had already been revoked (by someone else, or a moment earlier) and was left as it was.',
    );
    expect(status).not.toHaveTextContent(/2 grants revoked/);
  });

  it("on one's own record without the System override: no revoke controls, an explanation, no request", async () => {
    mocks.accessReview.mockResolvedValue(reviewOf([grant('g1'), grant('g2')]));
    render(
      <AccessReviewSection
        profile={profile}
        viewer={{ userId: 'user-1', systemEmployeeManage: false }}
      />,
    );
    expect(await screen.findByText('Role g1')).toBeInTheDocument();
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: /Revoke selected/ })).not.toBeInTheDocument();
    expect(
      screen.getByText(
        /This is your own employment record\. You cannot revoke its grants yourself/,
      ),
    ).toBeInTheDocument();
    expect(mocks.revokeGrants).not.toHaveBeenCalled();
  });

  it("on one's own record with the System override: controls stay, and the override is announced", async () => {
    mocks.accessReview.mockResolvedValue(reviewOf([grant('g1')]));
    render(
      <AccessReviewSection
        profile={profile}
        viewer={{ userId: 'user-1', systemEmployeeManage: true }}
      />,
    );
    fireEvent.click(await screen.findByLabelText('Role g1'));
    expect(screen.getByText(/uses your System-level override/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Revoke selected (1)' }));
    expect(screen.getByRole('dialog', { name: 'Revoke 1 grant?' })).toHaveTextContent(
      /your System-level override is recorded/,
    );
  });

  it('marks inactive grants, keeps them revocable as clean-up and never counts them as access', async () => {
    mocks.accessReview.mockResolvedValue(
      reviewOf(
        [
          grant('g1', {
            organizationId: 'org-9',
            organizationName: 'Archived Co',
            inactiveReason: 'ORGANIZATION_ARCHIVED',
          }),
          grant('g2', { inactiveReason: 'ROLE_ARCHIVED' }),
        ],
        { hasEffectiveAuthorization: false },
      ),
    );
    render(<AccessReviewSection profile={profile} viewer={other} />);
    expect(await screen.findByText('Inactive: organization archived')).toBeInTheDocument();
    expect(screen.getByText('Inactive: role archived')).toBeInTheDocument();
    // Still revocable (clean-up).
    expect(screen.getAllByRole('checkbox')).toHaveLength(2);
    // Not counted as access: no cross-organization warning, and the login note says the
    // remaining grants authorize nothing.
    expect(screen.queryByText(/span more than one organization/)).not.toBeInTheDocument();
    expect(screen.queryByText(/because role grants remain/)).not.toBeInTheDocument();
    expect(screen.getByText(/remaining grants authorize nothing/)).toBeInTheDocument();
  });

  it('explains a refused revocation in the dialog, and that nothing was revoked', async () => {
    mocks.accessReview.mockResolvedValue(reviewOf([grant('g1')]));
    mocks.revokeGrants.mockRejectedValue(
      new AuthApiError('forbidden', 403, undefined, {
        code: 'LIFECYCLE_SELF_TARGET',
        action: 'REVOKE_GRANTS',
      }),
    );
    render(<AccessReviewSection profile={profile} />);
    fireEvent.click(await screen.findByLabelText('Role g1'));
    fireEvent.click(screen.getByRole('button', { name: 'Revoke selected (1)' }));
    const dialog = screen.getByRole('dialog', { name: 'Revoke 1 grant?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Revoke grants' }));
    expect(
      await within(dialog).findByText(
        'You cannot revoke grants on your own employment record. Ask another administrator. Nothing was revoked.',
      ),
    ).toBeInTheDocument();
  });
});

describe('StatusChangeDialog', () => {
  it('requires a reason to mark inactive and explains what changes', async () => {
    mocks.inactivate.mockResolvedValue({ employeeId: 'employee-1', status: 'INACTIVE' });
    const onDone = vi.fn();
    render(
      <StatusChangeDialog
        open
        profile={{ ...profile, status: 'ACTIVE', terminationDate: null }}
        mode="inactivate"
        onClose={vi.fn()}
        onDone={onDone}
      />,
    );
    const dialog = screen.getByRole('dialog', { name: 'Mark employee inactive' });
    expect(dialog).toHaveTextContent(/cannot record time/);
    expect(dialog).toHaveTextContent(/login and role grants are not changed/);
    fireEvent.click(screen.getByRole('button', { name: 'Mark inactive' }));
    expect(
      await screen.findByText('Enter the reason for the inactive status.'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/^Reason/)).toHaveAttribute('aria-invalid', 'true');
    expect(mocks.inactivate).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText(/^Reason/), { target: { value: ' Parental leave ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Mark inactive' }));
    await waitFor(() =>
      expect(mocks.inactivate).toHaveBeenCalledWith('employee-1', 'Parental leave'),
    );
    expect(onDone).toHaveBeenCalled();
  });
});

describe('TransferDialog', () => {
  const position = {
    id: 'position-2',
    name: 'Support Lead',
    code: 'SL-1',
    jobTitle: { id: 'job-2', name: 'Lead', code: 'LEAD' },
    organization: { id: 'org-1', name: 'Acme', code: 'ACME' },
    placement: null,
    workLocation: null,
  };

  it('validates dates, previews the impact of the day before, requires review, and sends the transfer', async () => {
    mocks.listPositionOptions.mockResolvedValue({ items: [position], nextAfterId: null });
    mocks.assignmentImpact.mockResolvedValue(impact({ endDate: '2026-11-30' }));
    mocks.transferAssignment
      .mockRejectedValueOnce(
        new AuthApiError('conflict', 409, 'changed', { code: 'TRANSFER_SOURCE_CHANGED' }),
      )
      .mockResolvedValueOnce({
        replayed: false,
        sourceAssignment: { id: 'assignment-1', endDate: '2026-11-30', status: 'ACTIVE' },
        destinationAssignment: {
          id: 'new',
          positionId: 'position-2',
          startDate: '2026-12-01',
          endDate: null,
          status: 'PLANNED',
          isPrimary: true,
        },
        compensationRequired: true,
        sourceHadCompensation: true,
        primaryCarried: true,
        manager: { managerAssignmentId: 'manager-1', carried: true, droppedReason: null },
      });
    const onDone = vi.fn();
    render(
      <TransferDialog
        open
        profile={{ ...profile, status: 'ACTIVE', terminationDate: null }}
        assignment={assignment}
        onClose={vi.fn()}
        onDone={onDone}
      />,
    );
    const dialog = screen.getByRole('dialog', { name: 'Transfer from Platform Engineer' });
    expect(dialog).toHaveTextContent(/Compensation is not copied/);
    fireEvent.click(await screen.findByRole('button', { name: /Support Lead/ }));
    fireEvent.change(screen.getByLabelText('First day in the new position'), {
      target: { value: '2026-12-01' },
    });
    expect(
      screen.getByText(/Platform Engineer ends Nov 30, 2026 \(inclusive\)/),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(mocks.assignmentImpact).toHaveBeenCalledWith(
        'employee-1',
        'assignment-1',
        '2026-11-30',
      ),
    );
    const submit = screen.getByRole('button', { name: 'Transfer' });
    expect(submit).toBeDisabled();
    fireEvent.click(await screen.findByLabelText(/I reviewed the impact/));
    fireEvent.click(screen.getByRole('button', { name: 'Transfer' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/changed while you were working/);
    fireEvent.click(screen.getByRole('button', { name: 'Transfer' }));
    await waitFor(() =>
      expect(mocks.transferAssignment).toHaveBeenLastCalledWith('employee-1', 'assignment-1', {
        positionId: 'position-2',
        effectiveDate: '2026-12-01',
        employmentType: 'FULL_TIME',
        isPrimary: true,
      }),
    );
    expect(onDone).toHaveBeenCalled();
  });

  it('refuses a blocked date (finalized records) and explains the client-side rules', async () => {
    expect(
      validateTransfer(assignment, {
        position: { ...position, id: 'position-1' },
        effectiveDate: '2026-12-01',
        endDate: '',
        managerChoice: 'carry',
        manager: null,
      }),
    ).toBe('Choose a different position for the transfer.');
    expect(
      validateTransfer(assignment, {
        position,
        effectiveDate: '2026-01-01',
        endDate: '',
        managerChoice: 'carry',
        manager: null,
      }),
    ).toMatch(/must be after Jan 1, 2026/);
    expect(
      validateTransfer(assignment, {
        position,
        effectiveDate: '2026-12-01',
        endDate: '',
        managerChoice: 'choose',
        manager: null,
      }),
    ).toBe('Choose the manager.');
  });

  it('summarizes manager and compensation outcomes', () => {
    const base = {
      replayed: false,
      sourceAssignment: { id: 'a', endDate: '2026-11-30', status: 'ACTIVE' as const },
      destinationAssignment: {
        id: 'b',
        positionId: 'p',
        startDate: '2026-12-01',
        endDate: null,
        status: 'PLANNED' as const,
        isPrimary: true,
      },
      compensationRequired: true,
      sourceHadCompensation: true,
      primaryCarried: true,
      manager: {
        managerAssignmentId: null,
        carried: false,
        droppedReason: 'MANAGER_ORGANIZATION_MISMATCH' as const,
      },
    };
    expect(transferSummary(base)).toMatch(
      /not carried over: the previous manager works in another organization/,
    );
    expect(transferSummary(base)).toMatch(/add a compensation record for the new assignment\./);
    expect(transferSummary({ ...base, replayed: true })).toMatch(/already been recorded/);
  });
});

describe('validateRehire', () => {
  it('requires a new assignment that starts after the last day', () => {
    const position = {
      id: 'p',
      name: 'P',
      code: 'P',
      jobTitle: { id: 'j', name: 'J', code: 'J' },
      organization: { id: 'o', name: 'O', code: 'O' },
      placement: null,
      workLocation: null,
    };
    expect(
      validateRehire({ position: null, employmentType: '', startDate: '', endDate: '' }, null),
    ).toMatch(/position/);
    expect(
      validateRehire(
        { position, employmentType: 'CASUAL', startDate: '2026-10-31', endDate: '' },
        '2026-10-31',
      ),
    ).toMatch(/must start after the last day of employment/);
    expect(
      validateRehire(
        { position, employmentType: 'CASUAL', startDate: '2026-11-01', endDate: '2026-10-01' },
        '2026-10-31',
      ),
    ).toMatch(/end date/);
    expect(
      validateRehire(
        { position, employmentType: 'CASUAL', startDate: '2026-11-01', endDate: '' },
        '2026-10-31',
      ),
    ).toBeNull();
  });
});
