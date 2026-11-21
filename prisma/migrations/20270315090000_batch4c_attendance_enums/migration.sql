-- Batch 4C — Attendance lifecycle (1/2): new enum values, kept apart from anything that uses them
-- (PostgreSQL cannot use an enum value in the transaction that added it). Additive only.
--
-- NO_SHOW: a published shift that started (plus the policy's grace) without any attendance on
-- its assignment. A non-blocking review signal; it never creates punches or changes hours.
ALTER TYPE "AttendanceExceptionType" ADD VALUE 'NO_SHOW';
-- APPROVED: the timesheet-level approval (every segment approved; the payroll snapshot frozen).
ALTER TYPE "TimesheetEventType" ADD VALUE 'APPROVED';
