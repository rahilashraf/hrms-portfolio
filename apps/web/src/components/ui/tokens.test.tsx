import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import * as compensationShared from '../compensation/compensation-shared';
import * as googleShared from '../google-workspace/google-workspace-shared';
import * as leaveShared from '../leave/leave-shared';
import { ErrorBanner, FeedbackMessage, LoadingState } from '../organization/shared';
import * as reportingShared from '../reporting/reporting-shared';
import { buttonClass } from './button';
import { InlineMessage } from './inline-message';
import { EmptyState, LoadingText } from './states';
import { badgeClass, dangerButton, inputClass, primaryButton, secondaryButton } from './tokens';

afterEach(cleanup);

describe('Batch 3A shared tokens', () => {
  it('derives the module button styles from buttonClass, with branding on primary', () => {
    expect(primaryButton).toBe(buttonClass('primary'));
    expect(primaryButton).toContain('bg-[var(--hrms-accent)]');
    expect(secondaryButton).toBe(buttonClass('secondary'));
    expect(dangerButton).toBe(buttonClass('danger'));
    expect(dangerButton).toContain('border-rose-300');
    expect(inputClass).toContain('aria-[invalid=true]:border-rose-600');
    // Batch 10F: a visible, consistent focus ring on every input.
    expect(inputClass).toContain('focus:ring-2');
    expect(inputClass).toContain('focus:ring-[var(--hrms-accent-text)]');
  });

  it('is what the modules that defined their own copies now re-export', () => {
    for (const shared of [compensationShared, leaveShared]) {
      expect(shared.inputClass).toBe(inputClass);
      expect(shared.primaryButton).toBe(primaryButton);
      expect(shared.secondaryButton).toBe(secondaryButton);
      expect(shared.EmptyState).toBe(EmptyState);
    }
    expect(leaveShared.dangerButton).toBe(dangerButton);
    expect(googleShared.dangerButton).toBe(dangerButton);
    // The re-export chain (compensation → payroll → recruitment → … → Google Workspace).
    expect(googleShared.primaryButton).toBe(primaryButton);
    expect(googleShared.EmptyState).toBe(EmptyState);
    expect(googleShared.Loading).toBe(LoadingText);
    expect(reportingShared.Loading).toBe(LoadingText);
  });

  it('gives every badge tone a readable pair of colors', () => {
    expect(badgeClass()).toContain('bg-slate-100 text-slate-700');
    expect(badgeClass('danger')).toContain('text-rose-900');
    expect(badgeClass('warning')).toContain('text-amber-900');
  });
});

describe('Batch 3A shared feedback states', () => {
  it('renders the text-only EmptyState the modules used, and the titled one', () => {
    const { container } = render(<EmptyState>No pay groups yet.</EmptyState>);
    expect(screen.getByText('No pay groups yet.')).toBeInTheDocument();
    expect(container.firstElementChild).toHaveClass('border-dashed', 'text-sm', 'text-slate-600');
    cleanup();
    render(
      <EmptyState
        title="No requests"
        description="Requests you submit appear here."
        action={{ label: 'Request leave', href: '/leave' }}
      />,
    );
    expect(screen.getByText('No requests')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Request leave' })).toHaveAttribute('href', '/leave');
  });

  it('announces loading politely, and messages by tone', () => {
    render(<LoadingText />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading…');
    cleanup();
    render(<LoadingState />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading organization data…');
    cleanup();

    render(
      <>
        <InlineMessage tone="success">Saved.</InlineMessage>
        <InlineMessage tone="error">Could not save.</InlineMessage>
      </>,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Saved.');
    expect(screen.getByRole('alert')).toHaveTextContent('Could not save.');
  });

  it('keeps ErrorBanner and FeedbackMessage working for the modules that import them', () => {
    render(
      <>
        <ErrorBanner>Unable to load.</ErrorBanner>
        <FeedbackMessage>Archived.</FeedbackMessage>
        <FeedbackMessage tone="error">Refused.</FeedbackMessage>
      </>,
    );
    const alerts = screen.getAllByRole('alert');
    expect(alerts.map((alert) => alert.textContent)).toEqual(['Unable to load.', 'Refused.']);
    expect(alerts[0]).toHaveClass('border-rose-300', 'bg-rose-50');
    const status = screen.getByRole('status');
    expect(status.tagName).toBe('P');
    expect(status).toHaveClass('border-emerald-300');
  });
});
