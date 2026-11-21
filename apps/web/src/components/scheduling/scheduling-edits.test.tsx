import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthApiError } from '../../lib/auth/types';
import type {
  RecurrenceRule,
  SchedulePattern,
  SchedulePolicy,
  ScheduleTemplate,
} from '../../lib/scheduling/types';
import { latestDateAnywhere } from '../../lib/scheduling/time';
import { expectNoAxeViolations } from '../../test/axe';
import { SchedulePatternsPage } from './schedule-patterns-page';
import { SchedulePoliciesPage } from './schedule-policies-page';
import { ScheduleTemplatesPage } from './schedule-templates-page';

/**
 * Batch R3.1: editing scheduling policies, template rules, recurring patterns and pattern rules
 * through the existing PATCH endpoints. The clock is fixed at 2026-10-08 15:00 UTC, so the latest
 * date anywhere (UTC+14) is 2026-10-09: anything starting on or before that day is in effect
 * somewhere and the API refuses to edit it.
 */

const api = vi.hoisted(() => ({
  listPolicies: vi.fn(),
  createPolicy: vi.fn(),
  updatePolicy: vi.fn(),
  endPolicy: vi.fn(),
  deletePolicy: vi.fn(),
  resolvePolicy: vi.fn(),
  listTemplates: vi.fn(),
  getTemplate: vi.fn(),
  createTemplate: vi.fn(),
  updateTemplate: vi.fn(),
  archiveTemplate: vi.fn(),
  deleteTemplate: vi.fn(),
  addTemplateRule: vi.fn(),
  updateTemplateRule: vi.fn(),
  deleteTemplateRule: vi.fn(),
  listPatterns: vi.fn(),
  createPattern: vi.fn(),
  patternFromTemplate: vi.fn(),
  updatePattern: vi.fn(),
  endPattern: vi.fn(),
  deletePattern: vi.fn(),
  addPatternRule: vi.fn(),
  updatePatternRule: vi.fn(),
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
vi.mock('next/navigation', () => ({ usePathname: () => '/admin/scheduling' }));

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

const SETTINGS_NONE = {
  generationHorizonDays: null,
  defaultSchedulePeriod: null,
  autoCreateSchedules: null,
  unscheduledWorkMode: null,
  clockInEarlyMinutes: null,
  clockInLateMinutes: null,
  overlapConflictSeverity: null,
  minimumRestMinutes: null,
  maximumShiftDurationMinutes: null,
  requireWorkLocation: null,
  allowManagerConflictOverride: null,
} as const;

function policy(overrides: Partial<SchedulePolicy>): SchedulePolicy {
  return {
    id: 'pol-future',
    scopeType: 'ORGANIZATION',
    organizationId: ORG,
    organizationalUnitId: null,
    departmentId: null,
    teamId: null,
    name: 'Winter rules',
    effectiveFrom: '2026-11-01',
    effectiveTo: null,
    createdAt: '',
    updatedAt: '',
    ...SETTINGS_NONE,
    minimumRestMinutes: 480,
    unscheduledWorkMode: 'WARN_UNSCHEDULED',
    ...overrides,
  };
}

const rule: RecurrenceRule = {
  id: 'r1',
  weekIndex: 0,
  dayOfWeek: 'FRIDAY',
  startLocalTime: '18:00',
  endLocalTime: '21:00',
  overnight: false,
  workLocationId: null,
  timezone: null,
  sortOrder: 0,
};

const template: ScheduleTemplate = {
  id: 'tpl-1',
  organizationId: ORG,
  name: 'School mornings',
  description: null,
  rotationWeeks: 1,
  archivedAt: null,
  ruleCount: 1,
  createdAt: '',
  updatedAt: '',
};

function pattern(overrides: Partial<SchedulePattern>): SchedulePattern {
  return {
    id: 'pat-1',
    employmentAssignmentId: 'asg-hall',
    name: 'Evening sessions',
    effectiveFrom: '2026-11-02',
    effectiveTo: null,
    rotationWeeks: 2,
    anchorDate: '2026-11-02',
    sourceTemplateId: null,
    rules: [{ ...rule, weekIndex: 1 }],
    createdAt: '',
    updatedAt: '',
    ...overrides,
  };
}

const ALL = [
  'schedule.read',
  'schedule.manage',
  'schedule.manage_policy',
  'schedule.manage_templates',
  'schedule.manage_patterns',
];

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-08T15:00:00Z'));
  useOrganization(ALL);
  organizationApi.listUnits.mockResolvedValue([]);
  organizationApi.listDepartments.mockResolvedValue([]);
  organizationApi.listTeams.mockResolvedValue([]);
  organizationApi.listWorkLocations.mockResolvedValue([]);
  api.listPolicies.mockResolvedValue({
    items: [
      policy({}),
      policy({ id: 'pol-boundary', name: 'Starts tomorrow', effectiveFrom: '2026-10-09' }),
      policy({ id: 'pol-current', name: 'Base rules', effectiveFrom: '2026-01-01' }),
    ],
    nextAfterId: null,
  });
  api.listTemplates.mockResolvedValue({ items: [template], nextAfterId: null });
  api.getTemplate.mockResolvedValue({ ...template, rules: [rule] });
  api.listPatterns.mockResolvedValue({ items: [pattern({})] });
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
        {
          id: 'asg-hall',
          status: 'ACTIVE',
          isPrimary: true,
          startDate: '2025-01-01',
          endDate: null,
          position: { id: 'pos-1', title: 'Hall assistant', organizationId: ORG },
          workLocation: { id: 'loc-1', name: 'Community Hall' },
          organization: { id: ORG, name: 'Harbourline Foundation' },
        },
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

describe('latestDateAnywhere', () => {
  it('is the calendar date at UTC+14, the API’s "has started anywhere" boundary', () => {
    expect(latestDateAnywhere(new Date('2026-10-08T15:00:00Z'))).toBe('2026-10-09');
    expect(latestDateAnywhere(new Date('2026-10-08T09:59:00Z'))).toBe('2026-10-08');
  });
});

describe('SchedulePoliciesPage: editing a policy', () => {
  it('offers Edit only for policies that have not taken effect anywhere', async () => {
    render(<SchedulePoliciesPage />);
    expect(await screen.findByRole('button', { name: /^Edit Winter rules/ })).toBeInTheDocument();
    // In effect, or starting on 2026-10-09 (already that day at UTC+14): the API would refuse.
    expect(screen.queryByRole('button', { name: /^Edit Base rules/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Edit Starts tomorrow/ })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /^Delete Starts tomorrow/ }),
    ).not.toBeInTheDocument();
  });

  it('shows the current values, sends only the changes and clears a setting with null', async () => {
    api.updatePolicy.mockResolvedValue(policy({ minimumRestMinutes: 600 }));
    render(<SchedulePoliciesPage />);
    fireEvent.click(await screen.findByRole('button', { name: /^Edit Winter rules/ }));
    const form = screen.getByRole('form', { name: 'Edit Winter rules' });
    expect(form).toHaveTextContent('Applies to Whole organization');
    const rest = within(form).getByLabelText('Minimum rest between shifts');
    expect(rest).toHaveValue(480);
    expect(within(form).getByLabelText(/^Unscheduled work/)).toHaveValue('WARN_UNSCHEDULED');
    expect(within(form).getByLabelText(/^Effective from/)).toHaveValue('2026-11-01');

    fireEvent.change(rest, { target: { value: '600' } });
    fireEvent.change(within(form).getByLabelText(/^Unscheduled work/), { target: { value: '' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save policy' }));

    await waitFor(() =>
      expect(api.updatePolicy).toHaveBeenCalledWith('pol-future', {
        minimumRestMinutes: 600,
        unscheduledWorkMode: null,
      }),
    );
    expect(await screen.findByText('Policy saved.')).toBeInTheDocument();
    expect(api.listPolicies).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('form', { name: 'Edit Winter rules' })).not.toBeInTheDocument();
  });

  it('validates locally: no empty policy, no unchanged save, no end before start', async () => {
    render(<SchedulePoliciesPage />);
    fireEvent.click(await screen.findByRole('button', { name: /^Edit Winter rules/ }));
    const form = screen.getByRole('form', { name: 'Edit Winter rules' });

    fireEvent.click(within(form).getByRole('button', { name: 'Save policy' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent('Nothing changed.');

    const to = within(form).getByLabelText(/^Effective to/);
    fireEvent.change(to, { target: { value: '2026-10-20' } });
    // The browser refuses the date itself (min = the first day); the form check is the fallback.
    expect(to).toBeInvalid();
    fireEvent.submit(form);
    expect(within(form).getByRole('alert')).toHaveTextContent('cannot be before the first day');

    fireEvent.change(within(form).getByLabelText(/^Effective to/), { target: { value: '' } });
    fireEvent.change(within(form).getByLabelText('Minimum rest between shifts'), {
      target: { value: '' },
    });
    fireEvent.change(within(form).getByLabelText(/^Unscheduled work/), { target: { value: '' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save policy' }));
    expect(within(form).getByRole('alert')).toHaveTextContent('at least one setting');
    expect(api.updatePolicy).not.toHaveBeenCalled();
  });

  it('keeps the form open and shows the API refusal', async () => {
    api.updatePolicy.mockRejectedValue(
      new AuthApiError('conflict', 409, 'The period overlaps another policy for this scope.', {}),
    );
    render(<SchedulePoliciesPage />);
    fireEvent.click(await screen.findByRole('button', { name: /^Edit Winter rules/ }));
    const form = screen.getByRole('form', { name: 'Edit Winter rules' });
    fireEvent.change(within(form).getByLabelText(/^Effective from/), {
      target: { value: '2026-11-15' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Save policy' }));
    expect(await screen.findByText(/overlaps another policy/)).toBeInTheDocument();
    expect(screen.getByRole('form', { name: 'Edit Winter rules' })).toBeInTheDocument();
  });

  it('keeps focus in the form under StrictMode, whose effects run twice in development (R4-A.7)', async () => {
    render(
      <StrictMode>
        <SchedulePoliciesPage />
      </StrictMode>,
    );
    const edit = await screen.findByRole('button', { name: /^Edit Winter rules/ });
    edit.focus();
    fireEvent.click(edit);
    const form = screen.getByRole('form', { name: 'Edit Winter rules' });
    const name = within(form).getByLabelText('Name (optional)');
    expect(name).toHaveFocus();
    // Let any restore queued by the first (development-only) effect run: timers of the same
    // delay run in order, so this one runs after it.
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    expect(name).toHaveFocus();
    // Closing still returns focus to the Edit button (the opener, not the field).
    fireEvent.click(within(form).getByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^Edit Winter rules/ })).toHaveFocus(),
    );
  });

  it('moves focus into the form, shows a refusal once inside it, and returns focus on cancel (R4-A.7)', async () => {
    api.updatePolicy.mockRejectedValue(
      new AuthApiError('conflict', 409, 'The period overlaps another policy for this scope.', {}),
    );
    render(<SchedulePoliciesPage />);
    const edit = await screen.findByRole('button', { name: /^Edit Winter rules/ });
    edit.focus();
    fireEvent.click(edit);
    const form = screen.getByRole('form', { name: 'Edit Winter rules' });
    // Focus starts in the form (its first field).
    expect(form.contains(document.activeElement)).toBe(true);
    expect(within(form).getByLabelText('Name (optional)')).toHaveFocus();

    fireEvent.change(within(form).getByLabelText(/^Effective from/), {
      target: { value: '2026-11-15' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Save policy' }));
    const alert = await within(form).findByRole('alert');
    expect(alert).toHaveTextContent(/overlaps another policy/);
    // Announced once: the page banner does not repeat it.
    expect(screen.getAllByText(/overlaps another policy/)).toHaveLength(1);

    fireEvent.click(within(form).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('form', { name: 'Edit Winter rules' })).not.toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^Edit Winter rules/ })).toHaveFocus(),
    );
    // Opening again starts clean.
    fireEvent.click(screen.getByRole('button', { name: /^Edit Winter rules/ }));
    expect(
      within(screen.getByRole('form', { name: 'Edit Winter rules' })).queryByRole('alert'),
    ).not.toBeInTheDocument();
  });

  it('shows no edit controls without schedule.manage_policy', async () => {
    useOrganization(['schedule.read']);
    render(<SchedulePoliciesPage />);
    expect(await screen.findByText(/Winter rules/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Edit / })).not.toBeInTheDocument();
  });
});

describe('ScheduleTemplatesPage: editing a rule', () => {
  it('edits one rule of an active template and refreshes it', async () => {
    api.updateTemplateRule.mockResolvedValue({ ...rule, endLocalTime: '22:00' });
    render(<ScheduleTemplatesPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Manage School mornings' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Friday 18:00 rule' }));
    const form = screen.getByRole('form', { name: 'Edit Friday 18:00 rule' });
    expect(within(form).getByLabelText('Day')).toHaveValue('FRIDAY');
    expect(within(form).getByLabelText('Starts')).toHaveValue('18:00');
    fireEvent.change(within(form).getByLabelText(/^Ends/), { target: { value: '22:00' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save rule' }));

    await waitFor(() =>
      expect(api.updateTemplateRule).toHaveBeenCalledWith('tpl-1', 'r1', { endLocalTime: '22:00' }),
    );
    expect(await screen.findByText('Rule saved.')).toBeInTheDocument();
    expect(api.getTemplate).toHaveBeenCalledTimes(2);
  });

  it('focuses the rule form, keeps a refusal inside it, and returns focus to the rule on cancel (R4-A.7)', async () => {
    api.updateTemplateRule.mockRejectedValue(
      new AuthApiError('conflict', 409, 'The rule overlaps another rule.', {}),
    );
    render(<ScheduleTemplatesPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Manage School mornings' }));
    const edit = await screen.findByRole('button', { name: 'Edit Friday 18:00 rule' });
    edit.focus();
    fireEvent.click(edit);
    const form = screen.getByRole('form', { name: 'Edit Friday 18:00 rule' });
    expect(form.contains(document.activeElement)).toBe(true);
    fireEvent.change(within(form).getByLabelText(/^Ends/), { target: { value: '22:00' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save rule' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent(
      'The rule overlaps another rule.',
    );
    expect(screen.getAllByText('The rule overlaps another rule.')).toHaveLength(1);
    fireEvent.click(within(form).getByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Edit Friday 18:00 rule' })).toHaveFocus(),
    );
  });

  it('does not offer rule edits on an archived template or without template management', async () => {
    api.listTemplates.mockResolvedValue({
      items: [{ ...template, archivedAt: '2026-10-01T00:00:00Z' }],
      nextAfterId: null,
    });
    api.getTemplate.mockResolvedValue({
      ...template,
      archivedAt: '2026-10-01T00:00:00Z',
      rules: [rule],
    });
    render(<ScheduleTemplatesPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'View School mornings' }));
    await screen.findByText('18:00–21:00');
    expect(screen.queryByRole('button', { name: /^Edit Friday/ })).not.toBeInTheDocument();

    cleanup();
    useOrganization(['schedule.read']);
    api.listTemplates.mockResolvedValue({ items: [template], nextAfterId: null });
    api.getTemplate.mockResolvedValue({ ...template, rules: [rule] });
    render(<ScheduleTemplatesPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'View School mornings' }));
    await screen.findByText('18:00–21:00');
    expect(screen.queryByRole('button', { name: /^Edit Friday/ })).not.toBeInTheDocument();
  });
});

async function choosePatternsFor() {
  fireEvent.change(await screen.findByLabelText(/Employee \(name or employee number\)/), {
    target: { value: 'Ada' },
  });
  fireEvent.click(await screen.findByRole('option', { name: /Ada Lovelace/ }, { timeout: 2000 }));
  const select = await screen.findByLabelText('Assignment');
  await waitFor(() => expect(within(select).getAllByRole('option').length).toBe(2));
  fireEvent.change(select, { target: { value: 'asg-hall' } });
  await screen.findAllByText('Evening sessions');
}

describe('SchedulePatternsPage: editing a pattern and its rules', () => {
  it('edits a pattern that has not started, sending only the changes', async () => {
    api.updatePattern.mockResolvedValue(pattern({ name: 'Evening sessions (winter)' }));
    render(<SchedulePatternsPage />);
    await choosePatternsFor();
    fireEvent.click(screen.getByRole('button', { name: 'Edit pattern Evening sessions' }));
    const form = screen.getByRole('form', { name: 'Edit Evening sessions' });
    expect(within(form).getByLabelText(/^First day/)).toHaveValue('2026-11-02');
    expect(within(form).getByLabelText('Rotation weeks')).toHaveValue(2);
    fireEvent.change(within(form).getByLabelText('Name (optional)'), {
      target: { value: 'Evening sessions (winter)' },
    });
    fireEvent.change(within(form).getByLabelText(/^Last day/), {
      target: { value: '2027-03-31' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Save pattern' }));
    await waitFor(() =>
      expect(api.updatePattern).toHaveBeenCalledWith('asg-hall', 'pat-1', {
        name: 'Evening sessions (winter)',
        effectiveTo: '2027-03-31',
      }),
    );
    expect(await screen.findByText(/Pattern saved/)).toBeInTheDocument();
    expect(api.listPatterns).toHaveBeenCalledTimes(2);
  });

  it('refuses a rotation shorter than the weeks its rules use', async () => {
    render(<SchedulePatternsPage />);
    await choosePatternsFor();
    fireEvent.click(screen.getByRole('button', { name: 'Edit pattern Evening sessions' }));
    const form = screen.getByRole('form', { name: 'Edit Evening sessions' });
    fireEvent.change(within(form).getByLabelText('Rotation weeks'), { target: { value: '1' } });
    fireEvent.submit(form);
    expect(within(form).getByRole('alert')).toHaveTextContent('use 2 rotation weeks');
    expect(api.updatePattern).not.toHaveBeenCalled();
  });

  it('refuses a rotation start that is not a Monday (the API counts weeks from a Monday)', async () => {
    api.updatePattern.mockResolvedValue(pattern({ anchorDate: '2026-11-09' }));
    render(<SchedulePatternsPage />);
    await choosePatternsFor();
    fireEvent.click(screen.getByRole('button', { name: 'Edit pattern Evening sessions' }));
    const form = screen.getByRole('form', { name: 'Edit Evening sessions' });
    const anchor = within(form).getByLabelText(/^Rotation starts on/);
    // 2026-11-11 is a Wednesday.
    fireEvent.change(anchor, { target: { value: '2026-11-11' } });
    fireEvent.submit(form);
    expect(within(form).getByRole('alert')).toHaveTextContent('must start on a Monday');
    expect(api.updatePattern).not.toHaveBeenCalled();

    fireEvent.change(anchor, { target: { value: '2026-11-09' } });
    fireEvent.submit(form);
    await waitFor(() =>
      expect(api.updatePattern).toHaveBeenCalledWith('asg-hall', 'pat-1', {
        anchorDate: '2026-11-09',
      }),
    );
  });

  it('edits one rule of a pattern that has not started', async () => {
    api.updatePatternRule.mockResolvedValue({ ...rule, weekIndex: 1, dayOfWeek: 'SATURDAY' });
    render(<SchedulePatternsPage />);
    await choosePatternsFor();
    fireEvent.click(screen.getByRole('button', { name: 'Edit Friday 18:00 rule' }));
    const form = screen.getByRole('form', { name: 'Edit Friday 18:00 rule' });
    expect(within(form).getByLabelText('Rotation week')).toHaveValue('1');
    fireEvent.change(within(form).getByLabelText('Day'), { target: { value: 'SATURDAY' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save rule' }));
    await waitFor(() =>
      expect(api.updatePatternRule).toHaveBeenCalledWith('asg-hall', 'pat-1', 'r1', {
        dayOfWeek: 'SATURDAY',
      }),
    );
    expect(await screen.findByText('Rule saved.')).toBeInTheDocument();
  });

  it('offers no edits once the pattern has started anywhere', async () => {
    api.listPatterns.mockResolvedValue({ items: [pattern({ effectiveFrom: '2026-10-09' })] });
    render(<SchedulePatternsPage />);
    await choosePatternsFor();
    expect(screen.queryByRole('button', { name: /^Edit pattern/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Edit Friday/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Set end date for/ })).toBeInTheDocument();
  });

  it('offers no edits without schedule.manage_patterns', async () => {
    useOrganization(['schedule.read']);
    render(<SchedulePatternsPage />);
    await choosePatternsFor();
    expect(screen.queryByRole('button', { name: /^Edit pattern/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Edit Friday/ })).not.toBeInTheDocument();
  });
});

describe('edit forms: accessibility', () => {
  it('has no axe violations in the policy, template-rule, pattern and pattern-rule edit forms', async () => {
    const policyView = render(<SchedulePoliciesPage />);
    fireEvent.click(await screen.findByRole('button', { name: /^Edit Winter rules/ }));
    await expectNoAxeViolations(screen.getByRole('form', { name: 'Edit Winter rules' }));
    policyView.unmount();

    const templateView = render(<ScheduleTemplatesPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Manage School mornings' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Friday 18:00 rule' }));
    await expectNoAxeViolations(screen.getByRole('form', { name: 'Edit Friday 18:00 rule' }));
    templateView.unmount();

    render(<SchedulePatternsPage />);
    await choosePatternsFor();
    fireEvent.click(screen.getByRole('button', { name: 'Edit pattern Evening sessions' }));
    await expectNoAxeViolations(screen.getByRole('form', { name: 'Edit Evening sessions' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit Friday 18:00 rule' }));
    await expectNoAxeViolations(screen.getByRole('form', { name: 'Edit Friday 18:00 rule' }));
  });
});
