-- CreateTable
CREATE TABLE "OrganizationBranding" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "displayName" TEXT,
    "shortName" TEXT,
    "logoUrl" TEXT,
    "iconUrl" TEXT,
    "loginLogoUrl" TEXT,
    "primaryColor" TEXT,
    "secondaryColor" TEXT,
    "loginSubtitle" TEXT,
    "websiteUrl" TEXT,
    "supportEmail" TEXT,
    "publicLoginEnabled" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedByUserId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "OrganizationBranding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationBranding_organizationId_key" ON "OrganizationBranding"("organizationId");

-- AddForeignKey
ALTER TABLE "OrganizationBranding" ADD CONSTRAINT "OrganizationBranding_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ─── Phase 20 integrity: checks ──────────────────────────────────────────────
-- Branding holds references only: https URLs (never data: or other schemes, never binaries),
-- #RRGGBB colors, bounded text. The API validates the same rules; these are the final guard.

ALTER TABLE "OrganizationBranding"
  ADD CONSTRAINT "OrganizationBranding_version_check" CHECK ("version" >= 1),
  ADD CONSTRAINT "OrganizationBranding_display_name_check" CHECK ("displayName" IS NULL OR (length(btrim("displayName")) BETWEEN 1 AND 120 AND "displayName" = btrim("displayName"))),
  ADD CONSTRAINT "OrganizationBranding_short_name_check" CHECK ("shortName" IS NULL OR (length(btrim("shortName")) BETWEEN 1 AND 40 AND "shortName" = btrim("shortName"))),
  ADD CONSTRAINT "OrganizationBranding_login_subtitle_check" CHECK ("loginSubtitle" IS NULL OR (length(btrim("loginSubtitle")) BETWEEN 1 AND 200 AND "loginSubtitle" = btrim("loginSubtitle"))),
  ADD CONSTRAINT "OrganizationBranding_logo_url_check" CHECK ("logoUrl" IS NULL OR ("logoUrl" ~ '^https://[^\s/?#@]+[^\s]*$' AND length("logoUrl") <= 2048)),
  ADD CONSTRAINT "OrganizationBranding_icon_url_check" CHECK ("iconUrl" IS NULL OR ("iconUrl" ~ '^https://[^\s/?#@]+[^\s]*$' AND length("iconUrl") <= 2048)),
  ADD CONSTRAINT "OrganizationBranding_login_logo_url_check" CHECK ("loginLogoUrl" IS NULL OR ("loginLogoUrl" ~ '^https://[^\s/?#@]+[^\s]*$' AND length("loginLogoUrl") <= 2048)),
  ADD CONSTRAINT "OrganizationBranding_website_url_check" CHECK ("websiteUrl" IS NULL OR ("websiteUrl" ~ '^https://[^\s/?#@]+[^\s]*$' AND length("websiteUrl") <= 2048)),
  ADD CONSTRAINT "OrganizationBranding_primary_color_check" CHECK ("primaryColor" IS NULL OR "primaryColor" ~ '^#[0-9A-F]{6}$'),
  ADD CONSTRAINT "OrganizationBranding_secondary_color_check" CHECK ("secondaryColor" IS NULL OR "secondaryColor" ~ '^#[0-9A-F]{6}$'),
  ADD CONSTRAINT "OrganizationBranding_support_email_check" CHECK ("supportEmail" IS NULL OR ("supportEmail" ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' AND length("supportEmail") <= 254));
