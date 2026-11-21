-- Contracted/fixed-period salaried compensation. Existing salary records are explicitly
-- annual; hourly records keep salary arrangement fields null.

CREATE TYPE "CompensationSalaryArrangement" AS ENUM ('ANNUAL', 'FIXED_PERIOD', 'CONTRACT_TOTAL');

ALTER TABLE "CompensationRecord"
  ADD COLUMN "salaryArrangement" "CompensationSalaryArrangement",
  ADD COLUMN "salaryMonthlyAmount" DECIMAL(19,4),
  ADD COLUMN "salaryPaidMonths" INTEGER,
  ADD COLUMN "salaryContractAmount" DECIMAL(19,4),
  ADD COLUMN "salaryPeriodStart" DATE,
  ADD COLUMN "salaryPeriodEnd" DATE;

UPDATE "CompensationRecord"
SET "salaryArrangement" = 'ANNUAL'
WHERE "payBasis" = 'SALARY' AND "salaryArrangement" IS NULL;

ALTER TABLE "PayrollCompensationSnapshot"
  ADD COLUMN "salaryArrangement" "CompensationSalaryArrangement",
  ADD COLUMN "salaryMonthlyAmount" DECIMAL(19,4),
  ADD COLUMN "salaryPaidMonths" INTEGER,
  ADD COLUMN "salaryContractAmount" DECIMAL(19,4),
  ADD COLUMN "salaryPeriodStart" DATE,
  ADD COLUMN "salaryPeriodEnd" DATE;

ALTER TABLE "CompensationRecord"
  ADD CONSTRAINT "CompensationRecord_salary_arrangement_check" CHECK (
    (
      "payBasis" = 'HOURLY'
      AND "salaryArrangement" IS NULL
      AND "salaryMonthlyAmount" IS NULL
      AND "salaryPaidMonths" IS NULL
      AND "salaryContractAmount" IS NULL
      AND "salaryPeriodStart" IS NULL
      AND "salaryPeriodEnd" IS NULL
    )
    OR (
      "payBasis" = 'SALARY'
      AND (
        (
          ("salaryArrangement" IS NULL OR "salaryArrangement" = 'ANNUAL')
          AND "salaryMonthlyAmount" IS NULL
          AND "salaryPaidMonths" IS NULL
          AND "salaryContractAmount" IS NULL
          AND "salaryPeriodStart" IS NULL
          AND "salaryPeriodEnd" IS NULL
        )
        OR (
          "salaryArrangement" = 'FIXED_PERIOD'
          AND "salaryMonthlyAmount" > 0
          AND "salaryPaidMonths" BETWEEN 1 AND 120
          AND "salaryContractAmount" > 0
          AND "salaryPeriodStart" IS NOT NULL
          AND "salaryPeriodEnd" IS NOT NULL
          AND "salaryPeriodEnd" >= "salaryPeriodStart"
          AND "salaryPeriodStart" = "effectiveFrom"
          AND "effectiveTo" = "salaryPeriodEnd"
        )
        OR (
          "salaryArrangement" = 'CONTRACT_TOTAL'
          AND "salaryMonthlyAmount" IS NULL
          AND "salaryPaidMonths" IS NULL
          AND "salaryContractAmount" > 0
          AND "salaryPeriodStart" IS NOT NULL
          AND "salaryPeriodEnd" IS NOT NULL
          AND "salaryPeriodEnd" >= "salaryPeriodStart"
          AND "salaryPeriodStart" = "effectiveFrom"
          AND "effectiveTo" = "salaryPeriodEnd"
        )
      )
    )
  );

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
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
