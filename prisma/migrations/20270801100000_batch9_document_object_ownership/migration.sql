-- Batch 9 (final review, N3): defence in depth for stored-object ownership.
--
-- The version guard already requires an attached object of the version's organization, purpose
-- and key. This narrows it to the object's own target, mirroring the application's binding
-- check: an employee document version takes only an object uploaded for that document's
-- employee (and, when the upload named a document, for that document); a policy version takes
-- only an object uploaded for that policy.
--
-- Function body only: no table, column or index changes. Existing rows are untouched (the
-- trigger checks inserts; an update may never change storedObjectId, unchanged). Rows without a
-- stored object (links, references, legacy internal references) are unaffected.
-- Rollback: re-run the CREATE OR REPLACE FUNCTION from 20270801090000_batch9_document_storage.
CREATE OR REPLACE FUNCTION guard_document_version_object() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  object_row "DocumentStoredObject"%ROWTYPE;
  version_organization uuid;
  version_employee uuid;
  owner_ok boolean;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."storedObjectId" IS DISTINCT FROM OLD."storedObjectId" THEN
      RAISE EXCEPTION 'A version''s stored object never changes.' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."storedObjectId" IS NULL THEN
    IF NEW."provider" = 'INTERNAL_OBJECT_STORAGE' THEN
      RAISE EXCEPTION 'Internal storage takes an uploaded file, never a typed key.' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO object_row FROM "DocumentStoredObject" WHERE "id" = NEW."storedObjectId";
  -- Each table's own columns only (PL/pgSQL resolves NEW fields per table).
  IF TG_TABLE_NAME = 'EmployeeDocumentVersion' THEN
    SELECT "organizationId", "employeeId" INTO version_organization, version_employee
      FROM "EmployeeDocument" WHERE "id" = NEW."documentId";
    owner_ok := object_row."purpose" IN ('EMPLOYEE_DOCUMENT', 'SELF_SERVICE')
      AND object_row."employeeId" IS NOT DISTINCT FROM version_employee
      AND (object_row."documentId" IS NULL OR object_row."documentId" = NEW."documentId");
  ELSE
    version_organization := NEW."organizationId";
    owner_ok := object_row."purpose" = 'POLICY_VERSION'
      AND object_row."policyId" IS NOT DISTINCT FROM NEW."policyId";
  END IF;
  IF NEW."provider" <> 'INTERNAL_OBJECT_STORAGE' OR object_row."status" <> 'ATTACHED'
     OR object_row."organizationId" <> version_organization
     OR object_row."storageKey" <> NEW."storageKey"
     OR owner_ok IS NOT TRUE THEN
    RAISE EXCEPTION 'The stored object is not attached to this organization''s version.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
