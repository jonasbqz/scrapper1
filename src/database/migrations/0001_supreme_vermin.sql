CREATE TABLE IF NOT EXISTS "chapter_likes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"chapter_id" integer NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "chapters" ADD COLUMN IF NOT EXISTS "likes" integer DEFAULT 0;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "chapter_likes" ADD CONSTRAINT "chapter_likes_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "chapter_likes" ADD CONSTRAINT "chapter_likes_chapter_id_chapters_id_fk" FOREIGN KEY ("chapter_id") REFERENCES "public"."chapters"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "chapter_likes_profile_chapter_idx" ON "chapter_likes" USING btree ("profile_id","chapter_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chapter_likes_profile_idx" ON "chapter_likes" USING btree ("profile_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chapter_likes_chapter_idx" ON "chapter_likes" USING btree ("chapter_id");