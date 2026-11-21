-- Payroll separation of duties: provenance backfill (idempotent; rehearse on a copy first).
--
-- Run AFTER migration 20271113090000_m2_payroll_separation_of_duties, inside one transaction:
--
--   BEGIN;  \i docs/security/sql/m2-payroll-provenance-backfill.sql  -- review the counts
--   COMMIT;
--
-- It never invents an actor and never touches finalized or voided payroll:
--
-- 1. PayrollRun.calculatedByUserId for CALCULATED / APPROVED runs only (finalized and voided runs
--    are immutable by trigger and keep NULL; their calculator stays in the audit trail), taken
--    from the latest calculation audit entry of the run — and only when that entry is for the
--    run's current calculation (same source fingerprint and calculation version) and names an
--    existing user. Anything unverifiable stays NULL: with dual control on, such a run must be
--    recalculated before approval (CALCULATOR_UNKNOWN_RECALCULATE).
-- 2. CompensationRecordClosure rows (source LEGACY_AUDIT) for closures made before that
--    migration, from the COMPENSATION_CHANGED (previous record shortened) and COMPENSATION_ENDED
--    audit entries. The actor is kept only when it is an existing user (otherwise NULL:
--    unverified). One row per audit entry (auditLogId is unique), so re-running inserts nothing.
--
-- Each statement ends with a line holding only `;` (the rehearsal test splits on it).

-- 1. Calculators of live runs.
UPDATE "PayrollRun" AS r
SET "calculatedByUserId" = latest."actorUserId"
FROM (
  SELECT DISTINCT ON (a."entityId") a."entityId", a."actorUserId", a."metadata"
  FROM "AuditLog" AS a
  WHERE a."entityType" = 'PayrollRun'
    AND a."action" IN ('PAYROLL_RUN_CALCULATED', 'PAYROLL_RUN_RECALCULATED')
  ORDER BY a."entityId", a."occurredAt" DESC, a."id" DESC
) AS latest
WHERE r."id"::text = latest."entityId"
  AND r."status" IN ('CALCULATED', 'APPROVED')
  AND r."calculatedByUserId" IS NULL
  AND latest."actorUserId" IS NOT NULL
  AND latest."metadata" ->> 'sourceFingerprint' = r."sourceFingerprint"
  AND latest."metadata" ->> 'calculationVersion' = r."calculationVersion"
  AND EXISTS (SELECT 1 FROM "User" AS u WHERE u."id" = latest."actorUserId")
;

-- 2a. Closures recorded by compensation changes (the previous record was shortened).
INSERT INTO "CompensationRecordClosure" (
  "id", "compensationRecordId", "employmentAssignmentId", "organizationId",
  "previousEffectiveTo", "newEffectiveTo", "closedByUserId", "source", "auditLogId", "createdAt"
)
SELECT
  gen_random_uuid(), c."id", c."employmentAssignmentId", c."organizationId",
  NULLIF(a."metadata" -> 'previousEffectiveTo' ->> 'before', '')::date,
  (a."metadata" -> 'previousEffectiveTo' ->> 'after')::date,
  (SELECT u."id" FROM "User" AS u WHERE u."id" = a."actorUserId"),
  'LEGACY_AUDIT', a."id", a."occurredAt"
FROM "AuditLog" AS a
JOIN "CompensationRecord" AS c ON c."id"::text = a."metadata" ->> 'previousRecordId'
WHERE a."action" = 'COMPENSATION_CHANGED'
  AND a."metadata" -> 'previousEffectiveTo' ->> 'after' ~ '^\d{4}-\d{2}-\d{2}$'
  AND (
    COALESCE(a."metadata" -> 'previousEffectiveTo' ->> 'before', '') = ''
    OR (a."metadata" -> 'previousEffectiveTo' ->> 'after')::date
      < (a."metadata" -> 'previousEffectiveTo' ->> 'before')::date
  )
ON CONFLICT ("auditLogId") DO NOTHING
;

-- 2b. Closures recorded by ending a record early.
INSERT INTO "CompensationRecordClosure" (
  "id", "compensationRecordId", "employmentAssignmentId", "organizationId",
  "previousEffectiveTo", "newEffectiveTo", "closedByUserId", "source", "auditLogId", "createdAt"
)
SELECT
  gen_random_uuid(), c."id", c."employmentAssignmentId", c."organizationId",
  NULLIF(a."metadata" -> 'effectiveTo' ->> 'before', '')::date,
  (a."metadata" -> 'effectiveTo' ->> 'after')::date,
  (SELECT u."id" FROM "User" AS u WHERE u."id" = a."actorUserId"),
  'LEGACY_AUDIT', a."id", a."occurredAt"
FROM "AuditLog" AS a
JOIN "CompensationRecord" AS c ON c."id"::text = a."entityId"
WHERE a."action" = 'COMPENSATION_ENDED'
  AND a."entityType" = 'CompensationRecord'
  AND a."metadata" -> 'effectiveTo' ->> 'after' ~ '^\d{4}-\d{2}-\d{2}$'
  AND (
    COALESCE(a."metadata" -> 'effectiveTo' ->> 'before', '') = ''
    OR (a."metadata" -> 'effectiveTo' ->> 'after')::date
      < (a."metadata" -> 'effectiveTo' ->> 'before')::date
  )
ON CONFLICT ("auditLogId") DO NOTHING
;

-- Review (read-only): what remains unattributed.
SELECT
  (SELECT count(*) FROM "PayrollRun"
     WHERE "status" IN ('CALCULATED', 'APPROVED') AND "calculatedByUserId" IS NULL)
    AS live_runs_needing_recalculation,
  (SELECT count(*) FROM "CompensationRecordClosure"
     WHERE "source" = 'LEGACY_AUDIT' AND "closedByUserId" IS NULL)
    AS legacy_closures_without_verified_actor
;
