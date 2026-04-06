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
import { RouteProtectionService } from '@/modules/route-protection/route-protection.service';

@ApiTags('Reading History')
@Controller('reading-history')
@UseGuards(AuthGuard, ProfileGuard)
@ApiBearerAuth()
export class ReadingHistoryController {
  constructor(
    private readingHistoryService: ReadingHistoryService,
    private routeProtectionService: RouteProtectionService,
  ) {}

  private async enrichEntry(entry: any): Promise<any> {
    if (!entry?.comic) {
      return entry;
    }

    const comicPath = await this.routeProtectionService.getComicPath(entry.comic);
    const chapterPath = entry.chapter
      ? await this.routeProtectionService.getChapterPath(entry.comic, entry.chapter, {
          comicPath,
        })
      : undefined;

    return {
      ...entry,
      comic: {
        ...entry.comic,
        comicPath,
      },
      chapter: entry.chapter
        ? {
            ...entry.chapter,
            chapterPath,
          }
        : entry.chapter,
    };
  }

  @Post()
  @ApiOperation({ summary: 'Record reading progress' })
  async record(
    @CurrentUser() user: UserSession,
    @Body() dto: RecordReadingDto,
  ) {
    const entry = await this.readingHistoryService.record(user.profileId!, dto);
    return this.enrichEntry(entry);
  }

  @Get()
  @ApiOperation({ summary: 'Get full reading history' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async findAll(
    @CurrentUser() user: UserSession,
    @Query('limit') limit?: string,
  ) {
    const entries = await this.readingHistoryService.findAll(
      user.profileId!,
      limit ? parseInt(limit, 10) : 50,
    );
    return Promise.all(entries.map((entry) => this.enrichEntry(entry)));
  }

  @Get('recent')
  @ApiOperation({ summary: 'Get recent reading history' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async findRecent(
    @CurrentUser() user: UserSession,
    @Query('limit') limit?: string,
  ) {
    const entries = await this.readingHistoryService.findRecent(
      user.profileId!,
      limit ? parseInt(limit, 10) : 10,
    );
    return Promise.all(entries.map((entry) => this.enrichEntry(entry)));
  }

  @Get('comic/:comicId')
  @ApiOperation({ summary: 'Get reading history for a comic' })
  async findByComic(
    @CurrentUser() user: UserSession,
    @Param('comicId', ParseIntPipe) comicId: number,
  ) {
    const entries = await this.readingHistoryService.findByComic(user.profileId!, comicId);
    return Promise.all(entries.map((entry) => this.enrichEntry(entry)));
  }

  @Get('comic/:comicId/last')
  @ApiOperation({ summary: 'Get last read chapter for a comic' })
  async findLastRead(
    @CurrentUser() user: UserSession,
    @Param('comicId', ParseIntPipe) comicId: number,
  ) {
    const entry = await this.readingHistoryService.findLastRead(user.profileId!, comicId);
    return this.enrichEntry(entry);
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
