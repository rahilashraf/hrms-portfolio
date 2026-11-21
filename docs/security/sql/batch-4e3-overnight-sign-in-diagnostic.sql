-- Overnight sign-in diagnostic (operator query): sign-ins whose stored work date differs from
-- the work date of the published occurrence they are linked to (typically an overnight shift
-- signed in for after midnight, recorded by an earlier version under the local calendar date of
-- the sign-in).
-- READ ONLY: lists and counts rows, changes nothing. The application never rewrites these rows;
-- new sign-ins linked to a published shift take the shift revision's work date.
-- When: optional, at any time (informational; no action is required).
--   psql "$DATABASE_URL" -f docs/security/sql/batch-4e3-overnight-sign-in-diagnostic.sql
BEGIN TRANSACTION READ ONLY;

-- 1. Count by organization and status. Informational: these rows appear under the sign-in's own
--    date in sign-in lists, and under the shift's date in expected attendance.
SELECT p."organizationId" AS organization_id,
       s.status,
       count(*) AS sign_ins
FROM "AttendanceSignIn" s
JOIN "ScheduledShiftRevision" r ON r.id = s."scheduledShiftRevisionId"
JOIN "EmploymentAssignment" a ON a.id = s."employmentAssignmentId"
JOIN "Position" p ON p.id = a."positionId"
WHERE s."workDate" <> r."workDate"
GROUP BY p."organizationId", s.status
ORDER BY p."organizationId", s.status;

-- 2. The rows themselves (the latest 500): the stored date, the occurrence's date and times.
SELECT s.id AS sign_in_id,
       p."organizationId" AS organization_id,
       s."employmentAssignmentId" AS employment_assignment_id,
       s.status,
       s."workDate" AS stored_work_date,
       r."workDate" AS occurrence_work_date,
       s."signedInAt" AS signed_in_at,
       r."startsAt" AS occurrence_starts_at,
       r."endsAt" AS occurrence_ends_at,
       s.timezone
FROM "AttendanceSignIn" s
JOIN "ScheduledShiftRevision" r ON r.id = s."scheduledShiftRevisionId"
JOIN "EmploymentAssignment" a ON a.id = s."employmentAssignmentId"
JOIN "Position" p ON p.id = a."positionId"
WHERE s."workDate" <> r."workDate"
ORDER BY s."signedInAt" DESC
LIMIT 500;

ROLLBACK;
