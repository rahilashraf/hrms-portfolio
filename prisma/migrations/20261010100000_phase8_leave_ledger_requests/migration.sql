-- Phase 8 — leave accounts, the append-only leave ledger, requests, days, events and amendments.
CREATE TYPE "LeaveLedgerEntryType" AS ENUM ('GRANT', 'ACCRUAL', 'USAGE', 'ADJUSTMENT', 'CARRYOVER_FORFEIT', 'EXPIRY', 'REVERSAL');

CREATE TYPE "LeaveLedgerSourceType" AS ENUM ('POLICY', 'LEAVE_REQUEST', 'MANUAL', 'YEAR_END');

CREATE TYPE "LeaveRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');

CREATE TYPE "LeaveDayAmountSource" AS ENUM ('SCHEDULE', 'STANDARD_DAY', 'HOLIDAY_EXCLUDED', 'NON_WORKDAY', 'MANUAL_OVERRIDE');

CREATE TYPE "LeaveRequestEventType" AS ENUM ('SUBMITTED', 'APPROVED', 'REJECTED', 'CANCELLED', 'AMENDED');

CREATE TYPE "LeaveAmendmentType" AS ENUM ('CANCEL', 'SHORTEN');

CREATE TABLE "LeaveAccount" (
    "id" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "employmentAssignmentId" UUID NOT NULL,
    "leaveTypeId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LeaveAccount_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "LeaveLedgerEntry" (
    "id" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "employmentAssignmentId" UUID NOT NULL,
    "leaveTypeId" UUID NOT NULL,
    "entryType" "LeaveLedgerEntryType" NOT NULL,
    "amountMinutes" INTEGER NOT NULL,
    "effectiveDate" DATE NOT NULL,
    "sourceType" "LeaveLedgerSourceType" NOT NULL,
    "policyId" UUID,
    "leaveRequestId" UUID,
    "leaveRequestDayId" UUID,
    "reversesEntryId" UUID,
    "idempotencyKey" TEXT NOT NULL,
    "reason" TEXT,
    "createdByUserId" UUID,
    "postedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LeaveLedgerEntry_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "LeaveRequest" (
    "id" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "employmentAssignmentId" UUID NOT NULL,
    "leaveTypeId" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "status" "LeaveRequestStatus" NOT NULL DEFAULT 'PENDING',
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "startLocalTime" TEXT,
    "endLocalTime" TEXT,
    "timezone" TEXT NOT NULL,
    "reason" TEXT,
    "requestedMinutes" INTEGER NOT NULL,
    "approvedMinutes" INTEGER,
    "requestedByUserId" UUID NOT NULL,
    "submittedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedByUserId" UUID,
    "decidedAt" TIMESTAMPTZ(6),
    "decisionNote" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "LeaveRequest_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "LeaveRequestDay" (
    "id" UUID NOT NULL,
    "requestId" UUID NOT NULL,
    "date" DATE NOT NULL,
    "minutes" INTEGER NOT NULL,
    "amountSource" "LeaveDayAmountSource" NOT NULL,
    "windowStart" TIMESTAMPTZ(6) NOT NULL,
    "windowEnd" TIMESTAMPTZ(6) NOT NULL,
    "absenceStart" TIMESTAMPTZ(6) NOT NULL,
    "absenceEnd" TIMESTAMPTZ(6) NOT NULL,
    "scheduledShiftRevisionIds" UUID[] DEFAULT ARRAY[]::UUID[],
    "holidayName" TEXT,
    "overrideReason" TEXT,
    "cancelledByAmendmentId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LeaveRequestDay_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "LeaveRequestEvent" (
    "id" UUID NOT NULL,
    "requestId" UUID NOT NULL,
    "type" "LeaveRequestEventType" NOT NULL,
    "actorUserId" UUID,
    "note" TEXT,
    "metadata" JSONB,
    "occurredAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LeaveRequestEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "LeaveRequestAmendment" (
    "id" UUID NOT NULL,
    "requestId" UUID NOT NULL,
    "type" "LeaveAmendmentType" NOT NULL,
    "reason" TEXT NOT NULL,
    "cancelledMinutes" INTEGER NOT NULL,
    "actorUserId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LeaveRequestAmendment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "LeaveAccount_employeeId_idx" ON "LeaveAccount"("employeeId");

CREATE INDEX "LeaveAccount_leaveTypeId_idx" ON "LeaveAccount"("leaveTypeId");

CREATE UNIQUE INDEX "LeaveAccount_employmentAssignmentId_leaveTypeId_key" ON "LeaveAccount"("employmentAssignmentId", "leaveTypeId");

CREATE UNIQUE INDEX "LeaveAccount_id_employmentAssignmentId_leaveTypeId_key" ON "LeaveAccount"("id", "employmentAssignmentId", "leaveTypeId");

CREATE UNIQUE INDEX "LeaveLedgerEntry_reversesEntryId_key" ON "LeaveLedgerEntry"("reversesEntryId");

CREATE UNIQUE INDEX "LeaveLedgerEntry_idempotencyKey_key" ON "LeaveLedgerEntry"("idempotencyKey");

CREATE INDEX "LeaveLedgerEntry_accountId_effectiveDate_idx" ON "LeaveLedgerEntry"("accountId", "effectiveDate");

CREATE INDEX "LeaveLedgerEntry_employeeId_effectiveDate_idx" ON "LeaveLedgerEntry"("employeeId", "effectiveDate");

CREATE INDEX "LeaveLedgerEntry_leaveRequestId_idx" ON "LeaveLedgerEntry"("leaveRequestId");

CREATE INDEX "LeaveRequest_employmentAssignmentId_startDate_endDate_idx" ON "LeaveRequest"("employmentAssignmentId", "startDate", "endDate");

CREATE INDEX "LeaveRequest_employeeId_status_startDate_idx" ON "LeaveRequest"("employeeId", "status", "startDate");

CREATE INDEX "LeaveRequest_status_startDate_idx" ON "LeaveRequest"("status", "startDate");

CREATE INDEX "LeaveRequestDay_date_idx" ON "LeaveRequestDay"("date");

CREATE UNIQUE INDEX "LeaveRequestDay_requestId_date_key" ON "LeaveRequestDay"("requestId", "date");

CREATE INDEX "LeaveRequestEvent_requestId_occurredAt_idx" ON "LeaveRequestEvent"("requestId", "occurredAt");

CREATE INDEX "LeaveRequestAmendment_requestId_createdAt_idx" ON "LeaveRequestAmendment"("requestId", "createdAt");

ALTER TABLE "LeaveAccount" ADD CONSTRAINT "LeaveAccount_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "LeaveAccount" ADD CONSTRAINT "LeaveAccount_employmentAssignmentId_employeeId_fkey" FOREIGN KEY ("employmentAssignmentId", "employeeId") REFERENCES "EmploymentAssignment"("id", "employeeId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "LeaveAccount" ADD CONSTRAINT "LeaveAccount_leaveTypeId_fkey" FOREIGN KEY ("leaveTypeId") REFERENCES "LeaveType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "LeaveLedgerEntry" ADD CONSTRAINT "LeaveLedgerEntry_accountId_employmentAssignmentId_leaveTyp_fkey" FOREIGN KEY ("accountId", "employmentAssignmentId", "leaveTypeId") REFERENCES "LeaveAccount"("id", "employmentAssignmentId", "leaveTypeId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "LeaveLedgerEntry" ADD CONSTRAINT "LeaveLedgerEntry_reversesEntryId_fkey" FOREIGN KEY ("reversesEntryId") REFERENCES "LeaveLedgerEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "LeaveLedgerEntry" ADD CONSTRAINT "LeaveLedgerEntry_leaveRequestId_fkey" FOREIGN KEY ("leaveRequestId") REFERENCES "LeaveRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "LeaveLedgerEntry" ADD CONSTRAINT "LeaveLedgerEntry_leaveRequestDayId_fkey" FOREIGN KEY ("leaveRequestDayId") REFERENCES "LeaveRequestDay"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "LeaveLedgerEntry" ADD CONSTRAINT "LeaveLedgerEntry_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "LeaveRequest" ADD CONSTRAINT "LeaveRequest_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "LeaveRequest" ADD CONSTRAINT "LeaveRequest_employmentAssignmentId_employeeId_fkey" FOREIGN KEY ("employmentAssignmentId", "employeeId") REFERENCES "EmploymentAssignment"("id", "employeeId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "LeaveRequest" ADD CONSTRAINT "LeaveRequest_accountId_employmentAssignmentId_leaveTypeId_fkey" FOREIGN KEY ("accountId", "employmentAssignmentId", "leaveTypeId") REFERENCES "LeaveAccount"("id", "employmentAssignmentId", "leaveTypeId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "LeaveRequest" ADD CONSTRAINT "LeaveRequest_requestedByUserId_fkey" FOREIGN KEY ("requestedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "LeaveRequest" ADD CONSTRAINT "LeaveRequest_decidedByUserId_fkey" FOREIGN KEY ("decidedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "LeaveRequestDay" ADD CONSTRAINT "LeaveRequestDay_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "LeaveRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "LeaveRequestDay" ADD CONSTRAINT "LeaveRequestDay_cancelledByAmendmentId_fkey" FOREIGN KEY ("cancelledByAmendmentId") REFERENCES "LeaveRequestAmendment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "LeaveRequestEvent" ADD CONSTRAINT "LeaveRequestEvent_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "LeaveRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "LeaveRequestEvent" ADD CONSTRAINT "LeaveRequestEvent_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "LeaveRequestAmendment" ADD CONSTRAINT "LeaveRequestAmendment_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "LeaveRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "LeaveRequestAmendment" ADD CONSTRAINT "LeaveRequestAmendment_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "LeaveLedgerEntry"
  ADD CONSTRAINT "LeaveLedgerEntry_amount_nonzero_check" CHECK ("amountMinutes" <> 0),
  ADD CONSTRAINT "LeaveLedgerEntry_reversal_shape_check" CHECK (("entryType" = 'REVERSAL') = ("reversesEntryId" IS NOT NULL)),
  ADD CONSTRAINT "LeaveLedgerEntry_sign_check" CHECK (
    ("entryType" IN ('GRANT', 'ACCRUAL') AND "amountMinutes" > 0) OR
    ("entryType" IN ('USAGE', 'CARRYOVER_FORFEIT', 'EXPIRY') AND "amountMinutes" < 0) OR
    "entryType" IN ('ADJUSTMENT', 'REVERSAL')
  ),
  ADD CONSTRAINT "LeaveLedgerEntry_reason_required_check" CHECK (
    "entryType" NOT IN ('ADJUSTMENT', 'REVERSAL') OR ("reason" IS NOT NULL AND btrim("reason") <> '')
  ),
  ADD CONSTRAINT "LeaveLedgerEntry_usage_source_check" CHECK (
    ("entryType" <> 'USAGE' OR ("leaveRequestId" IS NOT NULL AND "leaveRequestDayId" IS NOT NULL))
    AND ("leaveRequestDayId" IS NULL OR "leaveRequestId" IS NOT NULL)
  ),
  ADD CONSTRAINT "LeaveLedgerEntry_idempotency_key_not_blank_check" CHECK (btrim("idempotencyKey") <> '');

ALTER TABLE "LeaveRequest"
  ADD CONSTRAINT "LeaveRequest_range_check" CHECK ("endDate" >= "startDate"),
  ADD CONSTRAINT "LeaveRequest_partial_day_check" CHECK (
    ("startLocalTime" IS NULL AND "endLocalTime" IS NULL) OR
    ("startLocalTime" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND "endLocalTime" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
      AND "startLocalTime" < "endLocalTime" AND "startDate" = "endDate")
  ),
  ADD CONSTRAINT "LeaveRequest_minutes_check" CHECK ("requestedMinutes" >= 0 AND ("approvedMinutes" IS NULL OR "approvedMinutes" >= 0)),
  ADD CONSTRAINT "LeaveRequest_timezone_not_blank_check" CHECK (btrim("timezone") <> ''),
  ADD CONSTRAINT "LeaveRequest_status_shape_check" CHECK (
    ("status" = 'PENDING' AND "decidedByUserId" IS NULL AND "decidedAt" IS NULL AND "approvedMinutes" IS NULL) OR
    ("status" = 'APPROVED' AND "decidedByUserId" IS NOT NULL AND "decidedAt" IS NOT NULL AND "approvedMinutes" IS NOT NULL) OR
    ("status" = 'REJECTED' AND "decidedByUserId" IS NOT NULL AND "decidedAt" IS NOT NULL AND "approvedMinutes" IS NULL) OR
    "status" = 'CANCELLED'
  );

ALTER TABLE "LeaveRequestDay"
  ADD CONSTRAINT "LeaveRequestDay_minutes_check" CHECK ("minutes" BETWEEN 0 AND 2880),
  ADD CONSTRAINT "LeaveRequestDay_window_check" CHECK ("windowEnd" > "windowStart"),
  ADD CONSTRAINT "LeaveRequestDay_absence_covers_window_check" CHECK ("absenceStart" <= "windowStart" AND "absenceEnd" >= "windowEnd"),
  ADD CONSTRAINT "LeaveRequestDay_override_reason_check" CHECK (
    ("amountSource" = 'MANUAL_OVERRIDE') = ("overrideReason" IS NOT NULL AND btrim("overrideReason") <> '')
  ),
  ADD CONSTRAINT "LeaveRequestDay_revisions_not_null_check" CHECK ("scheduledShiftRevisionIds" IS NOT NULL);

ALTER TABLE "LeaveRequestAmendment"
  ADD CONSTRAINT "LeaveRequestAmendment_reason_not_blank_check" CHECK (btrim("reason") <> ''),
  ADD CONSTRAINT "LeaveRequestAmendment_minutes_check" CHECK ("cancelledMinutes" >= 0);

-- Append-only history: ledger entries, request events and amendments are never updated or deleted.
CREATE FUNCTION "prevent_leave_history_mutation"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "LeaveLedgerEntry_prevent_update" BEFORE UPDATE ON "LeaveLedgerEntry"
  FOR EACH ROW EXECUTE FUNCTION "prevent_leave_history_mutation"();
CREATE TRIGGER "LeaveLedgerEntry_prevent_delete" BEFORE DELETE ON "LeaveLedgerEntry"
  FOR EACH ROW EXECUTE FUNCTION "prevent_leave_history_mutation"();
CREATE TRIGGER "LeaveRequestEvent_prevent_update" BEFORE UPDATE ON "LeaveRequestEvent"
  FOR EACH ROW EXECUTE FUNCTION "prevent_leave_history_mutation"();
CREATE TRIGGER "LeaveRequestEvent_prevent_delete" BEFORE DELETE ON "LeaveRequestEvent"
  FOR EACH ROW EXECUTE FUNCTION "prevent_leave_history_mutation"();
CREATE TRIGGER "LeaveRequestAmendment_prevent_update" BEFORE UPDATE ON "LeaveRequestAmendment"
  FOR EACH ROW EXECUTE FUNCTION "prevent_leave_history_mutation"();
CREATE TRIGGER "LeaveRequestAmendment_prevent_delete" BEFORE DELETE ON "LeaveRequestAmendment"
  FOR EACH ROW EXECUTE FUNCTION "prevent_leave_history_mutation"();

-- A reversal exactly negates one non-reversal entry of the same account.
CREATE FUNCTION "check_leave_ledger_reversal"() RETURNS trigger AS $$
DECLARE
  original RECORD;
BEGIN
  IF NEW."reversesEntryId" IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT "accountId", "amountMinutes", "entryType" INTO original
  FROM "LeaveLedgerEntry" WHERE "id" = NEW."reversesEntryId";
  IF NOT FOUND OR original."accountId" <> NEW."accountId" THEN
    RAISE EXCEPTION 'A leave ledger reversal must reference an entry of the same account';
  END IF;
  IF original."entryType" = 'REVERSAL' THEN
    RAISE EXCEPTION 'A leave ledger reversal cannot itself be reversed';
  END IF;
  IF NEW."amountMinutes" <> -original."amountMinutes" THEN
    RAISE EXCEPTION 'A leave ledger reversal must exactly negate the original amount';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "LeaveLedgerEntry_check_reversal" BEFORE INSERT ON "LeaveLedgerEntry"
  FOR EACH ROW EXECUTE FUNCTION "check_leave_ledger_reversal"();

-- Request days are sized freely while the request is PENDING and frozen afterwards: the only
-- later change is recording, once, the amendment that cancelled the day.
CREATE FUNCTION "guard_leave_request_day"() RETURNS trigger AS $$
DECLARE
  request_status "LeaveRequestStatus";
BEGIN
  SELECT "status" INTO request_status FROM "LeaveRequest" WHERE "id" = OLD."requestId";
  IF request_status = 'PENDING' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    IF NEW."requestId" <> OLD."requestId" OR NEW."date" <> OLD."date" OR NEW."cancelledByAmendmentId" IS NOT NULL THEN
      RAISE EXCEPTION 'LeaveRequestDay identity cannot change';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'LeaveRequestDay rows of a decided request are immutable';
  END IF;
  IF OLD."cancelledByAmendmentId" IS NULL AND NEW."cancelledByAmendmentId" IS NOT NULL
     AND (to_jsonb(NEW) - 'cancelledByAmendmentId') = (to_jsonb(OLD) - 'cancelledByAmendmentId') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'LeaveRequestDay rows of a decided request are immutable';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "LeaveRequestDay_guard" BEFORE UPDATE OR DELETE ON "LeaveRequestDay"
  FOR EACH ROW EXECUTE FUNCTION "guard_leave_request_day"();
