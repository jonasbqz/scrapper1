export const env = {
  port: Number(process.env.PORT) || 8085,
  nodeEnv: process.env.NODE_ENV || 'development',
  databaseUrl: process.env.DATABASE_URL!,
  jwtJwksUrl: process.env.JWT_JWKS_URL!,
  emailVerificationRequiredFrom:
    process.env.EMAIL_VERIFICATION_REQUIRED_FROM || '2026-04-04T00:00:00Z',
  scraperConcurrentLimit: Number(process.env.SCRAPER_CONCURRENT_LIMIT) || 1,
  scraperDelayMs: Number(process.env.SCRAPER_DELAY_MS) || 2000,
  redisUrl: process.env.REDIS_URL,
} as const;
