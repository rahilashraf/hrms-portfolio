-- CreateTable
CREATE TABLE "Organization" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "archivedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrganizationalUnit" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "parentUnitId" UUID,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "archivedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "OrganizationalUnit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Department" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "organizationalUnitId" UUID,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "archivedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Department_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Team" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "departmentId" UUID,
    "organizationalUnitId" UUID,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "archivedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Team_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobTitle" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "archivedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "JobTitle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Position" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "jobTitleId" UUID NOT NULL,
    "organizationalUnitId" UUID,
    "departmentId" UUID,
    "teamId" UUID,
    "workLocationId" UUID,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "archivedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "Position_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkLocation" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT,
    "addressLine1" TEXT,
    "addressLine2" TEXT,
    "city" TEXT,
    "stateProvince" TEXT,
    "postalCode" TEXT,
    "country" TEXT,
    "timezone" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "archivedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "WorkLocation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Organization_code_key" ON "Organization"("code");

-- CreateIndex
CREATE INDEX "Organization_archivedAt_sortOrder_idx" ON "Organization"("archivedAt", "sortOrder");

-- CreateIndex
CREATE INDEX "OrganizationalUnit_organizationId_archivedAt_sortOrder_idx" ON "OrganizationalUnit"("organizationId", "archivedAt", "sortOrder");

-- CreateIndex
CREATE INDEX "OrganizationalUnit_organizationId_parentUnitId_idx" ON "OrganizationalUnit"("organizationId", "parentUnitId");

-- CreateIndex
CREATE INDEX "OrganizationalUnit_parentUnitId_idx" ON "OrganizationalUnit"("parentUnitId");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationalUnit_organizationId_code_key" ON "OrganizationalUnit"("organizationId", "code");

-- CreateIndex
CREATE INDEX "Department_organizationId_archivedAt_sortOrder_idx" ON "Department"("organizationId", "archivedAt", "sortOrder");

-- CreateIndex
CREATE INDEX "Department_organizationId_organizationalUnitId_idx" ON "Department"("organizationId", "organizationalUnitId");

-- CreateIndex
CREATE INDEX "Department_organizationalUnitId_idx" ON "Department"("organizationalUnitId");

-- CreateIndex
CREATE UNIQUE INDEX "Department_organizationId_code_key" ON "Department"("organizationId", "code");

-- CreateIndex
CREATE INDEX "Team_organizationId_archivedAt_sortOrder_idx" ON "Team"("organizationId", "archivedAt", "sortOrder");

-- CreateIndex
CREATE INDEX "Team_organizationId_departmentId_idx" ON "Team"("organizationId", "departmentId");

-- CreateIndex
CREATE INDEX "Team_organizationId_organizationalUnitId_idx" ON "Team"("organizationId", "organizationalUnitId");

-- CreateIndex
CREATE INDEX "Team_departmentId_idx" ON "Team"("departmentId");

-- CreateIndex
CREATE INDEX "Team_organizationalUnitId_idx" ON "Team"("organizationalUnitId");

-- CreateIndex
CREATE UNIQUE INDEX "Team_organizationId_code_key" ON "Team"("organizationId", "code");

-- CreateIndex
CREATE INDEX "JobTitle_organizationId_archivedAt_sortOrder_idx" ON "JobTitle"("organizationId", "archivedAt", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "JobTitle_organizationId_code_key" ON "JobTitle"("organizationId", "code");

-- CreateIndex
CREATE INDEX "Position_organizationId_archivedAt_sortOrder_idx" ON "Position"("organizationId", "archivedAt", "sortOrder");

-- CreateIndex
CREATE INDEX "Position_organizationId_jobTitleId_idx" ON "Position"("organizationId", "jobTitleId");

-- CreateIndex
CREATE INDEX "Position_organizationId_departmentId_idx" ON "Position"("organizationId", "departmentId");

-- CreateIndex
CREATE INDEX "Position_organizationId_teamId_idx" ON "Position"("organizationId", "teamId");

-- CreateIndex
CREATE INDEX "Position_organizationId_organizationalUnitId_idx" ON "Position"("organizationId", "organizationalUnitId");

-- CreateIndex
CREATE INDEX "Position_workLocationId_idx" ON "Position"("workLocationId");

-- CreateIndex
CREATE UNIQUE INDEX "Position_organizationId_code_key" ON "Position"("organizationId", "code");

-- CreateIndex
CREATE INDEX "WorkLocation_organizationId_archivedAt_sortOrder_idx" ON "WorkLocation"("organizationId", "archivedAt", "sortOrder");

-- CreateIndex
CREATE INDEX "WorkLocation_timezone_idx" ON "WorkLocation"("timezone");

-- CreateIndex
CREATE UNIQUE INDEX "WorkLocation_organizationId_code_key" ON "WorkLocation"("organizationId", "code");

-- AddForeignKey
ALTER TABLE "OrganizationalUnit" ADD CONSTRAINT "OrganizationalUnit_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationalUnit" ADD CONSTRAINT "OrganizationalUnit_parentUnitId_fkey" FOREIGN KEY ("parentUnitId") REFERENCES "OrganizationalUnit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Department" ADD CONSTRAINT "Department_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Department" ADD CONSTRAINT "Department_organizationalUnitId_fkey" FOREIGN KEY ("organizationalUnitId") REFERENCES "OrganizationalUnit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Team" ADD CONSTRAINT "Team_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Team" ADD CONSTRAINT "Team_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Team" ADD CONSTRAINT "Team_organizationalUnitId_fkey" FOREIGN KEY ("organizationalUnitId") REFERENCES "OrganizationalUnit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobTitle" ADD CONSTRAINT "JobTitle_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Position" ADD CONSTRAINT "Position_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Position" ADD CONSTRAINT "Position_jobTitleId_fkey" FOREIGN KEY ("jobTitleId") REFERENCES "JobTitle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Position" ADD CONSTRAINT "Position_organizationalUnitId_fkey" FOREIGN KEY ("organizationalUnitId") REFERENCES "OrganizationalUnit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Position" ADD CONSTRAINT "Position_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Position" ADD CONSTRAINT "Position_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Position" ADD CONSTRAINT "Position_workLocationId_fkey" FOREIGN KEY ("workLocationId") REFERENCES "WorkLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkLocation" ADD CONSTRAINT "WorkLocation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
