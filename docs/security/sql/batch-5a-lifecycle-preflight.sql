-- Employee lifecycle core: read-only preflight (operator query).
-- READ ONLY: lists rows, changes nothing (no backfill, no rewrite). Run it before deploying the
-- employee lifecycle changes to a database that holds existing employees, and keep the output:
--   psql "$DATABASE_URL" -f docs/security/sql/batch-5a-lifecycle-preflight.sql
-- Counts first, then up to 200 example rows per finding. Identifiers only: no names, reasons or
-- contact details. Each check below explains what its rows mean.
BEGIN TRANSACTION READ ONLY;

-- 1. ACTIVE assignments already past their end date (by UTC date; each assignment's own time
--    zone may be up to a day behind). With EMPLOYEE_LIFECYCLE_AUTOMATION_ENABLED=true the first
--    end-due-assignments run ends all of them (ACTIVE -> ENDED, audited); with it off they appear
--    in GET /employees/lifecycle/due for manual processing.
SELECT count(*) AS overdue_active_assignments
FROM "EmploymentAssignment"
WHERE "status" = 'ACTIVE' AND "endDate" < CURRENT_DATE - 1;
SELECT ea."id" AS employment_assignment_id, ea."employeeId" AS employee_id,
       p."organizationId" AS organization_id, ea."endDate" AS end_date
FROM "EmploymentAssignment" ea
JOIN "Position" p ON p."id" = ea."positionId"
WHERE ea."status" = 'ACTIVE' AND ea."endDate" < CURRENT_DATE - 1
ORDER BY ea."endDate", ea."id"
LIMIT 200;

-- 2. R4: TERMINATED employees whose termination date is still in the future (recorded by the
--    previous immediate-termination behaviour). Reported only; 5A does not migrate or rewrite
--    them. Review each with HR.
SELECT count(*) AS terminated_with_future_date
FROM "Employee"
WHERE "status" = 'TERMINATED' AND "terminationDate" > CURRENT_DATE;
SELECT "id" AS employee_id, "terminationDate" AS termination_date
FROM "Employee"
WHERE "status" = 'TERMINATED' AND "terminationDate" > CURRENT_DATE
ORDER BY "terminationDate", "id"
LIMIT 200;

-- 3. TERMINATED employees that still have an ACTIVE or PLANNED assignment.
SELECT count(DISTINCT e."id") AS terminated_with_open_assignments
FROM "Employee" e
JOIN "EmploymentAssignment" ea ON ea."employeeId" = e."id"
WHERE e."status" = 'TERMINATED' AND ea."status" IN ('ACTIVE', 'PLANNED');
SELECT e."id" AS employee_id, ea."id" AS employment_assignment_id, ea."status",
       ea."startDate" AS start_date, ea."endDate" AS end_date
FROM "Employee" e
JOIN "EmploymentAssignment" ea ON ea."employeeId" = e."id"
WHERE e."status" = 'TERMINATED' AND ea."status" IN ('ACTIVE', 'PLANNED')
ORDER BY e."id", ea."startDate"
LIMIT 200;

-- 4. TERMINATED employees whose login is still usable (active login or unrevoked sessions).
--    5A revokes sessions only for terminations it applies; earlier ones are reported here. The
--    login stays when the account still holds grants (R2): see the grant count.
SELECT e."id" AS employee_id, u."id" AS user_id, u."status" AS login_status,
       (SELECT count(*) FROM "AuthSession" s
         WHERE s."userId" = u."id" AND s."revokedAt" IS NULL AND s."expiresAt" > now())
         AS open_sessions,
       (SELECT count(*) FROM "RoleAssignment" r
         WHERE r."userId" = u."id" AND r."revokedAt" IS NULL
           AND (r."expiresAt" IS NULL OR r."expiresAt" > now())) AS active_grants
FROM "Employee" e
JOIN "User" u ON u."personId" = e."personId"
WHERE e."status" = 'TERMINATED'
  AND (u."status" = 'ACTIVE'
       OR EXISTS (SELECT 1 FROM "AuthSession" s
                   WHERE s."userId" = u."id" AND s."revokedAt" IS NULL AND s."expiresAt" > now()))
ORDER BY e."id"
LIMIT 200;

-- 5. Positions occupied by overlapping non-cancelled assignments (5A refuses new overlaps; old
--    ones block corrections of those assignments until resolved).
SELECT a."positionId" AS position_id, a."id" AS assignment_a, b."id" AS assignment_b
FROM "EmploymentAssignment" a
JOIN "EmploymentAssignment" b
  ON b."positionId" = a."positionId" AND b."id" > a."id"
 AND b."status" <> 'CANCELLED'
 AND a."startDate" <= COALESCE(b."endDate", DATE '9999-12-31')
 AND b."startDate" <= COALESCE(a."endDate", DATE '9999-12-31')
WHERE a."status" <> 'CANCELLED'
ORDER BY 1, 2
LIMIT 200;

-- 6. Employees with overlapping primary assignments.
SELECT a."employeeId" AS employee_id, a."id" AS assignment_a, b."id" AS assignment_b
FROM "EmploymentAssignment" a
JOIN "EmploymentAssignment" b
  ON b."employeeId" = a."employeeId" AND b."id" > a."id"
 AND b."isPrimary" AND b."status" <> 'CANCELLED'
 AND a."startDate" <= COALESCE(b."endDate", DATE '9999-12-31')
 AND b."startDate" <= COALESCE(a."endDate", DATE '9999-12-31')
WHERE a."isPrimary" AND a."status" <> 'CANCELLED'
ORDER BY 1, 2
LIMIT 200;

-- 7. Manager links that cross organizations (subordinate and manager positions in different
--    organizations). Informational: 5A does not change manager rules.
SELECT s."id" AS employment_assignment_id, ps."organizationId" AS organization_id,
       m."id" AS manager_assignment_id, pm."organizationId" AS manager_organization_id
FROM "EmploymentAssignment" s
JOIN "Position" ps ON ps."id" = s."positionId"
JOIN "EmploymentAssignment" m ON m."id" = s."managerAssignmentId"
JOIN "Position" pm ON pm."id" = m."positionId"
WHERE ps."organizationId" <> pm."organizationId"
ORDER BY 2, 1
LIMIT 200;

-- 8. Archived positions that still have ACTIVE or PLANNED assignments.
SELECT p."id" AS position_id, p."organizationId" AS organization_id,
       ea."id" AS employment_assignment_id, ea."status"
FROM "Position" p
JOIN "EmploymentAssignment" ea ON ea."positionId" = p."id"
WHERE p."archivedAt" IS NOT NULL AND ea."status" IN ('ACTIVE', 'PLANNED')
ORDER BY 1, 3
LIMIT 200;

-- 9. ENDED assignments with an end date still in the future, or none (the previous "end"
--    action ended immediately whatever the date). 5A corrections keep them ENDED; their dates
--    remain as recorded.
SELECT count(*) AS ended_with_future_or_open_end
FROM "EmploymentAssignment"
WHERE "status" = 'ENDED' AND ("endDate" IS NULL OR "endDate" > CURRENT_DATE);
SELECT "id" AS employment_assignment_id, "employeeId" AS employee_id, "endDate" AS end_date
FROM "EmploymentAssignment"
WHERE "status" = 'ENDED' AND ("endDate" IS NULL OR "endDate" > CURRENT_DATE)
ORDER BY "endDate" NULLS FIRST, "id"
LIMIT 200;

-- 10. INACTIVE employees (5A blocks new assignments and time capture for them; nothing else
--     changes).
SELECT count(*) AS inactive_employees FROM "Employee" WHERE "status" = 'INACTIVE';

-- 11. Assignments whose position has no resolvable time zone (neither its work location nor its
--     organization has one). 5A evaluates their dates in UTC.
SELECT ea."id" AS employment_assignment_id, p."id" AS position_id,
       p."organizationId" AS organization_id
FROM "EmploymentAssignment" ea
JOIN "Position" p ON p."id" = ea."positionId"
JOIN "Organization" o ON o."id" = p."organizationId"
LEFT JOIN "WorkLocation" w ON w."id" = p."workLocationId"
WHERE ea."status" IN ('ACTIVE', 'PLANNED')
  AND COALESCE(NULLIF(trim(w."timezone"), ''), NULLIF(trim(o."timezone"), '')) IS NULL
ORDER BY 3, 1
LIMIT 200;

ROLLBACK;
