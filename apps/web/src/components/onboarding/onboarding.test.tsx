import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthApiError } from '../../lib/auth/types';
import type {
  MyTask,
  OnboardingOrganization,
  WorkflowDashboard,
  WorkflowDetail,
  WorkflowTask,
} from '../../lib/onboarding/types';
import type { ApplicationDetail } from '../../lib/recruitment/types';
import { ApplicationPage } from '../recruitment/application-page';
import { EmployeeWorkflowsSection } from './employee-workflows-section';
import { MyOnboardingPage } from './my-onboarding-page';
import { OnboardingAdminPage } from './onboarding-admin-page';
import { WorkflowPage } from './workflow-page';

const mocks = vi.hoisted(() => ({
  api: {
    organizations: vi.fn(),
    mine: vi.fn(),
    myTasks: vi.fn(),
    templates: vi.fn(),
    createTemplate: vi.fn(),
    updateTemplate: vi.fn(),
    activateTemplate: vi.fn(),
    archiveTemplate: vi.fn(),
    setDefaultTemplate: vi.fn(),
    dashboard: vi.fn(),
    employeeWorkflows: vi.fn(),
    startOnboarding: vi.fn(),
    startOffboarding: vi.fn(),
    startFromHire: vi.fn(),
    workflow: vi.fn(),
    cancelWorkflow: vi.fn(),
    completeWorkflow: vi.fn(),
    startTask: vi.fn(),
    completeTask: vi.fn(),
    acknowledgeTask: vi.fn(),
    waiveTask: vi.fn(),
    reopenTask: vi.fn(),
    reassignTask: vi.fn(),
    setTaskDueDate: vi.fn(),
    importCompletions: vi.fn(),
    options: vi.fn(),
  },
  recruitment: { application: vi.fn() },
  employee: { get: vi.fn(), list: vi.fn() },
  useAuth: vi.fn(),
}));

vi.mock('../../lib/onboarding/api', () => ({ onboardingApi: mocks.api }));
vi.mock('../../lib/recruitment/api', () => ({ recruitmentApi: mocks.recruitment }));
vi.mock('../../lib/employee/api', () => ({ employeeApi: mocks.employee }));
vi.mock('../../providers/auth-provider', () => ({ useAuth: mocks.useAuth }));

const api = mocks.api;

/** Picks an option of a RecordCombobox (debounced search) by its label. */
async function pick(scope: HTMLElement, label: string | RegExp, query: string, option: RegExp) {
  fireEvent.change(within(scope).getByLabelText(label), { target: { value: query } });
  fireEvent.click(await within(scope).findByRole('option', { name: option }, { timeout: 2000 }));
}
const auth = (keys: string[]) =>
  mocks.useAuth.mockReturnValue({
    authorizationLoading: false,
    authorization: {
      permissions: keys.map((key) => ({ key, scopes: [{ type: 'ORGANIZATION', id: 'org-1' }] })),
    },
  });

const progress = (overrides = {}) => ({
  total: 4,
  done: 1,
  percent: 25,
  requiredTotal: 3,
  requiredDone: 1,
  overdue: 1,
  allDone: false,
  requiredComplete: false,
  ...overrides,
});

const noActions = {
  canStart: false,
  canComplete: false,
  canAcknowledge: false,
  canWaive: false,
  canReopen: false,
  canReassign: false,
};

const task = (overrides: Partial<WorkflowTask> = {}): WorkflowTask => ({
  id: 'tk-1',
  workflowId: 'wf-1',
  sortOrder: 10,
  title: 'Submit banking details',
  description: 'Use the payroll form.',
  category: 'PAYROLL',
  ownerType: 'EMPLOYEE',
  owner: { userId: 'u-emp', email: 'ada@example.org' },
  dueDate: '2026-10-01',
  overdue: true,
  required: true,
  evidenceRequired: false,
  acknowledgementRequired: false,
  acknowledgementStatement: null,
  reference: null,
  systemAction: 'NONE',
  status: 'NOT_STARTED',
  startedAt: null,
  completedAt: null,
  completedByUserId: null,
  completionNote: null,
  evidenceReference: null,
  completionSource: null,
  acknowledgedAt: null,
  waivedAt: null,
  waiverReason: null,
  reopenCount: 0,
  actions: { ...noActions, canStart: true, canComplete: true },
  ...overrides,
});

const STATEMENT =
  'I have read the Staff Handbook and understand that it sets out the workplace policies that apply to me.';

const handbook = task({
  id: 'tk-ack',
  title: 'Staff Handbook',
  category: 'POLICY',
  overdue: false,
  dueDate: '2026-11-03',
  acknowledgementRequired: true,
  acknowledgementStatement: STATEMENT,
  reference: {
    type: 'GOOGLE_DOC',
    url: 'https://docs.google.com/document/d/handbook',
    externalId: null,
    label: 'Staff Handbook 2026',
  },
  actions: { ...noActions, canAcknowledge: true },
});

const workflow = (overrides: Partial<WorkflowDetail> = {}): WorkflowDetail => ({
  id: 'wf-1',
  view: 'EMPLOYEE',
  kind: 'ONBOARDING',
  status: 'ACTIVE',
  templateName: 'Staff onboarding',
  anchorDate: '2026-11-02',
  plannedEndDate: null,
  startedAt: '2026-10-01T12:00:00.000Z',
  completedAt: null,
  cancelledAt: null,
  organization: { id: 'org-1', name: 'Camp' },
  employee: { id: 'emp-1', employeeNumber: 'E-100', displayName: 'Ada Lovelace' },
  position: { id: 'pos-1', name: 'Counsellor' },
  progress: progress(),
  tasks: [task(), handbook],
  actions: { canManage: false, canCancel: false, canComplete: false },
  ...overrides,
});

const hrWorkflow = (overrides: Partial<WorkflowDetail> = {}) =>
  workflow({
    view: 'HR',
    kind: 'OFFBOARDING',
    anchorDate: '2026-10-31',
    plannedEndDate: '2026-10-31',
    templateCode: 'STAFF-OFF',
    templateName: 'Staff offboarding',
    reason: 'Resigned to return to school',
    recruitmentHireId: null,
    cancellationReason: null,
    coreHr: {
      assignmentStatus: 'ACTIVE',
      assignmentStartDate: '2025-06-01',
      assignmentEndDate: null,
      employeeStatus: 'ACTIVE',
      department: { id: 'd-1', name: 'Programs' },
      team: null,
      workLocation: { id: 'l-1', name: 'Main camp' },
      manager: { assignmentId: 'asg-m', displayName: 'Grace Hopper' },
      endDateRecorded: false,
    },
    events: [
      {
        id: 'ev-1',
        taskId: null,
        type: 'STARTED',
        fromStatus: null,
        toStatus: 'ACTIVE',
        note: null,
        actorUserId: 'u-hr',
        createdAt: '2026-10-01T12:00:00.000Z',
      },
    ],
    tasks: [
      task({
        id: 'tk-keys',
        title: 'Collect keys',
        category: 'EQUIPMENT',
        ownerType: 'MANAGER',
        owner: null,
        systemAction: 'COLLECT_EQUIPMENT',
        actions: {
          ...noActions,
          canStart: true,
          canComplete: true,
          canWaive: true,
          canReassign: true,
        },
      }),
      task({
        id: 'tk-exit',
        title: 'Exit interview',
        category: 'MEETING',
        ownerType: 'HR',
        owner: null,
        overdue: false,
        status: 'COMPLETED',
        completionNote: 'Held on site',
        actions: { ...noActions, canReopen: true },
      }),
    ],
    actions: { canManage: true, canCancel: true, canComplete: false },
    ...overrides,
  });

const organization = (overrides: Partial<OnboardingOrganization['actions']> = {}) => ({
  id: 'org-1',
  name: 'Camp',
  code: 'CAMP',
  timezone: 'America/Toronto',
  actions: {
    canManageTemplates: false,
    onboarding: true,
    offboarding: true,
    canImportOnboarding: true,
    canImportOffboarding: true,
    ...overrides,
  },
});

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  mocks.recruitment.application.mockReset();
  mocks.useAuth.mockReset();
  auth([]);
});

// Batch 10E-1: tab clicks now write the section into the URL (#templates); every test starts
// from a clean address so one test's tab does not open the next.
afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
});

describe('MyOnboardingPage', () => {
  const assigned: MyTask = {
    ...task({
      id: 'tk-laptop',
      workflowId: 'wf-2',
      title: 'Prepare laptop',
      ownerType: 'SPECIFIC_USER',
      dueDate: '2026-10-30',
      overdue: false,
      description: null,
    }),
    workflow: {
      id: 'wf-2',
      kind: 'ONBOARDING',
      status: 'ACTIVE',
      anchorDate: '2026-11-02',
      organization: { id: 'org-1', name: 'Camp' },
      employee: { id: 'emp-2', displayName: 'Alan Turing' },
    },
  };

  it('shows the employee’s own checklist with progress, due dates and assigned tasks', async () => {
    api.mine.mockResolvedValue({ items: [workflow()] });
    api.myTasks.mockResolvedValue({ items: [assigned] });
    render(<MyOnboardingPage />);
    const mine = await screen.findByRole('region', { name: 'My onboarding — Counsellor' });
    expect(
      within(mine).getByRole('progressbar', { name: 'My onboarding progress' }),
    ).toHaveAttribute('aria-valuenow', '25');
    expect(within(mine).getByText(/25% · 1 of 4 tasks done/)).toBeInTheDocument();
    const banking = within(mine).getByRole('listitem', { name: 'Task Submit banking details' });
    expect(within(banking).getByText('Overdue')).toBeInTheDocument();
    expect(within(banking).getByText('Due 10/01/2026 · Payroll')).toBeInTheDocument();
    expect(within(banking).getByText('Use the payroll form.')).toBeInTheDocument();
    expect(within(mine).getAllByRole('listitem')).toHaveLength(2);
    expect(within(mine).queryByText('Prepare laptop')).not.toBeInTheDocument();
    expect(screen.queryByText(/Reason/)).not.toBeInTheDocument();

    const others = screen.getByRole('region', { name: 'Tasks assigned to me' });
    const laptop = within(others).getByRole('listitem', { name: 'Assigned task Prepare laptop' });
    expect(
      within(laptop).getByText(/Alan Turing · Onboarding · Camp · Due 10\/30\/2026/),
    ).toBeInTheDocument();
    api.startTask.mockResolvedValue(workflow());
    fireEvent.click(within(laptop).getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(api.startTask).toHaveBeenCalledWith('tk-laptop'));
  });

  it('acknowledges the exact statement only after the checkbox is ticked', async () => {
    api.mine.mockResolvedValue({ items: [workflow()] });
    api.myTasks.mockResolvedValue({ items: [] });
    api.acknowledgeTask.mockResolvedValue(workflow());
    render(<MyOnboardingPage />);
    const form = await screen.findByRole('form', { name: 'Acknowledge Staff Handbook' });
    expect(within(form).getByText(STATEMENT)).toBeInTheDocument();
    expect(screen.queryByText(/agree/i)).not.toBeInTheDocument();
    const button = within(form).getByRole('button', { name: 'Acknowledge' });
    expect(button).toBeDisabled();
    fireEvent.submit(form);
    expect(api.acknowledgeTask).not.toHaveBeenCalled();
    fireEvent.click(
      within(form).getByRole('checkbox', { name: 'I acknowledge the statement above.' }),
    );
    expect(button).toBeEnabled();
    fireEvent.click(button);
    await waitFor(() => expect(api.acknowledgeTask).toHaveBeenCalledWith('tk-ack'));
    expect(await screen.findByText('Acknowledgement recorded.')).toBeInTheDocument();
    const handbookItem = screen.getByRole('listitem', { name: 'Task Staff Handbook' });
    expect(
      within(handbookItem).queryByRole('button', { name: 'Complete' }),
    ).not.toBeInTheDocument();
  });

  it('sends the note and evidence reference on completion and asks for evidence first', async () => {
    api.mine.mockResolvedValue({
      items: [workflow({ tasks: [task({ evidenceRequired: true })] })],
    });
    api.myTasks.mockResolvedValue({ items: [] });
    api.completeTask.mockResolvedValue(workflow());
    render(<MyOnboardingPage />);
    const item = await screen.findByRole('listitem', { name: 'Task Submit banking details' });
    fireEvent.click(within(item).getByRole('button', { name: 'Complete' }));
    const form = within(item).getByRole('form', { name: 'Complete Submit banking details' });
    fireEvent.click(within(form).getByRole('button', { name: 'Mark complete' }));
    expect(within(form).getByRole('alert')).toHaveTextContent(
      'Add a completion note or an evidence reference.',
    );
    expect(api.completeTask).not.toHaveBeenCalled();
    fireEvent.change(within(form).getByLabelText('Completion note'), {
      target: { value: ' Submitted via the form ' },
    });
    fireEvent.change(within(form).getByLabelText('Evidence reference'), {
      target: { value: 'FORM-RESP-42' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Mark complete' }));
    await waitFor(() =>
      expect(api.completeTask).toHaveBeenCalledWith('tk-1', {
        note: 'Submitted via the form',
        evidenceReference: 'FORM-RESP-42',
      }),
    );
  });

  it('renders references as links only for https URLs, opening them safely', async () => {
    api.mine.mockResolvedValue({
      items: [
        workflow({
          tasks: [
            handbook,
            task({
              id: 'tk-unsafe',
              title: 'Benefits enrolment',
              reference: {
                type: 'GOOGLE_FORM',
                url: 'javascript:alert(1)',
                externalId: 'form-77',
                label: 'Enrolment form',
              },
            }),
            task({
              id: 'tk-http',
              title: 'Drive',
              reference: {
                type: 'GOOGLE_DRIVE_FOLDER',
                url: 'http://drive.example.com/folder',
                externalId: null,
                label: null,
              },
            }),
          ],
        }),
      ],
    });
    api.myTasks.mockResolvedValue({ items: [] });
    render(<MyOnboardingPage />);
    const link = await screen.findByRole('link', { name: 'Staff Handbook 2026' });
    expect(link).toHaveAttribute('href', 'https://docs.google.com/document/d/handbook');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getByText('Google Doc:')).toBeInTheDocument();
    const unsafe = screen.getByRole('listitem', { name: 'Task Benefits enrolment' });
    expect(within(unsafe).queryByRole('link')).not.toBeInTheDocument();
    expect(within(unsafe).getByText('Google Form:')).toBeInTheDocument();
    expect(within(unsafe).getByText('Enrolment form (form-77)')).toBeInTheDocument();
    const drive = screen.getByRole('listitem', { name: 'Task Drive' });
    expect(within(drive).queryByRole('link')).not.toBeInTheDocument();
    expect(within(drive).getAllByText(/Drive folder/).length).toBeGreaterThan(0);
  });
});

describe('OnboardingAdminPage', () => {
  const dashboard = (kind: 'ONBOARDING' | 'OFFBOARDING'): WorkflowDashboard => ({
    today: '2026-10-06',
    kind,
    items: [
      {
        id: 'wf-1',
        status: 'ACTIVE',
        templateName: 'Staff offboarding',
        anchorDate: '2026-10-01',
        plannedEndDate: kind === 'OFFBOARDING' ? '2026-10-01' : null,
        employee: { id: 'emp-1', employeeNumber: 'E-100', displayName: 'Ada Lovelace' },
        position: { id: 'pos-1', name: 'Counsellor' },
        assignmentStatus: 'ACTIVE',
        assignmentEndDate: null,
        progress: progress({ percent: 40, done: 2, total: 5, overdue: 2 }),
      },
    ],
    attention: {
      overdueTasks: [
        {
          workflowId: 'wf-1',
          taskId: 'tk-1',
          title: 'Collect keys',
          dueDate: '2026-10-01',
          ownerType: 'MANAGER',
          owner: 'grace@example.org',
          employee: 'Ada Lovelace',
        },
      ],
      unassignedTasks: [
        {
          workflowId: 'wf-1',
          taskId: 'tk-2',
          title: 'Disable accounts',
          ownerType: 'SPECIFIC_USER',
          employee: 'Ada Lovelace',
        },
      ],
      upcoming: [],
      coreHrPending:
        kind === 'OFFBOARDING'
          ? [{ workflowId: 'wf-1', employee: 'Ada Lovelace', plannedEndDate: '2026-10-01' }]
          : [],
    },
  });

  it('is forbidden without onboarding permissions', () => {
    auth(['employee.manage']);
    render(<OnboardingAdminPage />);
    expect(screen.getByText('You do not have permission to view onboarding.')).toBeInTheDocument();
    expect(api.organizations).not.toHaveBeenCalled();
  });

  it('shows the offboarding dashboard with attention items including Core HR pending', async () => {
    auth(['offboarding.read']);
    api.organizations.mockResolvedValue({ items: [organization({ onboarding: false })] });
    api.dashboard.mockImplementation((_org: string, kind: 'ONBOARDING' | 'OFFBOARDING') =>
      Promise.resolve(dashboard(kind)),
    );
    render(<OnboardingAdminPage />);
    expect(await screen.findByRole('tab', { name: 'Offboarding' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.queryByRole('tab', { name: 'Onboarding' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Templates' })).not.toBeInTheDocument();
    await waitFor(() => expect(api.dashboard).toHaveBeenCalledWith('org-1', 'OFFBOARDING', false));
    expect(await screen.findByRole('link', { name: 'Open Ada Lovelace' })).toHaveAttribute(
      'href',
      '/onboarding/workflows/wf-1',
    );
    expect(screen.getByText('40%')).toBeInTheDocument();
    const overdue = screen.getByRole('region', { name: 'Overdue tasks' });
    expect(
      within(overdue).getByRole('link', { name: 'Ada Lovelace — Collect keys' }),
    ).toBeInTheDocument();
    expect(
      within(overdue).getByText(/due 10\/01\/2026 · Manager \(grace@example.org\)/),
    ).toBeInTheDocument();
    const unassigned = screen.getByRole('region', { name: 'Unassigned tasks' });
    expect(within(unassigned).getByText('Specific user task')).toBeInTheDocument();
    const pending = screen.getByRole('region', { name: 'Awaiting Core HR' });
    expect(
      within(pending).getByText(/Core HR has not ended the assignment yet/),
    ).toBeInTheDocument();
    expect(within(pending).getByText(/Offboarding never ends employment/)).toBeInTheDocument();
    expect(within(pending).getByText('last day 10/01/2026')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Upcoming last days' })).toBeInTheDocument();
  });

  it('creates a template with its tasks in the edited order', async () => {
    auth(['onboarding.template.manage']);
    api.organizations.mockResolvedValue({
      items: [organization({ canManageTemplates: true, onboarding: false, offboarding: false })],
    });
    api.templates.mockResolvedValue({ items: [] });
    api.createTemplate.mockResolvedValue({});
    render(<OnboardingAdminPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'New template' }));
    const form = screen.getByRole('form', { name: 'Create template' });
    fireEvent.change(within(form).getByLabelText('Template code'), { target: { value: 'STAFF' } });
    fireEvent.change(within(form).getByLabelText('Template name'), {
      target: { value: 'Staff onboarding' },
    });
    const first = within(form).getByRole('group', { name: 'Task 1' });
    fireEvent.change(within(first).getByLabelText('Title'), { target: { value: 'Laptop' } });
    fireEvent.change(within(first).getByLabelText('Owner'), { target: { value: 'SPECIFIC_USER' } });
    // Batch 7A: owners come from the onboarding options (no role.assign needed).
    api.options.mockResolvedValue({
      items: [{ id: 'u-it', label: 'Ivan Tech', description: 'E-7' }],
      nextAfterId: null,
    });
    await pick(first, /^Owner person/, 'Ivan', /Ivan Tech/);
    expect(api.options).toHaveBeenCalledWith(
      'org-1',
      'owner',
      expect.objectContaining({ search: 'Ivan' }),
    );
    fireEvent.change(within(first).getByLabelText('Category'), {
      target: { value: 'EQUIPMENT' },
    });
    fireEvent.change(within(first).getByLabelText('Due offset (days)'), {
      target: { value: '-3' },
    });
    fireEvent.change(within(first).getByLabelText('System action'), {
      target: { value: 'ISSUE_EQUIPMENT' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Add task' }));
    const second = within(form).getByRole('group', { name: 'Task 2' });
    fireEvent.change(within(second).getByLabelText('Title'), { target: { value: 'Handbook' } });
    fireEvent.change(within(second).getByLabelText('Category'), { target: { value: 'POLICY' } });
    fireEvent.click(within(second).getByLabelText('Acknowledgement required'));
    fireEvent.change(within(second).getByLabelText('Acknowledgement statement'), {
      target: { value: 'I have read the handbook.' },
    });
    fireEvent.change(within(second).getByLabelText('Reference type'), {
      target: { value: 'GOOGLE_DOC' },
    });
    fireEvent.change(within(second).getByLabelText('Reference link (https)'), {
      target: { value: 'https://docs.google.com/document/d/h' },
    });
    fireEvent.click(within(second).getByRole('button', { name: 'Move up' }));
    fireEvent.click(within(form).getByRole('button', { name: 'Create template' }));
    await waitFor(() =>
      expect(api.createTemplate).toHaveBeenCalledWith({
        organizationId: 'org-1',
        kind: 'ONBOARDING',
        code: 'STAFF',
        name: 'Staff onboarding',
        description: null,
        tasks: [
          {
            title: 'Handbook',
            description: null,
            category: 'POLICY',
            ownerType: 'EMPLOYEE',
            ownerUserId: null,
            dueOffsetDays: 0,
            required: true,
            evidenceRequired: false,
            acknowledgementRequired: true,
            acknowledgementStatement: 'I have read the handbook.',
            referenceType: 'GOOGLE_DOC',
            referenceUrl: 'https://docs.google.com/document/d/h',
            referenceExternalId: null,
            referenceLabel: null,
            systemAction: 'NONE',
          },
          {
            title: 'Laptop',
            description: null,
            category: 'EQUIPMENT',
            ownerType: 'SPECIFIC_USER',
            ownerUserId: 'u-it',
            dueOffsetDays: -3,
            required: true,
            evidenceRequired: false,
            acknowledgementRequired: false,
            acknowledgementStatement: null,
            referenceType: null,
            referenceUrl: null,
            referenceExternalId: null,
            referenceLabel: null,
            systemAction: 'ISSUE_EQUIPMENT',
          },
        ],
      }),
    );
    expect(await screen.findByText('Template created as a draft.')).toBeInTheDocument();
  });

  it('sends each saved task back with its id when editing a template', async () => {
    auth(['onboarding.template.manage']);
    api.organizations.mockResolvedValue({
      items: [organization({ canManageTemplates: true, onboarding: false, offboarding: false })],
    });
    const saved = {
      id: 'tt-laptop',
      sortOrder: 10,
      title: 'Laptop',
      description: null,
      category: 'EQUIPMENT' as const,
      ownerType: 'SPECIFIC_USER' as const,
      ownerUserId: 'u-it',
      dueOffsetDays: 0,
      required: true,
      evidenceRequired: false,
      acknowledgementRequired: false,
      acknowledgementStatement: null,
      referenceType: null,
      referenceUrl: null,
      referenceExternalId: null,
      referenceLabel: null,
      systemAction: 'NONE' as const,
    };
    api.templates.mockResolvedValue({
      items: [
        {
          id: 'tpl-1',
          organizationId: 'org-1',
          kind: 'ONBOARDING',
          code: 'STAFF',
          name: 'Staff onboarding',
          description: null,
          status: 'DRAFT',
          isDefault: false,
          workflowCount: 0,
          activatedAt: null,
          archivedAt: null,
          tasks: [saved],
        },
      ],
    });
    api.updateTemplate.mockResolvedValue({});
    render(<OnboardingAdminPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Staff onboarding' }));
    const form = screen.getByRole('form', { name: 'Edit template' });
    fireEvent.click(within(form).getByRole('button', { name: 'Add task' }));
    const added = within(form).getByRole('group', { name: 'Task 2' });
    fireEvent.change(within(added).getByLabelText('Title'), { target: { value: 'Handbook' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save template' }));
    // The saved task keeps its owner on that task only (see the API's owner rule): the new
    // task is sent without an id.
    await waitFor(() => expect(api.updateTemplate).toHaveBeenCalled());
    const [templateId, input] = api.updateTemplate.mock.calls[0]!;
    expect(templateId).toBe('tpl-1');
    expect(input.tasks).toEqual([
      expect.objectContaining({ id: 'tt-laptop', title: 'Laptop', ownerUserId: 'u-it' }),
      expect.objectContaining({ title: 'Handbook' }),
    ]);
    expect(input.tasks[1]).not.toHaveProperty('id');
  });

  it('Batch 5C: opens Start offboarding prefilled from a profile link, flags an open workflow, and starts nothing by itself', async () => {
    const employeeId = '11111111-1111-4111-8111-111111111111';
    const assignmentId = '22222222-2222-4222-8222-222222222222';
    const templateId = '33333333-3333-4333-8333-333333333333';
    window.history.replaceState(
      null,
      '',
      `/admin/onboarding?offboardEmployee=${employeeId}&offboardAssignment=${assignmentId}&offboardTemplate=${templateId}&offboardEndDate=2026-11-30#start`,
    );
    auth(['offboarding.manage', 'onboarding.manage']);
    api.organizations.mockResolvedValue({ items: [organization()] });
    api.dashboard.mockImplementation((_org: string, kind: 'ONBOARDING' | 'OFFBOARDING') =>
      Promise.resolve(dashboard(kind)),
    );
    api.templates.mockResolvedValue({ items: [] });
    api.employeeWorkflows.mockResolvedValue({
      items: [
        {
          id: 'wf-open',
          kind: 'OFFBOARDING',
          status: 'ACTIVE',
          templateName: 'Staff offboarding',
          anchorDate: null,
          plannedEndDate: '2026-11-30',
          employmentAssignmentId: assignmentId,
          positionName: 'Counsellor',
          progress: progress({}),
        },
      ],
    });
    api.startOffboarding.mockResolvedValue(hrWorkflow());
    mocks.employee.get.mockResolvedValue({
      id: employeeId,
      employeeNumber: 'E-100',
      person: { firstName: 'Ada', lastName: 'Lovelace', middleName: null, preferredName: null },
      assignments: {
        historical: [],
        current: [
          {
            id: assignmentId,
            status: 'ACTIVE',
            isPrimary: true,
            startDate: '2026-01-01',
            position: { id: 'pos-1', name: 'Counsellor', code: 'C' },
            organization: { id: 'org-1', name: 'Org', code: 'O' },
          },
        ],
        upcoming: [],
      },
    });
    render(<OnboardingAdminPage />);
    const form = await screen.findByRole('form', { name: 'Start offboarding' });
    expect(await within(form).findByRole('note')).toHaveTextContent(/Nothing has started/);
    expect(within(form).getByLabelText('Planned last day')).toHaveValue('2026-11-30');
    await waitFor(() => expect(mocks.employee.get).toHaveBeenCalledWith(employeeId));
    // Batch 7A: the module-scoped picker shows the preselected employment by name.
    expect(await within(form).findByDisplayValue('Ada Lovelace')).toBeInTheDocument();
    expect(await within(form).findByRole('alert')).toHaveTextContent(/already open/);
    expect(within(form).getByRole('link', { name: 'Open the active workflow' })).toHaveAttribute(
      'href',
      '/onboarding/workflows/wf-open',
    );
    expect(api.startOffboarding).not.toHaveBeenCalled();
    window.history.replaceState(null, '', '/admin/onboarding');
  });

  it('starts offboarding and imports external completions', async () => {
    auth(['offboarding.manage', 'onboarding.manage']);
    api.organizations.mockResolvedValue({ items: [organization()] });
    api.dashboard.mockImplementation((_org: string, kind: 'ONBOARDING' | 'OFFBOARDING') =>
      Promise.resolve(dashboard(kind)),
    );
    api.templates.mockResolvedValue({ items: [] });
    api.startOffboarding.mockResolvedValue(hrWorkflow());
    api.importCompletions.mockResolvedValue({
      outcomes: [
        { externalResponseId: 'r-1', outcome: 'COMPLETED', taskId: 'tk-9' },
        { externalResponseId: 'r-2', outcome: 'NO_MATCHING_EMPLOYEE' },
      ],
    });
    render(<OnboardingAdminPage />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Start' }));
    const form = screen.getByRole('form', { name: 'Start offboarding' });
    // Batch 7A: assignments the user may offboard, ended ones included.
    api.options.mockResolvedValue({
      items: [
        {
          id: 'asg-1',
          label: 'Ada Lovelace',
          description: 'E-100 · Counsellor · Ended 2026-09-30',
        },
      ],
      nextAfterId: null,
    });
    await pick(form, /^Employment/, 'Ada', /Ada Lovelace/);
    expect(api.options).toHaveBeenCalledWith(
      'org-1',
      'assignment',
      expect.objectContaining({ workflowKind: 'OFFBOARDING', search: 'Ada' }),
    );
    fireEvent.change(within(form).getByLabelText('Planned last day'), {
      target: { value: '2026-10-31' },
    });
    fireEvent.change(within(form).getByLabelText('Reason (HR only)'), {
      target: { value: 'Resigned' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Start offboarding' }));
    await waitFor(() =>
      expect(api.startOffboarding).toHaveBeenCalledWith({
        employmentAssignmentId: 'asg-1',
        plannedEndDate: '2026-10-31',
        reason: 'Resigned',
        templateId: null,
      }),
    );
    expect(
      await screen.findByRole('link', { name: 'Open Offboarding for Ada Lovelace' }),
    ).toHaveAttribute('href', '/onboarding/workflows/wf-1');

    fireEvent.click(screen.getByRole('tab', { name: 'Import' }));
    const importForm = screen.getByRole('form', { name: 'Import task completions' });
    const submissions = [
      {
        externalResourceId: 'form-1',
        externalResponseId: 'r-1',
        respondentEmail: 'ada@example.org',
        submittedAt: '2026-10-05T10:00:00Z',
      },
    ];
    fireEvent.change(within(importForm).getByLabelText(/Submissions/), {
      target: { value: JSON.stringify(submissions) },
    });
    fireEvent.click(within(importForm).getByRole('button', { name: 'Import' }));
    await waitFor(() =>
      expect(api.importCompletions).toHaveBeenCalledWith({
        organizationId: 'org-1',
        referenceType: 'GOOGLE_FORM',
        submissions,
      }),
    );
    expect(await screen.findByText('No Matching Employee')).toBeInTheDocument();
    expect(screen.getByText('tk-9')).toBeInTheDocument();
  });
});

describe('WorkflowPage', () => {
  it('shows HR the reason, Core HR, events and the actions each task allows', async () => {
    api.workflow.mockResolvedValue(hrWorkflow());
    api.waiveTask.mockResolvedValue(hrWorkflow());
    render(<WorkflowPage workflowId="wf-1" />);
    expect(
      await screen.findByRole('heading', { name: 'Offboarding: Ada Lovelace' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Reason: Resigned to return to school')).toBeInTheDocument();
    expect(screen.getByText('Staff offboarding (STAFF-OFF)')).toBeInTheDocument();
    const core = screen.getByRole('region', { name: 'Core HR' });
    expect(within(core).getByText('Grace Hopper')).toBeInTheDocument();
    expect(within(core).getByText('Programs')).toBeInTheDocument();
    expect(within(core).getByRole('note')).toHaveTextContent(
      'Core HR has not recorded the planned last day as the assignment end date yet.',
    );
    expect(within(core).getByRole('note')).toHaveTextContent('Offboarding never ends employment');
    const history = screen.getByRole('region', { name: 'History' });
    expect(within(history).getByText(/Workflow started/)).toBeInTheDocument();

    const keys = screen.getByRole('row', { name: 'Task Collect keys' });
    expect(within(keys).getByText('Unassigned')).toBeInTheDocument();
    expect(within(keys).getByText(/Collect equipment/)).toBeInTheDocument();
    for (const name of ['Start', 'Complete', 'Waive', 'Reassign', 'Change due date']) {
      expect(within(keys).getByRole('button', { name })).toBeInTheDocument();
    }
    expect(within(keys).queryByRole('button', { name: 'Reopen' })).not.toBeInTheDocument();
    expect(within(keys).queryByRole('form', { name: /Acknowledge/ })).not.toBeInTheDocument();
    const exit = screen.getByRole('row', { name: 'Task Exit interview' });
    expect(within(exit).getByText('HR pool')).toBeInTheDocument();
    expect(within(exit).getByRole('button', { name: 'Reopen' })).toBeInTheDocument();
    expect(within(exit).queryByRole('button', { name: 'Waive' })).not.toBeInTheDocument();
    expect(within(exit).getByText(/Note: Held on site/)).toBeInTheDocument();

    expect(screen.getByRole('button', { name: 'Cancel workflow' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Complete workflow' })).not.toBeInTheDocument();

    fireEvent.click(within(keys).getByRole('button', { name: 'Waive' }));
    const waive = within(keys).getByRole('form', { name: 'Waive Collect keys' });
    const confirm = within(waive).getByRole('button', { name: 'Confirm waiver' });
    expect(confirm).toBeDisabled();
    fireEvent.change(within(waive).getByLabelText('Reason for waiving'), {
      target: { value: 'Keys were never issued' },
    });
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(api.waiveTask).toHaveBeenCalledWith('tk-keys', 'Keys were never issued'),
    );
    expect(await screen.findByText('Task waived.')).toBeInTheDocument();
  });

  it('reassigns to the HR pool and changes a due date with a reason', async () => {
    api.workflow.mockResolvedValue(hrWorkflow());
    api.reassignTask.mockResolvedValue(hrWorkflow());
    api.setTaskDueDate.mockResolvedValue(hrWorkflow());
    render(<WorkflowPage workflowId="wf-1" />);
    const keys = await screen.findByRole('row', { name: 'Task Collect keys' });
    // Batch 7A: owners from the onboarding options; an unowned manager task offers no "no owner".
    api.options.mockResolvedValue({
      items: [{ id: 'u-grace', label: 'Grace Hopper', description: 'E-2' }],
      nextAfterId: null,
    });
    fireEvent.click(within(keys).getByRole('button', { name: 'Reassign' }));
    expect(within(keys).queryByLabelText(/Remove the owner/)).not.toBeInTheDocument();
    await pick(keys, /^New owner/, 'Grace', /Grace Hopper/);
    fireEvent.click(within(keys).getByRole('button', { name: 'Save owner' }));
    await waitFor(() => expect(api.reassignTask).toHaveBeenCalledWith('tk-keys', 'u-grace'));
    const row = await screen.findByRole('row', { name: 'Task Collect keys' });
    fireEvent.click(within(row).getByRole('button', { name: 'Change due date' }));
    fireEvent.change(within(row).getByLabelText('Due date (empty for none)'), {
      target: { value: '2026-10-15' },
    });
    fireEvent.change(within(row).getByLabelText('Reason for the change'), {
      target: { value: 'Manager on leave' },
    });
    fireEvent.click(within(row).getByRole('button', { name: 'Save due date' }));
    await waitFor(() =>
      expect(api.setTaskDueDate).toHaveBeenCalledWith('tk-keys', '2026-10-15', 'Manager on leave'),
    );
  });

  it('hides the reason, Core HR and events from the employee view', async () => {
    api.workflow.mockResolvedValue(workflow({ kind: 'OFFBOARDING', plannedEndDate: '2026-10-31' }));
    render(<WorkflowPage workflowId="wf-1" />);
    expect(
      await screen.findByRole('heading', { name: 'Offboarding: Ada Lovelace' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Your checklist')).toBeInTheDocument();
    expect(screen.queryByText(/Reason/)).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Core HR' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'History' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel workflow' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Waive' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: '← My onboarding' })).toHaveAttribute(
      'href',
      '/onboarding',
    );
    expect(screen.getByRole('form', { name: 'Acknowledge Staff Handbook' })).toBeInTheDocument();
  });

  it('shows a forbidden page without access', async () => {
    api.workflow.mockRejectedValue(new AuthApiError('forbidden', 403));
    render(<WorkflowPage workflowId="wf-1" />);
    expect(await screen.findByText('You do not have access to this workflow.')).toBeInTheDocument();
  });
});

describe('EmployeeWorkflowsSection', () => {
  it('lists the employee’s workflows with links', async () => {
    api.employeeWorkflows.mockResolvedValue({
      items: [
        {
          id: 'wf-1',
          kind: 'OFFBOARDING',
          status: 'ACTIVE',
          templateName: 'Staff offboarding',
          anchorDate: '2026-10-31',
          plannedEndDate: '2026-10-31',
          employmentAssignmentId: 'asg-1',
          positionName: 'Counsellor',
          progress: progress({ percent: 60, overdue: 0 }),
        },
      ],
    });
    render(<EmployeeWorkflowsSection employeeId="emp-1" />);
    expect(await screen.findByRole('link', { name: /^Open / })).toHaveAttribute(
      'href',
      '/onboarding/workflows/wf-1',
    );
    expect(api.employeeWorkflows).toHaveBeenCalledWith('emp-1');
    expect(screen.getByText('Last day 10/31/2026')).toBeInTheDocument();
    expect(screen.getByText('60%')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Onboarding & offboarding' })).toBeInTheDocument();
  });

  it('explains when the records are not accessible', async () => {
    api.employeeWorkflows.mockRejectedValue(new AuthApiError('forbidden', 403));
    render(<EmployeeWorkflowsSection employeeId="emp-1" />);
    expect(
      await screen.findByText('You do not have access to this employee’s onboarding records.'),
    ).toBeInTheDocument();
  });
});

describe('ApplicationPage onboarding hand-off', () => {
  const hire = {
    id: 'hire-1',
    personId: 'p-1',
    employeeId: 'emp-9',
    employmentAssignmentId: 'asg-9',
    compensationRecordId: null,
    internalCandidate: false,
    createdEmployee: true,
    convertedByUserId: 'u-1',
    convertedAt: '2026-10-06T00:00:00.000Z',
  };
  const hiredApplication = {
    id: 'app-1',
    view: 'FULL',
    status: 'HIRED',
    source: 'DIRECT',
    sourceDetail: null,
    appliedAt: '2026-09-02T00:00:00.000Z',
    stageEnteredAt: '2026-09-10T00:00:00.000Z',
    stage: { id: 's-9', name: 'Hired', kind: 'HIRED' },
    organization: { id: 'org-1', name: 'Camp' },
    opening: {
      id: 'op-1',
      code: 'REQ-1',
      title: 'Camp Counsellor',
      status: 'OPEN',
      positionId: 'pos-1',
      employmentType: 'CASUAL',
    },
    candidate: {
      id: 'cand-1',
      organizationId: 'org-1',
      displayName: 'Ada Lovelace',
      firstName: 'Ada',
      lastName: 'Lovelace',
      preferredName: null,
      status: 'ACTIVE',
      source: 'DIRECT',
      internal: false,
      internalEmployee: null,
      mergedIntoCandidateId: null,
      hired: true,
      email: null,
      phone: null,
      location: null,
      notes: null,
      createdAt: '2026-09-02T00:00:00.000Z',
    },
    interviews: [],
    documents: [],
    dispositionReason: null,
    dispositionAt: null,
    transitions: [],
    activity: [],
    hire,
    screening: null,
    offers: [],
    actions: {
      canManage: false,
      canMoveStage: false,
      canScreen: false,
      canScheduleInterview: false,
      canWithdraw: false,
      canReject: false,
      canCreateOffer: false,
      canApproveOffer: false,
      canHire: false,
    },
  } as unknown as ApplicationDetail;

  it('starts onboarding for a hire and links to the workflow', async () => {
    auth(['recruitment.manage', 'onboarding.manage']);
    mocks.recruitment.application.mockResolvedValue(hiredApplication);
    api.startFromHire.mockResolvedValue({ ...workflow({ id: 'wf-7', view: 'HR' }), created: true });
    render(<ApplicationPage applicationId="app-1" />);
    const hired = await screen.findByRole('region', { name: 'Hired' });
    fireEvent.click(within(hired).getByRole('button', { name: 'Start onboarding' }));
    await waitFor(() => expect(api.startFromHire).toHaveBeenCalledWith('hire-1'));
    expect(await within(hired).findByText(/Onboarding started\./)).toBeInTheDocument();
    expect(within(hired).getByRole('link', { name: 'Open onboarding' })).toHaveAttribute(
      'href',
      '/onboarding/workflows/wf-7',
    );
  });

  it('hides the button without onboarding.manage and explains a refusal', async () => {
    auth(['recruitment.manage']);
    mocks.recruitment.application.mockResolvedValue(hiredApplication);
    render(<ApplicationPage applicationId="app-1" />);
    const hired = await screen.findByRole('region', { name: 'Hired' });
    expect(
      within(hired).queryByRole('button', { name: 'Start onboarding' }),
    ).not.toBeInTheDocument();
    cleanup();

    auth(['onboarding.manage']);
    api.startFromHire.mockRejectedValue(new AuthApiError('forbidden', 403));
    render(<ApplicationPage applicationId="app-1" />);
    const again = await screen.findByRole('region', { name: 'Hired' });
    fireEvent.click(within(again).getByRole('button', { name: 'Start onboarding' }));
    expect(
      await within(again).findByText(
        'You do not have permission to start onboarding for this hire.',
      ),
    ).toBeInTheDocument();
  });
});

describe('Batch 7A onboarding', () => {
  const emptyDashboard = (kind: 'ONBOARDING' | 'OFFBOARDING'): WorkflowDashboard => ({
    today: '2026-10-06',
    kind,
    items: [],
    attention: { overdueTasks: [], unassignedTasks: [], upcoming: [], coreHrPending: [] },
  });

  it('shows assigned tasks already done on request and explains when HR records the employee’s tasks', async () => {
    const own = task({ actions: { ...noActions } });
    api.mine.mockResolvedValue({ items: [workflow({ tasks: [own, handbook] })] });
    api.myTasks.mockResolvedValue({ items: [] });
    render(<MyOnboardingPage />);
    const mine = await screen.findByRole('region', { name: 'My onboarding — Counsellor' });
    const banking = within(mine).getByRole('listitem', { name: 'Task Submit banking details' });
    expect(within(banking).getByRole('note')).toHaveTextContent(/HR record this task for you/);
    expect(within(banking).queryByRole('button', { name: 'Complete' })).not.toBeInTheDocument();
    // The acknowledgement stays the employee's own act: no note there.
    const ack = within(mine).getByRole('listitem', { name: 'Task Staff Handbook' });
    expect(within(ack).queryByText(/HR record this task/)).not.toBeInTheDocument();

    expect(api.myTasks).toHaveBeenCalledWith(false);
    fireEvent.click(screen.getByLabelText('Show completed tasks'));
    await waitFor(() => expect(api.myTasks).toHaveBeenCalledWith(true));
    expect(await screen.findByText('No tasks are assigned to you.')).toBeInTheDocument();
  });

  it('starts onboarding prefilled from the employee profile, through the scoped picker', async () => {
    const employeeId = '11111111-1111-4111-8111-111111111111';
    const assignmentId = '22222222-2222-4222-8222-222222222222';
    window.history.replaceState(
      null,
      '',
      `/admin/onboarding?onboardEmployee=${employeeId}&onboardOrganization=org-1&onboardAssignment=${assignmentId}#start`,
    );
    auth(['onboarding.manage']);
    api.organizations.mockResolvedValue({ items: [organization({ offboarding: false })] });
    api.dashboard.mockImplementation((_org: string, kind: 'ONBOARDING' | 'OFFBOARDING') =>
      Promise.resolve(emptyDashboard(kind)),
    );
    api.templates.mockResolvedValue({ items: [] });
    api.startOnboarding.mockResolvedValue(
      workflow({
        view: 'HR',
        employee: { id: employeeId, employeeNumber: 'E-9', displayName: 'Ada Lovelace' },
      }),
    );
    mocks.employee.get.mockResolvedValue({
      id: employeeId,
      employeeNumber: 'E-9',
      person: { firstName: 'Ada', lastName: 'Lovelace', middleName: null, preferredName: null },
      assignments: {
        current: [],
        historical: [],
        upcoming: [
          {
            id: assignmentId,
            status: 'PLANNED',
            isPrimary: true,
            startDate: '2026-11-02',
            position: { id: 'pos-1', name: 'Counsellor', code: 'C' },
            organization: { id: 'org-1', name: 'Org', code: 'O' },
          },
        ],
      },
    });
    render(<OnboardingAdminPage />);
    const form = await screen.findByRole('form', { name: 'Start onboarding' });
    expect(within(form).getByRole('note')).toHaveTextContent(/Nothing has started/);
    expect(await within(form).findByDisplayValue('Ada Lovelace')).toBeInTheDocument();
    expect(api.startOnboarding).not.toHaveBeenCalled();
    fireEvent.click(within(form).getByRole('button', { name: 'Start onboarding' }));
    await waitFor(() =>
      expect(api.startOnboarding).toHaveBeenCalledWith({
        employmentAssignmentId: assignmentId,
        templateId: null,
      }),
    );
    expect(
      await screen.findByRole('link', { name: /Open Onboarding for Ada Lovelace/ }),
    ).toBeInTheDocument();
    window.history.replaceState(null, '', '/admin/onboarding');
  });

  it('picks a hire instead of typing its id and reports a restarted or an already started onboarding', async () => {
    auth(['onboarding.manage']);
    api.organizations.mockResolvedValue({ items: [organization({ offboarding: false })] });
    api.dashboard.mockResolvedValue(emptyDashboard('ONBOARDING'));
    api.templates.mockResolvedValue({ items: [] });
    api.options.mockResolvedValue({
      items: [
        {
          id: 'hire-1',
          label: 'Grace Hopper',
          description: 'E-12 · Counsellor · Starts 2026-11-02',
          restartable: true,
        },
      ],
      nextAfterId: null,
    });
    api.startFromHire.mockResolvedValueOnce({
      ...workflow({ id: 'wf-new', view: 'HR' }),
      created: true,
      restartedFromWorkflowId: 'wf-old',
    });
    render(<OnboardingAdminPage />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Start' }));
    const form = screen.getByRole('form', { name: 'Start onboarding from a hire' });
    expect(within(form).queryByLabelText('Hire ID')).not.toBeInTheDocument();
    fireEvent.change(within(form).getByLabelText(/^Hire/), { target: { value: 'Grace' } });
    const option = await within(form).findByRole(
      'option',
      { name: /Grace Hopper/ },
      { timeout: 2000 },
    );
    expect(option).toHaveTextContent(/Earlier onboarding cancelled/);
    expect(api.options).toHaveBeenCalledWith(
      'org-1',
      'hire',
      expect.objectContaining({ search: 'Grace' }),
    );
    fireEvent.click(option);
    fireEvent.click(within(form).getByRole('button', { name: 'Start from hire' }));
    await waitFor(() => expect(api.startFromHire).toHaveBeenCalledWith('hire-1', null));
    expect(
      await screen.findByRole('link', {
        name: /Onboarding restarted .* — Onboarding for Ada Lovelace/,
      }),
    ).toHaveAttribute('href', '/onboarding/workflows/wf-new');

    api.startFromHire.mockResolvedValueOnce({
      ...workflow({ id: 'wf-new', view: 'HR' }),
      created: false,
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Start from hire' }));
    expect(
      await screen.findByRole('link', { name: /Onboarding was already started for this hire/ }),
    ).toHaveAttribute('href', '/onboarding/workflows/wf-new');
  });

  it('offers Import only with organization-level manage and names the kinds it completes', async () => {
    // Team-scoped onboarding.manage: the import would be refused, so it is not offered.
    mocks.useAuth.mockReturnValue({
      authorizationLoading: false,
      authorization: {
        permissions: [{ key: 'onboarding.manage', scopes: [{ type: 'TEAM', id: 'team-1' }] }],
      },
    });
    // The organizations endpoint decides (organization-level manage per kind).
    api.organizations.mockResolvedValue({
      items: [
        organization({
          offboarding: false,
          canImportOnboarding: false,
          canImportOffboarding: false,
        }),
      ],
    });
    api.dashboard.mockResolvedValue(emptyDashboard('ONBOARDING'));
    render(<OnboardingAdminPage />);
    expect(await screen.findByRole('tab', { name: 'Start' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Import' })).not.toBeInTheDocument();
    cleanup();

    auth(['offboarding.manage', 'onboarding.read']);
    api.organizations.mockResolvedValue({
      items: [organization({ canImportOnboarding: false, canImportOffboarding: true })],
    });
    render(<OnboardingAdminPage />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Import' }));
    expect(
      screen.getByText(/Completes offboarding tasks only — the workflow kinds you manage/),
    ).toBeInTheDocument();
  });

  it('says when the dashboard lists only part of the workflows in scope', async () => {
    auth(['onboarding.read']);
    api.organizations.mockResolvedValue({ items: [organization({ offboarding: false })] });
    api.dashboard.mockResolvedValue({ ...emptyDashboard('ONBOARDING'), truncated: true });
    render(<OnboardingAdminPage />);
    expect(await screen.findByRole('note')).toHaveTextContent(/More are within your access/);
  });

  it('offers "no owner" only where the API accepts it: HR and manager tasks, never specific-user ones', async () => {
    const owned = { userId: 'u-1', email: 'it@example.org' };
    api.workflow.mockResolvedValue(
      hrWorkflow({
        tasks: [
          task({
            id: 'tk-mgr',
            title: 'Welcome meeting',
            ownerType: 'MANAGER',
            owner: owned,
            actions: { ...noActions, canReassign: true },
          }),
          task({
            id: 'tk-it',
            title: 'Disable accounts',
            ownerType: 'SPECIFIC_USER',
            owner: owned,
            actions: { ...noActions, canReassign: true },
          }),
          task({
            id: 'tk-hr',
            title: 'Exit paperwork',
            ownerType: 'HR',
            owner: owned,
            actions: { ...noActions, canReassign: true },
          }),
        ],
      }),
    );
    api.reassignTask.mockResolvedValue(hrWorkflow());
    render(<WorkflowPage workflowId="wf-1" />);
    const it = await screen.findByRole('row', { name: 'Task Disable accounts' });
    fireEvent.click(within(it).getByRole('button', { name: 'Reassign' }));
    expect(within(it).queryByRole('checkbox')).not.toBeInTheDocument();
    const hr = screen.getByRole('row', { name: 'Task Exit paperwork' });
    fireEvent.click(within(hr).getByRole('button', { name: 'Reassign' }));
    expect(within(hr).getByLabelText('Return to the HR pool')).toBeInTheDocument();
    const manager = screen.getByRole('row', { name: 'Task Welcome meeting' });
    fireEvent.click(within(manager).getByRole('button', { name: 'Reassign' }));
    fireEvent.click(within(manager).getByLabelText(/Remove the owner \(HR handles it/));
    fireEvent.click(within(manager).getByRole('button', { name: 'Save owner' }));
    await waitFor(() => expect(api.reassignTask).toHaveBeenCalledWith('tk-mgr', null));
  });
});
