import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  UseGuards,
  ParseIntPipe,
  NotFoundException,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '@/modules/auth/auth.guard';
import { ProfileGuard } from '@/modules/auth/profile.guard';
import { VerifiedEmailGuard } from '@/modules/auth/verified-email.guard';
import { CurrentUser, UserSession } from '@/modules/auth/current-user.decorator';
import { BookmarkService } from './bookmark.service';
import { CreateBookmarkDto, UpdateBookmarkDto } from './bookmark.dto';
import { RouteProtectionService } from '@/modules/route-protection/route-protection.service';

@ApiTags('Bookmarks')
@Controller('bookmarks')
@UseGuards(AuthGuard, ProfileGuard, VerifiedEmailGuard)
@ApiBearerAuth()
export class BookmarkController {
  constructor(
    private bookmarkService: BookmarkService,
    private routeProtectionService: RouteProtectionService,
  ) {}

  private async enrichBookmark(bookmark: any): Promise<any> {
    if (!bookmark?.comic) {
      return bookmark;
    }

    return {
      ...bookmark,
      comic: {
        ...bookmark.comic,
        comicPath: await this.routeProtectionService.getComicPath(bookmark.comic),
      },
    };
  }

  @Post()
  @ApiOperation({ summary: 'Create or update bookmark' })
  async upsert(
    @CurrentUser() user: UserSession,
    @Body() dto: CreateBookmarkDto,
  ) {
    const bookmark = await this.bookmarkService.upsert(user.profileId!, dto);
    return this.enrichBookmark(bookmark);
  }

  @Get()
  @ApiOperation({ summary: 'Get all bookmarks' })
  async findAll(@CurrentUser() user: UserSession) {
    const bookmarks = await this.bookmarkService.findAll(user.profileId!);
    return Promise.all(bookmarks.map((bookmark) => this.enrichBookmark(bookmark)));
  }

  @Get('favorites')
  @ApiOperation({ summary: 'Get favorite bookmarks' })
  async findFavorites(@CurrentUser() user: UserSession) {
    const bookmarks = await this.bookmarkService.findFavorites(user.profileId!);
    return Promise.all(bookmarks.map((bookmark) => this.enrichBookmark(bookmark)));
  }

  @Get('status/:status')
  @ApiOperation({ summary: 'Get bookmarks by status' })
  async findByStatus(
    @CurrentUser() user: UserSession,
    @Param('status') status: string,
  ) {
    const bookmarks = await this.bookmarkService.findByStatus(user.profileId!, status);
    return Promise.all(bookmarks.map((bookmark) => this.enrichBookmark(bookmark)));
  }

  @Get(':comicId')
  @ApiOperation({ summary: 'Get bookmark for a comic' })
  async findOne(
    @CurrentUser() user: UserSession,
    @Param('comicId', ParseIntPipe) comicId: number,
  ) {
    const bookmark = await this.bookmarkService.findOne(user.profileId!, comicId);
    if (!bookmark) {
      throw new NotFoundException('Bookmark not found');
    }
    return this.enrichBookmark(bookmark);
  }

  @Put(':comicId')
  @ApiOperation({ summary: 'Update bookmark' })
  async update(
    @CurrentUser() user: UserSession,
    @Param('comicId', ParseIntPipe) comicId: number,
    @Body() dto: UpdateBookmarkDto,
  ) {
    const bookmark = await this.bookmarkService.update(user.profileId!, comicId, dto);
    return this.enrichBookmark(bookmark);
  }

  @Delete(':comicId')
  @ApiOperation({ summary: 'Delete bookmark' })
  async delete(
    @CurrentUser() user: UserSession,
    @Param('comicId', ParseIntPipe) comicId: number,
  ) {
    await this.bookmarkService.delete(user.profileId!, comicId);
    return { success: true };
  }
}
