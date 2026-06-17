import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { ReadingHistoryService } from './reading-history.service';
import { CACHE_KEYS } from '@/cache/cache.service';

function createMockDb() {
  const selectResult = [];
  const selectChain = {
    from: mock(() => selectChain),
    where: mock(() => selectChain),
    groupBy: mock(() => selectChain),
    orderBy: mock(() => selectChain),
    limit: mock(() => selectChain),
    offset: mock(() => selectChain),
    then: mock((resolve) => Promise.resolve(selectResult).then(resolve)),
  };

  return {
    select: mock(() => selectChain),
    query: {
      readingHistory: {
        findFirst: mock(async () => null),
        findMany: mock(async () => []),
      },
    },
    insert: mock(() => ({
      values: mock(function () { return this; }),
      onConflictDoUpdate: mock(function () { return this; }),
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

describe('ReadingHistoryService', () => {
  let service;
  let db;
  let cache;

  beforeEach(() => {
    db = createMockDb();
    cache = createMockCache();
    service = new ReadingHistoryService(db, cache);
  });

  const profileId = 'profile-1';
  const otherProfileId = 'profile-2';

  const existingEntry = {
    id: 'entry-1',
    profileId: 'profile-1',
    comicId: 42,
    chapterId: 10,
    progressPercentage: 50,
    readAt: new Date('2025-01-15'),
    updatedAt: new Date('2025-01-15'),
  };

  const comicRelation = {
    id: 42,
    title: 'One Piece',
    slug: 'one-piece',
  };

  const chapterRelation = {
    id: 10,
    chapterNumber: 100,
    title: 'Chapter 100',
  };

  describe('record', () => {
    it('creates a new entry when no existing record', async () => {
      const newEntry = {
        id: 'entry-new',
        profileId,
        comicId: 42,
        chapterId: 10,
        progressPercentage: 30,
        readAt: new Date(),
      };
      db.insert.mockReturnValue({
        values: mock(function () { return this; }),
        onConflictDoUpdate: mock(function () { return this; }),
        returning: mock(async () => [newEntry]),
      });

      const result = await service.record(profileId, {
        comicId: 42,
        chapterId: 10,
        progressPercentage: 30,
      });

      expect(result.id).toBe('entry-new');
      expect(result.progressPercentage).toBe(30);
      expect(db.insert).toHaveBeenCalledTimes(1);
      expect(db.update).not.toHaveBeenCalled();
    });

    it('upserts an existing entry', async () => {
      const updatedEntry = {
        ...existingEntry,
        progressPercentage: 75,
        readAt: new Date(),
        updatedAt: new Date(),
      };
      db.insert.mockReturnValue({
        values: mock(function () { return this; }),
        onConflictDoUpdate: mock(function () { return this; }),
        returning: mock(async () => [updatedEntry]),
      });

      const result = await service.record(profileId, {
        comicId: 42,
        chapterId: 10,
        progressPercentage: 75,
      });

      expect(result.progressPercentage).toBe(75);
      expect(db.insert).toHaveBeenCalledTimes(1);
      expect(db.update).not.toHaveBeenCalled();
    });

    it('defaults progressPercentage to 0 when creating without it', async () => {
      const newEntry = {
        id: 'entry-new',
        profileId,
        comicId: 42,
        chapterId: 10,
        progressPercentage: 0,
      };
      db.insert.mockReturnValue({
        values: mock(function () { return this; }),
        onConflictDoUpdate: mock(function () { return this; }),
        returning: mock(async () => [newEntry]),
      });

      const result = await service.record(profileId, {
        comicId: 42,
        chapterId: 10,
      });

      expect(result.progressPercentage).toBe(0);
    });

    it("record() calls cacheService.del('notifications:updates:profileId') after a successful insert", async () => {
      const newEntry = {
        id: 'entry-new',
        profileId,
        comicId: 42,
        chapterId: 10,
        progressPercentage: 30,
      };
      db.insert.mockReturnValue({
        values: mock(function () { return this; }),
        onConflictDoUpdate: mock(function () { return this; }),
        returning: mock(async () => [newEntry]),
      });

      await service.record(profileId, { comicId: 42, chapterId: 10, progressPercentage: 30 });

      expect(cache.del).toHaveBeenCalledTimes(1);
      expect(cache.del).toHaveBeenCalledWith(`${CACHE_KEYS.NOTIFICATIONS_UPDATES}:${profileId}`);
    });
  });

  describe('findAll', () => {
    it('returns reading history entries with relations', async () => {
      const entries = [
        { ...existingEntry, comic: comicRelation, chapter: chapterRelation },
      ];
      db.query.readingHistory.findMany.mockResolvedValue(entries);

      const result = await service.findAll(profileId);

      expect(result).toHaveLength(1);
      expect(result[0].comic.title).toBe('One Piece');
      expect(db.query.readingHistory.findMany).toHaveBeenCalledTimes(1);
    });

    it('clamps limit to valid range', async () => {
      db.query.readingHistory.findMany.mockResolvedValue([]);

      await service.findAll(profileId, 100, 0);

      expect(db.query.readingHistory.findMany).toHaveBeenCalledTimes(1);
    });

    it('handles invalid limit gracefully', async () => {
      db.query.readingHistory.findMany.mockResolvedValue([]);

      await service.findAll(profileId, NaN, -5);

      expect(db.query.readingHistory.findMany).toHaveBeenCalledTimes(1);
    });
  });

  describe('findGroupedByComic', () => {
    it('groups entries by comic with pagination', async () => {
      // Mock the select chain for grouped comics query
      // groupedComics returns comicId + lastReadAt, we add an extra to test hasMore
      const groupedComics = [
        { comicId: 42, lastReadAt: new Date('2025-01-20') },
        { comicId: 43, lastReadAt: new Date('2025-01-19') },
        { comicId: 44, lastReadAt: new Date('2025-01-18') }, // extra for hasMore (limit is 2)
      ];

      const selectResult = groupedComics;
      const selectChain = {
        from: mock(() => selectChain),
        where: mock(() => selectChain),
        groupBy: mock(() => selectChain),
        orderBy: mock(() => selectChain),
        limit: mock(() => selectChain),
        offset: mock(() => selectChain),
        then: mock((resolve) => Promise.resolve(selectResult).then(resolve)),
      };
      db.select.mockReturnValue(selectChain);

      const comic42Entries = [
        { id: 'e1', profileId, comicId: 42, chapterId: 10, readAt: new Date('2025-01-20'), comic: comicRelation, chapter: chapterRelation },
        { id: 'e2', profileId, comicId: 42, chapterId: 11, readAt: new Date('2025-01-19'), comic: comicRelation, chapter: { ...chapterRelation, id: 11 } },
      ];
      const comic43Entries = [
        { id: 'e3', profileId, comicId: 43, chapterId: 20, readAt: new Date('2025-01-18'), comic: { ...comicRelation, id: 43 }, chapter: { ...chapterRelation, id: 20 } },
      ];
      db.query.readingHistory.findMany
        .mockResolvedValueOnce(comic42Entries)
        .mockResolvedValueOnce(comic43Entries);

      const result = await service.findGroupedByComic(profileId, 2, 0, 4);

      expect(result.items).toHaveLength(2);
      expect(result.hasMore).toBe(true);
      expect(result.items[0].comicId).toBe(42);
      expect(result.items[0].entries).toHaveLength(2);
      expect(result.items[1].comicId).toBe(43);
      expect(result.items[1].entries).toHaveLength(1);
    });

    it('respects chaptersLimit per comic', async () => {
      const groupedComics = [
        { comicId: 42, lastReadAt: new Date('2025-01-20') },
      ];

      const selectChain = {
        from: mock(() => selectChain),
        where: mock(() => selectChain),
        groupBy: mock(() => selectChain),
        orderBy: mock(() => selectChain),
        limit: mock(() => selectChain),
        offset: mock(() => selectChain),
        then: mock((resolve) => Promise.resolve(groupedComics).then(resolve)),
      };
      db.select.mockReturnValue(selectChain);

      const limitedEntries = Array.from({ length: 2 }, (_, i) => ({
        id: `e${i}`,
        profileId,
        comicId: 42,
        chapterId: 10 + i,
        readAt: new Date(`2025-01-${20 - i}`),
        comic: comicRelation,
        chapter: { ...chapterRelation, id: 10 + i },
      }));
      db.query.readingHistory.findMany.mockResolvedValueOnce(limitedEntries);

      const result = await service.findGroupedByComic(profileId, 20, 0, 2);

      expect(result.items[0].entries).toHaveLength(2);
    });

    it('returns empty items when no grouped comics', async () => {
      const selectChain = {
        from: mock(() => selectChain),
        where: mock(() => selectChain),
        groupBy: mock(() => selectChain),
        orderBy: mock(() => selectChain),
        limit: mock(() => selectChain),
        offset: mock(() => selectChain),
        then: mock((resolve) => Promise.resolve([]).then(resolve)),
      };
      db.select.mockReturnValue(selectChain);

      const result = await service.findGroupedByComic(profileId);

      expect(result.items).toHaveLength(0);
      expect(result.hasMore).toBe(false);
    });

    it('returns hasMore false when total equals limit', async () => {
      const groupedComics = [
        { comicId: 42, lastReadAt: new Date('2025-01-20') },
      ];

      const selectChain = {
        from: mock(() => selectChain),
        where: mock(() => selectChain),
        groupBy: mock(() => selectChain),
        orderBy: mock(() => selectChain),
        limit: mock(() => selectChain),
        offset: mock(() => selectChain),
        then: mock((resolve) => Promise.resolve(groupedComics).then(resolve)),
      };
      db.select.mockReturnValue(selectChain);
      db.query.readingHistory.findMany.mockResolvedValue([]);

      const result = await service.findGroupedByComic(profileId, 20, 0, 4);

      expect(result.hasMore).toBe(false);
    });
  });

  describe('findByComic', () => {
    it('returns entries for a specific comic with relations', async () => {
      const entries = [
        { ...existingEntry, comic: comicRelation, chapter: chapterRelation },
        { ...existingEntry, id: 'e2', chapterId: 11, chapter: { ...chapterRelation, id: 11 } },
      ];
      db.query.readingHistory.findMany.mockResolvedValue(entries);

      const result = await service.findByComic(profileId, 42);

      expect(result).toHaveLength(2);
      expect(result[0].comic.title).toBe('One Piece');
      expect(db.query.readingHistory.findMany).toHaveBeenCalledTimes(1);
    });
  });

  describe('delete', () => {
    it('deletes an entry owned by the profile', async () => {
      db.query.readingHistory.findFirst.mockResolvedValue(existingEntry);

      await service.delete(profileId, 'entry-1');

      expect(db.delete).toHaveBeenCalledTimes(1);
    });

    it('throws NotFoundException for wrong profile', async () => {
      db.query.readingHistory.findFirst.mockResolvedValue(null);

      await expect(
        service.delete(otherProfileId, 'entry-1'),
      ).rejects.toThrow('Reading history entry not found');

      expect(db.delete).not.toHaveBeenCalled();
    });

    it('throws NotFoundException for non-existent entry', async () => {
      db.query.readingHistory.findFirst.mockResolvedValue(null);

      await expect(
        service.delete(profileId, 'non-existent'),
      ).rejects.toThrow('Reading history entry not found');
    });
  });
});
