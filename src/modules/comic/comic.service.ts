import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { eq, like, ilike, desc, asc, and, or, sql, inArray } from 'drizzle-orm';
import { DATABASE_CONNECTION } from '@/database/database.module';
import { comics, comicGenres, genres, comicScans, chapters } from '@/database/schema';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '@/database/schema';
import { CacheService, CACHE_TTL, CACHE_KEYS } from '@/cache/cache.service';

/**
 * Normalize a string by removing accents/diacritics
 * This is used for accent-insensitive search
 */
function normalizeString(str: string): string {
  return str
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

export interface ComicFilters {
  search?: string;
  type?: 'manga' | 'manhwa' | 'manhua';
  status?: 'ongoing' | 'completed' | 'hiatus' | 'cancelled';
  genreIds?: number[];
  genreNames?: string[];
  isNsfw?: boolean;
  page?: number;
  limit?: number;
  orderBy?: 'recent_chapter' | 'created_at' | 'views' | 'updated_at';
  isDesc?: boolean;
}

@Injectable()
export class ComicService {
  constructor(
    @Inject(DATABASE_CONNECTION)
    private db: NodePgDatabase<typeof schema>,
    private cacheService: CacheService,
  ) {}

  async findAll(filters: ComicFilters = {}) {
    const cacheKey = this.cacheService.buildComicListKey(filters);
    const ttl = filters.search ? CACHE_TTL.VERY_SHORT : CACHE_TTL.SHORT;

    return this.cacheService.wrap(
      cacheKey,
      () => this.findAllFromDb(filters),
      ttl,
    );
  }

  private async findAllFromDb(filters: ComicFilters = {}) {
    const { search, type, status, genreIds, genreNames, isNsfw, page = 1, limit = 20, orderBy = 'recent_chapter', isDesc = true } = filters;
    const offset = (page - 1) * limit;

    const conditions = [];

    if (search) {
      const normalizedSearch = normalizeString(search);
      const searchPattern = `%${search}%`;
      const normalizedPattern = `%${normalizedSearch}%`;

      conditions.push(
        or(
          ilike(comics.title, searchPattern),
          ilike(comics.titleAlternative, searchPattern),
          sql`LOWER(TRANSLATE(${comics.title}, 'áéíóúàèìòùâêîôûäëïöüñÁÉÍÓÚÀÈÌÒÙÂÊÎÔÛÄËÏÖÜÑ', 'aeiouaeiouaeiouaeiounaeiouaeiouaeiouaeiouna')) LIKE ${normalizedPattern}`,
          sql`LOWER(TRANSLATE(COALESCE(${comics.titleAlternative}, ''), 'áéíóúàèìòùâêîôûäëïöüñÁÉÍÓÚÀÈÌÒÙÂÊÎÔÛÄËÏÖÜÑ', 'aeiouaeiouaeiouaeiounaeiouaeiouaeiouaeiouna')) LIKE ${normalizedPattern}`,
        )!
      );
    }
    if (type) {
      conditions.push(eq(comics.type, type));
    }
    if (status) {
      conditions.push(eq(comics.status, status));
    }
    if (isNsfw !== undefined) {
      conditions.push(eq(comics.isNsfw, isNsfw));
    }

    if (genreNames?.length) {
      const genreRecords = await this.db.query.genres.findMany({
        where: inArray(genres.name, genreNames),
      });
      const genreIdsFromNames = genreRecords.map(g => g.id);
      if (genreIdsFromNames.length > 0) {
        const comicsWithGenres = await this.db
          .select({ comicId: comicGenres.comicId })
          .from(comicGenres)
          .where(inArray(comicGenres.genreId, genreIdsFromNames));
        const comicIds = comicsWithGenres.map(c => c.comicId);
        if (comicIds.length > 0) {
          conditions.push(inArray(comics.id, comicIds));
        } else {
          conditions.push(eq(comics.id, -1));
        }
      }
    } else if (genreIds?.length) {
      const comicsWithGenres = await this.db
        .select({ comicId: comicGenres.comicId })
        .from(comicGenres)
        .where(inArray(comicGenres.genreId, genreIds));
      const comicIds = comicsWithGenres.map(c => c.comicId);
      if (comicIds.length > 0) {
        conditions.push(inArray(comics.id, comicIds));
      }
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    // Step 1: Get ordered comic IDs, count, and genres in parallel
    const getOrderedIds = async (): Promise<number[]> => {
      if (orderBy === 'recent_chapter') {
        const lastChapterSubquery = sql`(
          SELECT MAX(ch.created_at) FROM chapters ch
          INNER JOIN comic_scans cs ON ch.comic_scan_id = cs.id
          WHERE cs.comic_id = ${comics.id}
        )`;

        const result = await this.db
          .select({ id: comics.id })
          .from(comics)
          .where(whereClause)
          .orderBy(isDesc
            ? sql`${lastChapterSubquery} DESC NULLS LAST`
            : sql`${lastChapterSubquery} ASC NULLS LAST`
          )
          .limit(limit)
          .offset(offset);

        return result.map(r => r.id);
      }

      const orderColumn = orderBy === 'views' ? comics.views
        : orderBy === 'created_at' ? comics.createdAt
        : comics.updatedAt;

      const result = await this.db
        .select({ id: comics.id })
        .from(comics)
        .where(whereClause)
        .orderBy(isDesc ? desc(orderColumn) : asc(orderColumn))
        .limit(limit)
        .offset(offset);

      return result.map(r => r.id);
    };

    const [orderedComicIds, countResult, allGenres] = await Promise.all([
      getOrderedIds(),
      this.db.select({ count: sql<number>`count(*)` }).from(comics).where(whereClause),
      this.db.query.genres.findMany({ orderBy: [genres.name] }),
    ]);

    const total = Number(countResult[0]?.count || 0);

    if (orderedComicIds.length === 0) {
      return {
        data: [],
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
        genres: allGenres.map(g => g.name),
      };
    }

    // Step 2: Fetch full comic data with relations
    const results = await this.db.query.comics.findMany({
      where: inArray(comics.id, orderedComicIds),
      with: {
        comicGenres: { with: { genre: true } },
        comicScans: { with: { scanGroup: true } },
      },
    });

    // Preserve ordering from step 1
    const comicMap = new Map(results.map(c => [c.id, c]));
    const orderedResults = orderedComicIds.map(id => comicMap.get(id)).filter(Boolean) as typeof results;

    // Step 3: Get top 2 chapters per comic_scan (window function, only fetches what's needed)
    const comicScanIds = orderedResults.flatMap(comic => comic.comicScans?.map(cs => cs.id) || []);
    const chaptersByScan = new Map<number, any[]>();

    if (comicScanIds.length > 0) {
      const chaptersResult = await this.db.execute(sql`
        SELECT id, comic_scan_id, chapter_number, title, created_at FROM (
          SELECT id, comic_scan_id, chapter_number, title, created_at,
            ROW_NUMBER() OVER (PARTITION BY comic_scan_id ORDER BY created_at DESC) as rn
          FROM chapters
          WHERE comic_scan_id IN (${sql.join(comicScanIds.map(id => sql`${id}`), sql`, `)})
        ) sub
        WHERE rn <= 2
      `);

      for (const ch of chaptersResult.rows as any[]) {
        const scanId = ch.comic_scan_id;
        if (!chaptersByScan.has(scanId)) {
          chaptersByScan.set(scanId, []);
        }
        chaptersByScan.get(scanId)!.push(ch);
      }
    }

    return {
      data: orderedResults.map(comic => {
        const mainScan = comic.comicScans?.find(cs => chaptersByScan.has(cs.id)) || comic.comicScans?.[0];
        const recentChapters = mainScan ? (chaptersByScan.get(mainScan.id) || []) : [];

        return {
          ...comic,
          genres: comic.comicGenres.map((cg: any) => cg.genre),
          scan_group_name: mainScan?.scanGroup?.name || 'Unknown',
          recent_chapters: recentChapters.map((ch: any) => ({
            id: ch.id,
            chapter_number: String(ch.chapter_number),
            title: ch.title || `Capítulo ${ch.chapter_number}`,
            created_at: ch.created_at,
          })),
        };
      }),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      genres: allGenres.map(g => g.name),
    };
  }

  async findById(id: number) {
    const cacheKey = `${CACHE_KEYS.COMIC_DETAIL}:${id}`;

    return this.cacheService.wrap(
      cacheKey,
      async () => {
        const comic = await this.db.query.comics.findFirst({
          where: eq(comics.id, id),
          with: {
            comicGenres: {
              with: { genre: true },
            },
            comicScans: {
              with: {
                scanGroup: true,
                chapters: {
                  orderBy: [desc(chapters.chapterNumber)],
                },
              },
            },
          },
        });

        if (!comic) {
          throw new NotFoundException('Comic not found');
        }

        return {
          ...comic,
          genres: comic.comicGenres.map((cg: any) => cg.genre),
        };
      },
      CACHE_TTL.LONG, // 2 hours
    );
  }

  async findBySlug(slug: string) {
    const cacheKey = `${CACHE_KEYS.COMIC_SLUG}:${slug}`;

    return this.cacheService.wrap(
      cacheKey,
      async () => {
        const comic = await this.db.query.comics.findFirst({
          where: eq(comics.slug, slug),
          with: {
            comicGenres: {
              with: { genre: true },
            },
            comicScans: {
              with: {
                scanGroup: true,
                chapters: {
                  orderBy: [desc(chapters.chapterNumber)],
                },
              },
            },
          },
        });

        if (!comic) {
          throw new NotFoundException('Comic not found');
        }

        return {
          ...comic,
          genres: comic.comicGenres.map((cg: any) => cg.genre),
        };
      },
      CACHE_TTL.LONG, // 2 hours
    );
  }

  async getTrending(limit = 10, isNsfw?: boolean) {
    const nsfwKey = isNsfw === undefined ? 'all' : isNsfw ? 'nsfw' : 'safe';
    const cacheKey = `${CACHE_KEYS.COMIC_TRENDING}:${limit}:${nsfwKey}`;

    return this.cacheService.wrap(
      cacheKey,
      () => {
        const whereClause = isNsfw !== undefined ? eq(comics.isNsfw, isNsfw) : undefined;
        return this.db.query.comics.findMany({
          where: whereClause,
          orderBy: [desc(comics.views)],
          limit,
          with: {
            comicGenres: {
              with: { genre: true },
            },
          },
        });
      },
      CACHE_TTL.LONG, // 2 hours
    );
  }

  async getRecent(limit = 10, isNsfw?: boolean) {
    const nsfwKey = isNsfw === undefined ? 'all' : isNsfw ? 'nsfw' : 'safe';
    const cacheKey = `${CACHE_KEYS.COMIC_RECENT}:${limit}:${nsfwKey}`;

    return this.cacheService.wrap(
      cacheKey,
      () => {
        const whereClause = isNsfw !== undefined ? eq(comics.isNsfw, isNsfw) : undefined;
        return this.db.query.comics.findMany({
          where: whereClause,
          orderBy: [desc(comics.updatedAt)],
          limit,
          with: {
            comicGenres: {
              with: { genre: true },
            },
          },
        });
      },
      CACHE_TTL.MEDIUM, // 30 minutes
    );
  }

  async getRecentWithChapters(limit = 20, isNsfw?: boolean) {
    const nsfwKey = isNsfw === undefined ? 'all' : isNsfw ? 'nsfw' : 'safe';
    const cacheKey = `${CACHE_KEYS.COMIC_RECENT_CHAPTERS}:${limit}:${nsfwKey}`;

    return this.cacheService.wrap(
      cacheKey,
      () => this.getRecentWithChaptersFromDb(limit, isNsfw),
      CACHE_TTL.SHORT, // 10 minutes - frequently updated
    );
  }

  private async getRecentWithChaptersFromDb(limit = 20, isNsfw?: boolean) {
    // Step 1: Get comic_scan_ids ordered by most recent chapter, filtered in SQL
    const nsfwCondition = isNsfw !== undefined
      ? sql` AND c.is_nsfw = ${isNsfw}`
      : sql``;

    const recentScansResult = await this.db.execute(sql`
      SELECT cs.id as comic_scan_id, MAX(ch.created_at) as last_chapter_at
      FROM chapters ch
      INNER JOIN comic_scans cs ON ch.comic_scan_id = cs.id
      INNER JOIN comics c ON cs.comic_id = c.id
      WHERE 1=1 ${nsfwCondition}
      GROUP BY cs.id
      ORDER BY last_chapter_at DESC
      LIMIT ${limit}
    `);

    const sortedScans = recentScansResult.rows as any[];

    if (sortedScans.length === 0) {
      return [];
    }

    const scanIds = sortedScans.map(s => s.comic_scan_id);

    // Step 2: Get comic_scans with their comic and scan_group info
    const comicScansData = await this.db.query.comicScans.findMany({
      where: inArray(comicScans.id, scanIds),
      with: {
        comic: true,
        scanGroup: true,
      },
    });

    const scanDataMap = new Map(comicScansData.map(cs => [cs.id, cs]));

    // Step 3: Get top 2 chapters per comic_scan (window function)
    const chaptersResult = await this.db.execute(sql`
      SELECT id, comic_scan_id, chapter_number, title, created_at FROM (
        SELECT id, comic_scan_id, chapter_number, title, created_at,
          ROW_NUMBER() OVER (PARTITION BY comic_scan_id ORDER BY created_at DESC) as rn
        FROM chapters
        WHERE comic_scan_id IN (${sql.join(scanIds.map(id => sql`${id}`), sql`, `)})
      ) sub
      WHERE rn <= 2
    `);

    const chaptersByScan = new Map<number, any[]>();
    for (const chapter of chaptersResult.rows as any[]) {
      const scanId = chapter.comic_scan_id;
      if (!chaptersByScan.has(scanId)) {
        chaptersByScan.set(scanId, []);
      }
      chaptersByScan.get(scanId)!.push(chapter);
    }

    // Step 4: Build results preserving order
    return sortedScans
      .map(({ comic_scan_id, last_chapter_at }) => {
        const scan = scanDataMap.get(comic_scan_id);
        if (!scan?.comic) return null;

        const chaps = chaptersByScan.get(comic_scan_id) || [];

        return {
          comic_id: scan.comic.id,
          comic_title: scan.comic.title,
          comic_cover: scan.comic.coverImage,
          comic_status: scan.comic.status,
          comic_type: scan.comic.type,
          is_content_nsfw: scan.comic.isNsfw,
          comic_scan_id: scan.id,
          comic_scan_title: scan.comic.title,
          language: scan.language,
          scan_group_id: scan.scanGroup?.id || 0,
          scan_group_name: scan.scanGroup?.name || 'Unknown',
          last_chapter_at: last_chapter_at,
          recent_chapters: chaps.map(ch => ({
            id: ch.id,
            chapter_number: String(ch.chapter_number),
            title: ch.title || `Capítulo ${ch.chapter_number}`,
            created_at: ch.created_at,
          })),
        };
      })
      .filter(Boolean);
  }

  // Adult genre slugs that should be hidden when not in adult mode
  // Note: ecchi and smut are NOT considered adult content
  private readonly ADULT_GENRE_SLUGS = [
    '18',           // +18
    'adulto',       // Adulto
    'maduro',       // Maduro
    'boys-love',    // Boys Love
    'hentai',       // Hentai
    'yaoi',         // Yaoi
    'yuri',         // Yuri
    'erotico',      // Erótico
    'gore',         // Gore (mature content)
    'girls-love',   // Girls Love
  ];

  async getAllGenres(includeAdult = false) {
    const cacheKey = `${CACHE_KEYS.GENRES}:${includeAdult ? 'all' : 'safe'}`;

    return this.cacheService.wrap(
      cacheKey,
      async () => {
        const allGenres = await this.db.query.genres.findMany({
          orderBy: [genres.name],
        });

        if (includeAdult) {
          return allGenres;
        }

        // Filter out adult genres by slug
        return allGenres.filter(g =>
          !this.ADULT_GENRE_SLUGS.includes(g.slug.toLowerCase())
        );
      },
      CACHE_TTL.STATIC, // 24 hours - rarely changes
    );
  }

  async incrementViews(id: number) {
    await this.db
      .update(comics)
      .set({ views: sql`${comics.views} + 1` })
      .where(eq(comics.id, id));

    // Invalidate caches that depend on views
    // Don't invalidate on every view to avoid cache thrashing
    // Views are accumulated, so cache will auto-refresh
  }

  async getComicScanById(comicScanId: number) {
    const comicScan = await this.db.query.comicScans.findFirst({
      where: eq(comicScans.id, comicScanId),
      with: {
        scanGroup: true,
        comic: true,
        chapters: {
          orderBy: [desc(chapters.chapterNumber)],
          columns: {
            id: true,
            comicScanId: true,
            chapterNumber: true,
            title: true,
            slug: true,
            releaseDate: true,
            views: true,
            copyrighted: true,
            createdAt: true,
            updatedAt: true,
            // urlPages excluded - not needed for comic listing
          },
        },
      },
    });

    if (!comicScan) {
      throw new NotFoundException('Comic scan not found');
    }

    return comicScan;
  }

  async getRecommendations(comicId: number, limit = 10, isNsfw?: boolean) {
    const nsfwKey = isNsfw === undefined ? 'all' : isNsfw ? 'nsfw' : 'safe';
    const cacheKey = `${CACHE_KEYS.COMIC_RECOMMENDATIONS}:${comicId}:${limit}:${nsfwKey}`;

    return this.cacheService.wrap(
      cacheKey,
      () => this.getRecommendationsFromDb(comicId, limit, isNsfw),
      CACHE_TTL.LONG, // 2 hours
    );
  }

  private async getRecommendationsFromDb(comicId: number, limit = 10, isNsfw?: boolean) {
    // Get the comic's genres
    const comicGenreRecords = await this.db.query.comicGenres.findMany({
      where: eq(comicGenres.comicId, comicId),
    });

    const genreIds = comicGenreRecords.map(cg => cg.genreId);

    let recommendedComics: any[] = [];

    if (genreIds.length > 0) {
      // Find comics with the same genres, excluding the current comic
      const comicsWithSameGenres = await this.db
        .select({ comicId: comicGenres.comicId })
        .from(comicGenres)
        .where(inArray(comicGenres.genreId, genreIds));

      const comicIds = [...new Set(comicsWithSameGenres.map(c => c.comicId))]
        .filter(id => id !== comicId);

      if (comicIds.length > 0) {
        // Build where clause with NSFW filter
        const conditions = [inArray(comics.id, comicIds)];
        if (isNsfw !== undefined) {
          conditions.push(eq(comics.isNsfw, isNsfw));
        }

        // Get comics ordered by views (popularity within same genres)
        recommendedComics = await this.db.query.comics.findMany({
          where: and(...conditions),
          orderBy: [desc(comics.views)],
          limit,
          with: {
            comicGenres: {
              with: { genre: true },
            },
          },
        });
      }
    }

    // If no recommendations by genre, fallback to popular comics
    if (recommendedComics.length < limit) {
      const existingIds = recommendedComics.map(c => c.id);
      existingIds.push(comicId); // Exclude current comic

      // Build conditions for fallback
      const conditions = [];
      if (existingIds.length > 0) {
        conditions.push(sql`${comics.id} NOT IN (${sql.join(existingIds.map(id => sql`${id}`), sql`, `)})`);
      }
      if (isNsfw !== undefined) {
        conditions.push(eq(comics.isNsfw, isNsfw));
      }

      const popularComics = await this.db.query.comics.findMany({
        where: conditions.length > 0 ? and(...conditions) : undefined,
        orderBy: [desc(comics.views)],
        limit: limit - recommendedComics.length,
        with: {
          comicGenres: {
            with: { genre: true },
          },
        },
      });

      recommendedComics = [...recommendedComics, ...popularComics];
    }

    return recommendedComics.map(comic => ({
      id: comic.id,
      title: comic.title,
      slug: comic.slug,
      coverImage: comic.coverImage,
      type: comic.type,
      status: comic.status,
      views: comic.views,
      isNsfw: comic.isNsfw,
      genres: comic.comicGenres?.map((cg: any) => cg.genre) || [],
    }));
  }

  async getPopular(limit = 10, isNsfw?: boolean) {
    const nsfwKey = isNsfw === undefined ? 'all' : isNsfw ? 'nsfw' : 'safe';
    const cacheKey = `${CACHE_KEYS.COMIC_POPULAR}:${limit}:${nsfwKey}`;

    return this.cacheService.wrap(
      cacheKey,
      async () => {
        const whereClause = isNsfw !== undefined ? eq(comics.isNsfw, isNsfw) : undefined;
        const popularComics = await this.db.query.comics.findMany({
          where: whereClause,
          orderBy: [desc(comics.views)],
          limit,
          with: {
            comicGenres: {
              with: { genre: true },
            },
          },
        });

        return popularComics.map(comic => ({
          id: comic.id,
          title: comic.title,
          slug: comic.slug,
          coverImage: comic.coverImage,
          type: comic.type,
          status: comic.status,
          views: comic.views,
          isNsfw: comic.isNsfw,
          genres: comic.comicGenres?.map((cg: any) => cg.genre) || [],
        }));
      },
      CACHE_TTL.LONG, // 2 hours
    );
  }

  /**
   * Update isNsfw flag for all existing comics based on their genres
   * Returns the number of comics updated
   */
  async syncNsfwFlags(): Promise<{ updated: number; details: Array<{ id: number; title: string; isNsfw: boolean }> }> {
    // Get all adult genre IDs
    const adultGenres = await this.db.query.genres.findMany({
      where: inArray(genres.slug, this.ADULT_GENRE_SLUGS),
    });
    const adultGenreIds = adultGenres.map(g => g.id);

    // Get all comics with their genres
    const allComics = await this.db.query.comics.findMany({
      with: {
        comicGenres: true,
      },
    });

    const updated: Array<{ id: number; title: string; isNsfw: boolean }> = [];

    for (const comic of allComics) {
      // Check if comic has any adult genre
      const hasAdultGenre = comic.comicGenres.some(cg => adultGenreIds.includes(cg.genreId));

      // Only update if the isNsfw flag is different
      if (comic.isNsfw !== hasAdultGenre) {
        await this.db.update(comics).set({
          isNsfw: hasAdultGenre,
        }).where(eq(comics.id, comic.id));

        updated.push({
          id: comic.id,
          title: comic.title,
          isNsfw: hasAdultGenre,
        });
      }
    }

    // Clear all comic-related caches
    await this.cacheService.invalidateComicCache();

    return { updated: updated.length, details: updated };
  }

  /**
   * Clear all comic-related caches manually
   */
  async clearComicCache(): Promise<{ message: string }> {
    await this.cacheService.invalidateComicCache();
    return { message: 'Comic cache cleared successfully' };
  }

  /**
   * Get all comics for sitemap (optimized - only id, slug, updatedAt)
   * Returns paginated results to avoid memory issues
   */
  async getSitemapComics(page = 1, limit = 1000): Promise<{
    comics: Array<{ id: number; slug: string; updatedAt: Date | null }>;
    total: number;
    totalPages: number;
    page: number;
  }> {
    const cacheKey = `sitemap:comics:${page}:${limit}`;

    return this.cacheService.wrap(
      cacheKey,
      async () => {
        const offset = (page - 1) * limit;

        const [results, countResult] = await Promise.all([
          this.db
            .select({
              id: comics.id,
              slug: comics.slug,
              updatedAt: comics.updatedAt,
            })
            .from(comics)
            .orderBy(desc(comics.updatedAt))
            .limit(limit)
            .offset(offset),
          this.db
            .select({ count: sql<number>`count(*)` })
            .from(comics),
        ]);

        const total = Number(countResult[0]?.count || 0);

        return {
          comics: results,
          total,
          totalPages: Math.ceil(total / limit),
          page,
        };
      },
      CACHE_TTL.LONG, // 2 hours
    );
  }

  /**
   * Get all chapters for sitemap (optimized)
   * Returns paginated results grouped by comic
   */
  async getSitemapChapters(page = 1, limit = 5000): Promise<{
    chapters: Array<{
      id: number;
      comicId: number;
      chapterNumber: number;
      updatedAt: Date | null;
    }>;
    total: number;
    totalPages: number;
    page: number;
  }> {
    const cacheKey = `sitemap:chapters:${page}:${limit}`;

    return this.cacheService.wrap(
      cacheKey,
      async () => {
        const offset = (page - 1) * limit;

        // Join chapters with comic_scans to get comic_id
        const [results, countResult] = await Promise.all([
          this.db
            .select({
              id: chapters.id,
              comicId: comicScans.comicId,
              chapterNumber: chapters.chapterNumber,
              updatedAt: chapters.updatedAt,
            })
            .from(chapters)
            .innerJoin(comicScans, eq(chapters.comicScanId, comicScans.id))
            .orderBy(desc(chapters.updatedAt))
            .limit(limit)
            .offset(offset),
          this.db
            .select({ count: sql<number>`count(*)` })
            .from(chapters),
        ]);

        const total = Number(countResult[0]?.count || 0);

        return {
          chapters: results,
          total,
          totalPages: Math.ceil(total / limit),
          page,
        };
      },
      CACHE_TTL.LONG, // 2 hours
    );
  }

  /**
   * Get sitemap stats (total counts)
   */
  async getSitemapStats(): Promise<{
    totalComics: number;
    totalChapters: number;
    comicPages: number;
    chapterPages: number;
  }> {
    const cacheKey = 'sitemap:stats';

    return this.cacheService.wrap(
      cacheKey,
      async () => {
        const [comicCount, chapterCount] = await Promise.all([
          this.db.select({ count: sql<number>`count(*)` }).from(comics),
          this.db.select({ count: sql<number>`count(*)` }).from(chapters),
        ]);

        const totalComics = Number(comicCount[0]?.count || 0);
        const totalChapters = Number(chapterCount[0]?.count || 0);

        return {
          totalComics,
          totalChapters,
          comicPages: Math.ceil(totalComics / 1000),
          chapterPages: Math.ceil(totalChapters / 5000),
        };
      },
      CACHE_TTL.LONG, // 2 hours
    );
  }
}
