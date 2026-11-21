/**
 * Phase 20 — the caller's workspace context (GET /auth/me/workspace). It drives navigation and
 * persona rendering only; the API stays authoritative for every action.
 */
import type { FeatureModule } from '../features/types';

export type OrganizationModule = FeatureModule;

export interface WorkspaceBranding {
  displayName: string | null;
  shortName: string | null;
  logoUrl: string | null;
  iconUrl: string | null;
  primaryColor: string | null;
  secondaryColor: string | null;
}

export interface WorkspaceOrganization {
  id: string;
  name: string;
  code: string;
  timezone: string | null;
  branding: WorkspaceBranding | null;
  /** Phase 18 modules currently enabled for this organization. */
  enabledModules: OrganizationModule[];
  /** Permission keys whose grants reach any part of this organization. */
  permissions: string[];
  /** The caller has a non-cancelled employment in this organization. */
  isEmployee: boolean;
  /** The caller manages at least one active employment in this organization. */
  isManager: boolean;
}

export interface Workspace {
  user: { id: string; email: string; displayName: string };
  /** Keys held at SYSTEM scope. */
  systemPermissions: string[];
  organizations: WorkspaceOrganization[];
}

export const ORGANIZATION_MODULES: readonly OrganizationModule[] = [
  'ATTENDANCE',
  'SCHEDULING',
  'LEAVE',
  'COMPENSATION',
  'PAYROLL',
  'BENEFITS',
  'PERFORMANCE',
  'RECRUITMENT',
  'ONBOARDING',
  'DOCUMENTS',
  'NOTIFICATIONS',
  'GOOGLE_WORKSPACE',
  'REPORTING',
];
