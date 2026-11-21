import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AuthenticatedError from './(app)/(authenticated)/error';
import AppError from './(app)/error';
import KioskError from './(kiosk)/kiosk/error';
import GlobalError from './global-error';

const failure = Object.assign(new Error('relation "Secret" does not exist'), {
  digest: 'abc123',
});

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(cleanup);

describe('route error boundaries', () => {
  it('shows a generic alert with the reference, never the raw message, and logs the error', () => {
    render(<AuthenticatedError error={failure} retry={vi.fn()} />);

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent("This page couldn't be displayed");
    expect(alert).toHaveTextContent('Reference: abc123');
    expect(alert).not.toHaveTextContent('Secret');
    expect(console.error).toHaveBeenCalledWith(failure);
  });

  it('retries the segment and links back to the dashboard inside the shell', () => {
    const retry = vi.fn();
    render(<AuthenticatedError error={failure} retry={retry} />);

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('link', { name: 'Go to dashboard' })).toHaveAttribute(
      'href',
      '/dashboard',
    );
  });

  it('omits the reference when the error has no digest', () => {
    render(<AppError error={new Error('boom')} retry={vi.fn()} />);

    expect(screen.getByRole('alert')).not.toHaveTextContent('Reference');
    expect(screen.getByRole('main')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to start' })).toHaveAttribute('href', '/');
  });

  it('offers the kiosk a retry only, with no link into the application', () => {
    render(<KioskError error={failure} retry={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('renders its own document when a root layout fails', () => {
    const html = renderToStaticMarkup(<GlobalError error={failure} retry={vi.fn()} />);

    expect(html).toMatch(/^<html lang="en"/);
    expect(html).toContain('<title>Something went wrong · HRMS</title>');
    expect(html).toMatch(/Reference: (<!-- -->)?abc123/);
    expect(html).not.toContain('Secret');
  });
});
