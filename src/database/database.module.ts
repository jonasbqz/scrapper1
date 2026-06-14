import { Module, Global } from '@nestjs/common';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema';
import { getSharedPool } from '@/lib/db-pool';
import { ensureRuntimeSchema } from './ensure-runtime-schema';
import { ensureTrafficSchema } from './ensure-traffic-schema';

export const DATABASE_CONNECTION = 'DATABASE_CONNECTION';

@Global()
@Module({
  providers: [
    {
      provide: DATABASE_CONNECTION,
      useFactory: async () => {
        const pool = getSharedPool();
        await ensureRuntimeSchema(pool);
        await ensureTrafficSchema(pool);
        return drizzle(pool, { schema });
      },
    },
  ],
  exports: [DATABASE_CONNECTION],
})
export class DatabaseModule {}
