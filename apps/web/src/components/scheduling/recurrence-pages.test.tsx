import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthApiError } from '../../lib/auth/types';
import type {
  GenerationResult,
  SchedulePattern,
  ScheduleTemplate,
} from '../../lib/scheduling/types';
import { SchedulePatternsPage } from './schedule-patterns-page';
import { ScheduleTemplatesPage } from './schedule-templates-page';

const api = vi.hoisted(() => ({
  listTemplates: vi.fn(),
  getTemplate: vi.fn(),
  createTemplate: vi.fn(),
  updateTemplate: vi.fn(),
  archiveTemplate: vi.fn(),
  deleteTemplate: vi.fn(),
  addTemplateRule: vi.fn(),
  deleteTemplateRule: vi.fn(),
  listPatterns: vi.fn(),
  createPattern: vi.fn(),
  patternFromTemplate: vi.fn(),
  endPattern: vi.fn(),
  deletePattern: vi.fn(),
  addPatternRule: vi.fn(),
  deletePatternRule: vi.fn(),
  generate: vi.fn(),
}));
const organizationApi = vi.hoisted(() => ({
  listUnits: vi.fn(),
  listDepartments: vi.fn(),
  listTeams: vi.fn(),
  listWorkLocations: vi.fn(),
}));
const employeeApi = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn() }));
const workspace = vi.hoisted(() => ({ current: {} as unknown }));

vi.mock('../../lib/scheduling/api', () => ({ schedulingApi: api }));
vi.mock('../../lib/organization/api', () => ({ organizationApi }));
vi.mock('../../lib/employee/api', () => ({ employeeApi }));
vi.mock('../../providers/workspace-provider', () => ({ useWorkspace: () => workspace.current }));
vi.mock('next/navigation', () => ({ usePathname: () => '/admin/scheduling/templates' }));

const ORG = 'org-hbl';
function useOrganization(permissions: string[]) {
  workspace.current = {
    status: 'ready',
    selectedOrganization: {
      id: ORG,
      name: 'Harbourline Foundation',
      code: 'HBL',
      timezone: 'America/Toronto',
      branding: null,
      enabledModules: ['SCHEDULING'],
      permissions,
      isEmployee: false,
      isManager: false,
    },
  };
}

const template: ScheduleTemplate = {
  id: 'tpl-1',
  organizationId: ORG,
  name: 'School mornings',
  description: null,
  rotationWeeks: 1,
  archivedAt: null,
  ruleCount: 0,
  createdAt: '',
  updatedAt: '',
};

const pattern: SchedulePattern = {
  id: 'pat-1',
  employmentAssignmentId: 'asg-hall',
  name: 'Evening sessions',
  effectiveFrom: '2026-10-01',
  effectiveTo: null,
  rotationWeeks: 1,
  anchorDate: '2026-09-28',
  sourceTemplateId: null,
  rules: [
    {
      id: 'r1',
      weekIndex: 0,
      dayOfWeek: 'FRIDAY',
      startLocalTime: '18:00',
      endLocalTime: '21:00',
      overnight: false,
      workLocationId: null,
      timezone: null,
      sortOrder: 0,
    },
  ],
  createdAt: '',
  updatedAt: '',
};

const generation = (overrides: Partial<GenerationResult>): GenerationResult => ({
  patternId: 'pat-1',
  employmentAssignmentId: 'asg-hall',
  range: { from: '2026-10-08', to: '2027-01-05' },
  created: 0,
  updated: 0,
  unchanged: 0,
  removed: 0,
  protected: 0,
  schedulesCreated: [],
  blocked: [],
  errors: [],
  notices: [],
  ...overrides,
});

const assignment = (id: string, position: string, unit: string) => ({
  id,
  employmentType: 'PART_TIME',
  status: 'ACTIVE',
  startDate: '2026-01-01',
  endDate: null,
  isPrimary: false,
  position: { id: `p-${id}`, name: position, code: id },
  jobTitle: { id: 'jt', name: position, code: 'JT' },
  organization: { id: ORG, name: 'Harbourline Foundation', code: 'HBL' },
  placement: { type: 'ORGANIZATIONAL_UNIT', id: unit, name: unit, code: unit },
  workLocation: null,
  manager: null,
});

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-08T15:00:00Z'));
  useOrganization([
    'schedule.read',
    'schedule.manage',
    'schedule.manage_templates',
    'schedule.manage_patterns',
  ]);
  organizationApi.listUnits.mockResolvedValue([]);
  organizationApi.listDepartments.mockResolvedValue([]);
  organizationApi.listTeams.mockResolvedValue([]);
  organizationApi.listWorkLocations.mockResolvedValue([]);
  api.listTemplates.mockResolvedValue({ items: [template], nextAfterId: null });
  api.getTemplate.mockResolvedValue({ ...template, rules: [] });
  api.listPatterns.mockResolvedValue({ items: [pattern] });
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
        assignment('asg-teacher', 'Teacher', 'Harbourline Academy'),
        assignment('asg-hall', 'Hall assistant', 'Community Hall'),
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

describe('ScheduleTemplatesPage', () => {
  it('creates a template and adds one rule per selected day, in order', async () => {
    api.createTemplate.mockResolvedValue({ ...template, rules: [] });
    api.addTemplateRule.mockResolvedValue({});
    render(<ScheduleTemplatesPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'New template' }));
    const form = screen.getByRole('form', { name: 'New template' });
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'School mornings' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Create template' }));
    await waitFor(() =>
      expect(api.createTemplate).toHaveBeenCalledWith({
        organizationId: ORG,
        name: 'School mornings',
        rotationWeeks: 1,
      }),
    );

    const ruleForm = await screen.findByRole('form', { name: 'Shift rule' });
    fireEvent.click(within(ruleForm).getByLabelText('Wed'));
    fireEvent.change(within(ruleForm).getByLabelText('Starts'), { target: { value: '08:00' } });
    fireEvent.change(within(ruleForm).getByLabelText(/^Ends/), { target: { value: '12:00' } });
    fireEvent.click(within(ruleForm).getByRole('button', { name: 'Add rule' }));
    await waitFor(() => expect(api.addTemplateRule).toHaveBeenCalledTimes(2));
    expect(api.addTemplateRule.mock.calls.map((call) => call[1].dayOfWeek)).toEqual([
      'MONDAY',
      'WEDNESDAY',
    ]);
    expect(api.addTemplateRule).toHaveBeenCalledWith('tpl-1', {
      weekIndex: 0,
      dayOfWeek: 'MONDAY',
      startLocalTime: '08:00',
      endLocalTime: '12:00',
    });
  });

  it('archives a template after confirmation and shows the API refusal for deleting an applied one', async () => {
    api.archiveTemplate.mockResolvedValue({});
    api.deleteTemplate.mockRejectedValue(
      new AuthApiError('conflict', 409, 'The template was applied; archive it instead.', {}),
    );
    render(<ScheduleTemplatesPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Manage School mornings' }));
    const panel = await screen.findByRole('region', { name: 'School mornings' });
    fireEvent.click(within(panel).getByRole('button', { name: 'Delete School mornings' }));
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete' }),
    );
    expect(
      await screen.findByText('The template was applied; archive it instead.'),
    ).toBeInTheDocument();

    fireEvent.click(
      within(screen.getByRole('region', { name: 'School mornings' })).getByRole('button', {
        name: 'Archive School mornings',
      }),
    );
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Archive' }),
    );
    await waitFor(() => expect(api.archiveTemplate).toHaveBeenCalledWith('tpl-1'));
  });

  it('is read-only without template management', async () => {
    useOrganization(['schedule.read']);
    render(<ScheduleTemplatesPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'View School mornings' }));
    await screen.findByRole('region', { name: 'School mornings' });
    expect(screen.queryByRole('button', { name: 'New template' })).not.toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Shift rule' })).not.toBeInTheDocument();
  });
});

async function chooseAssignment(id: string) {
  fireEvent.change(await screen.findByLabelText(/Employee \(name or employee number\)/), {
    target: { value: 'Ada' },
  });
  fireEvent.click(await screen.findByRole('option', { name: /Ada Lovelace/ }, { timeout: 2000 }));
  const select = await screen.findByLabelText('Assignment');
  await waitFor(() => expect(within(select).getAllByRole('option').length).toBe(3));
  fireEvent.change(select, { target: { value: id } });
}

describe('SchedulePatternsPage', () => {
  it('manages patterns per assignment for an employee with two positions', async () => {
    api.patternFromTemplate.mockResolvedValue(pattern);
    render(<SchedulePatternsPage />);
    await chooseAssignment('asg-hall');
    await waitFor(() => expect(api.listPatterns).toHaveBeenCalledWith('asg-hall'));
    expect(await screen.findByText('Evening sessions')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Patterns for Ada Lovelace' })).toHaveTextContent(
      'Hall assistant · Community Hall · Harbourline Foundation',
    );

    fireEvent.click(screen.getByRole('button', { name: 'New pattern' }));
    const form = screen.getByRole('form', { name: 'New pattern' });
    fireEvent.change(within(form).getByLabelText('Effective from'), {
      target: { value: '2026-10-15' },
    });
    fireEvent.change(within(form).getByLabelText(/^Template/), { target: { value: 'tpl-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create pattern' }));
    await waitFor(() =>
      expect(api.patternFromTemplate).toHaveBeenCalledWith('asg-hall', {
        effectiveFrom: '2026-10-15',
        anchorDate: '2026-10-12', // the Monday of the first week
        templateId: 'tpl-1',
      }),
    );
  });

  it('creates a custom pattern only with at least one rule', async () => {
    api.listTemplates.mockResolvedValue({ items: [], nextAfterId: null });
    api.createPattern.mockResolvedValue(pattern);
    render(<SchedulePatternsPage />);
    await chooseAssignment('asg-teacher');
    fireEvent.click(await screen.findByRole('button', { name: 'New pattern' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create pattern' }));
    expect(await screen.findByText('Add at least one shift rule.')).toBeInTheDocument();
    expect(api.createPattern).not.toHaveBeenCalled();

    const ruleForm = screen.getByRole('form', { name: 'Shift rule' });
    fireEvent.click(within(ruleForm).getByRole('button', { name: 'Add to pattern' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create pattern' }));
    await waitFor(() =>
      expect(api.createPattern).toHaveBeenCalledWith(
        'asg-teacher',
        expect.objectContaining({
          rotationWeeks: 1,
          rules: [
            { weekIndex: 0, dayOfWeek: 'MONDAY', startLocalTime: '09:00', endLocalTime: '17:00' },
          ],
        }),
      ),
    );
  });

  it('generates draft shifts and reports created, blocked and failed occurrences; a rerun creates nothing new', async () => {
    api.generate
      .mockResolvedValueOnce(
        generation({
          created: 12,
          schedulesCreated: ['s1', 's2'],
          blocked: [
            {
              patternId: 'pat-1',
              ruleId: 'r1',
              workDate: '2026-10-09',
              occurrenceKey: 'k1',
              code: 'EMPLOYEE_ASSIGNMENT_OVERLAP',
              message: 'Overlaps the Teacher shift.',
            },
          ],
          errors: [
            {
              patternId: 'pat-1',
              ruleId: 'r1',
              workDate: '2026-10-16',
              occurrenceKey: 'k2',
              code: 'SCHEDULE_PERIOD_PUBLISHED',
              message: 'The week is already published.',
            },
          ],
        }),
      )
      .mockResolvedValueOnce(generation({ unchanged: 12 }));
    render(<SchedulePatternsPage />);
    await chooseAssignment('asg-hall');
    fireEvent.click(await screen.findByRole('button', { name: /^Generate shifts for / }));
    fireEvent.click(
      within(screen.getByRole('form', { name: 'Generate shifts' })).getByRole('button', {
        name: 'Generate',
      }),
    );
    const summary = await screen.findByRole('region', { name: 'Generation summary' });
    const counts = within(summary).getByLabelText('Generation counts');
    expect(within(counts).getByText('Created').nextSibling).toHaveTextContent('12');
    expect(within(counts).getByText('Blocked').nextSibling).toHaveTextContent('1');
    expect(within(counts).getByText('Failed').nextSibling).toHaveTextContent('1');
    expect(summary).toHaveTextContent('2 weekly draft schedule(s) created');
    expect(summary).toHaveTextContent('Overlaps the Teacher shift.');
    expect(api.generate).toHaveBeenCalledWith('asg-hall', 'pat-1', {});

    fireEvent.click(screen.getByRole('button', { name: /^Generate shifts for / }));
    fireEvent.click(
      within(screen.getByRole('form', { name: 'Generate shifts' })).getByRole('button', {
        name: 'Generate',
      }),
    );
    await waitFor(() =>
      expect(
        within(
          within(screen.getByRole('region', { name: 'Generation summary' })).getByLabelText(
            'Generation counts',
          ),
        ).getByText('Unchanged').nextSibling,
      ).toHaveTextContent('12'),
    );
    expect(
      within(
        within(screen.getByRole('region', { name: 'Generation summary' })).getByLabelText(
          'Generation counts',
        ),
      ).getByText('Created').nextSibling,
    ).toHaveTextContent('0');
  });
});
