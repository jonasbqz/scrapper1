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
      const profile = await this.db.query.profiles.findFirst({
        where: eq(profiles.userId, session.user.id),
      });

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
