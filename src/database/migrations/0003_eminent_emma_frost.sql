DO $$ BEGIN
 CREATE TYPE "public"."user_plan" AS ENUM('basic', 'premium');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN IF NOT EXISTS "plan" "user_plan" DEFAULT 'basic';--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN IF NOT EXISTS "premium_expire_at" timestamp;