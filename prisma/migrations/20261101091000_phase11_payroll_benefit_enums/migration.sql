-- Phase 11 — Payroll consumes benefit facts. New enum values get their own migration: they
-- cannot be used in the transaction that adds them.

-- AlterEnum
ALTER TYPE "PayrollContributionCategory" ADD VALUE 'BENEFIT';

-- AlterEnum
ALTER TYPE "PayrollDeductionCategory" ADD VALUE 'BENEFIT';

-- AlterEnum
ALTER TYPE "PayrollSourceKind" ADD VALUE 'BENEFIT_DAY';
