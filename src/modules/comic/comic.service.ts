import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { eq, like, desc, and, sql, inArray } from 'drizzle-orm';
import { DATABASE_CONNECTION } from '@/database/database.module';
import { comics, comicGenres, genres, comicScans, chapters } from '@/database/schema';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '@/database/schema';

export interface ComicFilters {
  search?: string;
  type?: 'manga' | 'manhwa' | 'manhua';
  status?: 'ongoing' | 'completed' | 'hiatus' | 'cancelled';
  genreIds?: number[];
  isNsfw?: boolean;
  page?: number;
  limit?: number;
}

@Injectable()
export class ComicService {
  constructor(
    @Inject(DATABASE_CONNECTION)
    private db: NodePgDatabase<typeof schema>,
  ) {}

  async findAll(filters: ComicFilters = {}) {
    const { search, type, status, genreIds, isNsfw, page = 1, limit = 20 } = filters;
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
    if (genreIds?.length) {
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

    const [results, countResult] = await Promise.all([
      this.db.query.comics.findMany({
        where: whereClause,
        orderBy: [desc(comics.updatedAt)],
        limit,
        offset,
        with: {
          comicGenres: {
            with: {
              genre: true,
            },
          },
        },
      }),
      this.db
        .select({ count: sql<number>`count(*)` })
        .from(comics)
        .where(whereClause),
    ]);

    return {
      data: results.map(comic => ({
        ...comic,
        genres: comic.comicGenres.map(cg => cg.genre),
      })),
      pagination: {
        page,
        limit,
        total: Number(countResult[0]?.count || 0),
        totalPages: Math.ceil(Number(countResult[0]?.count || 0) / limit),
      },
    };
  }

  async findById(id: number) {
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
      genres: comic.comicGenres.map(cg => cg.genre),
    };
  }

  async findBySlug(slug: string) {
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
      genres: comic.comicGenres.map(cg => cg.genre),
    };
  }

  async getTrending(limit = 10) {
    return this.db.query.comics.findMany({
      orderBy: [desc(comics.views)],
      limit,
      with: {
        comicGenres: {
          with: { genre: true },
        },
      },
    });
  }

  async getRecent(limit = 10) {
    return this.db.query.comics.findMany({
      orderBy: [desc(comics.updatedAt)],
      limit,
      with: {
        comicGenres: {
          with: { genre: true },
        },
      },
    });
  }

  async getAllGenres() {
    return this.db.query.genres.findMany({
      orderBy: [genres.name],
    });
  }

  async incrementViews(id: number) {
    await this.db
      .update(comics)
      .set({ views: sql`${comics.views} + 1` })
      .where(eq(comics.id, id));
  }
}
