import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DATABASE_CONNECTION } from '@/database/database.module';
import { account, user } from '@/database/schema';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '@/database/schema';
import { and, eq, inArray, lt } from 'drizzle-orm';
import { isVerificationCleanupEligible } from '@/lib/email-verification-policy';

@Injectable()
export class AuthCleanupService {
  private readonly logger = new Logger(AuthCleanupService.name);

  constructor(
    @Inject(DATABASE_CONNECTION)
    private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async removeExpiredUnverifiedUsers() {
    const expirationThreshold = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const staleUsers = await this.db
      .select({
        id: user.id,
        createdAt: user.createdAt,
        emailVerified: user.emailVerified,
      })
      .from(user)
      .innerJoin(account, eq(account.userId, user.id))
      .where(
        and(
          eq(account.providerId, 'credential'),
          eq(user.emailVerified, false),
          lt(user.createdAt, expirationThreshold),
        ),
      );

    const userIds = Array.from(
      new Set(
        staleUsers
          .filter((entry) =>
            isVerificationCleanupEligible({
              createdAt: entry.createdAt,
              emailVerified: entry.emailVerified,
              hasCredentialAccount: true,
            }),
          )
          .map((entry) => entry.id),
      ),
    );

    if (userIds.length === 0) {
      return;
    }

    await this.db.delete(user).where(inArray(user.id, userIds));
    this.logger.log(
      `Deleted ${userIds.length} unverified account(s) older than 24 hours.`,
    );
  }
}
