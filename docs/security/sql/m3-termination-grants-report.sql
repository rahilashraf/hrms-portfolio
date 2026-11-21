-- Termination grant decisions: read-only pre-deployment report (operator query).
--
-- Shows the existing data that the termination-grant changes do NOT change retroactively (the
-- migration revokes nothing).
-- Run it on a staging copy (never production without explicit approval). It writes nothing:
-- the whole report runs in a READ ONLY transaction, and identifiers only (no names, e-mails or
-- termination reasons) are returned.
--
--   psql "$STAGING_DATABASE_URL" -v ON_ERROR_STOP=1 -f docs/security/sql/m3-termination-grants-report.sql

BEGIN TRANSACTION READ ONLY;

-- 1. Terminated employees whose login still has live grants (M3 would have revoked the ones
--    in the terminated organizations). Review each with the access review; nothing is automatic.
WITH m3_live_grant AS (  -- live: not revoked, not expired, already started
  SELECT ra.* FROM "RoleAssignment" ra
  WHERE ra."revokedAt" IS NULL
    AND (ra."expiresAt" IS NULL OR ra."expiresAt" > now())
    AND ra."startsAt" <= now())
SELECT '1_terminated_with_live_grants' AS section,
       e."id" AS employee_id, u."id" AS user_id, u."status" AS login_status,
       e."terminationDate", count(g."id") AS live_grants,
       count(g."id") FILTER (WHERE g."scopeType" = 'SYSTEM') AS system_grants
FROM "Employee" e
JOIN "User" u ON u."personId" = e."personId"
JOIN m3_live_grant g ON g."userId" = u."id"
WHERE e."status" = 'TERMINATED'
GROUP BY e."id", u."id", u."status", e."terminationDate"
ORDER BY e."terminationDate", e."id";

-- 2. Enabled logins (ACTIVE or LOCKED) whose person has no ACTIVE or PLANNED assignment.
WITH m3_live_grant AS (  -- live: not revoked, not expired, already started
  SELECT ra.* FROM "RoleAssignment" ra
  WHERE ra."revokedAt" IS NULL
    AND (ra."expiresAt" IS NULL OR ra."expiresAt" > now())
    AND ra."startsAt" <= now())
SELECT '2_enabled_login_without_employment' AS section,
       u."id" AS user_id, u."status" AS login_status, e."id" AS employee_id,
       e."status" AS employee_status,
       (SELECT count(*) FROM m3_live_grant g WHERE g."userId" = u."id") AS live_grants
FROM "User" u
LEFT JOIN "Employee" e ON e."personId" = u."personId"
WHERE u."status" IN ('ACTIVE', 'LOCKED')
  AND u."archivedAt" IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM "EmploymentAssignment" a
    WHERE a."employeeId" = e."id" AND a."status" IN ('ACTIVE', 'PLANNED'))
ORDER BY u."id";

-- 3. SYSTEM grants (System Owners) and their holder's employment status. Each one needs an
--    explicit decision when its holder is terminated.
WITH m3_live_grant AS (  -- live: not revoked, not expired, already started
  SELECT ra.* FROM "RoleAssignment" ra
  WHERE ra."revokedAt" IS NULL
    AND (ra."expiresAt" IS NULL OR ra."expiresAt" > now())
    AND ra."startsAt" <= now())
SELECT '3_system_grants' AS section,
       g."id" AS role_assignment_id, g."userId" AS user_id, u."status" AS login_status,
       e."id" AS employee_id, e."status" AS employee_status, g."expiresAt"
FROM m3_live_grant g
JOIN "User" u ON u."id" = g."userId"
LEFT JOIN "Employee" e ON e."personId" = u."personId"
WHERE g."scopeType" = 'SYSTEM'
ORDER BY g."userId", g."id";

-- 4. Scheduled terminations recorded with the legacy acknowledgement (or for a SYSTEM-grant
--    holder): before M3 none has a decision, so after deployment they will not apply until a
--    System administrator records one per SYSTEM grant (TERMINATION_GRANT_DECISION_REQUIRED).
--    (After deployment, GET /employees/:id/terminations/:id/grants shows the decisions.)
WITH m3_live_grant AS (  -- live: not revoked, not expired, already started
  SELECT ra.* FROM "RoleAssignment" ra
  WHERE ra."revokedAt" IS NULL
    AND (ra."expiresAt" IS NULL OR ra."expiresAt" > now())
    AND ra."startsAt" <= now())
SELECT '4_legacy_ack_scheduled' AS section,
       t."id" AS termination_id, t."employeeId", t."terminationDate",
       t."systemGrantsAcknowledged", g."id" AS undecided_system_grant
FROM "EmployeeTermination" t
JOIN "Employee" e ON e."id" = t."employeeId"
JOIN "User" u ON u."personId" = e."personId"
JOIN m3_live_grant g ON g."userId" = u."id" AND g."scopeType" = 'SYSTEM'
WHERE t."status" = 'SCHEDULED'
ORDER BY t."terminationDate", t."id";

-- 4b. All other scheduled terminations: their in-scope grants will be revoked when they apply.
WITH m3_live_grant AS (  -- live: not revoked, not expired, already started
  SELECT ra.* FROM "RoleAssignment" ra
  WHERE ra."revokedAt" IS NULL
    AND (ra."expiresAt" IS NULL OR ra."expiresAt" > now())
    AND ra."startsAt" <= now())
SELECT '4b_scheduled_will_revoke' AS section,
       t."id" AS termination_id, t."employeeId", t."terminationDate",
       count(g."id") AS in_scope_grants
FROM "EmployeeTermination" t
JOIN "Employee" e ON e."id" = t."employeeId"
JOIN "User" u ON u."personId" = e."personId"
JOIN m3_live_grant g ON g."userId" = u."id"
WHERE t."status" = 'SCHEDULED'
  AND g."scopeType" <> 'SYSTEM'
  AND g."organizationId" IN (
    SELECT p."organizationId"
    FROM "EmployeeTerminationAssignment" ta
    JOIN "EmploymentAssignment" a ON a."id" = ta."employmentAssignmentId"
    JOIN "Position" p ON p."id" = a."positionId"
    WHERE ta."terminationId" = t."id")
GROUP BY t."id", t."employeeId", t."terminationDate"
ORDER BY t."terminationDate", t."id";

-- 5. Cross-organization people: live grants in an organization where they have no ACTIVE or
--    PLANNED assignment, or employment in several organizations. A termination revokes only the
--    grants in the organizations it ends; the rest (and the login) remain.
WITH m3_live_grant AS (  -- live: not revoked, not expired, already started
  SELECT ra.* FROM "RoleAssignment" ra
  WHERE ra."revokedAt" IS NULL
    AND (ra."expiresAt" IS NULL OR ra."expiresAt" > now())
    AND ra."startsAt" <= now())
SELECT '5_cross_organization' AS section,
       u."id" AS user_id, e."id" AS employee_id,
       count(DISTINCT p."organizationId") AS employment_orgs,
       count(DISTINCT g."organizationId") FILTER (
         WHERE g."organizationId" IS NOT NULL AND g."organizationId" NOT IN (
           SELECT p2."organizationId" FROM "EmploymentAssignment" a2
           JOIN "Position" p2 ON p2."id" = a2."positionId"
           WHERE a2."employeeId" = e."id" AND a2."status" IN ('ACTIVE', 'PLANNED'))
       ) AS grant_orgs_without_employment
FROM "User" u
JOIN "Employee" e ON e."personId" = u."personId"
LEFT JOIN "EmploymentAssignment" a ON a."employeeId" = e."id" AND a."status" IN ('ACTIVE', 'PLANNED')
LEFT JOIN "Position" p ON p."id" = a."positionId"
LEFT JOIN m3_live_grant g ON g."userId" = u."id"
GROUP BY u."id", e."id"
HAVING count(DISTINCT p."organizationId") > 1
    OR count(DISTINCT g."organizationId") FILTER (
         WHERE g."organizationId" IS NOT NULL AND g."organizationId" NOT IN (
           SELECT p2."organizationId" FROM "EmploymentAssignment" a2
           JOIN "Position" p2 ON p2."id" = a2."positionId"
           WHERE a2."employeeId" = e."id" AND a2."status" IN ('ACTIVE', 'PLANNED'))) > 0
ORDER BY u."id";

ROLLBACK;
