export interface Organization {
  id: string;
  name: string;
  code: string;
  description: string | null;
  sortOrder: number;
  /** IANA timezone; the fallback for local dates when a position has no work location. */
  timezone: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OrganizationRecord {
  id: string;
  organizationId: string;
  name: string;
  code: string;
  description: string | null;
  sortOrder: number;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OrganizationalUnit extends OrganizationRecord {
  parentUnitId: string | null;
}

export interface Department extends OrganizationRecord {
  organizationalUnitId: string | null;
}

export interface Team extends OrganizationRecord {
  departmentId: string | null;
  organizationalUnitId: string | null;
}

export type JobTitle = OrganizationRecord;

/**
 * R5B: an active Job Title or Work Location a Position may reference, as listed by
 * `GET /organizations/:id/position-reference-options` for managers anywhere in the organization.
 */
export interface PositionReferenceOption {
  id: string;
  name: string;
  code: string;
}

export interface PositionReferenceOptions {
  jobTitles: PositionReferenceOption[];
  workLocations: PositionReferenceOption[];
}

export interface Position extends OrganizationRecord {
  jobTitleId: string;
  organizationalUnitId: string | null;
  departmentId: string | null;
  teamId: string | null;
  workLocationId: string | null;
}

export interface PhysicalSite {
  id: string;
  organizationId: string;
  name: string;
}

/** Batch 5B (D12): a building work locations and kiosk devices belong to. */
export interface PhysicalSiteRecord extends PhysicalSite {
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  stateProvince: string | null;
  postalCode: string | null;
  country: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A listed site with what still uses it (archive refuses a site in use). */
export interface PhysicalSiteListItem extends PhysicalSiteRecord {
  activeWorkLocations: number;
  activeDevices: number;
}

export interface PhysicalSiteInput {
  name?: string;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  stateProvince?: string | null;
  postalCode?: string | null;
  country?: string | null;
}

export interface WorkLocation extends OrganizationRecord {
  physicalSiteId: string;
  physicalSite: PhysicalSite | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  stateProvince: string | null;
  postalCode: string | null;
  country: string | null;
  timezone: string | null;
}

export interface OrganizationUnitNode extends OrganizationalUnit {
  children: OrganizationUnitNode[];
}

export interface OrganizationRecordMap {
  units: OrganizationalUnit;
  departments: Department;
  teams: Team;
  'job-titles': JobTitle;
  positions: Position;
  'work-locations': WorkLocation;
}

export type OrganizationResource = keyof OrganizationRecordMap;

export interface CodeCreateInput {
  name: string;
  code: string;
  description?: string;
  sortOrder?: number;
}

export interface OrganizationUpdateInput {
  name?: string;
  description?: string;
  sortOrder?: number;
}

export interface OrganizationCreateInput extends CodeCreateInput {
  timezone?: string;
}

/** An organization's own settings; its timezone can be changed but never cleared. */
export interface OrganizationSettingsUpdateInput extends OrganizationUpdateInput {
  timezone?: string;
}

export interface UnitCreateInput extends CodeCreateInput {
  parentUnitId?: string;
}

export interface UnitUpdateInput extends OrganizationUpdateInput {
  parentUnitId?: string | null;
}

export interface DepartmentCreateInput extends CodeCreateInput {
  organizationalUnitId?: string;
}

export interface DepartmentUpdateInput extends OrganizationUpdateInput {
  organizationalUnitId?: string | null;
}

export interface TeamCreateInput extends CodeCreateInput {
  departmentId?: string;
  organizationalUnitId?: string;
}

export interface TeamUpdateInput extends OrganizationUpdateInput {
  departmentId?: string | null;
  organizationalUnitId?: string | null;
}

export interface PositionCreateInput extends CodeCreateInput {
  jobTitleId: string;
  organizationalUnitId?: string;
  departmentId?: string;
  teamId?: string;
  workLocationId?: string;
}

export interface PositionUpdateInput extends OrganizationUpdateInput {
  jobTitleId?: string;
  organizationalUnitId?: string | null;
  departmentId?: string | null;
  teamId?: string | null;
  workLocationId?: string | null;
}

export interface WorkLocationCreateInput extends CodeCreateInput {
  physicalSiteId?: string | null;
  /** Batch 5B: create a physical site matching the work location (explicit, audited). */
  createPhysicalSite?: boolean;
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  stateProvince?: string;
  postalCode?: string;
  country?: string;
  timezone?: string;
}

export interface WorkLocationUpdateInput extends OrganizationUpdateInput {
  physicalSiteId?: string | null;
  /** Batch 5B: create a physical site matching the work location (explicit, audited). */
  createPhysicalSite?: boolean;
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  stateProvince?: string;
  postalCode?: string;
  country?: string;
  timezone?: string;
}
