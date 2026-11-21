-- Attendance lifecycle and exception management: read-only preflight (operator query).
-- READ ONLY: counts and lists rows, changes nothing. Run it before deploying the attendance
-- lifecycle changes to a database that holds existing time data, and keep the output:
--   psql "$DATABASE_URL" -f docs/security/sql/batch-4c-attendance-lifecycle-preflight.sql
-- Each check below explains what its rows mean.
BEGIN TRANSACTION READ ONLY;

-- 1. Time periods of one organization that overlap (share a date) with different bounds,
--    classified by ownership (a period is payroll-owned when a PayrollPeriod uses it):
--      PAYROLL_PAYROLL_OTHER_GROUPS  — allowed: pay groups with different calendars (unchanged).
--      PAYROLL_PAYROLL_SAME_GROUP    — should not exist (the payroll calendar refuses it): review.
--      ATTENDANCE_CONFLICT           — involves an attendance-owned period: 4C now refuses new
--                                      ones (409 TIME_PERIOD_OVERLAP); existing pairs are left
--                                      as they are and need an operator's review (an employee
--                                      may hold two timesheets for the same days).
--    Nothing is changed automatically.
WITH owners AS (
  SELECT tp.id, tp."organizationId", tp."startDate", tp."endDate",
         array_remove(array_agg(DISTINCT pp."payGroupId"), NULL) AS pay_groups
  FROM "TimePeriod" tp
  LEFT JOIN "PayrollPeriod" pp ON pp."timePeriodId" = tp.id
  GROUP BY tp.id
)
SELECT CASE
         WHEN cardinality(a.pay_groups) = 0 OR cardinality(b.pay_groups) = 0 THEN 'ATTENDANCE_CONFLICT'
         WHEN a.pay_groups && b.pay_groups THEN 'PAYROLL_PAYROLL_SAME_GROUP'
         ELSE 'PAYROLL_PAYROLL_OTHER_GROUPS'
       END AS classification,
       a."organizationId", a.id AS period_a, a."startDate" AS a_start, a."endDate" AS a_end,
       a.pay_groups AS a_pay_groups, b.id AS period_b, b."startDate" AS b_start,
       b."endDate" AS b_end, b.pay_groups AS b_pay_groups
FROM owners a
JOIN owners b
  ON b."organizationId" = a."organizationId" AND b.id > a.id
 AND b."startDate" <= a."endDate" AND b."endDate" >= a."startDate"
ORDER BY classification, a."organizationId", a."startDate";

-- 2. Organizations that use Time & attendance without payroll (no pay group with a payroll
--    calendar): the ones the attendance-only routes are for. Informational, with their latest
--    period. Nothing is generated for them until a manager does it or the organization opts in.
SELECT o.id AS organization_id, o.name, o.timezone,
       (SELECT max(tp."endDate") FROM "TimePeriod" tp WHERE tp."organizationId" = o.id) AS latest_period_end,
       (SELECT count(*) FROM "Timesheet" t JOIN "TimePeriod" tp ON tp.id = t."timePeriodId"
         WHERE tp."organizationId" = o.id) AS timesheets
FROM "Organization" o
WHERE o."archivedAt" IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM "OrganizationModuleSetting" m
    WHERE m."organizationId" = o.id AND m.module = 'ATTENDANCE' AND m.enabled = false)
  AND NOT EXISTS (
    SELECT 1 FROM "PayrollCalendar" c JOIN "PayGroup" g ON g.id = c."payGroupId"
    WHERE g."organizationId" = o.id)
ORDER BY o.name;

-- 3. Open attendance exceptions by organization and type: the review backlog managers can now
--    resolve or dismiss. A MISSING_CLOCK_OUT on a still-open entry can't be reviewed (the entry
--    is corrected instead); the last column counts those.
SELECT p."organizationId", x.type, count(*) AS open_exceptions,
       count(*) FILTER (WHERE x."workflowImpact" = 'SUBMISSION_BLOCKING' AND e.status = 'OPEN')
         AS blocking_with_open_entry
FROM "AttendanceException" x
JOIN "EmploymentAssignment" ea ON ea.id = x."employmentAssignmentId"
JOIN "Position" p ON p.id = ea."positionId"
LEFT JOIN "TimeEntry" e ON e.id = x."timeEntryId"
WHERE x.status = 'OPEN'
GROUP BY p."organizationId", x.type
ORDER BY p."organizationId", x.type;

-- 4. The new constraints can't fail on existing data: every row below must be absent (0 rows).
--    (An exception with an assignment but no subject, or a reviewer without a note.)
SELECT x.id, x.type, x.status
FROM "AttendanceException" x
WHERE (x."timeEntryId" IS NOT NULL AND x."attendanceSignInId" IS NOT NULL)
   OR ((x."timeEntryId" IS NOT NULL OR x."attendanceSignInId" IS NOT NULL)
       <> (x."employmentAssignmentId" IS NOT NULL));

-- 5. Monthly periods starting after day 28 (month arithmetic skips into the next month). New
--    monthly periods must start on day 1–28; existing ones are informational.
SELECT tp.id, tp."organizationId", tp."startDate", tp."endDate"
FROM "TimePeriod" tp
WHERE tp.cadence = 'MONTHLY' AND extract(day FROM tp."startDate") > 28;

ROLLBACK;
