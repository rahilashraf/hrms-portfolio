-- TimePunch is immutable raw evidence. Its link to a TimeEntry used to include the entry's
-- employmentAssignmentId with ON UPDATE CASCADE, so a CHANGE_ASSIGNMENT correction tried to
-- rewrite every punch of the entry and the immutability trigger rejected the correction.
--
-- A punch still belongs to exactly one TimeEntry of the same employee, but keeps the
-- assignment it recorded (still enforced against EmploymentAssignment by
-- "TimePunch_employmentAssignmentId_employeeId_fkey"). After a correction the punch and entry
-- assignments may differ: that is provenance, not corruption. Nothing cascades into punches.
CREATE UNIQUE INDEX "TimeEntry_id_employeeId_key" ON "TimeEntry"("id", "employeeId");

ALTER TABLE "TimePunch"
  DROP CONSTRAINT "TimePunch_timeEntryId_employeeId_employmentAssignmentId_fkey";

ALTER TABLE "TimePunch"
  ADD CONSTRAINT "TimePunch_timeEntryId_employeeId_fkey"
  FOREIGN KEY ("timeEntryId", "employeeId") REFERENCES "TimeEntry"("id", "employeeId") ON DELETE RESTRICT ON UPDATE RESTRICT;
