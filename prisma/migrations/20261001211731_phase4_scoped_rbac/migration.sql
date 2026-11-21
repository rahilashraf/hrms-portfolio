-- CreateEnum
CREATE TYPE "RoleAssignmentScopeType" AS ENUM ('SYSTEM', 'ORGANIZATION', 'ORGANIZATIONAL_UNIT', 'DEPARTMENT', 'TEAM');

-- CreateTable
CREATE TABLE "Permission" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Permission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Role" (
    "id" UUID NOT NULL,
    "organizationId" UUID,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isSystemOwner" BOOLEAN NOT NULL DEFAULT false,
    "archivedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RolePermission" (
    "roleId" UUID NOT NULL,
    "permissionId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RolePermission_pkey" PRIMARY KEY ("roleId","permissionId")
);

-- CreateTable
CREATE TABLE "RoleAssignment" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "roleId" UUID NOT NULL,
    "roleOrganizationId" UUID,
    "scopeType" "RoleAssignmentScopeType" NOT NULL,
    "organizationId" UUID,
    "organizationalUnitId" UUID,
    "departmentId" UUID,
    "teamId" UUID,
    "startsAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(6),
    "revokedAt" TIMESTAMPTZ(6),
    "revokedByUserId" UUID,
    "revocationReason" TEXT,
    "createdByUserId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "RoleAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Permission_key_key" ON "Permission"("key");

-- CreateIndex
CREATE INDEX "Permission_isActive_key_idx" ON "Permission"("isActive", "key");

-- CreateIndex
CREATE INDEX "Role_organizationId_archivedAt_name_idx" ON "Role"("organizationId", "archivedAt", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Role_organizationId_code_key" ON "Role"("organizationId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "Role_id_organizationId_key" ON "Role"("id", "organizationId");

-- CreateIndex
CREATE INDEX "RolePermission_permissionId_roleId_idx" ON "RolePermission"("permissionId", "roleId");

-- CreateIndex
CREATE INDEX "RoleAssignment_userId_revokedAt_startsAt_expiresAt_idx" ON "RoleAssignment"("userId", "revokedAt", "startsAt", "expiresAt");

-- CreateIndex
CREATE INDEX "RoleAssignment_roleId_revokedAt_idx" ON "RoleAssignment"("roleId", "revokedAt");

-- CreateIndex
CREATE INDEX "RoleAssignment_organizationId_scopeType_revokedAt_idx" ON "RoleAssignment"("organizationId", "scopeType", "revokedAt");

-- CreateIndex
CREATE INDEX "RoleAssignment_organizationalUnitId_scopeType_idx" ON "RoleAssignment"("organizationalUnitId", "scopeType");

-- CreateIndex
CREATE INDEX "RoleAssignment_departmentId_scopeType_idx" ON "RoleAssignment"("departmentId", "scopeType");

-- CreateIndex
CREATE INDEX "RoleAssignment_teamId_scopeType_idx" ON "RoleAssignment"("teamId", "scopeType");

-- CreateIndex
CREATE UNIQUE INDEX "Department_id_organizationId_key" ON "Department"("id", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationalUnit_id_organizationId_key" ON "OrganizationalUnit"("id", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "Team_id_organizationId_key" ON "Team"("id", "organizationId");

-- AddForeignKey
ALTER TABLE "Role" ADD CONSTRAINT "Role_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RolePermission" ADD CONSTRAINT "RolePermission_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RolePermission" ADD CONSTRAINT "RolePermission_permissionId_fkey" FOREIGN KEY ("permissionId") REFERENCES "Permission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoleAssignment" ADD CONSTRAINT "RoleAssignment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoleAssignment" ADD CONSTRAINT "RoleAssignment_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoleAssignment" ADD CONSTRAINT "RoleAssignment_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoleAssignment" ADD CONSTRAINT "RoleAssignment_organizationalUnitId_organizationId_fkey" FOREIGN KEY ("organizationalUnitId", "organizationId") REFERENCES "OrganizationalUnit"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoleAssignment" ADD CONSTRAINT "RoleAssignment_departmentId_organizationId_fkey" FOREIGN KEY ("departmentId", "organizationId") REFERENCES "Department"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoleAssignment" ADD CONSTRAINT "RoleAssignment_teamId_organizationId_fkey" FOREIGN KEY ("teamId", "organizationId") REFERENCES "Team"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoleAssignment" ADD CONSTRAINT "RoleAssignment_revokedByUserId_fkey" FOREIGN KEY ("revokedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RoleAssignment" ADD CONSTRAINT "RoleAssignment_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "Role_system_owner_singleton_idx"
ON "Role" ("isSystemOwner")
WHERE "isSystemOwner" = true;

ALTER TABLE "Role"
ADD CONSTRAINT "Role_system_owner_reserved_check"
CHECK (
    ("isSystemOwner" = true AND "organizationId" IS NULL AND "code" = 'SYSTEM_OWNER')
    OR ("isSystemOwner" = false AND "organizationId" IS NOT NULL AND "code" <> 'SYSTEM_OWNER')
);

ALTER TABLE "RoleAssignment"
ADD CONSTRAINT "RoleAssignment_scope_target_check"
CHECK (
    ("scopeType" = 'SYSTEM' AND "organizationId" IS NULL AND "organizationalUnitId" IS NULL AND "departmentId" IS NULL AND "teamId" IS NULL AND "roleOrganizationId" IS NULL)
    OR ("scopeType" = 'ORGANIZATION' AND "organizationId" IS NOT NULL AND "organizationalUnitId" IS NULL AND "departmentId" IS NULL AND "teamId" IS NULL AND "roleOrganizationId" = "organizationId")
    OR ("scopeType" = 'ORGANIZATIONAL_UNIT' AND "organizationId" IS NOT NULL AND "organizationalUnitId" IS NOT NULL AND "departmentId" IS NULL AND "teamId" IS NULL AND "roleOrganizationId" = "organizationId")
    OR ("scopeType" = 'DEPARTMENT' AND "organizationId" IS NOT NULL AND "organizationalUnitId" IS NULL AND "departmentId" IS NOT NULL AND "teamId" IS NULL AND "roleOrganizationId" = "organizationId")
    OR ("scopeType" = 'TEAM' AND "organizationId" IS NOT NULL AND "organizationalUnitId" IS NULL AND "departmentId" IS NULL AND "teamId" IS NOT NULL AND "roleOrganizationId" = "organizationId")
);

ALTER TABLE "RoleAssignment"
ADD CONSTRAINT "RoleAssignment_effective_date_check"
CHECK ("expiresAt" IS NULL OR "expiresAt" > "startsAt");

CREATE FUNCTION "validate_role_assignment_scope"() RETURNS trigger AS $$
DECLARE
    assigned_role_organization UUID;
    assigned_role_is_system_owner BOOLEAN;
BEGIN
    SELECT "organizationId", "isSystemOwner"
      INTO assigned_role_organization, assigned_role_is_system_owner
      FROM "Role"
     WHERE "id" = NEW."roleId";

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Role assignment references a missing role';
    END IF;

    IF NEW."scopeType" = 'SYSTEM' THEN
        IF assigned_role_organization IS NOT NULL OR assigned_role_is_system_owner IS NOT TRUE THEN
            RAISE EXCEPTION 'SYSTEM assignments require the reserved System Owner role';
        END IF;
    ELSIF assigned_role_organization IS DISTINCT FROM NEW."organizationId"
       OR assigned_role_is_system_owner IS TRUE THEN
        RAISE EXCEPTION 'Role and assignment scope must belong to the same organization';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "RoleAssignment_scope_role_guard"
BEFORE INSERT OR UPDATE OF "roleId", "roleOrganizationId", "scopeType", "organizationId"
ON "RoleAssignment"
FOR EACH ROW EXECUTE FUNCTION "validate_role_assignment_scope"();

CREATE FUNCTION "prevent_permission_key_mutation"() RETURNS trigger AS $$
BEGIN
    IF NEW."key" IS DISTINCT FROM OLD."key" THEN
        RAISE EXCEPTION 'Permission keys are immutable';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Permission_key_immutable"
BEFORE UPDATE OF "key" ON "Permission"
FOR EACH ROW EXECUTE FUNCTION "prevent_permission_key_mutation"();
