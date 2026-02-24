ALTER TABLE "comics" ADD COLUMN IF NOT EXISTS "is_hentai" boolean DEFAULT false;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "comics_is_hentai_idx" ON "comics" USING btree ("is_hentai");