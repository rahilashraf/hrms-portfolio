-- CreateEnum
CREATE TYPE "EmployeeWorkflowKind" AS ENUM ('ONBOARDING', 'OFFBOARDING');

-- CreateEnum
CREATE TYPE "WorkflowTemplateStatus" AS ENUM ('DRAFT', 'ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "WorkflowTaskCategory" AS ENUM ('PAPERWORK', 'POLICY', 'ACCOUNT_ACCESS', 'EQUIPMENT', 'ORIENTATION', 'TRAINING', 'PAYROLL', 'BENEFITS', 'MEETING', 'RECORDS', 'OTHER');

-- CreateEnum
CREATE TYPE "WorkflowTaskOwnerType" AS ENUM ('EMPLOYEE', 'MANAGER', 'HR', 'SPECIFIC_USER');

-- CreateEnum
CREATE TYPE "WorkflowReferenceType" AS ENUM ('EXTERNAL_URL', 'GOOGLE_FORM', 'GOOGLE_DOC', 'GOOGLE_DRIVE_FILE', 'GOOGLE_DRIVE_FOLDER', 'INTERNAL_DOCUMENT');

-- CreateEnum
CREATE TYPE "WorkflowSystemAction" AS ENUM ('NONE', 'PROVISION_HRMS_ACCOUNT', 'DISABLE_HRMS_ACCOUNT', 'PROVISION_EXTERNAL_ACCOUNT', 'DISABLE_EXTERNAL_ACCOUNT', 'REVOKE_BUILDING_ACCESS', 'ISSUE_EQUIPMENT', 'COLLECT_EQUIPMENT');

-- CreateEnum
CREATE TYPE "EmployeeWorkflowStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "EmployeeWorkflowTaskStatus" AS ENUM ('NOT_STARTED', 'IN_PROGRESS', 'COMPLETED', 'WAIVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "WorkflowTaskCompletionSource" AS ENUM ('MANUAL', 'EXTERNAL');

-- CreateEnum
CREATE TYPE "EmployeeWorkflowEventType" AS ENUM ('STARTED', 'TASK_STARTED', 'TASK_COMPLETED', 'TASK_ACKNOWLEDGED', 'TASK_WAIVED', 'TASK_REOPENED', 'TASK_REASSIGNED', 'TASK_DUE_DATE_CHANGED', 'TASK_CANCELLED', 'COMPLETED', 'REOPENED', 'CANCELLED');

-- CreateTable
CREATE TABLE "WorkflowTemplate" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "kind" "EmployeeWorkflowKind" NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" "WorkflowTemplateStatus" NOT NULL DEFAULT 'DRAFT',
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdByUserId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "activatedAt" TIMESTAMPTZ(6),
    "archivedAt" TIMESTAMPTZ(6),

    CONSTRAINT "WorkflowTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowTemplateTask" (
    "id" UUID NOT NULL,
    "templateId" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "category" "WorkflowTaskCategory" NOT NULL,
    "ownerType" "WorkflowTaskOwnerType" NOT NULL,
    "ownerUserId" UUID,
    "dueOffsetDays" INTEGER NOT NULL DEFAULT 0,
    "required" BOOLEAN NOT NULL DEFAULT true,
    "evidenceRequired" BOOLEAN NOT NULL DEFAULT false,
    "acknowledgementRequired" BOOLEAN NOT NULL DEFAULT false,
    "acknowledgementStatement" TEXT,
    "referenceType" "WorkflowReferenceType",
    "referenceUrl" TEXT,
    "referenceExternalId" TEXT,
    "referenceLabel" TEXT,
    "systemAction" "WorkflowSystemAction" NOT NULL DEFAULT 'NONE',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "WorkflowTemplateTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmployeeWorkflow" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "kind" "EmployeeWorkflowKind" NOT NULL,
    "employeeId" UUID NOT NULL,
    "employmentAssignmentId" UUID NOT NULL,
    "templateId" UUID,
    "templateCode" TEXT,
    "templateName" TEXT NOT NULL,
    "status" "EmployeeWorkflowStatus" NOT NULL DEFAULT 'ACTIVE',
    "anchorDate" DATE NOT NULL,
    "plannedEndDate" DATE,
    "reason" TEXT,
    "recruitmentHireId" UUID,
    "startedByUserId" UUID,
    "startedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMPTZ(6),
    "completedByUserId" UUID,
    "cancelledAt" TIMESTAMPTZ(6),
    "cancelledByUserId" UUID,
    "cancellationReason" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "EmployeeWorkflow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmployeeWorkflowTask" (
    "id" UUID NOT NULL,
    "workflowId" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "templateTaskId" UUID,
    "sortOrder" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "category" "WorkflowTaskCategory" NOT NULL,
    "ownerType" "WorkflowTaskOwnerType" NOT NULL,
    "ownerUserId" UUID,
    "dueDate" DATE,
    "required" BOOLEAN NOT NULL,
    "evidenceRequired" BOOLEAN NOT NULL,
    "acknowledgementRequired" BOOLEAN NOT NULL,
    "acknowledgementStatement" TEXT,
    "referenceType" "WorkflowReferenceType",
    "referenceUrl" TEXT,
    "referenceExternalId" TEXT,
    "referenceLabel" TEXT,
    "systemAction" "WorkflowSystemAction" NOT NULL,
    "status" "EmployeeWorkflowTaskStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "startedAt" TIMESTAMPTZ(6),
    "completedAt" TIMESTAMPTZ(6),
    "completedByUserId" UUID,
    "completionNote" TEXT,
    "evidenceReference" TEXT,
    "completionSource" "WorkflowTaskCompletionSource",
    "externalCompletionId" TEXT,
    "acknowledgedAt" TIMESTAMPTZ(6),
    "acknowledgedByUserId" UUID,
    "waivedAt" TIMESTAMPTZ(6),
    "waivedByUserId" UUID,
    "waiverReason" TEXT,
    "cancelledAt" TIMESTAMPTZ(6),
    "reopenCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "EmployeeWorkflowTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmployeeWorkflowEvent" (
    "id" UUID NOT NULL,
    "workflowId" UUID NOT NULL,
    "taskId" UUID,
    "type" "EmployeeWorkflowEventType" NOT NULL,
    "fromStatus" TEXT,
    "toStatus" TEXT,
    "note" TEXT,
    "actorUserId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmployeeWorkflowEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WorkflowTemplate_organizationId_kind_status_idx" ON "WorkflowTemplate"("organizationId", "kind", "status");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowTemplate_organizationId_code_key" ON "WorkflowTemplate"("organizationId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowTemplate_id_organizationId_key" ON "WorkflowTemplate"("id", "organizationId");

-- CreateIndex
CREATE INDEX "WorkflowTemplateTask_templateId_sortOrder_idx" ON "WorkflowTemplateTask"("templateId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "EmployeeWorkflow_recruitmentHireId_key" ON "EmployeeWorkflow"("recruitmentHireId");

-- CreateIndex
CREATE INDEX "EmployeeWorkflow_organizationId_kind_status_idx" ON "EmployeeWorkflow"("organizationId", "kind", "status");

-- CreateIndex
CREATE INDEX "EmployeeWorkflow_employeeId_kind_idx" ON "EmployeeWorkflow"("employeeId", "kind");

-- CreateIndex
CREATE INDEX "EmployeeWorkflow_employmentAssignmentId_idx" ON "EmployeeWorkflow"("employmentAssignmentId");

-- CreateIndex
CREATE UNIQUE INDEX "EmployeeWorkflow_id_organizationId_key" ON "EmployeeWorkflow"("id", "organizationId");

-- CreateIndex
CREATE INDEX "EmployeeWorkflowTask_workflowId_sortOrder_idx" ON "EmployeeWorkflowTask"("workflowId", "sortOrder");

-- CreateIndex
CREATE INDEX "EmployeeWorkflowTask_ownerUserId_status_idx" ON "EmployeeWorkflowTask"("ownerUserId", "status");

-- CreateIndex
CREATE INDEX "EmployeeWorkflowTask_organizationId_status_dueDate_idx" ON "EmployeeWorkflowTask"("organizationId", "status", "dueDate");

-- CreateIndex
CREATE INDEX "EmployeeWorkflowEvent_workflowId_createdAt_idx" ON "EmployeeWorkflowEvent"("workflowId", "createdAt");

-- CreateIndex
CREATE INDEX "EmployeeWorkflowEvent_taskId_createdAt_idx" ON "EmployeeWorkflowEvent"("taskId", "createdAt");

-- AddForeignKey
ALTER TABLE "WorkflowTemplate" ADD CONSTRAINT "WorkflowTemplate_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowTemplateTask" ADD CONSTRAINT "WorkflowTemplateTask_templateId_organizationId_fkey" FOREIGN KEY ("templateId", "organizationId") REFERENCES "WorkflowTemplate"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowTemplateTask" ADD CONSTRAINT "WorkflowTemplateTask_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeWorkflow" ADD CONSTRAINT "EmployeeWorkflow_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeWorkflow" ADD CONSTRAINT "EmployeeWorkflow_employmentAssignmentId_employeeId_fkey" FOREIGN KEY ("employmentAssignmentId", "employeeId") REFERENCES "EmploymentAssignment"("id", "employeeId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeWorkflow" ADD CONSTRAINT "EmployeeWorkflow_templateId_organizationId_fkey" FOREIGN KEY ("templateId", "organizationId") REFERENCES "WorkflowTemplate"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeWorkflow" ADD CONSTRAINT "EmployeeWorkflow_recruitmentHireId_fkey" FOREIGN KEY ("recruitmentHireId") REFERENCES "RecruitmentHire"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeWorkflowTask" ADD CONSTRAINT "EmployeeWorkflowTask_workflowId_organizationId_fkey" FOREIGN KEY ("workflowId", "organizationId") REFERENCES "EmployeeWorkflow"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeWorkflowTask" ADD CONSTRAINT "EmployeeWorkflowTask_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeWorkflowEvent" ADD CONSTRAINT "EmployeeWorkflowEvent_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "EmployeeWorkflow"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmployeeWorkflowEvent" ADD CONSTRAINT "EmployeeWorkflowEvent_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "EmployeeWorkflowTask"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ─── Integrity ───────────────────────────────────────────────────────────────
-- Lock order of workflow writes: EmployeeWorkflow (FOR NO KEY UPDATE) → its tasks. Core HR
-- rows (assignments, reporting lines) and Recruitment hires are only read.

ALTER TABLE "WorkflowTemplate"
  ADD CONSTRAINT "WorkflowTemplate_code_check" CHECK ("code" ~ '^[A-Z0-9_-]{2,64}$'),
  ADD CONSTRAINT "WorkflowTemplate_name_check" CHECK (btrim("name") <> ''),
  ADD CONSTRAINT "WorkflowTemplate_status_shape_check" CHECK (
    (("status" = 'DRAFT') = ("activatedAt" IS NULL) OR "status" = 'ARCHIVED')
    AND (("status" = 'ARCHIVED') = ("archivedAt" IS NOT NULL))
    AND (NOT "isDefault" OR "status" = 'ACTIVE')
  );
-- One active default template per organization and kind.
CREATE UNIQUE INDEX "WorkflowTemplate_default_key"
  ON "WorkflowTemplate"("organizationId", "kind") WHERE "isDefault";

ALTER TABLE "WorkflowTemplateTask"
  ADD CONSTRAINT "WorkflowTemplateTask_title_check" CHECK (btrim("title") <> ''),
  ADD CONSTRAINT "WorkflowTemplateTask_offset_check" CHECK ("dueOffsetDays" BETWEEN -365 AND 365),
  ADD CONSTRAINT "WorkflowTemplateTask_owner_check" CHECK (("ownerType" = 'SPECIFIC_USER') = ("ownerUserId" IS NOT NULL)),
  ADD CONSTRAINT "WorkflowTemplateTask_acknowledgement_check" CHECK (
    "acknowledgementRequired" = ("acknowledgementStatement" IS NOT NULL AND btrim("acknowledgementStatement") <> '')
    AND (NOT "acknowledgementRequired" OR "ownerType" = 'EMPLOYEE')
  ),
  ADD CONSTRAINT "WorkflowTemplateTask_reference_check" CHECK (
    ("referenceUrl" IS NULL OR "referenceUrl" ~* '^https://\S+$')
    AND (("referenceType" IS NULL) = ("referenceUrl" IS NULL AND "referenceExternalId" IS NULL))
  );

ALTER TABLE "EmployeeWorkflow"
  ADD CONSTRAINT "EmployeeWorkflow_name_check" CHECK (btrim("templateName") <> ''),
  ADD CONSTRAINT "EmployeeWorkflow_kind_shape_check" CHECK (
    ("kind" = 'OFFBOARDING') = ("plannedEndDate" IS NOT NULL)
    AND ("kind" = 'ONBOARDING' OR "recruitmentHireId" IS NULL)
    AND ("kind" = 'OFFBOARDING' OR "reason" IS NULL)
  ),
  ADD CONSTRAINT "EmployeeWorkflow_status_shape_check" CHECK (
    (("status" = 'COMPLETED') = ("completedAt" IS NOT NULL))
    AND (("status" = 'CANCELLED') = ("cancelledAt" IS NOT NULL AND "cancellationReason" IS NOT NULL))
    AND ("cancellationReason" IS NULL OR btrim("cancellationReason") <> '')
  );
-- One active onboarding and one active offboarding per assignment.
CREATE UNIQUE INDEX "EmployeeWorkflow_active_key"
  ON "EmployeeWorkflow"("employmentAssignmentId", "kind") WHERE "status" = 'ACTIVE';

ALTER TABLE "EmployeeWorkflowTask"
  ADD CONSTRAINT "EmployeeWorkflowTask_title_check" CHECK (btrim("title") <> ''),
  ADD CONSTRAINT "EmployeeWorkflowTask_owner_check" CHECK ("ownerType" <> 'SPECIFIC_USER' OR "ownerUserId" IS NOT NULL),
  ADD CONSTRAINT "EmployeeWorkflowTask_reference_check" CHECK ("referenceUrl" IS NULL OR "referenceUrl" ~* '^https://\S+$'),
  ADD CONSTRAINT "EmployeeWorkflowTask_status_shape_check" CHECK (
    (("status" = 'COMPLETED') = ("completedAt" IS NOT NULL AND "completionSource" IS NOT NULL))
    AND (("status" = 'WAIVED') = ("waivedAt" IS NOT NULL AND "waiverReason" IS NOT NULL))
    AND (("status" = 'CANCELLED') = ("cancelledAt" IS NOT NULL))
    AND ("waiverReason" IS NULL OR btrim("waiverReason") <> '')
    AND ("status" <> 'COMPLETED' OR NOT "acknowledgementRequired" OR "acknowledgedAt" IS NOT NULL)
    AND ("status" <> 'COMPLETED' OR NOT "evidenceRequired" OR "completionNote" IS NOT NULL OR "evidenceReference" IS NOT NULL)
    AND ("status" = 'NOT_STARTED' OR "status" = 'CANCELLED' OR "status" = 'WAIVED' OR "startedAt" IS NOT NULL)
    AND ("reopenCount" >= 0)
  );
-- An external submission completes at most one task of a workflow.
CREATE UNIQUE INDEX "EmployeeWorkflowTask_external_completion_key"
  ON "EmployeeWorkflowTask"("workflowId", "externalCompletionId") WHERE "externalCompletionId" IS NOT NULL;

CREATE FUNCTION prevent_workflow_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only.', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END $$;
CREATE TRIGGER "EmployeeWorkflowEvent_append_only" BEFORE UPDATE OR DELETE ON "EmployeeWorkflowEvent"
  FOR EACH ROW EXECUTE FUNCTION prevent_workflow_append_only();

CREATE FUNCTION guard_workflow_template() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'Only a draft template is deleted; archive it instead.' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW."organizationId" <> OLD."organizationId" OR NEW."code" <> OLD."code" OR NEW."kind" <> OLD."kind" THEN
    RAISE EXCEPTION 'A template''s organization, code and kind never change.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."status" <> OLD."status" AND NOT (
    (OLD."status" = 'DRAFT' AND NEW."status" IN ('ACTIVE', 'ARCHIVED'))
    OR (OLD."status" = 'ACTIVE' AND NEW."status" = 'ARCHIVED')
  ) THEN
    RAISE EXCEPTION 'Invalid template status change from % to %.', OLD."status", NEW."status" USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."status" = 'ARCHIVED' AND (NEW."name" <> OLD."name" OR NEW."description" IS DISTINCT FROM OLD."description" OR NEW."isDefault") THEN
    RAISE EXCEPTION 'An archived template is frozen.' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "WorkflowTemplate_guard" BEFORE UPDATE OR DELETE ON "WorkflowTemplate"
  FOR EACH ROW EXECUTE FUNCTION guard_workflow_template();

-- Template tasks change while the template is not archived (workflows hold snapshots).
CREATE FUNCTION guard_workflow_template_task() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  template_status "WorkflowTemplateStatus";
BEGIN
  SELECT "status" INTO template_status FROM "WorkflowTemplate"
  WHERE "id" = COALESCE(NEW."templateId", OLD."templateId") FOR NO KEY UPDATE;
  IF template_status = 'ARCHIVED' OR (TG_OP = 'UPDATE' AND NEW."templateId" <> OLD."templateId") THEN
    RAISE EXCEPTION 'An archived template is frozen.' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER "WorkflowTemplateTask_guard" BEFORE INSERT OR UPDATE OR DELETE ON "WorkflowTemplateTask"
  FOR EACH ROW EXECUTE FUNCTION guard_workflow_template_task();

CREATE FUNCTION guard_employee_workflow() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Workflows are completed or cancelled, never deleted.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'ACTIVE' THEN
      RAISE EXCEPTION 'A workflow starts active.' USING ERRCODE = 'check_violation';
    END IF;
    IF (SELECT p."organizationId" FROM "EmploymentAssignment" a JOIN "Position" p ON p."id" = a."positionId"
        WHERE a."id" = NEW."employmentAssignmentId") <> NEW."organizationId" THEN
      RAISE EXCEPTION 'The assignment belongs to another organization.' USING ERRCODE = 'check_violation';
    END IF;
    IF (SELECT "status" FROM "EmploymentAssignment" WHERE "id" = NEW."employmentAssignmentId") = 'CANCELLED' THEN
      RAISE EXCEPTION 'A cancelled assignment has no workflows.' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."recruitmentHireId" IS NOT NULL AND (
      SELECT "employmentAssignmentId" FROM "RecruitmentHire" WHERE "id" = NEW."recruitmentHireId"
    ) IS DISTINCT FROM NEW."employmentAssignmentId" THEN
      RAISE EXCEPTION 'The hire created a different assignment.' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."organizationId" <> OLD."organizationId" OR NEW."kind" <> OLD."kind"
     OR NEW."employeeId" <> OLD."employeeId" OR NEW."employmentAssignmentId" <> OLD."employmentAssignmentId"
     OR NEW."templateId" IS DISTINCT FROM OLD."templateId" OR NEW."templateName" <> OLD."templateName"
     OR NEW."templateCode" IS DISTINCT FROM OLD."templateCode"
     OR NEW."recruitmentHireId" IS DISTINCT FROM OLD."recruitmentHireId"
     OR NEW."startedAt" <> OLD."startedAt" THEN
    RAISE EXCEPTION 'A workflow''s employee, assignment and template snapshot never change.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."status" <> OLD."status" AND NOT (
    (OLD."status" = 'ACTIVE' AND NEW."status" IN ('COMPLETED', 'CANCELLED'))
    OR (OLD."status" = 'COMPLETED' AND NEW."status" = 'ACTIVE')
  ) THEN
    RAISE EXCEPTION 'Invalid workflow status change from % to %.', OLD."status", NEW."status" USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."status" = 'CANCELLED' THEN
    RAISE EXCEPTION 'A cancelled workflow is frozen.' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "EmployeeWorkflow_guard" BEFORE INSERT OR UPDATE OR DELETE ON "EmployeeWorkflow"
  FOR EACH ROW EXECUTE FUNCTION guard_employee_workflow();

CREATE FUNCTION guard_employee_workflow_task() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  workflow_status "EmployeeWorkflowStatus";
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Workflow tasks are waived or cancelled, never deleted.' USING ERRCODE = 'restrict_violation';
  END IF;
  SELECT "status" INTO workflow_status FROM "EmployeeWorkflow" WHERE "id" = NEW."workflowId";
  IF TG_OP = 'INSERT' THEN
    IF workflow_status <> 'ACTIVE' OR NEW."status" <> 'NOT_STARTED' THEN
      RAISE EXCEPTION 'Tasks are added, not started, to active workflows.' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."workflowId" <> OLD."workflowId" OR NEW."organizationId" <> OLD."organizationId"
     OR NEW."templateTaskId" IS DISTINCT FROM OLD."templateTaskId"
     OR NEW."title" <> OLD."title" OR NEW."description" IS DISTINCT FROM OLD."description"
     OR NEW."category" <> OLD."category" OR NEW."ownerType" <> OLD."ownerType"
     OR NEW."required" <> OLD."required" OR NEW."evidenceRequired" <> OLD."evidenceRequired"
     OR NEW."acknowledgementRequired" <> OLD."acknowledgementRequired"
     OR NEW."acknowledgementStatement" IS DISTINCT FROM OLD."acknowledgementStatement"
     OR NEW."referenceType" IS DISTINCT FROM OLD."referenceType"
     OR NEW."referenceUrl" IS DISTINCT FROM OLD."referenceUrl"
     OR NEW."referenceExternalId" IS DISTINCT FROM OLD."referenceExternalId"
     OR NEW."referenceLabel" IS DISTINCT FROM OLD."referenceLabel"
     OR NEW."systemAction" <> OLD."systemAction"
     OR NEW."reopenCount" < OLD."reopenCount" THEN
    RAISE EXCEPTION 'A workflow task''s snapshot never changes.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."status" <> OLD."status" AND NOT (
    (OLD."status" = 'NOT_STARTED' AND NEW."status" IN ('IN_PROGRESS', 'COMPLETED', 'WAIVED', 'CANCELLED'))
    OR (OLD."status" = 'IN_PROGRESS' AND NEW."status" IN ('COMPLETED', 'WAIVED', 'CANCELLED'))
    OR (OLD."status" IN ('COMPLETED', 'WAIVED') AND NEW."status" = 'IN_PROGRESS' AND NEW."reopenCount" = OLD."reopenCount" + 1)
  ) THEN
    RAISE EXCEPTION 'Invalid task status change from % to %.', OLD."status", NEW."status" USING ERRCODE = 'check_violation';
  END IF;
  -- Finished work is changed only by an explicit reopening (which counts it).
  IF OLD."status" IN ('COMPLETED', 'WAIVED') AND NEW."status" = OLD."status" AND (
    NEW."completedAt" IS DISTINCT FROM OLD."completedAt" OR NEW."completedByUserId" IS DISTINCT FROM OLD."completedByUserId"
    OR NEW."completionNote" IS DISTINCT FROM OLD."completionNote"
    OR NEW."evidenceReference" IS DISTINCT FROM OLD."evidenceReference"
    OR NEW."acknowledgedAt" IS DISTINCT FROM OLD."acknowledgedAt"
    OR NEW."waivedAt" IS DISTINCT FROM OLD."waivedAt" OR NEW."waiverReason" IS DISTINCT FROM OLD."waiverReason"
    OR NEW."ownerUserId" IS DISTINCT FROM OLD."ownerUserId" OR NEW."dueDate" IS DISTINCT FROM OLD."dueDate"
  ) THEN
    RAISE EXCEPTION 'A finished task is locked; reopen it explicitly.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."status" = 'CANCELLED' THEN
    RAISE EXCEPTION 'A cancelled task is frozen.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF workflow_status <> 'ACTIVE' AND NEW."status" <> 'CANCELLED' THEN
    RAISE EXCEPTION 'Tasks change only while their workflow is active.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "EmployeeWorkflowTask_guard" BEFORE INSERT OR UPDATE OR DELETE ON "EmployeeWorkflowTask"
  FOR EACH ROW EXECUTE FUNCTION guard_employee_workflow_task();
