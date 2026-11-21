-- Phase 9.5 — Attendance kiosk and sign-in mode (1/2): new enum values.
-- Kept apart from the tables and constraints that use them: PostgreSQL cannot use an enum value
-- in the transaction that added it.
-- TimeEntrySource / TimePunchSource gain KIOSK (live capture at a trusted onsite device;
-- LIVE_CLOCK keeps meaning authenticated self-service). AttendanceExceptionType gains the
-- presence signals of SIGN_IN_ONLY attendance.

ALTER TYPE "AttendanceExceptionType" ADD VALUE 'LATE_SIGN_IN';
ALTER TYPE "AttendanceExceptionType" ADD VALUE 'UNSCHEDULED_SIGN_IN';
ALTER TYPE "TimeEntrySource" ADD VALUE 'KIOSK';
ALTER TYPE "TimePunchSource" ADD VALUE 'KIOSK';
