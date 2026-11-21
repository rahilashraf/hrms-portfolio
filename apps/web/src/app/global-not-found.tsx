import type { Metadata } from 'next';
import './globals.css';
import { NotFoundState } from '../components/ui/not-found-state';

export const metadata: Metadata = {
  title: 'Page not found · HRMS',
  description: 'The page you are looking for does not exist.',
};

/**
 * The 404 for URLs that match no route. The app has two root layouts (application and kiosk),
 * so this page renders its own document.
 */
export default function GlobalNotFound() {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full bg-slate-50">
        <main id="main-content">
          <NotFoundState />
        </main>
      </body>
    </html>
  );
}
