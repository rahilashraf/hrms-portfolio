# Testing

The project has seven test layers, from fast unit tests to browser suites that drive the real
API and database. This page lists what each layer covers, how to run it, what it needs, and the
latest recorded results.

## Layers

| Layer                  | Tool                                       | Location                                              | Needs                                   |
| ---------------------- | ------------------------------------------ | ----------------------------------------------------- | --------------------------------------- |
| API unit               | Vitest                                     | `apps/api/src/**/*.spec.ts`, `apps/api/demo`, helpers | Nothing                                 |
| Worker unit            | Node test runner (`tsx --test`)            | `apps/worker/src/*.test.ts`                           | The API build                           |
| Web unit and component | Vitest, jsdom, Testing Library, vitest-axe | `apps/web/src/**/*.test.{ts,tsx}`                     | Nothing                                 |
| Database integration   | Vitest                                     | `apps/api/test/*.db-spec.ts`                          | Migrated PostgreSQL, Redis              |
| API HTTP end-to-end    | Vitest, Supertest                          | `apps/api/test/*.e2e-spec.ts`                         | Migrated PostgreSQL, Redis              |
| Mocked browser         | Playwright (Chromium), axe-core            | `apps/web/e2e`                                        | Playwright Chromium                     |
| Real-stack browser     | Playwright (Chromium)                      | `apps/web/e2e-real`                                   | Disposable PostgreSQL, Redis, API build |
| Demo smoke             | Playwright (Chromium)                      | `apps/web/e2e-demo`                                   | A running local demo (`pnpm demo`)      |

### Unit and component tests

- **API:** domain rules, DTO validation, authorization policy, rate limiters, security headers,
  configuration validation, the demo database guards and similar logic that needs no database.
- **Worker:** job schedules, start-up settings (automation switches, cron validation), health
  and heartbeat behaviour, failure logging.
- **Web:** components and pages rendered in jsdom with a mocked API. Component tests call
  `expectNoAxeViolations(container)` (vitest-axe; colour contrast is checked in the browser
  suites instead). Some tests enforce design rules across the codebase, for example focus-ring
  classes and checkbox sizes.

### Database integration tests

`apps/api/test/*.db-spec.ts` run services and SQL against a real, migrated PostgreSQL database
and Redis: transactions, row locks, concurrency races, triggers (including the append-only audit
log), organization isolation, payroll calculation and finalization, retention, and the demo and
real-stack database guards. Four of them load the read-only queries in `docs/security/sql/` and
check their results against fixtures.

Fixtures are created with random identifiers and removed afterwards. Some clean-ups bypass
triggers with `SET LOCAL session_replication_role = replica`, so the database user must be a
superuser: use a local, disposable database (the `docker-compose.yml` user qualifies), never a
shared or production one.

The S3 half of the document-storage contract test
(`batch-9-storage-contract.db-spec.ts`) runs only when `DOCUMENT_S3_TEST_ENDPOINT` points to a
disposable S3-compatible server that accepts the test's dummy keys (for example a local moto
server; the test creates its own bucket). Without it those 2 tests are skipped; the local-storage
half always runs.

### API HTTP end-to-end tests

`apps/api/test/*.e2e-spec.ts` start the Nest application with the production HTTP pipeline
(headers, body limits, CORS, validation) and call it over HTTP with Supertest, against the same
database and Redis.

`route-boundary.e2e-spec.ts` discovers every route the router registers, from the controllers
rather than a hand-written list, and asserts that each answers 401 without credentials, except an
explicit allowlist of public routes; kiosk device routes must answer 401 without the device
cookie, and a user who must change their password reaches only the routes needed to do so. A new
route is therefore covered automatically.

### Mocked browser tests

`apps/web/e2e` mocks every API call with `page.route` and runs against a **production build**
(`next build`, then `next start` on `127.0.0.1:3100`), using a never-resolving HTTPS API origin
so nothing outside the machine is reached. `PLAYWRIGHT_DEV_SERVER=1` uses `next dev` instead for
quicker local iteration.

- Flows end with an axe check (`expectNoSeriousA11yViolations`, @axe-core/playwright,
  WCAG 2.1 A/AA; serious and critical violations fail).
- `ui-acceptance.spec.ts` checks 23 major routes at 1440, 1280, 820 and 375 px (plus 320 px):
  no page-wide horizontal scroll, named scroll regions, heading structure, axe, page width from
  the first paint and visible focus. `ui-acceptance-flows.spec.ts` covers deep links, loading
  versus denied states and the kiosk at tablet and phone sizes.
- `forced-colors-focus.spec.ts` checks focus indicators with forced colours emulated;
  `security-csp.spec.ts` checks that pages load without Content Security Policy violations.

### Real-stack browser tests

`apps/web/e2e-real` drives the real web app, the built API, PostgreSQL and Redis; nothing is
mocked. Each run seeds a new organization with random names and passwords. Three independent
guards refuse any database that is not local, not named `*_disposable`, not marked as a
disposable test database, or that holds accounts other than the seed's own. The suite runs one
flow at a time. The web app runs under `next dev`, because a production web build requires an
HTTPS API origin.

### Demo smoke tests

`apps/web/e2e-demo` signs in as each of the eight demo accounts against a running local demo and
checks that each reaches its pages with the seeded data and that organization isolation holds. It
starts no server and never seeds. `DEMO_WEB_URL` overrides the web address (default
`http://localhost:3000`); `DEMO_CREDENTIALS` overrides the credentials file (default
`.demo/credentials.json`).

## Running the tests

All commands run from the repository root. Install dependencies with `pnpm install` first (see
the root README for prerequisites).

### Static checks and builds

```bash
pnpm format:check
pnpm lint
pnpm --filter web typegen   # Next.js route types, needed by the web typecheck
pnpm typecheck
pnpm build                  # api, worker and web
```

A production web build needs `NEXT_PUBLIC_API_URL` set to an HTTPS origin; CI uses the
never-resolving `https://api.ci.invalid`.

### Unit and component tests

```bash
pnpm test                    # all three; Turborepo builds the API first for the worker tests
pnpm --filter api test
pnpm --filter web test
pnpm --filter worker test    # needs the API build (pnpm build:api)
```

### Database and API end-to-end tests

Start PostgreSQL and Redis (`docker compose up -d --wait`, which uses the ports in `.env`), then:

```bash
pnpm db:migrate:deploy
pnpm --filter api test:db
pnpm --filter api test:e2e
```

The specs read `DATABASE_URL` and `REDIS_URL` from the environment or the root `.env`. The e2e
and HTTP-level database specs set their own `JWT_ACCESS_SECRET` when it is unset or empty (as
`.env.example` leaves it). Set `ARGON2_MEMORY_COST_KIB`, `ARGON2_TIME_COST` and
`ARGON2_PARALLELISM` as in `.env.example` (CI sets them explicitly).

### Mocked browser tests

```bash
pnpm --filter web exec playwright install chromium   # once; add --with-deps on a fresh Linux machine
pnpm --filter web test:e2e
```

### Real-stack browser tests

Create an empty local database whose name ends in `_disposable`, then:

```bash
export DATABASE_URL='postgresql://hrms:hrms_dev_password@localhost:5436/hrms_e2e_disposable?schema=public'
export REDIS_URL='redis://localhost:6380'
pnpm db:migrate:deploy
REAL_STACK_E2E=1 pnpm --filter api exec tsx test/real-stack/disposable-database-cli.ts mark
pnpm --filter api build
pnpm --filter web test:e2e:real
```

The API listens on `127.0.0.1:3201` and the web app on `127.0.0.1:3200`. The seeded data stays
until the database is dropped; recreate and mark it again for a clean run.

### Demo smoke tests

```bash
pnpm demo                          # in one terminal; waits until the demo is running
pnpm --filter web test:e2e:demo    # in another
```

See [the local demo guide](development/demo.md).

## Environment variables used by tests

| Variable                                                           | Used by                                                      |
| ------------------------------------------------------------------ | ------------------------------------------------------------ |
| `DATABASE_URL`, `REDIS_URL`                                        | Database and API e2e specs, real-stack suite, migrations     |
| `ARGON2_MEMORY_COST_KIB`, `ARGON2_TIME_COST`, `ARGON2_PARALLELISM` | Password hashing in database and e2e specs                   |
| `DOCUMENT_S3_TEST_ENDPOINT`                                        | Optional S3 half of the storage contract test                |
| `NEXT_PUBLIC_API_URL`                                              | Web builds (HTTPS required for a production build)           |
| `PLAYWRIGHT_DEV_SERVER`                                            | `1` runs the mocked browser suite under `next dev`           |
| `REAL_STACK_E2E`                                                   | `1` is required by the real-stack guards and marking command |
| `DEMO_WEB_URL`, `DEMO_CREDENTIALS`                                 | Demo smoke suite overrides                                   |
| `CI`                                                               | Playwright reporters and traces; `pnpm demo` hides passwords |

## Continuous integration

Two GitHub Actions workflows are defined:

- `.github/workflows/ci.yml`: formatting, lint, route type generation, typecheck, unit tests
  and builds, with no services.
- `.github/workflows/integration.yml`: database and API e2e specs, the mocked browser suite,
  the real-stack browser suite and the demo smoke suite, each against its own throwaway
  PostgreSQL 17 and Redis 7 service containers. Pull requests that change only documentation
  skip it.

Neither workflow uses repository secrets or reaches a deployed environment. **Both workflows
passed on the public portfolio repository's `main` commit `e515e4a`**, after the R5-C validation
PR was squash-merged: [CI](https://github.com/rahilashraf/hrms-portfolio/actions/runs/44861403878)
and [Integration](https://github.com/rahilashraf/hrms-portfolio/actions/runs/44861403875).
All seven jobs completed successfully. The earlier results below are a separate record of local
validation, not GitHub Actions test results.

## Latest recorded results

Local validation of the source snapshot used Node.js 24.22.1 and pnpm 12.8.1, on a disposable
PostgreSQL 16 database and Redis. These are local results, not GitHub Actions results. After the
application-code validation, documentation and a configuration comment were revised; the frozen
install, formatting and documentation link checks affected by those revisions were rerun.

| Stage                                                  | Result                                                                                        |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| Frozen install (lockfile unchanged), migrate, generate | exit 0                                                                                        |
| Format, route types                                    | exit 0                                                                                        |
| Lint and typecheck (api, web, worker)                  | exit 0                                                                                        |
| Builds (api, web, worker)                              | exit 0                                                                                        |
| Unit: api / worker / web                               | 1086 / 42 / 1288 passed, exit 0                                                               |
| Database integration                                   | 1114 passed, 2 skipped (S3-only), exit 0                                                      |
| API HTTP end-to-end                                    | 100 passed, exit 0                                                                            |
| Mocked browser on a production build (with axe checks) | 350 passed, exit 0                                                                            |
| Real-stack browser                                     | 37 passed, exit 0                                                                             |
| Demo setup, smoke (8 passed), rerun, reset             | exit 0; the rerun created nothing                                                             |
| Production dependency audit (`pnpm audit --prod`)      | exit 0: no known vulnerabilities                                                              |
| Full dependency audit (`pnpm audit`)                   | exit 1: one moderate, development-only ([details](security.md#9-known-limits-and-open-items)) |

### Resolved: intermittent invitation-role race failure

`apps/api/test/batch-5e-invitation-role-race.db-spec.ts` once failed under full parallel load:
the role assignment succeeded, but its `ROLE_ASSIGNMENT_CREATED` audit entry count was 0
(expected 1). The cause was another spec's cleanup, not the application:
`batch-5e-revocation-concurrency.db-spec.ts` deleted, with the append-only triggers bypassed,
every `RoleAssignment` and `Role` audit entry that had no actor, across the whole database.
Database spec files run in parallel, and the race spec created its grant without an audit context
(the HTTP controller always passes one), so its committed entry had no actor and could be
deleted between its commit and the assertion. The failure was reproduced (2 of 15 runs of the two
files together); with the cleanup limited to its own fixture organization it did not recur (0 of
30, then 0 of 30 with both fixes below).

- The revocation spec now deletes only the audit entries of its own fixture organization's roles
  and grants.
- The race spec passes the controller's audit context, asserts the whole entry (actor, target,
  role), and removes its own entries instead of relying on another spec's cleanup.

The application writes the audit entry in the same serializable transaction as the grant, and
HTTP requests always record the actor. Test cleanups that bypass the triggers are a test-only
facility (`SET LOCAL session_replication_role = replica`); see [security.md](security.md) for why
the runtime database role must not be able to do the same.

## Coverage limits

- Browser tests run in **Chromium only**. Safari and Firefox are not tested.
- Accessibility is checked with axe-core and keyboard/focus assertions; there has been **no
  testing with real screen readers** and no manual Windows high-contrast session.
- Kiosk flows are tested in the browser at tablet and phone sizes, not on kiosk hardware.
- The S3 storage path is tested only against a local S3-compatible test server when one is
  configured, not against a hosted provider.
- There are no load or performance tests and no automated penetration tests.
