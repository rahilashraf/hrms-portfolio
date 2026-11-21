/** Phase 18 — organization feature management (mirrors apps/api/src/features). */

export type FeatureModule =
  | 'ATTENDANCE'
  | 'SCHEDULING'
  | 'LEAVE'
  | 'COMPENSATION'
  | 'PAYROLL'
  | 'BENEFITS'
  | 'PERFORMANCE'
  | 'RECRUITMENT'
  | 'ONBOARDING'
  | 'DOCUMENTS'
  | 'NOTIFICATIONS'
  | 'GOOGLE_WORKSPACE'
  | 'REPORTING';

export interface FeaturesOrganization {
  id: string;
  name: string;
  code: string;
  actions: { canRead: boolean; canManage: boolean };
}

export interface ModuleState {
  module: FeatureModule;
  name: string;
  description: string;
  enabled: boolean;
  /** No explicit decision was ever recorded (enabled by default). */
  isDefault: boolean;
  /** Modules this one cannot work without. */
  requires: FeatureModule[];
  /** Modules that require this one. */
  dependents: FeatureModule[];
  /** Required modules currently disabled (enabling is refused until they are on). */
  blockedBy: FeatureModule[];
  /** 0 when the module was never changed. */
  version: number;
  updatedAt: string | null;
  updatedByUserId: string | null;
}

export type SettingType =
  | { kind: 'boolean' }
  | {
      kind: 'integer';
      min: number;
      max: number;
      /**
       * Phase 19: 0 means "off" and any other value must be at least this (e.g. a retention
       * period's hard minimum). Absent: every value from min to max is valid.
       */
      minWhenEnabled?: number;
    }
  | { kind: 'enum'; values: string[] };

/**
 * The admin area's section of a setting: the module whose behaviour it tunes, or CORE for core
 * HR behaviour that is never a module (e.g. audit log retention).
 */
export type SettingSection = FeatureModule | 'CORE';

export type SettingValue = boolean | number | string;

export interface SettingState {
  key: string;
  /** The module whose behaviour the setting tunes, or CORE. */
  section: SettingSection;
  name: string;
  description: string;
  type: SettingType;
  value: SettingValue;
  default: SettingValue;
  isDefault: boolean;
  schemaVersion: number;
  version: number;
  updatedAt: string | null;
  updatedByUserId: string | null;
  /** M2: relaxing it needs a SYSTEM administrator, a reason and a confirmation. */
  guarded?: boolean;
}

export type LinkedUnavailableReason = 'FORBIDDEN' | 'FEATURE_DISABLED' | 'UNAVAILABLE';

export type Linked<T> =
  | ({ available: true; endpoint: string } & T)
  | {
      available: false;
      reason: LinkedUnavailableReason;
    };

export interface TimeAttendanceSummary {
  activeLayers: number;
  currentLayers: number;
  organizationLayer: {
    id: string;
    effectiveFrom: string;
    effectiveTo: string | null;
    inheritanceMode: string;
    attendance: unknown;
    clockMode: string | null;
    breaksMode: string | null;
    missedPunchEnabled: boolean | null;
  } | null;
}

export interface NotificationsSummary {
  emailEnabled: boolean;
  suppressMandatoryEmail: boolean;
  categoriesEmailDisabled: string[];
  updatedAt: string | null;
}

export interface GoogleWorkspaceSummary {
  status: string;
  mode: string | null;
  capabilities: string[];
  lastHealthOk: boolean | null;
  lastHealthCheckAt: string | null;
}

export interface FeaturesOverview {
  organization: { id: string; name: string; code: string };
  canManage: boolean;
  /** M2: whether the viewer may relax a guarded setting (a SYSTEM administrator). */
  canRelaxGuardedSettings?: boolean;
  /** Areas that are always on. */
  core: string[];
  modules: ModuleState[];
  settings: SettingState[];
  linked: {
    timeAttendance: Linked<TimeAttendanceSummary>;
    notifications: Linked<NotificationsSummary>;
    googleWorkspace: Linked<GoogleWorkspaceSummary>;
  };
}

export interface FeatureChange {
  id: string;
  kind: 'MODULE' | 'SETTING';
  /** The module or setting key. */
  subject: string;
  /** null = the default (never set, or reset). */
  oldValue: SettingValue | null;
  newValue: SettingValue | null;
  version: number;
  actorUserId: string | null;
  /** M2: the stated reason (relaxing a guarded setting). */
  reason?: string | null;
  changedAt: string;
}

export interface FeatureHistoryPage {
  items: FeatureChange[];
  /** Pass as `before` to load the next (older) page; null at the end. */
  nextBefore: string | null;
}

/** Either permission shows Settings & features (the API decides the organizations). */
export const FEATURE_PERMISSION_KEYS = ['feature.read', 'feature.manage'] as const;
