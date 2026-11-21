CREATE OR REPLACE FUNCTION "validate_role_assignment_scope"() RETURNS trigger AS $$
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

    IF NEW."roleOrganizationId" IS DISTINCT FROM assigned_role_organization THEN
        RAISE EXCEPTION 'Role organization reference does not match the assigned role';
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

CREATE FUNCTION "prevent_role_organization_mutation"() RETURNS trigger AS $$
BEGIN
    IF NEW."organizationId" IS DISTINCT FROM OLD."organizationId" THEN
        RAISE EXCEPTION 'Role organization ownership is immutable';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Role_organization_immutable"
BEFORE UPDATE OF "organizationId" ON "Role"
FOR EACH ROW EXECUTE FUNCTION "prevent_role_organization_mutation"();
