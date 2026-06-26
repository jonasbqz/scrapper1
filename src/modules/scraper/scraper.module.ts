import { Module } from '@nestjs/common';
import { ScraperController } from './scraper.controller';
import { ScraperService } from './scraper.service';
import { ScraperQueue } from './scraper.queue';

@Module({
  controllers: [ScraperController],
  providers: [ScraperService, ScraperQueue],
  exports: [ScraperService],
})
export class ScraperModule {}
