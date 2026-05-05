import { createHash } from 'crypto';

export type TrafficEventType =
  | 'comic_list'
  | 'comic_search'
  | 'comic_view'
  | 'chapter_view'
  | 'chapter_pages'
  | 'comic_lookup'
  | 'chapter_lookup';

export type TrafficAction = 'allow' | 'observe' | 'suspicious' | 'rate_limited';

export type TrafficInspectionInput = {
  eventType: TrafficEventType;
  clientIp?: string | null;
  clientAsn?: number | null;
  userAgent?: string | null;
  path?: string | null;
  searchQuery?: string | null;
  userId?: string | null;
  watchCidrs?: string[];
  watchAsns?: number[];
  allowCidrs?: string[];
  allowIps?: string[];
  allowAsns?: number[];
};

export type TrafficInspectionResult = {
  isAllowedSearchCrawler: boolean;
  isBotLike: boolean;
  isAllowedNetwork: boolean;
  isWatchlistedDatacenter: boolean;
  isInternalIp: boolean;
  riskScore: number;
  reasons: string[];
};

const ALLOWED_SEARCH_CRAWLER_UA_REGEX =
  /\b(Googlebot|Google-InspectionTool|AdsBot-Google|Mediapartners-Google|bingbot|BingPreview|DuckDuckBot|Applebot|YandexBot|Baiduspider|Slurp)\b/i;

const BOT_LIKE_UA_REGEX =
  /\b(bot|crawler|spider|scraper|scrapy|crawl|httpclient|python-requests|python-urllib|aiohttp|curl|wget|go-http-client|java\/|okhttp|axios|headlesschrome|phantomjs|selenium|playwright|puppeteer)\b/i;

function ipv4ToNumber(ip: string): number | null {
  const parts = ip.split('.').map((part) => Number.parseInt(part, 10));
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isFinite(part) || part < 0 || part > 255)
  ) {
    return null;
  }

  return (((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3]) >>> 0;
}

export function isIpv4InCidr(ip: string, cidr: string): boolean {
  const [base, prefixText] = cidr.trim().split('/');
  const prefix = Number.parseInt(prefixText ?? '32', 10);
  const ipNumber = ipv4ToNumber(ip);
  const baseNumber = ipv4ToNumber(base);

  if (
    ipNumber === null ||
    baseNumber === null ||
    !Number.isFinite(prefix) ||
    prefix < 0 ||
    prefix > 32
  ) {
    return false;
  }

  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipNumber & mask) === (baseNumber & mask);
}

export function isIpInAnyCidr(ip: string | null | undefined, cidrs: string[] = []): boolean {
  if (!ip) return false;
  return cidrs.some((cidr) => cidr && isIpv4InCidr(ip, cidr));
}

export function isInternalIp(ip: string | null | undefined): boolean {
  if (!ip) return false;
  const normalized = ip.toLowerCase();
  if (
    normalized === 'localhost' ||
    normalized === '::1' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('fe80')
  ) {
    return true;
  }

  const parts = ip.split('.').map((part) => Number.parseInt(part, 10));
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isFinite(part) || part < 0 || part > 255)
  ) {
    return false;
  }

  const [a, b] = parts;
  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}

export function parseCsvList(value?: string | null): string[] {
  return (value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function parseAsnList(value?: string | null): number[] {
  return Array.from(
    new Set(
      parseCsvList(value)
        .map((item) => item.replace(/^AS/i, ''))
        .map((item) => Number.parseInt(item, 10))
        .filter((item) => Number.isInteger(item) && item > 0),
    ),
  );
}

export function hashTrafficSubject(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function inspectTrafficEvent(input: TrafficInspectionInput): TrafficInspectionResult {
  const userAgent = (input.userAgent || '').trim();
  const reasons: string[] = [];
  let riskScore = 0;

  const isAllowedSearchCrawler = ALLOWED_SEARCH_CRAWLER_UA_REGEX.test(userAgent);
  const isBotLike = BOT_LIKE_UA_REGEX.test(userAgent);
  const isAllowedNetwork = Boolean(
    (input.clientIp &&
      (input.allowIps || []).includes(input.clientIp) ||
      isIpInAnyCidr(input.clientIp, input.allowCidrs)) ||
      (input.clientAsn &&
        Array.isArray(input.allowAsns) &&
        input.allowAsns.includes(input.clientAsn)),
  );
  const isInternal = isInternalIp(input.clientIp);

  if (!userAgent) {
    riskScore += 15;
    reasons.push('missing_user_agent');
  }

  if (isAllowedSearchCrawler) {
    reasons.push('allowed_search_crawler_user_agent');
  } else if (isBotLike) {
    riskScore += 25;
    reasons.push('bot_like_user_agent');
  }

  if (!isAllowedNetwork && isIpInAnyCidr(input.clientIp, input.watchCidrs)) {
    riskScore += 35;
    reasons.push('watchlisted_datacenter_ip');
  }

  if (
    !isAllowedNetwork &&
    input.clientAsn &&
    Array.isArray(input.watchAsns) &&
    input.watchAsns.includes(input.clientAsn)
  ) {
    riskScore += 35;
    reasons.push('watchlisted_datacenter_asn');
  }

  const isWatchlistedDatacenter =
    reasons.includes('watchlisted_datacenter_ip') ||
    reasons.includes('watchlisted_datacenter_asn');

  if (isAllowedNetwork) {
    reasons.push('allowed_network');
  }

  if (isInternal) {
    reasons.push('internal_origin_ip');
  }

  if (!input.userId) {
    riskScore += 5;
    reasons.push('anonymous_traffic');
  }

  if (input.eventType === 'comic_search' && (input.searchQuery || '').length <= 2) {
    riskScore += 5;
    reasons.push('short_search_query');
  }

  if (input.path && /\.(php|env|bak|sql|zip|tar|gz)$/i.test(input.path)) {
    riskScore += 30;
    reasons.push('probe_path_pattern');
  }

  return {
    isAllowedSearchCrawler,
    isBotLike,
    isAllowedNetwork,
    isWatchlistedDatacenter,
    isInternalIp: isInternal,
    riskScore,
    reasons,
  };
}

export function actionFromRiskScore(score: number): TrafficAction {
  if (score >= 70) return 'suspicious';
  if (score >= 35) return 'observe';
  return 'allow';
}
