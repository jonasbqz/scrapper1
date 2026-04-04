import { Injectable, Inject, NotFoundException, ForbiddenException, ConflictException } from '@nestjs/common';
import { eq, and, desc, asc, count } from 'drizzle-orm';
import { DATABASE_CONNECTION } from '@/database/database.module';
import { playlists, playlistItems } from '@/database/schema';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '@/database/schema';
import { CreatePlaylistDto, UpdatePlaylistDto, ReorderPlaylistDto } from './playlists.dto';

@Injectable()
export class PlaylistsService {
  constructor(
    @Inject(DATABASE_CONNECTION)
    private db: NodePgDatabase<typeof schema>,
  ) {}

  async create(profileId: string, dto: CreatePlaylistDto) {
    const [playlist] = await this.db.insert(playlists).values({
      profileId,
      name: dto.name,
      description: dto.description,
      isPublic: dto.isPublic ?? false,
      coverImage: dto.coverImage,
    }).returning();

    return playlist;
  }

  async findById(id: string) {
    return this.db.query.playlists.findFirst({
      where: eq(playlists.id, id),
      with: {
        profile: {
          columns: {
            id: true,
            username: true,
            visibleName: true,
            avatarUrl: true,
          },
        },
        items: {
          orderBy: [asc(playlistItems.order)],
          with: {
            comic: {
              columns: {
                id: true,
                title: true,
                coverImage: true,
                slug: true,
                type: true,
                status: true,
                protectedRouteEnabled: true,
              },
            },
          },
        },
      },
    });
  }

  async findByIdForUser(playlistId: string, profileId: string | null) {
    const playlist = await this.findById(playlistId);

    if (!playlist) {
      throw new NotFoundException('Playlist not found');
    }

    // If private and not the owner, deny access
    if (!playlist.isPublic && playlist.profileId !== profileId) {
      throw new ForbiddenException('This playlist is private');
    }

    return playlist;
  }

  async findByUser(profileId: string) {
    return this.db.query.playlists.findMany({
      where: eq(playlists.profileId, profileId),
      orderBy: [desc(playlists.updatedAt)],
      with: {
        items: {
          limit: 4,
          orderBy: [asc(playlistItems.order)],
          with: {
            comic: {
              columns: {
                id: true,
                title: true,
                coverImage: true,
                slug: true,
                type: true,
                status: true,
                protectedRouteEnabled: true,
              },
            },
          },
        },
      },
    });
  }

  async findPublic(limit = 20, offset = 0) {
    return this.db.query.playlists.findMany({
      where: eq(playlists.isPublic, true),
      orderBy: [desc(playlists.updatedAt)],
      limit,
      offset,
      with: {
        profile: {
          columns: {
            id: true,
            username: true,
            visibleName: true,
            avatarUrl: true,
          },
        },
        items: {
          limit: 4,
          orderBy: [asc(playlistItems.order)],
          with: {
            comic: {
              columns: {
                id: true,
                title: true,
                coverImage: true,
                slug: true,
                type: true,
                status: true,
                protectedRouteEnabled: true,
              },
            },
          },
        },
      },
    });
  }

  async update(profileId: string, playlistId: string, dto: UpdatePlaylistDto) {
    const playlist = await this.findById(playlistId);
    if (!playlist) {
      throw new NotFoundException('Playlist not found');
    }

    if (playlist.profileId !== profileId) {
      throw new ForbiddenException('You can only edit your own playlists');
    }

    const [updated] = await this.db
      .update(playlists)
      .set({
        ...dto,
        updatedAt: new Date(),
      })
      .where(eq(playlists.id, playlistId))
      .returning();

    return this.findById(updated.id);
  }

  async delete(profileId: string, playlistId: string) {
    const playlist = await this.findById(playlistId);
    if (!playlist) {
      throw new NotFoundException('Playlist not found');
    }

    if (playlist.profileId !== profileId) {
      throw new ForbiddenException('You can only delete your own playlists');
    }

    await this.db.delete(playlists).where(eq(playlists.id, playlistId));
  }

  async addComic(profileId: string, playlistId: string, comicId: number) {
    const playlist = await this.findById(playlistId);
    if (!playlist) {
      throw new NotFoundException('Playlist not found');
    }

    if (playlist.profileId !== profileId) {
      throw new ForbiddenException('You can only modify your own playlists');
    }

    // Check if comic already exists in playlist
    const existing = await this.db.query.playlistItems.findFirst({
      where: and(
        eq(playlistItems.playlistId, playlistId),
        eq(playlistItems.comicId, comicId),
      ),
    });

    if (existing) {
      throw new ConflictException('Comic already exists in this playlist');
    }

    // Get the max order number
    const maxOrder = playlist.items.reduce((max, item) => Math.max(max, item.order ?? 0), -1);

    const [item] = await this.db.insert(playlistItems).values({
      playlistId,
      comicId,
      order: maxOrder + 1,
    }).returning();

    // Update playlist timestamp
    await this.db
      .update(playlists)
      .set({ updatedAt: new Date() })
      .where(eq(playlists.id, playlistId));

    return item;
  }

  async removeComic(profileId: string, playlistId: string, comicId: number) {
    const playlist = await this.findById(playlistId);
    if (!playlist) {
      throw new NotFoundException('Playlist not found');
    }

    if (playlist.profileId !== profileId) {
      throw new ForbiddenException('You can only modify your own playlists');
    }

    const existing = await this.db.query.playlistItems.findFirst({
      where: and(
        eq(playlistItems.playlistId, playlistId),
        eq(playlistItems.comicId, comicId),
      ),
    });

    if (!existing) {
      throw new NotFoundException('Comic not found in this playlist');
    }

    await this.db.delete(playlistItems).where(eq(playlistItems.id, existing.id));

    // Update playlist timestamp
    await this.db
      .update(playlists)
      .set({ updatedAt: new Date() })
      .where(eq(playlists.id, playlistId));
  }

  async reorderComics(profileId: string, playlistId: string, dto: ReorderPlaylistDto) {
    const playlist = await this.findById(playlistId);
    if (!playlist) {
      throw new NotFoundException('Playlist not found');
    }

    if (playlist.profileId !== profileId) {
      throw new ForbiddenException('You can only modify your own playlists');
    }

    // Update order for each item
    for (const item of dto.items) {
      await this.db
        .update(playlistItems)
        .set({ order: item.order })
        .where(
          and(
            eq(playlistItems.playlistId, playlistId),
            eq(playlistItems.comicId, item.comicId),
          ),
        );
    }

    // Update playlist timestamp
    await this.db
      .update(playlists)
      .set({ updatedAt: new Date() })
      .where(eq(playlists.id, playlistId));

    return this.findById(playlistId);
  }

  async getUserPlaylistsCount(profileId: string): Promise<number> {
    const result = await this.db
      .select({ count: count() })
      .from(playlists)
      .where(eq(playlists.profileId, profileId));
    return result[0]?.count ?? 0;
  }

  /**
   * Get public playlists for sitemap (optimized - only id and updatedAt)
   */
  async getSitemapPlaylists(): Promise<Array<{ id: string; updatedAt: Date | null }>> {
    return this.db
      .select({
        id: playlists.id,
        updatedAt: playlists.updatedAt,
      })
      .from(playlists)
      .where(eq(playlists.isPublic, true))
      .orderBy(desc(playlists.updatedAt));
  }
}
