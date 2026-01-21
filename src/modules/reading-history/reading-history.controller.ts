import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  ParseIntPipe,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags, ApiQuery } from '@nestjs/swagger';
import { AuthGuard } from '@/modules/auth/auth.guard';
import { ProfileGuard } from '@/modules/auth/profile.guard';
import { CurrentUser, UserSession } from '@/modules/auth/current-user.decorator';
import { ReadingHistoryService } from './reading-history.service';
import { RecordReadingDto } from './reading-history.dto';

@ApiTags('Reading History')
@Controller('reading-history')
@UseGuards(AuthGuard, ProfileGuard)
@ApiBearerAuth()
export class ReadingHistoryController {
  constructor(private readingHistoryService: ReadingHistoryService) {}

  @Post()
  @ApiOperation({ summary: 'Record reading progress' })
  async record(
    @CurrentUser() user: UserSession,
    @Body() dto: RecordReadingDto,
  ) {
    return this.readingHistoryService.record(user.profileId!, dto);
  }

  @Get()
  @ApiOperation({ summary: 'Get full reading history' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async findAll(
    @CurrentUser() user: UserSession,
    @Query('limit') limit?: string,
  ) {
    return this.readingHistoryService.findAll(
      user.profileId!,
      limit ? parseInt(limit, 10) : 50,
    );
  }

  @Get('recent')
  @ApiOperation({ summary: 'Get recent reading history' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async findRecent(
    @CurrentUser() user: UserSession,
    @Query('limit') limit?: string,
  ) {
    return this.readingHistoryService.findRecent(
      user.profileId!,
      limit ? parseInt(limit, 10) : 10,
    );
  }

  @Get('comic/:comicId')
  @ApiOperation({ summary: 'Get reading history for a comic' })
  async findByComic(
    @CurrentUser() user: UserSession,
    @Param('comicId', ParseIntPipe) comicId: number,
  ) {
    return this.readingHistoryService.findByComic(user.profileId!, comicId);
  }

  @Get('comic/:comicId/last')
  @ApiOperation({ summary: 'Get last read chapter for a comic' })
  async findLastRead(
    @CurrentUser() user: UserSession,
    @Param('comicId', ParseIntPipe) comicId: number,
  ) {
    return this.readingHistoryService.findLastRead(user.profileId!, comicId);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete reading history entry' })
  async delete(
    @CurrentUser() user: UserSession,
    @Param('id') id: string,
  ) {
    await this.readingHistoryService.delete(user.profileId!, id);
    return { success: true };
  }
}
