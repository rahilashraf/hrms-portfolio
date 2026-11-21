# Architecture

This document describes how Portfolio HRMS is built: the code layout, the three runtime
applications, the data model's organization and permission boundaries, and the main
workflows. Each section names the source files it describes, so the text can be checked
against the code. Where the code and this document disagree, the code is authoritative.

## Contents

1. [Monorepo](#1-monorepo)
2. [System context](#2-system-context)
3. [Runtime components](#3-runtime-components)
4. [Next.js frontend](#4-nextjs-frontend)
5. [NestJS API](#5-nestjs-api)
6. [PostgreSQL and Prisma](#6-postgresql-and-prisma)
7. [Redis, BullMQ and background jobs](#7-redis-bullmq-and-background-jobs)
8. [Authentication and sessions](#8-authentication-and-sessions)
9. [Organization and permission scope model](#9-organization-and-permission-scope-model)
10. [Scheduling, attendance and payroll data](#10-scheduling-attendance-and-payroll-data)
11. [Documents and storage abstraction](#11-documents-and-storage-abstraction)
12. [Notifications and email](#12-notifications-and-email)
13. [Deployment topology](#13-deployment-topology)
14. [Testing layers](#14-testing-layers)

## 1. Monorepo

pnpm workspaces (`pnpm-workspace.yaml`) with Turborepo (`turbo.json`). Node.js 24.10 or newer.

| Path                  | Package            | Purpose                                                               |
| --------------------- | ------------------ | --------------------------------------------------------------------- |
| `apps/web`            | `web`              | Next.js 16 / React 19 frontend, including the onsite attendance kiosk |
| `apps/api`            | `api`              | NestJS REST API; owns the Prisma client and all business rules        |
| `apps/worker`         | `worker`           | BullMQ worker; runs job handlers compiled from `apps/api`             |
| `packages/config`     | `@hrms/config`     | Zod environment validation, used by the API                           |
| `packages/validation` | `@hrms/validation` | Shared password policy (12 to 128 characters), used by the API        |
| `prisma/`             | —                  | `schema.prisma` and the migration history (62 migrations)             |

```mermaid
flowchart LR
  subgraph apps
    web["apps/web<br/>Next.js"]
    api["apps/api<br/>NestJS + Prisma"]
    worker["apps/worker<br/>BullMQ"]
  end
  subgraph packages
    config["@hrms/config"]
    validation["@hrms/validation"]
  end
  schema[("prisma/schema.prisma<br/>+ migrations")]
  web -- "HTTP (fetch)" --> api
  worker -- "workspace dependency:<br/>imports api build output" --> api
  api --> config
  api --> validation
  api -- "generates client into<br/>apps/api/src/generated/prisma" --> schema
```

The web app shares no code with the API; it talks to it only over HTTP. Turborepo builds the
API (after `prisma generate`) before the worker, because the worker imports the API's compiled
job modules through the `exports` map in `apps/api/package.json`.

## 2. System context

```mermaid
flowchart LR
  staff["Employees, managers,<br/>HR and payroll staff<br/>(browser)"]
  kiosk["Onsite kiosk<br/>(enrolled browser)"]
  subgraph hrms["Portfolio HRMS"]
    web["web"]
    api["api"]
    worker["worker"]
  end
  pg[("PostgreSQL")]
  redis[("Redis")]
  store[("Document storage<br/>local disk or S3-compatible<br/>(optional)")]
  smtp["SMTP server<br/>(optional)"]
  google["Google Workspace APIs<br/>OAuth, Forms, Drive, Gmail, Sheets<br/>(optional, per organization)"]

  staff --> web
  staff --> api
  kiosk --> web
  kiosk --> api
  api --> pg
  api --> redis
  worker --> pg
  worker --> redis
  api --> store
  worker --> store
  api --> smtp
  worker --> smtp
  api --> google
  worker --> google
```

- Without document storage configured (`DOCUMENT_STORAGE_DRIVER=none`, the default) uploads
  are refused; references to external files can still be recorded.
- Without SMTP or a Google Workspace connection, email is suppressed (in production, account
  email then answers 503 instead of pretending to send).
- The Google Workspace connection is made per organization through OAuth
  (`apps/api/src/integrations/google`). It is used to read bound Google Forms, check Drive
  references, send email through Gmail and export reports to Sheets. It is not a sign-in
  method.
- No other external services are integrated. There is no bundled malware scanner, no payment
  or statutory-payroll provider and no single sign-on.

## 3. Runtime components

```mermaid
flowchart LR
  browser["Browser"]
  kiosk["Kiosk browser"]
  web["web<br/>Next.js"]
  api["api<br/>NestJS"]
  worker["worker<br/>BullMQ"]
  pg[("PostgreSQL")]
  redis[("Redis")]
  store[("Document storage")]

  browser -- "pages" --> web
  kiosk -- "pages" --> web
  browser -- "JSON API, Bearer token<br/>+ refresh cookie" --> api
  kiosk -- "JSON API, device cookie" --> api
  api -- "Prisma, transactions" --> pg
  api -- "rate limits,<br/>enqueue account email" --> redis
  api --> store
  worker -- "queue hrms-default,<br/>schedules, heartbeat" --> redis
  worker -- "job handlers" --> pg
  worker -- "upload clean-up,<br/>reference checks" --> store
```

The browser calls the API directly from client components; the Next.js server does not proxy
API requests.

## 4. Next.js frontend

`apps/web/src` (details in [apps/web/README.md](../../apps/web/README.md))

- **API access:** `lib/api-config.ts` reads `NEXT_PUBLIC_API_URL` (an origin; HTTPS required for
  production builds). `lib/auth/api-client.ts` keeps the access token in memory only, sends it as
  a Bearer token, and on a 401 refreshes once through `POST /auth/refresh` (the HttpOnly cookie)
  and retries. A 403 `PASSWORD_CHANGE_REQUIRED` sends the user to the password change; a 429
  surfaces `Retry-After`.
- **Route groups:** `app/(app)` holds sign-in, password recovery, invitations and email
  verification. `app/(app)/(authenticated)` wraps every signed-in page in `ProtectedRoute`,
  `WorkspaceProvider` and `AppShell`. `app/(kiosk)/kiosk` is the attendance kiosk.
- **Permission gating** (`components/ui/require-permission.tsx`, `lib/authorization/`) only
  hides what a user cannot use. It is presentation, not security: the API decides.
- **Security headers** for pages come from `next.config.ts` `headers()`
  (`lib/security/page-headers.ts`): a Content Security Policy, baseline headers and, outside
  development, HSTS (`max-age=31536000`). There is no Next.js middleware.
- **UI building blocks** (`components/ui/`) and accessibility conventions are described in
  [docs/design/design-system.md](../design/design-system.md).

## 5. NestJS API

`apps/api/src` (details in [apps/api/README.md](../../apps/api/README.md)). Feature modules are
registered in `app.module.ts`; the HTTP pipeline is built in `config/http-application.ts`.

```mermaid
flowchart TB
  req["HTTP request"] --> proxy["trust proxy (TRUST_PROXY_HOPS)"]
  proxy --> rid["request id"]
  rid --> headers["security headers<br/>(nosniff, no-referrer, DENY framing,<br/>CSP default-src 'none', no-store, HSTS in production)"]
  headers --> body["request logging, cookies,<br/>body limits (JSON 1 MB)"]
  body --> cors["CORS: exactly WEB_ORIGIN, credentials"]
  cors --> rl["RateLimitGuard (global, Redis)"]
  rl --> guard["AccessTokenGuard (per controller)"]
  guard --> pipe["ValidationPipe<br/>whitelist + forbidNonWhitelisted"]
  pipe --> ctrl["controller"]
  ctrl --> svc["domain service<br/>authorization → feature gate → rules"]
  svc --> prisma["Prisma (transactions)"]
```

Feature folders: `auth`, `sessions`, `users`, `authorization`, `organization`, `employee`, `time`,
`scheduling`, `calendar`, `leave`, `compensation`, `kiosk`, `payroll`, `benefits`, `performance`,
`recruitment`, `onboarding` (onboarding and offboarding), `documents`, `notifications`,
`integrations/google`, `reporting`, `features`, `branding`, `workspace`, `audit`, plus
infrastructure (`health`, `observability`, `rate-limit`, `redis`, `database`, `email`,
`retention`, `security`). Requests carry no API version prefix.

Business rules live in services, not controllers. Concurrency is handled per workflow: timesheet
review and the feature and branding settings take an `expectedVersion`; clock, kiosk and leave
ledger actions take an idempotency key; status transitions are conditional updates inside a
transaction, so of two people acting at once only one succeeds.

## 6. PostgreSQL and Prisma

- One PostgreSQL database; schema `prisma/schema.prisma`, migrations in `prisma/migrations`,
  applied with `pnpm db:migrate:deploy`. Prisma 7 uses the `pg` driver adapter.
- Times are stored as `timestamptz` instants. Local dates (work dates, leave days, pay periods)
  are computed in an IANA time zone (`common/timezone.ts`).
- Money is decimal with an explicit ISO 4217 currency on each record (`CompensationRecord`,
  `PayrollRun`, `BenefitPlan`); currency is never inferred from the organization.
- Many cross-record links use composite foreign keys on `[id, organizationId]` (role-assignment
  scopes, pay groups, payroll periods and runs), so the database itself refuses a link between
  records of different organizations. Not every link does: for example a position's unit,
  department and team, and an assignment's manager, are linked on `id` alone and checked in
  services.
- Changes to people, access, time, pay and documents write `AuditLog` rows, viewable per
  organization. Database triggers refuse `UPDATE` and `TRUNCATE` on `AuditLog`; `DELETE` is
  allowed only for the retention purge of entries older than 24 months. A role that owns the
  table can disable the triggers, so a hardened deployment needs a separate least-privilege
  runtime role (see [docs/security.md](../security.md)).

## 7. Redis, BullMQ and background jobs

`apps/worker/src` (details and the full job table in
[apps/worker/README.md](../../apps/worker/README.md)). One BullMQ queue, `hrms-default`, is
consumed by one `Worker` (`WORKER_CONCURRENCY`, default 1). Repeatable schedules are registered at
start-up with `upsertJobScheduler` in UTC (`schedules.ts`); the handlers are the API's compiled
job modules (`apps/api/src/*/*-jobs.ts`).

```mermaid
flowchart LR
  subgraph worker["worker process"]
    reg["registerSchedules()<br/>upsert enabled, remove disabled"]
    w["BullMQ Worker<br/>concurrency 1–10"]
    route["createJobProcessor()<br/>job name → handler"]
    health["/health, /ready<br/>+ Redis heartbeat"]
  end
  subgraph redis["Redis"]
    q[["queue hrms-default"]]
  end
  apisvc["api: account recovery<br/>and verification"] -- "add auth.deliver-account-email" --> q
  reg -- "job schedulers (UTC cron)" --> q
  q --> w --> route
  route -- "unknown name" --> fail["fail at once,<br/>never retried"]
  route --> handlers["API job modules<br/>(api/*-jobs exports)"]
  handlers --> pg[("PostgreSQL")]
  handlers --> ext["SMTP / Google Workspace /<br/>document storage"]
```

| Kind                | Jobs                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Always scheduled    | shift generation, leave entitlements, assignment activation, open time-entry scan, payroll period preparation, evidence and application sync, offer expiry, onboarding/performance/recruitment reminders, document expiry reminders, reference checks and upload clean-up, notification publishing and delivery (every 2 minutes), Google Forms sync and health check, retention, auth-record pruning |
| On unless disabled  | retained-grant reconciliation (`RETAINED_GRANT_RECONCILIATION_ENABLED`)                                                                                                                                                                                                                                                                                                                               |
| Off unless enabled  | `TIME_ATTENDANCE_AUTOMATION_ENABLED` (attendance period preparation, no-show detection); `EMPLOYEE_LIFECYCLE_AUTOMATION_ENABLED` (due terminations, due assignment ends). A switched-off group's schedules are removed at start-up.                                                                                                                                                                   |
| Enqueued by the API | `auth.deliver-account-email` (password resets and email verification)                                                                                                                                                                                                                                                                                                                                 |

`AUTH_RECORD_RETENTION_ENABLED` must be `true` before the pruning job deletes anything, and data
retention applies only to organizations that opted in. Payroll preparation creates periods and
timesheets but never calculates or finalizes a run.

Redis also holds the API's rate-limit counters (sign-in, kiosk PIN failures and per-route
policies).

## 8. Authentication and sessions

```mermaid
sequenceDiagram
  autonumber
  participant B as Browser (web)
  participant A as API
  participant R as Redis
  participant D as PostgreSQL
  B->>A: POST /auth/login (email, password)
  A->>A: Origin, if sent, must equal WEB_ORIGIN
  A->>R: sign-in limits (10/min per IP, 5/15 min per IP + email)
  A->>D: user, Argon2id verify (dummy hash when unknown)
  A->>D: create AuthSession (SHA-256 of refresh token)
  A-->>B: access token (JWT HS256, 15 min) in body<br/>Set-Cookie hrms_refresh (HttpOnly, SameSite=Lax, path /auth, 30 days)
  B->>A: API call, Authorization: Bearer
  A->>D: AccessTokenGuard: session still active?
  B->>A: POST /auth/refresh (cookie) on 401
  A->>D: rotate refresh token (previous one valid 30 s, then reuse revokes the session)
  A-->>B: new access token + new cookie
```

- Access tokens live only in browser memory; a page reload refreshes from the cookie. Because the
  cookie is `SameSite=Lax`, the web and API origins must be same-site.
- Sign-in rate limiting fails closed: if Redis is unavailable, sign-in answers 503.
- Five failed sign-ins lock an account for 15 minutes.
- Invitations, password resets and email verification use single-use random tokens stored as
  SHA-256 hashes, with lifetimes of 7 days, 30 minutes and 24 hours. Password-reset and
  verification emails are queued for the worker, so the API answers the same way whether or not
  an address exists; invitations are sent by the API directly.
- An administrator can require a password change; the API then refuses every other request with
  403 `PASSWORD_CHANGE_REQUIRED`.
- **Kiosk:** a device is enrolled with a one-time 15-minute code and then holds a device secret in
  the `hrms_kiosk` cookie (stored hashed). Employees identify with a 6-digit PIN (Argon2id); PIN
  failures are rate-limited per device, employee and organization.
- Not implemented: multi-factor authentication and single sign-on.

## 9. Organization and permission scope model

```mermaid
erDiagram
  Organization ||--o{ OrganizationalUnit : contains
  OrganizationalUnit |o--o{ OrganizationalUnit : "parent of"
  Organization ||--o{ Department : contains
  OrganizationalUnit |o--o{ Department : groups
  Organization ||--o{ Team : contains
  Department |o--o{ Team : groups
  Organization ||--o{ Position : owns
  Position }o--o| OrganizationalUnit : "in"
  Position }o--o| Department : "in"
  Position }o--o| Team : "in"
  Position }o--o| WorkLocation : "at"
  Person ||--o| Employee : "is"
  Person ||--o| User : "signs in as"
  Employee ||--o{ EmploymentAssignment : holds
  EmploymentAssignment }o--|| Position : fills
  EmploymentAssignment }o--o| EmploymentAssignment : "manager"
  User ||--o{ RoleAssignment : "is granted"
  RoleAssignment }o--|| Role : grants
  RoleAssignment }o--o| Organization : "scope"
  RoleAssignment }o--o| OrganizationalUnit : "scope"
  RoleAssignment }o--o| Department : "scope"
  RoleAssignment }o--o| Team : "scope"
  Role }o--o| Organization : "belongs to (or global)"
  Role ||--o{ RolePermission : includes
  RolePermission }o--|| Permission : "is"
```

- An employee's organization is never a field on `Employee`: it comes from the position each
  `EmploymentAssignment` fills. One person can therefore work in several organizations, each
  assignment with its own manager, pay, schedule and time zone (the work location's, else the
  organization's).
- A `RoleAssignment` has a scope type (`SYSTEM`, `ORGANIZATION`, `ORGANIZATIONAL_UNIT`,
  `DEPARTMENT`, `TEAM`) and is effective between `startsAt` and `expiresAt` unless revoked.

```mermaid
flowchart LR
  svc["Domain *-access service"] -- "can(user, permission, target)" --> authz["AuthorizationService"]
  authz -- "effective grants<br/>(not revoked, started, not expired,<br/>organization and role not archived)" --> grants["grants"]
  authz -- "resolve target:<br/>organization, unit path,<br/>department, team" --> target["target"]
  grants --> scope{"grant scope<br/>contains target?"}
  target --> scope
  scope -- no --> deny["403 or 404"]
  scope -- yes --> gate["FeatureGateService<br/>(module enabled for the org?)"]
  gate --> selfrule{"self-target rule?"}
  selfrule -- "own leave / timesheet / payroll /<br/>pay / benefits / documents" --> deny2["403 *_SELF_* code"]
  selfrule -- ok --> allow["business rule checks"]
```

- Scope containment (`authorization/authorization.policy.ts`): `SYSTEM` covers everything; an
  `ORGANIZATION` grant covers its organization; an `ORGANIZATIONAL_UNIT` grant covers targets
  whose unit path includes that unit (so a grant on an ancestor covers its descendants); a
  `DEPARTMENT` grant covers the department and its teams; a `TEAM` grant covers the team.
- Permissions are checked in services (`authorization/authorization.service.ts` and one
  `*-access.service.ts` per domain), not by route decorators, because almost every decision
  depends on the target record's organization and unit. Every non-public controller uses
  `AccessTokenGuard`.
- The catalog has 74 permissions (`authorization/authorization-catalog.ts`). Role templates
  (`authorization/role-templates.ts`) cover organization, HR, payroll, time and attendance
  administrators, schedulers, recruiters, managers, employees and auditors. The System Owner
  role is reserved and granted only by the `authz:bootstrap-owner` command.
- **Separation of duties:** nobody approves their own leave, timesheet or payroll, adjusts their
  own leave or payroll, or manages their own compensation, benefits or documents.
- **Isolation:** queries are filtered by the organizations the caller's grants cover. An
  out-of-scope candidate, leave request, document, piece of evidence or role answers 404. Some
  other resources (organization structure details, payroll runs, benefit plans, pay groups,
  performance cycles, kiosk devices, assignment-scoped compensation and benefits routes) answer
  403 for an existing identifier, without returning data.

## 10. Scheduling, attendance and payroll data

```mermaid
flowchart TB
  shift["ScheduledShift (PUBLISHED)<br/>+ ScheduledShiftRevision"]
  entry["TimeEntry<br/>web, kiosk or manual<br/>owner: employmentAssignmentId"]
  cover["TimeEntryAssignmentCoverage<br/>other assignments covered<br/>(no extra minutes)"]
  exc["AttendanceException<br/>missing clock-out, late, no-show …"]
  corr["TimeCorrectionRequest /<br/>manager correction"]
  ts["Timesheet<br/>(employee × TimePeriod)"]
  seg["TimesheetSegment<br/>(one per assignment)"]
  appr["Segment APPROVED<br/>approvedWorkedMinutes fixed"]
  pp["PayrollPeriod<br/>(PayGroup × TimePeriod)"]
  run["PayrollRun<br/>DRAFT → CALCULATED → APPROVED → FINALIZED"]
  ra["PayrollRunEmployee →<br/>PayrollRunAssignment"]
  snaps["Snapshots: time, compensation,<br/>leave, benefits, presence"]
  claim["PayrollSourceClaim<br/>(worked time, salary day,<br/>leave day, benefit day)"]
  lines["Earning, deduction and<br/>employer-contribution lines"]
  adj["PayrollAdjustment<br/>(carried by a later run)"]

  shift -. "matched at clock-in" .-> entry
  entry --> cover
  entry --> exc
  exc --> corr
  corr --> entry
  entry -- "minutes to owner assignment" --> seg
  ts --> seg
  seg -- "submit, approve<br/>(not your own)" --> appr
  pp --> run
  run --> ra
  appr --> snaps
  ra --> snaps
  ra --> claim
  snaps --> lines
  run -- "after FINALIZED" --> adj
```

Other payroll inputs are effective-dated `CompensationRecord`s, approved leave days and benefit
enrollments. Published schedules and presence records are shown for context only; payroll never
pays from schedules.

- **Multi-assignment attendance** (`time/time-coverage.ts`): one `TimeEntry` is one physical work
  interval. Its `employmentAssignmentId` is the payroll owner, and timesheet segments, payroll and
  reports attribute the interval's minutes to that assignment only. Coverage rows name the other
  assignments it covers (at most 10 in total) and never add time, so the interval is paid once.
- **Time zones:** work dates, overnight shifts and daylight-saving transitions are computed in the
  shift's IANA time zone. Policies are layered: system, organization, unit, department, team,
  assignment (`TimeAttendancePolicy`).
- **Exceptions:** blocking exceptions prevent timesheet submission. Attendance recorded after
  approval raises an exception instead of silently changing an approved timesheet.
  Presence-only sign-ins and sign-outs (`AttendanceSignIn`/`AttendanceSignOut`) record who is on
  site without creating payable minutes.
- **Payroll** (`payroll/payroll-engine.ts`, `payroll/payroll-source.service.ts`): a calculation
  snapshots its inputs and claims each source (`PayrollSourceClaim`), so the same hours, salaried
  day or leave day cannot be paid by two live runs. A finalized run is never rewritten; later
  changes become `PayrollAdjustment` records carried by the next run. Approval requires a
  different person from the one whose pay is affected.
- **Not calculated:** statutory deductions and net pay. `PayrollRun.statutoryStatus` defaults to
  `NOT_CALCULATED`; only an interface exists (`payroll/statutory/statutory-payroll.contracts.ts`),
  and the payroll pages and register say so.
- Operating details: [docs/operations/time-attendance.md](../operations/time-attendance.md) and
  [docs/operations/employee-lifecycle.md](../operations/employee-lifecycle.md).

```mermaid
stateDiagram-v2
  [*] --> DRAFT
  DRAFT --> CALCULATED: calculate
  CALCULATED --> CALCULATED: recalculate
  CALCULATED --> APPROVED: approve (not your own pay)
  APPROVED --> CALCULATED: recalculate (approval cleared)
  APPROVED --> FINALIZED: finalize
  DRAFT --> VOIDED: void
  CALCULATED --> VOIDED: void
  APPROVED --> VOIDED: void
  FINALIZED --> [*]
  VOIDED --> [*]
```

## 11. Documents and storage abstraction

Two boundaries in `apps/api/src/documents`:

- **Object store** (`document-object-store.ts`): `documentStorageFromEnv` selects the driver from
  `DOCUMENT_STORAGE_DRIVER`: `none` (the default; uploads are refused), `local`
  (`LocalDocumentObjectStore`: files under `DOCUMENT_STORAGE_LOCAL_DIR` and HMAC-signed download
  links; refused in production unless `DOCUMENT_STORAGE_ALLOW_LOCAL_IN_PRODUCTION=true`) or `s3`
  (`S3DocumentObjectStore`: any S3-compatible endpoint, requests signed with `aws4fetch`, HTTPS
  required in production). Object keys are `documents/<organizationId>/<objectId>`.
- **Storage adapters** (`document-storage.contract.ts`): provider-neutral reference checks for
  stored versions. `documents.module.ts` registers a Google Drive adapter (used only where the
  organization has a Google Workspace connection) and, when an object store is configured,
  `InternalObjectStorageAdapter`; the worker's `documents.verify-references` job uses the same
  set.

```mermaid
sequenceDiagram
  autonumber
  participant B as Browser
  participant A as API
  participant S as Object store (local or S3)
  B->>A: POST /documents/uploads (multipart)
  A->>A: authorize the target before reading the body
  A->>A: stream to a temp file, size, SHA-256, type check<br/>optional malware scanner
  A->>S: put object documents/orgId/objectId
  A-->>B: uploadId (ledger: STORED)
  B->>A: create record / version with uploadId (ATTACHED)
  B->>A: POST …/versions/:id/download-url
  A-->>B: 60-second URL (S3 presigned, or HMAC-signed local link)
```

- PDF, PNG and JPEG; 10 MB by default (`DOCUMENT_UPLOAD_MAX_BYTES`, at most 25 MB).
- Confidentiality: `EMPLOYEE_VISIBLE`, `MANAGER_VISIBLE`, `HR_ONLY`, `RESTRICTED`.
- A worker job removes uploads never attached within 24 hours.
- No malware scanner is bundled. `DOCUMENT_REQUIRE_MALWARE_SCAN=true` refuses files that were not
  scanned.

## 12. Notifications and email

```mermaid
flowchart LR
  domain["Committed domain records<br/>(leave, timesheets, schedules,<br/>payroll, benefits …)"] --> pub["notifications.publish-events<br/>(worker, every 2 min)<br/>checkpoint per source + dedupe key"]
  pub --> notif["Notification<br/>IN_APP: visible at once"]
  pub --> deliv["NotificationDelivery (EMAIL)"]
  deliv --> sender["notifications.deliver-pending<br/>(every 2 min), lease + retries"]
  sender --> gmail["Organization's Google Workspace Gmail"]
  sender --> smtp["SMTP (SMTP_*)"]
  sender --> none["no provider: SUPPRESSED"]
  sender --> log["NotificationDeliveryAttempt<br/>(delivery log)"]
```

- Notifications are derived from records that have already committed, by reading forward from a
  stored checkpoint (`NotificationProducerCheckpoint`), rather than published from inside request
  transactions. A failed request therefore never notifies, and a restarted worker resumes where it
  stopped.
- Users choose email preferences per category; security and required HR messages cannot be
  turned off.
- Account email (invitations from the API; password resets and verification from the worker)
  uses the same order: the organization's Gmail connection, else SMTP, else a development
  fallback that refuses in production.

## 13. Deployment topology

The applications are three independent processes built from this repository. A deployment
needs:

```mermaid
flowchart TB
  user["Users and kiosks"] -->|"HTTPS, e.g. hr.example.com"| web["web<br/>next start"]
  user -->|"HTTPS, e.g. api.hr.example.com"| api["api<br/>node dist/main.js<br/>/health, /ready"]
  worker["worker<br/>node dist/index.js<br/>no public ingress<br/>optional /health, /ready"]
  migrate["one-off migration step<br/>pnpm db:migrate:deploy<br/>(owner role)"]
  api --> pg[("PostgreSQL<br/>runtime role")]
  worker --> pg
  migrate --> pg
  api --> redis[("Redis")]
  worker --> redis
  api -.-> s3[("S3-compatible storage<br/>(optional)")]
  worker -.-> s3
  api -.-> smtp["SMTP (optional)"]
  worker -.-> smtp
```

- Web and API must be same-site (for example `hr.example.com` and `api.hr.example.com`) for the
  refresh cookie; `WEB_ORIGIN` and `NEXT_PUBLIC_API_URL` name each other's origins, and the web
  build requires an HTTPS API origin.
- `TRUST_PROXY_HOPS` must match the real proxy chain in front of the API.
- Migrations run once per release before the new API starts, never from application start-up.
  The first account is created with `authz:create-initial-user` and `authz:bootstrap-owner`, never
  with the development seed.
- The API's `/health` is liveness; `/ready` checks PostgreSQL and Redis. The worker serves the
  same probes on `WORKER_HEALTH_PORT` when set.
- No production deployment has been verified. Prerequisites, including the separate runtime and
  migration database roles, are in [docs/deployment.md](../deployment.md).

## 14. Testing layers

| Layer                                                                  | Location                                          | Command                           |
| ---------------------------------------------------------------------- | ------------------------------------------------- | --------------------------------- |
| API unit (Vitest)                                                      | `apps/api/**/*.spec.ts`                           | `pnpm --filter api test`          |
| API database integration                                               | `apps/api/test/**/*.db-spec.ts`                   | `pnpm --filter api test:db`       |
| API HTTP end-to-end (includes a route-boundary suite over every route) | `apps/api/test/**/*.e2e-spec.ts`                  | `pnpm --filter api test:e2e`      |
| Web unit (Vitest, Testing Library)                                     | `apps/web/src/**/*.test.{ts,tsx}`                 | `pnpm --filter web test`          |
| Web end-to-end, API mocked, with axe checks                            | `apps/web/e2e/`                                   | `pnpm --filter web test:e2e`      |
| Web end-to-end against a real API and database                         | `apps/web/e2e-real/`                              | `pnpm --filter web test:e2e:real` |
| Demo smoke (eight accounts)                                            | `apps/web/e2e-demo/`                              | `pnpm --filter web test:e2e:demo` |
| Worker (Node test runner)                                              | `apps/worker/src/jobs.test.ts`, `runtime.test.ts` | `pnpm --filter worker test`       |

Results, environment requirements and known open issues: [docs/testing.md](../testing.md).
