# Security

This page describes the safeguards that are implemented in the code today, where they live, and
their known limits. It is not a certification or a penetration-test report: the controls below
reduce specific risks, and the limits section lists what they do not cover. Nothing here should
be read as a claim that the system is completely secure.

Source locations are relative to the repository root. Read-only operator and diagnostic queries
are in [`docs/security/sql/`](security/sql/).

## Contents

1. [Authentication and sessions](#1-authentication-and-sessions)
2. [Authorization and scope enforcement](#2-authorization-and-scope-enforcement)
3. [Cross-organization isolation](#3-cross-organization-isolation)
4. [Audit log](#4-audit-log)
5. [Kiosk authentication and rate limiting](#5-kiosk-authentication-and-rate-limiting)
6. [HTTP security headers and CORS](#6-http-security-headers-and-cors)
7. [Sensitive-data handling](#7-sensitive-data-handling)
8. [Database access controls](#8-database-access-controls)
9. [Known limits and open items](#9-known-limits-and-open-items)

## 1. Authentication and sessions

Code: `apps/api/src/auth`, `apps/api/src/sessions`, `apps/api/src/security`,
`packages/validation`.

**Passwords**

- Hashed with Argon2id (`security/password-hasher.service.ts`). Defaults: 65536 KiB memory,
  3 iterations, parallelism 1 (`ARGON2_*` variables).
- Length 12–128 characters. There is no breached-password or common-password blocklist.
- An unknown or inactive account still costs one Argon2 verification (a dummy hash), so the
  response does not depend on whether a password check ran.
- Failed sign-ins of existing accounts are audited with a reason code (never the typed address);
  unknown addresses leave no trace.

**Sign-in rate limits and lockout** (`auth/login-rate-limiter.service.ts`, Redis)

- 10 attempts per minute per client address, and 5 per 15 minutes per address and email.
- If Redis is unavailable, sign-in answers 503 rather than running without a limit (fail
  closed). Password reset, invitation acceptance, email verification and password change limits
  also fail closed, as do the kiosk limits (section 5). Other route limits (for example
  refresh, exports and document downloads) fail open.
- After 5 failed sign-ins an account is locked for 15 minutes; a successful sign-in resets the
  counter.

**Tokens**

- Access token: an HS256 JWT (algorithm pinned on verification) valid for 15 minutes, carrying
  only the user id and session id. The browser keeps it in memory.
- `JWT_ACCESS_SECRET` is validated at start-up: at least 32 bytes, at least 8 distinct
  characters, and not an obvious placeholder.
- Refresh token: 32 random bytes, stored only as a SHA-256 hash, in a cookie named
  `hrms_refresh` with `HttpOnly`, `SameSite=Lax`, `Path=/auth`, no `Domain`, and `Secure` when
  `NODE_ENV=production`. A session lasts at most 30 days.
- Every refresh rotates the token. The previous token is accepted for a 30-second grace period
  (concurrent tabs); presenting it after that revokes the whole session and writes
  `AUTH_REFRESH_TOKEN_REUSE` and `AUTH_SESSION_REVOKED` audit entries.
- Login, refresh, logout and kiosk requests carrying an `Origin` other than `WEB_ORIGIN` are
  refused.

**Per-request session check.** `AccessTokenGuard` verifies the JWT and then loads the session on
every request: it must be unrevoked and unexpired, and the user `ACTIVE` and not archived. A
revoked session or disabled account therefore stops working immediately, not when the access
token expires. A user who must change their password can reach only the routes needed to do so
(`403 PASSWORD_CHANGE_REQUIRED` elsewhere).

**Account tokens.** Invitation, password-reset and email-verification tokens are 32 random bytes,
stored hashed, single use and expiring (reset 30 minutes, verification 24 hours, invitation
7 days). Links carry the token in the URL fragment, which browsers do not send to servers.

## 2. Authorization and scope enforcement

Code: `apps/api/src/authorization`, per-module services.

- **Every non-public route requires an access token.** `apps/api/test/route-boundary.e2e-spec.ts`
  discovers every registered route from the controllers (so new routes are covered without being
  listed) and asserts that each answers 401 without credentials, except an explicit allowlist:
  the health probes, the credential flows of `/auth`, kiosk enrollment, the Google OAuth
  callback (validates a signed state), public login-page branding (opt-in public fields only) and
  local document downloads (authorized by a signed, 60-second token). Kiosk device routes
  require the device cookie instead.
- **Permissions and scopes.** Access comes from role grants. The catalog holds 74 permissions
  (`authorization/authorization-catalog.ts`). A grant has one scope: `SYSTEM`, `ORGANIZATION`,
  `ORGANIZATIONAL_UNIT`, `DEPARTMENT` or `TEAM`. A grant on an ancestor covers its descendants
  (an organizational unit covers its departments and teams). `SYSTEM` covers everything.
- **Inactive grants.** A grant counts only while it has started, has not expired or been
  revoked, its role is not archived, and neither its organization nor its role's organization is
  archived. Archiving an organization therefore disables its grants, including its own
  administrators'.
- **Checks are made in the API** against the target record (for example an employee is
  authorized through the positions of their assignments). The web app hides what the user cannot
  do, but that is presentation only; it never decides access.
- **Separation of duties** is enforced in the services, for example:
  - nobody approves their own leave, timesheet segments or correction requests, or corrects
    their own time;
  - nobody manages their own compensation or benefits, or adjusts or approves their own payroll;
  - payroll dual control (on by default; only a System administrator may turn it off, with a
    reason): whoever calculates a run, adds one of its adjustments or changed compensation it
    pays cannot approve it, and the calculator cannot finalize it;
  - lifecycle actions on one's own employment are refused (a System override is audited);
  - role delegation is bounded by the actor's own grants.
- **Terminations revoke access.** When a termination applies, the person's grants in the
  affected organizations and every SYSTEM grant are revoked unless an approved, time-limited
  exception exists; the login is disabled when nothing else authorizes it. See
  [employee lifecycle](operations/employee-lifecycle.md#13-role-grants-at-termination).

## 3. Cross-organization isolation

One deployment can hold several organizations, and one person can work in several. Isolation is
enforced by the API, not by separate databases:

- An employee's organization comes from the positions their assignments fill. Queries are
  filtered by the organizations, units, departments and teams the caller's grants cover, in the
  query itself and before any row limit.
- Records in an organization where the caller holds none of the relevant permissions generally
  answer **404**, like a missing record, so their existence is not revealed. Inside an
  organization the caller can see, a missing permission or narrower scope answers **403**. Some
  older routes answer 403 rather than 404 for out-of-scope records; both refuse access.
- Organization structure routes (`organization/organization-authorization.interceptor.ts`)
  check `organization.read` or `organization.manage` against the target unit, department, team,
  position or work location, and filter list results to the caller's readable scope.
- Timesheets show only their own organization's segments; managers see a count of segments
  outside their scope, not their minutes. Kiosks identify employees only for assignments in the
  kiosk's own organization. A PIN shared across organizations can be issued or revoked only by
  someone with the credential permission in each of them.
- Payroll, documents, recruitment, onboarding task ownership, reporting (with small-group
  suppression) and notifications apply the same scoping. Database specs such as
  `time-organization-isolation`, `payroll-organization-isolation` and `m1-account-isolation`
  cover these paths.

## 4. Audit log

Code: `apps/api/src/audit`; migrations `20270126090000_phase19_data_hardening` and
`20271201090000_r2_audit_log_append_only`.

**What is recorded.** Security events (sign-ins, failures, lockouts, session revocations, token
reuse) and business changes across the modules, with actor, entity, request id, address and
user agent. Audit metadata holds identifiers and safe metadata (ids, codes, dates, counts, the
names of changed fields); free text written about a person, contact details, document URLs,
storage keys and secrets are kept out of it. Administrators' operational justifications on
corrections and the before/after amounts of compensation and payroll changes are recorded by
design as the financial control record. The in-app audit viewer returns only a whitelisted,
value-checked subset (no addresses, user agents, emails or free text).

**Append-only at the database level.** Triggers on `AuditLog`:

| Operation                           | Result                                                                                                                                                   |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `INSERT`                            | Allowed                                                                                                                                                  |
| `UPDATE` (any column)               | Refused, including the `ON DELETE SET NULL` of the actor foreign key, so deleting a user who appears in the log is refused                               |
| `DELETE` outside retention          | Refused                                                                                                                                                  |
| `DELETE` in a retention transaction | Allowed only for organization entries older than that organization's configured retention period (minimum 24 months; retention is off unless configured) |
| `TRUNCATE`                          | Refused                                                                                                                                                  |

The trigger functions and the retention helpers they rely on run with a fixed `search_path`
(`pg_catalog, public, pg_temp`), so a session cannot substitute look-alike functions or tables
through its own search path. `apps/api/test/r2-audit-log-append-only.db-spec.ts` covers these
cases.

**Limits.** These are PostgreSQL triggers, not a tamper-proof store:

- A role that owns the `AuditLog` table, or a superuser, can disable or drop the triggers. In
  the current single-role arrangement the application connects as the table owner, so the
  triggers stop application bugs and SQL running with the application's privileges without DDL,
  but not someone who holds the application's database credentials. See
  [section 8](#8-database-access-controls).
- Any session can mark its transaction as a retention transaction. That only allows the
  age-limited retention deletes above, never an update.
- There is no external copy, hash chain or signing of entries.

**Profile edits** (`employee/employee-profile-audit.ts`). The `EMPLOYEE_UPDATED` entry lists
only the fields that changed, with masked hints of the values before and after:

| Field                 | Recorded as                                                |
| --------------------- | ---------------------------------------------------------- |
| Legal/preferred names | First character only (`A***`)                              |
| Personal email        | First character and top-level domain only (`a***@***.com`) |
| Phone                 | Last two digits only (`***34`)                             |

The full values stay on the person record behind its own access control.

## 5. Kiosk authentication and rate limiting

Code: `apps/api/src/kiosk`, `apps/api/src/rate-limit`.

- **Enrollment.** An administrator with `time.device.manage` registers a device and receives a
  one-time enrollment code (10 characters from a 31-symbol alphabet, about 49 bits), valid for
  15 minutes, single use and stored only as a hash. Enrollment attempts are limited to 10 per
  client address per 15 minutes.
- **Device secret.** Entering the code issues a 32-byte random device secret, stored only as a
  SHA-256 hash and held by the kiosk browser in an `HttpOnly`, `SameSite=Strict` cookie scoped to
  `/kiosk` (`Secure` in production). Device requests must come from `WEB_ORIGIN`. Devices can be
  disabled, rotated (new code, old secret cleared) or permanently revoked.
- **PINs.** Six digits, separate from the account password, hashed with Argon2id and never
  returned after issue. Trivial PINs (one repeated digit, or a straight ascending or descending
  run) are refused. A PIN locks for 15 minutes after 5 consecutive failures.
- **Failure limits** on PIN identification, counted in Redis at several levels (defaults,
  configurable with `KIOSK_*_FAILURE_*`): device 30 per 5 minutes, device and employee 5 per
  15 minutes, employee across kiosks 15 per 15 minutes, organization 300 per 5 minutes. A
  general limit of 300 requests per minute per address applies to every kiosk route.
- **Fail closed.** Identification, enrollment and the general kiosk limit answer 503 when Redis
  is unavailable; no PIN or code is checked without a limiter.
- **Interaction tokens** after identification are random, stored hashed, single use, bound to
  the device and valid for 90 seconds.
- **Minimal disclosure.** After identification the kiosk shows only the employee's first (or
  preferred) name and generic warning codes. The kiosk page sends `Cache-Control: no-store`,
  `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex, nofollow` and a `Permissions-Policy`
  that disables camera, microphone and geolocation.

Kiosk flows have been tested in browsers (Chromium) and database specs, not on dedicated kiosk
hardware.

## 6. HTTP security headers and CORS

**API** (`apps/api/src/config/http-application.ts`), on every response including errors and
404s:

- `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`;
- `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`;
- `Cache-Control: no-store` by default;
- `Strict-Transport-Security: max-age=31536000; includeSubDomains` when `NODE_ENV=production`;
- no `X-Powered-By`; JSON bodies limited to 1 MB and URL-encoded bodies to 100 kB;
- global validation with `whitelist` and `forbidNonWhitelisted` (unknown fields are refused).

**CORS.** Exactly one allowed origin, `WEB_ORIGIN` (validated as a bare origin; required in
production), with credentials. Exposed headers: `Content-Disposition`, `Retry-After`,
`X-Request-Id`, `X-Report-Truncated`.

**Web** (`apps/web/src/lib/security/page-headers.ts`), on every page:

- a Content Security Policy:
  `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self' <API origin>; worker-src 'self' blob:; manifest-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'`;
- `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: strict-origin-when-cross-origin`;
- `Strict-Transport-Security: max-age=31536000` outside `next dev` (no `includeSubDomains`, no
  `preload`; browsers ignore it over plain HTTP);
- sign-in, recovery, account and kiosk pages additionally send `Cache-Control: no-store`,
  `Referrer-Policy: no-referrer` and `X-Robots-Tag: noindex, nofollow`.

**The `'unsafe-inline'` trade-off.** Next.js App Router pages include inline bootstrap scripts
whose content differs per page and build, so they cannot be allow-listed by hash, and a
per-request nonce would force every page to render dynamically. `script-src` therefore allows
`'unsafe-inline'`, which weakens the CSP as a defence against injected scripts. Mitigations: the
app renders no user-supplied HTML (no `dangerouslySetInnerHTML`), React escapes text, and the
rest of the policy blocks plugins, base-URL and form hijacking, framing and connections to other
origins. `'unsafe-eval'` and WebSocket sources are added only under `next dev`. `img-src` allows
any `https:` image because an organization's branding logo is an administrator-entered HTTPS
URL; loading it reveals visitors' addresses to that host.

`apps/web/e2e/security-csp.spec.ts` checks the policy in the browser.

## 7. Sensitive-data handling

- **Logs** (`apps/api/src/observability`). Each request produces one structured line with the
  request id, method, route template, status, duration and user id. Bodies, query strings,
  headers and cookies are never logged. As a backstop, keys such as `password`, `pin`, `token`,
  `secret`, `authorization`, `cookie`, `email`, `enrollmentCode` and `credentials` are redacted
  at any depth. Worker job failures log the job name, id and a sanitized error, never payloads.
- **Responses.** Password hashes, token hashes and PIN hashes are never returned. The employee
  directory and profile return professional fields; personal contact details are limited to
  narrower permissions.
- **Documents** (`apps/api/src/documents`).
  - Uploads are authorized against their target before the body is read, size-limited
    (10 MB default, 25 MB maximum), type-checked by content signature, checksummed and stored
    under server-generated keys outside the database.
  - Downloads use links that expire after 60 seconds: an HMAC-SHA256 token bound to one object
    for local storage, or a presigned URL for S3-compatible storage (the bucket must be private).
  - Four confidentiality levels decide who can see a record; storage references are never
    audited or logged.
  - No malware scanner ships. `DOCUMENT_REQUIRE_MALWARE_SCAN=true` refuses unscanned files, which
    with no scanner configured means refusing uploads.
- **Pay and compensation.** An employee sees only their own pay statements, through a
  self-service route. Payroll run detail needs `payroll.read` and compensation needs
  `compensation.read` for the assignment's scope. Payroll prepares gross pay only; statutory
  deductions and net pay are not calculated (`NET_PAY_NOT_CALCULATED`).
- **Integration credentials** (Google Workspace) are encrypted with AES-256-GCM using
  `INTEGRATION_ENCRYPTION_KEY`, which is never stored in the database; previous keys can be kept
  for rotation. The OAuth flow uses PKCE and a signed, bound state.
- **Retention.** Configurable per organization; audit-log retention has a 24-month minimum and
  is off unless configured. Revoked or expired sessions and used account links are deleted only
  when `AUTH_RECORD_RETENTION_ENABLED=true` on the worker.

## 8. Database access controls

**Current arrangement: a single role.** The API, the worker and `prisma migrate deploy` all use
the same `DATABASE_URL`. That role owns the tables, so it can run DDL, including disabling or
dropping the audit-log triggers described in [section 4](#4-audit-log). The append-only
guarantee therefore holds against application bugs and ordinary queries, not against anyone who
obtains the application's database credentials.

**Required before a hardened production release:** separate roles.

- A migration/owner role that owns the schema and is used only to run migrations.
- A least-privilege runtime role for the API and worker that owns no tables, has no `CREATE`
  privilege on any schema, and has only the table privileges the application needs. For
  `AuditLog` that is `SELECT`, `INSERT` and `DELETE` (the retention purge), with no `UPDATE` and
  no `TRUNCATE`.

This split is not implemented in the repository's migrations or configuration. An outline of the
grants is in [deployment](deployment.md#database-role-separation). Some other trigger functions
(retention triggers of other tables and record guards) do not pin their `search_path`; that
becomes relevant once the runtime role can no longer disable triggers, and should be addressed
together with the role split.

Other database-level controls: check constraints and triggers keep role-assignment scopes
consistent, finalized payroll runs immutable and time punches append-only. Local development
publishes PostgreSQL and Redis on `127.0.0.1` only (`docker-compose.yml`).

## 9. Known limits and open items

- Single database role; audit-log triggers can be disabled by the table owner (section 8).
- `script-src 'unsafe-inline'` in the web CSP (section 6).
- Refresh-token reuse is detected only for the immediately previous token.
- Sign-in limits are per address and per address and email; there is no per-account limit across
  addresses, so someone can deliberately lock an account for 15 minutes.
- Sign-in timing may still differ slightly between existing and unknown accounts (audit write and
  failure counter).
- No password blocklist; no multi-factor authentication.
- No malware scanning for uploaded documents.
- Metrics are a no-op hook by default; there is no built-in alerting (see
  [deployment](deployment.md#monitoring-and-logging)).
- The application is not designed as an unrestricted public hosted demo: the demo accounts hold
  real privileges, and there is no restricted demo mode.
- Testing covers Chromium only; no real screen-reader or kiosk-hardware testing. See
  [testing](testing.md).
- Dependency advisories (as of November 2026; recheck with `pnpm audit` and `pnpm audit --prod`).
  A clean audit only means no known advisory matched the installed versions; it does not show the
  application has no vulnerabilities.
  - `pnpm audit --prod` reports no known vulnerabilities. GHSA-7589-6fvf-x4pw (`effect` up to
    3.22.0, a regular-expression denial of service in `Schema.TemplateLiteral`; fixed in 3.22.1) is
    resolved by a pnpm override in `pnpm-workspace.yaml` that pins `effect` to 3.22.1.
    `@prisma/config` 7.10.0 pins `effect` to exactly 3.20.0, so an override is the only fix
    without upgrading Prisma. `effect` is in the tree through the Prisma CLI (`prisma` →
    `@prisma/config`), which uses it to load `prisma.config.ts` when generating the client or
    applying migrations, and as an optional peer of `@hookform/resolvers`. No application code
    imports it: the web app uses only the Zod resolver, and neither the API, the worker nor the web
    build contains it. Its only input is the repository's own configuration, never request data.
    Re-evaluate the override whenever Prisma is upgraded, and remove it once the installed
    `@prisma/config` depends on `effect` 3.22.1 or later (check with `pnpm why effect -r`).
  - The full audit (development dependencies included) reports one moderate advisory,
    GHSA-g3hv-75wg-m249 (`minimatch` 10.2.6, a denial of service through crafted glob patterns;
    fixed in 11.0.1). It is reached only through the web app's lint toolchain
    (`eslint-config-next` → `typescript-eslint` → `@typescript-eslint/typescript-estree` →
    `minimatch`), runs only when linting the repository's own files, and is not part of any build
    or deployed code. It is left until those lint packages ship a fixed version.
