import { apiRequest } from '../auth/api-client';
import type {
  AttendanceDevice,
  AssignmentAttendance,
  AttendanceOrganization,
  DeviceEnrollment,
  EffectivePolicy,
  InheritedPolicy,
  PolicyScopeType,
  ExpectedSignIn,
  PinStatus,
  SignIn,
  SignInCaptureResult,
  SignInDetail,
  SignOut,
  TimePolicy,
  TimePolicyInput,
} from './types';

const enc = encodeURIComponent;

function query(values: Record<string, string | boolean | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== '') params.set(key, String(value));
  }
  const result = params.toString();
  return result ? `?${result}` : '';
}

function post<T>(path: string, body?: unknown): Promise<T> {
  return apiRequest(path, {
    method: 'POST',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

export const attendanceApi = {
  /**
   * Organizations reachable through the user's Time administration grants. Batch 4F (C10): with
   * `includeDisabledOrganizations`, also those with attendance turned off (read only).
   */
  organizations(
    options: { includeDisabledOrganizations?: boolean } = {},
  ): Promise<{ items: AttendanceOrganization[] }> {
    return apiRequest(
      `/time/manage/organizations${query({
        includeDisabledOrganizations: options.includeDisabledOrganizations || undefined,
      })}`,
    );
  },

  // ─── Self-service ────────────────────────────────────────────────────────
  /** Batch 4E-3 (C7): optionally the occurrence being confirmed (one open for sign-in now). */
  signIn(
    employmentAssignmentId: string,
    idempotencyKey: string,
    scheduledShiftId?: string,
  ): Promise<SignInCaptureResult> {
    return post('/time/me/sign-in', {
      employmentAssignmentId,
      idempotencyKey,
      ...(scheduledShiftId ? { scheduledShiftId } : {}),
    });
  },
  /** Batch 4D (D-H): sign out of the open sign-in, where the policy enables it. */
  signOut(
    employmentAssignmentId: string,
    idempotencyKey: string,
  ): Promise<{ outcome: 'SIGNED_OUT' | 'ALREADY_SIGNED_OUT'; signOut: SignOut }> {
    return post('/time/me/sign-out', { employmentAssignmentId, idempotencyKey });
  },
  mySignIns(range: { from?: string; to?: string } = {}): Promise<{
    items: SignInDetail[];
    attendanceDisabledOrganizationIds?: string[];
  }> {
    return apiRequest(`/time/me/sign-ins${query(range)}`);
  },
  myPin(): Promise<{ hasPin: boolean }> {
    return apiRequest('/time/me/attendance-pin');
  },
  changeMyPin(input: { currentPin?: string; newPin: string }): Promise<{ hasPin: boolean }> {
    return apiRequest('/time/me/attendance-pin', { method: 'PUT', body: JSON.stringify(input) });
  },

  // ─── Sign-ins (managers) ─────────────────────────────────────────────────
  managedSignIns(input: {
    organizationId: string;
    from?: string;
    to?: string;
    includeVoided?: boolean;
    /** Batch 4F (C10): the history of an organization with attendance turned off. */
    includeDisabledOrganizations?: boolean;
  }): Promise<{
    items: SignInDetail[];
    /** Batch 4F (Q3): capped at `limit`; a capped list is never complete. */
    truncated?: boolean;
    limit?: number;
    attendanceDisabledOrganizationIds?: string[];
  }> {
    return apiRequest(
      `/time/manage/sign-ins${query({
        ...input,
        includeDisabledOrganizations: input.includeDisabledOrganizations || undefined,
      })}`,
    );
  },
  expectedSignIns(input: { organizationId: string; from?: string; to?: string }): Promise<{
    items: ExpectedSignIn[];
    truncated?: boolean;
    limit?: number;
  }> {
    return apiRequest(`/time/manage/expected-sign-ins${query(input)}`);
  },
  recordSignIn(input: {
    employmentAssignmentId: string;
    signedInAt: string;
    reason: string;
    scheduledShiftId?: string;
  }): Promise<{ signIn: SignIn; exceptions: string[] }> {
    return post('/time/sign-ins', input);
  },
  voidSignIn(signInId: string, reason: string): Promise<SignIn> {
    return post(`/time/sign-ins/${enc(signInId)}/void`, { reason });
  },
  correctSignIn(
    signInId: string,
    input: { signedInAt?: string; reason: string },
  ): Promise<{ signIn: SignIn; replaced: string }> {
    return post(`/time/sign-ins/${enc(signInId)}/correct`, input);
  },

  /** Batch 4D: a manager records a sign-out (time.correct; never one's own). */
  recordSignOut(
    signInId: string,
    input: { signedOutAt: string; reason: string },
  ): Promise<SignOut> {
    return post(`/time/sign-ins/${enc(signInId)}/sign-out`, input);
  },
  voidSignOut(signOutId: string, reason: string): Promise<SignOut> {
    return post(`/time/sign-outs/${enc(signOutId)}/void`, { reason });
  },

  // ─── Kiosks (time.device.manage) ─────────────────────────────────────────
  devices(organizationId: string): Promise<{ items: AttendanceDevice[] }> {
    return apiRequest(`/time/devices${query({ organizationId })}`);
  },
  registerDevice(input: {
    organizationId: string;
    physicalSiteId: string;
    name: string;
  }): Promise<DeviceEnrollment> {
    return post('/time/devices', input);
  },
  rotateDevice(deviceId: string): Promise<DeviceEnrollment> {
    return post(`/time/devices/${enc(deviceId)}/rotate`);
  },
  setDeviceEnabled(deviceId: string, enabled: boolean): Promise<AttendanceDevice> {
    return post(`/time/devices/${enc(deviceId)}/${enabled ? 'enable' : 'disable'}`);
  },
  revokeDevice(deviceId: string, reason: string): Promise<AttendanceDevice> {
    return post(`/time/devices/${enc(deviceId)}/revoke`, { reason });
  },
  /** Batch 4E-2: rename a kiosk or move it to another site (audited). */
  updateDevice(
    deviceId: string,
    input: { name?: string; physicalSiteId?: string },
  ): Promise<AttendanceDevice> {
    return apiRequest(`/time/devices/${enc(deviceId)}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    });
  },

  // ─── PINs (time.credential.manage) ───────────────────────────────────────
  pinStatus(employeeId: string): Promise<PinStatus> {
    return apiRequest(`/time/employees/${enc(employeeId)}/attendance-pin`);
  },
  issuePin(employeeId: string): Promise<{ employeeId: string; pin: string; reset: boolean }> {
    return post(`/time/employees/${enc(employeeId)}/attendance-pin`);
  },
  revokePin(employeeId: string, reason: string): Promise<{ hasPin: boolean }> {
    return post(`/time/employees/${enc(employeeId)}/attendance-pin/revoke`, { reason });
  },

  // ─── Policies (time.manage_policy) ───────────────────────────────────────
  policies(organizationId: string, includeArchived = false): Promise<{ items: TimePolicy[] }> {
    return apiRequest(
      `/time/policies${query({ organizationId, includeArchived: includeArchived || undefined })}`,
    );
  },
  createPolicy(input: TimePolicyInput): Promise<TimePolicy> {
    return post('/time/policies', input);
  },
  endPolicy(policyId: string, effectiveTo: string): Promise<TimePolicy> {
    return post(`/time/policies/${enc(policyId)}/end`, { effectiveTo });
  },
  archivePolicy(policyId: string): Promise<TimePolicy> {
    return post(`/time/policies/${enc(policyId)}/archive`);
  },
  /** Batch 4E-2 (B3): replace a layer from a date, atomically. */
  supersedePolicy(
    policyId: string,
    input: {
      effectiveFrom: string;
      config: Record<string, Record<string, unknown>>;
      inheritanceMode?: 'INHERIT' | 'OVERRIDE';
      expectedUpdatedAt: string;
    },
  ): Promise<{ ended: TimePolicy; created: TimePolicy }> {
    return post(`/time/policies/${enc(policyId)}/supersede`, input);
  },
  /** Batch 4E-2 (B1): an assignment's resolved policy, explained. */
  effectivePolicy(employmentAssignmentId: string, date?: string): Promise<EffectivePolicy> {
    return apiRequest(`/time/policies/effective${query({ employmentAssignmentId, date })}`);
  },
  /** Batch 4E-2 review: what a layer at a scope would inherit on a date. */
  inheritedPolicy(input: {
    scopeType: Exclude<PolicyScopeType, 'SYSTEM'>;
    organizationId?: string;
    organizationalUnitId?: string;
    departmentId?: string;
    teamId?: string;
    employmentAssignmentId?: string;
    date: string;
  }): Promise<InheritedPolicy> {
    return apiRequest(`/time/policies/inherited${query(input)}`);
  },
  /** Batch 4E-2 (B4): how readable assignments capture attendance, across organizations. */
  assignmentAttendance(input: {
    search?: string;
    employeeId?: string;
    date?: string;
    limit?: number;
    afterId?: string;
  }): Promise<{ items: AssignmentAttendance[]; nextAfterId: string | null }> {
    return apiRequest(
      `/time/manage/assignment-attendance${query({
        search: input.search,
        employeeId: input.employeeId,
        date: input.date,
        limit: input.limit === undefined ? undefined : String(input.limit),
        afterId: input.afterId,
      })}`,
    );
  },

  // ─── Timesheets ──────────────────────────────────────────────────────────
  reopenTimesheet(timesheetId: string, note: string): Promise<unknown> {
    return post(`/time/timesheets/${enc(timesheetId)}/reopen`, { note });
  },
};
