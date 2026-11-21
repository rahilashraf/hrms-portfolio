import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthApiError } from '../../lib/auth/types';
import { archiveRestriction, PhysicalSitesPage } from './physical-sites-page';

const mocks = vi.hoisted(() => ({
  getOrganization: vi.fn(),
  listPhysicalSites: vi.fn(),
  createPhysicalSite: vi.fn(),
  updatePhysicalSite: vi.fn(),
  archivePhysicalSite: vi.fn(),
  reactivatePhysicalSite: vi.fn(),
  can: vi.fn(),
}));
vi.mock('../../lib/organization/api', () => ({ organizationApi: mocks }));
vi.mock('../../providers/auth-provider', () => ({ useAuth: () => ({ can: mocks.can }) }));

const site = (overrides: Record<string, unknown> = {}) => ({
  id: 'site-1',
  organizationId: 'org-1',
  name: 'Main campus',
  addressLine1: '1 Main St',
  addressLine2: null,
  city: 'Toronto',
  stateProvince: null,
  postalCode: null,
  country: null,
  archivedAt: null,
  createdAt: '',
  updatedAt: '',
  activeWorkLocations: 0,
  activeDevices: 0,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getOrganization.mockResolvedValue({ id: 'org-1', name: 'Acme', archivedAt: null });
  mocks.can.mockReturnValue(true);
});
afterEach(cleanup);

describe('PhysicalSitesPage', () => {
  it('lists sites, explains archive restrictions, and archives an unused site after confirmation', async () => {
    mocks.listPhysicalSites.mockResolvedValue({
      items: [
        site(),
        site({ id: 'site-2', name: 'Annex', activeWorkLocations: 2, activeDevices: 1 }),
      ],
    });
    mocks.archivePhysicalSite.mockResolvedValue(site({ archivedAt: '2026-11-04' }));
    render(<PhysicalSitesPage organizationId="org-1" />);
    const list = await screen.findByRole('list', { name: 'Physical sites' });
    const annex = within(list).getByText('Annex').closest('li')!;
    expect(within(annex).getByRole('button', { name: 'Archive' })).toBeDisabled();
    expect(annex).toHaveTextContent(
      'In use by 2 work locations and 1 active kiosk device. Move or archive them before archiving this site.',
    );
    const main = within(list).getByText('Main campus').closest('li')!;
    fireEvent.click(within(main).getByRole('button', { name: 'Archive' }));
    expect(mocks.archivePhysicalSite).not.toHaveBeenCalled();
    fireEvent.click(
      within(screen.getByRole('dialog', { name: 'Archive Main campus?' })).getByRole('button', {
        name: 'Archive site',
      }),
    );
    await waitFor(() => expect(mocks.archivePhysicalSite).toHaveBeenCalledWith('org-1', 'site-1'));
    expect(await screen.findByText('Main campus archived.')).toBeInTheDocument();
  });

  it('creates and renames with domain errors explained, and reactivates archived sites', async () => {
    mocks.listPhysicalSites.mockResolvedValue({
      items: [site(), site({ id: 'site-3', name: 'Old depot', archivedAt: '2026-01-01' })],
    });
    mocks.createPhysicalSite
      .mockRejectedValueOnce(
        new AuthApiError('conflict', 409, 'taken', { code: 'PHYSICAL_SITE_NAME_TAKEN' }),
      )
      .mockResolvedValueOnce(site({ id: 'site-4', name: 'North' }));
    mocks.reactivatePhysicalSite.mockResolvedValue(site({ id: 'site-3' }));
    render(<PhysicalSitesPage organizationId="org-1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add physical site' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add site' }));
    expect(await screen.findByText('Enter the site name.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: ' North ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add site' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/already has this name/);
    fireEvent.click(screen.getByRole('button', { name: 'Add site' }));
    await waitFor(() =>
      expect(mocks.createPhysicalSite).toHaveBeenLastCalledWith(
        'org-1',
        expect.objectContaining({ name: 'North', city: null }),
      ),
    );
    expect(await screen.findByText('North added.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reactivate' }));
    await waitFor(() =>
      expect(mocks.reactivatePhysicalSite).toHaveBeenCalledWith('org-1', 'site-3'),
    );
  });

  it('is read-only without organization.manage, and reports load errors with retry', async () => {
    mocks.can.mockReturnValue(false);
    mocks.listPhysicalSites
      .mockRejectedValueOnce(new AuthApiError('unexpected', 503))
      .mockResolvedValueOnce({ items: [site()] });
    render(<PhysicalSitesPage organizationId="org-1" />);
    const error = await screen.findByRole('alert');
    fireEvent.click(within(error).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Main campus')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add physical site' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Archive' })).not.toBeInTheDocument();
    expect(mocks.can).toHaveBeenCalledWith('organization.manage', {
      type: 'ORGANIZATION',
      id: 'org-1',
    });
  });

  it('describes restrictions exactly', () => {
    expect(archiveRestriction({ activeWorkLocations: 0, activeDevices: 0 })).toBeNull();
    expect(archiveRestriction({ activeWorkLocations: 1, activeDevices: 0 })).toBe(
      'In use by 1 work location. Move or archive them before archiving this site.',
    );
  });
});
