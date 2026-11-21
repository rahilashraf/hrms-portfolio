'use client';

import { usePathname } from 'next/navigation';
import { RouteErrorState, type RouteErrorProps } from '../../../components/ui/route-error';
import { pageWidthFor } from '../../../lib/navigation/page-width';

/** A page that failed to render, shown inside the application shell so navigation still works. */
export default function AuthenticatedError({ error, retry }: RouteErrorProps) {
  const pathname = usePathname();
  return (
    <RouteErrorState
      error={error}
      retry={retry}
      width={pageWidthFor(pathname)}
      home={{ label: 'Go to dashboard', href: '/dashboard' }}
    />
  );
}
