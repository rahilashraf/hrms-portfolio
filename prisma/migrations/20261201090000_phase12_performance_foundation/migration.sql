-- CreateEnum
CREATE TYPE "PerformanceConfigStatus" AS ENUM ('DRAFT', 'ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "PerformanceItemType" AS ENUM ('RATING', 'SCALE', 'TEXT', 'YES_NO', 'GOAL_PROGRESS', 'EVIDENCE_REFERENCE');

-- CreateEnum
CREATE TYPE "PerformanceRespondent" AS ENUM ('SELF', 'REVIEWER', 'BOTH');

-- CreateEnum
CREATE TYPE "PerformanceScoringMode" AS ENUM ('NONE', 'WEIGHTED_AVERAGE');

-- CreateEnum
CREATE TYPE "PerformanceCycleStatus" AS ENUM ('DRAFT', 'OPEN', 'CLOSED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "PerformanceReviewerModel" AS ENUM ('DIRECT_MANAGER', 'HR_ASSIGNED');

-- CreateEnum
CREATE TYPE "PerformanceReviewStatus" AS ENUM ('NOT_STARTED', 'IN_PROGRESS', 'SUBMITTED', 'FINALIZED', 'ACKNOWLEDGED', 'CLOSED');

-- CreateEnum
CREATE TYPE "PerformancePartStatus" AS ENUM ('NOT_REQUIRED', 'NOT_STARTED', 'IN_PROGRESS', 'SUBMITTED', 'NOT_SUBMITTED');

-- CreateEnum
CREATE TYPE "PerformanceReviewerSource" AS ENUM ('DIRECT_MANAGER', 'ASSIGNED');

-- CreateEnum
CREATE TYPE "PerformanceReviewEventType" AS ENUM ('ADDED', 'REVIEWER_CHANGED', 'SELF_SUBMITTED', 'REVIEWER_SUBMITTED', 'SELF_REOPENED', 'REVIEWER_REOPENED', 'FINALIZED', 'ACKNOWLEDGED', 'CORRECTED', 'CLOSED');

-- CreateEnum
CREATE TYPE "PerformanceResponseRecordType" AS ENUM ('ORIGINAL', 'CORRECTION');

-- CreateEnum
CREATE TYPE "PerformanceCloseReason" AS ENUM ('COMPLETED', 'NOT_ACKNOWLEDGED', 'INCOMPLETE');

-- CreateEnum
CREATE TYPE "PerformanceGoalStatus" AS ENUM ('NOT_STARTED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PerformanceEvidenceProvider" AS ENUM ('GOOGLE_FORMS', 'MANUAL', 'TRAINING', 'CERTIFICATION', 'OTHER');

-- CreateEnum
CREATE TYPE "PerformanceEvidenceKind" AS ENUM ('ASSESSMENT', 'TRAINING', 'CERTIFICATION', 'POLICY_ACKNOWLEDGEMENT', 'OTHER');

-- CreateEnum
CREATE TYPE "PerformanceEvidenceChannel" AS ENUM ('MANUAL', 'IMPORT', 'SYNC');

-- CreateEnum
CREATE TYPE "PerformanceEvidenceStatus" AS ENUM ('ACTIVE', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "PerformanceIntakeStatus" AS ENUM ('PENDING_MATCH', 'MATCHED', 'REJECTED');

-- CreateTable
CREATE TABLE "PerformanceCompetency" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT,
    "createdByUserId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "archivedAt" TIMESTAMPTZ(6),

    CONSTRAINT "PerformanceCompetency_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PerformanceRatingScale" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" "PerformanceConfigStatus" NOT NULL DEFAULT 'DRAFT',
    "createdByUserId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "activatedAt" TIMESTAMPTZ(6),
    "archivedAt" TIMESTAMPTZ(6),

    CONSTRAINT "PerformanceRatingScale_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PerformanceRatingScaleLevel" (
    "id" UUID NOT NULL,
    "scaleId" UUID NOT NULL,
    "value" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PerformanceRatingScaleLevel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PerformanceTemplate" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" "PerformanceConfigStatus" NOT NULL DEFAULT 'DRAFT',
    "scoringMode" "PerformanceScoringMode" NOT NULL DEFAULT 'NONE',
    "ratingScaleId" UUID,
    "overallRatingEnabled" BOOLEAN NOT NULL DEFAULT false,
    "createdByUserId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "activatedAt" TIMESTAMPTZ(6),
    "archivedAt" TIMESTAMPTZ(6),

    CONSTRAINT "PerformanceTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PerformanceTemplateSection" (
    "id" UUID NOT NULL,
    "templateId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "sortOrder" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "PerformanceTemplateSection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PerformanceTemplateItem" (
    "id" UUID NOT NULL,
    "templateId" UUID NOT NULL,
    "sectionId" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "itemType" "PerformanceItemType" NOT NULL,
    "prompt" TEXT NOT NULL,
    "helpText" TEXT,
    "respondent" "PerformanceRespondent" NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "weight" DECIMAL(5,2),
    "competencyId" UUID,
    "ratingScaleId" UUID,
    "scaleMin" INTEGER,
    "scaleMax" INTEGER,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "PerformanceTemplateItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PerformanceCycle" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" "PerformanceCycleStatus" NOT NULL DEFAULT 'DRAFT',
    "templateId" UUID NOT NULL,
    "reviewerModel" "PerformanceReviewerModel" NOT NULL DEFAULT 'DIRECT_MANAGER',
    "selfReviewEnabled" BOOLEAN NOT NULL DEFAULT true,
    "acknowledgementEnabled" BOOLEAN NOT NULL DEFAULT true,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "windowStart" DATE NOT NULL,
    "windowEnd" DATE NOT NULL,
    "selfReviewDueDate" DATE,
    "reviewerDueDate" DATE,
    "scoringMode" "PerformanceScoringMode",
    "overallRatingEnabled" BOOLEAN,
    "overallScaleLevels" JSONB,
    "overallScaleName" TEXT,
    "openedAt" TIMESTAMPTZ(6),
    "openedByUserId" UUID,
    "closedAt" TIMESTAMPTZ(6),
    "closedByUserId" UUID,
    "archivedAt" TIMESTAMPTZ(6),
    "createdByUserId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "PerformanceCycle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PerformanceFormSection" (
    "id" UUID NOT NULL,
    "cycleId" UUID NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PerformanceFormSection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PerformanceFormItem" (
    "id" UUID NOT NULL,
    "cycleId" UUID NOT NULL,
    "sectionId" UUID NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "itemType" "PerformanceItemType" NOT NULL,
    "prompt" TEXT NOT NULL,
    "helpText" TEXT,
    "respondent" "PerformanceRespondent" NOT NULL,
    "required" BOOLEAN NOT NULL,
    "weight" DECIMAL(5,2),
    "competencyId" UUID,
    "competencyCode" TEXT,
    "competencyName" TEXT,
    "scaleLevels" JSONB,
    "scaleMin" INTEGER,
    "scaleMax" INTEGER,
    "templateItemId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PerformanceFormItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PerformanceReview" (
    "id" UUID NOT NULL,
    "cycleId" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "employmentAssignmentId" UUID NOT NULL,
    "status" "PerformanceReviewStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "selfStatus" "PerformancePartStatus" NOT NULL,
    "reviewerStatus" "PerformancePartStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "reviewerEmployeeId" UUID,
    "reviewerAssignmentId" UUID,
    "reviewerSource" "PerformanceReviewerSource",
    "reviewerAssignedAt" TIMESTAMPTZ(6),
    "selfSubmittedAt" TIMESTAMPTZ(6),
    "selfSubmittedByUserId" UUID,
    "reviewerSubmittedAt" TIMESTAMPTZ(6),
    "reviewerSubmittedByUserId" UUID,
    "reviewerSubmittedEmployeeId" UUID,
    "calculatedScore" DECIMAL(6,2),
    "overallRatingValue" INTEGER,
    "overallRatingLabel" TEXT,
    "finalizedAt" TIMESTAMPTZ(6),
    "finalizedByUserId" UUID,
    "acknowledgedAt" TIMESTAMPTZ(6),
    "closedAt" TIMESTAMPTZ(6),
    "closedByUserId" UUID,
    "closeReason" "PerformanceCloseReason",
    "createdByUserId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "PerformanceReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PerformanceReviewResponse" (
    "id" UUID NOT NULL,
    "reviewId" UUID NOT NULL,
    "cycleId" UUID NOT NULL,
    "itemId" UUID NOT NULL,
    "respondent" "PerformanceRespondent" NOT NULL,
    "ratingValue" INTEGER,
    "ratingLabel" TEXT,
    "numericValue" INTEGER,
    "booleanValue" BOOLEAN,
    "textValue" TEXT,
    "recordType" "PerformanceResponseRecordType" NOT NULL DEFAULT 'ORIGINAL',
    "lockedAt" TIMESTAMPTZ(6),
    "supersedesResponseId" UUID,
    "supersededAt" TIMESTAMPTZ(6),
    "correctionReason" TEXT,
    "authorUserId" UUID,
    "authorEmployeeId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "PerformanceReviewResponse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PerformanceReviewEvent" (
    "id" UUID NOT NULL,
    "reviewId" UUID NOT NULL,
    "type" "PerformanceReviewEventType" NOT NULL,
    "actorUserId" UUID,
    "actorEmployeeId" UUID,
    "fromEmployeeId" UUID,
    "toEmployeeId" UUID,
    "fromStatus" "PerformanceReviewStatus",
    "toStatus" "PerformanceReviewStatus",
    "reason" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PerformanceReviewEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PerformanceReviewAcknowledgement" (
    "id" UUID NOT NULL,
    "reviewId" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "comment" TEXT,
    "acknowledgedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "supersededAt" TIMESTAMPTZ(6),

    CONSTRAINT "PerformanceReviewAcknowledgement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PerformanceGoal" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "employmentAssignmentId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "measure" TEXT,
    "startDate" DATE NOT NULL,
    "dueDate" DATE,
    "status" "PerformanceGoalStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "progressPercent" INTEGER,
    "completionNotes" TEXT,
    "completedAt" TIMESTAMPTZ(6),
    "cancelledAt" TIMESTAMPTZ(6),
    "cancellationReason" TEXT,
    "createdByUserId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "PerformanceGoal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PerformanceReviewGoal" (
    "id" UUID NOT NULL,
    "reviewId" UUID NOT NULL,
    "goalId" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "linkedByUserId" UUID,
    "linkedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "unlinkedAt" TIMESTAMPTZ(6),
    "unlinkedByUserId" UUID,
    "snapshotTitle" TEXT,
    "snapshotStatus" "PerformanceGoalStatus",
    "snapshotProgress" INTEGER,
    "snapshottedAt" TIMESTAMPTZ(6),

    CONSTRAINT "PerformanceReviewGoal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PerformanceEvidenceSource" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "provider" "PerformanceEvidenceProvider" NOT NULL,
    "kind" "PerformanceEvidenceKind" NOT NULL,
    "externalResourceId" TEXT,
    "resourceTitle" TEXT,
    "resourceUrl" TEXT,
    "passThresholdPercent" DECIMAL(5,2),
    "lastSyncedAt" TIMESTAMPTZ(6),
    "lastSyncStatus" TEXT,
    "lastSyncMessage" TEXT,
    "createdByUserId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "archivedAt" TIMESTAMPTZ(6),

    CONSTRAINT "PerformanceEvidenceSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PerformanceEvidence" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "employmentAssignmentId" UUID,
    "sourceId" UUID,
    "provider" "PerformanceEvidenceProvider" NOT NULL,
    "kind" "PerformanceEvidenceKind" NOT NULL,
    "channel" "PerformanceEvidenceChannel" NOT NULL,
    "title" TEXT NOT NULL,
    "externalResourceId" TEXT,
    "externalResultId" TEXT,
    "completedAt" TIMESTAMPTZ(6) NOT NULL,
    "score" DECIMAL(10,2),
    "maxScore" DECIMAL(10,2),
    "percentage" DECIMAL(5,2),
    "passed" BOOLEAN,
    "passThresholdPercent" DECIMAL(5,2),
    "resultUrl" TEXT,
    "externalUpdatedAt" TIMESTAMPTZ(6),
    "contentHash" TEXT,
    "notes" TEXT,
    "status" "PerformanceEvidenceStatus" NOT NULL DEFAULT 'ACTIVE',
    "withdrawnAt" TIMESTAMPTZ(6),
    "withdrawalReason" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "supersedesEvidenceId" UUID,
    "supersededAt" TIMESTAMPTZ(6),
    "correctionReason" TEXT,
    "importedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recordedByUserId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "PerformanceEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PerformanceEvidenceIntake" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "sourceId" UUID NOT NULL,
    "externalResultId" TEXT NOT NULL,
    "respondentEmail" TEXT,
    "respondentReference" TEXT,
    "result" JSONB NOT NULL,
    "status" "PerformanceIntakeStatus" NOT NULL DEFAULT 'PENDING_MATCH',
    "reason" TEXT NOT NULL,
    "evidenceId" UUID,
    "receivedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastReceivedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMPTZ(6),
    "resolvedByUserId" UUID,
    "resolutionNote" TEXT,

    CONSTRAINT "PerformanceEvidenceIntake_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PerformanceReviewEvidence" (
    "id" UUID NOT NULL,
    "reviewId" UUID NOT NULL,
    "evidenceId" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "cycleId" UUID NOT NULL,
    "formItemId" UUID,
    "linkedByUserId" UUID,
    "linkedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "unlinkedAt" TIMESTAMPTZ(6),
    "unlinkedByUserId" UUID,

    CONSTRAINT "PerformanceReviewEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PerformanceCompetency_organizationId_archivedAt_idx" ON "PerformanceCompetency"("organizationId", "archivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "PerformanceCompetency_organizationId_code_key" ON "PerformanceCompetency"("organizationId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "PerformanceCompetency_id_organizationId_key" ON "PerformanceCompetency"("id", "organizationId");

-- CreateIndex
CREATE INDEX "PerformanceRatingScale_organizationId_status_idx" ON "PerformanceRatingScale"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PerformanceRatingScale_organizationId_code_key" ON "PerformanceRatingScale"("organizationId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "PerformanceRatingScale_id_organizationId_key" ON "PerformanceRatingScale"("id", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "PerformanceRatingScaleLevel_scaleId_value_key" ON "PerformanceRatingScaleLevel"("scaleId", "value");

-- CreateIndex
CREATE INDEX "PerformanceTemplate_organizationId_status_idx" ON "PerformanceTemplate"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PerformanceTemplate_organizationId_code_key" ON "PerformanceTemplate"("organizationId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "PerformanceTemplate_id_organizationId_key" ON "PerformanceTemplate"("id", "organizationId");

-- CreateIndex
CREATE INDEX "PerformanceTemplateSection_templateId_sortOrder_idx" ON "PerformanceTemplateSection"("templateId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "PerformanceTemplateSection_id_templateId_key" ON "PerformanceTemplateSection"("id", "templateId");

-- CreateIndex
CREATE INDEX "PerformanceTemplateItem_templateId_sectionId_sortOrder_idx" ON "PerformanceTemplateItem"("templateId", "sectionId", "sortOrder");

-- CreateIndex
CREATE INDEX "PerformanceTemplateItem_competencyId_idx" ON "PerformanceTemplateItem"("competencyId");

-- CreateIndex
CREATE INDEX "PerformanceCycle_organizationId_status_idx" ON "PerformanceCycle"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PerformanceCycle_organizationId_code_key" ON "PerformanceCycle"("organizationId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "PerformanceCycle_id_organizationId_key" ON "PerformanceCycle"("id", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "PerformanceFormSection_cycleId_sortOrder_key" ON "PerformanceFormSection"("cycleId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "PerformanceFormSection_id_cycleId_key" ON "PerformanceFormSection"("id", "cycleId");

-- CreateIndex
CREATE UNIQUE INDEX "PerformanceFormItem_id_cycleId_key" ON "PerformanceFormItem"("id", "cycleId");

-- CreateIndex
CREATE UNIQUE INDEX "PerformanceFormItem_sectionId_sortOrder_key" ON "PerformanceFormItem"("sectionId", "sortOrder");

-- CreateIndex
CREATE INDEX "PerformanceReview_employeeId_status_idx" ON "PerformanceReview"("employeeId", "status");

-- CreateIndex
CREATE INDEX "PerformanceReview_reviewerEmployeeId_status_idx" ON "PerformanceReview"("reviewerEmployeeId", "status");

-- CreateIndex
CREATE INDEX "PerformanceReview_organizationId_status_idx" ON "PerformanceReview"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PerformanceReview_cycleId_employmentAssignmentId_key" ON "PerformanceReview"("cycleId", "employmentAssignmentId");

-- CreateIndex
CREATE UNIQUE INDEX "PerformanceReview_id_employeeId_key" ON "PerformanceReview"("id", "employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "PerformanceReview_id_cycleId_key" ON "PerformanceReview"("id", "cycleId");

-- CreateIndex
CREATE UNIQUE INDEX "PerformanceReviewResponse_supersedesResponseId_key" ON "PerformanceReviewResponse"("supersedesResponseId");

-- CreateIndex
CREATE INDEX "PerformanceReviewResponse_reviewId_itemId_idx" ON "PerformanceReviewResponse"("reviewId", "itemId");

-- CreateIndex
CREATE INDEX "PerformanceReviewEvent_reviewId_createdAt_idx" ON "PerformanceReviewEvent"("reviewId", "createdAt");

-- CreateIndex
CREATE INDEX "PerformanceReviewAcknowledgement_reviewId_idx" ON "PerformanceReviewAcknowledgement"("reviewId");

-- CreateIndex
CREATE INDEX "PerformanceGoal_employeeId_status_idx" ON "PerformanceGoal"("employeeId", "status");

-- CreateIndex
CREATE INDEX "PerformanceGoal_employmentAssignmentId_status_idx" ON "PerformanceGoal"("employmentAssignmentId", "status");

-- CreateIndex
CREATE INDEX "PerformanceGoal_organizationId_status_idx" ON "PerformanceGoal"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PerformanceGoal_id_employeeId_key" ON "PerformanceGoal"("id", "employeeId");

-- CreateIndex
CREATE INDEX "PerformanceReviewGoal_reviewId_idx" ON "PerformanceReviewGoal"("reviewId");

-- CreateIndex
CREATE INDEX "PerformanceReviewGoal_goalId_idx" ON "PerformanceReviewGoal"("goalId");

-- CreateIndex
CREATE INDEX "PerformanceEvidenceSource_organizationId_provider_idx" ON "PerformanceEvidenceSource"("organizationId", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "PerformanceEvidenceSource_organizationId_code_key" ON "PerformanceEvidenceSource"("organizationId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "PerformanceEvidenceSource_id_organizationId_key" ON "PerformanceEvidenceSource"("id", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "PerformanceEvidence_supersedesEvidenceId_key" ON "PerformanceEvidence"("supersedesEvidenceId");

-- CreateIndex
CREATE INDEX "PerformanceEvidence_employeeId_completedAt_idx" ON "PerformanceEvidence"("employeeId", "completedAt");

-- CreateIndex
CREATE INDEX "PerformanceEvidence_organizationId_provider_idx" ON "PerformanceEvidence"("organizationId", "provider");

-- CreateIndex
CREATE INDEX "PerformanceEvidence_sourceId_idx" ON "PerformanceEvidence"("sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "PerformanceEvidence_id_employeeId_key" ON "PerformanceEvidence"("id", "employeeId");

-- CreateIndex
CREATE INDEX "PerformanceEvidenceIntake_organizationId_status_idx" ON "PerformanceEvidenceIntake"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PerformanceEvidenceIntake_sourceId_externalResultId_key" ON "PerformanceEvidenceIntake"("sourceId", "externalResultId");

-- CreateIndex
CREATE INDEX "PerformanceReviewEvidence_reviewId_idx" ON "PerformanceReviewEvidence"("reviewId");

-- CreateIndex
CREATE INDEX "PerformanceReviewEvidence_evidenceId_idx" ON "PerformanceReviewEvidence"("evidenceId");

-- AddForeignKey
ALTER TABLE "PerformanceCompetency" ADD CONSTRAINT "PerformanceCompetency_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PerformanceRatingScale" ADD CONSTRAINT "PerformanceRatingScale_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PerformanceRatingScaleLevel" ADD CONSTRAINT "PerformanceRatingScaleLevel_scaleId_fkey" FOREIGN KEY ("scaleId") REFERENCES "PerformanceRatingScale"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PerformanceTemplate" ADD CONSTRAINT "PerformanceTemplate_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PerformanceTemplate" ADD CONSTRAINT "PerformanceTemplate_ratingScaleId_organizationId_fkey" FOREIGN KEY ("ratingScaleId", "organizationId") REFERENCES "PerformanceRatingScale"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PerformanceTemplateSection" ADD CONSTRAINT "PerformanceTemplateSection_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "PerformanceTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PerformanceTemplateItem" ADD CONSTRAINT "PerformanceTemplateItem_templateId_organizationId_fkey" FOREIGN KEY ("templateId", "organizationId") REFERENCES "PerformanceTemplate"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PerformanceTemplateItem" ADD CONSTRAINT "PerformanceTemplateItem_sectionId_templateId_fkey" FOREIGN KEY ("sectionId", "templateId") REFERENCES "PerformanceTemplateSection"("id", "templateId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PerformanceTemplateItem" ADD CONSTRAINT "PerformanceTemplateItem_competencyId_organizationId_fkey" FOREIGN KEY ("competencyId", "organizationId") REFERENCES "PerformanceCompetency"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PerformanceTemplateItem" ADD CONSTRAINT "PerformanceTemplateItem_ratingScaleId_organizationId_fkey" FOREIGN KEY ("ratingScaleId", "organizationId") REFERENCES "PerformanceRatingScale"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PerformanceCycle" ADD CONSTRAINT "PerformanceCycle_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PerformanceCycle" ADD CONSTRAINT "PerformanceCycle_templateId_organizationId_fkey" FOREIGN KEY ("templateId", "organizationId") REFERENCES "PerformanceTemplate"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PerformanceFormSection" ADD CONSTRAINT "PerformanceFormSection_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "PerformanceCycle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PerformanceFormItem" ADD CONSTRAINT "PerformanceFormItem_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "PerformanceCycle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PerformanceFormItem" ADD CONSTRAINT "PerformanceFormItem_sectionId_cycleId_fkey" FOREIGN KEY ("sectionId", "cycleId") REFERENCES "PerformanceFormSection"("id", "cycleId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PerformanceReview" ADD CONSTRAINT "PerformanceReview_cycleId_organizationId_fkey" FOREIGN KEY ("cycleId", "organizationId") REFERENCES "PerformanceCycle"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PerformanceReview" ADD CONSTRAINT "PerformanceReview_employmentAssignmentId_employeeId_fkey" FOREIGN KEY ("employmentAssignmentId", "employeeId") REFERENCES "EmploymentAssignment"("id", "employeeId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PerformanceReview" ADD CONSTRAINT "PerformanceReview_reviewerEmployeeId_fkey" FOREIGN KEY ("reviewerEmployeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PerformanceReviewResponse" ADD CONSTRAINT "PerformanceReviewResponse_reviewId_cycleId_fkey" FOREIGN KEY ("reviewId", "cycleId") REFERENCES "PerformanceReview"("id", "cycleId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PerformanceReviewResponse" ADD CONSTRAINT "PerformanceReviewResponse_itemId_cycleId_fkey" FOREIGN KEY ("itemId", "cycleId") REFERENCES "PerformanceFormItem"("id", "cycleId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PerformanceReviewResponse" ADD CONSTRAINT "PerformanceReviewResponse_supersedesResponseId_fkey" FOREIGN KEY ("supersedesResponseId") REFERENCES "PerformanceReviewResponse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PerformanceReviewEvent" ADD CONSTRAINT "PerformanceReviewEvent_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "PerformanceReview"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PerformanceReviewAcknowledgement" ADD CONSTRAINT "PerformanceReviewAcknowledgement_reviewId_employeeId_fkey" FOREIGN KEY ("reviewId", "employeeId") REFERENCES "PerformanceReview"("id", "employeeId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PerformanceGoal" ADD CONSTRAINT "PerformanceGoal_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PerformanceGoal" ADD CONSTRAINT "PerformanceGoal_employmentAssignmentId_employeeId_fkey" FOREIGN KEY ("employmentAssignmentId", "employeeId") REFERENCES "EmploymentAssignment"("id", "employeeId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PerformanceReviewGoal" ADD CONSTRAINT "PerformanceReviewGoal_reviewId_employeeId_fkey" FOREIGN KEY ("reviewId", "employeeId") REFERENCES "PerformanceReview"("id", "employeeId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PerformanceReviewGoal" ADD CONSTRAINT "PerformanceReviewGoal_goalId_employeeId_fkey" FOREIGN KEY ("goalId", "employeeId") REFERENCES "PerformanceGoal"("id", "employeeId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PerformanceEvidenceSource" ADD CONSTRAINT "PerformanceEvidenceSource_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PerformanceEvidence" ADD CONSTRAINT "PerformanceEvidence_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PerformanceEvidence" ADD CONSTRAINT "PerformanceEvidence_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PerformanceEvidence" ADD CONSTRAINT "PerformanceEvidence_employmentAssignmentId_employeeId_fkey" FOREIGN KEY ("employmentAssignmentId", "employeeId") REFERENCES "EmploymentAssignment"("id", "employeeId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PerformanceEvidence" ADD CONSTRAINT "PerformanceEvidence_sourceId_organizationId_fkey" FOREIGN KEY ("sourceId", "organizationId") REFERENCES "PerformanceEvidenceSource"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PerformanceEvidence" ADD CONSTRAINT "PerformanceEvidence_supersedesEvidenceId_fkey" FOREIGN KEY ("supersedesEvidenceId") REFERENCES "PerformanceEvidence"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PerformanceEvidenceIntake" ADD CONSTRAINT "PerformanceEvidenceIntake_sourceId_organizationId_fkey" FOREIGN KEY ("sourceId", "organizationId") REFERENCES "PerformanceEvidenceSource"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PerformanceEvidenceIntake" ADD CONSTRAINT "PerformanceEvidenceIntake_evidenceId_fkey" FOREIGN KEY ("evidenceId") REFERENCES "PerformanceEvidence"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PerformanceReviewEvidence" ADD CONSTRAINT "PerformanceReviewEvidence_reviewId_employeeId_fkey" FOREIGN KEY ("reviewId", "employeeId") REFERENCES "PerformanceReview"("id", "employeeId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PerformanceReviewEvidence" ADD CONSTRAINT "PerformanceReviewEvidence_evidenceId_employeeId_fkey" FOREIGN KEY ("evidenceId", "employeeId") REFERENCES "PerformanceEvidence"("id", "employeeId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PerformanceReviewEvidence" ADD CONSTRAINT "PerformanceReviewEvidence_formItemId_cycleId_fkey" FOREIGN KEY ("formItemId", "cycleId") REFERENCES "PerformanceFormItem"("id", "cycleId") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ─── Integrity ───────────────────────────────────────────────────────────────

ALTER TABLE "PerformanceCompetency"
  ADD CONSTRAINT "PerformanceCompetency_code_check" CHECK ("code" ~ '^[A-Z0-9_-]{2,64}$'),
  ADD CONSTRAINT "PerformanceCompetency_name_check" CHECK (btrim("name") <> '');

ALTER TABLE "PerformanceRatingScale"
  ADD CONSTRAINT "PerformanceRatingScale_code_check" CHECK ("code" ~ '^[A-Z0-9_-]{2,64}$'),
  ADD CONSTRAINT "PerformanceRatingScale_name_check" CHECK (btrim("name") <> '');

ALTER TABLE "PerformanceRatingScaleLevel"
  ADD CONSTRAINT "PerformanceRatingScaleLevel_label_check" CHECK (btrim("label") <> ''),
  ADD CONSTRAINT "PerformanceRatingScaleLevel_value_check" CHECK ("value" BETWEEN 0 AND 100);

ALTER TABLE "PerformanceTemplate"
  ADD CONSTRAINT "PerformanceTemplate_code_check" CHECK ("code" ~ '^[A-Z0-9_-]{2,64}$'),
  ADD CONSTRAINT "PerformanceTemplate_name_check" CHECK (btrim("name") <> ''),
  ADD CONSTRAINT "PerformanceTemplate_scale_check" CHECK (
    ("scoringMode" = 'NONE' AND NOT "overallRatingEnabled") OR "ratingScaleId" IS NOT NULL
  );

ALTER TABLE "PerformanceTemplateSection"
  ADD CONSTRAINT "PerformanceTemplateSection_title_check" CHECK (btrim("title") <> '');

ALTER TABLE "PerformanceTemplateItem"
  ADD CONSTRAINT "PerformanceTemplateItem_prompt_check" CHECK (btrim("prompt") <> ''),
  ADD CONSTRAINT "PerformanceTemplateItem_shape_check" CHECK (
    ("itemType" = 'RATING') = ("ratingScaleId" IS NOT NULL)
    AND ("competencyId" IS NULL OR "itemType" = 'RATING')
    AND (("itemType" = 'SCALE') = ("scaleMin" IS NOT NULL AND "scaleMax" IS NOT NULL))
    AND ("scaleMin" IS NULL OR ("scaleMax" IS NOT NULL AND "scaleMin" < "scaleMax"))
    AND ("weight" IS NULL OR ("itemType" = 'RATING' AND "respondent" <> 'SELF' AND "weight" > 0 AND "weight" <= 100))
  );

ALTER TABLE "PerformanceCycle"
  ADD CONSTRAINT "PerformanceCycle_code_check" CHECK ("code" ~ '^[A-Z0-9_-]{2,64}$'),
  ADD CONSTRAINT "PerformanceCycle_name_check" CHECK (btrim("name") <> ''),
  ADD CONSTRAINT "PerformanceCycle_period_check" CHECK ("periodEnd" >= "periodStart"),
  ADD CONSTRAINT "PerformanceCycle_window_check" CHECK ("windowEnd" >= "windowStart"),
  ADD CONSTRAINT "PerformanceCycle_due_check" CHECK (
    ("selfReviewDueDate" IS NULL OR "selfReviewDueDate" BETWEEN "windowStart" AND "windowEnd")
    AND ("reviewerDueDate" IS NULL OR "reviewerDueDate" BETWEEN "windowStart" AND "windowEnd")
  ),
  ADD CONSTRAINT "PerformanceCycle_opened_shape_check" CHECK (
    ("status" = 'DRAFT') = ("openedAt" IS NULL)
    AND ("status" = 'DRAFT' OR ("scoringMode" IS NOT NULL AND "overallRatingEnabled" IS NOT NULL))
    AND (("status" IN ('CLOSED', 'ARCHIVED')) = ("closedAt" IS NOT NULL))
    AND (("status" = 'ARCHIVED') = ("archivedAt" IS NOT NULL))
  );

ALTER TABLE "PerformanceReview"
  ADD CONSTRAINT "PerformanceReview_not_self_reviewer_check" CHECK ("reviewerEmployeeId" IS NULL OR "reviewerEmployeeId" <> "employeeId"),
  ADD CONSTRAINT "PerformanceReview_reviewer_shape_check" CHECK (
    ("reviewerEmployeeId" IS NULL) = ("reviewerSource" IS NULL)
    AND ("reviewerAssignmentId" IS NULL OR "reviewerEmployeeId" IS NOT NULL)
  ),
  ADD CONSTRAINT "PerformanceReview_reviewer_part_check" CHECK ("reviewerStatus" <> 'NOT_REQUIRED'),
  ADD CONSTRAINT "PerformanceReview_lifecycle_shape_check" CHECK (
    (("selfStatus" = 'SUBMITTED') = ("selfSubmittedAt" IS NOT NULL))
    AND (("reviewerStatus" = 'SUBMITTED') = ("reviewerSubmittedAt" IS NOT NULL))
    AND ("status" NOT IN ('SUBMITTED', 'FINALIZED', 'ACKNOWLEDGED') OR "reviewerStatus" = 'SUBMITTED')
    AND (("status" IN ('FINALIZED', 'ACKNOWLEDGED')) <= ("finalizedAt" IS NOT NULL))
    AND (("status" = 'ACKNOWLEDGED') <= ("acknowledgedAt" IS NOT NULL))
    AND (("status" = 'CLOSED') = ("closedAt" IS NOT NULL AND "closeReason" IS NOT NULL))
    AND ("status" NOT IN ('FINALIZED', 'ACKNOWLEDGED', 'CLOSED') OR "selfStatus" IN ('NOT_REQUIRED', 'SUBMITTED', 'NOT_SUBMITTED'))
  ),
  ADD CONSTRAINT "PerformanceReview_rating_check" CHECK (("overallRatingValue" IS NULL) = ("overallRatingLabel" IS NULL));

ALTER TABLE "PerformanceReviewResponse"
  ADD CONSTRAINT "PerformanceReviewResponse_respondent_check" CHECK ("respondent" IN ('SELF', 'REVIEWER')),
  ADD CONSTRAINT "PerformanceReviewResponse_rating_check" CHECK (("ratingValue" IS NULL) = ("ratingLabel" IS NULL)),
  ADD CONSTRAINT "PerformanceReviewResponse_correction_shape_check" CHECK (
    ("recordType" = 'CORRECTION') = ("correctionReason" IS NOT NULL)
    AND ("correctionReason" IS NULL OR btrim("correctionReason") <> '')
    AND ("recordType" = 'ORIGINAL' OR ("supersedesResponseId" IS NOT NULL AND "lockedAt" IS NOT NULL))
    AND ("supersededAt" IS NULL OR "lockedAt" IS NOT NULL)
  );
CREATE UNIQUE INDEX "PerformanceReviewResponse_current_key"
  ON "PerformanceReviewResponse"("reviewId", "itemId", "respondent") WHERE "supersededAt" IS NULL;

ALTER TABLE "PerformanceReviewEvent"
  ADD CONSTRAINT "PerformanceReviewEvent_reason_check" CHECK ("reason" IS NULL OR btrim("reason") <> '');

ALTER TABLE "PerformanceGoal"
  ADD CONSTRAINT "PerformanceGoal_title_check" CHECK (btrim("title") <> ''),
  ADD CONSTRAINT "PerformanceGoal_dates_check" CHECK ("dueDate" IS NULL OR "dueDate" >= "startDate"),
  ADD CONSTRAINT "PerformanceGoal_progress_check" CHECK ("progressPercent" IS NULL OR "progressPercent" BETWEEN 0 AND 100),
  ADD CONSTRAINT "PerformanceGoal_status_shape_check" CHECK (
    (("status" = 'COMPLETED') = ("completedAt" IS NOT NULL))
    AND (("status" = 'CANCELLED') = ("cancelledAt" IS NOT NULL AND "cancellationReason" IS NOT NULL))
    AND ("cancellationReason" IS NULL OR btrim("cancellationReason") <> '')
  );

CREATE UNIQUE INDEX "PerformanceReviewGoal_active_key"
  ON "PerformanceReviewGoal"("reviewId", "goalId") WHERE "unlinkedAt" IS NULL;

ALTER TABLE "PerformanceEvidenceSource"
  ADD CONSTRAINT "PerformanceEvidenceSource_code_check" CHECK ("code" ~ '^[A-Z0-9_-]{2,64}$'),
  ADD CONSTRAINT "PerformanceEvidenceSource_name_check" CHECK (btrim("name") <> ''),
  ADD CONSTRAINT "PerformanceEvidenceSource_resource_check" CHECK ("externalResourceId" IS NULL OR btrim("externalResourceId") <> ''),
  ADD CONSTRAINT "PerformanceEvidenceSource_threshold_check" CHECK ("passThresholdPercent" IS NULL OR "passThresholdPercent" BETWEEN 0 AND 100);
CREATE UNIQUE INDEX "PerformanceEvidenceSource_resource_key"
  ON "PerformanceEvidenceSource"("organizationId", "provider", "externalResourceId") WHERE "externalResourceId" IS NOT NULL;

ALTER TABLE "PerformanceEvidence"
  ADD CONSTRAINT "PerformanceEvidence_title_check" CHECK (btrim("title") <> ''),
  ADD CONSTRAINT "PerformanceEvidence_score_check" CHECK (
    ("score" IS NULL OR "score" >= 0)
    AND ("maxScore" IS NULL OR "maxScore" > 0)
    AND ("score" IS NULL OR "maxScore" IS NULL OR "score" <= "maxScore")
    AND ("percentage" IS NULL OR "percentage" BETWEEN 0 AND 100)
    AND ("passThresholdPercent" IS NULL OR "passThresholdPercent" BETWEEN 0 AND 100)
  ),
  ADD CONSTRAINT "PerformanceEvidence_external_check" CHECK (
    ("externalResultId" IS NULL OR "externalResourceId" IS NOT NULL)
    AND ("externalResultId" IS NULL OR btrim("externalResultId") <> '')
  ),
  ADD CONSTRAINT "PerformanceEvidence_revision_shape_check" CHECK (
    "revision" >= 1
    AND (("revision" = 1) = ("supersedesEvidenceId" IS NULL))
    AND (("supersedesEvidenceId" IS NULL) = ("correctionReason" IS NULL))
  ),
  ADD CONSTRAINT "PerformanceEvidence_withdrawn_shape_check" CHECK (
    ("status" = 'WITHDRAWN') = ("withdrawnAt" IS NOT NULL AND "withdrawalReason" IS NOT NULL)
  );
-- One current revision per external result (idempotent, retry-safe imports).
CREATE UNIQUE INDEX "PerformanceEvidence_external_result_key"
  ON "PerformanceEvidence"("organizationId", "provider", "externalResourceId", "externalResultId")
  WHERE "supersededAt" IS NULL AND "externalResultId" IS NOT NULL;

ALTER TABLE "PerformanceEvidenceIntake"
  ADD CONSTRAINT "PerformanceEvidenceIntake_shape_check" CHECK (
    btrim("externalResultId") <> ''
    AND (("status" = 'PENDING_MATCH') = ("resolvedAt" IS NULL))
    AND (("status" = 'MATCHED') = ("evidenceId" IS NOT NULL))
  );

CREATE UNIQUE INDEX "PerformanceReviewEvidence_active_key"
  ON "PerformanceReviewEvidence"("reviewId", "evidenceId") WHERE "unlinkedAt" IS NULL;

-- Lock order of Performance writes: PerformanceCycle → PerformanceReview → responses/links.
-- Configuration rows are locked by their own writes. Core HR rows are only read.

CREATE FUNCTION performance_assignment_organization(assignment_id uuid) RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT p."organizationId" FROM "EmploymentAssignment" a
  JOIN "Position" p ON p."id" = a."positionId" WHERE a."id" = assignment_id
$$;

CREATE FUNCTION guard_performance_competency() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Competencies are archived, never deleted.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."organizationId" <> OLD."organizationId" OR NEW."code" <> OLD."code" THEN
    RAISE EXCEPTION 'A competency''s organization and code never change.' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "PerformanceCompetency_guard" BEFORE UPDATE OR DELETE ON "PerformanceCompetency"
  FOR EACH ROW EXECUTE FUNCTION guard_performance_competency();

-- Shared by rating scales and templates: DRAFT → ACTIVE → ARCHIVED, identity fixed.
CREATE FUNCTION guard_performance_config() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'Only draft configuration can be deleted.' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW."organizationId" <> OLD."organizationId" OR NEW."code" <> OLD."code" THEN
    RAISE EXCEPTION 'Configuration organization and code never change.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."status" <> OLD."status" AND NOT (
    (OLD."status" = 'DRAFT' AND NEW."status" = 'ACTIVE')
    OR (OLD."status" IN ('DRAFT', 'ACTIVE') AND NEW."status" = 'ARCHIVED')
  ) THEN
    RAISE EXCEPTION 'Invalid configuration status change from % to %.', OLD."status", NEW."status" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "PerformanceRatingScale_guard" BEFORE UPDATE OR DELETE ON "PerformanceRatingScale"
  FOR EACH ROW EXECUTE FUNCTION guard_performance_config();

CREATE FUNCTION check_performance_scale_activation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."status" = 'ACTIVE' AND OLD."status" = 'DRAFT'
     AND (SELECT count(*) FROM "PerformanceRatingScaleLevel" WHERE "scaleId" = NEW."id") < 2 THEN
    RAISE EXCEPTION 'A rating scale needs at least two levels.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "PerformanceRatingScale_activation" BEFORE UPDATE ON "PerformanceRatingScale"
  FOR EACH ROW EXECUTE FUNCTION check_performance_scale_activation();

CREATE FUNCTION guard_performance_scale_level() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  scale_status "PerformanceConfigStatus";
BEGIN
  SELECT "status" INTO scale_status FROM "PerformanceRatingScale"
  WHERE "id" = COALESCE(NEW."scaleId", OLD."scaleId") FOR NO KEY UPDATE;
  IF scale_status <> 'DRAFT' OR (TG_OP = 'UPDATE' AND NEW."scaleId" <> OLD."scaleId") THEN
    RAISE EXCEPTION 'Levels of an active rating scale never change; create a new scale.' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER "PerformanceRatingScaleLevel_guard" BEFORE INSERT OR UPDATE OR DELETE ON "PerformanceRatingScaleLevel"
  FOR EACH ROW EXECUTE FUNCTION guard_performance_scale_level();

CREATE TRIGGER "PerformanceTemplate_guard" BEFORE UPDATE OR DELETE ON "PerformanceTemplate"
  FOR EACH ROW EXECUTE FUNCTION guard_performance_config();

CREATE FUNCTION guard_performance_template_content() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW."scoringMode" <> OLD."scoringMode"
    OR NEW."ratingScaleId" IS DISTINCT FROM OLD."ratingScaleId"
    OR NEW."overallRatingEnabled" <> OLD."overallRatingEnabled"
  ) AND OLD."status" <> 'DRAFT' THEN
    RAISE EXCEPTION 'An active template never changes; create a new version.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."status" = 'ACTIVE' AND NEW."ratingScaleId" IS NOT NULL AND (
    SELECT "status" FROM "PerformanceRatingScale" WHERE "id" = NEW."ratingScaleId"
  ) <> 'ACTIVE' AND (TG_OP = 'INSERT' OR OLD."status" = 'DRAFT') THEN
    RAISE EXCEPTION 'An active template needs an active rating scale.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "PerformanceTemplate_content" BEFORE INSERT OR UPDATE ON "PerformanceTemplate"
  FOR EACH ROW EXECUTE FUNCTION guard_performance_template_content();

-- Sections and items change only while their template is a draft.
CREATE FUNCTION guard_performance_template_part() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  template_status "PerformanceConfigStatus";
BEGIN
  SELECT "status" INTO template_status FROM "PerformanceTemplate"
  WHERE "id" = COALESCE(NEW."templateId", OLD."templateId") FOR NO KEY UPDATE;
  IF template_status <> 'DRAFT' OR (TG_OP = 'UPDATE' AND NEW."templateId" <> OLD."templateId") THEN
    RAISE EXCEPTION 'An active template never changes; create a new version.' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER "PerformanceTemplateSection_guard" BEFORE INSERT OR UPDATE OR DELETE ON "PerformanceTemplateSection"
  FOR EACH ROW EXECUTE FUNCTION guard_performance_template_part();
CREATE TRIGGER "PerformanceTemplateItem_guard" BEFORE INSERT OR UPDATE OR DELETE ON "PerformanceTemplateItem"
  FOR EACH ROW EXECUTE FUNCTION guard_performance_template_part();

CREATE FUNCTION guard_performance_cycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'Only a draft cycle can be deleted.' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'A cycle starts as a draft.' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."organizationId" <> OLD."organizationId" OR NEW."code" <> OLD."code" THEN
    RAISE EXCEPTION 'A cycle''s organization and code never change.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."status" <> OLD."status" AND NOT (
    (OLD."status" = 'DRAFT' AND NEW."status" = 'OPEN')
    OR (OLD."status" = 'OPEN' AND NEW."status" = 'CLOSED')
    OR (OLD."status" = 'CLOSED' AND NEW."status" = 'ARCHIVED')
  ) THEN
    RAISE EXCEPTION 'Invalid cycle status change from % to %.', OLD."status", NEW."status" USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."status" <> 'DRAFT' AND (
    NEW."templateId" <> OLD."templateId"
    OR NEW."reviewerModel" <> OLD."reviewerModel"
    OR NEW."selfReviewEnabled" <> OLD."selfReviewEnabled"
    OR NEW."acknowledgementEnabled" <> OLD."acknowledgementEnabled"
    OR NEW."periodStart" <> OLD."periodStart"
    OR NEW."periodEnd" <> OLD."periodEnd"
    OR NEW."windowStart" <> OLD."windowStart"
    OR NEW."scoringMode" IS DISTINCT FROM OLD."scoringMode"
    OR NEW."overallRatingEnabled" IS DISTINCT FROM OLD."overallRatingEnabled"
    OR NEW."overallScaleLevels"::text IS DISTINCT FROM OLD."overallScaleLevels"::text
    OR NEW."overallScaleName" IS DISTINCT FROM OLD."overallScaleName"
    OR NEW."openedAt" IS DISTINCT FROM OLD."openedAt"
  ) THEN
    RAISE EXCEPTION 'An opened cycle''s template, period, reviewer model and snapshot never change.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."status" IN ('CLOSED', 'ARCHIVED') AND (
    NEW."windowEnd" <> OLD."windowEnd"
    OR NEW."selfReviewDueDate" IS DISTINCT FROM OLD."selfReviewDueDate"
    OR NEW."reviewerDueDate" IS DISTINCT FROM OLD."reviewerDueDate"
  ) THEN
    RAISE EXCEPTION 'A closed cycle''s dates never change.' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "PerformanceCycle_guard" BEFORE INSERT OR UPDATE OR DELETE ON "PerformanceCycle"
  FOR EACH ROW EXECUTE FUNCTION guard_performance_cycle();

-- The form snapshot is written once, while the cycle is opened (still DRAFT in the same
-- transaction), and never changes.
CREATE FUNCTION guard_performance_form() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'A cycle''s form snapshot never changes.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF (SELECT "status" FROM "PerformanceCycle" WHERE "id" = NEW."cycleId") <> 'DRAFT' THEN
    RAISE EXCEPTION 'A cycle''s form is frozen once it opens.' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "PerformanceFormSection_guard" BEFORE INSERT OR UPDATE OR DELETE ON "PerformanceFormSection"
  FOR EACH ROW EXECUTE FUNCTION guard_performance_form();
CREATE TRIGGER "PerformanceFormItem_guard" BEFORE INSERT OR UPDATE OR DELETE ON "PerformanceFormItem"
  FOR EACH ROW EXECUTE FUNCTION guard_performance_form();

CREATE FUNCTION guard_performance_review() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  cycle_status "PerformanceCycleStatus";
BEGIN
  SELECT "status" INTO cycle_status FROM "PerformanceCycle"
  WHERE "id" = COALESCE(NEW."cycleId", OLD."cycleId");
  IF TG_OP = 'DELETE' THEN
    IF cycle_status <> 'DRAFT' THEN
      RAISE EXCEPTION 'Reviews of an opened cycle are closed, never deleted.' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF cycle_status NOT IN ('DRAFT', 'OPEN') THEN
      RAISE EXCEPTION 'Reviews are added to draft or open cycles only.' USING ERRCODE = 'check_violation';
    END IF;
    IF performance_assignment_organization(NEW."employmentAssignmentId") <> NEW."organizationId" THEN
      RAISE EXCEPTION 'The assignment belongs to another organization.' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" <> 'NOT_STARTED' THEN
      RAISE EXCEPTION 'A review starts not started.' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."cycleId" <> OLD."cycleId" OR NEW."organizationId" <> OLD."organizationId"
     OR NEW."employeeId" <> OLD."employeeId"
     OR NEW."employmentAssignmentId" <> OLD."employmentAssignmentId" THEN
    RAISE EXCEPTION 'A review''s cycle, employee and assignment never change.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."status" <> OLD."status" AND NOT (
    (OLD."status" = 'NOT_STARTED' AND NEW."status" IN ('IN_PROGRESS', 'SUBMITTED', 'CLOSED'))
    OR (OLD."status" = 'IN_PROGRESS' AND NEW."status" IN ('SUBMITTED', 'CLOSED'))
    OR (OLD."status" = 'SUBMITTED' AND NEW."status" IN ('IN_PROGRESS', 'FINALIZED', 'CLOSED'))
    OR (OLD."status" = 'FINALIZED' AND NEW."status" IN ('ACKNOWLEDGED', 'CLOSED'))
    OR (OLD."status" = 'ACKNOWLEDGED' AND NEW."status" IN ('FINALIZED', 'CLOSED'))
  ) THEN
    RAISE EXCEPTION 'Invalid review status change from % to %.', OLD."status", NEW."status" USING ERRCODE = 'check_violation';
  END IF;
  IF cycle_status <> 'OPEN' AND OLD."status" IN ('NOT_STARTED', 'IN_PROGRESS', 'SUBMITTED')
     AND NEW."status" NOT IN ('CLOSED') AND (
       NEW."status" <> OLD."status" OR NEW."selfStatus" <> OLD."selfStatus"
       OR NEW."reviewerStatus" <> OLD."reviewerStatus"
     ) THEN
    RAISE EXCEPTION 'Reviews progress only while their cycle is open.' USING ERRCODE = 'check_violation';
  END IF;
  -- Finalized content is locked: only acknowledgement, closing and explicit corrections of the
  -- overall rating/score change it.
  IF OLD."status" IN ('FINALIZED', 'ACKNOWLEDGED', 'CLOSED') AND (
    NEW."selfStatus" <> OLD."selfStatus" OR NEW."reviewerStatus" <> OLD."reviewerStatus"
    OR NEW."reviewerEmployeeId" IS DISTINCT FROM OLD."reviewerEmployeeId"
    OR NEW."reviewerAssignmentId" IS DISTINCT FROM OLD."reviewerAssignmentId"
    OR NEW."selfSubmittedAt" IS DISTINCT FROM OLD."selfSubmittedAt"
    OR NEW."reviewerSubmittedAt" IS DISTINCT FROM OLD."reviewerSubmittedAt"
    OR NEW."reviewerSubmittedEmployeeId" IS DISTINCT FROM OLD."reviewerSubmittedEmployeeId"
    OR NEW."finalizedAt" IS DISTINCT FROM OLD."finalizedAt"
  ) THEN
    RAISE EXCEPTION 'A finalized review is locked; use an explicit correction.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."status" = 'CLOSED' AND (
    NEW."status" <> 'CLOSED' OR NEW."closedAt" <> OLD."closedAt" OR NEW."closeReason" <> OLD."closeReason"
    OR NEW."acknowledgedAt" IS DISTINCT FROM OLD."acknowledgedAt"
    OR (OLD."finalizedAt" IS NULL AND (
      NEW."calculatedScore" IS DISTINCT FROM OLD."calculatedScore"
      OR NEW."overallRatingValue" IS DISTINCT FROM OLD."overallRatingValue"))
  ) THEN
    RAISE EXCEPTION 'A closed review is frozen.' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "PerformanceReview_guard" BEFORE INSERT OR UPDATE OR DELETE ON "PerformanceReview"
  FOR EACH ROW EXECUTE FUNCTION guard_performance_review();

CREATE FUNCTION guard_performance_response() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  review_status "PerformanceReviewStatus";
  item_respondent "PerformanceRespondent";
BEGIN
  SELECT "status" INTO review_status FROM "PerformanceReview" WHERE "id" = COALESCE(NEW."reviewId", OLD."reviewId");
  IF TG_OP = 'DELETE' THEN
    IF OLD."lockedAt" IS NOT NULL OR review_status IN ('FINALIZED', 'ACKNOWLEDGED', 'CLOSED') THEN
      RAISE EXCEPTION 'Submitted answers are never deleted.' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT "respondent" INTO item_respondent FROM "PerformanceFormItem" WHERE "id" = NEW."itemId";
    IF item_respondent <> 'BOTH' AND item_respondent::text <> NEW."respondent"::text THEN
      RAISE EXCEPTION 'This item is not answered by %.', NEW."respondent" USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."recordType" = 'ORIGINAL' AND review_status NOT IN ('NOT_STARTED', 'IN_PROGRESS', 'SUBMITTED') THEN
      RAISE EXCEPTION 'A finalized review is locked; use an explicit correction.' USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW."recordType" = 'CORRECTION' AND review_status NOT IN ('FINALIZED', 'ACKNOWLEDGED', 'CLOSED') THEN
      RAISE EXCEPTION 'Corrections apply to finalized reviews.' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."reviewId" <> OLD."reviewId" OR NEW."itemId" <> OLD."itemId"
     OR NEW."respondent" <> OLD."respondent" OR NEW."recordType" <> OLD."recordType"
     OR NEW."supersedesResponseId" IS DISTINCT FROM OLD."supersedesResponseId" THEN
    RAISE EXCEPTION 'An answer never moves.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."lockedAt" IS NOT NULL THEN
    IF OLD."supersededAt" IS NOT NULL OR NEW."supersededAt" IS NULL
       OR NEW."lockedAt" <> OLD."lockedAt"
       OR NEW."ratingValue" IS DISTINCT FROM OLD."ratingValue"
       OR NEW."ratingLabel" IS DISTINCT FROM OLD."ratingLabel"
       OR NEW."numericValue" IS DISTINCT FROM OLD."numericValue"
       OR NEW."booleanValue" IS DISTINCT FROM OLD."booleanValue"
       OR NEW."textValue" IS DISTINCT FROM OLD."textValue"
       OR NEW."authorUserId" IS DISTINCT FROM OLD."authorUserId"
       OR NEW."authorEmployeeId" IS DISTINCT FROM OLD."authorEmployeeId" THEN
      RAISE EXCEPTION 'Submitted answers are immutable; they are only superseded.' USING ERRCODE = 'restrict_violation';
    END IF;
  ELSIF review_status NOT IN ('NOT_STARTED', 'IN_PROGRESS', 'SUBMITTED') THEN
    RAISE EXCEPTION 'A finalized review is locked.' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "PerformanceReviewResponse_guard" BEFORE INSERT OR UPDATE OR DELETE ON "PerformanceReviewResponse"
  FOR EACH ROW EXECUTE FUNCTION guard_performance_response();

CREATE FUNCTION prevent_performance_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only.', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END $$;
CREATE TRIGGER "PerformanceReviewEvent_append_only" BEFORE UPDATE OR DELETE ON "PerformanceReviewEvent"
  FOR EACH ROW EXECUTE FUNCTION prevent_performance_append_only();

CREATE FUNCTION guard_performance_acknowledgement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD."supersededAt" IS NOT NULL OR NEW."supersededAt" IS NULL
     OR NEW."reviewId" <> OLD."reviewId" OR NEW."employeeId" <> OLD."employeeId"
     OR NEW."userId" <> OLD."userId" OR NEW."comment" IS DISTINCT FROM OLD."comment"
     OR NEW."acknowledgedAt" <> OLD."acknowledgedAt" THEN
    RAISE EXCEPTION 'Acknowledgements are immutable; a correction only supersedes them.' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "PerformanceReviewAcknowledgement_guard" BEFORE UPDATE OR DELETE ON "PerformanceReviewAcknowledgement"
  FOR EACH ROW EXECUTE FUNCTION guard_performance_acknowledgement();
CREATE UNIQUE INDEX "PerformanceReviewAcknowledgement_current_key"
  ON "PerformanceReviewAcknowledgement"("reviewId") WHERE "supersededAt" IS NULL;

CREATE FUNCTION guard_performance_goal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Goals are cancelled, never deleted.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF performance_assignment_organization(NEW."employmentAssignmentId") <> NEW."organizationId" THEN
      RAISE EXCEPTION 'The assignment belongs to another organization.' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."organizationId" <> OLD."organizationId" OR NEW."employeeId" <> OLD."employeeId"
     OR NEW."employmentAssignmentId" <> OLD."employmentAssignmentId" THEN
    RAISE EXCEPTION 'A goal never moves to another employee or assignment.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."status" IN ('COMPLETED', 'CANCELLED') THEN
    RAISE EXCEPTION 'Completed and cancelled goals are frozen.' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "PerformanceGoal_guard" BEFORE INSERT OR UPDATE OR DELETE ON "PerformanceGoal"
  FOR EACH ROW EXECUTE FUNCTION guard_performance_goal();

-- Links (goals, evidence) change only while the review is being written; finalization only
-- freezes the goal state onto the link.
CREATE FUNCTION guard_performance_review_goal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  review_row "PerformanceReview"%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Review links are unlinked, never deleted.' USING ERRCODE = 'restrict_violation';
  END IF;
  SELECT * INTO review_row FROM "PerformanceReview" WHERE "id" = NEW."reviewId";
  IF TG_OP = 'INSERT' THEN
    IF review_row."status" NOT IN ('NOT_STARTED', 'IN_PROGRESS', 'SUBMITTED') THEN
      RAISE EXCEPTION 'A finalized review''s links are locked.' USING ERRCODE = 'restrict_violation';
    END IF;
    IF (SELECT "employmentAssignmentId" FROM "PerformanceGoal" WHERE "id" = NEW."goalId")
       <> review_row."employmentAssignmentId" THEN
      RAISE EXCEPTION 'A goal links only into reviews of its own assignment.' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."reviewId" <> OLD."reviewId" OR NEW."goalId" <> OLD."goalId" OR NEW."employeeId" <> OLD."employeeId"
     OR NEW."linkedAt" <> OLD."linkedAt" OR (OLD."unlinkedAt" IS NOT NULL AND NEW."unlinkedAt" IS DISTINCT FROM OLD."unlinkedAt")
     OR (OLD."snapshottedAt" IS NOT NULL AND (
       NEW."snapshottedAt" IS DISTINCT FROM OLD."snapshottedAt"
       OR NEW."snapshotStatus" IS DISTINCT FROM OLD."snapshotStatus"
       OR NEW."snapshotProgress" IS DISTINCT FROM OLD."snapshotProgress"
       OR NEW."snapshotTitle" IS DISTINCT FROM OLD."snapshotTitle")) THEN
    RAISE EXCEPTION 'Review goal links are only unlinked or snapshotted once.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."unlinkedAt" IS DISTINCT FROM OLD."unlinkedAt"
     AND review_row."status" NOT IN ('NOT_STARTED', 'IN_PROGRESS', 'SUBMITTED') THEN
    RAISE EXCEPTION 'A finalized review''s links are locked.' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "PerformanceReviewGoal_guard" BEFORE INSERT OR UPDATE OR DELETE ON "PerformanceReviewGoal"
  FOR EACH ROW EXECUTE FUNCTION guard_performance_review_goal();

CREATE FUNCTION guard_performance_evidence_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Evidence sources are archived, never deleted.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."organizationId" <> OLD."organizationId" OR NEW."code" <> OLD."code"
     OR NEW."provider" <> OLD."provider"
     OR (OLD."externalResourceId" IS NOT NULL AND NEW."externalResourceId" IS DISTINCT FROM OLD."externalResourceId") THEN
    RAISE EXCEPTION 'An evidence source''s organization, code, provider and resource never change.' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "PerformanceEvidenceSource_guard" BEFORE UPDATE OR DELETE ON "PerformanceEvidenceSource"
  FOR EACH ROW EXECUTE FUNCTION guard_performance_evidence_source();

CREATE FUNCTION guard_performance_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Evidence is withdrawn or superseded, never deleted.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."employmentAssignmentId" IS NOT NULL
       AND performance_assignment_organization(NEW."employmentAssignmentId") <> NEW."organizationId" THEN
      RAISE EXCEPTION 'The assignment belongs to another organization.' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM "EmploymentAssignment" a JOIN "Position" p ON p."id" = a."positionId"
      WHERE a."employeeId" = NEW."employeeId" AND p."organizationId" = NEW."organizationId"
    ) THEN
      RAISE EXCEPTION 'The employee has no assignment in the evidence''s organization.' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."supersedesEvidenceId" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM "PerformanceEvidence" o
      WHERE o."id" = NEW."supersedesEvidenceId"
        AND o."organizationId" = NEW."organizationId" AND o."provider" = NEW."provider"
        AND o."externalResourceId" IS NOT DISTINCT FROM NEW."externalResourceId"
        AND o."externalResultId" IS NOT DISTINCT FROM NEW."externalResultId"
        AND o."supersededAt" IS NOT NULL AND NEW."revision" = o."revision" + 1
    ) THEN
      -- The employee may change: a result re-matched to the right employee is a new revision.
      RAISE EXCEPTION 'A revision supersedes the current revision of the same result.' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."organizationId" <> OLD."organizationId" OR NEW."employeeId" <> OLD."employeeId"
     OR NEW."employmentAssignmentId" IS DISTINCT FROM OLD."employmentAssignmentId"
     OR NEW."sourceId" IS DISTINCT FROM OLD."sourceId"
     OR NEW."provider" <> OLD."provider" OR NEW."kind" <> OLD."kind" OR NEW."channel" <> OLD."channel"
     OR NEW."title" <> OLD."title"
     OR NEW."externalResourceId" IS DISTINCT FROM OLD."externalResourceId"
     OR NEW."externalResultId" IS DISTINCT FROM OLD."externalResultId"
     OR NEW."completedAt" <> OLD."completedAt"
     OR NEW."score" IS DISTINCT FROM OLD."score" OR NEW."maxScore" IS DISTINCT FROM OLD."maxScore"
     OR NEW."percentage" IS DISTINCT FROM OLD."percentage" OR NEW."passed" IS DISTINCT FROM OLD."passed"
     OR NEW."passThresholdPercent" IS DISTINCT FROM OLD."passThresholdPercent"
     OR NEW."resultUrl" IS DISTINCT FROM OLD."resultUrl"
     OR NEW."externalUpdatedAt" IS DISTINCT FROM OLD."externalUpdatedAt"
     OR NEW."contentHash" IS DISTINCT FROM OLD."contentHash"
     OR NEW."notes" IS DISTINCT FROM OLD."notes"
     OR NEW."revision" <> OLD."revision"
     OR NEW."supersedesEvidenceId" IS DISTINCT FROM OLD."supersedesEvidenceId"
     OR NEW."correctionReason" IS DISTINCT FROM OLD."correctionReason"
     OR NEW."importedAt" <> OLD."importedAt"
     OR NEW."recordedByUserId" IS DISTINCT FROM OLD."recordedByUserId"
     OR (OLD."supersededAt" IS NOT NULL AND NEW."supersededAt" IS DISTINCT FROM OLD."supersededAt")
     OR (OLD."status" = 'WITHDRAWN' AND (NEW."status" <> 'WITHDRAWN'
         OR NEW."withdrawnAt" IS DISTINCT FROM OLD."withdrawnAt"
         OR NEW."withdrawalReason" IS DISTINCT FROM OLD."withdrawalReason")) THEN
    RAISE EXCEPTION 'Evidence is immutable; it is only superseded by a revision or withdrawn.' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "PerformanceEvidence_guard" BEFORE INSERT OR UPDATE OR DELETE ON "PerformanceEvidence"
  FOR EACH ROW EXECUTE FUNCTION guard_performance_evidence();

CREATE FUNCTION guard_performance_evidence_intake() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Evidence intake is resolved, never deleted.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."organizationId" <> OLD."organizationId" OR NEW."sourceId" <> OLD."sourceId"
     OR NEW."externalResultId" <> OLD."externalResultId"
     OR (OLD."status" <> 'PENDING_MATCH' AND (
       NEW."status" <> OLD."status" OR NEW."evidenceId" IS DISTINCT FROM OLD."evidenceId"
       OR NEW."result"::text <> OLD."result"::text)) THEN
    RAISE EXCEPTION 'A resolved intake never changes.' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "PerformanceEvidenceIntake_guard" BEFORE UPDATE OR DELETE ON "PerformanceEvidenceIntake"
  FOR EACH ROW EXECUTE FUNCTION guard_performance_evidence_intake();

CREATE FUNCTION guard_performance_review_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  review_row "PerformanceReview"%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Review links are unlinked, never deleted.' USING ERRCODE = 'restrict_violation';
  END IF;
  SELECT * INTO review_row FROM "PerformanceReview" WHERE "id" = NEW."reviewId";
  IF TG_OP = 'INSERT' THEN
    IF review_row."status" NOT IN ('NOT_STARTED', 'IN_PROGRESS', 'SUBMITTED') THEN
      RAISE EXCEPTION 'A finalized review''s links are locked.' USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW."cycleId" <> review_row."cycleId" THEN
      RAISE EXCEPTION 'The link''s cycle must be the review''s cycle.' USING ERRCODE = 'check_violation';
    END IF;
    IF (SELECT "organizationId" FROM "PerformanceEvidence" WHERE "id" = NEW."evidenceId") <> review_row."organizationId" THEN
      RAISE EXCEPTION 'The evidence belongs to another organization.' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."formItemId" IS NOT NULL
       AND (SELECT "itemType" FROM "PerformanceFormItem" WHERE "id" = NEW."formItemId") <> 'EVIDENCE_REFERENCE' THEN
      RAISE EXCEPTION 'Evidence links only to evidence items.' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."reviewId" <> OLD."reviewId" OR NEW."evidenceId" <> OLD."evidenceId"
     OR NEW."formItemId" IS DISTINCT FROM OLD."formItemId" OR NEW."linkedAt" <> OLD."linkedAt"
     OR OLD."unlinkedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'Review evidence links are only unlinked, once.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF review_row."status" NOT IN ('NOT_STARTED', 'IN_PROGRESS', 'SUBMITTED') THEN
    RAISE EXCEPTION 'A finalized review''s links are locked.' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "PerformanceReviewEvidence_guard" BEFORE INSERT OR UPDATE OR DELETE ON "PerformanceReviewEvidence"
  FOR EACH ROW EXECUTE FUNCTION guard_performance_review_evidence();
