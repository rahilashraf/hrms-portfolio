import { expect } from 'vitest';
import { configureAxe } from 'vitest-axe';

/**
 * Batch 3B — axe-core accessibility checks for component tests (vitest-axe). jsdom has no
 * layout or computed colors, so color contrast is left to the Playwright checks on real pages;
 * `region` is page-level (a component rendered alone has no landmarks).
 */
const axe = configureAxe({
  rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
});

/** Fails with a readable list (rule, impact, element) when axe finds any violation. */
export async function expectNoAxeViolations(container: Element) {
  const results = await axe(container);
  expect(
    results.violations.map(
      (violation) =>
        `${violation.id} (${violation.impact}): ${violation.nodes
          .map((node) => node.target.join(' '))
          .join(', ')}`,
    ),
  ).toEqual([]);
}
