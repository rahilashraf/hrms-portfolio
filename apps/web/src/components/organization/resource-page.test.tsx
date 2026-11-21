import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthApiError } from '../../lib/auth/types';
import { canFromSnapshot, type AuthorizationScope } from '../../lib/authorization/can';
import type { GrantSnapshot } from '../../lib/authorization/types';
import { OrganizationResourcePage, withoutUnchangedPlacement } from './resource-page';

/**
 * R5-A (F1) — the structure screens follow the API's rules for managers whose grants sit below
 * the organization: each record's actions use its own scope, new records are offered only under
 * parents the caller manages, moves only to destinations they manage, and a refused
 * organization header does not hide the records the API lists for them.
 */
const mocks = vi.hoisted(() => ({
  api: {
    getOrganization: vi.fn(),
    getStructure: vi.fn(),
    listUnits: vi.fn(),
    listDepartments: vi.fn(),
    listTeams: vi.fn(),
    listJobTitles: vi.fn(),
    listPositions: vi.fn(),
    listWorkLocations: vi.fn(),
    listPositionReferenceOptions: vi.fn(),
    listPhysicalSites: vi.fn(),
    createUnit: vi.fn(),
    updateUnit: vi.fn(),
    createDepartment: vi.fn(),
    updateDepartment: vi.fn(),
    createTeam: vi.fn(),
    updateTeam: vi.fn(),
    createPosition: vi.fn(),
    updatePosition: vi.fn(),
    archiveRecord: vi.fn(),
    reactivateRecord: vi.fn(),
  },
  snapshot: null as GrantSnapshot | null,
}));
vi.mock('../../lib/organization/api', () => ({ organizationApi: mocks.api }));
vi.mock('../../providers/auth-provider', () => ({
  useAuth: () => ({
    can: (permission: string, scope?: AuthorizationScope, context?: object) =>
      canFromSnapshot(mocks.snapshot, permission, scope, context),
  }),
}));
vi.mock('../../providers/workspace-provider', () => ({
  useWorkspace: () => ({
    organizations: [{ id: 'org-1', name: 'Harbourline Outdoor Centre' }],
  }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: unknown }) => (
    <a href={href} {...(rest as object)}>
      {children as never}
    </a>
  ),
}));

type Grant = { key: string; type: string; id?: string };
const grants = (...items: Grant[]): GrantSnapshot =>
  ({
    permissions: Object.values(
      items.reduce<Record<string, { key: string; scopes: Array<{ type: string; id?: string }> }>>(
        (all, { key, type, id }) => {
          (all[key] ??= { key, scopes: [] }).scopes.push({ type, ...(id ? { id } : {}) });
          return all;
        },
        {},
      ),
    ),
  }) as unknown as GrantSnapshot;
const manage = (type: string, id: string): Grant => ({ key: 'organization.manage', type, id });
const read = (type: string, id: string): Grant => ({ key: 'organization.read', type, id });

const base = { organizationId: 'org-1', description: null, sortOrder: 0, archivedAt: null };
// Root unit; two business units under it (A and its sibling B); a unit under A.
const units = {
  root: { ...base, id: 'unit-root', name: 'Harbourline', code: 'HBL', parentUnitId: null },
  a: { ...base, id: 'unit-a', name: 'Outdoor Centre', code: 'OC', parentUnitId: 'unit-root' },
  b: { ...base, id: 'unit-b', name: 'Studio', code: 'ST', parentUnitId: 'unit-root' },
  a1: { ...base, id: 'unit-a1', name: 'Waterfront', code: 'WF', parentUnitId: 'unit-a' },
};
const departments = {
  a: { ...base, id: 'dept-a', name: 'Programs', code: 'PRG', organizationalUnitId: 'unit-a' },
  b: { ...base, id: 'dept-b', name: 'Bookings', code: 'BKG', organizationalUnitId: 'unit-b' },
  org: { ...base, id: 'dept-org', name: 'Finance', code: 'FIN', organizationalUnitId: null },
};
const teams = {
  a: {
    ...base,
    id: 'team-a',
    name: 'Canoe',
    code: 'CAN',
    departmentId: 'dept-a',
    organizationalUnitId: null,
  },
  b: {
    ...base,
    id: 'team-b',
    name: 'Front desk',
    code: 'FD',
    departmentId: 'dept-b',
    organizationalUnitId: null,
  },
};
const tree = (list: Array<{ id: string; parentUnitId: string | null }>) => {
  const node = (unit: (typeof list)[number]): object => ({
    ...unit,
    children: list.filter((child) => child.parentUnitId === unit.id).map(node),
  });
  const ids = new Set(list.map((unit) => unit.id));
  return list.filter((unit) => !unit.parentUnitId || !ids.has(unit.parentUnitId)).map(node);
};

/** What the API lists for the caller (it filters by organization.read). */
function visible({
  unitList = Object.values(units),
  departmentList = Object.values(departments),
  teamList = Object.values(teams),
}: {
  unitList?: Array<(typeof units)[keyof typeof units]>;
  departmentList?: Array<Record<string, unknown>>;
  teamList?: Array<Record<string, unknown>>;
} = {}) {
  mocks.api.getStructure.mockResolvedValue(tree(unitList));
  mocks.api.listUnits.mockResolvedValue(unitList);
  mocks.api.listDepartments.mockResolvedValue(departmentList);
  mocks.api.listTeams.mockResolvedValue(teamList);
}

const forbidden = () => new AuthApiError('forbidden', 403);
const readsOrganization = () =>
  canFromSnapshot(mocks.snapshot, 'organization.read', { type: 'ORGANIZATION', id: 'org-1' });

function rowFor(code: string): HTMLElement {
  const row = screen
    .getAllByRole('row')
    .find((candidate) => within(candidate).queryByText(code, { selector: 'td' }));
  if (!row) throw new Error(`No row for ${code}`);
  return row;
}
const actionsIn = (code: string) =>
  within(rowFor(code))
    .queryAllByRole('button')
    .map((button) => button.textContent)
    .filter((label) => label === 'Edit' || label === 'Archive' || label === 'Reactivate');
const optionLabels = (select: HTMLElement) =>
  within(select)
    .getAllByRole('option')
    .map((option) => option.textContent);

async function openPage(resource: Parameters<typeof OrganizationResourcePage>[0]['resource']) {
  render(<OrganizationResourcePage organizationId="org-1" resource={resource} />);
  await screen.findByRole('heading', { level: 2 });
  await waitFor(() => expect(screen.queryByText('Loading organization data…')).toBeNull());
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.api.getOrganization.mockResolvedValue({
    id: 'org-1',
    name: 'Harbourline Outdoor Centre',
    archivedAt: null,
  });
  // R5B: like the API, the organization's job titles are listed only to callers who may read the
  // organization itself (they used to be returned to everyone here, which hid that scoped
  // managers had nothing to choose from).
  mocks.api.listJobTitles.mockImplementation(async () =>
    readsOrganization() ? [{ ...base, id: 'jt-1', name: 'Guide', code: 'GUIDE' }] : [],
  );
  mocks.api.listWorkLocations.mockResolvedValue([]);
  mocks.api.listPositionReferenceOptions.mockResolvedValue({
    jobTitles: [{ id: 'jt-1', name: 'Guide', code: 'GUIDE' }],
    workLocations: [],
  });
  mocks.api.listPhysicalSites.mockResolvedValue({ items: [] });
  mocks.api.listPositions.mockResolvedValue([]);
  for (const fn of [
    mocks.api.createUnit,
    mocks.api.updateUnit,
    mocks.api.createDepartment,
    mocks.api.updateDepartment,
    mocks.api.createTeam,
    mocks.api.updateTeam,
    mocks.api.createPosition,
    mocks.api.updatePosition,
    mocks.api.archiveRecord,
    mocks.api.reactivateRecord,
  ])
    fn.mockResolvedValue({});
  visible();
});
afterEach(cleanup);

describe('structure management by scope (R5-A F1)', () => {
  it('keeps every action for an organization-wide manager, including top-level records', async () => {
    mocks.snapshot = grants(read('ORGANIZATION', 'org-1'), manage('ORGANIZATION', 'org-1'));
    await openPage('units');
    for (const code of ['HBL', 'OC', 'ST', 'WF'])
      expect(actionsIn(code)).toEqual(['Edit', 'Archive']);
    fireEvent.click(screen.getByRole('button', { name: 'New record' }));
    expect(optionLabels(screen.getByLabelText('Parent Unit'))).toEqual([
      'No parent (root unit)',
      'Harbourline (HBL)',
      'Outdoor Centre (OC)',
      'Studio (ST)',
      'Waterfront (WF)',
    ]);
    cleanup();
    await openPage('departments');
    fireEvent.click(screen.getByRole('button', { name: 'New record' }));
    expect(optionLabels(screen.getByLabelText('Business Unit'))[0]).toBe('Organization-wide');
  });

  it('lets a business-unit manager act within the unit only, even when the organization is not theirs to read', async () => {
    mocks.snapshot = grants(
      read('ORGANIZATIONAL_UNIT', 'unit-a'),
      manage('ORGANIZATIONAL_UNIT', 'unit-a'),
    );
    mocks.api.getOrganization.mockRejectedValue(forbidden());
    visible({
      unitList: [units.a, units.a1],
      departmentList: [departments.a],
      teamList: [teams.a],
    });
    await openPage('units');
    // The page loads with the workspace's name for the organization.
    expect(screen.getByRole('link', { name: '← Harbourline Outdoor Centre' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(actionsIn('OC')).toEqual(['Edit', 'Archive']);
    expect(actionsIn('WF')).toEqual(['Edit', 'Archive']);

    // Create: only under units they manage; never a root unit.
    fireEvent.click(screen.getByRole('button', { name: 'New record' }));
    const parent = screen.getByLabelText('Parent Unit');
    expect(optionLabels(parent)).toEqual(['Select…', 'Outdoor Centre (OC)', 'Waterfront (WF)']);
    expect(parent).toBeRequired();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Ropes course' } });
    fireEvent.change(screen.getByLabelText('Code'), { target: { value: 'RC' } });
    fireEvent.change(parent, { target: { value: 'unit-a1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Business Unit' }));
    await waitFor(() =>
      expect(mocks.api.createUnit).toHaveBeenCalledWith(
        'org-1',
        expect.objectContaining({ code: 'RC', parentUnitId: 'unit-a1' }),
      ),
    );
  });

  it('renames the managed unit without resending a parent the manager cannot see', async () => {
    mocks.snapshot = grants(
      read('ORGANIZATIONAL_UNIT', 'unit-a'),
      manage('ORGANIZATIONAL_UNIT', 'unit-a'),
    );
    mocks.api.getOrganization.mockRejectedValue(forbidden());
    visible({ unitList: [units.a, units.a1] });
    await openPage('units');
    fireEvent.click(within(rowFor('OC')).getByRole('button', { name: 'Edit' }));
    const parent = screen.getByLabelText('Parent Unit');
    expect(parent).toHaveValue('unit-root');
    expect(optionLabels(parent)).toContain('Current placement (unchanged)');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Outdoor Centre North' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(mocks.api.updateUnit).toHaveBeenCalledTimes(1));
    const [, id, body] = mocks.api.updateUnit.mock.calls[0]!;
    expect(id).toBe('unit-a');
    expect(body).toMatchObject({ name: 'Outdoor Centre North' });
    expect(body).not.toHaveProperty('parentUnitId');
  });

  it('never offers actions on a sibling unit the manager can only read', async () => {
    mocks.snapshot = grants(read('ORGANIZATION', 'org-1'), manage('ORGANIZATIONAL_UNIT', 'unit-a'));
    await openPage('units');
    expect(actionsIn('OC')).toEqual(['Edit', 'Archive']);
    expect(actionsIn('WF')).toEqual(['Edit', 'Archive']);
    expect(actionsIn('ST')).toEqual([]);
    expect(actionsIn('HBL')).toEqual([]);
  });

  it('moves a department only to units the manager manages, and sends the new unit', async () => {
    mocks.snapshot = grants(read('ORGANIZATION', 'org-1'), manage('ORGANIZATIONAL_UNIT', 'unit-a'));
    await openPage('departments');
    expect(actionsIn('PRG')).toEqual(['Edit', 'Archive']);
    expect(actionsIn('BKG')).toEqual([]);
    expect(actionsIn('FIN')).toEqual([]);
    fireEvent.click(within(rowFor('PRG')).getByRole('button', { name: 'Edit' }));
    const unit = screen.getByLabelText('Business Unit');
    expect(optionLabels(unit)).toEqual(['Select…', 'Outdoor Centre (OC)', 'Waterfront (WF)']);
    fireEvent.change(unit, { target: { value: 'unit-a1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(mocks.api.updateDepartment).toHaveBeenCalledWith(
        'org-1',
        'dept-a',
        expect.objectContaining({ organizationalUnitId: 'unit-a1' }),
      ),
    );
  });

  it('shows the API refusal in the form and keeps it open', async () => {
    mocks.snapshot = grants(read('ORGANIZATION', 'org-1'), manage('ORGANIZATIONAL_UNIT', 'unit-a'));
    mocks.api.updateDepartment.mockRejectedValue(forbidden());
    await openPage('departments');
    fireEvent.click(within(rowFor('PRG')).getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(
      await screen.findByText('You do not have permission to perform this action.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeInTheDocument();
  });

  it('lets a department manager manage the department and create teams under it only', async () => {
    mocks.snapshot = grants(read('ORGANIZATION', 'org-1'), manage('DEPARTMENT', 'dept-a'));
    await openPage('departments');
    expect(actionsIn('PRG')).toEqual(['Edit', 'Archive']);
    expect(actionsIn('BKG')).toEqual([]);
    // A department sits under a unit or the organization, neither of which is theirs.
    expect(screen.getByRole('button', { name: 'New record' })).toBeDisabled();
    cleanup();

    await openPage('teams');
    expect(actionsIn('CAN')).toEqual(['Edit', 'Archive']);
    expect(actionsIn('FD')).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'New record' }));
    expect(optionLabels(screen.getByLabelText('Placement type'))).toEqual([
      'Select…',
      'Department',
    ]);
    expect(optionLabels(screen.getByLabelText('Department'))).toEqual([
      'Select…',
      'Programs (PRG)',
    ]);
  });

  it('lets a team manager edit the team and place positions in it, and nothing wider', async () => {
    mocks.snapshot = grants(read('ORGANIZATION', 'org-1'), manage('TEAM', 'team-a'));
    await openPage('teams');
    expect(actionsIn('CAN')).toEqual(['Edit', 'Archive']);
    expect(actionsIn('FD')).toEqual([]);
    expect(screen.getByRole('button', { name: 'New record' })).toBeDisabled();
    cleanup();

    await openPage('positions');
    fireEvent.click(screen.getByRole('button', { name: 'New record' }));
    expect(optionLabels(screen.getByLabelText('Placement type'))).toEqual(['Select…', 'Team']);
    expect(optionLabels(screen.getByLabelText('Team'))).toEqual(['Select…', 'Canoe (CAN)']);
  });

  it('archives and reactivates only records in scope', async () => {
    mocks.snapshot = grants(read('ORGANIZATION', 'org-1'), manage('ORGANIZATIONAL_UNIT', 'unit-a'));
    const archivedInScope = {
      ...departments.a,
      id: 'dept-old',
      code: 'OLD',
      archivedAt: '2026-10-01',
    };
    const archivedOutside = {
      ...departments.b,
      id: 'dept-gone',
      code: 'GONE',
      archivedAt: '2026-10-01',
    };
    visible({
      departmentList: [departments.a, departments.b, archivedInScope, archivedOutside],
    });
    await openPage('departments');
    expect(actionsIn('OLD')).toEqual(['Reactivate']);
    expect(actionsIn('GONE')).toEqual([]);
    fireEvent.click(within(rowFor('OLD')).getByRole('button', { name: 'Reactivate' }));
    await waitFor(() =>
      expect(mocks.api.reactivateRecord).toHaveBeenCalledWith('org-1', 'departments', 'dept-old'),
    );
    fireEvent.click(within(rowFor('PRG')).getByRole('button', { name: 'Archive' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm archive' }));
    await waitFor(() =>
      expect(mocks.api.archiveRecord).toHaveBeenCalledWith('org-1', 'departments', 'dept-a'),
    );
  });

  it('keeps job titles organization-level, and read-only users without any management control', async () => {
    mocks.snapshot = grants(read('ORGANIZATION', 'org-1'), manage('ORGANIZATIONAL_UNIT', 'unit-a'));
    await openPage('job-titles');
    expect(actionsIn('GUIDE')).toEqual([]);
    expect(screen.getByRole('button', { name: 'New record' })).toBeDisabled();
    cleanup();

    mocks.snapshot = grants(read('ORGANIZATION', 'org-1'));
    await openPage('units');
    for (const code of ['HBL', 'OC', 'ST', 'WF']) expect(actionsIn(code)).toEqual([]);
    expect(screen.getByRole('button', { name: 'New record' })).toBeDisabled();
    expect(screen.queryByRole('form')).toBeNull();
  });

  it('lets a manager who can edit but not create cancel an edit from the header', async () => {
    mocks.snapshot = grants(read('ORGANIZATION', 'org-1'), manage('TEAM', 'team-a'));
    await openPage('teams');
    expect(screen.getByRole('button', { name: 'New record' })).toBeDisabled();
    fireEvent.click(within(rowFor('CAN')).getByRole('button', { name: 'Edit' }));
    const cancel = screen.getByRole('button', { name: 'Cancel edit' });
    expect(cancel).toBeEnabled();
    fireEvent.click(cancel);
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
  });

  it('labels a parent the caller cannot see as not visible, not as the root', async () => {
    mocks.snapshot = grants(
      read('ORGANIZATIONAL_UNIT', 'unit-a'),
      manage('ORGANIZATIONAL_UNIT', 'unit-a'),
    );
    mocks.api.getOrganization.mockRejectedValue(forbidden());
    visible({ unitList: [units.a, units.a1], departmentList: [departments.a] });
    await openPage('units');
    expect(rowFor('OC')).toHaveTextContent('Parent not visible');
    expect(rowFor('OC')).not.toHaveTextContent('Root unit');
    expect(rowFor('WF')).toHaveTextContent('Parent: Outdoor Centre');
  });

  it('does not treat a missing organization (404) as a scoped manager', async () => {
    mocks.snapshot = grants(read('ORGANIZATION', 'org-1'), manage('ORGANIZATION', 'org-1'));
    mocks.api.getOrganization.mockRejectedValue(new AuthApiError('unexpected', 404));
    render(<OrganizationResourcePage organizationId="org-1" resource="units" />);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('still reports an organization that fails to load for another reason', async () => {
    mocks.snapshot = grants(read('ORGANIZATION', 'org-1'), manage('ORGANIZATION', 'org-1'));
    mocks.api.getOrganization.mockRejectedValue(new AuthApiError('unexpected', 500));
    render(<OrganizationResourcePage organizationId="org-1" resource="units" />);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryAllByRole('row')).toHaveLength(0);
  });

  it('keeps an archived organization read-only for its managers', async () => {
    mocks.snapshot = grants(read('ORGANIZATION', 'org-1'), manage('ORGANIZATION', 'org-1'));
    mocks.api.getOrganization.mockResolvedValue({
      id: 'org-1',
      name: 'Harbourline Outdoor Centre',
      archivedAt: '2026-10-01',
    });
    await openPage('units');
    expect(screen.getByRole('button', { name: 'New record' })).toBeDisabled();
    expect(within(rowFor('OC')).getByRole('button', { name: 'Edit' })).toBeDisabled();
  });
});

describe('withoutUnchangedPlacement (R5-A F1)', () => {
  it('drops a placement that would store what the record already holds', () => {
    expect(
      withoutUnchangedPlacement({ name: 'N', parentUnitId: 'u' }, { parentUnitId: 'u' }),
    ).toEqual({ name: 'N' });
    expect(
      withoutUnchangedPlacement(
        { name: 'N', organizationalUnitId: null, departmentId: null, teamId: 't' },
        { organizationalUnitId: null, departmentId: null, teamId: 't' },
      ),
    ).toEqual({ name: 'N' });
  });

  it('keeps a real move, and a placement that would clear another anchor', () => {
    expect(withoutUnchangedPlacement({ parentUnitId: 'v' }, { parentUnitId: 'u' })).toEqual({
      parentUnitId: 'v',
    });
    // A team under a department that also names a unit: sending only the department clears the
    // unit, which is a change, so the placement is sent (and checked) as before.
    expect(
      withoutUnchangedPlacement(
        { departmentId: 'd' },
        { departmentId: 'd', organizationalUnitId: 'u' },
      ),
    ).toEqual({ departmentId: 'd' });
    expect(withoutUnchangedPlacement({ name: 'N' }, { parentUnitId: 'u' })).toEqual({ name: 'N' });
  });
});

describe('Position forms with reference options (R5B)', () => {
  const position = (overrides: Record<string, unknown> = {}) => ({
    ...base,
    id: 'pos-1',
    name: 'Lead Guide',
    code: 'LG',
    jobTitleId: 'jt-1',
    workLocationId: 'wl-1',
    organizationalUnitId: null,
    departmentId: 'dept-a',
    teamId: null,
    ...overrides,
  });
  const location = (id: string, name: string, code: string, archivedAt: string | null = null) => ({
    ...base,
    id,
    name,
    code,
    archivedAt,
    physicalSiteId: 'site-1',
    physicalSite: null,
    timezone: 'America/Toronto',
  });
  const references = {
    jobTitles: [
      { id: 'jt-1', name: 'Guide', code: 'GUIDE' },
      { id: 'jt-2', name: 'Instructor', code: 'INSTR' },
    ],
    workLocations: [
      { id: 'wl-1', name: 'Dock', code: 'DOCK' },
      { id: 'wl-2', name: 'Lodge', code: 'LODGE' },
    ],
  };
  const orgAdmin = () => grants(read('ORGANIZATION', 'org-1'), manage('ORGANIZATION', 'org-1'));
  const scoped = (type: string, id: string) => grants(read(type, id), manage(type, id));
  const save = () => fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  const lastUpdate = () =>
    mocks.api.updatePosition.mock.calls.at(-1)![2] as Record<string, unknown>;

  beforeEach(() => {
    mocks.api.listPositionReferenceOptions.mockResolvedValue(references);
  });

  it.each([
    {
      label: 'business-unit',
      snapshot: () => scoped('ORGANIZATIONAL_UNIT', 'unit-a'),
      structure: {
        unitList: [units.a, units.a1],
        departmentList: [departments.a],
        teamList: [teams.a],
      },
      placementType: 'units',
      field: 'Business Unit',
      value: 'unit-a',
      anchor: { organizationalUnitId: 'unit-a' },
    },
    {
      label: 'department',
      snapshot: () => scoped('DEPARTMENT', 'dept-a'),
      structure: { unitList: [], departmentList: [departments.a], teamList: [teams.a] },
      placementType: 'departments',
      field: 'Department',
      value: 'dept-a',
      anchor: { departmentId: 'dept-a' },
    },
    {
      label: 'team',
      snapshot: () => scoped('TEAM', 'team-a'),
      structure: { unitList: [], departmentList: [], teamList: [teams.a] },
      placementType: 'teams',
      field: 'Team',
      value: 'team-a',
      anchor: { teamId: 'team-a' },
    },
  ])(
    'lets a $label manager without organization access create a Position from the options',
    async ({ snapshot, structure, placementType, field, value, anchor }) => {
      mocks.snapshot = snapshot();
      mocks.api.getOrganization.mockRejectedValue(forbidden());
      visible(structure);
      await openPage('positions');
      expect(mocks.api.listPositionReferenceOptions).toHaveBeenCalledWith('org-1');
      expect(screen.queryByRole('alert')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'New record' }));
      const title = screen.getByLabelText('Job Title');
      expect(title).toBeRequired();
      expect(optionLabels(title)).toEqual(['Select…', 'Guide (GUIDE)', 'Instructor (INSTR)']);
      expect(optionLabels(screen.getByLabelText('Work Location'))).toEqual([
        'No work location',
        'Dock (DOCK)',
        'Lodge (LODGE)',
      ]);
      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Paddler' } });
      fireEvent.change(screen.getByLabelText('Code'), { target: { value: 'PADDLER' } });
      fireEvent.change(title, { target: { value: 'jt-2' } });
      fireEvent.change(screen.getByLabelText('Work Location'), { target: { value: 'wl-2' } });
      fireEvent.change(screen.getByLabelText('Placement type'), {
        target: { value: placementType },
      });
      fireEvent.change(screen.getByLabelText(field), { target: { value } });
      fireEvent.click(screen.getByRole('button', { name: 'Create Position' }));
      await waitFor(() => expect(mocks.api.createPosition).toHaveBeenCalledTimes(1));
      expect(mocks.api.createPosition).toHaveBeenCalledWith('org-1', {
        name: 'Paddler',
        code: 'PADDLER',
        description: '',
        sortOrder: 0,
        jobTitleId: 'jt-2',
        workLocationId: 'wl-2',
        ...anchor,
      });
    },
  );

  it('lets a department manager edit a Position in scope, labels it from the options, and offers nothing outside', async () => {
    mocks.snapshot = scoped('DEPARTMENT', 'dept-a');
    mocks.api.getOrganization.mockRejectedValue(forbidden());
    visible({ unitList: [], departmentList: [departments.a, departments.b], teamList: [] });
    mocks.api.listPositions.mockResolvedValue([
      position(),
      position({
        id: 'pos-2',
        code: 'BK',
        name: 'Booker',
        departmentId: 'dept-b',
        jobTitleId: 'jt-gone',
      }),
    ]);
    await openPage('positions');
    // Names come from the reference options (the organization lists are empty for them).
    expect(rowFor('LG')).toHaveTextContent('Department: Programs · Guide · Dock');
    expect(rowFor('BK')).toHaveTextContent('Job title not visible');
    expect(rowFor('BK')).not.toHaveTextContent('jt-gone');
    expect(actionsIn('BK')).toEqual([]);
    expect(actionsIn('LG')).toEqual(['Edit', 'Archive']);

    fireEvent.click(within(rowFor('LG')).getByRole('button', { name: 'Edit' }));
    expect(optionLabels(screen.getByLabelText('Placement type'))).toEqual([
      'Select…',
      'Department',
    ]);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Head Guide' } });
    fireEvent.change(screen.getByLabelText('Job Title'), { target: { value: 'jt-2' } });
    save();
    await waitFor(() => expect(mocks.api.updatePosition).toHaveBeenCalledTimes(1));
    expect(mocks.api.updatePosition.mock.calls[0]![1]).toBe('pos-1');
    expect(lastUpdate()).toEqual({
      name: 'Head Guide',
      description: '',
      sortOrder: 0,
      jobTitleId: 'jt-2',
    });
  });

  it('keeps a current archived job title and an unknown work location when editing, and never offers them for new records', async () => {
    mocks.snapshot = orgAdmin();
    mocks.api.listJobTitles.mockResolvedValue([
      { ...base, id: 'jt-1', name: 'Guide', code: 'GUIDE' },
      { ...base, id: 'jt-old', name: 'Ranger', code: 'RANGER', archivedAt: '2026-10-01' },
    ]);
    mocks.api.listWorkLocations.mockResolvedValue([location('wl-1', 'Dock', 'DOCK')]);
    mocks.api.listPositions.mockResolvedValue([
      position({ jobTitleId: 'jt-old', workLocationId: 'wl-hidden' }),
    ]);
    await openPage('positions');
    expect(rowFor('LG')).toHaveTextContent('Ranger');
    expect(rowFor('LG')).toHaveTextContent('Work location not visible');

    fireEvent.click(within(rowFor('LG')).getByRole('button', { name: 'Edit' }));
    const title = screen.getByLabelText('Job Title');
    const where = screen.getByLabelText('Work Location');
    expect(title).toHaveValue('jt-old');
    expect(optionLabels(title)).toContain(
      'Ranger (RANGER) — current, unavailable for new positions',
    );
    expect(where).toHaveValue('wl-hidden');
    expect(optionLabels(where)).toContain('Current work location (unavailable for new positions)');
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Seasonal' } });
    save();
    await waitFor(() => expect(mocks.api.updatePosition).toHaveBeenCalledTimes(1));
    expect(lastUpdate()).toEqual({ name: 'Lead Guide', description: 'Seasonal', sortOrder: 0 });
    cleanup();

    await openPage('positions');
    fireEvent.click(screen.getByRole('button', { name: 'New record' }));
    expect(optionLabels(screen.getByLabelText('Job Title'))).toEqual([
      'Select…',
      'Guide (GUIDE)',
      'Instructor (INSTR)',
    ]);
    expect(optionLabels(screen.getByLabelText('Work Location'))).toEqual([
      'No work location',
      'Dock (DOCK)',
      'Lodge (LODGE)',
    ]);
  });

  it('sends an explicit work-location change, and null only when the user clears it', async () => {
    mocks.snapshot = orgAdmin();
    mocks.api.listPositions.mockResolvedValue([position()]);
    await openPage('positions');
    fireEvent.click(within(rowFor('LG')).getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Work Location'), { target: { value: 'wl-2' } });
    save();
    await waitFor(() => expect(mocks.api.updatePosition).toHaveBeenCalledTimes(1));
    expect(lastUpdate()).toMatchObject({ workLocationId: 'wl-2' });
    expect(lastUpdate()).not.toHaveProperty('jobTitleId');

    fireEvent.click(within(rowFor('LG')).getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Work Location'), { target: { value: '' } });
    save();
    await waitFor(() => expect(mocks.api.updatePosition).toHaveBeenCalledTimes(2));
    expect(lastUpdate()).toHaveProperty('workLocationId', null);
    expect(lastUpdate()).not.toHaveProperty('jobTitleId');
  });

  it('explains that no Position can be created without an active job title', async () => {
    mocks.snapshot = scoped('DEPARTMENT', 'dept-a');
    mocks.api.getOrganization.mockRejectedValue(forbidden());
    visible({ unitList: [], departmentList: [departments.a], teamList: [] });
    mocks.api.listPositionReferenceOptions.mockResolvedValue({ jobTitles: [], workLocations: [] });
    mocks.api.listPositions.mockResolvedValue([position()]);
    await openPage('positions');
    expect(screen.getByRole('status')).toHaveTextContent(
      'No active job title is available, so new Positions cannot be created yet.',
    );
    expect(screen.getByRole('button', { name: 'New record' })).toBeDisabled();
    // Editing keeps the current job title, so it stays available.
    expect(within(rowFor('LG')).getByRole('button', { name: 'Edit' })).toBeEnabled();
  });

  it('offers no Position form when the reference options are refused', async () => {
    mocks.snapshot = scoped('DEPARTMENT', 'dept-a');
    mocks.api.getOrganization.mockRejectedValue(forbidden());
    visible({ unitList: [], departmentList: [departments.a], teamList: [] });
    mocks.api.listPositionReferenceOptions.mockRejectedValue(forbidden());
    mocks.api.listPositions.mockResolvedValue([position()]);
    await openPage('positions');
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Job titles and work locations for Position forms could not be loaded: You do not have permission to perform this action.',
    );
    expect(screen.getByRole('button', { name: 'New record' })).toBeDisabled();
    const edit = within(rowFor('LG')).getByRole('button', { name: 'Edit' });
    expect(edit).toBeDisabled();
    fireEvent.click(edit);
    expect(screen.queryByLabelText('Job Title')).toBeNull();
    // The records themselves still load.
    expect(rowFor('LG')).toHaveTextContent('Lead Guide');
  });

  it('does not warn readers who cannot manage Positions about refused options', async () => {
    mocks.snapshot = grants(read('ORGANIZATION', 'org-1'));
    mocks.api.listPositionReferenceOptions.mockRejectedValue(forbidden());
    mocks.api.listPositions.mockResolvedValue([position()]);
    await openPage('positions');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(actionsIn('LG')).toEqual([]);
    expect(rowFor('LG')).toHaveTextContent('Guide');
  });

  it.each([
    [new AuthApiError('validation', 400, 'Job title is archived.'), 'Job title is archived.'],
    [forbidden(), 'You do not have permission to perform this action.'],
  ])('keeps the entered values when the API refuses the save (%#)', async (error, message) => {
    mocks.snapshot = scoped('DEPARTMENT', 'dept-a');
    mocks.api.getOrganization.mockRejectedValue(forbidden());
    visible({ unitList: [], departmentList: [departments.a], teamList: [] });
    mocks.api.createPosition.mockRejectedValue(error);
    await openPage('positions');
    fireEvent.click(screen.getByRole('button', { name: 'New record' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Paddler' } });
    fireEvent.change(screen.getByLabelText('Code'), { target: { value: 'PADDLER' } });
    fireEvent.change(screen.getByLabelText('Job Title'), { target: { value: 'jt-2' } });
    fireEvent.change(screen.getByLabelText('Placement type'), {
      target: { value: 'departments' },
    });
    fireEvent.change(screen.getByLabelText('Department'), { target: { value: 'dept-a' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Position' }));
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveValue('Paddler');
    expect(screen.getByLabelText('Code')).toHaveValue('PADDLER');
    expect(screen.getByLabelText('Job Title')).toHaveValue('jt-2');
    expect(screen.getByLabelText('Department')).toHaveValue('dept-a');
  });

  it('keeps job titles and work locations read-only for managers below the organization', async () => {
    mocks.snapshot = scoped('DEPARTMENT', 'dept-a');
    mocks.api.getOrganization.mockRejectedValue(forbidden());
    mocks.api.listJobTitles.mockResolvedValue([
      { ...base, id: 'jt-1', name: 'Guide', code: 'GUIDE' },
    ]);
    mocks.api.listWorkLocations.mockResolvedValue([location('wl-1', 'Dock', 'DOCK')]);
    await openPage('job-titles');
    expect(actionsIn('GUIDE')).toEqual([]);
    expect(screen.getByRole('button', { name: 'New record' })).toBeDisabled();
    cleanup();
    await openPage('work-locations');
    expect(actionsIn('DOCK')).toEqual([]);
    expect(screen.getByRole('button', { name: 'New record' })).toBeDisabled();
    expect(mocks.api.listPositionReferenceOptions).not.toHaveBeenCalled();
  });
});

describe('staffed Position edits (R5B)', () => {
  const staffedPosition = {
    ...base,
    id: 'pos-1',
    name: 'Lead Guide',
    code: 'LG',
    jobTitleId: 'jt-1',
    workLocationId: 'wl-1',
    organizationalUnitId: null,
    departmentId: 'dept-a',
    teamId: null,
  };
  const location = {
    ...base,
    id: 'wl-1',
    name: 'Dock',
    code: 'DOCK',
    physicalSiteId: 'site-1',
    physicalSite: null,
    timezone: 'America/Toronto',
  };

  it('renames a staffed Position as an organization admin without resending its identity', async () => {
    mocks.snapshot = grants(read('ORGANIZATION', 'org-1'), manage('ORGANIZATION', 'org-1'));
    mocks.api.listPositions.mockResolvedValue([staffedPosition]);
    mocks.api.listWorkLocations.mockResolvedValue([location]);
    mocks.api.listPositionReferenceOptions.mockResolvedValue({
      jobTitles: [{ id: 'jt-1', name: 'Guide', code: 'GUIDE' }],
      workLocations: [{ id: 'wl-1', name: 'Dock', code: 'DOCK' }],
    });
    await openPage('positions');
    fireEvent.click(within(rowFor('LG')).getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Senior Lead Guide' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(mocks.api.updatePosition).toHaveBeenCalledTimes(1));
    const [, id, body] = mocks.api.updatePosition.mock.calls[0]!;
    expect(id).toBe('pos-1');
    expect(body).toMatchObject({ name: 'Senior Lead Guide' });
    for (const field of [
      'jobTitleId',
      'workLocationId',
      'organizationalUnitId',
      'departmentId',
      'teamId',
    ])
      expect(body).not.toHaveProperty(field);
  });
});
