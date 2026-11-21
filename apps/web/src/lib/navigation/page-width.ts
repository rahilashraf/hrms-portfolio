import type { PageWidth } from '../../components/ui/page-container';

/**
 * Batch 10F — the page width of each signed-in route, so the route-level loading skeleton (and
 * other route-wide fallbacks) render in the same frame as the page that replaces them. Pages
 * keep choosing their own width with `PageContainer`; this table mirrors those choices and
 * `page-width.test.ts` plus the `ui-acceptance` Playwright suite keep the two in step.
 *
 * Rules are matched in order against the path (without query or hash); the first match wins.
 * A rule matches its own path and every path below it, unless it is `exact`.
 */
interface WidthRule {
  path: string;
  width: PageWidth;
  exact?: boolean;
}

const RULES: readonly WidthRule[] = [
  // Narrow: one form or a list of preferences.
  { path: '/notifications/preferences', width: 'narrow' },
  { path: '/account/security', width: 'narrow' },
  // Full: calendars and dense planning grids.
  { path: '/admin/leave', width: 'full' },
  { path: '/admin/time', width: 'full' },
  { path: '/admin/scheduling', width: 'full' },
  // Default exceptions below wide administration areas.
  { path: '/admin/employees/', width: 'default' },
  { path: '/admin/organizations', width: 'default', exact: true },
  // Wide: many-column tables and dashboards.
  { path: '/dashboard', width: 'wide' },
  { path: '/admin/access-control', width: 'wide' },
  { path: '/admin/audit', width: 'wide' },
  { path: '/admin/benefits', width: 'wide' },
  { path: '/admin/documents', width: 'wide' },
  { path: '/admin/employees', width: 'wide', exact: true },
  { path: '/admin/notifications', width: 'wide' },
  { path: '/admin/onboarding', width: 'wide' },
  { path: '/admin/payroll', width: 'wide' },
  { path: '/admin/performance', width: 'wide' },
  { path: '/admin/recruitment', width: 'wide' },
  { path: '/admin/settings', width: 'wide' },
  { path: '/leave', width: 'wide' },
  { path: '/time', width: 'wide' },
  { path: '/onboarding/workflows', width: 'wide' },
  { path: '/reports', width: 'wide' },
  { path: '/settings/integrations', width: 'wide' },
];

/** `/admin/organizations/{id}/{resource}` is wide, except the overview and physical sites. */
const ORGANIZATION_RESOURCE = /^\/admin\/organizations\/[^/]+\/(?!physical-sites$)[^/]+$/;

function matches(pathname: string, rule: WidthRule): boolean {
  if (rule.path.endsWith('/')) return pathname.startsWith(rule.path);
  if (pathname === rule.path) return true;
  return !rule.exact && pathname.startsWith(`${rule.path}/`);
}

/** The `PageContainer` width the page at `pathname` renders; `default` for anything unlisted. */
export function pageWidthFor(pathname: string | null | undefined): PageWidth {
  const path = (pathname ?? '').split(/[?#]/)[0].replace(/\/+$/, '') || '/';
  if (ORGANIZATION_RESOURCE.test(path)) return 'wide';
  return RULES.find((rule) => matches(path, rule))?.width ?? 'default';
}
