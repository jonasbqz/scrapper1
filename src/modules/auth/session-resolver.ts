import { Injectable, Inject } from '@nestjs/common';
import { auth } from '@/lib/auth';
import { profiles, session as authSession } from '@/database/schema';
import { eq } from 'drizzle-orm';
import { DATABASE_CONNECTION } from '@/database/database.module';
import { isDatabaseConnectionError } from '@/lib/db-pool';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '@/database/schema';

/**
 * Resolved session containing the authenticated user's ID.
 * Returns null when no valid session is found.
 */
export interface ResolvedSession {
  user: { id: string };
}

@Injectable()
export class SessionResolverService {
  constructor(
    @Inject(DATABASE_CONNECTION)
    private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  /**
   * Resolve the current user session from request headers.
   * Tries better-auth cookie session first, then falls back to
   * Bearer token lookup in the session table.
   */
  async resolveSession(
    headers: Record<string, any>,
  ): Promise<ResolvedSession | null> {
    let session = await auth.api
      .getSession({ headers: headers as any })
      .catch(() => null);

    if (!session?.user) {
      const authHeader = headers.authorization;
      if (
        typeof authHeader === 'string' &&
        authHeader.toLowerCase().startsWith('bearer ')
      ) {
        const tokenStr = authHeader.substring(7).trim();
        try {
          const sessionRecord = await this.db.query.session.findFirst({
            where: eq(authSession.token, tokenStr),
          });
          if (sessionRecord?.userId) {
            session = { user: { id: sessionRecord.userId } } as any;
          }
        } catch (error) {
          if (!isDatabaseConnectionError(error)) {
            throw error;
          }
        }
      }
    }

    if (!session?.user?.id) {
      return null;
    }

    return { user: { id: session.user.id } };
  }

  /**
   * Resolve the profile ID for the current user session.
   * Returns null when no session exists or the user has no profile.
   */
  async resolveOptionalProfileId(
    headers: Record<string, any>,
  ): Promise<string | null> {
    const session = await this.resolveSession(headers);
    if (!session) {
      return null;
    }

    const profile = await this.db.query.profiles.findFirst({
      where: eq(profiles.userId, session.user.id),
      columns: { id: true },
    });

    return profile?.id ?? null;
  }
}
