
-- CreateEnum
CREATE TYPE "OrganizationModule" AS ENUM ('ATTENDANCE', 'SCHEDULING', 'LEAVE', 'COMPENSATION', 'PAYROLL', 'BENEFITS', 'PERFORMANCE', 'RECRUITMENT', 'ONBOARDING', 'DOCUMENTS', 'NOTIFICATIONS', 'GOOGLE_WORKSPACE', 'REPORTING');

-- CreateEnum
CREATE TYPE "OrganizationSettingChangeKind" AS ENUM ('MODULE', 'SETTING');

-- CreateTable
CREATE TABLE "OrganizationModuleSetting" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "module" "OrganizationModule" NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedByUserId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "OrganizationModuleSetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrganizationSetting" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB,
    "schemaVersion" INTEGER NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedByUserId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "OrganizationSetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrganizationSettingChange" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "kind" "OrganizationSettingChangeKind" NOT NULL,
    "subject" TEXT NOT NULL,
    "oldValue" JSONB,
    "newValue" JSONB,
    "version" INTEGER NOT NULL,
    "actorUserId" UUID,
    "changedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrganizationSettingChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationModuleSetting_organizationId_module_key" ON "OrganizationModuleSetting"("organizationId", "module");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationSetting_organizationId_key_key" ON "OrganizationSetting"("organizationId", "key");

-- CreateIndex
CREATE INDEX "OrganizationSettingChange_organizationId_changedAt_idx" ON "OrganizationSettingChange"("organizationId", "changedAt");

-- AddForeignKey
ALTER TABLE "OrganizationModuleSetting" ADD CONSTRAINT "OrganizationModuleSetting_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationSetting" ADD CONSTRAINT "OrganizationSetting_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationSettingChange" ADD CONSTRAINT "OrganizationSettingChange_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ─── Phase 18 integrity: checks ──────────────────────────────────────────────

ALTER TABLE "OrganizationModuleSetting"
  ADD CONSTRAINT "OrganizationModuleSetting_version_check" CHECK ("version" >= 1);

ALTER TABLE "OrganizationSetting"
  ADD CONSTRAINT "OrganizationSetting_key_check" CHECK ("key" ~ '^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$' AND length("key") <= 100),
  ADD CONSTRAINT "OrganizationSetting_value_check" CHECK ("value" IS NULL OR jsonb_typeof("value") IN ('boolean', 'number', 'string')),
  ADD CONSTRAINT "OrganizationSetting_schema_version_check" CHECK ("schemaVersion" >= 1),
  ADD CONSTRAINT "OrganizationSetting_version_check" CHECK ("version" >= 1);

ALTER TABLE "OrganizationSettingChange"
  ADD CONSTRAINT "OrganizationSettingChange_subject_check" CHECK (
    ("kind" = 'MODULE' AND "subject" ~ '^[A-Z][A-Z_]*$')
    OR ("kind" = 'SETTING' AND "subject" ~ '^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$' AND length("subject") <= 100)
  ),
  ADD CONSTRAINT "OrganizationSettingChange_value_check" CHECK (
    ("oldValue" IS NULL OR jsonb_typeof("oldValue") IN ('boolean', 'number', 'string'))
    AND ("newValue" IS NULL OR jsonb_typeof("newValue") IN ('boolean', 'number', 'string'))
  ),
  ADD CONSTRAINT "OrganizationSettingChange_version_check" CHECK ("version" >= 1);

-- ─── Phase 18 integrity: guards ──────────────────────────────────────────────

-- Module and setting rows are never deleted (a reset keeps the row with a NULL value), their
-- identity never changes, and every change increments the version by exactly one.
CREATE FUNCTION guard_organization_configuration_row() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Organization configuration rows are never deleted.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."version" <> 1 THEN
      RAISE EXCEPTION 'A configuration row starts at version 1.' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."id" <> OLD."id" OR NEW."organizationId" <> OLD."organizationId" OR NEW."createdAt" <> OLD."createdAt" THEN
    RAISE EXCEPTION 'A configuration row''s organization never changes.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_TABLE_NAME = 'OrganizationModuleSetting' THEN
    IF NEW."module" <> OLD."module" THEN
      RAISE EXCEPTION 'A module setting''s module never changes.' USING ERRCODE = 'restrict_violation';
    END IF;
  ELSE
    IF NEW."key" <> OLD."key" THEN
      RAISE EXCEPTION 'A setting''s key never changes.' USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  IF NEW."version" <> OLD."version" + 1 THEN
    RAISE EXCEPTION 'Each configuration change increments the version by one.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "OrganizationModuleSetting_guard" BEFORE INSERT OR UPDATE OR DELETE ON "OrganizationModuleSetting"
  FOR EACH ROW EXECUTE FUNCTION guard_organization_configuration_row();
CREATE TRIGGER "OrganizationSetting_guard" BEFORE INSERT OR UPDATE OR DELETE ON "OrganizationSetting"
  FOR EACH ROW EXECUTE FUNCTION guard_organization_configuration_row();

-- The change history is append-only.
CREATE FUNCTION guard_organization_setting_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'The configuration change history is append-only.' USING ERRCODE = 'restrict_violation';
END $$;

CREATE TRIGGER "OrganizationSettingChange_guard" BEFORE UPDATE OR DELETE ON "OrganizationSettingChange"
  FOR EACH ROW EXECUTE FUNCTION guard_organization_setting_change();
