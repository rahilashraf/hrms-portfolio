-- Time zones, daylight saving, overnight shifts, automatic break deduction and optional
-- sign-out: read-only preflight (operator query).
-- READ ONLY: counts and lists rows, changes nothing. Run it before deploying the time-zone and
-- overnight policy changes to a database that holds existing time data, and keep the output:
--   psql "$DATABASE_URL" -f docs/security/sql/batch-4d-dst-overnight-policy-preflight.sql
-- Each check below explains what its rows mean.
BEGIN TRANSACTION READ ONLY;

-- 1. Time zones in use. 4D accepts every IANA identifier the runtime resolves, including
--    aliases (Asia/Calcutta, Europe/Kiev, US/Eastern …); stored values are never rewritten.
--    `known_to_postgres = false` is unexpected (the API validated these): review those rows.
WITH zones AS (
  SELECT 'Organization' AS source, timezone FROM "Organization" WHERE timezone IS NOT NULL
  UNION ALL SELECT 'WorkLocation', timezone FROM "WorkLocation" WHERE timezone IS NOT NULL
  UNION ALL SELECT 'TimeEntry', timezone FROM "TimeEntry"
  UNION ALL SELECT 'ScheduledShift', timezone FROM "ScheduledShift"
  UNION ALL SELECT 'AttendanceSignIn', timezone FROM "AttendanceSignIn"
)
SELECT source, timezone, count(*) AS rows,
       EXISTS (SELECT 1 FROM pg_timezone_names n WHERE n.name = zones.timezone) AS known_to_postgres
FROM zones
GROUP BY source, timezone
ORDER BY source, timezone;

-- 2. Active policy layers whose expected local times fall between 00:00 and 03:59, where daylight
--    saving transitions happen. 4D resolves a skipped time forward by the gap and a repeated time
--    to its first occurrence; nothing is refused. Informational: lateness and auto-close on
--    transition days may differ by the gap from before (which used the clock-in's offset).
SELECT p.id, p."scopeType", p."organizationId", p."employmentAssignmentId",
       p."effectiveFrom", p."effectiveTo",
       p.config -> 'attendanceInterpretation' ->> 'expectedStartLocalTime' AS expected_start,
       p.config -> 'missedPunch' ->> 'expectedEndLocalTime' AS expected_end
FROM "TimeAttendancePolicy" p
WHERE p."archivedAt" IS NULL
  AND (   (p.config -> 'attendanceInterpretation' ->> 'expectedStartLocalTime') < '04:00'
       OR (p.config -> 'missedPunch' ->> 'expectedEndLocalTime') < '04:00')
ORDER BY p."organizationId", p."effectiveFrom";

-- 3. Open entries that started on an earlier local day than today in their own time zone
--    (overnight work in progress, or forgotten clock-outs). 4D keeps each on its stored work date;
--    the scan auto-closes only at a linked shift's end, or at the policy's expected end when the
--    configured window itself crosses midnight. Informational.
SELECT e.id, e."employeeId", e."employmentAssignmentId", e.timezone, e."workDate",
       e."clockInAt", e."scheduledShiftId",
       round(extract(epoch FROM (now() - e."clockInAt")) / 3600.0, 1) AS open_hours
FROM "TimeEntry" e
WHERE e.status = 'OPEN'
  AND (e."clockInAt" AT TIME ZONE e.timezone)::date < (now() AT TIME ZONE e.timezone)::date
ORDER BY e."clockInAt";

-- 4. Active AUTO_DEDUCT layers. Existing layers keep their meaning: no
--    `autoDeductAfterMinutes` means 0 (deduct on any worked day), now once per employee,
--    organization and work date instead of once per entry, and reduced by recorded unpaid
--    breaks. Layers created after 4D without a threshold are saved with 360.
SELECT p.id, p."scopeType", p."organizationId", p."organizationalUnitId", p."departmentId",
       p."teamId", p."employmentAssignmentId", p."effectiveFrom", p."effectiveTo",
       p.config -> 'breaks' ->> 'autoDeductMinutes' AS auto_deduct_minutes,
       coalesce(p.config -> 'breaks' ->> 'autoDeductAfterMinutes', '(unset: 0)') AS after_minutes
FROM "TimeAttendancePolicy" p
WHERE p."archivedAt" IS NULL AND p.config -> 'breaks' ->> 'mode' = 'AUTO_DEDUCT'
ORDER BY p."organizationId", p."effectiveFrom";

-- 5. Unapproved timesheets (OPEN, SUBMITTED, CHANGES_REQUESTED) whose deduction may change on the
--    next refresh: the employee has several closed entries on one work date in the period's
--    organization, or a closed entry with an unpaid break, and a segment currently carries a
--    policy deduction. Approved and locked timesheets are never recalculated. An upper bound:
--    whether each assignment actually resolves to AUTO_DEDUCT depends on policy inheritance.
WITH day_entries AS (
  SELECT ts.id AS timesheet_id, ts.status, ts."employeeId", e."workDate",
         count(DISTINCT e.id) AS entries,
         count(DISTINCT e."employmentAssignmentId") AS assignments,
         count(b.id) FILTER (WHERE b."payType" = 'UNPAID') AS unpaid_breaks
  FROM "Timesheet" ts
  JOIN "TimePeriod" tp ON tp.id = ts."timePeriodId"
  JOIN "TimeEntry" e
    ON e."employeeId" = ts."employeeId" AND e.status = 'CLOSED'
   AND e."workDate" BETWEEN tp."startDate" AND tp."endDate"
  JOIN "EmploymentAssignment" a ON a.id = e."employmentAssignmentId"
  JOIN "Position" pos ON pos.id = a."positionId" AND pos."organizationId" = tp."organizationId"
  LEFT JOIN "BreakEntry" b ON b."timeEntryId" = e.id
  WHERE ts.status IN ('OPEN', 'SUBMITTED', 'CHANGES_REQUESTED')
  GROUP BY ts.id, ts.status, ts."employeeId", e."workDate"
)
SELECT d.timesheet_id, d.status, d."employeeId",
       count(*) FILTER (WHERE d.entries > 1) AS days_with_several_entries,
       count(*) FILTER (WHERE d.assignments > 1) AS days_split_across_assignments,
       count(*) FILTER (WHERE d.unpaid_breaks > 0) AS days_with_unpaid_breaks,
       (SELECT sum(s."policyDeductionMinutes") FROM "TimesheetSegment" s
         WHERE s."timesheetId" = d.timesheet_id) AS current_deduction_minutes
FROM day_entries d
GROUP BY d.timesheet_id, d.status, d."employeeId"
HAVING (count(*) FILTER (WHERE d.entries > 1 OR d.unpaid_breaks > 0)) > 0
   AND (SELECT sum(s."policyDeductionMinutes") FROM "TimesheetSegment" s
         WHERE s."timesheetId" = d.timesheet_id) > 0
ORDER BY d.status, d.timesheet_id;

-- 6. Sign-in-only layers. Sign-out is a new, optional record (`attendance.signOutEnabled`,
--    default off): nothing changes for these until an administrator enables it. Informational.
SELECT p.id, p."scopeType", p."organizationId", p."employmentAssignmentId",
       p.config -> 'attendance' ->> 'captureMode' AS capture_mode,
       coalesce(p.config -> 'attendance' ->> 'signOutEnabled', 'false') AS sign_out_enabled
FROM "TimeAttendancePolicy" p
WHERE p."archivedAt" IS NULL AND p.config -> 'attendance' ->> 'trackingMode' = 'SIGN_IN_ONLY'
ORDER BY p."organizationId";

-- 7. The new table must not exist before the migration and must be empty right after it.
SELECT to_regclass('"AttendanceSignOut"') IS NOT NULL AS sign_out_table_exists;

ROLLBACK;
