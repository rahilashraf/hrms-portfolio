'use client';

import { buttonClass } from '../ui/button';
import { useState, type FormEvent, type ReactNode } from 'react';
import type {
  Department,
  JobTitle,
  OrganizationalUnit,
  PhysicalSite,
  Position,
  PositionReferenceOptions,
  Team,
  WorkLocation,
} from '../../lib/organization/types';
import { ErrorBanner } from './shared';
import type { PlacementPermissions } from '../../lib/organization/authority';

export type ResourceKind =
  'units' | 'departments' | 'teams' | 'job-titles' | 'positions' | 'work-locations';

export interface ResourceFormInitial {
  id: string;
  name: string;
  code: string;
  description: string;
  sortOrder: number;
  parentUnitId?: string | null;
  organizationalUnitId?: string | null;
  departmentId?: string | null;
  teamId?: string | null;
  jobTitleId?: string;
  workLocationId?: string | null;
  physicalSiteId?: string | null;
  /** The record's current site, so editing always offers (and keeps) it. */
  physicalSite?: { id: string; name: string } | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  stateProvince?: string | null;
  postalCode?: string | null;
  country?: string | null;
  timezone?: string | null;
}

export interface ResourceFormOptions {
  units: OrganizationalUnit[];
  departments: Department[];
  teams: Team[];
  jobTitles: JobTitle[];
  workLocations: WorkLocation[];
  /**
   * Batch 5C: the organization's physical sites for the work-location site picker. `null` when
   * they could not be listed; the picker then offers the sites of existing work locations.
   */
  physicalSites?: PhysicalSite[] | null;
  /**
   * R5B: the active Job Titles and Work Locations a Position may reference (from the reference
   * options route, which managers at any scope may read). When present, the Position form offers
   * these instead of `jobTitles` / `workLocations`, which stay the lookups for labels.
   */
  positionReferences?: PositionReferenceOptions | null;
}

const inputClass =
  'mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-950 shadow-sm focus:border-indigo-500 focus:outline-hidden focus:ring-2 focus:ring-[var(--hrms-accent-text)]';

function TextField({
  label,
  name,
  defaultValue,
  required = false,
  type = 'text',
}: {
  label: string;
  name: string;
  defaultValue?: string | number | null;
  required?: boolean;
  type?: 'text' | 'number' | 'textarea';
}) {
  const id = `organization-${name}`;
  return (
    <label htmlFor={id} className="block text-sm font-medium text-slate-700">
      {label}
      {type === 'textarea' ? (
        <textarea
          id={id}
          name={name}
          defaultValue={defaultValue ?? ''}
          rows={3}
          className={inputClass}
        />
      ) : (
        <input
          id={id}
          name={name}
          type={type}
          defaultValue={defaultValue ?? ''}
          required={required}
          min={type === 'number' ? 0 : undefined}
          step={type === 'number' ? 1 : undefined}
          className={inputClass}
        />
      )}
    </label>
  );
}

function SelectField({
  label,
  name,
  options,
  defaultValue,
  required = false,
  emptyLabel = 'Select…',
  allowEmpty = true,
  onChange,
}: {
  label: string;
  name: string;
  options: Array<{ id: string; label: string }>;
  defaultValue?: string | null;
  required?: boolean;
  emptyLabel?: string;
  /** R5-A: false when the empty choice (e.g. "No parent") is not the caller's to make. */
  allowEmpty?: boolean;
  onChange?(value: string): void;
}) {
  const id = `organization-${name}`;
  return (
    <label htmlFor={id} className="block text-sm font-medium text-slate-700">
      {label}
      <select
        id={id}
        name={name}
        defaultValue={defaultValue ?? ''}
        required={required || !allowEmpty}
        onChange={(event) => onChange?.(event.currentTarget.value)}
        className={inputClass}
      >
        <option value="">{allowEmpty ? emptyLabel : 'Select…'}</option>
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function placementType(initial?: ResourceFormInitial): string {
  if (initial?.organizationalUnitId) return 'units';
  if (initial?.departmentId) return 'departments';
  if (initial?.teamId) return 'teams';
  return 'organization';
}

export function formInitialFromRecord(
  kind: ResourceKind,
  record: OrganizationalUnit | Department | Team | JobTitle | Position | WorkLocation,
): ResourceFormInitial {
  const initial: ResourceFormInitial = {
    id: record.id,
    name: record.name,
    code: record.code,
    description: record.description ?? '',
    sortOrder: record.sortOrder,
  };
  if (kind === 'units' && 'parentUnitId' in record) {
    initial.parentUnitId = record.parentUnitId;
  } else if (kind === 'departments' && 'organizationalUnitId' in record) {
    initial.organizationalUnitId = record.organizationalUnitId;
  } else if (kind === 'teams' && 'departmentId' in record) {
    initial.departmentId = record.departmentId;
    initial.organizationalUnitId = record.organizationalUnitId;
  } else if (kind === 'positions' && 'jobTitleId' in record) {
    initial.jobTitleId = record.jobTitleId;
    initial.organizationalUnitId = record.organizationalUnitId;
    initial.departmentId = record.departmentId;
    initial.teamId = record.teamId;
    initial.workLocationId = record.workLocationId;
  } else if (kind === 'work-locations' && 'timezone' in record) {
    initial.physicalSiteId = record.physicalSiteId;
    initial.physicalSite = record.physicalSite
      ? { id: record.physicalSite.id, name: record.physicalSite.name }
      : null;
    initial.addressLine1 = record.addressLine1;
    initial.addressLine2 = record.addressLine2;
    initial.city = record.city;
    initial.stateProvince = record.stateProvince;
    initial.postalCode = record.postalCode;
    initial.country = record.country;
    initial.timezone = record.timezone;
  }
  return initial;
}

/**
 * R5-A (F1): the record's current parent stays a choice even when it is not otherwise offered (a
 * manager of a business unit does not see the unit above it; an archived parent is filtered out),
 * so a save that keeps it works.
 */
function keepCurrent(
  visible: Array<{ id: string }>,
  ids: Array<string | null | undefined>,
): Array<{ id: string; label: string }> {
  return ids
    .filter((id): id is string => !!id && !visible.some((item) => item.id === id))
    .map((id) => ({ id, label: 'Current placement (unchanged)' }));
}

/**
 * R5B: the Position's current Job Title or Work Location stays selectable while editing even when
 * it is no longer offered (archived), so saving other changes keeps it instead of clearing it. It
 * is labelled as unavailable and is never offered for a new record.
 */
function keepCurrentReference(
  offered: Array<{ id: string }>,
  id: string | null | undefined,
  known: Array<{ id: string; name: string; code: string }>,
  noun: string,
): Array<{ id: string; label: string }> {
  if (!id || offered.some((item) => item.id === id)) return [];
  const record = known.find((item) => item.id === id);
  return [
    {
      id,
      label: record
        ? `${record.name} (${record.code}) — current, unavailable for new positions`
        : `Current ${noun} (unavailable for new positions)`,
    },
  ];
}

export function OrganizationResourceForm({
  kind,
  initial,
  options,
  error,
  busy,
  readOnly = false,
  forbiddenParentIds = [],
  placement,
  onSubmit,
  onCancel,
}: {
  kind: ResourceKind;
  initial?: ResourceFormInitial;
  options: ResourceFormOptions;
  error: string | null;
  busy: boolean;
  readOnly?: boolean;
  forbiddenParentIds?: string[];
  /**
   * R5-A (F1): where the caller may place the record. Only those parents are offered, plus the
   * record's current one (so a save that keeps it works); without it every parent is offered.
   */
  placement?: PlacementPermissions;
  onSubmit(data: FormData): void;
  onCancel(): void;
}) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmit(new FormData(event.currentTarget));
  }

  const editing = Boolean(initial);
  // The record's current placement stays selectable: keeping it is not a move.
  const current = {
    units: new Set(
      [initial?.parentUnitId, initial?.organizationalUnitId].filter((id): id is string => !!id),
    ),
    departments: initial?.departmentId ?? null,
    teams: initial?.teamId ?? null,
  };
  const currentlyAtOrganization =
    editing &&
    (kind === 'units'
      ? !initial?.parentUnitId
      : kind === 'departments'
        ? !initial?.organizationalUnitId
        : kind === 'positions'
          ? placementType(initial) === 'organization'
          : false);
  const mayPlaceAtOrganization = !placement || placement.organization || currentlyAtOrganization;
  const orgUnitOptions = options.units
    .filter((unit) => !unit.archivedAt)
    .filter((unit) => !forbiddenParentIds.includes(unit.id))
    .filter((unit) => !placement || placement.unit(unit.id) || current.units.has(unit.id))
    .map((unit) => ({ id: unit.id, label: `${unit.name} (${unit.code})` }));
  orgUnitOptions.push(...keepCurrent(orgUnitOptions, [...current.units]));
  const departmentOptions = options.departments
    .filter((item) => !item.archivedAt)
    .filter(
      (item) => !placement || placement.department(item.id) || current.departments === item.id,
    )
    .map((item) => ({
      id: item.id,
      label: `${item.name} (${item.code})`,
    }));
  departmentOptions.push(...keepCurrent(departmentOptions, [current.departments]));
  const teamOptions = options.teams
    .filter((item) => !item.archivedAt)
    .filter((item) => !placement || placement.team(item.id) || current.teams === item.id)
    .map((item) => ({
      id: item.id,
      label: `${item.name} (${item.code})`,
    }));
  teamOptions.push(...keepCurrent(teamOptions, [current.teams]));
  const references = options.positionReferences;
  const titleOptions = (
    references?.jobTitles ?? options.jobTitles.filter((item) => !item.archivedAt)
  ).map((item) => ({
    id: item.id,
    label: `${item.name} (${item.code})`,
  }));
  const locationOptions = (
    references?.workLocations ?? options.workLocations.filter((item) => !item.archivedAt)
  ).map((item) => ({
    id: item.id,
    label: `${item.name} (${item.code})`,
  }));
  if (editing && kind === 'positions') {
    titleOptions.push(
      ...keepCurrentReference(titleOptions, initial?.jobTitleId, options.jobTitles, 'job title'),
    );
    locationOptions.push(
      ...keepCurrentReference(
        locationOptions,
        initial?.workLocationId,
        options.workLocations,
        'work location',
      ),
    );
  }
  const siteOptions = Array.from(
    new Map(
      [
        ...(options.physicalSites ??
          options.workLocations
            .filter((item) => !item.archivedAt && item.physicalSite)
            .map((item) => item.physicalSite!)),
        // The edited location's own site, even when no other active location shares it.
        ...(initial?.physicalSite ? [initial.physicalSite] : []),
      ].map((site) => [site.id, site]),
    ).values(),
  ).map((site) => ({ id: site.id, label: site.name }));
  const selectedType = placementType(initial);
  // R5-A (F1): only the placement types the caller can use (the current one always).
  const placementChoices: Record<string, boolean> = {
    organization: mayPlaceAtOrganization,
    units: orgUnitOptions.length > 0,
    departments: departmentOptions.length > 0,
    teams: teamOptions.length > 0,
  };
  const teamTypes = [
    { id: 'departments', label: 'Department' },
    { id: 'units', label: 'Business Unit' },
  ].filter((type) => placementChoices[type.id] || type.id === selectedType);
  const positionTypes = [
    { id: 'organization', label: 'Organization' },
    { id: 'units', label: 'Business Unit' },
    { id: 'departments', label: 'Department' },
    { id: 'teams', label: 'Team' },
  ].filter((type) => placementChoices[type.id] || (editing && type.id === selectedType));
  const firstOf = (types: Array<{ id: string }>, preferred: string) =>
    types.some((type) => type.id === preferred) ? preferred : (types[0]?.id ?? preferred);
  const [teamType, setTeamType] = useState(() =>
    firstOf(teamTypes, selectedType === 'units' ? 'units' : 'departments'),
  );
  const [positionType, setPositionType] = useState(() => firstOf(positionTypes, selectedType));

  function selectForPlacement(type: string): ReactNode {
    if (type === 'units') {
      return (
        <SelectField
          label="Business Unit"
          name="organizationalUnitId"
          options={orgUnitOptions}
          defaultValue={type === selectedType ? initial?.organizationalUnitId : null}
          required
        />
      );
    }
    if (type === 'departments') {
      return (
        <SelectField
          label="Department"
          name="departmentId"
          options={departmentOptions}
          defaultValue={type === selectedType ? initial?.departmentId : null}
          required
        />
      );
    }
    if (type === 'teams') {
      return (
        <SelectField
          label="Team"
          name="teamId"
          options={teamOptions}
          defaultValue={type === selectedType ? initial?.teamId : null}
          required
        />
      );
    }
    return null;
  }

  return (
    <form onSubmit={submit} className="space-y-4 rounded-xl border border-slate-200 bg-white p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-slate-950">
            {editing ? `Edit ${kindLabel(kind)}` : `Create ${kindLabel(kind)}`}
          </h2>
          {editing && (
            <p className="mt-1 text-sm text-slate-600">
              Code <span className="font-mono">{initial?.code}</span> is immutable.
            </p>
          )}
        </div>
        {editing && (
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700"
          >
            Cancel
          </button>
        )}
      </div>
      {error && <ErrorBanner>{error}</ErrorBanner>}
      <fieldset disabled={readOnly || busy} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <TextField label="Name" name="name" defaultValue={initial?.name} required />
        {!editing && <TextField label="Code" name="code" required />}
        {kind === 'units' && (
          <SelectField
            label="Parent Unit"
            name="parentUnitId"
            options={orgUnitOptions}
            defaultValue={initial?.parentUnitId}
            emptyLabel="No parent (root unit)"
            allowEmpty={mayPlaceAtOrganization}
          />
        )}
        {kind === 'departments' && (
          <SelectField
            label="Business Unit"
            name="organizationalUnitId"
            options={orgUnitOptions}
            defaultValue={initial?.organizationalUnitId}
            emptyLabel="Organization-wide"
            allowEmpty={mayPlaceAtOrganization}
          />
        )}
        {kind === 'teams' && (
          <>
            <SelectField
              label="Placement type"
              name="placementType"
              options={teamTypes}
              defaultValue={teamType}
              required
              onChange={setTeamType}
            />
            <SelectField
              label={teamType === 'units' ? 'Business Unit' : 'Department'}
              name={teamType === 'units' ? 'organizationalUnitId' : 'departmentId'}
              options={teamType === 'units' ? orgUnitOptions : departmentOptions}
              defaultValue={
                teamType === selectedType
                  ? teamType === 'units'
                    ? initial?.organizationalUnitId
                    : initial?.departmentId
                  : null
              }
              required
            />
          </>
        )}
        {kind === 'positions' && (
          <>
            <SelectField
              label="Job Title"
              name="jobTitleId"
              options={titleOptions}
              defaultValue={initial?.jobTitleId}
              required
            />
            <SelectField
              label="Work Location"
              name="workLocationId"
              options={locationOptions}
              defaultValue={initial?.workLocationId}
              emptyLabel="No work location"
            />
            <SelectField
              label="Placement type"
              name="placementType"
              options={positionTypes}
              defaultValue={positionType}
              required
              onChange={setPositionType}
            />
            {selectForPlacement(positionType)}
          </>
        )}
        <TextField
          label="Sort order"
          name="sortOrder"
          type="number"
          defaultValue={initial?.sortOrder ?? 0}
        />
        {kind === 'work-locations' && (
          <>
            <SelectField
              label="Physical Site"
              name="physicalSiteId"
              options={siteOptions}
              defaultValue={initial?.physicalSiteId}
              emptyLabel="Create a matching physical site"
            />
            <TextField
              label="Address line 1"
              name="addressLine1"
              defaultValue={initial?.addressLine1}
            />
            <TextField
              label="Address line 2"
              name="addressLine2"
              defaultValue={initial?.addressLine2}
            />
            <TextField label="City" name="city" defaultValue={initial?.city} />
            <TextField
              label="State / Province"
              name="stateProvince"
              defaultValue={initial?.stateProvince}
            />
            <TextField label="Postal code" name="postalCode" defaultValue={initial?.postalCode} />
            <TextField label="Country" name="country" defaultValue={initial?.country} />
            <TextField label="Timezone (IANA)" name="timezone" defaultValue={initial?.timezone} />
          </>
        )}
        <div className="sm:col-span-2">
          <TextField
            label="Description"
            name="description"
            type="textarea"
            defaultValue={initial?.description}
          />
        </div>
      </fieldset>
      <div className="flex justify-end gap-2">
        {!editing && (
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700"
          >
            Cancel
          </button>
        )}
        {!readOnly && (
          <button type="submit" disabled={busy} className={buttonClass('primary')}>
            {busy ? 'Saving…' : editing ? 'Save changes' : `Create ${kindLabel(kind)}`}
          </button>
        )}
      </div>
    </form>
  );
}

function kindLabel(kind: ResourceKind): string {
  switch (kind) {
    case 'units':
      return 'Business Unit';
    case 'departments':
      return 'Department';
    case 'teams':
      return 'Team';
    case 'job-titles':
      return 'Job Title';
    case 'positions':
      return 'Position';
    case 'work-locations':
      return 'Work Location';
  }
}
