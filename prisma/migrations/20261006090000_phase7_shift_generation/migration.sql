-- Generation provenance for PATTERN shifts. A generated ScheduledShift is still the concrete
-- operational record; these columns only say which pattern occurrence it materializes.
ALTER TABLE "ScheduledShift"
  ADD COLUMN "sourcePatternId" UUID,
  ADD COLUMN "sourcePatternRuleId" UUID,
  ADD COLUMN "sourceOccurrenceKey" TEXT,
  ADD COLUMN "generatedAt" TIMESTAMPTZ(6);

-- PATTERN shifts always carry full provenance (kept after publication and correction);
-- MANUAL shifts never do. The occurrence key is "v1:<patternId>:<ruleId>:<local date>" and must
-- name the same pattern and rule as the provenance columns.
ALTER TABLE "ScheduledShift"
  ADD CONSTRAINT "ScheduledShift_generation_provenance_check" CHECK (
    (
      "sourceType" = 'PATTERN' AND
      "sourcePatternId" IS NOT NULL AND
      "sourcePatternRuleId" IS NOT NULL AND
      "sourceOccurrenceKey" IS NOT NULL AND
      "generatedAt" IS NOT NULL AND
      "sourceOccurrenceKey" LIKE 'v1:' || "sourcePatternId"::text || ':' || "sourcePatternRuleId"::text || ':%' AND
      "sourceOccurrenceKey" ~ '^v1:[0-9a-f-]{36}:[0-9a-f-]{36}:[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    ) OR (
      "sourceType" = 'MANUAL' AND
      "sourcePatternId" IS NULL AND
      "sourcePatternRuleId" IS NULL AND
      "sourceOccurrenceKey" IS NULL AND
      "generatedAt" IS NULL
    )
  );

-- One concrete shift per recurrence occurrence, ever: idempotent generation is enforced here,
-- not by find-then-insert. MANUAL shifts have no key and are unaffected.
CREATE UNIQUE INDEX "ScheduledShift_sourceOccurrenceKey_key"
  ON "ScheduledShift"("sourceOccurrenceKey");
CREATE INDEX "ScheduledShift_sourcePatternId_workDate_idx"
  ON "ScheduledShift"("sourcePatternId", "workDate");
CREATE INDEX "ScheduledShift_sourcePatternRuleId_idx"
  ON "ScheduledShift"("sourcePatternRuleId");

-- RESTRICT: provenance is never silently lost. Removing a pattern or rule first removes its
-- untouched generated drafts; published or otherwise protected shifts block the removal.
ALTER TABLE "ScheduledShift"
  ADD CONSTRAINT "ScheduledShift_sourcePatternId_fkey"
  FOREIGN KEY ("sourcePatternId") REFERENCES "EmployeeSchedulePattern"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ScheduledShift"
  ADD CONSTRAINT "ScheduledShift_sourcePatternRuleId_fkey"
  FOREIGN KEY ("sourcePatternRuleId") REFERENCES "EmployeeSchedulePatternRule"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
