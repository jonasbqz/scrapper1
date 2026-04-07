import { describe, expect, it } from 'bun:test';
import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ChapterService } from './chapter.service';
import { RouteProtectionService } from '../route-protection/route-protection.service';

function createRouteProtectionService() {
  const service = new RouteProtectionService(
    {
      get: async () => undefined,
      set: async () => undefined,
    },
    { get: () => undefined },
  );

  service.getChapterCode = async () => '222222';
  return service;
}

function createChapterService() {
  const service = new ChapterService(
    {},
    {
      wrap: async (_key, fn) => fn(),
    },
    createRouteProtectionService(),
  );

  service.getNavigation = async () => ({
    current: {
      id: 55,
      comicScan: {
        comic: {
          id: 10,
          slug: 'my-comic',
          protectedRouteEnabled: true,
        },
      },
    },
    prev: null,
    next: null,
  });

  return service;
}

describe('ChapterService.findPublicByRouteSegments', () => {
  it('accepts a stale comic code when the chapter code is still valid', async () => {
    const service = createChapterService();

    const result = await service.findPublicByRouteSegments(
      'my-comic-999999',
      '55-222222',
    );

    expect(result.comic.slug).toBe('my-comic');
    expect(result.navigation.current.id).toBe(55);
  });

  it('rejects chapter access when the comic segment belongs to another comic', async () => {
    const service = createChapterService();

    let error;
    try {
      await service.findPublicByRouteSegments('other-comic-999999', '55-222222');
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ServiceUnavailableException);
  });

  it('rejects protected chapter access when the chapter code is missing', async () => {
    const service = createChapterService();

    let error;
    try {
      await service.findPublicByRouteSegments('my-comic-999999', '55');
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ServiceUnavailableException);
  });

  it('returns not found when the chapter segment cannot be parsed', async () => {
    const service = createChapterService();

    let error;
    try {
      await service.findPublicByRouteSegments('my-comic-999999', 'bad-segment');
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(NotFoundException);
  });
});
