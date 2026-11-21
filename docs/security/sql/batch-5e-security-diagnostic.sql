-- Security and lifecycle hardening: read-only diagnostic (operator query).
-- READ ONLY: lists rows, changes nothing (no backfill, no rewrite). Run it before deploying the
-- security and lifecycle hardening changes to a database that holds existing data, and keep
-- the output:
--   psql "$DATABASE_URL" -f docs/security/sql/batch-5e-security-diagnostic.sql
-- Identifiers only (no names, emails or reasons); up to 200 example rows per finding. Each check
-- below explains what its rows mean.

BEGIN TRANSACTION READ ONLY;

-- 1. Inert grants (K9): unrevoked, unexpired grants that authorize nothing because their scope
--    organization, their role's organization or their role is archived. The access review now
--    marks them (inactiveReason). Kept as they are; reactivating restores them.
SELECT ra."id" AS role_assignment_id, ra."userId" AS user_id, ra."scopeType" AS scope_type,
       ra."organizationId" AS scope_organization_id, r."organizationId" AS role_organization_id,
       CASE
         WHEN so."archivedAt" IS NOT NULL OR ro."archivedAt" IS NOT NULL THEN 'ORGANIZATION_ARCHIVED'
         ELSE 'ROLE_ARCHIVED'
       END AS inactive_reason
FROM "RoleAssignment" ra
JOIN "Role" r ON r."id" = ra."roleId"
LEFT JOIN "Organization" so ON so."id" = ra."organizationId"
LEFT JOIN "Organization" ro ON ro."id" = r."organizationId"
WHERE ra."revokedAt" IS NULL
  AND (ra."expiresAt" IS NULL OR ra."expiresAt" > now())
  AND (so."archivedAt" IS NOT NULL OR ro."archivedAt" IS NOT NULL OR r."archivedAt" IS NOT NULL)
ORDER BY 6, 4, 2
LIMIT 200;

-- 2. Archived roles that still hold unrevoked grants. Archiving a role revokes its grants in the
--    same transaction, so rows here predate that rule or were changed outside the application.
SELECT r."id" AS role_id, r."organizationId" AS organization_id, r."archivedAt" AS archived_at,
       count(ra."id") AS unrevoked_grants
FROM "Role" r
JOIN "RoleAssignment" ra ON ra."roleId" = r."id" AND ra."revokedAt" IS NULL
WHERE r."archivedAt" IS NOT NULL
GROUP BY r."id", r."organizationId", r."archivedAt"
ORDER BY 3
LIMIT 200;

-- 3. Historical cross-organization grants: an organization role granted in another
--    organization's scope, or a stored role organization that disagrees with the role. Refused
--    by the RoleAssignment scope trigger and check constraint since Phase 4, so expected empty;
--    any row means data was changed with the trigger disabled or a role's organization changed.
SELECT ra."id" AS role_assignment_id, ra."userId" AS user_id, ra."scopeType" AS scope_type,
       ra."organizationId" AS scope_organization_id, ra."roleOrganizationId" AS stored_role_organization_id,
       r."organizationId" AS role_organization_id, ra."revokedAt" IS NOT NULL AS revoked
FROM "RoleAssignment" ra
JOIN "Role" r ON r."id" = ra."roleId"
WHERE ra."scopeType" <> 'SYSTEM'
  AND (r."organizationId" IS DISTINCT FROM ra."organizationId"
       OR ra."roleOrganizationId" IS DISTINCT FROM r."organizationId")
ORDER BY 7, 4
LIMIT 200;

-- 4. Shared logins with grants in archived and live organizations (informational; corrects the
--    5B diagnostic's check 5, which ignored expiry and role organizations).
SELECT ra."userId" AS user_id,
       count(DISTINCT ra."organizationId") FILTER (
         WHERE so."archivedAt" IS NULL AND ro."archivedAt" IS NULL AND r."archivedAt" IS NULL
       ) AS live_organizations,
       count(DISTINCT ra."organizationId") FILTER (
         WHERE so."archivedAt" IS NOT NULL OR ro."archivedAt" IS NOT NULL
       ) AS archived_organizations
FROM "RoleAssignment" ra
JOIN "Role" r ON r."id" = ra."roleId"
JOIN "Organization" so ON so."id" = ra."organizationId"
LEFT JOIN "Organization" ro ON ro."id" = r."organizationId"
WHERE ra."revokedAt" IS NULL
  AND (ra."expiresAt" IS NULL OR ra."expiresAt" > now())
GROUP BY ra."userId"
HAVING count(DISTINCT ra."organizationId") FILTER (
         WHERE so."archivedAt" IS NOT NULL OR ro."archivedAt" IS NOT NULL
       ) > 0
ORDER BY 1
LIMIT 200;

-- 5. E-3: grants with more than one ROLE_ASSIGNMENT_REVOKED audit entry (concurrent revocations
--    before 5E). History is kept; the grant row names the last revoker.
SELECT a."entityId" AS role_assignment_id, count(*) AS revocation_entries,
       min(a."occurredAt") AS first_at, max(a."occurredAt") AS last_at
FROM "AuditLog" a
WHERE a."action" = 'ROLE_ASSIGNMENT_REVOKED' AND a."entityType" = 'RoleAssignment'
GROUP BY a."entityId"
HAVING count(*) > 1
ORDER BY 4 DESC
LIMIT 200;

-- 6. Overnight time at a termination (R3): OPEN time entries of TERMINATED employees or on
--    ENDED assignments. Each needs an audited manager correction (5E makes the next-day
--    clock-out possible); until then the timesheet cannot be submitted and payroll reports
--    TIMESHEET_NOT_FINAL for an hourly assignment.
SELECT te."id" AS time_entry_id, te."employeeId" AS employee_id,
       te."employmentAssignmentId" AS assignment_id, te."workDate" AS work_date,
       e."status" AS employee_status, ea."status" AS assignment_status, ea."endDate" AS assignment_end
FROM "TimeEntry" te
JOIN "Employee" e ON e."id" = te."employeeId"
JOIN "EmploymentAssignment" ea ON ea."id" = te."employmentAssignmentId"
WHERE te."status" = 'OPEN' AND te."archivedAt" IS NULL
  AND (e."status" = 'TERMINATED' OR ea."status" IN ('ENDED', 'CANCELLED'))
ORDER BY 4
LIMIT 200;

-- 7. A-3: archived, never-activated logins (a cancelled or failed invitation) that still hold
--    live grants. Before 5E a failed first invitation email could leave a role assigned during
--    delivery; reissuing the invitation now revokes such grants first. Listed for review.
SELECT u."id" AS user_id, u."archivedAt" AS archived_at, count(ra."id") AS live_grants
FROM "User" u
JOIN "RoleAssignment" ra ON ra."userId" = u."id" AND ra."revokedAt" IS NULL
  AND (ra."expiresAt" IS NULL OR ra."expiresAt" > now())
WHERE u."status" = 'ARCHIVED' AND u."passwordHash" IS NULL
GROUP BY u."id", u."archivedAt"
ORDER BY 2
LIMIT 200;

ROLLBACK;
