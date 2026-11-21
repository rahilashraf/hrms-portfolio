import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Batch R2: Zod is imported through src/lib/forms/zod.ts, which turns off its eval probe
  // (a Content Security Policy violation).
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/lib/forms/zod.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'zod',
              message: "Import { z } from 'src/lib/forms/zod' (it sets Zod's CSP-safe mode).",
            },
          ],
          patterns: [
            {
              group: ['zod/*'],
              message: "Import { z } from 'src/lib/forms/zod' (it sets Zod's CSP-safe mode).",
            },
          ],
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    '.next/**',
    'out/**',
    'build/**',
    'test-results/**',
    'playwright-report/**',
    'next-env.d.ts',
  ]),
]);

export default eslintConfig;
