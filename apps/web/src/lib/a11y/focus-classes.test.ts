import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Batch 11C — a static guard for keyboard focus styles across the web app's source.
 *
 * - `outline-none` removes the outline even in Windows forced-colours mode, where box-shadow
 *   rings are not drawn either, so a control styled that way has no focus indicator there.
 *   Controls with their own ring use `outline-hidden` instead. `outline-none` is allowed only on
 *   non-interactive elements that receive focus programmatically (`tabIndex={-1}`: <main>,
 *   dialog and kiosk headings), which are never keyboard tab stops.
 * - A focus ring on a visual stand-in for a visually hidden input (`peer-focus:ring…` on the
 *   PIN dots, `focus-within:ring…` on a chip label around a radio) needs the matching
 *   `outline-hidden` for the same reason.
 * - Focus rings in very light tints (indigo/slate 50–300) fall below 3:1 against white.
 * The browser behaviour is checked in e2e/forced-colors-focus.spec.ts.
 */
const SRC = join(__dirname, '..', '..');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sources(full);
    return /\.(ts|tsx|css)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

// CSS comments are blanked (keeping line numbers) so prose about the rule doesn't match it.
const FILES = sources(SRC).map((file) => {
  const text = readFileSync(file, 'utf8');
  const code = file.endsWith('.css')
    ? text.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '))
    : text;
  return { file: relative(SRC, file), lines: code.split('\n') };
});

describe('focus styles (Batch 11C)', () => {
  it('scans the web source', () => {
    expect(FILES.length).toBeGreaterThan(200);
  });

  it('uses outline-none only on programmatic focus targets (tabIndex={-1})', () => {
    const offenders: string[] = [];
    const allowed: string[] = [];
    for (const { file, lines } of FILES) {
      lines.forEach((line, index) => {
        if (!/(^|[\s'"`:])outline-none(?=[\s'"`]|$)/.test(line)) return;
        const nearby = lines.slice(Math.max(0, index - 3), index + 4).join('\n');
        if (/tabIndex=\{-1\}/.test(nearby)) allowed.push(`${file}:${index + 1}`);
        else offenders.push(`${file}:${index + 1}: ${line.trim().slice(0, 120)}`);
      });
    }
    expect(offenders).toEqual([]);
    // The known programmatic focus targets: <main>, the form and view dialog titles, the kiosk
    // heading. A new one is fine; this keeps the list visible in review.
    expect(allowed.sort()).toEqual(
      [
        'components/kiosk/kiosk-app.tsx',
        'components/shell/app-shell.tsx',
        'components/ui/form-dialog.tsx',
        'components/ui/view-dialog.tsx',
      ].map((file) => expect.stringMatching(new RegExp(`^${file}:\\d+$`))),
    );
  });

  it('pairs a stand-in focus ring (peer-focus: or focus-within:) with outline-hidden', () => {
    const offenders = FILES.flatMap(({ file, lines }) =>
      lines.flatMap((line, index) =>
        (['peer-focus', 'focus-within'] as const).flatMap((variant) =>
          line.includes(`${variant}:ring`) && !line.includes(`${variant}:outline-hidden`)
            ? [`${file}:${index + 1} (${variant})`]
            : [],
        ),
      ),
    );
    expect(offenders).toEqual([]);
  });

  it('draws no focus ring in a tint too light to see on white', () => {
    const offenders = FILES.flatMap(({ file, lines }) =>
      lines.flatMap((line, index) =>
        /(focus|focus-visible|focus-within|peer-focus):ring-(indigo|slate|gray|zinc|neutral|stone|sky|blue|cyan|teal|emerald|green|lime|yellow|amber|orange|red|rose|pink|fuchsia|purple|violet)-(50|100|200|300)\b|(focus|focus-visible|focus-within|peer-focus):ring-white\b/.test(
          line,
        ) && !/kiosk/.test(file)
          ? [`${file}:${index + 1}: ${line.trim().slice(0, 100)}`]
          : [],
      ),
    );
    expect(offenders).toEqual([]);
  });
});
