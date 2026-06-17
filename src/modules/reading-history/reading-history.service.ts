import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { eq, and, desc, sql } from 'drizzle-orm';
import { DATABASE_CONNECTION } from '@/database/database.module';
import { readingHistory } from '@/database/schema';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '@/database/schema';
import { mapWithConcurrency } from '@/lib/async';
import { READING_HISTORY_RELATIONS } from '@/lib/list-relations';
import { CacheService, CACHE_KEYS } from '@/cache/cache.service';
import { RecordReadingDto } from './reading-history.dto';

@Injectable()
export class ReadingHistoryService {
  constructor(
    @Inject(DATABASE_CONNECTION)
    private db: NodePgDatabase<typeof schema>,
    private cacheService: CacheService,
  ) {}

  async record(profileId: string, dto: RecordReadingDto) {
    const progressPercentage = dto.progressPercentage ?? 0;
    const now = new Date();

    const [entry] = await this.db
      .insert(readingHistory)
      .values({
        profileId,
        comicId: dto.comicId,
        chapterId: dto.chapterId,
        progressPercentage,
        readAt: now,
      })
      .onConflictDoUpdate({
        target: [
          readingHistory.profileId,
          readingHistory.comicId,
          readingHistory.chapterId,
        ],
        set: {
          progressPercentage: sql`CASE
            WHEN ${readingHistory.progressPercentage} IS NULL THEN excluded.progress_percentage
            WHEN excluded.progress_percentage > ${readingHistory.progressPercentage} THEN excluded.progress_percentage
            ELSE ${readingHistory.progressPercentage}
          END`,
          readAt: now,
          updatedAt: now,
        },
      })
      .returning();

    // Reading any chapter can move `lastRead` for that comic, which changes
    // the notifications feed. `CacheService.del` swallows errors internally,
    // so a flaky cache will not block the 201 response.
    await this.cacheService.del(`${CACHE_KEYS.NOTIFICATIONS_UPDATES}:${profileId}`);

    return entry;
  }

  async findAll(profileId: string, limit = 50, offset = 0) {
    const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 50) : 50;
    const safeOffset = Number.isFinite(offset) ? Math.max(offset, 0) : 0;

    return this.db.query.readingHistory.findMany({
      where: eq(readingHistory.profileId, profileId),
      orderBy: [desc(readingHistory.readAt)],
      limit: safeLimit,
      offset: safeOffset,
      with: READING_HISTORY_RELATIONS,
    });
  }

  async findRecent(profileId: string, limit = 10, offset = 0) {
    const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 50) : 10;
    const safeOffset = Number.isFinite(offset) ? Math.max(offset, 0) : 0;

    return this.db.query.readingHistory.findMany({
      where: eq(readingHistory.profileId, profileId),
      orderBy: [desc(readingHistory.readAt)],
      limit: safeLimit,
      offset: safeOffset,
      with: READING_HISTORY_RELATIONS,
    });
  }

  async findGroupedByComic(
    profileId: string,
    limit = 20,
    offset = 0,
    chaptersLimit = 4,
  ) {
    const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 50) : 20;
    const safeOffset = Number.isFinite(offset) ? Math.max(offset, 0) : 0;
    const safeChaptersLimit = Number.isFinite(chaptersLimit)
      ? Math.min(Math.max(chaptersLimit, 1), 4)
      : 4;
    const lastReadAt = sql<Date>`max(${readingHistory.readAt})`;

    const groupedComics = await this.db
      .select({
        comicId: readingHistory.comicId,
        lastReadAt,
      })
      .from(readingHistory)
      .where(eq(readingHistory.profileId, profileId))
      .groupBy(readingHistory.comicId)
      .orderBy(desc(lastReadAt))
      .limit(safeLimit + 1)
      .offset(safeOffset);

    const pageComics = groupedComics.slice(0, safeLimit);
    const comicIds = pageComics.map((c) => c.comicId);

    const allEntries =
      comicIds.length > 0
        ? (
            await mapWithConcurrency(comicIds, 4, (comicId) =>
              this.db.query.readingHistory.findMany({
                where: and(
                  eq(readingHistory.profileId, profileId),
                  eq(readingHistory.comicId, comicId),
                ),
                orderBy: [desc(readingHistory.readAt)],
                limit: safeChaptersLimit,
                with: READING_HISTORY_RELATIONS,
              }),
            )
          ).flat()
        : [];

    const entriesByComic = new Map<number, typeof allEntries>();
    for (const entry of allEntries) {
      const list = entriesByComic.get(entry.comicId) || [];
      list.push(entry);
      entriesByComic.set(entry.comicId, list);
    }

    const items = pageComics.map((comicHistory) => ({
      comicId: comicHistory.comicId,
      lastReadAt: comicHistory.lastReadAt,
      entries: entriesByComic.get(comicHistory.comicId) || [],
    }));

    return {
      items,
      hasMore: groupedComics.length > safeLimit,
      nextOffset: safeOffset + pageComics.length,
    };
  }

  async findByComic(profileId: string, comicId: number, limit = 20, offset = 0) {
    const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 50) : 20;
    const safeOffset = Number.isFinite(offset) ? Math.max(offset, 0) : 0;

    return this.db.query.readingHistory.findMany({
      where: and(
        eq(readingHistory.profileId, profileId),
        eq(readingHistory.comicId, comicId),
      ),
      orderBy: [desc(readingHistory.readAt)],
      limit: safeLimit,
      offset: safeOffset,
      with: READING_HISTORY_RELATIONS,
    });
  }

  async findLastRead(profileId: string, comicId: number) {
    return this.db.query.readingHistory.findFirst({
      where: and(
        eq(readingHistory.profileId, profileId),
        eq(readingHistory.comicId, comicId),
      ),
      orderBy: [desc(readingHistory.readAt)],
      with: READING_HISTORY_RELATIONS,
    });
  }

  async deleteByComic(profileId: string, comicId: number) {
    const result = await this.db
      .delete(readingHistory)
      .where(
        and(
          eq(readingHistory.profileId, profileId),
          eq(readingHistory.comicId, comicId),
        ),
      )
      .returning({ id: readingHistory.id });

    return { deletedCount: result.length };
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
