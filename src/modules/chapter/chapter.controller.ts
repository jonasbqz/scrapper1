import { Controller, Get, Param, ParseIntPipe } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ChapterService } from './chapter.service';

@ApiTags('Chapters')
@Controller('chapters')
export class ChapterController {
  constructor(private chapterService: ChapterService) {}

  @Get(':id')
  @ApiOperation({ summary: 'Get chapter by ID with navigation' })
  async findById(@Param('id', ParseIntPipe) id: number) {
    await this.chapterService.incrementViews(id);
    return this.chapterService.getNavigation(id);
  }

  @Get(':id/pages')
  @ApiOperation({ summary: 'Get chapter pages' })
  async getPages(@Param('id', ParseIntPipe) id: number) {
    return this.chapterService.getPages(id);
  }

  @Get('comic-scan/:comicScanId')
  @ApiOperation({ summary: 'Get all chapters by comic scan' })
  async findByComicScan(@Param('comicScanId', ParseIntPipe) comicScanId: number) {
    return this.chapterService.findByComicScan(comicScanId);
  }
}
