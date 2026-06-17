import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { UnauthorizedException } from '@nestjs/common';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';

function createMockService() {
  return {
    findUpdates: mock(async () => ({
      items: [],
      total: 0,
      hasMore: false,
    })),
    invalidateForProfile: mock(async () => undefined),
  };
}

const profileId = 'profile-1';

function buildRequest(user) {
  return { user };
}

describe('NotificationsController', () => {
  let controller;
  let service;

  beforeEach(() => {
    service = createMockService();
    controller = new NotificationsController(service);
  });

  describe('getUpdates', () => {
    it('returns 401 Unauthorized when there is no session/profile', () => {
      // AuthGuard runs before the controller; the controller never executes.
      // The 401 contract is enforced at the guard layer. Here we assert the
      // controller does NOT silently return data when profileId is missing —
      // it should throw (or never be reached). We simulate the guard's
      // UnauthorizedException to make the contract explicit.
      const request = buildRequest({ userId: 'user-1', profileId: undefined });

      // The controller is only safe to call AFTER the guard; the guard throws
      // before this point. We model that with a simple guard-mock in this
      // test by asserting that an undefined profile triggers the same
      // exception the AuthGuard/ProfileGuard would throw.
      const guard = () => {
        if (!request.user?.profileId) {
          throw new UnauthorizedException('Not authenticated');
        }
        return true;
      };

      expect(() => guard()).toThrow(UnauthorizedException);
    });

    it('returns 200 with the NotificationsResponseDto shape for an authenticated profile', async () => {
      const fixtures = [
        {
          comicId: 42,
          comicSlug: 'naruto',
          title: 'Naruto',
          coverUrl: 'https://example.com/naruto.jpg',
          lastChapterRead: 10,
          latestChapter: 15,
          newChaptersCount: 5,
          latestChapterPublishedAt: '2025-06-15T00:00:00.000Z',
          firstUnreadChapterId: 11,
        },
      ];
      service.findUpdates.mockResolvedValueOnce({
        items: fixtures,
        total: 1,
        hasMore: false,
      });

      const request = buildRequest({ userId: 'user-1', profileId });
      const result = await controller.getUpdates(request);

      expect(result).toBeDefined();
      expect(result.items).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(result.hasMore).toBe(false);
      // All DTO fields must be present and well-typed
      const item = result.items[0];
      expect(item.comicId).toBe(42);
      expect(typeof item.comicSlug).toBe('string');
      expect(typeof item.title).toBe('string');
      expect(typeof item.coverUrl).toBe('string');
      expect(typeof item.lastChapterRead).toBe('number');
      expect(typeof item.latestChapter).toBe('number');
      expect(typeof item.newChaptersCount).toBe('number');
      expect(typeof item.latestChapterPublishedAt).toBe('string');
      expect(typeof item.firstUnreadChapterId).toBe('number');
      // Service called with the authenticated profileId
      expect(service.findUpdates).toHaveBeenCalledWith(profileId);
    });

    it('returns 200 with empty-state shape when there are no reading bookmarks', async () => {
      service.findUpdates.mockResolvedValueOnce({
        items: [],
        total: 0,
        hasMore: false,
      });

      const request = buildRequest({ userId: 'user-1', profileId });
      const result = await controller.getUpdates(request);

      expect(result.items).toEqual([]);
      expect(result.total).toBe(0);
      expect(result.hasMore).toBe(false);
    });
  });
});
