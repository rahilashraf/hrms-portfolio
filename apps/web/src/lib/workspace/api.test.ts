import { afterEach, describe, expect, it, vi } from 'vitest';
import { setAccessToken } from '../auth/api-client';
import { parseWorkspace, workspaceApi } from './api';

const raw = {
  user: { id: 'user-1', email: 'ada@example.com', displayName: 'Ada Lovelace' },
  systemPermissions: ['audit.read', 7],
  organizations: [
    {
      id: 'org-1',
      name: 'Northwind Academy',
      code: 'NWA',
      timezone: 'America/Toronto',
      branding: {
        displayName: 'Northwind',
        shortName: 'NW',
        logoUrl: 'javascript:alert(1)',
        iconUrl: 'https://cdn.example.com/icon.png',
        primaryColor: '#123ABC',
        secondaryColor: 'red',
      },
      enabledModules: ['PAYROLL', 'NOT_A_MODULE'],
      permissions: ['payroll.read'],
      isEmployee: true,
      isManager: 'yes',
    },
    { id: '', name: 'Broken' },
  ],
};

describe('workspace API', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    setAccessToken(null);
  });

  it('parses the contract shape defensively', () => {
    const workspace = parseWorkspace(raw);
    expect(workspace.systemPermissions).toEqual(['audit.read']);
    expect(workspace.organizations).toHaveLength(1);
    const [organization] = workspace.organizations;
    expect(organization).toMatchObject({
      id: 'org-1',
      enabledModules: ['PAYROLL'],
      isEmployee: true,
      isManager: false,
    });
    // Only https URLs and #RRGGBB colors are kept.
    expect(organization!.branding).toEqual({
      displayName: 'Northwind',
      shortName: 'NW',
      logoUrl: null,
      iconUrl: 'https://cdn.example.com/icon.png',
      primaryColor: '#123ABC',
      secondaryColor: null,
    });
  });

  it('falls back to the email for a missing display name', () => {
    expect(
      parseWorkspace({ ...raw, user: { id: 'u', email: 'x@example.com' } }).user.displayName,
    ).toBe('x@example.com');
  });

  it('rejects an unexpected shape so the shell can fall back', () => {
    expect(() => parseWorkspace(null)).toThrow();
    expect(() => parseWorkspace({ user: {}, organizations: 'nope' })).toThrow();
  });

  it('calls GET /auth/me/workspace with the access token', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(raw), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    setAccessToken('token-1');
    const workspace = await workspaceApi.current();
    expect(workspace.user.email).toBe('ada@example.com');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:3001/auth/me/workspace');
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer token-1');
  });
});
