# Worker (`apps/worker`)

The background worker of Portfolio HRMS: a single BullMQ worker process that runs scheduled
and enqueued jobs. For the system as a whole see the [root README](../../README.md) and
[docs/architecture/README.md](../../docs/architecture/README.md).

## Responsibilities

- Consume the `hrms-default` queue in Redis with one BullMQ `Worker`.
- Register the repeatable schedules at start-up with `upsertJobScheduler` (stable scheduler ids,
  UTC cron patterns), and remove the schedules of switched-off automation.
- Route each job name to its handler. Handlers are the API's compiled job modules; the worker
  itself contains no business rules.
- Report liveness and readiness, write a Redis heartbeat and shut down gracefully.

## Source layout

| File               | Contents                                                                                        |
| ------------------ | ----------------------------------------------------------------------------------------------- |
| `src/index.ts`     | Process entry: environment checks, Redis connection, worker, schedules, health server, shutdown |
| `src/jobs.ts`      | Job-name to handler routing; unknown job names fail at once and are never retried               |
| `src/schedules.ts` | Schedule definitions, retry policies and completed/failed job retention                         |
| `src/runtime.ts`   | Settings parsing, failure log lines (no payloads), heartbeat, health server, shutdown           |
| `src/*.test.ts`    | Tests for routing, schedules and runtime (Node test runner)                                     |

## Jobs

All patterns are UTC. Handlers come from the `api/*-jobs` exports of `apps/api/package.json`.

| Job                                                               | Schedule                 | Purpose                                                                                                                                                                            |
| ----------------------------------------------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scheduling.extend-generated-shifts`                              | daily 02:15              | Extend shifts generated from recurring patterns                                                                                                                                    |
| `leave.process-entitlements`                                      | daily 02:30              | Leave grants, accruals, carryover and expiry                                                                                                                                       |
| `employee.activate-due-assignments`                               | hourly                   | Activate planned assignments whose start date has arrived                                                                                                                          |
| `employee.reconcile-retained-grants`                              | every 15 minutes         | Disable a terminated employee's sign-in once their last retained grant has ended                                                                                                   |
| `time.scan-open-entries`                                          | every 15 minutes         | Raise missing clock-out exceptions                                                                                                                                                 |
| `payroll.prepare-periods`                                         | daily 06:20              | Prepare payroll periods and timesheets; never calculates or finalizes payroll                                                                                                      |
| `performance.sync-evidence`, `recruitment.sync-applications`      | daily 06:40, hourly      | Provider-neutral evidence and application import; no provider adapter is registered for these jobs, so they import nothing (Google Forms data arrives through `google.sync-forms`) |
| `recruitment.expire-offers`                                       | daily 05:15              | Record expired offers                                                                                                                                                              |
| `onboarding.task-reminders`, `performance.reminders`              | daily                    | Reminder digests                                                                                                                                                                   |
| `recruitment.reminders`                                           | hourly                   | Recruitment reminders                                                                                                                                                              |
| `documents.expiry-reminders`, `documents.verify-references`       | daily                    | Expiry digests; check document references (internal storage, Google Drive)                                                                                                         |
| `documents.cleanup-uploads`                                       | hourly                   | Remove uploads never attached within 24 hours                                                                                                                                      |
| `notifications.publish-events`                                    | every 2 minutes          | Create notifications from committed records, from a stored checkpoint                                                                                                              |
| `notifications.deliver-pending`                                   | every 2 minutes          | Deliver email notifications (organization Gmail, else SMTP, else suppressed)                                                                                                       |
| `google.sync-forms`, `google.health-check`                        | every 15 minutes, hourly | Import bound Google Forms responses as performance evidence, applications and onboarding task completions; check connection health                                                 |
| `retention.apply`                                                 | daily 03:35              | Data retention for organizations that opted in                                                                                                                                     |
| `auth.prune-sessions-and-tokens`                                  | daily 03:50              | Delete expired sessions and account tokens when `AUTH_RECORD_RETENTION_ENABLED=true`                                                                                               |
| `time.prepare-attendance-periods`, `time.detect-no-shows`         | off unless enabled       | Attendance automation (`TIME_ATTENDANCE_AUTOMATION_ENABLED=true`)                                                                                                                  |
| `employee.apply-due-terminations`, `employee.end-due-assignments` | off unless enabled       | Lifecycle automation (`EMPLOYEE_LIFECYCLE_AUTOMATION_ENABLED=true`)                                                                                                                |
| `auth.deliver-account-email`                                      | enqueued by the API      | Password-reset and email-verification messages                                                                                                                                     |

The retained-grant reconciliation is on unless `RETAINED_GRANT_RECONCILIATION_ENABLED=false`;
`RETAINED_GRANT_RECONCILIATION_CRON` overrides its pattern. Daily and hourly jobs retry three
times with exponential backoff, quarter-hourly jobs once, and two-minute jobs not at all (the
next run is the retry). Completed jobs are kept for up to 7 days (200 jobs) and failed jobs for
up to 30 days (1,000 jobs).

## Framework and main dependencies

BullMQ 6 and ioredis on Node.js 24, `dotenv`, and the workspace package `api`
(`"api": "workspace:*"`), which also brings Prisma and the domain code. Built with `tsc`; tests
use the Node test runner through `tsx`.

## Commands

Run from `apps/worker` with `pnpm run <script>`, or from the root with
`pnpm --filter worker <script>`.

| Script      | What it does                                 |
| ----------- | -------------------------------------------- |
| `dev`       | `tsx watch src/index.ts`                     |
| `build`     | Compile to `dist/` (`tsc -p tsconfig.json`)  |
| `start`     | Run the build (`node dist/index.js`)         |
| `lint`      | oxlint (type-aware) over `src/`              |
| `typecheck` | `tsc --noEmit`                               |
| `test`      | `src/jobs.test.ts` and `src/runtime.test.ts` |

The worker imports the API's build output, so build the API first. From the root,
`pnpm build:worker` (Turborepo) generates the Prisma client and builds the API and the worker
in order.

## Environment

The worker reads the repository's root `.env` (`../../.env`); see `.env.example`.

| Variable                                                                      | Purpose                                                                       |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `REDIS_URL`, `DATABASE_URL`                                                   | Required in production; outside production Redis defaults to `localhost:6380` |
| `WORKER_CONCURRENCY`                                                          | Jobs processed in parallel (1 to 10, default 1)                               |
| `WORKER_HEALTH_PORT`                                                          | Port of the `/health` and `/ready` server; disabled when unset                |
| `WORKER_SHUTDOWN_TIMEOUT_MS`                                                  | How long shutdown waits for active jobs (default 30 seconds)                  |
| `TIME_ATTENDANCE_AUTOMATION_ENABLED`, `EMPLOYEE_LIFECYCLE_AUTOMATION_ENABLED` | Off by default; `true` schedules the automation jobs                          |
| `RETAINED_GRANT_RECONCILIATION_ENABLED`, `RETAINED_GRANT_RECONCILIATION_CRON` | Retained-grant reconciliation switch and pattern                              |
| `AUTH_RECORD_RETENTION_ENABLED`                                               | `true` lets the pruning job delete records                                    |
| `SMTP_*`, `DOCUMENT_*`, `GOOGLE_OAUTH_*`, `INTEGRATION_ENCRYPTION_KEY`        | Email, document storage and the Google Workspace connection used by jobs      |

Invalid switch or SMTP values stop the worker at start-up; the error names the variable, never
its value.

## Interaction with other apps

- **API:** shares the queue, database and Redis. The API enqueues account emails; everything
  else the worker runs is scheduled. Job code is the API's (`apps/api/src/*/*-jobs.ts`).
- **Web:** no direct interaction; results (notifications, prepared periods, reminders) are
  read through the API.
- **Health:** `/health` reports liveness; `/ready` checks Redis and PostgreSQL. The heartbeat
  key `hrms:worker:heartbeat` expires after three missed 15-second beats.

## Testing and build

`pnpm --filter worker test` runs without Redis or PostgreSQL (the runtime is injectable). Turbo
builds the API before the worker's tests. The job handlers themselves are tested in the API's
unit and database suites; see [docs/testing.md](../../docs/testing.md).
