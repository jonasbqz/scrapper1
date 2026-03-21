DO $$
BEGIN
  CREATE TYPE "public"."premium_cycle" AS ENUM('1m', '3m', '6m');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN IF NOT EXISTS "premium_cycle" "premium_cycle";
--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN IF NOT EXISTS "premium_started_at" timestamp;
