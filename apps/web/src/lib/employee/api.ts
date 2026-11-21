import { apiRequest } from '../auth/api-client';
import type {
  EmployeeAssignmentActivationResponse,
  EmployeeAssignmentCreateInput,
  EmployeeCapabilities,
  EmployeeAssignmentEndInput,
  EmployeeAssignmentManagerInput,
  EmployeeAssignmentMutationResponse,
  EmployeeAssignmentPrimaryInput,
  EmployeeAssignmentUpdateInput,
  EmployeeCreateInput,
  EmployeeDirectoryQuery,
  EmployeeDirectoryResponse,
  EmployeeMutationResponse,
  EmployeeManagerAssignmentOption,
  EmployeeManagerAssignmentOptionQuery,
  EmployeeOptionQuery,
  EmployeeOptionResponse,
  EmployeePersonOption,
  EmployeePositionOption,
  EmployeePositionOptionQuery,
  EmployeeProfile,
  EmployeeRehireInput,
  EmployeeTerminationInput,
  EmployeeTerminationResult,
  EmployeeUpdateInput,
  MyEmployeeProfile,
  EmployeeAccount,
  AssignmentImpact,
  EmployeeAccessReview,
  EmployeeRehireResult,
  EmployeeRevokeGrantsResult,
  EmployeeStatusChangeResult,
  EmployeeTermination,
  EmployeeTerminationPreview,
  EmployeeTransferInput,
  EmployeeTransferResult,
  LifecycleDue,
  TerminationGrantDecisionInput,
  TerminationGrantList,
} from './types';

function queryString(query: object): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== '') params.set(key, String(value));
  }
  const result = params.toString();
  return result ? `?${result}` : '';
}

export const employeeApi = {
  /** My Profile: the caller's own employee record. */
  me(): Promise<MyEmployeeProfile> {
    return apiRequest('/employees/me');
  },
  list(query: EmployeeDirectoryQuery = {}): Promise<EmployeeDirectoryResponse> {
    return apiRequest(`/employees${queryString(query)}`);
  },
  get(employeeId: string): Promise<EmployeeProfile> {
    return apiRequest(`/employees/${encodeURIComponent(employeeId)}`);
  },
  capabilities(employeeId: string): Promise<EmployeeCapabilities> {
    return apiRequest(`/employees/${encodeURIComponent(employeeId)}/capabilities`);
  },
  create(input: EmployeeCreateInput): Promise<EmployeeMutationResponse> {
    return apiRequest('/employees', { method: 'POST', body: JSON.stringify(input) });
  },
  update(employeeId: string, input: EmployeeUpdateInput): Promise<EmployeeMutationResponse> {
    return apiRequest(`/employees/${encodeURIComponent(employeeId)}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    });
  },
  listPersonOptions(
    query: EmployeeOptionQuery = {},
  ): Promise<EmployeeOptionResponse<EmployeePersonOption>> {
    return apiRequest(`/employees/options/people${queryString(query)}`);
  },
  listPositionOptions(
    query: EmployeePositionOptionQuery = {},
  ): Promise<EmployeeOptionResponse<EmployeePositionOption>> {
    return apiRequest(`/employees/options/positions${queryString(query)}`);
  },
  listManagerAssignmentOptions(
    query: EmployeeManagerAssignmentOptionQuery,
  ): Promise<EmployeeOptionResponse<EmployeeManagerAssignmentOption>> {
    return apiRequest(`/employees/options/manager-assignments${queryString(query)}`);
  },
  createAssignment(
    employeeId: string,
    input: EmployeeAssignmentCreateInput,
  ): Promise<EmployeeAssignmentMutationResponse> {
    return apiRequest(`/employees/${encodeURIComponent(employeeId)}/assignments`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
  updateAssignment(
    employeeId: string,
    assignmentId: string,
    input: EmployeeAssignmentUpdateInput,
  ): Promise<EmployeeAssignmentMutationResponse> {
    return apiRequest(
      `/employees/${encodeURIComponent(employeeId)}/assignments/${encodeURIComponent(assignmentId)}`,
      { method: 'PATCH', body: JSON.stringify(input) },
    );
  },
  endAssignment(
    employeeId: string,
    assignmentId: string,
    input: EmployeeAssignmentEndInput,
  ): Promise<EmployeeAssignmentMutationResponse> {
    return apiRequest(
      `/employees/${encodeURIComponent(employeeId)}/assignments/${encodeURIComponent(assignmentId)}/end`,
      { method: 'POST', body: JSON.stringify(input) },
    );
  },
  cancelAssignment(
    employeeId: string,
    assignmentId: string,
  ): Promise<EmployeeAssignmentMutationResponse> {
    return apiRequest(
      `/employees/${encodeURIComponent(employeeId)}/assignments/${encodeURIComponent(assignmentId)}/cancel`,
      { method: 'POST' },
    );
  },
  activateAssignment(
    employeeId: string,
    assignmentId: string,
  ): Promise<EmployeeAssignmentActivationResponse> {
    return apiRequest(
      `/employees/${encodeURIComponent(employeeId)}/assignments/${encodeURIComponent(assignmentId)}/activate`,
      { method: 'POST' },
    );
  },
  setAssignmentPrimary(
    employeeId: string,
    assignmentId: string,
    input: EmployeeAssignmentPrimaryInput,
  ): Promise<EmployeeAssignmentMutationResponse> {
    return apiRequest(
      `/employees/${encodeURIComponent(employeeId)}/assignments/${encodeURIComponent(assignmentId)}/primary`,
      { method: 'PATCH', body: JSON.stringify(input) },
    );
  },
  setAssignmentManager(
    employeeId: string,
    assignmentId: string,
    input: EmployeeAssignmentManagerInput,
  ): Promise<EmployeeAssignmentMutationResponse> {
    return apiRequest(
      `/employees/${encodeURIComponent(employeeId)}/assignments/${encodeURIComponent(assignmentId)}/manager`,
      { method: 'PATCH', body: JSON.stringify(input) },
    );
  },
  terminate(
    employeeId: string,
    input: EmployeeTerminationInput,
  ): Promise<EmployeeTerminationResult> {
    return apiRequest(`/employees/${encodeURIComponent(employeeId)}/terminate`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
  rehire(employeeId: string, input: EmployeeRehireInput): Promise<EmployeeRehireResult> {
    return apiRequest(`/employees/${encodeURIComponent(employeeId)}/rehire`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
  /** Batch 5C: the termination history (reasons only for those who may manage the employee). */
  terminations(employeeId: string): Promise<{ items: EmployeeTermination[] }> {
    return apiRequest(`/employees/${encodeURIComponent(employeeId)}/terminations`);
  },
  terminationPreview(
    employeeId: string,
    terminationDate: string,
  ): Promise<EmployeeTerminationPreview> {
    return apiRequest(
      `/employees/${encodeURIComponent(employeeId)}/termination-preview${queryString({ terminationDate })}`,
    );
  },
  cancelTermination(
    employeeId: string,
    terminationId: string,
    input: { reason?: string } = {},
  ): Promise<EmployeeTerminationResult> {
    return apiRequest(
      `/employees/${encodeURIComponent(employeeId)}/terminations/${encodeURIComponent(terminationId)}/cancel`,
      { method: 'POST', body: JSON.stringify(input) },
    );
  },
  rescheduleTermination(
    employeeId: string,
    terminationId: string,
    input: EmployeeTerminationInput,
  ): Promise<EmployeeTerminationResult> {
    return apiRequest(
      `/employees/${encodeURIComponent(employeeId)}/terminations/${encodeURIComponent(terminationId)}/reschedule`,
      { method: 'POST', body: JSON.stringify(input) },
    );
  },
  applyTermination(employeeId: string, terminationId: string): Promise<EmployeeTerminationResult> {
    return apiRequest(
      `/employees/${encodeURIComponent(employeeId)}/terminations/${encodeURIComponent(terminationId)}/apply`,
      { method: 'POST', body: JSON.stringify({}) },
    );
  },
  /** M3: the grants a termination concerns, with decisions and outcomes. */
  terminationGrants(employeeId: string, terminationId: string): Promise<TerminationGrantList> {
    return apiRequest(
      `/employees/${encodeURIComponent(employeeId)}/terminations/${encodeURIComponent(terminationId)}/grants`,
    );
  },
  /** M3: record REVOKE or KEEP decisions for a scheduled termination (a KEEP is a request). */
  recordGrantDecisions(
    employeeId: string,
    terminationId: string,
    decisions: TerminationGrantDecisionInput[],
  ): Promise<TerminationGrantList> {
    return apiRequest(
      `/employees/${encodeURIComponent(employeeId)}/terminations/${encodeURIComponent(terminationId)}/grant-decisions`,
      { method: 'POST', body: JSON.stringify({ decisions }) },
    );
  },
  /** M3: approve, reject or withdraw a keep request. */
  reviewGrantKeep(
    employeeId: string,
    terminationId: string,
    decisionId: string,
    action: 'approve' | 'reject' | 'cancel',
    note?: string,
  ): Promise<TerminationGrantList> {
    return apiRequest(
      `/employees/${encodeURIComponent(employeeId)}/terminations/${encodeURIComponent(terminationId)}/grant-decisions/${encodeURIComponent(decisionId)}/${action}`,
      {
        method: 'POST',
        body: JSON.stringify(action !== 'cancel' && note?.trim() ? { note: note.trim() } : {}),
      },
    );
  },
  inactivate(employeeId: string, reason: string): Promise<EmployeeStatusChangeResult> {
    return apiRequest(`/employees/${encodeURIComponent(employeeId)}/inactivate`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    });
  },
  reactivate(employeeId: string, reason?: string): Promise<EmployeeStatusChangeResult> {
    return apiRequest(`/employees/${encodeURIComponent(employeeId)}/reactivate`, {
      method: 'POST',
      body: JSON.stringify(reason ? { reason } : {}),
    });
  },
  accessReview(employeeId: string): Promise<EmployeeAccessReview> {
    return apiRequest(`/employees/${encodeURIComponent(employeeId)}/access-review`);
  },
  revokeGrants(
    employeeId: string,
    input: { roleAssignmentIds: string[]; reason?: string },
  ): Promise<EmployeeRevokeGrantsResult> {
    return apiRequest(`/employees/${encodeURIComponent(employeeId)}/access-review/revoke-grants`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
  /** Batch 5B (K6): atomic transfer to another position. */
  transferAssignment(
    employeeId: string,
    assignmentId: string,
    input: EmployeeTransferInput,
  ): Promise<EmployeeTransferResult> {
    return apiRequest(
      `/employees/${encodeURIComponent(employeeId)}/assignments/${encodeURIComponent(assignmentId)}/transfer`,
      { method: 'POST', body: JSON.stringify(input) },
    );
  },
  /** R4-A.1: due terminations, overdue and upcoming assignment ends the caller manages. */
  lifecycleDue(organizationId: string, upcomingDays?: number): Promise<LifecycleDue> {
    return apiRequest(`/employees/lifecycle/due${queryString({ organizationId, upcomingDays })}`);
  },
  /** R4-A.1: ends one ACTIVE assignment past its end date (never the employment). */
  applyAssignmentEnd(employeeId: string, assignmentId: string): Promise<unknown> {
    return apiRequest(
      `/employees/${encodeURIComponent(employeeId)}/assignments/${encodeURIComponent(assignmentId)}/apply-end`,
      { method: 'POST' },
    );
  },
  /** Batch 5B (K8): what ending the assignment on `endDate` would leave behind (read-only). */
  assignmentImpact(
    employeeId: string,
    assignmentId: string,
    endDate?: string,
  ): Promise<AssignmentImpact> {
    return apiRequest(
      `/employees/${encodeURIComponent(employeeId)}/assignments/${encodeURIComponent(assignmentId)}/impact${queryString({ endDate })}`,
    );
  },
  account(employeeId: string): Promise<EmployeeAccount> {
    return apiRequest(`/employees/${encodeURIComponent(employeeId)}/account`);
  },
  inviteAccount(employeeId: string, email?: string): Promise<EmployeeAccount> {
    return accountAction(employeeId, 'invitation', email ? { email } : {});
  },
  resendAccountInvitation(employeeId: string, email?: string): Promise<EmployeeAccount> {
    return accountAction(employeeId, 'invitation/resend', email ? { email } : {});
  },
  cancelAccountInvitation(employeeId: string): Promise<EmployeeAccount> {
    return accountAction(employeeId, 'invitation/cancel', {});
  },
  disableAccount(employeeId: string, reason?: string): Promise<EmployeeAccount> {
    return accountAction(employeeId, 'disable', reason ? { reason } : {});
  },
  enableAccount(employeeId: string): Promise<EmployeeAccount> {
    return accountAction(employeeId, 'enable', {});
  },
  /** Batch 2: the employee must choose a new password; `signOut` ends their sessions now. */
  requireAccountPasswordChange(employeeId: string, signOut: boolean): Promise<EmployeeAccount> {
    return accountAction(employeeId, 'require-password-change', { signOut });
  },
  sendAccountPasswordReset(employeeId: string): Promise<EmployeeAccount> {
    return accountAction(employeeId, 'password-reset', {});
  },
  signOutAccount(employeeId: string): Promise<EmployeeAccount> {
    return accountAction(employeeId, 'sessions/revoke', {});
  },
  unlockAccount(employeeId: string): Promise<EmployeeAccount> {
    return accountAction(employeeId, 'unlock', {});
  },
};

function accountAction(employeeId: string, path: string, body: object): Promise<EmployeeAccount> {
  return apiRequest(`/employees/${encodeURIComponent(employeeId)}/account/${path}`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}
