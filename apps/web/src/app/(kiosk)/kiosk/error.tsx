'use client';

import { RouteErrorState, type RouteErrorProps } from '../../../components/ui/route-error';

/** The kiosk failed to render: offer a retry only, never a link into the application. */
export default function KioskError({ error, retry }: RouteErrorProps) {
  return (
    <main className="min-h-screen">
      <RouteErrorState error={error} retry={retry} />
    </main>
  );
}
