ALTER TABLE "profiles" ALTER COLUMN "premium_cycle" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."premium_cycle";--> statement-breakpoint
CREATE TYPE "public"."premium_cycle" AS ENUM('1m', '3m', '6m', '1w');--> statement-breakpoint
ALTER TABLE "profiles" ALTER COLUMN "premium_cycle" SET DATA TYPE "public"."premium_cycle" USING "premium_cycle"::"public"."premium_cycle";--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "plan" text DEFAULT 'basic';--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "premium_expire_at" timestamp;--> statement-breakpoint
ALTER TABLE "comics" ADD COLUMN "search_vector" "tsvector";--> statement-breakpoint
CREATE INDEX "comics_search_vector_idx" ON "comics" USING gin ("search_vector" tsvector_ops);--> statement-breakpoint
CREATE INDEX "comics_title_trgm_idx" ON "comics" USING gin ("title" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "comics_title_alt_trgm_idx" ON "comics" USING gin ("title_alternative" gin_trgm_ops);