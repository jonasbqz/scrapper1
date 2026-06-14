import { Pool } from 'pg';

let sharedPool: Pool | null = null;

export function isDatabaseConnectionError(error: unknown): boolean {
  const messages = [
    error instanceof Error ? error.message : String(error),
    error instanceof Error && error.cause instanceof Error
      ? error.cause.message
      : '',
  ];

  return messages.some(
    (message) =>
      message.includes('timeout exceeded when trying to connect') ||
      message.includes('Connection terminated unexpectedly') ||
      message.includes('ECONNREFUSED') ||
      message.includes('ENOTFOUND') ||
      message.includes('too many clients already'),
  );
}

export function getSharedPool(): Pool {
  if (!sharedPool) {
    sharedPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: Number(process.env.DB_POOL_MAX || 30),
      min: Number(process.env.DB_POOL_MIN || 2),
      idleTimeoutMillis: Number(process.env.DB_IDLE_TIMEOUT_MS || 30000),
      connectionTimeoutMillis: Number(
        process.env.DB_CONNECTION_TIMEOUT_MS || 5000,
      ),
      allowExitOnIdle: true,
    });

    sharedPool.on('error', (error) => {
      console.error('Database pool idle client error:', error.message);
    });
  }

  return sharedPool;
}
