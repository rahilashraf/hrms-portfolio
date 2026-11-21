import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pageContainerClass, type PageWidth } from '../../../components/ui/page-container';

/**
 * Batch 10F — the route-level skeleton (loading.tsx) and error state (error.tsx) render in the
 * destination page's own `PageContainer` width, so the loaded page (or the error) replaces them
 * without a width jump. The e2e acceptance suite checks the same widths on the loaded pages.
 */
let pathname: string | null = '/';
vi.mock('next/navigation', () => ({ usePathname: () => pathname }));

const { default: AuthenticatedLoading } = await import('./loading');
const { default: AuthenticatedError } = await import('./error');
const { default: AuthenticatedNotFound } = await import('./not-found');

afterEach(cleanup);

const ROUTES: Array<[string, PageWidth]> = [
  ['/dashboard', 'wide'],
  ['/account/security', 'narrow'],
  ['/admin/organizations', 'default'],
  ['/admin/audit', 'wide'],
  ['/admin/settings', 'wide'],
  ['/admin/time', 'full'],
  ['/admin/leave', 'full'],
  ['/admin/scheduling/templates', 'full'],
  ['/time', 'wide'],
  ['/leave', 'wide'],
  ['/schedule', 'default'],
  ['/admin/payroll', 'wide'],
  ['/admin/payroll/runs/run-1', 'wide'],
  ['/pay', 'default'],
  ['/admin/recruitment', 'wide'],
  ['/recruitment/applications/app-1', 'default'],
  ['/admin/onboarding', 'wide'],
  ['/onboarding/workflows/wf-1', 'wide'],
  ['/admin/performance', 'wide'],
  ['/admin/benefits', 'wide'],
  ['/admin/notifications', 'wide'],
  ['/notifications/preferences', 'narrow'],
  ['/admin/documents', 'wide'],
  ['/documents/records/doc-1', 'default'],
  ['/reports', 'wide'],
];

describe('route skeleton (loading.tsx)', () => {
  it.each(ROUTES)('%s: a "Loading page…" status in the %s frame', (path, width) => {
    pathname = path;
    const { container } = render(<AuthenticatedLoading />);
    const frame = container.firstElementChild as HTMLElement;
    expect(frame.className).toBe(pageContainerClass(width));
    // Feedback stays: an announced status and the placeholder rows.
    expect(screen.getByRole('status')).toHaveTextContent(/^Loading page…$/);
    expect(frame.querySelectorAll('.animate-pulse').length).toBeGreaterThanOrEqual(5);
  });

  it('falls back to the default frame when the path is not known yet', () => {
    pathname = null;
    const { container } = render(<AuthenticatedLoading />);
    expect((container.firstElementChild as HTMLElement).className).toBe(
      pageContainerClass('default'),
    );
  });
});

describe('route error (error.tsx)', () => {
  it.each(ROUTES.slice(0, 8))('%s: the error replaces the page in its %s frame', (path, width) => {
    pathname = path;
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { container } = render(
      <AuthenticatedError
        error={Object.assign(new Error('secret detail'), { digest: 'd-1' })}
        retry={() => undefined}
      />,
    );
    expect((container.firstElementChild as HTMLElement).className).toBe(pageContainerClass(width));
    // The raw message never shows; the digest does.
    expect(container).not.toHaveTextContent('secret detail');
    expect(container).toHaveTextContent('Reference: d-1');
  });
});

describe('not found (not-found.tsx)', () => {
  it.each(ROUTES.slice(0, 6))('%s: the 404 card sits in the %s frame', (path, width) => {
    pathname = path;
    const { container } = render(<AuthenticatedNotFound />);
    expect((container.firstElementChild as HTMLElement).className).toBe(
      pageContainerClass(width, false),
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Page not found' })).toBeInTheDocument();
  });
});
