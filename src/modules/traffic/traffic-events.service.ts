import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
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
  uniquePaths10m: number;
  uniqueSearches10m: number;
  riskScore: number;
  reasons: string[];
};

type TrafficEventPersistencePayload = typeof trafficEvents.$inferInsert & {
  occurredAt?: Date;
};

type TrafficAggregatePayload = TrafficEventPersistencePayload & {
  uniquePathHit: number;
  uniqueSearchHit: number;
};

const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_RAW_MIN_RISK_SCORE = 35;
const DEFAULT_RAW_SAMPLE_RATE = 0.002; // 0.2% of low-risk traffic, enough for debugging without DB explosion.
const DEFAULT_RAW_RETENTION_DAYS = 2;
const DEFAULT_AGGREGATE_RETENTION_DAYS = 30;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

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

    const uniquePathHit = await this.trackUniqueValue(
      `traffic:${subjectKey}:paths:10m`,
      path,
      10 * 60 * 1000,
    );
    const uniqueSearchHit = input.searchQuery
      ? await this.trackUniqueValue(
          `traffic:${subjectKey}:search-values:10m`,
          input.searchQuery.toLowerCase(),
          10 * 60 * 1000,
        )
      : 0;

    const eventPayload: TrafficEventPersistencePayload = {
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
    };

    await this.persistAggregate({
      ...eventPayload,
      uniquePathHit,
      uniqueSearchHit,
    });

    if (await this.shouldPersistRawEvent(eventPayload)) {
      await this.persistEvent(eventPayload);
    }

    void this.cleanupOldTrafficData();

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
        max(last_path) as "lastPath",
        min(first_seen_at) as "firstSeenAt",
        max(last_seen_at) as "lastSeenAt",
        sum(total_events)::int as "events",
        sum(search_events)::int as "searches",
        sum(content_events)::int as "contentViews",
        sum(lookup_events)::int as "lookupEvents",
        sum(unique_path_hits)::int as "uniquePaths",
        sum(unique_search_hits)::int as "uniqueSearches",
        max(max_risk_score)::int as "maxRiskScore",
        (sum(risk_score_sum)::float / nullif(sum(risk_samples), 0))::float as "avgRiskScore",
        jsonb_agg(distinct reason.value) filter (where reason.value is not null) as reasons
      from traffic_subject_windows
      left join lateral jsonb_array_elements_text(traffic_subject_windows.reasons) as reason(value) on true
      where window_start >= date_trunc('hour', now() - (${hours}::text || ' hours')::interval)
      group by subject_key
      having max(max_risk_score) >= 35
        or sum(total_events) >= 80
        or sum(search_events) >= 20
        or sum(unique_path_hits) >= 40
        or sum(unique_search_hits) >= 15
      order by max(max_risk_score) desc, sum(total_events) desc
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
    let uniquePaths10m = 0;
    let uniqueSearches10m = 0;
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
        uniqueSearches10m = await this.trackUniqueValue(
          `traffic:${keySubject}:unique-searches:10m`,
          input.searchQuery.toLowerCase(),
          10 * 60 * 1000,
          true,
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
      uniquePaths10m = await this.trackUniqueValue(
        `traffic:${keySubject}:unique-paths:10m`,
        input.path,
        10 * 60 * 1000,
        true,
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

    if (uniquePaths10m > 60) {
      riskScore += 35;
      reasons.push('high_unique_path_crawl_10m');
    } else if (uniquePaths10m > 30) {
      riskScore += 20;
      reasons.push('elevated_unique_path_crawl_10m');
    }

    if (uniqueSearches10m > 30) {
      riskScore += 35;
      reasons.push('high_unique_search_burst_10m');
    } else if (uniqueSearches10m > 15) {
      riskScore += 20;
      reasons.push('elevated_unique_search_burst_10m');
    }

    return {
      minuteEvents,
      minuteSearches,
      minuteContentViews,
      repeatedSearches,
      repeatedPathHits,
      uniquePaths10m,
      uniqueSearches10m,
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

  private async trackUniqueValue(
    key: string,
    value: string | null | undefined,
    ttlMs: number,
    returnCardinality = false,
  ): Promise<number> {
    if (!value) {
      return 0;
    }

    const store = (this.cacheService as any).cacheManager?.store;
    const client = store?.client;
    if (!client) {
      return returnCardinality ? 0 : 1;
    }

    try {
      const added = Number(await client.sadd(key, value)) || 0;
      if (added) {
        await client.pexpire(key, ttlMs);
      }

      if (returnCardinality) {
        return Number(await client.scard(key)) || 0;
      }

      return added > 0 ? 1 : 0;
    } catch {
      return returnCardinality ? 0 : 1;
    }
  }

  private getWindowStart(date = new Date()): Date {
    return new Date(Math.floor(date.getTime() / HOUR_MS) * HOUR_MS);
  }

  private readIntConfig(name: string, fallback: number): number {
    const parsed = Number.parseInt(this.configService.get<string>(name) || '', 10);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  private readFloatConfig(name: string, fallback: number): number {
    const parsed = Number.parseFloat(this.configService.get<string>(name) || '');
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  private async shouldPersistRawEvent(values: TrafficEventPersistencePayload): Promise<boolean> {
    if (this.configService.get<string>('TRAFFIC_EVENTS_PERSIST_ENABLED') === 'false') {
      return false;
    }

    const minRisk = this.readIntConfig(
      'TRAFFIC_RAW_MIN_RISK_SCORE',
      DEFAULT_RAW_MIN_RISK_SCORE,
    );
    const throttleMs = this.readIntConfig('TRAFFIC_RAW_THROTTLE_MS', 30 * 1000);
    const riskScore = Number(values.riskScore || 0);
    const isImportant =
      riskScore >= minRisk || values.action !== 'allow';

    if (!isImportant) {
      const sampleRate = Math.min(
        Math.max(
          this.readFloatConfig('TRAFFIC_RAW_SAMPLE_RATE', DEFAULT_RAW_SAMPLE_RATE),
          0,
        ),
        1,
      );
      if (sampleRate <= 0 || Math.random() > sampleRate) {
        return false;
      }
    }

    const riskBand = riskScore >= 70 ? 'high' : riskScore >= 35 ? 'medium' : 'low';
    const throttleKey = [
      'traffic:raw',
      values.subjectKey,
      values.eventType,
      values.action,
      riskBand,
    ].join(':');

    return (await this.incrementCounter(throttleKey, throttleMs)) === 1;
  }

  private async persistAggregate(values: TrafficAggregatePayload) {
    if (this.configService.get<string>('TRAFFIC_EVENTS_PERSIST_ENABLED') === 'false') {
      return;
    }

    const windowStart = this.getWindowStart(values.occurredAt || new Date());
    const isSearch = values.eventType === 'comic_search' ? 1 : 0;
    const isContent = ['comic_view', 'chapter_view', 'chapter_pages'].includes(values.eventType) ? 1 : 0;
    const isLookup = ['comic_lookup', 'chapter_lookup'].includes(values.eventType) ? 1 : 0;

    try {
      await this.db.execute(sql`
        insert into traffic_subject_windows (
          subject_key,
          window_start,
          client_ip,
          client_asn,
          user_agent,
          user_id,
          last_path,
          last_search_query,
          total_events,
          search_events,
          content_events,
          lookup_events,
          unique_path_hits,
          unique_search_hits,
          max_risk_score,
          risk_score_sum,
          risk_samples,
          reasons,
          first_seen_at,
          last_seen_at,
          metadata
        )
        values (
          ${values.subjectKey},
          ${windowStart},
          ${values.clientIp || null},
          ${values.clientAsn || null},
          ${values.userAgent || null},
          ${values.userId || null},
          ${values.path || null},
          ${values.searchQuery || null},
          1,
          ${isSearch},
          ${isContent},
          ${isLookup},
          ${values.uniquePathHit},
          ${values.uniqueSearchHit},
          ${values.riskScore},
          ${values.riskScore},
          1,
          ${JSON.stringify(values.reasons || [])}::jsonb,
          coalesce(${values.occurredAt || null}, now()),
          coalesce(${values.occurredAt || null}, now()),
          ${JSON.stringify({
            lastEventType: values.eventType,
            lastAction: values.action,
            lastEntityType: values.entityType,
            lastEntityId: values.entityId,
          })}::jsonb
        )
        on conflict (subject_key, window_start) do update set
          client_ip = coalesce(excluded.client_ip, traffic_subject_windows.client_ip),
          client_asn = coalesce(excluded.client_asn, traffic_subject_windows.client_asn),
          user_agent = coalesce(excluded.user_agent, traffic_subject_windows.user_agent),
          user_id = coalesce(excluded.user_id, traffic_subject_windows.user_id),
          last_path = coalesce(excluded.last_path, traffic_subject_windows.last_path),
          last_search_query = coalesce(excluded.last_search_query, traffic_subject_windows.last_search_query),
          total_events = traffic_subject_windows.total_events + excluded.total_events,
          search_events = traffic_subject_windows.search_events + excluded.search_events,
          content_events = traffic_subject_windows.content_events + excluded.content_events,
          lookup_events = traffic_subject_windows.lookup_events + excluded.lookup_events,
          unique_path_hits = traffic_subject_windows.unique_path_hits + excluded.unique_path_hits,
          unique_search_hits = traffic_subject_windows.unique_search_hits + excluded.unique_search_hits,
          max_risk_score = greatest(traffic_subject_windows.max_risk_score, excluded.max_risk_score),
          risk_score_sum = traffic_subject_windows.risk_score_sum + excluded.risk_score_sum,
          risk_samples = traffic_subject_windows.risk_samples + excluded.risk_samples,
          reasons = (
            select coalesce(jsonb_agg(distinct value), '[]'::jsonb)
            from jsonb_array_elements_text(traffic_subject_windows.reasons || excluded.reasons) as reason(value)
          ),
          last_seen_at = greatest(traffic_subject_windows.last_seen_at, excluded.last_seen_at),
          metadata = traffic_subject_windows.metadata || excluded.metadata
      `);
    } catch (error) {
      this.handleTrafficStorageError(error, 'traffic_subject_windows table is missing; run the 0013 traffic rollups migration.');
    }
  }

  private async persistEvent(values: TrafficEventPersistencePayload) {
    if (this.configService.get<string>('TRAFFIC_EVENTS_PERSIST_ENABLED') === 'false') {
      return;
    }

    try {
      await this.db.insert(trafficEvents).values(values);
    } catch (error) {
      this.handleTrafficStorageError(
        error,
        'traffic_events table is missing; run the 0012 traffic events migration.',
      );
    }
  }

  private handleTrafficStorageError(error: unknown, missingMessage: string) {
    const code = (error as { code?: string })?.code;
    if (code === '42P01' || code === '42703') {
      if (!this.tableMissingLogged) {
        this.tableMissingLogged = true;
        console.warn(missingMessage);
      }
      return;
    }
    console.error('Failed to persist traffic data:', error);
  }

  @Interval(CLEANUP_INTERVAL_MS)
  async cleanupOldTrafficData() {
    if (this.configService.get<string>('TRAFFIC_EVENTS_PERSIST_ENABLED') === 'false') {
      return;
    }

    const lockKey = 'traffic:cleanup:lock';
    if ((await this.incrementCounter(lockKey, CLEANUP_INTERVAL_MS)) !== 1) {
      return;
    }

    const rawRetentionDays = Math.max(
      this.readIntConfig('TRAFFIC_RAW_RETENTION_DAYS', DEFAULT_RAW_RETENTION_DAYS),
      1,
    );
    const aggregateRetentionDays = Math.max(
      this.readIntConfig(
        'TRAFFIC_AGGREGATE_RETENTION_DAYS',
        DEFAULT_AGGREGATE_RETENTION_DAYS,
      ),
      rawRetentionDays,
    );

    try {
      await this.db.execute(sql`
        delete from traffic_events
        where occurred_at < now() - (${rawRetentionDays}::text || ' days')::interval
           or (risk_score < 35 and occurred_at < now() - interval '6 hours')
      `);
      await this.db.execute(sql`
        delete from traffic_subject_windows
        where window_start < date_trunc('hour', now() - (${aggregateRetentionDays}::text || ' days')::interval)
      `);
    } catch (error) {
      this.handleTrafficStorageError(error, 'traffic storage tables are missing; run traffic migrations.');
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
