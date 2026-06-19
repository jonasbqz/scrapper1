import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { RouteProtectionService } from './route-protection.service';

function createService({
  cacheGet = async () => undefined,
  cacheSet = async () => {},
  cacheDel = async () => {},
  selectBySlug = async () => [],
  updateComic = async () => ({}),
} = {}) {
  const cacheSetCalls = [];
  const updateCalls = [];
  const selectCalls = [];

  const service = new RouteProtectionService(
    {
      get: cacheGet,
      set: async (key, value, ttl) => {
        cacheSetCalls.push({ key, value, ttl });
        await cacheSet(key, value, ttl);
      },
      del: cacheDel,
    },
    { get: () => undefined },
    {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => {
              selectCalls.push('limit');
              return await selectBySlug();
            },
          }),
        }),
      }),
      update: () => {
        updateCalls.push('update');
        const chain = {
          set: () => chain,
          where: async () => await updateComic(),
        };
        return chain;
      },
    },
  );

  return { service, cacheSetCalls, updateCalls, selectCalls };
}

// A mock DB that supports both: select().from().where() (list, no limit) and
// select().from().where().limit(1) (single collision check). The first call
// returns the supplied `protectedComics` list (for the all-protected-comics
// query); every subsequent call returns an empty array (so the unique-slug
// generator's collision check always finds a free slug).
function createServiceWithProtectedComics(protectedComics) {
  const cacheSetCalls = [];
  const updateCalls = [];
  let callCount = 0;

  const whereResult = [];
  whereResult.then = (resolve) => {
    callCount += 1;
    return Promise.resolve(callCount === 1 ? protectedComics : []).then(resolve);
  };
  whereResult.limit = async () => {
    callCount += 1;
    return callCount === 1 ? protectedComics : [];
  };

  const dbMock = {
    select: () => ({
      from: () => ({
        where: () => whereResult,
      }),
    }),
    update: () => {
      updateCalls.push('update');
      const chain = {
        set: () => chain,
        where: async () => undefined,
      };
      return chain;
    },
  };

  const service = new RouteProtectionService(
    {
      get: async () => undefined,
      set: async (key, value, ttl) => {
        cacheSetCalls.push({ key, value, ttl });
      },
      del: async () => {},
    },
    { get: () => undefined },
    dbMock,
  );

  return { service, cacheSetCalls, updateCalls };
}

describe('RouteProtectionService', () => {
  describe('parseComicSegment', () => {
    const service = new RouteProtectionService(
      { get: async () => undefined, set: async () => {}, del: async () => {} },
      { get: () => undefined },
      {},
    );

    it('detects the new protected format with 3-digit prefix and 4-digit suffix', () => {
      const result = service.parseComicSegment('133naruto2125');
      expect(result.slug).toBe('133naruto2125');
      expect(result.hasCode).toBe(true);
    });

    it('returns the segment as-is for plain (unprotected) slugs', () => {
      const result = service.parseComicSegment('naruto');
      expect(result.slug).toBe('naruto');
      expect(result.hasCode).toBe(false);
    });

    it('treats long slugs with numeric suffix as protected when the prefix is also numeric', () => {
      const result = service.parseComicSegment('456the-battle-begins-chapter-57890');
      expect(result.slug).toBe('456the-battle-begins-chapter-57890');
      expect(result.hasCode).toBe(true);
    });

    it('returns the segment as-is when the prefix is not numeric', () => {
      const result = service.parseComicSegment('a12345');
      expect(result.hasCode).toBe(false);
    });

    it('returns the segment as-is when the suffix is not numeric', () => {
      const result = service.parseComicSegment('123abc');
      expect(result.hasCode).toBe(false);
    });
  });

  describe('parseChapterSegment', () => {
    const service = new RouteProtectionService(
      { get: async () => undefined, set: async () => {}, del: async () => {} },
      { get: () => undefined },
      {},
    );

    it('returns the segment as the chapter slug (no 90- prefix, no random)', () => {
      const result = service.parseChapterSegment('1185237596551512066');
      expect(result.chapterSlug).toBe('1185237596551512066');
      expect(result.random).toBe(null);
      expect(result.hasRandom).toBe(false);
    });

    it('returns the segment as-is for legacy 90-<slug> URLs', () => {
      const result = service.parseChapterSegment('90-5');
      expect(result.chapterSlug).toBe('90-5');
      expect(result.hasRandom).toBe(false);
    });
  });

  describe('isProtected', () => {
    const service = new RouteProtectionService(
      { get: async () => undefined, set: async () => {}, del: async () => {} },
      { get: () => undefined },
      {},
    );

    it('returns true when protectedRouteEnabled is true', () => {
      expect(service.isProtected({ id: 1, slug: 'x', protectedRouteEnabled: true })).toBe(true);
    });

    it('returns false when protectedRouteEnabled is false or null', () => {
      expect(service.isProtected({ id: 1, slug: 'x', protectedRouteEnabled: false })).toBe(false);
      expect(service.isProtected({ id: 1, slug: 'x', protectedRouteEnabled: null })).toBe(false);
    });

    it('returns false for null/undefined comic', () => {
      expect(service.isProtected(null)).toBe(false);
      expect(service.isProtected(undefined)).toBe(false);
    });
  });

  describe('generateUniqueComicSlug', () => {
    it('generates a slug with 3-digit prefix + title + 4-digit suffix', async () => {
      const { service } = createService({
        selectBySlug: async () => [],
      });
      const slug = await service.generateUniqueComicSlug('naruto');
      expect(slug).toMatch(/^\d{3}naruto\d{4}$/);
    });

    it('retries on collision until a unique slug is found', async () => {
      let attempts = 0;
      const { service } = createService({
        selectBySlug: async () => {
          attempts += 1;
          if (attempts < 3) {
            return [{ id: attempts }];
          }
          return [];
        },
      });
      const slug = await service.generateUniqueComicSlug('bleach');
      expect(slug).toMatch(/^\d{3}bleach\d{4}$/);
      expect(attempts).toBe(3);
    });

    it('throws after max attempts when all candidates collide', async () => {
      const { service } = createService({
        selectBySlug: async () => [{ id: 1 }],
      });
      await expect(service.generateUniqueComicSlug('collision-city')).rejects.toThrow(
        /Failed to generate a unique protected comic slug/,
      );
    });
  });

  describe('getComicPath', () => {
    it('returns the full /comics/<slug> path (random is baked into the slug)', async () => {
      const service = new RouteProtectionService(
        { get: async () => undefined, set: async () => {}, del: async () => {} },
        { get: () => undefined },
        {},
      );
      const path = await service.getComicPath({
        id: 1,
        slug: '133naruto2125',
        protectedRouteEnabled: true,
      });
      expect(path).toBe('/comics/133naruto2125');
    });
  });

  describe('getChapterPath', () => {
    const service = new RouteProtectionService(
      { get: async () => undefined, set: async () => {}, del: async () => {} },
      { get: () => undefined },
      {},
    );

    it('uses the numeric chapter ID for unprotected comics', async () => {
      const path = await service.getChapterPath(
        { id: 1, slug: 'naruto', protectedRouteEnabled: false },
        { id: 55, slug: '1185237596551512066' },
      );
      expect(path).toBe('/comics/naruto/chapters/55');
    });

    it('uses the opaque slug for protected comics', async () => {
      const path = await service.getChapterPath(
        { id: 1, slug: '133naruto2125', protectedRouteEnabled: true },
        { id: 55, slug: '1185237596551512066' },
      );
      expect(path).toBe('/comics/133naruto2125/chapters/1185237596551512066');
    });

    it('uses the provided comicPath when supplied', async () => {
      const path = await service.getChapterPath(
        { id: 1, slug: 'naruto', protectedRouteEnabled: true },
        { id: 55, slug: '1185237596551512066' },
        { comicPath: '/comics/133naruto2125' },
      );
      expect(path).toBe('/comics/133naruto2125/chapters/1185237596551512066');
    });
  });

  describe('rotateAllProtectedComicSlugs', () => {
    it('updates the slug for every protected comic and rotates the random', async () => {
      const protectedComics = [
        { id: 1, slug: '111naruto1111', title: 'Naruto' },
        { id: 2, slug: '222bleach2222', title: 'Bleach' },
      ];
      const { service, updateCalls } = createServiceWithProtectedComics(protectedComics);

      const rotated = await service.rotateAllProtectedComicSlugs();
      expect(rotated).toBe(2);
      expect(updateCalls.length).toBeGreaterThanOrEqual(2);
    });

    it('does not increment the rotated counter when a slug is unchanged', async () => {
      const { service } = createServiceWithProtectedComics([]);
      const rotated = await service.rotateAllProtectedComicSlugs();
      expect(rotated).toBe(0);
    });
  });
});
