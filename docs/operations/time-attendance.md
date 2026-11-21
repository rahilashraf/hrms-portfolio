# Time & attendance operations

Operator and administrator guide to the Time & attendance, scheduling-attendance, kiosk and
timesheet features. It describes what the product does today and how to run it safely. Every
organization configures its own policies; nothing here is specific to one organization.

Deployment and environment variables: [`docs/deployment.md`](../deployment.md).

## 1. Concepts

| Concept                 | What it is                                                                                                                                                 |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Employment assignment   | The work context (one position in one organization). Time, attendance, schedules and timesheets all belong to an assignment; an employee may hold several. |
| Time entry              | Timed work (TIME_CLOCK tracking): clock-in/out punches are immutable; corrections add adjustments and never rewrite punches.                               |
| Sign-in                 | Presence (SIGN_IN_ONLY tracking): a fact that the employee attended an occurrence. It carries **no minutes** and is never payable time. Optional sign-out. |
| Published shift         | Expected work from Scheduling, with immutable revisions. Attendance links to the revision it was interpreted against.                                      |
| Time period / timesheet | A period of the organization; a timesheet per employee with one segment per assignment. Approval stores the payroll snapshot; locking finalizes it.        |
| Attendance exception    | A review flag (late, missing clock-out, no-show, recorded after approval…). Exceptions never change recorded time by themselves.                           |

## 2. Organization setup

1. **Turn the modules on** (the organization's feature settings): `ATTENDANCE` for Time & attendance,
   `SCHEDULING` for schedules (needed for expected attendance, scheduled-vs-actual and no-shows).
2. **Time zones.** Every organization (or the assignment's work location) needs an IANA time
   zone; work dates, DST and overnight shifts are computed in it.
3. **Policies** (Time administration → Policies). Policy layers inherit
   system → organization → unit → department → team → assignment, and are effective-dated: a
   change is a new layer (supersede), never an edit of the past. The _Effective policy_ view
   shows what applies to one assignment on a date, with the layer each setting comes from.
4. **Permissions** (roles, at organization, unit, department or team scope):

| Permission               | Allows                                                                                         |
| ------------------------ | ---------------------------------------------------------------------------------------------- |
| `time.clock`             | Self-service clock-in/out, breaks, sign-in/out, own corrections and timesheet submission       |
| `time.view`              | Reading attendance of the positions in scope (records, sign-ins, expected attendance, reports) |
| `time.correct`           | Direct corrections, manual sign-ins/outs, schedule links (never on one's own time)             |
| `time.approve`           | Deciding correction requests and exceptions (never one's own)                                  |
| `time.timesheet.approve` | Approving segments, requesting changes                                                         |
| `time.timesheet.manage`  | Periods, timesheet creation, lock and reopen                                                   |
| `time.manage_policy`     | Policy layers                                                                                  |
| `time.device.manage`     | Kiosk devices (organization scope)                                                             |
| `time.credential.manage` | Employees' kiosk PINs                                                                          |

### Key policy settings

| Setting                                                                            | Default      | Meaning                                                                                                                |
| ---------------------------------------------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `attendance.trackingMode`                                                          | `TIME_CLOCK` | `TIME_CLOCK` (timed work) or `SIGN_IN_ONLY` (presence, no minutes)                                                     |
| `attendance.captureMode`                                                           | self-service | Where attendance may be captured: self-service, kiosk, or both (`KIOSK_ONLY` refuses remote capture and auto-approval) |
| `attendance.signInDuplicateWindowMinutes`                                          | 10           | A repeated sign-in inside this window is the same arrival                                                              |
| `attendance.signOutEnabled`                                                        | off          | Optional presence sign-out                                                                                             |
| `clock.mode`                                                                       | —            | `LIVE_CLOCK` for live punches                                                                                          |
| `breaks.*`, `breaks.autoDeductAfterMinutes`                                        | —            | Break capture and the day's automatic deduction (applied by timesheets and payroll)                                    |
| `correction.employeeRequestsEnabled`                                               | off          | Employees may request corrections; `correction.approvalMode` decides review                                            |
| `periods.autoGenerate`, `cadence`, `anchorDate`, `leadDays` (7), `autoMaterialize` | off          | Automatic attendance periods (needs the worker switch, section 7)                                                      |
| `noShow.enabled`, `noShow.graceMinutes` (30)                                       | off          | No-show review flags (needs the worker switch)                                                                         |
| `timesheet.autoLockOnApproval`                                                     | off          | Lock a timesheet as soon as it is fully approved                                                                       |

## 3. Kiosks

**Enrollment** (Time administration → Kiosks, `time.device.manage` at organization scope):

1. Register the device with its physical site. The response shows a one-time **enrollment code**
   (about 49 bits, valid 15 minutes, single use, stored only as a hash).
2. On the kiosk browser, open `/kiosk` on the HRMS web domain and enter the code. The browser
   receives the device credential as an HTTP-only cookie; the code cannot be used again.
3. Issue PINs (employee profile → Attendance PIN, `time.credential.manage`), or employees set
   their own PIN in My Time. A PIN is shown once; it locks for 15 minutes after 5 failures.

**Lifecycle:** _Rotate_ clears the credential and issues a new code (re-enroll the browser);
_Disable_ refuses the device immediately and keeps its credential (_Enable_ restores it);
_Revoke_ is permanent and clears every secret. A device's site can change only within its own
organization. Device administrators see the last address and browser the device used.

**Using a kiosk:** the employee taps start, enters their employee number and PIN (on-screen keypad
or a physical keyboard/keypad), and chooses an action. When several shifts are open at once, each
occurrence is its own labelled button; a second tap never silently confirms another occurrence.
Waiting screens warn "Still there?" 10 seconds before the 30-second idle reset; result
screens clear after 5 seconds. Interaction tokens are single use and bound to the device.

**Shared PINs across organizations:** one PIN works in every organization of the employee, so
issuing or revoking it needs `time.credential.manage` in every such organization (or System
scope, audited) — otherwise `403 ATTENDANCE_PIN_SHARED_SCOPE`.

## 4. Authorization rules (what callers see)

- A record of an organization in which the caller holds **none** of the relevant permissions is
  answered **404**, exactly like a missing record — its existence is never revealed across
  organizations. This covers time records, kiosk devices, PINs, entry corrections, schedule
  links, direct entries, sign-in corrections and policy layers.
- Inside an organization the caller can see, a missing permission or a narrower scope is
  **403**. Reading counts as seeing: a manager with `time.view` who opens a correction, schedule
  link, sign-in correction or policy change gets 403, not 404. The caller's own records are always visible to them: acting on one's own time is
  **403** (`TIME_SELF_TARGET_FORBIDDEN`, `ATTENDANCE_SELF_CORRECTION`, own correction request…).
- Correction requests: nobody learns anything about a request (details or status, including
  approved, rejected and cancelled ones) before being authorized to decide it.
- Lists apply the caller's scope **in the query** before any row limit; a list reports
  `truncated: true` (with its `limit`) when the range holds more rows. Outsiders get a permission
  refusal, not the organization's feature state.

## 5. When Time & attendance is turned off (history)

Turning `ATTENDANCE` off for an organization stops every action there (403 `FEATURE_DISABLED`),
but keeps existing history readable:

- **Employees** keep reading their own My Time history (entries, requests, exceptions, timesheets,
  sign-ins, expected attendance). Records of the disabled organization are marked read-only.
- **Managers** read history only by asking for it: the review screens' _Include organizations
  with attendance turned off_ option (API: `includeDisabledOrganizations=true`). Their current
  grants still apply; a revoked role or ended scope reads nothing. Operational views (current
  clock-ins, expected sign-ins) stay off.
- Nothing becomes readable that the caller's current permissions do not cover, and a disabled
  account cannot sign in at all.

## 6. Multi-organization employees

- An employee may work in several organizations; each assignment follows its own organization's
  policies, time zone, features and permissions.
- A timesheet belongs to one organization's period and shows only that organization's segments;
  managers never see another organization's segment minutes (only a count of segments outside
  their scope).
- Kiosks identify employees only for assignments in the kiosk's organization.
- One physical clock-in can cover several assignments in the same organization: on My Time the
  employee picks the assignment to clock in on and, under _Also covering (optional)_, any other
  eligible assignments of that organization (API: `additionalEmploymentAssignmentIds` on the
  clock-in request; the server re-checks each one). The chosen assignment is the payroll owner;
  the covered ones add no time, so the hours are counted once. One time entry never spans
  organizations. Kiosks and managers' audited coverage corrections can record coverage too.

## 7. Automation (worker)

Off by default, in two steps:

1. Deployment switch: `TIME_ATTENDANCE_AUTOMATION_ENABLED=true` on the **worker** service.
2. Organization opt-in through policy: `periods.autoGenerate` (with `cadence` and `anchorDate`)
   and/or `noShow.enabled`.

| Job                               | Schedule (UTC)     | Notes                                                                                                                   |
| --------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `time.scan-open-entries`          | every 15 minutes   | Always on; flags/escalates long-open entries per policy; skips disabled organizations                                   |
| `time.prepare-attendance-periods` | 02:40 daily        | Needs the switch; generates periods/timesheets; skips organizations with a payroll calendar; per-organization lock      |
| `time.detect-no-shows`            | :07, :22, :37, :52 | Needs the switch; LIVE_CLOCK and SIGN_IN_ONLY shifts; 48 h lookback; one flag per shift revision; supersedes stale ones |

Presence no-shows are judged per session: a session counts as attended when a sign-in is linked
to it, or when an unlinked sign-in of the assignment falls between the schedule policy's early
sign-in bound before its start and its end. A sign-in linked to another session never counts.

A failed organization fails the job run (kept 30 days in the queue, logged with ids only). There
is no alerting: check failed jobs after enabling automation.

## 8. Notifications

Time & attendance notifications use their own `TIME` category. The employee is notified when a
correction request they made is approved or declined, and when their timesheet is approved or
changes are requested (once per event; never notes or hours). Decisions also show in My Time.

## 9. Exports

Reports (Reports → Time & attendance; `report.read` + `time.view`, and `report.export` to export):
clocked hours, attendance exceptions (every type, including no-shows and time recorded after
approval), corrections, **timesheet detail** (approved snapshot minutes separate from the live
calculation) and **attendance sign-ins** (presence; no minutes). Rows are limited to the caller's
scope. Results are capped at 5,000 rows; a capped result says so, a capped CSV ends with a
`TRUNCATED:` line and the download carries `X-Report-Truncated: true`, and a capped Google Sheets
export ends with a `TRUNCATED:` row and is reported as capped. Exports are audited and
contain no contact details, PINs or credentials.

## 10. Deployment, preflights and rollback

**Read-only operator queries** (run with a read-only role where possible, keep the output, never
on a writable session you do not need). They check existing data before the corresponding
schema and rule changes reach a database that already holds time data; a new database needs
none of them.

| Script (`docs/security/sql/`)                 | Checks                                                                                      |
| --------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `batch-4a-time-integrity-preflight.sql`       | Duplicate clock-outs, timesheets without a snapshot, self-corrections                       |
| `batch-4b-organization-isolation-checks.sql`  | Rows that cross organizations (timesheets, exceptions, retro payroll) and shared kiosk PINs |
| `batch-4c-attendance-lifecycle-preflight.sql` | Overlapping time periods, classified by payroll ownership                                   |
| `batch-4d-dst-overnight-policy-preflight.sql` | Time zones, daylight-saving and overnight policy settings                                   |
| `batch-4e3-overnight-sign-in-diagnostic.sql`  | Overnight sign-ins stored under another date (informational)                                |
| `batch-4f-presence-no-show-preflight.sql`     | Policies that would start presence no-show flags (informational)                            |

**Order:** back up the database → run the queries above where they apply → `prisma migrate deploy`
→ deploy **API and worker together**, then **web** → health checks → smoke test. Leave
`TIME_ATTENDANCE_AUTOMATION_ENABLED` unchanged unless enabling it is a separate, approved step.

**Rollback:** redeploy the previous API, worker and web builds. Migrations are additive, so a
code rollback is possible only to a version whose schema expectations the migrated database
still meets; check the migrations between the two versions first. Never restore a backup just to
undo a code change. See [`docs/deployment.md`](../deployment.md).

## 11. Health checks and smoke test

- API: `GET /health` (liveness), `GET /ready` (PostgreSQL and Redis). Worker: `GET /health`,
  `GET /ready` on `WORKER_HEALTH_PORT`, heartbeat key `hrms:worker:heartbeat`.
- Smoke test after a deployment (a test organization and accounts, never real employees' data):
  1. An employee opens My Time: Today, History, Timesheets load.
  2. A manager opens Time administration: the organization list, records and exceptions load.
  3. A kiosk loads `/kiosk` and shows _Tap to start_ (enrolled test device).
  4. Reports → Time & attendance → _Attendance sign-ins_ runs and exports a CSV.
  5. If automation is on: the worker shows the `time.*` repeatable jobs and no failed runs.

## 12. Diagnostics

Read-only queries for common questions are in `docs/security/sql/`. Useful starting points: open
exceptions by type (`AttendanceException` grouped by `type`, `status`), timesheets awaiting
approval (`Timesheet.status = 'SUBMITTED'`), and the preflights above. Never update attendance
rows by hand: punches, sign-ins and approved snapshots are append-only by design, and
corrections go through the product so they are audited.
