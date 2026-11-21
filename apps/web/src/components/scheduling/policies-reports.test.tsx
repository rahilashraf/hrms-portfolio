import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SchedulePolicy } from '../../lib/scheduling/types';
import { ScheduledHoursPage } from './scheduled-hours-page';
import { SchedulePoliciesPage, settingsFrom } from './schedule-policies-page';

const api = vi.hoisted(() => ({
  listPolicies: vi.fn(),
  createPolicy: vi.fn(),
  endPolicy: vi.fn(),
  deletePolicy: vi.fn(),
  resolvePolicy: vi.fn(),
  scheduledHours: vi.fn(),
  listSchedules: vi.fn(),
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
vi.mock('next/navigation', () => ({ usePathname: () => '/admin/scheduling/policies' }));

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

const NULL_SETTINGS = {
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

const policy: SchedulePolicy = {
  ...NULL_SETTINGS,
  id: 'pol-1',
  scopeType: 'ORGANIZATIONAL_UNIT',
  organizationId: ORG,
  organizationalUnitId: 'unit-school',
  departmentId: null,
  teamId: null,
  name: 'School rules',
  effectiveFrom: '2026-09-01',
  effectiveTo: null,
  minimumRestMinutes: 600,
  unscheduledWorkMode: 'REQUIRE_SCHEDULED_SHIFT',
  createdAt: '',
  updatedAt: '',
};

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-08T15:00:00Z'));
  useOrganization(['schedule.read', 'schedule.manage_policy', 'organization.read']);
  organizationApi.listUnits.mockResolvedValue([{ id: 'unit-school', name: 'Harbourline Academy' }]);
  organizationApi.listDepartments.mockResolvedValue([]);
  organizationApi.listTeams.mockResolvedValue([]);
  organizationApi.listWorkLocations.mockResolvedValue([]);
  api.listPolicies.mockResolvedValue({ items: [policy], nextAfterId: null });
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe('settingsFrom', () => {
  it('sends only explicitly set values, typed', () => {
    const form = new FormData();
    form.set('minimumRestMinutes', '480');
    form.set('allowManagerConflictOverride', 'false');
    form.set('unscheduledWorkMode', '');
    expect(settingsFrom(form)).toEqual({
      minimumRestMinutes: 480,
      allowManagerConflictOverride: false,
    });
  });
});

describe('SchedulePoliciesPage', () => {
  it('lists effective-dated layers with their explicit settings', async () => {
    render(<SchedulePoliciesPage />);
    const item = (await screen.findByText(/School rules/)).closest('li')!;
    expect(item).toHaveTextContent('Business unit: Harbourline Academy');
    expect(item).toHaveTextContent('In effect');
    expect(item).toHaveTextContent('Minimum rest between shifts600 min');
    expect(item).toHaveTextContent('Require a published shift');
    expect(item).not.toHaveTextContent('Maximum shift duration');
  });

  it('adds a layer with only the chosen settings and ends a layer without rewriting it', async () => {
    api.createPolicy.mockResolvedValue(policy);
    api.endPolicy.mockResolvedValue(policy);
    render(<SchedulePoliciesPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'New policy' }));
    const form = screen.getByRole('form', { name: 'New scheduling policy' });
    fireEvent.change(within(form).getByLabelText(/^Unscheduled work/), {
      target: { value: 'WARN_UNSCHEDULED' },
    });
    fireEvent.change(within(form).getByLabelText('Maximum shift duration'), {
      target: { value: '720' },
    });
    fireEvent.change(within(form).getByLabelText('Effective from'), {
      target: { value: '2026-11-01' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Add policy' }));
    await waitFor(() =>
      expect(api.createPolicy).toHaveBeenCalledWith({
        organizationId: ORG,
        scopeType: 'ORGANIZATION',
        effectiveFrom: '2026-11-01',
        unscheduledWorkMode: 'WARN_UNSCHEDULED',
        maximumShiftDurationMinutes: 720,
      }),
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Set end date' }));
    const endForm = screen.getByRole('form', { name: 'End policy' });
    fireEvent.change(within(endForm).getByLabelText('Last day in effect'), {
      target: { value: '2026-12-31' },
    });
    fireEvent.click(within(endForm).getByRole('button', { name: 'Set end date' }));
    await waitFor(() => expect(api.endPolicy).toHaveBeenCalledWith('pol-1', '2026-12-31'));
    // A layer already in effect cannot be deleted from the UI.
    expect(screen.queryByRole('button', { name: /^Delete/ })).not.toBeInTheDocument();
  });

  it('shows the effective settings of an assignment and where each comes from', async () => {
    employeeApi.list.mockResolvedValue({
      items: [
        {
          id: 'emp-1',
          employeeNumber: 'E-1',
          status: 'ACTIVE',
          person: { firstName: 'Ada', lastName: 'L', middleName: null, preferredName: null },
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
            id: 'asg-teacher',
            status: 'ACTIVE',
            isPrimary: true,
            startDate: '2026-01-01',
            position: { id: 'p', name: 'Teacher', code: 'T' },
            organization: { id: ORG, name: 'Harbourline Foundation', code: 'HBL' },
            placement: {
              type: 'ORGANIZATIONAL_UNIT',
              id: 'unit-school',
              name: 'Harbourline Academy',
              code: 'S',
            },
            workLocation: null,
          },
        ],
        upcoming: [],
        historical: [],
        cancelled: [],
      },
    });
    api.resolvePolicy.mockResolvedValue({
      employmentAssignmentId: 'asg-teacher',
      date: '2026-10-08',
      generationHorizonDays: 90,
      defaultSchedulePeriod: 'WEEKLY',
      autoCreateSchedules: true,
      unscheduledWorkMode: 'REQUIRE_SCHEDULED_SHIFT',
      clockInEarlyMinutes: 60,
      clockInLateMinutes: 120,
      overlapConflictSeverity: 'WARNING',
      minimumRestMinutes: 600,
      maximumShiftDurationMinutes: null,
      requireWorkLocation: false,
      allowManagerConflictOverride: true,
      sources: {
        unscheduledWorkMode: { policyId: 'pol-1', scopeType: 'ORGANIZATIONAL_UNIT' },
        minimumRestMinutes: { policyId: 'pol-1', scopeType: 'ORGANIZATIONAL_UNIT' },
        clockInEarlyMinutes: 'DEFAULT',
      },
    });
    render(<SchedulePoliciesPage />);
    const panel = await screen.findByRole('region', { name: 'Effective policy for an assignment' });
    fireEvent.change(within(panel).getByLabelText(/Employee \(name or employee number\)/), {
      target: { value: 'Ada' },
    });
    fireEvent.click(await within(panel).findByRole('option', { name: /Ada L/ }, { timeout: 2000 }));
    const select = await within(panel).findByLabelText('Assignment');
    await waitFor(() => expect(within(select).getAllByRole('option').length).toBe(2));
    fireEvent.change(select, { target: { value: 'asg-teacher' } });
    const table = await within(panel).findByRole('table', { name: 'Effective settings' });
    expect(api.resolvePolicy).toHaveBeenCalledWith('asg-teacher', '2026-10-08');
    const row = within(table).getByText('Unscheduled work').closest('tr')!;
    expect(row).toHaveTextContent('Require a published shift');
    expect(row).toHaveTextContent('Business unit policy');
    expect(
      within(table).getByText('Clock-in opens before the shift').closest('tr'),
    ).toHaveTextContent('Built-in default');
  });

  it('is read-only without policy management', async () => {
    useOrganization(['schedule.read']);
    render(<SchedulePoliciesPage />);
    await screen.findByText(/School rules/);
    expect(screen.queryByRole('button', { name: 'New policy' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Set end date' })).not.toBeInTheDocument();
  });
});

describe('ScheduledHoursPage', () => {
  it('runs the existing report for published active shifts and totals the groups', async () => {
    useOrganization(['schedule.read', 'organization.read']);
    api.scheduledHours.mockResolvedValue({
      range: { from: '2026-10-05', to: '2026-10-11' },
      groupBy: 'organizationalUnit',
      filters: { status: 'ACTIVE', scheduleStatus: 'PUBLISHED' },
      groups: [
        { key: 'unit-school', shiftCount: 10, scheduledMinutes: 2400 },
        { key: null, shiftCount: 1, scheduledMinutes: 90 },
      ],
      nextAfterKey: null,
    });
    render(<ScheduledHoursPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Run report' }));
    const table = await screen.findByRole('table', { name: 'Scheduled hours' });
    expect(api.scheduledHours).toHaveBeenCalledWith({
      organizationId: ORG,
      from: '2026-10-05',
      to: '2026-10-11',
      groupBy: 'organizationalUnit',
      scheduleStatus: 'PUBLISHED',
      status: 'ACTIVE',
    });
    expect(within(table).getByText('Harbourline Academy').closest('tr')).toHaveTextContent('1040');
    expect(within(table).getByText('Total').closest('tr')).toHaveTextContent('Total1141.50');
  });

  it('refuses ranges longer than the API allows', async () => {
    useOrganization(['schedule.read']);
    render(<ScheduledHoursPage />);
    fireEvent.change(await screen.findByLabelText('From'), { target: { value: '2026-08-01' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run report' }));
    expect(await screen.findByText('The range can cover at most 62 days.')).toBeInTheDocument();
    expect(api.scheduledHours).not.toHaveBeenCalled();
  });
});
