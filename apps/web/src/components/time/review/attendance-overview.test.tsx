import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthApiError } from '../../../lib/auth/types';
import { expectNoAxeViolations } from '../../../test/axe';
import { AttendanceOverview } from './attendance-overview';
import { FormDialog } from './entry-dialogs';
import type { ReviewOrganization } from './review-shared';

const mocks = vi.hoisted(() => ({
  managementCurrent: vi.fn(),
  managementExceptions: vi.fn(),
  managementCorrections: vi.fn(),
  managementTimesheets: vi.fn(),
  managementEntries: vi.fn(),
}));

vi.mock('../../../lib/time/api', () => ({ timeApi: mocks }));

const empty = { items: [], nextAfterId: null };

const organization: ReviewOrganization = {
  id: 'org-1',
  name: 'Example Organization',
  code: 'EX',
  timezone: 'America/Toronto',
  workLocations: [],
  physicalSites: [],
  actions: {
    canViewSignIns: false,
    canCorrectSignIns: false,
    canManageDevices: false,
    canManagePolicies: false,
    canManagePins: false,
    canViewAttendance: true,
    canCorrectTime: false,
    canReviewExceptions: true,
    canReviewCorrections: true,
    canApproveTimesheets: true,
    canManageTimesheets: false,
    canManagePeriods: false,
  },
};

function metric(title: string) {
  const totals = screen.getByRole('region', { name: 'Attendance totals' });
  return within(totals).getByText(title).parentElement!;
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.managementCurrent.mockResolvedValue(empty);
  mocks.managementExceptions.mockResolvedValue(empty);
  mocks.managementEntries.mockResolvedValue(empty);
  mocks.managementCorrections.mockResolvedValue({
    items: [{ id: 'c-1' }, { id: 'c-2' }],
    nextAfterId: null,
  });
  mocks.managementTimesheets.mockResolvedValue({
    items: [{ segments: [{ status: 'PENDING' }, { status: 'APPROVED' }] }],
    nextAfterId: null,
  });
});

afterEach(cleanup);

describe('AttendanceOverview totals', () => {
  it('marks only the failed total unavailable and retries the totals', async () => {
    mocks.managementCorrections.mockRejectedValueOnce(new AuthApiError('service-unavailable', 503));
    const { container } = render(
      <AttendanceOverview organization={organization} onNavigate={vi.fn()} />,
    );

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/could not|unavailable/i);
    expect(metric('Pending corrections')).toHaveTextContent('Unavailable');
    // The other totals still show.
    expect(metric('Timesheet approvals')).toHaveTextContent('1');
    expect(metric('Currently clocked in')).toHaveTextContent('0');
    expect(metric('Open exceptions')).toHaveTextContent('0');
    await expectNoAxeViolations(container);

    fireEvent.click(within(alert).getByRole('button', { name: 'Retry totals' }));
    await waitFor(() => expect(metric('Pending corrections')).toHaveTextContent('2'));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(mocks.managementCorrections).toHaveBeenCalledTimes(2);
  });
});

describe('FormDialog', () => {
  it('moves focus into a dialog that has no field (its heading)', () => {
    render(
      <FormDialog
        open
        title="Confirm the change"
        submitLabel="Save"
        busy={false}
        canSubmit
        error={null}
        onSubmit={vi.fn()}
        onClose={vi.fn()}
      >
        <p>Nothing to fill in.</p>
      </FormDialog>,
    );
    expect(screen.getByRole('heading', { name: 'Confirm the change' })).toHaveFocus();
  });
});
