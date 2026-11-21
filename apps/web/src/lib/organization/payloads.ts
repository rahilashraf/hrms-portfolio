import type {
  DepartmentCreateInput,
  DepartmentUpdateInput,
  PositionCreateInput,
  PositionUpdateInput,
  TeamCreateInput,
  TeamUpdateInput,
} from './types';

function field(data: FormData, name: string): string {
  const value = data.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function sortOrder(data: FormData): number {
  return Number(field(data, 'sortOrder') || 0);
}

function description(data: FormData): string {
  return field(data, 'description');
}

type Placement = 'organization' | 'units' | 'departments' | 'teams';

function selectedPlacement(data: FormData): { type: Placement; id: string } | null {
  const selected = field(data, 'placementType');
  if (
    selected !== 'organization' &&
    selected !== 'units' &&
    selected !== 'departments' &&
    selected !== 'teams'
  ) {
    throw new Error('Choose a valid placement.');
  }
  const type: Placement = selected;
  if (type === 'organization') return null;
  const id = field(data, type === 'units' ? 'organizationalUnitId' : type.slice(0, -1) + 'Id');
  if (!id) throw new Error('Choose a placement.');
  return { type, id };
}

export function createTeamPayload(data: FormData): TeamCreateInput {
  const placement = selectedPlacement(data);
  if (!placement || placement.type === 'teams') {
    throw new Error('Choose a Department or Business Unit for the Team.');
  }
  return {
    name: field(data, 'name'),
    code: field(data, 'code'),
    description: description(data),
    sortOrder: sortOrder(data),
    ...(placement.type === 'departments'
      ? { departmentId: placement.id }
      : { organizationalUnitId: placement.id }),
  };
}

export function updateTeamPayload(data: FormData): TeamUpdateInput {
  const placement = selectedPlacement(data);
  if (!placement || placement.type === 'teams') {
    throw new Error('Choose a Department or Business Unit for the Team.');
  }
  return {
    name: field(data, 'name'),
    description: description(data),
    sortOrder: sortOrder(data),
    ...(placement.type === 'departments'
      ? { departmentId: placement.id }
      : { organizationalUnitId: placement.id }),
  };
}

export function createPositionPayload(data: FormData): PositionCreateInput {
  const placement = selectedPlacement(data);
  const common = {
    name: field(data, 'name'),
    code: field(data, 'code'),
    description: description(data),
    sortOrder: sortOrder(data),
    jobTitleId: field(data, 'jobTitleId'),
    workLocationId: field(data, 'workLocationId') || undefined,
  };
  if (!placement) return common;
  if (placement.type === 'units') return { ...common, organizationalUnitId: placement.id };
  if (placement.type === 'departments') return { ...common, departmentId: placement.id };
  return { ...common, teamId: placement.id };
}

/**
 * R5B: the Position's current job title and work location. The API treats any job title, work
 * location or placement it receives as an identity change and refuses it once the Position has
 * employment history, even when the value is unchanged; so an edit leaves out the ones the user
 * did not change (placement is left out by the page, see withoutUnchangedPlacement).
 */
export interface PositionIdentity {
  jobTitleId: string;
  workLocationId: string | null;
}

export function updatePositionPayload(
  data: FormData,
  current: PositionIdentity,
): PositionUpdateInput {
  const placement = selectedPlacement(data);
  const jobTitleId = field(data, 'jobTitleId');
  // An empty choice is "No work location": sent (as null) only to clear a location that was set.
  const workLocationId = field(data, 'workLocationId') || null;
  const common: PositionUpdateInput = {
    name: field(data, 'name'),
    description: description(data),
    sortOrder: sortOrder(data),
    ...(jobTitleId && jobTitleId !== current.jobTitleId ? { jobTitleId } : {}),
    ...(workLocationId !== (current.workLocationId ?? null) ? { workLocationId } : {}),
    organizationalUnitId: null,
    departmentId: null,
    teamId: null,
  };
  if (!placement) return common;
  if (placement.type === 'units') return { ...common, organizationalUnitId: placement.id };
  if (placement.type === 'departments') return { ...common, departmentId: placement.id };
  return { ...common, teamId: placement.id };
}

export function createDepartmentPayload(data: FormData): DepartmentCreateInput {
  const organizationalUnitId = field(data, 'organizationalUnitId');
  return {
    name: field(data, 'name'),
    code: field(data, 'code'),
    description: description(data),
    sortOrder: sortOrder(data),
    ...(organizationalUnitId ? { organizationalUnitId } : {}),
  };
}

export function updateDepartmentPayload(data: FormData): DepartmentUpdateInput {
  const common = {
    name: field(data, 'name'),
    description: description(data),
    sortOrder: sortOrder(data),
    organizationalUnitId: field(data, 'organizationalUnitId') || null,
  };
  return common;
}
