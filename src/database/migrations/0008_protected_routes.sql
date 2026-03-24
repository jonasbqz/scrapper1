ALTER TABLE "comics"
ADD COLUMN IF NOT EXISTS "protected_route_enabled" boolean DEFAULT false;

UPDATE "comics"
SET "protected_route_enabled" = false
WHERE "protected_route_enabled" IS NULL;

ALTER TABLE "comics"
ALTER COLUMN "protected_route_enabled" SET DEFAULT false;

ALTER TABLE "comics"
ALTER COLUMN "protected_route_enabled" SET NOT NULL;
