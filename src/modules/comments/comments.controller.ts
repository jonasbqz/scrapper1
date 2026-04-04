import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { AuthGuard } from '@/modules/auth/auth.guard';
import { ProfileGuard } from '@/modules/auth/profile.guard';
import { VerifiedEmailGuard } from '@/modules/auth/verified-email.guard';
import { CurrentUser, UserSession } from '@/modules/auth/current-user.decorator';
import { resolveOptionalProfileId } from '@/modules/auth/session-resolver';
import { CommentsService } from './comments.service';
import {
  CreateCommentDto,
  GetCommentsQueryDto,
  UpdateCommentDto,
  VoteCommentDto,
} from './comments.dto';
import { DATABASE_CONNECTION } from '@/database/database.module';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '@/database/schema';

@ApiTags('Comments')
@Controller('comments')
export class CommentsController {
  constructor(
    private readonly commentsService: CommentsService,
    @Inject(DATABASE_CONNECTION)
    private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  @Post()
  @UseGuards(AuthGuard, ProfileGuard, VerifiedEmailGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a new comment' })
  async create(
    @CurrentUser() user: UserSession,
    @Body() dto: CreateCommentDto,
  ) {
    return this.commentsService.create(user.profileId!, dto);
  }

  @Get('comic/:comicId')
  @ApiOperation({ summary: 'Get comments for a comic (public)' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'offset', required: false, type: Number })
  @ApiQuery({ name: 'sort', required: false, enum: ['best', 'newest', 'oldest'] })
  async findByComic(
    @Param('comicId', ParseIntPipe) comicId: number,
    @Query() query: GetCommentsQueryDto,
    @Req() request: FastifyRequest,
  ) {
    const viewerProfileId = await resolveOptionalProfileId(
      this.db,
      request.headers as Record<string, any>,
    );
    return this.commentsService.findByComic(comicId, query, viewerProfileId);
  }

  @Get('chapter/:chapterId')
  @ApiOperation({ summary: 'Get comments for a chapter (public)' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'offset', required: false, type: Number })
  @ApiQuery({ name: 'sort', required: false, enum: ['best', 'newest', 'oldest'] })
  async findByChapter(
    @Param('chapterId', ParseIntPipe) chapterId: number,
    @Query() query: GetCommentsQueryDto,
    @Req() request: FastifyRequest,
  ) {
    const viewerProfileId = await resolveOptionalProfileId(
      this.db,
      request.headers as Record<string, any>,
    );
    return this.commentsService.findByChapter(chapterId, query, viewerProfileId);
  }

  @Get('replies/:parentId')
  @ApiOperation({ summary: 'Get replies to a comment (public)' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'offset', required: false, type: Number })
  @ApiQuery({ name: 'sort', required: false, enum: ['best', 'newest', 'oldest'] })
  async findReplies(
    @Param('parentId', ParseUUIDPipe) parentId: string,
    @Query() query: GetCommentsQueryDto,
    @Req() request: FastifyRequest,
  ) {
    const viewerProfileId = await resolveOptionalProfileId(
      this.db,
      request.headers as Record<string, any>,
    );
    return this.commentsService.findReplies(parentId, query, viewerProfileId);
  }

  @Get('user')
  @UseGuards(AuthGuard, ProfileGuard, VerifiedEmailGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get comments by current user' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'offset', required: false, type: Number })
  async findByUser(
    @CurrentUser() user: UserSession,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.commentsService.findByUser(
      user.profileId!,
      limit ? parseInt(limit, 10) : 50,
      offset ? parseInt(offset, 10) : 0,
    );
  }

  @Get('comic/:comicId/count')
  @ApiOperation({ summary: 'Get comments count for a comic (public)' })
  async getComicCommentsCount(
    @Param('comicId', ParseIntPipe) comicId: number,
  ) {
    const count = await this.commentsService.getComicCommentsCount(comicId);
    return { comicId, commentsCount: count, count };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a specific comment (public)' })
  async findById(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() request: FastifyRequest,
  ) {
    const viewerProfileId = await resolveOptionalProfileId(
      this.db,
      request.headers as Record<string, any>,
    );
    return this.commentsService.findById(id, viewerProfileId);
  }

  @Post(':id/vote')
  @UseGuards(AuthGuard, ProfileGuard, VerifiedEmailGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Vote up or down on a comment' })
  async vote(
    @CurrentUser() user: UserSession,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: VoteCommentDto,
  ) {
    return this.commentsService.vote(user.profileId!, id, dto.direction);
  }

  @Patch(':id')
  @UseGuards(AuthGuard, ProfileGuard, VerifiedEmailGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update own comment' })
  async update(
    @CurrentUser() user: UserSession,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCommentDto,
  ) {
    return this.commentsService.update(user.profileId!, id, dto);
  }

  @Delete(':id')
  @UseGuards(AuthGuard, ProfileGuard, VerifiedEmailGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Delete own comment' })
  async delete(
    @CurrentUser() user: UserSession,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.commentsService.delete(user.profileId!, id);
    return { success: true };
  }
}
