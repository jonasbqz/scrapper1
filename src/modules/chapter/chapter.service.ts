import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { eq, desc, sql, and, gt, lt, gte } from 'drizzle-orm';
import { DATABASE_CONNECTION } from '@/database/database.module';
import { chapters } from '@/database/schema';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '@/database/schema';
import { CacheService, CACHE_TTL, CACHE_KEYS } from '@/cache/cache.service';
import { RouteProtectionService } from '@/modules/route-protection/route-protection.service';

@Injectable()
export class ChapterService {
  constructor(
    @Inject(DATABASE_CONNECTION)
    private db: NodePgDatabase<typeof schema>,
    private cacheService: CacheService,
    private routeProtectionService: RouteProtectionService,
  ) {}

  private matchesComicSegment(
    comicSegment: string,
    comic: { id: number; slug: string },
  ): boolean {
    if (/^\d+$/.test(comicSegment)) {
      return Number(comicSegment) === comic.id;
    }

    const parsedComic = this.routeProtectionService.parseComicSegment(comicSegment);
    return parsedComic.slug === comic.slug;
  }

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

        const prevChapter = await this.db.query.chapters.findFirst({
          where: and(
            eq(chapters.comicScanId, chapter.comicScanId),
            lt(chapters.chapterNumber, chapter.chapterNumber),
          ),
          orderBy: [desc(chapters.chapterNumber)],
        });

        const nextChapter = await this.db.query.chapters.findFirst({
          where: and(
            eq(chapters.comicScanId, chapter.comicScanId),
            gt(chapters.chapterNumber, chapter.chapterNumber),
          ),
          orderBy: [chapters.chapterNumber],
        });

        return {
          current: chapter,
          prev: prevChapter || null,
          next: nextChapter || null,
        };
      },
      CACHE_TTL.LONG, // 2 hours
    );
  }

  async findPublicByRouteSegments(comicSegment: string, chapterSegment: string) {
    const parsedChapter = this.routeProtectionService.parseChapterSegment(chapterSegment);

    if (!parsedChapter.chapterId) {
      throw new NotFoundException('Chapter not found');
    }

    const navigation = await this.getNavigation(parsedChapter.chapterId);
    const comic = navigation.current.comicScan?.comic;

    if (!comic?.id) {
      throw this.routeProtectionService.createUnavailableException();
    }

    if (!this.matchesComicSegment(comicSegment, comic)) {
      throw this.routeProtectionService.createUnavailableException();
    }

    if (comic.protectedRouteEnabled) {
      if (!parsedChapter.hasCode || !parsedChapter.code) {
        throw this.routeProtectionService.createUnavailableException();
      }

      const currentCode = await this.routeProtectionService.getChapterCode(navigation.current.id);
      if (parsedChapter.code !== currentCode) {
        throw this.routeProtectionService.createUnavailableException();
      }
    } else if (parsedChapter.hasCode) {
      throw new NotFoundException('Chapter not found');
    }

    return {
      comic,
      navigation,
    };
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

  /**
   * Fetches `count` consecutive chapters (including the starting chapter)
   * ordered by chapterNumber ASC in a single query.
   * Allowed counts: 5 | 10 | 25 | 50
   */
  async getNextChaptersPages(startId: number, count: number) {
    const cacheKey = `chapter_next_pages:${startId}:${count}`;

    return this.cacheService.wrap(
      cacheKey,
      async () => {
        // 1. Find the starting chapter to get comicScanId & chapterNumber
        const start = await this.db.query.chapters.findFirst({
          where: eq(chapters.id, startId),
          columns: { id: true, comicScanId: true, chapterNumber: true },
        });

        if (!start) {
          throw new NotFoundException('Chapter not found');
        }

        // 2. Single query: all chapters in the same scan from start onward
        const rows = await this.db.query.chapters.findMany({
          where: and(
            eq(chapters.comicScanId, start.comicScanId),
            gte(chapters.chapterNumber, start.chapterNumber),
          ),
          orderBy: [chapters.chapterNumber],
          limit: count,
          columns: {
            id: true,
            chapterNumber: true,
            title: true,
            urlPages: true,
            copyrighted: true,
            slug: true,
          },
        });

        // 3. Map results with prev/next ids derived from array positions
        return rows.map((chapter, index) => ({
          id: chapter.id,
          chapter_number: String(chapter.chapterNumber),
          title: chapter.title,
          url_pages: chapter.copyrighted ? [] : (chapter.urlPages || []),
          copyrighted: chapter.copyrighted,
          pathname: chapter.slug || '',
          prev_chapter_id: index > 0 ? rows[index - 1].id : null,
          next_chapter_id: index < rows.length - 1 ? rows[index + 1].id : null,
        }));
      },
      CACHE_TTL.LONG, // 2 hours
    );
  }
}
