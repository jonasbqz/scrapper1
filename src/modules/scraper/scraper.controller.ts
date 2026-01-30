import { Controller, Get, Post, Param, Query, Delete } from '@nestjs/common';
import { ApiOperation, ApiTags, ApiQuery } from '@nestjs/swagger';
import { ScraperService } from './scraper.service';
import { ScraperQueue } from './scraper.queue';

@ApiTags('Scraper')
@Controller('scraper')
export class ScraperController {
  constructor(
    private scraperService: ScraperService,
    private scraperQueue: ScraperQueue,
  ) {}

  @Get('status')
  @ApiOperation({ summary: 'Get scraper queue status' })
  getStatus() {
    return this.scraperService.getStatus();
  }

  @Get('trigger')
  @ApiOperation({ summary: 'Manually trigger a scraper' })
  @ApiQuery({ name: 'name', required: true, type: String })
  @ApiQuery({ name: 'startPage', required: false, type: Number })
  @ApiQuery({ name: 'endPage', required: false, type: Number })
  async trigger(
    @Query('name') name: string,
    @Query('startPage') startPage?: string,
    @Query('endPage') endPage?: string,
  ) {
    const result = await this.scraperService.triggerScraper(name, {
      startPage: startPage ? parseInt(startPage, 10) : undefined,
      endPage: endPage ? parseInt(endPage, 10) : undefined,
    });

    return {
      message: `Scraper ${name} completed`,
      result,
      status: this.scraperService.getStatus(),
    };
  }

  @Delete('queue')
  @ApiOperation({ summary: 'Clear pending scraper queue' })
  clearQueue() {
    const cleared = this.scraperQueue.clear();
    return {
      message: `Cleared ${cleared} pending tasks`,
      status: this.scraperService.getStatus(),
    };
  }
}
