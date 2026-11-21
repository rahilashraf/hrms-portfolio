-- Security remediation M2 — payroll separation of duties (maker-checker). Additive only: two
-- nullable columns, two append-only tables, checks and triggers. No existing row changes; no
-- payroll amount, calculation or source-consumption rule changes. The provenance backfill
-- (docs/security/sql/m2-payroll-provenance-backfill.sql) is separate, idempotent and rehearsed.

-- AlterTable
ALTER TABLE "PayrollRun" ADD COLUMN     "calculatedByUserId" UUID;

-- AlterTable
ALTER TABLE "OrganizationSettingChange" ADD COLUMN     "reason" TEXT;

-- CreateTable
CREATE TABLE "CompensationRecordClosure" (
    "id" UUID NOT NULL,
    "compensationRecordId" UUID NOT NULL,
    "employmentAssignmentId" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "previousEffectiveTo" DATE,
    "newEffectiveTo" DATE NOT NULL,
    "closedByUserId" UUID,
    "source" TEXT NOT NULL,
    "auditLogId" UUID,
    "transactionId" BIGINT NOT NULL DEFAULT txid_current(),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CompensationRecordClosure_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollAdjustmentCompensationSource" (
    "adjustmentId" UUID NOT NULL,
    "compensationRecordId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PayrollAdjustmentCompensationSource_pkey" PRIMARY KEY ("adjustmentId","compensationRecordId")
);

-- CreateIndex
CREATE UNIQUE INDEX "CompensationRecordClosure_auditLogId_key" ON "CompensationRecordClosure"("auditLogId");

-- CreateIndex
CREATE INDEX "CompensationRecordClosure_compensationRecordId_idx" ON "CompensationRecordClosure"("compensationRecordId");

-- CreateIndex
CREATE INDEX "CompensationRecordClosure_employmentAssignmentId_idx" ON "CompensationRecordClosure"("employmentAssignmentId");

-- CreateIndex
CREATE INDEX "CompensationRecordClosure_closedByUserId_idx" ON "CompensationRecordClosure"("closedByUserId");

-- CreateIndex
CREATE INDEX "PayrollAdjustmentCompensationSource_compensationRecordId_idx" ON "PayrollAdjustmentCompensationSource"("compensationRecordId");

-- AddForeignKey
ALTER TABLE "CompensationRecordClosure" ADD CONSTRAINT "CompensationRecordClosure_compensationRecordId_fkey" FOREIGN KEY ("compensationRecordId") REFERENCES "CompensationRecord"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompensationRecordClosure" ADD CONSTRAINT "CompensationRecordClosure_closedByUserId_fkey" FOREIGN KEY ("closedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollRun" ADD CONSTRAINT "PayrollRun_calculatedByUserId_fkey" FOREIGN KEY ("calculatedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollAdjustmentCompensationSource" ADD CONSTRAINT "PayrollAdjustmentCompensationSource_adjustmentId_fkey" FOREIGN KEY ("adjustmentId") REFERENCES "PayrollAdjustment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollAdjustmentCompensationSource" ADD CONSTRAINT "PayrollAdjustmentCompensationSource_compensationRecordId_fkey" FOREIGN KEY ("compensationRecordId") REFERENCES "CompensationRecord"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- A cancelled adjustment remembers the live run it was removed from (its canceller changed that
-- run's pay; independent review M1). Set once, with the cancellation (the adjustment rule
-- freezes a cancelled adjustment).
ALTER TABLE "PayrollAdjustment" ADD COLUMN "cancelledFromRunId" UUID;
ALTER TABLE "PayrollAdjustment" ADD CONSTRAINT "PayrollAdjustment_cancelledFromRunId_fkey" FOREIGN KEY ("cancelledFromRunId") REFERENCES "PayrollRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PayrollAdjustment" ADD CONSTRAINT "PayrollAdjustment_cancelled_from_check"
  CHECK ("cancelledFromRunId" IS NULL OR "status" = 'CANCELLED');

-- The adjustment rule (20261020093000) plus: cancelledFromRunId names the run the adjustment was
-- actually carried by when it was cancelled (and nothing else ever sets it).
CREATE OR REPLACE FUNCTION "prevent_payroll_adjustment_rewrite"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Payroll adjustments cannot be deleted; cancel one instead.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."status" <> 'PENDING' THEN
    RAISE EXCEPTION 'A % payroll adjustment cannot change.', lower(OLD."status"::text) USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."organizationId" <> OLD."organizationId" OR NEW."payGroupId" <> OLD."payGroupId"
    OR NEW."employeeId" <> OLD."employeeId" OR NEW."employmentAssignmentId" <> OLD."employmentAssignmentId"
    OR NEW."currency" <> OLD."currency" OR NEW."kind" <> OLD."kind" OR NEW."amount" <> OLD."amount"
    OR NEW."description" <> OLD."description" OR NEW."reason" <> OLD."reason"
    OR NEW."sourceRunId" IS DISTINCT FROM OLD."sourceRunId"
    OR NEW."sourceEarningLineId" IS DISTINCT FROM OLD."sourceEarningLineId"
    OR NEW."sourceFingerprint" IS DISTINCT FROM OLD."sourceFingerprint"
    OR NEW."createdByUserId" <> OLD."createdByUserId" OR NEW."createdAt" <> OLD."createdAt" THEN
    RAISE EXCEPTION 'Payroll adjustment terms are immutable; cancel it and create another.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."cancelledFromRunId" IS NOT NULL
    AND NEW."cancelledFromRunId" IS DISTINCT FROM OLD."payrollRunId" THEN
    RAISE EXCEPTION 'A cancelled adjustment names only the run that carried it.' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ─── Checks ──────────────────────────────────────────────────────────────────────────────

ALTER TABLE "OrganizationSettingChange"
  ADD CONSTRAINT "OrganizationSettingChange_reason_check"
  CHECK ("reason" IS NULL OR char_length(btrim("reason")) BETWEEN 10 AND 500);

ALTER TABLE "CompensationRecordClosure"
  ADD CONSTRAINT "CompensationRecordClosure_source_check"
    CHECK ("source" IN ('APPLICATION', 'LEGACY_AUDIT')),
  ADD CONSTRAINT "CompensationRecordClosure_actor_check"
    CHECK ("source" <> 'APPLICATION' OR "closedByUserId" IS NOT NULL),
  ADD CONSTRAINT "CompensationRecordClosure_legacy_check"
    CHECK (("source" = 'LEGACY_AUDIT') = ("auditLogId" IS NOT NULL)),
  ADD CONSTRAINT "CompensationRecordClosure_shortens_check"
    CHECK ("previousEffectiveTo" IS NULL OR "newEffectiveTo" < "previousEffectiveTo");

-- ─── Closure ledger ──────────────────────────────────────────────────────────────────────

-- A closure copies its record's assignment and organization, and (for one written by the
-- application) must describe the change actually being made: from the record's current end
-- date to an earlier one, never before it starts.
CREATE FUNCTION "compensation_closure_before_insert"() RETURNS trigger AS $$
DECLARE
  record_row "CompensationRecord"%ROWTYPE;
BEGIN
  SELECT * INTO record_row FROM "CompensationRecord" WHERE "id" = NEW."compensationRecordId";
  NEW."employmentAssignmentId" := record_row."employmentAssignmentId";
  NEW."organizationId" := record_row."organizationId";
  IF NEW."source" = 'APPLICATION' THEN
    IF record_row."supersededAt" IS NOT NULL
      OR NEW."previousEffectiveTo" IS DISTINCT FROM record_row."effectiveTo"
      OR NEW."newEffectiveTo" < record_row."effectiveFrom" THEN
      RAISE EXCEPTION 'A compensation closure must shorten the record''s current end date.' USING ERRCODE = 'check_violation';
    END IF;
    NEW."transactionId" := txid_current();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "CompensationRecordClosure_before_insert" BEFORE INSERT ON "CompensationRecordClosure"
  FOR EACH ROW EXECUTE FUNCTION "compensation_closure_before_insert"();

CREATE FUNCTION "prevent_append_only_rewrite"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: rows cannot be changed or deleted.', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "CompensationRecordClosure_append_only" BEFORE UPDATE OR DELETE ON "CompensationRecordClosure"
  FOR EACH ROW EXECUTE FUNCTION "prevent_append_only_rewrite"();

-- The record rule (20270216090000) plus: shortening `effectiveTo` needs a closure naming who did
-- it, written in the same transaction.
CREATE OR REPLACE FUNCTION "prevent_compensation_record_rewrite"() RETURNS trigger AS $$
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
    OR NEW."salaryArrangement" IS DISTINCT FROM OLD."salaryArrangement"
    OR NEW."salaryMonthlyAmount" IS DISTINCT FROM OLD."salaryMonthlyAmount"
    OR NEW."salaryPaidMonths" IS DISTINCT FROM OLD."salaryPaidMonths"
    OR NEW."salaryContractAmount" IS DISTINCT FROM OLD."salaryContractAmount"
    OR NEW."salaryPeriodStart" IS DISTINCT FROM OLD."salaryPeriodStart"
    OR NEW."salaryPeriodEnd" IS DISTINCT FROM OLD."salaryPeriodEnd"
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
  IF NEW."effectiveTo" IS DISTINCT FROM OLD."effectiveTo" AND NOT EXISTS (
    SELECT 1 FROM "CompensationRecordClosure" c
    WHERE c."compensationRecordId" = NEW."id"
      AND c."source" = 'APPLICATION'
      AND c."newEffectiveTo" = NEW."effectiveTo"
      AND c."previousEffectiveTo" IS NOT DISTINCT FROM OLD."effectiveTo"
      AND c."transactionId" = txid_current()
  ) THEN
    RAISE EXCEPTION 'A compensation record is closed only with a closure entry naming who closed it (CompensationRecordClosure).' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ─── Retro adjustment compensation sources ───────────────────────────────────────────────

-- A source belongs to a retro adjustment (one created from a finalized run) of the same
-- assignment.
CREATE FUNCTION "payroll_adjustment_source_before_insert"() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "PayrollAdjustment" a
    JOIN "CompensationRecord" r ON r."id" = NEW."compensationRecordId"
    WHERE a."id" = NEW."adjustmentId"
      AND a."sourceRunId" IS NOT NULL
      AND a."employmentAssignmentId" = r."employmentAssignmentId"
  ) THEN
    RAISE EXCEPTION 'A retro adjustment source is a compensation record of the adjustment''s assignment.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "PayrollAdjustmentCompensationSource_before_insert" BEFORE INSERT ON "PayrollAdjustmentCompensationSource"
  FOR EACH ROW EXECUTE FUNCTION "payroll_adjustment_source_before_insert"();

CREATE TRIGGER "PayrollAdjustmentCompensationSource_append_only" BEFORE UPDATE OR DELETE ON "PayrollAdjustmentCompensationSource"
  FOR EACH ROW EXECUTE FUNCTION "prevent_append_only_rewrite"();
