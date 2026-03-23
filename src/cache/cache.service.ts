import { Injectable, Inject } from "@nestjs/common";
import { CACHE_MANAGER } from "@nestjs/cache-manager";
import { Cache } from "cache-manager";

// Cache TTL constants (in milliseconds)
export const CACHE_TTL = {
  STATIC: 1 * 60 * 60 * 1000, // 1 hours - for genres, static data
  LONG: 10 * 60 * 1000, // 10 minutes - for comic/chapter details
  MEDIUM: 5 * 60 * 1000, // 5 minutes - for lists, trending
  SHORT: 1 * 60 * 1000, // 1 minutes - for frequently updated data
  VERY_SHORT: 30 * 1000, // 30 seconds - for counts, user-specific
} as const;

// Cache key prefixes
export const CACHE_KEYS = {
  // Comics
  COMIC_LIST: "comics:list",
  COMIC_DETAIL: "comic",
  COMIC_SLUG: "comic:slug",
  COMIC_TRENDING: "comics:trending",
  COMIC_RECENT: "comics:recent",
  COMIC_RECENT_CHAPTERS: "comics:recentChapters",
  COMIC_POPULAR: "comics:popular",
  COMIC_RECOMMENDATIONS: "comic:recommendations",
  GENRES: "genres:all",

  // Chapters
  CHAPTER_DETAIL: "chapter",
  CHAPTER_PAGES: "chapter:pages",
  CHAPTER_NAVIGATION: "chapter:navigation",
  CHAPTERS_BY_COMIC_SCAN: "chapters:comicScan",

  // Likes
  LIKES_COUNT: "likes:count",
  CHAPTER_LIKES_COUNT: "chapter_likes:count",

  // Comments
  COMMENTS_COUNT: "comments:count",
} as const;

@Injectable()
export class CacheService {
  constructor(@Inject(CACHE_MANAGER) private cacheManager: Cache) {}

  /**
   * Get value from cache
   */
  async get<T>(key: string): Promise<T | undefined> {
    try {
      return await this.cacheManager.get<T>(key);
    } catch (error) {
      console.error(`Cache get error for key ${key}:`, error);
      return undefined;
    }
  }

  /**
   * Set value in cache with TTL
   */
  async set<T>(
    key: string,
    value: T,
    ttl: number = CACHE_TTL.MEDIUM,
  ): Promise<void> {
    try {
      await this.cacheManager.set(key, value, ttl);
    } catch (error) {
      console.error(`Cache set error for key ${key}:`, error);
    }
  }

  /**
   * Delete a specific key from cache
   */
  async del(key: string): Promise<void> {
    try {
      await this.cacheManager.del(key);
    } catch (error) {
      console.error(`Cache delete error for key ${key}:`, error);
    }
  }

  /**
   * Delete multiple keys matching a pattern
   * Note: This requires the underlying store to support pattern deletion
   */
  async delByPattern(pattern: string): Promise<void> {
    try {
      const store = this.cacheManager.store as any;
      if (store.keys && store.del) {
        const keys = await store.keys(pattern);
        if (keys && keys.length > 0) {
          await Promise.all(
            keys.map((key: string) => this.cacheManager.del(key)),
          );
        }
      }
    } catch (error) {
      console.error(`Cache pattern delete error for ${pattern}:`, error);
    }
  }

  /**
   * Wrap a function with caching
   * If cached value exists, return it. Otherwise, execute function and cache result.
   */
  async wrap<T>(
    key: string,
    fn: () => Promise<T>,
    ttl: number = CACHE_TTL.MEDIUM,
  ): Promise<T> {
    try {
      const cached = await this.get<T>(key);
      if (cached !== undefined && cached !== null) {
        return cached;
      }

      const result = await fn();
      await this.set(key, result, ttl);
      return result;
    } catch (error) {
      console.error(`Cache wrap error for key ${key}:`, error);
      // On cache error, just execute the function
      return fn();
    }
  }

  /**
   * Generate cache key for comic list with filters
   */
  buildComicListKey(filters: Record<string, any>): string {
    const sortedFilters = Object.keys(filters)
      .sort()
      .filter(
        (key) =>
          filters[key] !== undefined &&
          filters[key] !== null &&
          filters[key] !== "",
      )
      .map((key) => `${key}=${filters[key]}`)
      .join(":");
    return `${CACHE_KEYS.COMIC_LIST}:${sortedFilters || "all"}`;
  }

  /**
   * Invalidate all comic-related cache entries
   */
  async invalidateComicCache(comicId?: number): Promise<void> {
    const patterns = [
      `${CACHE_KEYS.COMIC_TRENDING}:*`,
      `${CACHE_KEYS.COMIC_RECENT}:*`,
      `${CACHE_KEYS.COMIC_RECENT_CHAPTERS}:*`,
      `${CACHE_KEYS.COMIC_POPULAR}:*`,
      `${CACHE_KEYS.COMIC_LIST}:*`,
    ];

    if (comicId) {
      patterns.push(`${CACHE_KEYS.COMIC_DETAIL}:${comicId}`);
      patterns.push(`${CACHE_KEYS.COMIC_RECOMMENDATIONS}:${comicId}:*`);
    }

    await Promise.all(patterns.map((pattern) => this.delByPattern(pattern)));
  }

  /**
   * Invalidate chapter-related cache entries
   */
  async invalidateChapterCache(
    chapterId?: number,
    comicScanId?: number,
  ): Promise<void> {
    if (chapterId) {
      await this.del(`${CACHE_KEYS.CHAPTER_DETAIL}:${chapterId}`);
      await this.del(`${CACHE_KEYS.CHAPTER_PAGES}:${chapterId}`);
      await this.del(`${CACHE_KEYS.CHAPTER_NAVIGATION}:${chapterId}`);
    }
    if (comicScanId) {
      await this.del(`${CACHE_KEYS.CHAPTERS_BY_COMIC_SCAN}:${comicScanId}`);
    }
  }

  /**
   * Tracks daily comic views in Redis using Sorted Sets
   */
  async incrementDailyView(comicId: number): Promise<void> {
    try {
      const store = this.cacheManager.store as any;
      if (store.client) {
        const today = new Date().toISOString().split('T')[0];
        const key = `comic:views:daily:${today}`;
        await store.client.zincrby(key, 1, comicId.toString());
        // Set expiry to 2 days (172800 seconds) if it doesn't have one
        const ttl = await store.client.ttl(key);
        if (ttl === -1) {
          await store.client.expire(key, 172800);
        }
      }
    } catch (error) {
      console.error('Error incrementing daily view in Redis:', error);
    }
  }

  /**
   * Retrieves the top trending comic IDs for the day from Redis
   */
  async getDailyTrendingComicIds(limit: number): Promise<number[]> {
    try {
      const store = this.cacheManager.store as any;
      if (store.client) {
        const today = new Date().toISOString().split('T')[0];
        const key = `comic:views:daily:${today}`;
        // zrevrange returns highest scores first
        const ids = await store.client.zrevrange(key, 0, limit - 1);
        return ids.map((id: string) => parseInt(id, 10));
      }
    } catch (error) {
      console.error('Error getting daily trending comics from Redis:', error);
    }
    return [];
  }
}

