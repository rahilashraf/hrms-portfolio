# API (`apps/api`)

The NestJS REST API of Portfolio HRMS. It owns the Prisma client and every business rule:
authentication, authorization, organization isolation, separation of duties, validation,
auditing and the domain workflows. The web app and the worker contain no business rules of
their own. For the system as a whole see the [root README](../../README.md) and
[docs/architecture/README.md](../../docs/architecture/README.md).

## Responsibilities

- Serve the JSON API used by the web app and the attendance kiosk (no version prefix).
- Authenticate users (password sign-in, rotating refresh sessions) and kiosk devices.
- Authorize every action in domain services against the target record's organization, unit,
  department or team, and enforce per-organization feature switches.
- Run domain workflows inside database transactions and write audit entries.
- Publish job handlers that the worker runs (see [Interaction with web and worker](#interaction-with-web-and-worker)).
- Provide operator CLIs (permission catalog, owner bootstrap, initial user) and the local demo
  seed.

## Source layout

`src/app.module.ts` registers the feature modules; `src/config/http-application.ts` builds the
HTTP pipeline (request id, security headers, logging, body limits, CORS, validation).

| Directory                               | Purpose                                                                                 |
| --------------------------------------- | --------------------------------------------------------------------------------------- |
| `auth`, `sessions`, `users`, `security` | Sign-in, refresh sessions, account recovery and invitations, Argon2id password hashing  |
| `authorization`                         | Permission catalog (74 keys), roles, scoped role assignments, role templates, CLI       |
| `organization`                          | Organizations, units, departments, teams, positions, work locations, physical sites     |
| `employee`                              | Employees, employment assignments, transfers, terminations, lifecycle jobs              |
| `time`, `kiosk`                         | Clock-in/out, multi-assignment coverage, exceptions, timesheets, kiosk devices and PINs |
| `scheduling`, `calendar`                | Schedules, shifts, templates, patterns, policies; holidays and closures                 |
| `leave`                                 | Leave types, policies, balance ledger, requests and approvals                           |
| `compensation`, `payroll`, `benefits`   | Effective-dated pay, pay groups, payroll runs (gross pay), adjustments; benefit plans   |
| `performance`                           | Review cycles, templates, goals, reviews, external evidence                             |
| `recruitment`, `onboarding`             | Openings, candidates, interviews, offers, hires; onboarding and offboarding workflows   |
| `documents`                             | Document records, versions, uploads, local or S3-compatible object storage              |
| `notifications`, `email`                | In-app and email notifications, delivery log, SMTP mailer                               |
| `integrations/google`                   | Optional per-organization Google Workspace connection (Forms, Drive, Gmail, Sheets)     |
| `reporting`                             | Reports with CSV export and small-group suppression                                     |
| `features`, `branding`, `workspace`     | Per-organization module switches, branding, dashboard and setup data                    |
| `audit`, `retention`                    | Audit log writer and viewer; data-retention rules                                       |
| `health`, `observability`, `rate-limit` | `/health` and `/ready`, logging and request ids, Redis-backed rate limits               |
| `database`, `redis`, `config`, `common` | Prisma service, Redis client, HTTP setup, time-zone and currency helpers                |
| `generated`                             | Prisma client generated from `prisma/schema.prisma` (not edited by hand)                |

Other folders: `test/` (database and HTTP end-to-end specs), `demo/` (the local demo CLI and
dataset), `prisma/` (the local development seed; the schema and migrations are in the
repository's root `prisma/` folder).

## Framework and main dependencies

NestJS 12 on Express, Prisma 7 with the `@prisma/adapter-pg` driver adapter, class-validator
and class-transformer DTOs, `argon2`, `jose` (HS256 access tokens), `ioredis` and `bullmq`,
`nodemailer`, `busboy` (streamed uploads) and `aws4fetch` (S3 request signing). Environment
validation comes from `@hrms/config` and the password policy from `@hrms/validation`.

## Commands

Run from `apps/api` with `pnpm run <script>`, or from the repository root with
`pnpm --filter api <script>` (the root README's quick start uses `pnpm --dir apps/api run`).

| Script                                                                      | What it does                                                                   |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `dev`, `start:dev`                                                          | `nest start --watch`                                                           |
| `start`, `start:debug`                                                      | Start once, or with the debugger and watch mode                                |
| `build`                                                                     | Compile to `dist/` (`nest build`)                                              |
| `start:prod`                                                                | Run the build (`node dist/main`)                                               |
| `lint`, `typecheck`                                                         | oxlint (type-aware) over `src/` and `test/`; `tsc --noEmit`                    |
| `test`, `test:watch`, `test:cov`                                            | Unit specs (`*.spec.ts`) with Vitest                                           |
| `test:db`                                                                   | Database integration specs (`test/**/*.db-spec.ts`); needs a migrated database |
| `test:e2e`                                                                  | HTTP end-to-end specs (`*.e2e-spec.ts`)                                        |
| `authz:sync-permissions`                                                    | Synchronize the permission catalog into the database (after `build`)           |
| `authz:bootstrap-owner -- --email <e>`                                      | Grant the reserved System Owner role to an existing active user                |
| `authz:create-initial-user -- --email <e> --first-name <f> --last-name <l>` | Create the first account; prompts for the password                             |
| `db:seed`                                                                   | Local development seed (`admin@local.test`); local `hrms`/`*_dev` DB only      |
| `demo`                                                                      | The demo CLI (`demo/demo-cli.ts`); normally run through the root `pnpm demo`   |
| `scheduling:extend-generated-shifts`                                        | Run shift generation once (after `build`)                                      |
| `leave:process-entitlements`                                                | Run leave entitlement processing once (after `build`)                          |

Database commands live in the root `package.json`: `pnpm db:generate`,
`pnpm db:migrate:deploy`, `pnpm db:migrate:dev`, `pnpm db:migrate:status`.

### Authorization bootstrap

After migrations and a build, synchronize the permission catalog and grant the owner role:

```bash
pnpm --dir apps/api build
pnpm --dir apps/api run authz:sync-permissions
pnpm --dir apps/api run authz:bootstrap-owner -- --email admin@example.com
```

`bootstrap-owner` takes the normalized email of an existing active user and rejects missing,
inactive or archived users; it never picks an account implicitly. Both commands are
idempotent. Run the permission sync again whenever the catalog changes. Account identities
never belong in migrations or seeds.

The current user's permissions are available at `GET /auth/me/authorization`. Role metadata is
updated with `PATCH /authorization/roles/:roleId` and its permission set replaced with
`PUT /authorization/roles/:roleId/permissions` (`{"permissionKeys":["organization.read"]}`).

## Environment

The API reads the repository's root `.env` (`../../.env`); `.env.example` lists every variable
with comments. Values are validated at start-up by `validateEnvironment` in
[`packages/config`](../../packages/config/src/index.ts); an invalid value stops the process.

Required: `DATABASE_URL`, `REDIS_URL`, `JWT_ACCESS_SECRET` (at least 32 bytes), `WEB_ORIGIN`
(the exact web origin, used for CORS and the sign-in origin check) and, in production,
`TRUST_PROXY_HOPS`. Optional groups: `SMTP_*`, `DOCUMENT_*` (storage driver `none`, `local` or
`s3`), `GOOGLE_OAUTH_*` with `INTEGRATION_ENCRYPTION_KEY`, `KIOSK_*` failure limits,
`LOG_FORMAT` and `PORT` (required in production; 3001 otherwise).

Deployment notes:

- Set `TRUST_PROXY_HOPS` to the real number of trusted proxies; sign-in rate limits use the
  resolved client IP, so the proxy must set forwarded headers correctly.
- The refresh cookie is `SameSite=Lax`, HttpOnly, host-only, `Secure` in production and scoped
  to `/auth`, so the web and API origins must be same-site (for example `hr.example.com` and
  `api.hr.example.com`).

## Interaction with web and worker

- **Web:** the browser calls the API directly with a Bearer access token and the refresh
  cookie; the kiosk uses a device cookie. The Next.js server does not proxy API calls.
- **Worker:** `apps/worker` depends on this package (`"api": "workspace:*"`) and imports the
  compiled job modules listed under `exports` in `package.json` (`api/scheduling-jobs`,
  `api/time-jobs`, `api/notifications-jobs`, `api/platform-health` and others). The API must
  therefore be built before the worker. The API itself enqueues account-recovery and
  verification emails on the shared `hrms-default` queue; invitations are sent directly.

## Observability

- Every request gets an `X-Request-Id` (a safe caller-supplied id is kept), which is also the
  audit correlation id.
- Logs are JSON lines in production and text in development (`LOG_FORMAT` overrides).
- `MetricsService` is a metrics hook; the default implementation discards measurements, so a
  deployment can bind its own exporter.
- `GET /health` is liveness; `GET /ready` checks PostgreSQL and Redis.

## Testing and build

Unit specs run without services. `test:db` and `test:e2e` need PostgreSQL and Redis
(`docker compose up -d` at the root), a migrated database and the `.env` values. One database
spec (`test/batch-5e-invitation-role-race.db-spec.ts`) has failed intermittently under full
parallel load and is under investigation; see [docs/testing.md](../../docs/testing.md).

The build output in `dist/` is what `start:prod`, the CLIs, the worker and the demo use.
