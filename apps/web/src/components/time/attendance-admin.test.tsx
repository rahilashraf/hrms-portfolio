import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AttendanceOrganization } from '../../lib/attendance/types';
import { AttendanceAdmin, localDateTimeIn } from './attendance-admin';

const mocks = vi.hoisted(() => ({
  organizations: vi.fn(),
  managedSignIns: vi.fn(),
  expectedSignIns: vi.fn(),
  voidSignIn: vi.fn(),
  correctSignIn: vi.fn(),
  recordSignIn: vi.fn(),
  devices: vi.fn(),
  registerDevice: vi.fn(),
  rotateDevice: vi.fn(),
  setDeviceEnabled: vi.fn(),
  revokeDevice: vi.fn(),
  policies: vi.fn(),
  createPolicy: vi.fn(),
  endPolicy: vi.fn(),
  archivePolicy: vi.fn(),
}));

vi.mock('../../lib/attendance/api', () => ({ attendanceApi: mocks }));

const organization = (
  actions: Partial<AttendanceOrganization['actions']>,
): AttendanceOrganization => ({
  id: 'org-1',
  name: 'Camp',
  code: 'CAMP',
  timezone: 'America/Toronto',
  workLocations: [{ id: 'loc-1', name: 'Main lodge', timezone: 'America/Toronto' }],
  physicalSites: [{ id: 'site-1', name: 'Main campus' }],
  actions: {
    canViewSignIns: false,
    canCorrectSignIns: false,
    canManageDevices: false,
    canManagePolicies: false,
    canManagePins: false,
    ...actions,
  },
});

const device = {
  id: 'device-1',
  organizationId: 'org-1',
  physicalSite: { id: 'site-1', name: 'Main campus' },
  name: 'Front desk',
  status: 'ACTIVE' as const,
  enrolled: true,
  credentialIssuedAt: '2026-10-01T12:00:00.000Z',
  enrollmentPending: false,
  enrollmentExpiresAt: null,
  lastSeenAt: '2026-10-05T12:00:00.000Z',
  lastSeenIp: null,
  revokedAt: null,
  revokedReason: null,
  createdAt: '2026-10-01T12:00:00.000Z',
};

const signIn = {
  id: 'sign-in-1',
  employeeId: 'employee-1',
  employmentAssignmentId: 'assignment-1',
  signedInAt: '2026-10-05T13:07:00.000Z',
  timezone: 'America/Toronto',
  workDate: '2026-10-05',
  source: 'KIOSK' as const,
  attendanceDeviceId: 'device-1',
  workLocationId: 'loc-1',
  scheduledShiftId: 'shift-1',
  scheduledShiftRevisionId: 'revision-1',
  status: 'ACTIVE' as const,
  voidedAt: null,
  voidReason: null,
  replacesSignInId: null,
  recordedByUserId: null,
  reason: null,
  createdAt: '2026-10-05T13:07:00.000Z',
  positionName: 'Counsellor',
  employeeNumber: 'E-100',
  employeeName: 'Ada Lovelace',
  device: { id: 'device-1', name: 'Front desk' },
  workLocation: { id: 'loc-1', name: 'Main lodge' },
  exceptions: [{ id: 'exception-1', type: 'LATE_SIGN_IN', status: 'OPEN' }],
  actions: { canVoid: true, canCorrect: true },
};

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.managedSignIns.mockResolvedValue({ items: [signIn] });
  mocks.expectedSignIns.mockResolvedValue({ items: [] });
  mocks.devices.mockResolvedValue({ items: [device] });
  mocks.policies.mockResolvedValue({ items: [] });
});

afterEach(cleanup);

describe('AttendanceAdmin', () => {
  it('offers only the panels the organization grants allow', async () => {
    mocks.organizations.mockResolvedValue({ items: [organization({ canManagePolicies: true })] });
    render(<AttendanceAdmin />);

    expect(await screen.findByRole('tab', { name: 'Attendance policies' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Sign-ins' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Kiosks' })).not.toBeInTheDocument();
    expect(mocks.managedSignIns).not.toHaveBeenCalled();
  });

  it('lists sign-ins with their exceptions and voids one with a reason', async () => {
    mocks.organizations.mockResolvedValue({
      items: [organization({ canViewSignIns: true, canCorrectSignIns: true })],
    });
    mocks.voidSignIn.mockResolvedValue({});
    render(<AttendanceAdmin />);

    expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.getByText('Late Sign In')).toBeInTheDocument();
    expect(mocks.managedSignIns).toHaveBeenCalledWith({
      organizationId: 'org-1',
      from: '',
      to: '',
      includeVoided: false,
    });

    fireEvent.click(screen.getByRole('button', { name: /^Void Ada Lovelace, / }));
    const form = screen.getByRole('form', { name: 'Void sign-in' });
    fireEvent.change(within(form).getByLabelText('Reason'), {
      target: { value: 'Recorded twice' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Void sign-in' }));

    await waitFor(() =>
      expect(mocks.voidSignIn).toHaveBeenCalledWith('sign-in-1', 'Recorded twice'),
    );
    expect(await screen.findByText('Sign-in voided.')).toBeInTheDocument();
  });

  it('corrects a sign-in in the wall time of its workplace', async () => {
    mocks.organizations.mockResolvedValue({
      items: [organization({ canViewSignIns: true, canCorrectSignIns: true })],
    });
    mocks.correctSignIn.mockResolvedValue({});
    render(<AttendanceAdmin />);

    fireEvent.click(await screen.findByRole('button', { name: /^Correct Ada Lovelace, / }));
    const form = screen.getByRole('form', { name: 'Correct sign-in' });
    const at = within(form).getByLabelText('Signed in at (America/Toronto)');
    expect(at).toHaveValue('2026-10-05T09:07');
    fireEvent.change(at, { target: { value: '2026-10-05T09:00' } });
    fireEvent.change(within(form).getByLabelText('Reason'), { target: { value: 'Kiosk queue' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save correction' }));

    await waitFor(() =>
      expect(mocks.correctSignIn).toHaveBeenCalledWith('sign-in-1', {
        signedInAt: '2026-10-05T09:00',
        reason: 'Kiosk queue',
      }),
    );
  });

  it('registers a kiosk and shows its enrollment code once', async () => {
    mocks.organizations.mockResolvedValue({ items: [organization({ canManageDevices: true })] });
    mocks.registerDevice.mockResolvedValue({
      device: { ...device, id: 'device-2', name: 'Dock', enrolled: false, enrollmentPending: true },
      enrollment: { code: 'ABCD-EFGH-JKLM', expiresAt: '2026-10-06T12:00:00.000Z' },
    });
    render(<AttendanceAdmin />);

    const form = await screen.findByRole('form', { name: 'Register kiosk' });
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'Dock' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Register kiosk' }));

    await waitFor(() =>
      expect(mocks.registerDevice).toHaveBeenCalledWith({
        organizationId: 'org-1',
        physicalSiteId: 'site-1',
        name: 'Dock',
      }),
    );
    expect(await screen.findByTestId('enrollment-code')).toHaveTextContent('ABCD-EFGH-JKLM');

    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByTestId('enrollment-code')).not.toBeInTheDocument();
  });

  it('disables and revokes kiosks', async () => {
    mocks.organizations.mockResolvedValue({ items: [organization({ canManageDevices: true })] });
    mocks.setDeviceEnabled.mockResolvedValue({});
    mocks.revokeDevice.mockResolvedValue({});
    render(<AttendanceAdmin />);

    // Disabling stops clock-ins at the site, so it is confirmed first.
    fireEvent.click(await screen.findByRole('button', { name: /^Disable / }));
    const dialog = await screen.findByRole('alertdialog', { name: /^Disable / });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(mocks.setDeviceEnabled).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /^Disable / }));
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Disable kiosk',
      }),
    );
    await waitFor(() => expect(mocks.setDeviceEnabled).toHaveBeenCalledWith('device-1', false));

    fireEvent.click(screen.getByRole('button', { name: /^Revoke / }));
    const form = screen.getByRole('form', { name: 'Revoke kiosk' });
    fireEvent.change(within(form).getByLabelText('Reason'), { target: { value: 'Stolen' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Revoke kiosk' }));
    await waitFor(() => expect(mocks.revokeDevice).toHaveBeenCalledWith('device-1', 'Stolen'));

    // A new enrollment code takes the kiosk offline until it enrolls again: confirmed too.
    mocks.rotateDevice.mockResolvedValue({
      device,
      enrollment: { code: 'WXYZ-1234-5678', expiresAt: '2026-10-06T12:00:00.000Z' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'New enrollment code' }));
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cancel' }),
    );
    expect(mocks.rotateDevice).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'New enrollment code' }));
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Issue new code',
      }),
    );
    await waitFor(() => expect(mocks.rotateDevice).toHaveBeenCalledWith('device-1'));
    expect(await screen.findByTestId('enrollment-code')).toHaveTextContent('WXYZ-1234-5678');
  });

  it('adds an attendance policy with only the chosen settings', async () => {
    mocks.organizations.mockResolvedValue({ items: [organization({ canManagePolicies: true })] });
    mocks.createPolicy.mockResolvedValue({});
    render(<AttendanceAdmin />);

    const form = await screen.findByRole('form', { name: 'Add attendance policy' });
    fireEvent.change(within(form).getByLabelText('Effective from'), {
      target: { value: '2026-11-01' },
    });
    fireEvent.change(within(form).getByLabelText('Capture'), { target: { value: 'KIOSK_ONLY' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Add policy' }));
    // Batch 4E-2: a capture change is confirmed with what it affects.
    const warning = await screen.findByRole('alertdialog', { name: 'Save these policy changes?' });
    expect(warning).toHaveTextContent('kiosk-only capture refuses self-service');
    expect(mocks.createPolicy).not.toHaveBeenCalled();
    fireEvent.click(within(warning).getByRole('button', { name: 'Save policy' }));

    await waitFor(() =>
      expect(mocks.createPolicy).toHaveBeenCalledWith({
        scopeType: 'ORGANIZATION',
        organizationId: 'org-1',
        inheritanceMode: 'INHERIT',
        effectiveFrom: '2026-11-01',
        config: { attendance: { captureMode: 'KIOSK_ONLY' } },
      }),
    );
  });

  it('formats an instant as local wall time in a timezone', () => {
    expect(localDateTimeIn('2026-07-01T16:30:00.000Z', 'America/Toronto')).toBe('2026-07-01T12:30');
    expect(localDateTimeIn('2026-01-01T04:59:00.000Z', 'America/Toronto')).toBe('2025-12-31T23:59');
  });
});
