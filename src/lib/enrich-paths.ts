import type { RouteProtectionService } from '@/modules/route-protection/route-protection.service';

type ComicShape = {
  id: number;
  slug: string;
  protectedRouteEnabled?: boolean | null;
};

type ChapterShape = {
  id: number;
  slug: string;
};

type EntryWithRelations = {
  comic?: ComicShape | null;
  chapter?: ChapterShape | null;
  [key: string]: unknown;
};

export async function enrichEntriesWithPaths<T extends EntryWithRelations>(
  entries: T[],
  routeProtectionService: RouteProtectionService,
): Promise<T[]> {
  if (entries.length === 0) {
    return entries;
  }

  const comicsById = new Map<number, ComicShape>();
  entries.forEach((entry) => {
    if (entry.comic) {
      comicsById.set(entry.comic.id, entry.comic);
    }
  });

  const comicPaths = new Map<number, string>();
  await Promise.all(
    Array.from(comicsById.values()).map(async (comic) => {
      comicPaths.set(comic.id, await routeProtectionService.getComicPath(comic));
    }),
  );

  const chapterPaths = new Map<number, string>();
  await Promise.all(
    entries.map(async (entry) => {
      if (!entry.comic || !entry.chapter) {
        return;
      }

      const comicPath = comicPaths.get(entry.comic.id);
      if (!comicPath) {
        return;
      }

      chapterPaths.set(
        entry.chapter.id,
        await routeProtectionService.getChapterPath(entry.comic, entry.chapter, { comicPath }),
      );
    }),
  );

  return entries.map((entry) => {
    if (!entry.comic) {
      return entry;
    }

    const comicPath = comicPaths.get(entry.comic.id);
    const chapterPath = entry.chapter ? chapterPaths.get(entry.chapter.id) : undefined;

    return {
      ...entry,
      comic: {
        ...entry.comic,
        comicPath,
      },
      chapter: entry.chapter
        ? {
            ...entry.chapter,
            chapterPath,
          }
        : entry.chapter,
    };
  });
}

export async function enrichBookmarksWithPaths<T extends { comic?: ComicShape | null }>(
  bookmarks: T[],
  routeProtectionService: RouteProtectionService,
): Promise<T[]> {
  if (bookmarks.length === 0) {
    return bookmarks;
  }

  const comicsById = new Map<number, ComicShape>();
  bookmarks.forEach((bookmark) => {
    if (bookmark.comic) {
      comicsById.set(bookmark.comic.id, bookmark.comic);
    }
  });

  const comicPaths = new Map<number, string>();
  await Promise.all(
    Array.from(comicsById.values()).map(async (comic) => {
      comicPaths.set(comic.id, await routeProtectionService.getComicPath(comic));
    }),
  );

  return bookmarks.map((bookmark) => {
    if (!bookmark.comic) {
      return bookmark;
    }

    return {
      ...bookmark,
      comic: {
        ...bookmark.comic,
        comicPath: comicPaths.get(bookmark.comic.id),
      },
    };
  });
}
