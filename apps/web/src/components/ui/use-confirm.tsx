'use client';

import { useCallback, useId, useRef, useState, type ReactNode } from 'react';
import { ConfirmDialog } from './confirm-dialog';
import { inputClass } from './tokens';

export interface ReasonOptions {
  label: string;
  /** A required reason keeps the confirm button disabled until something is entered. */
  required?: boolean;
  /** The API's limit for the field (default 1000 characters). */
  maxLength?: number;
  /** Pre-filled text the user may change. */
  defaultValue?: string;
  hint?: string;
}

export interface ConfirmOptions {
  title: string;
  description: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  destructive?: boolean;
}

export interface Pending extends ConfirmOptions {
  reason?: ReasonOptions;
}

interface Outcome {
  confirmed: boolean;
  reason: string;
}

/** The dialog state behind useConfirm, useConfirmWithReason and ConfirmButton. */
export function useConfirmDialog() {
  const [options, setOptions] = useState<Pending | null>(null);
  const [reason, setReason] = useState('');
  const resolver = useRef<((value: Outcome) => void) | null>(null);
  const reasonId = useId();

  const ask = useCallback((next: Pending) => {
    resolver.current?.({ confirmed: false, reason: '' });
    setReason(next.reason?.defaultValue ?? '');
    setOptions(next);
    return new Promise<Outcome>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const settle = (confirmed: boolean) => {
    resolver.current?.({ confirmed, reason: confirmed ? reason.trim() : '' });
    resolver.current = null;
    setOptions(null);
  };

  const field = options?.reason;
  const dialog = (
    <ConfirmDialog
      open={options !== null}
      title={options?.title ?? ''}
      description={options?.description ?? ''}
      confirmLabel={options?.confirmLabel ?? 'Confirm'}
      cancelLabel={options?.cancelLabel}
      destructive={options?.destructive ?? true}
      confirmDisabled={Boolean(field?.required) && reason.trim() === ''}
      onConfirm={() => settle(true)}
      onCancel={() => settle(false)}
    >
      {field && (
        <div>
          <label htmlFor={reasonId} className="block text-sm font-medium text-slate-800">
            {field.label}
            {!field.required && <span className="font-normal text-slate-600"> (optional)</span>}
          </label>
          <textarea
            id={reasonId}
            rows={3}
            value={reason}
            required={field.required}
            maxLength={field.maxLength ?? 1000}
            aria-describedby={field.hint ? `${reasonId}-hint` : undefined}
            onChange={(event) => setReason(event.currentTarget.value)}
            className={inputClass}
          />
          {field.hint && (
            <p id={`${reasonId}-hint`} className="mt-1 text-xs text-slate-600">
              {field.hint}
            </p>
          )}
        </div>
      )}
    </ConfirmDialog>
  );
  return { ask, dialog };
}

/**
 * The shared ConfirmDialog as a promise: `if (await confirm({...})) doIt()`. Render the
 * returned element once in the component. Replaces `window.confirm`, which is not accessible
 * or styleable and blocks the page.
 */
export function useConfirm(): readonly [(options: ConfirmOptions) => Promise<boolean>, ReactNode] {
  const { ask, dialog } = useConfirmDialog();
  const confirm = useCallback(
    async (options: ConfirmOptions) => (await ask(options)).confirmed,
    [ask],
  );
  return [confirm, dialog] as const;
}

/**
 * Batch 3A — a confirmation that also asks for a reason (for the audit trail):
 * `const why = await confirm({..., reason: { label: 'Reason', required: true } })` resolves to
 * the trimmed reason, '' for an optional reason left empty, or `null` when cancelled.
 */
export function useConfirmWithReason(): readonly [
  (options: ConfirmOptions & { reason: ReasonOptions }) => Promise<string | null>,
  ReactNode,
] {
  const { ask, dialog } = useConfirmDialog();
  const confirm = useCallback(
    async (options: ConfirmOptions & { reason: ReasonOptions }) => {
      const outcome = await ask(options);
      return outcome.confirmed ? outcome.reason : null;
    },
    [ask],
  );
  return [confirm, dialog] as const;
}
