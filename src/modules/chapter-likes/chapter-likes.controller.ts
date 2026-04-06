import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  UseGuards,
  ParseIntPipe,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '@/modules/auth/auth.guard';
import { ProfileGuard } from '@/modules/auth/profile.guard';
import { CurrentUser, UserSession } from '@/modules/auth/current-user.decorator';
import { ChapterLikesService } from './chapter-likes.service';

@ApiTags('Chapter Likes')
@Controller('chapter-likes')
export class ChapterLikesController {
  constructor(private chapterLikesService: ChapterLikesService) {}

  @Post(':chapterId')
  @UseGuards(AuthGuard, ProfileGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Toggle like on a chapter (add if not exists, remove if exists)' })
  async toggle(
    @CurrentUser() user: UserSession,
    @Param('chapterId', ParseIntPipe) chapterId: number,
  ) {
    return this.chapterLikesService.toggle(user.profileId!, chapterId);
  }

  @Get('check/:chapterId')
  @UseGuards(AuthGuard, ProfileGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Check if user has liked a chapter' })
  async checkLike(
    @CurrentUser() user: UserSession,
    @Param('chapterId', ParseIntPipe) chapterId: number,
  ) {
    const liked = await this.chapterLikesService.checkLike(user.profileId!, chapterId);
    return { liked };
  }

  @Get('chapter/:chapterId')
  @ApiOperation({ summary: 'Get likes count for a chapter (public)' })
  async getChapterLikes(
    @Param('chapterId', ParseIntPipe) chapterId: number,
  ) {
    const count = await this.chapterLikesService.getChapterLikesCount(chapterId);
    return { chapterId, likesCount: count };
  }

  @Get('user')
  @UseGuards(AuthGuard, ProfileGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get all chapters liked by the current user' })
  async getUserChapterLikes(@CurrentUser() user: UserSession) {
    return this.chapterLikesService.getUserChapterLikes(user.profileId!);
  }

  @Delete(':chapterId')
  @UseGuards(AuthGuard, ProfileGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Remove like from a chapter' })
  async removeLike(
    @CurrentUser() user: UserSession,
    @Param('chapterId', ParseIntPipe) chapterId: number,
  ) {
    const isLiked = await this.chapterLikesService.checkLike(user.profileId!, chapterId);
    if (isLiked) {
      return this.chapterLikesService.toggle(user.profileId!, chapterId);
    }
    return { liked: false, message: 'Chapter was not liked' };
  }
}
