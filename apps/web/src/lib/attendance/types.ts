/** Phase 9.5 — attendance kiosks, PINs, sign-ins and attendance policy (admin and self-service). */

export type SignInSource = 'KIOSK' | 'LIVE_CLOCK' | 'MANUAL' | 'SYSTEM';

export interface SignIn {
  id: string;
  employeeId: string;
  employmentAssignmentId: string;
  signedInAt: string;
  timezone: string;
  workDate: string;
  source: SignInSource;
  attendanceDeviceId: string | null;
  workLocationId: string | null;
  scheduledShiftId: string | null;
  scheduledShiftRevisionId: string | null;
  status: 'ACTIVE' | 'VOIDED';
  voidedAt: string | null;
  voidReason: string | null;
  replacesSignInId: string | null;
  recordedByUserId: string | null;
  reason: string | null;
  createdAt: string;
}

export interface SignInDetail extends SignIn {
  positionName: string;
  employeeNumber: string;
  employeeName: string | null;
  device: { id: string; name: string } | null;
  workLocation: { id: string; name: string } | null;
  exceptions: Array<{ id: string; type: string; status: string }>;
  actions?: { canVoid: boolean; canCorrect: boolean };
  /** Batch 4D: the active sign-out, if any (presence only; never payable time). */
  signOut?: SignOut | null;
}

export interface SignOut {
  id: string;
  signInId: string;
  employmentAssignmentId: string;
  signedOutAt: string;
  source: SignInSource;
  attendanceDeviceId: string | null;
  recordedByUserId: string | null;
  reason: string | null;
  status: 'ACTIVE' | 'VOIDED';
  voidedAt: string | null;
  voidReason: string | null;
}

export interface SignInCaptureResult {
  outcome: 'SIGNED_IN' | 'ALREADY_SIGNED_IN';
  signIn: SignIn;
  exceptions: string[];
}

export interface ExpectedSignIn {
  scheduledShiftId: string;
  scheduledShiftRevisionId: string;
  employmentAssignmentId: string;
  employeeId: string;
  employeeNumber: string;
  employeeName: string | null;
  positionName: string;
  workDate: string;
  startsAt: string;
  endsAt: string;
  timezone: string;
  status: 'SIGNED_IN' | 'EXCUSED' | 'MISSING' | 'PENDING';
  signIn: {
    id: string;
    signedInAt: string;
    source: SignInSource;
    minutesAfterStart: number;
  } | null;
}

export interface AttendanceDevice {
  id: string;
  organizationId: string;
  physicalSite: { id: string; name: string | null };
  name: string;
  status: 'ACTIVE' | 'DISABLED' | 'REVOKED';
  enrolled: boolean;
  credentialIssuedAt: string | null;
  enrollmentPending: boolean;
  enrollmentExpiresAt: string | null;
  lastSeenAt: string | null;
  lastSeenIp: string | null;
  revokedAt: string | null;
  revokedReason: string | null;
  createdAt: string;
}

export interface DeviceEnrollment {
  device: AttendanceDevice;
  enrollment: { code: string; expiresAt: string };
}

export interface PinStatus {
  employeeId: string;
  hasPin: boolean;
  issuedAt: string | null;
  lastUsedAt: string | null;
  locked: boolean;
}

export type PolicyScopeType =
  | 'SYSTEM'
  | 'ORGANIZATION'
  | 'ORGANIZATIONAL_UNIT'
  | 'DEPARTMENT'
  | 'TEAM'
  | 'EMPLOYMENT_ASSIGNMENT';

export interface TimePolicy {
  id: string;
  scopeType: PolicyScopeType;
  organizationId: string | null;
  organizationalUnitId: string | null;
  departmentId: string | null;
  teamId: string | null;
  employmentAssignmentId: string | null;
  inheritanceMode: 'INHERIT' | 'OVERRIDE';
  effectiveFrom: string;
  effectiveTo: string | null;
  config: Record<string, Record<string, unknown>>;
  archivedAt: string | null;
  actions?: { canEnd: boolean; canArchive: boolean };
  /** Batch 4E-2: the scope by name, and the version a supersede must name. */
  scopeName?: string;
  updatedAt?: string;
}

/** Batch 4E-2 (B1): where a resolved setting came from. */
export type PolicySettingSource =
  | { value: unknown; source: 'LAYER'; layerId: string }
  | { value: unknown; source: 'DEFAULT'; resetByLayerId?: string };

export interface PolicyChainLayer {
  id: string;
  scopeType: PolicyScopeType;
  scopeName: string;
  inheritanceMode: 'INHERIT' | 'OVERRIDE';
  effectiveFrom: string;
  effectiveTo: string | null;
  config?: Record<string, Record<string, unknown>>;
}

export interface EffectiveAttendanceModes {
  trackingMode: 'TIME_CLOCK' | 'SIGN_IN_ONLY';
  captureMode: 'KIOSK_ONLY' | 'SELF_SERVICE' | 'KIOSK_OR_SELF_SERVICE';
  kioskLocationRule: string;
  signInDuplicateWindowMinutes: number;
  signOutEnabled: boolean;
}

export interface EffectivePolicy {
  date: string;
  timezone: string | null;
  assignment: {
    id: string;
    employeeId: string;
    status: string;
    position: { id: string; name: string };
    organization: { id: string; name: string };
  };
  config: Record<string, Record<string, unknown>>;
  settings: Record<string, Record<string, PolicySettingSource>>;
  chain: PolicyChainLayer[];
  attendance: EffectiveAttendanceModes;
}

/**
 * Batch 4E-2 review: what a layer at a scope inherits on a date (the editor's hints), resolved
 * by the API as the runtime resolves. Not determinable for a department or team when unit (or
 * department) layers apply, because those depend on each position.
 */
export type InheritedPolicy =
  | {
      date: string;
      determinable: true;
      config: Record<string, Record<string, unknown>>;
      settings: Record<string, Record<string, PolicySettingSource>>;
      chain: PolicyChainLayer[];
    }
  | {
      date: string;
      determinable: false;
      reason: 'VARIES_BY_POSITION';
      varyingScopes: PolicyScopeType[];
    };

/** Batch 4E-2 (B4): one assignment's attendance setup. */
export interface AssignmentAttendance {
  id: string;
  employee: { id: string; employeeNumber: string; name: string };
  assignment: {
    id: string;
    status: string;
    startDate: string | null;
    endDate: string | null;
    isPrimary: boolean;
    position: { id: string; name: string; code: string };
    organization: { id: string; name: string; code: string };
    workLocation: { id: string; name: string; timezone: string | null } | null;
  };
  date: string;
  timezone: string | null;
  attendance: EffectiveAttendanceModes;
  clock: { mode: string };
  breaks: { mode: string; autoDeductMinutes: number | null; autoDeductAfterMinutes: number | null };
  chain: PolicyChainLayer[];
}

export interface TimePolicyInput {
  scopeType: PolicyScopeType;
  organizationId?: string;
  organizationalUnitId?: string;
  departmentId?: string;
  teamId?: string;
  employmentAssignmentId?: string;
  inheritanceMode?: 'INHERIT' | 'OVERRIDE';
  effectiveFrom: string;
  effectiveTo?: string;
  config: Record<string, Record<string, unknown>>;
}

export interface AttendanceOrganization {
  id: string;
  name: string;
  code: string;
  timezone: string | null;
  /** Kiosk locations; listed only with time.device.manage on the organization. */
  workLocations: Array<{ id: string; name: string; timezone: string | null }>;
  /** Physical sites available for kiosk devices; listed only with time.device.manage. */
  physicalSites: Array<{ id: string; name: string }>;
  /**
   * Batch 4F (C10): false for an organization listed only for its history (attendance turned
   * off): every action flag is then false. Absent from older API responses (enabled).
   */
  attendanceEnabled?: boolean;
  actions: {
    canViewSignIns: boolean;
    canCorrectSignIns: boolean;
    canManageDevices: boolean;
    canManagePolicies: boolean;
    canManagePins: boolean;
    /**
     * Batch 4E-1: what the manager review screens may offer in this organization. Interface
     * hints only; the API authorizes every action per record. Absent from older API responses.
     */
    canViewAttendance?: boolean;
    canCorrectTime?: boolean;
    canReviewExceptions?: boolean;
    canReviewCorrections?: boolean;
    canApproveTimesheets?: boolean;
    canManageTimesheets?: boolean;
    canManagePeriods?: boolean;
  };
}
