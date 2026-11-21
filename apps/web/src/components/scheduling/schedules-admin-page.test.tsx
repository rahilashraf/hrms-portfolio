import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthApiError } from '../../lib/auth/types';
import type { GridShift, Schedule, ScheduleConflict } from '../../lib/scheduling/types';
import { SchedulesAdminPage, loadRange } from './schedules-admin-page';

const api = vi.hoisted(() => ({
  grid: vi.fn(),
  listSchedules: vi.fn(),
  createSchedule: vi.fn(),
  updateSchedule: vi.fn(),
  deleteSchedule: vi.fn(),
  publishSchedule: vi.fn(),
  createShift: vi.fn(),
  updateShift: vi.fn(),
  deleteShift: vi.fn(),
  previewNewShift: vi.fn(),
  previewShiftUpdate: vi.fn(),
  addPublishedShift: vi.fn(),
  correctShift: vi.fn(),
  cancelShift: vi.fn(),
  revisions: vi.fn(),
}));
const organizationApi = vi.hoisted(() => ({
  listUnits: vi.fn(),
  listDepartments: vi.fn(),
  listTeams: vi.fn(),
  listWorkLocations: vi.fn(),
}));
const employeeApi = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn() }));
const workspace = vi.hoisted(() => ({ current: {} as unknown }));

vi.mock('../../lib/scheduling/api', () => ({ schedulingApi: api, GRID_MAX_DAYS: 62 }));
vi.mock('../../lib/organization/api', () => ({ organizationApi }));
vi.mock('../../lib/employee/api', () => ({ employeeApi }));
vi.mock('../../providers/workspace-provider', () => ({ useWorkspace: () => workspace.current }));
vi.mock('next/navigation', () => ({ usePathname: () => '/admin/scheduling' }));

const ORG = 'org-hbl';
const SCHEDULER = [
  'schedule.read',
  'schedule.manage',
  'schedule.publish',
  'schedule.manage_templates',
  'schedule.manage_patterns',
  'organization.read',
  'employee.read',
];

function useOrganization(permissions: string[]) {
  workspace.current = {
    status: 'ready',
    selectedOrganization: {
      id: ORG,
      name: 'Harbourline Foundation',
      code: 'HBL',
      timezone: 'America/Toronto',
      branding: null,
      enabledModules: ['SCHEDULING', 'ATTENDANCE'],
      permissions,
      isEmployee: false,
      isManager: false,
    },
  };
}

const draftSchedule: Schedule = {
  id: 'sch-draft',
  scopeType: 'ORGANIZATIONAL_UNIT',
  organizationId: ORG,
  organizationalUnitId: 'unit-school',
  departmentId: null,
  teamId: null,
  name: 'School week',
  periodStart: '2026-10-05',
  periodEnd: '2026-10-11',
  type: 'STANDARD',
  status: 'DRAFT',
  publishedAt: null,
  publishedByUserId: null,
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
};
const publishedSchedule: Schedule = {
  ...draftSchedule,
  id: 'sch-pub',
  name: 'Hall week',
  organizationalUnitId: 'unit-hall',
  status: 'PUBLISHED',
  publishedAt: '2026-10-02T00:00:00Z',
};

const actions = (overrides: Partial<GridShift['actions']> = {}): GridShift['actions'] => ({
  canEditDraft: false,
  canDeleteDraft: false,
  canPublish: false,
  canCorrect: false,
  canCancel: false,
  canOverrideConflict: false,
  canManagePattern: false,
  ...overrides,
});

function shift(overrides: Partial<GridShift>): GridShift {
  return {
    id: 'shift-1',
    scheduleId: draftSchedule.id,
    schedule: {
      id: draftSchedule.id,
      name: draftSchedule.name,
      status: 'DRAFT',
      type: 'STANDARD',
      scopeType: 'ORGANIZATIONAL_UNIT',
      periodStart: '2026-10-05',
      periodEnd: '2026-10-11',
    },
    employmentAssignmentId: 'asg-teacher',
    employee: { id: 'emp-1', employeeNumber: 'E-1', displayName: 'Ada Lovelace' },
    assignment: {
      id: 'asg-teacher',
      isPrimary: true,
      employmentType: 'PART_TIME',
      position: {
        id: 'pos-t',
        name: 'Teacher',
        code: 'T',
        organizationalUnitId: 'unit-school',
        departmentId: null,
        teamId: null,
      },
      organization: { id: ORG, name: 'Harbourline Foundation' },
    },
    workLocation: {
      id: 'loc-school',
      name: 'School building',
      code: 'SB',
      timezone: 'America/Toronto',
    },
    workDate: '2026-10-06',
    startsAt: '2026-10-06T12:00:00.000Z',
    endsAt: '2026-10-06T16:00:00.000Z',
    timezone: 'America/Toronto',
    durationMinutes: 240,
    status: 'ACTIVE',
    sourceType: 'MANUAL',
    sourcePatternId: null,
    currentRevision: null,
    actions: actions({ canEditDraft: true, canDeleteDraft: true }),
    ...overrides,
  };
}

const publishedShift = shift({
  id: 'shift-pub',
  scheduleId: publishedSchedule.id,
  schedule: {
    ...shift({}).schedule,
    id: publishedSchedule.id,
    name: 'Hall week',
    status: 'PUBLISHED',
  },
  employmentAssignmentId: 'asg-hall',
  assignment: {
    ...shift({}).assignment,
    id: 'asg-hall',
    isPrimary: false,
    position: {
      id: 'pos-i',
      name: 'Hall assistant',
      code: 'I',
      organizationalUnitId: 'unit-hall',
      departmentId: null,
      teamId: null,
    },
  },
  workDate: '2026-10-07',
  startsAt: '2026-10-07T21:00:00.000Z',
  endsAt: '2026-10-08T01:00:00.000Z',
  currentRevision: { id: 'rev-1', revisionNumber: 1, revisionType: 'PUBLISHED_BASELINE' },
  actions: actions({ canCorrect: true, canCancel: true }),
});

const conflict: ScheduleConflict = {
  key: 'a'.repeat(64),
  type: 'EMPLOYEE_ASSIGNMENT_OVERLAP',
  severity: 'WARNING',
  overrideAllowed: true,
  overridden: false,
  overrideId: null,
  message: 'Ada is already scheduled as Hall assistant at this time.',
  employeeId: 'emp-1',
  employmentAssignmentId: 'asg-teacher',
  conflictingShift: {
    id: 'shift-pub',
    scheduleId: 'sch-pub',
    employmentAssignmentId: 'asg-hall',
    workDate: '2026-10-07',
    startsAt: '2026-10-07T21:00:00.000Z',
    endsAt: '2026-10-08T01:00:00.000Z',
  },
  overlap: { startsAt: '2026-10-07T21:00:00.000Z', endsAt: '2026-10-07T22:00:00.000Z' },
};

const assignmentView = (
  id: string,
  position: string,
  unit: string,
  organization = { id: ORG, name: 'Harbourline Foundation', code: 'HBL' },
) => ({
  id,
  employmentType: 'PART_TIME' as const,
  status: 'ACTIVE' as const,
  startDate: '2026-01-01',
  endDate: null,
  isPrimary: id === 'asg-teacher',
  position: { id: `pos-${id}`, name: position, code: id },
  jobTitle: { id: 'jt', name: position, code: 'JT' },
  organization,
  placement: { type: 'ORGANIZATIONAL_UNIT' as const, id: `unit-${unit}`, name: unit, code: unit },
  workLocation: { id: 'loc-school', name: 'School building', code: 'SB' },
  manager: null,
});

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-07T15:00:00Z'));
  useOrganization(SCHEDULER);
  api.grid.mockResolvedValue({
    range: { from: '', to: '' },
    items: [shift({}), publishedShift],
    nextAfterId: null,
  });
  api.listSchedules.mockResolvedValue({
    items: [draftSchedule, publishedSchedule],
    nextAfterId: null,
  });
  api.revisions.mockResolvedValue({ items: [] });
  organizationApi.listUnits.mockResolvedValue([
    { id: 'unit-school', name: 'Harbourline Academy' },
    { id: 'unit-hall', name: 'Community Hall' },
  ]);
  organizationApi.listDepartments.mockResolvedValue([]);
  organizationApi.listTeams.mockResolvedValue([]);
  organizationApi.listWorkLocations.mockResolvedValue([
    { id: 'loc-school', name: 'School building', timezone: 'America/Toronto' },
  ]);
  employeeApi.list.mockResolvedValue({
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
  employeeApi.get.mockResolvedValue({
    id: 'emp-1',
    assignments: {
      current: [
        assignmentView('asg-teacher', 'Teacher', 'Harbourline Academy'),
        assignmentView('asg-hall', 'Hall assistant', 'Community Hall'),
        assignmentView('asg-other', 'Volunteer', 'Elsewhere', {
          id: 'org-other',
          name: 'Other org',
          code: 'O',
        }),
      ],
      upcoming: [],
      historical: [],
      cancelled: [],
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

async function pickEmployeeAssignment(form: HTMLElement, assignment: string) {
  fireEvent.change(within(form).getByLabelText(/Employee \(name or employee number\)/), {
    target: { value: 'Ada' },
  });
  fireEvent.click(
    await within(form).findByRole('option', { name: /Ada Lovelace/ }, { timeout: 2000 }),
  );
  const select = await within(form).findByLabelText('Assignment');
  await waitFor(() => expect(within(select).getAllByRole('option').length).toBeGreaterThan(1));
  fireEvent.change(select, { target: { value: assignment } });
}

describe('loadRange', () => {
  it('loads whole weeks for the month view and the exact range otherwise', () => {
    expect(loadRange('week', '2026-10-08')).toEqual({ from: '2026-10-05', to: '2026-10-11' });
    expect(loadRange('day', '2026-10-08')).toEqual({ from: '2026-10-08', to: '2026-10-08' });
    expect(loadRange('month', '2026-10-08')).toEqual({ from: '2026-09-28', to: '2026-11-01' });
  });
});

describe('SchedulesAdminPage', () => {
  it('shows draft and published shifts of several assignments in the week, with clear status', async () => {
    render(<SchedulesAdminPage />);
    const draftCard = await screen.findByRole('button', {
      name: /, Ada Lovelace, Teacher, 2026-10-06, draft$/,
    });
    const publishedCard = screen.getByRole('button', {
      name: /, Ada Lovelace, Hall assistant, 2026-10-07, published$/,
    });
    expect(draftCard).toHaveTextContent('Draft');
    expect(publishedCard).toHaveTextContent('Published');
    // Organization-scoped query for the visible week.
    expect(api.grid).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: ORG,
        from: '2026-10-05',
        to: '2026-10-11',
        limit: 200,
      }),
    );
    // Day view and month view are one click away.
    fireEvent.click(screen.getByRole('button', { name: 'month' }));
    await waitFor(() =>
      expect(api.grid).toHaveBeenLastCalledWith(
        expect.objectContaining({ from: '2026-09-28', to: '2026-11-01' }),
      ),
    );
  });

  it('filters by business unit and publication status', async () => {
    render(<SchedulesAdminPage />);
    await screen.findByRole('button', { name: /Teacher, 2026-10-06/ });
    fireEvent.change(await screen.findByLabelText('Business unit'), {
      target: { value: 'unit-hall' },
    });
    fireEvent.change(screen.getByLabelText('Publication'), { target: { value: 'PUBLISHED' } });
    await waitFor(() =>
      expect(api.grid).toHaveBeenLastCalledWith(
        expect.objectContaining({
          organizationalUnitId: 'unit-hall',
          scheduleStatus: 'PUBLISHED',
        }),
      ),
    );
  });

  it('creates and deletes a draft schedule', async () => {
    api.createSchedule.mockResolvedValue(draftSchedule);
    api.deleteSchedule.mockResolvedValue({ success: true });
    render(<SchedulesAdminPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'New schedule' }));
    const form = screen.getByRole('form', { name: 'New schedule' });
    fireEvent.change(within(form).getByLabelText('Name'), {
      target: { value: 'Hall holiday week' },
    });
    fireEvent.change(within(form).getByLabelText('Scope'), {
      target: { value: 'ORGANIZATIONAL_UNIT' },
    });
    fireEvent.change(await within(form).findByLabelText('Business unit'), {
      target: { value: 'unit-hall' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Create draft' }));
    await waitFor(() =>
      expect(api.createSchedule).toHaveBeenCalledWith({
        organizationId: ORG,
        scopeType: 'ORGANIZATIONAL_UNIT',
        organizationalUnitId: 'unit-hall',
        name: 'Hall holiday week',
        periodStart: '2026-10-05',
        periodEnd: '2026-10-11',
        type: 'STANDARD',
      }),
    );
    expect(await screen.findByText('Draft schedule created.')).toBeInTheDocument();

    const draftRow = screen.getByText('School week', { selector: 'p' }).closest('li')!;
    fireEvent.click(within(draftRow).getByRole('button', { name: 'Delete School week' }));
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Delete schedule',
      }),
    );
    await waitFor(() => expect(api.deleteSchedule).toHaveBeenCalledWith('sch-draft'));
    // A published schedule offers no edit or delete.
    const publishedRow = screen.getByText('Hall week', { selector: 'p' }).closest('li')!;
    expect(within(publishedRow).queryByRole('button', { name: /^Delete/ })).not.toBeInTheDocument();
    expect(
      within(publishedRow).queryByRole('button', { name: /^Publish/ }),
    ).not.toBeInTheDocument();
  });

  it('confirms publication and lists the shifts that block it', async () => {
    api.publishSchedule.mockRejectedValueOnce(
      new AuthApiError(
        'conflict',
        409,
        'The Schedule has unresolved scheduling conflicts and cannot be published.',
        {
          code: 'SCHEDULE_CONFLICT_OVERRIDE_REQUIRED',
          shifts: [{ shiftId: 'shift-1', conflicts: [conflict] }],
        },
      ),
    );
    render(<SchedulesAdminPage />);
    const row = (await screen.findByText('School week', { selector: 'p' })).closest('li')!;
    fireEvent.click(within(row).getByRole('button', { name: 'Publish School week' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent(/cannot be undone/);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Publish' }));
    const problems = await screen.findByText(/Publication of “School week” was refused/);
    expect(problems.closest('div')).toHaveTextContent('Ada Lovelace');
    expect(problems.closest('div')).toHaveTextContent(conflict.message);
    expect(screen.getByText(/conflicts without an override/)).toBeInTheDocument();

    api.publishSchedule.mockResolvedValueOnce({ ...draftSchedule, status: 'PUBLISHED' });
    fireEvent.click(within(row).getByRole('button', { name: 'Publish School week' }));
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Publish' }),
    );
    expect(await screen.findByText('“School week” published.')).toBeInTheDocument();
  });

  it('adds a draft shift for the chosen assignment, and overrides a cross-assignment overlap only with a reason', async () => {
    useOrganization([...SCHEDULER, 'schedule.override_conflict']);
    api.previewNewShift.mockResolvedValue({
      valid: true,
      overrideRequired: true,
      conflicts: [conflict],
    });
    api.createShift
      .mockRejectedValueOnce(
        new AuthApiError('conflict', 409, 'needs override', {
          code: 'SCHEDULE_CONFLICT_OVERRIDE_REQUIRED',
          conflicts: [conflict],
        }),
      )
      .mockResolvedValueOnce({ id: 'new' });
    render(<SchedulesAdminPage />);
    const row = (await screen.findByText('School week', { selector: 'p' })).closest('li')!;
    fireEvent.click(within(row).getByRole('button', { name: 'Add shift' }));
    const form = await screen.findByRole('form', { name: 'Add a draft shift' });
    await pickEmployeeAssignment(form, 'asg-teacher');
    // An assignment of another organization cannot be chosen.
    expect(
      within(form).getByRole('option', { name: /Volunteer.*other organization/ }),
    ).toBeDisabled();
    fireEvent.change(within(form).getByLabelText('Date'), { target: { value: '2026-10-07' } });
    fireEvent.change(within(form).getByLabelText('Starts'), { target: { value: '16:00' } });
    fireEvent.change(within(form).getByLabelText('Ends'), { target: { value: '18:00' } });

    fireEvent.click(within(form).getByRole('button', { name: 'Check conflicts' }));
    expect(await within(form).findByText(conflict.message)).toBeInTheDocument();
    expect(api.previewNewShift).toHaveBeenCalledWith('sch-draft', {
      employmentAssignmentId: 'asg-teacher',
      workLocationId: 'loc-school',
      workDate: '2026-10-07',
      startsAt: '2026-10-07T20:00:00.000Z',
      endsAt: '2026-10-07T22:00:00.000Z',
      timezone: 'America/Toronto',
    });

    // Saving without a reason sends no override; the API refuses and the conflict stays visible.
    fireEvent.click(within(form).getByRole('button', { name: 'Save shift' }));
    expect(await within(form).findByText(/need an override reason/)).toBeInTheDocument();
    expect(api.createShift.mock.calls[0]![1]).not.toHaveProperty('conflictOverrides');

    fireEvent.change(within(form).getByLabelText(/Override reason/), {
      target: { value: 'Covering the evening class' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Save shift' }));
    await waitFor(() =>
      expect(api.createShift).toHaveBeenLastCalledWith(
        'sch-draft',
        expect.objectContaining({
          employmentAssignmentId: 'asg-teacher',
          conflictOverrides: [
            {
              conflictType: 'EMPLOYEE_ASSIGNMENT_OVERLAP',
              conflictKey: conflict.key,
              reason: 'Covering the evening class',
            },
          ],
        }),
      ),
    );
    expect(await screen.findByText('Draft shift added.')).toBeInTheDocument();
  });

  it('cannot override without the permission', async () => {
    api.previewNewShift.mockResolvedValue({
      valid: true,
      overrideRequired: true,
      conflicts: [conflict],
    });
    render(<SchedulesAdminPage />);
    const row = (await screen.findByText('School week', { selector: 'p' })).closest('li')!;
    fireEvent.click(within(row).getByRole('button', { name: 'Add shift' }));
    const form = await screen.findByRole('form', { name: 'Add a draft shift' });
    await pickEmployeeAssignment(form, 'asg-teacher');
    fireEvent.click(within(form).getByRole('button', { name: 'Check conflicts' }));
    expect(
      await within(form).findByText(
        /Overriding needs the “Override schedule conflicts” permission/,
      ),
    ).toBeInTheDocument();
    expect(within(form).queryByLabelText(/Override reason/)).not.toBeInTheDocument();
  });

  it('edits and deletes a draft shift', async () => {
    api.updateShift.mockResolvedValue({});
    api.deleteShift.mockResolvedValue({ success: true });
    render(<SchedulesAdminPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Teacher, 2026-10-06/ }));
    const detail = screen.getByRole('region', { name: 'Shift details' });
    fireEvent.click(within(detail).getByRole('button', { name: 'Edit' }));
    const form = screen.getByRole('form', { name: 'Edit draft shift' });
    expect(within(form).getByLabelText('Starts')).toHaveValue('08:00');
    fireEvent.change(within(form).getByLabelText('Ends'), { target: { value: '13:00' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(api.updateShift).toHaveBeenCalledWith('sch-draft', 'shift-1', {
        endsAt: '2026-10-06T17:00:00.000Z',
        timezone: 'America/Toronto',
      }),
    );

    fireEvent.click(await screen.findByRole('button', { name: /Teacher, 2026-10-06/ }));
    fireEvent.click(
      within(screen.getByRole('region', { name: 'Shift details' })).getByRole('button', {
        name: 'Delete',
      }),
    );
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete shift' }),
    );
    await waitFor(() => expect(api.deleteShift).toHaveBeenCalledWith('sch-draft', 'shift-1'));
  });

  it('corrects and cancels published shifts only with a reason, keeping the revision history', async () => {
    api.revisions.mockResolvedValue({
      items: [
        {
          id: 'rev-1',
          scheduledShiftId: 'shift-pub',
          revisionNumber: 1,
          revisionType: 'PUBLISHED_BASELINE',
          employmentAssignmentId: 'asg-hall',
          workLocationId: null,
          workDate: '2026-10-07',
          startsAt: publishedShift.startsAt,
          endsAt: publishedShift.endsAt,
          timezone: 'America/Toronto',
          status: 'ACTIVE',
          sourceType: 'MANUAL',
          reason: null,
          changedByUserId: 'u',
          changedAt: '2026-10-02T00:00:00Z',
        },
      ],
    });
    api.correctShift.mockResolvedValue({});
    api.cancelShift.mockResolvedValue({});
    render(<SchedulesAdminPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Hall assistant, 2026-10-07/ }));
    const detail = screen.getByRole('region', { name: 'Shift details' });
    expect(await within(detail).findByText(/#1 Published/)).toBeInTheDocument();
    expect(within(detail).queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
    expect(within(detail).queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();

    fireEvent.click(within(detail).getByRole('button', { name: 'Correct' }));
    const form = screen.getByRole('form', { name: 'Correct a published shift' });
    fireEvent.change(within(form).getByLabelText('Ends'), { target: { value: '22:00' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save changes' }));
    expect(api.correctShift).not.toHaveBeenCalled();
    fireEvent.change(within(form).getByLabelText(/^Reason \(required\)/), {
      target: { value: 'Session time moved' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(api.correctShift).toHaveBeenCalledWith('sch-pub', 'shift-pub', {
        endsAt: '2026-10-08T02:00:00.000Z',
        timezone: 'America/Toronto',
        reason: 'Session time moved',
      }),
    );

    fireEvent.click(await screen.findByRole('button', { name: /Hall assistant, 2026-10-07/ }));
    const again = screen.getByRole('region', { name: 'Shift details' });
    fireEvent.click(within(again).getByRole('button', { name: 'Cancel shift' }));
    const cancelForm = screen.getByRole('form', { name: 'Cancel published shift' });
    fireEvent.change(within(cancelForm).getByLabelText(/^Reason \(required\)/), {
      target: { value: 'Event cancelled' },
    });
    fireEvent.click(within(cancelForm).getByRole('button', { name: 'Cancel shift' }));
    await waitFor(() =>
      expect(api.cancelShift).toHaveBeenCalledWith('sch-pub', 'shift-pub', 'Event cancelled'),
    );
  });

  it('shows published-add conflicts from a 409 instead of saving silently', async () => {
    useOrganization([...SCHEDULER, 'schedule.override_conflict']);
    api.addPublishedShift.mockRejectedValue(
      new AuthApiError('conflict', 409, 'blocking', {
        code: 'SCHEDULE_CONFLICT_ERROR',
        conflicts: [
          {
            ...conflict,
            severity: 'ERROR',
            overrideAllowed: false,
            type: 'SAME_ASSIGNMENT_OVERLAP',
          },
        ],
      }),
    );
    render(<SchedulesAdminPage />);
    const row = (await screen.findByText('Hall week')).closest('li')!;
    fireEvent.click(within(row).getByRole('button', { name: 'Add shift' }));
    const form = await screen.findByRole('form', { name: 'Add a shift to the published schedule' });
    await pickEmployeeAssignment(form, 'asg-hall');
    fireEvent.change(within(form).getByLabelText(/^Reason \(required\)/), {
      target: { value: 'Extra coverage' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Save shift' }));
    expect(
      await within(form).findByText(/blocking conflict and cannot be saved/),
    ).toBeInTheDocument();
    expect(within(form).getByText(/cannot be overridden/)).toBeInTheDocument();
    expect(api.addPublishedShift).toHaveBeenCalledWith(
      'sch-pub',
      expect.objectContaining({ employmentAssignmentId: 'asg-hall', reason: 'Extra coverage' }),
    );
  });

  it('hides management actions from read-only users and explains missing access', async () => {
    useOrganization(['schedule.read']);
    render(<SchedulesAdminPage />);
    await screen.findByText('School week', { selector: 'p' });
    expect(screen.queryByRole('button', { name: 'New schedule' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add shift' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Publish/ })).not.toBeInTheDocument();

    cleanup();
    useOrganization(['employee.read']);
    render(<SchedulesAdminPage />);
    expect(screen.getByText('No access')).toBeInTheDocument();
    expect(api.grid).toHaveBeenCalledTimes(1);
  });
});
