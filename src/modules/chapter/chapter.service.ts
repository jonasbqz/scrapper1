import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { eq, desc, sql, and, gt, lt } from 'drizzle-orm';
import { DATABASE_CONNECTION } from '@/database/database.module';
import { chapters, comicScans } from '@/database/schema';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '@/database/schema';
import { CacheService, CACHE_TTL, CACHE_KEYS } from '@/cache/cache.service';

@Injectable()
export class ChapterService {
  constructor(
    @Inject(DATABASE_CONNECTION)
    private db: NodePgDatabase<typeof schema>,
    private cacheService: CacheService,
  ) {}

  async findByComicScan(comicScanId: number) {
    const cacheKey = `${CACHE_KEYS.CHAPTERS_BY_COMIC_SCAN}:${comicScanId}`;

    return this.cacheService.wrap(
      cacheKey,
      () =>
        this.db.query.chapters.findMany({
          where: eq(chapters.comicScanId, comicScanId),
          orderBy: [desc(chapters.chapterNumber)],
        }),
      CACHE_TTL.LONG, // 2 hours
    );
  }

  async findById(id: number) {
    const cacheKey = `${CACHE_KEYS.CHAPTER_DETAIL}:${id}`;

    return this.cacheService.wrap(
      cacheKey,
      async () => {
        const chapter = await this.db.query.chapters.findFirst({
          where: eq(chapters.id, id),
          with: {
            comicScan: {
              with: {
                comic: true,
                scanGroup: true,
              },
            },
          },
        });

        if (!chapter) {
          throw new NotFoundException('Chapter not found');
        }

        return chapter;
      },
      CACHE_TTL.LONG, // 2 hours
    );
  }

  async getNavigation(chapterId: number) {
    const cacheKey = `${CACHE_KEYS.CHAPTER_NAVIGATION}:${chapterId}`;

    return this.cacheService.wrap(
      cacheKey,
      async () => {
        const chapter = await this.findById(chapterId);

        const [prevChapter, nextChapter] = await Promise.all([
          this.db.query.chapters.findFirst({
            where: and(
              eq(chapters.comicScanId, chapter.comicScanId),
              lt(chapters.chapterNumber, chapter.chapterNumber),
            ),
            orderBy: [desc(chapters.chapterNumber)],
          }),
          this.db.query.chapters.findFirst({
            where: and(
              eq(chapters.comicScanId, chapter.comicScanId),
              gt(chapters.chapterNumber, chapter.chapterNumber),
            ),
            orderBy: [chapters.chapterNumber],
          }),
        ]);

        return {
          current: chapter,
          prev: prevChapter || null,
          next: nextChapter || null,
        };
      },
      CACHE_TTL.LONG, // 2 hours
    );
  }

  async incrementViews(id: number) {
    await this.db
      .update(chapters)
      .set({ views: sql`${chapters.views} + 1` })
      .where(eq(chapters.id, id));
    // Views don't need immediate cache invalidation
  }

  async getPages(id: number) {
    const cacheKey = `${CACHE_KEYS.CHAPTER_PAGES}:${id}`;

    return this.cacheService.wrap(
      cacheKey,
      async () => {
        const chapter = await this.db.query.chapters.findFirst({
          where: eq(chapters.id, id),
          columns: {
            id: true,
            urlPages: true,
            copyrighted: true,
            chapterNumber: true,
          },
        });
        return chapter;
      },
      CACHE_TTL.STATIC, // 24 hours - pages rarely change
    );
  }
}
