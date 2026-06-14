DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'entity_reaction_target') THEN
    CREATE TYPE "entity_reaction_target" AS ENUM ('comic', 'chapter');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'entity_reaction_type') THEN
    CREATE TYPE "entity_reaction_type" AS ENUM ('upvote', 'funny', 'love', 'surprised', 'angry', 'sad');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'media_asset_source') THEN
    CREATE TYPE "media_asset_source" AS ENUM ('uploaded', 'external');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'media_asset_type') THEN
    CREATE TYPE "media_asset_type" AS ENUM ('image', 'gif', 'sticker');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'storage_provider') THEN
    CREATE TYPE "storage_provider" AS ENUM ('s3', 'r2');
  END IF;
END $$;

-- comics/chapters reaction columns are ensured by 0017_ensure_runtime_schema.sql
-- Skipping ALTER on hot tables here avoids deadlocks while the API is serving traffic.

ALTER TABLE "comments"
  ADD COLUMN IF NOT EXISTS "upvotes_count" integer DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "downvotes_count" integer DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "score" integer DEFAULT 0 NOT NULL;

CREATE TABLE IF NOT EXISTS "comment_votes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "comment_id" uuid NOT NULL REFERENCES "comments"("id") ON DELETE cascade,
  "profile_id" uuid NOT NULL REFERENCES "profiles"("id") ON DELETE cascade,
  "value" integer NOT NULL,
  "created_at" timestamp DEFAULT now(),
  "updated_at" timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "entity_reactions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "entity_type" "entity_reaction_target" NOT NULL,
  "entity_id" integer NOT NULL,
  "profile_id" uuid NOT NULL REFERENCES "profiles"("id") ON DELETE cascade,
  "reaction_type" "entity_reaction_type" NOT NULL,
  "created_at" timestamp DEFAULT now(),
  "updated_at" timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "media_assets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "profile_id" uuid NOT NULL REFERENCES "profiles"("id") ON DELETE cascade,
  "source_type" "media_asset_source" NOT NULL,
  "media_type" "media_asset_type" NOT NULL,
  "storage_provider" "storage_provider",
  "storage_key" text,
  "original_url" text,
  "mime_type" varchar(150),
  "width" integer,
  "height" integer,
  "size_bytes" integer,
  "created_at" timestamp DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "comment_attachments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "comment_id" uuid NOT NULL REFERENCES "comments"("id") ON DELETE cascade,
  "media_asset_id" uuid NOT NULL REFERENCES "media_assets"("id") ON DELETE cascade,
  "sort_order" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "comment_votes_comment_profile_idx" ON "comment_votes" ("comment_id", "profile_id");
CREATE INDEX IF NOT EXISTS "comment_votes_profile_idx" ON "comment_votes" ("profile_id");
CREATE INDEX IF NOT EXISTS "comment_votes_comment_idx" ON "comment_votes" ("comment_id");

CREATE UNIQUE INDEX IF NOT EXISTS "entity_reactions_entity_profile_idx" ON "entity_reactions" ("entity_type", "entity_id", "profile_id");
CREATE INDEX IF NOT EXISTS "entity_reactions_entity_idx" ON "entity_reactions" ("entity_type", "entity_id");
CREATE INDEX IF NOT EXISTS "entity_reactions_profile_idx" ON "entity_reactions" ("profile_id");

CREATE INDEX IF NOT EXISTS "media_assets_profile_idx" ON "media_assets" ("profile_id");
CREATE INDEX IF NOT EXISTS "media_assets_source_idx" ON "media_assets" ("source_type");
CREATE UNIQUE INDEX IF NOT EXISTS "media_assets_storage_key_idx" ON "media_assets" ("storage_key");

CREATE UNIQUE INDEX IF NOT EXISTS "comment_attachments_comment_media_idx" ON "comment_attachments" ("comment_id", "media_asset_id");
CREATE INDEX IF NOT EXISTS "comment_attachments_comment_idx" ON "comment_attachments" ("comment_id");
CREATE INDEX IF NOT EXISTS "comment_attachments_media_idx" ON "comment_attachments" ("media_asset_id");

CREATE INDEX IF NOT EXISTS "comments_chapter_score_idx" ON "comments" ("chapter_id", "parent_id", "score");
CREATE INDEX IF NOT EXISTS "comments_comic_score_idx" ON "comments" ("comic_id", "parent_id", "score");
