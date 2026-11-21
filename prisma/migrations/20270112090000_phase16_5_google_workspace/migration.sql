-- CreateEnum
CREATE TYPE "GoogleConnectionMode" AS ENUM ('OAUTH', 'SERVICE_ACCOUNT');

-- CreateEnum
CREATE TYPE "GoogleConnectionStatus" AS ENUM ('ACTIVE', 'ERROR', 'DISCONNECTED', 'CREDENTIALS_UNAVAILABLE');

-- CreateEnum
CREATE TYPE "GoogleCapability" AS ENUM ('FORMS', 'DRIVE_METADATA', 'GMAIL_SEND', 'SHEETS_EXPORT');

-- CreateEnum
CREATE TYPE "GoogleFormBindingTarget" AS ENUM ('PERFORMANCE_EVIDENCE', 'RECRUITMENT_INTAKE', 'ONBOARDING_TASKS');

-- CreateEnum
CREATE TYPE "GoogleSyncTrigger" AS ENUM ('MANUAL', 'SCHEDULED');

-- CreateEnum
CREATE TYPE "GoogleSyncRunStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED');

-- CreateTable
CREATE TABLE "GoogleWorkspaceConnection" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "mode" "GoogleConnectionMode" NOT NULL,
    "status" "GoogleConnectionStatus" NOT NULL,
    "workspaceDomain" TEXT,
    "accountEmail" TEXT,
    "serviceAccountEmail" TEXT,
    "grantedScopes" TEXT[],
    "capabilities" "GoogleCapability"[],
    "credentialCiphertext" TEXT,
    "credentialKeyId" TEXT,
    "credentialVersion" INTEGER NOT NULL DEFAULT 1,
    "lastHealthCheckAt" TIMESTAMPTZ(6),
    "lastHealthOk" BOOLEAN,
    "lastErrorCode" TEXT,
    "createdByUserId" UUID,
    "connectedByUserId" UUID,
    "connectedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "disconnectedByUserId" UUID,
    "disconnectedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "GoogleWorkspaceConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GoogleOAuthState" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "initiatedByUserId" UUID NOT NULL,
    "stateHash" TEXT NOT NULL,
    "browserBindingHash" TEXT NOT NULL,
    "codeVerifierCiphertext" TEXT NOT NULL,
    "codeVerifierKeyId" TEXT NOT NULL,
    "requestedScopes" TEXT[],
    "capabilities" "GoogleCapability"[],
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "consumedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GoogleOAuthState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GoogleFormBinding" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "formId" TEXT NOT NULL,
    "formTitle" TEXT,
    "target" "GoogleFormBindingTarget" NOT NULL,
    "performanceSourceId" UUID,
    "recruitmentSourceId" UUID,
    "mapping" JSONB NOT NULL,
    "mappingSchemaVersion" INTEGER NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "cursorSubmittedAt" TEXT,
    "cursorResponseId" TEXT,
    "lastSyncAt" TIMESTAMPTZ(6),
    "lastSuccessAt" TIMESTAMPTZ(6),
    "lastFailureAt" TIMESTAMPTZ(6),
    "lastErrorCode" TEXT,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "nextSyncAfter" TIMESTAMPTZ(6),
    "createdByUserId" UUID,
    "updatedByUserId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "archivedAt" TIMESTAMPTZ(6),

    CONSTRAINT "GoogleFormBinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GoogleSyncRun" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "bindingId" UUID NOT NULL,
    "target" "GoogleFormBindingTarget" NOT NULL,
    "trigger" "GoogleSyncTrigger" NOT NULL,
    "triggeredByUserId" UUID,
    "status" "GoogleSyncRunStatus" NOT NULL,
    "startedAt" TIMESTAMPTZ(6) NOT NULL,
    "leaseExpiresAt" TIMESTAMPTZ(6) NOT NULL,
    "finishedAt" TIMESTAMPTZ(6),
    "fetched" INTEGER NOT NULL DEFAULT 0,
    "accepted" INTEGER NOT NULL DEFAULT 0,
    "duplicates" INTEGER NOT NULL DEFAULT 0,
    "rejected" INTEGER NOT NULL DEFAULT 0,
    "errorCode" TEXT,

    CONSTRAINT "GoogleSyncRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GoogleWorkspaceConnection_organizationId_status_idx" ON "GoogleWorkspaceConnection"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "GoogleWorkspaceConnection_id_organizationId_key" ON "GoogleWorkspaceConnection"("id", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "GoogleOAuthState_stateHash_key" ON "GoogleOAuthState"("stateHash");

-- CreateIndex
CREATE INDEX "GoogleOAuthState_expiresAt_idx" ON "GoogleOAuthState"("expiresAt");

-- CreateIndex
CREATE INDEX "GoogleFormBinding_organizationId_archivedAt_idx" ON "GoogleFormBinding"("organizationId", "archivedAt");

-- CreateIndex
CREATE INDEX "GoogleFormBinding_formId_idx" ON "GoogleFormBinding"("formId");

-- CreateIndex
CREATE UNIQUE INDEX "GoogleFormBinding_id_organizationId_key" ON "GoogleFormBinding"("id", "organizationId");

-- CreateIndex
CREATE INDEX "GoogleSyncRun_organizationId_startedAt_idx" ON "GoogleSyncRun"("organizationId", "startedAt");

-- CreateIndex
CREATE INDEX "GoogleSyncRun_bindingId_startedAt_idx" ON "GoogleSyncRun"("bindingId", "startedAt");

-- AddForeignKey
ALTER TABLE "GoogleWorkspaceConnection" ADD CONSTRAINT "GoogleWorkspaceConnection_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoogleOAuthState" ADD CONSTRAINT "GoogleOAuthState_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoogleOAuthState" ADD CONSTRAINT "GoogleOAuthState_initiatedByUserId_fkey" FOREIGN KEY ("initiatedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoogleFormBinding" ADD CONSTRAINT "GoogleFormBinding_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoogleFormBinding" ADD CONSTRAINT "GoogleFormBinding_performanceSourceId_organizationId_fkey" FOREIGN KEY ("performanceSourceId", "organizationId") REFERENCES "PerformanceEvidenceSource"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoogleFormBinding" ADD CONSTRAINT "GoogleFormBinding_recruitmentSourceId_organizationId_fkey" FOREIGN KEY ("recruitmentSourceId", "organizationId") REFERENCES "RecruitmentIntakeSource"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoogleSyncRun" ADD CONSTRAINT "GoogleSyncRun_bindingId_organizationId_fkey" FOREIGN KEY ("bindingId", "organizationId") REFERENCES "GoogleFormBinding"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ─── Phase 16.5 integrity: checks, partial uniques and guard triggers ───────────

ALTER TABLE "GoogleWorkspaceConnection"
  ADD CONSTRAINT "GoogleWorkspaceConnection_disconnect_check" CHECK (("status" = 'DISCONNECTED') = ("disconnectedAt" IS NOT NULL)),
  -- Credentials exist exactly while connected; a disconnected connection keeps no ciphertext.
  ADD CONSTRAINT "GoogleWorkspaceConnection_credentials_check" CHECK (
    ("credentialCiphertext" IS NULL) = ("credentialKeyId" IS NULL)
    AND (("status" = 'DISCONNECTED') = ("credentialCiphertext" IS NULL))
    AND ("credentialKeyId" IS NULL OR "credentialKeyId" ~ '^[a-z0-9-]{1,40}$')
    AND ("credentialCiphertext" IS NULL OR length("credentialCiphertext") <= 20000)
    AND "credentialVersion" >= 1
  ),
  ADD CONSTRAINT "GoogleWorkspaceConnection_mode_check" CHECK (("mode" = 'SERVICE_ACCOUNT') = ("serviceAccountEmail" IS NOT NULL)),
  -- Only the minimal scopes this integration requests are ever recorded.
  ADD CONSTRAINT "GoogleWorkspaceConnection_scopes_check" CHECK ("grantedScopes" <@ ARRAY[
    'openid', 'email',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/forms.body.readonly',
    'https://www.googleapis.com/auth/forms.responses.readonly',
    'https://www.googleapis.com/auth/drive.metadata.readonly',
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/drive.file'
  ]::text[]),
  ADD CONSTRAINT "GoogleWorkspaceConnection_capabilities_check" CHECK ("status" = 'DISCONNECTED' OR cardinality("capabilities") >= 1),
  ADD CONSTRAINT "GoogleWorkspaceConnection_identity_check" CHECK (
    ("workspaceDomain" IS NULL OR ("workspaceDomain" ~ '^[a-z0-9.-]{1,253}$' AND "workspaceDomain" = lower("workspaceDomain")))
    AND ("accountEmail" IS NULL OR length("accountEmail") <= 320)
    AND ("serviceAccountEmail" IS NULL OR length("serviceAccountEmail") <= 320)
  ),
  ADD CONSTRAINT "GoogleWorkspaceConnection_error_check" CHECK ("lastErrorCode" IS NULL OR "lastErrorCode" ~ '^[A-Z][A-Z0-9_]{0,63}$');

-- One connection per organization that is not disconnected.
CREATE UNIQUE INDEX "GoogleWorkspaceConnection_current_key"
  ON "GoogleWorkspaceConnection"("organizationId") WHERE "status" <> 'DISCONNECTED';

ALTER TABLE "GoogleOAuthState"
  ADD CONSTRAINT "GoogleOAuthState_hash_check" CHECK ("stateHash" ~ '^[0-9a-f]{64}$' AND "browserBindingHash" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "GoogleOAuthState_expiry_check" CHECK ("expiresAt" > "createdAt" AND "expiresAt" <= "createdAt" + interval '15 minutes'),
  ADD CONSTRAINT "GoogleOAuthState_consumed_check" CHECK ("consumedAt" IS NULL OR "consumedAt" >= "createdAt"),
  ADD CONSTRAINT "GoogleOAuthState_verifier_check" CHECK ("codeVerifierKeyId" ~ '^[a-z0-9-]{1,40}$' AND length("codeVerifierCiphertext") <= 2000),
  ADD CONSTRAINT "GoogleOAuthState_capabilities_check" CHECK (cardinality("capabilities") >= 1);

ALTER TABLE "GoogleFormBinding"
  ADD CONSTRAINT "GoogleFormBinding_target_check" CHECK (
    ("target" = 'PERFORMANCE_EVIDENCE' AND "performanceSourceId" IS NOT NULL AND "recruitmentSourceId" IS NULL)
    OR ("target" = 'RECRUITMENT_INTAKE' AND "recruitmentSourceId" IS NOT NULL AND "performanceSourceId" IS NULL)
    OR ("target" = 'ONBOARDING_TASKS' AND "performanceSourceId" IS NULL AND "recruitmentSourceId" IS NULL)
  ),
  ADD CONSTRAINT "GoogleFormBinding_form_check" CHECK ("formId" ~ '^[A-Za-z0-9_-]{10,200}$' AND ("formTitle" IS NULL OR length("formTitle") <= 300)),
  ADD CONSTRAINT "GoogleFormBinding_mapping_check" CHECK (jsonb_typeof("mapping") = 'object' AND "mappingSchemaVersion" >= 1),
  ADD CONSTRAINT "GoogleFormBinding_cursor_check" CHECK (
    ("cursorSubmittedAt" IS NULL) = ("cursorResponseId" IS NULL)
    AND ("cursorSubmittedAt" IS NULL OR "cursorSubmittedAt" ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{9}Z$')
    AND ("cursorResponseId" IS NULL OR length("cursorResponseId") BETWEEN 1 AND 300)
  ),
  ADD CONSTRAINT "GoogleFormBinding_failures_check" CHECK ("consecutiveFailures" BETWEEN 0 AND 100000),
  ADD CONSTRAINT "GoogleFormBinding_archive_check" CHECK ("archivedAt" IS NULL OR NOT "enabled"),
  ADD CONSTRAINT "GoogleFormBinding_error_check" CHECK ("lastErrorCode" IS NULL OR "lastErrorCode" ~ '^[A-Z][A-Z0-9_]{0,63}$');

-- A form feeds one live binding per target, and a domain source has one live binding.
CREATE UNIQUE INDEX "GoogleFormBinding_form_target_key"
  ON "GoogleFormBinding"("formId", "target") WHERE "archivedAt" IS NULL;
CREATE UNIQUE INDEX "GoogleFormBinding_performance_source_key"
  ON "GoogleFormBinding"("performanceSourceId") WHERE "archivedAt" IS NULL AND "performanceSourceId" IS NOT NULL;
CREATE UNIQUE INDEX "GoogleFormBinding_recruitment_source_key"
  ON "GoogleFormBinding"("recruitmentSourceId") WHERE "archivedAt" IS NULL AND "recruitmentSourceId" IS NOT NULL;

ALTER TABLE "GoogleSyncRun"
  ADD CONSTRAINT "GoogleSyncRun_state_check" CHECK (("status" = 'RUNNING') = ("finishedAt" IS NULL)),
  ADD CONSTRAINT "GoogleSyncRun_time_check" CHECK ("leaseExpiresAt" > "startedAt" AND ("finishedAt" IS NULL OR "finishedAt" >= "startedAt")),
  ADD CONSTRAINT "GoogleSyncRun_counts_check" CHECK ("fetched" >= 0 AND "accepted" >= 0 AND "duplicates" >= 0 AND "rejected" >= 0),
  ADD CONSTRAINT "GoogleSyncRun_error_check" CHECK (
    ("errorCode" IS NULL OR "errorCode" ~ '^[A-Z][A-Z0-9_]{0,63}$')
    AND ("status" <> 'FAILED' OR "errorCode" IS NOT NULL)
  ),
  ADD CONSTRAINT "GoogleSyncRun_trigger_check" CHECK ("trigger" = 'SCHEDULED' OR "triggeredByUserId" IS NOT NULL);

-- At most one running synchronization per binding.
CREATE UNIQUE INDEX "GoogleSyncRun_running_key"
  ON "GoogleSyncRun"("bindingId") WHERE "status" = 'RUNNING';

CREATE FUNCTION guard_google_workspace_connection() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Google Workspace connections are disconnected, never deleted.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'ACTIVE' OR NEW."credentialVersion" <> 1 THEN
      RAISE EXCEPTION 'A connection starts active with its first credentials.' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."organizationId" <> OLD."organizationId" OR NEW."mode" <> OLD."mode"
     OR NEW."createdAt" <> OLD."createdAt" OR NEW."createdByUserId" IS DISTINCT FROM OLD."createdByUserId" THEN
    RAISE EXCEPTION 'A connection''s organization and mode never change.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."status" = 'DISCONNECTED' THEN
    RAISE EXCEPTION 'A disconnected connection is kept for history only.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."credentialVersion" < OLD."credentialVersion" THEN
    RAISE EXCEPTION 'A credential version never decreases.' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" <> 'DISCONNECTED'
     AND NEW."credentialCiphertext" IS DISTINCT FROM OLD."credentialCiphertext"
     AND NEW."credentialVersion" <> OLD."credentialVersion" + 1 THEN
    RAISE EXCEPTION 'Each credential change increments the credential version.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "GoogleWorkspaceConnection_guard" BEFORE INSERT OR UPDATE OR DELETE ON "GoogleWorkspaceConnection"
  FOR EACH ROW EXECUTE FUNCTION guard_google_workspace_connection();

CREATE FUNCTION guard_google_oauth_state() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."consumedAt" IS NULL AND OLD."expiresAt" > now() THEN
      RAISE EXCEPTION 'Only consumed or expired authorization states are pruned.' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."consumedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'An authorization state starts unused.' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."consumedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'An authorization state is used once.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."organizationId" <> OLD."organizationId" OR NEW."initiatedByUserId" <> OLD."initiatedByUserId"
     OR NEW."stateHash" <> OLD."stateHash" OR NEW."browserBindingHash" <> OLD."browserBindingHash"
     OR NEW."codeVerifierCiphertext" <> OLD."codeVerifierCiphertext" OR NEW."codeVerifierKeyId" <> OLD."codeVerifierKeyId"
     OR NEW."requestedScopes" <> OLD."requestedScopes" OR NEW."capabilities" <> OLD."capabilities"
     OR NEW."expiresAt" <> OLD."expiresAt" OR NEW."createdAt" <> OLD."createdAt" THEN
    RAISE EXCEPTION 'An authorization state never changes except when consumed.' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "GoogleOAuthState_guard" BEFORE INSERT OR UPDATE OR DELETE ON "GoogleOAuthState"
  FOR EACH ROW EXECUTE FUNCTION guard_google_oauth_state();

CREATE FUNCTION guard_google_form_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Form bindings are archived, never deleted.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."archivedAt" IS NOT NULL OR NEW."cursorSubmittedAt" IS NOT NULL OR NEW."consecutiveFailures" <> 0 THEN
      RAISE EXCEPTION 'A binding starts live with no cursor and no failures.' USING ERRCODE = 'check_violation';
    END IF;
    -- A Google Form is bound by one organization only (serialized per form).
    PERFORM pg_advisory_xact_lock(hashtextextended('google-form:' || NEW."formId", 0));
    IF EXISTS (SELECT 1 FROM "GoogleFormBinding"
               WHERE "formId" = NEW."formId" AND "organizationId" <> NEW."organizationId") THEN
      RAISE EXCEPTION 'The form is bound by another organization.' USING ERRCODE = 'unique_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."organizationId" <> OLD."organizationId" OR NEW."formId" <> OLD."formId" OR NEW."target" <> OLD."target"
     OR NEW."performanceSourceId" IS DISTINCT FROM OLD."performanceSourceId"
     OR NEW."recruitmentSourceId" IS DISTINCT FROM OLD."recruitmentSourceId"
     OR NEW."createdAt" <> OLD."createdAt" OR NEW."createdByUserId" IS DISTINCT FROM OLD."createdByUserId" THEN
    RAISE EXCEPTION 'A binding''s organization, form, target and source never change.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."archivedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'An archived binding is frozen.' USING ERRCODE = 'restrict_violation';
  END IF;
  -- The cursor only moves forward.
  IF OLD."cursorSubmittedAt" IS NOT NULL AND (
       NEW."cursorSubmittedAt" IS NULL
       OR (NEW."cursorSubmittedAt", NEW."cursorResponseId") < (OLD."cursorSubmittedAt", OLD."cursorResponseId")) THEN
    RAISE EXCEPTION 'A binding cursor never moves backwards.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "GoogleFormBinding_guard" BEFORE INSERT OR UPDATE OR DELETE ON "GoogleFormBinding"
  FOR EACH ROW EXECUTE FUNCTION guard_google_form_binding();

CREATE FUNCTION guard_google_sync_run() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  binding_target "GoogleFormBindingTarget";
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Synchronization runs are append-only.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'RUNNING' OR NEW."fetched" <> 0 OR NEW."accepted" <> 0
       OR NEW."duplicates" <> 0 OR NEW."rejected" <> 0 OR NEW."errorCode" IS NOT NULL THEN
      RAISE EXCEPTION 'A synchronization run starts running with no counts.' USING ERRCODE = 'check_violation';
    END IF;
    SELECT "target" INTO binding_target FROM "GoogleFormBinding" WHERE "id" = NEW."bindingId";
    IF binding_target IS DISTINCT FROM NEW."target" THEN
      RAISE EXCEPTION 'A run records its binding''s target.' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."status" <> 'RUNNING' THEN
    RAISE EXCEPTION 'A finished synchronization run is final.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."organizationId" <> OLD."organizationId" OR NEW."bindingId" <> OLD."bindingId"
     OR NEW."target" <> OLD."target" OR NEW."trigger" <> OLD."trigger"
     OR NEW."triggeredByUserId" IS DISTINCT FROM OLD."triggeredByUserId" OR NEW."startedAt" <> OLD."startedAt" THEN
    RAISE EXCEPTION 'A run''s binding, trigger and start never change.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."fetched" < OLD."fetched" OR NEW."accepted" < OLD."accepted"
     OR NEW."duplicates" < OLD."duplicates" OR NEW."rejected" < OLD."rejected" THEN
    RAISE EXCEPTION 'Run counts only grow.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "GoogleSyncRun_guard" BEFORE INSERT OR UPDATE OR DELETE ON "GoogleSyncRun"
  FOR EACH ROW EXECUTE FUNCTION guard_google_sync_run();
