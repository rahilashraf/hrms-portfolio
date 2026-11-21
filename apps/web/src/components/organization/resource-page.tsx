'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  placementPermissions,
  recordAuthority,
  type StructureResource,
} from '../../lib/organization/authority';
import { AuthApiError } from '../../lib/auth/types';
import { organizationApi } from '../../lib/organization/api';
import { organizationErrorMessage } from '../../lib/organization/errors';
import {
  createPositionPayload,
  createDepartmentPayload,
  createTeamPayload,
  updateDepartmentPayload,
  updatePositionPayload,
  updateTeamPayload,
} from '../../lib/organization/payloads';
import type {
  Department,
  Organization,
  OrganizationRecordMap,
  OrganizationalUnit,
  Position,
  Team,
  WorkLocation,
} from '../../lib/organization/types';
import { useAuth } from '../../providers/auth-provider';
import { useWorkspace } from '../../providers/workspace-provider';
import {
  PageHeader,
  ArchivedToggle,
  ErrorBanner,
  FeedbackMessage,
  LoadingState,
  RecordActions,
  StatusBadge,
} from './shared';
import {
  formInitialFromRecord,
  OrganizationResourceForm,
  type ResourceFormInitial,
  type ResourceFormOptions,
  type ResourceKind,
} from './resource-form';
import { TableScroll } from '../ui/states';
import { InlineMessage } from '../ui/inline-message';
import { PageContainer } from '../ui/page-container';

type ResourceRecord = OrganizationRecordMap[keyof OrganizationRecordMap];
type ResourceFormState = { record: ResourceRecord | null; initial: ResourceFormInitial };
/**
 * R5B: the form options, plus why the Position reference options could not be loaded (they are
 * refused to callers who cannot manage Positions anywhere in the organization).
 */
type PageOptions = ResourceFormOptions & { positionReferencesError?: string | null };

const resourceInfo: Record<ResourceKind, { title: string; description: string }> = {
  units: {
    title: 'Business Units',
    description: 'Build and maintain the organization unit hierarchy.',
  },
  departments: {
    title: 'Departments',
    description: 'Manage departments scoped to a unit or to the whole organization.',
  },
  teams: {
    title: 'Teams',
    description: 'Place each Team under exactly one Department or Business Unit.',
  },
  'job-titles': {
    title: 'Job Titles',
    description: 'Manage job titles used by organization Positions.',
  },
  positions: {
    title: 'Positions',
    description: 'Manage Positions and their Job Title, Work Location, and structural placement.',
  },
  'work-locations': {
    title: 'Work Locations',
    description: 'Manage work sites, contact address, and IANA time zone.',
  },
};

const emptyOptions: PageOptions = {
  units: [],
  departments: [],
  teams: [],
  jobTitles: [],
  workLocations: [],
};

async function fetchRecords(
  organizationId: string,
  resource: ResourceKind,
  includeArchived: boolean,
): Promise<ResourceRecord[]> {
  if (resource === 'units') {
    if (includeArchived) return organizationApi.listUnits(organizationId, true);
    const tree = await organizationApi.getStructure(organizationId);
    return flattenStructure(tree);
  }
  switch (resource) {
    case 'departments':
      return organizationApi.listDepartments(organizationId, includeArchived);
    case 'teams':
      return organizationApi.listTeams(organizationId, includeArchived);
    case 'job-titles':
      return organizationApi.listJobTitles(organizationId, includeArchived);
    case 'positions':
      return organizationApi.listPositions(organizationId, includeArchived);
    case 'work-locations':
      return organizationApi.listWorkLocations(organizationId, includeArchived);
  }
}

function flattenStructure(
  nodes: Awaited<ReturnType<typeof organizationApi.getStructure>>,
): OrganizationalUnit[] {
  return nodes.flatMap(({ children, ...unit }) => [unit, ...flattenStructure(children)]);
}

async function fetchOptions(
  organizationId: string,
  resource: ResourceKind,
  includeArchived: boolean,
): Promise<PageOptions> {
  const options = { ...emptyOptions };
  if (resource === 'units' || resource === 'departments' || resource === 'teams') {
    options.units = await organizationApi.listUnits(organizationId, includeArchived);
  }
  if (resource === 'teams' || resource === 'positions') {
    options.departments = await organizationApi.listDepartments(organizationId, includeArchived);
  }
  if (resource === 'work-locations') {
    // Batch 5C: the site picker lists the organization's active physical sites; when they cannot
    // be listed it falls back to the sites of existing work locations.
    const [workLocations, sites] = await Promise.all([
      organizationApi.listWorkLocations(organizationId, includeArchived),
      organizationApi
        .listPhysicalSites(organizationId)
        .then((list) => list.items)
        .catch(() => null),
    ]);
    options.workLocations = workLocations;
    options.physicalSites = sites;
  }
  if (resource === 'positions') {
    const [units, teams, jobTitles, workLocations, references] = await Promise.all([
      organizationApi.listUnits(organizationId, includeArchived),
      organizationApi.listTeams(organizationId, includeArchived),
      // Name lookups for the table and for a current reference that is no longer active (archived
      // ones included). The API lists these by organization.read on the organization, so they are
      // empty for managers whose grants sit below it.
      organizationApi.listJobTitles(organizationId, true),
      organizationApi.listWorkLocations(organizationId, true),
      // R5B: what the Position form offers — the active references, for managers at any scope.
      organizationApi.listPositionReferenceOptions(organizationId).then(
        (value) => ({ value, error: null }),
        (cause: unknown) => ({
          value: null,
          error: organizationErrorMessage(
            cause,
            'Job titles and work locations could not be loaded.',
          ),
        }),
      ),
    ]);
    options.units = units;
    options.teams = teams;
    options.jobTitles = jobTitles;
    options.workLocations = workLocations;
    options.positionReferences = references.value;
    options.positionReferencesError = references.error;
  }
  return options;
}

/**
 * R5-A (F1): an edit that keeps the record where it is sends no placement. The API checks a move's
 * destination whenever a placement field is present, so resending the current parent would need
 * `organization.manage` on that parent even to rename a record the caller manages. A placement is
 * left out only when the payload would store exactly what the record already holds.
 */
const PLACEMENT_FIELDS = [
  'parentUnitId',
  'organizationalUnitId',
  'departmentId',
  'teamId',
] as const;

export function withoutUnchangedPlacement<T extends object>(payload: T, record: object): T {
  const sent = PLACEMENT_FIELDS.filter((field) => field in payload);
  if (sent.length === 0) return payload;
  const value = (source: object, field: string) =>
    ((source as Record<string, unknown>)[field] ?? null) as string | null;
  const relevant = PLACEMENT_FIELDS.filter((field) => field in payload || field in record);
  const unchanged = relevant.every((field) =>
    field in payload
      ? value(payload, field) === value(record, field)
      : value(record, field) === null,
  );
  if (!unchanged) return payload;
  const rest = { ...payload } as Record<string, unknown>;
  for (const field of sent) delete rest[field];
  return rest as T;
}

function text(data: FormData, field: string): string {
  const value = data.get(field);
  return typeof value === 'string' ? value.trim() : '';
}

function number(data: FormData, field: string): number {
  return Number(text(data, field) || 0);
}

function commonUpdate(data: FormData) {
  return {
    name: text(data, 'name'),
    description: text(data, 'description'),
    sortOrder: number(data, 'sortOrder'),
  };
}

function locationFields(data: FormData) {
  // Batch 5B (D12): "Create a matching physical site" is sent as an explicit request; the API no
  // longer creates a site from a missing or null id.
  const physicalSiteId = text(data, 'physicalSiteId');
  return {
    ...(physicalSiteId ? { physicalSiteId } : { createPhysicalSite: true }),
    addressLine1: text(data, 'addressLine1'),
    addressLine2: text(data, 'addressLine2'),
    city: text(data, 'city'),
    stateProvince: text(data, 'stateProvince'),
    postalCode: text(data, 'postalCode'),
    country: text(data, 'country'),
    timezone: text(data, 'timezone'),
  };
}

function isUnitRecord(record: ResourceRecord): record is OrganizationalUnit {
  return 'parentUnitId' in record;
}

function isDepartmentRecord(record: ResourceRecord): record is Department {
  return 'organizationalUnitId' in record && !('departmentId' in record);
}

function isTeamRecord(record: ResourceRecord): record is Team {
  return 'departmentId' in record && !('jobTitleId' in record);
}

function isPositionRecord(record: ResourceRecord): record is Position {
  return 'jobTitleId' in record;
}

function isWorkLocationRecord(record: ResourceRecord): record is WorkLocation {
  return 'timezone' in record;
}

function placementLabel(record: ResourceRecord, lookups: ResourceFormOptions): string {
  if (isUnitRecord(record)) {
    const parent = lookups.units.find((unit) => unit.id === record.parentUnitId);
    // R5-A: a parent the caller cannot see is not the root.
    return parent
      ? `Parent: ${parent.name}`
      : record.parentUnitId
        ? 'Parent not visible'
        : 'Root unit';
  }
  if (isDepartmentRecord(record)) {
    const unit = lookups.units.find((item) => item.id === record.organizationalUnitId);
    return unit
      ? `Unit: ${unit.name}`
      : record.organizationalUnitId
        ? 'Placement not visible'
        : 'Organization-wide';
  }
  if (isTeamRecord(record)) {
    const department = lookups.departments.find((item) => item.id === record.departmentId);
    const unit = lookups.units.find((item) => item.id === record.organizationalUnitId);
    return department
      ? `Department: ${department.name}`
      : unit
        ? `Unit: ${unit.name}`
        : 'Placement unavailable';
  }
  if (isPositionRecord(record)) {
    // R5B: names come from the organization lists or, for managers below the organization, from
    // the reference options; a name the caller cannot see gets a neutral label, never an id.
    const named = (
      lists: Array<Array<{ id: string; name: string }> | undefined>,
      id: string | null,
      hidden: string,
    ) =>
      id
        ? (lists.flatMap((list) => list ?? []).find((item) => item.id === id) ?? { name: hidden })
        : null;
    const title = named(
      [lookups.jobTitles, lookups.positionReferences?.jobTitles],
      record.jobTitleId,
      'Job title not visible',
    );
    const unit = lookups.units.find((item) => item.id === record.organizationalUnitId);
    const department = lookups.departments.find((item) => item.id === record.departmentId);
    const team = lookups.teams.find((item) => item.id === record.teamId);
    const location = named(
      [lookups.workLocations, lookups.positionReferences?.workLocations],
      record.workLocationId,
      'Work location not visible',
    );
    const placement = team
      ? `Team: ${team.name}`
      : department
        ? `Department: ${department.name}`
        : unit
          ? `Unit: ${unit.name}`
          : record.teamId || record.departmentId || record.organizationalUnitId
            ? 'Placement not visible'
            : 'Organization';
    return `${placement}${title ? ` · ${title.name}` : ''}${location ? ` · ${location.name}` : ''}`;
  }
  if (isWorkLocationRecord(record)) {
    const address = [
      record.addressLine1,
      record.addressLine2,
      record.city,
      record.stateProvince,
      record.postalCode,
      record.country,
    ]
      .filter(Boolean)
      .join(', ');
    return [
      record.physicalSite?.name ? `Site: ${record.physicalSite.name}` : null,
      address || 'Location details not set',
      record.timezone,
    ]
      .filter(Boolean)
      .join(' · ');
  }
  return '—';
}

function descendantsOf(unitId: string, units: OrganizationalUnit[]): Set<string> {
  const descendants = new Set<string>([unitId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const unit of units) {
      if (unit.parentUnitId && descendants.has(unit.parentUnitId) && !descendants.has(unit.id)) {
        descendants.add(unit.id);
        changed = true;
      }
    }
  }
  return descendants;
}

function treeRows(
  units: OrganizationalUnit[],
  collapsed: Set<string>,
): Array<{ unit: OrganizationalUnit; depth: number; hasChildren: boolean }> {
  const byId = new Map(units.map((unit) => [unit.id, unit]));
  const children = new Map<string, OrganizationalUnit[]>();
  const roots: OrganizationalUnit[] = [];
  for (const unit of units) {
    if (unit.parentUnitId && byId.has(unit.parentUnitId)) {
      const current = children.get(unit.parentUnitId) ?? [];
      current.push(unit);
      children.set(unit.parentUnitId, current);
    } else {
      roots.push(unit);
    }
  }
  const result: Array<{ unit: OrganizationalUnit; depth: number; hasChildren: boolean }> = [];
  const visited = new Set<string>();
  function visit(unit: OrganizationalUnit, depth: number) {
    if (visited.has(unit.id)) return;
    visited.add(unit.id);
    const childUnits = children.get(unit.id) ?? [];
    result.push({ unit, depth, hasChildren: childUnits.length > 0 });
    if (!collapsed.has(unit.id)) {
      for (const child of childUnits) visit(child, depth + 1);
    }
  }
  for (const root of roots) visit(root, 0);
  for (const unit of units) visit(unit, 0);
  return result;
}

export function OrganizationResourcePage({
  organizationId,
  resource,
}: {
  organizationId: string;
  resource: ResourceKind;
}) {
  const { can } = useAuth();
  const { organizations: workspaceOrganizations } = useWorkspace();
  const [organization, setOrganization] = useState<Organization | null>(null);
  const [records, setRecords] = useState<ResourceRecord[]>([]);
  const [options, setOptions] = useState<PageOptions>(emptyOptions);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [formState, setFormState] = useState<ResourceFormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [busyRecordId, setBusyRecordId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const requestId = useRef(0);

  const fetchResource = useCallback(
    () =>
      Promise.all([
        // R5-A (F1): a manager whose grants sit below the organization may not read the
        // organization itself (403), yet may manage records within it; the lists below are
        // filtered by the API. The page then shows the workspace's name for the organization.
        organizationApi.getOrganization(organizationId, true).catch((cause: unknown) => {
          if (cause instanceof AuthApiError && cause.status === 403) return null;
          throw cause;
        }),
        fetchRecords(organizationId, resource, includeArchived),
        fetchOptions(organizationId, resource, includeArchived),
      ]),
    [organizationId, resource, includeArchived],
  );

  const load = useCallback(async () => {
    const currentRequest = ++requestId.current;
    setLoading(true);
    try {
      const [nextOrganization, nextRecords, nextOptions] = await fetchResource();
      if (currentRequest !== requestId.current) return;
      setOrganization(nextOrganization);
      setRecords(nextRecords);
      setOptions(nextOptions);
      setError(null);
    } catch (cause) {
      if (currentRequest === requestId.current) {
        setError(organizationErrorMessage(cause, 'Unable to load this organization resource.'));
      }
    } finally {
      if (currentRequest === requestId.current) setLoading(false);
    }
  }, [fetchResource]);

  useEffect(() => {
    const currentRequest = ++requestId.current;
    let active = true;
    fetchResource()
      .then(([nextOrganization, nextRecords, nextOptions]) => {
        if (!active || currentRequest !== requestId.current) return;
        setOrganization(nextOrganization);
        setRecords(nextRecords);
        setOptions(nextOptions);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (!active || currentRequest !== requestId.current) return;
        setError(organizationErrorMessage(cause, 'Unable to load this organization resource.'));
      })
      .finally(() => {
        if (active && currentRequest === requestId.current) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [fetchResource]);

  const unitRows = useMemo(
    () => (resource === 'units' ? treeRows(records.filter(isUnitRecord), collapsed) : []),
    [resource, records, collapsed],
  );

  /**
   * Batch 5C: the record's scope and every ancestor a grant may cover it from (the organization
   * included), from the structure this page has loaded. See lib/organization/authority.
   */
  const structure = useMemo(() => {
    const own = <T,>(kind: ResourceKind) => (resource === kind ? (records as T[]) : []);
    return {
      units: [...options.units, ...own<OrganizationalUnit>('units')],
      departments: [...options.departments, ...own<Department>('departments')],
      teams: [...options.teams, ...own<Team>('teams')],
    };
  }, [options, records, resource]);

  function canManageRecord(record: ResourceRecord) {
    const { scope, ancestors } = recordAuthority(
      resource as StructureResource,
      record as Parameters<typeof recordAuthority>[1],
      organizationId,
      structure,
    );
    return can('organization.manage', scope, { ancestors });
  }

  const placement = useMemo(
    () =>
      placementPermissions(
        ({ scope, ancestors }) => can('organization.manage', scope, { ancestors }),
        organizationId,
        structure,
      ),
    [can, organizationId, structure],
  );
  const activeIds = (items: Array<{ id: string; archivedAt?: string | null }>) =>
    items.filter((item) => !item.archivedAt).map((item) => item.id);
  // R5-A (F1): a record can be created where the caller may place it (see placementPermissions).
  const canCreate = (() => {
    if (placement.organization) return true;
    const units = activeIds(structure.units).some((id) => placement.unit(id));
    const departments = activeIds(structure.departments).some((id) => placement.department(id));
    const teams = activeIds(structure.teams).some((id) => placement.team(id));
    switch (resource) {
      case 'units':
      case 'departments':
        return units;
      case 'teams':
        return units || departments;
      case 'positions':
        return units || departments || teams;
      default:
        return false;
    }
  })();
  // R5B: Position forms need the reference options; without them (refused or failed) no form is
  // offered, and without an active job title no Position can be created.
  const positionReferencesUnavailable = resource === 'positions' && !options.positionReferences;
  const noActiveJobTitles =
    resource === 'positions' && options.positionReferences?.jobTitles.length === 0;
  const mayOpenCreate = canCreate && !positionReferencesUnavailable && !noActiveJobTitles;
  const mayOpenEdit = (record: ResourceRecord) =>
    canManageRecord(record) && !(resource === 'positions' && positionReferencesUnavailable);
  const managesPositions =
    resource === 'positions' && (canCreate || records.some((record) => canManageRecord(record)));
  const organizationName =
    organization?.name ??
    workspaceOrganizations.find((item) => item.id === organizationId)?.name ??
    'Organization';

  function startCreate() {
    if (!mayOpenCreate) return;
    setFormError(null);
    setSuccess(null);
    setFormState({
      record: null,
      initial: { id: '', name: '', code: '', description: '', sortOrder: 0 },
    });
  }

  function startEdit(record: ResourceRecord) {
    if (!mayOpenEdit(record)) return;
    setFormError(null);
    setSuccess(null);
    setFormState({ record, initial: formInitialFromRecord(resource, record) });
  }

  async function save(data: FormData) {
    if (saving) return;
    setSaving(true);
    setFormError(null);
    setSuccess(null);
    try {
      const id = formState?.record?.id;
      switch (resource) {
        case 'units': {
          const common = commonUpdate(data);
          if (id) {
            await organizationApi.updateUnit(
              organizationId,
              id,
              withoutUnchangedPlacement(
                { ...common, parentUnitId: text(data, 'parentUnitId') || null },
                formState!.record!,
              ),
            );
          } else {
            const parentUnitId = text(data, 'parentUnitId');
            await organizationApi.createUnit(organizationId, {
              ...common,
              code: text(data, 'code'),
              ...(parentUnitId ? { parentUnitId } : {}),
            });
          }
          break;
        }
        case 'departments': {
          if (id) {
            await organizationApi.updateDepartment(
              organizationId,
              id,
              withoutUnchangedPlacement(updateDepartmentPayload(data), formState!.record!),
            );
          } else {
            await organizationApi.createDepartment(organizationId, createDepartmentPayload(data));
          }
          break;
        }
        case 'teams':
          if (id) {
            await organizationApi.updateTeam(
              organizationId,
              id,
              withoutUnchangedPlacement(updateTeamPayload(data), formState!.record!),
            );
          } else {
            await organizationApi.createTeam(organizationId, createTeamPayload(data));
          }
          break;
        case 'job-titles': {
          const common = commonUpdate(data);
          if (id) {
            await organizationApi.updateJobTitle(organizationId, id, common);
          } else {
            await organizationApi.createJobTitle(organizationId, {
              ...common,
              code: text(data, 'code'),
            });
          }
          break;
        }
        case 'positions':
          if (id) {
            await organizationApi.updatePosition(
              organizationId,
              id,
              withoutUnchangedPlacement(
                updatePositionPayload(data, formState!.record as Position),
                formState!.record!,
              ),
            );
          } else {
            await organizationApi.createPosition(organizationId, createPositionPayload(data));
          }
          break;
        case 'work-locations': {
          const common = { ...commonUpdate(data), ...locationFields(data) };
          if (id) {
            await organizationApi.updateWorkLocation(organizationId, id, common);
          } else {
            await organizationApi.createWorkLocation(organizationId, {
              ...common,
              code: text(data, 'code'),
            });
          }
          break;
        }
      }
      setFormState(null);
      setSuccess(
        id
          ? `${resourceInfo[resource].title} updated.`
          : `${resourceInfo[resource].title} created.`,
      );
      await load();
    } catch (cause) {
      setFormError(
        organizationErrorMessage(
          cause,
          `Unable to save ${resourceInfo[resource].title.toLowerCase()}.`,
        ),
      );
    } finally {
      setSaving(false);
    }
  }

  async function archive(record: ResourceRecord) {
    if (!canManageRecord(record)) return;
    setBusyRecordId(record.id);
    setError(null);
    setSuccess(null);
    try {
      await organizationApi.archiveRecord(organizationId, resource, record.id);
      setSuccess(`${record.name} archived.`);
      await load();
    } catch (cause) {
      setError(organizationErrorMessage(cause, `Unable to archive ${record.name}.`));
    } finally {
      setBusyRecordId(null);
    }
  }

  async function reactivate(record: ResourceRecord) {
    if (!canManageRecord(record)) return;
    setBusyRecordId(record.id);
    setError(null);
    setSuccess(null);
    try {
      await organizationApi.reactivateRecord(organizationId, resource, record.id);
      setSuccess(`${record.name} reactivated.`);
      await load();
    } catch (cause) {
      setError(organizationErrorMessage(cause, `Unable to reactivate ${record.name}.`));
    } finally {
      setBusyRecordId(null);
    }
  }

  const info = resourceInfo[resource];
  return (
    <PageContainer width="wide">
      <Link
        href={`/admin/organizations/${organizationId}`}
        className="text-sm font-medium text-indigo-700 hover:underline"
      >
        ← {organizationName}
      </Link>
      <div className="mt-6">
        <PageHeader eyebrow={organizationName} title={info.title} description={info.description}>
          <button
            type="button"
            onClick={() => (formState?.record ? setFormState(null) : startCreate())}
            disabled={
              loading || Boolean(organization?.archivedAt) || (!formState?.record && !mayOpenCreate)
            }
            className="rounded-lg bg-indigo-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-800 disabled:opacity-50"
          >
            {formState?.record ? 'Cancel edit' : 'New record'}
          </button>
        </PageHeader>
      </div>
      {organization?.archivedAt && (
        <div className="mt-5">
          <FeedbackMessage tone="error">
            This organization is archived. Its records are read-only.
          </FeedbackMessage>
        </div>
      )}
      {!loading && !organization?.archivedAt && managesPositions && (
        <>
          {options.positionReferencesError ? (
            <div className="mt-5">
              <ErrorBanner>
                Job titles and work locations for Position forms could not be loaded:{' '}
                {options.positionReferencesError} Positions cannot be created or edited until they
                load.
              </ErrorBanner>
            </div>
          ) : noActiveJobTitles && canCreate ? (
            <div className="mt-5">
              <InlineMessage tone="warning" as="p">
                No active job title is available, so new Positions cannot be created yet. An
                organization administrator needs to add or reactivate a job title first.
              </InlineMessage>
            </div>
          ) : null}
        </>
      )}
      {success && (
        <div className="mt-5">
          <FeedbackMessage>{success}</FeedbackMessage>
        </div>
      )}
      {error && (
        <div className="mt-5">
          <ErrorBanner>{error}</ErrorBanner>
        </div>
      )}
      <section className="mt-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-slate-950">{info.title}</h2>
          <ArchivedToggle
            checked={includeArchived}
            onChange={(checked) => {
              setLoading(true);
              setIncludeArchived(checked);
            }}
          />
        </div>
        {formState &&
          !organization?.archivedAt &&
          (formState.record ? mayOpenEdit(formState.record) : mayOpenCreate) && (
            <OrganizationResourceForm
              key={formState.record?.id ?? 'new-record'}
              kind={resource}
              initial={formState.record ? formState.initial : undefined}
              options={options}
              error={formError}
              busy={saving}
              placement={placement}
              forbiddenParentIds={
                resource === 'units' && formState.record
                  ? [...descendantsOf(formState.record.id, records.filter(isUnitRecord))]
                  : []
              }
              onSubmit={(data) => void save(data)}
              onCancel={() => {
                setFormState(null);
                setFormError(null);
              }}
            />
          )}
        {loading ? (
          <LoadingState />
        ) : records.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center">
            <p className="font-medium text-slate-900">No {info.title.toLowerCase()} found</p>
            <p className="mt-1 text-sm text-slate-600">
              {includeArchived ? 'No records match this view.' : 'Create a record to get started.'}
            </p>
          </div>
        ) : (
          <TableScroll label={info.title}>
            <table className="min-w-full divide-y divide-slate-200">
              <thead className="bg-slate-50">
                <tr>
                  {resource === 'units' && (
                    <th
                      scope="col"
                      className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500"
                    >
                      Hierarchy
                    </th>
                  )}
                  <th
                    scope="col"
                    className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500"
                  >
                    Code
                  </th>
                  {resource !== 'units' && (
                    <th
                      scope="col"
                      className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500"
                    >
                      Name
                    </th>
                  )}
                  <th
                    scope="col"
                    className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500"
                  >
                    {resource === 'units' ? 'Status' : 'Placement / details'}
                  </th>
                  {resource !== 'units' && (
                    <th
                      scope="col"
                      className="px-5 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-500"
                    >
                      Status
                    </th>
                  )}
                  <th
                    scope="col"
                    className="px-5 py-3 text-right text-xs font-semibold uppercase tracking-wide text-slate-500"
                  >
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {(resource === 'units' ? unitRows.map(({ unit }) => unit) : records).map(
                  (record) => {
                    const unitRow =
                      resource === 'units'
                        ? unitRows.find((item) => item.unit.id === record.id)
                        : undefined;
                    const archived = Boolean(record.archivedAt);
                    return (
                      <tr key={record.id} className={archived ? 'bg-slate-50 text-slate-600' : ''}>
                        {resource === 'units' && (
                          <td className="px-5 py-4 align-top">
                            <div
                              className="flex min-w-64 items-start gap-2"
                              style={{ paddingLeft: `${(unitRow?.depth ?? 0) * 24}px` }}
                            >
                              {unitRow?.hasChildren ? (
                                <button
                                  type="button"
                                  aria-label={`${collapsed.has(record.id) ? 'Expand' : 'Collapse'} ${record.name}`}
                                  onClick={() =>
                                    setCollapsed((current) => {
                                      const next = new Set(current);
                                      if (next.has(record.id)) next.delete(record.id);
                                      else next.add(record.id);
                                      return next;
                                    })
                                  }
                                  className="mt-0.5 size-6 rounded border border-slate-300 text-sm text-slate-700"
                                >
                                  {collapsed.has(record.id) ? '+' : '−'}
                                </button>
                              ) : (
                                <span aria-hidden="true" className="inline-block size-6" />
                              )}
                              <div>
                                <p className="font-medium text-slate-900">{record.name}</p>
                                <p className="mt-1 text-xs text-slate-500">
                                  {placementLabel(record, options)}
                                </p>
                                {record.description && (
                                  <p className="mt-1 text-sm text-slate-500">
                                    {record.description}
                                  </p>
                                )}
                              </div>
                            </div>
                          </td>
                        )}
                        <td className="px-5 py-4 align-top font-mono text-sm">{record.code}</td>
                        {resource !== 'units' && (
                          <td className="px-5 py-4 align-top">
                            <p className="font-medium text-slate-900">{record.name}</p>
                            {record.description && (
                              <p className="mt-1 max-w-md text-sm text-slate-500">
                                {record.description}
                              </p>
                            )}
                          </td>
                        )}
                        <td className="px-5 py-4 align-top text-sm text-slate-700">
                          {resource === 'units' ? (
                            <StatusBadge archived={archived} />
                          ) : (
                            placementLabel(record, options)
                          )}
                        </td>
                        {resource !== 'units' && (
                          <td className="px-5 py-4 align-top">
                            <StatusBadge archived={archived} />
                          </td>
                        )}
                        <td className="px-5 py-4 align-top text-right">
                          <div className="flex justify-end">
                            <RecordActions
                              archived={archived}
                              busy={busyRecordId === record.id || Boolean(organization?.archivedAt)}
                              onEdit={() => startEdit(record)}
                              onArchive={() => archive(record)}
                              onReactivate={() => reactivate(record)}
                              readOnly={!canManageRecord(record)}
                              editDisabled={!mayOpenEdit(record)}
                            />
                          </div>
                        </td>
                      </tr>
                    );
                  },
                )}
              </tbody>
            </table>
          </TableScroll>
        )}
      </section>
    </PageContainer>
  );
}
