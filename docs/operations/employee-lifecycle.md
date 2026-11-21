# Employee lifecycle operations

How terminations, assignment ends, rehires and inactive status work, who may do what, and how to
run the optional automation.

## 1. Rules in one page

- **Dates are calendar dates** (`YYYY-MM-DD`, nothing else is accepted). The **termination date
  is the last day of employment**, inclusive. Each assignment is judged in its own business time
  zone: its position's work location, else its organization (UTC only for legacy positions with
  neither).
- **A termination is scheduled until its date has passed.** Recording it sets every open
  assignment's end date to the termination date (an earlier end stays) and the employee's
  termination date; nothing else changes yet. The employee keeps working, signing in and
  recording time until the last day.
- **It takes effect per assignment.** Once the last day has passed in an assignment's time zone,
  that assignment becomes ENDED (or CANCELLED if it would only have started later). When every
  affected assignment has, the termination is APPLIED and the employee TERMINATED: their sign-in
  sessions and pending account links are revoked, and the shared login is **disabled only if no
  role grant remains**. A date already past everywhere applies in the same request.
- **Grants are revoked when the termination applies.** At that moment
  (never when it is recorded, scheduled, previewed, rescheduled or cancelled), every live grant
  of the person's login in the organizations the termination ends — and every SYSTEM grant — is
  revoked (`revocationReason = employment_terminated`, one `ROLE_ASSIGNMENT_REVOKED` audit each,
  no termination reason in it). Grants in other organizations, and the login if they authorize
  anything, are kept. See section 13.
- **System-level grants:** only a System administrator may terminate their holder, and
  each SYSTEM grant needs an explicit REVOKE or KEEP decision. `acknowledgeSystemGrants` is
  still accepted and stored but keeps nothing.
- **Cancel or reschedule** is possible while nothing has taken effect yet; it restores each
  assignment's original end date exactly (refused if an assignment was changed in the meantime).
  Rescheduling keeps the old record as SUPERSEDED. History is append-only.
- **Rehire** needs a TERMINATED employee and creates the new assignment (position, employment
  type, start date after the last day). The original hire date and history are kept; sign-in
  access and roles are not restored.
- **Inactive** (leave of absence, reason required): no new assignments and no time capture; leave,
  payroll, schedules, history, the login and grants are unchanged. Reactivation reverses it.
- **Assignment ends.** Ending with a future date keeps the assignment ACTIVE until that day has
  passed; a past date ends it now. Assignment status always follows the dates: a status
  that contradicts them is refused (`ASSIGNMENT_STATUS_DERIVED`).
- **Finalized records are protected.** No termination, end, correction or cancellation may leave
  approved or locked timesheets, finalized payroll runs, recorded time or sign-ins outside the
  employment dates (`409 LIFECYCLE_FINALIZED_RECORDS`, with the blocking records). Correct those
  first. Historical corrections of ENDED assignments are allowed for dates they covered.
- **While a termination is scheduled**, new assignments for the employee are refused and open
  assignments cannot end after the termination date (`TERMINATION_SCHEDULED`).

## 2. Who may act

| Action                                                                   | Required                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Terminate, cancel, reschedule, apply; inactive/reactivate; profile edits | `employee.manage` over **every** affected assignment's position (ACTIVE, PLANNED, and ENDED ones still running on the date), or SYSTEM                                                                                                        |
| Add an assignment, rehire                                                | `employee.manage` on the position, plus: the employee is already visible to you, **or** organization-wide `employee.manage` and the employee number confirmed through the attach lookup, **or** SYSTEM                                        |
| End, correct, cancel, activate an assignment; apply a due end            | `employee.manage` on that assignment's position                                                                                                                                                                                               |
| Recruitment conversion into an existing employee                         | Recruitment hire rights and `employee.manage` on the offered position, plus: the employee is already visible to you, or SYSTEM (internal candidates convert into their own record); the employee must be ACTIVE with no scheduled termination |
| Anything on your own employment                                          | Refused (`LIFECYCLE_SELF_TARGET`) unless SYSTEM; the SYSTEM override is audited                                                                                                                                                               |
| See termination reasons                                                  | Whoever may manage the employee employee-wide; never in directories, reports or audit metadata                                                                                                                                                |
| See / revoke grants in the access review                                 | `role.read` / `role.assign` over the grant's scope; System Owner grants are never revocable here                                                                                                                                              |

An employee you cannot see at all answers **404**; visible but not fully covered answers **403**.

## 3. API

| Method and path                                                | Purpose                                                                                                                                  |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /employees/:id/terminate`                                | `{ terminationDate, reason?, acknowledgeSystemGrants?, grantDecisions? }`; a repeated identical request replays (see section 13)         |
| `GET /employees/:id/termination-preview?terminationDate=`      | Effects per assignment, blockers, follow-ups, access                                                                                     |
| `GET /employees/:id/terminations`                              | History (reasons only for managers)                                                                                                      |
| `POST /employees/:id/terminations/:tid/cancel`                 | `{ reason? }`                                                                                                                            |
| `POST /employees/:id/terminations/:tid/reschedule`             | `{ terminationDate, reason?, acknowledgeSystemGrants?, grantDecisions? }`; decisions carry over, keeps need approval again               |
| `POST /employees/:id/terminations/:tid/apply`                  | Manual apply of what is due (`409 TERMINATION_NOT_DUE` otherwise)                                                                        |
| `POST /employees/:id/rehire`                                   | `{ assignment: { positionId, employmentType, startDate, endDate?, isPrimary?, managerAssignmentId? }, confirmEmployeeNumber?, reason? }` |
| `POST /employees/:id/inactivate` / `reactivate`                | `{ reason }` / `{ reason? }`                                                                                                             |
| `GET /employees/:id/access-review`                             | Login status, sessions, grants with relation, `revocable` and `inactiveReason`                                                           |
| `POST /employees/:id/access-review/revoke-grants`              | `{ roleAssignmentIds, reason? }` → `{ revoked, alreadyRevoked, loginDisabled }`; one transaction                                         |
| `POST /employees/:id/assignments/:aid/apply-end`               | Manual end of an assignment past its end date                                                                                            |
| `GET /employees/lifecycle/due?organizationId=`                 | Due terminations and assignment ends you manage (500, `truncated`)                                                                       |
| `GET /employees/attach-lookup?organizationId=&employeeNumber=` | Exact-number lookup for organization-wide attach (audited)                                                                               |

## 4. Automation (default off)

`EMPLOYEE_LIFECYCLE_AUTOMATION_ENABLED=true` on the **worker** schedules two hourly jobs:
`employee.apply-due-terminations` (minute 10) and `employee.end-due-assignments` (minute 15).
Off (the default), neither is scheduled and each run does nothing; use the due list and the
manual apply actions instead (same rules, locks and audit). Both jobs are idempotent, recover
missed runs, commit per employee or assignment and report failures as failed jobs (retried).
Assignments that belong to a scheduled termination end only through it. The existing hourly
activation job (`employee.activate-due-assignments`) is unchanged and skips inactive employees.

**Before switching it on:** run the preflight (section 6); its first finding is what the first
end-due-assignments run will end.

**Always on, whatever this switch says:** `employee.reconcile-retained-grants` (every 15
minutes). It only disables the login of a terminated employee whose last retained grant has
ended, when nothing else authorizes it (section 13). It never applies terminations or ends
assignments.

## 5. Troubleshooting

| Code                                            | Meaning / what to do                                                                                                                                                              |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LIFECYCLE_SCOPE_INCOMPLETE` (403)              | Another organization's administrator, or a System administrator, must act                                                                                                         |
| `LIFECYCLE_SELF_TARGET` (403)                   | Ask another administrator                                                                                                                                                         |
| `LIFECYCLE_FINALIZED_RECORDS` (409)             | `blockers` lists the timesheets, payroll runs, time or sign-ins; correct them or pick other dates                                                                                 |
| `TERMINATION_ALREADY_SCHEDULED` (409)           | Reschedule or cancel the existing one                                                                                                                                             |
| `TERMINATION_ALREADY_EFFECTIVE` (409)           | Some assignment has passed the date; rehire instead                                                                                                                               |
| `TERMINATION_ASSIGNMENT_CHANGED` (409)          | An affected assignment changed after scheduling; review it first                                                                                                                  |
| `TERMINATION_SCHEDULED` (409)                   | Change the termination first                                                                                                                                                      |
| `TERMINATION_SYSTEM_ACTOR_REQUIRED` (403)       | System-level grants: a System administrator must act                                                                                                                              |
| `TERMINATION_GRANT_DECISION_REQUIRED` (400/409) | a SYSTEM grant has no decision; `roleAssignmentIds` names them. Record REVOKE or KEEP                                                                                             |
| `TERMINATION_KEEP_APPROVAL_REQUIRED` (409)      | a SYSTEM keep awaits approval by another System administrator; approve, reject or withdraw                                                                                        |
| `TERMINATION_KEEP_APPROVAL_INVALID` (409)       | an approved SYSTEM keep no longer passes the approval rules (approver lost authority, role changed or archived); get a fresh approval or revoke                                   |
| `TERMINATION_KEEP_INVALID` (400/409)            | reason 10–500 characters, keep end after the last day and ≤ 30 days after it; grant still live                                                                                    |
| `TERMINATION_KEEP_EXPIRED` (409)                | the keep's end date has passed; record a new decision                                                                                                                             |
| `TERMINATION_KEEP_OUTSIDE_SCOPE` (400)          | the grant is not in an organization this termination ends; it is not affected                                                                                                     |
| `TERMINATION_KEEP_NOT_AUTHORIZED` (403)         | requesting needs `role.assign` over the grant's scope; approving needs the role-delegation authority (`role.assign` plus each of the role's permissions, over a containing scope) |
| `TERMINATION_KEEP_SELF_APPROVAL` (403)          | the requester cannot approve or reject their own exception                                                                                                                        |
| `TERMINATION_KEEP_NOT_PENDING` (409)            | already approved, rejected, withdrawn or applied; refresh                                                                                                                         |
| `EMPLOYEE_NOT_ACTIVE` (409)                     | Reactivate (inactive) or rehire (terminated)                                                                                                                                      |
| `ASSIGNMENT_STATUS_DERIVED` (400)               | Omit `status`; the dates decide it                                                                                                                                                |
| `ASSIGNMENT_STATUS_CONFLICT` (409)              | The correction would reopen an ended assignment or move an active one into the future                                                                                             |

## 6. Deployment

1. Back up. On a database that already holds employees, run
   `docs/security/sql/batch-5a-lifecycle-preflight.sql` (read-only) and keep the output; review
   findings 1–4 with HR (nothing is migrated or rewritten).
2. Apply the migrations (`prisma migrate deploy`; the lifecycle tables come from the additive
   migration `20270501090000_batch5a_employee_termination`), then deploy API and worker together,
   then web.
3. Leave `EMPLOYEE_LIFECYCLE_AUTOMATION_ENABLED` unset until the due list has been reviewed.
4. Rollback: redeploy the previous images. The new tables stay (unused by the old code); do not
   drop them, they hold termination history.

## 7. Transfers

`POST /employees/:id/assignments/:aid/transfer` with `{ positionId, effectiveDate, employmentType?,
endDate?, isPrimary?, managerAssignmentId?, reason? }`. `effectiveDate` (T) is the first day in the
new position; the current assignment ends on T−1, in the same transaction. Needs `employee.manage`
on **both** positions (cross-organization transfers too); 404 for a position or assignment you
cannot see, 403 when visible but not manageable. Primary carries unless overridden; the manager
carries only if still valid and in the new position's organization (otherwise
`manager.droppedReason`). Compensation is never copied: the response says `compensationRequired`.
Refusals: `TRANSFER_DATE_OUTSIDE_ASSIGNMENT`, `TRANSFER_SAME_POSITION`, `TRANSFER_SOURCE_NOT_ACTIVE`,
`EMPLOYEE_NOT_ACTIVE`, `TERMINATION_SCHEDULED`, `LIFECYCLE_FINALIZED_RECORDS`, and the usual
position overlap and primary checks. Repeating the same request replays it.

## 8. Before ending or transferring: the impact preview

`GET /employees/:id/assignments/:aid/impact?endDate=` lists what the end leaves behind (open time,
future shifts, leave, compensation and open payroll runs, benefits, direct reports, other current
assignments, grants in the organization) and returns the `offboarding` prefill for
`POST /onboarding/workflows/offboarding` (`employmentAssignmentId`, `plannedEndDate`, default
template). Nothing is changed or cancelled. Each section needs its module's read permission
(`time.view`, `schedule.read`, `leave.read`, `compensation.read`, `payroll.read`, `benefit.read`,
`role.read`, `onboarding.read`) and is `null` otherwise; lists are bounded (`total`, `items`,
`truncated`, `limit`). When `endsLastCurrentEmployment` is true, use the
termination workflow instead of an assignment end.

## 9. Manager links, archived organizations, positions

- Manager links must stay inside one organization (`MANAGER_ORGANIZATION_MISMATCH`). Older
  cross-organization links stay and show a warning; a manager whose assignment ended stays linked
  and shows `MANAGER_ASSIGNMENT_ENDED`.
- Grants scoped to an archived organization (or through a role of one) stop authorizing anything,
  including its own administrators'; only a SYSTEM administrator can reactivate it, which restores
  them. SYSTEM grants are unaffected (business rules for archived organizations still apply).
- An explicitly chosen manager must be readable by you (`employee.read` on its position).
- A position with active or planned assignments cannot be archived (`POSITION_HAS_LIVE_ASSIGNMENTS`);
  a planned assignment in an archived position cannot be activated (`POSITION_ARCHIVED`).

## 10. Physical sites

`/organizations/:orgId/physical-sites` (list, get, create, update, archive, reactivate). Changing
sites needs `organization.manage` in the organization; listing also works with `organization.read`
or `time.device.manage`. A site used by an unarchived work location or an active kiosk device
cannot be archived (`PHYSICAL_SITE_IN_USE`), and a kiosk device is never registered on, moved to or
re-enabled at an archived site (`KIOSK_LOCATION_UNUSABLE`). A work location needs a site: choose one, or ask for a
matching one with `createPhysicalSite: true` (audited); `physicalSiteId: null` never creates one.

## 11. In the web app

- **Employee profile → header**: Terminate employee, Mark inactive / Reactivate, Rehire employee
  (TERMINATED), Start offboarding — shown when the API's capabilities allow them
  (`actions.manageLifecycle`, `startOffboarding`); the API still decides every request.
- **Terminate**: choose the last day (inclusive). The preview says _Scheduled_ (the employee keeps
  working through that day) or _Immediate_ (already past everywhere; confirm it), lists each
  assignment's effect and time zone, blockers and follow-ups. The reason is restricted.
- **Scheduled termination banner**: Reschedule, Cancel termination and — after the last day has
  passed — Apply termination. Automatic application stays off unless enabled (section 4).
- **Employment tab**: per current assignment, _Transfer_ and _Preview impact_; _End assignment_
  shows the impact for the chosen date; the termination history is listed below.
- **Overview → Access review**: login vs employment, grants by relation; revoke only selected
  grants after confirming. It also shows the grants a termination revoked, kept grants with their end
  date and approval, and why the login is active or disabled.
- **Organization → Physical Sites**: add, rename, archive (refused while a work location or an
  active kiosk uses the site), reactivate. The work-location form picks one of these sites or
  creates a matching one.
- **Offboarding links** open Onboarding → Start with the employee, assignment, default template and
  planned last day preselected; review and start it yourself.

## 12. Access safeguards

- **Revoking grants is one transaction.** Under the employee's lifecycle lock: the self-target
  rule, the grants locked in id order, every authorization check, each revocation and its audit
  entry, and the login disable either all commit or all roll back. A refusal or any failure
  leaves every grant and the login as they were; retrying is safe.
- **Your own employment:** revoking grants on it answers `403 LIFECYCLE_SELF_TARGET` (as every
  other lifecycle action), unless you hold System `employee.manage`; that override is audited
  (`LIFECYCLE_SELF_TARGET_OVERRIDE`). The general Roles API is unchanged.
- **Already revoked:** a grant someone else revoked first is left as it is (its revoker and its
  single audit entry stay) and is returned in `alreadyRevoked`; `revoked` lists only what this
  request revoked. Every path that revokes grants (this one, the Roles API, archiving a role,
  cancelling an invitation) locks them in id order and revokes with a conditional update, so concurrent requests revoke a
  grant once and count it in exactly one audit entry.
- **Withdrawn invitations keep no roles:** cancelling an invitation, a failed first invitation
  email (the invitation is undone) and reissuing an archived invitation all revoke the login's
  live grants in one transaction with the account change, audited
  (`revokedRoleAssignmentCount`). Roles assigned to an invited login therefore never come back
  through a reissued invitation.
- **Inactive grants:** the access review marks grants that authorize nothing because their
  organization or role is archived (`inactiveReason: ORGANIZATION_ARCHIVED | ROLE_ARCHIVED`).
- **Recruitment duplicates:** converting a hire checks the candidate's email only against
  employees of the hiring organization and employees the recruiter can see. Another
  organization's employees never cause `RECRUITMENT_POSSIBLE_EXISTING_EMPLOYEE`.
- **Diagnostic (read-only):** `docs/security/sql/batch-5e-security-diagnostic.sql` — inert grants,
  archived roles holding grants, historical cross-organization grants (expected empty), shared
  logins across archived organizations, grants with duplicate revocation entries, and open time
  of terminated employees or on ended assignments.

### Someone is still clocked in when their termination takes effect

The termination applies as usual. The open entry is left
exactly as it was: no clock-out is invented and no hours are awarded.

1. **Find it:** the termination preview and the impact preview list open time beforehand;
   afterwards, the diagnostic's check 6 or the time management views.
2. **Payroll is protected meanwhile:** the timesheet cannot be submitted
   (`409 TIMESHEET_OPEN_ENTRY`) and an hourly assignment's payroll run reports
   `TIMESHEET_NOT_FINAL` and cannot be approved.
3. **Close it:** a manager with `time.correct` over the assignment records the real clock-out
   with a direct correction (`ADD_MISSING_CLOCK_OUT`, reason required, audited
   `TIME_DIRECT_CORRECTION_APPLIED`). The clock-out may be on the next local day; the entry keeps
   its work date (the last day). Time starting after the last day is still refused (400).
4. **Submit and approve:** `time.timesheet.manage` submits on the employee's behalf (reason
   required), then the segments are approved and payroll is recalculated.
5. **After payroll is finalized** nothing changes in the finalized run: a further correction
   needs an audited reopen (reason required), which records a retroactive requirement against
   the run.

**The employee closing it themselves (by design).** While the terminated employee's login
stays active (grants in another organization, or an approved keep, remain), they may close their own already-open entry where the
organization's capture policy permits it, at the moment they do it. They can never start a new
session (clocking in is refused), and KIOSK_ONLY is never bypassed (the web is refused). Once
their access is revoked (revoking their last grant disables the login), only an authorized
manager can close the entry, through the audited correction in step 3. Corrections are judged
in the time zone the entry is stored with — the one it was recorded in, unless the correction
moves it to another assignment — so a later time-zone change of the work location does not move
its work date.

## 13. Role grants at termination

**When.** Only when a termination applies (the last assignment ends: immediately, through
_Apply termination_, or by the due job). Recording, scheduling, previewing, rescheduling and
cancelling revoke nothing. Ending or transferring a single assignment is not a termination and
revokes nothing (use the access review).

**What.** The live grants of the person's login (not revoked, not expired) that are SYSTEM-scoped
or belong to an organization of the termination's assignments — including grants added after it
was scheduled. Each is revoked with a conditional update (one already revoked by someone else is
left as it is and reported as `ALREADY_REVOKED`), audited once; the worker's revocations have no
actor (`source: AUTOMATIC`, `scheduledByUserId` in metadata). Then all sessions end, and the login
is disabled if nothing authorizes it any more.

**Exceptions (KEEP).** Per grant, by `roleAssignmentId`: a reason (10–500 characters) and
`keepUntil` (ISO instant with offset, after the last day and at most 30 days after it — the end
of the 30th day in the earliest affected time zone). A KEEP is a _request_:

| Status      | Meaning                                                                                          |
| ----------- | ------------------------------------------------------------------------------------------------ |
| `REQUESTED` | Waiting for review; at application an ordinary grant is revoked, a SYSTEM grant blocks it        |
| `APPROVED`  | Reviewed by someone other than the requester (DB check); applied as below                        |
| `REJECTED`  | The grant is revoked at application                                                              |
| `CANCELLED` | Withdrawn, or the termination was cancelled/rescheduled (keeps are carried over as new requests) |
| `DECIDED`   | A REVOKE decision                                                                                |

An approved, unexpired keep is applied by revoking the original grant and creating a
replacement that expires at `min(original expiry, keepUntil)` (`ROLE_ASSIGNMENT_RETAINED`, naming
requester and approver). It never extends an earlier expiry; a late approval after application
is refused (`409 TERMINATION_NOT_SCHEDULED`; the decision itself is closed). When the last
retained grant ends, the **retained-grant reconciliation job** disables the login if nothing else
authorizes it (below).

**Approvals are checked again at application.** An approved keep is honoured only if it would
still be approved now, under the locks of the application:

- the approver is still active and still has the role-delegation authority for that role at that
  scope, measured against the role's **current** permissions (a role that gained a permission the
  approver cannot grant is no longer covered; one that lost permissions is checked as it is now);
- the role is not archived; the keep is unexpired and within the 30-day maximum;
- the approver is neither the requester nor the departing employee;
- for a SYSTEM grant, the approver is still a System administrator at SYSTEM scope.

If the check fails:

- **Ordinary grant:** the keep is ignored, the grant is revoked (decision outcome `REVOKED`, no
  replacement), and `EMPLOYEE_TERMINATION_GRANT_KEEP_REVALIDATION_FAILED` is audited with a
  category (`APPROVER_NOT_AUTHORIZED`, `ROLE_INELIGIBLE`, `KEEP_LIMIT_EXCEEDED` or
  `SELF_APPROVAL`). The rest of the termination applies normally. The screen shows _Approval no
  longer valid: not kept_ before application, and the reason afterwards.
- **SYSTEM grant:** the application is refused and nothing changes
  (`409 TERMINATION_KEEP_APPROVAL_INVALID`). Have an eligible System administrator approve a new
  keep request (_Change decision_), or record a REVOKE. The due job reports it as blocked.

**Routes.**

| Route                                                         | Notes                                                                  |
| ------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `GET /employees/:id/terminations/:tid/grants`                 | Grants, decisions, outcome, `blocking`, `loginWillBeDisabled`          |
| `POST /employees/:id/terminations/:tid/grant-decisions`       | `{ decisions: [{ roleAssignmentId, decision, reason?, keepUntil? }] }` |
| `POST …/grant-decisions/:did/approve` · `/reject` · `/cancel` | `{ note? }`; approve/reject never by the requester                     |

**Who may decide.**

- **Requesting a keep, or any SYSTEM decision:** `role.assign` over the grant's scope; SYSTEM
  grants need a System administrator.
- **Approving a keep:** the authority to grant that role at that scope through ordinary role
  assignment (`role.assign` plus every active permission of the role, each over a scope
  containing the grant's).
  - SYSTEM keeps also need a System administrator delegating at SYSTEM scope: another System
    Owner.
  - Archived roles cannot be kept.
  - The requester never approves.
  - It is checked when the approval runs. A refused approve or reject is audited
    (`EMPLOYEE_TERMINATION_GRANT_KEEP_REVIEW_REFUSED`) and changes nothing.
- **Everything else:** the same employee-wide authority as the termination itself.

**Retained-grant reconciliation (`employee.reconcile-retained-grants`).**

- **Schedule:** worker, every 15 minutes (`7,22,37,52 * * * *` UTC). It runs **whether or not**
  `EMPLOYEE_LIFECYCLE_AUTOMATION_ENABLED` is set.
- **What it does:** for each terminated employee whose retained grants have all ended (or been
  revoked), it disables the login if nothing else authorizes it, using the normal effective-grant
  rules. It then ends sessions and account links and audits
  `EMPLOYEE_TERMINATION_RETENTION_EXPIRED` (and `EMPLOYEE_ACCOUNT_DISABLED`, reason
  `retention_expired`).
  - Grants in another organization keep the login. A rehired employee is left alone.
  - At most 200 decisions per run.
- **Failures:** a failure for one employee is reported and fails the run, which is retried; the
  others commit. Repeated or concurrent runs are no-ops.
- **Maximum delay:** about 15 minutes after a keep ends.
- **Verify:** look for completed `employee.reconcile-retained-grants` jobs and the audit entries
  above. This query should return nothing older than about 30 minutes: decisions with
  `outcome = 'RETAINED'` and `expiryHandledAt IS NULL` whose replacement grant has expired.
- **Disable or roll back:** `RETAINED_GRANT_RECONCILIATION_ENABLED=false`, then restart the worker
  (the schedule is removed; data is untouched).
- **Change the interval:** `RETAINED_GRANT_RECONCILIATION_CRON` (five-field cron, UTC).

**Worker.** A due termination blocked on SYSTEM decisions (pending, missing or no longer valid
approvals) changes nothing and is logged (ids and codes); the run succeeds. Enable lifecycle automation only after the report below has been
reviewed (the reconciliation job above does not depend on it).

**Existing data (no retroactive change).** The migration `20271101090000_m3_termination_grant_decisions`
only adds a table. Already terminated employees keep their grants until an administrator revokes
them in the access review. Run `docs/security/sql/m3-termination-grants-report.sql` (read-only)
on a staging copy first: it lists terminated employees with live grants, enabled logins without
employment, SYSTEM grants, scheduled terminations of SYSTEM holders (they will not apply until a
decision is recorded) and cross-organization people.

**Former employees and pay statements.** Pay history is kept. A former employee whose login is
disabled can no longer open _My pay_ (`/payroll/me/pay` is self-service and needs an active
login); no grant is kept for that, and the disabled login's sessions no longer authenticate.

- **Delivery today:** an authorized payroll administrator (`payroll.read` for the organization)
  opens the finalized payroll run and the employee's statement, prints or saves it as PDF from
  the browser, and sends it through the organization's secure channel. Do not re-enable the login
  or grant a role for this.
- **Not built:** restricted self-service access for former employees.
