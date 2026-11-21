-- Batch 4D — optional sign-out for sign-in-only (presence) attendance. Additive: one new table,
-- its constraints and triggers. No existing row is changed. Nothing records a sign-out unless a
-- time policy sets attendance.signOutEnabled (off by default).
--
-- A sign-out ends a presence sign-in. It is never payable time and never a TimeEntry. Like
-- sign-ins it is append-only: it can only be voided, once; a correction voids it and records
-- another (MANUAL, with who and why).
-- CreateTable
CREATE TABLE "AttendanceSignOut" (
    "id" UUID NOT NULL,
    "signInId" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "employmentAssignmentId" UUID NOT NULL,
    "signedOutAt" TIMESTAMPTZ(6) NOT NULL,
    "source" "TimePunchSource" NOT NULL,
    "attendanceDeviceId" UUID,
    "idempotencyKey" TEXT,
    "recordedByUserId" UUID,
    "reason" TEXT,
    "status" "AttendanceSignInStatus" NOT NULL DEFAULT 'ACTIVE',
    "voidedAt" TIMESTAMPTZ(6),
    "voidedByUserId" UUID,
    "voidReason" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AttendanceSignOut_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AttendanceSignOut_signInId_idx" ON "AttendanceSignOut"("signInId");

-- CreateIndex
CREATE INDEX "AttendanceSignOut_employmentAssignmentId_signedOutAt_idx" ON "AttendanceSignOut"("employmentAssignmentId", "signedOutAt");

-- CreateIndex
CREATE UNIQUE INDEX "AttendanceSignOut_employeeId_idempotencyKey_key" ON "AttendanceSignOut"("employeeId", "idempotencyKey");


-- Foreign keys: the sign-in (with its employee and assignment), the device, the users.
ALTER TABLE "AttendanceSignOut" ADD CONSTRAINT "AttendanceSignOut_signInId_employeeId_employmentAssignment_fkey" FOREIGN KEY ("signInId", "employeeId", "employmentAssignmentId") REFERENCES "AttendanceSignIn"("id", "employeeId", "employmentAssignmentId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AttendanceSignOut" ADD CONSTRAINT "AttendanceSignOut_attendanceDeviceId_fkey" FOREIGN KEY ("attendanceDeviceId") REFERENCES "AttendanceDevice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AttendanceSignOut" ADD CONSTRAINT "AttendanceSignOut_recordedByUserId_fkey" FOREIGN KEY ("recordedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AttendanceSignOut" ADD CONSTRAINT "AttendanceSignOut_voidedByUserId_fkey" FOREIGN KEY ("voidedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── Shape: like sign-ins ──────────────────────────────────────────────────────────────────
ALTER TABLE "AttendanceSignOut"
  ADD CONSTRAINT "AttendanceSignOut_source_shape_check" CHECK (
    "source" IN ('LIVE_CLOCK', 'KIOSK', 'MANUAL')
    AND ("source" = 'KIOSK') = ("attendanceDeviceId" IS NOT NULL)
    AND ("source" = 'MANUAL') = ("recordedByUserId" IS NOT NULL AND "reason" IS NOT NULL)
  ),
  ADD CONSTRAINT "AttendanceSignOut_reason_check" CHECK (
    ("reason" IS NULL OR btrim("reason") <> '')
    AND ("voidReason" IS NULL OR btrim("voidReason") <> '')
  ),
  ADD CONSTRAINT "AttendanceSignOut_void_shape_check" CHECK (
    ("status" = 'VOIDED') = ("voidedAt" IS NOT NULL)
    AND ("status" <> 'VOIDED' OR ("voidReason" IS NOT NULL AND "voidedByUserId" IS NOT NULL))
  ),
  ADD CONSTRAINT "AttendanceSignOut_idempotency_key_check" CHECK (
    "idempotencyKey" IS NULL OR char_length("idempotencyKey") BETWEEN 1 AND 100
  );

-- One ACTIVE sign-out per sign-in.
CREATE UNIQUE INDEX "AttendanceSignOut_one_active_per_sign_in_key"
  ON "AttendanceSignOut"("signInId")
  WHERE "status" = 'ACTIVE';

-- A sign-out ends an ACTIVE sign-in, after it (at most 24 hours later).
CREATE FUNCTION "check_attendance_sign_out"() RETURNS trigger AS $$
DECLARE
  sign_in RECORD;
BEGIN
  SELECT "status", "signedInAt" INTO sign_in FROM "AttendanceSignIn" WHERE "id" = NEW."signInId" FOR SHARE;
  IF sign_in."status" <> 'ACTIVE' THEN
    RAISE EXCEPTION 'Only an active sign-in can be signed out.' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."signedOutAt" <= sign_in."signedInAt"
     OR NEW."signedOutAt" > sign_in."signedInAt" + interval '24 hours' THEN
    RAISE EXCEPTION 'A sign-out is after its sign-in, within 24 hours.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "AttendanceSignOut_check" BEFORE INSERT ON "AttendanceSignOut"
  FOR EACH ROW EXECUTE FUNCTION "check_attendance_sign_out"();

-- Kiosk sign-outs come from an ACTIVE device of the assignment's organization (the Phase 9.5
-- check shared with punches and sign-ins).
CREATE TRIGGER "AttendanceSignOut_kiosk_device" BEFORE INSERT ON "AttendanceSignOut"
  FOR EACH ROW WHEN (NEW."attendanceDeviceId" IS NOT NULL)
  EXECUTE FUNCTION "check_kiosk_attendance_device"();

-- Never deleted or rewritten: the only change is voiding an ACTIVE sign-out once.
CREATE FUNCTION "prevent_attendance_sign_out_rewrite"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Sign-outs are never deleted; void them.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."status" <> 'ACTIVE' OR NEW."status" <> 'VOIDED' THEN
    RAISE EXCEPTION 'A sign-out can only be voided, once.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."id" <> OLD."id"
    OR NEW."signInId" <> OLD."signInId"
    OR NEW."employeeId" <> OLD."employeeId"
    OR NEW."employmentAssignmentId" <> OLD."employmentAssignmentId"
    OR NEW."signedOutAt" <> OLD."signedOutAt"
    OR NEW."source" <> OLD."source"
    OR NEW."attendanceDeviceId" IS DISTINCT FROM OLD."attendanceDeviceId"
    OR NEW."idempotencyKey" IS DISTINCT FROM OLD."idempotencyKey"
    OR NEW."recordedByUserId" IS DISTINCT FROM OLD."recordedByUserId"
    OR NEW."reason" IS DISTINCT FROM OLD."reason"
    OR NEW."createdAt" <> OLD."createdAt" THEN
    RAISE EXCEPTION 'Sign-outs are immutable; void one and record another to correct it.' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "AttendanceSignOut_prevent_rewrite" BEFORE UPDATE OR DELETE ON "AttendanceSignOut"
  FOR EACH ROW EXECUTE FUNCTION "prevent_attendance_sign_out_rewrite"();
