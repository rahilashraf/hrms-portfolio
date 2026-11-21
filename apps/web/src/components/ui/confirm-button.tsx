'use client';

import type { ButtonHTMLAttributes } from 'react';
import { useConfirmDialog, type ConfirmOptions, type ReasonOptions } from './use-confirm';

/**
 * Batch 3A — a button whose action runs only after the shared confirmation dialog (and, with
 * `confirm.reason`, a reason for the audit trail). For archive, delete, disable and other
 * high-impact row actions: `<ConfirmButton confirm={{ title, description, confirmLabel }}
 * onConfirm={() => archive()}>Archive</ConfirmButton>`. Focus returns to the button when the
 * dialog closes.
 */
export function ConfirmButton({
  confirm,
  onConfirm,
  type = 'button',
  children,
  ...button
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'> & {
  confirm: ConfirmOptions & { reason?: ReasonOptions };
  /** Runs after confirmation, with the reason ('' when none was asked or given). */
  onConfirm(reason: string): void;
}) {
  const { ask, dialog } = useConfirmDialog();
  return (
    <>
      <button
        {...button}
        type={type}
        onClick={async () => {
          const outcome = await ask(confirm);
          if (outcome.confirmed) onConfirm(outcome.reason);
        }}
      >
        {children}
      </button>
      {dialog}
    </>
  );
}
