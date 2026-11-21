-- CreateEnum
CREATE TYPE "DocumentCategory" AS ENUM ('EMPLOYMENT_AGREEMENT', 'OFFER_LETTER', 'RESUME', 'CERTIFICATION', 'LICENSE', 'BACKGROUND_CHECK', 'HANDBOOK', 'POLICY', 'EVALUATION', 'PAYROLL', 'TAX', 'IDENTIFICATION', 'TRAINING_CERTIFICATE', 'OTHER');

-- CreateEnum
CREATE TYPE "DocumentConfidentiality" AS ENUM ('EMPLOYEE_VISIBLE', 'MANAGER_VISIBLE', 'HR_ONLY', 'RESTRICTED');

-- CreateEnum
CREATE TYPE "DocumentStorageProvider" AS ENUM ('GOOGLE_DRIVE', 'EXTERNAL_URL', 'INTERNAL_OBJECT_STORAGE', 'MANUAL_REFERENCE');

-- CreateEnum
CREATE TYPE "EmployeeDocumentStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "EmployeeDocumentSource" AS ENUM ('HR', 'EMPLOYEE', 'RECRUITMENT_HANDOFF', 'ONBOARDING');

-- CreateEnum
CREATE TYPE "DocumentReferenceStatus" AS ENUM ('UNKNOWN', 'OK', 'MISSING', 'ACCESS_DENIED');

-- CreateEnum
CREATE TYPE "PolicyDocumentStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'RETIRED');

-- CreateEnum
CREATE TYPE "DocumentAcknowledgementSource" AS ENUM ('SELF_SERVICE', 'ONBOARDING_TASK');

-- AlterTable
ALTER TABLE "EmployeeWorkflowTask" ADD COLUMN     "documentAcknowledgementId" UUID;

-- CreateTable
CREATE TABLE "DocumentType" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category" "DocumentCategory" NOT NULL,
    "defaultConfidentiality" "DocumentConfidentiality" NOT NULL DEFAULT 'HR_ONLY',
    "expiryTracked" BOOLEAN NOT NULL DEFAULT false,
    "employeeProvided" BOOLEAN NOT NULL DEFAULT false,
    "createdByUserId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "archivedAt" TIMESTAMPTZ(6),

    CONSTRAINT "DocumentType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmployeeDocument" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "employmentAssignmentId" UUID,
    "typeId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "confidentiality" "DocumentConfidentiality" NOT NULL,
    "status" "EmployeeDocumentStatus" NOT NULL DEFAULT 'ACTIVE',
    "source" "EmployeeDocumentSource" NOT NULL,
    "recruitmentDocumentId" UUID,
    "recruitmentHireId" UUID,
    "workflowTaskId" UUID,
    "createdByUserId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "archivedAt" TIMESTAMPTZ(6),
    "archivedByUserId" UUID,
    "archiveReason" TEXT,

    CONSTRAINT "EmployeeDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmployeeDocumentVersion" (
    "id" UUID NOT NULL,
    "documentId" UUID NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "provider" "DocumentStorageProvider" NOT NULL,
    "externalUrl" TEXT,
    "storageKey" TEXT,
    "externalFileId" TEXT,
    "fileName" TEXT,
    "mimeType" TEXT,
    "sizeBytes" INTEGER,
    "issuedOn" DATE,
    "effectiveOn" DATE,
    "expiresOn" DATE,
    "note" TEXT,
    "referenceStatus" "DocumentReferenceStatus" NOT NULL DEFAULT 'UNKNOWN',
    "referenceCheckedAt" TIMESTAMPTZ(6),
    "createdByUserId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "supersededAt" TIMESTAMPTZ(6),

    CONSTRAINT "EmployeeDocumentVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PolicyDocument" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "typeId" UUID,
    "code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" "PolicyDocumentStatus" NOT NULL DEFAULT 'DRAFT',
    "acknowledgementRequired" BOOLEAN NOT NULL DEFAULT true,
    "audienceEmploymentType" "EmploymentType",
    "audienceDepartmentId" UUID,
    "createdByUserId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "retiredAt" TIMESTAMPTZ(6),

    CONSTRAINT "PolicyDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PolicyDocumentVersion" (
    "id" UUID NOT NULL,
    "policyId" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "versionLabel" TEXT NOT NULL,
    "provider" "DocumentStorageProvider" NOT NULL,
    "externalUrl" TEXT,
    "storageKey" TEXT,
    "externalFileId" TEXT,
    "fileName" TEXT,
    "mimeType" TEXT,
    "acknowledgementStatement" TEXT,
    "effectiveOn" DATE,
    "publishedAt" TIMESTAMPTZ(6),
    "publishedByUserId" UUID,
    "supersededAt" TIMESTAMPTZ(6),
    "referenceStatus" "DocumentReferenceStatus" NOT NULL DEFAULT 'UNKNOWN',
    "referenceCheckedAt" TIMESTAMPTZ(6),
    "createdByUserId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PolicyDocumentVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentAcknowledgement" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "policyVersionId" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "acknowledgedByUserId" UUID NOT NULL,
    "statement" TEXT NOT NULL,
    "source" "DocumentAcknowledgementSource" NOT NULL,
    "acknowledgedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentAcknowledgement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentRequirement" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "typeId" UUID NOT NULL,
    "employmentType" "EmploymentType",
    "departmentId" UUID,
    "positionId" UUID,
    "note" TEXT,
    "createdByUserId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archivedAt" TIMESTAMPTZ(6),

    CONSTRAINT "DocumentRequirement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DocumentType_organizationId_code_key" ON "DocumentType"("organizationId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentType_id_organizationId_key" ON "DocumentType"("id", "organizationId");

-- CreateIndex
CREATE INDEX "EmployeeDocument_employeeId_status_idx" ON "EmployeeDocument"("employeeId", "status");

-- CreateIndex
CREATE INDEX "EmployeeDocument_organizationId_typeId_status_idx" ON "EmployeeDocument"("organizationId", "typeId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "EmployeeDocument_id_organizationId_key" ON "EmployeeDocument"("id", "organizationId");

-- CreateIndex
CREATE INDEX "EmployeeDocumentVersion_expiresOn_idx" ON "EmployeeDocumentVersion"("expiresOn");

-- CreateIndex
CREATE UNIQUE INDEX "EmployeeDocumentVersion_documentId_versionNumber_key" ON "EmployeeDocumentVersion"("documentId", "versionNumber");

-- CreateIndex
CREATE UNIQUE INDEX "PolicyDocument_organizationId_code_key" ON "PolicyDocument"("organizationId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "PolicyDocument_id_organizationId_key" ON "PolicyDocument"("id", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "PolicyDocumentVersion_policyId_versionNumber_key" ON "PolicyDocumentVersion"("policyId", "versionNumber");

-- CreateIndex
CREATE UNIQUE INDEX "PolicyDocumentVersion_id_organizationId_key" ON "PolicyDocumentVersion"("id", "organizationId");

-- CreateIndex
CREATE INDEX "DocumentAcknowledgement_employeeId_idx" ON "DocumentAcknowledgement"("employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentAcknowledgement_policyVersionId_employeeId_key" ON "DocumentAcknowledgement"("policyVersionId", "employeeId");

-- CreateIndex
CREATE INDEX "DocumentRequirement_organizationId_archivedAt_idx" ON "DocumentRequirement"("organizationId", "archivedAt");

-- AddForeignKey
ALTER TABLE "EmployeeWorkflowTask" ADD CONSTRAINT "EmployeeWorkflowTask_documentAcknowledgementId_fkey" FOREIGN KEY ("documentAcknowledgementId") REFERENCES "DocumentAcknowledgement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentType" ADD CONSTRAINT "DocumentType_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeDocument" ADD CONSTRAINT "EmployeeDocument_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeDocument" ADD CONSTRAINT "EmployeeDocument_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeDocument" ADD CONSTRAINT "EmployeeDocument_employmentAssignmentId_employeeId_fkey" FOREIGN KEY ("employmentAssignmentId", "employeeId") REFERENCES "EmploymentAssignment"("id", "employeeId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeDocument" ADD CONSTRAINT "EmployeeDocument_typeId_organizationId_fkey" FOREIGN KEY ("typeId", "organizationId") REFERENCES "DocumentType"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeDocument" ADD CONSTRAINT "EmployeeDocument_recruitmentDocumentId_fkey" FOREIGN KEY ("recruitmentDocumentId") REFERENCES "RecruitmentCandidateDocument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeDocument" ADD CONSTRAINT "EmployeeDocument_recruitmentHireId_fkey" FOREIGN KEY ("recruitmentHireId") REFERENCES "RecruitmentHire"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeDocumentVersion" ADD CONSTRAINT "EmployeeDocumentVersion_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "EmployeeDocument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PolicyDocument" ADD CONSTRAINT "PolicyDocument_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PolicyDocument" ADD CONSTRAINT "PolicyDocument_typeId_organizationId_fkey" FOREIGN KEY ("typeId", "organizationId") REFERENCES "DocumentType"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PolicyDocument" ADD CONSTRAINT "PolicyDocument_audienceDepartmentId_organizationId_fkey" FOREIGN KEY ("audienceDepartmentId", "organizationId") REFERENCES "Department"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PolicyDocumentVersion" ADD CONSTRAINT "PolicyDocumentVersion_policyId_organizationId_fkey" FOREIGN KEY ("policyId", "organizationId") REFERENCES "PolicyDocument"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentAcknowledgement" ADD CONSTRAINT "DocumentAcknowledgement_policyVersionId_organizationId_fkey" FOREIGN KEY ("policyVersionId", "organizationId") REFERENCES "PolicyDocumentVersion"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentAcknowledgement" ADD CONSTRAINT "DocumentAcknowledgement_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentRequirement" ADD CONSTRAINT "DocumentRequirement_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentRequirement" ADD CONSTRAINT "DocumentRequirement_typeId_organizationId_fkey" FOREIGN KEY ("typeId", "organizationId") REFERENCES "DocumentType"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentRequirement" ADD CONSTRAINT "DocumentRequirement_departmentId_organizationId_fkey" FOREIGN KEY ("departmentId", "organizationId") REFERENCES "Department"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentRequirement" ADD CONSTRAINT "DocumentRequirement_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "Position"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ─── Integrity ───────────────────────────────────────────────────────────────
-- Lock order of document writes: EmployeeDocument / PolicyDocument (FOR NO KEY UPDATE) →
-- their versions → acknowledgements. Core HR rows are only read.

ALTER TABLE "DocumentType"
  ADD CONSTRAINT "DocumentType_code_check" CHECK ("code" ~ '^[A-Z0-9_-]{2,64}$'),
  ADD CONSTRAINT "DocumentType_name_check" CHECK (btrim("name") <> '');

ALTER TABLE "EmployeeDocument"
  ADD CONSTRAINT "EmployeeDocument_title_check" CHECK (btrim("title") <> ''),
  ADD CONSTRAINT "EmployeeDocument_archive_check" CHECK (
    ("status" = 'ARCHIVED') = ("archivedAt" IS NOT NULL AND "archiveReason" IS NOT NULL)
    AND ("archiveReason" IS NULL OR btrim("archiveReason") <> '')
  ),
  ADD CONSTRAINT "EmployeeDocument_provenance_check" CHECK (
    ("source" = 'RECRUITMENT_HANDOFF') = ("recruitmentHireId" IS NOT NULL)
    AND ("recruitmentDocumentId" IS NULL OR "recruitmentHireId" IS NOT NULL)
  );
-- A candidate document is handed off to an employee once.
CREATE UNIQUE INDEX "EmployeeDocument_handoff_key"
  ON "EmployeeDocument"("employeeId", "recruitmentDocumentId") WHERE "recruitmentDocumentId" IS NOT NULL;

ALTER TABLE "EmployeeDocumentVersion"
  ADD CONSTRAINT "EmployeeDocumentVersion_number_check" CHECK ("versionNumber" >= 1),
  ADD CONSTRAINT "EmployeeDocumentVersion_dates_check" CHECK ("expiresOn" IS NULL OR "issuedOn" IS NULL OR "expiresOn" >= "issuedOn"),
  ADD CONSTRAINT "EmployeeDocumentVersion_size_check" CHECK ("sizeBytes" IS NULL OR "sizeBytes" >= 0),
  ADD CONSTRAINT "EmployeeDocumentVersion_reference_check" CHECK (
    ("externalUrl" IS NULL OR "externalUrl" ~* '^https://\S+$')
    AND ("provider" <> 'EXTERNAL_URL' OR "externalUrl" IS NOT NULL)
    AND ("provider" <> 'GOOGLE_DRIVE' OR "externalUrl" IS NOT NULL OR "externalFileId" IS NOT NULL)
    AND (("provider" = 'INTERNAL_OBJECT_STORAGE') = ("storageKey" IS NOT NULL))
  );
-- One current version per document.
CREATE UNIQUE INDEX "EmployeeDocumentVersion_current_key"
  ON "EmployeeDocumentVersion"("documentId") WHERE "supersededAt" IS NULL;

ALTER TABLE "PolicyDocument"
  ADD CONSTRAINT "PolicyDocument_code_check" CHECK ("code" ~ '^[A-Z0-9_-]{2,64}$'),
  ADD CONSTRAINT "PolicyDocument_title_check" CHECK (btrim("title") <> ''),
  ADD CONSTRAINT "PolicyDocument_status_check" CHECK (("status" = 'RETIRED') = ("retiredAt" IS NOT NULL));

ALTER TABLE "PolicyDocumentVersion"
  ADD CONSTRAINT "PolicyDocumentVersion_label_check" CHECK (btrim("versionLabel") <> '' AND "versionNumber" >= 1),
  ADD CONSTRAINT "PolicyDocumentVersion_statement_check" CHECK ("acknowledgementStatement" IS NULL OR btrim("acknowledgementStatement") <> ''),
  ADD CONSTRAINT "PolicyDocumentVersion_publish_check" CHECK (
    ("supersededAt" IS NULL OR "publishedAt" IS NOT NULL)
    AND (("publishedAt" IS NULL) = ("publishedByUserId" IS NULL))
  ),
  ADD CONSTRAINT "PolicyDocumentVersion_reference_check" CHECK (
    ("externalUrl" IS NULL OR "externalUrl" ~* '^https://\S+$')
    AND ("provider" <> 'EXTERNAL_URL' OR "externalUrl" IS NOT NULL)
    AND ("provider" <> 'GOOGLE_DRIVE' OR "externalUrl" IS NOT NULL OR "externalFileId" IS NOT NULL)
    AND (("provider" = 'INTERNAL_OBJECT_STORAGE') = ("storageKey" IS NOT NULL))
  );
-- One current published version per policy.
CREATE UNIQUE INDEX "PolicyDocumentVersion_current_key"
  ON "PolicyDocumentVersion"("policyId") WHERE "publishedAt" IS NOT NULL AND "supersededAt" IS NULL;
-- At most one unpublished draft per policy.
CREATE UNIQUE INDEX "PolicyDocumentVersion_draft_key"
  ON "PolicyDocumentVersion"("policyId") WHERE "publishedAt" IS NULL;

ALTER TABLE "DocumentAcknowledgement"
  ADD CONSTRAINT "DocumentAcknowledgement_statement_check" CHECK (btrim("statement") <> '');

CREATE FUNCTION prevent_document_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is immutable.', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END $$;

CREATE FUNCTION document_employee_in_organization(employee_id uuid, organization_id uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM "EmploymentAssignment" a JOIN "Position" p ON p."id" = a."positionId"
    WHERE a."employeeId" = employee_id AND p."organizationId" = organization_id AND a."status" <> 'CANCELLED'
  )
$$;

CREATE FUNCTION guard_document_type() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Document types are archived, never deleted.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."organizationId" <> OLD."organizationId" OR NEW."code" <> OLD."code" OR NEW."category" <> OLD."category" THEN
    RAISE EXCEPTION 'A document type''s organization, code and category never change.' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "DocumentType_guard" BEFORE UPDATE OR DELETE ON "DocumentType"
  FOR EACH ROW EXECUTE FUNCTION guard_document_type();

CREATE FUNCTION guard_employee_document() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Employee documents are archived, never deleted.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'ACTIVE' THEN
      RAISE EXCEPTION 'A document starts active.' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT document_employee_in_organization(NEW."employeeId", NEW."organizationId") THEN
      RAISE EXCEPTION 'The employee has no assignment in the document''s organization.' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."employmentAssignmentId" IS NOT NULL AND (
      SELECT p."organizationId" FROM "EmploymentAssignment" a JOIN "Position" p ON p."id" = a."positionId"
      WHERE a."id" = NEW."employmentAssignmentId"
    ) <> NEW."organizationId" THEN
      RAISE EXCEPTION 'The assignment belongs to another organization.' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."recruitmentHireId" IS NOT NULL AND (
      SELECT "employeeId" FROM "RecruitmentHire" WHERE "id" = NEW."recruitmentHireId"
    ) <> NEW."employeeId" THEN
      RAISE EXCEPTION 'The hire belongs to another employee.' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."organizationId" <> OLD."organizationId" OR NEW."employeeId" <> OLD."employeeId"
     OR NEW."employmentAssignmentId" IS DISTINCT FROM OLD."employmentAssignmentId"
     OR NEW."typeId" <> OLD."typeId" OR NEW."source" <> OLD."source"
     OR NEW."recruitmentDocumentId" IS DISTINCT FROM OLD."recruitmentDocumentId"
     OR NEW."recruitmentHireId" IS DISTINCT FROM OLD."recruitmentHireId"
     OR NEW."workflowTaskId" IS DISTINCT FROM OLD."workflowTaskId"
     OR NEW."createdAt" <> OLD."createdAt" THEN
    RAISE EXCEPTION 'A document''s employee, type and provenance never change.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."status" = 'ARCHIVED' THEN
    RAISE EXCEPTION 'An archived document is frozen.' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "EmployeeDocument_guard" BEFORE INSERT OR UPDATE OR DELETE ON "EmployeeDocument"
  FOR EACH ROW EXECUTE FUNCTION guard_employee_document();

CREATE FUNCTION guard_employee_document_version() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  document_status "EmployeeDocumentStatus";
  last_number integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Document versions are superseded, never deleted.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT "status" INTO document_status FROM "EmployeeDocument" WHERE "id" = NEW."documentId";
    IF document_status <> 'ACTIVE' THEN
      RAISE EXCEPTION 'Versions are added to active documents only.' USING ERRCODE = 'check_violation';
    END IF;
    SELECT max("versionNumber") INTO last_number FROM "EmployeeDocumentVersion" WHERE "documentId" = NEW."documentId";
    IF NEW."versionNumber" <> COALESCE(last_number, 0) + 1 THEN
      RAISE EXCEPTION 'Versions are numbered in sequence.' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."supersededAt" IS NOT NULL THEN
      RAISE EXCEPTION 'A new version is current.' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."documentId" <> OLD."documentId" OR NEW."versionNumber" <> OLD."versionNumber"
     OR NEW."provider" <> OLD."provider" OR NEW."externalUrl" IS DISTINCT FROM OLD."externalUrl"
     OR NEW."storageKey" IS DISTINCT FROM OLD."storageKey" OR NEW."externalFileId" IS DISTINCT FROM OLD."externalFileId"
     OR NEW."fileName" IS DISTINCT FROM OLD."fileName" OR NEW."mimeType" IS DISTINCT FROM OLD."mimeType"
     OR NEW."sizeBytes" IS DISTINCT FROM OLD."sizeBytes"
     OR NEW."issuedOn" IS DISTINCT FROM OLD."issuedOn" OR NEW."effectiveOn" IS DISTINCT FROM OLD."effectiveOn"
     OR NEW."expiresOn" IS DISTINCT FROM OLD."expiresOn" OR NEW."note" IS DISTINCT FROM OLD."note"
     OR NEW."createdAt" <> OLD."createdAt" OR NEW."createdByUserId" IS DISTINCT FROM OLD."createdByUserId"
     OR (OLD."supersededAt" IS NOT NULL AND NEW."supersededAt" IS DISTINCT FROM OLD."supersededAt") THEN
    RAISE EXCEPTION 'A document version is immutable; add a new version.' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "EmployeeDocumentVersion_guard" BEFORE INSERT OR UPDATE OR DELETE ON "EmployeeDocumentVersion"
  FOR EACH ROW EXECUTE FUNCTION guard_employee_document_version();

CREATE FUNCTION guard_policy_document() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Policy documents are retired, never deleted.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."organizationId" <> OLD."organizationId" OR NEW."code" <> OLD."code" THEN
    RAISE EXCEPTION 'A policy''s organization and code never change.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."status" <> OLD."status" AND NOT (
    (OLD."status" = 'DRAFT' AND NEW."status" IN ('PUBLISHED', 'RETIRED'))
    OR (OLD."status" = 'PUBLISHED' AND NEW."status" = 'RETIRED')
  ) THEN
    RAISE EXCEPTION 'Invalid policy status change from % to %.', OLD."status", NEW."status" USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."status" = 'RETIRED' THEN
    RAISE EXCEPTION 'A retired policy is frozen.' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "PolicyDocument_guard" BEFORE UPDATE OR DELETE ON "PolicyDocument"
  FOR EACH ROW EXECUTE FUNCTION guard_policy_document();

CREATE FUNCTION guard_policy_document_version() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  last_number integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."publishedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'Published policy versions are superseded, never deleted.' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF (SELECT "status" FROM "PolicyDocument" WHERE "id" = NEW."policyId") = 'RETIRED' THEN
      RAISE EXCEPTION 'A retired policy takes no new versions.' USING ERRCODE = 'check_violation';
    END IF;
    SELECT max("versionNumber") INTO last_number FROM "PolicyDocumentVersion" WHERE "policyId" = NEW."policyId";
    IF NEW."versionNumber" <> COALESCE(last_number, 0) + 1 OR NEW."publishedAt" IS NOT NULL OR NEW."supersededAt" IS NOT NULL THEN
      RAISE EXCEPTION 'A policy version is a new, unpublished, next-numbered draft.' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."policyId" <> OLD."policyId" OR NEW."organizationId" <> OLD."organizationId"
     OR NEW."versionNumber" <> OLD."versionNumber" OR NEW."createdAt" <> OLD."createdAt"
     OR (OLD."publishedAt" IS NOT NULL AND NEW."publishedAt" IS DISTINCT FROM OLD."publishedAt")
     OR (OLD."supersededAt" IS NOT NULL AND NEW."supersededAt" IS DISTINCT FROM OLD."supersededAt") THEN
    RAISE EXCEPTION 'A policy version is published and superseded once and never moves.' USING ERRCODE = 'restrict_violation';
  END IF;
  -- A published version's content is fixed (what employees acknowledged).
  IF OLD."publishedAt" IS NOT NULL AND (
    NEW."versionLabel" <> OLD."versionLabel" OR NEW."provider" <> OLD."provider"
    OR NEW."externalUrl" IS DISTINCT FROM OLD."externalUrl" OR NEW."storageKey" IS DISTINCT FROM OLD."storageKey"
    OR NEW."externalFileId" IS DISTINCT FROM OLD."externalFileId" OR NEW."fileName" IS DISTINCT FROM OLD."fileName"
    OR NEW."mimeType" IS DISTINCT FROM OLD."mimeType"
    OR NEW."acknowledgementStatement" IS DISTINCT FROM OLD."acknowledgementStatement"
    OR NEW."effectiveOn" IS DISTINCT FROM OLD."effectiveOn"
  ) THEN
    RAISE EXCEPTION 'A published policy version is immutable; publish a new version.' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "PolicyDocumentVersion_guard" BEFORE INSERT OR UPDATE OR DELETE ON "PolicyDocumentVersion"
  FOR EACH ROW EXECUTE FUNCTION guard_policy_document_version();

CREATE FUNCTION guard_document_acknowledgement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Acknowledgements are immutable.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF (SELECT "publishedAt" FROM "PolicyDocumentVersion" WHERE "id" = NEW."policyVersionId") IS NULL THEN
    RAISE EXCEPTION 'Only a published version is acknowledged.' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT document_employee_in_organization(NEW."employeeId", NEW."organizationId") THEN
    RAISE EXCEPTION 'The employee has no assignment in the policy''s organization.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "DocumentAcknowledgement_guard" BEFORE INSERT OR UPDATE OR DELETE ON "DocumentAcknowledgement"
  FOR EACH ROW EXECUTE FUNCTION guard_document_acknowledgement();

CREATE FUNCTION guard_document_requirement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Requirements are archived, never deleted.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."positionId" IS NOT NULL
     AND (SELECT "organizationId" FROM "Position" WHERE "id" = NEW."positionId") <> NEW."organizationId" THEN
    RAISE EXCEPTION 'The position belongs to another organization.' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND (
    NEW."organizationId" <> OLD."organizationId" OR NEW."typeId" <> OLD."typeId"
    OR NEW."employmentType" IS DISTINCT FROM OLD."employmentType"
    OR NEW."departmentId" IS DISTINCT FROM OLD."departmentId" OR NEW."positionId" IS DISTINCT FROM OLD."positionId"
    OR OLD."archivedAt" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'A requirement never changes; archive it and add another.' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "DocumentRequirement_guard" BEFORE INSERT OR UPDATE OR DELETE ON "DocumentRequirement"
  FOR EACH ROW EXECUTE FUNCTION guard_document_requirement();

-- Phase 14 tasks: the document acknowledgement linked to a finished task is locked with it.
CREATE FUNCTION guard_workflow_task_document_acknowledgement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" IN ('COMPLETED', 'WAIVED') AND NEW."status" = OLD."status"
     AND NEW."documentAcknowledgementId" IS DISTINCT FROM OLD."documentAcknowledgementId" THEN
    RAISE EXCEPTION 'A finished task is locked; reopen it explicitly.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."documentAcknowledgementId" IS NOT NULL AND (
    NEW."documentAcknowledgementId" IS DISTINCT FROM OLD."documentAcknowledgementId"
  ) AND (
    SELECT a."employeeId" FROM "DocumentAcknowledgement" a WHERE a."id" = NEW."documentAcknowledgementId"
  ) <> (SELECT w."employeeId" FROM "EmployeeWorkflow" w WHERE w."id" = NEW."workflowId") THEN
    RAISE EXCEPTION 'The acknowledgement belongs to another employee.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "EmployeeWorkflowTask_document_acknowledgement_guard" BEFORE UPDATE ON "EmployeeWorkflowTask"
  FOR EACH ROW EXECUTE FUNCTION guard_workflow_task_document_acknowledgement();
