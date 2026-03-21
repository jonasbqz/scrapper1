CREATE TYPE "public"."premium_cycle" AS ENUM('1w', '1m', '3m', '6m');--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "premium_cycle" "premium_cycle";--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "premium_started_at" timestamp;