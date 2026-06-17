import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { BookmarkService } from './bookmark.service';
import { CACHE_KEYS } from '@/cache/cache.service';

function createMockDb() {
  return {
    query: {
      bookmarks: {
        findFirst: mock(async () => null),
        findMany: mock(async () => []),
      },
    },
    insert: mock(() => ({
      values: mock(function () { return this; }),
      returning: mock(async () => [{}]),
    })),
    update: mock(() => ({
      set: mock(function () { return this; }),
      where: mock(function () { return this; }),
      returning: mock(async () => [{}]),
    })),
    delete: mock(() => ({
      where: mock(async () => ({ count: 1 })),
    })),
  };
}

function createMockCache() {
  return {
    del: mock(async () => undefined),
  };
}

describe('BookmarkService', () => {
  let service;
  let db;
  let cache;

  beforeEach(() => {
    db = createMockDb();
    cache = createMockCache();
    service = new BookmarkService(db, cache);
  });

  const profileId = 'profile-1';
  const comicId = 42;

  const existingBookmark = {
    id: 1,
    profileId: 'profile-1',
    comicId: 42,
    status: 'reading',
    isFavorite: false,
    updatedAt: new Date('2025-01-01'),
  };

  const comicRelation = {
    id: 42,
    title: 'One Piece',
    slug: 'one-piece',
    coverImage: 'https://example.com/cover.jpg',
  };

  describe('upsert', () => {
    it('creates a new bookmark when none exists', async () => {
      db.query.bookmarks.findFirst.mockResolvedValue(null);
      const newBookmark = {
        id: 2,
        profileId,
        comicId,
        status: 'plan_to_read',
        isFavorite: false,
      };
      db.insert.mockReturnValue({
        values: mock(function () { return this; }),
        returning: mock(async () => [newBookmark]),
      });

      const result = await service.upsert(profileId, { comicId });

      expect(result).toEqual(newBookmark);
      expect(db.query.bookmarks.findFirst).toHaveBeenCalledTimes(1);
      expect(db.insert).toHaveBeenCalledTimes(1);
    });

    it('updates an existing bookmark', async () => {
      db.query.bookmarks.findFirst.mockResolvedValue(existingBookmark);
      const updatedBookmark = { ...existingBookmark, status: 'completed', isFavorite: true };
      db.update.mockReturnValue({
        set: mock(function () { return this; }),
        where: mock(function () { return this; }),
        returning: mock(async () => [updatedBookmark]),
      });

      const result = await service.upsert(profileId, {
        comicId,
        status: 'completed',
        isFavorite: true,
      });

      expect(result.status).toBe('completed');
      expect(result.isFavorite).toBe(true);
      expect(db.update).toHaveBeenCalledTimes(1);
      expect(db.insert).not.toHaveBeenCalled();
    });

    it('preserves existing isFavorite when not provided in dto', async () => {
      const favBookmark = { ...existingBookmark, isFavorite: true };
      db.query.bookmarks.findFirst.mockResolvedValue(favBookmark);
      db.update.mockReturnValue({
        set: mock(function () { return this; }),
        where: mock(function () { return this; }),
        returning: mock(async () => [{ ...favBookmark, status: 'dropped' }]),
      });

      await service.upsert(profileId, { comicId, status: 'dropped' });

      expect(db.update).toHaveBeenCalledTimes(1);
    });

    it('defaults status to plan_to_read when creating', async () => {
      db.query.bookmarks.findFirst.mockResolvedValue(null);
      const insertedBookmark = { id: 3, profileId, comicId, status: 'plan_to_read', isFavorite: false };
      db.insert.mockReturnValue({
        values: mock(function () { return this; }),
        returning: mock(async () => [insertedBookmark]),
      });

      const result = await service.upsert(profileId, { comicId });

      expect(result.status).toBe('plan_to_read');
    });

    it("upsert with status='reading' calls cacheService.del('notifications:updates:profileId')", async () => {
      db.query.bookmarks.findFirst.mockResolvedValue(null);
      db.insert.mockReturnValue({
        values: mock(function () { return this; }),
        returning: mock(async () => [{ id: 5, profileId, comicId, status: 'reading', isFavorite: false }]),
      });

      await service.upsert(profileId, { comicId, status: 'reading' });

      expect(cache.del).toHaveBeenCalledTimes(1);
      expect(cache.del).toHaveBeenCalledWith(`${CACHE_KEYS.NOTIFICATIONS_UPDATES}:${profileId}`);
    });

    it('upsert with status=plan_to_read on a fresh bookmark does NOT call cacheService.del', async () => {
      db.query.bookmarks.findFirst.mockResolvedValue(null);
      db.insert.mockReturnValue({
        values: mock(function () { return this; }),
        returning: mock(async () => [{ id: 6, profileId, comicId, status: 'plan_to_read', isFavorite: false }]),
      });

      await service.upsert(profileId, { comicId, status: 'plan_to_read' });

      expect(cache.del).not.toHaveBeenCalled();
    });
  });

  describe('findAll', () => {
    it('returns all bookmarks for a profile with comic relation', async () => {
      const bookmarksList = [
        { ...existingBookmark, comic: comicRelation },
        { ...existingBookmark, id: 2, comicId: 43, comic: { ...comicRelation, id: 43 } },
      ];
      db.query.bookmarks.findMany.mockResolvedValue(bookmarksList);

      const result = await service.findAll(profileId);

      expect(result).toHaveLength(2);
      expect(db.query.bookmarks.findMany).toHaveBeenCalledTimes(1);
    });
  });

  describe('findByStatus', () => {
    it('returns bookmarks filtered by status', async () => {
      const readingBookmarks = [{ ...existingBookmark, comic: comicRelation }];
      db.query.bookmarks.findMany.mockResolvedValue(readingBookmarks);

      const result = await service.findByStatus(profileId, 'reading');

      expect(result).toHaveLength(1);
      expect(result[0].status).toBe('reading');
      expect(db.query.bookmarks.findMany).toHaveBeenCalledTimes(1);
    });
  });

  describe('findFavorites', () => {
    it('returns only favorite bookmarks', async () => {
      const favorites = [{ ...existingBookmark, isFavorite: true, comic: comicRelation }];
      db.query.bookmarks.findMany.mockResolvedValue(favorites);

      const result = await service.findFavorites(profileId);

      expect(result).toHaveLength(1);
      expect(result[0].isFavorite).toBe(true);
      expect(db.query.bookmarks.findMany).toHaveBeenCalledTimes(1);
    });
  });

  describe('findOne', () => {
    it('returns a bookmark with comic relation', async () => {
      const bookmarkWithComic = { ...existingBookmark, comic: comicRelation };
      db.query.bookmarks.findFirst.mockResolvedValue(bookmarkWithComic);

      const result = await service.findOne(profileId, comicId);

      expect(result).toBeDefined();
      expect(result.comic).toBeDefined();
      expect(result.comic.title).toBe('One Piece');
      expect(db.query.bookmarks.findFirst).toHaveBeenCalledTimes(1);
    });

    it('returns null when bookmark does not exist', async () => {
      db.query.bookmarks.findFirst.mockResolvedValue(null);

      const result = await service.findOne(profileId, 999);

      expect(result).toBeNull();
    });
  });

  describe('update', () => {
    it('updates and returns the bookmark', async () => {
      const bookmarkWithComic = { ...existingBookmark, comic: comicRelation };
      db.query.bookmarks.findFirst.mockResolvedValue(bookmarkWithComic);
      const updatedBookmark = { ...existingBookmark, status: 'completed' };
      db.update.mockReturnValue({
        set: mock(function () { return this; }),
        where: mock(function () { return this; }),
        returning: mock(async () => [updatedBookmark]),
      });

      const result = await service.update(profileId, comicId, { status: 'completed' });

      expect(result.status).toBe('completed');
    });

    it('throws NotFoundException when bookmark does not exist', async () => {
      db.query.bookmarks.findFirst.mockResolvedValue(null);

      await expect(
        service.update(profileId, 999, { status: 'completed' }),
      ).rejects.toThrow('Bookmark not found');
    });

    it("update with non-reading → reading calls cacheService.del('notifications:updates:profileId')", async () => {
      const planBookmark = { ...existingBookmark, status: 'plan_to_read' };
      db.query.bookmarks.findFirst.mockResolvedValue(planBookmark);
      db.update.mockReturnValue({
        set: mock(function () { return this; }),
        where: mock(function () { return this; }),
        returning: mock(async () => [{ ...planBookmark, status: 'reading' }]),
      });

      await service.update(profileId, comicId, { status: 'reading' });

      expect(cache.del).toHaveBeenCalledTimes(1);
      expect(cache.del).toHaveBeenCalledWith(`${CACHE_KEYS.NOTIFICATIONS_UPDATES}:${profileId}`);
    });

    it('update with reading → non-reading calls cacheService.del (out-of-reading transition)', async () => {
      const readingBookmark = { ...existingBookmark, status: 'reading' };
      db.query.bookmarks.findFirst.mockResolvedValue(readingBookmark);
      db.update.mockReturnValue({
        set: mock(function () { return this; }),
        where: mock(function () { return this; }),
        returning: mock(async () => [{ ...readingBookmark, status: 'completed' }]),
      });

      await service.update(profileId, comicId, { status: 'completed' });

      expect(cache.del).toHaveBeenCalledTimes(1);
      expect(cache.del).toHaveBeenCalledWith(`${CACHE_KEYS.NOTIFICATIONS_UPDATES}:${profileId}`);
    });

    it('update with non-reading → non-reading does NOT call cacheService.del', async () => {
      const droppedBookmark = { ...existingBookmark, status: 'dropped' };
      db.query.bookmarks.findFirst.mockResolvedValue(droppedBookmark);
      db.update.mockReturnValue({
        set: mock(function () { return this; }),
        where: mock(function () { return this; }),
        returning: mock(async () => [{ ...droppedBookmark, status: 'plan_to_read' }]),
      });

      await service.update(profileId, comicId, { status: 'plan_to_read' });

      expect(cache.del).not.toHaveBeenCalled();
    });

    it('update with isFavorite only (no status) does NOT call cacheService.del', async () => {
      const planBookmark = { ...existingBookmark, status: 'plan_to_read' };
      db.query.bookmarks.findFirst.mockResolvedValue(planBookmark);
      db.update.mockReturnValue({
        set: mock(function () { return this; }),
        where: mock(function () { return this; }),
        returning: mock(async () => [{ ...planBookmark, isFavorite: true }]),
      });

      await service.update(profileId, comicId, { isFavorite: true });

      expect(cache.del).not.toHaveBeenCalled();
    });
  });

  describe('delete', () => {
    it('deletes the bookmark when it exists', async () => {
      const bookmarkWithComic = { ...existingBookmark, comic: comicRelation };
      db.query.bookmarks.findFirst.mockResolvedValue(bookmarkWithComic);

      await service.delete(profileId, comicId);

      expect(db.delete).toHaveBeenCalledTimes(1);
    });

    it('throws NotFoundException when bookmark does not exist', async () => {
      db.query.bookmarks.findFirst.mockResolvedValue(null);

      await expect(
        service.delete(profileId, 999),
      ).rejects.toThrow('Bookmark not found');
    });
  });
});
