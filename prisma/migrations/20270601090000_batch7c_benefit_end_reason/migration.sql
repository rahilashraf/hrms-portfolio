-- Batch 7C (C1) — benefit election end reasons on the election, not in audit metadata.
--
-- The reason an election was ended (often a life event: divorce, death, leaving the plan) was
-- written only into AuditLog metadata. It now lives on the election itself, read only by
-- Benefits/HR users entitled to the election's HR notes; audit metadata records only that a
-- reason was given. Existing audit rows are left untouched (no historical data is deleted).
--
-- Narrow scope: one nullable column, its non-blank check, and the election immutability trigger
-- extended so the reason is written only together with ending coverage (the one update an
-- election allows), is never erased on its own (it moves only with the end it explains), and
-- is frozen with the rest of a superseded election.
--
-- Rollback (manual): the column is additive and nullable. To roll back, restore the previous
-- "prevent_benefit_enrollment_rewrite" body (migration 20261101090000_phase11_benefits_foundation)
-- and then `ALTER TABLE "BenefitEnrollment" DROP COLUMN "endReason";` — which discards the end
-- reasons recorded since (export them first if they must be kept).

ALTER TABLE "BenefitEnrollment" ADD COLUMN "endReason" TEXT;

ALTER TABLE "BenefitEnrollment"
  ADD CONSTRAINT "BenefitEnrollment_endReason_check"
  CHECK ("endReason" IS NULL OR btrim("endReason") <> '');

CREATE OR REPLACE FUNCTION "prevent_benefit_enrollment_rewrite"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Benefit elections cannot be deleted; supersede them.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."id" <> OLD."id" OR NEW."employeeId" <> OLD."employeeId"
    OR NEW."employmentAssignmentId" <> OLD."employmentAssignmentId"
    OR NEW."organizationId" <> OLD."organizationId" OR NEW."planId" <> OLD."planId"
    OR NEW."optionId" IS DISTINCT FROM OLD."optionId"
    OR NEW."electionType" <> OLD."electionType" OR NEW."recordType" <> OLD."recordType"
    OR NEW."coverageStart" <> OLD."coverageStart" OR NEW."electedOn" <> OLD."electedOn"
    OR NEW."reason" IS DISTINCT FROM OLD."reason"
    OR NEW."eligibilityOverrideReason" IS DISTINCT FROM OLD."eligibilityOverrideReason"
    OR NEW."supersedesEnrollmentId" IS DISTINCT FROM OLD."supersedesEnrollmentId"
    OR NEW."createdByUserId" IS DISTINCT FROM OLD."createdByUserId"
    OR NEW."createdAt" <> OLD."createdAt" THEN
    RAISE EXCEPTION 'Benefit elections are immutable; correct one by superseding it.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."supersededAt" IS NOT NULL
    AND (NEW."supersededAt" IS DISTINCT FROM OLD."supersededAt"
      OR NEW."supersessionReason" IS DISTINCT FROM OLD."supersessionReason"
      OR NEW."coverageEnd" IS DISTINCT FROM OLD."coverageEnd"
      OR NEW."endReason" IS DISTINCT FROM OLD."endReason") THEN
    RAISE EXCEPTION 'A superseded benefit election is frozen.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."coverageEnd" IS DISTINCT FROM OLD."coverageEnd"
    AND (NEW."coverageEnd" IS NULL OR (OLD."coverageEnd" IS NOT NULL AND NEW."coverageEnd" >= OLD."coverageEnd")) THEN
    RAISE EXCEPTION 'Coverage can only be ended earlier, never extended or reopened.' USING ERRCODE = 'restrict_violation';
  END IF;
  -- Batch 7C (C1): the end reason is recorded with the end it explains, never on its own.
  IF NEW."endReason" IS DISTINCT FROM OLD."endReason"
    AND NEW."coverageEnd" IS NOT DISTINCT FROM OLD."coverageEnd" THEN
    RAISE EXCEPTION 'An end reason is recorded only when coverage is ended.' USING ERRCODE = 'restrict_violation';
  END IF;
  -- A recorded end reason is never erased on its own: it moves only with the end it explains
  -- (an earlier end replacing it, or a change or transfer handing the end to the next segment).
  IF OLD."endReason" IS NOT NULL AND NEW."endReason" IS NULL
    AND NEW."coverageEnd" IS NOT DISTINCT FROM OLD."coverageEnd" THEN
    RAISE EXCEPTION 'A recorded end reason is never erased.' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
