import { describe, expect, it } from 'bun:test';
import { RouteProtectionService } from './route-protection.service';

describe('RouteProtectionService', () => {
  it('stores comic codes with a 16-hour TTL', async () => {
    const setCalls = [];
    const service = new RouteProtectionService(
      {
        get: async () => undefined,
        set: async (key, value, ttl) => {
          setCalls.push({ key, value, ttl });
        },
      },
      { get: () => undefined },
    );

    const code = await service.getComicCode(42);

    expect(code).toMatch(/^\d{6}$/);
    expect(setCalls).toHaveLength(1);
    expect(setCalls[0]).toEqual({
      key: 'route:comic:42',
      value: code,
      ttl: 16 * 60 * 60 * 1000,
    });
  });

  it('reuses cached chapter codes without regenerating them', async () => {
    const setCalls = [];
    const service = new RouteProtectionService(
      {
        get: async () => '654321',
        set: async (key, value, ttl) => {
          setCalls.push({ key, value, ttl });
        },
      },
      { get: () => undefined },
    );

    const code = await service.getChapterCode(7);

    expect(code).toBe('654321');
    expect(setCalls).toHaveLength(0);
  });
});
