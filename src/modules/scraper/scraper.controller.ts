import { Controller, Get, Post, Query, Delete, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags, ApiQuery, ApiResponse } from '@nestjs/swagger';
import { ScraperService } from './scraper.service';
import { ScraperQueue } from './scraper.queue';
import { AuthGuard } from '@/modules/auth/auth.guard';
import { AdminGuard } from '@/modules/auth/admin.guard';

@ApiTags('Scraper')
@Controller('scraper')
@UseGuards(AuthGuard, AdminGuard)
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

  @Post('trigger')
  @ApiOperation({ summary: 'Manually trigger a scraper' })
  @ApiQuery({ name: 'name', required: true, type: String, enum: ['olympus', 'ikigai', 'peerless', 'nobledicion'] })
  @ApiQuery({ name: 'startPage', required: false, type: Number, description: 'Start page (default: 1)' })
  @ApiQuery({ name: 'endPage', required: false, type: Number, description: 'End page (default for nobledicion: 3)' })
  @ApiQuery({ name: 'postsPerPage', required: false, type: Number, description: 'Posts per page (for nobledicion, default 18)' })
  @ApiResponse({ status: 200, description: 'Scraper completed' })
  @ApiResponse({ status: 409, description: 'That scraper is already running' })
  async trigger(
    @Query('name') name: string,
    @Query('startPage') startPage?: string,
    @Query('endPage') endPage?: string,
    @Query('postsPerPage') postsPerPage?: string,
  ) {
    const start = startPage ? parseInt(startPage, 10) : (name === 'nobledicion' ? 0 : 1);
    const end = endPage ? parseInt(endPage, 10) : (name === 'olympus' ? 5 : (name === 'nobledicion' ? 3 : 10));
    const ppp = postsPerPage ? parseInt(postsPerPage, 10) : (name === 'nobledicion' ? 18 : undefined);

    console.log(`[ScraperController] Triggering ${name} scraper: pages ${start}-${end}`);

    const result = await this.scraperService.triggerScraper(name, {
      startPage: start,
      endPage: end,
      postsPerPage: ppp,
    });

    const success = result.errors.length === 0 && (result.comics > 0 || result.chapters > 0);

    return {
      success,
      message: success
        ? `Scraper ${name} completed: ${result.comics} comics, ${result.chapters} chapters`
        : `Scraper ${name} finished with issues`,
      scraper: name,
      pages: { start, end },
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

  @Post('reset')
  @ApiOperation({ summary: 'Force reset scraper queue (use when stuck)' })
  @ApiResponse({ status: 200, description: 'Queue has been force reset' })
  forceReset() {
    const result = this.scraperService.forceReset();
    return {
      ...result,
      status: this.scraperService.getStatus(),
    };
  }
}
