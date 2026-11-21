import Link from 'next/link';
import { buttonClass } from './button';

/** The shared "page not found" content (global 404 and in-app `notFound()`). */
export function NotFoundState({
  title = 'Page not found',
  message = 'The page you are looking for does not exist, has moved, or is not available to you.',
  homeHref = '/dashboard',
}: {
  title?: string;
  message?: string;
  homeHref?: string;
}) {
  return (
    <div className="mx-auto max-w-xl px-5 py-16 text-center">
      <p className="text-sm font-semibold text-[var(--hrms-accent-text)]">404</p>
      <h1 className="mt-2 text-2xl font-semibold text-slate-950">{title}</h1>
      <p className="mt-3 text-slate-600">{message}</p>
      <Link href={homeHref} className={`mt-6 ${buttonClass('secondary')}`}>
        Return to dashboard
      </Link>
    </div>
  );
}
