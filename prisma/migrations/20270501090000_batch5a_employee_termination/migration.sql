-- Batch 5A — employee-wide termination history (additive only: two new tables, no change to an
-- existing column, no backfill). Old code ignores these tables, so a code rollback is safe.

CREATE TYPE "EmployeeTerminationStatus" AS ENUM ('SCHEDULED', 'APPLIED', 'CANCELLED', 'SUPERSEDED');
CREATE TYPE "EmployeeTerminationAssignmentAction" AS ENUM ('END', 'CANCEL');

CREATE TABLE "EmployeeTermination" (
    "id" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "terminationDate" DATE NOT NULL,
    "status" "EmployeeTerminationStatus" NOT NULL DEFAULT 'SCHEDULED',
    "reason" TEXT,
    "systemGrantsAcknowledged" BOOLEAN NOT NULL DEFAULT false,
    "recordedByUserId" UUID,
    "recordedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "appliedAt" TIMESTAMPTZ(6),
    "appliedSource" TEXT,
    "cancelledAt" TIMESTAMPTZ(6),
    "cancelledByUserId" UUID,
    "cancellationReason" TEXT,
    "supersededById" UUID,
    "rehireAssignmentId" UUID,
    "rehiredAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "EmployeeTermination_pkey" PRIMARY KEY ("id"),
    -- Each status has exactly its own fields.
    CONSTRAINT "EmployeeTermination_status_shape_check" CHECK (
      ("status" = 'SCHEDULED' AND "appliedAt" IS NULL AND "cancelledAt" IS NULL AND "supersededById" IS NULL)
      OR ("status" = 'APPLIED' AND "appliedAt" IS NOT NULL AND "appliedSource" IN ('IMMEDIATE', 'MANUAL', 'AUTOMATIC') AND "cancelledAt" IS NULL AND "supersededById" IS NULL)
      OR ("status" = 'CANCELLED' AND "cancelledAt" IS NOT NULL AND "appliedAt" IS NULL AND "supersededById" IS NULL)
      OR ("status" = 'SUPERSEDED' AND "cancelledAt" IS NOT NULL AND "appliedAt" IS NULL AND "supersededById" IS NOT NULL)
    ),
    -- Only an applied termination can be followed by a rehire (both fields together).
    CONSTRAINT "EmployeeTermination_rehire_shape_check" CHECK (
      ("rehireAssignmentId" IS NULL AND "rehiredAt" IS NULL)
      OR ("rehireAssignmentId" IS NOT NULL AND "rehiredAt" IS NOT NULL AND "status" = 'APPLIED')
    ),
    CONSTRAINT "EmployeeTermination_reason_length_check" CHECK ("reason" IS NULL OR char_length("reason") <= 1000),
    CONSTRAINT "EmployeeTermination_cancellation_length_check" CHECK ("cancellationReason" IS NULL OR char_length("cancellationReason") <= 1000)
);

CREATE TABLE "EmployeeTerminationAssignment" (
    "id" UUID NOT NULL,
    "terminationId" UUID NOT NULL,
    "employmentAssignmentId" UUID NOT NULL,
    "action" "EmployeeTerminationAssignmentAction" NOT NULL,
    "previousStatus" "EmploymentAssignmentStatus" NOT NULL,
    "previousEndDate" DATE,
    "appliedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EmployeeTerminationAssignment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "EmployeeTermination_employeeId_status_idx" ON "EmployeeTermination"("employeeId", "status");
CREATE INDEX "EmployeeTermination_status_terminationDate_idx" ON "EmployeeTermination"("status", "terminationDate");
CREATE INDEX "EmployeeTerminationAssignment_employmentAssignmentId_idx" ON "EmployeeTerminationAssignment"("employmentAssignmentId");
CREATE UNIQUE INDEX "EmployeeTerminationAssignment_terminationId_employmentAssig_key" ON "EmployeeTerminationAssignment"("terminationId", "employmentAssignmentId");
-- At most one scheduled termination per employee: concurrent schedules cannot both succeed.
CREATE UNIQUE INDEX "EmployeeTermination_one_scheduled_per_employee" ON "EmployeeTermination"("employeeId") WHERE "status" = 'SCHEDULED';

ALTER TABLE "EmployeeTermination" ADD CONSTRAINT "EmployeeTermination_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EmployeeTermination" ADD CONSTRAINT "EmployeeTermination_recordedByUserId_fkey" FOREIGN KEY ("recordedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EmployeeTermination" ADD CONSTRAINT "EmployeeTermination_cancelledByUserId_fkey" FOREIGN KEY ("cancelledByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- Deferred: a reschedule marks the old row SUPERSEDED (pointing at the new one) before the new
-- row can exist under the one-scheduled-per-employee index; both commit together.
ALTER TABLE "EmployeeTermination" ADD CONSTRAINT "EmployeeTermination_supersededById_fkey" FOREIGN KEY ("supersededById") REFERENCES "EmployeeTermination"("id") ON DELETE RESTRICT ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "EmployeeTermination" ADD CONSTRAINT "EmployeeTermination_rehireAssignmentId_fkey" FOREIGN KEY ("rehireAssignmentId") REFERENCES "EmploymentAssignment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EmployeeTerminationAssignment" ADD CONSTRAINT "EmployeeTerminationAssignment_terminationId_fkey" FOREIGN KEY ("terminationId") REFERENCES "EmployeeTermination"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EmployeeTerminationAssignment" ADD CONSTRAINT "EmployeeTerminationAssignment_employmentAssignmentId_fkey" FOREIGN KEY ("employmentAssignmentId") REFERENCES "EmploymentAssignment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- History is never deleted; an applied termination never changes (except its one rehire link),
-- and a closed (cancelled or superseded) one never changes at all. An affected assignment must
-- belong to the terminated employee.
CREATE FUNCTION "employee_termination_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Employee termination history cannot be deleted.' USING ERRCODE = '23514';
  END IF;
  IF OLD."status" IN ('CANCELLED', 'SUPERSEDED') THEN
    RAISE EXCEPTION 'A closed employee termination cannot change.' USING ERRCODE = '23514';
  END IF;
  IF OLD."status" = 'APPLIED' AND (
    NEW."status" IS DISTINCT FROM OLD."status"
    OR NEW."employeeId" IS DISTINCT FROM OLD."employeeId"
    OR NEW."terminationDate" IS DISTINCT FROM OLD."terminationDate"
    OR NEW."reason" IS DISTINCT FROM OLD."reason"
    OR NEW."appliedAt" IS DISTINCT FROM OLD."appliedAt"
    OR NEW."appliedSource" IS DISTINCT FROM OLD."appliedSource"
    OR NEW."recordedByUserId" IS DISTINCT FROM OLD."recordedByUserId"
    OR NEW."recordedAt" IS DISTINCT FROM OLD."recordedAt"
    OR NEW."systemGrantsAcknowledged" IS DISTINCT FROM OLD."systemGrantsAcknowledged"
    OR (OLD."rehireAssignmentId" IS NOT NULL AND NEW."rehireAssignmentId" IS DISTINCT FROM OLD."rehireAssignmentId")
    OR (OLD."rehiredAt" IS NOT NULL AND NEW."rehiredAt" IS DISTINCT FROM OLD."rehiredAt")
  ) THEN
    RAISE EXCEPTION 'An applied employee termination can only gain its rehire link.' USING ERRCODE = '23514';
  END IF;
  IF NEW."employeeId" IS DISTINCT FROM OLD."employeeId" OR NEW."recordedAt" IS DISTINCT FROM OLD."recordedAt" THEN
    RAISE EXCEPTION 'An employee termination keeps its employee and recording time.' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "EmployeeTermination_guard"
  BEFORE UPDATE OR DELETE ON "EmployeeTermination"
  FOR EACH ROW EXECUTE FUNCTION "employee_termination_guard"();

CREATE FUNCTION "employee_termination_assignment_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Employee termination history cannot be deleted.' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND (
    NEW."terminationId" IS DISTINCT FROM OLD."terminationId"
    OR NEW."employmentAssignmentId" IS DISTINCT FROM OLD."employmentAssignmentId"
    OR NEW."action" IS DISTINCT FROM OLD."action"
    OR NEW."previousStatus" IS DISTINCT FROM OLD."previousStatus"
    OR NEW."previousEndDate" IS DISTINCT FROM OLD."previousEndDate"
    OR (OLD."appliedAt" IS NOT NULL AND NEW."appliedAt" IS DISTINCT FROM OLD."appliedAt")
  ) THEN
    RAISE EXCEPTION 'An affected assignment record can only gain its applied time.' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' AND NOT EXISTS (
    SELECT 1 FROM "EmployeeTermination" t
    JOIN "EmploymentAssignment" a ON a."id" = NEW."employmentAssignmentId"
    WHERE t."id" = NEW."terminationId" AND a."employeeId" = t."employeeId"
  ) THEN
    RAISE EXCEPTION 'The assignment does not belong to the terminated employee.' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "EmployeeTerminationAssignment_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "EmployeeTerminationAssignment"
  FOR EACH ROW EXECUTE FUNCTION "employee_termination_assignment_guard"();
