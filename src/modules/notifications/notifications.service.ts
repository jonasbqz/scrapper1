import { Injectable, Inject } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DATABASE_CONNECTION } from '@/database/database.module';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '@/database/schema';
import { CacheService, CACHE_KEYS, CACHE_TTL } from '@/cache/cache.service';
import { NotificationItemDto } from './dto/notifications.dto';

const NOTIFICATIONS_PAGE_SIZE = 50;
const UNREAD_WINDOW_DAYS = 30;
const READING_STATUS = 'reading';

interface UnreadCteRow {
  [key: string]: unknown;
  comic_id: number;
  slug: string;
  title: string;
  cover_image: string;
  last_chapter_read: number;
  latest_chapter: number;
  new_chapters_count: number;
  latest_chapter_published_at: Date | string;
  first_unread_chapter_id: number | null;
  total_count: string;
}

/**
 * NotificationsModule
 *
 * Server-computed "updates" feed: per profile, list the comics the user is
 * actively `reading` that have unreleased-since-last-read chapters, scoped to
 * the last 30 days. Results are cached in Redis (1h TTL) and hard-invalidated
 * on bookmark status transitions into/out of `reading` and on any
 * `readingHistory` insert (see `bookmark.service.ts` and
 * `reading-history.service.ts`).
 */
@Injectable()
export class NotificationsService {
  constructor(
    @Inject(DATABASE_CONNECTION)
    private db: NodePgDatabase<typeof schema>,
    private cacheService: CacheService,
  ) {}

  /**
   * Returns the per-profile "updates" feed, cached in Redis for 1h.
   */
  async findUpdates(profileId: string) {
    const cacheKey = this.cacheKeyFor(profileId);

    const cached = await this.cacheService.wrap(
      cacheKey,
      () => this.queryFromDb(profileId),
      CACHE_TTL.STATIC,
    );

    return cached;
  }

  /**
   * Hard-invalidates the per-profile feed cache. Called by
   * `BookmarkService.upsert/update` and `ReadingHistoryService.record`.
   */
  async invalidateForProfile(profileId: string): Promise<void> {
    await this.cacheService.del(this.cacheKeyFor(profileId));
  }

  private cacheKeyFor(profileId: string): string {
    return `${CACHE_KEYS.NOTIFICATIONS_UPDATES}:${profileId}`;
  }

  /**
   * The canonical CTE. Mirrors the design doc §2 verbatim, including the
   * `firstUnreadChapterId` tiebreak (lowest `chapter_number` then lowest `id`).
   *
   * Notes on column names: the CTE emits snake_case rows; the mapper converts
   * them to camelCase before reaching the DTO.
   */
  private async queryFromDb(
    profileId: string,
  ): Promise<{ items: NotificationItemDto[]; total: number; hasMore: boolean }> {
    const result = await this.db.execute<UnreadCteRow>(sql`
      WITH params AS (
        SELECT ${profileId}::uuid AS profile_id,
               now() - interval '${sql.raw(String(UNREAD_WINDOW_DAYS))} days' AS cutoff
      ),
      reading_bookmarks AS (
        SELECT b.comic_id
        FROM bookmarks b, params p
        WHERE b.profile_id = p.profile_id
          AND b.status = ${READING_STATUS}
      ),
      last_read_per_comic AS (
        SELECT rh.comic_id, max(rh.read_at) AS last_read_at
        FROM reading_history rh, params p
        WHERE rh.profile_id = p.profile_id
          AND rh.comic_id IN (SELECT comic_id FROM reading_bookmarks)
        GROUP BY rh.comic_id
      ),
      last_read_chapter_number AS (
        SELECT lrc.comic_id, c.chapter_number AS last_read_chapter_number
        FROM last_read_per_comic lrc
        JOIN reading_history rh
          ON rh.profile_id = (SELECT profile_id FROM params)
         AND rh.comic_id    = lrc.comic_id
         AND rh.read_at     = lrc.last_read_at
        JOIN chapters c ON c.id = rh.chapter_id
      ),
      unread AS (
        SELECT c.id, c.comic_scan_id, c.chapter_number, c.release_date, cs.comic_id
        FROM chapters c
        JOIN comic_scans cs ON cs.id = c.comic_scan_id
        JOIN reading_bookmarks rb ON rb.comic_id = cs.comic_id
        LEFT JOIN last_read_chapter_number lrcn ON lrcn.comic_id = cs.comic_id
        WHERE c.release_date IS NOT NULL
          AND c.release_date > (SELECT cutoff FROM params)
          AND (lrcn.last_read_chapter_number IS NULL
               OR c.chapter_number > lrcn.last_read_chapter_number)
      )
      SELECT cs.comic_id,
             co.slug          AS slug,
             co.title         AS title,
             co.cover_image   AS cover_image,
             coalesce(lrcn.last_read_chapter_number, 0) AS last_chapter_read,
             max(u.chapter_number)        AS latest_chapter,
             count(*)                      AS new_chapters_count,
             max(u.release_date)           AS latest_chapter_published_at,
            (
              SELECT id FROM unread u2
              WHERE u2.comic_id = cs.comic_id
              -- TIEBREAK: lowest chapterNumber, then lowest chapters.id.
              -- Must match design §2 and the spec "Multi-scan tiebreak" scenario.
              ORDER BY u2.chapter_number ASC, u2.id ASC
              LIMIT 1
            ) AS first_unread_chapter_id,
            (SELECT count(distinct u2.comic_id) FROM unread u2) AS total_count
      FROM unread u
      JOIN comic_scans cs ON cs.id = u.comic_scan_id
      JOIN comics co      ON co.id = cs.comic_id
      LEFT JOIN last_read_chapter_number lrcn ON lrcn.comic_id = cs.comic_id
      GROUP BY cs.comic_id, co.slug, co.title, co.cover_image, lrcn.last_read_chapter_number
      ORDER BY max(u.release_date) DESC
      LIMIT ${NOTIFICATIONS_PAGE_SIZE};
    `);

    const rows = (result.rows ?? []) as UnreadCteRow[];
    const items = rows.map((row) => this.mapRowToItem(row));
    const total = Number(rows[0]?.total_count ?? 0);
    const hasMore = total > items.length;

    return { items, total, hasMore };
  }

  private mapRowToItem(row: UnreadCteRow): NotificationItemDto {
    // Defensive clamps: a SQL anomaly must never surface a negative count or
    // a malformed date through the DTO.
    const safeCount = Math.max(0, Number(row.new_chapters_count) || 0);
    const safeLatestChapter = Math.max(1, Number(row.latest_chapter) || 1);
    const safeLastRead = Math.max(0, Number(row.last_chapter_read) || 0);
    const firstUnread = safeCount === 0
      ? null
      : row.first_unread_chapter_id == null
        ? null
        : Number(row.first_unread_chapter_id);

    return {
      comicId: Number(row.comic_id),
      comicSlug: String(row.slug ?? ''),
      title: String(row.title ?? ''),
      coverUrl: String(row.cover_image ?? ''),
      lastChapterRead: safeLastRead,
      latestChapter: safeLatestChapter,
      newChaptersCount: safeCount,
      latestChapterPublishedAt: this.toIsoString(row.latest_chapter_published_at),
      firstUnreadChapterId: firstUnread,
    };
  }

  private toIsoString(value: Date | string | null | undefined): string {
    if (!value) {
      return new Date(0).toISOString();
    }
    if (value instanceof Date) {
      return value.toISOString();
    }
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? new Date(0).toISOString() : parsed.toISOString();
  }
}
