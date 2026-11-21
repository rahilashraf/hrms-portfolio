import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import LoginPage from './login/page';

const apiRequest = vi.hoisted(() => vi.fn());
vi.mock('../../lib/auth/api-client', () => ({ apiRequest }));
const auth = vi.hoisted(() => ({ login: vi.fn(), status: 'unauthenticated' }));
vi.mock('../../providers/auth-provider', () => ({ useAuth: () => auth }));
const replace = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace }) }));

const BRANDED = {
  source: 'ORGANIZATION',
  displayName: 'Northwind Academy',
  shortName: 'Northwind',
  loginLogoUrl: 'https://cdn.example.com/login.png',
  iconUrl: 'https://cdn.example.com/icon.png',
  primaryColor: '#0F766E',
  secondaryColor: '#F59E0B',
  loginSubtitle: 'Staff and camp counsellors',
  websiteUrl: 'https://northwind.example.com',
  supportEmail: 'help@northwind.example.com',
};

beforeEach(() => {
  vi.clearAllMocks();
  auth.login.mockResolvedValue(undefined);
  window.history.replaceState(null, '', '/login');
  document.title = 'HRMS';
});
afterEach(cleanup);

describe('login page branding', () => {
  it('shows the configured public branding for ?organization=<code>', async () => {
    window.history.replaceState(null, '', '/login?organization=nwa');
    apiRequest.mockResolvedValue(BRANDED);
    render(<LoginPage />);
    const card = await screen.findByRole('region', { name: 'Northwind Academy sign-in' });
    expect(apiRequest).toHaveBeenCalledWith('/public/branding?organization=NWA', {
      authenticated: false,
      retryUnauthorized: false,
    });
    const logo = within(card).getByAltText('Northwind Academy logo');
    expect(logo).toHaveAttribute('src', 'https://cdn.example.com/login.png');
    expect(logo).toHaveAttribute('referrerpolicy', 'no-referrer');
    expect(within(card).getByText('Staff and camp counsellors')).toBeInTheDocument();
    expect(within(card).getByRole('link', { name: 'Website' })).toHaveAttribute(
      'href',
      'https://northwind.example.com',
    );
    expect(within(card).getByRole('link', { name: 'Contact support' })).toHaveAttribute(
      'href',
      'mailto:help@northwind.example.com',
    );
    // Accent applied as CSS custom properties.
    expect(screen.getByRole('main').style.getPropertyValue('--hrms-accent')).toBe('#0F766E');
    await waitFor(() => expect(document.title).toBe('Sign in · Northwind'));
  });

  it('falls back to generic HRMS branding on any error and still signs in', async () => {
    apiRequest.mockRejectedValue(new TypeError('Failed to fetch'));
    render(<LoginPage />);
    expect(screen.getByRole('region', { name: 'HRMS sign-in' })).toBeInTheDocument();
    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith('/public/branding', expect.anything()),
    );
    expect(screen.queryAllByRole('img')).toHaveLength(0);
    expect(
      screen.queryByRole('navigation', { name: 'Organization links' }),
    ).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'ada@example.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(auth.login).toHaveBeenCalledWith('ada@example.com', 'secret'));
    expect(replace).toHaveBeenCalledWith('/dashboard');
  });

  it('never blocks sign-in while branding is still loading', async () => {
    apiRequest.mockReturnValue(new Promise(() => undefined));
    render(<LoginPage />);
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'ada@example.com' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(auth.login).toHaveBeenCalled());
  });

  it('never renders non-https images and ignores unknown fields', async () => {
    apiRequest.mockResolvedValue({
      ...BRANDED,
      loginLogoUrl: 'http://insecure.example.com/login.png',
      iconUrl: 'data:image/png;base64,AAAA',
      websiteUrl: 'javascript:alert(1)',
      internalNotes: 'never shown',
      organizationId: 'org-1',
    });
    render(<LoginPage />);
    await screen.findByRole('region', { name: 'Northwind Academy sign-in' });
    expect(screen.queryAllByRole('img')).toHaveLength(0);
    expect(screen.queryByRole('link', { name: 'Website' })).not.toBeInTheDocument();
    expect(screen.queryByText('never shown')).not.toBeInTheDocument();
    expect(screen.queryByText('org-1')).not.toBeInTheDocument();
  });
});
