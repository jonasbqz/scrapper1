import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  Inject,
} from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import { auth } from '@/lib/auth';
import { DATABASE_CONNECTION } from '@/database/database.module';
import { eq } from 'drizzle-orm';
import { profiles } from '@/database/schema';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '@/database/schema';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(DATABASE_CONNECTION)
    private db: NodePgDatabase<typeof schema>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();

    try {
      // Get session from better-auth using headers
      const session = await auth.api.getSession({
        headers: request.headers as any,
      });

      if (!session?.user) {
        throw new UnauthorizedException('Not authenticated');
      }

      // Find profile by userId
      let profile = await this.db.query.profiles.findFirst({
        where: eq(profiles.userId, session.user.id),
      });

      // Auto-create profile if it doesn't exist
      if (!profile) {
        try {
          const baseUsername = (session.user.name || session.user.email?.split('@')[0] || 'user')
            .toLowerCase()
            .replace(/[^a-z0-9]/g, '')
            .substring(0, 20);
          const uniqueSuffix = Date.now().toString(36).substring(-4);
          const username = `${baseUsername}${uniqueSuffix}`;

          // onConflictDoNothing makes this idempotent under concurrent requests
          await this.db.insert(profiles).values({
            userId: session.user.id,
            username,
            visibleName: session.user.name || null,
            avatarUrl: session.user.image || null,
            language: 'es',
          }).onConflictDoNothing();

          // Re-fetch since onConflictDoNothing doesn't return rows on conflict
          profile = await this.db.query.profiles.findFirst({
            where: eq(profiles.userId, session.user.id),
          }) ?? null;

          if (profile) {
            console.log(`Auto-created profile for user ${session.user.id}: ${profile.username}`);
          }
        } catch (err) {
          console.error('Error auto-creating profile:', err);
          // Continue without profile - ProfileGuard will handle the 403
        }
      }

      // Attach user info to request
      (request as any).user = {
        userId: session.user.id,
        email: session.user.email,
        name: session.user.name,
        profileId: profile?.id,
        session: session.session,
      };

      return true;
    } catch (error) {
      if (error instanceof UnauthorizedException) throw error;
      throw new UnauthorizedException('Invalid session');
    }
  }
}
