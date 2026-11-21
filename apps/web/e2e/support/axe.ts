import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

/**
 * Batch 3B — axe-core on the current page (WCAG 2.1 A and AA rules). Serious and critical
 * violations fail the test, listed by rule and element so the report says what to fix.
 */
export async function expectNoSeriousA11yViolations(
  page: Page,
  { exclude = [] }: { exclude?: string[] } = {},
) {
  expect(await seriousA11yViolations(page, { exclude })).toEqual([]);
}

/**
 * The serious and critical violations on the current page, one line per rule. For a page with a
 * known violation awaiting its fix PR, assert this list exactly (so any new violation still fails).
 */
export async function seriousA11yViolations(
  page: Page,
  { exclude = [] }: { exclude?: string[] } = {},
) {
  let builder = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']);
  for (const selector of exclude) builder = builder.exclude(selector);
  const results = await builder.analyze();
  return results.violations
    .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
    .map(
      (violation) =>
        `${violation.id} (${violation.impact}): ${violation.nodes
          .slice(0, 5)
          .map((node) => node.target.join(' '))
          .join(', ')}`,
    );
}
