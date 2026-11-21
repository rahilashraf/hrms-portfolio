import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthApiError } from '../../lib/auth/types';
import type { ScheduleScopeType, SchedulePolicy } from '../../lib/scheduling/types';
import { expectNoAxeViolations } from '../../test/axe';
import { SchedulePoliciesPage } from './schedule-policies-page';
import { Field, ScopeFields, inputClass, useStructure } from './scheduling-shared';

const api = vi.hoisted(() => ({
  listPolicies: vi.fn(),
  createPolicy: vi.fn(),
  endPolicy: vi.fn(),
  deletePolicy: vi.fn(),
}));
const organizationApi = vi.hoisted(() => ({
  listUnits: vi.fn(),
  listDepartments: vi.fn(),
  listTeams: vi.fn(),
  listWorkLocations: vi.fn(),
}));
const workspace = vi.hoisted(() => ({ current: {} as unknown }));

vi.mock('../../lib/scheduling/api', () => ({ schedulingApi: api, GRID_MAX_DAYS: 62 }));
vi.mock('../../lib/organization/api', () => ({ organizationApi }));
vi.mock('../../lib/employee/api', () => ({ employeeApi: { list: vi.fn(), get: vi.fn() } }));
vi.mock('../../providers/workspace-provider', () => ({ useWorkspace: () => workspace.current }));
vi.mock('next/navigation', () => ({ usePathname: () => '/admin/scheduling/policies' }));

const ORG = 'org-1';
const unavailable = () => new AuthApiError('service-unavailable', 503);
const forbidden = () => new AuthApiError('forbidden', 403);

const policy: SchedulePolicy = {
  id: 'pol-1',
  scopeType: 'ORGANIZATION',
  organizationId: ORG,
  organizationalUnitId: null,
  departmentId: null,
  teamId: null,
  name: 'Weekday rules',
  effectiveFrom: '2026-09-01',
  effectiveTo: null,
  generationHorizonDays: null,
  defaultSchedulePeriod: null,
  autoCreateSchedules: null,
  unscheduledWorkMode: null,
  clockInEarlyMinutes: null,
  clockInLateMinutes: null,
  overlapConflictSeverity: null,
  minimumRestMinutes: 480,
  maximumShiftDurationMinutes: null,
  requireWorkLocation: null,
  allowManagerConflictOverride: null,
  createdAt: '',
  updatedAt: '',
};

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  workspace.current = {
    status: 'ready',
    selectedOrganization: {
      id: ORG,
      name: 'Example Organization',
      code: 'EX',
      timezone: 'America/Toronto',
      branding: null,
      enabledModules: ['SCHEDULING'],
      permissions: ['schedule.read', 'schedule.manage_policy', 'organization.read'],
      isEmployee: false,
      isManager: false,
    },
  };
  organizationApi.listUnits.mockResolvedValue([{ id: 'unit-1', name: 'Operations' }]);
  organizationApi.listDepartments.mockResolvedValue([{ id: 'dep-1', name: 'Reception' }]);
  organizationApi.listTeams.mockResolvedValue([]);
  organizationApi.listWorkLocations.mockResolvedValue([]);
});

afterEach(cleanup);

describe('Scheduling load failures', () => {
  it('shows a failed policy list as an error with a retry, never as "no policies"', async () => {
    api.listPolicies
      .mockRejectedValueOnce(unavailable())
      .mockResolvedValueOnce({ items: [policy], nextAfterId: null });
    render(<SchedulePoliciesPage />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Policies could not be loaded');
    expect(screen.queryByText(/No scheduling policies/)).not.toBeInTheDocument();

    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText(/Weekday rules/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(api.listPolicies).toHaveBeenCalledTimes(2);
  });
});

function ScopeHarness() {
  const structure = useStructure(ORG);
  const [scope, setScope] = useState<{ scopeType: ScheduleScopeType; targetId: string }>({
    scopeType: 'DEPARTMENT',
    targetId: '',
  });
  return (
    <div>
      <p role="status">{structure.loaded ? 'loaded' : 'loading'}</p>
      <ScopeFields
        structure={structure}
        scopeType={scope.scopeType}
        targetId={scope.targetId}
        onChange={setScope}
      />
    </div>
  );
}

describe('useStructure', () => {
  it('keeps the lists that loaded and offers a retry when one fails', async () => {
    organizationApi.listUnits.mockRejectedValueOnce(unavailable());
    render(<ScopeHarness />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The organization structure could not be loaded.');
    // Still a picker (not a raw id field), with the departments that did load.
    const department = screen.getByRole('combobox', { name: 'Department' });
    expect(within(department).getByRole('option', { name: 'Reception' })).toBeInTheDocument();

    fireEvent.change(screen.getByRole('combobox', { name: 'Scope' }), {
      target: { value: 'ORGANIZATIONAL_UNIT' },
    });
    expect(screen.getByRole('combobox', { name: 'Business unit' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Operations' })).not.toBeInTheDocument();

    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('option', { name: 'Operations' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(organizationApi.listUnits).toHaveBeenCalledTimes(2);
  });

  it('falls back to an id field, with a hint, only when the structure is not readable', async () => {
    for (const list of Object.values(organizationApi)) list.mockRejectedValue(forbidden());
    const { container } = render(<ScopeHarness />);
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('loaded'));

    const field = screen.getByRole('textbox', { name: 'Department' });
    expect(field).toHaveAccessibleDescription(
      'Enter the id (organization structure is not readable).',
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await expectNoAxeViolations(container);
  });
});

describe('Field', () => {
  it('names the control by its label and describes it with the hint', async () => {
    const { container } = render(
      <Field label="Rotation (weeks)" hint="1 for every week; 2 for alternating weeks.">
        <input className={inputClass} />
      </Field>,
    );
    const input = screen.getByRole('textbox', { name: 'Rotation (weeks)' });
    expect(input).toHaveAccessibleDescription('1 for every week; 2 for alternating weeks.');
    await expectNoAxeViolations(container);
  });

  it('adds no description without a hint', () => {
    render(
      <Field label="Name">
        <input className={inputClass} />
      </Field>,
    );
    expect(screen.getByRole('textbox', { name: 'Name' })).not.toHaveAttribute('aria-describedby');
  });
});
