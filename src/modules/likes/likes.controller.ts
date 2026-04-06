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
import { LikesService } from './likes.service';

@ApiTags('Likes')
@Controller('likes')
export class LikesController {
  constructor(private likesService: LikesService) {}

  @Post(':comicId')
  @UseGuards(AuthGuard, ProfileGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Toggle like on a comic (add if not exists, remove if exists)' })
  async toggle(
    @CurrentUser() user: UserSession,
    @Param('comicId', ParseIntPipe) comicId: number,
  ) {
    return this.likesService.toggle(user.profileId!, comicId);
  }

  @Get('check/:comicId')
  @UseGuards(AuthGuard, ProfileGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Check if user has liked a comic' })
  async checkLike(
    @CurrentUser() user: UserSession,
    @Param('comicId', ParseIntPipe) comicId: number,
  ) {
    const liked = await this.likesService.checkLike(user.profileId!, comicId);
    return { liked };
  }

  @Get('comic/:comicId')
  @ApiOperation({ summary: 'Get likes count for a comic (public)' })
  async getComicLikes(
    @Param('comicId', ParseIntPipe) comicId: number,
  ) {
    const count = await this.likesService.getComicLikesCount(comicId);
    return { comicId, likesCount: count };
  }

  @Get('user')
  @UseGuards(AuthGuard, ProfileGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get all comics liked by the current user' })
  async getUserLikes(@CurrentUser() user: UserSession) {
    return this.likesService.getUserLikes(user.profileId!);
  }

  @Delete(':comicId')
  @UseGuards(AuthGuard, ProfileGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Remove like from a comic' })
  async removeLike(
    @CurrentUser() user: UserSession,
    @Param('comicId', ParseIntPipe) comicId: number,
  ) {
    const isLiked = await this.likesService.checkLike(user.profileId!, comicId);
    if (isLiked) {
      return this.likesService.toggle(user.profileId!, comicId);
    }
    return { liked: false, message: 'Comic was not liked' };
  }
}
