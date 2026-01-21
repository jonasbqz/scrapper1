import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '@/database/schema';

export interface ScrapedComic {
  title: string;
  slug: string;
  titleAlternative?: string;
  description?: string;
  coverImage?: string;
  author?: string;
  artist?: string;
  type?: 'manga' | 'manhwa' | 'manhua';
  status?: 'ongoing' | 'completed' | 'hiatus' | 'cancelled';
  genres?: string[];
  isNsfw?: boolean;
}

export interface ScrapedChapter {
  chapterNumber: number;
  title?: string;
  slug: string;
  releaseDate?: Date;
  pages?: string[];
}

export abstract class BaseScraperAdapter {
  protected delayMs: number;

  constructor(
    protected db: NodePgDatabase<typeof schema>,
    delayMs = 2000,
  ) {
    this.delayMs = delayMs;
  }

  /**
   * Main scraping method to be implemented by each adapter
   */
  abstract scrape(): Promise<void>;

  /**
   * Get the name of this scraper
   */
  abstract getName(): string;

  /**
   * Delay between requests to avoid rate limiting
   */
  protected delay(ms?: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms || this.delayMs));
  }

  /**
   * Generate a URL-friendly slug from a string
   */
  protected slugify(text: string): string {
    return text
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  /**
   * Parse chapter number from string (handles formats like "1", "1.5", "Chapter 1")
   */
  protected parseChapterNumber(input: string): number {
    const match = input.match(/[\d.]+/);
    return match ? parseFloat(match[0]) : 0;
  }

  /**
   * Clean HTML and extract text
   */
  protected cleanText(html: string): string {
    return html
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/\s+/g, ' ')
      .trim();
  }
}
