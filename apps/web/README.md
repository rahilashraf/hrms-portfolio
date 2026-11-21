# Web (`apps/web`)

The Next.js frontend of Portfolio HRMS: the signed-in application for employees, managers and
administrators, the sign-in and account-recovery pages, and the onsite attendance kiosk. For
the system as a whole see the [root README](../../README.md) and
[docs/architecture/README.md](../../docs/architecture/README.md).

## Responsibilities

- Render the user interface and call the API from client components. The Next.js server does
  not proxy API requests and holds no business rules.
- Keep the access token in memory only, send it as a Bearer token, and on a 401 refresh once
  through `POST /auth/refresh` (HttpOnly cookie) before retrying (`src/lib/auth/api-client.ts`).
- Hide navigation and actions the user's permissions do not allow
  (`src/components/ui/require-permission.tsx`, `src/lib/authorization/`). This is presentation
  only; the API makes every authorization decision.
- Send page security headers, including a Content Security Policy and, outside development,
  `Strict-Transport-Security: max-age=31536000` (`next.config.ts`,
  `src/lib/security/page-headers.ts`). There is no Next.js middleware.

## Source layout

| Path                             | Contents                                                                         |
| -------------------------------- | -------------------------------------------------------------------------------- |
| `src/app/(app)`                  | Sign-in, password recovery, invitation acceptance, email verification            |
| `src/app/(app)/(authenticated)`  | Signed-in pages, wrapped in `ProtectedRoute`, `WorkspaceProvider` and `AppShell` |
| `src/app/(kiosk)/kiosk`          | The attendance kiosk (its own root layout)                                       |
| `src/components/<domain>`        | Feature components per domain; `components/ui` holds shared building blocks      |
| `src/lib/<domain>`               | API clients, types and pure helpers per domain                                   |
| `src/providers`                  | Authentication and workspace context providers                                   |
| `e2e/`, `e2e-real/`, `e2e-demo/` | Playwright suites: mocked API, real stack, demo smoke and screenshot capture     |

UI conventions and accessibility rules are in
[docs/design/design-system.md](../../docs/design/design-system.md).

## Framework and main dependencies

Next.js 16 (App Router) and React 19, Tailwind CSS 4, React Hook Form with Zod 4 (imported
through `src/lib/forms/zod.ts`, which enables Zod's CSP-safe mode). Tests use Vitest with
jsdom and Testing Library, `vitest-axe`, and Playwright with `@axe-core/playwright`.

## Commands

Run from `apps/web` with `pnpm run <script>`, or from the root with `pnpm --filter web <script>`.

| Script             | What it does                                                                                    |
| ------------------ | ----------------------------------------------------------------------------------------------- |
| `dev`              | `next dev` (port 3000 by default)                                                               |
| `build`, `start`   | Production build and server; the build requires an HTTPS `NEXT_PUBLIC_API_URL`                  |
| `lint`             | ESLint with the Next.js core-web-vitals and TypeScript configurations                           |
| `typegen`          | Generate Next.js route types; run before `typecheck`                                            |
| `typecheck`        | `tsc --noEmit`                                                                                  |
| `test`             | Unit and component tests (`src/**/*.test.{ts,tsx}`, Vitest, jsdom)                              |
| `test:e2e`         | Playwright with every API call mocked, against a production build on port 3100, with axe checks |
| `test:e2e:real`    | Playwright against the real built API and a local disposable (`*_disposable`) database          |
| `test:e2e:demo`    | Smoke test of the demo accounts against a running `pnpm demo`                                   |
| `screenshots:demo` | Capture the documentation screenshots into `docs/assets/screenshots/` from a running demo       |

Install the browser once with `pnpm --filter web exec playwright install chromium`.
`PLAYWRIGHT_DEV_SERVER=1` runs the mocked suite against `next dev` for faster iteration. All
Playwright configurations use Desktop Chrome (Chromium) only.

## Environment

`next.config.ts` loads the repository's root `.env` when it exists. The only variable the web
app reads is `NEXT_PUBLIC_API_URL`: an origin with no path, validated in
`src/lib/api-config.ts`, and required to use HTTPS when `NODE_ENV=production`. It is inlined at
build time, so changing it requires a rebuild. That is why the local demo runs the web app
under `next dev` against `http://localhost:3001`.

## Interaction with other apps

- **API:** all data comes from JSON calls to the API (`credentials: 'include'`); the API's
  `WEB_ORIGIN` must equal this app's origin, and the two origins must be same-site for the
  `SameSite=Lax` refresh cookie. The kiosk uses a separate device cookie issued at enrollment.
- **Worker:** no direct interaction. Notifications the worker publishes are read through the API.

## Testing and build

`pnpm --filter web test` needs no services. `test:e2e` builds and starts the app itself and
needs no API. `test:e2e:real` starts the built API and `next dev`; it requires `DATABASE_URL` and
`REDIS_URL` pointing at a migrated local database whose name ends in `_disposable` and which
carries the disposable-test marker (`apps/api/test/real-stack/disposable-database-cli.ts mark`); see
[docs/testing.md](../../docs/testing.md). The production build writes `.next/`.
