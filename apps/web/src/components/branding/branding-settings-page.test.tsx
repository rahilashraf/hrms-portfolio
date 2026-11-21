import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthApiError } from '../../lib/auth/types';
import type { BrandingView } from '../../lib/branding/types';
import { BrandingSettingsPage } from './branding-settings-page';

const api = vi.hoisted(() => ({ get: vi.fn(), update: vi.fn() }));
vi.mock('../../lib/branding/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/branding/api')>()),
  brandingApi: api,
}));
const workspace = vi.hoisted(() => ({ value: null as unknown }));
vi.mock('../../providers/workspace-provider', () => ({
  useWorkspace: () => workspace.value,
  useOptionalWorkspace: () => workspace.value,
}));

const refresh = vi.fn(async () => undefined);
function setWorkspace(permissions: string[]) {
  workspace.value = {
    status: 'ready',
    refresh,
    selectedOrganization: {
      id: 'org-1',
      name: 'Northwind Academy',
      code: 'NWA',
      timezone: 'America/Toronto',
      branding: null,
      enabledModules: [],
      permissions,
      isEmployee: false,
      isManager: false,
    },
    navContext: {
      mode: 'workspace',
      permissions: new Set(permissions),
      enabledModules: new Set(),
      organizationId: 'org-1',
      isEmployee: false,
    },
  };
}

const view = (overrides: Partial<BrandingView> = {}): BrandingView => ({
  organizationId: 'org-1',
  displayName: 'Northwind',
  shortName: 'NW',
  logoUrl: 'https://cdn.example.com/logo.png',
  iconUrl: null,
  loginLogoUrl: null,
  primaryColor: '#0F766E',
  secondaryColor: null,
  loginSubtitle: null,
  websiteUrl: null,
  supportEmail: null,
  publicLoginEnabled: false,
  version: 2,
  updatedAt: '2026-10-01T00:00:00Z',
  updatedByUserId: 'user-1',
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  setWorkspace(['organization.read', 'organization.branding.manage']);
  api.get.mockResolvedValue(view());
});
afterEach(cleanup);

describe('BrandingSettingsPage', () => {
  it('loads branding, validates https/colors client-side and saves with the expected version', async () => {
    api.update.mockResolvedValue(view({ displayName: 'Northwind Academy', version: 3 }));
    render(<BrandingSettingsPage />);
    const displayName = await screen.findByLabelText('Display name');
    expect(displayName).toHaveValue('Northwind');
    expect(
      screen.getByText(/Lets the sign-in page show this branding before anyone signs in/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Only\s+presentation fields are public/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Logo URL'), {
      target: { value: 'http://insecure.example.com/logo.png' },
    });
    fireEvent.change(screen.getByLabelText('Primary color (hex)'), { target: { value: '#12' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save branding' }));
    expect(
      await screen.findByText('Logo URL must be an absolute https:// address.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Primary color must be a #RRGGBB color.')).toBeInTheDocument();
    expect(screen.getByLabelText('Logo URL')).toHaveAttribute('aria-invalid', 'true');
    expect(api.update).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('Logo URL'), {
      target: { value: 'https://cdn.example.com/new.png' },
    });
    fireEvent.change(screen.getByLabelText('Primary color (hex)'), {
      target: { value: '#1d4ed8' },
    });
    fireEvent.change(displayName, { target: { value: ' Northwind Academy ' } });
    fireEvent.click(screen.getByLabelText(/Show this branding on the sign-in page/));
    fireEvent.click(screen.getByRole('button', { name: 'Save branding' }));
    await waitFor(() =>
      expect(api.update).toHaveBeenCalledWith('org-1', {
        displayName: 'Northwind Academy',
        shortName: 'NW',
        logoUrl: 'https://cdn.example.com/new.png',
        iconUrl: null,
        loginLogoUrl: null,
        primaryColor: '#1D4ED8',
        secondaryColor: null,
        loginSubtitle: null,
        websiteUrl: null,
        supportEmail: null,
        publicLoginEnabled: true,
        expectedVersion: 2,
      }),
    );
    expect(await screen.findByRole('status', { name: '' })).toHaveTextContent('Branding saved.');
    expect(refresh).toHaveBeenCalled();
  });

  it('reloads the latest branding with a message on a version conflict (409)', async () => {
    api.get
      .mockResolvedValueOnce(view())
      .mockResolvedValueOnce(view({ displayName: 'Changed elsewhere', version: 5 }));
    api.update
      .mockRejectedValueOnce(
        new AuthApiError('conflict', 409, 'stale', {
          code: 'BRANDING_VERSION_CONFLICT',
          currentVersion: 5,
        }),
      )
      .mockResolvedValueOnce(view({ version: 6 }));
    render(<BrandingSettingsPage />);
    fireEvent.change(await screen.findByLabelText('Display name'), { target: { value: 'Mine' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save branding' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Someone else changed this branding while you were editing',
    );
    expect(screen.getByLabelText('Display name')).toHaveValue('Changed elsewhere');
    fireEvent.click(screen.getByRole('button', { name: 'Save branding' }));
    await waitFor(() =>
      expect(api.update).toHaveBeenLastCalledWith(
        'org-1',
        expect.objectContaining({ displayName: 'Changed elsewhere', expectedVersion: 5 }),
      ),
    );
  });

  it('shows an API field refusal on that field', async () => {
    api.update.mockRejectedValueOnce(
      new AuthApiError('validation', 400, 'websiteUrl must be an absolute https URL.', {
        code: 'BRANDING_INVALID',
        field: 'websiteUrl',
      }),
    );
    render(<BrandingSettingsPage />);
    await screen.findByLabelText('Display name');
    fireEvent.click(screen.getByRole('button', { name: 'Save branding' }));
    await waitFor(() =>
      expect(screen.getByLabelText('Website')).toHaveAttribute('aria-invalid', 'true'),
    );
  });

  it('is read-only without organization.branding.manage in the selected organization', async () => {
    setWorkspace(['organization.read']);
    render(<BrandingSettingsPage />);
    const displayName = await screen.findByLabelText('Display name');
    expect(displayName).toBeDisabled();
    expect(screen.getByLabelText('Logo URL')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save branding' })).not.toBeInTheDocument();
    expect(screen.getByRole('note')).toHaveTextContent('Manage branding');
  });

  it('previews images only from https URLs, with alt text and no referrer', async () => {
    render(<BrandingSettingsPage />);
    await screen.findByLabelText('Display name');
    const preview = screen.getByRole('region', { name: 'Preview' });
    const logo = within(preview).getByAltText('Northwind logo');
    expect(logo).toHaveAttribute('src', 'https://cdn.example.com/logo.png');
    expect(logo).toHaveAttribute('referrerpolicy', 'no-referrer');
    fireEvent.change(screen.getByLabelText('Logo URL'), {
      target: { value: 'javascript:alert(1)' },
    });
    expect(within(preview).queryByAltText('Northwind logo')).not.toBeInTheDocument();
    expect(within(preview).queryAllByRole('img')).toHaveLength(0);
  });

  it('warns and keeps the default accent when the primary color has poor contrast', async () => {
    render(<BrandingSettingsPage />);
    fireEvent.change(await screen.findByLabelText('Primary color (hex)'), {
      target: { value: '#777777' },
    });
    expect(screen.getByText(/does not keep readable contrast/)).toBeInTheDocument();
  });

  it('shows access denied when the API refuses (403)', async () => {
    api.get.mockRejectedValueOnce(new AuthApiError('forbidden', 403));
    render(<BrandingSettingsPage />);
    expect(await screen.findByRole('heading', { name: 'Access denied' })).toBeInTheDocument();
  });
});
