import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import '../globals.css';

export const metadata: Metadata = {
  title: 'Attendance kiosk',
  description: 'Onsite attendance kiosk',
  robots: { index: false, follow: false },
};

/**
 * Phase 9.5 — the kiosk's own root layout: no user session (no AuthProvider), no navigation,
 * no HR data. Navigating between this and the application's root layout is a full page load.
 */
export default function KioskLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full bg-slate-950">{children}</body>
    </html>
  );
}
