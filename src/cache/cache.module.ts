import { Global, Module } from '@nestjs/common';
import { CacheModule } from '@nestjs/cache-manager';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { redisStore } from 'cache-manager-ioredis-yet';
import { CacheService } from './cache.service';

function parseRedisUrl(url: string) {
  // Parse redis://user:password@host:port format
  const match = url.match(/redis:\/\/(?:([^:]+):([^@]+)@)?([^:]+):(\d+)/);
  if (!match) {
    throw new Error('Invalid Redis URL format');
  }
  return {
    host: match[3],
    port: parseInt(match[4], 10),
    password: match[2] || undefined,
    username: match[1] !== 'default' ? match[1] : undefined,
  };
}

@Global()
@Module({
  imports: [
    CacheModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: async (configService: ConfigService) => {
        const redisUrl = configService.get<string>('REDIS_URL');

        if (!redisUrl) {
          console.warn('REDIS_URL not configured, using in-memory cache');
          return {
            ttl: 60 * 1000, // 1 minute default TTL
          };
        }

        console.log('Connecting to Redis...');

        const redisConfig = parseRedisUrl(redisUrl);

        return {
          store: await redisStore({
            host: redisConfig.host,
            port: redisConfig.port,
            password: redisConfig.password,
            ttl: 60, // default TTL in seconds for ioredis
          }),
        };
      },
    }),
  ],
  providers: [CacheService],
  exports: [CacheModule, CacheService],
})
export class RedisCacheModule {}
