'use client';

import { RouteErrorState, type RouteErrorProps } from '../../components/ui/route-error';

/**
 * Errors on the public pages (sign-in, recovery) and in the authenticated layout itself (route
 * guard, workspace, shell), which the boundary inside the shell cannot catch.
 */
export default function AppError({ error, retry }: RouteErrorProps) {
  return (
    <main id="main-content" className="min-h-screen bg-slate-50">
      <RouteErrorState error={error} retry={retry} home={{ label: 'Go to start', href: '/' }} />
    </main>
  );
}
