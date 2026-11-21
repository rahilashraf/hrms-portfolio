import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buttonClass } from './button';
import { ConfirmDialog } from './confirm-dialog';
import { PageHeader } from './page-header';
import { EmptyState, ErrorState, LoadingState, TableScroll } from './states';
import { lifecycleSteps, StatusTimeline, Stepper } from './stepper';
import { ToastProvider, useToast } from './toast';

afterEach(cleanup);

describe('PageHeader', () => {
  it('renders one heading, description and primary/secondary actions', () => {
    const onExport = vi.fn();
    render(
      <PageHeader
        eyebrow="Pay"
        title="Payroll"
        description="Runs from draft to finalized."
        primaryAction={{ label: 'New run', href: '/admin/payroll/new' }}
        secondaryActions={[{ label: 'Export', onClick: onExport }]}
      />,
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Payroll' })).toBeInTheDocument();
    expect(screen.getByText('Runs from draft to finalized.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'New run' })).toHaveAttribute(
      'href',
      '/admin/payroll/new',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    expect(onExport).toHaveBeenCalled();
  });
});

describe('state components', () => {
  it('explains an empty state with a next step', () => {
    render(
      <EmptyState
        title="No payroll runs yet"
        description="Runs appear once a pay period is opened."
        action={{ label: 'Open pay groups', href: '/admin/compensation' }}
      />,
    );
    expect(screen.getByText('No payroll runs yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open pay groups' })).toHaveAttribute(
      'href',
      '/admin/compensation',
    );
  });

  it('announces errors with a retry', () => {
    const retry = vi.fn();
    render(<ErrorState message="Unable to load." onRetry={retry} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Unable to load.');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalled();
  });

  it('keeps an accessible loading status and scrollable tables', () => {
    render(
      <>
        <LoadingState label="Loading runs…" />
        <TableScroll label="Runs">
          <table />
        </TableScroll>
      </>,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Loading runs…');
    expect(screen.getByRole('region', { name: 'Runs' })).toHaveClass('overflow-x-auto');
  });

  it('has consistent button variants', () => {
    expect(buttonClass('primary')).toContain('bg-[var(--hrms-accent)]');
    expect(buttonClass('destructive')).toContain('bg-rose-700');
    expect(buttonClass('secondary')).toContain('border');
    for (const variant of ['primary', 'secondary', 'destructive', 'ghost'] as const)
      expect(buttonClass(variant)).toContain('focus-visible:ring');
  });
});

function DialogHarness({ onConfirm }: { onConfirm(): void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Void run
      </button>
      <ConfirmDialog
        open={open}
        title="Void this payroll run?"
        description="Voiding cannot be undone."
        confirmLabel="Void run"
        onConfirm={() => {
          onConfirm();
          setOpen(false);
        }}
        onCancel={() => setOpen(false)}
      />
    </>
  );
}

describe('ConfirmDialog', () => {
  it('is a labelled alertdialog that focuses cancel, traps Tab, closes on Escape and restores focus', () => {
    const onConfirm = vi.fn();
    render(<DialogHarness onConfirm={onConfirm} />);
    const trigger = screen.getByRole('button', { name: 'Void run' });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = screen.getByRole('alertdialog', { name: 'Void this payroll run?' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleDescription('Voiding cannot be undone.');
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    expect(cancel).toHaveFocus();
    const confirm = screen.getAllByRole('button', { name: 'Void run' }).at(-1)!;
    confirm.focus();
    fireEvent.keyDown(confirm, { key: 'Tab' });
    expect(cancel).toHaveFocus();
    fireEvent.keyDown(cancel, { key: 'Escape' });
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('confirms, and cancels from the backdrop', () => {
    const onConfirm = vi.fn();
    render(<DialogHarness onConfirm={onConfirm} />);
    fireEvent.click(screen.getByRole('button', { name: 'Void run' }));
    fireEvent.click(screen.getByTestId('confirm-backdrop'));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Void run' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Void run' }).at(-1)!);
    expect(onConfirm).toHaveBeenCalledOnce();
  });
});

function ToastHarness() {
  const toast = useToast();
  return (
    <>
      <button type="button" onClick={() => toast.success('Run approved.')}>
        ok
      </button>
      <button type="button" onClick={() => toast.error('Approval failed.')}>
        fail
      </button>
    </>
  );
}

describe('toasts', () => {
  it('announces success politely and errors assertively, and can be dismissed', () => {
    vi.useFakeTimers();
    try {
      render(
        <ToastProvider timeoutMs={1000}>
          <ToastHarness />
        </ToastProvider>,
      );
      fireEvent.click(screen.getByRole('button', { name: 'ok' }));
      fireEvent.click(screen.getByRole('button', { name: 'fail' }));
      const status = screen.getByRole('status');
      expect(status).toHaveTextContent('Run approved.');
      expect(status.parentElement).toHaveAttribute('aria-live', 'polite');
      const alert = screen.getByRole('alert');
      expect(alert).toHaveTextContent('Approval failed.');
      expect(alert.parentElement).toHaveAttribute('aria-live', 'assertive');
      fireEvent.click(screen.getAllByRole('button', { name: 'Dismiss notification' })[0]!);
      expect(screen.queryByText('Run approved.')).not.toBeInTheDocument();
      act(() => vi.advanceTimersByTime(1000));
      expect(screen.queryByText('Approval failed.')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('is a silent no-op without a provider', () => {
    render(<ToastHarness />);
    expect(() => fireEvent.click(screen.getByRole('button', { name: 'ok' }))).not.toThrow();
  });
});

describe('Stepper and StatusTimeline', () => {
  const path = [
    { key: 'DRAFT', label: 'Draft' },
    { key: 'CALCULATED', label: 'Calculated' },
    { key: 'APPROVED', label: 'Approved' },
    { key: 'FINALIZED', label: 'Finalized' },
  ] as const;

  it('derives step states from the current lifecycle state', () => {
    expect(lifecycleSteps(path, 'CALCULATED').map((step) => step.state)).toEqual([
      'complete',
      'current',
      'upcoming',
      'upcoming',
    ]);
    expect(lifecycleSteps(path, 'FINALIZED', { completeAtEnd: true }).at(-1)?.state).toBe(
      'complete',
    );
    // An off-path state (e.g. VOIDED) skips what was never reached.
    expect(
      lifecycleSteps<string>(path, 'VOIDED', { reached: 'CALCULATED' }).map((step) => step.state),
    ).toEqual(['complete', 'complete', 'skipped', 'skipped']);
  });

  it('marks the current step for assistive technology', () => {
    render(<Stepper label="Payroll run progress" steps={lifecycleSteps(path, 'APPROVED')} />);
    const nav = screen.getByRole('navigation', { name: 'Payroll run progress' });
    const current = nav.querySelector('[aria-current="step"]');
    expect(current).toHaveTextContent('Approved (current step)');
    expect(nav).toHaveTextContent('Draft (completed)');
  });

  it('lists history events or an empty message', () => {
    const { rerender } = render(
      <StatusTimeline label="History" events={[]} empty="Nothing yet." />,
    );
    expect(screen.getByText('Nothing yet.')).toBeInTheDocument();
    rerender(
      <StatusTimeline
        label="History"
        events={[
          { key: '1', title: 'Submitted', when: 'Mar 1' },
          { key: '2', title: 'Approved', tone: 'success' },
        ]}
      />,
    );
    expect(screen.getByRole('list', { name: 'History' }).children).toHaveLength(2);
  });
});
