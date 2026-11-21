import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfirmButton } from './confirm-button';

afterEach(cleanup);

describe('ConfirmButton', () => {
  it('runs nothing on Cancel, returns focus to the button, and runs the action once confirmed', async () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmButton
        aria-label="Archive Safety quiz"
        className="secondary"
        confirm={{
          title: 'Archive Safety quiz?',
          description: 'It can no longer be used.',
          confirmLabel: 'Archive',
        }}
        onConfirm={onConfirm}
      >
        Archive
      </ConfirmButton>,
    );
    const button = screen.getByRole('button', { name: 'Archive Safety quiz' });
    expect(button).toHaveAttribute('type', 'button');
    button.focus();
    fireEvent.click(button);
    const dialog = await screen.findByRole('alertdialog', { name: 'Archive Safety quiz?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(onConfirm).not.toHaveBeenCalled();
    await waitFor(() => expect(button).toHaveFocus());

    fireEvent.click(button);
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Archive' }),
    );
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith(''));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('passes a required reason to the action', async () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmButton
        confirm={{
          title: 'Disable this kiosk?',
          description: 'Nobody can clock in on it.',
          confirmLabel: 'Disable kiosk',
          reason: { label: 'Reason', required: true },
        }}
        onConfirm={onConfirm}
      >
        Disable
      </ConfirmButton>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Disable' }));
    const dialog = await screen.findByRole('alertdialog');
    const confirm = within(dialog).getByRole('button', { name: 'Disable kiosk' });
    expect(confirm).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: ' Moved ' } });
    fireEvent.click(confirm);
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith('Moved'));
  });

  it('stays disabled like any button', () => {
    render(
      <ConfirmButton
        disabled
        confirm={{ title: 'Remove?', description: 'Gone.', confirmLabel: 'Remove' }}
        onConfirm={vi.fn()}
      >
        Remove
      </ConfirmButton>,
    );
    expect(screen.getByRole('button', { name: 'Remove' })).toBeDisabled();
  });
});
