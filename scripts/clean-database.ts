import { Pool } from 'pg';
import { config } from 'dotenv';

config();

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error('DATABASE_URL is required to clean the database');
  process.exit(1);
}

const pool = new Pool({
  connectionString: databaseUrl,
  connectionTimeoutMillis: 10000,
});

async function clean() {
  const client = await pool.connect();
  try {
    console.log('Resetting database to a clean state...');
    
    // Drop the drizzle migrations schema
    await client.query('DROP SCHEMA IF EXISTS drizzle CASCADE');
    console.log('Dropped drizzle schema');

    // Recreate the public schema to drop all tables, enums, and indexes
    await client.query('DROP SCHEMA public CASCADE');
    await client.query('CREATE SCHEMA public');
    await client.query('GRANT ALL ON SCHEMA public TO postgres');
    await client.query('GRANT ALL ON SCHEMA public TO public');
    console.log('Recreated public schema successfully');
    
    console.log('Database is now completely clean!');
  } catch (err: any) {
    console.error('Error cleaning database:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

clean();
