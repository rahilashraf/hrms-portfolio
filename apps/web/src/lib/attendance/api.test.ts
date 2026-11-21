import { beforeEach, describe, expect, it, vi } from 'vitest';
import { attendanceApi } from './api';

const apiRequest = vi.hoisted(() => vi.fn());

vi.mock('../auth/api-client', () => ({ apiRequest }));

beforeEach(() => {
  apiRequest.mockReset();
  apiRequest.mockResolvedValue({});
});

describe('attendanceApi', () => {
  it('maps self-service sign-in and PIN routes', async () => {
    await attendanceApi.signIn('assignment-1', 'key-1');
    await attendanceApi.mySignIns({ from: '2026-10-01' });
    await attendanceApi.myPin();
    await attendanceApi.changeMyPin({ currentPin: '135790', newPin: '246813' });

    expect(apiRequest).toHaveBeenNthCalledWith(1, '/time/me/sign-in', {
      method: 'POST',
      body: JSON.stringify({ employmentAssignmentId: 'assignment-1', idempotencyKey: 'key-1' }),
    });
    expect(apiRequest).toHaveBeenNthCalledWith(2, '/time/me/sign-ins?from=2026-10-01');
    expect(apiRequest).toHaveBeenNthCalledWith(3, '/time/me/attendance-pin');
    expect(apiRequest).toHaveBeenNthCalledWith(4, '/time/me/attendance-pin', {
      method: 'PUT',
      body: JSON.stringify({ currentPin: '135790', newPin: '246813' }),
    });
  });

  it('maps management routes with encoded ids', async () => {
    await attendanceApi.organizations();
    await attendanceApi.managedSignIns({ organizationId: 'org-1', includeVoided: true });
    await attendanceApi.voidSignIn('sign/1', 'Duplicate');
    await attendanceApi.correctSignIn('sign/1', {
      signedInAt: '2026-10-02T09:05',
      reason: 'Late entry',
    });
    await attendanceApi.revokeDevice('device/1', 'Stolen');
    await attendanceApi.setDeviceEnabled('device-1', false);
    await attendanceApi.issuePin('employee/1');
    await attendanceApi.policies('org-1');
    await attendanceApi.reopenTimesheet('sheet-1', 'Late correction');

    expect(apiRequest.mock.calls.map((call) => call[0])).toEqual([
      '/time/manage/organizations',
      '/time/manage/sign-ins?organizationId=org-1&includeVoided=true',
      '/time/sign-ins/sign%2F1/void',
      '/time/sign-ins/sign%2F1/correct',
      '/time/devices/device%2F1/revoke',
      '/time/devices/device-1/disable',
      '/time/employees/employee%2F1/attendance-pin',
      '/time/policies?organizationId=org-1',
      '/time/timesheets/sheet-1/reopen',
    ]);
    expect(apiRequest.mock.calls[6]?.[1]).toEqual({ method: 'POST' });
  });

  it('opts in to the history of organizations with attendance turned off (Batch 4F, C10)', async () => {
    await attendanceApi.organizations({ includeDisabledOrganizations: true });
    await attendanceApi.managedSignIns({
      organizationId: 'org-2',
      includeDisabledOrganizations: true,
    });
    await attendanceApi.managedSignIns({
      organizationId: 'org-1',
      includeDisabledOrganizations: false,
    });
    expect(apiRequest.mock.calls.map((call) => call[0])).toEqual([
      '/time/manage/organizations?includeDisabledOrganizations=true',
      '/time/manage/sign-ins?organizationId=org-2&includeDisabledOrganizations=true',
      '/time/manage/sign-ins?organizationId=org-1',
    ]);
  });
});
