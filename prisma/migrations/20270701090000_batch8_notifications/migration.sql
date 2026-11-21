-- Batch 8 — Notifications: one narrow, additive migration.
--
-- N2: a TIME notification category (separate from SCHEDULING). Existing preferences and
--     organization settings are untouched; TIME has none until a user or organization sets one
--     (default: email on, like every other non-mandatory category). The existing check
--     constraints (no preference or organization setting for SECURITY / HR_REQUIRED) apply.
-- D2 / O1: two suppression reasons: no email provider configured; email expired unsent.
-- D1: an UNCERTAIN attempt status (a send that timed out; it may have been delivered).
-- N1: durable checkpoints of the event notification producers, and cursor indexes on the
--     committed domain records they read (no event journal; no business table changes).
-- N5: an index for the organization delivery log.
--
-- New enum values are not used in this migration (PostgreSQL requires a commit first).

ALTER TYPE "NotificationCategory" ADD VALUE 'TIME' AFTER 'SCHEDULING';
ALTER TYPE "NotificationSuppressionReason" ADD VALUE 'EMAIL_PROVIDER_NOT_CONFIGURED';
ALTER TYPE "NotificationSuppressionReason" ADD VALUE 'DELIVERY_EXPIRED';
ALTER TYPE "NotificationAttemptStatus" ADD VALUE 'UNCERTAIN';

CREATE TABLE "NotificationProducerCheckpoint" (
    "producerKey" TEXT NOT NULL,
    "cursorAt" TIMESTAMPTZ(6) NOT NULL,
    "cursorId" UUID NOT NULL,
    "bootstrappedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "NotificationProducerCheckpoint_pkey" PRIMARY KEY ("producerKey"),
    CONSTRAINT "NotificationProducerCheckpoint_key_check" CHECK ("producerKey" ~ '^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$' AND length("producerKey") <= 100)
);

-- A checkpoint only moves forward (a replay never rewinds it; an operator may delete one to
-- re-bootstrap at the current horizon, which never notifies history).
CREATE FUNCTION guard_notification_producer_checkpoint() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW."cursorAt", NEW."cursorId") < ROW(OLD."cursorAt", OLD."cursorId")
     OR NEW."bootstrappedAt" <> OLD."bootstrappedAt" OR NEW."producerKey" <> OLD."producerKey" THEN
    RAISE EXCEPTION 'A notification producer checkpoint only moves forward.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "NotificationProducerCheckpoint_guard" BEFORE UPDATE ON "NotificationProducerCheckpoint"
  FOR EACH ROW EXECUTE FUNCTION guard_notification_producer_checkpoint();

-- D1: a worker renews its lease (SENDING to SENDING, same attempt) immediately before each
-- send. Same rules as Phase 16 otherwise: every claim still counts exactly one attempt.
CREATE OR REPLACE FUNCTION guard_notification_delivery() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Notification deliveries are never deleted.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."attemptCount" <> 0 OR NEW."status" NOT IN ('PENDING', 'SENT', 'SUPPRESSED')
       OR (NEW."channel" <> 'IN_APP' AND NEW."status" = 'SENT') THEN
      RAISE EXCEPTION 'A delivery starts pending or suppressed (in-app: sent) with no attempts.' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."notificationId" <> OLD."notificationId" OR NEW."organizationId" <> OLD."organizationId"
     OR NEW."channel" <> OLD."channel" OR NEW."createdAt" <> OLD."createdAt" THEN
    RAISE EXCEPTION 'A delivery''s notification and channel never change.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."status" IN ('SENT', 'FAILED', 'SUPPRESSED') THEN
    RAISE EXCEPTION 'A % delivery is final.', lower(OLD."status"::text) USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."attemptCount" < OLD."attemptCount" OR NEW."attemptCount" > OLD."attemptCount" + 1 THEN
    RAISE EXCEPTION 'Attempts are counted one at a time.' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" = 'SENDING' AND NEW."attemptCount" <> OLD."attemptCount" + 1
     AND NOT (OLD."status" = 'SENDING' AND NEW."attemptCount" = OLD."attemptCount"
              AND NEW."nextAttemptAt" IS NOT DISTINCT FROM OLD."nextAttemptAt"
              AND NEW."lastErrorCode" IS NOT DISTINCT FROM OLD."lastErrorCode") THEN
    RAISE EXCEPTION 'Each claim counts an attempt.' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" = 'SENT' AND OLD."status" <> 'SENDING' THEN
    RAISE EXCEPTION 'Only a delivery being sent becomes sent.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE INDEX "LeaveRequestEvent_occurredAt_id_idx" ON "LeaveRequestEvent"("occurredAt", "id");
CREATE INDEX "TimesheetEvent_occurredAt_id_idx" ON "TimesheetEvent"("occurredAt", "id");
CREATE INDEX "TimeCorrectionRequest_reviewedAt_id_idx" ON "TimeCorrectionRequest"("reviewedAt", "id");
CREATE INDEX "Schedule_publishedAt_id_idx" ON "Schedule"("publishedAt", "id");
CREATE INDEX "ScheduledShiftRevision_changedAt_id_idx" ON "ScheduledShiftRevision"("changedAt", "id");
CREATE INDEX "PayrollRun_finalizedAt_id_idx" ON "PayrollRun"("finalizedAt", "id");
CREATE INDEX "NotificationDelivery_organizationId_createdAt_id_idx" ON "NotificationDelivery"("organizationId", "createdAt" DESC, "id" DESC);
