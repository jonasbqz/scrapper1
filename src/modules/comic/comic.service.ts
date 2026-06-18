import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { eq, desc, asc, and, sql, inArray } from 'drizzle-orm';
import { DATABASE_CONNECTION } from '@/database/database.module';
import { comics, comicGenres, genres, comicScans, chapters, comicViewsHistory } from '@/database/schema';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '@/database/schema';
import { CacheService, CACHE_TTL, CACHE_KEYS } from '@/cache/cache.service';
import { RouteProtectionService } from '@/modules/route-protection/route-protection.service';
import { mapWithConcurrency } from '@/lib/async';

// Adult genre slugs - used to automatically mark comics as NSFW
// Note: ecchi and smut are NOT considered adult content
export const ADULT_GENRE_SLUGS = [
  '18',           // +18
  'adulto',       // Adulto
  'maduro',       // Maduro
  'boys-love',    // Boys Love
  'girls-love',   // Girls Love
  'hentai',       // Hentai
  'yaoi',         // Yaoi
  'yuri',         // Yuri
  'erotico',      // Erótico
  'gore',         // Gore (mature content)
];

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
    private routeProtectionService: RouteProtectionService,
  ) {}

  private getCurrentDateKey(): string {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  private mapGenresFromComic(comic: any) {
    return comic.comicGenres?.map((cg: any) => cg.genre) || comic.genres || [];
  }

  private async buildComicSummary<T extends { id: number; slug: string; protectedRouteEnabled?: boolean | null }>(
    comic: T,
  ) {
    return {
      ...comic,
      comicPath: await this.routeProtectionService.getComicPath(comic),
    };
  }

  private async buildRecentChapterSummaries<
    T extends { id: number; slug: string; protectedRouteEnabled?: boolean | null },
  >(
    comic: T,
    recentChapters: Array<{ id: number; slug: string; [key: string]: any }>,
    options?: { comicPath?: string },
  ) {
    const comicPath =
      options?.comicPath ?? (await this.routeProtectionService.getComicPath(comic));

    return Promise.all(
      recentChapters.map(async (chapter) => ({
        ...chapter,
        chapterPath: await this.routeProtectionService.getChapterPath(comic, chapter, {
          comicPath,
        }),
      })),
    );
  }

  private async buildComicDetailPayload(comic: any) {
    const comicPath = await this.routeProtectionService.getComicPath(comic);
    const comicScans = await Promise.all(
      (comic.comicScans || []).map(async (comicScan: any) => ({
        ...comicScan,
        chapters: await Promise.all(
          (comicScan.chapters || []).map(async (chapter: any) => ({
            ...chapter,
            chapterPath: await this.routeProtectionService.getChapterPath(comic, chapter, {
              comicPath,
            }),
          })),
        ),
      })),
    );

    return {
      ...comic,
      comicPath,
      comicScans,
      genres: this.mapGenresFromComic(comic),
    };
  }

  async resolveComicRouteSegment(segment: string) {
    const comic = await this.db.query.comics.findFirst({
      where: eq(comics.slug, segment),
    });

    if (!comic) {
      throw new NotFoundException('Comic not found');
    }

    return comic;
  }

  async findPublicByRouteSegment(segment: string) {
    const comic = await this.resolveComicRouteSegment(segment);
    return this.findById(comic.id);
  }

  async findLookupByRouteSegment(segment: string) {
    const comic = await this.resolveComicRouteSegment(segment);

    return {
      id: comic.id,
      slug: comic.slug,
      protectedRouteEnabled: comic.protectedRouteEnabled ?? false,
      comicPath: await this.routeProtectionService.getComicPath(comic),
    };
  }

  async findLookupById(id: number) {
    const comic = await this.db.query.comics.findFirst({
      where: eq(comics.id, id),
      columns: {
        id: true,
        slug: true,
        protectedRouteEnabled: true,
      },
    });

    if (!comic) {
      throw new NotFoundException('Comic not found');
    }

    return {
      id: comic.id,
      slug: comic.slug,
      protectedRouteEnabled: comic.protectedRouteEnabled ?? false,
      comicPath: await this.routeProtectionService.getComicPath(comic),
    };
  }

  async findAll(filters: ComicFilters = {}) {
    const cacheKey = this.cacheService.buildComicListKey(filters);
    const ttl = filters.search ? CACHE_TTL.VERY_SHORT : CACHE_TTL.SHORT;

    return this.cacheService.wrap(
      cacheKey,
      () => this.findAllFromDb(filters),
      ttl,
    );
  }

  async buildEmptySearchResponse(page = 1, limit = 20) {
    const allGenres = await this.db.query.genres.findMany({
      orderBy: [genres.name],
    });

    return {
      data: [],
      pagination: {
        page,
        limit,
        total: 0,
        totalPages: 0,
      },
      genres: allGenres.map((genre) => genre.name),
    };
  }

  private async findAllFromDb(filters: ComicFilters = {}) {
    const { search, type, status, genreIds, genreNames, isNsfw, page = 1, limit = 20, orderBy = 'recent_chapter', isDesc = true } = filters;
    const offset = (page - 1) * limit;

    const conditions = [];

    // Build tsquery for full-text search (used for filtering and ranking)
    // websearch_to_tsquery is resilient to punctuation/quotes/CJK input and won't
    // explode with syntax errors like raw to_tsquery(...) can.
    const normalizedSearch = search?.trim();
    const searchTsquery = normalizedSearch
      ? sql`websearch_to_tsquery('simple', unaccent(${normalizedSearch}))`
      : null;

    if (search && searchTsquery) {
      conditions.push(
        sql`search_vector @@ ${searchTsquery}`,
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

    // Always exclude hentai comics
    conditions.push(eq(comics.isHentai, false));

    if (genreNames?.length) {
      const genreRecords = await this.db.query.genres.findMany({
        where: inArray(genres.name, genreNames),
      });
      const genreIdsFromNames = genreRecords.map(g => g.id);
      if (genreIdsFromNames.length > 0) {
        const comicsWithGenres = await this.db
          .select({ comicId: comicGenres.comicId })
          .from(comicGenres)
          .where(inArray(comicGenres.genreId, genreIdsFromNames))
          .groupBy(comicGenres.comicId)
          .having(sql`count(distinct ${comicGenres.genreId}) >= ${genreIdsFromNames.length}`);
        const comicIds = comicsWithGenres.map(c => c.comicId);
        if (comicIds.length > 0) {
          conditions.push(inArray(comics.id, comicIds));
        } else {
          conditions.push(eq(comics.id, -1));
        }
      } else {
        conditions.push(eq(comics.id, -1));
      }
    } else if (genreIds?.length) {
      const comicsWithGenres = await this.db
        .select({ comicId: comicGenres.comicId })
        .from(comicGenres)
        .where(inArray(comicGenres.genreId, genreIds))
        .groupBy(comicGenres.comicId)
        .having(sql`count(distinct ${comicGenres.genreId}) >= ${genreIds.length}`);
      const comicIds = comicsWithGenres.map(c => c.comicId);
      if (comicIds.length > 0) {
        conditions.push(inArray(comics.id, comicIds));
      } else {
        conditions.push(eq(comics.id, -1));
      }
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    // Step 1: Get ordered comic IDs, count, and genres in parallel
    const getOrderedIds = async (): Promise<number[]> => {
      // When searching, order by relevance (ts_rank) instead of the default
      if (search && searchTsquery) {
        const result = await this.db
          .select({ id: comics.id })
          .from(comics)
          .where(whereClause)
          .orderBy(sql`ts_rank(search_vector, ${searchTsquery}) DESC`)
          .limit(limit)
          .offset(offset);

        return result.map(r => r.id);
      }

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

    let total = Number(countResult[0]?.count || 0);

    // Fallback to pg_trgm similarity when tsquery returns no results
    if (orderedComicIds.length === 0 && normalizedSearch) {
      // Build non-search conditions (type, status, nsfw, genres)
      const baseConditions: (typeof conditions[number])[] = [];
      if (type) baseConditions.push(eq(comics.type, type));
      if (status) baseConditions.push(eq(comics.status, status));
      if (isNsfw !== undefined) baseConditions.push(eq(comics.isNsfw, isNsfw));
      baseConditions.push(eq(comics.isHentai, false));

      const similarityExpr = sql`GREATEST(
        similarity(${comics.title}, unaccent(${search})),
        similarity(COALESCE(${comics.titleAlternative}, ''), unaccent(${search}))
      )`;

      const trgmWhere = and(
        sql`${similarityExpr} > 0.15`,
        ...baseConditions,
      );

      const [trgmResults, trgmCount] = await Promise.all([
        this.db
          .select({ id: comics.id })
          .from(comics)
          .where(trgmWhere)
          .orderBy(sql`${similarityExpr} DESC`)
          .limit(limit)
          .offset(offset),
        this.db.select({ count: sql<number>`count(*)` }).from(comics).where(trgmWhere),
      ]);

      const fallbackIds = trgmResults.map(r => r.id);
      total = Number(trgmCount[0]?.count || 0);

      if (fallbackIds.length === 0) {
        return {
          data: [],
          pagination: { page, limit, total: 0, totalPages: 0 },
          genres: allGenres.map(g => g.name),
        };
      }

      // Use fallback IDs for the rest of the pipeline
      return this.buildComicResponse(fallbackIds, allGenres, page, limit, total);
    }

    if (orderedComicIds.length === 0) {
      return {
        data: [],
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
        genres: allGenres.map(g => g.name),
      };
    }

    return this.buildComicResponse(orderedComicIds, allGenres, page, limit, total);
  }

  private async buildComicResponse(
    orderedComicIds: number[],
    allGenres: { id: number; name: string; slug: string; createdAt: Date | null }[],
    page: number,
    limit: number,
    total: number,
  ) {
    // Fetch full comic data with relations
    const results = await this.db.query.comics.findMany({
      where: inArray(comics.id, orderedComicIds),
      with: {
        comicGenres: { with: { genre: true } },
        comicScans: { with: { scanGroup: true } },
      },
    });

    // Preserve ordering
    const comicMap = new Map(results.map(c => [c.id, c]));
    const orderedResults = orderedComicIds.map(id => comicMap.get(id)).filter(Boolean) as typeof results;

    // Get top 2 chapters per comic_scan (window function)
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

    const data = await Promise.all(
      orderedComicIds.length === 0 ? [] : orderedResults.map(async comic => {
        const mainScan = comic.comicScans?.find(cs => chaptersByScan.has(cs.id)) || comic.comicScans?.[0];
        const recentChapters = mainScan ? (chaptersByScan.get(mainScan.id) || []) : [];

        return {
          ...(await this.buildComicSummary(comic)),
          genres: comic.comicGenres.map((cg: any) => cg.genre),
          scan_group_name: mainScan?.scanGroup?.name || 'Unknown',
          recent_chapters: await this.buildRecentChapterSummaries(comic, recentChapters.map((ch: any) => ({
            id: ch.id,
            slug: ch.slug,
            chapter_number: String(ch.chapter_number),
            title: ch.title || `Capítulo ${ch.chapter_number}`,
            created_at: ch.created_at,
          }))),
        };
      }),
    );

    return {
      data,
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

        return this.buildComicDetailPayload(comic);
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

        return this.buildComicDetailPayload(comic);
      },
      CACHE_TTL.LONG, // 2 hours
    );
  }

  async getTrending(limit = 10, isNsfw?: boolean) {
    const nsfwKey = isNsfw === undefined ? 'all' : isNsfw ? 'nsfw' : 'safe';
    const cacheKey = `${CACHE_KEYS.COMIC_TRENDING}:${limit}:${nsfwKey}`;

    return this.cacheService.wrap(
      cacheKey,
      async () => {
        const conditions = [eq(comics.isHentai, false)];
        if (isNsfw !== undefined) conditions.push(eq(comics.isNsfw, isNsfw));
        const results = await this.db.query.comics.findMany({
          where: and(...conditions),
          orderBy: [desc(comics.views)],
          limit,
          with: {
            comicGenres: {
              with: { genre: true },
            },
          },
        });
        return Promise.all(
          results.map(async (comic) => ({
            ...(await this.buildComicSummary(comic)),
            genres: comic.comicGenres?.map((cg: any) => cg.genre) || [],
          })),
        );
      },
      CACHE_TTL.LONG, // 2 hours
    );
  }

  private async getPopularTodayFallback(limit = 10, isNsfw?: boolean) {
    const conditions = [eq(comics.isHentai, false)];
    if (isNsfw !== undefined) conditions.push(eq(comics.isNsfw, isNsfw));

    return this.db.query.comics.findMany({
      where: and(...conditions),
      orderBy: [desc(comics.views)],
      limit,
      columns: {
        id: true,
        title: true,
        slug: true,
        coverImage: true,
        protectedRouteEnabled: true,
        isNsfw: true,
      },
    });
  }

  async getPopularToday(limit = 10, isNsfw?: boolean) {
    const todayStr = this.getCurrentDateKey();

    const topDaily = await this.db.query.comicViewsHistory.findMany({
      where: eq(comicViewsHistory.date, todayStr),
      orderBy: [desc(comicViewsHistory.views)],
      limit: limit * 3,
      columns: { comicId: true, views: true },
    });

    if (topDaily.length === 0) {
      const fallback = await this.getPopularTodayFallback(limit, isNsfw);
      return Promise.all(
        fallback.map(async (comic) => ({
          ...(await this.buildComicSummary(comic)),
          title: comic.title,
          coverImage: comic.coverImage,
          viewsToday: 0,
          isNsfw: comic.isNsfw,
        })),
      );
    }

    const topIds = topDaily.map((daily) => daily.comicId);
    const dailyViewsMap = new Map(
      topDaily.map((daily) => [daily.comicId, daily.views]),
    );

    const conditions = [eq(comics.isHentai, false), inArray(comics.id, topIds)];
    if (isNsfw !== undefined) conditions.push(eq(comics.isNsfw, isNsfw));

    const results = await this.db.query.comics.findMany({
      where: and(...conditions),
      columns: {
        id: true,
        title: true,
        slug: true,
        coverImage: true,
        protectedRouteEnabled: true,
        isNsfw: true,
      },
    });

    const comicMap = new Map(results.map((comic) => [comic.id, comic]));
    const sortedResults = topIds
      .map((id) => comicMap.get(id))
      .filter((comic): comic is NonNullable<typeof comic> => Boolean(comic))
      .slice(0, limit);

    if (sortedResults.length === 0) {
      const fallback = await this.getPopularTodayFallback(limit, isNsfw);
      return Promise.all(
        fallback.map(async (comic) => ({
          ...(await this.buildComicSummary(comic)),
          title: comic.title,
          coverImage: comic.coverImage,
          viewsToday: 0,
          isNsfw: comic.isNsfw,
        })),
      );
    }

    return Promise.all(
      sortedResults.map(async (comic) => ({
        ...(await this.buildComicSummary(comic)),
        title: comic.title,
        coverImage: comic.coverImage,
        viewsToday: dailyViewsMap.get(comic.id) ?? 0,
        isNsfw: comic.isNsfw,
      })),
    );
  }

  async getRecent(limit = 10, isNsfw?: boolean) {
    const nsfwKey = isNsfw === undefined ? 'all' : isNsfw ? 'nsfw' : 'safe';
    const cacheKey = `${CACHE_KEYS.COMIC_RECENT}:v2:${limit}:${nsfwKey}`;

    return this.cacheService.wrap(
      cacheKey,
      async () => {
        const conditions = [eq(comics.isHentai, false)];
        if (isNsfw !== undefined) conditions.push(eq(comics.isNsfw, isNsfw));
        const results = await this.db.query.comics.findMany({
          where: and(...conditions),
          orderBy: [desc(comics.updatedAt)],
          limit,
          with: {
            comicGenres: {
              with: { genre: true },
            },
          },
        });
        return Promise.all(
          results.map(async (comic) => ({
            ...(await this.buildComicSummary(comic)),
            genres: comic.comicGenres?.map((cg: any) => cg.genre) || [],
          })),
        );
      },
      CACHE_TTL.MEDIUM, // 30 minutes
    );
  }

  async getRecentWithChapters(limit = 20, isNsfw?: boolean) {
    const nsfwKey = isNsfw === undefined ? 'all' : isNsfw ? 'nsfw' : 'safe';
    const cacheKey = `${CACHE_KEYS.COMIC_RECENT_CHAPTERS}:v2:${limit}:${nsfwKey}`;

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
      WHERE c.is_hentai = false ${nsfwCondition}
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

    // Step 4: Build results preserving order (limit DB pressure from route codes)
    const recentResults = await mapWithConcurrency(
      sortedScans,
      4,
      async ({ comic_scan_id, last_chapter_at }) => {
        const scan = scanDataMap.get(comic_scan_id);
        if (!scan?.comic) return null;

        const chaps = chaptersByScan.get(comic_scan_id) || [];
        const comicPath = await this.routeProtectionService.getComicPath(scan.comic);

        return {
          comic_id: scan.comic.id,
          comic_slug: scan.comic.slug,
          comic_title: scan.comic.title,
          comic_cover: scan.comic.coverImage,
          comic_path: comicPath,
          comic_status: scan.comic.status,
          comic_type: scan.comic.type,
          is_content_nsfw: scan.comic.isNsfw,
          views: scan.comic.views || 0,
          likes: scan.comic.likes || 0,
          followers: scan.comic.followers || 0,
          comic_scan_id: scan.id,
          comic_scan_title: scan.comic.title,
          language: scan.language,
          scan_group_id: scan.scanGroup?.id || 0,
          scan_group_name: scan.scanGroup?.name || 'Unknown',
          last_chapter_at: last_chapter_at,
          recent_chapters: await this.buildRecentChapterSummaries(
            scan.comic,
            chaps.map((ch) => ({
              id: ch.id,
              slug: ch.slug,
              chapter_number: String(ch.chapter_number),
              title: ch.title || `Capítulo ${ch.chapter_number}`,
              created_at: ch.created_at,
            })),
            { comicPath },
          ),
        };
      },
    );

    return recentResults.filter(Boolean);
  }

  async getAllGenres(includeAdult = false) {
    const cacheKey = `${CACHE_KEYS.GENRES}:${includeAdult ? 'adult' : 'safe'}`;

    return this.cacheService.wrap(
      cacheKey,
      async () => {
        const allGenres = await this.db.query.genres.findMany({
          orderBy: [genres.name],
        });

        if (includeAdult) {
          return allGenres;
        }

        // Safe mode: filter out all adult genres
        return allGenres.filter(g =>
          !ADULT_GENRE_SLUGS.includes(g.slug.toLowerCase())
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

    // Register this view in the Postgres daily views history table
    const todayStr = this.getCurrentDateKey();
    await this.db
      .insert(comicViewsHistory)
      .values({
        comicId: id,
        date: todayStr,
        views: 1,
      })
      .onConflictDoUpdate({
        target: [comicViewsHistory.comicId, comicViewsHistory.date],
        set: { views: sql`${comicViewsHistory.views} + 1` },
      });

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

    const comicPath = await this.routeProtectionService.getComicPath(comicScan.comic);

    return {
      ...comicScan,
      comicPath,
      chapters: await Promise.all(
        (comicScan.chapters || []).map(async (chapter) => ({
          ...chapter,
          chapterPath: await this.routeProtectionService.getChapterPath(
            comicScan.comic,
            chapter,
            {
              comicPath,
            },
          ),
        })),
      ),
    };
  }

  async getRecommendations(comicId: number, limit = 5, isNsfw?: boolean) {
    const nsfwKey = isNsfw === undefined ? 'all' : isNsfw ? 'nsfw' : 'safe';
    const cacheKey = `${CACHE_KEYS.COMIC_RECOMMENDATIONS}:${comicId}:${limit}:${nsfwKey}`;

    return this.cacheService.wrap(
      cacheKey,
      () => this.getRecommendationsFromDb(comicId, limit, isNsfw),
      CACHE_TTL.STATIC, // 24 hours
    );
  }

  private async getRecommendationsFromDb(comicId: number, limit = 3, isNsfw?: boolean) {
    // Get the comic's genres and title
    const sourceComic = await this.db.query.comics.findFirst({
      where: eq(comics.id, comicId),
      with: { comicGenres: true }
    });

    if (!sourceComic) return [];

    const genreIds = sourceComic.comicGenres.map(cg => cg.genreId);
    
    // Strict SFW / NSFW enforcement. If source is NSFW, only recommend NSFW.
    // If source is SFW, only recommend SFW.
    const isSourceNsfw = sourceComic.isNsfw ?? false;
    // We enforce this regardless of the `isNsfw` parameter to prevent mixing content types
    const strictNsfwCondition = eq(comics.isNsfw, isSourceNsfw);
    
    let recommendedComics: any[] = [];

    if (genreIds.length > 0) {
      // Find comics that share the most genres, combined with title similarity, excluding the current comic
      const genreOverlapCount = sql<number>`count(distinct ${comicGenres.genreId})`;
      
      const similarityExpr = sql`GREATEST(
        similarity(${comics.title}, unaccent(${sourceComic.title})),
        0
      )`;
      
      // We want to rank by a combination of genre overlap, title similarity, and views
      const rankExpr = sql`${genreOverlapCount} * 10 + ${similarityExpr} * 20 + log(${comics.views} + 1)`;

      const comicsWithSameGenres = await this.db
        .select({ 
          comicId: comicGenres.comicId,
        })
        .from(comicGenres)
        .innerJoin(comics, eq(comics.id, comicGenres.comicId))
        .where(
          and(
            inArray(comicGenres.genreId, genreIds),
            eq(comics.isHentai, false),
            strictNsfwCondition
          )
        )
        .groupBy(comicGenres.comicId, comics.title, comics.views)
        .orderBy(desc(rankExpr))
        .limit(limit * 2);

      const comicIds = [...new Set(comicsWithSameGenres.map(c => c.comicId))]
        .filter(id => id !== comicId)
        .slice(0, limit);

      if (comicIds.length > 0) {
        // Fetch full data for the best matches
        recommendedComics = await this.db.query.comics.findMany({
          where: inArray(comics.id, comicIds),
          with: {
            comicGenres: {
              with: { genre: true },
            },
          },
        });
        
        // Restore order
        const comicMap = new Map(recommendedComics.map(c => [c.id, c]));
        recommendedComics = comicIds.map(id => comicMap.get(id)).filter(Boolean);
      }
    }

    // If no recommendations or not enough, fallback to popular comics of the SAME SFW/NSFW category
    if (recommendedComics.length < limit) {
      const existingIds = recommendedComics.map(c => c.id);
      existingIds.push(comicId); // Exclude current comic

      const conditions = [
        eq(comics.isHentai, false),
        strictNsfwCondition
      ];
      
      if (existingIds.length > 0) {
        conditions.push(sql`${comics.id} NOT IN (${sql.join(existingIds.map(id => sql`${id}`), sql`, `)})`);
      }

      const popularComics = await this.db.query.comics.findMany({
        where: and(...conditions),
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

    return Promise.all(
      recommendedComics.map(async (comic) => ({
        ...(await this.buildComicSummary(comic)),
        title: comic.title,
        coverImage: comic.coverImage,
        type: comic.type,
        status: comic.status,
        views: comic.views,
        isNsfw: comic.isNsfw,
        genres: comic.comicGenres?.map((cg: any) => cg.genre) || [],
      })),
    );
  }

  async getPopular(limit = 10, isNsfw?: boolean) {
    const nsfwKey = isNsfw === undefined ? 'all' : isNsfw ? 'nsfw' : 'safe';
    const cacheKey = `${CACHE_KEYS.COMIC_POPULAR}:${limit}:${nsfwKey}`;

    return this.cacheService.wrap(
      cacheKey,
      async () => {
        const conditions = [eq(comics.isHentai, false)];
        if (isNsfw !== undefined) conditions.push(eq(comics.isNsfw, isNsfw));
        const whereClause = and(...conditions);
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

        return Promise.all(
          popularComics.map(async (comic) => ({
            ...(await this.buildComicSummary(comic)),
            title: comic.title,
            coverImage: comic.coverImage,
            type: comic.type,
            status: comic.status,
            views: comic.views,
            isNsfw: comic.isNsfw,
            genres: comic.comicGenres?.map((cg: any) => cg.genre) || [],
          })),
        );
      },
      CACHE_TTL.LONG, // 2 hours
    );
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
            .where(eq(comics.protectedRouteEnabled, false))
            .orderBy(desc(comics.updatedAt))
            .limit(limit)
            .offset(offset),
          this.db
            .select({ count: sql<number>`count(*)` })
            .from(comics)
            .where(eq(comics.protectedRouteEnabled, false)),
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
      comicSlug: string;
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
              comicSlug: comics.slug,
              chapterNumber: chapters.chapterNumber,
              updatedAt: chapters.updatedAt,
            })
            .from(chapters)
            .innerJoin(comicScans, eq(chapters.comicScanId, comicScans.id))
            .innerJoin(comics, eq(comicScans.comicId, comics.id))
            .where(eq(comics.protectedRouteEnabled, false))
            .orderBy(desc(chapters.updatedAt))
            .limit(limit)
            .offset(offset),
          this.db
            .select({ count: sql<number>`count(*)` })
            .from(chapters)
            .innerJoin(comicScans, eq(chapters.comicScanId, comicScans.id))
            .innerJoin(comics, eq(comicScans.comicId, comics.id))
            .where(eq(comics.protectedRouteEnabled, false)),
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
