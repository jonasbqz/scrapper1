import { describe, expect, it } from 'bun:test';
import {
  actionFromRiskScore,
  inspectTrafficEvent,
  isInternalIp,
  isIpv4InCidr,
  parseAsnList,
  parseCsvList,
} from './bot-detection.util';

describe('bot detection util', () => {
  it('does not penalize known search crawlers by user agent', () => {
    const result = inspectTrafficEvent({
      eventType: 'comic_view',
      userAgent: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      clientIp: '66.249.66.1',
      userId: null,
    });

    expect(result.isAllowedSearchCrawler).toBe(true);
    expect(result.reasons).toContain('allowed_search_crawler_user_agent');
    expect(result.riskScore).toBeLessThan(20);
  });

  it('flags generic bot user agents', () => {
    const result = inspectTrafficEvent({
      eventType: 'comic_search',
      userAgent: 'python-requests/2.31',
      clientIp: '203.0.113.10',
      searchQuery: 'one piece',
    });

    expect(result.isBotLike).toBe(true);
    expect(result.reasons).toContain('bot_like_user_agent');
    expect(result.riskScore).toBeGreaterThanOrEqual(25);
  });

  it('flags watchlisted datacenter IP ranges', () => {
    const result = inspectTrafficEvent({
      eventType: 'comic_view',
      userAgent: 'Mozilla/5.0',
      clientIp: '192.0.2.55',
      watchCidrs: ['192.0.2.0/24'],
    });

    expect(result.reasons).toContain('watchlisted_datacenter_ip');
  });

  it('flags watchlisted datacenter ASNs', () => {
    const result = inspectTrafficEvent({
      eventType: 'comic_view',
      userAgent: 'Mozilla/5.0',
      clientIp: '192.0.2.55',
      clientAsn: 51167,
      watchAsns: [51167],
    });

    expect(result.reasons).toContain('watchlisted_datacenter_asn');
    expect(result.isWatchlistedDatacenter).toBe(true);
  });

  it('recognizes private/internal origin IPs', () => {
    expect(isInternalIp('10.0.1.14')).toBe(true);
    expect(isInternalIp('172.20.0.10')).toBe(true);
    expect(isInternalIp('192.168.1.10')).toBe(true);
    expect(isInternalIp('8.8.8.8')).toBe(false);
  });

  it('marks explicitly allowed networks', () => {
    const result = inspectTrafficEvent({
      eventType: 'comic_view',
      userAgent: 'Mozilla/5.0',
      clientIp: '203.0.113.10',
      allowCidrs: ['203.0.113.0/24'],
    });

    expect(result.isAllowedNetwork).toBe(true);
    expect(result.reasons).toContain('allowed_network');
  });

  it('does not mark allowed ASNs as watchlisted datacenters', () => {
    const result = inspectTrafficEvent({
      eventType: 'comic_view',
      userAgent: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      clientIp: '66.249.64.97',
      clientAsn: 15169,
      watchAsns: [15169],
      allowAsns: [15169],
    });

    expect(result.isAllowedSearchCrawler).toBe(true);
    expect(result.isAllowedNetwork).toBe(true);
    expect(result.isWatchlistedDatacenter).toBe(false);
    expect(result.reasons).toContain('allowed_network');
    expect(result.reasons).not.toContain('watchlisted_datacenter_asn');
  });

  it('matches IPv4 CIDR ranges', () => {
    expect(isIpv4InCidr('192.0.2.55', '192.0.2.0/24')).toBe(true);
    expect(isIpv4InCidr('192.0.3.55', '192.0.2.0/24')).toBe(false);
  });

  it('normalizes CSV lists', () => {
    expect(parseCsvList(' 192.0.2.0/24, ,198.51.100.10 ')).toEqual([
      '192.0.2.0/24',
      '198.51.100.10',
    ]);
  });

  it('normalizes ASN lists', () => {
    expect(parseAsnList('AS51167, 24940,invalid, AS51167')).toEqual([
      51167,
      24940,
    ]);
  });

  it('maps risk score to observation actions', () => {
    expect(actionFromRiskScore(10)).toBe('allow');
    expect(actionFromRiskScore(40)).toBe('observe');
    expect(actionFromRiskScore(80)).toBe('suspicious');
  });
});
