import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { useConfirm, useConfirmWithReason } from './use-confirm';

function Harness() {
  const [confirm, dialog] = useConfirm();
  const [result, setResult] = useState('none');
  return (
    <>
      <button
        type="button"
        onClick={async () =>
          setResult(
            String(
              await confirm({
                title: 'Archive this policy?',
                description: 'It has not taken effect yet.',
                confirmLabel: 'Archive policy',
              }),
            ),
          )
        }
      >
        Archive
      </button>
      <output>{result}</output>
      {dialog}
    </>
  );
}

afterEach(cleanup);

describe('useConfirm', () => {
  it('resolves true on confirm and false on cancel or Escape', async () => {
    render(<Harness />);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Archive this policy?' });
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Archive policy' }));
    expect(await screen.findByText('true')).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    fireEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cancel' }),
    );
    expect(await screen.findByText('false')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    fireEvent.keyDown(await screen.findByRole('alertdialog'), { key: 'Escape' });
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });
});

function ReasonHarness({ required, defaultValue }: { required: boolean; defaultValue?: string }) {
  const [confirm, dialog] = useConfirmWithReason();
  const [result, setResult] = useState('none');
  return (
    <>
      <button
        type="button"
        onClick={async () =>
          setResult(
            JSON.stringify(
              await confirm({
                title: 'Close this cycle?',
                description: 'Unsubmitted reviews are closed as incomplete.',
                confirmLabel: 'Close cycle',
                reason: {
                  label: 'Reason',
                  required,
                  defaultValue,
                  hint: 'Kept in the audit trail.',
                },
              }),
            ),
          )
        }
      >
        Close
      </button>
      <output>{result}</output>
      {dialog}
    </>
  );
}

describe('useConfirmWithReason', () => {
  it('keeps confirm disabled until a required reason is given, then resolves to it', async () => {
    render(<ReasonHarness required />);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Close this cycle?' });
    const reason = within(dialog).getByLabelText('Reason');
    expect(reason).toBeRequired();
    expect(reason).toHaveAccessibleDescription('Kept in the audit trail.');
    const confirmButton = within(dialog).getByRole('button', { name: 'Close cycle' });
    expect(confirmButton).toBeDisabled();
    fireEvent.change(reason, { target: { value: '   ' } });
    expect(confirmButton).toBeDisabled();
    fireEvent.change(reason, { target: { value: '  Window ended  ' } });
    expect(confirmButton).toBeEnabled();
    fireEvent.click(confirmButton);
    expect(await screen.findByText('"Window ended"')).toBeInTheDocument();

    // Cancelling resolves to null, and the next dialog starts empty.
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    const again = await screen.findByRole('alertdialog');
    expect(within(again).getByLabelText('Reason')).toHaveValue('');
    fireEvent.click(within(again).getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByText('null')).toBeInTheDocument();
  });

  it('accepts an optional reason, pre-filled and editable, or left empty', async () => {
    render(<ReasonHarness required={false} defaultValue="Review window ended" />);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    const dialog = await screen.findByRole('alertdialog');
    const reason = within(dialog).getByLabelText('Reason (optional)');
    expect(reason).toHaveValue('Review window ended');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close cycle' }));
    expect(await screen.findByText('"Review window ended"')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    const next = await screen.findByRole('alertdialog');
    fireEvent.change(within(next).getByLabelText('Reason (optional)'), { target: { value: '' } });
    fireEvent.click(within(next).getByRole('button', { name: 'Close cycle' }));
    expect(await screen.findByText('""')).toBeInTheDocument();
  });
});
