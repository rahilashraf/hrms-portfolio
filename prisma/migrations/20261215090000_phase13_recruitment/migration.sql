-- CreateEnum
CREATE TYPE "JobOpeningStatus" AS ENUM ('DRAFT', 'OPEN', 'ON_HOLD', 'FILLED', 'CLOSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "JobOpeningEventType" AS ENUM ('CREATED', 'UPDATED', 'STATUS_CHANGED', 'HIRE_RECORDED');

-- CreateEnum
CREATE TYPE "RecruitmentStageKind" AS ENUM ('APPLIED', 'SCREENING', 'INTERVIEW', 'ASSESSMENT', 'REFERENCE_CHECK', 'OFFER', 'HIRED', 'OTHER');

-- CreateEnum
CREATE TYPE "RecruitmentCandidateStatus" AS ENUM ('ACTIVE', 'MERGED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "RecruitmentSource" AS ENUM ('DIRECT', 'REFERRAL', 'JOB_BOARD', 'AGENCY', 'INTERNAL', 'CAREERS_SITE', 'EXTERNAL_FORM', 'OTHER');

-- CreateEnum
CREATE TYPE "RecruitmentApplicationStatus" AS ENUM ('ACTIVE', 'WITHDRAWN', 'REJECTED', 'OFFERED', 'HIRED');

-- CreateEnum
CREATE TYPE "RecruitmentScreeningOutcome" AS ENUM ('PENDING', 'ADVANCE', 'HOLD', 'DO_NOT_ADVANCE');

-- CreateEnum
CREATE TYPE "RecruitmentActivityType" AS ENUM ('APPLICATION_RECEIVED', 'APPLICATION_UPDATED_EXTERNALLY', 'STAGE_CHANGED', 'SCREENING_RECORDED', 'INTERVIEW_SCHEDULED', 'INTERVIEW_RESCHEDULED', 'INTERVIEW_CANCELLED', 'INTERVIEW_COMPLETED', 'FEEDBACK_SUBMITTED', 'FEEDBACK_REOPENED', 'OFFER_CREATED', 'OFFER_APPROVED', 'OFFER_REVISED', 'OFFER_SENT', 'OFFER_ACCEPTED', 'OFFER_DECLINED', 'OFFER_WITHDRAWN', 'OFFER_EXPIRED', 'APPLICATION_WITHDRAWN', 'APPLICATION_REJECTED', 'HIRED', 'CANDIDATE_MERGED', 'DOCUMENT_ADDED', 'DOCUMENT_REMOVED');

-- CreateEnum
CREATE TYPE "RecruitmentInterviewType" AS ENUM ('PHONE', 'VIDEO', 'IN_PERSON', 'PANEL', 'OTHER');

-- CreateEnum
CREATE TYPE "RecruitmentInterviewStatus" AS ENUM ('SCHEDULED', 'COMPLETED', 'CANCELLED', 'NO_SHOW');

-- CreateEnum
CREATE TYPE "RecruitmentRecommendation" AS ENUM ('STRONG_YES', 'YES', 'NO', 'STRONG_NO', 'NO_DECISION');

-- CreateEnum
CREATE TYPE "RecruitmentFeedbackStatus" AS ENUM ('DRAFT', 'SUBMITTED');

-- CreateEnum
CREATE TYPE "RecruitmentOfferStatus" AS ENUM ('DRAFT', 'APPROVED', 'SENT', 'ACCEPTED', 'DECLINED', 'WITHDRAWN', 'EXPIRED');

-- CreateEnum
CREATE TYPE "RecruitmentDocumentKind" AS ENUM ('RESUME', 'COVER_LETTER', 'CERTIFICATE', 'REFERENCE', 'PORTFOLIO', 'OTHER');

-- CreateEnum
CREATE TYPE "RecruitmentDocumentProvider" AS ENUM ('EXTERNAL_URL', 'GOOGLE_DRIVE', 'MANUAL_REFERENCE');

-- CreateEnum
CREATE TYPE "RecruitmentIntakeProvider" AS ENUM ('GOOGLE_FORMS', 'CAREERS_SITE', 'MANUAL_IMPORT', 'OTHER');

-- CreateEnum
CREATE TYPE "RecruitmentIntakeStatus" AS ENUM ('APPLIED', 'PENDING_OPENING', 'REJECTED');

-- CreateTable
CREATE TABLE "RecruitmentStage" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "RecruitmentStageKind" NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "createdByUserId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "archivedAt" TIMESTAMPTZ(6),

    CONSTRAINT "RecruitmentStage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobOpening" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "positionId" UUID,
    "organizationalUnitId" UUID,
    "departmentId" UUID,
    "teamId" UUID,
    "workLocationId" UUID,
    "hiringManagerEmployeeId" UUID,
    "recruiterUserId" UUID,
    "employmentType" "EmploymentType" NOT NULL,
    "openingCount" INTEGER NOT NULL DEFAULT 1,
    "hiredCount" INTEGER NOT NULL DEFAULT 0,
    "expectedStartDate" DATE,
    "postedOn" DATE,
    "closesOn" DATE,
    "compensationPayBasis" "CompensationPayBasis",
    "compensationMin" DECIMAL(19,4),
    "compensationMax" DECIMAL(19,4),
    "compensationCurrency" CHAR(3),
    "status" "JobOpeningStatus" NOT NULL DEFAULT 'DRAFT',
    "statusReason" TEXT,
    "openedAt" TIMESTAMPTZ(6),
    "closedAt" TIMESTAMPTZ(6),
    "createdByUserId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "JobOpening_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobOpeningEvent" (
    "id" UUID NOT NULL,
    "openingId" UUID NOT NULL,
    "type" "JobOpeningEventType" NOT NULL,
    "fromStatus" "JobOpeningStatus",
    "toStatus" "JobOpeningStatus",
    "changedFields" TEXT[],
    "reason" TEXT,
    "actorUserId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JobOpeningEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecruitmentCandidate" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "preferredName" TEXT,
    "email" TEXT,
    "normalizedEmail" TEXT,
    "phone" TEXT,
    "location" TEXT,
    "source" "RecruitmentSource" NOT NULL DEFAULT 'DIRECT',
    "notes" TEXT,
    "internalEmployeeId" UUID,
    "personId" UUID,
    "status" "RecruitmentCandidateStatus" NOT NULL DEFAULT 'ACTIVE',
    "mergedIntoCandidateId" UUID,
    "mergedAt" TIMESTAMPTZ(6),
    "mergedByUserId" UUID,
    "createdByUserId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "RecruitmentCandidate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecruitmentApplication" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "candidateId" UUID NOT NULL,
    "openingId" UUID NOT NULL,
    "stageId" UUID NOT NULL,
    "status" "RecruitmentApplicationStatus" NOT NULL DEFAULT 'ACTIVE',
    "source" "RecruitmentSource" NOT NULL DEFAULT 'DIRECT',
    "sourceDetail" TEXT,
    "appliedAt" TIMESTAMPTZ(6) NOT NULL,
    "recruiterUserId" UUID,
    "stageEnteredAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dispositionReason" TEXT,
    "dispositionAt" TIMESTAMPTZ(6),
    "dispositionByUserId" UUID,
    "createdByUserId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "RecruitmentApplication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecruitmentScreening" (
    "id" UUID NOT NULL,
    "applicationId" UUID NOT NULL,
    "outcome" "RecruitmentScreeningOutcome" NOT NULL DEFAULT 'PENDING',
    "meetsMinimumQualifications" BOOLEAN,
    "workAuthorizationConfirmed" BOOLEAN,
    "requiredCertificationsHeld" BOOLEAN,
    "availableFrom" DATE,
    "notes" TEXT,
    "screenedByUserId" UUID,
    "screenedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "RecruitmentScreening_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecruitmentStageTransition" (
    "id" UUID NOT NULL,
    "applicationId" UUID NOT NULL,
    "fromStageId" UUID,
    "fromStageName" TEXT,
    "toStageId" UUID NOT NULL,
    "toStageName" TEXT NOT NULL,
    "note" TEXT,
    "actorUserId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecruitmentStageTransition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecruitmentActivity" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "candidateId" UUID NOT NULL,
    "applicationId" UUID,
    "type" "RecruitmentActivityType" NOT NULL,
    "summary" TEXT NOT NULL,
    "relatedId" UUID,
    "actorUserId" UUID,
    "occurredAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecruitmentActivity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecruitmentInterview" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "applicationId" UUID NOT NULL,
    "type" "RecruitmentInterviewType" NOT NULL,
    "title" TEXT NOT NULL,
    "scheduledStart" TIMESTAMPTZ(6) NOT NULL,
    "durationMinutes" INTEGER NOT NULL,
    "location" TEXT,
    "meetingUrl" TEXT,
    "status" "RecruitmentInterviewStatus" NOT NULL DEFAULT 'SCHEDULED',
    "feedbackDueAt" TIMESTAMPTZ(6),
    "completedAt" TIMESTAMPTZ(6),
    "cancelledAt" TIMESTAMPTZ(6),
    "cancellationReason" TEXT,
    "createdByUserId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "RecruitmentInterview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecruitmentInterviewer" (
    "id" UUID NOT NULL,
    "interviewId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "assignedByUserId" UUID,
    "assignedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedAt" TIMESTAMPTZ(6),
    "removedByUserId" UUID,

    CONSTRAINT "RecruitmentInterviewer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecruitmentInterviewFeedback" (
    "id" UUID NOT NULL,
    "interviewId" UUID NOT NULL,
    "interviewerUserId" UUID NOT NULL,
    "status" "RecruitmentFeedbackStatus" NOT NULL DEFAULT 'DRAFT',
    "recommendation" "RecruitmentRecommendation",
    "rating" INTEGER,
    "strengths" TEXT,
    "concerns" TEXT,
    "comments" TEXT,
    "submittedAt" TIMESTAMPTZ(6),
    "revision" INTEGER NOT NULL DEFAULT 1,
    "supersedesFeedbackId" UUID,
    "supersededAt" TIMESTAMPTZ(6),
    "reopenReason" TEXT,
    "reopenedByUserId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "RecruitmentInterviewFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecruitmentOffer" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "applicationId" UUID NOT NULL,
    "positionId" UUID NOT NULL,
    "workLocationId" UUID,
    "employmentType" "EmploymentType" NOT NULL,
    "startDate" DATE NOT NULL,
    "payBasis" "CompensationPayBasis" NOT NULL,
    "rateAmount" DECIMAL(19,4) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "expiresOn" DATE,
    "candidateTerms" TEXT,
    "internalNotes" TEXT,
    "status" "RecruitmentOfferStatus" NOT NULL DEFAULT 'DRAFT',
    "approvedAt" TIMESTAMPTZ(6),
    "approvedByUserId" UUID,
    "sentAt" TIMESTAMPTZ(6),
    "sentByUserId" UUID,
    "respondedAt" TIMESTAMPTZ(6),
    "responseRecordedByUserId" UUID,
    "declineReason" TEXT,
    "withdrawnAt" TIMESTAMPTZ(6),
    "withdrawalReason" TEXT,
    "expiredAt" TIMESTAMPTZ(6),
    "createdByUserId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "RecruitmentOffer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecruitmentHire" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "applicationId" UUID NOT NULL,
    "offerId" UUID NOT NULL,
    "candidateId" UUID NOT NULL,
    "openingId" UUID NOT NULL,
    "personId" UUID NOT NULL,
    "employeeId" UUID NOT NULL,
    "employmentAssignmentId" UUID NOT NULL,
    "compensationRecordId" UUID,
    "internalCandidate" BOOLEAN NOT NULL,
    "createdEmployee" BOOLEAN NOT NULL,
    "convertedByUserId" UUID,
    "convertedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecruitmentHire_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecruitmentCandidateDocument" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "candidateId" UUID NOT NULL,
    "applicationId" UUID,
    "kind" "RecruitmentDocumentKind" NOT NULL,
    "title" TEXT NOT NULL,
    "provider" "RecruitmentDocumentProvider" NOT NULL,
    "externalUrl" TEXT,
    "externalFileId" TEXT,
    "fileName" TEXT,
    "mimeType" TEXT,
    "addedByUserId" UUID,
    "addedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedAt" TIMESTAMPTZ(6),
    "removedByUserId" UUID,
    "removalReason" TEXT,

    CONSTRAINT "RecruitmentCandidateDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecruitmentIntakeSource" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "provider" "RecruitmentIntakeProvider" NOT NULL,
    "externalResourceId" TEXT,
    "resourceUrl" TEXT,
    "defaultOpeningId" UUID,
    "lastSyncedAt" TIMESTAMPTZ(6),
    "lastSyncStatus" TEXT,
    "lastSyncMessage" TEXT,
    "createdByUserId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "archivedAt" TIMESTAMPTZ(6),

    CONSTRAINT "RecruitmentIntakeSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecruitmentIntakeSubmission" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "sourceId" UUID NOT NULL,
    "externalResponseId" TEXT NOT NULL,
    "status" "RecruitmentIntakeStatus" NOT NULL,
    "submission" JSONB NOT NULL,
    "contentHash" TEXT NOT NULL,
    "submittedAt" TIMESTAMPTZ(6) NOT NULL,
    "externalUpdatedAt" TIMESTAMPTZ(6),
    "correctionCount" INTEGER NOT NULL DEFAULT 0,
    "reason" TEXT,
    "candidateId" UUID,
    "applicationId" UUID,
    "receivedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastReceivedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMPTZ(6),
    "resolvedByUserId" UUID,

    CONSTRAINT "RecruitmentIntakeSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RecruitmentStage_organizationId_archivedAt_sortOrder_idx" ON "RecruitmentStage"("organizationId", "archivedAt", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "RecruitmentStage_organizationId_code_key" ON "RecruitmentStage"("organizationId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "RecruitmentStage_id_organizationId_key" ON "RecruitmentStage"("id", "organizationId");

-- CreateIndex
CREATE INDEX "JobOpening_organizationId_status_idx" ON "JobOpening"("organizationId", "status");

-- CreateIndex
CREATE INDEX "JobOpening_hiringManagerEmployeeId_idx" ON "JobOpening"("hiringManagerEmployeeId");

-- CreateIndex
CREATE UNIQUE INDEX "JobOpening_organizationId_code_key" ON "JobOpening"("organizationId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "JobOpening_id_organizationId_key" ON "JobOpening"("id", "organizationId");

-- CreateIndex
CREATE INDEX "JobOpeningEvent_openingId_createdAt_idx" ON "JobOpeningEvent"("openingId", "createdAt");

-- CreateIndex
CREATE INDEX "RecruitmentCandidate_organizationId_status_idx" ON "RecruitmentCandidate"("organizationId", "status");

-- CreateIndex
CREATE INDEX "RecruitmentCandidate_organizationId_lastName_firstName_idx" ON "RecruitmentCandidate"("organizationId", "lastName", "firstName");

-- CreateIndex
CREATE INDEX "RecruitmentCandidate_internalEmployeeId_idx" ON "RecruitmentCandidate"("internalEmployeeId");

-- CreateIndex
CREATE UNIQUE INDEX "RecruitmentCandidate_id_organizationId_key" ON "RecruitmentCandidate"("id", "organizationId");

-- CreateIndex
CREATE INDEX "RecruitmentApplication_organizationId_status_idx" ON "RecruitmentApplication"("organizationId", "status");

-- CreateIndex
CREATE INDEX "RecruitmentApplication_openingId_status_stageId_idx" ON "RecruitmentApplication"("openingId", "status", "stageId");

-- CreateIndex
CREATE INDEX "RecruitmentApplication_candidateId_idx" ON "RecruitmentApplication"("candidateId");

-- CreateIndex
CREATE UNIQUE INDEX "RecruitmentApplication_id_organizationId_key" ON "RecruitmentApplication"("id", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "RecruitmentScreening_applicationId_key" ON "RecruitmentScreening"("applicationId");

-- CreateIndex
CREATE INDEX "RecruitmentStageTransition_applicationId_createdAt_idx" ON "RecruitmentStageTransition"("applicationId", "createdAt");

-- CreateIndex
CREATE INDEX "RecruitmentActivity_candidateId_occurredAt_idx" ON "RecruitmentActivity"("candidateId", "occurredAt");

-- CreateIndex
CREATE INDEX "RecruitmentActivity_applicationId_occurredAt_idx" ON "RecruitmentActivity"("applicationId", "occurredAt");

-- CreateIndex
CREATE INDEX "RecruitmentInterview_applicationId_scheduledStart_idx" ON "RecruitmentInterview"("applicationId", "scheduledStart");

-- CreateIndex
CREATE INDEX "RecruitmentInterview_organizationId_status_scheduledStart_idx" ON "RecruitmentInterview"("organizationId", "status", "scheduledStart");

-- CreateIndex
CREATE INDEX "RecruitmentInterviewer_interviewId_idx" ON "RecruitmentInterviewer"("interviewId");

-- CreateIndex
CREATE INDEX "RecruitmentInterviewer_userId_removedAt_idx" ON "RecruitmentInterviewer"("userId", "removedAt");

-- CreateIndex
CREATE UNIQUE INDEX "RecruitmentInterviewFeedback_supersedesFeedbackId_key" ON "RecruitmentInterviewFeedback"("supersedesFeedbackId");

-- CreateIndex
CREATE INDEX "RecruitmentInterviewFeedback_interviewId_idx" ON "RecruitmentInterviewFeedback"("interviewId");

-- CreateIndex
CREATE INDEX "RecruitmentOffer_applicationId_status_idx" ON "RecruitmentOffer"("applicationId", "status");

-- CreateIndex
CREATE INDEX "RecruitmentOffer_organizationId_status_expiresOn_idx" ON "RecruitmentOffer"("organizationId", "status", "expiresOn");

-- CreateIndex
CREATE UNIQUE INDEX "RecruitmentOffer_id_applicationId_key" ON "RecruitmentOffer"("id", "applicationId");

-- CreateIndex
CREATE UNIQUE INDEX "RecruitmentHire_applicationId_key" ON "RecruitmentHire"("applicationId");

-- CreateIndex
CREATE UNIQUE INDEX "RecruitmentHire_offerId_key" ON "RecruitmentHire"("offerId");

-- CreateIndex
CREATE UNIQUE INDEX "RecruitmentHire_employmentAssignmentId_key" ON "RecruitmentHire"("employmentAssignmentId");

-- CreateIndex
CREATE UNIQUE INDEX "RecruitmentHire_compensationRecordId_key" ON "RecruitmentHire"("compensationRecordId");

-- CreateIndex
CREATE INDEX "RecruitmentHire_organizationId_convertedAt_idx" ON "RecruitmentHire"("organizationId", "convertedAt");

-- CreateIndex
CREATE INDEX "RecruitmentHire_employeeId_idx" ON "RecruitmentHire"("employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "RecruitmentHire_offerId_applicationId_key" ON "RecruitmentHire"("offerId", "applicationId");

-- CreateIndex
CREATE INDEX "RecruitmentCandidateDocument_candidateId_removedAt_idx" ON "RecruitmentCandidateDocument"("candidateId", "removedAt");

-- CreateIndex
CREATE INDEX "RecruitmentCandidateDocument_applicationId_idx" ON "RecruitmentCandidateDocument"("applicationId");

-- CreateIndex
CREATE UNIQUE INDEX "RecruitmentIntakeSource_organizationId_code_key" ON "RecruitmentIntakeSource"("organizationId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "RecruitmentIntakeSource_id_organizationId_key" ON "RecruitmentIntakeSource"("id", "organizationId");

-- CreateIndex
CREATE INDEX "RecruitmentIntakeSubmission_organizationId_status_idx" ON "RecruitmentIntakeSubmission"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "RecruitmentIntakeSubmission_sourceId_externalResponseId_key" ON "RecruitmentIntakeSubmission"("sourceId", "externalResponseId");

-- AddForeignKey
ALTER TABLE "RecruitmentStage" ADD CONSTRAINT "RecruitmentStage_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobOpening" ADD CONSTRAINT "JobOpening_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobOpening" ADD CONSTRAINT "JobOpening_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "Position"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobOpening" ADD CONSTRAINT "JobOpening_organizationalUnitId_organizationId_fkey" FOREIGN KEY ("organizationalUnitId", "organizationId") REFERENCES "OrganizationalUnit"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobOpening" ADD CONSTRAINT "JobOpening_departmentId_organizationId_fkey" FOREIGN KEY ("departmentId", "organizationId") REFERENCES "Department"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobOpening" ADD CONSTRAINT "JobOpening_teamId_organizationId_fkey" FOREIGN KEY ("teamId", "organizationId") REFERENCES "Team"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobOpening" ADD CONSTRAINT "JobOpening_workLocationId_organizationId_fkey" FOREIGN KEY ("workLocationId", "organizationId") REFERENCES "WorkLocation"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobOpening" ADD CONSTRAINT "JobOpening_hiringManagerEmployeeId_fkey" FOREIGN KEY ("hiringManagerEmployeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobOpeningEvent" ADD CONSTRAINT "JobOpeningEvent_openingId_fkey" FOREIGN KEY ("openingId") REFERENCES "JobOpening"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecruitmentCandidate" ADD CONSTRAINT "RecruitmentCandidate_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecruitmentCandidate" ADD CONSTRAINT "RecruitmentCandidate_internalEmployeeId_fkey" FOREIGN KEY ("internalEmployeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecruitmentCandidate" ADD CONSTRAINT "RecruitmentCandidate_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecruitmentCandidate" ADD CONSTRAINT "RecruitmentCandidate_mergedIntoCandidateId_organizationId_fkey" FOREIGN KEY ("mergedIntoCandidateId", "organizationId") REFERENCES "RecruitmentCandidate"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecruitmentApplication" ADD CONSTRAINT "RecruitmentApplication_candidateId_organizationId_fkey" FOREIGN KEY ("candidateId", "organizationId") REFERENCES "RecruitmentCandidate"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecruitmentApplication" ADD CONSTRAINT "RecruitmentApplication_openingId_organizationId_fkey" FOREIGN KEY ("openingId", "organizationId") REFERENCES "JobOpening"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecruitmentApplication" ADD CONSTRAINT "RecruitmentApplication_stageId_organizationId_fkey" FOREIGN KEY ("stageId", "organizationId") REFERENCES "RecruitmentStage"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecruitmentScreening" ADD CONSTRAINT "RecruitmentScreening_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "RecruitmentApplication"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecruitmentStageTransition" ADD CONSTRAINT "RecruitmentStageTransition_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "RecruitmentApplication"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecruitmentActivity" ADD CONSTRAINT "RecruitmentActivity_candidateId_organizationId_fkey" FOREIGN KEY ("candidateId", "organizationId") REFERENCES "RecruitmentCandidate"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecruitmentActivity" ADD CONSTRAINT "RecruitmentActivity_applicationId_organizationId_fkey" FOREIGN KEY ("applicationId", "organizationId") REFERENCES "RecruitmentApplication"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecruitmentInterview" ADD CONSTRAINT "RecruitmentInterview_applicationId_organizationId_fkey" FOREIGN KEY ("applicationId", "organizationId") REFERENCES "RecruitmentApplication"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecruitmentInterviewer" ADD CONSTRAINT "RecruitmentInterviewer_interviewId_fkey" FOREIGN KEY ("interviewId") REFERENCES "RecruitmentInterview"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecruitmentInterviewer" ADD CONSTRAINT "RecruitmentInterviewer_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecruitmentInterviewFeedback" ADD CONSTRAINT "RecruitmentInterviewFeedback_interviewId_fkey" FOREIGN KEY ("interviewId") REFERENCES "RecruitmentInterview"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecruitmentInterviewFeedback" ADD CONSTRAINT "RecruitmentInterviewFeedback_supersedesFeedbackId_fkey" FOREIGN KEY ("supersedesFeedbackId") REFERENCES "RecruitmentInterviewFeedback"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecruitmentOffer" ADD CONSTRAINT "RecruitmentOffer_applicationId_organizationId_fkey" FOREIGN KEY ("applicationId", "organizationId") REFERENCES "RecruitmentApplication"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecruitmentOffer" ADD CONSTRAINT "RecruitmentOffer_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "Position"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecruitmentOffer" ADD CONSTRAINT "RecruitmentOffer_workLocationId_organizationId_fkey" FOREIGN KEY ("workLocationId", "organizationId") REFERENCES "WorkLocation"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecruitmentHire" ADD CONSTRAINT "RecruitmentHire_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "RecruitmentApplication"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecruitmentHire" ADD CONSTRAINT "RecruitmentHire_offerId_applicationId_fkey" FOREIGN KEY ("offerId", "applicationId") REFERENCES "RecruitmentOffer"("id", "applicationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecruitmentHire" ADD CONSTRAINT "RecruitmentHire_candidateId_organizationId_fkey" FOREIGN KEY ("candidateId", "organizationId") REFERENCES "RecruitmentCandidate"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecruitmentHire" ADD CONSTRAINT "RecruitmentHire_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecruitmentHire" ADD CONSTRAINT "RecruitmentHire_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecruitmentHire" ADD CONSTRAINT "RecruitmentHire_employmentAssignmentId_employeeId_fkey" FOREIGN KEY ("employmentAssignmentId", "employeeId") REFERENCES "EmploymentAssignment"("id", "employeeId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecruitmentHire" ADD CONSTRAINT "RecruitmentHire_compensationRecordId_fkey" FOREIGN KEY ("compensationRecordId") REFERENCES "CompensationRecord"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecruitmentCandidateDocument" ADD CONSTRAINT "RecruitmentCandidateDocument_candidateId_organizationId_fkey" FOREIGN KEY ("candidateId", "organizationId") REFERENCES "RecruitmentCandidate"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecruitmentCandidateDocument" ADD CONSTRAINT "RecruitmentCandidateDocument_applicationId_organizationId_fkey" FOREIGN KEY ("applicationId", "organizationId") REFERENCES "RecruitmentApplication"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecruitmentIntakeSource" ADD CONSTRAINT "RecruitmentIntakeSource_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecruitmentIntakeSource" ADD CONSTRAINT "RecruitmentIntakeSource_defaultOpeningId_organizationId_fkey" FOREIGN KEY ("defaultOpeningId", "organizationId") REFERENCES "JobOpening"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecruitmentIntakeSubmission" ADD CONSTRAINT "RecruitmentIntakeSubmission_sourceId_organizationId_fkey" FOREIGN KEY ("sourceId", "organizationId") REFERENCES "RecruitmentIntakeSource"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecruitmentIntakeSubmission" ADD CONSTRAINT "RecruitmentIntakeSubmission_candidateId_organizationId_fkey" FOREIGN KEY ("candidateId", "organizationId") REFERENCES "RecruitmentCandidate"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecruitmentIntakeSubmission" ADD CONSTRAINT "RecruitmentIntakeSubmission_applicationId_organizationId_fkey" FOREIGN KEY ("applicationId", "organizationId") REFERENCES "RecruitmentApplication"("id", "organizationId") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ─── Integrity ───────────────────────────────────────────────────────────────
-- Lock order of Recruitment writes: JobOpening → RecruitmentApplication → its offer,
-- interview and feedback rows. Hire conversion then writes Core HR (Person, Employee,
-- EmploymentAssignment) and optionally Compensation through their own domain services.

ALTER TABLE "RecruitmentStage"
  ADD CONSTRAINT "RecruitmentStage_code_check" CHECK ("code" ~ '^[A-Z0-9_-]{2,64}$'),
  ADD CONSTRAINT "RecruitmentStage_name_check" CHECK (btrim("name") <> '');

ALTER TABLE "JobOpening"
  ADD CONSTRAINT "JobOpening_code_check" CHECK ("code" ~ '^[A-Z0-9_-]{2,64}$'),
  ADD CONSTRAINT "JobOpening_title_check" CHECK (btrim("title") <> ''),
  ADD CONSTRAINT "JobOpening_count_check" CHECK ("openingCount" BETWEEN 1 AND 1000 AND "hiredCount" >= 0 AND "hiredCount" <= "openingCount"),
  ADD CONSTRAINT "JobOpening_dates_check" CHECK ("closesOn" IS NULL OR "postedOn" IS NULL OR "closesOn" >= "postedOn"),
  ADD CONSTRAINT "JobOpening_compensation_check" CHECK (
    ("compensationMin" IS NULL AND "compensationMax" IS NULL AND "compensationCurrency" IS NULL AND "compensationPayBasis" IS NULL)
    OR ("compensationCurrency" IS NOT NULL AND "compensationPayBasis" IS NOT NULL
        AND ("compensationMin" IS NOT NULL OR "compensationMax" IS NOT NULL)
        AND ("compensationMin" IS NULL OR "compensationMin" > 0)
        AND ("compensationMax" IS NULL OR "compensationMax" > 0)
        AND ("compensationMin" IS NULL OR "compensationMax" IS NULL OR "compensationMin" <= "compensationMax"))
  ),
  ADD CONSTRAINT "JobOpening_status_shape_check" CHECK (
    ("status" = 'DRAFT') = ("openedAt" IS NULL)
    AND (("status" IN ('CLOSED', 'CANCELLED')) = ("closedAt" IS NOT NULL))
    AND ("status" <> 'FILLED' OR "hiredCount" = "openingCount")
  );

ALTER TABLE "JobOpeningEvent"
  ADD CONSTRAINT "JobOpeningEvent_reason_check" CHECK ("reason" IS NULL OR btrim("reason") <> '');

ALTER TABLE "RecruitmentCandidate"
  ADD CONSTRAINT "RecruitmentCandidate_name_check" CHECK (btrim("firstName") <> '' AND btrim("lastName") <> ''),
  ADD CONSTRAINT "RecruitmentCandidate_email_check" CHECK (
    ("email" IS NULL) = ("normalizedEmail" IS NULL)
    AND ("normalizedEmail" IS NULL OR "normalizedEmail" = lower(btrim("email")))
    AND ("normalizedEmail" IS NULL OR "normalizedEmail" ~ '^[^@\s]+@[^@\s]+$')
  ),
  ADD CONSTRAINT "RecruitmentCandidate_merge_shape_check" CHECK (
    ("status" = 'MERGED') = ("mergedIntoCandidateId" IS NOT NULL)
    AND (("mergedIntoCandidateId" IS NULL) = ("mergedAt" IS NULL))
    AND ("mergedIntoCandidateId" IS NULL OR "mergedIntoCandidateId" <> "id")
  );
-- Deduplication: one unmerged candidate per normalized email in an organization.
CREATE UNIQUE INDEX "RecruitmentCandidate_email_key"
  ON "RecruitmentCandidate"("organizationId", "normalizedEmail")
  WHERE "normalizedEmail" IS NOT NULL AND "mergedIntoCandidateId" IS NULL;
-- One candidate record per internal employee in an organization.
CREATE UNIQUE INDEX "RecruitmentCandidate_internal_key"
  ON "RecruitmentCandidate"("organizationId", "internalEmployeeId")
  WHERE "internalEmployeeId" IS NOT NULL AND "mergedIntoCandidateId" IS NULL;

ALTER TABLE "RecruitmentApplication"
  ADD CONSTRAINT "RecruitmentApplication_disposition_shape_check" CHECK (
    ("status" IN ('WITHDRAWN', 'REJECTED')) = ("dispositionAt" IS NOT NULL)
    AND ("dispositionReason" IS NULL OR btrim("dispositionReason") <> '')
  );
-- One live application per candidate and opening (withdrawn/rejected ones are kept).
CREATE UNIQUE INDEX "RecruitmentApplication_live_key"
  ON "RecruitmentApplication"("candidateId", "openingId")
  WHERE "status" IN ('ACTIVE', 'OFFERED', 'HIRED');

ALTER TABLE "RecruitmentInterview"
  ADD CONSTRAINT "RecruitmentInterview_title_check" CHECK (btrim("title") <> ''),
  ADD CONSTRAINT "RecruitmentInterview_duration_check" CHECK ("durationMinutes" BETWEEN 5 AND 1440),
  ADD CONSTRAINT "RecruitmentInterview_url_check" CHECK ("meetingUrl" IS NULL OR "meetingUrl" ~* '^https://\S+$'),
  ADD CONSTRAINT "RecruitmentInterview_status_shape_check" CHECK (
    (("status" = 'COMPLETED') = ("completedAt" IS NOT NULL))
    AND (("status" = 'CANCELLED') = ("cancelledAt" IS NOT NULL AND "cancellationReason" IS NOT NULL))
    AND ("cancellationReason" IS NULL OR btrim("cancellationReason") <> '')
  );

CREATE UNIQUE INDEX "RecruitmentInterviewer_active_key"
  ON "RecruitmentInterviewer"("interviewId", "userId") WHERE "removedAt" IS NULL;

ALTER TABLE "RecruitmentInterviewFeedback"
  ADD CONSTRAINT "RecruitmentInterviewFeedback_rating_check" CHECK ("rating" IS NULL OR "rating" BETWEEN 1 AND 5),
  ADD CONSTRAINT "RecruitmentInterviewFeedback_shape_check" CHECK (
    (("status" = 'SUBMITTED') = ("submittedAt" IS NOT NULL))
    AND ("status" = 'DRAFT' OR "recommendation" IS NOT NULL)
    AND ("supersededAt" IS NULL OR "status" = 'SUBMITTED')
    AND ("revision" >= 1 AND (("revision" = 1) = ("supersedesFeedbackId" IS NULL)))
    AND (("supersedesFeedbackId" IS NULL) = ("reopenReason" IS NULL))
    AND ("reopenReason" IS NULL OR btrim("reopenReason") <> '')
  );
-- One current feedback per interviewer and interview.
CREATE UNIQUE INDEX "RecruitmentInterviewFeedback_current_key"
  ON "RecruitmentInterviewFeedback"("interviewId", "interviewerUserId") WHERE "supersededAt" IS NULL;

ALTER TABLE "RecruitmentOffer"
  ADD CONSTRAINT "RecruitmentOffer_rate_check" CHECK ("rateAmount" > 0),
  ADD CONSTRAINT "RecruitmentOffer_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "RecruitmentOffer_status_shape_check" CHECK (
    ("status" NOT IN ('APPROVED', 'SENT', 'ACCEPTED', 'DECLINED', 'EXPIRED') OR "approvedAt" IS NOT NULL)
    AND ("status" NOT IN ('SENT', 'ACCEPTED', 'DECLINED', 'EXPIRED') OR "sentAt" IS NOT NULL)
    AND (("status" IN ('ACCEPTED', 'DECLINED')) = ("respondedAt" IS NOT NULL))
    AND (("status" = 'WITHDRAWN') = ("withdrawnAt" IS NOT NULL AND "withdrawalReason" IS NOT NULL))
    AND (("status" = 'EXPIRED') = ("expiredAt" IS NOT NULL))
    AND ("withdrawalReason" IS NULL OR btrim("withdrawalReason") <> '')
  );
-- At most one offer in progress, and one accepted offer, per application.
CREATE UNIQUE INDEX "RecruitmentOffer_open_key"
  ON "RecruitmentOffer"("applicationId") WHERE "status" IN ('DRAFT', 'APPROVED', 'SENT');
CREATE UNIQUE INDEX "RecruitmentOffer_accepted_key"
  ON "RecruitmentOffer"("applicationId") WHERE "status" = 'ACCEPTED';

ALTER TABLE "RecruitmentCandidateDocument"
  ADD CONSTRAINT "RecruitmentCandidateDocument_title_check" CHECK (btrim("title") <> ''),
  ADD CONSTRAINT "RecruitmentCandidateDocument_reference_check" CHECK (
    ("externalUrl" IS NULL OR "externalUrl" ~* '^https://\S+$')
    AND ("provider" <> 'EXTERNAL_URL' OR "externalUrl" IS NOT NULL)
    AND ("provider" <> 'GOOGLE_DRIVE' OR "externalUrl" IS NOT NULL OR "externalFileId" IS NOT NULL)
  ),
  ADD CONSTRAINT "RecruitmentCandidateDocument_removal_check" CHECK (("removedAt" IS NULL) = ("removalReason" IS NULL));

ALTER TABLE "RecruitmentIntakeSource"
  ADD CONSTRAINT "RecruitmentIntakeSource_code_check" CHECK ("code" ~ '^[A-Z0-9_-]{2,64}$'),
  ADD CONSTRAINT "RecruitmentIntakeSource_name_check" CHECK (btrim("name") <> ''),
  ADD CONSTRAINT "RecruitmentIntakeSource_resource_check" CHECK (
    ("externalResourceId" IS NULL OR btrim("externalResourceId") <> '')
    AND ("provider" = 'MANUAL_IMPORT' OR "externalResourceId" IS NOT NULL)
  ),
  ADD CONSTRAINT "RecruitmentIntakeSource_url_check" CHECK ("resourceUrl" IS NULL OR "resourceUrl" ~* '^https://\S+$');
CREATE UNIQUE INDEX "RecruitmentIntakeSource_resource_key"
  ON "RecruitmentIntakeSource"("organizationId", "provider", "externalResourceId") WHERE "externalResourceId" IS NOT NULL;

ALTER TABLE "RecruitmentIntakeSubmission"
  ADD CONSTRAINT "RecruitmentIntakeSubmission_shape_check" CHECK (
    btrim("externalResponseId") <> ''
    AND ("status" <> 'APPLIED' OR ("candidateId" IS NOT NULL AND "applicationId" IS NOT NULL))
    AND ("correctionCount" >= 0)
  );

-- ─── Guards ──────────────────────────────────────────────────────────────────

CREATE FUNCTION prevent_recruitment_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only.', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END $$;
CREATE TRIGGER "JobOpeningEvent_append_only" BEFORE UPDATE OR DELETE ON "JobOpeningEvent"
  FOR EACH ROW EXECUTE FUNCTION prevent_recruitment_append_only();
CREATE TRIGGER "RecruitmentStageTransition_append_only" BEFORE UPDATE OR DELETE ON "RecruitmentStageTransition"
  FOR EACH ROW EXECUTE FUNCTION prevent_recruitment_append_only();
CREATE TRIGGER "RecruitmentActivity_append_only" BEFORE UPDATE OR DELETE ON "RecruitmentActivity"
  FOR EACH ROW EXECUTE FUNCTION prevent_recruitment_append_only();

CREATE FUNCTION guard_recruitment_stage() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Stages are archived, never deleted.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."organizationId" <> OLD."organizationId" OR NEW."code" <> OLD."code" OR NEW."kind" <> OLD."kind" THEN
    RAISE EXCEPTION 'A stage''s organization, code and kind never change.' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "RecruitmentStage_guard" BEFORE UPDATE OR DELETE ON "RecruitmentStage"
  FOR EACH ROW EXECUTE FUNCTION guard_recruitment_stage();

CREATE FUNCTION guard_job_opening() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Job openings are closed or cancelled, never deleted.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."positionId" IS NOT NULL AND (TG_OP = 'INSERT' OR NEW."positionId" IS DISTINCT FROM OLD."positionId")
     AND (SELECT "organizationId" FROM "Position" WHERE "id" = NEW."positionId") <> NEW."organizationId" THEN
    RAISE EXCEPTION 'The position belongs to another organization.' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."hiringManagerEmployeeId" IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW."hiringManagerEmployeeId" IS DISTINCT FROM OLD."hiringManagerEmployeeId")
     AND NOT EXISTS (
       SELECT 1 FROM "EmploymentAssignment" a JOIN "Position" p ON p."id" = a."positionId"
       WHERE a."employeeId" = NEW."hiringManagerEmployeeId" AND a."status" <> 'CANCELLED'
         AND p."organizationId" = NEW."organizationId"
     ) THEN
    RAISE EXCEPTION 'The hiring manager has no assignment in the organization.' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'DRAFT' OR NEW."hiredCount" <> 0 THEN
      RAISE EXCEPTION 'An opening starts as a draft without hires.' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."organizationId" <> OLD."organizationId" OR NEW."code" <> OLD."code" THEN
    RAISE EXCEPTION 'An opening''s organization and requisition code never change.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."hiredCount" < OLD."hiredCount" OR NEW."hiredCount" > OLD."hiredCount" + 1 THEN
    RAISE EXCEPTION 'Hires are recorded one at a time and never removed.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."openingCount" < NEW."hiredCount" THEN
    RAISE EXCEPTION 'An opening cannot have fewer openings than hires.' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" <> OLD."status" AND NOT (
    (OLD."status" = 'DRAFT' AND NEW."status" IN ('OPEN', 'CANCELLED'))
    OR (OLD."status" = 'OPEN' AND NEW."status" IN ('ON_HOLD', 'FILLED', 'CLOSED', 'CANCELLED'))
    OR (OLD."status" = 'ON_HOLD' AND NEW."status" IN ('OPEN', 'CLOSED', 'CANCELLED'))
    OR (OLD."status" = 'FILLED' AND NEW."status" IN ('OPEN', 'CLOSED'))
  ) THEN
    RAISE EXCEPTION 'Invalid opening status change from % to %.', OLD."status", NEW."status" USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."status" IN ('CLOSED', 'CANCELLED') AND (
    NEW."title" <> OLD."title" OR NEW."description" IS DISTINCT FROM OLD."description"
    OR NEW."openingCount" <> OLD."openingCount" OR NEW."hiredCount" <> OLD."hiredCount"
    OR NEW."positionId" IS DISTINCT FROM OLD."positionId"
    OR NEW."employmentType" <> OLD."employmentType"
  ) THEN
    RAISE EXCEPTION 'A closed or cancelled opening is frozen.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."hiredCount" > OLD."hiredCount" AND OLD."status" NOT IN ('OPEN') THEN
    RAISE EXCEPTION 'Hires are recorded against open openings only.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "JobOpening_guard" BEFORE INSERT OR UPDATE OR DELETE ON "JobOpening"
  FOR EACH ROW EXECUTE FUNCTION guard_job_opening();

CREATE FUNCTION guard_recruitment_candidate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Candidates are archived or merged, never deleted.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."internalEmployeeId" IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW."internalEmployeeId" IS DISTINCT FROM OLD."internalEmployeeId")
     AND NOT EXISTS (
       SELECT 1 FROM "EmploymentAssignment" a JOIN "Position" p ON p."id" = a."positionId"
       WHERE a."employeeId" = NEW."internalEmployeeId" AND a."status" <> 'CANCELLED'
         AND p."organizationId" = NEW."organizationId"
     ) THEN
    RAISE EXCEPTION 'An internal candidate must be an employee of the organization.' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" = 'MERGED' THEN
      RAISE EXCEPTION 'A candidate is created unmerged.' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."organizationId" <> OLD."organizationId" THEN
    RAISE EXCEPTION 'A candidate never moves to another organization.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."status" = 'MERGED' AND (
    NEW."status" <> 'MERGED' OR NEW."mergedIntoCandidateId" <> OLD."mergedIntoCandidateId"
    OR NEW."mergedAt" <> OLD."mergedAt"
  ) THEN
    RAISE EXCEPTION 'A merge is permanent.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."personId" IS NOT NULL AND NEW."personId" IS DISTINCT FROM OLD."personId" THEN
    RAISE EXCEPTION 'A hired candidate''s person link never changes.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."mergedIntoCandidateId" IS NOT NULL AND OLD."mergedIntoCandidateId" IS NULL
     AND (SELECT "mergedIntoCandidateId" FROM "RecruitmentCandidate" WHERE "id" = NEW."mergedIntoCandidateId") IS NOT NULL THEN
    RAISE EXCEPTION 'Merge into an unmerged candidate.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "RecruitmentCandidate_guard" BEFORE INSERT OR UPDATE OR DELETE ON "RecruitmentCandidate"
  FOR EACH ROW EXECUTE FUNCTION guard_recruitment_candidate();

CREATE FUNCTION guard_recruitment_application() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  opening_status "JobOpeningStatus";
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Applications are withdrawn or rejected, never deleted.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT "status" INTO opening_status FROM "JobOpening" WHERE "id" = NEW."openingId";
    IF opening_status NOT IN ('OPEN', 'ON_HOLD') THEN
      RAISE EXCEPTION 'Applications are received for open openings only.' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" <> 'ACTIVE' THEN
      RAISE EXCEPTION 'An application starts active.' USING ERRCODE = 'check_violation';
    END IF;
    IF (SELECT "status" FROM "RecruitmentCandidate" WHERE "id" = NEW."candidateId") <> 'ACTIVE' THEN
      RAISE EXCEPTION 'Only active candidates apply.' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."organizationId" <> OLD."organizationId" OR NEW."openingId" <> OLD."openingId"
     OR NEW."appliedAt" <> OLD."appliedAt" THEN
    RAISE EXCEPTION 'An application''s organization, opening and date never change.' USING ERRCODE = 'restrict_violation';
  END IF;
  -- The candidate changes only through an explicit merge into the new candidate.
  IF NEW."candidateId" <> OLD."candidateId" AND (
    SELECT "mergedIntoCandidateId" FROM "RecruitmentCandidate" WHERE "id" = OLD."candidateId"
  ) IS DISTINCT FROM NEW."candidateId" THEN
    RAISE EXCEPTION 'An application moves only to the candidate it was merged into.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."status" <> OLD."status" AND NOT (
    (OLD."status" = 'ACTIVE' AND NEW."status" IN ('WITHDRAWN', 'REJECTED', 'OFFERED'))
    OR (OLD."status" = 'OFFERED' AND NEW."status" IN ('ACTIVE', 'HIRED', 'WITHDRAWN', 'REJECTED'))
  ) THEN
    RAISE EXCEPTION 'Invalid application status change from % to %.', OLD."status", NEW."status" USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" = 'HIRED' AND OLD."status" <> 'HIRED'
     AND NOT EXISTS (SELECT 1 FROM "RecruitmentHire" WHERE "applicationId" = NEW."id") THEN
    RAISE EXCEPTION 'An application is hired only by hire conversion.' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."status" IN ('WITHDRAWN', 'REJECTED', 'HIRED') AND (
    NEW."stageId" <> OLD."stageId" OR NEW."dispositionReason" IS DISTINCT FROM OLD."dispositionReason"
    OR NEW."dispositionAt" IS DISTINCT FROM OLD."dispositionAt"
  ) THEN
    RAISE EXCEPTION 'A closed application is frozen.' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "RecruitmentApplication_guard" BEFORE INSERT OR UPDATE OR DELETE ON "RecruitmentApplication"
  FOR EACH ROW EXECUTE FUNCTION guard_recruitment_application();

CREATE FUNCTION guard_recruitment_screening() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Screenings are never deleted.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW."applicationId" <> OLD."applicationId" THEN
    RAISE EXCEPTION 'A screening never moves.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF (SELECT "status" FROM "RecruitmentApplication" WHERE "id" = NEW."applicationId") NOT IN ('ACTIVE', 'OFFERED') THEN
    RAISE EXCEPTION 'Only live applications are screened.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "RecruitmentScreening_guard" BEFORE INSERT OR UPDATE OR DELETE ON "RecruitmentScreening"
  FOR EACH ROW EXECUTE FUNCTION guard_recruitment_screening();

CREATE FUNCTION guard_recruitment_interview() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Interviews are cancelled, never deleted.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'SCHEDULED' THEN
      RAISE EXCEPTION 'An interview starts scheduled.' USING ERRCODE = 'check_violation';
    END IF;
    IF (SELECT "status" FROM "RecruitmentApplication" WHERE "id" = NEW."applicationId") NOT IN ('ACTIVE', 'OFFERED') THEN
      RAISE EXCEPTION 'Interviews are scheduled for live applications only.' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."applicationId" <> OLD."applicationId" OR NEW."organizationId" <> OLD."organizationId" THEN
    RAISE EXCEPTION 'An interview never moves to another application.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."status" <> OLD."status" AND NOT (OLD."status" = 'SCHEDULED' AND NEW."status" IN ('COMPLETED', 'CANCELLED', 'NO_SHOW')) THEN
    RAISE EXCEPTION 'Invalid interview status change from % to %.', OLD."status", NEW."status" USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."status" <> 'SCHEDULED' AND (
    NEW."scheduledStart" <> OLD."scheduledStart" OR NEW."durationMinutes" <> OLD."durationMinutes"
    OR NEW."type" <> OLD."type" OR NEW."title" <> OLD."title"
    OR NEW."location" IS DISTINCT FROM OLD."location" OR NEW."meetingUrl" IS DISTINCT FROM OLD."meetingUrl"
  ) THEN
    RAISE EXCEPTION 'A completed or cancelled interview is frozen.' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "RecruitmentInterview_guard" BEFORE INSERT OR UPDATE OR DELETE ON "RecruitmentInterview"
  FOR EACH ROW EXECUTE FUNCTION guard_recruitment_interview();

CREATE FUNCTION guard_recruitment_interviewer() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Interviewers are removed, never deleted.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND (
    NEW."interviewId" <> OLD."interviewId" OR NEW."userId" <> OLD."userId"
    OR NEW."assignedAt" <> OLD."assignedAt" OR OLD."removedAt" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'An interviewer assignment is only removed, once.' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "RecruitmentInterviewer_guard" BEFORE UPDATE OR DELETE ON "RecruitmentInterviewer"
  FOR EACH ROW EXECUTE FUNCTION guard_recruitment_interviewer();

CREATE FUNCTION guard_recruitment_feedback() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" = 'SUBMITTED' THEN
      RAISE EXCEPTION 'Submitted feedback is never deleted.' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'DRAFT' AND NEW."supersedesFeedbackId" IS NOT NULL THEN
      RAISE EXCEPTION 'A reopened revision starts as a draft.' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."supersedesFeedbackId" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM "RecruitmentInterviewFeedback" o
      WHERE o."id" = NEW."supersedesFeedbackId" AND o."interviewId" = NEW."interviewId"
        AND o."interviewerUserId" = NEW."interviewerUserId" AND o."status" = 'SUBMITTED'
        AND o."supersededAt" IS NOT NULL AND NEW."revision" = o."revision" + 1
    ) THEN
      RAISE EXCEPTION 'A revision supersedes the submitted feedback of the same interviewer.' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."interviewId" <> OLD."interviewId" OR NEW."interviewerUserId" <> OLD."interviewerUserId"
     OR NEW."revision" <> OLD."revision" OR NEW."supersedesFeedbackId" IS DISTINCT FROM OLD."supersedesFeedbackId"
     OR NEW."reopenReason" IS DISTINCT FROM OLD."reopenReason" THEN
    RAISE EXCEPTION 'Feedback never moves.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."status" = 'SUBMITTED' AND (
    OLD."supersededAt" IS NOT NULL OR NEW."supersededAt" IS NULL
    OR NEW."status" <> 'SUBMITTED' OR NEW."submittedAt" <> OLD."submittedAt"
    OR NEW."recommendation" IS DISTINCT FROM OLD."recommendation"
    OR NEW."rating" IS DISTINCT FROM OLD."rating"
    OR NEW."strengths" IS DISTINCT FROM OLD."strengths"
    OR NEW."concerns" IS DISTINCT FROM OLD."concerns"
    OR NEW."comments" IS DISTINCT FROM OLD."comments"
  ) THEN
    RAISE EXCEPTION 'Submitted feedback is locked; it is only superseded by a reopened revision.' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "RecruitmentInterviewFeedback_guard" BEFORE INSERT OR UPDATE OR DELETE ON "RecruitmentInterviewFeedback"
  FOR EACH ROW EXECUTE FUNCTION guard_recruitment_feedback();

CREATE FUNCTION guard_recruitment_offer() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Offers are withdrawn, never deleted.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF (TG_OP = 'INSERT' OR NEW."positionId" <> OLD."positionId")
     AND (SELECT "organizationId" FROM "Position" WHERE "id" = NEW."positionId") <> NEW."organizationId" THEN
    RAISE EXCEPTION 'The offered position belongs to another organization.' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'An offer starts as a draft.' USING ERRCODE = 'check_violation';
    END IF;
    IF (SELECT "status" FROM "RecruitmentApplication" WHERE "id" = NEW."applicationId") <> 'ACTIVE' THEN
      RAISE EXCEPTION 'Offers are made on active applications.' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."applicationId" <> OLD."applicationId" OR NEW."organizationId" <> OLD."organizationId" THEN
    RAISE EXCEPTION 'An offer never moves to another application.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."status" <> OLD."status" AND NOT (
    (OLD."status" = 'DRAFT' AND NEW."status" IN ('APPROVED', 'WITHDRAWN'))
    OR (OLD."status" = 'APPROVED' AND NEW."status" IN ('DRAFT', 'SENT', 'WITHDRAWN'))
    OR (OLD."status" = 'SENT' AND NEW."status" IN ('ACCEPTED', 'DECLINED', 'WITHDRAWN', 'EXPIRED'))
  ) THEN
    RAISE EXCEPTION 'Invalid offer status change from % to %.', OLD."status", NEW."status" USING ERRCODE = 'check_violation';
  END IF;
  -- Terms are editable only as a draft (an approved offer returns to draft to be revised).
  IF OLD."status" <> 'DRAFT' AND (
    NEW."positionId" <> OLD."positionId" OR NEW."workLocationId" IS DISTINCT FROM OLD."workLocationId"
    OR NEW."employmentType" <> OLD."employmentType" OR NEW."startDate" <> OLD."startDate"
    OR NEW."payBasis" <> OLD."payBasis" OR NEW."rateAmount" <> OLD."rateAmount"
    OR NEW."currency" <> OLD."currency" OR NEW."expiresOn" IS DISTINCT FROM OLD."expiresOn"
    OR NEW."candidateTerms" IS DISTINCT FROM OLD."candidateTerms"
  ) THEN
    RAISE EXCEPTION 'An approved offer''s terms are locked; return it to draft to revise.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."status" IN ('ACCEPTED', 'DECLINED', 'WITHDRAWN', 'EXPIRED') AND (
    NEW."internalNotes" IS DISTINCT FROM OLD."internalNotes"
    OR NEW."respondedAt" IS DISTINCT FROM OLD."respondedAt"
    OR NEW."declineReason" IS DISTINCT FROM OLD."declineReason"
  ) THEN
    RAISE EXCEPTION 'A concluded offer is frozen.' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "RecruitmentOffer_guard" BEFORE INSERT OR UPDATE OR DELETE ON "RecruitmentOffer"
  FOR EACH ROW EXECUTE FUNCTION guard_recruitment_offer();

CREATE FUNCTION guard_recruitment_hire() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'A hire conversion is permanent.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "RecruitmentApplication" a
    WHERE a."id" = NEW."applicationId" AND a."organizationId" = NEW."organizationId"
      AND a."candidateId" = NEW."candidateId" AND a."openingId" = NEW."openingId"
      AND a."status" = 'OFFERED'
  ) THEN
    RAISE EXCEPTION 'Hire conversion needs the offered application of the candidate and opening.' USING ERRCODE = 'check_violation';
  END IF;
  IF (SELECT "status" FROM "RecruitmentOffer" WHERE "id" = NEW."offerId") <> 'ACCEPTED' THEN
    RAISE EXCEPTION 'Hire conversion needs an accepted offer.' USING ERRCODE = 'check_violation';
  END IF;
  IF (SELECT "personId" FROM "Employee" WHERE "id" = NEW."employeeId") <> NEW."personId" THEN
    RAISE EXCEPTION 'The employee is not the hired person.' USING ERRCODE = 'check_violation';
  END IF;
  IF (SELECT p."organizationId" FROM "EmploymentAssignment" a JOIN "Position" p ON p."id" = a."positionId"
      WHERE a."id" = NEW."employmentAssignmentId") <> NEW."organizationId" THEN
    RAISE EXCEPTION 'The assignment belongs to another organization.' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."compensationRecordId" IS NOT NULL AND (
    SELECT "employmentAssignmentId" FROM "CompensationRecord" WHERE "id" = NEW."compensationRecordId"
  ) <> NEW."employmentAssignmentId" THEN
    RAISE EXCEPTION 'The compensation record belongs to another assignment.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "RecruitmentHire_guard" BEFORE INSERT OR UPDATE OR DELETE ON "RecruitmentHire"
  FOR EACH ROW EXECUTE FUNCTION guard_recruitment_hire();

CREATE FUNCTION guard_recruitment_document() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Candidate documents are removed, never deleted.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."applicationId" IS NOT NULL AND (
      SELECT "candidateId" FROM "RecruitmentApplication" WHERE "id" = NEW."applicationId"
    ) <> NEW."candidateId" THEN
      RAISE EXCEPTION 'The application belongs to another candidate.' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."organizationId" <> OLD."organizationId"
     OR NEW."applicationId" IS DISTINCT FROM OLD."applicationId"
     OR NEW."kind" <> OLD."kind" OR NEW."title" <> OLD."title" OR NEW."provider" <> OLD."provider"
     OR NEW."externalUrl" IS DISTINCT FROM OLD."externalUrl"
     OR NEW."externalFileId" IS DISTINCT FROM OLD."externalFileId"
     OR NEW."fileName" IS DISTINCT FROM OLD."fileName" OR NEW."mimeType" IS DISTINCT FROM OLD."mimeType"
     OR NEW."addedAt" <> OLD."addedAt" OR OLD."removedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'A document reference is immutable; it is only removed, once (or follows a merge).' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."candidateId" <> OLD."candidateId" AND (
    SELECT "mergedIntoCandidateId" FROM "RecruitmentCandidate" WHERE "id" = OLD."candidateId"
  ) IS DISTINCT FROM NEW."candidateId" THEN
    RAISE EXCEPTION 'A document moves only to the candidate it was merged into.' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "RecruitmentCandidateDocument_guard" BEFORE INSERT OR UPDATE OR DELETE ON "RecruitmentCandidateDocument"
  FOR EACH ROW EXECUTE FUNCTION guard_recruitment_document();

CREATE FUNCTION guard_recruitment_intake_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Intake sources are archived, never deleted.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."organizationId" <> OLD."organizationId" OR NEW."code" <> OLD."code" OR NEW."provider" <> OLD."provider"
     OR (OLD."externalResourceId" IS NOT NULL AND NEW."externalResourceId" IS DISTINCT FROM OLD."externalResourceId") THEN
    RAISE EXCEPTION 'An intake source''s organization, code, provider and resource never change.' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "RecruitmentIntakeSource_guard" BEFORE UPDATE OR DELETE ON "RecruitmentIntakeSource"
  FOR EACH ROW EXECUTE FUNCTION guard_recruitment_intake_source();

CREATE FUNCTION guard_recruitment_intake_submission() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Intake submissions are resolved, never deleted.' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."organizationId" <> OLD."organizationId" OR NEW."sourceId" <> OLD."sourceId"
     OR NEW."externalResponseId" <> OLD."externalResponseId" OR NEW."receivedAt" <> OLD."receivedAt"
     OR NEW."correctionCount" < OLD."correctionCount"
     OR (OLD."status" <> 'PENDING_OPENING' AND NEW."status" <> OLD."status")
     OR (OLD."applicationId" IS NOT NULL AND NEW."applicationId" IS DISTINCT FROM OLD."applicationId") THEN
    RAISE EXCEPTION 'A resolved submission keeps its identity and resolution.' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "RecruitmentIntakeSubmission_guard" BEFORE UPDATE OR DELETE ON "RecruitmentIntakeSubmission"
  FOR EACH ROW EXECUTE FUNCTION guard_recruitment_intake_submission();
