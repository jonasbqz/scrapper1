import { Injectable, Inject, Logger, ConflictException, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { DATABASE_CONNECTION } from '@/database/database.module';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '@/database/schema';
import { ScraperQueue } from './scraper.queue';
import { OlympusAdapter } from './adapters/olympus.adapter';
import { IkigaiAdapter } from './adapters/ikigai.adapter';
import { PeerlessAdapter } from './adapters/m440.adapter';
import { NobledicionAdapter } from './adapters/nobledicion.adapter';
import type { ScraperResult } from './scraper.types';

@Injectable()
export class ScraperService implements OnModuleInit {
  private readonly logger = new Logger(ScraperService.name);
  private readonly delayMs: number;

  constructor(
    @Inject(DATABASE_CONNECTION)
    private db: NodePgDatabase<typeof schema>,
    private configService: ConfigService,
    private queue: ScraperQueue,
  ) {
    this.delayMs = this.configService.get<number>('SCRAPER_DELAY_MS') || 2000;
  }

  async onModuleInit() {
    this.logger.log('Server started. Triggering initial scrape tasks...');

    this.scrapeIkigai(1, 3).catch(err => this.logger.error(`Initial Ikigai scrape failed: ${err}`));
    this.scrapeOlympus(1, 2).catch(err => this.logger.error(`Initial Olympus scrape failed: ${err}`));
    // this.scrapePeerless(1,2).catch(err => this.logger.error(`Initial Peerless scrape failed: ${err}`));
    // Initial Nobledicion scrape config for pages 0-3 with 18 items per page:
    this.scrapeNobledicion(1, 1, 6).catch(err => this.logger.error(`Initial Nobledicion scrape failed: ${err}`));
  }

  getStatus() {
    return this.queue.getStatus();
  }

  /**
   * Force reset the scraper queue when it gets stuck
   */
  forceReset() {
    return this.queue.forceReset();
  }

  async triggerScraper(scraperName: string, options?: { startPage?: number; endPage?: number; postsPerPage?: number }) {
    if (this.queue.isRunning(scraperName)) {
      throw new ConflictException(
        `Scraper "${scraperName}" is already running.`,
      );
    }

    switch (scraperName) {
      case 'olympus':
        return this.scrapeOlympus(options?.startPage, options?.endPage);
      case 'ikigai':
        return this.scrapeIkigai(options?.startPage, options?.endPage);
      case 'peerless':
        return this.scrapePeerless(options?.startPage, options?.endPage);
      case 'nobledicion':
        return this.scrapeNobledicion(options?.startPage, options?.endPage, options?.postsPerPage);
      default:
        throw new Error(`Unknown scraper: ${scraperName}`);
    }
  }

  /**
   * Scheduled scraping - Ikigai every hour
   */
  @Cron(CronExpression.EVERY_HOUR)
  async scheduledIkigai() {
    if (!this.queue.isRunning('ikigai')) {
      this.logger.log('Starting scheduled Ikigai scrape');
      await this.scrapeIkigai(1, 1);
    }
  }

  /**
   * Scheduled scraping - Olympus every 2 hours
   */
  @Cron(CronExpression.EVERY_2_HOURS)
  async scheduledOlympus() {
    if (!this.queue.isRunning('olympus')) {
      this.logger.log('Starting scheduled Olympus scrape');
      await this.scrapeOlympus(1, 1);
    }
  }

  /**
   * Scheduled scraping - Peerless every hour
   */
  // @Cron(CronExpression.EVERY_HOUR)
  async scheduledPeerless() {
    if (!this.queue.isRunning('peerless')) {
      this.logger.log('Starting scheduled Peerless scrape');
      await this.scrapePeerless(1, 1);
    }
  }

  /**
   * Scheduled scraping - Nobledicion every 5 hours
   */
  @Cron('0 */5 * * *')
  async scheduledNobledicion() {
    if (!this.queue.isRunning('nobledicion')) {
      this.logger.log('Starting scheduled Nobledicion scrape');
      await this.scrapeNobledicion(0, 0, 6);
    }
  }

  private async scrapeOlympus(startPage = 1, endPage = 5): Promise<ScraperResult> {
    return this.queue.enqueue('olympus', async () => {
      this.logger.log(`Scraping Olympus pages ${startPage}-${endPage}...`);

      const adapter = new OlympusAdapter(this.db, this.delayMs);
      const result = await adapter.scrape(startPage, endPage);

      this.logger.log(
        `Olympus scrape completed: ${result.comics} comics, ${result.chapters} chapters, ${result.errors.length} errors`,
      );

      return result;
    });
  }

  private async scrapeIkigai(startPage = 1, endPage = 10): Promise<ScraperResult> {
    return this.queue.enqueue('ikigai', async () => {
      this.logger.log(`Scraping Ikigai pages ${startPage}-${endPage}...`);

      const baseUrl = this.configService.get<string>('SCRAPER_IKIGAI_URL');
      const adapter = new IkigaiAdapter(this.db, this.delayMs, baseUrl);
      const result = await adapter.scrape(startPage, endPage);

      this.logger.log(
        `Ikigai scrape completed: ${result.comics} comics, ${result.chapters} chapters, ${result.errors.length} errors`,
      );

      return result;
    });
  }

  private async scrapePeerless(startPage = 1, endPage = 10): Promise<ScraperResult> {
    return this.queue.enqueue('peerless', async () => {
      this.logger.log(`Scraping Peerless pages ${startPage}-${endPage}...`);

      const baseUrl = this.configService.get<string>('SCRAPER_PEERLESS_URL');
      const adapter = new PeerlessAdapter(this.db, this.delayMs, baseUrl);
      const result = await adapter.scrape(startPage, endPage);

      this.logger.log(
        `Peerless scrape completed: ${result.comics} comics, ${result.chapters} chapters, ${result.errors.length} errors`,
      );

      return result;
    });
  }

  private async scrapeNobledicion(startPage = 0, endPage = 3, postsPerPage = 18): Promise<ScraperResult> {
    return this.queue.enqueue('nobledicion', async () => {
      this.logger.log(`Scraping Nobledicion pages ${startPage}-${endPage} (${postsPerPage} posts/page)...`);

      const baseUrl = this.configService.get<string>('SCRAPER_NOBLEDICION_URL');
      const adapter = new NobledicionAdapter(this.db, this.delayMs, baseUrl);
      const result = await adapter.scrape(startPage, endPage, postsPerPage);

      this.logger.log(
        `Nobledicion scrape completed: ${result.comics} comics, ${result.chapters} chapters, ${result.errors.length} errors`,
      );

      return result;
    });
  }
}
