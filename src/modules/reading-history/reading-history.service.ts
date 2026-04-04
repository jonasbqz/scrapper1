import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { eq, and, desc } from 'drizzle-orm';
import { DATABASE_CONNECTION } from '@/database/database.module';
import { readingHistory } from '@/database/schema';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '@/database/schema';
import { RecordReadingDto } from './reading-history.dto';

@Injectable()
export class ReadingHistoryService {
  constructor(
    @Inject(DATABASE_CONNECTION)
    private db: NodePgDatabase<typeof schema>,
  ) {}

  async record(profileId: string, dto: RecordReadingDto) {
    const existing = await this.db.query.readingHistory.findFirst({
      where: and(
        eq(readingHistory.profileId, profileId),
        eq(readingHistory.comicId, dto.comicId),
        eq(readingHistory.chapterId, dto.chapterId),
      ),
    });

    if (existing) {
      const [updated] = await this.db
        .update(readingHistory)
        .set({
          progressPercentage: dto.progressPercentage ?? existing.progressPercentage,
          readAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(readingHistory.id, existing.id))
        .returning();
      return updated;
    }

    const [entry] = await this.db.insert(readingHistory).values({
      profileId,
      comicId: dto.comicId,
      chapterId: dto.chapterId,
      progressPercentage: dto.progressPercentage || 0,
      readAt: new Date(),
    }).returning();

    return entry;
  }

  async findAll(profileId: string, limit = 50) {
    return this.db.query.readingHistory.findMany({
      where: eq(readingHistory.profileId, profileId),
      orderBy: [desc(readingHistory.readAt)],
      limit,
      with: {
        comic: true,
        chapter: true,
      },
    });
  }

  async findRecent(profileId: string, limit = 10) {
    return this.db.query.readingHistory.findMany({
      where: eq(readingHistory.profileId, profileId),
      orderBy: [desc(readingHistory.readAt)],
      limit,
      with: {
        comic: true,
        chapter: true,
      },
    });
  }

  async findByComic(profileId: string, comicId: number) {
    return this.db.query.readingHistory.findMany({
      where: and(
        eq(readingHistory.profileId, profileId),
        eq(readingHistory.comicId, comicId),
      ),
      orderBy: [desc(readingHistory.readAt)],
      with: {
        comic: true,
        chapter: true,
      },
    });
  }

  async findLastRead(profileId: string, comicId: number) {
    return this.db.query.readingHistory.findFirst({
      where: and(
        eq(readingHistory.profileId, profileId),
        eq(readingHistory.comicId, comicId),
      ),
      orderBy: [desc(readingHistory.readAt)],
      with: {
        comic: true,
        chapter: true,
      },
    });
  }

  async delete(profileId: string, id: string) {
    const existing = await this.db.query.readingHistory.findFirst({
      where: and(
        eq(readingHistory.id, id),
        eq(readingHistory.profileId, profileId),
      ),
    });

    if (!existing) {
      throw new NotFoundException('Reading history entry not found');
    }

    await this.db.delete(readingHistory).where(eq(readingHistory.id, id));
  }
}
