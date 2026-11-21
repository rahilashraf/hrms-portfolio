# Local demo: setup, accounts and data

A fresh clone becomes a running, seeded demonstration of Portfolio HRMS with one
command. Everything in the demo is **synthetic**: a fictional group of companies, invented
people, `.test` email addresses that can never receive mail, and a generated sample PDF. No real
staff, payroll, financial or personal information is used anywhere.

## Prerequisites

- Node.js 24.10 or newer, and pnpm. Run `corepack enable` once, and the version pinned in
  `package.json` is used.
- Docker, for PostgreSQL 17 and Redis 7 through the repository's `docker-compose.yml`.
  Alternatively, run your own local PostgreSQL and Redis and pass `--no-docker`.

## One command

```bash
git clone <repository-url> portfolio-hrms
cd portfolio-hrms
pnpm install
pnpm demo
```

`pnpm demo` runs `scripts/demo.mjs`, which:

1. **Checks the prerequisites.** It creates `.env` from `.env.example` if `.env` doesn't exist
   (local values only), because Docker Compose reads it.
2. **Starts PostgreSQL and Redis** with `docker compose up -d --wait`.
3. **Builds the API and the worker.** It runs the same steps as `pnpm build:worker` (Prisma
   client generation, the NestJS build and the worker build) directly, one after another.
4. **Prepares the demo database.** It creates `hrms_demo` next to your development database
   `hrms`, applies the migrations, and marks it as a demonstration database.
5. **Seeds the demonstration data through the API.** It starts the built API on a temporary port
   and runs `apps/api/demo/demo-cli.ts seed` against it.
6. **Starts the applications:**
   - the API on `:3001`;
   - the BullMQ worker;
   - the web app on `:3000`, under `next dev`, because a production web build requires an
     HTTPS API origin.

   It then prints the demo accounts. Ctrl+C stops all three (see [Removing the demo](#removing-the-demo)
   to clean up completely).

Open <http://localhost:3000> and sign in with one of the printed accounts.

| Option                                | Effect                                                                                                                    |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `pnpm demo --setup-only`              | Everything except starting the applications                                                                               |
| `pnpm demo --no-docker`               | Use PostgreSQL and Redis already running at the `.env` addresses                                                          |
| `pnpm demo --reset-passwords`         | Give every demo account a new password                                                                                    |
| `pnpm demo:reset`                     | Drop and recreate the local demo database (asks you to type its name); starts Docker Compose unless you add `--no-docker` |
| `DEMO_PASSWORD=<12+ chars>`           | Use one shared password for all demo accounts (local convenience)                                                         |
| `DEMO_WEB_PORT`, `DEMO_API_PORT`      | Other ports (default 3000 and 3001)                                                                                       |
| `DEMO_DATABASE_URL`, `DEMO_REDIS_URL` | Other demo database or Redis (default: `hrms_demo`, Redis database 1)                                                     |

### What stays separate from development

The demo has its own resources:

- the database `hrms_demo` (your development database `hrms` and its `admin@local.test` seed are
  untouched);
- Redis database 1;
- a git-ignored `.demo/` folder holding:
  - `credentials.json`: the demo passwords, mode 0600;
  - `secrets.json`: a generated JWT secret and document-link signing key, mode 0600;
  - `documents/`: the synthetic uploaded file.

Nothing in `.demo/` is ever committed.

### Removing the demo

To remove the demo completely:

1. Stop it (Ctrl+C).
2. Drop the `hrms_demo` database (or the one `DEMO_DATABASE_URL` names).
3. Flush the Redis database the demo uses: database 1 of the Redis in `.env` (or the one
   `DEMO_REDIS_URL` names), for example `redis-cli -p 6380 -n 1 FLUSHDB`.
4. Delete the `.demo/` folder.

`pnpm demo:reset` only drops and recreates the demo database. It keeps `.demo/` (credentials,
secrets and the sample file) and Redis database 1; the next `pnpm demo` seeds the recreated
accounts with new passwords and overwrites `.demo/credentials.json`.

## Demo accounts

All accounts use the reserved domain `@demo.harbourline.test`. Passwords are **generated
randomly for each clone** when the accounts are first created. They are printed at the end of
`pnpm demo` and kept in `.demo/credentials.json`. No password is written in the repository. A
rerun keeps the existing passwords; `--reset-passwords` replaces them. These accounts and
passwords exist only in your local demo database and are never suitable for a deployed
environment.

| Account         | Person          | What it shows                                                                                          |
| --------------- | --------------- | ------------------------------------------------------------------------------------------------------ |
| `owner@…`       | Avery Lindqvist | System Owner: both organizations, roles, settings, audit                                               |
| `hr.admin@…`    | Morgan Achebe   | HR administrator of the Outdoor Centre: employees, leave, onboarding, documents, benefits, performance |
| `payroll@…`     | Priya Raman     | Payroll administrator: pay groups, calendars, runs, the payroll register                               |
| `manager@…`     | Daniel Okafor   | Programs manager: schedules, timesheet approval, leave approval, team reviews                          |
| `employee@…`    | Sofia Martins   | Camp counsellor: My time, My schedule, leave request, pay statements, documents, self-review           |
| `recruiter@…`   | Jordan Kim      | Recruiter: the summer counsellor opening, candidates, interviews, offers                               |
| `studio.lead@…` | Arjun Mehta     | Lead of Harbourline Studio (Asia/Kolkata); cannot see the Outdoor Centre                               |
| `facilities@…`  | Hana Suzuki     | Facilities coordinator who manages the Operations department's structure only                          |

Each account holds roles with only the permissions its job needs, mostly scoped to its
organization. The facilities account shows a grant **below the organization**: it may manage
(`organization.manage`) only the Operations department and what is under it, and it may read
(`organization.read`) the rest of the centre's structure. The owner holds the reserved System
Owner role, granted through the same idempotent path as `authz:bootstrap-owner`.

## The demonstration dataset

Harbourline Group is fictional and has two organizations.

**Harbourline Outdoor Centre** (code `HL-OUT`, America/Toronto, CAD) has four departments
(Programs, Operations, People & Culture, Finance), ten employees with a reporting hierarchy, and
one position per person, plus open counsellor seats. The recruitment flow hires one more
counsellor into an open seat (a planned assignment), and a seasonal facilities assistant is hired
on the reference date (see Employee lifecycle below), so the centre's directory lists 12 people.
Operations has two teams, "Grounds & Trails" and "Boats & Equipment", created by the facilities
account.

| Module                   | What the seed creates                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Compensation and payroll | Two bi-weekly pay groups: "Salaried staff", and "Program staff (hourly)" for the counsellors. Both completed hourly periods are **finalized**: the hours were entered by the manager, submitted on the counsellors' behalf and approved. With payroll dual control (on by default) the payroll administrator prepares and calculates the runs and the System Owner approves and finalizes the hourly ones. The salaried run is **calculated** and waiting for an independent approver: it pays both of them.                                         |
| Attendance               | 60 attendance records (three counsellors, 20 working days). Approved timesheets for the two completed periods.                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Scheduling               | This week's counsellor schedule is **published** (staggered shifts 08:00–18:00). Next week's is a **draft**.                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Leave                    | Vacation and an unpaid personal-day type. Ten-day opening balances. A **pending** request (Sofia), an **approved** request (Elena) and a centre closure day.                                                                                                                                                                                                                                                                                                                                                                                         |
| Recruitment → onboarding | The "Camp Counsellor (summer season)" opening has three candidates: one newly applied, one with an interview booked with the hiring manager, and one offered, approved by HR, sent, accepted and **hired** into an open seat with compensation. Onboarding starts from that hire. A second counsellor's onboarding is part-way through.                                                                                                                                                                                                              |
| Performance              | A five-point scale, a "Seasonal review" template and an open review cycle for the counsellors. One **submitted self-review**, one **submitted manager review** and a personal goal.                                                                                                                                                                                                                                                                                                                                                                  |
| Benefits                 | An extended-health plan with single and family coverage and rates. A family enrollment with two dependents, a single enrollment and a waiver.                                                                                                                                                                                                                                                                                                                                                                                                        |
| Documents                | A synthetic first-aid certificate PDF, generated in code and labelled as demonstration data, with an expiry date. A paper-file reference.                                                                                                                                                                                                                                                                                                                                                                                                            |
| Employee lifecycle       | The "Ending assignments" page has one of each case, and nothing is applied (lifecycle automation stays off): Grace Mwangi's secondary "Year-end Audit Liaison" assignment ended three days before the reference date and is still active (**overdue**); Marcus Bell's secondary "Winter Gear Inventory Assistant" assignment ends 12 days after it (**upcoming**); Leo Brandt, a seasonal hire with no pay, account or payroll history, has a termination **scheduled** 25 days after it. As real time passes, upcoming items become overdue or due. |
| Multiple assignments     | Sofia Martins also works part-time as a "Waterfront Lifeguard" (a second, non-primary assignment from the reference date). A live-clock attendance policy on the Programs department makes both her assignments eligible, so My Time asks which assignment a clock-in is for and offers "Also covering". Her counsellor assignment stays primary; the time is counted once, under the chosen assignment. The seed records no clock-ins. The API refuses policies that start in the past, so this policy starts on the day of the first seed.         |
| Notifications            | The events above publish in-app notifications: leave submitted, schedule published, timesheet approved, payslip available and benefit election changed.                                                                                                                                                                                                                                                                                                                                                                                              |

**Harbourline Studio** (code `HL-STU`, Asia/Kolkata, INR) has three employees paid monthly: the studio lead and two designers.
Last month's run is **calculated** and waiting for an independent approver: the System Owner set
the studio's compensation and calculated the run, so dual control does not let them approve it.
The studio lead's role covers only the studio, which shows organization isolation.

All dates are relative to the **reference week**: the Monday of the week the database was first
seeded, recorded in the database's demo marker. Reruns on later days therefore place every
record on the same days. There are three exceptions, each because the API refuses a date that
is already past. The performance review window runs from one week before to four weeks after
the reference Monday, so a first seed long after that date reports the review submissions as
skipped. The Programs attendance policy starts on the day of the first seed. The seasonal hire's
termination is scheduled only while its date is still in the future; otherwise it is reported as
skipped (it is never applied).

## How the seed respects the system's rules

- **Everything except the sign-in accounts goes through the HTTP API,** as a demo user who is
  allowed to do it. Validation, business rules, authorization, separation of duties, audit
  logging and notification producers all apply as for a person.
- **Separation of duties holds:**
  - nobody approves their own leave, timesheet or payroll, or manages their own pay or benefits;
  - the owner sets the payroll administrator's pay;
  - HR approves the recruiter's offer.
- **Accounts:** the API creates users only through emailed invitations, and a local demo has no
  mailbox. So `apps/api/demo/accounts.ts` creates the demo users directly. It uses the same
  shape as `authz:create-initial-user`: an active, verified user with an Argon2id hash from the
  API's own hasher.
- **Idempotence:**
  - Each step looks up what exists (read-only queries by natural key: organization code,
    employee number, codes, idempotency keys) and only creates or advances what is missing.
  - A rerun creates no records. The only rows a rerun adds are the seed's own sign-in sessions
    and their audit entries.
  - Reruns were verified by counting every table before and after a second seed, and the demo
    smoke workflow checks that a second `pnpm demo --setup-only` reports nothing created.

## Safety: the demo can never touch real data

`apps/api/demo/demo-database.ts` has unit tests in `demo-database.spec.ts`. Every command
refuses unless all of the following hold:

1. `NODE_ENV` isn't `production`.
2. `DATABASE_URL` is PostgreSQL, the database name ends in `_demo`, and the host is this machine.
   A demo database on another host also needs `HRMS_DEMO_ALLOW_REMOTE=1`. The URL may not carry query
   parameters that change where or as whom the driver connects (`host`, `hostaddr`, `port`,
   `dbname`, `database`, `user`, `password`, `service`, `options`): the PostgreSQL driver applies
   them over the URL, so they could point a URL that looks local at another server.
3. The database carries the **demo marker**, a database comment. Marking is allowed only on a new
   database whose **application tables are all empty**; only Prisma's `_prisma_migrations`
   history may hold rows. Empty account and organization tables alone are not enough, because
   people, employees or payroll can exist without them. Marking also requires the database to be
   migrated exactly to this repository's migrations: Prisma's history must record every directory
   under `prisma/migrations` as applied, with no failed attempt and no migration the repository
   doesn't have. (An unmigrated database has no tables at all, so the emptiness check alone would
   accept it.) `pnpm demo` migrates the database before marking it.
4. Every account in it is `@demo.harbourline.test`, and every organization code starts with `HL-`.
   Every person is a demo account or an employee of a demo organization, and every employee has an
   assignment in a demo organization.

A production database fails every one of these: it isn't named `*_demo`, it has no marker, and it
has real accounts.

**Reset** (`pnpm demo:reset`) additionally requires:

- a database on this machine (there is no code path that resets a remote database);
- the explicit confirmation `--confirm <database-name>`;
- the marker and demo-only data, checked before anything is dropped.

## Commands (from `apps/api`)

```bash
pnpm demo create                       # create the *_demo database if it doesn't exist
pnpm demo mark                         # mark the new, empty database (migrate it first)
pnpm demo check                        # exit non-zero unless it is a demo database
pnpm demo seed --api-url <api origin>  # accounts, then everything else through that API
pnpm demo reset --confirm <db-name>    # drop and recreate (local demo database only)
```

Each needs `DATABASE_URL` set to the demo database (`pnpm demo` at the root sets it).
