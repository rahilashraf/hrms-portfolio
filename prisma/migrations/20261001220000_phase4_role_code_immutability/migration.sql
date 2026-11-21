CREATE FUNCTION "prevent_role_code_mutation"() RETURNS trigger AS $$
BEGIN
    IF NEW."code" IS DISTINCT FROM OLD."code" THEN
        RAISE EXCEPTION 'Role codes are immutable';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Role_code_immutable"
BEFORE UPDATE OF "code" ON "Role"
FOR EACH ROW EXECUTE FUNCTION "prevent_role_code_mutation"();
