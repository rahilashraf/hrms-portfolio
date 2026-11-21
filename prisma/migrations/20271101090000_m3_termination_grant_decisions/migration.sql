-- Security remediation M3: decisions about role grants when a termination applies (additive).
-- Nothing existing is changed or backfilled: terminations already applied keep their grants as
-- they are (no retroactive revocation); see docs/security/sql/m3-termination-grants-report.sql.

CREATE TYPE "TerminationGrantDecisionKind" AS ENUM ('REVOKE', 'KEEP');
CREATE TYPE "TerminationGrantDecisionStatus" AS ENUM ('DECIDED', 'REQUESTED', 'APPROVED', 'REJECTED', 'CANCELLED');
CREATE TYPE "TerminationGrantOutcome" AS ENUM ('REVOKED', 'RETAINED', 'ALREADY_REVOKED');

CREATE TABLE "EmployeeTerminationGrantDecision" (
    "id" UUID NOT NULL,
    "terminationId" UUID NOT NULL,
    "roleAssignmentId" UUID NOT NULL,
    "decision" "TerminationGrantDecisionKind" NOT NULL,
    "status" "TerminationGrantDecisionStatus" NOT NULL,
    "reason" TEXT,
    "keepUntil" TIMESTAMPTZ(6),
    "requestedByUserId" UUID,
    "requestedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedByUserId" UUID,
    "reviewedAt" TIMESTAMPTZ(6),
    "reviewNote" TEXT,
    "appliedAt" TIMESTAMPTZ(6),
    "outcome" "TerminationGrantOutcome",
    "retainedRoleAssignmentId" UUID,
    "expiryHandledAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "EmployeeTerminationGrantDecision_pkey" PRIMARY KEY ("id"),
    -- A KEEP carries a non-blank reason and an expiry; a REVOKE carries neither.
    CONSTRAINT "EmployeeTerminationGrantDecision_keep_fields_check" CHECK (
        ("decision" = 'KEEP' AND "reason" IS NOT NULL AND length(btrim("reason")) > 0 AND "keepUntil" IS NOT NULL)
        OR ("decision" = 'REVOKE' AND "keepUntil" IS NULL)
    ),
    -- Statuses by kind: a KEEP is requested and reviewed; a REVOKE is decided (or cancelled).
    CONSTRAINT "EmployeeTerminationGrantDecision_status_check" CHECK (
        ("decision" = 'KEEP' AND "status" IN ('REQUESTED', 'APPROVED', 'REJECTED', 'CANCELLED'))
        OR ("decision" = 'REVOKE' AND "status" IN ('DECIDED', 'CANCELLED'))
    ),
    -- Approval and rejection are someone else's: never the requester's own.
    CONSTRAINT "EmployeeTerminationGrantDecision_review_check" CHECK (
        "status" NOT IN ('APPROVED', 'REJECTED')
        OR ("reviewedByUserId" IS NOT NULL AND "reviewedAt" IS NOT NULL
            AND "requestedByUserId" IS NOT NULL AND "reviewedByUserId" <> "requestedByUserId")
    ),
    -- Only an approved KEEP is ever retained, and only through a replacement grant.
    CONSTRAINT "EmployeeTerminationGrantDecision_retained_check" CHECK (
        ("outcome" = 'RETAINED') = ("retainedRoleAssignmentId" IS NOT NULL)
        AND ("outcome" IS DISTINCT FROM 'RETAINED' OR ("decision" = 'KEEP' AND "status" = 'APPROVED'))
    ),
    CONSTRAINT "EmployeeTerminationGrantDecision_applied_check" CHECK (
        ("outcome" IS NULL) = ("appliedAt" IS NULL)
    )
);

CREATE UNIQUE INDEX "EmployeeTerminationGrantDecision_terminationId_roleAssignme_key"
    ON "EmployeeTerminationGrantDecision"("terminationId", "roleAssignmentId");
CREATE INDEX "EmployeeTerminationGrantDecision_roleAssignmentId_idx"
    ON "EmployeeTerminationGrantDecision"("roleAssignmentId");
CREATE INDEX "EmployeeTerminationGrantDecision_outcome_expiryHandledAt_idx"
    ON "EmployeeTerminationGrantDecision"("outcome", "expiryHandledAt");

ALTER TABLE "EmployeeTerminationGrantDecision" ADD CONSTRAINT "EmployeeTerminationGrantDecision_terminationId_fkey" FOREIGN KEY ("terminationId") REFERENCES "EmployeeTermination"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EmployeeTerminationGrantDecision" ADD CONSTRAINT "EmployeeTerminationGrantDecision_roleAssignmentId_fkey" FOREIGN KEY ("roleAssignmentId") REFERENCES "RoleAssignment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EmployeeTerminationGrantDecision" ADD CONSTRAINT "EmployeeTerminationGrantDecision_retainedRoleAssignmentId_fkey" FOREIGN KEY ("retainedRoleAssignmentId") REFERENCES "RoleAssignment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EmployeeTerminationGrantDecision" ADD CONSTRAINT "EmployeeTerminationGrantDecision_requestedByUserId_fkey" FOREIGN KEY ("requestedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EmployeeTerminationGrantDecision" ADD CONSTRAINT "EmployeeTerminationGrantDecision_reviewedByUserId_fkey" FOREIGN KEY ("reviewedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
