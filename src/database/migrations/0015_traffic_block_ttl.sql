ALTER TABLE "traffic_blocked_subjects"
  ADD COLUMN IF NOT EXISTS "blocked_until" timestamp;

UPDATE "traffic_blocked_subjects"
SET "blocked_until" = "last_blocked_at" + interval '24 hours'
WHERE "status" = 'active'
  AND "blocked_until" IS NULL;

CREATE INDEX IF NOT EXISTS "traffic_blocked_subjects_active_until_idx"
  ON "traffic_blocked_subjects" ("subject_key", "status", "blocked_until");
