import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { FastifyRequest } from 'fastify';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { CacheService } from '@/cache/cache.service';
import { getRequestClientIp } from '@/common/network/client-ip';
import { DATABASE_CONNECTION } from '@/database/database.module';
import { trafficEvents } from '@/database/schema';
import type * as schema from '@/database/schema';
import {
  actionFromRiskScore,
  hashTrafficSubject,
  inspectTrafficEvent,
  parseAsnList,
  parseCsvList,
  TrafficAction,
  TrafficEventType,
} from './bot-detection.util';

type RecordTrafficInput = {
  eventType: TrafficEventType;
  request: FastifyRequest;
  path?: string | null;
  searchQuery?: string | null;
  entityType?: string | null;
  entityId?: number | null;
  action?: TrafficAction;
  metadata?: Record<string, unknown>;
};

type CounterSignals = {
  minuteEvents: number;
  minuteSearches: number;
  minuteContentViews: number;
  repeatedSearches: number;
  repeatedPathHits: number;
  riskScore: number;
  reasons: string[];
};

@Injectable()
export class TrafficEventsService {
  private readonly watchCidrs: string[];
  private readonly watchAsns: number[];
  private tableMissingLogged = false;

  constructor(
    @Inject(DATABASE_CONNECTION)
    private readonly db: NodePgDatabase<typeof schema>,
    private readonly cacheService: CacheService,
    private readonly configService: ConfigService,
  ) {
    this.watchCidrs = parseCsvList(
      this.configService.get<string>('BOT_WATCH_IP_CIDRS') ||
        this.configService.get<string>('SUSPICIOUS_IP_CIDRS') ||
        this.configService.get<string>('BOT_DATACENTER_IP_CIDRS'),
    );
    this.watchAsns = parseAsnList(
      this.configService.get<string>('BOT_WATCH_ASNS') ||
        this.configService.get<string>('SUSPICIOUS_ASNS') ||
        this.configService.get<string>('BOT_DATACENTER_ASNS'),
    );
  }

  async record(input: RecordTrafficInput) {
    if (this.configService.get<string>('TRAFFIC_EVENTS_ENABLED') === 'false') {
      return { action: 'allow' as TrafficAction, riskScore: 0, reasons: [] as string[] };
    }

    const clientIp = getRequestClientIp(input.request);
    const clientAsn = this.getClientAsn(input.request);
    const userAgent = this.readHeader(input.request, 'user-agent');
    const referer = this.readHeader(input.request, 'referer') || this.readHeader(input.request, 'referrer');
    const acceptLanguage = this.readHeader(input.request, 'accept-language');
    const userId = this.readHeader(input.request, 'x-user-id') || null;
    const path = input.path || this.getRequestPath(input.request);
    const subjectSource = clientIp || userAgent || 'unknown';
    const subjectKey = hashTrafficSubject(subjectSource);

    const staticInspection = inspectTrafficEvent({
      eventType: input.eventType,
      clientIp,
      clientAsn,
      userAgent,
      path,
      searchQuery: input.searchQuery,
      userId,
      watchCidrs: this.watchCidrs,
      watchAsns: this.watchAsns,
    });

    const counters = await this.inspectCounters({
      clientIp,
      eventType: input.eventType,
      path,
      searchQuery: input.searchQuery,
    });

    const riskScore = Math.min(
      100,
      staticInspection.riskScore + counters.riskScore,
    );
    const reasons = Array.from(
      new Set([...staticInspection.reasons, ...counters.reasons]),
    );
    const action = input.action || actionFromRiskScore(riskScore);

    await this.persistEvent({
      eventType: input.eventType,
      action,
      subjectKey,
      clientIp,
      clientAsn,
      userAgent,
      path,
      method: input.request.method,
      referer,
      acceptLanguage,
      userId,
      searchQuery: input.searchQuery || null,
      entityType: input.entityType || null,
      entityId: input.entityId || null,
      riskScore,
      reasons,
      metadata: {
        ...input.metadata,
        isAllowedSearchCrawler: staticInspection.isAllowedSearchCrawler,
        isBotLike: staticInspection.isBotLike,
        watchedAsns: this.watchAsns,
        counters,
      },
    });

    return { action, riskScore, reasons };
  }

  async getRecentEvents(filters: {
    limit?: number;
    minRisk?: number;
    eventType?: string;
    clientIp?: string;
  }) {
    const limit = Math.min(Math.max(filters.limit || 100, 1), 500);
    const minRisk = Math.min(Math.max(filters.minRisk || 0, 0), 100);

    const rows = await this.db.execute(sql`
      select
        id,
        occurred_at as "occurredAt",
        event_type as "eventType",
        action,
        subject_key as "subjectKey",
        client_ip as "clientIp",
        client_asn as "clientAsn",
        user_agent as "userAgent",
        path,
        method,
        user_id as "userId",
        search_query as "searchQuery",
        entity_type as "entityType",
        entity_id as "entityId",
        risk_score as "riskScore",
        reasons,
        metadata
      from traffic_events
      where risk_score >= ${minRisk}
        and (${filters.eventType || null}::text is null or event_type = ${filters.eventType || null})
        and (${filters.clientIp || null}::text is null or client_ip = ${filters.clientIp || null})
      order by occurred_at desc
      limit ${limit}
    `);

    return this.rows(rows);
  }

  async getSuspiciousSubjects(filters: { hours?: number; limit?: number }) {
    const hours = Math.min(Math.max(filters.hours || 24, 1), 24 * 30);
    const limit = Math.min(Math.max(filters.limit || 100, 1), 500);

    const rows = await this.db.execute(sql`
      select
        subject_key as "subjectKey",
        max(client_ip) as "clientIp",
        max(client_asn) as "clientAsn",
        max(user_id) as "userId",
        count(distinct user_id)::int as "userCount",
        max(user_agent) as "lastUserAgent",
        max(path) as "lastPath",
        min(occurred_at) as "firstSeenAt",
        max(occurred_at) as "lastSeenAt",
        count(*)::int as "events",
        count(*) filter (where event_type = 'comic_search')::int as "searches",
        count(*) filter (where event_type in ('comic_view', 'chapter_view', 'chapter_pages'))::int as "contentViews",
        count(distinct path)::int as "uniquePaths",
        count(distinct search_query)::int as "uniqueSearches",
        max(risk_score)::int as "maxRiskScore",
        avg(risk_score)::float as "avgRiskScore",
        jsonb_agg(distinct reason.value) filter (where reason.value is not null) as reasons
      from traffic_events
      left join lateral jsonb_array_elements_text(traffic_events.reasons) as reason(value) on true
      where occurred_at >= now() - (${hours}::text || ' hours')::interval
      group by subject_key
      having max(risk_score) >= 35 or count(*) >= 80 or count(*) filter (where event_type = 'comic_search') >= 20
      order by max(risk_score) desc, count(*) desc
      limit ${limit}
    `);

    return this.rows(rows);
  }

  private async inspectCounters(input: {
    clientIp: string | null;
    eventType: TrafficEventType;
    path: string;
    searchQuery?: string | null;
  }): Promise<CounterSignals> {
    const keySubject = input.clientIp || 'unknown';
    const minuteEvents = await this.incrementCounter(
      `traffic:${keySubject}:events:1m`,
      60 * 1000,
    );

    let minuteSearches = 0;
    let repeatedSearches = 0;
    let minuteContentViews = 0;
    let repeatedPathHits = 0;
    let riskScore = 0;
    const reasons: string[] = [];

    if (input.eventType === 'comic_search') {
      minuteSearches = await this.incrementCounter(
        `traffic:${keySubject}:searches:1m`,
        60 * 1000,
      );
      if (input.searchQuery) {
        repeatedSearches = await this.incrementCounter(
          `traffic:${keySubject}:search:${hashTrafficSubject(input.searchQuery.toLowerCase())}:10m`,
          10 * 60 * 1000,
        );
      }
    }

    if (['comic_view', 'chapter_view', 'chapter_pages'].includes(input.eventType)) {
      minuteContentViews = await this.incrementCounter(
        `traffic:${keySubject}:content:1m`,
        60 * 1000,
      );
    }

    if (input.path) {
      repeatedPathHits = await this.incrementCounter(
        `traffic:${keySubject}:path:${hashTrafficSubject(input.path)}:5m`,
        5 * 60 * 1000,
      );
    }

    if (minuteEvents > 120) {
      riskScore += 35;
      reasons.push('high_request_rate_1m');
    } else if (minuteEvents > 70) {
      riskScore += 20;
      reasons.push('elevated_request_rate_1m');
    }

    if (minuteSearches > 30) {
      riskScore += 35;
      reasons.push('high_search_rate_1m');
    } else if (minuteSearches > 15) {
      riskScore += 20;
      reasons.push('elevated_search_rate_1m');
    }

    if (minuteContentViews > 80) {
      riskScore += 30;
      reasons.push('high_content_view_rate_1m');
    } else if (minuteContentViews > 45) {
      riskScore += 15;
      reasons.push('elevated_content_view_rate_1m');
    }

    if (repeatedSearches > 8) {
      riskScore += 15;
      reasons.push('repeated_same_search_10m');
    }

    if (repeatedPathHits > 25) {
      riskScore += 15;
      reasons.push('repeated_same_path_5m');
    }

    return {
      minuteEvents,
      minuteSearches,
      minuteContentViews,
      repeatedSearches,
      repeatedPathHits,
      riskScore,
      reasons,
    };
  }

  private async incrementCounter(key: string, ttlMs: number): Promise<number> {
    const store = (this.cacheService as any).cacheManager?.store;
    const client = store?.client;

    if (client) {
      try {
        const count = await client.incr(key);
        if (count === 1) {
          await client.pexpire(key, ttlMs);
        }
        return Number(count) || 0;
      } catch {
        // Fallback below.
      }
    }

    const current = Number((await this.cacheService.get<number>(key)) || 0) + 1;
    await this.cacheService.set(key, current, ttlMs);
    return current;
  }

  private async persistEvent(values: typeof trafficEvents.$inferInsert) {
    if (this.configService.get<string>('TRAFFIC_EVENTS_PERSIST_ENABLED') === 'false') {
      return;
    }

    try {
      await this.db.insert(trafficEvents).values(values);
    } catch (error) {
      const code = (error as { code?: string })?.code;
      if (code === '42P01' || code === '42703') {
        if (!this.tableMissingLogged) {
          this.tableMissingLogged = true;
          console.warn(
            'traffic_events table is missing; run the 0012_traffic_events migration to persist bot learning events.',
          );
        }
        return;
      }
      console.error('Failed to persist traffic event:', error);
    }
  }

  private getRequestPath(request: FastifyRequest): string {
    return request.url?.split('?')[0] || '';
  }

  private readHeader(request: FastifyRequest, name: string): string {
    const value = request.headers[name.toLowerCase()];
    if (Array.isArray(value)) {
      return String(value[0] || '').trim();
    }
    return typeof value === 'string' ? value.trim() : '';
  }

  private getClientAsn(request: FastifyRequest): number | null {
    for (const headerName of [
      'cf-connecting-asn',
      'cf-asn',
      'x-client-asn',
      'x-asn',
      'x-vercel-ip-as-number',
    ]) {
      const raw = this.readHeader(request, headerName);
      const parsed = Number.parseInt(raw.replace(/^AS/i, ''), 10);
      if (Number.isInteger(parsed) && parsed > 0) {
        return parsed;
      }
    }

    return null;
  }

  private rows(result: unknown): unknown[] {
    if (Array.isArray(result)) return result;
    const maybeRows = (result as { rows?: unknown[] })?.rows;
    return Array.isArray(maybeRows) ? maybeRows : [];
  }
}
