import { expect, test, type Page } from '@playwright/test';
import { API } from './support/api-origin';
import { expectNoSeriousA11yViolations } from './support/axe';
import {
  application,
  json,
  ONBOARDING_HR,
  onboardingServer,
  path,
  RECRUITER,
  recruitmentServer,
  session,
  workflow,
} from './support/recruitment-onboarding-mocks';

/**
 * Batch 10E-1 — Recruitment and Onboarding screens against a mocked API with long, realistic
 * values:
 * - /admin/recruitment and /admin/onboarding keep their `#hash` deep links, write the picked
 *   tab into the URL (the query is kept) and follow the keyboard and Back/Forward;
 * - every table scrolls inside a named, keyboard-focusable region, nothing widens the page and
 *   axe finds nothing serious at 1280, 820 and 375 px;
 * - loading, denied and loaded states share the page's width, and "Access denied" never flashes
 *   while permissions load;
 * - the application page keeps its sections per view (an interviewer sees no screening or
 *   offers), its small buttons are at least 24 px, a stage move is sent once, and confirmations
 *   return focus.
 */
const VIEWPORTS = {
  desktop: { width: 1280, height: 800 },
  tablet: { width: 820, height: 1180 },
  phone: { width: 375, height: 812 },
} as const;
const LONG_TITLE = 'Senior Early Childhood Educator and Before-and-After School Coordinator';
const LONG_NAME = 'Alexandria Montgomery-Fitzgerald';

async function pageOverflow(page: Page) {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

/** Every horizontally scrolling table container is a named, focusable region. */
async function scrollersAreAccessible(page: Page) {
  const offenders = await page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>('main *'))
      .filter((el) => {
        const style = getComputedStyle(el);
        return (
          (style.overflowX === 'auto' || style.overflowX === 'scroll') &&
          el.scrollWidth > el.clientWidth + 1 &&
          el.querySelector('table') !== null
        );
      })
      .filter(
        (el) =>
          !(el.getAttribute('role') === 'region' && el.getAttribute('aria-label')) ||
          el.tabIndex < 0,
      )
      .map((el) => el.className),
  );
  expect(offenders).toEqual([]);
}

async function checkAtAllWidths(page: Page, ready: () => Promise<void>) {
  for (const size of [VIEWPORTS.desktop, VIEWPORTS.tablet, VIEWPORTS.phone]) {
    await page.setViewportSize(size);
    await ready();
    await expect.poll(() => pageOverflow(page)).toBeLessThanOrEqual(1);
    await scrollersAreAccessible(page);
    await expectNoSeriousA11yViolations(page);
  }
  await page.setViewportSize(VIEWPORTS.desktop);
}

/** The width of the page's outer container (`main`'s first child). */
const frameWidth = (page: Page) =>
  page
    .evaluate(() => {
      const first = document.querySelector('main')?.firstElementChild as HTMLElement | null;
      return first ? Math.round(first.getBoundingClientRect().width) : 0;
    })
    .catch(() => 0);

/** Samples the frame's width until `done` is visible; it must never change. */
async function widthsUntil(page: Page, done: ReturnType<Page['getByRole']>) {
  const widths: number[] = [];
  let sawDenied = false;
  for (let i = 0; i < 120 && !(await done.isVisible().catch(() => false)); i += 1) {
    // Batch 10F: the route skeleton is sampled too — it renders in the page's own width.
    const width = await frameWidth(page);
    if (width) widths.push(width);
    sawDenied ||= await page
      .getByRole('heading', { name: 'Access denied' })
      .isVisible()
      .catch(() => false);
    await page.waitForTimeout(40);
  }
  await expect(done).toBeVisible();
  widths.push(await frameWidth(page));
  return { widths: [...new Set(widths)], sawDenied };
}

const tab = (page: Page, name: string) => page.getByRole('tab', { name, exact: true });

// ─── Recruitment administration ─────────────────────────────────────────────

test('/admin/recruitment: #hash links open a section; picking a tab writes it; keys and Back/Forward follow', async ({
  page,
}) => {
  await session(page, RECRUITER);
  await recruitmentServer(page);

  await page.goto('/admin/recruitment#candidates');
  await expect(tab(page, 'Candidates')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('region', { name: 'Candidates' })).toBeVisible();

  // Picking a tab names it in the address bar (before: the hash was cleared).
  await tab(page, 'Intake').click();
  await expect(page).toHaveURL(/\/admin\/recruitment#intake$/);
  await expect(page.getByRole('region', { name: 'Intake sources' })).toBeVisible();

  // Arrow keys move between tabs and write the URL too.
  await tab(page, 'Intake').focus();
  await page.keyboard.press('ArrowRight');
  await expect(tab(page, 'Settings')).toHaveAttribute('aria-selected', 'true');
  await expect(tab(page, 'Settings')).toBeFocused();
  await expect(page).toHaveURL(/#settings$/);

  // A same-page #link (a new history entry) and Back/Forward.
  await page.evaluate(() => {
    window.location.hash = 'pipeline';
  });
  await expect(tab(page, 'Pipeline')).toHaveAttribute('aria-selected', 'true');
  await page.goBack();
  await expect(tab(page, 'Settings')).toHaveAttribute('aria-selected', 'true');
  await page.goForward();
  await expect(tab(page, 'Pipeline')).toHaveAttribute('aria-selected', 'true');

  // On a fresh load, a hash that names no section opens the dashboard.
  await page.goto('about:blank');
  await page.goto('/admin/recruitment#nothing-here');
  await expect(tab(page, 'Dashboard')).toHaveAttribute('aria-selected', 'true');
});

test('/admin/recruitment: every section fits, passes axe and scrolls its tables in named regions', async ({
  page,
}) => {
  await session(page, RECRUITER);
  await recruitmentServer(page);
  const sections: Array<[string, string, string[]]> = [
    ['Dashboard', 'dashboard', ['Pipeline by opening']],
    ['Openings', 'openings', ['Openings']],
    ['Pipeline', 'pipeline', ['Applications']],
    ['Candidates', 'candidates', ['Candidates']],
    ['Intake', 'intake', ['Intake sources', 'Submissions waiting for an opening']],
    ['Settings', 'settings', ['Hiring stages']],
  ];
  for (const [name, hash, regions] of sections) {
    await page.goto(`/admin/recruitment#${hash}`);
    await expect(tab(page, name)).toHaveAttribute('aria-selected', 'true');
    await checkAtAllWidths(page, async () => {
      for (const region of regions) {
        const scroller = page.getByRole('region', { name: region, exact: true });
        await expect(scroller).toBeVisible();
        await expect(scroller).toHaveAttribute('tabindex', '0');
      }
    });
  }
  // Statuses say what they are in words, and rows are named by their record.
  await page.goto('/admin/recruitment#openings');
  const openings = page.getByRole('region', { name: 'Openings', exact: true });
  await expect(
    openings.getByRole('rowheader', { name: new RegExp(`^${LONG_TITLE}`) }),
  ).toBeVisible();
  await expect(openings.getByText('On Hold', { exact: true })).toBeVisible();
  await expect(openings.getByText('Budget review')).toBeVisible();
  await expect(openings.getByRole('columnheader', { name: 'Actions' })).toBeAttached();
});

test('the opening editor fits a phone, and putting an opening on hold asks for a reason', async ({
  page,
}) => {
  await session(page, RECRUITER);
  await recruitmentServer(page);
  await page.goto('/admin/recruitment#openings');
  await page.getByRole('button', { name: 'New opening' }).click();
  const form = page.getByRole('form', { name: 'Create opening' });
  await checkAtAllWidths(page, async () => {
    await expect(form.getByLabel('Requisition code')).toBeVisible();
    await expect(form.getByRole('button', { name: 'Create opening' })).toBeVisible();
  });
  await form.getByRole('button', { name: 'Cancel editing' }).click();

  const hold = page.getByRole('button', { name: `Put on hold ${LONG_TITLE}`, exact: true });
  await hold.click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText(`Put on hold ${LONG_TITLE}?`);
  await expect(dialog.getByRole('button', { name: 'Put on hold opening' })).toBeDisabled();
  await expectNoSeriousA11yViolations(page);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(hold).toBeFocused();
});

// ─── Application, candidate and interviews ──────────────────────────────────

test('an application: every section fits and passes axe, small buttons are 24 px, a move is sent once', async ({
  page,
}) => {
  await session(page, RECRUITER);
  const calls = await recruitmentServer(page);
  await page.route(path('/recruitment/applications/app-1'), (route) =>
    json(route, application('FULL')),
  );
  await page.goto('/recruitment/applications/app-1');
  await expect(page.getByRole('heading', { level: 1 })).toContainText(LONG_NAME);

  const main = page.getByRole('main');
  for (const region of ['Hiring journey', 'Screening', 'Interviews', 'Offers', 'Stage history'])
    await expect(main.getByRole('region', { name: region, exact: true })).toBeVisible();
  for (const form of ['Move stage', 'Schedule interview', 'Draft offer'])
    await expect(main.getByRole('form', { name: form })).toBeVisible();
  await expect(main.getByRole('region', { name: 'Close application' })).toBeVisible();
  await expect(
    main.getByText('Panel interview with the leadership team', { exact: true }),
  ).toBeVisible();
  await expect(main.getByText('Scheduled', { exact: true })).toBeVisible();

  await checkAtAllWidths(page, async () => {
    await expect(main.getByRole('region', { name: 'Interviews', exact: true })).toBeVisible();
  });

  // Removing an interviewer is a real target (was 6 × 16 px).
  await page.setViewportSize(VIEWPORTS.phone);
  for (const email of ['grace.hopper@example.org', 'ken.thompson@example.org']) {
    const box = await page
      .getByRole('button', { name: `Remove interviewer ${email}` })
      .boundingBox();
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(24);
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(24);
  }
  await page.setViewportSize(VIEWPORTS.desktop);

  // A stage move is sent once: the button is disabled while the request runs.
  const move = main.getByRole('form', { name: 'Move stage' });
  await move.getByLabel('Move to stage').selectOption({ label: 'Classroom assessment' });
  await move.getByRole('button', { name: 'Move' }).click();
  await expect(move.getByRole('button', { name: 'Move' })).toBeDisabled();
  await move.getByRole('button', { name: 'Move' }).click({ force: true });
  await expect(page.getByText('Stage changed.')).toBeVisible();
  expect(calls.moveStage).toBe(1);

  // Withdrawing asks first; cancelling returns focus to the button.
  const withdraw = main.getByRole('button', { name: 'Withdraw application' });
  await withdraw.click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText(`Withdraw ${LONG_NAME}'s application?`);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(withdraw).toBeFocused();
});

test('an interviewer sees the candidate, the stage and their interviews, never screening, offers or contact details', async ({
  page,
}) => {
  await session(page, ['recruitment.read']);
  await page.route(path('/recruitment/applications/app-1'), (route) =>
    json(route, application('INTERVIEWER')),
  );
  await page.goto('/recruitment/applications/app-1');
  await expect(page.getByRole('heading', { level: 1 })).toContainText(LONG_NAME);
  const main = page.getByRole('main');
  await expect(main.getByRole('region', { name: 'My interviews' })).toBeVisible();
  for (const hidden of ['Screening', 'Offers', 'Close application', 'Stage history'])
    await expect(main.getByRole('region', { name: hidden, exact: true })).toHaveCount(0);
  await expect(main.getByRole('form', { name: 'Move stage' })).toHaveCount(0);
  await expect(main).not.toContainText('alexandria.montgomery-fitzgerald@example.org');
  await expect(main.getByRole('link', { name: 'Candidate profile' })).toHaveCount(0);
  await checkAtAllWidths(page, async () => {
    await expect(main.getByRole('region', { name: 'My interviews' })).toBeVisible();
  });
});

test('a candidate: the applications table is a named region and each link names its opening', async ({
  page,
}) => {
  await session(page, RECRUITER);
  await recruitmentServer(page);
  await page.goto('/recruitment/candidates/cand-1');
  await expect(page.getByRole('heading', { level: 1, name: LONG_NAME })).toBeVisible();
  const applications = page.getByRole('region', {
    name: `Applications of ${LONG_NAME}`,
    exact: true,
  });
  await expect(
    applications.getByRole('link', { name: `Open the application for ${LONG_TITLE}` }),
  ).toHaveAttribute('href', '/recruitment/applications/app-1');
  await checkAtAllWidths(page, async () => {
    await expect(applications).toBeVisible();
  });
});

// ─── Loading and denied states ──────────────────────────────────────────────

for (const target of [
  { path: '/admin/recruitment', heading: 'Recruitment', permissions: RECRUITER },
  { path: '/admin/onboarding', heading: 'Onboarding & offboarding', permissions: ONBOARDING_HR },
]) {
  test(`${target.path}: loading, never "Access denied", in the page's width while permissions load`, async ({
    page,
  }) => {
    await session(page, target.permissions, { authorizationDelayMs: 1_500 });
    await recruitmentServer(page);
    await onboardingServer(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(target.path, { waitUntil: 'commit' });
    const { widths, sawDenied } = await widthsUntil(
      page,
      page.getByRole('heading', { level: 1, name: target.heading }),
    );
    expect(sawDenied).toBe(false);
    expect(widths).toHaveLength(1);
  });
}

test('an onboarding workflow loads and renders in one width', async ({ page }) => {
  await session(page, ONBOARDING_HR);
  await page.route(path('/onboarding/workflows/wf-1'), async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    await json(route, workflow());
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/onboarding/workflows/wf-1', { waitUntil: 'commit' });
  const { widths } = await widthsUntil(
    page,
    page.getByRole('heading', { level: 1, name: `Onboarding: ${LONG_NAME}` }),
  );
  expect(widths).toHaveLength(1);
});

test('without access, recruitment and onboarding show the denied state in the page width (no onboarding data)', async ({
  page,
}) => {
  await session(page, ['employee.read'], { authorizationDelayMs: 800 });
  // A user with no recruitment permission and no opening they hire for.
  await page.route(path('/recruitment/organizations'), (route) => json(route, { items: [] }));
  const onboardingRequests: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.origin === API && url.pathname.startsWith('/onboarding/'))
      onboardingRequests.push(url.pathname);
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const target of ['/admin/recruitment', '/admin/onboarding']) {
    await page.goto(target, { waitUntil: 'commit' });
    const { widths } = await widthsUntil(
      page,
      page.getByRole('heading', { level: 1, name: 'Access denied' }),
    );
    // Loading and denied share the page's width (before: a narrow denied page).
    expect(widths).toHaveLength(1);
    await expectNoSeriousA11yViolations(page);
  }
  expect(onboardingRequests).toEqual([]);
});

// ─── Onboarding administration ──────────────────────────────────────────────

test('/admin/onboarding: #hash links open a section and picking a tab keeps the query', async ({
  page,
}) => {
  await session(page, ONBOARDING_HR);
  await onboardingServer(page);
  await page.goto('/admin/onboarding?source=profile#templates');
  await expect(tab(page, 'Templates')).toHaveAttribute('aria-selected', 'true');
  await tab(page, 'Import').click();
  await expect(page).toHaveURL(/\/admin\/onboarding\?source=profile#import$/);
  await tab(page, 'Import').focus();
  await page.keyboard.press('ArrowLeft');
  await expect(tab(page, 'Templates')).toHaveAttribute('aria-selected', 'true');
  await expect(page).toHaveURL(/\?source=profile#templates$/);
});

test('/admin/onboarding: every section fits, passes axe and scrolls its tables in named regions', async ({
  page,
}) => {
  await session(page, ONBOARDING_HR);
  await onboardingServer(page);
  const sections: Array<[string, string, string[]]> = [
    ['Onboarding', 'onboarding', ['Onboarding workflows']],
    ['Offboarding', 'offboarding', ['Offboarding workflows']],
    ['Start', 'start', []],
    ['Templates', 'templates', ['Templates']],
    ['Import', 'import', []],
  ];
  for (const [name, hash, regions] of sections) {
    await page.goto(`/admin/onboarding#${hash}`);
    await expect(tab(page, name)).toHaveAttribute('aria-selected', 'true');
    await checkAtAllWidths(page, async () => {
      for (const region of regions) {
        const scroller = page.getByRole('region', { name: region, exact: true });
        await expect(scroller).toBeVisible();
        await expect(scroller).toHaveAttribute('tabindex', '0');
      }
    });
  }
  await page.goto('/admin/onboarding');
  const workflows = page.getByRole('region', { name: 'Onboarding workflows', exact: true });
  await expect(
    workflows.getByRole('rowheader', { name: new RegExp(`^${LONG_NAME}`) }),
  ).toBeVisible();
  await expect(workflows.getByText('Active', { exact: true })).toBeVisible();
});

test('the template and task editors fit a phone and pass axe', async ({ page }) => {
  await session(page, ONBOARDING_HR);
  await onboardingServer(page);
  await page.goto('/admin/onboarding#templates');
  await page
    .getByRole('button', { name: 'Edit Educator onboarding (full-time, Toronto campus)' })
    .click();
  await checkAtAllWidths(page, async () => {
    await expect(page.getByRole('textbox', { name: /Title/ }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save template' })).toBeVisible();
  });
});

test('importing completions: invalid JSON is refused, outcomes are a named table', async ({
  page,
}) => {
  await session(page, ONBOARDING_HR);
  await onboardingServer(page);
  let imported = 0;
  await page.route(path('/onboarding/task-completions/import'), (route) => {
    imported += 1;
    return json(route, {
      outcomes: [
        { externalResponseId: 'resp-1', outcome: 'COMPLETED', taskId: 'tk-1' },
        { externalResponseId: 'resp-2', outcome: 'SKIPPED', reason: 'NO_MATCHING_EMPLOYEE' },
      ],
    });
  });
  await page.goto('/admin/onboarding#import');
  const form = page.getByRole('form', { name: 'Import task completions' });
  await form.getByLabel(/Submissions/).fill('{ not json');
  await form.getByRole('button', { name: 'Import' }).click();
  await expect(form.getByRole('alert')).toHaveText('Enter a JSON array of submissions.');
  expect(imported).toBe(0);
  await form.getByLabel(/Submissions/).fill('[{"externalResponseId":"resp-1"}]');
  await form.getByRole('button', { name: 'Import' }).click();
  const outcomes = page.getByRole('region', { name: 'Import outcomes' });
  await expect(outcomes.getByRole('rowheader', { name: 'resp-2' })).toBeVisible();
  await expect(outcomes).toContainText('No Matching Employee');
  await checkAtAllWidths(page, async () => {
    await expect(outcomes).toBeVisible();
  });
});

test('an onboarding workflow: task statuses in words, the tasks table scrolls in a named region', async ({
  page,
}) => {
  await session(page, ONBOARDING_HR);
  await onboardingServer(page);
  await page.goto('/onboarding/workflows/wf-1');
  await expect(
    page.getByRole('heading', { level: 1, name: `Onboarding: ${LONG_NAME}` }),
  ).toBeVisible();
  const tasks = page.getByRole('region', { name: 'Workflow tasks', exact: true });
  await expect(tasks).toHaveAttribute('tabindex', '0');
  for (const status of ['COMPLETED', 'IN_PROGRESS', 'WAIVED', 'OVERDUE'])
    await expect(tasks.locator(`[data-status="${status}"]`)).toBeVisible();
  await expect(tasks.locator('[data-status="IN_PROGRESS"]')).toHaveText('In Progress');
  await checkAtAllWidths(page, async () => {
    await expect(tasks).toBeVisible();
  });
});
