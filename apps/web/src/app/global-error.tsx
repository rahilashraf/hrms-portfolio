'use client';

import './globals.css';
import { RouteErrorState, type RouteErrorProps } from '../components/ui/route-error';

/**
 * Last-resort boundary for errors in a root layout (application or kiosk). It replaces the
 * layout, so it renders its own document.
 */
export default function GlobalError({ error, retry }: RouteErrorProps) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full bg-slate-50">
        <title>Something went wrong · HRMS</title>
        <main id="main-content">
          <RouteErrorState error={error} retry={retry} home={{ label: 'Go to start', href: '/' }} />
        </main>
      </body>
    </html>
  );
}
