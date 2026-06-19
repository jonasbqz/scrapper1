import { describe, expect, it } from 'bun:test';
import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ChapterService } from './chapter.service';
import { RouteProtectionService } from '../route-protection/route-protection.service';

function createRouteProtectionService() {
  return new RouteProtectionService(
    {
      get: async () => undefined,
      set: async () => undefined,
      del: async () => undefined,
    },
    { get: () => undefined },
    {},
  );
}

function createChapterService({
  comicBySlug = null,
  chaptersBySlug = [],
  dbQueryChaptersResult = null,
  comicScanIds = [1],
} = {}) {
  // Stateful mock: each select() invocation toggles which result to return.
  // findChapterBySlugInComic does two select() calls: first for comicScans
  // (returns scan ids), then for chapters (returns chaptersBySlug). Tests
  // that don't use that flow can ignore the toggle.
  let selectToggle = 0;

  const scanResult = comicScanIds.map((id) => ({ id }));

  const whereResult = [];
  whereResult.then = (resolve) => {
    selectToggle += 1;
    const data = selectToggle === 1 ? scanResult : chaptersBySlug;
    return Promise.resolve(data).then(resolve);
  };
  whereResult.limit = async () => {
    selectToggle += 1;
    return selectToggle === 1 ? scanResult : chaptersBySlug;
  };
  whereResult.orderBy = () => ({
    limit: async () => chaptersBySlug,
  });

  const db = {
    select: () => ({
      from: () => ({
        where: () => whereResult,
      }),
    }),
    query: {
      comics: {
        findFirst: async () => comicBySlug,
      },
      chapters: {
        findFirst: async () => dbQueryChaptersResult,
        findMany: async () => chaptersBySlug,
      },
    },
  };

  const service = new ChapterService(
    db,
    {
      wrap: async (_key, fn) => fn(),
    },
    createRouteProtectionService(),
  );

  // Make getNavigation fast and stubbed
  service.getNavigation = async (chapterId) => ({
    current: {
      id: chapterId,
      comicScan: {
        comic: comicBySlug,
      },
    },
    prev: null,
    next: null,
  });

  return service;
}

describe('ChapterService.findPublicByRouteSegments', () => {
  it('resolves a protected comic + chapter slug and returns the navigation', async () => {
    const service = createChapterService({
      comicBySlug: {
        id: 10,
        slug: '133my-comic2125',
        protectedRouteEnabled: true,
      },
      chaptersBySlug: [
        { id: 55, slug: '1185237596551512066', comicScanId: 1 },
      ],
    });

    const result = await service.findPublicByRouteSegments(
      '133my-comic2125',
      '1185237596551512066',
    );

    expect(result.comic.slug).toBe('133my-comic2125');
    expect(result.navigation.current.id).toBe(55);
  });

  it('resolves an unprotected comic + chapter ID (URL uses numeric ID, not slug)', async () => {
    const service = createChapterService({
      comicBySlug: {
        id: 10,
        slug: 'my-comic',
        protectedRouteEnabled: false,
      },
      chaptersBySlug: [
        { id: 55, slug: '1185237596551512066', comicScanId: 1 },
      ],
    });

    const result = await service.findPublicByRouteSegments('my-comic', '55');
    expect(result.comic.slug).toBe('my-comic');
    expect(result.navigation.current.id).toBe(55);
  });

  it('rejects when the comic segment does not match any comic', async () => {
    const service = createChapterService({
      comicBySlug: null,
      chaptersBySlug: [],
    });

    let error;
    try {
      await service.findPublicByRouteSegments('nonexistent', '5');
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(NotFoundException);
  });

  it('rejects with 503 when a protected comic has no matching chapter', async () => {
    const service = createChapterService({
      comicBySlug: {
        id: 10,
        slug: '133my-comic2125',
        protectedRouteEnabled: true,
      },
      chaptersBySlug: [],
    });

    let error;
    try {
      await service.findPublicByRouteSegments('133my-comic2125', 'unknown-chapter');
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ServiceUnavailableException);
  });

  it('rejects with 404 when an unprotected comic has no matching chapter', async () => {
    const service = createChapterService({
      comicBySlug: {
        id: 10,
        slug: 'my-comic',
        protectedRouteEnabled: false,
      },
      chaptersBySlug: [],
    });

    let error;
    try {
      await service.findPublicByRouteSegments('my-comic', 'unknown-chapter');
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(NotFoundException);
  });
});
