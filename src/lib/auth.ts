import 'dotenv/config';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { bearer } from 'better-auth/plugins/bearer';
import { APIError } from 'better-call';
import { Pool } from 'pg';
import * as schema from '@/database/schema';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  getAllowedPersonalEmailDomainsLabel,
  isAllowedPersonalEmailDomain,
} from '@/lib/email-policy';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const db = drizzle(pool, { schema });
const authBaseUrl = process.env.BASE_URL || 'http://localhost:8085';
const isLocalAuthBaseUrl =
  authBaseUrl.includes('localhost') || authBaseUrl.includes('127.0.0.1');
const shouldUseSecureCookies =
  process.env.NODE_ENV === 'production' && !isLocalAuthBaseUrl;

export const auth = betterAuth({
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: authBaseUrl,
  database: drizzleAdapter(db, {
    provider: 'pg',
    schema: {
      user: schema.user,
      session: schema.session,
      account: schema.account,
      verification: schema.verification,
    },
  }),
  emailAndPassword: {
    enabled: true,
    autoSignIn: true,
  },
  databaseHooks: {
    user: {
      create: {
        async before(nextUser) {
          const normalizedEmail = nextUser.email.trim().toLowerCase();

          if (!isAllowedPersonalEmailDomain(normalizedEmail)) {
            throw new APIError('BAD_REQUEST', {
              message: `Solo aceptamos correos personales de: ${getAllowedPersonalEmailDomainsLabel()}.`,
            });
          }

          return {
            data: {
              ...nextUser,
              email: normalizedEmail,
            },
          };
        },
      },
    },
  },
  socialProviders: {
    discord: {
      clientId: process.env.DISCORD_CLIENT_ID!,
      clientSecret: process.env.DISCORD_CLIENT_SECRET!,
    },
  },
  session: {
    expiresIn: 60 * 60 * 24 * 30,
    updateAge: 60 * 60 * 24 * 7,
    cookieCache: {
      enabled: true,
      maxAge: 60 * 60,
    },
  },
  trustedOrigins: [
    ...(process.env.CORS_ORIGIN?.split(',') || [
      'http://localhost:3000',
      'https://mangolibreria.com',
    ]),
    'https://mangolibreria.com',
    'https://www.mangolibreria.com',
    'http://mangas-mainmango-3i1hl5:8087',
  ],
  advanced: {
    defaultCookieAttributes: {
      secure: shouldUseSecureCookies,
      httpOnly: true,
      sameSite: shouldUseSecureCookies ? 'none' : 'lax',
    },
  },
  plugins: [bearer()],
});

export type Session = typeof auth.$Infer.Session;
