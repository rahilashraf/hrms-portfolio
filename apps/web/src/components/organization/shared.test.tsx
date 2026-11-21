import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ArchivedToggle, RecordActions } from './shared';

describe('organization admin controls', () => {
  it('reports archived toggle changes', () => {
    const onChange = vi.fn();
    render(<ArchivedToggle checked={false} onChange={onChange} />);

    fireEvent.click(screen.getByRole('checkbox', { name: 'Show archived' }));

    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('requires archive confirmation and replaces edit/archive with reactivate for archived records', async () => {
    const onArchive = vi.fn().mockResolvedValue(undefined);
    const onReactivate = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(
      <RecordActions
        archived={false}
        onEdit={vi.fn()}
        onArchive={onArchive}
        onReactivate={onReactivate}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    expect(screen.getByRole('alertdialog')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm archive' }));
    await vi.waitFor(() => {
      expect(onArchive).toHaveBeenCalledOnce();
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    });

    rerender(
      <RecordActions archived onEdit={vi.fn()} onArchive={onArchive} onReactivate={onReactivate} />,
    );
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Archive' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reactivate' }));
    await vi.waitFor(() => expect(onReactivate).toHaveBeenCalledOnce());
  });
});
