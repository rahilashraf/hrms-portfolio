-- CreateEnum
CREATE TYPE "PayrollSourceKind" AS ENUM ('WORKED_TIME', 'SALARY_DAY', 'LEAVE');

-- CreateTable
CREATE TABLE "PayrollSourceClaim" (
    "id" UUID NOT NULL,
    "payrollRunId" UUID NOT NULL,
    "payrollRunAssignmentId" UUID NOT NULL,
    "employmentAssignmentId" UUID NOT NULL,
    "kind" "PayrollSourceKind" NOT NULL,
    "workDate" DATE NOT NULL,
    "leaveRequestDayId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PayrollSourceClaim_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PayrollSourceClaim_payrollRunId_idx" ON "PayrollSourceClaim"("payrollRunId");

-- CreateIndex
CREATE INDEX "PayrollSourceClaim_payrollRunAssignmentId_payrollRunId_empl_idx" ON "PayrollSourceClaim"("payrollRunAssignmentId", "payrollRunId", "employmentAssignmentId");

-- CreateIndex
CREATE INDEX "PayrollSourceClaim_employmentAssignmentId_workDate_idx" ON "PayrollSourceClaim"("employmentAssignmentId", "workDate");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollRunAssignment_id_payrollRunId_employmentAssignmentId_key" ON "PayrollRunAssignment"("id", "payrollRunId", "employmentAssignmentId");

-- AddForeignKey
ALTER TABLE "PayrollSourceClaim" ADD CONSTRAINT "PayrollSourceClaim_payrollRunId_fkey" FOREIGN KEY ("payrollRunId") REFERENCES "PayrollRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollSourceClaim" ADD CONSTRAINT "PayrollSourceClaim_payrollRunAssignmentId_payrollRunId_emp_fkey" FOREIGN KEY ("payrollRunAssignmentId", "payrollRunId", "employmentAssignmentId") REFERENCES "PayrollRunAssignment"("id", "payrollRunId", "employmentAssignmentId") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ─── Integrity ───────────────────────────────────────────────────────────────

-- A leave claim names its leave day; time and salary claims never do.
ALTER TABLE "PayrollSourceClaim"
  ADD CONSTRAINT "PayrollSourceClaim_leave_shape_check" CHECK (
    ("kind" = 'LEAVE') = ("leaveRequestDayId" IS NOT NULL)
  );

-- The duplicate-pay invariant: across every live or finalized run, an assignment's worked time or
-- salaried day of a date is paid by one run, and a leave day by one run. A voided run releases
-- its claims; a recalculation replaces its own. Pay-group ownership comes from the compensation
-- effective on the date, so two pay groups never legitimately claim the same source.
CREATE UNIQUE INDEX "PayrollSourceClaim_one_payer_per_assignment_date_key"
  ON "PayrollSourceClaim" ("employmentAssignmentId", "kind", "workDate")
  WHERE "kind" <> 'LEAVE';
CREATE UNIQUE INDEX "PayrollSourceClaim_one_payer_per_leave_day_key"
  ON "PayrollSourceClaim" ("leaveRequestDayId")
  WHERE "kind" = 'LEAVE';

-- Written once with its run, never updated; a finalized run's claims are permanent.
CREATE TRIGGER "PayrollSourceClaim_prevent_update" BEFORE UPDATE ON "PayrollSourceClaim"
  FOR EACH ROW EXECUTE FUNCTION "prevent_payroll_line_update"();
CREATE TRIGGER "PayrollSourceClaim_guard_final_run" BEFORE INSERT OR DELETE ON "PayrollSourceClaim"
  FOR EACH ROW EXECUTE FUNCTION "guard_final_payroll_run_children"();
