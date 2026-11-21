import Link from 'next/link';
import type { Breadcrumb } from '../../lib/navigation/registry';
import { Icon } from './icons';

export function Breadcrumbs({ crumbs }: { crumbs: readonly Breadcrumb[] }) {
  if (crumbs.length === 0) return null;
  return (
    <nav aria-label="Breadcrumb" className="min-w-0">
      <ol className="flex flex-wrap items-center gap-1 text-sm text-slate-600">
        {crumbs.map((crumb, index) => (
          <li key={`${crumb.label}-${index}`} className="flex min-w-0 items-center gap-1">
            {index > 0 && <Icon name="chevronRight" className="size-3.5 text-slate-400" />}
            {crumb.href ? (
              <Link
                href={crumb.href}
                className="truncate rounded hover:text-[var(--hrms-accent-text)] hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-[var(--hrms-accent-text)]"
              >
                {crumb.label}
              </Link>
            ) : (
              <span
                aria-current={crumb.current ? 'page' : undefined}
                className={`truncate ${crumb.current ? 'font-medium text-slate-900' : ''}`}
              >
                {crumb.label}
              </span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
