import type { ReactNode } from 'react';
import Link from 'next/link';
import { buttonClass } from './button';

export interface PageAction {
  label: string;
  /** A link action… */
  href?: string;
  /** …or a button action. */
  onClick?: () => void;
  disabled?: boolean;
}

function ActionControl({
  action,
  variant,
}: {
  action: PageAction;
  variant: 'primary' | 'secondary';
}) {
  if (action.href) {
    return (
      <Link href={action.href} className={buttonClass(variant)}>
        {action.label}
      </Link>
    );
  }
  return (
    <button
      type="button"
      onClick={action.onClick}
      disabled={action.disabled}
      className={buttonClass(variant)}
    >
      {action.label}
    </button>
  );
}

/**
 * The shared page header: one h1 per page, an optional eyebrow and description, and the page's
 * primary/secondary actions (or any custom controls as children).
 */
export function PageHeader({
  eyebrow,
  title,
  description,
  primaryAction,
  secondaryActions = [],
  children,
}: {
  eyebrow?: string;
  title: ReactNode;
  description?: ReactNode;
  primaryAction?: PageAction;
  secondaryActions?: readonly PageAction[];
  children?: ReactNode;
}) {
  const hasActions = Boolean(primaryAction) || secondaryActions.length > 0 || Boolean(children);
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        {eyebrow && <p className="text-sm font-medium text-[var(--hrms-accent-text)]">{eyebrow}</p>}
        <h1 className="mt-1 break-words text-2xl font-semibold tracking-tight text-slate-950 sm:text-3xl">
          {title}
        </h1>
        {description && <p className="mt-2 max-w-2xl text-slate-600">{description}</p>}
      </div>
      {hasActions && (
        <div className="flex flex-wrap items-center gap-2">
          {children}
          {secondaryActions.map((action) => (
            <ActionControl key={action.label} action={action} variant="secondary" />
          ))}
          {primaryAction && <ActionControl action={primaryAction} variant="primary" />}
        </div>
      )}
    </div>
  );
}
