-- Phase 9.5 — Attendance kiosk and sign-in mode (2/2): devices, credentials, sign-ins.

-- CreateEnum
CREATE TYPE "AttendanceDeviceStatus" AS ENUM ('ACTIVE', 'DISABLED', 'REVOKED');

-- CreateEnum
CREATE TYPE "AttendanceCredentialType" AS ENUM ('PIN');

-- CreateEnum
CREATE TYPE "AttendanceCredentialStatus" AS ENUM ('ACTIVE', 'REVOKED');

-- CreateEnum
CREATE TYPE "AttendanceSignInStatus" AS ENUM ('ACTIVE', 'VOIDED');

-- AlterTable
ALTER TABLE "AttendanceException" ADD COLUMN     "attendanceSignInId" UUID;

-- AlterTable
ALTER TABLE "TimePunch" ADD COLUMN     "attendanceDeviceId" UUID;

-- CreateTable
CREATE TABLE "AttendanceDevice" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "workLocationId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "status" "AttendanceDeviceStatus" NOT NULL DEFAULT 'ACTIVE',
    "credentialHash" TEXT,
    "credentialIssuedAt" TIMESTAMPTZ(6),
    "enrollmentCodeHash" TEXT,
    "enrollmentExpiresAt" TIMESTAMPTZ(6),
    "lastSeenAt" TIMESTAMPTZ(6),
    "lastSeenIp" TEXT,
    "lastSeenUserAgent" TEXT,
    "createdByUserId" UUID,
    "revokedAt" TIMESTAMPTZ(6),
    "revokedByUserId" UUID,
    "revokedReason" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "AttendanceDevice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttendanceCredential" (
    "id" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "type" "AttendanceCredentialType" NOT NULL,
    "status" "AttendanceCredentialStatus" NOT NULL DEFAULT 'ACTIVE',
    "secretHash" TEXT,
    "lookupHash" TEXT,
    "failedAttempts" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMPTZ(6),
    "lastUsedAt" TIMESTAMPTZ(6),
    "issuedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "issuedByUserId" UUID,
    "revokedAt" TIMESTAMPTZ(6),
    "revokedByUserId" UUID,
    "revokedReason" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "AttendanceCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttendanceSignIn" (
    "id" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "employmentAssignmentId" UUID NOT NULL,
    "signedInAt" TIMESTAMPTZ(6) NOT NULL,
    "timezone" TEXT NOT NULL,
    "workDate" DATE NOT NULL,
    "source" "TimePunchSource" NOT NULL,
    "attendanceDeviceId" UUID,
    "workLocationId" UUID,
    "scheduledShiftId" UUID,
    "scheduledShiftRevisionId" UUID,
    "idempotencyKey" TEXT,
    "status" "AttendanceSignInStatus" NOT NULL DEFAULT 'ACTIVE',
    "voidedAt" TIMESTAMPTZ(6),
    "voidedByUserId" UUID,
    "voidReason" TEXT,
    "replacesSignInId" UUID,
    "recordedByUserId" UUID,
    "reason" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AttendanceSignIn_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AttendanceDevice_credentialHash_key" ON "AttendanceDevice"("credentialHash");

-- CreateIndex
CREATE UNIQUE INDEX "AttendanceDevice_enrollmentCodeHash_key" ON "AttendanceDevice"("enrollmentCodeHash");

-- CreateIndex
CREATE INDEX "AttendanceDevice_organizationId_status_idx" ON "AttendanceDevice"("organizationId", "status");

-- CreateIndex
CREATE INDEX "AttendanceDevice_workLocationId_idx" ON "AttendanceDevice"("workLocationId");

-- CreateIndex
CREATE UNIQUE INDEX "AttendanceDevice_organizationId_name_key" ON "AttendanceDevice"("organizationId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "AttendanceCredential_lookupHash_key" ON "AttendanceCredential"("lookupHash");

-- CreateIndex
CREATE INDEX "AttendanceCredential_employeeId_type_status_idx" ON "AttendanceCredential"("employeeId", "type", "status");

-- CreateIndex
CREATE UNIQUE INDEX "AttendanceSignIn_replacesSignInId_key" ON "AttendanceSignIn"("replacesSignInId");

-- CreateIndex
CREATE INDEX "AttendanceSignIn_employmentAssignmentId_workDate_idx" ON "AttendanceSignIn"("employmentAssignmentId", "workDate");

-- CreateIndex
CREATE INDEX "AttendanceSignIn_employeeId_signedInAt_idx" ON "AttendanceSignIn"("employeeId", "signedInAt");

-- CreateIndex
CREATE INDEX "AttendanceSignIn_scheduledShiftId_idx" ON "AttendanceSignIn"("scheduledShiftId");

-- CreateIndex
CREATE INDEX "AttendanceSignIn_workDate_idx" ON "AttendanceSignIn"("workDate");

-- CreateIndex
CREATE UNIQUE INDEX "AttendanceSignIn_id_employeeId_employmentAssignmentId_key" ON "AttendanceSignIn"("id", "employeeId", "employmentAssignmentId");

-- CreateIndex
CREATE UNIQUE INDEX "AttendanceSignIn_employeeId_idempotencyKey_key" ON "AttendanceSignIn"("employeeId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "AttendanceException_attendanceSignInId_type_status_idx" ON "AttendanceException"("attendanceSignInId", "type", "status");

-- CreateIndex
CREATE INDEX "TimePunch_attendanceDeviceId_occurredAt_idx" ON "TimePunch"("attendanceDeviceId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "WorkLocation_id_organizationId_key" ON "WorkLocation"("id", "organizationId");

-- AddForeignKey
ALTER TABLE "TimePunch" ADD CONSTRAINT "TimePunch_attendanceDeviceId_fkey" FOREIGN KEY ("attendanceDeviceId") REFERENCES "AttendanceDevice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceException" ADD CONSTRAINT "AttendanceException_attendanceSignInId_employeeId_employme_fkey" FOREIGN KEY ("attendanceSignInId", "employeeId", "employmentAssignmentId") REFERENCES "AttendanceSignIn"("id", "employeeId", "employmentAssignmentId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceDevice" ADD CONSTRAINT "AttendanceDevice_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceDevice" ADD CONSTRAINT "AttendanceDevice_workLocationId_organizationId_fkey" FOREIGN KEY ("workLocationId", "organizationId") REFERENCES "WorkLocation"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceDevice" ADD CONSTRAINT "AttendanceDevice_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceDevice" ADD CONSTRAINT "AttendanceDevice_revokedByUserId_fkey" FOREIGN KEY ("revokedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceCredential" ADD CONSTRAINT "AttendanceCredential_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceCredential" ADD CONSTRAINT "AttendanceCredential_issuedByUserId_fkey" FOREIGN KEY ("issuedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceCredential" ADD CONSTRAINT "AttendanceCredential_revokedByUserId_fkey" FOREIGN KEY ("revokedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceSignIn" ADD CONSTRAINT "AttendanceSignIn_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceSignIn" ADD CONSTRAINT "AttendanceSignIn_employmentAssignmentId_employeeId_fkey" FOREIGN KEY ("employmentAssignmentId", "employeeId") REFERENCES "EmploymentAssignment"("id", "employeeId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceSignIn" ADD CONSTRAINT "AttendanceSignIn_attendanceDeviceId_fkey" FOREIGN KEY ("attendanceDeviceId") REFERENCES "AttendanceDevice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceSignIn" ADD CONSTRAINT "AttendanceSignIn_workLocationId_fkey" FOREIGN KEY ("workLocationId") REFERENCES "WorkLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceSignIn" ADD CONSTRAINT "AttendanceSignIn_scheduledShiftId_fkey" FOREIGN KEY ("scheduledShiftId") REFERENCES "ScheduledShift"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceSignIn" ADD CONSTRAINT "AttendanceSignIn_scheduledShiftRevisionId_scheduledShiftId_fkey" FOREIGN KEY ("scheduledShiftRevisionId", "scheduledShiftId") REFERENCES "ScheduledShiftRevision"("id", "scheduledShiftId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceSignIn" ADD CONSTRAINT "AttendanceSignIn_replacesSignInId_fkey" FOREIGN KEY ("replacesSignInId") REFERENCES "AttendanceSignIn"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceSignIn" ADD CONSTRAINT "AttendanceSignIn_recordedByUserId_fkey" FOREIGN KEY ("recordedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceSignIn" ADD CONSTRAINT "AttendanceSignIn_voidedByUserId_fkey" FOREIGN KEY ("voidedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── Integrity ───────────────────────────────────────────────────────────────

-- Attendance devices: a REVOKED device is final, holds no secret and records who and why.
ALTER TABLE "AttendanceDevice"
  ADD CONSTRAINT "AttendanceDevice_name_check" CHECK (btrim("name") <> ''),
  ADD CONSTRAINT "AttendanceDevice_credential_shape_check" CHECK (
    ("credentialHash" IS NULL) = ("credentialIssuedAt" IS NULL)
  ),
  ADD CONSTRAINT "AttendanceDevice_enrollment_shape_check" CHECK (
    ("enrollmentCodeHash" IS NULL) = ("enrollmentExpiresAt" IS NULL)
  ),
  ADD CONSTRAINT "AttendanceDevice_revocation_shape_check" CHECK (
    ("status" = 'REVOKED') = ("revokedAt" IS NOT NULL)
    AND (
      "status" <> 'REVOKED'
      OR (
        "revokedReason" IS NOT NULL AND btrim("revokedReason") <> ''
        AND "credentialHash" IS NULL AND "enrollmentCodeHash" IS NULL
      )
    )
  );

-- A device's work location must be usable (not archived, with a timezone: kiosk attendance is
-- dated in it), and a revoked device is never changed or deleted.
CREATE FUNCTION "guard_attendance_device"() RETURNS trigger AS $$
DECLARE
  location RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Attendance devices are never deleted; revoke them.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."status" = 'REVOKED' THEN
    RAISE EXCEPTION 'A revoked attendance device is final.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'INSERT' OR NEW."workLocationId" IS DISTINCT FROM OLD."workLocationId" THEN
    SELECT "archivedAt", "timezone" INTO location FROM "WorkLocation" WHERE "id" = NEW."workLocationId";
    IF location."archivedAt" IS NOT NULL OR location."timezone" IS NULL OR btrim(location."timezone") = '' THEN
      RAISE EXCEPTION 'An attendance device needs an active work location with a timezone.' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "AttendanceDevice_guard" BEFORE INSERT OR UPDATE OR DELETE ON "AttendanceDevice"
  FOR EACH ROW EXECUTE FUNCTION "guard_attendance_device"();

-- Attendance credentials: one ACTIVE per employee and type; a PIN is a hash only; revoked
-- credentials are frozen history.
ALTER TABLE "AttendanceCredential"
  ADD CONSTRAINT "AttendanceCredential_secret_shape_check" CHECK (
    "type" <> 'PIN' OR ("secretHash" IS NOT NULL AND "lookupHash" IS NULL)
  ),
  ADD CONSTRAINT "AttendanceCredential_failed_attempts_check" CHECK ("failedAttempts" >= 0),
  ADD CONSTRAINT "AttendanceCredential_revocation_shape_check" CHECK (
    ("status" = 'REVOKED') = ("revokedAt" IS NOT NULL)
  );

CREATE UNIQUE INDEX "AttendanceCredential_one_active_per_employee_type_key"
  ON "AttendanceCredential"("employeeId", "type")
  WHERE "status" = 'ACTIVE';

CREATE FUNCTION "guard_attendance_credential"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Attendance credentials are never deleted; revoke them.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."status" = 'REVOKED' THEN
    RAISE EXCEPTION 'A revoked attendance credential is final.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."employeeId" <> OLD."employeeId"
    OR NEW."type" <> OLD."type"
    OR NEW."secretHash" IS DISTINCT FROM OLD."secretHash"
    OR NEW."lookupHash" IS DISTINCT FROM OLD."lookupHash"
    OR NEW."issuedAt" <> OLD."issuedAt"
    OR NEW."issuedByUserId" IS DISTINCT FROM OLD."issuedByUserId" THEN
    RAISE EXCEPTION 'An attendance credential''s secret is fixed; reset it by issuing a new credential.' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "AttendanceCredential_guard" BEFORE UPDATE OR DELETE ON "AttendanceCredential"
  FOR EACH ROW EXECUTE FUNCTION "guard_attendance_credential"();

-- Sign-ins: completed presence facts. Their source is explicit: KIOSK always names its device,
-- MANUAL always names who recorded it and why, and nothing else carries a device.
ALTER TABLE "AttendanceSignIn"
  ADD CONSTRAINT "AttendanceSignIn_timezone_check" CHECK (btrim("timezone") <> ''),
  ADD CONSTRAINT "AttendanceSignIn_source_shape_check" CHECK (
    ("source" = 'KIOSK') = ("attendanceDeviceId" IS NOT NULL)
    AND ("source" <> 'MANUAL' OR ("recordedByUserId" IS NOT NULL AND "reason" IS NOT NULL))
    AND ("replacesSignInId" IS NULL OR "source" = 'MANUAL')
  ),
  ADD CONSTRAINT "AttendanceSignIn_reason_check" CHECK (
    ("reason" IS NULL OR btrim("reason") <> '')
    AND ("voidReason" IS NULL OR btrim("voidReason") <> '')
  ),
  ADD CONSTRAINT "AttendanceSignIn_schedule_link_shape_check" CHECK (
    ("scheduledShiftId" IS NULL) = ("scheduledShiftRevisionId" IS NULL)
  ),
  ADD CONSTRAINT "AttendanceSignIn_void_shape_check" CHECK (
    ("status" = 'VOIDED') = ("voidedAt" IS NOT NULL)
    AND ("status" <> 'VOIDED' OR ("voidReason" IS NOT NULL AND "voidedByUserId" IS NOT NULL))
  ),
  ADD CONSTRAINT "AttendanceSignIn_idempotency_key_check" CHECK (
    "idempotencyKey" IS NULL OR char_length("idempotencyKey") BETWEEN 1 AND 100
  );

-- One attended occurrence is one sign-in: at most one ACTIVE sign-in per published shift.
CREATE UNIQUE INDEX "AttendanceSignIn_one_active_per_shift_key"
  ON "AttendanceSignIn"("scheduledShiftId")
  WHERE "scheduledShiftId" IS NOT NULL AND "status" = 'ACTIVE';

-- Never deleted or rewritten: the only change is voiding an ACTIVE sign-in once.
CREATE FUNCTION "prevent_attendance_sign_in_rewrite"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Sign-ins are never deleted; void them.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."status" <> 'ACTIVE' OR NEW."status" <> 'VOIDED' THEN
    RAISE EXCEPTION 'A sign-in can only be voided, once.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."id" <> OLD."id"
    OR NEW."employeeId" <> OLD."employeeId"
    OR NEW."employmentAssignmentId" <> OLD."employmentAssignmentId"
    OR NEW."signedInAt" <> OLD."signedInAt"
    OR NEW."timezone" <> OLD."timezone"
    OR NEW."workDate" <> OLD."workDate"
    OR NEW."source" <> OLD."source"
    OR NEW."attendanceDeviceId" IS DISTINCT FROM OLD."attendanceDeviceId"
    OR NEW."workLocationId" IS DISTINCT FROM OLD."workLocationId"
    OR NEW."scheduledShiftId" IS DISTINCT FROM OLD."scheduledShiftId"
    OR NEW."scheduledShiftRevisionId" IS DISTINCT FROM OLD."scheduledShiftRevisionId"
    OR NEW."idempotencyKey" IS DISTINCT FROM OLD."idempotencyKey"
    OR NEW."replacesSignInId" IS DISTINCT FROM OLD."replacesSignInId"
    OR NEW."recordedByUserId" IS DISTINCT FROM OLD."recordedByUserId"
    OR NEW."reason" IS DISTINCT FROM OLD."reason"
    OR NEW."createdAt" <> OLD."createdAt" THEN
    RAISE EXCEPTION 'Sign-ins are immutable; void and replace one to correct it.' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "AttendanceSignIn_prevent_rewrite" BEFORE UPDATE OR DELETE ON "AttendanceSignIn"
  FOR EACH ROW EXECUTE FUNCTION "prevent_attendance_sign_in_rewrite"();

-- Defence in depth for kiosk capture: a KIOSK punch or sign-in comes from an ACTIVE device of
-- the assignment's organization (the application share-locks the device row first, so a
-- revocation committed earlier always wins), and a sign-in never lands on a cancelled
-- assignment.
CREATE FUNCTION "check_kiosk_attendance_device"() RETURNS trigger AS $$
DECLARE
  device RECORD;
  assignment RECORD;
BEGIN
  SELECT ea."status", p."organizationId" INTO assignment
    FROM "EmploymentAssignment" ea JOIN "Position" p ON p."id" = ea."positionId"
    WHERE ea."id" = NEW."employmentAssignmentId";
  IF TG_TABLE_NAME = 'AttendanceSignIn' AND assignment."status" = 'CANCELLED' THEN
    RAISE EXCEPTION 'A cancelled assignment has no attendance.' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."attendanceDeviceId" IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT "status", "organizationId" INTO device FROM "AttendanceDevice" WHERE "id" = NEW."attendanceDeviceId";
  IF device."status" <> 'ACTIVE' THEN
    RAISE EXCEPTION 'Only an active attendance device records attendance.' USING ERRCODE = 'check_violation';
  END IF;
  IF device."organizationId" <> assignment."organizationId" THEN
    RAISE EXCEPTION 'An attendance device records attendance for its own organization only.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "AttendanceSignIn_kiosk_device" BEFORE INSERT ON "AttendanceSignIn"
  FOR EACH ROW EXECUTE FUNCTION "check_kiosk_attendance_device"();

CREATE TRIGGER "TimePunch_kiosk_device" BEFORE INSERT ON "TimePunch"
  FOR EACH ROW WHEN (NEW."attendanceDeviceId" IS NOT NULL)
  EXECUTE FUNCTION "check_kiosk_attendance_device"();

-- Punches: KIOSK iff captured by a device (existing rows are LIVE_CLOCK/MANUAL/SYSTEM without one).
ALTER TABLE "TimePunch"
  ADD CONSTRAINT "TimePunch_kiosk_device_shape_check" CHECK (
    ("source" = 'KIOSK') = ("attendanceDeviceId" IS NOT NULL)
  );

-- Exceptions now link to a time entry or a sign-in (never both), always with the assignment;
-- presence signals belong to sign-ins only, so a sign-in can never carry clock-out or break
-- exceptions.
ALTER TABLE "AttendanceException" DROP CONSTRAINT "AttendanceException_entry_assignment_shape_check";
ALTER TABLE "AttendanceException"
  ADD CONSTRAINT "AttendanceException_subject_shape_check" CHECK (
    NOT ("timeEntryId" IS NOT NULL AND "attendanceSignInId" IS NOT NULL)
    AND (("timeEntryId" IS NOT NULL OR "attendanceSignInId" IS NOT NULL) = ("employmentAssignmentId" IS NOT NULL))
  ),
  ADD CONSTRAINT "AttendanceException_sign_in_type_check" CHECK (
    ("type" IN ('LATE_SIGN_IN', 'UNSCHEDULED_SIGN_IN')) = ("attendanceSignInId" IS NOT NULL)
  );

CREATE UNIQUE INDEX "AttendanceException_one_open_per_sign_in_type_key"
  ON "AttendanceException"("attendanceSignInId", "type")
  WHERE "attendanceSignInId" IS NOT NULL AND "status" = 'OPEN';
