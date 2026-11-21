import { apiRequest } from '../auth/api-client';
import type {
  CodeCreateInput,
  Department,
  DepartmentCreateInput,
  DepartmentUpdateInput,
  JobTitle,
  Organization,
  OrganizationResource,
  OrganizationUnitNode,
  OrganizationCreateInput,
  OrganizationSettingsUpdateInput,
  OrganizationUpdateInput,
  OrganizationalUnit,
  PhysicalSiteInput,
  PhysicalSiteListItem,
  PhysicalSiteRecord,
  Position,
  PositionCreateInput,
  PositionReferenceOptions,
  PositionUpdateInput,
  Team,
  TeamCreateInput,
  TeamUpdateInput,
  UnitCreateInput,
  UnitUpdateInput,
  WorkLocation,
  WorkLocationCreateInput,
  WorkLocationUpdateInput,
} from './types';

function scopePath(organizationId: string): string {
  return `/organizations/${encodeURIComponent(organizationId)}`;
}

function archivedQuery(includeArchived: boolean): string {
  return includeArchived ? '?includeArchived=true' : '';
}

function recordsPath(organizationId: string, resource: OrganizationResource): string {
  return `${scopePath(organizationId)}/${resource}`;
}

export const organizationApi = {
  listOrganizations(includeArchived = false): Promise<Organization[]> {
    return apiRequest(`/organizations${archivedQuery(includeArchived)}`);
  },
  getOrganization(id: string, includeArchived = false): Promise<Organization> {
    return apiRequest(`/organizations/${encodeURIComponent(id)}${archivedQuery(includeArchived)}`);
  },
  createOrganization(input: OrganizationCreateInput): Promise<Organization> {
    return apiRequest('/organizations', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
  updateOrganization(id: string, input: OrganizationSettingsUpdateInput): Promise<Organization> {
    return apiRequest(`/organizations/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    });
  },
  archiveOrganization(id: string): Promise<unknown> {
    return apiRequest(`/organizations/${encodeURIComponent(id)}/archive`, {
      method: 'POST',
    });
  },
  reactivateOrganization(id: string): Promise<unknown> {
    return apiRequest(`/organizations/${encodeURIComponent(id)}/reactivate`, {
      method: 'POST',
    });
  },
  getStructure(organizationId: string): Promise<OrganizationUnitNode[]> {
    return apiRequest(`${scopePath(organizationId)}/structure`);
  },
  listUnits(organizationId: string, includeArchived = false): Promise<OrganizationalUnit[]> {
    return apiRequest(`${recordsPath(organizationId, 'units')}${archivedQuery(includeArchived)}`);
  },
  getUnit(organizationId: string, id: string, includeArchived = false) {
    return apiRequest<OrganizationalUnit>(
      `${recordsPath(organizationId, 'units')}/${encodeURIComponent(id)}${archivedQuery(includeArchived)}`,
    );
  },
  createUnit(organizationId: string, input: UnitCreateInput) {
    return apiRequest<OrganizationalUnit>(recordsPath(organizationId, 'units'), {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
  updateUnit(organizationId: string, id: string, input: UnitUpdateInput) {
    return apiRequest<OrganizationalUnit>(
      `${recordsPath(organizationId, 'units')}/${encodeURIComponent(id)}`,
      { method: 'PATCH', body: JSON.stringify(input) },
    );
  },
  listDepartments(organizationId: string, includeArchived = false): Promise<Department[]> {
    return apiRequest(
      `${recordsPath(organizationId, 'departments')}${archivedQuery(includeArchived)}`,
    );
  },
  getDepartment(organizationId: string, id: string, includeArchived = false) {
    return apiRequest<Department>(
      `${recordsPath(organizationId, 'departments')}/${encodeURIComponent(id)}${archivedQuery(includeArchived)}`,
    );
  },
  createDepartment(organizationId: string, input: DepartmentCreateInput) {
    return apiRequest<Department>(recordsPath(organizationId, 'departments'), {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
  updateDepartment(organizationId: string, id: string, input: DepartmentUpdateInput) {
    return apiRequest<Department>(
      `${recordsPath(organizationId, 'departments')}/${encodeURIComponent(id)}`,
      { method: 'PATCH', body: JSON.stringify(input) },
    );
  },
  listTeams(organizationId: string, includeArchived = false): Promise<Team[]> {
    return apiRequest(`${recordsPath(organizationId, 'teams')}${archivedQuery(includeArchived)}`);
  },
  getTeam(organizationId: string, id: string, includeArchived = false) {
    return apiRequest<Team>(
      `${recordsPath(organizationId, 'teams')}/${encodeURIComponent(id)}${archivedQuery(includeArchived)}`,
    );
  },
  createTeam(organizationId: string, input: TeamCreateInput) {
    return apiRequest<Team>(recordsPath(organizationId, 'teams'), {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
  updateTeam(organizationId: string, id: string, input: TeamUpdateInput) {
    return apiRequest<Team>(`${recordsPath(organizationId, 'teams')}/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    });
  },
  listJobTitles(organizationId: string, includeArchived = false): Promise<JobTitle[]> {
    return apiRequest(
      `${recordsPath(organizationId, 'job-titles')}${archivedQuery(includeArchived)}`,
    );
  },
  getJobTitle(organizationId: string, id: string, includeArchived = false) {
    return apiRequest<JobTitle>(
      `${recordsPath(organizationId, 'job-titles')}/${encodeURIComponent(id)}${archivedQuery(includeArchived)}`,
    );
  },
  createJobTitle(organizationId: string, input: CodeCreateInput) {
    return apiRequest<JobTitle>(recordsPath(organizationId, 'job-titles'), {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
  updateJobTitle(organizationId: string, id: string, input: OrganizationUpdateInput) {
    return apiRequest<JobTitle>(
      `${recordsPath(organizationId, 'job-titles')}/${encodeURIComponent(id)}`,
      { method: 'PATCH', body: JSON.stringify(input) },
    );
  },
  /** R5B: active Job Titles and Work Locations for Position forms (organization.manage within). */
  listPositionReferenceOptions(organizationId: string): Promise<PositionReferenceOptions> {
    return apiRequest(`${scopePath(organizationId)}/position-reference-options`);
  },
  listPositions(organizationId: string, includeArchived = false): Promise<Position[]> {
    return apiRequest(
      `${recordsPath(organizationId, 'positions')}${archivedQuery(includeArchived)}`,
    );
  },
  getPosition(organizationId: string, id: string, includeArchived = false) {
    return apiRequest<Position>(
      `${recordsPath(organizationId, 'positions')}/${encodeURIComponent(id)}${archivedQuery(includeArchived)}`,
    );
  },
  createPosition(organizationId: string, input: PositionCreateInput) {
    return apiRequest<Position>(recordsPath(organizationId, 'positions'), {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
  updatePosition(organizationId: string, id: string, input: PositionUpdateInput) {
    return apiRequest<Position>(
      `${recordsPath(organizationId, 'positions')}/${encodeURIComponent(id)}`,
      { method: 'PATCH', body: JSON.stringify(input) },
    );
  },
  listWorkLocations(organizationId: string, includeArchived = false): Promise<WorkLocation[]> {
    return apiRequest(
      `${recordsPath(organizationId, 'work-locations')}${archivedQuery(includeArchived)}`,
    );
  },
  getWorkLocation(organizationId: string, id: string, includeArchived = false) {
    return apiRequest<WorkLocation>(
      `${recordsPath(organizationId, 'work-locations')}/${encodeURIComponent(id)}${archivedQuery(includeArchived)}`,
    );
  },
  createWorkLocation(organizationId: string, input: WorkLocationCreateInput) {
    return apiRequest<WorkLocation>(recordsPath(organizationId, 'work-locations'), {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
  updateWorkLocation(organizationId: string, id: string, input: WorkLocationUpdateInput) {
    return apiRequest<WorkLocation>(
      `${recordsPath(organizationId, 'work-locations')}/${encodeURIComponent(id)}`,
      { method: 'PATCH', body: JSON.stringify(input) },
    );
  },
  /** Batch 5B (D12): physical sites (organization.manage to change; read for pickers). */
  listPhysicalSites(
    organizationId: string,
    includeArchived = false,
  ): Promise<{ items: PhysicalSiteListItem[] }> {
    return apiRequest(
      `${scopePath(organizationId)}/physical-sites${archivedQuery(includeArchived)}`,
    );
  },
  createPhysicalSite(
    organizationId: string,
    input: PhysicalSiteInput & { name: string },
  ): Promise<PhysicalSiteRecord> {
    return apiRequest(`${scopePath(organizationId)}/physical-sites`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
  updatePhysicalSite(
    organizationId: string,
    id: string,
    input: PhysicalSiteInput,
  ): Promise<PhysicalSiteRecord> {
    return apiRequest(`${scopePath(organizationId)}/physical-sites/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    });
  },
  archivePhysicalSite(organizationId: string, id: string): Promise<PhysicalSiteRecord> {
    return apiRequest(
      `${scopePath(organizationId)}/physical-sites/${encodeURIComponent(id)}/archive`,
      { method: 'POST' },
    );
  },
  reactivatePhysicalSite(organizationId: string, id: string): Promise<PhysicalSiteRecord> {
    return apiRequest(
      `${scopePath(organizationId)}/physical-sites/${encodeURIComponent(id)}/reactivate`,
      { method: 'POST' },
    );
  },
  async archiveRecord(
    organizationId: string,
    resource: OrganizationResource,
    id: string,
  ): Promise<void> {
    await apiRequest(`${recordsPath(organizationId, resource)}/${encodeURIComponent(id)}/archive`, {
      method: 'POST',
    });
  },
  async reactivateRecord(
    organizationId: string,
    resource: OrganizationResource,
    id: string,
  ): Promise<void> {
    await apiRequest(
      `${recordsPath(organizationId, resource)}/${encodeURIComponent(id)}/reactivate`,
      { method: 'POST' },
    );
  },
};
