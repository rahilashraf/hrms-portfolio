/** Response headers for pages that must never be cached, framed or leak a referrer. */
export interface HeaderRule {
  source: string;
  headers: Array<{ key: string; value: string }>;
}

export interface ContentSecurityPolicyOptions {
  /** Origin of the API the browser calls (NEXT_PUBLIC_API_URL), e.g. https://api.example.com. */
  apiOrigin: string;
  /** `next dev`: React Refresh needs `eval` and the dev server's WebSocket. Never in production. */
  development?: boolean;
}

/**
 * Batch R2 (I1): one Content Security Policy for every page.
 *
 * - Scripts: only this origin. Next.js App Router pages carry inline bootstrap scripts
 *   (`self.__next_f.push(…)`) whose content differs per page and build, so they cannot be
 *   allow-listed by hash, and a per-request nonce would force every page to render dynamically
 *   (no static pages). `'unsafe-inline'` therefore stays for scripts; `'unsafe-eval'` is only
 *   added for `next dev`. The app renders no user HTML (no `dangerouslySetInnerHTML`), React
 *   escapes text, and the rest of the policy blocks plugins, base-URL and form hijacking,
 *   framing, and data exfiltration to other origins.
 * - Styles: `'unsafe-inline'` for React `style` attributes and Next.js font styles.
 * - Images: this origin, `data:`/`blob:` previews, and any `https:` image, because an
 *   organization's branding logo is an administrator-entered HTTPS URL.
 * - Connections: this origin and the API origin only.
 * - No frames, objects or plugins; nothing may frame the app (`frame-ancestors 'none'`).
 */
export function contentSecurityPolicy({
  apiOrigin,
  development = false,
}: ContentSecurityPolicyOptions): string {
  const origin = new URL(apiOrigin).origin;
  const directives: Array<[string, string[]]> = [
    ['default-src', ["'self'"]],
    ['script-src', ["'self'", "'unsafe-inline'", ...(development ? ["'unsafe-eval'"] : [])]],
    ['style-src', ["'self'", "'unsafe-inline'"]],
    ['img-src', ["'self'", 'data:', 'blob:', 'https:']],
    ['font-src', ["'self'", 'data:']],
    ['connect-src', ["'self'", origin, ...(development ? ['ws:', 'wss:'] : [])]],
    ['worker-src', ["'self'", 'blob:']],
    ['manifest-src', ["'self'"]],
    ['frame-src', ["'none'"]],
    ['object-src', ["'none'"]],
    ['base-uri', ["'self'"]],
    ['form-action', ["'self'"]],
    ['frame-ancestors', ["'none'"]],
  ];
  return directives.map(([name, values]) => `${name} ${values.join(' ')}`).join('; ');
}

/**
 * R5-A: HTTPS only, for a year, on the web app's own host. The production app is served over
 * HTTPS (the API it calls must be https). No `includeSubDomains` (the API sets its own) and no
 * `preload` (hard to undo). Browsers ignore the header on plain HTTP, so a local `next start`
 * on http://localhost is unaffected; `next dev` does not send it.
 */
export const WEB_HSTS_HEADER = 'max-age=31536000';

/** Every page: the CSP above, no framing, no MIME sniffing, a conservative referrer; HSTS in production. */
function everyPage(options: ContentSecurityPolicyOptions) {
  return [
    { key: 'Content-Security-Policy', value: contentSecurityPolicy(options) },
    { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    ...(options.development ? [] : [{ key: 'Strict-Transport-Security', value: WEB_HSTS_HEADER }]),
  ];
}

/**
 * Pages that carry credentials or single-use links. Applied after the every-page rule: the
 * stricter `Referrer-Policy` replaces it (Next.js keeps the last value for a repeated key), and
 * the CSP and `X-Frame-Options` come from the every-page rule, so no value is defined twice.
 */
const PRIVATE_PAGE = [
  { key: 'Cache-Control', value: 'no-store' },
  { key: 'Referrer-Policy', value: 'no-referrer' },
  { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
];

/**
 * Batch 2: the sign-in, recovery and account security pages carry credentials or single-use
 * links (in the URL fragment): never cached, framed (clickjacking) or indexed, and no referrer.
 */
export const AUTH_PAGE_SOURCES = [
  '/login',
  '/forgot-password',
  '/reset-password',
  '/accept-invitation',
  '/verify-email',
  '/resend-verification',
  '/account/:path*',
] as const;

export function securityHeaderRules(options: ContentSecurityPolicyOptions): HeaderRule[] {
  return [
    { source: '/:path*', headers: everyPage(options) },
    // Phase 9.5 — the onsite kiosk: also no camera, microphone or location use.
    {
      source: '/kiosk',
      headers: [
        ...PRIVATE_PAGE,
        { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
      ],
    },
    ...AUTH_PAGE_SOURCES.map((source) => ({ source, headers: PRIVATE_PAGE })),
  ];
}
