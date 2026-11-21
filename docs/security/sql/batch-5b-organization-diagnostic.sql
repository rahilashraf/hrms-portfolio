-- Organization and assignment operations: read-only diagnostic (operator query).
-- READ ONLY: lists rows, changes nothing (no backfill or rewrite). Run it before deploying the
-- organization and assignment changes to a database that holds existing data, and keep the output:
--   psql "$DATABASE_URL" -f docs/security/sql/batch-5b-organization-diagnostic.sql
-- Identifiers only (no names or contact details); up to 200 example rows per finding. Each check
-- below explains what its rows mean.
BEGIN TRANSACTION READ ONLY;

-- 1. K7: manager links that cross organizations (subordinate and manager positions in different
--    organizations). Kept as they are; new or changed links must be same-organization. The
--    profile shows MANAGER_ORGANIZATION_MISMATCH on these.
SELECT count(*) AS cross_organization_manager_links
FROM "EmploymentAssignment" s
JOIN "Position" ps ON ps."id" = s."positionId"
JOIN "EmploymentAssignment" m ON m."id" = s."managerAssignmentId"
JOIN "Position" pm ON pm."id" = m."positionId"
WHERE ps."organizationId" <> pm."organizationId";
SELECT s."id" AS employment_assignment_id, ps."organizationId" AS organization_id,
       m."id" AS manager_assignment_id, pm."organizationId" AS manager_organization_id
FROM "EmploymentAssignment" s
JOIN "Position" ps ON ps."id" = s."positionId"
JOIN "EmploymentAssignment" m ON m."id" = s."managerAssignmentId"
JOIN "Position" pm ON pm."id" = m."positionId"
WHERE ps."organizationId" <> pm."organizationId"
ORDER BY 2, 1
LIMIT 200;

-- 2. K7: open assignments whose manager's assignment has ended or been cancelled (the link is
--    kept; the profile shows MANAGER_ASSIGNMENT_ENDED).
SELECT s."id" AS employment_assignment_id, s."status", m."id" AS manager_assignment_id,
       m."status" AS manager_status, m."endDate" AS manager_end_date
FROM "EmploymentAssignment" s
JOIN "EmploymentAssignment" m ON m."id" = s."managerAssignmentId"
WHERE s."status" IN ('ACTIVE', 'PLANNED')
  AND (m."status" IN ('ENDED', 'CANCELLED') OR m."endDate" < CURRENT_DATE)
ORDER BY m."endDate" NULLS FIRST, s."id"
LIMIT 200;

-- 3. D17: archived positions that still have ACTIVE or PLANNED assignments (archiving is now
--    refused with live assignments; planned ones here cannot be activated: POSITION_ARCHIVED).
SELECT p."id" AS position_id, p."organizationId" AS organization_id,
       ea."id" AS employment_assignment_id, ea."status"
FROM "Position" p
JOIN "EmploymentAssignment" ea ON ea."positionId" = p."id"
WHERE p."archivedAt" IS NOT NULL AND ea."status" IN ('ACTIVE', 'PLANNED')
ORDER BY 2, 1, 3
LIMIT 200;

-- 4. K9: role grants that stop counting because their scope organization or role organization
--    is archived (records kept; reactivating the organization restores them).
SELECT ra."id" AS role_assignment_id, ra."userId" AS user_id, ra."scopeType" AS scope_type,
       ra."organizationId" AS scope_organization_id, r."organizationId" AS role_organization_id
FROM "RoleAssignment" ra
JOIN "Role" r ON r."id" = ra."roleId"
LEFT JOIN "Organization" so ON so."id" = ra."organizationId"
LEFT JOIN "Organization" ro ON ro."id" = r."organizationId"
WHERE ra."revokedAt" IS NULL
  AND (ra."expiresAt" IS NULL OR ra."expiresAt" > now())
  AND (so."archivedAt" IS NOT NULL OR ro."archivedAt" IS NOT NULL)
ORDER BY 4, 2
LIMIT 200;

-- 5. K9: accounts that keep authorization elsewhere after (4) — shared logins with grants in
--    more than one organization, at least one of them archived. Informational. Superseded by
--    check 4 of batch-5e-security-diagnostic.sql (this one ignores expiry, the role's
--    organization and archived roles); kept unchanged for comparison with recorded outputs.
SELECT ra."userId" AS user_id,
       count(DISTINCT ra."organizationId") FILTER (WHERE so."archivedAt" IS NULL) AS live_organizations,
       count(DISTINCT ra."organizationId") FILTER (WHERE so."archivedAt" IS NOT NULL) AS archived_organizations
FROM "RoleAssignment" ra
JOIN "Organization" so ON so."id" = ra."organizationId"
WHERE ra."revokedAt" IS NULL
GROUP BY ra."userId"
HAVING count(DISTINCT ra."organizationId") FILTER (WHERE so."archivedAt" IS NOT NULL) > 0
ORDER BY 1
LIMIT 200;

-- 6. Archived organizations that still have unarchived structure or open assignments (archiving
--    an organization is refused while structure is active; these predate that rule).
SELECT o."id" AS organization_id,
       (SELECT count(*) FROM "Position" p WHERE p."organizationId" = o."id" AND p."archivedAt" IS NULL) AS live_positions,
       (SELECT count(*) FROM "EmploymentAssignment" ea JOIN "Position" p ON p."id" = ea."positionId"
         WHERE p."organizationId" = o."id" AND ea."status" IN ('ACTIVE', 'PLANNED')) AS open_assignments
FROM "Organization" o
WHERE o."archivedAt" IS NOT NULL
ORDER BY 1
LIMIT 200;

-- 7. D19: positions anchored to a team or department whose unit path comes from the team or
--    department (pickers now include them for unit-scoped managers). Informational count.
SELECT count(*) FILTER (WHERE p."teamId" IS NOT NULL AND p."organizationalUnitId" IS NULL) AS team_positions_without_unit,
       count(*) FILTER (WHERE p."departmentId" IS NOT NULL AND p."teamId" IS NULL AND p."organizationalUnitId" IS NULL) AS department_positions_without_unit
FROM "Position" p
WHERE p."archivedAt" IS NULL;

-- 8. Physical sites: archived sites still used by an unarchived work location or an active
--    kiosk device (5B refuses archiving a site in that state), and work locations whose site
--    belongs to another organization.
SELECT ps."id" AS physical_site_id, ps."organizationId" AS organization_id,
       (SELECT count(*) FROM "WorkLocation" w WHERE w."physicalSiteId" = ps."id" AND w."archivedAt" IS NULL) AS live_work_locations,
       (SELECT count(*) FROM "AttendanceDevice" d WHERE d."physicalSiteId" = ps."id" AND d."status" = 'ACTIVE') AS active_devices
FROM "PhysicalSite" ps
WHERE ps."archivedAt" IS NOT NULL
ORDER BY 2, 1
LIMIT 200;
SELECT w."id" AS work_location_id, w."organizationId" AS organization_id,
       ps."id" AS physical_site_id, ps."organizationId" AS site_organization_id
FROM "WorkLocation" w
JOIN "PhysicalSite" ps ON ps."id" = w."physicalSiteId"
WHERE ps."organizationId" <> w."organizationId"
ORDER BY 2, 1
LIMIT 200;

-- 9. Physical sites created implicitly by work-location saves (one site per work location, same
--    name); 5B no longer creates them silently. Informational.
SELECT ps."organizationId" AS organization_id, count(*) AS single_use_sites
FROM "PhysicalSite" ps
WHERE (SELECT count(*) FROM "WorkLocation" w WHERE w."physicalSiteId" = ps."id") = 1
GROUP BY 1
ORDER BY 1;

ROLLBACK;
