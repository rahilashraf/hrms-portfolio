'use client';
import Link from 'next/link';
import { Icon } from '../shell/icons';
import { buttonClass } from '../ui/button';

/**
 * The shared unauthorized state: the page exists but the caller may not use it. Never reveals
 * what the page would have shown.
 */
export function Forbidden({
  message = 'You do not have access to this area.',
  title = 'Access denied',
}: {
  message?: string;
  title?: string;
}) {
  return (
    <div className="mx-auto max-w-xl px-5 py-16 text-center">
      <Icon name="shield" className="mx-auto size-10 text-slate-400" />
      <h1 className="mt-4 text-2xl font-semibold text-slate-900">{title}</h1>
      <p className="mt-3 text-slate-600">{message}</p>
      <p className="mt-1 text-sm text-slate-500">
        If you need access, ask an administrator to grant you the right permissions.
      </p>
      <Link className={`mt-6 ${buttonClass('secondary')}`} href="/dashboard">
        Return to dashboard
      </Link>
    </div>
  );
}
