-- Batch 9 — Document storage (D11): one narrow, additive migration.
--
-- * DocumentStoredObject: the durable ledger of uploaded objects (server-generated key bound to
--   the row's organization and id, the authorized purpose and target, verified size, SHA-256,
--   detected type, scan state and lifecycle).
-- * EmployeeDocumentVersion.storedObjectId / PolicyDocumentVersion.storedObjectId (+ sizeBytes):
--   a version references its uploaded object once.
-- * Guards: no client-chosen internal keys at the database level (an INTERNAL_OBJECT_STORAGE
--   version needs an attached object of its own organization), one-way object lifecycle, an
--   attached object is never abandoned or deleted, and cleanup only removes unreferenced objects.
--
-- Existing rows are untouched. Legacy INTERNAL_OBJECT_STORAGE versions (hand-typed keys, before
-- Batch 9) keep storedObjectId NULL and are never downloadable.

CREATE TYPE "DocumentStoredObjectStatus" AS ENUM ('UPLOADING', 'STORED', 'ATTACHED', 'ABANDONED', 'REJECTED', 'DELETED');
CREATE TYPE "DocumentScanStatus" AS ENUM ('NOT_SCANNED', 'PENDING', 'CLEAN', 'INFECTED', 'FAILED');
CREATE TYPE "DocumentUploadPurpose" AS ENUM ('EMPLOYEE_DOCUMENT', 'SELF_SERVICE', 'POLICY_VERSION');

CREATE TABLE "DocumentStoredObject" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "purpose" "DocumentUploadPurpose" NOT NULL,
    "employeeId" UUID,
    "documentId" UUID,
    "policyId" UUID,
    "backend" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "status" "DocumentStoredObjectStatus" NOT NULL DEFAULT 'UPLOADING',
    "scanStatus" "DocumentScanStatus" NOT NULL DEFAULT 'NOT_SCANNED',
    "fileName" TEXT NOT NULL,
    "detectedMimeType" TEXT,
    "sizeBytes" INTEGER,
    "sha256" TEXT,
    "rejectionCode" TEXT,
    "uploadedByUserId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "storedAt" TIMESTAMPTZ(6),
    "attachedAt" TIMESTAMPTZ(6),
    "abandonedAt" TIMESTAMPTZ(6),
    "deletedAt" TIMESTAMPTZ(6),
    CONSTRAINT "DocumentStoredObject_pkey" PRIMARY KEY ("id"),
    -- The key is the row's own random id under its organization: never client-derived.
    CONSTRAINT "DocumentStoredObject_key_check" CHECK ("storageKey" = 'documents/' || "organizationId"::text || '/' || "id"::text),
    CONSTRAINT "DocumentStoredObject_backend_check" CHECK ("backend" IN ('local', 's3')),
    CONSTRAINT "DocumentStoredObject_file_check" CHECK (
      btrim("fileName") <> '' AND length("fileName") <= 255
      AND ("detectedMimeType" IS NULL OR "detectedMimeType" IN ('application/pdf', 'image/png', 'image/jpeg'))
      AND ("sizeBytes" IS NULL OR "sizeBytes" BETWEEN 1 AND 26214400)
      AND ("sha256" IS NULL OR "sha256" ~ '^[0-9a-f]{64}$')
      AND ("rejectionCode" IS NULL OR "rejectionCode" ~ '^[A-Z][A-Z0-9_]{0,63}$')
    ),
    CONSTRAINT "DocumentStoredObject_target_check" CHECK (
      ("purpose" IN ('EMPLOYEE_DOCUMENT', 'SELF_SERVICE') AND "employeeId" IS NOT NULL AND "policyId" IS NULL)
      OR ("purpose" = 'POLICY_VERSION' AND "policyId" IS NOT NULL AND "employeeId" IS NULL AND "documentId" IS NULL)
    ),
    CONSTRAINT "DocumentStoredObject_state_check" CHECK (
      ("status" NOT IN ('STORED', 'ATTACHED') OR ("sha256" IS NOT NULL AND "sizeBytes" IS NOT NULL AND "detectedMimeType" IS NOT NULL AND "storedAt" IS NOT NULL))
      AND (("status" = 'ATTACHED') = ("attachedAt" IS NOT NULL))
      AND ("status" <> 'ABANDONED' OR "abandonedAt" IS NOT NULL)
      AND ("status" <> 'DELETED' OR "deletedAt" IS NOT NULL)
      AND ("status" <> 'REJECTED' OR "rejectionCode" IS NOT NULL)
    )
);

CREATE UNIQUE INDEX "DocumentStoredObject_storageKey_key" ON "DocumentStoredObject"("storageKey");
CREATE INDEX "DocumentStoredObject_status_createdAt_idx" ON "DocumentStoredObject"("status", "createdAt");
CREATE INDEX "DocumentStoredObject_organizationId_status_idx" ON "DocumentStoredObject"("organizationId", "status");
ALTER TABLE "DocumentStoredObject" ADD CONSTRAINT "DocumentStoredObject_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "EmployeeDocumentVersion" ADD COLUMN "storedObjectId" UUID;
ALTER TABLE "PolicyDocumentVersion" ADD COLUMN "sizeBytes" INTEGER, ADD COLUMN "storedObjectId" UUID;
ALTER TABLE "PolicyDocumentVersion" ADD CONSTRAINT "PolicyDocumentVersion_size_check" CHECK ("sizeBytes" IS NULL OR "sizeBytes" >= 0);
CREATE UNIQUE INDEX "EmployeeDocumentVersion_storedObjectId_key" ON "EmployeeDocumentVersion"("storedObjectId");
CREATE UNIQUE INDEX "PolicyDocumentVersion_storedObjectId_key" ON "PolicyDocumentVersion"("storedObjectId");
ALTER TABLE "EmployeeDocumentVersion" ADD CONSTRAINT "EmployeeDocumentVersion_storedObjectId_fkey" FOREIGN KEY ("storedObjectId") REFERENCES "DocumentStoredObject"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PolicyDocumentVersion" ADD CONSTRAINT "PolicyDocumentVersion_storedObjectId_fkey" FOREIGN KEY ("storedObjectId") REFERENCES "DocumentStoredObject"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The object lifecycle is one-way; identity, key and verified metadata never change.
CREATE FUNCTION guard_document_stored_object() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Stored-object records are kept, never deleted.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'UPLOADING' THEN
      RAISE EXCEPTION 'A stored object starts uploading.' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."organizationId" <> OLD."organizationId" OR NEW."purpose" <> OLD."purpose"
     OR NEW."employeeId" IS DISTINCT FROM OLD."employeeId" OR NEW."documentId" IS DISTINCT FROM OLD."documentId"
     OR NEW."policyId" IS DISTINCT FROM OLD."policyId" OR NEW."backend" <> OLD."backend"
     OR NEW."storageKey" <> OLD."storageKey" OR NEW."fileName" <> OLD."fileName"
     OR NEW."uploadedByUserId" <> OLD."uploadedByUserId" OR NEW."createdAt" <> OLD."createdAt"
     OR (OLD."sha256" IS NOT NULL AND NEW."sha256" IS DISTINCT FROM OLD."sha256")
     OR (OLD."sizeBytes" IS NOT NULL AND NEW."sizeBytes" IS DISTINCT FROM OLD."sizeBytes")
     OR (OLD."detectedMimeType" IS NOT NULL AND NEW."detectedMimeType" IS DISTINCT FROM OLD."detectedMimeType")
     OR (OLD."storedAt" IS NOT NULL AND NEW."storedAt" IS DISTINCT FROM OLD."storedAt")
     OR (OLD."attachedAt" IS NOT NULL AND NEW."attachedAt" IS DISTINCT FROM OLD."attachedAt") THEN
    RAISE EXCEPTION 'A stored object''s identity, key and verified content never change.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."status" <> OLD."status" AND NOT (
    (OLD."status" = 'UPLOADING' AND NEW."status" IN ('STORED', 'ABANDONED', 'REJECTED'))
    OR (OLD."status" = 'STORED' AND NEW."status" IN ('ATTACHED', 'ABANDONED'))
    OR (OLD."status" IN ('ABANDONED', 'REJECTED') AND NEW."status" = 'DELETED')
  ) THEN
    RAISE EXCEPTION 'Invalid stored-object status change from % to %.', OLD."status", NEW."status" USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" = 'ABANDONED' AND OLD."status" <> 'ABANDONED' AND (
    EXISTS (SELECT 1 FROM "EmployeeDocumentVersion" WHERE "storedObjectId" = NEW."id")
    OR EXISTS (SELECT 1 FROM "PolicyDocumentVersion" WHERE "storedObjectId" = NEW."id")
  ) THEN
    RAISE EXCEPTION 'A referenced object is never abandoned.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."scanStatus" <> OLD."scanStatus" AND NOT (
    OLD."status" = 'UPLOADING'
    OR (OLD."scanStatus" = 'PENDING' AND NEW."scanStatus" IN ('CLEAN', 'INFECTED', 'FAILED'))
  ) THEN
    RAISE EXCEPTION 'A scan result is recorded once.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "DocumentStoredObject_guard" BEFORE INSERT OR UPDATE OR DELETE ON "DocumentStoredObject"
  FOR EACH ROW EXECUTE FUNCTION guard_document_stored_object();

-- A version's stored object: attached, of the document's own organization and purpose, with its
-- key; internal storage is never a free-text key (F2); the reference never changes.
CREATE FUNCTION guard_document_version_object() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  object_row "DocumentStoredObject"%ROWTYPE;
  version_organization uuid;
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
  IF TG_TABLE_NAME = 'EmployeeDocumentVersion' THEN
    SELECT "organizationId" INTO version_organization FROM "EmployeeDocument" WHERE "id" = NEW."documentId";
  ELSE
    version_organization := NEW."organizationId";
  END IF;
  IF NEW."provider" <> 'INTERNAL_OBJECT_STORAGE' OR object_row."status" <> 'ATTACHED'
     OR object_row."organizationId" <> version_organization
     OR object_row."storageKey" <> NEW."storageKey"
     OR (TG_TABLE_NAME = 'EmployeeDocumentVersion' AND object_row."purpose" NOT IN ('EMPLOYEE_DOCUMENT', 'SELF_SERVICE'))
     OR (TG_TABLE_NAME = 'PolicyDocumentVersion' AND object_row."purpose" <> 'POLICY_VERSION') THEN
    RAISE EXCEPTION 'The stored object is not attached to this organization''s version.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "EmployeeDocumentVersion_object_guard" BEFORE INSERT OR UPDATE ON "EmployeeDocumentVersion"
  FOR EACH ROW EXECUTE FUNCTION guard_document_version_object();
CREATE TRIGGER "PolicyDocumentVersion_object_guard" BEFORE INSERT OR UPDATE ON "PolicyDocumentVersion"
  FOR EACH ROW EXECUTE FUNCTION guard_document_version_object();
