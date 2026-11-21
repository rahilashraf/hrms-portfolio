import { z } from 'zod';

/**
 * Batch R2: the web app's single entry point for Zod. `jitless` turns off Zod 4's compiled fast
 * path, whose start-up probe (`new Function('')` inside a try/catch) is reported as a
 * `script-src` violation under the Content Security Policy, which allows no `eval`. Validation
 * results are identical; only the internal fast path is skipped. Import `z` from here (by a
 * relative path), never from 'zod' or 'zod/*', so the setting is applied before any schema is
 * used. ESLint enforces this.
 */
z.config({ jitless: true });

export { z };
