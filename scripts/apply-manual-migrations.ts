import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';

const MIGRATIONS_DIR = join(process.cwd(), 'src/database/migrations');
const MAX_DEADLOCK_RETRIES = Number(process.env.MIGRATE_DEADLOCK_RETRIES || 8);

const MANUAL_MIGRATIONS = [
  '0001_add_performance_indexes.sql',
  '0003_fulltext_search.sql',
  '0004_subscription_cycles.sql',
  '0005_weekly_subscription_cycle.sql',
  '0006_stripe_subscription_sync.sql',
  '0007_premium_source.sql',
  '0008_protected_routes.sql',
  '0009_refund_requests.sql',
  '0010_comment_media_reactions.sql',
  '0011_media_gallery_visibility.sql',
  '0012_traffic_events.sql',
  '0013_traffic_rollups.sql',
  '0014_traffic_blocked_subjects.sql',
  '0015_traffic_block_ttl.sql',
  '0016_route_protection_codes.sql',
  '0016_traffic_suspicious_query_idx.sql',
  '0017_ensure_runtime_schema.sql',
] as const;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getPgErrorCode(error: unknown): string | undefined {
  return (error as { code?: string })?.code;
}

async function ensureTrackingTable(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS manual_migrations (
      filename text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
  `);
}

async function getAppliedMigrations(pool: Pool): Promise<Set<string>> {
  const result = await pool.query<{ filename: string }>(
    'SELECT filename FROM manual_migrations',
  );
  return new Set(result.rows.map((row) => row.filename));
}

function discoverLooseSqlFiles(): string[] {
  const tracked = new Set<string>(MANUAL_MIGRATIONS);
  return readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith('.sql'))
    .filter((file) => !tracked.has(file))
    .filter((file) => !/^000[0-5]_/.test(file))
    .sort();
}

function isBenignMigrationError(error: unknown): boolean {
  const code = getPgErrorCode(error);
  return (
    code === '42701' ||
    code === '42P07' ||
    code === '42710' ||
    code === '23505'
  );
}

function isRetryableMigrationError(error: unknown): boolean {
  const code = getPgErrorCode(error);
  return code === '40P01' || code === '55P03';
}

async function queryWithRetry(
  pool: Pool,
  sql: string,
  label: string,
): Promise<void> {
  for (let attempt = 1; attempt <= MAX_DEADLOCK_RETRIES; attempt += 1) {
    try {
      await pool.query(sql);
      return;
    } catch (error) {
      if (isBenignMigrationError(error)) {
        console.warn(`[migrate] ${label} already applied in DB`);
        return;
      }

      if (isRetryableMigrationError(error) && attempt < MAX_DEADLOCK_RETRIES) {
        const waitMs = Math.min(2000 * attempt, 15000);
        console.warn(
          `[migrate] ${label} lock contention (attempt ${attempt}/${MAX_DEADLOCK_RETRIES}), retrying in ${waitMs}ms...`,
        );
        await sleep(waitMs);
        continue;
      }

      throw error;
    }
  }
}

async function applyMigration(pool: Pool, filename: string): Promise<void> {
  const filePath = join(MIGRATIONS_DIR, filename);
  const sql = readFileSync(filePath, 'utf8');

  console.log(`[migrate] applying ${filename}`);
  await queryWithRetry(pool, sql, filename);

  await pool.query(
    'INSERT INTO manual_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING',
    [filename],
  );
  console.log(`[migrate] applied ${filename}`);
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required to apply manual migrations');
  }

  console.warn(
    '[migrate] tip: stop monline-api during migrations to avoid deadlocks on busy tables',
  );

  const pool = new Pool({
    connectionString: databaseUrl,
    max: 1,
  });

  try {
    await ensureTrackingTable(pool);
    const applied = await getAppliedMigrations(pool);
    const pending = [
      ...MANUAL_MIGRATIONS.filter((filename) => !applied.has(filename)),
      ...discoverLooseSqlFiles().filter((filename) => !applied.has(filename)),
    ];

    if (pending.length === 0) {
      console.log('[migrate] manual migrations already up to date');
      return;
    }

    for (const filename of pending) {
      await applyMigration(pool, filename);
    }

    console.log(`[migrate] applied ${pending.length} manual migration(s)`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error('[migrate] failed:', error);
  process.exit(1);
});
