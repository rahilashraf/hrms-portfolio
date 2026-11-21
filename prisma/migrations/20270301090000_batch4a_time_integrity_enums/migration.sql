-- Batch 4A — Time integrity (1/2): the new exception type, kept apart from anything that uses it
-- (PostgreSQL cannot use an enum value in the transaction that added it). Additive only.
--
-- RECORDED_AFTER_APPROVAL: a time entry closed in approved or locked time. Live capture is never
-- refused for that; the entry is flagged for review and stays out of the approved payroll
-- snapshot until the timesheet is reopened and approved again.
ALTER TYPE "AttendanceExceptionType" ADD VALUE 'RECORDED_AFTER_APPROVAL';
