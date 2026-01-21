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
import { CurrentUser, UserSession } from '@/modules/auth/current-user.decorator';
import { BookmarkService } from './bookmark.service';
import { CreateBookmarkDto, UpdateBookmarkDto } from './bookmark.dto';

@ApiTags('Bookmarks')
@Controller('bookmarks')
@UseGuards(AuthGuard, ProfileGuard)
@ApiBearerAuth()
export class BookmarkController {
  constructor(private bookmarkService: BookmarkService) {}

  @Post()
  @ApiOperation({ summary: 'Create or update bookmark' })
  async upsert(
    @CurrentUser() user: UserSession,
    @Body() dto: CreateBookmarkDto,
  ) {
    return this.bookmarkService.upsert(user.profileId!, dto);
  }

  @Get()
  @ApiOperation({ summary: 'Get all bookmarks' })
  async findAll(@CurrentUser() user: UserSession) {
    return this.bookmarkService.findAll(user.profileId!);
  }

  @Get('favorites')
  @ApiOperation({ summary: 'Get favorite bookmarks' })
  async findFavorites(@CurrentUser() user: UserSession) {
    return this.bookmarkService.findFavorites(user.profileId!);
  }

  @Get('status/:status')
  @ApiOperation({ summary: 'Get bookmarks by status' })
  async findByStatus(
    @CurrentUser() user: UserSession,
    @Param('status') status: string,
  ) {
    return this.bookmarkService.findByStatus(user.profileId!, status);
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
    return bookmark;
  }

  @Put(':comicId')
  @ApiOperation({ summary: 'Update bookmark' })
  async update(
    @CurrentUser() user: UserSession,
    @Param('comicId', ParseIntPipe) comicId: number,
    @Body() dto: UpdateBookmarkDto,
  ) {
    return this.bookmarkService.update(user.profileId!, comicId, dto);
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
