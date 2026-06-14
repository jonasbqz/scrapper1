import { Pool } from 'pg';
import { ensureRuntimeSchema } from '../src/database/ensure-runtime-schema';
import { ensureTrafficSchema } from '../src/database/ensure-traffic-schema';

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required');
  }

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await ensureRuntimeSchema(pool);
    await ensureTrafficSchema(pool);
    console.log('[db:fix-schema] schema ok');
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error('[db:fix-schema] failed:', error);
  process.exit(1);
});
