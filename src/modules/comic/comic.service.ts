import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { eq, like, desc, asc, and, sql, inArray } from 'drizzle-orm';
import { DATABASE_CONNECTION } from '@/database/database.module';
import { comics, comicGenres, genres, comicScans, chapters } from '@/database/schema';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '@/database/schema';
import { CacheService, CACHE_TTL, CACHE_KEYS } from '@/cache/cache.service';

export interface ComicFilters {
  search?: string;
  type?: 'manga' | 'manhwa' | 'manhua';
  status?: 'ongoing' | 'completed' | 'hiatus' | 'cancelled';
  genreIds?: number[];
  genreNames?: string[];
  isNsfw?: boolean;
  page?: number;
  limit?: number;
  orderBy?: 'created_at' | 'views' | 'updated_at';
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

    return this.cacheService.wrap(
      cacheKey,
      () => this.findAllFromDb(filters),
      CACHE_TTL.MEDIUM, // 30 minutes
    );
  }

  private async findAllFromDb(filters: ComicFilters = {}) {
    const { search, type, status, genreIds, genreNames, isNsfw, page = 1, limit = 20, orderBy = 'updated_at', isDesc = true } = filters;
    const offset = (page - 1) * limit;

    const conditions = [];

    if (search) {
      conditions.push(like(comics.title, `%${search}%`));
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

    // Filter by genre names (comma-separated)
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
          // No comics found with those genres, return empty
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

    // Determine order column
    const orderColumn = orderBy === 'views' ? comics.views : orderBy === 'created_at' ? comics.createdAt : comics.updatedAt;

    // Step 1: Get comics with genres and comicScans (without chapters)
    const [results, countResult, allGenres] = await Promise.all([
      this.db.query.comics.findMany({
        where: whereClause,
        orderBy: [isDesc ? desc(orderColumn) : asc(orderColumn)],
        limit,
        offset,
        with: {
          comicGenres: {
            with: {
              genre: true,
            },
          },
          comicScans: {
            with: {
              scanGroup: true,
            },
          },
        },
      }),
      this.db
        .select({ count: sql<number>`count(*)` })
        .from(comics)
        .where(whereClause),
      this.db.query.genres.findMany({
        orderBy: [genres.name],
      }),
    ]);

    // Step 2: Get comic_scan_ids from results
    const comicScanIds = results.flatMap(comic =>
      comic.comicScans?.map(cs => cs.id) || []
    );

    // Step 3: Get top 2 chapters per comic_scan
    let chaptersByScan = new Map<number, any[]>();

    if (comicScanIds.length > 0) {
      // Get chapters for these comic_scans
      const allChapters = await this.db.query.chapters.findMany({
        where: inArray(chapters.comicScanId, comicScanIds),
        orderBy: [desc(chapters.createdAt)],
      });

      // Group by comic_scan_id, keeping only top 2
      for (const ch of allChapters) {
        const scanId = ch.comicScanId;
        if (!chaptersByScan.has(scanId)) {
          chaptersByScan.set(scanId, []);
        }
        const arr = chaptersByScan.get(scanId)!;
        if (arr.length < 2) {
          arr.push(ch);
        }
      }
    }

    return {
      data: results.map(comic => {
        // Get the first comic scan with chapters
        const mainScan = comic.comicScans?.find(cs => chaptersByScan.has(cs.id)) || comic.comicScans?.[0];
        const recentChapters = mainScan ? (chaptersByScan.get(mainScan.id) || []) : [];

        return {
          ...comic,
          genres: comic.comicGenres.map((cg: any) => cg.genre),
          scan_group_name: mainScan?.scanGroup?.name || 'Unknown',
          recent_chapters: recentChapters.map((ch: any) => ({
            id: ch.id,
            chapter_number: String(ch.chapterNumber),
            title: ch.title || `Capítulo ${ch.chapterNumber}`,
            created_at: ch.createdAt,
          })),
        };
      }),
      pagination: {
        page,
        limit,
        total: Number(countResult[0]?.count || 0),
        totalPages: Math.ceil(Number(countResult[0]?.count || 0) / limit),
      },
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

  async getTrending(limit = 10) {
    const cacheKey = `${CACHE_KEYS.COMIC_TRENDING}:${limit}`;

    return this.cacheService.wrap(
      cacheKey,
      () =>
        this.db.query.comics.findMany({
          orderBy: [desc(comics.views)],
          limit,
          with: {
            comicGenres: {
              with: { genre: true },
            },
          },
        }),
      CACHE_TTL.LONG, // 2 hours
    );
  }

  async getRecent(limit = 10) {
    const cacheKey = `${CACHE_KEYS.COMIC_RECENT}:${limit}`;

    return this.cacheService.wrap(
      cacheKey,
      () =>
        this.db.query.comics.findMany({
          orderBy: [desc(comics.updatedAt)],
          limit,
          with: {
            comicGenres: {
              with: { genre: true },
            },
          },
        }),
      CACHE_TTL.MEDIUM, // 30 minutes
    );
  }

  async getRecentWithChapters(limit = 20) {
    const cacheKey = `${CACHE_KEYS.COMIC_RECENT_CHAPTERS}:${limit}`;

    return this.cacheService.wrap(
      cacheKey,
      () => this.getRecentWithChaptersFromDb(limit),
      CACHE_TTL.SHORT, // 10 minutes - frequently updated
    );
  }

  private async getRecentWithChaptersFromDb(limit = 20) {
    // Step 1: Get comic_scans that have chapters, ordered by most recent chapter
    // Using raw SQL to get distinct comic_scan_ids with their max chapter date
    const recentScansQuery = await this.db.execute(sql`
      SELECT DISTINCT ON (comic_scan_id)
        comic_scan_id,
        created_at as last_chapter_at
      FROM chapters
      ORDER BY comic_scan_id, created_at DESC
    `);

    // Sort by last_chapter_at descending and take limit
    const sortedScans = (recentScansQuery.rows as any[])
      .sort((a, b) => new Date(b.last_chapter_at).getTime() - new Date(a.last_chapter_at).getTime())
      .slice(0, limit);

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

    // Create a map for quick lookup
    const scanDataMap = new Map(comicScansData.map(cs => [cs.id, cs]));

    // Step 3: Get top 2 chapters for each comic_scan
    const chaptersData = await this.db.query.chapters.findMany({
      where: inArray(chapters.comicScanId, scanIds),
      orderBy: [desc(chapters.createdAt)],
    });

    // Group chapters by comic_scan_id, keeping only top 2
    const chaptersByScan = new Map<number, typeof chaptersData>();
    for (const chapter of chaptersData) {
      const scanId = chapter.comicScanId;
      if (!chaptersByScan.has(scanId)) {
        chaptersByScan.set(scanId, []);
      }
      const arr = chaptersByScan.get(scanId)!;
      if (arr.length < 2) {
        arr.push(chapter);
      }
    }

    // Step 4: Build results in the correct order
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
            chapter_number: String(ch.chapterNumber),
            title: ch.title || `Capítulo ${ch.chapterNumber}`,
            created_at: ch.createdAt,
          })),
        };
      })
      .filter(Boolean);
  }

  async getAllGenres() {
    const cacheKey = CACHE_KEYS.GENRES;

    return this.cacheService.wrap(
      cacheKey,
      () =>
        this.db.query.genres.findMany({
          orderBy: [genres.name],
        }),
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
        },
      },
    });

    if (!comicScan) {
      throw new NotFoundException('Comic scan not found');
    }

    return comicScan;
  }

  async getRecommendations(comicId: number, limit = 10) {
    const cacheKey = `${CACHE_KEYS.COMIC_RECOMMENDATIONS}:${comicId}:${limit}`;

    return this.cacheService.wrap(
      cacheKey,
      () => this.getRecommendationsFromDb(comicId, limit),
      CACHE_TTL.LONG, // 2 hours
    );
  }

  private async getRecommendationsFromDb(comicId: number, limit = 10) {
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
        // Get comics ordered by views (popularity within same genres)
        recommendedComics = await this.db.query.comics.findMany({
          where: inArray(comics.id, comicIds),
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

      const popularComics = await this.db.query.comics.findMany({
        where: existingIds.length > 0
          ? sql`${comics.id} NOT IN (${sql.join(existingIds.map(id => sql`${id}`), sql`, `)})`
          : undefined,
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

  async getPopular(limit = 10) {
    const cacheKey = `${CACHE_KEYS.COMIC_POPULAR}:${limit}`;

    return this.cacheService.wrap(
      cacheKey,
      async () => {
        const popularComics = await this.db.query.comics.findMany({
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
}
