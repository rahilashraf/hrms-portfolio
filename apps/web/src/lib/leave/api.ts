import { apiRequest } from '../auth/api-client';
import type {
  Holiday,
  HolidayInput,
  LeaveAdjustmentInput,
  LeaveAmendInput,
  LeaveBalanceRow,
  LeaveCalendar,
  LeaveDayOverride,
  LeaveDecisionResult,
  LeaveLedgerView,
  LeaveOrganization,
  LeavePage,
  LeavePolicy,
  LeavePolicyInput,
  LeavePolicySettings,
  LeavePreview,
  LeaveRequestDetail,
  LeaveRequestInput,
  LeaveRequestStatus,
  LeaveType,
  LeaveTypeInput,
  LeaveOnBehalfInput,
  MyHoliday,
  MyLeaveOverview,
  MyLeaveRequest,
  QueuedLeaveRequest,
  ResolvedLeavePolicy,
  TeamCalendar,
} from './types';

type Query = Record<string, string | number | boolean | undefined>;

function queryString(query: Query = {}): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== '') params.set(key, String(value));
  }
  const result = params.toString();
  return result ? `?${result}` : '';
}

const enc = encodeURIComponent;

function post<T>(path: string, body?: unknown): Promise<T> {
  return apiRequest(path, {
    method: 'POST',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

export const leaveApi = {
  // ─── Employee self-service ───────────────────────────────────────────────
  me(): Promise<MyLeaveOverview> {
    return apiRequest('/leave/me');
  },
  myRequests(
    query: { status?: LeaveRequestStatus; afterId?: string; limit?: number } = {},
  ): Promise<LeavePage<MyLeaveRequest>> {
    return apiRequest(`/leave/me/requests${queryString(query)}`);
  },
  previewOwn(input: LeaveRequestInput): Promise<LeavePreview> {
    return post('/leave/me/requests/preview', input);
  },
  submitOwn(input: LeaveRequestInput): Promise<LeaveDecisionResult> {
    return post('/leave/me/requests', input);
  },
  myRequest(requestId: string): Promise<LeaveRequestDetail> {
    return apiRequest(`/leave/me/requests/${enc(requestId)}`);
  },
  cancelOwn(requestId: string, reason?: string): Promise<LeaveDecisionResult> {
    return post(`/leave/me/requests/${enc(requestId)}/cancel`, reason ? { reason } : {});
  },
  myLedger(accountId: string): Promise<LeaveLedgerView> {
    return apiRequest(`/leave/me/accounts/${enc(accountId)}/ledger`);
  },
  /** Batch 6B (D4): teammates absent on approved leave — names and "Absent" only. */
  myTeamCalendar(from: string, to: string): Promise<TeamCalendar> {
    return apiRequest(`/leave/me/team-calendar${queryString({ from, to })}`);
  },
  /** Batch 6B (D6): holidays that apply to one's own assignments. */
  myHolidays(from: string, to: string): Promise<{ items: MyHoliday[] }> {
    return apiRequest(`/leave/me/holidays${queryString({ from, to })}`);
  },

  // ─── Management ──────────────────────────────────────────────────────────
  organizations(): Promise<{ items: LeaveOrganization[] }> {
    return apiRequest('/leave/organizations');
  },
  queue(query: {
    organizationId: string;
    status?: LeaveRequestStatus;
    employeeId?: string;
    leaveTypeId?: string;
    from?: string;
    to?: string;
    afterId?: string;
    limit?: number;
  }): Promise<LeavePage<QueuedLeaveRequest>> {
    return apiRequest(`/leave/requests${queryString(query)}`);
  },
  request(requestId: string): Promise<LeaveRequestDetail> {
    return apiRequest(`/leave/requests/${enc(requestId)}`);
  },
  /** Batch 6B: previews leave for an employee's assignment (leave.approve). */
  previewForEmployee(input: LeaveRequestInput): Promise<LeavePreview> {
    return post('/leave/requests/preview', input);
  },
  /** Batch 6B: records leave for an employee, optionally approving it (never one's own). */
  recordForEmployee(input: LeaveOnBehalfInput): Promise<LeaveDecisionResult> {
    return post('/leave/requests', input);
  },
  approve(
    requestId: string,
    input: { note?: string; dayOverrides?: LeaveDayOverride[] } = {},
  ): Promise<LeaveDecisionResult> {
    return post(`/leave/requests/${enc(requestId)}/approve`, input);
  },
  reject(requestId: string, note?: string): Promise<LeaveDecisionResult> {
    return post(`/leave/requests/${enc(requestId)}/reject`, note ? { note } : {});
  },
  amend(requestId: string, input: LeaveAmendInput): Promise<LeaveDecisionResult> {
    return post(`/leave/requests/${enc(requestId)}/amend`, input);
  },
  balances(query: {
    organizationId: string;
    leaveTypeId?: string;
    employeeId?: string;
    asOf?: string;
    afterId?: string;
    limit?: number;
  }): Promise<LeavePage<LeaveBalanceRow> & { asOf: string | null }> {
    return apiRequest(`/leave/balances${queryString(query)}`);
  },
  ledger(accountId: string): Promise<LeaveLedgerView> {
    return apiRequest(`/leave/accounts/${enc(accountId)}/ledger`);
  },
  adjust(input: LeaveAdjustmentInput): Promise<unknown> {
    return post('/leave/adjustments', input);
  },
  reverse(entryId: string, reason: string): Promise<unknown> {
    return post(`/leave/ledger-entries/${enc(entryId)}/reverse`, { reason });
  },
  calendar(query: {
    organizationId: string;
    from: string;
    to: string;
    departmentId?: string;
    teamId?: string;
    includePending?: boolean;
  }): Promise<LeaveCalendar> {
    return apiRequest(`/leave/calendar${queryString(query)}`);
  },

  // ─── Configuration ───────────────────────────────────────────────────────
  types(organizationId: string, includeArchived = false): Promise<{ items: LeaveType[] }> {
    return apiRequest(
      `/leave/types${queryString({ organizationId, includeArchived: includeArchived || undefined })}`,
    );
  },
  createType(input: LeaveTypeInput): Promise<LeaveType> {
    return post('/leave/types', input);
  },
  updateType(
    typeId: string,
    input: Partial<Pick<LeaveTypeInput, 'name' | 'description' | 'displayUnit'>>,
  ): Promise<LeaveType> {
    return apiRequest(`/leave/types/${enc(typeId)}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    });
  },
  archiveType(typeId: string): Promise<LeaveType> {
    return post(`/leave/types/${enc(typeId)}/archive`);
  },
  /** Batch 6B: which policy applies to an assignment, for a leave type, on a date. */
  resolvePolicy(query: {
    employmentAssignmentId: string;
    leaveTypeId: string;
    date: string;
  }): Promise<ResolvedLeavePolicy> {
    return apiRequest(`/leave/policies/resolve${queryString(query)}`);
  },
  policies(organizationId: string, leaveTypeId?: string): Promise<{ items: LeavePolicy[] }> {
    return apiRequest(`/leave/policies${queryString({ organizationId, leaveTypeId })}`);
  },
  createPolicy(input: LeavePolicyInput): Promise<LeavePolicy> {
    return post('/leave/policies', input);
  },
  updatePolicy(
    policyId: string,
    input: LeavePolicySettings & { effectiveFrom?: string; effectiveTo?: string | null },
  ): Promise<LeavePolicy> {
    return apiRequest(`/leave/policies/${enc(policyId)}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    });
  },
  endPolicy(policyId: string, effectiveTo: string): Promise<LeavePolicy> {
    return post(`/leave/policies/${enc(policyId)}/end`, { effectiveTo });
  },
  deletePolicy(policyId: string): Promise<unknown> {
    return apiRequest(`/leave/policies/${enc(policyId)}`, { method: 'DELETE' });
  },

  // ─── Holiday calendar ────────────────────────────────────────────────────
  holidays(query: {
    organizationId: string;
    from: string;
    to: string;
    includeArchived?: boolean;
  }): Promise<{ items: Holiday[] }> {
    return apiRequest(`/holidays${queryString(query)}`);
  },
  createHoliday(input: HolidayInput): Promise<Holiday> {
    return post('/holidays', input);
  },
  updateHoliday(
    holidayId: string,
    input: Partial<Pick<HolidayInput, 'date' | 'name' | 'kind'>>,
  ): Promise<Holiday> {
    return apiRequest(`/holidays/${enc(holidayId)}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    });
  },
  archiveHoliday(holidayId: string): Promise<Holiday> {
    return post(`/holidays/${enc(holidayId)}/archive`);
  },
};
