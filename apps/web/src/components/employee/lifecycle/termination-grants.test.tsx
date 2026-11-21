import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  EmployeeProfile,
  EmployeeTermination,
  EmployeeTerminationPreview,
  TerminationGrantChanges,
  TerminationGrantList,
} from '../../../lib/employee/types';
import { AuthApiError } from '../../../lib/auth/types';
import { expectNoAxeViolations } from '../../../test/axe';
import { AccessReviewSection } from './access-review';
import { TerminationDialog } from './termination';
import {
  choicesValid,
  initialChoices,
  keepUntilFor,
  TerminationGrantsPanel,
  toGrantDecisions,
} from './termination-grants';

/**
 * Security remediation M3 — the "Roles and access" part of terminating someone: a decision per
 * grant (revoke by default; System-level grants must be decided), a keep is a request with a
 * reason and at most 30 days, approval by someone else, and the access review afterwards.
 */

const mocks = vi.hoisted(() => ({
  terminationPreview: vi.fn(),
  terminate: vi.fn(),
  rescheduleTermination: vi.fn(),
  terminationGrants: vi.fn(),
  recordGrantDecisions: vi.fn(),
  reviewGrantKeep: vi.fn(),
  accessReview: vi.fn(),
  revokeGrants: vi.fn(),
}));
vi.mock('../../../lib/employee/api', () => ({ employeeApi: mocks }));

const NOW = new Date('2026-11-04T20:00:00.000Z');
// The end of day 30 after Nov 20 in Toronto (EST, UTC-5).
const KEEP_LIMIT = '2026-12-21T05:00:00.000Z';

const profile: EmployeeProfile = {
  id: 'employee-1',
  employeeNumber: 'E-1',
  status: 'ACTIVE',
  hireDate: '2026-01-01',
  terminationDate: null,
  person: {
    firstName: 'Ada',
    middleName: null,
    lastName: 'Lovelace',
    preferredName: null,
    personalEmail: null,
    phone: null,
  },
  assignments: { current: [], upcoming: [], historical: [], cancelled: [] },
};

const hrGrant = {
  roleAssignmentId: 'grant-hr',
  roleName: 'HR Administrator',
  scopeType: 'ORGANIZATION',
  system: false,
  organizationId: 'org-1',
  organizationName: 'Toronto Campus',
  expiresAt: null,
  outcome: 'REVOKE' as const,
};
const ownerGrant = {
  roleAssignmentId: 'grant-owner',
  roleName: 'System Owner',
  scopeType: 'SYSTEM',
  system: true,
  organizationId: null,
  organizationName: null,
  expiresAt: null,
  outcome: 'DECISION_REQUIRED' as const,
};

const changes = (overrides: Partial<TerminationGrantChanges> = {}): TerminationGrantChanges => ({
  grants: [hrGrant, ownerGrant],
  otherAccessRemains: false,
  loginWillBeDisabled: true,
  decisionsRequired: ['grant-owner'],
  keepLimit: KEEP_LIMIT,
  ...overrides,
});

function preview(date: string, grantChanges = changes()): EmployeeTerminationPreview {
  return {
    employeeId: 'employee-1',
    terminationDate: date,
    scheduled: true,
    assignments: [
      {
        employmentAssignmentId: 'a-1',
        positionName: 'Teacher',
        organizationId: 'org-1',
        organizationName: 'Toronto Campus',
        timezone: 'America/Toronto',
        status: 'ACTIVE',
        startDate: '2026-01-01',
        endDate: null,
        action: 'END',
        newEndDate: date,
        effectiveFrom: date,
      },
    ],
    blockers: [],
    followUps: {
      openTimeEntries: 0,
      futurePublishedShifts: 0,
      pendingLeaveRequests: 0,
      approvedLeaveAfterTermination: 0,
      openBenefitEnrollments: 0,
      openPerformanceReviews: 0,
    },
    access: null,
    grantChanges,
  };
}

const termination: EmployeeTermination = {
  id: 'term-1',
  employeeId: 'employee-1',
  terminationDate: '2026-11-20',
  status: 'SCHEDULED',
  reason: null,
  systemGrantsAcknowledged: false,
  recordedByUserId: 'requester',
  recordedAt: '2026-11-01T12:00:00.000Z',
  appliedAt: null,
  appliedSource: null,
  cancelledAt: null,
  cancelledByUserId: null,
  supersededById: null,
  rehireAssignmentId: null,
  rehiredAt: null,
  assignments: [],
};

const pendingKeep = {
  id: 'decision-1',
  decision: 'KEEP' as const,
  status: 'REQUESTED' as const,
  reason: 'Handover of the payroll provider integration',
  keepUntil: '2026-12-01T05:00:00.000Z',
  requestedByUserId: 'requester',
  requestedByName: 'Rita Requester',
  requestedAt: '2026-11-02T15:00:00.000Z',
  reviewedByUserId: null,
  reviewedByName: null,
  reviewedAt: null,
  reviewNote: null,
  appliedAt: null,
  outcome: null,
  retainedRoleAssignmentId: null,
  retainedUntil: null,
};

const list = (overrides: Partial<TerminationGrantList> = {}): TerminationGrantList => ({
  grants: [
    { ...hrGrant, decision: null },
    { ...ownerGrant, outcome: 'KEEP_PENDING', decision: pendingKeep },
  ],
  otherAccessRemains: false,
  loginWillBeDisabled: true,
  blocking: [{ roleAssignmentId: 'grant-owner', code: 'TERMINATION_KEEP_APPROVAL_REQUIRED' }],
  keepLimit: KEEP_LIMIT,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  mocks.terminationPreview.mockImplementation(async (_id: string, date: string) => preview(date));
  mocks.terminate.mockResolvedValue({
    termination,
    employee: { id: 'employee-1', status: 'ACTIVE', terminationDate: '2026-11-20' },
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('decision helpers', () => {
  it('revokes by default, leaves System-level grants undecided, and never exceeds the limit', () => {
    const choices = initialChoices([hrGrant, ownerGrant]);
    expect(choices['grant-hr']!.choice).toBe('REVOKE');
    expect(choices['grant-owner']!.choice).toBeNull();
    expect(choicesValid([hrGrant, ownerGrant], choices)).toBe(false);
    expect(keepUntilFor(KEEP_LIMIT, 30)).toBe(KEEP_LIMIT);
    expect(keepUntilFor(KEEP_LIMIT, 10)).toBe('2026-12-01T05:00:00.000Z');
    // Rescheduling keeps the recorded decisions unless one is changed.
    expect(initialChoices([ownerGrant], { carryOver: true })['grant-owner']!.choice).toBe(
      'UNCHANGED',
    );
  });

  it('sends System-level decisions and keep requests only; a keep needs a reason and 1–30 days', () => {
    const choices = {
      'grant-hr': { choice: 'KEEP' as const, reason: 'short', days: '10' },
      'grant-owner': { choice: 'REVOKE' as const, reason: '', days: '30' },
    };
    expect(choicesValid([hrGrant, ownerGrant], choices)).toBe(false);
    choices['grant-hr'].reason = 'Handover of the payroll provider integration';
    expect(choicesValid([hrGrant, ownerGrant], choices)).toBe(true);
    for (const days of ['0', '31', '2.5', 'x'])
      expect(choicesValid([hrGrant], { 'grant-hr': { ...choices['grant-hr'], days } })).toBe(false);
    expect(toGrantDecisions([hrGrant, ownerGrant], choices, KEEP_LIMIT)).toEqual([
      {
        roleAssignmentId: 'grant-hr',
        decision: 'KEEP',
        reason: 'Handover of the payroll provider integration',
        keepUntil: '2026-12-01T05:00:00.000Z',
      },
      { roleAssignmentId: 'grant-owner', decision: 'REVOKE' },
    ]);
    // An ordinary grant's revoke is the default and is not sent.
    expect(
      toGrantDecisions(
        [hrGrant],
        { 'grant-hr': { choice: 'REVOKE', reason: '', days: '30' } },
        KEEP_LIMIT,
      ),
    ).toEqual([]);
  });
});

describe('termination dialog: Roles and access', () => {
  it('requires a decision for the System-level grant; the acknowledgement checkbox is gone', async () => {
    const { container } = render(
      <TerminationDialog open profile={profile} onClose={vi.fn()} onDone={vi.fn()} />,
    );
    fireEvent.change(screen.getByLabelText('Last day of employment'), {
      target: { value: '2026-11-20' },
    });
    const section = await screen.findByRole('region', { name: 'Roles and access' });
    expect(section).toHaveTextContent(/A keep is a request, not an approval/);
    expect(section).toHaveTextContent(/login will be disabled/);
    expect(screen.queryByText(/I understand they stay in place/)).not.toBeInTheDocument();
    const submit = screen.getByRole('button', { name: 'Schedule termination' });
    expect(submit).toBeDisabled();
    const owner = within(section).getByRole('group', { name: /System Owner/ });
    expect(owner).toHaveTextContent(/Required: decide/);
    expect(
      within(within(section).getByRole('group', { name: /HR Administrator/ })).getByLabelText(
        'Revoke when the termination applies',
      ),
    ).toBeChecked();
    fireEvent.click(within(owner).getByLabelText('Revoke when the termination applies'));
    expect(submit).toBeEnabled();
    await expectNoAxeViolations(container);
    fireEvent.click(submit);
    await waitFor(() =>
      expect(mocks.terminate).toHaveBeenCalledWith('employee-1', {
        terminationDate: '2026-11-20',
        grantDecisions: [{ roleAssignmentId: 'grant-owner', decision: 'REVOKE' }],
      }),
    );
  });

  it('a keep request needs a reason and a number of days, and is sent as a request', async () => {
    const { container } = render(
      <TerminationDialog open profile={profile} onClose={vi.fn()} onDone={vi.fn()} />,
    );
    fireEvent.change(screen.getByLabelText('Last day of employment'), {
      target: { value: '2026-11-20' },
    });
    const section = await screen.findByRole('region', { name: 'Roles and access' });
    const owner = within(section).getByRole('group', { name: /System Owner/ });
    fireEvent.click(within(owner).getByLabelText(/Request to keep it/));
    expect(owner).toHaveTextContent(/another System administrator must approve/i);
    const submit = screen.getByRole('button', { name: 'Schedule termination' });
    expect(submit).toBeDisabled();
    fireEvent.change(within(owner).getByLabelText('Reason for keeping it'), {
      target: { value: 'too short' },
    });
    expect(owner).toHaveTextContent(/at least 10 characters/);
    expect(within(owner).getByLabelText('Reason for keeping it')).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    fireEvent.change(within(owner).getByLabelText('Reason for keeping it'), {
      target: { value: 'Handover of the payroll provider integration' },
    });
    const days = within(owner).getByLabelText(/how many days after the last day/);
    fireEvent.change(days, { target: { value: '31' } });
    expect(submit).toBeDisabled();
    expect(owner).toHaveTextContent(/from 1 to 30/);
    fireEvent.change(days, { target: { value: '10' } });
    expect(owner).toHaveTextContent(/Ends Dec 1, 2026/);
    expect(submit).toBeEnabled();
    await expectNoAxeViolations(container);
    fireEvent.click(submit);
    await waitFor(() =>
      expect(mocks.terminate).toHaveBeenCalledWith('employee-1', {
        terminationDate: '2026-11-20',
        grantDecisions: [
          {
            roleAssignmentId: 'grant-owner',
            decision: 'KEEP',
            reason: 'Handover of the payroll provider integration',
            keepUntil: '2026-12-01T05:00:00.000Z',
          },
        ],
      }),
    );
  });

  it('the preview lists what is revoked and that other access keeps the login', async () => {
    mocks.terminationPreview.mockImplementation(async (_id: string, date: string) =>
      preview(
        date,
        changes({
          grants: [hrGrant],
          decisionsRequired: [],
          otherAccessRemains: true,
          loginWillBeDisabled: false,
        }),
      ),
    );
    render(<TerminationDialog open profile={profile} onClose={vi.fn()} onDone={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Last day of employment'), {
      target: { value: '2026-11-20' },
    });
    const previewPanel = await screen.findByRole('region', { name: 'Termination preview' });
    expect(previewPanel).toHaveTextContent(
      /HR Administrator · Toronto Campus · organization: revoked when it applies/,
    );
    expect(previewPanel).toHaveTextContent(/Other access remains .* the login stays enabled/);
    expect(screen.getByRole('button', { name: 'Schedule termination' })).toBeEnabled();
  });

  it('rescheduling keeps recorded decisions unless one is changed', async () => {
    mocks.rescheduleTermination.mockResolvedValue({
      termination,
      employee: { id: 'employee-1', status: 'ACTIVE', terminationDate: '2026-11-25' },
    });
    render(
      <TerminationDialog
        open
        profile={{ ...profile, terminationDate: '2026-11-20' }}
        termination={termination}
        onClose={vi.fn()}
        onDone={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText('Last day of employment'), {
      target: { value: '2026-11-25' },
    });
    const section = await screen.findByRole('region', { name: 'Roles and access' });
    expect(section).toHaveTextContent(/kept grants need approval again/);
    expect(
      within(within(section).getByRole('group', { name: /System Owner/ })).getByLabelText(
        'Keep the recorded decision',
      ),
    ).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Reschedule termination' }));
    await waitFor(() =>
      expect(mocks.rescheduleTermination).toHaveBeenCalledWith('employee-1', 'term-1', {
        terminationDate: '2026-11-25',
      }),
    );
  });
});

describe('scheduled termination: decisions and approval', () => {
  it('shows the request, who asked, and lets another administrator approve it', async () => {
    mocks.terminationGrants.mockResolvedValue(list());
    mocks.reviewGrantKeep.mockResolvedValue(
      list({
        grants: [
          { ...hrGrant, decision: null },
          {
            ...ownerGrant,
            outcome: 'KEEP',
            decision: {
              ...pendingKeep,
              status: 'APPROVED',
              reviewedByUserId: 'approver',
              reviewedByName: 'Alex Approver',
              reviewedAt: '2026-11-03T10:00:00.000Z',
            },
          },
        ],
        blocking: [],
        loginWillBeDisabled: false,
      }),
    );
    const { container } = render(
      <TerminationGrantsPanel
        employeeId="employee-1"
        termination={termination}
        viewerUserId="approver"
      />,
    );
    const panel = await screen.findByRole('region', { name: 'Roles and access at termination' });
    await within(panel).findByText('System Owner');
    expect(within(panel).getByRole('alert')).toHaveTextContent(/cannot apply yet/);
    expect(panel).toHaveTextContent(/Keep requested: awaiting approval/);
    expect(panel).toHaveTextContent(/Rita Requester/);
    expect(panel).toHaveTextContent(/Waiting for another administrator/);
    await expectNoAxeViolations(container);
    fireEvent.click(within(panel).getByRole('button', { name: 'Approve keep' }));
    const dialog = screen.getByRole('dialog', { name: /Approve keeping System Owner/ });
    fireEvent.change(within(dialog).getByLabelText(/Note/), { target: { value: 'Agreed' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve keep' }));
    await waitFor(() =>
      expect(mocks.reviewGrantKeep).toHaveBeenCalledWith(
        'employee-1',
        'term-1',
        'decision-1',
        'approve',
        'Agreed',
      ),
    );
    expect(await screen.findByText(/Keep approved\./)).toBeInTheDocument();
    expect(panel).toHaveTextContent(/Approved by Alex Approver/);
    expect(within(panel).queryByRole('alert')).not.toBeInTheDocument();
  });

  it('final M3: a System-level keep whose approval is no longer valid is shown as blocking, with what to do', async () => {
    mocks.terminationGrants.mockResolvedValue(
      list({
        grants: [
          { ...hrGrant, decision: null },
          {
            ...ownerGrant,
            outcome: 'KEEP_INVALID',
            decision: {
              ...pendingKeep,
              status: 'APPROVED',
              reviewedByUserId: 'approver',
              reviewedByName: 'Alex Approver',
              reviewedAt: '2026-11-03T10:00:00.000Z',
            },
          },
        ],
        blocking: [{ roleAssignmentId: 'grant-owner', code: 'TERMINATION_KEEP_APPROVAL_INVALID' }],
      }),
    );
    const { container } = render(
      <TerminationGrantsPanel employeeId="employee-1" termination={termination} viewerUserId="x" />,
    );
    const panel = await screen.findByRole('region', { name: 'Roles and access at termination' });
    await within(panel).findByText('System Owner');
    expect(panel).toHaveTextContent('Approval no longer valid: not kept');
    expect(within(panel).getByRole('alert')).toHaveTextContent(
      /An earlier approval is no longer valid .* have an eligible System administrator approve it again/,
    );
    // The way forward is offered: change the decision (a fresh request, then approval).
    expect(
      within(panel).getAllByRole('button', { name: 'Change decision' }).length,
    ).toBeGreaterThan(0);
    await expectNoAxeViolations(container);
  });

  it('final M3: after application, says why an approved keep was not kept', async () => {
    mocks.terminationGrants.mockResolvedValue(
      list({
        grants: [
          {
            ...hrGrant,
            outcome: 'REVOKED',
            decision: {
              ...pendingKeep,
              id: 'decision-2',
              status: 'APPROVED',
              reviewedByUserId: 'approver',
              reviewedByName: 'Alex Approver',
              reviewedAt: '2026-11-03T10:00:00.000Z',
              appliedAt: '2026-11-20T05:00:00.000Z',
              outcome: 'REVOKED',
              revalidationFailure: 'APPROVER_NOT_AUTHORIZED',
            },
          },
        ],
        blocking: [],
      }),
    );
    const { container } = render(
      <TerminationGrantsPanel
        employeeId="employee-1"
        termination={{ ...termination, status: 'APPLIED', appliedAt: '2026-11-20T05:00:00.000Z' }}
        viewerUserId="x"
      />,
    );
    const panel = await screen.findByRole('region', { name: 'Roles and access at termination' });
    await within(panel).findByText(/Approved by Alex Approver/);
    expect(panel).toHaveTextContent(
      'Not kept: the approver could no longer grant this role when the termination applied.',
    );
    await expectNoAxeViolations(container);
  });

  it('never offers approval to the requester, who may only withdraw', async () => {
    mocks.terminationGrants.mockResolvedValue(list());
    render(
      <TerminationGrantsPanel
        employeeId="employee-1"
        termination={termination}
        viewerUserId="requester"
      />,
    );
    const panel = await screen.findByRole('region', { name: 'Roles and access at termination' });
    await within(panel).findByText('System Owner');
    expect(within(panel).queryByRole('button', { name: 'Approve keep' })).not.toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: 'Reject keep' })).not.toBeInTheDocument();
    expect(panel).toHaveTextContent(/You requested this exception/);
    expect(within(panel).getByRole('button', { name: 'Withdraw request' })).toBeInTheDocument();
  });

  it('shows the server refusal when a self-approval slips through (stale page)', async () => {
    mocks.terminationGrants.mockResolvedValue(list());
    mocks.reviewGrantKeep.mockRejectedValue(
      new AuthApiError('forbidden', 403, undefined, {
        code: 'TERMINATION_KEEP_SELF_APPROVAL',
        message: 'Refused.',
      }),
    );
    render(
      <TerminationGrantsPanel
        employeeId="employee-1"
        termination={termination}
        viewerUserId={null}
      />,
    );
    const panel = await screen.findByRole('region', { name: 'Roles and access at termination' });
    await within(panel).findByText('System Owner');
    fireEvent.click(within(panel).getByRole('button', { name: 'Reject keep' }));
    const dialog = screen.getByRole('dialog', { name: /Reject keeping System Owner/ });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reject keep' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      /You requested this exception, so you cannot approve or reject it/,
    );
  });

  it('changes a decision through the same fields', async () => {
    mocks.terminationGrants.mockResolvedValue(list());
    mocks.recordGrantDecisions.mockResolvedValue(list());
    render(
      <TerminationGrantsPanel employeeId="employee-1" termination={termination} viewerUserId="x" />,
    );
    const panel = await screen.findByRole('region', { name: 'Roles and access at termination' });
    await within(panel).findByText('HR Administrator');
    fireEvent.click(within(panel).getAllByRole('button', { name: 'Change decision' })[0]!);
    const dialog = screen.getByRole('dialog', { name: 'Decide about HR Administrator' });
    const submit = within(dialog).getByRole('button', { name: 'Record decision' });
    expect(submit).toBeDisabled();
    fireEvent.click(within(dialog).getByLabelText('Revoke when the termination applies'));
    fireEvent.click(submit);
    await waitFor(() =>
      expect(mocks.recordGrantDecisions).toHaveBeenCalledWith('employee-1', 'term-1', [
        { roleAssignmentId: 'grant-hr', decision: 'REVOKE' },
      ]),
    );
  });
});

describe('access review after termination', () => {
  it('shows revoked grants, a retained grant with its end date and approval, and the login state', async () => {
    mocks.accessReview.mockResolvedValue({
      employeeId: 'employee-1',
      employeeStatus: 'TERMINATED',
      access: {
        userId: 'user-1',
        loginStatus: 'ACTIVE',
        activeSessions: 0,
        grants: [
          {
            roleAssignmentId: 'kept-1',
            roleName: 'System Owner',
            scopeType: 'SYSTEM',
            organizationId: null,
            organizationName: null,
            relation: 'SYSTEM',
            revocable: false,
            retention: {
              terminationId: 'term-1',
              keepUntil: '2026-12-01T05:00:00.000Z',
              approvalStatus: 'APPROVED',
              requestedByUserId: 'requester',
              approvedByUserId: 'approver',
            },
          },
        ],
        revokedByTermination: [
          {
            roleAssignmentId: 'grant-hr',
            roleName: 'HR Administrator',
            scopeType: 'ORGANIZATION',
            organizationName: 'Toronto Campus',
            revokedAt: '2026-11-21T05:00:00.000Z',
          },
        ],
        hiddenGrants: 0,
        systemGrants: 1,
        hasEffectiveAuthorization: true,
      },
    });
    const { container } = render(
      <AccessReviewSection
        profile={{ ...profile, status: 'TERMINATED', terminationDate: '2026-11-20' }}
      />,
    );
    const section = await screen.findByRole('region', { name: 'Access review' });
    await within(section).findByText('HR Administrator');
    expect(section).toHaveTextContent(/Revoked by termination/);
    expect(section).toHaveTextContent(/Kept after termination until Dec 1, 2026/);
    expect(section).toHaveTextContent(/approved by another administrator/);
    expect(section).toHaveTextContent(/an approved exception until its end date/);
    await expectNoAxeViolations(container);
  });

  it('explains a login disabled by the termination', async () => {
    mocks.accessReview.mockResolvedValue({
      employeeId: 'employee-1',
      employeeStatus: 'TERMINATED',
      access: {
        userId: 'user-1',
        loginStatus: 'DISABLED',
        activeSessions: 0,
        grants: [],
        revokedByTermination: [],
        hiddenGrants: 0,
        systemGrants: 0,
        hasEffectiveAuthorization: false,
      },
    });
    render(
      <AccessReviewSection
        profile={{ ...profile, status: 'TERMINATED', terminationDate: '2026-11-20' }}
      />,
    );
    expect(
      await screen.findByText(/no access remained, so the login was disabled/),
    ).toBeInTheDocument();
  });
});
