CREATE SEQUENCE "employee_number_seq" AS bigint START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;

ALTER TABLE "Person"
  ADD COLUMN "firstName" TEXT,
  ADD COLUMN "middleName" TEXT,
  ADD COLUMN "lastName" TEXT,
  ADD COLUMN "preferredName" TEXT,
  ADD COLUMN "personalEmail" TEXT,
  ADD COLUMN "phone" TEXT;

CREATE TYPE "EmployeeStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'TERMINATED');
CREATE TYPE "EmploymentType" AS ENUM ('FULL_TIME', 'PART_TIME', 'CASUAL', 'CONTRACT');
CREATE TYPE "EmploymentAssignmentStatus" AS ENUM ('PLANNED', 'ACTIVE', 'ENDED', 'CANCELLED');

CREATE TABLE "Employee" (
  "id" UUID NOT NULL,
  "personId" UUID NOT NULL,
  "employeeNumber" TEXT NOT NULL,
  "status" "EmployeeStatus" NOT NULL DEFAULT 'ACTIVE',
  "hireDate" DATE NOT NULL,
  "terminationDate" DATE,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  "archivedAt" TIMESTAMPTZ(6),
  CONSTRAINT "Employee_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "EmploymentAssignment" (
  "id" UUID NOT NULL,
  "employeeId" UUID NOT NULL,
  "positionId" UUID NOT NULL,
  "employmentType" "EmploymentType" NOT NULL,
  "status" "EmploymentAssignmentStatus" NOT NULL DEFAULT 'PLANNED',
  "startDate" DATE NOT NULL,
  "endDate" DATE,
  "isPrimary" BOOLEAN NOT NULL DEFAULT false,
  "managerAssignmentId" UUID,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "EmploymentAssignment_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "EmploymentAssignment_date_check" CHECK ("endDate" IS NULL OR "startDate" <= "endDate"),
  CONSTRAINT "EmploymentAssignment_not_self_managed" CHECK ("managerAssignmentId" IS NULL OR "managerAssignmentId" <> "id")
);

ALTER TABLE "Employee"
  ADD CONSTRAINT "Employee_personId_fkey"
  FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "EmploymentAssignment"
  ADD CONSTRAINT "EmploymentAssignment_employeeId_fkey"
  FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "EmploymentAssignment_positionId_fkey"
  FOREIGN KEY ("positionId") REFERENCES "Position"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "EmploymentAssignment_managerAssignmentId_fkey"
  FOREIGN KEY ("managerAssignmentId") REFERENCES "EmploymentAssignment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "Employee_personId_key" ON "Employee"("personId");
CREATE UNIQUE INDEX "Employee_employeeNumber_key" ON "Employee"("employeeNumber");
CREATE INDEX "Employee_status_hireDate_idx" ON "Employee"("status", "hireDate");
CREATE INDEX "Employee_terminationDate_idx" ON "Employee"("terminationDate");
CREATE INDEX "EmploymentAssignment_employeeId_status_startDate_endDate_idx" ON "EmploymentAssignment"("employeeId", "status", "startDate", "endDate");
CREATE INDEX "EmploymentAssignment_employeeId_isPrimary_startDate_endDate_idx" ON "EmploymentAssignment"("employeeId", "isPrimary", "startDate", "endDate");
CREATE INDEX "EmploymentAssignment_positionId_status_startDate_endDate_idx" ON "EmploymentAssignment"("positionId", "status", "startDate", "endDate");
CREATE INDEX "EmploymentAssignment_managerAssignmentId_idx" ON "EmploymentAssignment"("managerAssignmentId");
