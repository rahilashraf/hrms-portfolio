'use client';

import { useEffect, useId, useRef, type ReactNode } from 'react';
import { buttonClass } from './button';
import { trapTab, restoreFocus } from './focus';

/**
 * An accessible confirmation for destructive or irreversible actions: `alertdialog` with a
 * labelled title and description, focus moved to the safe (cancel) button, Tab trapped inside,
 * Escape and the backdrop cancel, and focus restored to the trigger on close.
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel = 'Cancel',
  destructive = true,
  busy = false,
  confirmDisabled = false,
  onConfirm,
  onCancel,
  children,
}: {
  open: boolean;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  destructive?: boolean;
  busy?: boolean;
  /** Keeps the confirm button disabled, e.g. until a required reason is entered. */
  confirmDisabled?: boolean;
  onConfirm(): void;
  onCancel(): void;
  /** Extra content, e.g. a required reason field. */
  children?: ReactNode;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancel.current?.focus();
    return () => restoreFocus(previous);
  }, [open]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center p-4 sm:items-center">
      <div
        aria-hidden="true"
        data-testid="confirm-backdrop"
        className="absolute inset-0 bg-slate-950/50"
        onClick={() => !busy && onCancel()}
      />
      <div
        ref={panel}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        // R4-A: like FormDialog, a tall confirmation (e.g. with an impact preview) scrolls
        // inside the viewport so its buttons stay reachable.
        className="relative max-h-[90vh] w-full max-w-md overflow-y-auto overflow-x-hidden rounded-2xl bg-white p-6 shadow-xl"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            if (!busy) onCancel();
            return;
          }
          if (panel.current) trapTab(event, panel.current);
        }}
      >
        <h2 id={titleId} className="text-lg font-semibold text-slate-950">
          {title}
        </h2>
        <div id={descriptionId} className="mt-2 text-sm text-slate-600">
          {description}
        </div>
        {children && <div className="mt-4">{children}</div>}
        <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button
            ref={cancel}
            type="button"
            disabled={busy}
            onClick={onCancel}
            className={buttonClass('secondary')}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            disabled={busy || confirmDisabled}
            onClick={onConfirm}
            className={buttonClass(destructive ? 'destructive' : 'primary')}
          >
            {busy ? 'Please wait…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
