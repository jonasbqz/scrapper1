import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  ParseIntPipe,
  ParseUUIDPipe,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags, ApiQuery } from '@nestjs/swagger';
import { AuthGuard } from '@/modules/auth/auth.guard';
import { ProfileGuard } from '@/modules/auth/profile.guard';
import { CurrentUser, UserSession } from '@/modules/auth/current-user.decorator';
import { PlaylistsService } from './playlists.service';
import { CreatePlaylistDto, UpdatePlaylistDto, ReorderPlaylistDto } from './playlists.dto';
import { RouteProtectionService } from '@/modules/route-protection/route-protection.service';

@ApiTags('Playlists')
@Controller('playlists')
export class PlaylistsController {
  constructor(
    private playlistsService: PlaylistsService,
    private routeProtectionService: RouteProtectionService,
  ) {}

  private async enrichPlaylist(playlist: any): Promise<any> {
    if (!playlist?.items?.length) {
      return playlist;
    }

    const items = await Promise.all(
      playlist.items.map(async (item: any) => {
        if (!item?.comic) {
          return item;
        }

        return {
          ...item,
          comic: {
            ...item.comic,
            comicPath: await this.routeProtectionService.getComicPath(item.comic),
          },
        };
      }),
    );

    return {
      ...playlist,
      items,
    };
  }

  @Post()
  @UseGuards(AuthGuard, ProfileGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a new playlist' })
  async create(
    @CurrentUser() user: UserSession,
    @Body() dto: CreatePlaylistDto,
  ) {
    return this.playlistsService.create(user.profileId!, dto);
  }

  @Get()
  @UseGuards(AuthGuard, ProfileGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get all playlists of the current user' })
  async findByUser(@CurrentUser() user: UserSession) {
    const playlists = await this.playlistsService.findByUser(user.profileId!);
    return Promise.all(playlists.map((playlist) => this.enrichPlaylist(playlist)));
  }

  @Get('public')
  @ApiOperation({ summary: 'Get public playlists' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'offset', required: false, type: Number })
  async findPublic(
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const playlists = await this.playlistsService.findPublic(
      limit ? parseInt(limit, 10) : 20,
      offset ? parseInt(offset, 10) : 0,
    );
    return Promise.all(playlists.map((playlist) => this.enrichPlaylist(playlist)));
  }

  @Get('sitemap/list')
  @ApiOperation({ summary: 'Get public playlists for sitemap (optimized)' })
  async getSitemapPlaylists() {
    return this.playlistsService.getSitemapPlaylists();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a playlist by ID (public if public, or owner)' })
  async findById(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user?: UserSession,
  ) {
    const playlist = await this.playlistsService.findByIdForUser(id, user?.profileId ?? null);
    return this.enrichPlaylist(playlist);
  }

  @Patch(':id')
  @UseGuards(AuthGuard, ProfileGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update a playlist' })
  async update(
    @CurrentUser() user: UserSession,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePlaylistDto,
  ) {
    const playlist = await this.playlistsService.update(user.profileId!, id, dto);
    return this.enrichPlaylist(playlist);
  }

  @Delete(':id')
  @UseGuards(AuthGuard, ProfileGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Delete a playlist' })
  async delete(
    @CurrentUser() user: UserSession,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.playlistsService.delete(user.profileId!, id);
    return { success: true };
  }

  @Post(':id/comics/:comicId')
  @UseGuards(AuthGuard, ProfileGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Add a comic to a playlist' })
  async addComic(
    @CurrentUser() user: UserSession,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('comicId', ParseIntPipe) comicId: number,
  ) {
    return this.playlistsService.addComic(user.profileId!, id, comicId);
  }

  @Delete(':id/comics/:comicId')
  @UseGuards(AuthGuard, ProfileGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Remove a comic from a playlist' })
  async removeComic(
    @CurrentUser() user: UserSession,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('comicId', ParseIntPipe) comicId: number,
  ) {
    await this.playlistsService.removeComic(user.profileId!, id, comicId);
    return { success: true };
  }

  @Patch(':id/reorder')
  @UseGuards(AuthGuard, ProfileGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Reorder comics in a playlist' })
  async reorder(
    @CurrentUser() user: UserSession,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReorderPlaylistDto,
  ) {
    const playlist = await this.playlistsService.reorderComics(user.profileId!, id, dto);
    return this.enrichPlaylist(playlist);
  }
}
