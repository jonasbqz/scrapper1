import { Injectable, Inject } from "@nestjs/common";
import { CACHE_MANAGER } from "@nestjs/cache-manager";
import type { Cache } from "cache-manager";

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
  private lastErrorTime = 0;
  private readonly ERROR_COOLDOWN_MS = 30000; // Only log errors every 30 seconds

  constructor(@Inject(CACHE_MANAGER) private cacheManager: Cache) {}

  private getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  /**
   * Returns the underlying Redis-backed store when REDIS_URL is configured.
   * cache-manager v7 wraps stores in Keyv → KeyvAdapter → legacy store.
   */
  getRedisBackedStore(): {
    keys?: (pattern?: string) => Promise<string[]>;
    client?: {
      incr: (key: string) => Promise<number>;
      pexpire: (key: string, ttlMs: number) => Promise<number>;
      ttl: (key: string) => Promise<number>;
      expire: (key: string, seconds: number) => Promise<number>;
      zincrby: (key: string, increment: number, member: string) => Promise<string>;
      zrevrange: (key: string, start: number, stop: number) => Promise<string[]>;
      sadd: (key: string, member: string) => Promise<number>;
      scard: (key: string) => Promise<number>;
    };
  } | null {
    const keyvAdapter = this.cacheManager.stores?.[0]?.opts?.store as
      | { _cache?: ReturnType<CacheService['getRedisBackedStore']> }
      | undefined;
    const legacyStore = (this.cacheManager as { store?: ReturnType<CacheService['getRedisBackedStore']> })
      .store;

    return keyvAdapter?._cache ?? legacyStore ?? null;
  }

  getRedisClient() {
    return this.getRedisBackedStore()?.client ?? null;
  }

  private shouldLogError(): boolean {
    const now = Date.now();
    if (now - this.lastErrorTime >= this.ERROR_COOLDOWN_MS) {
      this.lastErrorTime = now;
      return true;
    }
    return false;
  }

  /**
   * Get value from cache
   */
  async get<T>(key: string): Promise<T | undefined> {
    try {
      return await this.cacheManager.get<T>(key);
    } catch (error) {
      if (this.shouldLogError()) {
        console.error(`Cache get error (suppressed subsequent errors for 30s):`, this.getErrorMessage(error));
      }
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
      if (this.shouldLogError()) {
        console.error(`Cache set error (suppressed subsequent errors for 30s):`, this.getErrorMessage(error));
      }
    }
  }

  /**
   * Delete a specific key from cache
   */
  async del(key: string): Promise<void> {
    try {
      await this.cacheManager.del(key);
    } catch (error) {
      if (this.shouldLogError()) {
        console.error(`Cache delete error (suppressed subsequent errors for 30s):`, this.getErrorMessage(error));
      }
    }
  }

  /**
   * Delete multiple keys matching a pattern
   * Note: This requires the underlying store to support pattern deletion
   */
  async delByPattern(pattern: string): Promise<void> {
    try {
      const store = this.getRedisBackedStore();
      if (store?.keys) {
        const keys = await store.keys(pattern);
        if (keys && keys.length > 0) {
          await Promise.all(
            keys.map((key: string) => this.cacheManager.del(key)),
          );
        }
      }
    } catch (error) {
      if (this.shouldLogError()) {
        console.error(`Cache pattern delete error (suppressed subsequent errors for 30s):`, this.getErrorMessage(error));
      }
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
    const cached = await this.get<T>(key);
    if (cached !== undefined && cached !== null) {
      return cached;
    }

    const result = await fn();
    await this.set(key, result, ttl);
    return result;
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
      const store = this.getRedisBackedStore();
      const client = store?.client;
      if (client) {
        const today = new Date().toISOString().split('T')[0];
        const key = `comic:views:daily:${today}`;
        await client.zincrby(key, 1, comicId.toString());
        // Set expiry to 2 days (172800 seconds) if it doesn't have one
        const ttl = await client.ttl(key);
        if (ttl === -1) {
          await client.expire(key, 172800);
        }
      }
    } catch (error) {
      if (this.shouldLogError()) {
        console.error('Error incrementing daily view (suppressed subsequent errors for 30s):', this.getErrorMessage(error));
      }
    }
  }

  /**
   * Retrieves the top trending comic IDs for the day from Redis
   */
  async getDailyTrendingComicIds(limit: number): Promise<number[]> {
    try {
      const client = this.getRedisClient();
      if (client) {
        const today = new Date().toISOString().split('T')[0];
        const key = `comic:views:daily:${today}`;
        // zrevrange returns highest scores first
        const ids = await client.zrevrange(key, 0, limit - 1);
        return ids.map((id: string) => parseInt(id, 10));
      }
    } catch (error) {
      if (this.shouldLogError()) {
        console.error('Error getting daily trending (suppressed subsequent errors for 30s):', this.getErrorMessage(error));
      }
    }
    return [];
  }
}
