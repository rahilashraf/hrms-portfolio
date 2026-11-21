-- Phase 10 Batch 3: every payroll period references the Time-owned TimePeriod of exactly its
-- organization and dates (the composite foreign key proves both). PayrollPeriod rows only come
-- from period generation, which this same release introduces, so the NOT NULL column is safe.

-- AlterTable
ALTER TABLE "PayrollPeriod" ADD COLUMN     "timePeriodId" UUID NOT NULL,
ADD COLUMN     "timesheetsMaterializedAt" TIMESTAMPTZ(6);

-- CreateIndex
CREATE INDEX "PayrollPeriod_timePeriodId_idx" ON "PayrollPeriod"("timePeriodId");

-- CreateIndex
CREATE UNIQUE INDEX "TimePeriod_id_organizationId_startDate_endDate_key" ON "TimePeriod"("id", "organizationId", "startDate", "endDate");

-- AddForeignKey
ALTER TABLE "PayrollPeriod" ADD CONSTRAINT "PayrollPeriod_timePeriodId_organizationId_periodStart_peri_fkey" FOREIGN KEY ("timePeriodId", "organizationId", "periodStart", "periodEnd") REFERENCES "TimePeriod"("id", "organizationId", "startDate", "endDate") ON DELETE RESTRICT ON UPDATE CASCADE;
