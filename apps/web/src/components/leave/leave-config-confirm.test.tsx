import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LeaveTypesPanel } from './leave-config-panels';
import type { LeaveOrganization } from '../../lib/leave/types';

const mocks = vi.hoisted(() => ({ types: vi.fn(), archiveType: vi.fn() }));
vi.mock('../../lib/leave/api', () => ({ leaveApi: mocks }));

const organization = {
  id: 'org-1',
  name: 'Camp',
  timezone: 'America/Toronto',
  actions: { canManageTypes: true },
  holidayScopes: [],
} as unknown as LeaveOrganization;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.types.mockResolvedValue({
    items: [
      {
        id: 'type-vac',
        code: 'VAC',
        name: 'Vacation',
        classification: 'PAID',
        tracksBalance: true,
        displayUnit: 'HOURS',
        organizationId: 'org-1',
        description: null,
        archivedAt: null,
        actions: { canEdit: true, canArchive: true },
      },
    ],
  });
  mocks.archiveType.mockResolvedValue({});
});
afterEach(cleanup);

describe('leave configuration confirmations', () => {
  it('archives a leave type only after the shared ConfirmDialog', async () => {
    const native = vi.spyOn(window, 'confirm');
    render(<LeaveTypesPanel organization={organization} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Archive' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Archive Vacation?' });
    expect(dialog).toHaveTextContent('Existing requests and balances are kept.');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(mocks.archiveType).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Archive leave type',
      }),
    );
    await waitFor(() => expect(mocks.archiveType).toHaveBeenCalledWith('type-vac'));
    expect(native).not.toHaveBeenCalled();
  });
});
