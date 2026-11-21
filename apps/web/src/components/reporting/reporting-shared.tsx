'use client';

import type { ReactNode } from 'react';
import { hasPermission } from '../../lib/authorization/can';
import type { GrantSnapshot } from '../../lib/authorization/types';

export {
  EmptyState,
  Field,
  inputClass,
  primaryButton,
  secondaryButton,
  Section,
} from '../documents/documents-shared';
import { LoadingText } from '../ui/states';

/** Opens the Reporting area (the API decides which reports and scopes are reachable). */
export const REPORT_READ = 'report.read';

export function canSeeReports(authorization: GrantSnapshot | null | undefined): boolean {
  return hasPermission(authorization, REPORT_READ);
}

/** The reporting home or a report, keeping the selected organization. */
export function reportHref(reportKey: string | null, organizationId: string): string {
  const query = organizationId ? `?${new URLSearchParams({ organizationId })}` : '';
  return reportKey ? `/reports/${encodeURIComponent(reportKey)}${query}` : `/reports${query}`;
}

/** The organization named by `?organizationId=` in the current URL (client only). */
export function organizationFromLocation(): string {
  if (typeof window === 'undefined') return '';
  return new URLSearchParams(window.location.search).get('organizationId') ?? '';
}

const badge = 'inline-flex rounded-full px-2.5 py-1 text-xs font-medium';

export function Badge({
  tone = 'slate',
  children,
  title,
}: {
  tone?: 'slate' | 'amber' | 'indigo' | 'emerald';
  children: ReactNode;
  title?: string;
}) {
  const tones = {
    slate: 'bg-slate-100 text-slate-700',
    amber: 'bg-amber-50 text-amber-800',
    indigo: 'bg-indigo-50 text-indigo-800',
    emerald: 'bg-emerald-50 text-emerald-800',
  };
  return (
    <span className={`${badge} ${tones[tone]}`} title={title}>
      {children}
    </span>
  );
}

export { LoadingText as Loading };
