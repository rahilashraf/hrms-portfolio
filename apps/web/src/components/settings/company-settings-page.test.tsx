import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { navContextFromWorkspace } from '../../lib/navigation/context';
import { ORGANIZATION_MODULES, type Workspace } from '../../lib/workspace/types';
import { CompanySettingsPage } from './company-settings-page';

const apiRequest = vi.hoisted(() => vi.fn());
vi.mock('../../lib/auth/api-client', () => ({ apiRequest }));
const organizationApi = vi.hoisted(() => ({ getOrganization: vi.fn() }));
vi.mock('../../lib/organization/api', () => ({ organizationApi }));
const value = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('../../providers/workspace-provider', () => ({
  useWorkspace: () => value.current,
  useOptionalWorkspace: () => value.current,
}));

function setWorkspace(permissions: string[], modules = [...ORGANIZATION_MODULES]) {
  const workspace: Workspace = {
    user: { id: 'user-1', email: 'ada@example.com', displayName: 'Ada Lovelace' },
    systemPermissions: [],
    organizations: [
      {
        id: 'org-1',
        name: 'Northwind Academy',
        code: 'NWA',
        timezone: null,
        branding: null,
        enabledModules: modules,
        permissions,
        isEmployee: false,
        isManager: false,
      },
    ],
  };
  value.current = {
    status: 'ready',
    workspace,
    selectedOrganization: workspace.organizations[0],
    navContext: navContextFromWorkspace(workspace, workspace.organizations[0]!),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  organizationApi.getOrganization.mockResolvedValue({
    id: 'org-1',
    name: 'Northwind Academy',
    code: 'NWA',
    description: 'Summer camps',
    timezone: null,
  });
  apiRequest.mockResolvedValue({ organizationId: 'org-1', steps: [] });
});
afterEach(cleanup);

const settingsLinks = () =>
  within(screen.getByRole('heading', { name: 'Settings' }).parentElement!)
    .getAllByRole('link')
    .map((link) => link.getAttribute('href'));

describe('CompanySettingsPage', () => {
  it('links organization details and only the settings areas the registry shows', async () => {
    setWorkspace([
      'organization.read',
      'organization.manage',
      'organization.branding.manage',
      'feature.read',
      'audit.read',
    ]);
    render(<CompanySettingsPage />);
    expect(screen.getByRole('heading', { name: 'Company Settings' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Edit organization details' })).toHaveAttribute(
      'href',
      '/admin/organizations/org-1',
    );
    expect(await screen.findByText('Summer camps')).toBeInTheDocument();
    expect(screen.getByText(/Not set/)).toBeInTheDocument();
    expect(settingsLinks()).toEqual([
      '/admin/settings/branding',
      '/admin/settings',
      '/admin/audit',
    ]);
    // The setup checklist is part of the hub.
    expect(
      await screen.findByRole('heading', { name: 'Set up your organization' }),
    ).toBeInTheDocument();
    expect(apiRequest).toHaveBeenCalledWith('/organizations/org-1/setup');
  });

  it('respects modules: integrations and notification settings need their module', async () => {
    setWorkspace(
      [
        'organization.manage',
        'notification.settings.manage',
        'integration.google.manage',
        'role.read',
        'role.assign',
      ],
      ORGANIZATION_MODULES.filter((module) => module !== 'GOOGLE_WORKSPACE'),
    );
    render(<CompanySettingsPage />);
    expect(settingsLinks()).toEqual([
      '/admin/notifications',
      '/admin/access-control/roles',
      '/admin/access-control/assignments',
    ]);
    // organization.read is not held: no organization page link.
    expect(
      screen.queryByRole('link', { name: 'Edit organization details' }),
    ).not.toBeInTheDocument();
  });

  it('is refused without organization.read or organization.manage', () => {
    setWorkspace(['feature.read']);
    render(<CompanySettingsPage />);
    expect(screen.getByRole('heading', { name: 'Access denied' })).toBeInTheDocument();
  });
});
