import type { Pool } from 'pg';

const RUNTIME_SCHEMA_SQL = `
ALTER TABLE "comics"
  ADD COLUMN IF NOT EXISTS "protected_route_enabled" boolean DEFAULT false;

UPDATE "comics"
SET "protected_route_enabled" = false
WHERE "protected_route_enabled" IS NULL;

ALTER TABLE "comics"
  ADD COLUMN IF NOT EXISTS "reactions_total" integer DEFAULT 0;

UPDATE "comics"
SET "reactions_total" = 0
WHERE "reactions_total" IS NULL;

ALTER TABLE "comics"
  ADD COLUMN IF NOT EXISTS "reactions_summary" jsonb DEFAULT '{"upvote":0,"funny":0,"love":0,"surprised":0,"angry":0,"sad":0}'::jsonb;

UPDATE "comics"
SET "reactions_summary" = '{"upvote":0,"funny":0,"love":0,"surprised":0,"angry":0,"sad":0}'::jsonb
WHERE "reactions_summary" IS NULL;

ALTER TABLE "chapters"
  ADD COLUMN IF NOT EXISTS "reactions_total" integer DEFAULT 0;

UPDATE "chapters"
SET "reactions_total" = 0
WHERE "reactions_total" IS NULL;

ALTER TABLE "chapters"
  ADD COLUMN IF NOT EXISTS "reactions_summary" jsonb DEFAULT '{"upvote":0,"funny":0,"love":0,"surprised":0,"angry":0,"sad":0}'::jsonb;

UPDATE "chapters"
SET "reactions_summary" = '{"upvote":0,"funny":0,"love":0,"surprised":0,"angry":0,"sad":0}'::jsonb
WHERE "reactions_summary" IS NULL;

ALTER TABLE "comics"
  ADD COLUMN IF NOT EXISTS "is_hentai" boolean DEFAULT false;

UPDATE "comics"
SET "is_hentai" = false
WHERE "is_hentai" IS NULL;

ALTER TABLE "comics"
  ADD COLUMN IF NOT EXISTS "search_vector" tsvector;

CREATE INDEX IF NOT EXISTS "comics_is_hentai_idx" ON "comics" USING btree ("is_hentai");
CREATE INDEX IF NOT EXISTS "comics_search_vector_idx" ON "comics" USING gin ("search_vector");

-- Full-text search bootstrap: extensions, trigger function and trigger.
-- drizzle migration 0005 only added the column + index; the trigger that
-- populates search_vector lived in a manual-only migration (0003_fulltext_search.sql)
-- that never runs through drizzle. Without this, search_vector is empty for every
-- row and search returns nothing (trgm fallback then explodes if pg_trgm is missing).
CREATE EXTENSION IF NOT EXISTS "unaccent";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

CREATE OR REPLACE FUNCTION comics_search_vector_update() RETURNS trigger AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('simple', unaccent(COALESCE(NEW.title, ''))), 'A') ||
    setweight(to_tsvector('simple', unaccent(COALESCE(NEW.title_alternative, ''))), 'B') ||
    setweight(to_tsvector('simple', unaccent(COALESCE(NEW.author, ''))), 'B') ||
    setweight(to_tsvector('simple', unaccent(COALESCE(NEW.artist, ''))), 'B') ||
    setweight(to_tsvector('simple', unaccent(COALESCE(NEW.description, ''))), 'C');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS comics_search_vector_trigger ON "comics";
CREATE TRIGGER comics_search_vector_trigger
  BEFORE INSERT OR UPDATE OF title, title_alternative, author, artist, description ON "comics"
  FOR EACH ROW EXECUTE FUNCTION comics_search_vector_update();

-- Backfill existing rows so search works immediately after repair.
UPDATE "comics" SET search_vector =
  setweight(to_tsvector('simple', unaccent(COALESCE(title, ''))), 'A') ||
  setweight(to_tsvector('simple', unaccent(COALESCE(title_alternative, ''))), 'B') ||
  setweight(to_tsvector('simple', unaccent(COALESCE(author, ''))), 'B') ||
  setweight(to_tsvector('simple', unaccent(COALESCE(artist, ''))), 'B') ||
  setweight(to_tsvector('simple', unaccent(COALESCE(description, ''))), 'C');

CREATE INDEX IF NOT EXISTS "comics_title_trgm_idx" ON "comics" USING gin ("title" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "comics_title_alt_trgm_idx" ON "comics" USING gin ("title_alternative" gin_trgm_ops);
`;

const REQUIRED_COLUMNS: Array<{ table: string; column: string }> = [
  { table: 'comics', column: 'reactions_total' },
  { table: 'comics', column: 'reactions_summary' },
  { table: 'comics', column: 'protected_route_enabled' },
  { table: 'comics', column: 'is_hentai' },
  { table: 'comics', column: 'search_vector' },
  { table: 'chapters', column: 'reactions_total' },
  { table: 'chapters', column: 'reactions_summary' },
];

async function verifyRequiredColumns(pool: Pool): Promise<string[]> {
  const result = await pool.query<{ table_name: string; column_name: string }>(
    `
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND (table_name, column_name) IN (
          SELECT *
          FROM unnest($1::text[], $2::text[])
        )
    `,
    [
      REQUIRED_COLUMNS.map((item) => item.table),
      REQUIRED_COLUMNS.map((item) => item.column),
    ],
  );

  const present = new Set(
    result.rows.map((row) => `${row.table_name}.${row.column_name}`),
  );

  return REQUIRED_COLUMNS
    .filter((item) => !present.has(`${item.table}.${item.column}`))
    .map((item) => `${item.table}.${item.column}`);
}

async function searchTriggerExists(pool: Pool): Promise<boolean> {
  const result = await pool.query<{ exists: boolean }>(
    `
      SELECT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgname = 'comics_search_vector_trigger'
      ) AS exists
    `,
  );
  return Boolean(result.rows[0]?.exists);
}

export async function ensureRuntimeSchema(pool: Pool): Promise<void> {
  const missingBefore = await verifyRequiredColumns(pool);
  const ftsTriggerMissing = await searchTriggerExists(pool).catch(() => true);

  if (missingBefore.length === 0 && !ftsTriggerMissing) {
    return;
  }

  if (missingBefore.length > 0) {
    console.warn(
      `[db] missing runtime columns: ${missingBefore.join(', ')} — applying repair SQL`,
    );
  }
  if (ftsTriggerMissing) {
    console.warn(
      '[db] comics_search_vector_trigger missing — bootstrapping full-text search',
    );
  }

  await pool.query(RUNTIME_SCHEMA_SQL);

  const missingAfter = await verifyRequiredColumns(pool);
  if (missingAfter.length > 0) {
    throw new Error(
      `Database schema repair incomplete. Still missing: ${missingAfter.join(', ')}`,
    );
  }

  console.log('[db] runtime schema repair completed');
}
