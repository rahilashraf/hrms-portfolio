-- Organization isolation and kiosk credentials: historical data checks (operator query).
-- READ ONLY: counts and lists rows, changes nothing. Run it before deploying the organization
-- isolation changes to a database that holds existing data, and keep the output:
--   psql "$DATABASE_URL" -f docs/security/sql/batch-4b-organization-isolation-checks.sql
-- Each check below explains what its rows mean. Nothing here is fixed automatically.
BEGIN TRANSACTION READ ONLY;

-- 1. Timesheets holding segments of another organization than their time period's (written by
--    the pre-4B refresh, which read every organization's entries). After 4B these segments are
--    ignored everywhere; the rows themselves stay as they are.
SELECT t.id AS timesheet_id, t.status, t.version, tp."organizationId" AS period_organization,
       tp."startDate", tp."endDate", s.id AS segment_id, s."employmentAssignmentId",
       p."organizationId" AS segment_organization, s.status AS segment_status,
       s."netWorkedMinutes", s."approvedWorkedMinutes"
FROM "Timesheet" t
JOIN "TimePeriod" tp ON tp.id = t."timePeriodId"
JOIN "TimesheetSegment" s ON s."timesheetId" = t.id
JOIN "EmploymentAssignment" ea ON ea.id = s."employmentAssignmentId"
JOIN "Position" p ON p.id = ea."positionId"
WHERE p."organizationId" <> tp."organizationId"
ORDER BY tp."startDate", t.id;

-- 2. APPROVED or LOCKED timesheets whose stored totals (the approved payroll snapshot) include
--    another organization's minutes or payroll rows. Payroll was never affected (it keeps only
--    its own assignment's rows), but the stored minute totals over-count. 4B shows readers the
--    totals of the timesheet's own organization's segments; the stored JSON is left unchanged.
SELECT t.id AS timesheet_id, t.status, t.version, tp."organizationId" AS period_organization,
       count(DISTINCT s.id) AS foreign_segments,
       sum(s."approvedWorkedMinutes") AS foreign_approved_minutes,
       (SELECT count(*) FROM jsonb_array_elements(
          CASE WHEN jsonb_typeof(t.totals -> 'payrollWorkDates') = 'array'
               THEN t.totals -> 'payrollWorkDates' ELSE '[]'::jsonb END) row
        WHERE (row ->> 'employmentAssignmentId') IN (
          SELECT s2."employmentAssignmentId"::text FROM "TimesheetSegment" s2
          JOIN "EmploymentAssignment" ea2 ON ea2.id = s2."employmentAssignmentId"
          JOIN "Position" p2 ON p2.id = ea2."positionId"
          WHERE s2."timesheetId" = t.id AND p2."organizationId" <> tp."organizationId")
       ) AS foreign_payroll_rows
FROM "Timesheet" t
JOIN "TimePeriod" tp ON tp.id = t."timePeriodId"
JOIN "TimesheetSegment" s ON s."timesheetId" = t.id
JOIN "EmploymentAssignment" ea ON ea.id = s."employmentAssignmentId"
JOIN "Position" p ON p.id = ea."positionId"
WHERE t.status IN ('APPROVED', 'LOCKED')
  AND p."organizationId" <> tp."organizationId"
GROUP BY t.id, t.status, t.version, tp."organizationId"
ORDER BY t.id;

-- 3. RECORDED_AFTER_APPROVAL exceptions that cite a timesheet of another organization than the
--    entry's (finding O1), and those a reopen of another organization's timesheet resolved
--    (finding O2: resolved automatically while the entry's own organization's time may still be
--    approved). Both lists are for review; no exception is reopened automatically.
SELECT 'O1 cites another organization' AS finding, x.id AS exception_id, x.status,
       x."employeeId", x."timeEntryId", e."workDate", p."organizationId" AS entry_organization,
       tp."organizationId" AS cited_timesheet_organization, x.metadata ->> 'timesheetId' AS cited_timesheet
FROM "AttendanceException" x
JOIN "TimeEntry" e ON e.id = x."timeEntryId"
JOIN "EmploymentAssignment" ea ON ea.id = e."employmentAssignmentId"
JOIN "Position" p ON p.id = ea."positionId"
JOIN "Timesheet" t ON t.id::text = x.metadata ->> 'timesheetId'
JOIN "TimePeriod" tp ON tp.id = t."timePeriodId"
WHERE x.type = 'RECORDED_AFTER_APPROVAL' AND tp."organizationId" <> p."organizationId"
UNION ALL
SELECT 'O2 resolved by another organization''s reopen', x.id, x.status, x."employeeId",
       x."timeEntryId", e."workDate", p."organizationId", NULL, NULL
FROM "AttendanceException" x
JOIN "TimeEntry" e ON e.id = x."timeEntryId"
JOIN "EmploymentAssignment" ea ON ea.id = e."employmentAssignmentId"
JOIN "Position" p ON p.id = ea."positionId"
WHERE x.type = 'RECORDED_AFTER_APPROVAL'
  AND x.status = 'RESOLVED' AND x."resolutionMethod" = 'SYSTEM_AUTO_RESOLUTION'
  -- no reopen of the entry's own organization's timesheet covering the date at that moment
  AND NOT EXISTS (
    SELECT 1 FROM "Timesheet" t
    JOIN "TimePeriod" tp ON tp.id = t."timePeriodId"
    WHERE t."employeeId" = x."employeeId" AND tp."organizationId" = p."organizationId"
      AND e."workDate" BETWEEN tp."startDate" AND tp."endDate"
      AND t."reopenedAt" IS NOT NULL
      AND t."reopenedAt" BETWEEN x."resolvedAt" - interval '1 second' AND x."resolvedAt" + interval '1 second')
ORDER BY 1, 2;

-- 4. Retro payroll requirements naming another organization's run than their timesheet's (R4).
--    They never warn (that run's sources did not change) but are noise for payroll operators.
--    Requirements are append-only: list them for the operators; never delete them.
SELECT r.id AS requirement_id, r."payrollRunId", run."organizationId" AS run_organization,
       r."timesheetId", tp."organizationId" AS timesheet_organization, r."employmentAssignmentId",
       r."firstWorkDate", r."lastWorkDate", r."createdAt"
FROM "PayrollRetroRequirement" r
JOIN "PayrollRun" run ON run.id = r."payrollRunId"
JOIN "Timesheet" t ON t.id = r."timesheetId"
JOIN "TimePeriod" tp ON tp.id = t."timePeriodId"
WHERE run."organizationId" <> tp."organizationId"
ORDER BY r."createdAt";

-- 5. Shared PINs: employees with an ACTIVE PIN who work (ACTIVE or PLANNED assignments) in more
--    than one organization. From 4B only an administrator of every one of those organizations,
--    or System scope, can reset or revoke it. Also: the PINs last set by an administrator who
--    held time.credential.manage in only some of those organizations is not knowable from the
--    data; the issuing user is listed for review.
SELECT c."employeeId", e."employeeNumber", c.id AS credential_id, c."issuedAt",
       c."issuedByUserId", array_agg(DISTINCT p."organizationId") AS organizations
FROM "AttendanceCredential" c
JOIN "Employee" e ON e.id = c."employeeId"
JOIN "EmploymentAssignment" ea ON ea."employeeId" = c."employeeId"
  AND ea.status IN ('ACTIVE', 'PLANNED')
JOIN "Position" p ON p.id = ea."positionId"
WHERE c.type = 'PIN' AND c.status = 'ACTIVE'
GROUP BY c."employeeId", e."employeeNumber", c.id, c."issuedAt", c."issuedByUserId"
HAVING count(DISTINCT p."organizationId") > 1
ORDER BY c."issuedAt";

-- 6. PINs an employee set through self-service right after an administrator revoked their
--    previous one (the bypass 4B closes). For review: the administrator may want to revoke again.
SELECT c."employeeId", c.id AS credential_id, c."issuedAt", prev.id AS revoked_credential,
       prev."revokedAt", prev."revokedByUserId"
FROM "AttendanceCredential" c
JOIN "Employee" e ON e.id = c."employeeId"
JOIN "User" u ON u."personId" = e."personId"
JOIN LATERAL (
  SELECT p.* FROM "AttendanceCredential" p
  WHERE p."employeeId" = c."employeeId" AND p.type = 'PIN' AND p."issuedAt" < c."issuedAt"
  ORDER BY p."issuedAt" DESC LIMIT 1
) prev ON TRUE
WHERE c.type = 'PIN' AND c.status = 'ACTIVE'
  AND c."issuedByUserId" = u.id
  AND prev.status = 'REVOKED' AND prev."revokedByUserId" IS DISTINCT FROM u.id
ORDER BY c."issuedAt";

ROLLBACK;
