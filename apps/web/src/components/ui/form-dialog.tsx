'use client';

import { useEffect, useId, useRef, type FormEvent, type ReactNode } from 'react';
import { buttonClass } from './button';
import { trapTab, restoreFocus } from './focus';

/**
 * A modal form (Batch 4E-1, shared since Batch 5C): focus moves to the first field (or the
 * heading), Tab stays inside, Escape and the backdrop close it unless busy, and focus returns
 * to the control that opened it. The error is announced (`role="alert"`). On a phone it sits at
 * the bottom of the screen and scrolls inside, never sideways.
 */
export function FormDialog({
  open,
  title,
  description,
  submitLabel,
  busyLabel = 'Saving…',
  busy,
  canSubmit,
  error,
  onSubmit,
  onClose,
  tone = 'primary',
  size = 'md',
  cancelLabel = 'Cancel',
  children,
}: {
  open: boolean;
  title: string;
  description?: ReactNode;
  submitLabel: string;
  busyLabel?: string;
  busy: boolean;
  canSubmit: boolean;
  error: string | null;
  onSubmit(): void;
  onClose(): void;
  /** `destructive` for an action that ends something (termination, archive, revocation). */
  tone?: 'primary' | 'destructive';
  size?: 'md' | 'lg';
  cancelLabel?: string;
  children: ReactNode;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // The first field, or (a dialog without fields) its heading: focus always moves inside.
    const field = panel.current?.querySelector<HTMLElement>('input, select, textarea');
    (field ?? heading.current)?.focus();
    return () => restoreFocus(previous);
  }, [open]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center p-4 sm:items-center">
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-slate-950/50"
        onClick={() => !busy && onClose()}
      />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        aria-busy={busy || undefined}
        className={`relative max-h-[90vh] w-full ${size === 'lg' ? 'max-w-2xl' : 'max-w-lg'} overflow-y-auto overflow-x-hidden rounded-2xl bg-white p-6 shadow-xl`}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            if (!busy) onClose();
            return;
          }
          if (panel.current) trapTab(event, panel.current);
        }}
      >
        <h2
          id={titleId}
          ref={heading}
          tabIndex={-1}
          className="text-lg font-semibold text-slate-950 focus:outline-none"
        >
          {title}
        </h2>
        {description && (
          <div id={descriptionId} className="mt-1 text-sm text-slate-600">
            {description}
          </div>
        )}
        <form
          className="mt-4 space-y-4"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            if (canSubmit && !busy) onSubmit();
          }}
        >
          {children}
          {error && (
            <p role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-900">
              {error}
            </p>
          )}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className={buttonClass('secondary')}
            >
              {cancelLabel}
            </button>
            <button
              type="submit"
              disabled={busy || !canSubmit}
              className={buttonClass(tone === 'destructive' ? 'destructive' : 'primary')}
            >
              {busy ? busyLabel : submitLabel}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
