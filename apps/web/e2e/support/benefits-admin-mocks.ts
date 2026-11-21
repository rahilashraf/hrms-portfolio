import { expect, type Page, type Route } from '@playwright/test';
import { API } from './api-origin';
import { expectNoSeriousA11yViolations } from './axe';

// Batch 10E-2: moved unchanged from e2e/batch-7c-benefits-admin.spec.ts so batch-10e2.spec.ts can reuse it.
const VIEWPORTS = {
  desktop: { width: 1280, height: 800 },
  tablet: { width: 820, height: 1180 },
  phone: { width: 375, height: 812 },
} as const;

const identity = {
  id: 'benefits-admin',
  personId: 'person-benefits-admin',
  email: 'benefits-admin@example.com',
  status: 'ACTIVE',
  emailVerifiedAt: null,
  mustChangePassword: false,
};

export const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

export async function signedIn(page: Page, permissions: string[]) {
  let signed = false;
  await page.route('**/auth/refresh', (route) =>
    signed ? json(route, { accessToken: '7c-admin', identity }, 201) : json(route, {}, 401),
  );
  await page.route('**/auth/login', (route) => {
    signed = true;
    return json(route, { accessToken: '7c-admin', identity }, 201);
  });
  await page.route('**/auth/me', (route) =>
    signed ? json(route, identity) : json(route, {}, 401),
  );
  await page.route('**/auth/me/authorization', (route) =>
    json(route, {
      userId: identity.id,
      permissions: permissions.map((key) => ({
        key,
        scopes: [{ type: 'ORGANIZATION', id: 'org-1' }],
      })),
    }),
  );
  await page.goto('/login');
  await page.getByLabel('Email').fill(identity.email);
  await page.getByLabel('Password').fill('test-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}

export async function checkAt(page: Page) {
  for (const size of Object.values(VIEWPORTS)) {
    await page.setViewportSize(size);
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        ),
      )
      .toBeLessThanOrEqual(1);
    await expectNoSeriousA11yViolations(page);
  }
  await page.setViewportSize(VIEWPORTS.desktop);
}

/** A stateful benefits API for one organization. */
export function benefitsWorld(page: Page) {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const plans: Array<Record<string, unknown>> = [];
  const options: Array<Record<string, unknown>> = [];
  const rates: Array<Record<string, unknown>> = [];
  const rules: Array<Record<string, unknown>> = [];
  const actions = (plan: Record<string, unknown>) => ({
    canEdit: !plan.archived,
    canEditStart: plan.status === 'DRAFT',
    canActivate: plan.status !== 'ACTIVE' && options.length > 0,
    canClose: plan.status === 'ACTIVE',
    canArchive: false,
    canManageOptions: true,
    canManageRates: true,
    canManageEligibility: true,
  });
  const detail = (plan: Record<string, unknown>) => ({
    ...plan,
    organization: { id: 'org-1', name: 'Camp', timezone: 'America/Toronto' },
    asOf: '2026-03-15',
    actions: actions(plan),
    options: options.map((option) => ({
      ...option,
      currentAndFutureEnrollments: 0,
      actions: { canEdit: true, canArchive: true },
    })),
    rates: rates.map((rate) => ({ ...rate, actions: { canCorrect: !rate.supersededAt } })),
    eligibilityRules: rules,
  });
  const record = (route: Route) => {
    const request = route.request();
    calls.push({
      method: request.method(),
      path: new URL(request.url()).pathname,
      body: request.postData() ? (request.postDataJSON() as unknown) : undefined,
    });
    return request.postData() ? (request.postDataJSON() as Record<string, unknown>) : {};
  };

  return {
    calls,
    async install() {
      await page.route(`${API}/benefits/organizations`, (route) =>
        json(route, {
          items: [
            {
              id: 'org-1',
              name: 'Camp',
              code: 'CAMP',
              timezone: 'America/Toronto',
              actions: { canManagePlans: true },
            },
          ],
        }),
      );
      await page.route(`${API}/benefits/attention?*`, (route) => json(route, { items: [] }));
      await page.route(`${API}/benefits/options?*`, (route) => {
        const kind = new URL(route.request().url()).searchParams.get('kind');
        return json(route, {
          items:
            kind === 'department'
              ? [{ id: 'dept-a', label: 'Dept A', description: 'DA' }]
              : kind === 'unit'
                ? [{ id: 'unit-1', label: 'Elementary', description: 'EL' }]
                : [],
          nextAfterId: null,
        });
      });
      await page.route(`${API}/benefits/plans?*`, (route) =>
        json(route, {
          items: plans.map((plan) => ({
            ...plan,
            optionCount: options.length,
            actions: actions(plan),
          })),
        }),
      );
      await page.route(`${API}/benefits/plans`, (route) => {
        const body = record(route);
        const plan = {
          id: 'plan-1',
          organizationId: 'org-1',
          status: 'DRAFT',
          archived: false,
          description: null,
          providerName: null,
          providerReference: null,
          dependentChildMaxAge: null,
          showEmployerCostToEmployee: false,
          employerContributionTaxable: false,
          effectiveTo: null,
          ...body,
        };
        plans.push(plan);
        return json(route, plan, 201);
      });
      await page.route(`${API}/benefits/plans/plan-1`, (route) => {
        if (route.request().method() === 'PATCH') {
          Object.assign(plans[0]!, record(route));
          return json(route, plans[0]);
        }
        return json(route, detail(plans[0]!));
      });
      await page.route(`${API}/benefits/plans/plan-1/*`, (route) => {
        const path = new URL(route.request().url()).pathname;
        const body = record(route);
        if (path.endsWith('/options')) {
          const option = {
            id: `opt-${options.length + 1}`,
            planId: 'plan-1',
            sortOrder: options.length,
            archived: false,
            ...body,
          };
          options.push(option);
          return json(route, option, 201);
        }
        if (path.endsWith('/activate')) plans[0]!.status = 'ACTIVE';
        if (path.endsWith('/close')) plans[0]!.status = 'CLOSED';
        if (path.endsWith('/eligibility-rules')) {
          const rule: Record<string, unknown> = {
            id: `rule-${rules.length + 1}`,
            effectiveTo: null,
            organizationalUnitId: null,
            organizationalUnitName: null,
            includeSubunits: true,
            departmentId: null,
            departmentName: null,
            positionId: null,
            positionName: null,
            employmentTypes: [],
            minimumServiceDays: null,
            ...body,
          };
          if (rule.departmentId === 'dept-a') rule.departmentName = 'Dept A';
          rules.push(rule);
          return json(route, rule, 201);
        }
        if (path.endsWith('/discontinue')) {
          plans[0]!.effectiveTo = (body as { effectiveTo: string }).effectiveTo;
          return json(route, { electionsEnded: 0, electionsRescinded: 0 }, 201);
        }
        return json(route, plans[0], 201);
      });
      await page.route(`${API}/benefits/options/*`, (route) => {
        const body = record(route);
        const id = new URL(route.request().url()).pathname.split('/')[3]!;
        const option = options.find((o) => o.id === id)!;
        Object.assign(option, body);
        return json(route, option);
      });
      await page.route(`${API}/benefits/options/*/rates`, (route) => {
        const body = record(route);
        const optionId = new URL(route.request().url()).pathname.split('/')[3]!;
        const rate = {
          id: `rate-${rates.length + 1}`,
          optionId,
          effectiveTo: null,
          currency: 'CAD',
          recordType: 'INITIAL',
          supersededAt: null,
          reason: null,
          ...body,
        };
        rates.push(rate);
        return json(route, rate, 201);
      });
      await page.route(`${API}/benefits/rates/*/correct`, (route) => {
        const body = record(route);
        const id = new URL(route.request().url()).pathname.split('/')[3]!;
        const original = rates.find((r) => r.id === id)!;
        original.supersededAt = '2026-03-15T12:00:00Z';
        const corrected = {
          ...original,
          ...body,
          id: `rate-${rates.length + 1}`,
          recordType: 'CORRECTION',
          supersededAt: null,
        };
        rates.push(corrected);
        return json(route, corrected, 201);
      });
      await page.route(`${API}/benefits/eligibility-rules/*/end`, (route) => {
        const body = record(route) as { effectiveTo: string };
        rules[0]!.effectiveTo = body.effectiveTo;
        return json(route, rules[0], 201);
      });
    },
  };
}
