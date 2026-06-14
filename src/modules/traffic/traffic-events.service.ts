import { Inject, Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import type { FastifyRequest } from 'fastify';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { CacheService } from '@/cache/cache.service';
import { getRequestClientIp } from '@/common/network/client-ip';
import { parseTrustedRefererOrigins } from '@/lib/cors-origins';
import { isDatabaseConnectionError } from '@/lib/db-pool';
import { SessionResolverService } from '@/modules/auth/session-resolver';
import { RouteProtectionService } from '@/modules/route-protection/route-protection.service';
import { DATABASE_CONNECTION } from '@/database/database.module';
import { trafficEvents } from '@/database/schema';
import type * as schema from '@/database/schema';
import {
  actionFromRiskScore,
  hashTrafficSubject,
  inspectTrafficEvent,
  isInternalIp,
  isIpInAnyCidr,
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
  thirtySecondEvents: number;
  thirtySecondSearches: number;
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

type BlockedSubjectStatus = 'active' | 'unblocked' | 'expired' | 'all';

type BlockedSubjectsSummary = {
  active: number;
  expired: number;
  unblocked: number;
  expiringSoon: number;
};

const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_RAW_MIN_RISK_SCORE = 35;
const DEFAULT_RAW_SAMPLE_RATE = 0.002; // 0.2% of low-risk traffic, enough for debugging without DB explosion.
const DEFAULT_RAW_RETENTION_DAYS = 2;
const DEFAULT_AGGREGATE_RETENTION_DAYS = 30;
const DEFAULT_BLOCK_TTL_HOURS = 1;
const DEFAULT_MAX_REQUESTS_PER_30S = 200;
const DEFAULT_MAX_SEARCHES_PER_30S = 10;
const DEFAULT_BLOCK_MAX_REQUESTS_PER_30S = 400;
const DEFAULT_BLOCK_MAX_SEARCHES_PER_30S = 35;
const DEFAULT_HUMAN_BLOCK_BONUS_MULTIPLIER = 2;
const DEFAULT_AUTHENTICATED_BLOCK_BONUS_MULTIPLIER = 2;
const LOOKUP_EVENT_TYPES = new Set<TrafficEventType>([
  'comic_lookup',
  'chapter_lookup',
]);
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_BLOCKED_SUBJECTS_LIMIT = 100;
const MAX_BLOCKED_SUBJECTS_LIMIT = 500;
const BLOCKED_SUBJECT_CACHE_TTL_MS = 60_000;
const DEFAULT_TRAFFIC_PERSIST_CONCURRENCY = 3;

@Injectable()
export class TrafficEventsService {
  private readonly watchCidrs: string[];
  private readonly watchAsns: number[];
  private readonly allowCidrs: string[];
  private readonly allowIps: string[];
  private readonly allowAsns: number[];
  private readonly trustedRefererOrigins: string[];
  private tableMissingLogged = false;
  private lastConnectionErrorLogAt = 0;
  private trafficPersistInFlight = 0;
  private trafficPersistWaiters: Array<() => void> = [];

  constructor(
    @Inject(DATABASE_CONNECTION)
    private readonly db: NodePgDatabase<typeof schema>,
    private readonly cacheService: CacheService,
    private readonly configService: ConfigService,
    private readonly sessionResolver: SessionResolverService,
    private readonly routeProtectionService: RouteProtectionService,
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
    this.allowCidrs = parseCsvList(this.configService.get<string>('BOT_ALLOW_IP_CIDRS'));
    this.allowIps = parseCsvList(this.configService.get<string>('BOT_ALLOW_IPS'));
    this.allowAsns = parseAsnList(this.configService.get<string>('BOT_ALLOW_ASNS'));
    this.trustedRefererOrigins = parseTrustedRefererOrigins(
      this.configService.get<string>('TRUSTED_REFERER_ORIGINS') ||
        this.configService.get<string>('CORS_ORIGIN'),
    );
  }

  async record(input: RecordTrafficInput) {
    if (this.configService.get<string>('TRAFFIC_EVENTS_ENABLED') === 'false') {
      return {
        action: 'allow' as TrafficAction,
        blocked: false,
        riskScore: 0,
        reasons: [] as string[],
      };
    }

    const clientIp = getRequestClientIp(input.request);
    const clientAsn = this.getClientAsn(input.request);
    const userAgent = this.readHeader(input.request, 'user-agent');
    const referer = this.readHeader(input.request, 'referer') || this.readHeader(input.request, 'referrer');
    const acceptLanguage = this.readHeader(input.request, 'accept-language');
    const session = await this.sessionResolver.resolveSession(input.request.headers);
    const userId = session?.user.id || null;
    const hasInternalAccess = this.routeProtectionService.hasInternalAccess(
      input.request.headers,
    );
    const path = input.path || this.getRequestPath(input.request);
    const subjectSource = clientIp || userAgent || 'unknown';
    const subjectKey = hashTrafficSubject(subjectSource);

    if (clientIp && isInternalIp(clientIp)) {
      return {
        action: 'allow' as TrafficAction,
        blocked: false,
        riskScore: 0,
        reasons: ['internal_origin_ip'],
      };
    }

    if (this.isAllowedInfrastructure(clientIp, clientAsn)) {
      return {
        action: 'allow' as TrafficAction,
        blocked: false,
        riskScore: 0,
        reasons: ['allowed_network'],
      };
    }

    const activeBlock = await this.getActiveBlockedSubject(subjectKey);
    if (activeBlock) {
      if (this.shouldHonorActiveBlock(activeBlock)) {
        this.enqueueTrafficPersistTask(() =>
          this.touchBlockedSubject(subjectKey, {
            clientIp,
            clientAsn,
            userAgent,
            path,
            eventType: input.eventType,
            entityType: input.entityType || null,
            entityId: input.entityId || null,
          }),
        );

        return {
          action: 'rate_limited' as TrafficAction,
          blocked: true,
          riskScore: activeBlock.riskScore || 100,
          reasons: ['temporary_bot_block', ...(activeBlock.reasons || [])],
        };
      }

      this.enqueueTrafficPersistTask(() =>
        this.expireIgnoredActiveBlock(subjectKey, activeBlock.reasons),
      );
    }

    const staticInspection = inspectTrafficEvent({
      eventType: input.eventType,
      clientIp,
      clientAsn,
      userAgent,
      referer,
      path,
      searchQuery: input.searchQuery,
      userId,
      watchCidrs: this.watchCidrs,
      watchAsns: this.watchAsns,
      allowCidrs: this.allowCidrs,
      allowIps: this.allowIps,
      allowAsns: this.allowAsns,
      trustedRefererOrigins: this.trustedRefererOrigins,
      hasInternalAccess,
    });

    const counters = await this.inspectCounters({
      clientIp,
      eventType: input.eventType,
      path,
      searchQuery: input.searchQuery,
      metadata: input.metadata,
      userId,
    });

    const riskScore = Math.min(
      100,
      staticInspection.riskScore + counters.riskScore,
    );
    const reasons = Array.from(
      new Set([...staticInspection.reasons, ...counters.reasons]),
    );
    let shouldBlock = await this.shouldBlockRequest({
      action: input.action,
      counters,
      staticInspection,
      riskScore,
      userId,
      clientIp,
    });
    if (shouldBlock && await this.isManuallyUnblockedSubject(subjectKey)) {
      shouldBlock = false;
      reasons.push('manually_unblocked');
    }
    const action = shouldBlock
      ? 'rate_limited'
      : input.action || actionFromRiskScore(riskScore);

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
        blocked: shouldBlock,
        watchedAsns: this.watchAsns,
        counters,
      },
    };

    if (shouldBlock) {
      await this.cacheService.set(
        this.blockedSubjectCacheKey(subjectKey),
        { riskScore, reasons },
        this.getBlockTtlHours() * HOUR_MS,
      );
    }

    this.enqueueTrafficPersistence({
      eventPayload,
      uniquePathHit,
      uniqueSearchHit,
      shouldBlock,
    });

    return { action, blocked: shouldBlock, riskScore, reasons };
  }

  createBlockedException(): NotFoundException {
    return new NotFoundException('Not found');
  }

  private async shouldBlockRequest(input: {
    action?: TrafficAction;
    counters: CounterSignals;
    staticInspection: {
      isAllowedSearchCrawler: boolean;
      isAllowedNetwork: boolean;
      isInternalIp: boolean;
      isWatchlistedDatacenter: boolean;
    };
    riskScore: number;
    userId?: string | null;
    clientIp?: string | null;
  }): Promise<boolean> {
    if (input.action === 'rate_limited') {
      return true;
    }

    if (
      input.staticInspection.isAllowedSearchCrawler ||
      input.staticInspection.isAllowedNetwork ||
      input.staticInspection.isInternalIp
    ) {
      return false;
    }

    if (this.configService.get<string>('BOT_BLOCK_FAST_REQUESTS') === 'false') {
      return false;
    }

    const ipKey = input.clientIp || 'unknown';
    const limitMultiplier = await this.resolveBlockLimitMultiplier(
      ipKey,
      input.userId,
    );
    const blockMaxRequestsPer30s = Math.ceil(
      this.readIntConfig(
        'BOT_BLOCK_MAX_REQUESTS_PER_30S',
        DEFAULT_BLOCK_MAX_REQUESTS_PER_30S,
      ) * limitMultiplier,
    );
    const blockMaxSearchesPer30s = Math.ceil(
      this.readIntConfig(
        'BOT_BLOCK_MAX_SEARCHES_PER_30S',
        DEFAULT_BLOCK_MAX_SEARCHES_PER_30S,
      ) * limitMultiplier,
    );

    const hardSearchBurst =
      input.counters.thirtySecondSearches > blockMaxSearchesPer30s;
    const hardRequestBurst =
      input.counters.thirtySecondEvents > blockMaxRequestsPer30s;
    const isHumanEngaged = await this.hasRecentHumanEngagement(ipKey);

    // Authenticated readers bingeing chapters should not get fake-404 blocks from
    // request volume alone. Search bursts remain protected even when logged in.
    if (hardSearchBurst) {
      return true;
    }

    if (hardRequestBurst) {
      if (isHumanEngaged) {
        return false;
      }
      return true;
    }

    return false;
  }

  private isAllowedInfrastructure(
    clientIp: string | null,
    clientAsn: number | null,
  ): boolean {
    if (clientIp && this.allowIps.includes(clientIp)) {
      return true;
    }

    if (isIpInAnyCidr(clientIp, this.allowCidrs)) {
      return true;
    }

    return Boolean(clientAsn && this.allowAsns.includes(clientAsn));
  }

  async getRecentEvents(filters: {
    limit?: number;
    minRisk?: number;
    eventType?: string;
    clientIp?: string;
  }) {
    const limit = Math.min(Math.max(filters.limit || 100, 1), 500);
    const minRisk = Math.min(Math.max(filters.minRisk || 0, 0), 100);

    try {
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
    } catch (error) {
      this.throwTrafficQueryError(
        'No se pudieron cargar eventos recientes. Ejecuta la migración 0012_traffic_events.sql en monline-api.',
        error,
        '0012_traffic_events.sql',
      );
    }
  }

  async getSuspiciousSubjects(filters: { hours?: number; limit?: number }) {
    const hours = Math.min(Math.max(filters.hours || 24, 1), 24 * 30);
    const limit = Math.min(Math.max(filters.limit || 100, 1), 500);

    try {
      const result = await this.db.transaction(async (tx) => {
        await tx.execute(sql`set local statement_timeout = '30s'`);

        return tx.execute(sql`
          with subject_stats as (
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
              sum(unique_path_hits)::int as "uniquePaths",
              sum(unique_search_hits)::int as "uniqueSearches",
              max(max_risk_score)::int as "maxRiskScore",
              (sum(risk_score_sum)::float / nullif(sum(risk_samples), 0))::float as "avgRiskScore"
            from traffic_subject_windows
            where window_start >= date_trunc('hour', now() - (${hours}::text || ' hours')::interval)
              and (
                max_risk_score >= 35
                or total_events >= 20
                or search_events >= 5
                or unique_path_hits >= 10
                or unique_search_hits >= 5
              )
            group by subject_key
            having max(max_risk_score) >= 35
              or sum(total_events) >= 80
              or sum(search_events) >= 20
              or sum(unique_path_hits) >= 40
              or sum(unique_search_hits) >= 15
            order by max(max_risk_score) desc, sum(total_events) desc
            limit ${limit}
          )
          select
            s."subjectKey",
            s."clientIp",
            s."clientAsn",
            s."userId",
            s."userCount",
            s."lastUserAgent",
            s."lastPath",
            s."firstSeenAt",
            s."lastSeenAt",
            s."events",
            s."searches",
            s."contentViews",
            s."uniquePaths",
            s."uniqueSearches",
            s."maxRiskScore",
            s."avgRiskScore",
            coalesce((
              select jsonb_agg(distinct reason.value)
              from traffic_subject_windows t
              cross join lateral jsonb_array_elements_text(t.reasons) as reason(value)
              where t.subject_key = s."subjectKey"
                and t.window_start >= date_trunc('hour', now() - (${hours}::text || ' hours')::interval)
            ), '[]'::jsonb) as reasons
          from subject_stats s
        `);
      });

      return this.rows(result);
    } catch (error) {
      this.throwTrafficQueryError(
        'No se pudo cargar sujetos sospechosos. Prueba un periodo más corto o ejecuta las migraciones 0013_traffic_rollups.sql y 0016_traffic_suspicious_query_idx.sql.',
        error,
        '0013_traffic_rollups.sql',
      );
    }
  }

  async getBlockedSubjects(filters: { status?: string; limit?: number; offset?: number; q?: string }) {
    const requestedStatus = filters.status || 'active';
    const status: BlockedSubjectStatus = ['active', 'unblocked', 'expired', 'all'].includes(requestedStatus)
      ? requestedStatus as BlockedSubjectStatus
      : 'active';
    const limit = Math.min(
      Math.max(filters.limit || DEFAULT_BLOCKED_SUBJECTS_LIMIT, 1),
      MAX_BLOCKED_SUBJECTS_LIMIT,
    );
    const offset = Math.max(filters.offset || 0, 0);
    const search = (filters.q || '').trim();
    const searchPattern = search ? `%${search}%` : null;
    const statusFilter = this.buildBlockedStatusFilter(status);

    try {
      const [summaryResult, countResult] = await Promise.all([
        this.db.execute(sql`
          select
            count(*) filter (where status = 'active')::int as "active",
            count(*) filter (where status = 'expired')::int as "expired",
            count(*) filter (where status = 'unblocked')::int as "unblocked",
            count(*) filter (
              where status = 'active'
                and blocked_until is not null
                and blocked_until > now()
                and blocked_until <= now() + interval '1 hour'
            )::int as "expiringSoon"
          from traffic_blocked_subjects
        `),
        this.db.execute(sql`
          select count(*)::int as total
          from traffic_blocked_subjects
          where ${statusFilter}
            and (
              ${searchPattern}::text is null
              or client_ip ilike ${searchPattern}
              or subject_key ilike ${searchPattern}
              or coalesce(user_agent, '') ilike ${searchPattern}
              or coalesce(block_reason, '') ilike ${searchPattern}
              or status ilike ${searchPattern}
              or coalesce(client_asn::text, '') ilike ${searchPattern}
              or reasons::text ilike ${searchPattern}
            )
        `),
      ]);

      const [summaryRow] = this.rows(summaryResult) as BlockedSubjectsSummary[];
      const [countRow] = this.rows(countResult) as Array<{ total?: number }>;

      const rows = await this.db.execute(sql`
        select
          subject_key as "subjectKey",
          client_ip as "clientIp",
          client_asn as "clientAsn",
          user_agent as "userAgent",
          status,
          block_reason as "blockReason",
          reasons,
          risk_score as "riskScore",
          first_blocked_at as "firstBlockedAt",
          last_blocked_at as "lastBlockedAt",
          blocked_until as "blockedUntil",
          blocked_count as "blockedCount",
          unblocked_at as "unblockedAt",
          unblocked_by as "unblockedBy",
          unblock_reason as "unblockReason",
          metadata
        from traffic_blocked_subjects
        where ${statusFilter}
          and (
            ${searchPattern}::text is null
            or client_ip ilike ${searchPattern}
            or subject_key ilike ${searchPattern}
            or coalesce(user_agent, '') ilike ${searchPattern}
            or coalesce(block_reason, '') ilike ${searchPattern}
            or status ilike ${searchPattern}
            or coalesce(client_asn::text, '') ilike ${searchPattern}
            or reasons::text ilike ${searchPattern}
          )
        order by
          case when status = 'active' then 0 else 1 end,
          last_blocked_at desc
        limit ${limit}
        offset ${offset}
      `);

      return {
        items: this.rows(rows),
        total: Number(countRow?.total || 0),
        limit,
        offset,
        summary: {
          active: Number(summaryRow?.active || 0),
          expired: Number(summaryRow?.expired || 0),
          unblocked: Number(summaryRow?.unblocked || 0),
          expiringSoon: Number(summaryRow?.expiringSoon || 0),
        },
      };
    } catch (error) {
      this.throwTrafficQueryError(
        'No se pudieron cargar bloqueos. Ejecuta las migraciones 0014_traffic_blocked_subjects.sql y 0015_traffic_block_ttl.sql.',
        error,
        '0014_traffic_blocked_subjects.sql',
      );
    }
  }

  async unblockBlockedSubject(
    subjectKey: string,
    input: { actorId?: string | null; reason?: string | null },
  ) {
    try {
      const result = await this.db.execute(sql`
        update traffic_blocked_subjects
        set
          status = 'unblocked',
          blocked_until = null,
          unblocked_at = now(),
          unblocked_by = ${input.actorId || null},
          unblock_reason = ${input.reason || null}
        where subject_key = ${subjectKey}
        returning
          subject_key as "subjectKey",
          client_ip as "clientIp",
          client_asn as "clientAsn",
          user_agent as "userAgent",
          status,
          block_reason as "blockReason",
          reasons,
          risk_score as "riskScore",
          first_blocked_at as "firstBlockedAt",
          last_blocked_at as "lastBlockedAt",
          blocked_until as "blockedUntil",
          blocked_count as "blockedCount",
          unblocked_at as "unblockedAt",
          unblocked_by as "unblockedBy",
          unblock_reason as "unblockReason",
          metadata
      `);
      const [row] = this.rows(result);
      if (!row) {
        throw new NotFoundException('Blocked subject not found');
      }

      return row;
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw error;
      }
      this.handleTrafficStorageError(error, 'traffic_blocked_subjects table is missing; run the 0014 blocked subjects migration.');
      throw new NotFoundException('Blocked subject not found');
    }
  }

  async unblockAllActiveBlockedSubjects(input: {
    actorId?: string | null;
    reason?: string | null;
  }) {
    try {
      const result = await this.db.execute(sql`
        update traffic_blocked_subjects
        set
          status = 'unblocked',
          blocked_until = null,
          unblocked_at = now(),
          unblocked_by = ${input.actorId || null},
          unblock_reason = ${input.reason || 'mass_unblock'}
        where status = 'active'
        returning subject_key as "subjectKey"
      `);

      return {
        unblocked: this.rows(result).length,
      };
    } catch (error) {
      this.handleTrafficStorageError(error, 'traffic_blocked_subjects table is missing; run the 0014 blocked subjects migration.');
      return { unblocked: 0 };
    }
  }

  private async inspectCounters(input: {
    clientIp: string | null;
    eventType: TrafficEventType;
    path: string;
    searchQuery?: string | null;
    metadata?: Record<string, unknown>;
    userId?: string | null;
  }): Promise<CounterSignals> {
    const keySubject = input.clientIp || 'unknown';
    const isLookupEvent = LOOKUP_EVENT_TYPES.has(input.eventType);
    const thirtySecondEvents = isLookupEvent
      ? 0
      : await this.incrementCounter(
          `traffic:${keySubject}:events:30s`,
          30 * 1000,
        );
    const minuteEvents = isLookupEvent
      ? 0
      : await this.incrementCounter(
          `traffic:${keySubject}:events:1m`,
          60 * 1000,
        );

    let thirtySecondSearches = 0;
    let minuteSearches = 0;
    let repeatedSearches = 0;
    let minuteContentViews = 0;
    let repeatedPathHits = 0;
    let uniquePaths10m = 0;
    let uniqueSearches10m = 0;
    let riskScore = 0;
    const reasons: string[] = [];
    const page = Number(input.metadata?.page);
    const isSearchPagination =
      input.eventType === 'comic_search' &&
      Number.isFinite(page) &&
      page > 1;

    if (input.eventType === 'comic_search' && !isSearchPagination) {
      thirtySecondSearches = await this.incrementCounter(
        `traffic:${keySubject}:searches:30s`,
        30 * 1000,
      );
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
      await this.markHumanEngagement(keySubject);
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

    const maxRequestsPer30s = this.readIntConfig(
      'BOT_MAX_REQUESTS_PER_30S',
      DEFAULT_MAX_REQUESTS_PER_30S,
    );
    const maxSearchesPer30s = this.readIntConfig(
      'BOT_MAX_SEARCHES_PER_30S',
      DEFAULT_MAX_SEARCHES_PER_30S,
    );
    const limitMultiplier = await this.resolveBlockLimitMultiplier(
      keySubject,
      input.userId,
    );
    const blockMaxRequestsPer30s = Math.ceil(
      this.readIntConfig(
        'BOT_BLOCK_MAX_REQUESTS_PER_30S',
        DEFAULT_BLOCK_MAX_REQUESTS_PER_30S,
      ) * limitMultiplier,
    );
    const blockMaxSearchesPer30s = Math.ceil(
      this.readIntConfig(
        'BOT_BLOCK_MAX_SEARCHES_PER_30S',
        DEFAULT_BLOCK_MAX_SEARCHES_PER_30S,
      ) * limitMultiplier,
    );
    if (thirtySecondEvents > maxRequestsPer30s) {
      riskScore += 50;
      reasons.push('too_many_requests_30s');
    }
    if (thirtySecondSearches > maxSearchesPer30s) {
      riskScore += 50;
      reasons.push('too_many_searches_30s');
    }
    if (thirtySecondEvents > blockMaxRequestsPer30s) {
      reasons.push('hard_request_burst_30s');
    }
    if (thirtySecondSearches > blockMaxSearchesPer30s) {
      reasons.push('hard_search_burst_30s');
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
      thirtySecondEvents,
      thirtySecondSearches,
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

  private async markHumanEngagement(subjectKey: string): Promise<void> {
    const ttlMs = this.readIntConfig('SEARCH_ENGAGEMENT_TTL_MS', 5 * 60 * 1000);
    await this.cacheService.set(`human:${subjectKey}:engaged`, true, ttlMs);
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

  private async resolveBlockLimitMultiplier(
    ipKey: string,
    userId?: string | null,
  ): Promise<number> {
    const isHumanEngaged = await this.hasRecentHumanEngagement(ipKey);
    return this.getBlockLimitMultiplier({
      isHumanEngaged,
      isAuthenticated: Boolean(userId),
    });
  }

  private getBlockLimitMultiplier(input: {
    isHumanEngaged: boolean;
    isAuthenticated: boolean;
  }): number {
    let multiplier = 1;

    if (input.isHumanEngaged) {
      multiplier *= this.readIntConfig(
        'BOT_HUMAN_ENGAGEMENT_BONUS',
        DEFAULT_HUMAN_BLOCK_BONUS_MULTIPLIER,
      );
    }

    if (input.isAuthenticated) {
      multiplier *= this.readIntConfig(
        'BOT_AUTHENTICATED_BONUS',
        DEFAULT_AUTHENTICATED_BLOCK_BONUS_MULTIPLIER,
      );
    }

    return Math.max(1, multiplier);
  }

  private async incrementCounter(key: string, ttlMs: number): Promise<number> {
    const client = this.cacheService.getRedisClient();

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

    const client = this.cacheService.getRedisClient();
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

  private async isManuallyUnblockedSubject(subjectKey: string): Promise<boolean> {
    const cacheKey = this.manualUnblockCacheKey(subjectKey);
    const cached = await this.cacheService.get<boolean>(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    try {
      const result = await this.db.execute(sql`
        select status
        from traffic_blocked_subjects
        where subject_key = ${subjectKey}
        limit 1
      `);
      const [row] = this.rows(result) as Array<{ status?: string }>;
      const isUnblocked = row?.status === 'unblocked';
      await this.cacheService.set(cacheKey, isUnblocked, BLOCKED_SUBJECT_CACHE_TTL_MS);
      return isUnblocked;
    } catch (error) {
      this.handleTrafficStorageError(error, 'traffic_blocked_subjects table is missing; run the 0014 blocked subjects migration.');
      return false;
    }
  }

  private shouldHonorActiveBlock(activeBlock: { reasons: string[] }): boolean {
    if (this.configService.get<string>('BOT_HONOR_TEMP_BLOCKS') === 'false') {
      return false;
    }

    // Ignore stale blocks created by the old aggressive heuristics so normal users are not
    // kept behind fake 404s after deploy. New automatic blocks carry this reason.
    return (
      activeBlock.reasons.includes('hard_request_burst_30s') ||
      activeBlock.reasons.includes('hard_search_burst_30s')
    );
  }

  private getBlockTtlHours(): number {
    return Math.max(
      this.readIntConfig('BOT_BLOCK_TTL_HOURS', DEFAULT_BLOCK_TTL_HOURS),
      1,
    );
  }

  private async expireIgnoredActiveBlock(subjectKey: string, reasons: string[]) {
    try {
      await this.db.execute(sql`
        update traffic_blocked_subjects
        set
          status = 'expired',
          metadata = metadata || ${JSON.stringify({
            expiredBy: 'ignored_legacy_or_soft_rate_limit_block',
            previousReasons: reasons,
          })}::jsonb
        where subject_key = ${subjectKey}
          and status = 'active'
      `);
    } catch (error) {
      this.handleTrafficStorageError(error, 'traffic_blocked_subjects table is missing; run the 0015 block TTL migration.');
    }
  }

  private async getActiveBlockedSubject(subjectKey: string): Promise<{
    riskScore: number;
    reasons: string[];
  } | null> {
    const cacheKey = this.blockedSubjectCacheKey(subjectKey);
    const cached = await this.cacheService.get<{
      riskScore: number;
      reasons: string[];
    } | null>(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    try {
      const result = await this.db.execute(sql`
        select
          risk_score as "riskScore",
          reasons
        from traffic_blocked_subjects
        where subject_key = ${subjectKey}
          and status = 'active'
          and blocked_until > now()
        limit 1
      `);
      const [row] = this.rows(result) as Array<{
        riskScore?: number;
        reasons?: string[];
      }>;

      const activeBlock = row
        ? {
            riskScore: Number(row.riskScore || 100),
            reasons: Array.isArray(row.reasons) ? row.reasons : [],
          }
        : null;

      await this.cacheService.set(cacheKey, activeBlock, BLOCKED_SUBJECT_CACHE_TTL_MS);
      return activeBlock;
    } catch (error) {
      this.handleTrafficStorageError(error, 'traffic_blocked_subjects table is missing; run the 0015 block TTL migration.');
      return null;
    }
  }

  private async touchBlockedSubject(
    subjectKey: string,
    values: {
      clientIp: string | null;
      clientAsn: number | null;
      userAgent: string | null;
      path: string | null;
      eventType: TrafficEventType;
      entityType?: string | null;
      entityId?: number | null;
    },
  ) {
    try {
      await this.db.execute(sql`
        update traffic_blocked_subjects
        set
          client_ip = coalesce(${values.clientIp || null}, client_ip),
          client_asn = coalesce(${values.clientAsn || null}, client_asn),
          user_agent = coalesce(${values.userAgent || null}, user_agent),
          last_blocked_at = now(),
          blocked_count = blocked_count + 1,
          metadata = metadata || ${JSON.stringify({
            lastEventType: values.eventType,
            lastAction: 'rate_limited',
            lastPath: values.path,
            lastEntityType: values.entityType || null,
            lastEntityId: values.entityId || null,
            lastBlockedBy: 'temporary_bot_block',
          })}::jsonb
        where subject_key = ${subjectKey}
          and status = 'active'
          and blocked_until > now()
      `);
    } catch (error) {
      this.handleTrafficStorageError(error, 'traffic_blocked_subjects table is missing; run the 0015 block TTL migration.');
    }
  }

  private async persistBlockedSubject(values: TrafficEventPersistencePayload) {
    if (this.configService.get<string>('TRAFFIC_EVENTS_PERSIST_ENABLED') === 'false') {
      return;
    }

    const blockReason =
      values.reasons?.find((reason) => reason.includes('datacenter')) ||
      values.reasons?.find((reason) => reason.includes('rate')) ||
      values.reasons?.[0] ||
      'blocked_by_bot_detector';
    const ttlHours = this.getBlockTtlHours();

    try {
      await this.db.execute(sql`
        insert into traffic_blocked_subjects (
          subject_key,
          client_ip,
          client_asn,
          user_agent,
          status,
          block_reason,
          reasons,
          risk_score,
          first_blocked_at,
          last_blocked_at,
          blocked_until,
          blocked_count,
          metadata
        )
        values (
          ${values.subjectKey},
          ${values.clientIp || null},
          ${values.clientAsn || null},
          ${values.userAgent || null},
          'active',
          ${blockReason},
          ${JSON.stringify(values.reasons || [])}::jsonb,
          ${values.riskScore || 0},
          coalesce(${values.occurredAt || null}, now()),
          coalesce(${values.occurredAt || null}, now()),
          now() + (${ttlHours}::text || ' hours')::interval,
          1,
          ${JSON.stringify({
            lastEventType: values.eventType,
            lastAction: values.action,
            lastPath: values.path,
            lastSearchQuery: values.searchQuery,
            lastEntityType: values.entityType,
            lastEntityId: values.entityId,
          })}::jsonb
        )
        on conflict (subject_key) do update set
          client_ip = coalesce(excluded.client_ip, traffic_blocked_subjects.client_ip),
          client_asn = coalesce(excluded.client_asn, traffic_blocked_subjects.client_asn),
          user_agent = coalesce(excluded.user_agent, traffic_blocked_subjects.user_agent),
          status = 'active',
          block_reason = coalesce(excluded.block_reason, traffic_blocked_subjects.block_reason),
          reasons = (
            select coalesce(jsonb_agg(distinct value), '[]'::jsonb)
            from jsonb_array_elements_text(traffic_blocked_subjects.reasons || excluded.reasons) as reason(value)
          ),
          risk_score = greatest(traffic_blocked_subjects.risk_score, excluded.risk_score),
          last_blocked_at = greatest(traffic_blocked_subjects.last_blocked_at, excluded.last_blocked_at),
          blocked_until = excluded.blocked_until,
          blocked_count = traffic_blocked_subjects.blocked_count + 1,
          metadata = traffic_blocked_subjects.metadata || excluded.metadata
        where traffic_blocked_subjects.status <> 'unblocked'
      `);
    } catch (error) {
      this.handleTrafficStorageError(error, 'traffic_blocked_subjects table is missing; run the 0014 blocked subjects migration.');
    }
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

    if (isDatabaseConnectionError(error)) {
      const now = Date.now();
      if (now - this.lastConnectionErrorLogAt >= 30_000) {
        this.lastConnectionErrorLogAt = now;
        console.warn(
          'Traffic storage skipped: database pool saturated or unavailable.',
        );
      }
      return;
    }

    console.error('Failed to persist traffic data:', error);
  }

  private blockedSubjectCacheKey(subjectKey: string): string {
    return `traffic:blocked:active:${subjectKey}`;
  }

  private manualUnblockCacheKey(subjectKey: string): string {
    return `traffic:blocked:manual:${subjectKey}`;
  }

  private getTrafficPersistConcurrency(): number {
    return Math.max(
      this.readIntConfig(
        'TRAFFIC_PERSIST_CONCURRENCY',
        DEFAULT_TRAFFIC_PERSIST_CONCURRENCY,
      ),
      1,
    );
  }

  private async acquireTrafficPersistSlot(): Promise<void> {
    const maxConcurrency = this.getTrafficPersistConcurrency();
    if (this.trafficPersistInFlight < maxConcurrency) {
      this.trafficPersistInFlight += 1;
      return;
    }

    await new Promise<void>((resolve) => {
      this.trafficPersistWaiters.push(() => {
        this.trafficPersistInFlight += 1;
        resolve();
      });
    });
  }

  private releaseTrafficPersistSlot(): void {
    this.trafficPersistInFlight = Math.max(0, this.trafficPersistInFlight - 1);
    const next = this.trafficPersistWaiters.shift();
    if (next) {
      next();
    }
  }

  private enqueueTrafficPersistTask(task: () => Promise<void>): void {
    void (async () => {
      await this.acquireTrafficPersistSlot();
      try {
        await task();
      } catch (error) {
        this.handleTrafficStorageError(
          error,
          'Failed to persist traffic data asynchronously.',
        );
      } finally {
        this.releaseTrafficPersistSlot();
      }
    })();
  }

  private enqueueTrafficPersistence(input: {
    eventPayload: TrafficEventPersistencePayload;
    uniquePathHit: number;
    uniqueSearchHit: number;
    shouldBlock: boolean;
  }): void {
    this.enqueueTrafficPersistTask(async () => {
      if (input.shouldBlock) {
        await this.persistBlockedSubject(input.eventPayload);
        await this.cacheService.del(
          this.manualUnblockCacheKey(input.eventPayload.subjectKey),
        );
      }

      await this.persistAggregate({
        ...input.eventPayload,
        uniquePathHit: input.uniquePathHit,
        uniqueSearchHit: input.uniqueSearchHit,
      });

      if (await this.shouldPersistRawEvent(input.eventPayload)) {
        await this.persistEvent(input.eventPayload);
      }
    });
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
      await this.db.execute(sql`
        update traffic_blocked_subjects
        set status = 'expired'
        where status = 'active'
          and blocked_until is not null
          and blocked_until <= now()
      `);
      await this.db.execute(sql`
        update traffic_blocked_subjects
        set
          status = 'expired',
          metadata = metadata || ${JSON.stringify({
            expiredBy: 'legacy_or_soft_rate_limit_cleanup',
          })}::jsonb
        where status = 'active'
          and not (reasons ? 'hard_request_burst_30s')
          and not (reasons ? 'hard_search_burst_30s')
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

  private getPgErrorCode(error: unknown): string | undefined {
    const direct = (error as { code?: string })?.code;
    if (direct) return direct;
    return (error as { cause?: { code?: string } })?.cause?.code;
  }

  private buildBlockedStatusFilter(status: BlockedSubjectStatus) {
    if (status === 'all') {
      return sql`true`;
    }
    return sql`status = ${status}`;
  }

  private throwTrafficQueryError(message: string, error: unknown, migrationFile: string): never {
    const code = this.getPgErrorCode(error);

    if (code === '42P01' || code === '42703') {
      throw new InternalServerErrorException(
        `${message} Migración pendiente: ${migrationFile}`,
      );
    }

    if (code === '57014') {
      throw new InternalServerErrorException(
        `${message} La consulta excedió el tiempo límite.`,
      );
    }

    console.error(message, error);
    throw new InternalServerErrorException(message);
  }
}
