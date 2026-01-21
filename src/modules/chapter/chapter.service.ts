import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { eq, desc, sql, and, gt, lt } from 'drizzle-orm';
import { DATABASE_CONNECTION } from '@/database/database.module';
import { chapters, comicScans } from '@/database/schema';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '@/database/schema';

@Injectable()
export class ChapterService {
  constructor(
    @Inject(DATABASE_CONNECTION)
    private db: NodePgDatabase<typeof schema>,
  ) {}

  async findByComicScan(comicScanId: number) {
    return this.db.query.chapters.findMany({
      where: eq(chapters.comicScanId, comicScanId),
      orderBy: [desc(chapters.chapterNumber)],
    });
  }

  async findById(id: number) {
    const chapter = await this.db.query.chapters.findFirst({
      where: eq(chapters.id, id),
      with: {
        comicScan: {
          with: {
            comic: true,
            scanGroup: true,
          },
        },
      },
    });

    if (!chapter) {
      throw new NotFoundException('Chapter not found');
    }

    return chapter;
  }

  async getNavigation(chapterId: number) {
    const chapter = await this.findById(chapterId);

    const [prevChapter, nextChapter] = await Promise.all([
      this.db.query.chapters.findFirst({
        where: and(
          eq(chapters.comicScanId, chapter.comicScanId),
          lt(chapters.chapterNumber, chapter.chapterNumber),
        ),
        orderBy: [desc(chapters.chapterNumber)],
      }),
      this.db.query.chapters.findFirst({
        where: and(
          eq(chapters.comicScanId, chapter.comicScanId),
          gt(chapters.chapterNumber, chapter.chapterNumber),
        ),
        orderBy: [chapters.chapterNumber],
      }),
    ]);

    return {
      current: chapter,
      prev: prevChapter || null,
      next: nextChapter || null,
    };
  }

  async incrementViews(id: number) {
    await this.db
      .update(chapters)
      .set({ views: sql`${chapters.views} + 1` })
      .where(eq(chapters.id, id));
  }

  async getPages(id: number) {
    const chapter = await this.db.query.chapters.findFirst({
      where: eq(chapters.id, id),
      columns: {
        id: true,
        urlPages: true,
        copyrighted: true,
      },
    });

    if (!chapter) {
      throw new NotFoundException('Chapter not found');
    }

    if (chapter.copyrighted) {
      return { pages: [], copyrighted: true };
    }

    return { pages: chapter.urlPages, copyrighted: false };
  }
}
