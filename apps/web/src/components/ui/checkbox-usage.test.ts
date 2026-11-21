import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Batch 10F — every checkbox in the web app uses the shared 24 px `checkboxClass` (directly, or
 * through `switchClass` / a module `checkbox` alias that re-exports it), so none falls below the
 * WCAG 2.2 target size on a phone. The kiosk is the exception: its own 24 px dark-theme box.
 */
const ROOT = join(__dirname, '..');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return path.endsWith('.tsx') && !path.endsWith('.test.tsx') ? [path] : [];
  });
}

const FILES = sources(ROOT)
  .map((file) => ({ rel: relative(ROOT, file), text: readFileSync(file, 'utf8') }))
  .filter(({ rel }) => !rel.startsWith('kiosk'));

/** Every `<input …/>` tag; attributes may hold arrow functions (`=>`), so match to `/>`. */
const checkboxTags = (text: string) =>
  [...text.matchAll(/<input\b[\s\S]*?\/>/g)]
    .map((match) => match[0])
    .filter((tag) => /type=(?:"checkbox"|'checkbox'|\{\s*['"]checkbox['"]\s*\})/.test(tag));

describe('checkboxes', () => {
  it('all use the shared 24 px checkbox class', () => {
    const offenders: string[] = [];
    let count = 0;
    for (const { rel, text } of FILES) {
      for (const tag of checkboxTags(text)) {
        count += 1;
        const className = tag.match(/className=(\{[^}]*\}|"[^"]*")/)?.[1] ?? '';
        const shared =
          /\$\{checkboxClass\}/.test(className) ||
          /^\{\s*(checkboxClass|switchClass|checkbox)\s*\}$/.test(className);
        if (!shared) offenders.push(`${rel}: ${className || '(no className)'}`);
      }
    }
    expect(count).toBeGreaterThan(50);
    expect(offenders).toEqual([]);
  });

  it('module aliases are the shared class, never a style of their own', () => {
    const offenders: string[] = [];
    for (const { rel, text } of FILES) {
      // `checkbox` / `switchClass` must not be defined as a string (re-export checkboxClass).
      if (/\b(?:const|let)\s+(?:checkbox|switchClass)\s*=\s*['"`]/.test(text)) offenders.push(rel);
      for (const tag of checkboxTags(text))
        if (/\b(?:size|h|w)-[345]\b/.test(tag)) offenders.push(`${rel}: sized below 24 px`);
    }
    expect(offenders).toEqual([]);
  });
});
