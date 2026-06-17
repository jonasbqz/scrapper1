import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { eq, and, desc } from 'drizzle-orm';
import { DATABASE_CONNECTION } from '@/database/database.module';
import { bookmarks } from '@/database/schema';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '@/database/schema';
import { BOOKMARK_COMIC_RELATIONS } from '@/lib/list-relations';
import { CacheService, CACHE_KEYS } from '@/cache/cache.service';
import { CreateBookmarkDto, UpdateBookmarkDto } from './bookmark.dto';

const DEFAULT_BOOKMARK_LIMIT = 100;
const MAX_BOOKMARK_LIMIT = 100;
const READING_STATUS = 'reading';

@Injectable()
export class BookmarkService {
  constructor(
    @Inject(DATABASE_CONNECTION)
    private db: NodePgDatabase<typeof schema>,
    private cacheService: CacheService,
  ) {}

  private resolveLimit(limit?: number) {
    return Number.isFinite(limit)
      ? Math.min(Math.max(limit as number, 1), MAX_BOOKMARK_LIMIT)
      : DEFAULT_BOOKMARK_LIMIT;
  }

  private resolveOffset(offset?: number) {
    return Number.isFinite(offset) ? Math.max(offset as number, 0) : 0;
  }

  /**
   * True when a status change crosses the `reading` boundary in either
   * direction. Used to decide whether to bust the notifications cache.
   *
   * `prev` is the bookmark's status before the write (null on first create).
   * `next` is the status being written (undefined when the field is omitted).
   */
  private wasOrIsReading(
    prev: string | null,
    next: string | undefined,
  ): boolean {
    return prev === READING_STATUS || next === READING_STATUS;
  }

  /**
   * Hard-invalidate the per-profile notifications cache.
   * `CacheService.del` swallows errors internally, so this is safe to
   * call on every bookmark write without risking a 500 on a flaky cache.
   */
  private async bustNotificationsCache(profileId: string): Promise<void> {
    await this.cacheService.del(`${CACHE_KEYS.NOTIFICATIONS_UPDATES}:${profileId}`);
  }

  async upsert(profileId: string, dto: CreateBookmarkDto) {
    const existing = await this.db.query.bookmarks.findFirst({
      where: and(
        eq(bookmarks.profileId, profileId),
        eq(bookmarks.comicId, dto.comicId),
      ),
    });

    if (existing) {
      const [updated] = await this.db
        .update(bookmarks)
        .set({
          status: dto.status,
          isFavorite: dto.isFavorite ?? existing.isFavorite,
          updatedAt: new Date(),
        })
        .where(eq(bookmarks.id, existing.id))
        .returning();

      // Bust the notifications cache only on reading transitions.
      if (this.wasOrIsReading(existing.status, dto.status)) {
        await this.bustNotificationsCache(profileId);
      }
      return updated;
    }

    const [bookmark] = await this.db.insert(bookmarks).values({
      profileId,
      comicId: dto.comicId,
      status: dto.status || 'plan_to_read',
      isFavorite: dto.isFavorite || false,
    }).returning();

    // Fresh bookmark: bust only if the new status is `reading`.
    if (this.wasOrIsReading(null, dto.status)) {
      await this.bustNotificationsCache(profileId);
    }
    return bookmark;
  }

  async findAll(profileId: string, limit?: number, offset?: number) {
    return this.db.query.bookmarks.findMany({
      where: eq(bookmarks.profileId, profileId),
      orderBy: [desc(bookmarks.updatedAt)],
      limit: this.resolveLimit(limit),
      offset: this.resolveOffset(offset),
      with: BOOKMARK_COMIC_RELATIONS,
    });
  }

  async findByStatus(profileId: string, status: string, limit?: number, offset?: number) {
    return this.db.query.bookmarks.findMany({
      where: and(
        eq(bookmarks.profileId, profileId),
        eq(bookmarks.status, status as any),
      ),
      orderBy: [desc(bookmarks.updatedAt)],
      limit: this.resolveLimit(limit),
      offset: this.resolveOffset(offset),
      with: BOOKMARK_COMIC_RELATIONS,
    });
  }

  async findFavorites(profileId: string, limit?: number, offset?: number) {
    return this.db.query.bookmarks.findMany({
      where: and(
        eq(bookmarks.profileId, profileId),
        eq(bookmarks.isFavorite, true),
      ),
      orderBy: [desc(bookmarks.updatedAt)],
      limit: this.resolveLimit(limit),
      offset: this.resolveOffset(offset),
      with: BOOKMARK_COMIC_RELATIONS,
    });
  }

  async findOne(profileId: string, comicId: number) {
    return this.db.query.bookmarks.findFirst({
      where: and(
        eq(bookmarks.profileId, profileId),
        eq(bookmarks.comicId, comicId),
      ),
      with: BOOKMARK_COMIC_RELATIONS,
    });
  }

  async update(profileId: string, comicId: number, dto: UpdateBookmarkDto) {
    const existing = await this.findOne(profileId, comicId);
    if (!existing) {
      throw new NotFoundException('Bookmark not found');
    }

    const [updated] = await this.db
      .update(bookmarks)
      .set({
        ...dto,
        updatedAt: new Date(),
      })
      .where(eq(bookmarks.id, existing.id))
      .returning();

    // Bust the notifications cache only on reading transitions (into OR
    // out of `reading`). isFavorite-only updates do not affect the feed.
    if (this.wasOrIsReading(existing.status, dto.status)) {
      await this.bustNotificationsCache(profileId);
    }

    return updated;
  }

  async delete(profileId: string, comicId: number) {
    const existing = await this.findOne(profileId, comicId);
    if (!existing) {
      throw new NotFoundException('Bookmark not found');
    }

    await this.db.delete(bookmarks).where(eq(bookmarks.id, existing.id));

    // Deleting a `reading` bookmark removes it from the feed.
    if (existing.status === READING_STATUS) {
      await this.bustNotificationsCache(profileId);
    }
  }
}
