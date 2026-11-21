CREATE UNIQUE INDEX "RoleAssignment_unrevoked_duplicate_guard_idx"
ON "RoleAssignment" (
    "userId",
    "roleId",
    "scopeType",
    COALESCE("organizationId", '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE("organizationalUnitId", '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE("departmentId", '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE("teamId", '00000000-0000-0000-0000-000000000000'::uuid)
)
WHERE "revokedAt" IS NULL;

CREATE FUNCTION "enforce_role_assignment_immutability"() RETURNS trigger AS $$
BEGIN
    IF NEW."userId" IS DISTINCT FROM OLD."userId"
       OR NEW."roleId" IS DISTINCT FROM OLD."roleId"
       OR NEW."roleOrganizationId" IS DISTINCT FROM OLD."roleOrganizationId"
       OR NEW."scopeType" IS DISTINCT FROM OLD."scopeType"
       OR NEW."organizationId" IS DISTINCT FROM OLD."organizationId"
       OR NEW."organizationalUnitId" IS DISTINCT FROM OLD."organizationalUnitId"
       OR NEW."departmentId" IS DISTINCT FROM OLD."departmentId"
       OR NEW."teamId" IS DISTINCT FROM OLD."teamId"
       OR NEW."startsAt" IS DISTINCT FROM OLD."startsAt"
       OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt"
       OR NEW."createdByUserId" IS DISTINCT FROM OLD."createdByUserId"
       OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
        RAISE EXCEPTION 'Role assignment history fields are immutable';
    END IF;

    IF OLD."revokedAt" IS NOT NULL
       AND (NEW."revokedAt" IS DISTINCT FROM OLD."revokedAt"
         OR NEW."revokedByUserId" IS DISTINCT FROM OLD."revokedByUserId"
         OR NEW."revocationReason" IS DISTINCT FROM OLD."revocationReason") THEN
        RAISE EXCEPTION 'Role assignment revocation is immutable';
    END IF;

    IF OLD."revokedAt" IS NULL AND NEW."revokedAt" IS NULL
       AND (NEW."revokedByUserId" IS DISTINCT FROM OLD."revokedByUserId"
         OR NEW."revocationReason" IS DISTINCT FROM OLD."revocationReason") THEN
        RAISE EXCEPTION 'Revocation metadata requires a revocation timestamp';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "RoleAssignment_history_immutable"
BEFORE UPDATE ON "RoleAssignment"
FOR EACH ROW EXECUTE FUNCTION "enforce_role_assignment_immutability"();
