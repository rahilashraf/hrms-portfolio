'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { Icon } from '../shell/icons';
import { buttonClass } from './button';

export interface StateAction {
  label: string;
  href?: string;
  onClick?: () => void;
}

function StateActionControl({
  action,
  variant = 'primary',
}: {
  action: StateAction;
  variant?: 'primary' | 'secondary';
}) {
  return action.href ? (
    <Link href={action.href} className={buttonClass(variant, 'sm')}>
      {action.label}
    </Link>
  ) : (
    <button type="button" onClick={action.onClick} className={buttonClass(variant, 'sm')}>
      {action.label}
    </button>
  );
}

/**
 * Nothing to show yet: what is empty, why, and what to do next. Without a title it is the
 * compact text-only box the modules used to define themselves (`<EmptyState>No items.</EmptyState>`).
 */
export function EmptyState({
  title,
  description,
  action,
  icon = 'inbox',
  compact = false,
  children,
}: {
  title?: ReactNode;
  description?: ReactNode;
  action?: StateAction;
  icon?: Parameters<typeof Icon>[0]['name'];
  compact?: boolean;
  children?: ReactNode;
}) {
  if (title === undefined) {
    return (
      <div className="rounded-lg border border-dashed border-slate-300 p-5 text-center text-sm text-slate-600">
        {children ?? description}
        {action && (
          <div className="mt-3">
            <StateActionControl action={action} variant="secondary" />
          </div>
        )}
      </div>
    );
  }
  return (
    <div
      className={`rounded-xl border border-dashed border-slate-300 bg-white text-center ${compact ? 'p-4' : 'p-8'}`}
    >
      {!compact && <Icon name={icon} className="mx-auto size-8 text-slate-400" />}
      <p className={`${compact ? '' : 'mt-3 '}font-medium text-slate-900`}>{title}</p>
      {description && <p className="mx-auto mt-1 max-w-md text-sm text-slate-600">{description}</p>}
      {children && <div className="mx-auto mt-2 max-w-md text-sm text-slate-600">{children}</div>}
      {action && (
        <div className="mt-4">
          <StateActionControl action={action} />
        </div>
      )}
    </div>
  );
}

/** A page or panel that failed to load, with an optional retry. */
export function ErrorState({
  title = 'Something went wrong',
  message,
  onRetry,
  action,
}: {
  title?: string;
  message: ReactNode;
  onRetry?: () => void;
  action?: StateAction;
}) {
  return (
    <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-6 text-rose-900">
      <div className="flex items-start gap-3">
        <Icon name="alert" className="mt-0.5 size-5 text-rose-700" />
        <div>
          <p className="font-semibold">{title}</p>
          <p className="mt-1 text-sm">{message}</p>
          {(onRetry || action) && (
            <div className="mt-4 flex flex-wrap gap-2">
              {onRetry && (
                <button type="button" onClick={onRetry} className={buttonClass('secondary', 'sm')}>
                  Try again
                </button>
              )}
              {action && <StateActionControl action={action} variant="secondary" />}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** A shimmering placeholder block. */
export function Skeleton({ className = 'h-4 w-full' }: { className?: string }) {
  return (
    <span aria-hidden="true" className={`block animate-pulse rounded bg-slate-200 ${className}`} />
  );
}

/** A one-line loading message, announced politely (`role="status"`). */
export function LoadingText({
  children = 'Loading…',
  className = '',
}: {
  children?: ReactNode;
  className?: string;
}) {
  return (
    <p role="status" className={`text-sm text-slate-600 ${className}`.trim()}>
      {children}
    </p>
  );
}

/** A loading placeholder that keeps an accessible status message. */
export function LoadingState({ label = 'Loading…', rows = 3 }: { label?: string; rows?: number }) {
  return (
    <div className="space-y-3">
      <p role="status" className="text-sm text-slate-600">
        {label}
      </p>
      <div className="space-y-2 rounded-xl border border-slate-200 bg-white p-5">
        {Array.from({ length: rows }, (_, index) => (
          <Skeleton key={index} className={`h-4 ${index % 2 === 0 ? 'w-full' : 'w-2/3'}`} />
        ))}
      </div>
    </div>
  );
}

/**
 * Wraps a wide table so it scrolls horizontally on small screens instead of the page. With a
 * label it is a named region that keyboard users can focus and scroll. `bare` drops the frame
 * for tables already inside a bordered panel.
 */
export function TableScroll({
  children,
  label,
  bare = false,
}: {
  children: ReactNode;
  label?: string;
  bare?: boolean;
}) {
  return (
    <div
      // `relative`: screen-reader-only (absolutely positioned) text inside the table is clipped
      // by this region instead of widening the page (Batch 4E-1, tablet layout).
      className={`relative w-full overflow-x-auto ${bare ? '' : 'rounded-xl border border-slate-200 bg-white'}`.trim()}
      role={label ? 'region' : undefined}
      aria-label={label}
      tabIndex={label ? 0 : undefined}
    >
      {children}
    </div>
  );
}
