import { describe, expect, it } from 'bun:test';
import { RouteProtectionService } from './route-protection.service';

function createService({ cacheGet, cacheSet, selectCode, insertReturningCode }) {
  const setCalls = [];

  const service = new RouteProtectionService(
    {
      get: async (key) => (cacheGet ? cacheGet(key) : undefined),
      set: async (key, value, ttl) => {
        setCalls.push({ key, value, ttl });
        if (cacheSet) {
          await cacheSet(key, value, ttl);
        }
      },
    },
    { get: () => undefined },
    {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => (selectCode ? [{ code: await selectCode() }] : []),
          }),
        }),
      }),
      insert: () => ({
        values: () => ({
          onConflictDoNothing: async () => undefined,
        }),
      }),
      execute: async () => (insertReturningCode ? [{ code: await insertReturningCode() }] : []),
    },
  );

  return { service, setCalls };
}

describe('RouteProtectionService', () => {
  it('reuses persisted comic codes without regenerating them', async () => {
    const { service, setCalls } = createService({
      cacheGet: async () => undefined,
      selectCode: async () => '654321',
      insertReturningCode: async () => '654321',
    });

    const code = await service.getComicCode(42);

    expect(code).toBe('654321');
    expect(setCalls).toHaveLength(1);
    expect(setCalls[0]).toEqual({
      key: 'route:comic:42',
      value: '654321',
      ttl: 16 * 60 * 60 * 1000,
    });
  });

  it('seeds the database from an existing cache code', async () => {
    let executeCalls = 0;

    const { service } = createService({
      cacheGet: async () => '777777',
      selectCode: async () => null,
      insertReturningCode: async () => {
        executeCalls += 1;
        return '777777';
      },
    });

    const code = await service.getComicCode(42);

    expect(code).toBe('777777');
    expect(executeCalls).toBe(1);
  });

  it('reuses cached chapter codes without regenerating them', async () => {
    const service = new RouteProtectionService(
      {
        get: async () => '654321',
        set: async () => {},
      },
      { get: () => undefined },
      {
        insert: () => ({
          values: () => ({
            onConflictDoNothing: async () => undefined,
          }),
        }),
        execute: async () => [{ code: '654321' }],
      },
    );

    const code = await service.getChapterCode(7);

    expect(code).toBe('654321');
  });
});
