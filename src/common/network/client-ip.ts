import type { FastifyRequest } from 'fastify';

type HeaderAccessor =
  | Headers
  | Record<string, unknown>
  | {
      get(name: string): string | null;
    }
  | undefined
  | null;

const IP_HEADER_CANDIDATES = [
  'cf-connecting-ip',
  'true-client-ip',
  'x-real-ip',
  'x-client-ip',
  'x-forwarded-for',
] as const;

function readHeader(headers: HeaderAccessor, name: string): string {
  if (!headers) {
    return '';
  }

  if (typeof (headers as { get?: unknown }).get === 'function') {
    return ((headers as { get(name: string): string | null }).get(name) || '').trim();
  }

  const record = headers as Record<string, unknown>;
  const direct = record[name];
  if (typeof direct === 'string') {
    return direct.trim();
  }

  if (Array.isArray(direct)) {
    return String(direct[0] || '').trim();
  }

  const normalizedKey = Object.keys(record).find(
    (key) => key.toLowerCase() === name.toLowerCase(),
  );

  if (!normalizedKey) {
    return '';
  }

  const normalizedValue = record[normalizedKey];
  if (typeof normalizedValue === 'string') {
    return normalizedValue.trim();
  }

  if (Array.isArray(normalizedValue)) {
    return String(normalizedValue[0] || '').trim();
  }

  return '';
}

function normalizeIpCandidate(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === 'unknown') {
    return null;
  }

  const firstValue = trimmed.split(',')[0]?.trim() || '';
  if (!firstValue) {
    return null;
  }

  const forwardedMatch = firstValue.match(/for=(?:"?\[?)([a-f0-9:.]+)(?:\]?"?)/i);
  let normalized = (forwardedMatch?.[1] || firstValue)
    .replace(/^"+|"+$/g, '')
    .trim();

  const bracketedIpv6WithPort = normalized.match(/^\[([a-f0-9:]+)\](?::\d+)?$/i);
  if (bracketedIpv6WithPort) {
    normalized = bracketedIpv6WithPort[1];
  } else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(normalized)) {
    normalized = normalized.split(':')[0];
  }

  if (normalized.startsWith('::ffff:')) {
    normalized = normalized.slice(7);
  }

  return normalized || null;
}

export function extractClientIpFromHeaders(headers: HeaderAccessor): string | null {
  for (const headerName of IP_HEADER_CANDIDATES) {
    const value = readHeader(headers, headerName);
    const normalized = normalizeIpCandidate(value);
    if (normalized) {
      return normalized;
    }
  }

  const forwarded = readHeader(headers, 'forwarded');
  return normalizeIpCandidate(forwarded);
}

type RequestLike = Pick<FastifyRequest, 'headers' | 'ip' | 'raw'>;

export function getRequestClientIp(request: RequestLike): string | null {
  return (
    extractClientIpFromHeaders(request.headers) ||
    normalizeIpCandidate(request.ip || '') ||
    normalizeIpCandidate(request.raw?.socket?.remoteAddress || '')
  );
}
