import { apiRequest } from '../auth/api-client';
import type {
  CorrectionRequestInput,
  DirectCorrectionInput,
  ExpectedAttendanceItem,
  ManagerEntryInput,
  MaterializeResult,
  ScheduledVsActualQuery,
  ScheduledVsActualResponse,
  ScheduleLinkResult,
  TimeCorrection,
  TimePeriod,
  TimeEntryRead,
  TimeException,
  TimePage,
  TimeQuery,
  TimeStatus,
  Timesheet,
  Truncation,
} from './types';

function queryString(
  query: TimeQuery | Record<string, string | number | boolean | undefined> = {},
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== '') params.set(key, String(value));
  }
  const result = params.toString();
  return result ? `?${result}` : '';
}

const enc = encodeURIComponent;

export const timeApi = {
  status(): Promise<TimeStatus> {
    return apiRequest('/time/me/status');
  },
  selfEntries(query: TimeQuery = {}): Promise<TimePage<TimeEntryRead>> {
    return apiRequest(`/time/me/entries${queryString(query)}`);
  },
  /** Batch 4E-3 (C4): paged with afterId/limit/status. */
  selfExceptions(query: { status?: string; limit?: number; afterId?: string } = {}): Promise<{
    exceptions: TimeException[];
    nextAfterId?: string | null;
    attendanceDisabledOrganizationIds?: string[];
  }> {
    return apiRequest(`/time/me/exceptions${queryString(query)}`);
  },
  /** Batch 4E-3 (C4): paged with afterId/limit/status. */
  selfCorrections(query: { status?: string; limit?: number; afterId?: string } = {}): Promise<{
    corrections: TimeCorrection[];
    nextAfterId?: string | null;
    attendanceDisabledOrganizationIds?: string[];
  }> {
    return apiRequest(`/time/me/corrections${queryString(query)}`);
  },
  selfTimesheets(): Promise<{
    timesheets: Timesheet[];
    attendanceDisabledOrganizationIds?: string[];
  }> {
    return apiRequest('/time/me/timesheets');
  },
  /** Batch 4E-3 (C3): one timesheet, refreshed when still open, with actor names. */
  selfTimesheet(timesheetId: string): Promise<Timesheet> {
    return apiRequest(`/time/me/timesheets/${enc(timesheetId)}`);
  },
  /**
   * Batch 4E-3 (C8): the employee's published shifts and their attendance (31 days at most).
   * Batch 4F (Q3): capped (`truncated`, `limit`) — a capped answer is never complete.
   */
  expectedAttendance(range: { from: string; to: string }): Promise<
    {
      from: string;
      to: string;
      items: ExpectedAttendanceItem[];
      /** Batch 4F (C10): the caller's organizations with attendance turned off. */
      attendanceDisabledOrganizationIds?: string[];
    } & Truncation
  > {
    return apiRequest(`/time/me/expected-attendance?from=${enc(range.from)}&to=${enc(range.to)}`);
  },
  /**
   * R4-A.3: one physical clock-in; `additionalEmploymentAssignmentIds` are also covered (coverage
   * only — the time counts once, under `employmentAssignmentId`). The API checks each one.
   */
  clockIn(
    employmentAssignmentId: string,
    scheduledShiftId?: string,
    additionalEmploymentAssignmentIds: string[] = [],
  ): Promise<TimeStatus> {
    return apiRequest('/time/me/clock-in', {
      method: 'POST',
      body: JSON.stringify({
        employmentAssignmentId,
        ...(scheduledShiftId ? { scheduledShiftId } : {}),
        ...(additionalEmploymentAssignmentIds.length > 0
          ? { additionalEmploymentAssignmentIds }
          : {}),
      }),
    });
  },
  clockOut(): Promise<TimeStatus> {
    return apiRequest('/time/me/clock-out', { method: 'POST' });
  },
  startBreak(): Promise<TimeStatus> {
    return apiRequest('/time/me/break/start', { method: 'POST' });
  },
  endBreak(): Promise<TimeStatus> {
    return apiRequest('/time/me/break/end', { method: 'POST' });
  },
  switchAssignment(employmentAssignmentId: string, scheduledShiftId?: string): Promise<TimeStatus> {
    return apiRequest('/time/me/switch-assignment', {
      method: 'POST',
      body: JSON.stringify({
        employmentAssignmentId,
        ...(scheduledShiftId ? { scheduledShiftId } : {}),
      }),
    });
  },
  resolveMissedClockOut(exceptionId: string, clockOutAt: string): Promise<TimeStatus> {
    return apiRequest(`/time/me/exceptions/${enc(exceptionId)}/resolve-missed-clock-out`, {
      method: 'POST',
      body: JSON.stringify({ clockOutAt }),
    });
  },
  requestCorrection(input: CorrectionRequestInput): Promise<TimeCorrection> {
    return apiRequest('/time/me/corrections', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
  cancelCorrection(correctionId: string): Promise<TimeCorrection> {
    return apiRequest(`/time/me/corrections/${enc(correctionId)}/cancel`, { method: 'POST' });
  },
  /**
   * Batch 4E-3 (C3): the totals and version the employee reviewed. If the timesheet changed
   * since, the API refuses with 409 TIMESHEET_TOTALS_CHANGED and nothing is submitted.
   */
  submitTimesheet(
    timesheetId: string,
    expected: { expectedNetWorkedMinutes?: number; expectedVersion?: number } = {},
  ): Promise<Timesheet> {
    return apiRequest(`/time/me/timesheets/${enc(timesheetId)}/submit`, {
      method: 'POST',
      body: JSON.stringify(expected),
    });
  },
  managementCurrent(query: TimeQuery = {}): Promise<TimePage<TimeEntryRead>> {
    return apiRequest(`/time/manage/current${queryString(query)}`);
  },
  managementEntries(query: TimeQuery = {}): Promise<TimePage<TimeEntryRead>> {
    return apiRequest(`/time/manage/entries${queryString(query)}`);
  },
  managementExceptions(query: TimeQuery = {}): Promise<TimePage<TimeException>> {
    return apiRequest(`/time/manage/exceptions${queryString(query)}`);
  },
  managementCorrections(query: TimeQuery = {}): Promise<TimePage<TimeCorrection>> {
    return apiRequest(`/time/manage/corrections${queryString(query)}`);
  },
  managementTimesheets(query: TimeQuery = {}): Promise<TimePage<Timesheet>> {
    return apiRequest(`/time/manage/timesheets${queryString(query)}`);
  },
  approveCorrection(correctionId: string, reviewerNote?: string): Promise<TimeCorrection> {
    return apiRequest(`/time/corrections/${enc(correctionId)}/approve`, {
      method: 'POST',
      body: JSON.stringify({ reviewerNote }),
    });
  },
  rejectCorrection(correctionId: string, reviewerNote?: string): Promise<TimeCorrection> {
    return apiRequest(`/time/corrections/${enc(correctionId)}/reject`, {
      method: 'POST',
      body: JSON.stringify({ reviewerNote }),
    });
  },
  /**
   * `expectedNetWorkedMinutes`: the minutes the reviewer saw. If the segment changed since, the
   * API refuses with 409 TIMESHEET_SEGMENT_CHANGED instead of approving other numbers.
   */
  approveTimesheetSegment(
    segmentId: string,
    note?: string,
    expectedNetWorkedMinutes?: number,
  ): Promise<Timesheet> {
    return apiRequest(`/time/timesheet-segments/${enc(segmentId)}/approve`, {
      method: 'POST',
      body: JSON.stringify({ note, expectedNetWorkedMinutes }),
    });
  },
  requestTimesheetChanges(segmentId: string, note?: string): Promise<Timesheet> {
    return apiRequest(`/time/timesheet-segments/${enc(segmentId)}/request-changes`, {
      method: 'POST',
      body: JSON.stringify({ note }),
    });
  },

  // ─── Batch 4E-1: manager review ──────────────────────────────────────────

  /**
   * Approves a segment only if it still shows what the reviewer saw: its minutes and the
   * timesheet's version (409 TIMESHEET_SEGMENT_CHANGED / TIMESHEET_VERSION_CONFLICT otherwise).
   */
  approveSegmentAsSeen(
    segmentId: string,
    seen: { netWorkedMinutes: number; version: number },
    note?: string,
  ): Promise<Timesheet> {
    return apiRequest(`/time/timesheet-segments/${enc(segmentId)}/approve`, {
      method: 'POST',
      body: JSON.stringify({
        ...(note ? { note } : {}),
        expectedNetWorkedMinutes: seen.netWorkedMinutes,
        expectedVersion: seen.version,
      }),
    });
  },
  lockTimesheet(timesheetId: string, expectedVersion: number): Promise<Timesheet> {
    return apiRequest(`/time/timesheets/${enc(timesheetId)}/lock`, {
      method: 'POST',
      body: JSON.stringify({ expectedVersion }),
    });
  },
  submitTimesheetOnBehalf(timesheetId: string, reason: string): Promise<Timesheet> {
    return apiRequest(`/time/timesheets/${enc(timesheetId)}/submit-on-behalf`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    });
  },
  reopenTimesheet(timesheetId: string, note: string, expectedVersion: number): Promise<Timesheet> {
    return apiRequest(`/time/timesheets/${enc(timesheetId)}/reopen`, {
      method: 'POST',
      body: JSON.stringify({ note, expectedVersion }),
    });
  },
  periods(query: {
    organizationId: string;
    from?: string;
    to?: string;
    status?: string;
    limit?: number;
    afterId?: string;
    /** Batch 4F (C10): also periods of organizations with attendance turned off (read only). */
    includeDisabledOrganizations?: boolean;
  }): Promise<TimePage<TimePeriod>> {
    return apiRequest(`/time/periods${queryString(query)}`);
  },
  generatePeriods(input: {
    organizationId: string;
    startDate: string;
    cadence: 'WEEKLY' | 'BIWEEKLY' | 'MONTHLY';
    count?: number;
  }): Promise<{ periods: Array<Omit<TimePeriod, 'payrollManaged' | 'timesheetCount'>> }> {
    return apiRequest('/time/periods/generate', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
  materializeTimesheets(periodId: string): Promise<MaterializeResult> {
    return apiRequest(`/time/periods/${enc(periodId)}/materialize-timesheets`, { method: 'POST' });
  },
  resolveException(exceptionId: string, note: string): Promise<TimeException> {
    return apiRequest(`/time/exceptions/${enc(exceptionId)}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ note }),
    });
  },
  dismissException(exceptionId: string, note: string): Promise<TimeException> {
    return apiRequest(`/time/exceptions/${enc(exceptionId)}/dismiss`, {
      method: 'POST',
      body: JSON.stringify({ note }),
    });
  },
  /** A manager records a missing entry (time.correct; never one's own). */
  addEntry(employeeId: string, input: ManagerEntryInput): Promise<unknown> {
    return apiRequest(`/time/employees/${enc(employeeId)}/entries`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
  /**
   * Batch 4F (Q8): published shifts vs actual time per work date and assignment (31 days at
   * most), paged with the opaque `afterKey`.
   */
  scheduledVsActual(query: ScheduledVsActualQuery): Promise<ScheduledVsActualResponse> {
    return apiRequest(`/time/manage/scheduled-vs-actual${queryString({ ...query })}`);
  },
  /**
   * Batch 4F (Q8): link an entry to a published shift of its assignment, re-link it, or unlink
   * it (`null`), with a reason (time.correct; never one's own time; never finalized time).
   */
  linkScheduledShift(
    entryId: string,
    input: { scheduledShiftId: string | null; reason: string },
  ): Promise<ScheduleLinkResult> {
    return apiRequest(`/time/entries/${enc(entryId)}/scheduled-shift`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
  /** A manager corrects an entry directly (time.correct; recorded as an approved adjustment). */
  correctEntry(entryId: string, input: DirectCorrectionInput): Promise<unknown> {
    return apiRequest(`/time/entries/${enc(entryId)}/correct`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
};
