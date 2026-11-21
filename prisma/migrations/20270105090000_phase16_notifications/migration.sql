-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('IN_APP', 'EMAIL');

-- CreateEnum
CREATE TYPE "NotificationCategory" AS ENUM ('SECURITY', 'HR_REQUIRED', 'ONBOARDING', 'DOCUMENTS', 'PERFORMANCE', 'RECRUITMENT', 'LEAVE', 'SCHEDULING', 'PAYROLL', 'BENEFITS', 'GENERAL');

-- CreateEnum
CREATE TYPE "NotificationSourceDomain" AS ENUM ('SYSTEM', 'AUTH', 'ONBOARDING', 'DOCUMENTS', 'PERFORMANCE', 'RECRUITMENT', 'LEAVE', 'SCHEDULING', 'PAYROLL', 'BENEFITS', 'TIME');

-- CreateEnum
CREATE TYPE "NotificationTemplateStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "NotificationDeliveryStatus" AS ENUM ('PENDING', 'SENDING', 'SENT', 'FAILED', 'SUPPRESSED');

-- CreateEnum
CREATE TYPE "NotificationSuppressionReason" AS ENUM ('USER_PREFERENCE', 'ORGANIZATION_CATEGORY_DISABLED', 'ORGANIZATION_EMAIL_DISABLED', 'RECIPIENT_INACTIVE');

-- CreateEnum
CREATE TYPE "NotificationAttemptStatus" AS ENUM ('STARTED', 'SUCCEEDED', 'RETRYABLE_FAILURE', 'PERMANENT_FAILURE', 'ABANDONED');

-- CreateTable
CREATE TABLE "NotificationTemplate" (
    "id" UUID NOT NULL,
    "organizationId" UUID,
    "key" TEXT NOT NULL,
    "category" "NotificationCategory" NOT NULL,
    "subjectTemplate" TEXT NOT NULL,
    "bodyTemplate" TEXT NOT NULL,
    "allowedVariables" TEXT[],
    "mandatory" BOOLEAN NOT NULL DEFAULT false,
    "status" "NotificationTemplateStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdByUserId" UUID,
    "updatedByUserId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "archivedAt" TIMESTAMPTZ(6),

    CONSTRAINT "NotificationTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "recipientUserId" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "category" "NotificationCategory" NOT NULL,
    "mandatory" BOOLEAN NOT NULL DEFAULT false,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "link" TEXT,
    "sourceDomain" "NotificationSourceDomain" NOT NULL,
    "sourceEntityType" TEXT,
    "sourceEntityId" UUID,
    "dedupeKey" TEXT NOT NULL,
    "templateId" UUID,
    "templateVersion" INTEGER,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readAt" TIMESTAMPTZ(6),
    "archivedAt" TIMESTAMPTZ(6),

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationDelivery" (
    "id" UUID NOT NULL,
    "notificationId" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "status" "NotificationDeliveryStatus" NOT NULL,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMPTZ(6),
    "leaseExpiresAt" TIMESTAMPTZ(6),
    "sentAt" TIMESTAMPTZ(6),
    "lastErrorCode" TEXT,
    "suppressedReason" "NotificationSuppressionReason",
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "NotificationDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationDeliveryAttempt" (
    "id" UUID NOT NULL,
    "deliveryId" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "status" "NotificationAttemptStatus" NOT NULL,
    "provider" TEXT NOT NULL,
    "providerReference" TEXT,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMPTZ(6),

    CONSTRAINT "NotificationDeliveryAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationPreference" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "category" "NotificationCategory" NOT NULL,
    "emailEnabled" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "NotificationPreference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrganizationNotificationSetting" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "category" "NotificationCategory" NOT NULL,
    "emailEnabled" BOOLEAN NOT NULL,
    "updatedByUserId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "OrganizationNotificationSetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrganizationNotificationPolicy" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "emailEnabled" BOOLEAN NOT NULL DEFAULT true,
    "suppressMandatoryEmail" BOOLEAN NOT NULL DEFAULT false,
    "updatedByUserId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "OrganizationNotificationPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "NotificationTemplate_organizationId_key_status_idx" ON "NotificationTemplate"("organizationId", "key", "status");

-- CreateIndex
CREATE INDEX "Notification_recipientUserId_createdAt_idx" ON "Notification"("recipientUserId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Notification_organizationId_recipientUserId_dedupeKey_key" ON "Notification"("organizationId", "recipientUserId", "dedupeKey");

-- CreateIndex
CREATE UNIQUE INDEX "Notification_id_organizationId_key" ON "Notification"("id", "organizationId");

-- CreateIndex
CREATE INDEX "NotificationDelivery_channel_status_nextAttemptAt_idx" ON "NotificationDelivery"("channel", "status", "nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationDelivery_notificationId_channel_key" ON "NotificationDelivery"("notificationId", "channel");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationDelivery_id_organizationId_key" ON "NotificationDelivery"("id", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationDeliveryAttempt_deliveryId_attemptNumber_key" ON "NotificationDeliveryAttempt"("deliveryId", "attemptNumber");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationPreference_userId_category_key" ON "NotificationPreference"("userId", "category");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationNotificationSetting_organizationId_category_key" ON "OrganizationNotificationSetting"("organizationId", "category");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationNotificationPolicy_organizationId_key" ON "OrganizationNotificationPolicy"("organizationId");

-- AddForeignKey
ALTER TABLE "NotificationTemplate" ADD CONSTRAINT "NotificationTemplate_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_recipientUserId_fkey" FOREIGN KEY ("recipientUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "NotificationTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationDelivery" ADD CONSTRAINT "NotificationDelivery_notificationId_organizationId_fkey" FOREIGN KEY ("notificationId", "organizationId") REFERENCES "Notification"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationDeliveryAttempt" ADD CONSTRAINT "NotificationDeliveryAttempt_deliveryId_organizationId_fkey" FOREIGN KEY ("deliveryId", "organizationId") REFERENCES "NotificationDelivery"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationPreference" ADD CONSTRAINT "NotificationPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationNotificationSetting" ADD CONSTRAINT "OrganizationNotificationSetting_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationNotificationPolicy" ADD CONSTRAINT "OrganizationNotificationPolicy_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ─── Phase 16 integrity: checks, partial uniques and guard triggers ─────────────

ALTER TABLE "NotificationTemplate"
  ADD CONSTRAINT "NotificationTemplate_key_check" CHECK ("key" ~ '^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$' AND length("key") <= 100),
  ADD CONSTRAINT "NotificationTemplate_text_check" CHECK (
    btrim("subjectTemplate") <> '' AND length("subjectTemplate") <= 200
    AND btrim("bodyTemplate") <> '' AND length("bodyTemplate") <= 2000
  ),
  ADD CONSTRAINT "NotificationTemplate_version_check" CHECK ("version" >= 1),
  -- Only system templates carry the mandatory flag.
  ADD CONSTRAINT "NotificationTemplate_mandatory_check" CHECK ("organizationId" IS NULL OR NOT "mandatory"),
  ADD CONSTRAINT "NotificationTemplate_archive_check" CHECK (("status" = 'ARCHIVED') = ("archivedAt" IS NOT NULL)),
  ADD CONSTRAINT "NotificationTemplate_system_active_check" CHECK ("organizationId" IS NOT NULL OR "status" = 'ACTIVE');

-- One system template per type; one active override per organization and type.
CREATE UNIQUE INDEX "NotificationTemplate_system_key"
  ON "NotificationTemplate"("key") WHERE "organizationId" IS NULL;
CREATE UNIQUE INDEX "NotificationTemplate_active_override_key"
  ON "NotificationTemplate"("organizationId", "key") WHERE "organizationId" IS NOT NULL AND "status" = 'ACTIVE';

ALTER TABLE "Notification"
  ADD CONSTRAINT "Notification_type_check" CHECK ("type" ~ '^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$' AND length("type") <= 100),
  ADD CONSTRAINT "Notification_text_check" CHECK (
    btrim("title") <> '' AND length("title") <= 200 AND length("body") <= 2000
  ),
  -- A relative application path only: never a scheme, a protocol-relative URL or a backslash.
  ADD CONSTRAINT "Notification_link_check" CHECK (
    "link" IS NULL OR (
      length("link") <= 300 AND "link" ~ '^/[A-Za-z0-9/_.~?=&%-]*$'
      AND "link" !~ '^//' AND "link" !~ '(^|/)\.\.(/|$|\?)'
    )
  ),
  ADD CONSTRAINT "Notification_dedupe_check" CHECK ("dedupeKey" ~ '^[A-Za-z0-9:._-]{1,200}$'),
  ADD CONSTRAINT "Notification_source_check" CHECK ("sourceEntityType" IS NULL OR "sourceEntityType" ~ '^[A-Za-z][A-Za-z0-9]{0,63}$'),
  ADD CONSTRAINT "Notification_template_check" CHECK (("templateId" IS NULL) = ("templateVersion" IS NULL)),
  ADD CONSTRAINT "Notification_mandatory_category_check" CHECK ("category" NOT IN ('SECURITY', 'HR_REQUIRED') OR "mandatory");

CREATE INDEX "Notification_unread_idx"
  ON "Notification"("recipientUserId", "organizationId") WHERE "readAt" IS NULL AND "archivedAt" IS NULL;

ALTER TABLE "NotificationDelivery"
  ADD CONSTRAINT "NotificationDelivery_attempts_check" CHECK ("attemptCount" BETWEEN 0 AND 20),
  ADD CONSTRAINT "NotificationDelivery_in_app_check" CHECK ("channel" <> 'IN_APP' OR ("status" = 'SENT' AND "attemptCount" = 0)),
  ADD CONSTRAINT "NotificationDelivery_state_check" CHECK (
    ("status" <> 'PENDING' OR "nextAttemptAt" IS NOT NULL)
    AND (("status" = 'SENDING') = ("leaseExpiresAt" IS NOT NULL))
    AND (("status" = 'SENT') = ("sentAt" IS NOT NULL))
    AND (("status" = 'SUPPRESSED') = ("suppressedReason" IS NOT NULL))
  ),
  ADD CONSTRAINT "NotificationDelivery_error_check" CHECK ("lastErrorCode" IS NULL OR "lastErrorCode" ~ '^[A-Z][A-Z0-9_]{0,63}$');

CREATE INDEX "NotificationDelivery_due_idx"
  ON "NotificationDelivery"("nextAttemptAt") WHERE "channel" <> 'IN_APP' AND "status" = 'PENDING';
CREATE INDEX "NotificationDelivery_lease_idx"
  ON "NotificationDelivery"("leaseExpiresAt") WHERE "status" = 'SENDING';

ALTER TABLE "NotificationDeliveryAttempt"
  ADD CONSTRAINT "NotificationDeliveryAttempt_number_check" CHECK ("attemptNumber" >= 1),
  ADD CONSTRAINT "NotificationDeliveryAttempt_state_check" CHECK (("status" = 'STARTED') = ("finishedAt" IS NULL)),
  ADD CONSTRAINT "NotificationDeliveryAttempt_error_check" CHECK (
    ("errorCode" IS NULL OR "errorCode" ~ '^[A-Z][A-Z0-9_]{0,63}$')
    AND ("errorMessage" IS NULL OR length("errorMessage") <= 300)
    AND ("providerReference" IS NULL OR length("providerReference") <= 200)
    AND btrim("provider") <> '' AND length("provider") <= 64
  );

-- Mandatory categories have no user preference.
ALTER TABLE "NotificationPreference"
  ADD CONSTRAINT "NotificationPreference_category_check" CHECK ("category" NOT IN ('SECURITY', 'HR_REQUIRED'));

ALTER TABLE "OrganizationNotificationSetting"
  ADD CONSTRAINT "OrganizationNotificationSetting_category_check" CHECK ("category" NOT IN ('SECURITY', 'HR_REQUIRED'));

-- Suppressing mandatory email is an explicit decision taken only with the kill switch engaged.
ALTER TABLE "OrganizationNotificationPolicy"
  ADD CONSTRAINT "OrganizationNotificationPolicy_mandatory_check" CHECK (NOT "suppressMandatoryEmail" OR NOT "emailEnabled");

CREATE FUNCTION guard_notification_template() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  system_category "NotificationCategory";
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Notification templates are archived, never deleted.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'ACTIVE' OR NEW."version" <> 1 THEN
      RAISE EXCEPTION 'A template starts active at version 1.' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."organizationId" IS NOT NULL THEN
      SELECT "category" INTO system_category FROM "NotificationTemplate"
        WHERE "organizationId" IS NULL AND "key" = NEW."key";
      IF system_category IS NULL OR system_category <> NEW."category" THEN
        RAISE EXCEPTION 'An organization template overrides a system notification type of the same category.' USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."organizationId" IS DISTINCT FROM OLD."organizationId" OR NEW."key" <> OLD."key"
     OR NEW."category" <> OLD."category" OR NEW."mandatory" <> OLD."mandatory"
     OR NEW."createdAt" <> OLD."createdAt" OR NEW."createdByUserId" IS DISTINCT FROM OLD."createdByUserId" THEN
    RAISE EXCEPTION 'A template''s organization, type, category and mandatory flag never change.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."status" = 'ARCHIVED' THEN
    RAISE EXCEPTION 'An archived template is frozen.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF (NEW."subjectTemplate" <> OLD."subjectTemplate" OR NEW."bodyTemplate" <> OLD."bodyTemplate"
      OR NEW."allowedVariables" IS DISTINCT FROM OLD."allowedVariables")
     AND NEW."version" <> OLD."version" + 1 THEN
    RAISE EXCEPTION 'Each content change increments the template version.' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."version" < OLD."version" THEN
    RAISE EXCEPTION 'A template version never decreases.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "NotificationTemplate_guard" BEFORE INSERT OR UPDATE OR DELETE ON "NotificationTemplate"
  FOR EACH ROW EXECUTE FUNCTION guard_notification_template();

CREATE FUNCTION guard_notification() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  template_organization uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Notifications are archived, never deleted.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."readAt" IS NOT NULL OR NEW."archivedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'A notification starts unread.' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."templateId" IS NOT NULL THEN
      SELECT "organizationId" INTO template_organization FROM "NotificationTemplate" WHERE "id" = NEW."templateId";
      IF template_organization IS NOT NULL AND template_organization <> NEW."organizationId" THEN
        RAISE EXCEPTION 'The template belongs to another organization.' USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."organizationId" <> OLD."organizationId" OR NEW."recipientUserId" <> OLD."recipientUserId"
     OR NEW."type" <> OLD."type" OR NEW."category" <> OLD."category" OR NEW."mandatory" <> OLD."mandatory"
     OR NEW."title" <> OLD."title" OR NEW."body" <> OLD."body" OR NEW."link" IS DISTINCT FROM OLD."link"
     OR NEW."sourceDomain" <> OLD."sourceDomain"
     OR NEW."sourceEntityType" IS DISTINCT FROM OLD."sourceEntityType"
     OR NEW."sourceEntityId" IS DISTINCT FROM OLD."sourceEntityId"
     OR NEW."dedupeKey" <> OLD."dedupeKey" OR NEW."templateId" IS DISTINCT FROM OLD."templateId"
     OR NEW."templateVersion" IS DISTINCT FROM OLD."templateVersion" OR NEW."createdAt" <> OLD."createdAt" THEN
    RAISE EXCEPTION 'A notification''s content never changes.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF (OLD."readAt" IS NOT NULL AND NEW."readAt" IS DISTINCT FROM OLD."readAt")
     OR (OLD."archivedAt" IS NOT NULL AND NEW."archivedAt" IS DISTINCT FROM OLD."archivedAt") THEN
    RAISE EXCEPTION 'Read and archived times are recorded once.' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "Notification_guard" BEFORE INSERT OR UPDATE OR DELETE ON "Notification"
  FOR EACH ROW EXECUTE FUNCTION guard_notification();

CREATE FUNCTION guard_notification_delivery() RETURNS trigger LANGUAGE plpgsql AS $$
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
  IF NEW."status" = 'SENDING' AND NEW."attemptCount" <> OLD."attemptCount" + 1 THEN
    RAISE EXCEPTION 'Each claim counts an attempt.' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" = 'SENT' AND OLD."status" <> 'SENDING' THEN
    RAISE EXCEPTION 'Only a delivery being sent becomes sent.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "NotificationDelivery_guard" BEFORE INSERT OR UPDATE OR DELETE ON "NotificationDelivery"
  FOR EACH ROW EXECUTE FUNCTION guard_notification_delivery();

CREATE FUNCTION guard_notification_delivery_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  delivery_attempts integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Delivery attempts are append-only.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT "attemptCount" INTO delivery_attempts FROM "NotificationDelivery" WHERE "id" = NEW."deliveryId";
    IF NEW."status" <> 'STARTED' OR NEW."attemptNumber" <> delivery_attempts THEN
      RAISE EXCEPTION 'An attempt is recorded as started, numbered after its claim.' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."status" <> 'STARTED' OR NEW."status" = 'STARTED'
     OR NEW."deliveryId" <> OLD."deliveryId" OR NEW."organizationId" <> OLD."organizationId"
     OR NEW."attemptNumber" <> OLD."attemptNumber" OR NEW."provider" <> OLD."provider"
     OR NEW."startedAt" <> OLD."startedAt" THEN
    RAISE EXCEPTION 'Delivery attempts are append-only: an attempt is completed once.' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "NotificationDeliveryAttempt_guard" BEFORE INSERT OR UPDATE OR DELETE ON "NotificationDeliveryAttempt"
  FOR EACH ROW EXECUTE FUNCTION guard_notification_delivery_attempt();
