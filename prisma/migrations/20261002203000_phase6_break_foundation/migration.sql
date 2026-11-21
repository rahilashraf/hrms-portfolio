CREATE TYPE "BreakPayType" AS ENUM ('PAID', 'UNPAID');

CREATE TABLE "BreakEntry" (
  "id" UUID NOT NULL,
  "timeEntryId" UUID NOT NULL,
  "startAt" TIMESTAMPTZ(6) NOT NULL,
  "endAt" TIMESTAMPTZ(6),
  "payType" "BreakPayType",
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "BreakEntry_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "BreakEntry_time_order_check" CHECK ("endAt" IS NULL OR "endAt" > "startAt")
);

CREATE INDEX "BreakEntry_timeEntryId_startAt_idx"
  ON "BreakEntry"("timeEntryId", "startAt");

CREATE UNIQUE INDEX "BreakEntry_one_open_per_timeEntry_key"
  ON "BreakEntry"("timeEntryId")
  WHERE "endAt" IS NULL;

ALTER TABLE "BreakEntry"
  ADD CONSTRAINT "BreakEntry_timeEntryId_fkey"
  FOREIGN KEY ("timeEntryId") REFERENCES "TimeEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
