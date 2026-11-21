# Deployment

A generic guide to running the application in a production-like environment. It is written for
any container or VM platform; it names no hosting provider. Read [security](security.md) first:
several items below are prerequisites for a hardened release, not optional extras.

**Scope.** The application is meant to be deployed by one organization (or a group of related
organizations) for its own authenticated staff. It is **not designed as an unrestricted public
hosted demo**: the demo accounts hold real privileges, and there is no restricted demo mode.
The demo is meant to run locally (see [the local demo guide](development/demo.md)).

## Contents

1. [Required services](#required-services)
2. [Build and start](#build-and-start)
3. [Environment configuration](#environment-configuration)
4. [Database migrations](#database-migrations)
5. [First administrator](#first-administrator)
6. [HTTPS, domains and cookies](#https-domains-and-cookies)
7. [Proxy configuration](#proxy-configuration)
8. [Health checks](#health-checks)
9. [Database role separation](#database-role-separation)
10. [Backups and restore](#backups-and-restore)
11. [Rollback](#rollback)
12. [Monitoring and logging](#monitoring-and-logging)
13. [Document storage and email](#document-storage-and-email)
14. [Automation flags](#automation-flags)
15. [Production prerequisites](#production-prerequisites)

## Required services

| Service    | Notes                                                                                                                    |
| ---------- | ------------------------------------------------------------------------------------------------------------------------ |
| PostgreSQL | Version 17 in `docker-compose.yml` and CI; local runs also used 16. The only source of truth.                            |
| Redis      | Version 7. Queues, rate-limit counters, kiosk interaction tokens and the worker heartbeat. Needs no backup.              |
| API        | NestJS on Node.js 24.10 or newer. Public over HTTPS.                                                                     |
| Worker     | BullMQ job runner on Node.js 24.10 or newer. Needs no public address.                                                    |
| Web        | Next.js (`next start`). Public over HTTPS.                                                                               |
| Optional   | An SMTP server (account and notification email), a private S3-compatible bucket (document files), a Google OAuth client. |

Run one replica of the worker unless you have checked that every job you enable tolerates
concurrent runners; the jobs take row locks per organization.

## Build and start

From the repository root, after `pnpm install --frozen-lockfile`:

| Service | Build               | Start (with `NODE_ENV=production`)                                                    |
| ------- | ------------------- | ------------------------------------------------------------------------------------- |
| API     | `pnpm build:api`    | `node apps/api/dist/main.js`                                                          |
| Worker  | `pnpm build:worker` | `node apps/worker/dist/index.js`                                                      |
| Web     | `pnpm build:web`    | `next start` in `apps/web` (for example `node node_modules/next/dist/bin/next start`) |

- `build:worker` also builds the API: the worker runs the API's compiled job modules.
- `build:web` inlines `NEXT_PUBLIC_API_URL` into the browser bundle, so changing it requires a
  rebuild.
- Set `NODE_ENV=production` for the start commands, not for `pnpm install`, which would then
  skip the development dependencies the build needs.
- Start Node directly (or with `exec`) so `SIGTERM` reaches it: the API closes connections and
  the worker waits up to `WORKER_SHUTDOWN_TIMEOUT_MS` (default 30 s) for active jobs.

## Environment configuration

`.env.example` documents every variable. The API validates its configuration at start-up
(`packages/config`) and refuses to start on an invalid value. By group:

| Group               | Variables                                                                                                                                                                                     | Notes                                                                                                                                          |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Local services      | `POSTGRES_*`, `REDIS_PORT`                                                                                                                                                                    | Used only by `docker-compose.yml`. Do not set in production.                                                                                   |
| Connections         | `DATABASE_URL`, `REDIS_URL`                                                                                                                                                                   | API and worker. The worker refuses to start in production without either.                                                                      |
| Web                 | `NEXT_PUBLIC_API_URL`                                                                                                                                                                         | Web only. The API origin; must be `https:` in production builds; no path or credentials.                                                       |
| Port                | `PORT`                                                                                                                                                                                        | The API refuses to start in production without it (defaults to 3001 elsewhere). The web app listens on `PORT` (default 3000).                  |
| Sessions            | `JWT_ACCESS_SECRET`                                                                                                                                                                           | API only. At least 32 bytes and 8 distinct characters, not a placeholder. Generate with `openssl rand -base64 48`.                             |
| Origins and proxies | `WEB_ORIGIN`, `TRUST_PROXY_HOPS`                                                                                                                                                              | Both required in production. `WEB_ORIGIN` is the web app's exact origin (no path); the worker uses it for links in emails.                     |
| Password hashing    | `ARGON2_MEMORY_COST_KIB`, `ARGON2_TIME_COST`, `ARGON2_PARALLELISM`                                                                                                                            | Defaults 65536 KiB, 3, 1. Each concurrent sign-in uses the configured memory.                                                                  |
| Google Workspace    | `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_URI`                                                                                                           | Optional; all three or none. The redirect URI must be `https:` in production.                                                                  |
| Integration secrets | `INTEGRATION_ENCRYPTION_KEY`, `INTEGRATION_ENCRYPTION_PREVIOUS_KEYS`                                                                                                                          | Base64 of exactly 32 bytes. Never stored in the database; losing it makes stored integration credentials unreadable. Same value on the worker. |
| SMTP                | `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURITY`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`                                                                                                          | Optional. Host and sender required together, user and password together; `SMTP_SECURITY=none` is refused in production.                        |
| Worker switches     | `AUTH_RECORD_RETENTION_ENABLED`, `TIME_ATTENDANCE_AUTOMATION_ENABLED`, `EMPLOYEE_LIFECYCLE_AUTOMATION_ENABLED`, `RETAINED_GRANT_RECONCILIATION_ENABLED`, `RETAINED_GRANT_RECONCILIATION_CRON` | See [automation flags](#automation-flags). Invalid values stop the worker at start-up.                                                         |
| Kiosk limits        | `KIOSK_*_FAILURE_LIMIT`, `KIOSK_*_FAILURE_WINDOW_SECONDS`                                                                                                                                     | API, optional; defaults apply when empty.                                                                                                      |
| Observability       | `LOG_FORMAT`, `WORKER_CONCURRENCY`, `WORKER_HEALTH_PORT`, `WORKER_SHUTDOWN_TIMEOUT_MS`                                                                                                        | JSON logs by default in production. `WORKER_HEALTH_PORT` enables the worker's HTTP probes.                                                     |
| Document storage    | `DOCUMENT_STORAGE_*`, `DOCUMENT_URL_SIGNING_KEY`, `DOCUMENT_S3_*`, `DOCUMENT_UPLOAD_MAX_BYTES`, `DOCUMENT_REQUIRE_MALWARE_SCAN`                                                               | API and worker, same values. See [document storage](#document-storage-and-email).                                                              |

Keep secrets in the platform's secret store, never in the repository or the image. The API and
the worker must share `DATABASE_URL`, `REDIS_URL`, `WEB_ORIGIN`, the integration keys, SMTP and
document-storage settings. `JWT_ACCESS_SECRET`, `TRUST_PROXY_HOPS` and the Argon2 settings are
API-only. The web app needs no database, Redis or secrets.

## Database migrations

- Apply migrations with `pnpm db:migrate:deploy` (`prisma migrate deploy`), once per release,
  before the new API version starts. It applies only committed migrations; it never generates,
  resets or seeds. Never run `prisma migrate dev` or the development seed (`pnpm db:seed`, which
  refuses non-local hosts, databases not named `hrms`/`*_dev` and `NODE_ENV=production`) against a
  production database.
- The repository has 62 migrations. Migrations are additive and forward-only (there are no down
  migrations). **Never edit or rename a migration that has been applied anywhere**: databases
  record applied migrations by folder name and checksum. Add a new migration instead, with a
  folder timestamp later than the newest existing one.
- Take a backup immediately before any release that contains migrations.
- If a migration fails part-way, later deploys refuse until it is resolved. `prisma migrate
resolve --rolled-back` only updates Prisma's history; it does not undo statements that already
  ran. Inspect the database, then restore the pre-deploy backup or repair it deliberately,
  rehearsed on a copy first.
- Deploy the API and the worker together after a migration; the worker may start before the
  API's migration finishes, and BullMQ retries jobs that fail meanwhile. For a migration the
  previous code cannot tolerate, deploy the API first.
- **Existing data.** A new, empty database needs nothing else. A database that already holds data
  from an earlier version may need the read-only checks or the one-off backfill in
  [`docs/security/sql/`](security/sql/); each file's header says when it applies. Run them on a
  copy first.

## First administrator

There is no self-registration. On a new database, from `apps/api` after the API build and with
the production environment:

```bash
pnpm authz:create-initial-user --email admin@example.com --first-name Ada --last-name Admin
pnpm authz:sync-permissions
pnpm authz:bootstrap-owner --email admin@example.com
```

`create-initial-user` asks for the password at a hidden prompt (12–128 characters), creates one
active account and refuses as soon as any account exists. `bootstrap-owner` grants the reserved
System Owner role. Run `authz:sync-permissions` again after a release that adds permissions.

## HTTPS, domains and cookies

- Serve the web app and the API over HTTPS only. Production builds refuse an `http:`
  `NEXT_PUBLIC_API_URL`, and the API's refresh and kiosk cookies are `Secure` in production.
- **Use same-site domains**, for example `hr.example.com` (web) and `api.hr.example.com` (API),
  sharing one registrable domain. The refresh cookie is `SameSite=Lax`, `HttpOnly`,
  `Path=/auth` and host-only (no `Domain`) on the API host; it is sent on the web app's
  credentialed requests only when the two hosts are same-site. On two unrelated domains (for
  example two different hosting providers' default domains, or two subdomains of a domain on the
  Public Suffix List) sign-in works but every page reload signs the user out. The kiosk's device
  cookie is `SameSite=Strict` and has the same requirement.
- Set `WEB_ORIGIN` to the web app's exact origin (`https://hr.example.com`, no trailing slash) and
  `NEXT_PUBLIC_API_URL` to the API origin (`https://api.hr.example.com`). CORS allows exactly
  `WEB_ORIGIN`, with credentials.
- HSTS: the API sends `max-age=31536000; includeSubDomains`, the web app `max-age=31536000`.
  Make sure every subdomain of the API host serves HTTPS before deploying.

## Proxy configuration

`TRUST_PROXY_HOPS` is the number of reverse proxies in front of the API whose
`X-Forwarded-For` entries Express should trust. It decides the client address used by the
sign-in and kiosk rate limits and recorded in the audit log. Production refuses to start without
it.

- Set it to the exact number of proxies between the internet and the API (commonly `1` for a
  platform edge proxy; `2` if a CDN in proxy mode sits in front of it). Never trust every hop:
  clients could then choose their own address.
- After the first deploy, sign in from a known public address and check the
  `AUTH_LOGIN_SUCCESS` audit entry. A private address there means the value is wrong, and every
  user would share one rate-limit bucket.

## Health checks

| Probe                             | Meaning                                                                       |
| --------------------------------- | ----------------------------------------------------------------------------- |
| API `GET /health`                 | Liveness: the process serves HTTP; touches no dependency                      |
| API `GET /ready`                  | 200 only when PostgreSQL (1.5 s) and Redis (1 s) answer; otherwise 503        |
| Worker `GET /health`              | On `WORKER_HEALTH_PORT`: running and not shutting down                        |
| Worker `GET /ready`               | On `WORKER_HEALTH_PORT`: Redis and PostgreSQL answer                          |
| Web `GET /login`                  | The sign-in page renders                                                      |
| Redis key `hrms:worker:heartbeat` | Rewritten every 15 seconds and expires after 45; absence means no live worker |

Probes return status only, never error details, with `Cache-Control: no-store`. Use `/ready` as
the deploy health check so traffic switches only when dependencies answer, and point an external
uptime monitor at `/health` (and `/ready` for dependency alerts). Do not expose the worker's
health port publicly.

## Database role separation

The repository's default is a single database role that owns the schema and is used by the API,
the worker and migrations. That role can disable the audit-log triggers (see
[security](security.md#8-database-access-controls)). A **separate least-privilege runtime role
is required before a hardened production release.** This is not automated by the repository;
the outline below must be adapted, applied by a database administrator, and verified against
the full test suite before use.

- **Owner/migration role** (for example `hrms_owner`): owns the schema and every table, function
  and trigger. Used only by `prisma migrate deploy` and administrative work, through its own
  connection string.
- **Runtime role** (for example `hrms_app`): used by the API and the worker. Owns nothing, has no
  `CREATE` on any schema and is not a superuser.

```sql
-- As the owner role, after migrations:
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO hrms_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO hrms_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO hrms_app;
-- The audit log: no UPDATE, no TRUNCATE (DELETE only for the retention purge).
REVOKE UPDATE, TRUNCATE ON "AuditLog" FROM hrms_app;
-- Tables created by later migrations:
ALTER DEFAULT PRIVILEGES FOR ROLE hrms_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO hrms_app;
ALTER DEFAULT PRIVILEGES FOR ROLE hrms_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO hrms_app;
```

Remember that each new table that should be restricted like `AuditLog` needs its own revoke, and
that the Prisma `_prisma_migrations` table needs no runtime access. Some trigger functions other
than the audit-log ones do not pin their `search_path`; review them together with this change.

## Backups and restore

- Enable the database platform's scheduled backups before entering real data, and take a manual
  backup before every release that contains migrations.
- Keep an encrypted, off-platform logical copy as well, for example:

  ```bash
  pg_dump --format=custom --no-owner "$DATABASE_URL" > hrms-YYYYMMDD.dump
  # encrypt (age, gpg, ...) and store in approved storage; never commit dumps
  ```

  Use a `pg_dump` whose major version matches (or exceeds) the server's.

- **Test a restore** before relying on backups, and after any change to the backup setup:

  ```bash
  createdb hrms_restore_test
  pg_restore --no-owner --dbname hrms_restore_test hrms-YYYYMMDD.dump
  DATABASE_URL=postgresql://.../hrms_restore_test pnpm db:migrate:status
  ```

  Then start an API against the restored copy (never the production one) and check `/ready` and
  a sign-in.

- With role separation, restore as the owner role (`--no-owner` assigns ownership to the
  restoring role) and re-apply the runtime role's grants.
- Uploaded document files are not in the database: give the bucket its own versioning or backup
  policy. Redis needs no backup; the worker re-registers its schedules on start.

## Rollback

- **No migration in the release:** redeploy the previous build of the API, the worker and the
  web app. Sessions stay valid.
- **Additive migration that succeeded:** redeploying the previous build is usually safe because
  the old code ignores new tables and nullable columns. Read the migrations between the two
  versions to confirm.
- **Anything else:** restore the pre-deploy backup, then redeploy the previous build. Data
  written since the backup is lost, so announce a maintenance window. Preserve the current state
  (a manual backup) first if an incident is being investigated.
- Never restore a backup just to undo a code change that a redeploy can undo.
- After a rollback, rerun the health checks and a short smoke test (sign in, reload and stay
  signed in, open the main pages).

## Monitoring and logging

- **API logs:** JSON lines in production (`LOG_FORMAT` overrides), with level, timestamp,
  context, message and structured fields. Each request logs one `http_request` line with the
  request id, method, route template, status, duration and user id; never bodies, query strings,
  headers or cookies, and known secret and personal keys are redacted. The request id comes from
  a safe inbound `X-Request-Id` or `X-Correlation-Id`, or is generated; it is returned as
  `X-Request-Id` and stored on audit entries, so logs and audit entries can be joined.
- **Worker logs:** plain-text lines per lifecycle event and job (name, id, attempt and a sanitized
  error; never payloads or stack traces). Failed jobs are kept in the queue for inspection.
- **Metrics:** there is **no metrics endpoint**. The API records request counters and durations
  through a `MetricsService` hook that is a no-op by default; a deployment that wants metrics
  must bind its own implementation (for example a Prometheus or OpenTelemetry adapter).
- **Alerting:** none is built in. Use an external uptime monitor on the health endpoints, watch
  the worker heartbeat, and check failed jobs, especially after enabling automation.

## Document storage and email

**Document storage** (`DOCUMENT_STORAGE_DRIVER`):

- `none` (default): uploads are refused; documents can still be links or references.
- `local`: a directory, for development and tests. Needs `DOCUMENT_STORAGE_LOCAL_DIR` and
  `DOCUMENT_URL_SIGNING_KEY` (at least 32 bytes; signs 60-second download links). Refused in
  production unless `DOCUMENT_STORAGE_ALLOW_LOCAL_IN_PRODUCTION=true` is set deliberately.
- `s3`: any private S3-compatible bucket. Needs endpoint (HTTPS in production), region, bucket
  and keys; `DOCUMENT_S3_FORCE_PATH_STYLE` for providers that need it. Browsers receive only
  presigned 60-second download links; credentials stay on the server.

Uploads are limited to 10 MB by default (`DOCUMENT_UPLOAD_MAX_BYTES`, at most 25 MB). **No
malware scanner ships.** `DOCUMENT_REQUIRE_MALWARE_SCAN=true` makes the application refuse
unscanned files; without a scanner integration that means refusing uploads. Give the API and the
worker the same storage settings: the worker's hourly clean-up removes unattached uploads.

**Email.** Invitations, password resets, email verification and notification emails go through an
organization's Google Workspace Gmail connection when it has one, otherwise through the
deployment's SMTP server (any standard provider). Without either, account emails answer
"unavailable" and notification emails are retried but not delivered. Use `tls` (port 465) or
`starttls` (587); `none` is refused in production. Set the same SMTP values on the API and the
worker. Delivery is confirmed only as far as the mail server accepting the message; bounces are
not tracked.

## Automation flags

All worker switches are off by default and accept only empty, `true` or `false` (anything else
stops the worker at start-up):

| Variable                                | Default                   | When `true`                                                                                                          |
| --------------------------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `TIME_ATTENDANCE_AUTOMATION_ENABLED`    | off                       | Schedules attendance period generation and no-show detection; each organization must also opt in                     |
| `EMPLOYEE_LIFECYCLE_AUTOMATION_ENABLED` | off                       | Hourly: applies due terminations and ends assignments past their end date                                            |
| `AUTH_RECORD_RETENTION_ENABLED`         | off (job deletes nothing) | Daily deletion of old revoked or expired sessions and used account links                                             |
| `RETAINED_GRANT_RECONCILIATION_ENABLED` | **on**                    | Disables a terminated person's login when their last approved retained grant ends; `false` only as a rollback switch |

With automation off, authorized users apply due lifecycle transitions by hand. Holiday markers
are informational only. Review the operator guides before enabling anything:
[time and attendance](operations/time-attendance.md#7-automation-worker) and
[employee lifecycle](operations/employee-lifecycle.md#4-automation-default-off).

## Production prerequisites

Before real personal data is entered:

- **Database role separation** (above), so the application credentials cannot disable the
  audit-log triggers.
- Same-site HTTPS domains, `WEB_ORIGIN`, `NEXT_PUBLIC_API_URL` and a verified
  `TRUST_PROXY_HOPS`.
- Scheduled backups, an off-platform encrypted copy and one successful restore test.
- An external uptime monitor; a decision on metrics and alerting.
- A decision on document storage: a private S3-compatible bucket with its own backup policy, or
  uploads left off (`none`). Malware scanning is not available.
- An email provider (SMTP or Google Workspace) if invitations and password resets are needed.
- A successful CI run of both workflows on the release commit (they have not been observed
  passing for recent changes; see [testing](testing.md#continuous-integration)).
- Payroll prepares gross pay only: statutory deductions and net pay are not calculated
  (`NET_PAY_NOT_CALCULATED`). Payroll output must not be used as final pay without a separate
  payroll process.
- Testing has used Chromium only, with no real screen-reader testing and no kiosk hardware;
  validate the browsers and devices you will support.
- Do not expose a demo publicly: the application is not designed as an unrestricted public
  hosted demo.
