-- CreateEnum
CREATE TYPE "CompensationPayBasis" AS ENUM ('HOURLY', 'SALARY');

-- CreateEnum
CREATE TYPE "CompensationRecordType" AS ENUM ('INITIAL', 'CHANGE', 'CORRECTION');

-- CreateTable
CREATE TABLE "PayGroup" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "archivedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "PayGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompensationRecord" (
    "id" UUID NOT NULL,
    "employmentAssignmentId" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "recordType" "CompensationRecordType" NOT NULL,
    "payBasis" "CompensationPayBasis" NOT NULL,
    "rateAmount" DECIMAL(19,4) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "effectiveTo" DATE,
    "payGroupId" UUID,
    "supersedesRecordId" UUID,
    "reason" TEXT,
    "supersededAt" TIMESTAMPTZ(6),
    "createdByUserId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "CompensationRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PayGroup_organizationId_archivedAt_idx" ON "PayGroup"("organizationId", "archivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "PayGroup_organizationId_code_key" ON "PayGroup"("organizationId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "PayGroup_id_organizationId_key" ON "PayGroup"("id", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "CompensationRecord_supersedesRecordId_key" ON "CompensationRecord"("supersedesRecordId");

-- CreateIndex
CREATE INDEX "CompensationRecord_employmentAssignmentId_effectiveFrom_idx" ON "CompensationRecord"("employmentAssignmentId", "effectiveFrom");

-- CreateIndex
CREATE INDEX "CompensationRecord_organizationId_payGroupId_idx" ON "CompensationRecord"("organizationId", "payGroupId");

-- AddForeignKey
ALTER TABLE "PayGroup" ADD CONSTRAINT "PayGroup_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompensationRecord" ADD CONSTRAINT "CompensationRecord_employmentAssignmentId_fkey" FOREIGN KEY ("employmentAssignmentId") REFERENCES "EmploymentAssignment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompensationRecord" ADD CONSTRAINT "CompensationRecord_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompensationRecord" ADD CONSTRAINT "CompensationRecord_payGroupId_organizationId_fkey" FOREIGN KEY ("payGroupId", "organizationId") REFERENCES "PayGroup"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompensationRecord" ADD CONSTRAINT "CompensationRecord_supersedesRecordId_fkey" FOREIGN KEY ("supersedesRecordId") REFERENCES "CompensationRecord"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompensationRecord" ADD CONSTRAINT "CompensationRecord_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ─── Integrity ───────────────────────────────────────────────────────────────

ALTER TABLE "PayGroup"
  ADD CONSTRAINT "PayGroup_code_check" CHECK ("code" ~ '^[A-Z0-9_-]{2,64}$'),
  ADD CONSTRAINT "PayGroup_name_check" CHECK (btrim("name") <> '');

ALTER TABLE "CompensationRecord"
  ADD CONSTRAINT "CompensationRecord_rate_positive_check" CHECK ("rateAmount" > 0),
  ADD CONSTRAINT "CompensationRecord_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "CompensationRecord_period_check" CHECK ("effectiveTo" IS NULL OR "effectiveTo" >= "effectiveFrom"),
  ADD CONSTRAINT "CompensationRecord_reason_check" CHECK ("reason" IS NULL OR btrim("reason") <> ''),
  ADD CONSTRAINT "CompensationRecord_correction_shape_check" CHECK (
    ("recordType" = 'CORRECTION') = ("supersedesRecordId" IS NOT NULL)
    AND ("recordType" <> 'CORRECTION' OR "reason" IS NOT NULL)
  );

-- Compensation history is never deleted or rewritten. The only updates are: closing a period
-- by shortening its effectiveTo (a later change starts), and marking a record superseded once
-- (a correction replaced it). Everything else about a record is fixed at insert.
CREATE FUNCTION "prevent_compensation_record_rewrite"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Compensation history cannot be deleted.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."id" <> OLD."id"
    OR NEW."employmentAssignmentId" <> OLD."employmentAssignmentId"
    OR NEW."organizationId" <> OLD."organizationId"
    OR NEW."recordType" <> OLD."recordType"
    OR NEW."payBasis" <> OLD."payBasis"
    OR NEW."rateAmount" <> OLD."rateAmount"
    OR NEW."currency" <> OLD."currency"
    OR NEW."effectiveFrom" <> OLD."effectiveFrom"
    OR NEW."payGroupId" IS DISTINCT FROM OLD."payGroupId"
    OR NEW."supersedesRecordId" IS DISTINCT FROM OLD."supersedesRecordId"
    OR NEW."reason" IS DISTINCT FROM OLD."reason"
    OR NEW."createdByUserId" IS DISTINCT FROM OLD."createdByUserId"
    OR NEW."createdAt" <> OLD."createdAt" THEN
    RAISE EXCEPTION 'Compensation records are immutable; correct one by superseding it.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."supersededAt" IS NOT NULL
    AND (NEW."supersededAt" IS DISTINCT FROM OLD."supersededAt" OR NEW."effectiveTo" IS DISTINCT FROM OLD."effectiveTo") THEN
    RAISE EXCEPTION 'A superseded compensation record is frozen.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."effectiveTo" IS DISTINCT FROM OLD."effectiveTo"
    AND (NEW."effectiveTo" IS NULL OR (OLD."effectiveTo" IS NOT NULL AND NEW."effectiveTo" >= OLD."effectiveTo")) THEN
    RAISE EXCEPTION 'A compensation period can only be closed earlier, never extended or reopened.' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "CompensationRecord_prevent_rewrite" BEFORE UPDATE OR DELETE ON "CompensationRecord"
  FOR EACH ROW EXECUTE FUNCTION "prevent_compensation_record_rewrite"();

-- The timeline (records not superseded) of one assignment never overlaps and stays inside the
-- assignment, which must not be cancelled. Locks the assignment row first, the same first lock
-- every Phase 6–9 writer takes, so concurrent writers serialize here even outside the service.
CREATE FUNCTION "check_compensation_timeline"() RETURNS trigger AS $$
DECLARE
  assignment RECORD;
BEGIN
  IF NEW."supersededAt" IS NOT NULL THEN
    RETURN NEW;
  END IF;
  SELECT ea."status", ea."startDate", ea."endDate", p."organizationId"
    INTO assignment
    FROM "EmploymentAssignment" ea
    JOIN "Position" p ON p."id" = ea."positionId"
    WHERE ea."id" = NEW."employmentAssignmentId"
    FOR NO KEY UPDATE OF ea;
  IF assignment."status" = 'CANCELLED' THEN
    RAISE EXCEPTION 'A cancelled assignment has no compensation.' USING ERRCODE = 'check_violation';
  END IF;
  IF assignment."organizationId" <> NEW."organizationId" THEN
    RAISE EXCEPTION 'Compensation belongs to its assignment''s organization.' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."effectiveFrom" < assignment."startDate"
    OR (assignment."endDate" IS NOT NULL
      AND (NEW."effectiveFrom" > assignment."endDate" OR NEW."effectiveTo" > assignment."endDate")) THEN
    RAISE EXCEPTION 'Compensation must stay within its assignment''s dates.' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "CompensationRecord" other
    WHERE other."employmentAssignmentId" = NEW."employmentAssignmentId"
      AND other."id" <> NEW."id"
      AND other."supersededAt" IS NULL
      AND other."effectiveFrom" <= COALESCE(NEW."effectiveTo", 'infinity'::date)
      AND NEW."effectiveFrom" <= COALESCE(other."effectiveTo", 'infinity'::date)
  ) THEN
    RAISE EXCEPTION 'Compensation periods of an assignment cannot overlap.' USING ERRCODE = 'exclusion_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "CompensationRecord_timeline" BEFORE INSERT OR UPDATE ON "CompensationRecord"
  FOR EACH ROW EXECUTE FUNCTION "check_compensation_timeline"();

-- An assignment can never be re-dated or cancelled out from under its compensation: such a
-- change is refused (the application reports which records to change first); compensation is
-- never silently modified. Open-ended compensation simply ends with the assignment.
CREATE FUNCTION "guard_assignment_compensation"() RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "CompensationRecord" c
    WHERE c."employmentAssignmentId" = NEW."id"
      AND c."supersededAt" IS NULL
      AND (
        NEW."status" = 'CANCELLED'
        OR c."effectiveFrom" < NEW."startDate"
        OR (NEW."endDate" IS NOT NULL AND (c."effectiveFrom" > NEW."endDate" OR c."effectiveTo" > NEW."endDate"))
      )
  ) THEN
    RAISE EXCEPTION 'The assignment change would leave compensation outside the assignment.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "EmploymentAssignment_compensation_guard" BEFORE UPDATE ON "EmploymentAssignment"
  FOR EACH ROW
  WHEN (OLD."startDate" IS DISTINCT FROM NEW."startDate"
    OR OLD."endDate" IS DISTINCT FROM NEW."endDate"
    OR OLD."status" IS DISTINCT FROM NEW."status")
  EXECUTE FUNCTION "guard_assignment_compensation"();
