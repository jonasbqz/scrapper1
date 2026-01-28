import { Injectable, Inject } from '@nestjs/common';
import { eq, and, desc, count, sql } from 'drizzle-orm';
import { DATABASE_CONNECTION } from '@/database/database.module';
import { likes, comics } from '@/database/schema';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '@/database/schema';

@Injectable()
export class LikesService {
  constructor(
    @Inject(DATABASE_CONNECTION)
    private db: NodePgDatabase<typeof schema>,
  ) {}

  async toggle(profileId: string, comicId: number): Promise<{ liked: boolean; likesCount: number }> {
    const existing = await this.db.query.likes.findFirst({
      where: and(
        eq(likes.profileId, profileId),
        eq(likes.comicId, comicId),
      ),
    });

    if (existing) {
      // Remove like
      await this.db.delete(likes).where(eq(likes.id, existing.id));

      // Decrement likes count in comics table
      await this.db
        .update(comics)
        .set({ likes: sql`${comics.likes} - 1` })
        .where(eq(comics.id, comicId));

      const likesCount = await this.getComicLikesCount(comicId);
      return { liked: false, likesCount };
    }

    // Add like
    await this.db.insert(likes).values({
      profileId,
      comicId,
    });

    // Increment likes count in comics table
    await this.db
      .update(comics)
      .set({ likes: sql`${comics.likes} + 1` })
      .where(eq(comics.id, comicId));

    const likesCount = await this.getComicLikesCount(comicId);
    return { liked: true, likesCount };
  }

  async checkLike(profileId: string, comicId: number): Promise<boolean> {
    const existing = await this.db.query.likes.findFirst({
      where: and(
        eq(likes.profileId, profileId),
        eq(likes.comicId, comicId),
      ),
    });
    return !!existing;
  }

  async getComicLikesCount(comicId: number): Promise<number> {
    const result = await this.db
      .select({ count: count() })
      .from(likes)
      .where(eq(likes.comicId, comicId));
    return result[0]?.count ?? 0;
  }

  async getUserLikes(profileId: string) {
    return this.db.query.likes.findMany({
      where: eq(likes.profileId, profileId),
      orderBy: [desc(likes.createdAt)],
      with: {
        comic: true,
      },
    });
  }

  async getUserLikesCount(profileId: string): Promise<number> {
    const result = await this.db
      .select({ count: count() })
      .from(likes)
      .where(eq(likes.profileId, profileId));
    return result[0]?.count ?? 0;
  }
}
