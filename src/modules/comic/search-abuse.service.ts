import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { FastifyRequest } from 'fastify';
import { CacheService } from '@/cache/cache.service';
import { SessionResolverService } from '@/modules/auth/session-resolver';
import { isAllowedSearchCrawlerUserAgent } from '@/modules/traffic/bot-detection.util';
import { getRequestClientIp } from '@/common/network/client-ip';
import {
  containsBlockedSearchScript,
  hashSearchQueryKey,
  normalizeSearchQuery,
} from './search-abuse.util';

const SEARCH_NEW_WINDOW_MS = 60 * 1000;
const SEARCH_PAGINATION_WINDOW_MS = 30 * 1000;
const SEARCH_REFRESH_WINDOW_MS = 30 * 1000;
const BLOCKED_SCRIPT_WINDOW_MS = 5 * 60 * 1000;
const BLOCKED_SCRIPT_WINDOW_LIMIT = 3;
const NO_IP_WINDOW_LIMIT = 5;
const LAST_QUERY_TTL_MS = 10 * 60 * 1000;

const DEFAULT_NEW_SEARCH_LIMIT = 20;
const DEFAULT_PAGINATION_LIMIT = 50;
const DEFAULT_REFRESH_LIMIT = 20;
const DEFAULT_HUMAN_BONUS_MULTIPLIER = 2;
const DEFAULT_AUTHENTICATED_BONUS_MULTIPLIER = 2;

export type SearchInspectionResult =
  | { action: 'allow'; search: string }
  | { action: 'empty'; search: string }
  | { action: 'reject'; search: string };

type SearchInspectionOptions = {
  page?: number;
};

@Injectable()
export class SearchAbuseService {
  constructor(
    private readonly cacheService: CacheService,
    private readonly configService: ConfigService,
    private readonly sessionResolver: SessionResolverService,
  ) {}

  async inspectSearch(
    search: string | undefined,
    request: FastifyRequest,
    options: SearchInspectionOptions = {},
  ): Promise<SearchInspectionResult> {
    const normalizedSearch = normalizeSearchQuery(search);

    if (isAllowedSearchCrawlerUserAgent(this.readHeader(request, 'user-agent'))) {
      return { action: 'allow', search: normalizedSearch };
    }

    if (!normalizedSearch) {
      return { action: 'allow', search: '' };
    }

    const clientIp = getRequestClientIp(request);
    const ipKey = clientIp || 'unknown';
    const page = Math.max(1, options.page || 1);
    const queryHash = hashSearchQueryKey(normalizedSearch);
    const session = await this.sessionResolver.resolveSession(request.headers);
    const userId = session?.user.id || null;
    const isAuthenticated = Boolean(userId);
    const isHumanEngaged = await this.hasRecentHumanEngagement(ipKey);
    const limitMultiplier = this.getLimitMultiplier({
      isHumanEngaged,
      isAuthenticated,
    });

    const rateDecision = await this.evaluateSearchRate({
      ipKey,
      queryHash,
      page,
      limitMultiplier,
      hasClientIp: Boolean(clientIp),
    });

    if (rateDecision === 'reject') {
      return { action: 'reject', search: normalizedSearch };
    }

    if (!containsBlockedSearchScript(normalizedSearch)) {
      return { action: 'allow', search: normalizedSearch };
    }

    const blockedCount = await this.incrementCounter(
      `search:blocked-script:${ipKey}`,
      BLOCKED_SCRIPT_WINDOW_MS,
    );

    if (blockedCount > BLOCKED_SCRIPT_WINDOW_LIMIT) {
      return { action: 'reject', search: normalizedSearch };
    }

    return { action: 'empty', search: normalizedSearch };
  }

  createRateLimitException(): HttpException {
    return new HttpException(
      'Demasiadas búsquedas en muy poco tiempo. Intenta de nuevo en un momento.',
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  private async evaluateSearchRate(input: {
    ipKey: string;
    queryHash: string;
    page: number;
    limitMultiplier: number;
    hasClientIp: boolean;
  }): Promise<'allow' | 'reject'> {
    if (!input.hasClientIp) {
      const requestCount = await this.incrementCounter(
        `search:rate:${input.ipKey}`,
        SEARCH_PAGINATION_WINDOW_MS,
      );
      return requestCount > NO_IP_WINDOW_LIMIT ? 'reject' : 'allow';
    }

    if (input.page > 1) {
      const paginationLimit = Math.ceil(
        this.readIntConfig('SEARCH_RATE_PAGINATION_PER_30S', DEFAULT_PAGINATION_LIMIT) *
          input.limitMultiplier,
      );
      const paginationCount = await this.incrementCounter(
        `search:pagination:${input.ipKey}:${input.queryHash}`,
        SEARCH_PAGINATION_WINDOW_MS,
      );
      return paginationCount > paginationLimit ? 'reject' : 'allow';
    }

    const lastQueryKey = `search:last-query:${input.ipKey}`;
    const lastQueryHash = await this.cacheService.get<string>(lastQueryKey);
    const isSameQuery = lastQueryHash === input.queryHash;

    if (!isSameQuery) {
      await this.cacheService.set(lastQueryKey, input.queryHash, LAST_QUERY_TTL_MS);
      const newSearchLimit = Math.ceil(
        this.readIntConfig('SEARCH_RATE_NEW_PER_MINUTE', DEFAULT_NEW_SEARCH_LIMIT) *
          input.limitMultiplier,
      );
      const newSearchCount = await this.incrementCounter(
        `search:new:${input.ipKey}`,
        SEARCH_NEW_WINDOW_MS,
      );
      return newSearchCount > newSearchLimit ? 'reject' : 'allow';
    }

    const refreshLimit = Math.ceil(
      this.readIntConfig('SEARCH_RATE_SAME_QUERY_REFRESH_PER_30S', DEFAULT_REFRESH_LIMIT) *
        input.limitMultiplier,
    );
    const refreshCount = await this.incrementCounter(
      `search:refresh:${input.ipKey}:${input.queryHash}`,
      SEARCH_REFRESH_WINDOW_MS,
    );
    return refreshCount > refreshLimit ? 'reject' : 'allow';
  }

  private async hasRecentHumanEngagement(ipKey: string): Promise<boolean> {
    const engaged = await this.cacheService.get<boolean>(`human:${ipKey}:engaged`);
    if (engaged) {
      return true;
    }

    const recentContentViews = Number(
      (await this.cacheService.get<number>(`traffic:${ipKey}:content:1m`)) || 0,
    );
    return recentContentViews > 0;
  }

  private getLimitMultiplier(input: {
    isHumanEngaged: boolean;
    isAuthenticated: boolean;
  }): number {
    let multiplier = 1;

    if (input.isHumanEngaged) {
      multiplier *= this.readIntConfig(
        'SEARCH_HUMAN_ENGAGEMENT_BONUS',
        DEFAULT_HUMAN_BONUS_MULTIPLIER,
      );
    }

    if (input.isAuthenticated) {
      multiplier *= this.readIntConfig(
        'SEARCH_AUTHENTICATED_BONUS',
        DEFAULT_AUTHENTICATED_BONUS_MULTIPLIER,
      );
    }

    return Math.max(1, multiplier);
  }

  private readIntConfig(key: string, fallback: number): number {
    const raw = this.configService.get<string>(key);
    const parsed = Number.parseInt(raw || '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }

  private readHeader(request: FastifyRequest, name: string): string | null {
    const value = request.headers[name.toLowerCase()];
    if (Array.isArray(value)) {
      return value[0] || null;
    }
    return typeof value === 'string' ? value : null;
  }

  private async incrementCounter(key: string, ttlMs: number): Promise<number> {
    const client = this.cacheService.getRedisClient();

    if (client) {
      try {
        const count = await client.incr(key);
        if (count === 1) {
          await client.pexpire(key, ttlMs);
        }
        return count;
      } catch {
        // Redis offline — fall back to in-memory cache.
      }
    }

    const current = Number((await this.cacheService.get<number>(key)) || 0) + 1;
    await this.cacheService.set(key, current, ttlMs);
    return current;
  }
}
