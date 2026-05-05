import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { CacheService } from '@/cache/cache.service';
import { isAllowedSearchCrawlerUserAgent } from '@/modules/traffic/bot-detection.util';
import { getRequestClientIp } from '@/common/network/client-ip';
import {
  containsBlockedSearchScript,
  normalizeSearchQuery,
} from './search-abuse.util';

const SEARCH_WINDOW_MS = 30 * 1000;
const SEARCH_WINDOW_LIMIT = 10;
const BLOCKED_SCRIPT_WINDOW_MS = 5 * 60 * 1000;
const BLOCKED_SCRIPT_WINDOW_LIMIT = 3;
const NO_IP_WINDOW_LIMIT = 5;

export type SearchInspectionResult =
  | { action: 'allow'; search: string }
  | { action: 'empty'; search: string }
  | { action: 'reject'; search: string };

@Injectable()
export class SearchAbuseService {
  constructor(private readonly cacheService: CacheService) {}

  async inspectSearch(
    search: string | undefined,
    request: FastifyRequest,
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

    const requestCount = await this.incrementCounter(
      `search:rate:${ipKey}`,
      SEARCH_WINDOW_MS,
    );

    const currentLimit = clientIp ? SEARCH_WINDOW_LIMIT : NO_IP_WINDOW_LIMIT;
    if (requestCount > currentLimit) {
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

  private readHeader(request: FastifyRequest, name: string): string | null {
    const value = request.headers[name.toLowerCase()];
    if (Array.isArray(value)) {
      return value[0] || null;
    }
    return typeof value === 'string' ? value : null;
  }

  private async incrementCounter(key: string, ttlMs: number): Promise<number> {
    const store = (this.cacheService as any).cacheManager?.store;
    const client = store?.client;

    if (client) {
      try {
        const count = await client.incr(key);
        // Solo se setea el TTL cuando la key es nueva (count === 1)
        // Si se llama pexpire en cada request se convierte en sliding window
        // y el contador nunca expira → bloquea usuarios legítimos indefinidamente
        if (count === 1) {
          await client.pexpire(key, ttlMs);
        }
        return count;
      } catch {
        // Redis offline o error transitorio — caemos al fallback in-memory
        // para no tirar 500 a todos los usuarios
      }
    }

    const current = Number((await this.cacheService.get<number>(key)) || 0) + 1;
    await this.cacheService.set(key, current, ttlMs);
    return current;
  }
}
