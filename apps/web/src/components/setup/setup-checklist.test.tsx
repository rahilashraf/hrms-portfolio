import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthApiError } from '../../lib/auth/types';
import { parseSetupChecklist } from '../../lib/setup/api';
import { SetupChecklist, canSeeSetup } from './setup-checklist';

const apiRequest = vi.hoisted(() => vi.fn());
vi.mock('../../lib/auth/api-client', () => ({ apiRequest }));

const STEPS = {
  organizationId: 'org-1',
  steps: [
    {
      key: 'company',
      label: 'Company details',
      description: 'Set the time zone.',
      complete: true,
      optional: false,
      href: '/admin/settings/company',
      detail: null,
    },
    {
      key: 'branding',
      label: 'Branding',
      description: 'Add your logo and colors.',
      complete: false,
      optional: true,
      href: '/admin/settings/branding',
      detail: null,
    },
    {
      key: 'structure',
      label: 'Organization structure',
      description: 'Business units, departments, teams and locations.',
      complete: false,
      optional: false,
      href: '/admin/organizations/org-1',
      detail: '2 units, 1 department, 0 teams, 2 locations, 3 positions',
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  apiRequest.mockResolvedValue(STEPS);
});
afterEach(cleanup);

const step = (key: string) => document.querySelector(`[data-step="${key}"]`) as HTMLElement;

describe('SetupChecklist', () => {
  it('shows complete/incomplete state from the API only, optional steps and fix links', async () => {
    render(<SetupChecklist organizationId="org-1" userId="user-1" />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading setup checklist…');
    expect(await screen.findByText('1 of 2 required steps complete.')).toBeInTheDocument();
    expect(apiRequest).toHaveBeenCalledWith('/organizations/org-1/setup');
    expect(step('company')).toHaveAttribute('data-complete', 'true');
    expect(within(step('company')).getByText('(complete)')).toBeInTheDocument();
    expect(within(step('company')).queryByRole('link')).not.toBeInTheDocument();
    expect(step('structure')).toHaveAttribute('data-complete', 'false');
    expect(within(step('structure')).getByRole('link', { name: /Fix/ })).toHaveAttribute(
      'href',
      '/admin/organizations/org-1',
    );
    expect(within(step('structure')).getByText(/2 units, 1 department/)).toBeInTheDocument();
    expect(within(step('branding')).getByText('Optional')).toBeInTheDocument();
    // Only optional steps can be skipped.
    expect(
      within(step('structure')).queryByRole('button', { name: /Skip/ }),
    ).not.toBeInTheDocument();
  });

  it('skips optional steps and hides the card per user and organization (guide, never block)', async () => {
    const { unmount } = render(<SetupChecklist organizationId="org-1" userId="user-1" />);
    await screen.findByText('1 of 2 required steps complete.');
    fireEvent.click(within(step('branding')).getByRole('button', { name: /Skip for now/ }));
    expect(within(step('branding')).getByText('Skipped')).toBeInTheDocument();
    expect(window.localStorage.getItem('hrms.setup.skipped.user-1.org-1')).toBe('["branding"]');

    fireEvent.click(screen.getByRole('button', { name: 'Hide for now' }));
    expect(screen.getByText('The setup checklist is hidden for now.')).toBeInTheDocument();
    expect(window.localStorage.getItem('hrms.setup.hidden.user-1.org-1')).toBe('1');
    unmount();

    // Remembered for this user and organization only.
    render(<SetupChecklist organizationId="org-1" userId="user-1" />);
    expect(screen.getByRole('button', { name: 'Show setup checklist' })).toBeInTheDocument();
    cleanup();
    render(<SetupChecklist organizationId="org-1" userId="user-2" />);
    expect(await screen.findByText('1 of 2 required steps complete.')).toBeInTheDocument();
    cleanup();

    render(<SetupChecklist organizationId="org-1" userId="user-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Show setup checklist' }));
    expect(await screen.findByText('1 of 2 required steps complete.')).toBeInTheDocument();
    expect(within(step('branding')).getByText('Skipped')).toBeInTheDocument();
  });

  it('is not shown when the API refuses, and offers a retry on failure', async () => {
    apiRequest.mockRejectedValueOnce(new AuthApiError('forbidden', 403));
    const { container } = render(<SetupChecklist organizationId="org-1" userId="user-1" />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
    cleanup();

    apiRequest.mockRejectedValueOnce(new AuthApiError('service-unavailable', 503));
    render(<SetupChecklist organizationId="org-1" userId="user-1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('1 of 2 required steps complete.')).toBeInTheDocument();
  });

  it('announces when every required step is complete; the full variant cannot be hidden', async () => {
    apiRequest.mockResolvedValue({
      ...STEPS,
      steps: STEPS.steps.map((item) => ({ ...item, complete: !item.optional })),
    });
    render(<SetupChecklist organizationId="org-1" userId="user-1" variant="full" />);
    expect(await screen.findByText('All required steps are complete.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Hide for now' })).not.toBeInTheDocument();
  });

  it('parses defensively and gates visibility on organization.read/manage', () => {
    expect(() => parseSetupChecklist({})).toThrow();
    expect(
      parseSetupChecklist({
        steps: [
          { key: 'x', label: 'X', complete: 'yes' },
          { ...STEPS.steps[0], href: 'https://evil.example.com' },
        ],
      }).steps,
    ).toEqual([{ ...STEPS.steps[0], href: '/dashboard' }]);
    expect(canSeeSetup(new Set(['organization.read']))).toBe(true);
    expect(canSeeSetup(new Set(['organization.manage']))).toBe(true);
    expect(canSeeSetup(new Set(['employee.read']))).toBe(false);
  });
});
