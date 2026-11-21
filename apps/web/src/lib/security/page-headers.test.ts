import { describe, expect, it } from 'vitest';
import {
  AUTH_PAGE_SOURCES,
  contentSecurityPolicy,
  securityHeaderRules,
  WEB_HSTS_HEADER,
} from './page-headers';

const API = 'https://api.example.test';

/** The headers Next.js would send for a path: every matching rule in order, last value wins. */
function headersFor(rules: ReturnType<typeof securityHeaderRules>, ...sources: string[]) {
  const result: Record<string, string> = {};
  for (const rule of rules) {
    if (rule.source !== '/:path*' && !sources.includes(rule.source)) continue;
    for (const header of rule.headers) result[header.key] = header.value;
  }
  return result;
}

function directives(policy: string) {
  return Object.fromEntries(
    policy.split('; ').map((part) => {
      const [name, ...values] = part.split(' ');
      return [name!, values];
    }),
  );
}

describe('security header rules', () => {
  it('Batch R2: sends a Content Security Policy and baseline headers on every page', () => {
    const headers = headersFor(securityHeaderRules({ apiOrigin: API }), '/admin');
    expect(headers).toMatchObject({
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
    });
    expect(headers['Content-Security-Policy']).toBe(contentSecurityPolicy({ apiOrigin: API }));
    expect(headers['Cache-Control']).toBeUndefined();
  });

  it('production policy: no eval, no plugins or frames, connections only to the app and API', () => {
    const policy = directives(contentSecurityPolicy({ apiOrigin: `${API}/v1/` }));
    expect(policy['default-src']).toEqual(["'self'"]);
    expect(policy['script-src']).toEqual(["'self'", "'unsafe-inline'"]);
    expect(policy['script-src']).not.toContain("'unsafe-eval'");
    expect(policy['connect-src']).toEqual(["'self'", API]);
    expect(policy['object-src']).toEqual(["'none'"]);
    expect(policy['frame-src']).toEqual(["'none'"]);
    expect(policy['frame-ancestors']).toEqual(["'none'"]);
    expect(policy['base-uri']).toEqual(["'self'"]);
    expect(policy['form-action']).toEqual(["'self'"]);
    expect(policy['img-src']).toEqual(["'self'", 'data:', 'blob:', 'https:']);
  });

  it('development policy adds only what next dev needs', () => {
    const policy = directives(contentSecurityPolicy({ apiOrigin: API, development: true }));
    expect(policy['script-src']).toEqual(["'self'", "'unsafe-inline'", "'unsafe-eval'"]);
    expect(policy['connect-src']).toEqual(["'self'", API, 'ws:', 'wss:']);
    expect(policy['frame-ancestors']).toEqual(["'none'"]);
  });

  it('keeps the kiosk rules and protects every sign-in, recovery and account page', () => {
    const rules = securityHeaderRules({ apiOrigin: API });
    const csp = contentSecurityPolicy({ apiOrigin: API });
    expect(headersFor(rules, '/kiosk')).toMatchObject({
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': csp,
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
      'X-Robots-Tag': 'noindex, nofollow',
    });
    for (const source of [
      '/login',
      '/reset-password',
      '/accept-invitation',
      '/verify-email',
      '/account/:path*',
    ]) {
      expect(AUTH_PAGE_SOURCES).toContain(source);
      expect(headersFor(rules, source)).toMatchObject({
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'X-Frame-Options': 'DENY',
        'Content-Security-Policy': csp,
        'X-Robots-Tag': 'noindex, nofollow',
      });
    }
  });

  it('R5-A: production pages send HSTS for a year, without subdomains or preload; next dev does not', () => {
    expect(WEB_HSTS_HEADER).toBe('max-age=31536000');
    for (const path of ['/admin', '/login', '/kiosk', '/account/security']) {
      expect(headersFor(securityHeaderRules({ apiOrigin: API }), path)).toMatchObject({
        'Strict-Transport-Security': 'max-age=31536000',
      });
    }
    const development = headersFor(
      securityHeaderRules({ apiOrigin: API, development: true }),
      '/admin',
    );
    expect(development['Strict-Transport-Security']).toBeUndefined();
    expect(WEB_HSTS_HEADER).not.toMatch(/includeSubDomains|preload/i);
  });

  it('defines each header once per rule so no rule overrides another by accident', () => {
    for (const rule of securityHeaderRules({ apiOrigin: API })) {
      const keys = rule.headers.map((header) => header.key);
      expect(new Set(keys).size).toBe(keys.length);
      if (rule.source !== '/:path*') {
        expect(keys).not.toContain('Content-Security-Policy');
        expect(keys).not.toContain('X-Frame-Options');
      }
    }
  });
});
