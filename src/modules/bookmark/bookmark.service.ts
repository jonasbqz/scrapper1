import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { eq, and, desc } from 'drizzle-orm';
import { DATABASE_CONNECTION } from '@/database/database.module';
import { bookmarks } from '@/database/schema';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '@/database/schema';
import { CreateBookmarkDto, UpdateBookmarkDto } from './bookmark.dto';

@Injectable()
export class BookmarkService {
  constructor(
    @Inject(DATABASE_CONNECTION)
    private db: NodePgDatabase<typeof schema>,
  ) {}

  async upsert(profileId: string, dto: CreateBookmarkDto) {
    const existing = await this.db.query.bookmarks.findFirst({
      where: and(
        eq(bookmarks.profileId, profileId),
        eq(bookmarks.comicId, dto.comicId),
      ),
    });

    if (existing) {
      const [updated] = await this.db
        .update(bookmarks)
        .set({
          status: dto.status,
          isFavorite: dto.isFavorite ?? existing.isFavorite,
          updatedAt: new Date(),
        })
        .where(eq(bookmarks.id, existing.id))
        .returning();
      return updated;
    }

    const [bookmark] = await this.db.insert(bookmarks).values({
      profileId,
      comicId: dto.comicId,
      status: dto.status || 'plan_to_read',
      isFavorite: dto.isFavorite || false,
    }).returning();

    return bookmark;
  }

  async findAll(profileId: string) {
    return this.db.query.bookmarks.findMany({
      where: eq(bookmarks.profileId, profileId),
      orderBy: [desc(bookmarks.updatedAt)],
      with: {
        comic: true,
      },
    });
  }

  async findByStatus(profileId: string, status: string) {
    return this.db.query.bookmarks.findMany({
      where: and(
        eq(bookmarks.profileId, profileId),
        eq(bookmarks.status, status as any),
      ),
      orderBy: [desc(bookmarks.updatedAt)],
      with: {
        comic: true,
      },
    });
  }

  async findFavorites(profileId: string) {
    return this.db.query.bookmarks.findMany({
      where: and(
        eq(bookmarks.profileId, profileId),
        eq(bookmarks.isFavorite, true),
      ),
      orderBy: [desc(bookmarks.updatedAt)],
      with: {
        comic: true,
      },
    });
  }

  async findOne(profileId: string, comicId: number) {
    return this.db.query.bookmarks.findFirst({
      where: and(
        eq(bookmarks.profileId, profileId),
        eq(bookmarks.comicId, comicId),
      ),
      with: {
        comic: true,
      },
    });
  }

  async update(profileId: string, comicId: number, dto: UpdateBookmarkDto) {
    const existing = await this.findOne(profileId, comicId);
    if (!existing) {
      throw new NotFoundException('Bookmark not found');
    }

    const [updated] = await this.db
      .update(bookmarks)
      .set({
        ...dto,
        updatedAt: new Date(),
      })
      .where(eq(bookmarks.id, existing.id))
      .returning();

    return updated;
  }

  async delete(profileId: string, comicId: number) {
    const existing = await this.findOne(profileId, comicId);
    if (!existing) {
      throw new NotFoundException('Bookmark not found');
    }

    await this.db.delete(bookmarks).where(eq(bookmarks.id, existing.id));
  }
}
