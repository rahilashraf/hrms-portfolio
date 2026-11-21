import { beforeEach, describe, expect, it, vi } from 'vitest';
import { timeApi } from './api';

const apiRequest = vi.hoisted(() => vi.fn());

vi.mock('../auth/api-client', () => ({ apiRequest }));

beforeEach(() => {
  apiRequest.mockClear();
});

describe('timeApi', () => {
  it('maps the Batch 4F routes', async () => {
    apiRequest.mockResolvedValue({});
    await timeApi.managementEntries({
      organizationId: 'org-2',
      includeDisabledOrganizations: true,
    });
    await timeApi.scheduledVsActual({
      organizationId: 'org-1',
      from: '2026-10-05',
      to: '2026-10-11',
      afterKey: '2026-10-05|a',
      limit: 100,
    });
    await timeApi.linkScheduledShift('entry/1', { scheduledShiftId: null, reason: 'Wrong' });

    expect(apiRequest).toHaveBeenNthCalledWith(
      1,
      '/time/manage/entries?organizationId=org-2&includeDisabledOrganizations=true',
    );
    expect(apiRequest).toHaveBeenNthCalledWith(
      2,
      '/time/manage/scheduled-vs-actual?organizationId=org-1&from=2026-10-05&to=2026-10-11&afterKey=2026-10-05%7Ca&limit=100',
    );
    expect(apiRequest).toHaveBeenNthCalledWith(3, '/time/entries/entry%2F1/scheduled-shift', {
      method: 'POST',
      body: JSON.stringify({ scheduledShiftId: null, reason: 'Wrong' }),
    });
  });

  it('maps employee self-service routes', async () => {
    apiRequest.mockResolvedValue({});

    await timeApi.status();
    await timeApi.selfEntries({ startDate: '2026-10-01', limit: 25 });
    await timeApi.clockIn('assignment/1');
    await timeApi.resolveMissedClockOut('exception/1', '2026-10-02T17:00');
    await timeApi.requestCorrection({
      type: 'CHANGE_CLOCK_OUT',
      timeEntryId: 'entry-1',
      clockOutAt: '2026-10-02T17:00',
      reason: 'Forgot',
    });
    await timeApi.submitTimesheet('timesheet/1');

    expect(apiRequest).toHaveBeenNthCalledWith(1, '/time/me/status');
    expect(apiRequest).toHaveBeenNthCalledWith(2, '/time/me/entries?startDate=2026-10-01&limit=25');
    expect(apiRequest).toHaveBeenNthCalledWith(3, '/time/me/clock-in', {
      method: 'POST',
      body: JSON.stringify({ employmentAssignmentId: 'assignment/1' }),
    });
    expect(apiRequest).toHaveBeenNthCalledWith(
      4,
      '/time/me/exceptions/exception%2F1/resolve-missed-clock-out',
      { method: 'POST', body: JSON.stringify({ clockOutAt: '2026-10-02T17:00' }) },
    );
    expect(apiRequest).toHaveBeenNthCalledWith(5, '/time/me/corrections', {
      method: 'POST',
      body: JSON.stringify({
        type: 'CHANGE_CLOCK_OUT',
        timeEntryId: 'entry-1',
        clockOutAt: '2026-10-02T17:00',
        reason: 'Forgot',
      }),
    });
    // Batch 4E-3 (C3): the totals and version reviewed (none here: an empty body).
    expect(apiRequest).toHaveBeenNthCalledWith(6, '/time/me/timesheets/timesheet%2F1/submit', {
      method: 'POST',
      body: '{}',
    });
  });

  it('maps the Batch 4E-3 employee routes', async () => {
    apiRequest.mockResolvedValue({});
    await timeApi.selfCorrections({ status: 'PENDING', limit: 20, afterId: 'c-1' });
    await timeApi.selfExceptions({ limit: 20 });
    await timeApi.selfTimesheet('timesheet/1');
    await timeApi.submitTimesheet('timesheet/1', {
      expectedNetWorkedMinutes: 210,
      expectedVersion: 2,
    });
    await timeApi.expectedAttendance({ from: '2027-03-01', to: '2027-03-07' });
    expect(apiRequest).toHaveBeenNthCalledWith(
      1,
      '/time/me/corrections?status=PENDING&limit=20&afterId=c-1',
    );
    expect(apiRequest).toHaveBeenNthCalledWith(2, '/time/me/exceptions?limit=20');
    expect(apiRequest).toHaveBeenNthCalledWith(3, '/time/me/timesheets/timesheet%2F1');
    expect(apiRequest).toHaveBeenNthCalledWith(4, '/time/me/timesheets/timesheet%2F1/submit', {
      method: 'POST',
      body: JSON.stringify({ expectedNetWorkedMinutes: 210, expectedVersion: 2 }),
    });
    expect(apiRequest).toHaveBeenNthCalledWith(
      5,
      '/time/me/expected-attendance?from=2027-03-01&to=2027-03-07',
    );
  });

  it('maps management read and approval routes', async () => {
    apiRequest.mockResolvedValue({});

    await timeApi.managementCurrent({ search: 'Ada', limit: 10 });
    await timeApi.managementCorrections({ status: 'PENDING' });
    await timeApi.managementTimesheets({ segmentStatus: 'PENDING' });
    await timeApi.approveCorrection('correction/1', 'ok');
    await timeApi.requestTimesheetChanges('segment/1', 'fix');

    expect(apiRequest).toHaveBeenNthCalledWith(1, '/time/manage/current?search=Ada&limit=10');
    expect(apiRequest).toHaveBeenNthCalledWith(2, '/time/manage/corrections?status=PENDING');
    expect(apiRequest).toHaveBeenNthCalledWith(3, '/time/manage/timesheets?segmentStatus=PENDING');
    expect(apiRequest).toHaveBeenNthCalledWith(4, '/time/corrections/correction%2F1/approve', {
      method: 'POST',
      body: JSON.stringify({ reviewerNote: 'ok' }),
    });
    expect(apiRequest).toHaveBeenNthCalledWith(
      5,
      '/time/timesheet-segments/segment%2F1/request-changes',
      { method: 'POST', body: JSON.stringify({ note: 'fix' }) },
    );
  });

  it('sends the reviewed minutes with a segment approval (Batch 4A stale-review guard)', async () => {
    apiRequest.mockResolvedValue({});

    await timeApi.approveTimesheetSegment('segment/1', undefined, 180);

    expect(apiRequest).toHaveBeenCalledWith('/time/timesheet-segments/segment%2F1/approve', {
      method: 'POST',
      body: JSON.stringify({ expectedNetWorkedMinutes: 180 }),
    });
  });
});
