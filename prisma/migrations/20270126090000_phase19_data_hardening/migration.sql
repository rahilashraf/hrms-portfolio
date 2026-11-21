-- Phase 19 — data hardening (additive only):
--   1. indexes for query paths that had none (payroll run reads, retention scans);
--   2. same-organization guards for the organization structure (Phase 3 had none in the DB);
--   3. opt-in data retention (every retention.* setting defaults to 0 = off): a candidate
--      anonymization marker and narrowly scoped trigger allowances that only open when the
--      retention job sets `SET LOCAL hrms.retention_purge = 'on'` AND the row meets the
--      organization's own age rule, re-checked here in the database.
--
-- Rollout: every index uses IF NOT EXISTS so that on large production tables it can be built
-- beforehand with CREATE INDEX CONCURRENTLY under the same name (Prisma runs a migration in one
-- transaction, where CONCURRENTLY is not allowed); see docs/security/phase19-migration-review.md.

-- ─── 1. Indexes ──────────────────────────────────────────────────────────────

-- Payroll run detail, recalculation and reporting read run assignments and snapshots by run
-- (`where: { payrollRunId }`); every existing index on these tables leads with another column.
CREATE INDEX IF NOT EXISTS "PayrollRunAssignment_payrollRunId_idx" ON "PayrollRunAssignment"("payrollRunId");
CREATE INDEX IF NOT EXISTS "PayrollBenefitSnapshot_payrollRunId_idx" ON "PayrollBenefitSnapshot"("payrollRunId");
CREATE INDEX IF NOT EXISTS "PayrollCompensationSnapshot_payrollRunId_idx" ON "PayrollCompensationSnapshot"("payrollRunId");
CREATE INDEX IF NOT EXISTS "PayrollLeaveSnapshot_payrollRunId_idx" ON "PayrollLeaveSnapshot"("payrollRunId");
CREATE INDEX IF NOT EXISTS "PayrollPresenceSnapshot_payrollRunId_idx" ON "PayrollPresenceSnapshot"("payrollRunId");
CREATE INDEX IF NOT EXISTS "PayrollTimeSnapshot_payrollRunId_idx" ON "PayrollTimeSnapshot"("payrollRunId");

-- Retention scans: per organization, oldest first.
CREATE INDEX IF NOT EXISTS "Notification_organizationId_createdAt_idx" ON "Notification"("organizationId", "createdAt");
CREATE INDEX IF NOT EXISTS "NotificationDeliveryAttempt_organizationId_startedAt_idx" ON "NotificationDeliveryAttempt"("organizationId", "startedAt");
-- AuditLog has no organizationId column; organization-scoped entries carry it in metadata.
-- Partial expression index (not representable in the Prisma schema; Prisma ignores it).
CREATE INDEX IF NOT EXISTS "AuditLog_metadata_organizationId_occurredAt_idx"
  ON "AuditLog"((("metadata"->>'organizationId')), "occurredAt")
  WHERE "metadata" ? 'organizationId';

-- ─── 2. Organization structure: same-organization references ────────────────
-- The application validates placements (OrganizationIntegrityService); the database now does
-- too, for new writes only (existing rows are not rescanned — see the review for the one-off
-- verification query). organizationId never changes on these tables.

CREATE FUNCTION guard_organization_structure_scope() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  reference record;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."organizationId" <> OLD."organizationId" THEN
    RAISE EXCEPTION '% never moves to another organization.', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_TABLE_NAME = 'OrganizationalUnit' THEN
    IF NEW."parentUnitId" IS NOT NULL
       AND (SELECT "organizationId" FROM "OrganizationalUnit" WHERE "id" = NEW."parentUnitId") <> NEW."organizationId" THEN
      RAISE EXCEPTION 'The parent unit belongs to another organization.' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF TG_TABLE_NAME = 'Department' THEN
    IF NEW."organizationalUnitId" IS NOT NULL
       AND (SELECT "organizationId" FROM "OrganizationalUnit" WHERE "id" = NEW."organizationalUnitId") <> NEW."organizationId" THEN
      RAISE EXCEPTION 'The unit belongs to another organization.' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF TG_TABLE_NAME = 'Team' THEN
    IF NEW."organizationalUnitId" IS NOT NULL
       AND (SELECT "organizationId" FROM "OrganizationalUnit" WHERE "id" = NEW."organizationalUnitId") <> NEW."organizationId" THEN
      RAISE EXCEPTION 'The unit belongs to another organization.' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."departmentId" IS NOT NULL
       AND (SELECT "organizationId" FROM "Department" WHERE "id" = NEW."departmentId") <> NEW."organizationId" THEN
      RAISE EXCEPTION 'The department belongs to another organization.' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF TG_TABLE_NAME = 'Position' THEN
    FOR reference IN
      SELECT 'job title' AS label, (SELECT "organizationId" FROM "JobTitle" WHERE "id" = NEW."jobTitleId") AS org
      UNION ALL SELECT 'unit', (SELECT "organizationId" FROM "OrganizationalUnit" WHERE "id" = NEW."organizationalUnitId")
      UNION ALL SELECT 'department', (SELECT "organizationId" FROM "Department" WHERE "id" = NEW."departmentId")
      UNION ALL SELECT 'team', (SELECT "organizationId" FROM "Team" WHERE "id" = NEW."teamId")
      UNION ALL SELECT 'work location', (SELECT "organizationId" FROM "WorkLocation" WHERE "id" = NEW."workLocationId")
    LOOP
      IF reference.org IS NOT NULL AND reference.org <> NEW."organizationId" THEN
        RAISE EXCEPTION 'The position''s % belongs to another organization.', reference.label USING ERRCODE = 'check_violation';
      END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "OrganizationalUnit_scope_guard" BEFORE INSERT OR UPDATE ON "OrganizationalUnit"
  FOR EACH ROW EXECUTE FUNCTION guard_organization_structure_scope();
CREATE TRIGGER "Department_scope_guard" BEFORE INSERT OR UPDATE ON "Department"
  FOR EACH ROW EXECUTE FUNCTION guard_organization_structure_scope();
CREATE TRIGGER "Team_scope_guard" BEFORE INSERT OR UPDATE ON "Team"
  FOR EACH ROW EXECUTE FUNCTION guard_organization_structure_scope();
CREATE TRIGGER "Position_scope_guard" BEFORE INSERT OR UPDATE ON "Position"
  FOR EACH ROW EXECUTE FUNCTION guard_organization_structure_scope();
CREATE TRIGGER "JobTitle_scope_guard" BEFORE UPDATE OF "organizationId" ON "JobTitle"
  FOR EACH ROW EXECUTE FUNCTION guard_organization_structure_scope();
CREATE TRIGGER "WorkLocation_scope_guard" BEFORE UPDATE OF "organizationId" ON "WorkLocation"
  FOR EACH ROW EXECUTE FUNCTION guard_organization_structure_scope();

-- ─── 3. Data retention (opt-in, default off) ─────────────────────────────────

ALTER TABLE "RecruitmentCandidate" ADD COLUMN "anonymizedAt" TIMESTAMPTZ(6);

-- Only the retention job's own transaction sets this (SET LOCAL: it ends with the transaction).
CREATE FUNCTION hrms_retention_active() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce(current_setting('hrms.retention_purge', true), '') = 'on'
$$;

-- The organization's stored retention setting (registry schema version 1, an integer), else 0.
CREATE FUNCTION hrms_retention_months(organization uuid, setting_key text) RETURNS integer LANGUAGE sql STABLE AS $$
  SELECT coalesce((
    SELECT CASE
             WHEN s."schemaVersion" = 1 AND jsonb_typeof(s."value") = 'number'
                  AND s."value"::text ~ '^[0-9]{1,4}$'
             THEN s."value"::text::integer
           END
    FROM "OrganizationSetting" s
    WHERE s."organizationId" = organization AND s."key" = setting_key
  ), 0)
$$;

-- The instant before which a row may be purged / anonymized, or NULL when retention is off for
-- the organization or set below the hard minimum (the registry refuses such values too).
CREATE FUNCTION hrms_retention_cutoff(organization uuid, setting_key text, minimum_months integer)
RETURNS timestamptz LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN m > 0 AND m >= minimum_months THEN now() - make_interval(months => m) END
  FROM (SELECT hrms_retention_months(organization, setting_key) AS m) months
$$;

-- ── Notifications, deliveries, attempts (retention.notificationMonths ≥ 3,
--    retention.deliveryLogMonths ≥ 3) ──

-- A read or archived notification older than the organization's notification retention.
CREATE FUNCTION hrms_notification_purgeable(notification uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce((
    SELECT (n."readAt" IS NOT NULL OR n."archivedAt" IS NOT NULL)
       AND n."createdAt" < hrms_retention_cutoff(n."organizationId", 'retention.notificationMonths', 3)
    FROM "Notification" n WHERE n."id" = notification
  ), false)
$$;

CREATE FUNCTION retention_delete_notification() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT hrms_notification_purgeable(OLD."id")
     OR EXISTS (SELECT 1 FROM "NotificationDelivery" d
                WHERE d."notificationId" = OLD."id" AND d."status" IN ('PENDING', 'SENDING')) THEN
    RAISE EXCEPTION 'Retention purges only read or archived notifications older than the organization''s retention period.' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END $$;

CREATE FUNCTION retention_delete_notification_delivery() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" NOT IN ('SENT', 'FAILED', 'SUPPRESSED') OR NOT hrms_notification_purgeable(OLD."notificationId") THEN
    RAISE EXCEPTION 'Retention purges only final deliveries of purgeable notifications.' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END $$;

CREATE FUNCTION retention_delete_notification_delivery_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" = 'STARTED' OR NOT (
    coalesce(OLD."startedAt" < hrms_retention_cutoff(OLD."organizationId", 'retention.deliveryLogMonths', 3), false)
    OR coalesce((SELECT d."status" IN ('SENT', 'FAILED', 'SUPPRESSED') AND hrms_notification_purgeable(d."notificationId")
                 FROM "NotificationDelivery" d WHERE d."id" = OLD."deliveryId"), false)
  ) THEN
    RAISE EXCEPTION 'Retention purges only finished delivery attempts older than the organization''s retention period.' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END $$;

-- The Phase 16 guards keep INSERT/UPDATE unchanged; their DELETE refusal now applies whenever
-- retention is not active, and the retention rule applies when it is.
DROP TRIGGER "Notification_guard" ON "Notification";
CREATE TRIGGER "Notification_guard" BEFORE INSERT OR UPDATE ON "Notification"
  FOR EACH ROW EXECUTE FUNCTION guard_notification();
CREATE TRIGGER "Notification_guard_delete" BEFORE DELETE ON "Notification"
  FOR EACH ROW WHEN (NOT hrms_retention_active()) EXECUTE FUNCTION guard_notification();
CREATE TRIGGER "Notification_retention_delete" BEFORE DELETE ON "Notification"
  FOR EACH ROW WHEN (hrms_retention_active()) EXECUTE FUNCTION retention_delete_notification();

DROP TRIGGER "NotificationDelivery_guard" ON "NotificationDelivery";
CREATE TRIGGER "NotificationDelivery_guard" BEFORE INSERT OR UPDATE ON "NotificationDelivery"
  FOR EACH ROW EXECUTE FUNCTION guard_notification_delivery();
CREATE TRIGGER "NotificationDelivery_guard_delete" BEFORE DELETE ON "NotificationDelivery"
  FOR EACH ROW WHEN (NOT hrms_retention_active()) EXECUTE FUNCTION guard_notification_delivery();
CREATE TRIGGER "NotificationDelivery_retention_delete" BEFORE DELETE ON "NotificationDelivery"
  FOR EACH ROW WHEN (hrms_retention_active()) EXECUTE FUNCTION retention_delete_notification_delivery();

DROP TRIGGER "NotificationDeliveryAttempt_guard" ON "NotificationDeliveryAttempt";
CREATE TRIGGER "NotificationDeliveryAttempt_guard" BEFORE INSERT OR UPDATE ON "NotificationDeliveryAttempt"
  FOR EACH ROW EXECUTE FUNCTION guard_notification_delivery_attempt();
CREATE TRIGGER "NotificationDeliveryAttempt_guard_delete" BEFORE DELETE ON "NotificationDeliveryAttempt"
  FOR EACH ROW WHEN (NOT hrms_retention_active()) EXECUTE FUNCTION guard_notification_delivery_attempt();
CREATE TRIGGER "NotificationDeliveryAttempt_retention_delete" BEFORE DELETE ON "NotificationDeliveryAttempt"
  FOR EACH ROW WHEN (hrms_retention_active()) EXECUTE FUNCTION retention_delete_notification_delivery_attempt();

-- ── Google synchronization runs (retention.syncLogMonths ≥ 3) ──

CREATE FUNCTION retention_delete_google_sync_run() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" = 'RUNNING'
     OR NOT coalesce(OLD."startedAt" < hrms_retention_cutoff(OLD."organizationId", 'retention.syncLogMonths', 3), false) THEN
    RAISE EXCEPTION 'Retention purges only finished synchronization runs older than the organization''s retention period.' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END $$;

DROP TRIGGER "GoogleSyncRun_guard" ON "GoogleSyncRun";
CREATE TRIGGER "GoogleSyncRun_guard" BEFORE INSERT OR UPDATE ON "GoogleSyncRun"
  FOR EACH ROW EXECUTE FUNCTION guard_google_sync_run();
CREATE TRIGGER "GoogleSyncRun_guard_delete" BEFORE DELETE ON "GoogleSyncRun"
  FOR EACH ROW WHEN (NOT hrms_retention_active()) EXECUTE FUNCTION guard_google_sync_run();
CREATE TRIGGER "GoogleSyncRun_retention_delete" BEFORE DELETE ON "GoogleSyncRun"
  FOR EACH ROW WHEN (hrms_retention_active()) EXECUTE FUNCTION retention_delete_google_sync_run();

-- ── Audit log (retention.auditLogMonths ≥ 24) ──
-- AuditLog has no append-only trigger (see the database review); this one only constrains what
-- a retention transaction may delete: organization-scoped entries past the organization's period.

CREATE FUNCTION retention_delete_audit_log() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  organization text := OLD."metadata"->>'organizationId';
BEGIN
  IF organization IS NULL
     OR organization !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
     OR NOT coalesce(OLD."occurredAt" < hrms_retention_cutoff(organization::uuid, 'retention.auditLogMonths', 24), false) THEN
    RAISE EXCEPTION 'Retention purges only organization audit entries older than the organization''s retention period.' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END $$;

CREATE TRIGGER "AuditLog_retention_delete" BEFORE DELETE ON "AuditLog"
  FOR EACH ROW WHEN (hrms_retention_active()) EXECUTE FUNCTION retention_delete_audit_log();

-- ── Candidate anonymization (retention.rejectedCandidateMonths ≥ 6) ──
-- Eligible: never hired (no person, no hire), not an internal (employee) candidate, every
-- application withdrawn or rejected, nothing changed since the cutoff; a merged-away record
-- once the candidate it was merged into is anonymized. Rows are redacted, never deleted, so
-- applications, stages, offers and interviews keep counting in reports.

CREATE FUNCTION hrms_candidate_retention_eligible(candidate uuid) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE
  c "RecruitmentCandidate";
  cutoff timestamptz;
BEGIN
  SELECT * INTO c FROM "RecruitmentCandidate" WHERE "id" = candidate;
  IF NOT FOUND OR c."personId" IS NOT NULL OR c."internalEmployeeId" IS NOT NULL THEN
    RETURN false;
  END IF;
  cutoff := hrms_retention_cutoff(c."organizationId", 'retention.rejectedCandidateMonths', 6);
  IF cutoff IS NULL OR c."createdAt" >= cutoff OR c."updatedAt" >= cutoff THEN
    RETURN false;
  END IF;
  IF EXISTS (SELECT 1 FROM "RecruitmentHire" h WHERE h."candidateId" = candidate) THEN
    RETURN false;
  END IF;
  IF EXISTS (
    SELECT 1 FROM "RecruitmentApplication" a
    WHERE a."candidateId" = candidate
      AND (a."status" NOT IN ('WITHDRAWN', 'REJECTED') OR a."updatedAt" >= cutoff
           OR a."dispositionAt" IS NULL OR a."dispositionAt" >= cutoff)
  ) THEN
    RETURN false;
  END IF;
  IF c."status" = 'MERGED' AND NOT EXISTS (
    SELECT 1 FROM "RecruitmentCandidate" t WHERE t."id" = c."mergedIntoCandidateId" AND t."anonymizedAt" IS NOT NULL
  ) THEN
    RETURN false;
  END IF;
  RETURN true;
END $$;

ALTER TABLE "RecruitmentCandidate"
  ADD CONSTRAINT "RecruitmentCandidate_anonymized_shape_check" CHECK (
    "anonymizedAt" IS NULL OR (
      "email" IS NULL AND "normalizedEmail" IS NULL AND "phone" IS NULL AND "location" IS NULL
      AND "notes" IS NULL AND "preferredName" IS NULL AND "status" <> 'ACTIVE'
    )
  );

-- Always on: anonymization happens once, only through retention, only for eligible candidates,
-- with exactly the redacted values; an anonymized candidate's identity never comes back.
CREATE FUNCTION guard_recruitment_candidate_retention() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  expected "RecruitmentCandidate";
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."anonymizedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'A candidate is created with its details.' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."anonymizedAt" IS NOT NULL THEN
    IF NEW."anonymizedAt" IS DISTINCT FROM OLD."anonymizedAt"
       OR NEW."firstName" <> OLD."firstName" OR NEW."lastName" <> OLD."lastName"
       OR NEW."preferredName" IS DISTINCT FROM OLD."preferredName"
       OR NEW."email" IS DISTINCT FROM OLD."email" OR NEW."phone" IS DISTINCT FROM OLD."phone"
       OR NEW."location" IS DISTINCT FROM OLD."location" OR NEW."notes" IS DISTINCT FROM OLD."notes" THEN
      RAISE EXCEPTION 'An anonymized candidate stays anonymized.' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."anonymizedAt" IS NULL THEN
    IF hrms_retention_active() THEN
      RAISE EXCEPTION 'Retention only anonymizes candidates.' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;
  expected := OLD;
  expected."firstName" := 'Anonymized';
  expected."lastName" := 'Candidate';
  expected."preferredName" := NULL;
  expected."email" := NULL;
  expected."normalizedEmail" := NULL;
  expected."phone" := NULL;
  expected."location" := NULL;
  expected."notes" := NULL;
  expected."status" := CASE WHEN OLD."status" = 'ACTIVE' THEN 'ARCHIVED'::"RecruitmentCandidateStatus" ELSE OLD."status" END;
  expected."anonymizedAt" := NEW."anonymizedAt";
  IF NOT hrms_retention_active() OR NOT hrms_candidate_retention_eligible(OLD."id") OR NEW IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'Only the retention job anonymizes eligible candidates.' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "RecruitmentCandidate_retention_guard" BEFORE INSERT OR UPDATE ON "RecruitmentCandidate"
  FOR EACH ROW EXECUTE FUNCTION guard_recruitment_candidate_retention();

-- Redaction of a candidate's related free text. Each function accepts exactly one outcome (the
-- old row with only its personal free text redacted) for an eligible candidate.
CREATE FUNCTION retention_redact_recruitment_application() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  expected "RecruitmentApplication";
BEGIN
  expected := OLD;
  expected."sourceDetail" := NULL;
  expected."dispositionReason" := NULL;
  IF NEW IS DISTINCT FROM expected OR NOT hrms_candidate_retention_eligible(OLD."candidateId") THEN
    RAISE EXCEPTION 'Retention only redacts applications of eligible candidates.' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION retention_redact_recruitment_screening() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  expected "RecruitmentScreening";
BEGIN
  expected := OLD;
  expected."notes" := NULL;
  IF NEW IS DISTINCT FROM expected OR NOT hrms_candidate_retention_eligible(
    (SELECT a."candidateId" FROM "RecruitmentApplication" a WHERE a."id" = OLD."applicationId")
  ) THEN
    RAISE EXCEPTION 'Retention only redacts screenings of eligible candidates.' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION retention_redact_recruitment_feedback() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  expected "RecruitmentInterviewFeedback";
BEGIN
  expected := OLD;
  expected."strengths" := NULL;
  expected."concerns" := NULL;
  expected."comments" := NULL;
  IF NEW IS DISTINCT FROM expected OR NOT hrms_candidate_retention_eligible(
    (SELECT a."candidateId" FROM "RecruitmentInterview" i
     JOIN "RecruitmentApplication" a ON a."id" = i."applicationId" WHERE i."id" = OLD."interviewId")
  ) THEN
    RAISE EXCEPTION 'Retention only redacts feedback of eligible candidates.' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION retention_redact_recruitment_offer() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  expected "RecruitmentOffer";
BEGIN
  expected := OLD;
  expected."candidateTerms" := NULL;
  expected."internalNotes" := NULL;
  expected."declineReason" := NULL;
  expected."withdrawalReason" := CASE WHEN OLD."withdrawalReason" IS NULL THEN NULL ELSE 'Redacted' END;
  IF NEW IS DISTINCT FROM expected OR NOT hrms_candidate_retention_eligible(
    (SELECT a."candidateId" FROM "RecruitmentApplication" a WHERE a."id" = OLD."applicationId")
  ) THEN
    RAISE EXCEPTION 'Retention only redacts offers of eligible candidates.' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION retention_redact_recruitment_document() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  expected "RecruitmentCandidateDocument";
BEGIN
  expected := OLD;
  expected."title" := 'Redacted';
  expected."provider" := 'MANUAL_REFERENCE';
  expected."externalUrl" := NULL;
  expected."externalFileId" := NULL;
  expected."fileName" := NULL;
  expected."mimeType" := NULL;
  expected."removedAt" := coalesce(OLD."removedAt", NEW."removedAt");
  expected."removalReason" := 'Removed by data retention.';
  IF NEW IS DISTINCT FROM expected OR NEW."removedAt" IS NULL
     OR NOT hrms_candidate_retention_eligible(OLD."candidateId") THEN
    RAISE EXCEPTION 'Retention only redacts documents of eligible candidates.' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;

-- The Phase 13 guards keep INSERT/DELETE unchanged; their UPDATE rules apply whenever retention
-- is not active, and only the redaction rule applies when it is.
DROP TRIGGER "RecruitmentApplication_guard" ON "RecruitmentApplication";
CREATE TRIGGER "RecruitmentApplication_guard" BEFORE INSERT OR DELETE ON "RecruitmentApplication"
  FOR EACH ROW EXECUTE FUNCTION guard_recruitment_application();
CREATE TRIGGER "RecruitmentApplication_guard_update" BEFORE UPDATE ON "RecruitmentApplication"
  FOR EACH ROW WHEN (NOT hrms_retention_active()) EXECUTE FUNCTION guard_recruitment_application();
CREATE TRIGGER "RecruitmentApplication_retention_update" BEFORE UPDATE ON "RecruitmentApplication"
  FOR EACH ROW WHEN (hrms_retention_active()) EXECUTE FUNCTION retention_redact_recruitment_application();

DROP TRIGGER "RecruitmentScreening_guard" ON "RecruitmentScreening";
CREATE TRIGGER "RecruitmentScreening_guard" BEFORE INSERT OR DELETE ON "RecruitmentScreening"
  FOR EACH ROW EXECUTE FUNCTION guard_recruitment_screening();
CREATE TRIGGER "RecruitmentScreening_guard_update" BEFORE UPDATE ON "RecruitmentScreening"
  FOR EACH ROW WHEN (NOT hrms_retention_active()) EXECUTE FUNCTION guard_recruitment_screening();
CREATE TRIGGER "RecruitmentScreening_retention_update" BEFORE UPDATE ON "RecruitmentScreening"
  FOR EACH ROW WHEN (hrms_retention_active()) EXECUTE FUNCTION retention_redact_recruitment_screening();

DROP TRIGGER "RecruitmentInterviewFeedback_guard" ON "RecruitmentInterviewFeedback";
CREATE TRIGGER "RecruitmentInterviewFeedback_guard" BEFORE INSERT OR DELETE ON "RecruitmentInterviewFeedback"
  FOR EACH ROW EXECUTE FUNCTION guard_recruitment_feedback();
CREATE TRIGGER "RecruitmentInterviewFeedback_guard_update" BEFORE UPDATE ON "RecruitmentInterviewFeedback"
  FOR EACH ROW WHEN (NOT hrms_retention_active()) EXECUTE FUNCTION guard_recruitment_feedback();
CREATE TRIGGER "RecruitmentInterviewFeedback_retention_update" BEFORE UPDATE ON "RecruitmentInterviewFeedback"
  FOR EACH ROW WHEN (hrms_retention_active()) EXECUTE FUNCTION retention_redact_recruitment_feedback();

DROP TRIGGER "RecruitmentOffer_guard" ON "RecruitmentOffer";
CREATE TRIGGER "RecruitmentOffer_guard" BEFORE INSERT OR DELETE ON "RecruitmentOffer"
  FOR EACH ROW EXECUTE FUNCTION guard_recruitment_offer();
CREATE TRIGGER "RecruitmentOffer_guard_update" BEFORE UPDATE ON "RecruitmentOffer"
  FOR EACH ROW WHEN (NOT hrms_retention_active()) EXECUTE FUNCTION guard_recruitment_offer();
CREATE TRIGGER "RecruitmentOffer_retention_update" BEFORE UPDATE ON "RecruitmentOffer"
  FOR EACH ROW WHEN (hrms_retention_active()) EXECUTE FUNCTION retention_redact_recruitment_offer();

DROP TRIGGER "RecruitmentCandidateDocument_guard" ON "RecruitmentCandidateDocument";
CREATE TRIGGER "RecruitmentCandidateDocument_guard" BEFORE INSERT OR DELETE ON "RecruitmentCandidateDocument"
  FOR EACH ROW EXECUTE FUNCTION guard_recruitment_document();
CREATE TRIGGER "RecruitmentCandidateDocument_guard_update" BEFORE UPDATE ON "RecruitmentCandidateDocument"
  FOR EACH ROW WHEN (NOT hrms_retention_active()) EXECUTE FUNCTION guard_recruitment_document();
CREATE TRIGGER "RecruitmentCandidateDocument_retention_update" BEFORE UPDATE ON "RecruitmentCandidateDocument"
  FOR EACH ROW WHEN (hrms_retention_active()) EXECUTE FUNCTION retention_redact_recruitment_document();
