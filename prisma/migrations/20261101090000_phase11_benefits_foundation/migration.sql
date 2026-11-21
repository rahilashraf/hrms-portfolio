-- CreateEnum
CREATE TYPE "BenefitType" AS ENUM ('HEALTH', 'DENTAL', 'VISION', 'LIFE', 'DISABILITY', 'RETIREMENT', 'WELLNESS', 'OTHER');

-- CreateEnum
CREATE TYPE "BenefitPlanStatus" AS ENUM ('DRAFT', 'ACTIVE', 'CLOSED');

-- CreateEnum
CREATE TYPE "BenefitCoverageLevel" AS ENUM ('EMPLOYEE_ONLY', 'EMPLOYEE_SPOUSE', 'EMPLOYEE_CHILDREN', 'FAMILY', 'CUSTOM');

-- CreateEnum
CREATE TYPE "BenefitRateFrequency" AS ENUM ('PER_PAY_PERIOD', 'MONTHLY', 'ANNUAL');

-- CreateEnum
CREATE TYPE "BenefitRecordType" AS ENUM ('INITIAL', 'CHANGE', 'CORRECTION');

-- CreateEnum
CREATE TYPE "BenefitDependentRelationship" AS ENUM ('SPOUSE', 'CHILD', 'OTHER');

-- CreateEnum
CREATE TYPE "BenefitElectionType" AS ENUM ('ENROLLED', 'WAIVED');

-- CreateTable
CREATE TABLE "BenefitPlan" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "benefitType" "BenefitType" NOT NULL,
    "providerName" TEXT,
    "providerReference" TEXT,
    "currency" CHAR(3) NOT NULL,
    "status" "BenefitPlanStatus" NOT NULL DEFAULT 'DRAFT',
    "effectiveFrom" DATE NOT NULL,
    "effectiveTo" DATE,
    "employerContributionTaxable" BOOLEAN NOT NULL DEFAULT false,
    "showEmployerCostToEmployee" BOOLEAN NOT NULL DEFAULT true,
    "dependentChildMaxAge" INTEGER,
    "createdByUserId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "archivedAt" TIMESTAMPTZ(6),

    CONSTRAINT "BenefitPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BenefitCoverageOption" (
    "id" UUID NOT NULL,
    "planId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "coverageLevel" "BenefitCoverageLevel" NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "archivedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "BenefitCoverageOption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BenefitRate" (
    "id" UUID NOT NULL,
    "planId" UUID NOT NULL,
    "optionId" UUID NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "effectiveTo" DATE,
    "frequency" "BenefitRateFrequency" NOT NULL,
    "employeeAmount" DECIMAL(19,2) NOT NULL,
    "employerAmount" DECIMAL(19,2) NOT NULL,
    "recordType" "BenefitRecordType" NOT NULL,
    "supersedesRateId" UUID,
    "supersededAt" TIMESTAMPTZ(6),
    "reason" TEXT,
    "createdByUserId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "BenefitRate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BenefitEligibilityRule" (
    "id" UUID NOT NULL,
    "planId" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "effectiveTo" DATE,
    "organizationalUnitId" UUID,
    "includeSubunits" BOOLEAN NOT NULL DEFAULT true,
    "departmentId" UUID,
    "positionId" UUID,
    "employmentTypes" "EmploymentType"[] DEFAULT ARRAY[]::"EmploymentType"[],
    "minimumServiceDays" INTEGER,
    "createdByUserId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "BenefitEligibilityRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BenefitDependent" (
    "id" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "relationship" "BenefitDependentRelationship" NOT NULL,
    "dateOfBirth" DATE,
    "relationshipStartDate" DATE,
    "relationshipEndDate" DATE,
    "archivedAt" TIMESTAMPTZ(6),
    "createdByUserId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "BenefitDependent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BenefitEnrollment" (
    "id" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "employmentAssignmentId" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "planId" UUID NOT NULL,
    "optionId" UUID,
    "electionType" "BenefitElectionType" NOT NULL,
    "recordType" "BenefitRecordType" NOT NULL,
    "coverageStart" DATE NOT NULL,
    "coverageEnd" DATE,
    "electedOn" DATE NOT NULL,
    "reason" TEXT,
    "eligibilityOverrideReason" TEXT,
    "supersedesEnrollmentId" UUID,
    "supersededAt" TIMESTAMPTZ(6),
    "supersessionReason" TEXT,
    "createdByUserId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "BenefitEnrollment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BenefitEnrollmentDependent" (
    "id" UUID NOT NULL,
    "enrollmentId" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "dependentId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BenefitEnrollmentDependent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BenefitPlan_organizationId_status_archivedAt_idx" ON "BenefitPlan"("organizationId", "status", "archivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "BenefitPlan_organizationId_code_key" ON "BenefitPlan"("organizationId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "BenefitPlan_id_organizationId_key" ON "BenefitPlan"("id", "organizationId");

-- CreateIndex
CREATE INDEX "BenefitCoverageOption_planId_archivedAt_sortOrder_idx" ON "BenefitCoverageOption"("planId", "archivedAt", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "BenefitCoverageOption_planId_code_key" ON "BenefitCoverageOption"("planId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "BenefitCoverageOption_id_planId_key" ON "BenefitCoverageOption"("id", "planId");

-- CreateIndex
CREATE UNIQUE INDEX "BenefitRate_supersedesRateId_key" ON "BenefitRate"("supersedesRateId");

-- CreateIndex
CREATE INDEX "BenefitRate_optionId_effectiveFrom_idx" ON "BenefitRate"("optionId", "effectiveFrom");

-- CreateIndex
CREATE INDEX "BenefitRate_planId_effectiveFrom_idx" ON "BenefitRate"("planId", "effectiveFrom");

-- CreateIndex
CREATE INDEX "BenefitEligibilityRule_planId_effectiveFrom_idx" ON "BenefitEligibilityRule"("planId", "effectiveFrom");

-- CreateIndex
CREATE INDEX "BenefitEligibilityRule_organizationId_idx" ON "BenefitEligibilityRule"("organizationId");

-- CreateIndex
CREATE INDEX "BenefitDependent_employeeId_archivedAt_idx" ON "BenefitDependent"("employeeId", "archivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "BenefitDependent_id_employeeId_key" ON "BenefitDependent"("id", "employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "BenefitEnrollment_supersedesEnrollmentId_key" ON "BenefitEnrollment"("supersedesEnrollmentId");

-- CreateIndex
CREATE INDEX "BenefitEnrollment_employeeId_planId_coverageStart_idx" ON "BenefitEnrollment"("employeeId", "planId", "coverageStart");

-- CreateIndex
CREATE INDEX "BenefitEnrollment_employmentAssignmentId_coverageStart_idx" ON "BenefitEnrollment"("employmentAssignmentId", "coverageStart");

-- CreateIndex
CREATE INDEX "BenefitEnrollment_planId_coverageStart_idx" ON "BenefitEnrollment"("planId", "coverageStart");

-- CreateIndex
CREATE INDEX "BenefitEnrollment_organizationId_idx" ON "BenefitEnrollment"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "BenefitEnrollment_id_employeeId_key" ON "BenefitEnrollment"("id", "employeeId");

-- CreateIndex
CREATE INDEX "BenefitEnrollmentDependent_dependentId_idx" ON "BenefitEnrollmentDependent"("dependentId");

-- CreateIndex
CREATE UNIQUE INDEX "BenefitEnrollmentDependent_enrollmentId_dependentId_key" ON "BenefitEnrollmentDependent"("enrollmentId", "dependentId");

-- AddForeignKey
ALTER TABLE "BenefitPlan" ADD CONSTRAINT "BenefitPlan_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BenefitPlan" ADD CONSTRAINT "BenefitPlan_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BenefitCoverageOption" ADD CONSTRAINT "BenefitCoverageOption_planId_fkey" FOREIGN KEY ("planId") REFERENCES "BenefitPlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BenefitRate" ADD CONSTRAINT "BenefitRate_planId_fkey" FOREIGN KEY ("planId") REFERENCES "BenefitPlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BenefitRate" ADD CONSTRAINT "BenefitRate_optionId_planId_fkey" FOREIGN KEY ("optionId", "planId") REFERENCES "BenefitCoverageOption"("id", "planId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BenefitRate" ADD CONSTRAINT "BenefitRate_supersedesRateId_fkey" FOREIGN KEY ("supersedesRateId") REFERENCES "BenefitRate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BenefitRate" ADD CONSTRAINT "BenefitRate_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BenefitEligibilityRule" ADD CONSTRAINT "BenefitEligibilityRule_planId_organizationId_fkey" FOREIGN KEY ("planId", "organizationId") REFERENCES "BenefitPlan"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BenefitEligibilityRule" ADD CONSTRAINT "BenefitEligibilityRule_organizationalUnitId_organizationId_fkey" FOREIGN KEY ("organizationalUnitId", "organizationId") REFERENCES "OrganizationalUnit"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BenefitEligibilityRule" ADD CONSTRAINT "BenefitEligibilityRule_departmentId_organizationId_fkey" FOREIGN KEY ("departmentId", "organizationId") REFERENCES "Department"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BenefitEligibilityRule" ADD CONSTRAINT "BenefitEligibilityRule_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "Position"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BenefitEligibilityRule" ADD CONSTRAINT "BenefitEligibilityRule_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BenefitDependent" ADD CONSTRAINT "BenefitDependent_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BenefitDependent" ADD CONSTRAINT "BenefitDependent_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BenefitEnrollment" ADD CONSTRAINT "BenefitEnrollment_employmentAssignmentId_employeeId_fkey" FOREIGN KEY ("employmentAssignmentId", "employeeId") REFERENCES "EmploymentAssignment"("id", "employeeId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BenefitEnrollment" ADD CONSTRAINT "BenefitEnrollment_planId_organizationId_fkey" FOREIGN KEY ("planId", "organizationId") REFERENCES "BenefitPlan"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BenefitEnrollment" ADD CONSTRAINT "BenefitEnrollment_optionId_planId_fkey" FOREIGN KEY ("optionId", "planId") REFERENCES "BenefitCoverageOption"("id", "planId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BenefitEnrollment" ADD CONSTRAINT "BenefitEnrollment_supersedesEnrollmentId_fkey" FOREIGN KEY ("supersedesEnrollmentId") REFERENCES "BenefitEnrollment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BenefitEnrollment" ADD CONSTRAINT "BenefitEnrollment_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BenefitEnrollmentDependent" ADD CONSTRAINT "BenefitEnrollmentDependent_enrollmentId_employeeId_fkey" FOREIGN KEY ("enrollmentId", "employeeId") REFERENCES "BenefitEnrollment"("id", "employeeId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BenefitEnrollmentDependent" ADD CONSTRAINT "BenefitEnrollmentDependent_dependentId_employeeId_fkey" FOREIGN KEY ("dependentId", "employeeId") REFERENCES "BenefitDependent"("id", "employeeId") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ─── Integrity ───────────────────────────────────────────────────────────────

ALTER TABLE "BenefitPlan"
  ADD CONSTRAINT "BenefitPlan_code_check" CHECK ("code" ~ '^[A-Z0-9_-]{2,64}$'),
  ADD CONSTRAINT "BenefitPlan_text_check" CHECK (
    btrim("name") <> ''
    AND ("description" IS NULL OR btrim("description") <> '')
    AND ("providerName" IS NULL OR btrim("providerName") <> '')
    AND ("providerReference" IS NULL OR btrim("providerReference") <> '')
  ),
  ADD CONSTRAINT "BenefitPlan_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "BenefitPlan_period_check" CHECK ("effectiveTo" IS NULL OR "effectiveTo" >= "effectiveFrom"),
  ADD CONSTRAINT "BenefitPlan_child_age_check" CHECK (
    "dependentChildMaxAge" IS NULL OR "dependentChildMaxAge" BETWEEN 0 AND 99
  );

ALTER TABLE "BenefitCoverageOption"
  ADD CONSTRAINT "BenefitCoverageOption_code_check" CHECK ("code" ~ '^[A-Z0-9_-]{2,64}$'),
  ADD CONSTRAINT "BenefitCoverageOption_name_check" CHECK (btrim("name") <> '');

ALTER TABLE "BenefitRate"
  ADD CONSTRAINT "BenefitRate_period_check" CHECK ("effectiveTo" IS NULL OR "effectiveTo" >= "effectiveFrom"),
  ADD CONSTRAINT "BenefitRate_amount_check" CHECK ("employeeAmount" >= 0 AND "employerAmount" >= 0),
  ADD CONSTRAINT "BenefitRate_reason_check" CHECK ("reason" IS NULL OR btrim("reason") <> ''),
  ADD CONSTRAINT "BenefitRate_correction_shape_check" CHECK (
    ("recordType" = 'CORRECTION') = ("supersedesRateId" IS NOT NULL)
    AND ("recordType" <> 'CORRECTION' OR "reason" IS NOT NULL)
  );

ALTER TABLE "BenefitEligibilityRule"
  ADD CONSTRAINT "BenefitEligibilityRule_period_check" CHECK ("effectiveTo" IS NULL OR "effectiveTo" >= "effectiveFrom"),
  ADD CONSTRAINT "BenefitEligibilityRule_service_check" CHECK ("minimumServiceDays" IS NULL OR "minimumServiceDays" >= 0);

ALTER TABLE "BenefitDependent"
  ADD CONSTRAINT "BenefitDependent_name_check" CHECK (btrim("firstName") <> '' AND btrim("lastName") <> ''),
  ADD CONSTRAINT "BenefitDependent_child_birth_check" CHECK ("relationship" <> 'CHILD' OR "dateOfBirth" IS NOT NULL),
  ADD CONSTRAINT "BenefitDependent_relationship_period_check" CHECK (
    "relationshipEndDate" IS NULL OR "relationshipStartDate" IS NULL
    OR "relationshipEndDate" >= "relationshipStartDate"
  );

ALTER TABLE "BenefitEnrollment"
  ADD CONSTRAINT "BenefitEnrollment_period_check" CHECK ("coverageEnd" IS NULL OR "coverageEnd" >= "coverageStart"),
  -- A waiver elects no option; an enrollment elects exactly one.
  ADD CONSTRAINT "BenefitEnrollment_election_shape_check" CHECK (
    ("electionType" = 'WAIVED') = ("optionId" IS NULL)
  ),
  ADD CONSTRAINT "BenefitEnrollment_text_check" CHECK (
    ("reason" IS NULL OR btrim("reason") <> '')
    AND ("eligibilityOverrideReason" IS NULL OR btrim("eligibilityOverrideReason") <> '')
    AND ("supersessionReason" IS NULL OR btrim("supersessionReason") <> '')
  ),
  ADD CONSTRAINT "BenefitEnrollment_correction_shape_check" CHECK (
    ("recordType" = 'CORRECTION') = ("supersedesEnrollmentId" IS NOT NULL)
    AND ("recordType" <> 'CORRECTION' OR "reason" IS NOT NULL)
    AND ("supersededAt" IS NULL) = ("supersessionReason" IS NULL)
  );

-- A plan's organization, code and currency are its identity; its dates may move only while
-- every rate and election stays inside them.
CREATE FUNCTION "guard_benefit_plan"() RETURNS trigger AS $$
BEGIN
  IF NEW."organizationId" <> OLD."organizationId" OR NEW."code" <> OLD."code"
    OR NEW."currency" <> OLD."currency" THEN
    RAISE EXCEPTION 'A benefit plan''s organization, code and currency never change.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."effectiveFrom" <> OLD."effectiveFrom" OR NEW."effectiveTo" IS DISTINCT FROM OLD."effectiveTo" THEN
    IF EXISTS (
      SELECT 1 FROM "BenefitRate" r
      WHERE r."planId" = NEW."id" AND r."supersededAt" IS NULL
        AND (r."effectiveFrom" < NEW."effectiveFrom"
          OR COALESCE(r."effectiveTo", 'infinity'::date) > COALESCE(NEW."effectiveTo", 'infinity'::date))
    ) OR EXISTS (
      SELECT 1 FROM "BenefitEnrollment" e
      WHERE e."planId" = NEW."id" AND e."supersededAt" IS NULL
        AND (e."coverageStart" < NEW."effectiveFrom"
          OR COALESCE(e."coverageEnd", 'infinity'::date) > COALESCE(NEW."effectiveTo", 'infinity'::date))
    ) THEN
      RAISE EXCEPTION 'Rates or elections of the plan fall outside its new dates.' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "BenefitPlan_guard" BEFORE UPDATE ON "BenefitPlan"
  FOR EACH ROW EXECUTE FUNCTION "guard_benefit_plan"();

-- An option's plan, code and coverage level are what its history means.
CREATE FUNCTION "guard_benefit_option"() RETURNS trigger AS $$
BEGIN
  IF NEW."planId" <> OLD."planId" OR NEW."code" <> OLD."code"
    OR NEW."coverageLevel" <> OLD."coverageLevel" THEN
    RAISE EXCEPTION 'A coverage option''s plan, code and coverage level never change.' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "BenefitCoverageOption_guard" BEFORE UPDATE ON "BenefitCoverageOption"
  FOR EACH ROW EXECUTE FUNCTION "guard_benefit_option"();

-- Rates are history: never deleted; terms fixed at insert. The only updates are closing a rate
-- earlier (a later rate starts) and marking it superseded once (a correction replaced it).
CREATE FUNCTION "prevent_benefit_rate_rewrite"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Benefit rates cannot be deleted.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."id" <> OLD."id" OR NEW."planId" <> OLD."planId" OR NEW."optionId" <> OLD."optionId"
    OR NEW."effectiveFrom" <> OLD."effectiveFrom" OR NEW."frequency" <> OLD."frequency"
    OR NEW."employeeAmount" <> OLD."employeeAmount" OR NEW."employerAmount" <> OLD."employerAmount"
    OR NEW."recordType" <> OLD."recordType"
    OR NEW."supersedesRateId" IS DISTINCT FROM OLD."supersedesRateId"
    OR NEW."reason" IS DISTINCT FROM OLD."reason"
    OR NEW."createdByUserId" IS DISTINCT FROM OLD."createdByUserId"
    OR NEW."createdAt" <> OLD."createdAt" THEN
    RAISE EXCEPTION 'Benefit rates are immutable; correct one by superseding it.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."supersededAt" IS NOT NULL
    AND (NEW."supersededAt" IS DISTINCT FROM OLD."supersededAt" OR NEW."effectiveTo" IS DISTINCT FROM OLD."effectiveTo") THEN
    RAISE EXCEPTION 'A superseded benefit rate is frozen.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."effectiveTo" IS DISTINCT FROM OLD."effectiveTo"
    AND (NEW."effectiveTo" IS NULL OR (OLD."effectiveTo" IS NOT NULL AND NEW."effectiveTo" >= OLD."effectiveTo")) THEN
    RAISE EXCEPTION 'A benefit rate can only be closed earlier, never extended or reopened.' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "BenefitRate_prevent_rewrite" BEFORE UPDATE OR DELETE ON "BenefitRate"
  FOR EACH ROW EXECUTE FUNCTION "prevent_benefit_rate_rewrite"();

-- The rate timeline of an option never overlaps and stays inside the plan's dates. Locks the
-- option row first so concurrent writers of one option serialize here.
CREATE FUNCTION "check_benefit_rate_timeline"() RETURNS trigger AS $$
DECLARE
  plan RECORD;
BEGIN
  IF NEW."supersededAt" IS NOT NULL THEN
    RETURN NEW;
  END IF;
  PERFORM 1 FROM "BenefitCoverageOption" WHERE "id" = NEW."optionId" FOR NO KEY UPDATE;
  SELECT "effectiveFrom", "effectiveTo" INTO plan FROM "BenefitPlan" WHERE "id" = NEW."planId";
  IF NEW."effectiveFrom" < plan."effectiveFrom"
    OR COALESCE(NEW."effectiveTo", 'infinity'::date) > COALESCE(plan."effectiveTo", 'infinity'::date) THEN
    RAISE EXCEPTION 'A benefit rate must stay within its plan''s dates.' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "BenefitRate" other
    WHERE other."optionId" = NEW."optionId"
      AND other."id" <> NEW."id"
      AND other."supersededAt" IS NULL
      AND other."effectiveFrom" <= COALESCE(NEW."effectiveTo", 'infinity'::date)
      AND NEW."effectiveFrom" <= COALESCE(other."effectiveTo", 'infinity'::date)
  ) THEN
    RAISE EXCEPTION 'Rates of a coverage option cannot overlap.' USING ERRCODE = 'exclusion_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "BenefitRate_timeline" BEFORE INSERT OR UPDATE ON "BenefitRate"
  FOR EACH ROW EXECUTE FUNCTION "check_benefit_rate_timeline"();

-- Eligibility criteria never change (end a rule and start another); a position belongs to the
-- rule's organization.
CREATE FUNCTION "guard_benefit_eligibility_rule"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."planId" <> OLD."planId" OR NEW."organizationId" <> OLD."organizationId"
      OR NEW."effectiveFrom" <> OLD."effectiveFrom"
      OR NEW."organizationalUnitId" IS DISTINCT FROM OLD."organizationalUnitId"
      OR NEW."includeSubunits" <> OLD."includeSubunits"
      OR NEW."departmentId" IS DISTINCT FROM OLD."departmentId"
      OR NEW."positionId" IS DISTINCT FROM OLD."positionId"
      OR NEW."employmentTypes" <> OLD."employmentTypes"
      OR NEW."minimumServiceDays" IS DISTINCT FROM OLD."minimumServiceDays" THEN
      RAISE EXCEPTION 'Eligibility criteria never change; end the rule and add another.' USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW."effectiveTo" IS DISTINCT FROM OLD."effectiveTo"
      AND (NEW."effectiveTo" IS NULL OR (OLD."effectiveTo" IS NOT NULL AND NEW."effectiveTo" >= OLD."effectiveTo")) THEN
      RAISE EXCEPTION 'An eligibility rule can only be ended earlier.' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."positionId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "Position" p WHERE p."id" = NEW."positionId" AND p."organizationId" = NEW."organizationId"
  ) THEN
    RAISE EXCEPTION 'The position belongs to another organization.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "BenefitEligibilityRule_guard" BEFORE INSERT OR UPDATE ON "BenefitEligibilityRule"
  FOR EACH ROW EXECUTE FUNCTION "guard_benefit_eligibility_rule"();

-- A dependent never moves to another employee.
CREATE FUNCTION "guard_benefit_dependent"() RETURNS trigger AS $$
BEGIN
  IF NEW."employeeId" <> OLD."employeeId" THEN
    RAISE EXCEPTION 'A dependent never moves to another employee.' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "BenefitDependent_guard" BEFORE UPDATE ON "BenefitDependent"
  FOR EACH ROW EXECUTE FUNCTION "guard_benefit_dependent"();

-- Elections are history: never deleted; terms fixed at insert. The only updates are ending
-- coverage earlier (or ending open coverage) and marking a segment superseded once, with why.
CREATE FUNCTION "prevent_benefit_enrollment_rewrite"() RETURNS trigger AS $$
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
      OR NEW."coverageEnd" IS DISTINCT FROM OLD."coverageEnd") THEN
    RAISE EXCEPTION 'A superseded benefit election is frozen.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."coverageEnd" IS DISTINCT FROM OLD."coverageEnd"
    AND (NEW."coverageEnd" IS NULL OR (OLD."coverageEnd" IS NOT NULL AND NEW."coverageEnd" >= OLD."coverageEnd")) THEN
    RAISE EXCEPTION 'Coverage can only be ended earlier, never extended or reopened.' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "BenefitEnrollment_prevent_rewrite" BEFORE UPDATE OR DELETE ON "BenefitEnrollment"
  FOR EACH ROW EXECUTE FUNCTION "prevent_benefit_enrollment_rewrite"();

-- One election timeline per employee and plan, whatever their assignments: its segments
-- (enrolled or waived) never overlap. Locks the Employee row first, so concurrent election
-- writers of one employee serialize here even outside the service. A new segment must sit on a
-- live (not cancelled) assignment of the plan's organization, within the assignment's and the
-- plan's dates, on a plan that is not a draft and an option that is not archived.
-- Core HR is never blocked: an assignment may later end before coverage (Benefits reports it).
CREATE FUNCTION "check_benefit_enrollment_timeline"() RETURNS trigger AS $$
DECLARE
  assignment RECORD;
  plan RECORD;
BEGIN
  IF NEW."supersededAt" IS NOT NULL THEN
    RETURN NEW;
  END IF;
  PERFORM 1 FROM "Employee" WHERE "id" = NEW."employeeId" FOR NO KEY UPDATE;
  IF TG_OP = 'INSERT' THEN
    SELECT ea."status", ea."startDate", ea."endDate", p."organizationId"
      INTO assignment
      FROM "EmploymentAssignment" ea
      JOIN "Position" p ON p."id" = ea."positionId"
      WHERE ea."id" = NEW."employmentAssignmentId";
    IF assignment."organizationId" <> NEW."organizationId" THEN
      RAISE EXCEPTION 'The sponsoring assignment belongs to another organization.' USING ERRCODE = 'check_violation';
    END IF;
    IF assignment."status" = 'CANCELLED' THEN
      RAISE EXCEPTION 'A cancelled assignment cannot sponsor benefits.' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."coverageStart" < assignment."startDate"
      OR (assignment."endDate" IS NOT NULL
        AND (NEW."coverageStart" > assignment."endDate"
          OR COALESCE(NEW."coverageEnd", 'infinity'::date) > assignment."endDate")) THEN
      RAISE EXCEPTION 'Coverage must stay within the sponsoring assignment''s dates.' USING ERRCODE = 'check_violation';
    END IF;
    SELECT "status", "effectiveFrom", "effectiveTo", "archivedAt" INTO plan
      FROM "BenefitPlan" WHERE "id" = NEW."planId";
    IF plan."status" = 'DRAFT' OR plan."archivedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'The benefit plan does not accept elections.' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."coverageStart" < plan."effectiveFrom"
      OR COALESCE(NEW."coverageEnd", 'infinity'::date) > COALESCE(plan."effectiveTo", 'infinity'::date) THEN
      RAISE EXCEPTION 'Coverage must stay within the plan''s dates.' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."optionId" IS NOT NULL AND EXISTS (
      SELECT 1 FROM "BenefitCoverageOption" WHERE "id" = NEW."optionId" AND "archivedAt" IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'The coverage option is archived.' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF EXISTS (
    SELECT 1 FROM "BenefitEnrollment" other
    WHERE other."employeeId" = NEW."employeeId"
      AND other."planId" = NEW."planId"
      AND other."id" <> NEW."id"
      AND other."supersededAt" IS NULL
      AND other."coverageStart" <= COALESCE(NEW."coverageEnd", 'infinity'::date)
      AND NEW."coverageStart" <= COALESCE(other."coverageEnd", 'infinity'::date)
  ) THEN
    RAISE EXCEPTION 'Elections of an employee for one plan cannot overlap.' USING ERRCODE = 'exclusion_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "BenefitEnrollment_timeline" BEFORE INSERT OR UPDATE ON "BenefitEnrollment"
  FOR EACH ROW EXECUTE FUNCTION "check_benefit_enrollment_timeline"();

-- Covered dependents are written once with an enrolled (not waived, not superseded) segment.
CREATE FUNCTION "guard_benefit_enrollment_dependent"() RETURNS trigger AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Covered dependents of an election never change; start a new segment.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "BenefitEnrollment"
    WHERE "id" = NEW."enrollmentId" AND "electionType" = 'ENROLLED' AND "supersededAt" IS NULL
  ) THEN
    RAISE EXCEPTION 'Dependents can only be covered by a current enrolled election.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "BenefitEnrollmentDependent_guard" BEFORE INSERT OR UPDATE OR DELETE ON "BenefitEnrollmentDependent"
  FOR EACH ROW EXECUTE FUNCTION "guard_benefit_enrollment_dependent"();
