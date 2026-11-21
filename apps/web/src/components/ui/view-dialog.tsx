'use client';

import { useEffect, useId, useRef, type ReactNode } from 'react';
import { buttonClass } from './button';
import { trapTab, restoreFocus } from './focus';

/**
 * A read-only modal (Batch 8): the same behaviour as FormDialog without a form — focus moves to
 * the heading, Tab stays inside, Escape, the backdrop and Close dismiss it, and focus returns to
 * the control that opened it. On a phone it sits at the bottom and scrolls inside.
 */
export function ViewDialog({
  open,
  title,
  description,
  onClose,
  size = 'md',
  children,
}: {
  open: boolean;
  title: string;
  description?: ReactNode;
  onClose(): void;
  size?: 'md' | 'lg';
  children: ReactNode;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    heading.current?.focus();
    return () => restoreFocus(previous);
  }, [open]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center p-4 sm:items-center">
      <div aria-hidden="true" className="absolute inset-0 bg-slate-950/50" onClick={onClose} />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        className={`relative max-h-[90vh] w-full ${size === 'lg' ? 'max-w-2xl' : 'max-w-lg'} overflow-y-auto overflow-x-hidden rounded-2xl bg-white p-6 shadow-xl`}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            onClose();
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
        <div className="mt-4 space-y-4">{children}</div>
        <div className="mt-6 flex justify-end">
          <button type="button" onClick={onClose} className={buttonClass('secondary')}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
