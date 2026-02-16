import { Logger } from '@nestjs/common';
import * as cheerio from 'cheerio';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '@/database/schema';
import { eq, and } from 'drizzle-orm';
import { comics, chapters, comicScans, scanGroups, genres, comicGenres } from '@/database/schema';
import type { ScrapedComic, ScrapedChapter, ChapterListItem, ScraperResult } from '../scraper.types';
import { isAdultGenreSlug } from './base.adapter';

const IKIGAI_ORIGIN = 'https://ikigaimangas.com';
const IKIGAI_MEDIA = 'https://media.ikigaimangas.cloud';

export class IkigaiAdapter {
  private readonly logger = new Logger(IkigaiAdapter.name);
  private scanGroupId: number | null = null;
  private baseUrl: string;

  constructor(
    private db: NodePgDatabase<typeof schema>,
    private delayMs: number = 100,
    baseUrl?: string,
  ) {
    this.baseUrl = baseUrl || process.env.SCRAPER_IKIGAI_URL || IKIGAI_ORIGIN;
  }

  async scrape(startPage = 1, endPage = 10): Promise<ScraperResult> {
    const result: ScraperResult = { comics: 0, chapters: 0, errors: [] };

    this.logger.log(`Starting Ikigai scrape: pages ${startPage}-${endPage}, baseUrl: ${this.baseUrl}`);

    try {
      await this.ensureScanGroup();
      this.logger.log(`Scan group ensured: ID ${this.scanGroupId}`);

      const comicUrls = await this.getRecentComicUrls(startPage, endPage);
      this.logger.log(`Found ${comicUrls.length} comics to scrape`);

      if (comicUrls.length === 0) {
        this.logger.warn(`No comics found! Check if the URL is working: ${this.baseUrl}/series/`);
        result.errors.push(`No comics found from ${this.baseUrl}/series/`);
      }

      for (const url of comicUrls) {
        try {
          await this.scrapeComic(url, result);
          await this.delay();
        } catch (error) {
          const msg = `Failed to scrape comic ${url}: ${error}`;
          this.logger.error(msg);
          result.errors.push(msg);
        }
      }
    } catch (error) {
      const msg = `Ikigai scraper failed: ${error}`;
      this.logger.error(msg);
      result.errors.push(msg);
    }

    this.logger.log(`Ikigai scrape completed: ${result.comics} comics, ${result.chapters} chapters, ${result.errors.length} errors`);
    return result;
  }

  private async ensureScanGroup(): Promise<void> {
    const existing = await this.db.query.scanGroups.findFirst({
      where: eq(scanGroups.slug, 'ikigai'),
    });

    if (existing) {
      this.scanGroupId = existing.id;
      return;
    }

    const [created] = await this.db.insert(scanGroups).values({
      name: 'Ikigai Mangas',
      slug: 'ikigai',
      website: IKIGAI_ORIGIN,
    }).returning();

    this.scanGroupId = created.id;
  }

  private async getRecentComicUrls(startPage: number, endPage: number): Promise<string[]> {
    const urls: string[] = [];
    const seen = new Set<string>();

    for (let page = startPage; page <= endPage; page++) {
      try {
        const listUrl = `${this.baseUrl}/series/?tipos[]=comic&direccion=desc&ordenar=last_chapter_date&pagina=${page}`;
        this.logger.debug(`Fetching page ${page}: ${listUrl}`);

        const html = await this.fetchHtml(listUrl);
        this.logger.debug(`Got HTML response: ${html.length} characters`);

        const $ = cheerio.load(html);

        let foundOnPage = 0;
        $('section > ul > li').each((_, el) => {
          const chaptersTotal = $(el).find('a ul li:nth-child(1) span:nth-child(2)').text().trim();
          if (chaptersTotal === '0') return;

          const href = $(el).find('a').attr('href');
          if (href && !seen.has(href)) {
            seen.add(href);
            urls.push(this.joinUrl(this.baseUrl, href));
            foundOnPage++;
          }
        });

        this.logger.debug(`Page ${page}: found ${foundOnPage} comics`);

        if (foundOnPage === 0 && page === startPage) {
          // Log the HTML structure to help debug selector issues
          this.logger.warn(`No comics found on first page. HTML preview: ${html.substring(0, 500)}...`);
        }

        await this.delay();
      } catch (error) {
        this.logger.error(`Failed to fetch page ${page}: ${error}`);
        break;
      }
    }

    return urls;
  }

  private async scrapeComic(url: string, result: ScraperResult): Promise<void> {
    const html = await this.fetchHtml(url);
    const $ = cheerio.load(html);

    const comic = this.parseComicFromHtml($, url);
    if (!comic.title) {
      throw new Error('Could not parse comic title');
    }

    this.logger.log(`Scraping comic: ${comic.title}`);

    const comicId = await this.upsertComic(comic);
    result.comics++;

    // Get chapter list
    const chapterList = await this.getChapterList(url);
    this.logger.log(`Found ${chapterList.length} chapters for ${comic.title}`);

    for (const chapterItem of chapterList) {
      try {
        const chapter = await this.scrapeChapter(chapterItem.url);
        if (chapter.pages.length > 0) {
          await this.upsertChapter(comicId, chapter, chapterItem);
          result.chapters++;
        }
        await this.delay(40);
      } catch (error) {
        this.logger.warn(`Failed to scrape chapter ${chapterItem.url}: ${error}`);
      }
    }
  }

  private parseComicFromHtml($: cheerio.CheerioAPI, url: string): ScrapedComic {
    const title = $('div div article div h1').first().text().trim();
    const description = $('div div article div p').first().text().trim();

    // Status
    const statusText = $('div article figure ul li:nth-child(2)').text().toLowerCase().trim();
    const statusMap: Record<string, ScrapedComic['status']> = {
      'en curso': 'ongoing',
      'activo': 'ongoing',
      'ongoing': 'ongoing',
      'completado': 'completed',
      'completed': 'completed',
      'pausado': 'hiatus',
      'hiatus': 'hiatus',
      'cancelado': 'cancelled',
      'cancelled': 'cancelled',
    };
    const status = statusMap[statusText] || 'ongoing';

    // Type
    const typeText = $('div article figure ul li:nth-child(1)').text().toLowerCase().trim();
    const typeMap: Record<string, ScrapedComic['type']> = {
      'manga': 'manga',
      'manhwa': 'manhwa',
      'manhua': 'manhua',
      'webtoon': 'manhwa',
      'comic': 'comic',
    };
    const type = typeMap[typeText] || 'manga';

    // Genres
    const genresList: string[] = [];
    $('div div article div ul li a').each((_, el) => {
      const genre = $(el).text().trim().toUpperCase();
      if (genre) genresList.push(genre);
    });

    // Cover
    let coverImage = $('div div article figure img').attr('src') || '';
    if (coverImage && !coverImage.startsWith('http')) {
      coverImage = this.joinUrl(this.baseUrl, coverImage);
    }

    // Slug from URL
    const slug = this.extractSlugFromUrl(url);

    // Group scan
    const groupName = $('div article + div > div h3').text().trim();
    const groupUrl = $('div article + div > div a').attr('href');
    let groupCover = $('div article + div > figure img').attr('src');
    if (groupCover && !groupCover.startsWith('http')) {
      groupCover = this.joinUrl(this.baseUrl, groupCover);
    }

    return {
      slug,
      title,
      description,
      coverImage,
      type,
      status,
      genres: genresList,
      groupScan: groupName ? {
        name: groupName,
        cover: groupCover,
      } : undefined,
    };
  }

  private async getChapterList(comicUrl: string): Promise<ChapterListItem[]> {
    const allChapters: ChapterListItem[] = [];
    let page = 1;

    while (page <= 50) {
      const pageUrl = comicUrl.includes('?')
        ? `${comicUrl}&ordenar=asc&pagina=${page}`
        : `${comicUrl}?ordenar=asc&pagina=${page}`;

      try {
        const html = await this.fetchHtml(pageUrl);
        const $ = cheerio.load(html);

        const pageChapters: ChapterListItem[] = [];

        $('div.w-full > section > ul.grid > li > a').each((_, el) => {
          const href = $(el).attr('href') || '';
          if (!href.includes('capitulo')) return;

          const title = $(el).find('h3').first().text().trim();
          const releaseDateStr = $(el).find('time').attr('datetime') || '';

          let releaseDate: Date | undefined;
          if (releaseDateStr) {
            try {
              releaseDate = new Date(releaseDateStr);
            } catch {
              releaseDate = new Date();
            }
          }

          if (href && title) {
            pageChapters.push({
              id: this.extractSlugFromUrl(href),
              title,
              number: this.extractChapterNumber(title),
              url: this.joinUrl(this.baseUrl, href),
              pathname: href,
              releaseDate,
            });
          }
        });

        if (pageChapters.length === 0) break;
        allChapters.push(...pageChapters);

        // Check for max page
        const navLabels: string[] = [];
        $('section > div > nav > a').each((_, el) => {
          const label = $(el).attr('aria-label');
          if (label) navLabels.push(label);
        });

        if (navLabels.length > 2) {
          const lastLabel = navLabels[navLabels.length - 2];
          const match = lastLabel.match(/Página (\d+)/);
          if (match && page >= parseInt(match[1])) break;
        }

        page++;
        await this.delay(80);
      } catch (error) {
        this.logger.error(`Failed to fetch chapter list page ${page}: ${error}`);
        break;
      }
    }

    return allChapters;
  }

  private async scrapeChapter(chapterUrl: string): Promise<ScrapedChapter> {
    // Add NSFW bypass params
    let url = chapterUrl;
    if (!url.includes('forceSetNsfw=true')) {
      url += url.includes('?') ? '&forceSetNsfw=true' : '?forceSetNsfw=true';
    }
    if (!url.includes('forceSetTheme=')) {
      url += '&forceSetTheme=false';
    }

    const html = await this.fetchHtml(url);
    const $ = cheerio.load(html);

    const chapterName = $('div> div span.line-clamp-1').first().text().trim();
    const chapterNumText = $('div> div span.line-clamp-1 + span').text().trim();
    const chapterNumber = parseFloat(chapterNumText.replace(/[^0-9.]/g, '')) || 0;

    const pages: string[] = [];
    const seenUrls = new Set<string>();

    // Collect images
    $('div.w-full .w-full.img img, .img img, .reader img').each((_, el) => {
      let src = $(el).attr('src') || '';
      if (!src) return;

      if (src.startsWith('https://media.ikigaimangas.cloud')) {
        // Already full URL
      } else if (src.startsWith('/series/')) {
        src = IKIGAI_MEDIA + src;
      } else {
        src = this.joinUrl(IKIGAI_MEDIA, src);
      }

      if (!seenUrls.has(src)) {
        seenUrls.add(src);
        pages.push(src);
      }
    });

    // Fallback selector
    $('img[src*="media.ikigaimangas.cloud/series"]').each((_, el) => {
      const src = $(el).attr('src') || '';
      if (src && !seenUrls.has(src)) {
        seenUrls.add(src);
        pages.push(src);
      }
    });

    return {
      chapterNumber,
      title: chapterName,
      slug: this.extractSlugFromUrl(chapterUrl),
      pages,
    };
  }

  private async upsertComic(comic: ScrapedComic): Promise<number> {
    const externalUrl = `${IKIGAI_ORIGIN}/series/${comic.slug}`;

    // First, check if we already have this comic via externalUrl in comicScans
    // This prevents duplicates when URLs/slugs change
    const existingComicScan = await this.db.query.comicScans.findFirst({
      where: and(
        eq(comicScans.externalUrl, externalUrl),
        eq(comicScans.scanGroupId, this.scanGroupId!),
      ),
      with: { comic: true },
    });

    let comicId: number;

    if (existingComicScan && existingComicScan.comic) {
      // Found via externalUrl - update the existing comic
      await this.db.update(comics).set({
        title: comic.title,
        description: comic.description,
        coverImage: comic.coverImage,
        type: comic.type === 'comic' ? 'manga' : comic.type,
        status: comic.status,
        updatedAt: new Date(),
      }).where(eq(comics.id, existingComicScan.comicId));
      comicId = existingComicScan.comicId;
    } else {
      // Check by slug as fallback
      const existingBySlug = await this.db.query.comics.findFirst({
        where: eq(comics.slug, comic.slug),
      });

      if (existingBySlug) {
        await this.db.update(comics).set({
          title: comic.title,
          description: comic.description,
          coverImage: comic.coverImage,
          type: comic.type === 'comic' ? 'manga' : comic.type,
          status: comic.status,
          updatedAt: new Date(),
        }).where(eq(comics.id, existingBySlug.id));
        comicId = existingBySlug.id;
      } else {
        // Create new comic
        const [created] = await this.db.insert(comics).values({
          title: comic.title,
          slug: comic.slug,
          description: comic.description,
          coverImage: comic.coverImage,
          type: comic.type === 'comic' ? 'manga' : comic.type,
          status: comic.status,
        }).returning();
        comicId = created.id;
      }
    }

    await this.ensureComicScan(comicId, comic);
    await this.syncGenres(comicId, comic.genres);

    return comicId;
  }

  private async ensureComicScan(comicId: number, comic: ScrapedComic): Promise<number> {
    const existing = await this.db.query.comicScans.findFirst({
      where: eq(comicScans.comicId, comicId),
    });

    if (existing) return existing.id;

    const [created] = await this.db.insert(comicScans).values({
      comicId,
      scanGroupId: this.scanGroupId!,
      externalUrl: `${IKIGAI_ORIGIN}/series/${comic.slug}`,
      language: 'es',
    }).returning();

    return created.id;
  }

  private async syncGenres(comicId: number, genreNames: string[]): Promise<void> {
    await this.db.delete(comicGenres).where(eq(comicGenres.comicId, comicId));

    let hasAdultGenre = false;

    for (const name of genreNames) {
      const slug = this.slugify(name);

      if (isAdultGenreSlug(slug)) {
        hasAdultGenre = true;
      }

      let genre = await this.db.query.genres.findFirst({
        where: eq(genres.slug, slug),
      });

      if (!genre) {
        const [created] = await this.db.insert(genres).values({
          name: name.charAt(0) + name.slice(1).toLowerCase(),
          slug,
        }).returning();
        genre = created;
      }

      await this.db.insert(comicGenres).values({
        comicId,
        genreId: genre.id,
      }).onConflictDoNothing();
    }

    await this.db.update(comics).set({
      isNsfw: hasAdultGenre,
    }).where(eq(comics.id, comicId));
  }

  private async upsertChapter(
    comicId: number,
    chapter: ScrapedChapter,
    listItem: ChapterListItem,
  ): Promise<void> {
    const comicScan = await this.db.query.comicScans.findFirst({
      where: eq(comicScans.comicId, comicId),
    });

    if (!comicScan) return;

    // Search by (comicScanId, chapterNumber) instead of just slug
    // This prevents duplicates when chapter URLs change
    const existing = await this.db.query.chapters.findFirst({
      where: and(
        eq(chapters.comicScanId, comicScan.id),
        eq(chapters.chapterNumber, chapter.chapterNumber),
      ),
    });

    if (existing) {
      await this.db.update(chapters).set({
        urlPages: chapter.pages,
        slug: chapter.slug, // Update slug in case it changed
        updatedAt: new Date(),
      }).where(eq(chapters.id, existing.id));
    } else {
      await this.db.insert(chapters).values({
        comicScanId: comicScan.id,
        chapterNumber: chapter.chapterNumber,
        title: chapter.title || listItem.title,
        slug: chapter.slug,
        releaseDate: listItem.releaseDate,
        urlPages: chapter.pages,
      }).onConflictDoNothing();
    }
  }

  private async fetchHtml(url: string): Promise<string> {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36',
        'Referer': this.baseUrl,
        'Accept': 'text/html,application/xhtml+xml',
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    return response.text();
  }

  private extractSlugFromUrl(url: string): string {
    const parts = url.replace(/\/$/, '').split('/');
    return parts[parts.length - 1] || parts[parts.length - 2] || '';
  }

  private extractChapterNumber(title: string): string {
    const match = title.match(/(?:capitulo|chapter|cap|ch)[\s\-_]*([0-9]+(?:\.[0-9]+)?)/i);
    if (match) return match[1];

    const numMatch = title.match(/([0-9]+(?:\.[0-9]+)?)/);
    return numMatch ? numMatch[1] : '0';
  }

  private joinUrl(origin: string, path: string): string {
    if (!path) return '';
    if (path.startsWith('http://') || path.startsWith('https://')) return path;
    if (path.startsWith('/')) return origin.replace(/\/$/, '') + path;
    return origin.replace(/\/$/, '') + '/' + path.replace(/^\//, '');
  }

  private slugify(text: string): string {
    return text
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  private delay(ms?: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms || this.delayMs));
  }
}
