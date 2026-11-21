-- Time integrity and payroll snapshots: read-only preflight (operator query).
-- READ ONLY: counts and lists rows, changes nothing. Run it before deploying the time-integrity
-- migrations to a database that holds existing time data, and keep the output:
--   psql "$DATABASE_URL" -f docs/security/sql/batch-4a-time-integrity-preflight.sql
-- Each check below explains what its rows mean and what, if anything, to do about them.
BEGIN TRANSACTION READ ONLY;

-- 1. Time entries with more than one CLOCK_OUT punch (left by the clock-out race fixed here).
--    The new trigger only refuses NEW duplicates; existing rows are immutable evidence and are
--    kept. Any rows here: review them (which clock-out the entry kept is in "TimeEntry"); do not
--    delete punches.
SELECT p."timeEntryId", count(*) AS clock_out_punches,
       min(p."occurredAt") AS first_clock_out, max(p."occurredAt") AS last_clock_out,
       e."clockOutAt" AS entry_clock_out
FROM "TimePunch" p
JOIN "TimeEntry" e ON e.id = p."timeEntryId"
WHERE p.type = 'CLOCK_OUT'
GROUP BY p."timeEntryId", e."clockOutAt"
HAVING count(*) > 1
ORDER BY first_clock_out;

-- 2. APPROVED timesheets without a payroll snapshot (totals.payrollWorkDates). Locking them now
--    answers 409 TIMESHEET_SNAPSHOT_MISSING (it used to recompute from live entries); they need
--    a reopen and a new approval. Expected: 0.
SELECT t.id, t."employeeId", t."timePeriodId", t."approvedAt"
FROM "Timesheet" t
WHERE t.status = 'APPROVED'
  AND (t.totals IS NULL OR jsonb_typeof(t.totals -> 'payrollWorkDates') IS DISTINCT FROM 'array');

-- 3. Time closed after its timesheet was approved, in approved or locked periods. Before 4A, a
--    later lock folded such time into the payroll snapshot unreviewed; from now on a lock keeps
--    the approved snapshot exactly, so this time reaches payroll only after a reopen and a new
--    approval. Each row is an entry to review (it is NOT flagged retroactively).
SELECT t.id AS timesheet_id, t.status, t."approvedAt", e.id AS time_entry_id,
       e."employmentAssignmentId", e."workDate", e."clockInAt", e."clockOutAt", e."updatedAt"
FROM "Timesheet" t
JOIN "TimePeriod" tp ON tp.id = t."timePeriodId"
JOIN "TimeEntry" e
  ON e."employeeId" = t."employeeId"
 AND e."workDate" BETWEEN tp."startDate" AND tp."endDate"
 AND e."archivedAt" IS NULL
WHERE t.status IN ('APPROVED', 'LOCKED')
  AND t."approvedAt" IS NOT NULL
  AND (e."createdAt" > t."approvedAt" OR e."updatedAt" > t."approvedAt")
ORDER BY t."approvedAt", e."clockInAt";

-- 4. SUBMITTED timesheets whose period has not ended yet (by date, in UTC; borderline rows on
--    the end date depend on the organization's timezone). They can no longer be approved until
--    the period ends, unless the policy enables timesheet.allowEarlySubmission.
SELECT t.id, t."employeeId", tp."organizationId", tp."startDate", tp."endDate", t."submittedAt"
FROM "Timesheet" t
JOIN "TimePeriod" tp ON tp.id = t."timePeriodId"
WHERE t.status = 'SUBMITTED' AND tp."endDate" >= current_date;

-- 5. Timesheets with an approved segment while the timesheet itself was never submitted (the
--    approval path fixed here). Informational: their approvals stand.
SELECT t.id, t.status, t."employeeId", t."timePeriodId"
FROM "Timesheet" t
WHERE t."submittedAt" IS NULL
  AND EXISTS (
    SELECT 1 FROM "TimesheetSegment" s WHERE s."timesheetId" = t.id AND s.status = 'APPROVED'
  );

-- 6. Time in the future, and open entries overlapping other entries (now refused for new
--    corrections; existing rows are left as they are). Informational.
SELECT 'future' AS kind, e.id, e."employeeId", e."clockInAt", e."clockOutAt"
FROM "TimeEntry" e
WHERE e."archivedAt" IS NULL AND (e."clockInAt" > now() OR e."clockOutAt" > now())
UNION ALL
SELECT 'overlaps open entry', c.id, c."employeeId", c."clockInAt", c."clockOutAt"
FROM "TimeEntry" o
JOIN "TimeEntry" c
  ON c."employeeId" = o."employeeId" AND c.id <> o.id AND c."archivedAt" IS NULL
 AND c."clockOutAt" > o."clockInAt"
WHERE o.status = 'OPEN' AND o."archivedAt" IS NULL;

-- 7. Direct corrections and manual entries a user applied to their own time (now refused
--    unless a System-scope override, which is audited). Informational, for review.
SELECT a.id, a.type, a.source, a."appliedAt", a."employeeId", a."actorUserId"
FROM "TimeAdjustment" a
JOIN "Employee" e ON e.id = a."employeeId"
JOIN "User" u ON u."personId" = e."personId"
WHERE a."actorUserId" = u.id AND a.source = 'MANAGER_DIRECT'
ORDER BY a."appliedAt";

ROLLBACK;
