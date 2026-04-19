import { Module, Global } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';

export const DATABASE_CONNECTION = 'DATABASE_CONNECTION';

@Global()
@Module({
  providers: [
    {
      provide: DATABASE_CONNECTION,
      useFactory: async (configService: ConfigService) => {
        const pool = new Pool({
          connectionString: configService.get<string>('DATABASE_URL'),
          max: Number(configService.get<string>('DB_POOL_MAX') || 20),
          idleTimeoutMillis: Number(
            configService.get<string>('DB_IDLE_TIMEOUT_MS') || 30000,
          ),
          connectionTimeoutMillis: Number(
            configService.get<string>('DB_CONNECTION_TIMEOUT_MS') || 10000,
          ),
        });

        return drizzle(pool, { schema });
      },
      inject: [ConfigService],
    },
  ],
  exports: [DATABASE_CONNECTION],
})
export class DatabaseModule {}
