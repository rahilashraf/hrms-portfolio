import '@testing-library/jest-dom/vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POLICY_SECTIONS } from '../../../lib/attendance/policy-schema';
import type {
  AttendanceOrganization,
  EffectivePolicy,
  TimePolicy,
} from '../../../lib/attendance/types';
import { AuthApiError } from '../../../lib/auth/types';
import { timeErrorMessage } from '../../../lib/time/errors';
import { AttendanceAdmin } from '../attendance-admin';
import { AssignmentAttendancePanel } from './assignment-attendance';
import { EffectivePolicyView, sourceText } from './effective-policy';
import { todayIn } from '../../../lib/scheduling/time';
import { inShow, PoliciesPanel } from './policies-panel';
import { PolicyEditor } from './policy-editor';

const mocks = vi.hoisted(() => ({
  organizations: vi.fn(),
  managedSignIns: vi.fn(),
  expectedSignIns: vi.fn(),
  recordSignOut: vi.fn(),
  voidSignOut: vi.fn(),
  devices: vi.fn(),
  updateDevice: vi.fn(),
  policies: vi.fn(),
  createPolicy: vi.fn(),
  supersedePolicy: vi.fn(),
  endPolicy: vi.fn(),
  archivePolicy: vi.fn(),
  effectivePolicy: vi.fn(),
  inheritedPolicy: vi.fn(),
  assignmentAttendance: vi.fn(),
}));

vi.mock('../../../lib/attendance/api', () => ({ attendanceApi: mocks }));
// The structure pickers search the API; a plain input stands in for them here.
vi.mock('../../ui/assignment-id-picker', () => ({
  AssignmentIdPicker: ({
    label,
    value,
    onChange,
  }: {
    label: string;
    value: string;
    onChange(value: string): void;
  }) => (
    <label>
      {label}
      <input value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  ),
}));

const organization = (
  actions: Partial<AttendanceOrganization['actions']> = {},
): AttendanceOrganization => ({
  id: 'org-1',
  name: 'Camp',
  code: 'CAMP',
  timezone: 'America/Toronto',
  workLocations: [],
  physicalSites: [
    { id: 'site-1', name: 'Main campus' },
    { id: 'site-2', name: 'Lake site' },
  ],
  actions: {
    canViewSignIns: false,
    canCorrectSignIns: false,
    canManageDevices: false,
    canManagePolicies: true,
    canManagePins: false,
    ...actions,
  },
});

function policy(overrides: Partial<TimePolicy> = {}): TimePolicy {
  return {
    id: 'policy-1',
    scopeType: 'ORGANIZATION',
    organizationId: 'org-1',
    organizationalUnitId: null,
    departmentId: null,
    teamId: null,
    employmentAssignmentId: null,
    inheritanceMode: 'INHERIT',
    effectiveFrom: '2026-01-01',
    effectiveTo: null,
    config: { clock: { mode: 'LIVE_CLOCK' }, breaks: { mode: 'NONE' } },
    archivedAt: null,
    actions: { canEnd: true, canArchive: false },
    scopeName: 'Camp',
    updatedAt: '2026-10-01T12:00:00.000Z',
    ...overrides,
  };
}

const conflict = (code: string, extra: Record<string, unknown> = {}) =>
  new AuthApiError('conflict', 409, 'Conflict', { code, ...extra });

beforeEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/admin/time');
  vi.clearAllMocks();
  mocks.policies.mockResolvedValue({ items: [policy()] });
  mocks.inheritedPolicy.mockResolvedValue({
    date: '2027-01-01',
    determinable: true,
    config: {},
    settings: {},
    chain: [],
  });
});

afterEach(cleanup);

describe('Policy schema', () => {
  it('describes exactly the sections and settings the API accepts', () => {
    // The API's schema source (apps/api/src/time/time-policy.ts): every section and key, without
    // the passive `mode` keys nothing reads (clock.mode and breaks.mode are real settings).
    const source = readFileSync(
      resolve(__dirname, '../../../../../api/src/time/time-policy.ts'),
      'utf8',
    );
    const block = source.slice(
      source.indexOf('export const TIME_POLICY_CONFIG_SCHEMA'),
      source.indexOf('/** Batch 4D (D-G): the threshold'),
    );
    const api = new Map<string, Set<string>>();
    let section = '';
    for (const line of block.split('\n')) {
      const opened = /^\s{2}(\w+): \{(.*)$/.exec(line);
      if (opened) {
        section = opened[1]!;
        api.set(section, new Set());
        for (const match of opened[2]!.matchAll(/(\w+):/g)) api.get(section)!.add(match[1]!);
        continue;
      }
      const key = /^\s{4}(\w+):/.exec(line);
      if (key && section) api.get(section)!.add(key[1]!);
    }
    const passive = (sectionKey: string, key: string) =>
      key === 'mode' && sectionKey !== 'clock' && sectionKey !== 'breaks';
    const apiKeys = [...api].flatMap(([sectionKey, keys]) =>
      [...keys].filter((key) => !passive(sectionKey, key)).map((key) => `${sectionKey}.${key}`),
    );
    const webKeys = POLICY_SECTIONS.flatMap((item) =>
      item.fields.map((field) => `${item.key}.${field.key}`),
    );
    expect(apiKeys.length).toBeGreaterThan(30);
    expect([...webKeys].sort()).toEqual([...apiKeys].sort());
  });
});

describe('Policy editor', () => {
  it('offers every section for an organization, hides period automation for narrower scopes, and explains positions', async () => {
    render(
      <PolicyEditor organization={organization()} mode={{ kind: 'create' }} onSaved={vi.fn()} />,
    );
    const form = screen.getByRole('form', { name: 'Add attendance policy' });
    for (const section of POLICY_SECTIONS) {
      expect(within(form).getByRole('group', { name: section.title })).toBeInTheDocument();
    }
    expect(within(form).getByText(/There is no position scope/)).toBeInTheDocument();
    fireEvent.change(within(form).getByLabelText('Scope'), { target: { value: 'TEAM' } });
    expect(
      within(form).queryByRole('group', { name: 'Attendance period automation' }),
    ).not.toBeInTheDocument();
  });

  it('checks bounds before sending and shows the API’s field errors on the field', async () => {
    mocks.createPolicy.mockRejectedValueOnce(
      new AuthApiError('validation', 400, 'missedPunch.maxOpenDurationMinutes: must be ≤ 2880', {
        code: 'TIME_POLICY_CONFIG_INVALID',
        path: 'missedPunch.maxOpenDurationMinutes',
      }),
    );
    render(
      <PolicyEditor organization={organization()} mode={{ kind: 'create' }} onSaved={vi.fn()} />,
    );
    const form = screen.getByRole('form', { name: 'Add attendance policy' });
    fireEvent.change(within(form).getByLabelText('Effective from'), {
      target: { value: '2027-01-01' },
    });
    const breaks = within(form).getByRole('group', { name: 'Breaks and automatic deduction' });
    const deduction = within(breaks).getByLabelText('Deduction (minutes)');
    fireEvent.change(deduction, { target: { value: '999' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Add policy' }));
    expect(await within(form).findByText('Enter 0 to 480.')).toBeInTheDocument();
    expect(deduction).toHaveAttribute('aria-invalid', 'true');
    expect(mocks.createPolicy).not.toHaveBeenCalled();

    // Valid locally, refused by the API: its message lands on that field.
    fireEvent.change(deduction, { target: { value: '' } });
    const missed = within(form).getByRole('group', { name: 'Missed punches' });
    fireEvent.change(within(missed).getByLabelText('Longest open entry (minutes)'), {
      target: { value: '600' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Add policy' }));
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Save policy' }),
    );
    expect(await within(missed).findByText(/must be ≤ 2880/)).toBeInTheDocument();
  });

  it('saves settings without a warning when nothing sensitive changes, and with the override explained when overriding', async () => {
    mocks.createPolicy.mockResolvedValue(policy({ id: 'new' }));
    const onSaved = vi.fn();
    render(
      <PolicyEditor organization={organization()} mode={{ kind: 'create' }} onSaved={onSaved} />,
    );
    const form = screen.getByRole('form', { name: 'Add attendance policy' });
    fireEvent.change(within(form).getByLabelText('Effective from'), {
      target: { value: '2027-01-01' },
    });
    const timesheets = within(form).getByRole('group', { name: 'Timesheets' });
    fireEvent.change(within(timesheets).getByLabelText('Allow submission before the period ends'), {
      target: { value: 'true' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Add policy' }));
    await waitFor(() =>
      expect(mocks.createPolicy).toHaveBeenCalledWith({
        scopeType: 'ORGANIZATION',
        organizationId: 'org-1',
        inheritanceMode: 'INHERIT',
        effectiveFrom: '2027-01-01',
        config: { timesheet: { allowEarlySubmission: true } },
      }),
    );
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();

    cleanup();
    render(
      <PolicyEditor organization={organization()} mode={{ kind: 'create' }} onSaved={onSaved} />,
    );
    const again = screen.getByRole('form', { name: 'Add attendance policy' });
    fireEvent.change(within(again).getByLabelText('Effective from'), {
      target: { value: '2027-01-01' },
    });
    fireEvent.click(within(again).getByLabelText('Override broader policies'));
    fireEvent.click(within(again).getByRole('button', { name: 'Add policy' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Save these policy changes?' });
    expect(dialog).toHaveTextContent('resets to the built-in default');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save policy' }));
    await waitFor(() =>
      expect(mocks.createPolicy).toHaveBeenLastCalledWith(
        expect.objectContaining({ inheritanceMode: 'OVERRIDE', config: {} }),
      ),
    );
  });

  it('replaces a layer from a date with its settings prefilled, the version seen, and a warning for break changes', async () => {
    mocks.supersedePolicy.mockResolvedValue({ ended: policy(), created: policy({ id: 'next' }) });
    const onSaved = vi.fn();
    render(
      <PolicyEditor
        organization={organization()}
        mode={{ kind: 'supersede', policy: policy() }}
        onSaved={onSaved}
      />,
    );
    const form = screen.getByRole('form', { name: 'Change policy from a date' });
    const clock = within(form).getByRole('group', { name: 'Time clock' });
    expect(within(clock).getByLabelText('Time clock')).toHaveValue('LIVE_CLOCK');
    fireEvent.change(within(form).getByLabelText('Replace from'), {
      target: { value: '2027-02-01' },
    });
    const breaks = within(form).getByRole('group', { name: 'Breaks and automatic deduction' });
    fireEvent.change(within(breaks).getByLabelText('Breaks'), { target: { value: 'AUTO_DEDUCT' } });
    fireEvent.change(within(breaks).getByLabelText('Deduction (minutes)'), {
      target: { value: '30' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Replace policy' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('payable minutes');
    expect(dialog).not.toHaveTextContent('kiosk-only'); // capture unchanged: no capture warning
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save policy' }));
    await waitFor(() =>
      expect(mocks.supersedePolicy).toHaveBeenCalledWith('policy-1', {
        effectiveFrom: '2027-02-01',
        inheritanceMode: 'INHERIT',
        expectedUpdatedAt: '2026-10-01T12:00:00.000Z',
        config: {
          clock: { mode: 'LIVE_CLOCK' },
          breaks: { mode: 'AUTO_DEDUCT', autoDeductMinutes: 30 },
        },
      }),
    );
    expect(onSaved).toHaveBeenCalledWith(
      expect.stringContaining('Policy replaced from 02/01/2027'),
      expect.objectContaining({ id: 'next' }),
    );
  });

  it('asks to reload when another administrator changed the layer', async () => {
    mocks.supersedePolicy.mockRejectedValueOnce(conflict('TIME_POLICY_CHANGED'));
    const onStale = vi.fn();
    render(
      <PolicyEditor
        organization={organization()}
        mode={{ kind: 'supersede', policy: policy() }}
        onSaved={vi.fn()}
        onStale={onStale}
      />,
    );
    const form = screen.getByRole('form', { name: 'Change policy from a date' });
    fireEvent.change(within(form).getByLabelText('Replace from'), {
      target: { value: '2027-02-01' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Replace policy' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent(
      'This policy changed since you opened it',
    );
    expect(onStale).toHaveBeenCalled();
  });
});

describe('Policies panel', () => {
  it('lists layers by scope name, keeps system layers read-only, and filters ended and archived ones', async () => {
    mocks.policies.mockResolvedValue({
      items: [
        policy({
          id: 'system',
          scopeType: 'SYSTEM',
          organizationId: null,
          scopeName: 'System',
          actions: { canEnd: false, canArchive: false },
        }),
        policy({
          id: 'team',
          scopeType: 'TEAM',
          teamId: 'team-1',
          scopeName: 'Lifeguards',
          inheritanceMode: 'OVERRIDE',
          config: { attendance: { trackingMode: 'SIGN_IN_ONLY', signOutEnabled: true } },
        }),
        policy({
          id: 'old',
          scopeName: 'Camp (2025)',
          effectiveFrom: '2025-01-01',
          effectiveTo: '2025-12-31',
        }),
      ],
    });
    const onInspect = vi.fn();
    render(<PoliciesPanel organization={organization()} onInspect={onInspect} />);
    const team = (await screen.findByText('Lifeguards')).closest('li')!;
    expect(team).toHaveTextContent('Overrides broader policies');
    expect(team).toHaveTextContent('Tracking: Presence only (sign-in, never payable)');
    expect(team).toHaveTextContent('Presence staff may sign out: Yes');
    const system = screen.getByText('System', { selector: 'p > :first-child, p' }).closest('li')!;
    expect(system).toHaveTextContent('System policy · read-only');
    expect(within(system).queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByText('Camp (2025)')).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Ended'));
    expect(await screen.findByText('Camp (2025)')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Archived'));
    await waitFor(() => expect(mocks.policies).toHaveBeenLastCalledWith('org-1', true));
  });

  it('opens the replacement editor for a layer, then offers to inspect the effective policy', async () => {
    mocks.supersedePolicy.mockResolvedValue({ ended: policy(), created: policy({ id: 'next' }) });
    const onInspect = vi.fn();
    render(<PoliciesPanel organization={organization()} onInspect={onInspect} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Change from a date for Camp' }));
    const form = screen.getByRole('form', { name: 'Change policy from a date' });
    fireEvent.change(within(form).getByLabelText('Replace from'), {
      target: { value: '2027-02-01' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Replace policy' }));
    await waitFor(() => expect(mocks.supersedePolicy).toHaveBeenCalled());
    fireEvent.click(await screen.findByRole('button', { name: 'Inspect the effective policy' }));
    expect(onInspect).toHaveBeenCalled();
  });
});

describe('Effective policy', () => {
  const view: EffectivePolicy = {
    date: '2027-03-02',
    timezone: 'America/Toronto',
    assignment: {
      id: 'assignment-1',
      employeeId: 'employee-1',
      status: 'ACTIVE',
      position: { id: 'position-1', name: 'Counsellor' },
      organization: { id: 'org-1', name: 'Camp' },
    },
    config: {
      clock: { mode: 'LIVE_CLOCK' },
      breaks: { mode: 'NONE' },
      attendance: { trackingMode: 'TIME_CLOCK', captureMode: 'KIOSK_ONLY' },
    },
    settings: {
      clock: { mode: { value: 'LIVE_CLOCK', source: 'LAYER', layerId: 'team' } },
      breaks: { mode: { value: 'NONE', source: 'DEFAULT', resetByLayerId: 'team' } },
      attendance: {
        trackingMode: { value: 'TIME_CLOCK', source: 'DEFAULT' },
        captureMode: { value: 'KIOSK_ONLY', source: 'LAYER', layerId: 'assignment' },
      },
    },
    chain: [
      {
        id: 'org',
        scopeType: 'ORGANIZATION',
        scopeName: 'Camp',
        inheritanceMode: 'INHERIT',
        effectiveFrom: '2026-01-01',
        effectiveTo: null,
      },
      {
        id: 'team',
        scopeType: 'TEAM',
        scopeName: 'Lifeguards',
        inheritanceMode: 'OVERRIDE',
        effectiveFrom: '2026-06-01',
        effectiveTo: null,
      },
      {
        id: 'assignment',
        scopeType: 'EMPLOYMENT_ASSIGNMENT',
        scopeName: 'Ada · Counsellor',
        inheritanceMode: 'INHERIT',
        effectiveFrom: '2027-01-01',
        effectiveTo: '2027-12-31',
      },
    ],
    attendance: {
      trackingMode: 'TIME_CLOCK',
      captureMode: 'KIOSK_ONLY',
      kioskLocationRule: 'ANY_IN_ORGANIZATION',
      signInDuplicateWindowMinutes: 10,
      signOutEnabled: false,
    },
  };

  it('tells set-here, inherited, reset-by-override and default values apart', () => {
    expect(sourceText(view, 'attendance', 'captureMode')).toEqual({
      text: 'Set for this assignment',
      kind: 'assignment',
    });
    expect(sourceText(view, 'clock', 'mode')).toEqual({
      text: 'Inherited from Lifeguards (Team)',
      kind: 'inherited',
    });
    expect(sourceText(view, 'breaks', 'mode')).toEqual({
      text: "Reset to the default by Lifeguards's override",
      kind: 'reset',
    });
    expect(sourceText(view, 'attendance', 'trackingMode').kind).toBe('default');
    expect(sourceText(view, 'timesheet', 'allowEarlySubmission').kind).toBe('default');
  });

  it('shows the chain with dates and overrides, and every section’s settings', () => {
    render(<EffectivePolicyView view={view} />);
    expect(
      screen.getByText(/Timed attendance \(clock in and out\); capture: Kiosk only/),
    ).toBeInTheDocument();
    const chain = screen.getByRole('list');
    expect(
      within(chain)
        .getAllByRole('listitem')
        .map((item) => item.textContent?.trim()),
    ).toEqual([
      'Camp (Organization) · 01/01/2026 – open-ended',
      'Lifeguards (Team) · 06/01/2026 – open-ended Overrides broader policies',
      'Ada · Counsellor (Employment) · 01/01/2027 – 12/31/2027',
    ]);
    const capture = screen.getByRole('region', {
      name: 'Tracking and capture: effective settings',
    });
    expect(
      within(capture).getByRole('row', { name: /Capture Kiosk only Set for this assignment/ }),
    ).toBeInTheDocument();
    for (const section of POLICY_SECTIONS) {
      expect(screen.getByRole('heading', { name: section.title })).toBeInTheDocument();
    }
  });
});

describe('Assignment attendance', () => {
  it('searches across organizations, shows each assignment’s mode, and opens its effective policy', async () => {
    mocks.assignmentAttendance.mockResolvedValue({
      items: [
        {
          id: 'a-1',
          employee: { id: 'e-1', employeeNumber: 'E-1', name: 'Ada Lovelace' },
          assignment: {
            id: 'a-1',
            status: 'ACTIVE',
            startDate: null,
            endDate: null,
            isPrimary: true,
            position: { id: 'p-1', name: 'Counsellor', code: 'C' },
            organization: { id: 'org-1', name: 'Camp', code: 'CAMP' },
            workLocation: null,
          },
          date: '2027-03-02',
          timezone: 'America/Toronto',
          attendance: {
            trackingMode: 'TIME_CLOCK',
            captureMode: 'KIOSK_ONLY',
            kioskLocationRule: 'ANY_IN_ORGANIZATION',
            signInDuplicateWindowMinutes: 10,
            signOutEnabled: false,
          },
          clock: { mode: 'LIVE_CLOCK' },
          breaks: { mode: 'AUTO_DEDUCT', autoDeductMinutes: 30, autoDeductAfterMinutes: 360 },
          chain: [
            {
              id: 'l-1',
              scopeType: 'ORGANIZATION',
              scopeName: 'Camp',
              inheritanceMode: 'INHERIT',
              effectiveFrom: '2026-01-01',
              effectiveTo: null,
            },
          ],
        },
        {
          id: 'a-2',
          employee: { id: 'e-1', employeeNumber: 'E-1', name: 'Ada Lovelace' },
          assignment: {
            id: 'a-2',
            status: 'ACTIVE',
            startDate: null,
            endDate: null,
            isPrimary: false,
            position: { id: 'p-2', name: 'Volunteer', code: 'V' },
            organization: { id: 'org-2', name: 'School', code: 'SCH' },
            workLocation: null,
          },
          date: '2027-03-02',
          timezone: 'America/Toronto',
          attendance: {
            trackingMode: 'SIGN_IN_ONLY',
            captureMode: 'KIOSK_OR_SELF_SERVICE',
            kioskLocationRule: 'ANY_IN_ORGANIZATION',
            signInDuplicateWindowMinutes: 10,
            signOutEnabled: true,
          },
          clock: { mode: 'DISABLED' },
          breaks: { mode: 'NONE', autoDeductMinutes: null, autoDeductAfterMinutes: null },
          chain: [],
        },
      ],
      nextAfterId: null,
    });
    const onInspect = vi.fn();
    render(<AssignmentAttendancePanel onInspect={onInspect} />);
    expect(mocks.assignmentAttendance).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Employee name, number or position'), {
      target: { value: 'Ada' },
    });
    const table = await screen.findByRole('region', { name: 'Assignment attendance' });
    expect(mocks.assignmentAttendance).toHaveBeenCalledWith(
      expect.objectContaining({ search: 'Ada' }),
    );
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows[0]).toHaveTextContent('Camp');
    expect(rows[0]).toHaveTextContent('Timed attendance');
    expect(rows[0]).toHaveTextContent('30 min after 360 min');
    expect(rows[1]).toHaveTextContent('School');
    expect(rows[1]).toHaveTextContent('Presence only (not payable)');
    expect(rows[1]).toHaveTextContent('Sign-out allowed');
    expect(rows[1]).toHaveTextContent('Defaults only');
    fireEvent.click(
      within(rows[1]!).getByRole('button', {
        name: /Inspect the effective policy of Ada Lovelace, Volunteer/,
      }),
    );
    expect(onInspect).toHaveBeenCalledWith('a-2', '2027-03-02');
  });
});

describe('Attendance administration additions', () => {
  const signIn = {
    id: 'sign-in-1',
    employeeId: 'employee-1',
    employmentAssignmentId: 'assignment-1',
    signedInAt: '2026-10-05T13:07:00.000Z',
    timezone: 'America/Toronto',
    workDate: '2026-10-05',
    source: 'KIOSK',
    attendanceDeviceId: null,
    workLocationId: null,
    scheduledShiftId: null,
    scheduledShiftRevisionId: null,
    status: 'ACTIVE',
    voidedAt: null,
    voidReason: null,
    replacesSignInId: null,
    recordedByUserId: null,
    reason: null,
    createdAt: '2026-10-05T13:07:00.000Z',
    positionName: 'Counsellor',
    employeeNumber: 'E-100',
    employeeName: 'Ada Lovelace',
    device: null,
    workLocation: null,
    exceptions: [],
    actions: { canVoid: true, canCorrect: true },
    signOut: null,
  };

  it('records and voids a sign-out with a reason, and offers neither without correction rights', async () => {
    mocks.organizations.mockResolvedValue({
      items: [organization({ canViewSignIns: true, canCorrectSignIns: true })],
    });
    mocks.managedSignIns.mockResolvedValueOnce({ items: [signIn] }).mockResolvedValueOnce({
      items: [
        {
          ...signIn,
          signOut: {
            id: 'sign-out-1',
            signInId: 'sign-in-1',
            employmentAssignmentId: 'assignment-1',
            signedOutAt: '2026-10-05T17:00:00.000Z',
            source: 'MANUAL',
            attendanceDeviceId: null,
            recordedByUserId: 'manager',
            reason: 'Left early',
            status: 'ACTIVE',
            voidedAt: null,
            voidReason: null,
          },
        },
      ],
    });
    mocks.recordSignOut.mockResolvedValue({});
    mocks.voidSignOut.mockResolvedValue({});
    render(<AttendanceAdmin />);
    fireEvent.click(await screen.findByRole('button', { name: /^Record sign-out / }));
    const form = screen.getByRole('form', { name: 'Record sign-out' });
    expect(form).toHaveTextContent('never payable time');
    fireEvent.change(within(form).getByLabelText(/Signed out at/), {
      target: { value: '2026-10-05T13:00' },
    });
    fireEvent.change(within(form).getByLabelText('Reason'), { target: { value: 'Left early' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Record sign-out' }));
    await waitFor(() =>
      expect(mocks.recordSignOut).toHaveBeenCalledWith('sign-in-1', {
        signedOutAt: '2026-10-05T13:00',
        reason: 'Left early',
      }),
    );
    fireEvent.click(await screen.findByRole('button', { name: /^Void sign-out / }));
    const voidForm = screen.getByRole('form', { name: 'Void sign-out' });
    fireEvent.change(within(voidForm).getByLabelText('Reason'), { target: { value: 'Wrong day' } });
    fireEvent.click(within(voidForm).getByRole('button', { name: 'Void sign-out' }));
    await waitFor(() => expect(mocks.voidSignOut).toHaveBeenCalledWith('sign-out-1', 'Wrong day'));

    cleanup();
    mocks.managedSignIns.mockResolvedValue({
      items: [{ ...signIn, actions: { canVoid: false, canCorrect: false } }],
    });
    render(<AttendanceAdmin />);
    expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Record sign-out/ })).not.toBeInTheDocument();
  });

  it('renames a kiosk and moves it to another site, sending only what changed', async () => {
    mocks.organizations.mockResolvedValue({
      items: [organization({ canManageDevices: true, canManagePolicies: false })],
    });
    const device = {
      id: 'device-1',
      organizationId: 'org-1',
      physicalSite: { id: 'site-1', name: 'Main campus' },
      name: 'Front desk',
      status: 'ACTIVE',
      enrolled: true,
      credentialIssuedAt: null,
      enrollmentPending: false,
      enrollmentExpiresAt: null,
      lastSeenAt: null,
      lastSeenIp: null,
      revokedAt: null,
      revokedReason: null,
      createdAt: '2026-10-01T12:00:00.000Z',
    };
    // Any number of kiosks: three listed, each with its own actions.
    mocks.devices.mockResolvedValue({
      items: [
        device,
        { ...device, id: 'device-2', name: 'Gym' },
        { ...device, id: 'device-3', name: 'Pool' },
      ],
    });
    mocks.updateDevice.mockResolvedValue({});
    render(<AttendanceAdmin />);
    expect(await screen.findAllByRole('button', { name: /^Rename or move/ })).toHaveLength(3);
    fireEvent.click(screen.getByRole('button', { name: 'Rename or move Front desk' }));
    const form = screen.getByRole('form', { name: 'Rename or move kiosk' });
    fireEvent.change(within(form).getByLabelText('Site'), { target: { value: 'site-2' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save kiosk' }));
    await waitFor(() =>
      expect(mocks.updateDevice).toHaveBeenCalledWith('device-1', { physicalSiteId: 'site-2' }),
    );
    expect(await screen.findByText('Kiosk updated.')).toBeInTheDocument();
  });

  it('opens the effective policy of an assignment found in assignment attendance', async () => {
    mocks.organizations.mockResolvedValue({
      items: [organization({ canViewSignIns: true, canManagePolicies: false })],
    });
    mocks.managedSignIns.mockResolvedValue({ items: [] });
    mocks.assignmentAttendance.mockResolvedValue({
      items: [
        {
          id: 'a-1',
          employee: { id: 'e-1', employeeNumber: 'E-1', name: 'Ada Lovelace' },
          assignment: {
            id: 'a-1',
            status: 'ACTIVE',
            startDate: null,
            endDate: null,
            isPrimary: true,
            position: { id: 'p-1', name: 'Counsellor', code: 'C' },
            organization: { id: 'org-1', name: 'Camp', code: 'CAMP' },
            workLocation: null,
          },
          date: '2027-03-02',
          timezone: 'America/Toronto',
          attendance: {
            trackingMode: 'TIME_CLOCK',
            captureMode: 'SELF_SERVICE',
            kioskLocationRule: 'ANY_IN_ORGANIZATION',
            signInDuplicateWindowMinutes: 10,
            signOutEnabled: false,
          },
          clock: { mode: 'LIVE_CLOCK' },
          breaks: { mode: 'NONE', autoDeductMinutes: null, autoDeductAfterMinutes: null },
          chain: [],
        },
      ],
      nextAfterId: null,
    });
    mocks.effectivePolicy.mockResolvedValue({
      date: '2027-03-02',
      timezone: 'America/Toronto',
      assignment: {
        id: 'a-1',
        employeeId: 'e-1',
        status: 'ACTIVE',
        position: { id: 'p-1', name: 'Counsellor' },
        organization: { id: 'org-1', name: 'Camp' },
      },
      config: {},
      settings: {},
      chain: [],
      attendance: {
        trackingMode: 'TIME_CLOCK',
        captureMode: 'SELF_SERVICE',
        kioskLocationRule: 'ANY_IN_ORGANIZATION',
        signInDuplicateWindowMinutes: 10,
        signOutEnabled: false,
      },
    });
    render(<AttendanceAdmin />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Assignment attendance' }));
    fireEvent.change(screen.getByLabelText('Employee name, number or position'), {
      target: { value: 'Ada' },
    });
    fireEvent.click(await screen.findByRole('button', { name: /^Inspect/ }));
    expect(await screen.findByRole('tab', { name: 'Effective policy' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await waitFor(() => expect(mocks.effectivePolicy).toHaveBeenCalledWith('a-1', '2027-03-02'));
    expect(await screen.findByText(/No policy applies on this date/)).toBeInTheDocument();
    // No policy tab without the policy permission.
    expect(screen.queryByRole('tab', { name: 'Attendance policies' })).not.toBeInTheDocument();
  });
});

describe('PIN and policy error messages', () => {
  it('explains each coded refusal instead of a generic error', () => {
    const forbidden = (code: string) => new AuthApiError('forbidden', 403, undefined, { code });
    expect(timeErrorMessage(forbidden('ATTENDANCE_PIN_SHARED_SCOPE'))).toMatch(
      /also works in an organization you do not manage/,
    );
    expect(timeErrorMessage(forbidden('ATTENDANCE_PIN_SELF_TARGET'))).toMatch(/your own PIN/);
    expect(timeErrorMessage(conflict('ATTENDANCE_PIN_ADMIN_REVOKED'))).toMatch(
      /revoked by an administrator/,
    );
    expect(timeErrorMessage(conflict('TIME_POLICY_SUPERSEDE_DATE'))).toMatch(
      /after this policy starts/,
    );
    expect(timeErrorMessage(conflict('TIME_POLICY_OVERLAP'))).toMatch(
      /Another policy of this scope/,
    );
  });
});

describe('Inherited values in the editor (Batch 4E-2 review)', () => {
  const hintOf = (form: HTMLElement, group: string, field: string) => {
    const control = within(within(form).getByRole('group', { name: group })).getByLabelText(field);
    return document.getElementById(control.getAttribute('aria-describedby')!.split(' ')[0]!)!
      .textContent;
  };
  const systemLayer = {
    id: 'layer-system',
    scopeType: 'SYSTEM' as const,
    scopeName: 'System',
    inheritanceMode: 'INHERIT' as const,
    effectiveFrom: '2025-01-01',
    effectiveTo: null,
  };
  const orgLayer = {
    id: 'layer-org',
    scopeType: 'ORGANIZATION' as const,
    scopeName: 'Camp',
    inheritanceMode: 'OVERRIDE' as const,
    effectiveFrom: '2026-01-01',
    effectiveTo: null,
  };

  it('shows the API’s inherited value for the scope and date, with where it comes from', async () => {
    mocks.inheritedPolicy.mockResolvedValue({
      date: '2027-01-01',
      determinable: true,
      config: { clock: { mode: 'LIVE_CLOCK' }, breaks: { mode: 'NONE' } },
      settings: {
        clock: { mode: { value: 'LIVE_CLOCK', source: 'LAYER', layerId: 'layer-org' } },
        breaks: { mode: { value: 'NONE', source: 'DEFAULT', resetByLayerId: 'layer-org' } },
      },
      chain: [systemLayer, orgLayer],
    });
    render(
      <PolicyEditor organization={organization()} mode={{ kind: 'create' }} onSaved={vi.fn()} />,
    );
    const form = screen.getByRole('form', { name: 'Add attendance policy' });
    // Nothing is asked, and no value shown, before the date is known.
    expect(
      within(form).getByText('Choose the first day to see what blank settings inherit.', {
        exact: false,
      }),
    ).toBeInTheDocument();
    expect(hintOf(form, 'Time clock', 'Time clock')).toContain(
      'Blank inherits from broader policies.',
    );
    fireEvent.change(within(form).getByLabelText('Scope'), { target: { value: 'TEAM' } });
    expect(
      within(form).getByText('Choose the scope and the first day', { exact: false }),
    ).toBeInTheDocument();
    fireEvent.change(within(form).getByLabelText('Scope'), { target: { value: 'ORGANIZATION' } });
    fireEvent.change(within(form).getByLabelText('Effective from'), {
      target: { value: '2027-01-01' },
    });
    await waitFor(() =>
      expect(hintOf(form, 'Time clock', 'Time clock')).toContain(
        'Blank inherits On (clock in and out) (inherited from Camp (Organization)).',
      ),
    );
    expect(mocks.inheritedPolicy).toHaveBeenCalledWith({
      scopeType: 'ORGANIZATION',
      organizationId: 'org-1',
      date: '2027-01-01',
    });
    expect(hintOf(form, 'Breaks and automatic deduction', 'Breaks')).toContain(
      "Blank inherits No break punches (reset to the default by Camp's override).",
    );
    expect(hintOf(form, 'Timesheets', 'Lock timesheets when approved')).toContain(
      'Blank inherits the built-in default: No.',
    );
    expect(
      within(form).getByText('as broader policies stand on 01/01/2027', { exact: false }),
    ).toBeInTheDocument();

    // OVERRIDE: blank no longer inherits; the defaults are what blank means.
    fireEvent.click(within(form).getByLabelText('Override broader policies'));
    expect(hintOf(form, 'Time clock', 'Time clock')).toContain(
      'Blank resets to the built-in default: Off.',
    );
    expect(hintOf(form, 'Time clock', 'Time clock')).not.toContain('On (clock in and out)');
  });

  it('asks for the replaced layer’s own scope and the replacement date', async () => {
    render(
      <PolicyEditor
        organization={organization()}
        mode={{
          kind: 'supersede',
          policy: policy({
            scopeType: 'ORGANIZATIONAL_UNIT',
            organizationalUnitId: 'unit-1',
            scopeName: 'North',
          }),
        }}
        onSaved={vi.fn()}
      />,
    );
    const form = screen.getByRole('form', { name: 'Change policy from a date' });
    fireEvent.change(within(form).getByLabelText('Replace from'), {
      target: { value: '2027-02-01' },
    });
    await waitFor(() =>
      expect(mocks.inheritedPolicy).toHaveBeenCalledWith({
        scopeType: 'ORGANIZATIONAL_UNIT',
        organizationalUnitId: 'unit-1',
        date: '2027-02-01',
      }),
    );
  });

  it('shows no value when it depends on the position, and points to the effective policy view', async () => {
    mocks.inheritedPolicy.mockResolvedValue({
      date: '2027-02-01',
      determinable: false,
      reason: 'VARIES_BY_POSITION',
      varyingScopes: ['ORGANIZATIONAL_UNIT', 'DEPARTMENT'],
    });
    const onInspect = vi.fn();
    render(
      <PolicyEditor
        organization={organization()}
        mode={{ kind: 'supersede', policy: policy({ scopeType: 'TEAM', teamId: 'team-1' }) }}
        onSaved={vi.fn()}
        onInspect={onInspect}
      />,
    );
    const form = screen.getByRole('form', { name: 'Change policy from a date' });
    fireEvent.change(within(form).getByLabelText('Replace from'), {
      target: { value: '2027-02-01' },
    });
    expect(
      await within(form).findByText(
        /for a team they depend on each position's unit and department/,
      ),
    ).toBeInTheDocument();
    expect(mocks.inheritedPolicy).toHaveBeenCalledWith({
      scopeType: 'TEAM',
      teamId: 'team-1',
      date: '2027-02-01',
    });
    expect(hintOf(form, 'Time clock', 'Time clock')).toContain('the value depends on the position');
    expect(hintOf(form, 'Time clock', 'Time clock')).not.toContain('default');
    fireEvent.click(within(form).getByRole('button', { name: 'Open the effective policy view' }));
    expect(onInspect).toHaveBeenCalled();
  });

  it('says so when the inherited values can’t be loaded, without guessing', async () => {
    mocks.inheritedPolicy.mockRejectedValue(
      new AuthApiError('service-unavailable', 503, 'Unavailable'),
    );
    render(
      <PolicyEditor
        organization={organization()}
        mode={{ kind: 'create' }}
        onSaved={vi.fn()}
        onInspect={vi.fn()}
      />,
    );
    const form = screen.getByRole('form', { name: 'Add attendance policy' });
    fireEvent.change(within(form).getByLabelText('Effective from'), {
      target: { value: '2027-01-01' },
    });
    expect(await within(form).findByText(/could not be loaded/)).toBeInTheDocument();
    expect(hintOf(form, 'Time clock', 'Time clock')).toContain(
      'Blank inherits from broader policies.',
    );
    expect(
      within(form).getByRole('button', { name: 'Open the effective policy view' }),
    ).toBeInTheDocument();
  });
});

describe('Policy dates in the organization’s time zone (Batch 4E-2 review)', () => {
  const endingNov2 = policy({ effectiveTo: '2026-11-02' });

  it('classifies a layer by the organization’s local date near midnight, on both sides of UTC', () => {
    // 03:30 UTC on Nov 3: still Nov 2 in Toronto (UTC−5), already Nov 3 in Kolkata (UTC+5:30).
    const lateEvening = new Date('2026-11-03T03:30:00.000Z');
    expect(todayIn('America/Toronto', lateEvening)).toBe('2026-11-02');
    expect(todayIn('Asia/Kolkata', lateEvening)).toBe('2026-11-03');
    expect(inShow(endingNov2, 'current', todayIn('America/Toronto', lateEvening))).toBe(true);
    expect(inShow(endingNov2, 'ended', todayIn('Asia/Kolkata', lateEvening))).toBe(true);
    // 20:00 UTC on Nov 2: UTC still says Nov 2, but Kolkata is past midnight (01:30 Nov 3).
    const utcEvening = new Date('2026-11-02T20:00:00.000Z');
    expect(todayIn('Asia/Kolkata', utcEvening)).toBe('2026-11-03');
    expect(inShow(endingNov2, 'ended', todayIn('Asia/Kolkata', utcEvening))).toBe(true);
    expect(inShow(endingNov2, 'current', todayIn('UTC', utcEvening))).toBe(true);
    // The extremes: UTC+14 and UTC−11 at the same instant are two days apart.
    const instant = new Date('2026-11-02T11:30:00.000Z');
    expect(todayIn('Pacific/Kiritimati', instant)).toBe('2026-11-03');
    expect(todayIn('Pacific/Pago_Pago', instant)).toBe('2026-11-02');
    // One minute either side of the organization's midnight.
    expect(todayIn('America/Toronto', new Date('2026-11-03T04:59:00.000Z'))).toBe('2026-11-02');
    expect(todayIn('America/Toronto', new Date('2026-11-03T05:00:00.000Z'))).toBe('2026-11-03');
    // A layer ending today stays current; archived layers only under Archived.
    expect(inShow(endingNov2, 'current', '2026-11-02')).toBe(true);
    expect(inShow(endingNov2, 'ended', '2026-11-03')).toBe(true);
    expect(
      inShow(policy({ archivedAt: '2026-10-01T00:00:00.000Z' }), 'current', '2026-11-02'),
    ).toBe(false);
  });

  it('lists the same layer as current in Toronto and as ended in Kolkata at the same instant', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-03T03:30:00.000Z'));
    try {
      mocks.policies.mockResolvedValue({ items: [endingNov2] });
      render(<PoliciesPanel organization={{ ...organization(), timezone: 'America/Toronto' }} />);
      expect(
        await screen.findByRole('button', { name: /Change from a date for Camp/ }),
      ).toBeInTheDocument();
      cleanup();
      render(<PoliciesPanel organization={{ ...organization(), timezone: 'Asia/Kolkata' }} />);
      expect(await screen.findByText('No policies to show.')).toBeInTheDocument();
      fireEvent.click(screen.getByLabelText('Ended'));
      expect(
        await screen.findByRole('button', { name: /Change from a date for Camp/ }),
      ).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});
