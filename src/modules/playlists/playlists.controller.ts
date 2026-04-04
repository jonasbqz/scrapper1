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
import { VerifiedEmailGuard } from '@/modules/auth/verified-email.guard';
import { CurrentUser, UserSession } from '@/modules/auth/current-user.decorator';
import { PlaylistsService } from './playlists.service';
import { CreatePlaylistDto, UpdatePlaylistDto, ReorderPlaylistDto } from './playlists.dto';

@ApiTags('Playlists')
@Controller('playlists')
export class PlaylistsController {
  constructor(private playlistsService: PlaylistsService) {}

  @Post()
  @UseGuards(AuthGuard, ProfileGuard, VerifiedEmailGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a new playlist' })
  async create(
    @CurrentUser() user: UserSession,
    @Body() dto: CreatePlaylistDto,
  ) {
    return this.playlistsService.create(user.profileId!, dto);
  }

  @Get()
  @UseGuards(AuthGuard, ProfileGuard, VerifiedEmailGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get all playlists of the current user' })
  async findByUser(@CurrentUser() user: UserSession) {
    return this.playlistsService.findByUser(user.profileId!);
  }

  @Get('public')
  @ApiOperation({ summary: 'Get public playlists' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'offset', required: false, type: Number })
  async findPublic(
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.playlistsService.findPublic(
      limit ? parseInt(limit, 10) : 20,
      offset ? parseInt(offset, 10) : 0,
    );
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
    return this.playlistsService.findByIdForUser(id, user?.profileId ?? null);
  }

  @Patch(':id')
  @UseGuards(AuthGuard, ProfileGuard, VerifiedEmailGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update a playlist' })
  async update(
    @CurrentUser() user: UserSession,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePlaylistDto,
  ) {
    return this.playlistsService.update(user.profileId!, id, dto);
  }

  @Delete(':id')
  @UseGuards(AuthGuard, ProfileGuard, VerifiedEmailGuard)
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
  @UseGuards(AuthGuard, ProfileGuard, VerifiedEmailGuard)
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
  @UseGuards(AuthGuard, ProfileGuard, VerifiedEmailGuard)
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
  @UseGuards(AuthGuard, ProfileGuard, VerifiedEmailGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Reorder comics in a playlist' })
  async reorder(
    @CurrentUser() user: UserSession,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReorderPlaylistDto,
  ) {
    return this.playlistsService.reorderComics(user.profileId!, id, dto);
  }
}
