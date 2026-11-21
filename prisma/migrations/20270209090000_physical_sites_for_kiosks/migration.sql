-- Introduce PhysicalSite as the physical premise behind logical WorkLocations and kiosk devices.
-- Existing data is backfilled one-to-one from WorkLocation to avoid ambiguous address merging.

CREATE TABLE "PhysicalSite" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organizationId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "addressLine1" TEXT,
    "addressLine2" TEXT,
    "city" TEXT,
    "stateProvince" TEXT,
    "postalCode" TEXT,
    "country" TEXT,
    "sourceWorkLocationId" UUID,
    "archivedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "PhysicalSite_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PhysicalSite_id_organizationId_key" ON "PhysicalSite"("id", "organizationId");
CREATE INDEX "PhysicalSite_organizationId_archivedAt_name_idx" ON "PhysicalSite"("organizationId", "archivedAt", "name");

ALTER TABLE "PhysicalSite"
    ADD CONSTRAINT "PhysicalSite_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "WorkLocation" ADD COLUMN "physicalSiteId" UUID;

INSERT INTO "PhysicalSite" (
    "id",
    "organizationId",
    "name",
    "addressLine1",
    "addressLine2",
    "city",
    "stateProvince",
    "postalCode",
    "country",
    "sourceWorkLocationId",
    "archivedAt",
    "createdAt",
    "updatedAt"
)
SELECT
    gen_random_uuid(),
    "organizationId",
    "name",
    "addressLine1",
    "addressLine2",
    "city",
    "stateProvince",
    "postalCode",
    "country",
    "id",
    "archivedAt",
    "createdAt",
    "updatedAt"
FROM "WorkLocation";

UPDATE "WorkLocation" wl
SET "physicalSiteId" = ps."id"
FROM "PhysicalSite" ps
WHERE ps."organizationId" = wl."organizationId"
  AND ps."sourceWorkLocationId" = wl."id";

ALTER TABLE "PhysicalSite" DROP COLUMN "sourceWorkLocationId";

CREATE INDEX "WorkLocation_physicalSiteId_idx" ON "WorkLocation"("physicalSiteId");

ALTER TABLE "WorkLocation"
    ADD CONSTRAINT "WorkLocation_physicalSiteId_organizationId_fkey"
    FOREIGN KEY ("physicalSiteId", "organizationId") REFERENCES "PhysicalSite"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "AttendanceDevice" ADD COLUMN "physicalSiteId" UUID;

UPDATE "AttendanceDevice" ad
SET "physicalSiteId" = wl."physicalSiteId"
FROM "WorkLocation" wl
WHERE wl."id" = ad."workLocationId"
  AND wl."organizationId" = ad."organizationId";

ALTER TABLE "AttendanceDevice" ALTER COLUMN "physicalSiteId" SET NOT NULL;

ALTER TABLE "AttendanceDevice" DROP CONSTRAINT "AttendanceDevice_workLocationId_organizationId_fkey";
DROP INDEX "AttendanceDevice_workLocationId_idx";

ALTER TABLE "AttendanceDevice" DROP COLUMN "workLocationId";

CREATE INDEX "AttendanceDevice_physicalSiteId_idx" ON "AttendanceDevice"("physicalSiteId");

ALTER TABLE "AttendanceDevice"
    ADD CONSTRAINT "AttendanceDevice_physicalSiteId_organizationId_fkey"
    FOREIGN KEY ("physicalSiteId", "organizationId") REFERENCES "PhysicalSite"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;
