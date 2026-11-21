import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { expectNoAxeViolations } from '../../test/axe';
import { AssignmentsPage, RoleDetailPage, RolesPage } from './access-control';

const useAuth = vi.hoisted(() => vi.fn());
const authorizationApi = vi.hoisted(() => ({
  roles: vi.fn().mockResolvedValue([]),
  permissions: vi.fn().mockResolvedValue([]),
  role: vi.fn().mockResolvedValue({
    id: 'role-1',
    organizationId: 'org-1',
    code: 'teacher',
    name: 'Teacher',
    description: null,
    isSystemOwner: false,
    archivedAt: null,
  }),
  assignments: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
  roleTemplates: vi.fn().mockResolvedValue([]),
  createRole: vi.fn(),
  archive: vi.fn(),
  reactivate: vi.fn(),
  updateRole: vi.fn(),
  replacePermissions: vi.fn(),
}));
const organizationApi = vi.hoisted(() => ({
  listOrganizations: vi.fn().mockResolvedValue([]),
  listUnits: vi.fn().mockResolvedValue([]),
  listDepartments: vi.fn().mockResolvedValue([]),
  listTeams: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../providers/auth-provider', () => ({ useAuth }));
vi.mock('../../lib/authorization/api', () => ({ authorizationApi }));
vi.mock('../../lib/organization/api', () => ({ organizationApi }));

describe('Access Control authorization boundaries', () => {
  afterEach(cleanup);

  it('denies the roles route without role.read', () => {
    useAuth.mockReturnValue({
      can: vi.fn((permission: string) => permission === 'organization.read'),
      authorization: {
        permissions: [{ key: 'organization.read', scopes: [{ type: 'SYSTEM' }] }],
      },
    });
    render(<RolesPage />);
    expect(screen.getByRole('heading', { name: 'Access denied' })).toBeInTheDocument();
  });

  it('shows roles read-only when role.manage is absent', async () => {
    useAuth.mockReturnValue({
      can: vi.fn((permission: string) => permission === 'role.read'),
      authorization: {
        permissions: [{ key: 'role.read', scopes: [{ type: 'ORGANIZATION', id: 'org-1' }] }],
      },
    });
    render(<RolesPage />);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Roles' })).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Create role' })).not.toBeInTheDocument();
  });

  it('requires both role.read and role.assign for the assignments page', async () => {
    useAuth.mockReturnValue({
      can: vi.fn((permission: string) => permission === 'role.read'),
      authorization: {
        permissions: [{ key: 'role.read', scopes: [{ type: 'ORGANIZATION', id: 'org-1' }] }],
      },
    });
    render(<AssignmentsPage roleId="role-1" />);
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Access denied' })).toBeInTheDocument(),
    );
  });

  it('explains which people the user search can find', async () => {
    useAuth.mockReturnValue({
      can: vi.fn(
        (permission: string) => permission === 'role.read' || permission === 'role.assign',
      ),
      authorization: {
        permissions: [
          { key: 'role.read', scopes: [{ type: 'ORGANIZATION', id: 'org-1' }] },
          { key: 'role.assign', scopes: [{ type: 'ORGANIZATION', id: 'org-1' }] },
        ],
      },
    });
    render(<AssignmentsPage roleId="role-1" />);
    expect(
      await screen.findByRole('combobox', {
        name: /^Find user \(name, email or employee number\)/,
      }),
    ).toHaveAccessibleDescription(
      'Lists people who work in, or hold a role in, an organization where you manage access.',
    );
  });
});

const PERMISSIONS = [
  {
    id: 'p1',
    key: 'employee.read',
    name: 'employee.read',
    description: 'See employee records.',
    isActive: true,
    area: 'People',
    label: 'View employees',
  },
  {
    id: 'p2',
    key: 'employee.manage',
    name: 'employee.manage',
    description: 'Change employee records.',
    isActive: true,
    area: 'People',
    label: 'Manage employees',
  },
  {
    id: 'p3',
    key: 'leave.approve',
    name: 'leave.approve',
    description: 'Approve leave.',
    isActive: true,
    area: 'Leave',
    label: 'Approve leave',
  },
  {
    id: 'p4',
    key: 'audit.read',
    name: 'audit.read',
    description: null,
    isActive: true,
    area: 'Administration',
    label: 'View audit trail',
  },
];

const TEMPLATES = [
  {
    key: 'MANAGER',
    name: 'Manager',
    description: 'Team operations.',
    permissions: ['employee.read', 'leave.approve', 'audit.read'],
    missingPermissions: ['audit.read'],
  },
  {
    key: 'SYSTEM_OWNER',
    name: 'System Owner',
    description: 'never a template',
    permissions: ['employee.read'],
    missingPermissions: [],
  },
];

function manager() {
  useAuth.mockReturnValue({
    can: vi.fn(() => true),
    authorization: {
      permissions: [
        { key: 'role.read', scopes: [{ type: 'ORGANIZATION', id: 'org-1' }] },
        { key: 'role.manage', scopes: [{ type: 'ORGANIZATION', id: 'org-1' }] },
      ],
    },
  });
  organizationApi.listOrganizations.mockResolvedValue([{ id: 'org-1', name: 'Northwind' }]);
  authorizationApi.permissions.mockResolvedValue(PERMISSIONS);
  authorizationApi.roleTemplates.mockResolvedValue(TEMPLATES);
}

describe('Role templates', () => {
  afterEach(cleanup);

  it('pre-populates from a template, disables what the caller cannot grant, and stays customizable', async () => {
    manager();
    authorizationApi.roles.mockResolvedValue([]);
    authorizationApi.createRole.mockResolvedValue({ id: 'role-9', name: 'Team lead' });
    render(<RolesPage />);
    fireEvent.change(await screen.findByLabelText('Organization'), { target: { value: 'org-1' } });
    const picker = await screen.findByLabelText('Start from a template (optional)');
    await waitFor(() => expect(authorizationApi.roleTemplates).toHaveBeenCalledWith('org-1'));
    // The reserved System Owner is never offered as a template.
    expect(within(picker).queryByRole('option', { name: 'System Owner' })).not.toBeInTheDocument();
    fireEvent.change(picker, { target: { value: 'MANAGER' } });
    expect(
      screen.getByText(
        'Pre-selected 2 of 3 permissions. Adjust them below before creating the role.',
      ),
    ).toBeInTheDocument();

    // Grouped by area with labels; raw keys only as secondary text.
    expect(screen.getByRole('group', { name: 'People' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Leave' })).toBeInTheDocument();
    const view = screen.getByRole('checkbox', { name: /View employees/ });
    expect(view).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Approve leave/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Manage employees/ })).not.toBeChecked();
    const audit = screen.getByRole('checkbox', { name: /View audit trail/ });
    expect(audit).toBeDisabled();
    expect(audit).not.toBeChecked();
    expect(screen.getByText("You can't grant this permission.")).toBeInTheDocument();

    // Customize before saving.
    fireEvent.click(screen.getByRole('checkbox', { name: /Manage employees/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Approve leave/ }));
    fireEvent.change(screen.getByLabelText(/^Code/), { target: { value: 'TEAM_LEAD' } });
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Team lead' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create role' }));
    await waitFor(() =>
      expect(authorizationApi.createRole).toHaveBeenCalledWith('org-1', {
        code: 'TEAM_LEAD',
        name: 'Team lead',
        description: '',
        permissionKeys: ['employee.read', 'employee.manage'],
      }),
    );
    expect(await screen.findByText(/Role Team lead created/)).toBeInTheDocument();
  });

  it('validates the role fields on the field before calling the API', async () => {
    manager();
    authorizationApi.createRole.mockClear();
    authorizationApi.roles.mockResolvedValue([]);
    const { container } = render(<RolesPage />);
    fireEvent.change(await screen.findByLabelText('Organization'), { target: { value: 'org-1' } });
    const form = await screen.findByRole('form', { name: 'Create role' });
    fireEvent.change(within(form).getByLabelText(/^Code/), { target: { value: 'team lead' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Create role' }));
    expect(await within(form).findByText('Use only letters, digits, - and _.')).toBeInTheDocument();
    expect(within(form).getByText('Enter a name.')).toBeInTheDocument();
    expect(within(form).getByLabelText(/^Code/)).toHaveAttribute('aria-invalid', 'true');
    expect(authorizationApi.createRole).not.toHaveBeenCalled();
    await expectNoAxeViolations(container);
  });

  it('shows the reserved System Owner role as protected and not editable', async () => {
    manager();
    authorizationApi.roles.mockResolvedValue([
      {
        id: 'owner',
        organizationId: null,
        code: 'SYSTEM_OWNER',
        name: 'System Owner',
        description: null,
        isSystemOwner: true,
        archivedAt: null,
      },
    ]);
    render(<RolesPage />);
    fireEvent.change(await screen.findByLabelText('Organization'), { target: { value: 'org-1' } });
    expect(await screen.findByText('Protected')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'System Owner' })).not.toBeInTheDocument();
    cleanup();

    authorizationApi.role.mockResolvedValueOnce({
      id: 'owner',
      organizationId: 'org-1',
      code: 'SYSTEM_OWNER',
      name: 'System Owner',
      description: null,
      isSystemOwner: true,
      archivedAt: null,
      permissions: [{ permissionId: 'p1', permission: PERMISSIONS[0] }],
    });
    render(<RoleDetailPage roleId="owner" />);
    expect(await screen.findByText(/reserved System Owner role/)).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toBeDisabled();
    await waitFor(() =>
      expect(screen.getByRole('checkbox', { name: /View employees/ })).toBeDisabled(),
    );
    expect(screen.queryByRole('button', { name: 'Archive role' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save permissions' })).not.toBeInTheDocument();
  });

  it('archives a role only after the shared confirmation dialog', async () => {
    manager();
    const role = {
      id: 'role-1',
      organizationId: 'org-1',
      code: 'teacher',
      name: 'Teacher',
      description: null,
      isSystemOwner: false,
      archivedAt: null,
      permissions: [],
    };
    authorizationApi.role.mockResolvedValue(role);
    authorizationApi.archive.mockResolvedValue(undefined);
    render(<RoleDetailPage roleId="role-1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Archive role' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Archive role Teacher?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(authorizationApi.archive).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Archive role' }));
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Archive role' }),
    );
    await waitFor(() => expect(authorizationApi.archive).toHaveBeenCalledWith('role-1'));
  });
});
