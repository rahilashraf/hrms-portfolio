-- Onboarding / offboarding task owners outside their organization (operator query).
-- READ ONLY: counts rows, changes nothing.
-- Run with: psql "$DATABASE_URL" -f docs/security/sql/onboarding-task-owner-scope.sql
--
-- Not distinguishable from data: owners set by a System-scope administrator are legitimate
-- yet are counted here when the owner is not connected to the organization. Review the rows
-- (each counted task can be listed by replacing the final SELECT) before deciding anything.
BEGIN TRANSACTION READ ONLY;

-- An account "connected to" an organization, as the API now checks it: ACTIVE, not archived,
-- and a PLANNED/ACTIVE employment assignment in one of the organization's positions, or a
-- current (not revoked, not expired) non-System role assignment in the organization on a role
-- that is not archived.
WITH connected AS (
  SELECT u.id AS user_id, p."organizationId" AS organization_id
  FROM "User" u
  JOIN "Employee" e ON e."personId" = u."personId"
  JOIN "EmploymentAssignment" a ON a."employeeId" = e.id AND a.status IN ('PLANNED', 'ACTIVE')
  JOIN "Position" p ON p.id = a."positionId"
  WHERE u.status = 'ACTIVE' AND u."archivedAt" IS NULL
  UNION
  SELECT u.id, ra."organizationId"
  FROM "User" u
  JOIN "RoleAssignment" ra ON ra."userId" = u.id
  JOIN "Role" r ON r.id = ra."roleId" AND r."archivedAt" IS NULL
  WHERE u.status = 'ACTIVE' AND u."archivedAt" IS NULL
    AND ra."revokedAt" IS NULL
    AND ra."scopeType" <> 'SYSTEM'
    AND ra."organizationId" IS NOT NULL
    AND (ra."expiresAt" IS NULL OR ra."expiresAt" > now())
),
template_owners AS (
  SELECT t.id, t."organizationId", t."ownerType", t."ownerUserId", wt.status AS template_status
  FROM "WorkflowTemplateTask" t
  JOIN "WorkflowTemplate" wt ON wt.id = t."templateId"
  WHERE t."ownerUserId" IS NOT NULL
),
workflow_owners AS (
  -- Owners of tasks still open in ACTIVE workflows, with the employee's manager's account
  -- (the manager exception applies to workflow tasks only; templates have no employee).
  SELECT t.id, t."organizationId", t."ownerType", t."ownerUserId", mu.id AS manager_user_id
  FROM "EmployeeWorkflowTask" t
  JOIN "EmployeeWorkflow" w ON w.id = t."workflowId" AND w.status = 'ACTIVE'
  JOIN "EmploymentAssignment" ea ON ea.id = w."employmentAssignmentId"
  LEFT JOIN "EmploymentAssignment" ma ON ma.id = ea."managerAssignmentId"
  LEFT JOIN "Employee" me ON me.id = ma."employeeId"
  LEFT JOIN "User" mu ON mu."personId" = me."personId"
    AND mu.status = 'ACTIVE' AND mu."archivedAt" IS NULL
  WHERE t."ownerUserId" IS NOT NULL
    AND t.status IN ('NOT_STARTED', 'IN_PROGRESS')
)
SELECT "organizationId" AS organization_id,
       'template task owners not connected to the organization' AS finding,
       template_status::text AS detail, "ownerType"::text AS owner_type,
       count(*) AS tasks, count(DISTINCT "ownerUserId") AS owners
FROM template_owners o
WHERE NOT EXISTS (SELECT 1 FROM connected c
                  WHERE c.user_id = o."ownerUserId" AND c.organization_id = o."organizationId")
GROUP BY "organizationId", template_status, "ownerType"
UNION ALL
SELECT "organizationId",
       'open workflow task owners not connected to the organization (and not the manager)',
       'ACTIVE workflow', "ownerType"::text, count(*), count(DISTINCT "ownerUserId")
FROM workflow_owners o
WHERE NOT EXISTS (SELECT 1 FROM connected c
                  WHERE c.user_id = o."ownerUserId" AND c.organization_id = o."organizationId")
  AND o."ownerUserId" IS DISTINCT FROM o.manager_user_id
GROUP BY "organizationId", "ownerType"
ORDER BY 1, 2, 3, 4;

ROLLBACK;
