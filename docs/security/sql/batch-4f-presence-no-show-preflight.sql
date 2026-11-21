-- Presence-only no-show detection: read-only preflight (operator query).
-- READ ONLY: lists rows, changes nothing. Run it before enabling presence no-show detection on a
-- database that holds existing policies, and keep the output:
--   psql "$DATABASE_URL" -f docs/security/sql/batch-4f-presence-no-show-preflight.sql
-- The no-show job (only when the worker has TIME_ATTENDANCE_AUTOMATION_ENABLED=true) also flags
-- published shifts of SIGN_IN_ONLY assignments whose effective policy has noShow.enabled = true.
-- Policies inherit (system → organization → unit → department → team → assignment), so these
-- lists are indicative: an organization appearing in both lists may start receiving presence
-- no-show review flags. Flags are review items only: nothing is recorded, deducted or paid.
BEGIN TRANSACTION READ ONLY;

-- 1. Active, current policy layers that enable no-show detection.
SELECT "organizationId" AS organization_id, "scopeType" AS scope_type, "id" AS policy_id,
       "effectiveFrom" AS effective_from, "effectiveTo" AS effective_to,
       "config" -> 'noShow' AS no_show
FROM "TimeAttendancePolicy"
WHERE "archivedAt" IS NULL
  AND ("effectiveTo" IS NULL OR "effectiveTo" >= CURRENT_DATE)
  AND ("config" -> 'noShow' ->> 'enabled') = 'true'
ORDER BY 1 NULLS FIRST, 2, 4;

-- 2. Active, current policy layers that record presence by sign-in (SIGN_IN_ONLY).
SELECT "organizationId" AS organization_id, "scopeType" AS scope_type, "id" AS policy_id,
       "effectiveFrom" AS effective_from, "effectiveTo" AS effective_to
FROM "TimeAttendancePolicy"
WHERE "archivedAt" IS NULL
  AND ("effectiveTo" IS NULL OR "effectiveTo" >= CURRENT_DATE)
  AND ("config" -> 'attendance' ->> 'trackingMode') = 'SIGN_IN_ONLY'
ORDER BY 1 NULLS FIRST, 2, 4;

-- 3. Published, active shifts of the last 48 hours on assignments that currently have presence
--    sign-ins (the lookback the job uses), by organization: the order of magnitude of what the
--    first run after enabling could examine.
SELECT p."organizationId" AS organization_id, count(*) AS recent_shifts
FROM "ScheduledShift" s
JOIN "Schedule" sc ON sc."id" = s."scheduleId" AND sc."status" = 'PUBLISHED'
JOIN "EmploymentAssignment" ea ON ea."id" = s."employmentAssignmentId"
JOIN "Position" p ON p."id" = ea."positionId"
WHERE s."status" = 'ACTIVE'
  AND s."startsAt" >= now() - interval '48 hours'
  AND EXISTS (
    SELECT 1 FROM "AttendanceSignIn" si
    WHERE si."employmentAssignmentId" = ea."id" AND si."signedInAt" >= now() - interval '31 days'
  )
GROUP BY 1
ORDER BY 2 DESC;

ROLLBACK;
