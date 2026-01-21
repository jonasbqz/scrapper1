import { Logger } from '@nestjs/common';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '@/database/schema';
import { eq } from 'drizzle-orm';
import { comics, chapters, comicScans, scanGroups, genres, comicGenres } from '@/database/schema';
import type { ScrapedComic, ScrapedChapter, ChapterListItem, ScraperResult } from '../scraper.types';

const OLYMPUS_API = 'https://dashboard.olympusbiblioteca.com/api';
const OLYMPUS_ORIGIN = 'https://dashboard.olympusbiblioteca.com';

interface OlympusApiResponse {
  data: any;
  links?: { next?: string };
}

export class OlympusAdapter {
  private readonly logger = new Logger(OlympusAdapter.name);
  private scanGroupId: number | null = null;

  constructor(
    private db: NodePgDatabase<typeof schema>,
    private delayMs: number = 2000,
  ) {}

  async scrape(startPage = 1, endPage = 5): Promise<ScraperResult> {
    const result: ScraperResult = { comics: 0, chapters: 0, errors: [] };

    try {
      // Ensure scan group exists
      await this.ensureScanGroup();

      // Get comic URLs from recent updates
      const comicUrls = await this.getRecentComicUrls(startPage, endPage);
      this.logger.log(`Found ${comicUrls.length} comics to scrape`);

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
      const msg = `Olympus scraper failed: ${error}`;
      this.logger.error(msg);
      result.errors.push(msg);
    }

    return result;
  }

  private async ensureScanGroup(): Promise<void> {
    const existing = await this.db.query.scanGroups.findFirst({
      where: eq(scanGroups.slug, 'olympus'),
    });

    if (existing) {
      this.scanGroupId = existing.id;
      return;
    }

    const [created] = await this.db.insert(scanGroups).values({
      name: 'Olympus Scans',
      slug: 'olympus',
      website: 'https://olympusbiblioteca.com',
    }).returning();

    this.scanGroupId = created.id;
  }

  private async getRecentComicUrls(startPage: number, endPage: number): Promise<string[]> {
    const urls: string[] = [];
    const seen = new Set<string>();

    for (let page = startPage; page <= endPage; page++) {
      try {
        const response = await this.fetchJson<OlympusApiResponse>(
          `${OLYMPUS_API}/new-chapters?page=${page}`
        );

        if (!response.data || !Array.isArray(response.data)) break;

        for (const item of response.data) {
          // Skip novels
          if (item.type?.toLowerCase() === 'novel') continue;

          const slug = item.slug;
          if (slug && !seen.has(slug)) {
            seen.add(slug);
            urls.push(`${OLYMPUS_API}/series/${slug}`);
          }
        }

        await this.delay();
      } catch (error) {
        this.logger.error(`Failed to fetch page ${page}: ${error}`);
        break;
      }
    }

    return urls;
  }

  private async scrapeComic(apiUrl: string, result: ScraperResult): Promise<void> {
    const response = await this.fetchJson<OlympusApiResponse>(apiUrl);
    const data = response.data;

    if (!data?.name || !data?.cover) {
      throw new Error('Incomplete comic data');
    }

    const comic = this.parseComic(data);
    this.logger.log(`Scraping comic: ${comic.title}`);

    // Upsert comic
    const comicId = await this.upsertComic(comic);
    result.comics++;

    // Get and save chapters
    const chapterList = await this.getChapterList(data.slug);
    this.logger.log(`Found ${chapterList.length} chapters for ${comic.title}`);

    for (const chapterItem of chapterList) {
      try {
        const chapter = await this.scrapeChapter(data.slug, chapterItem.id);
        if (chapter.pages.length > 0) {
          await this.upsertChapter(comicId, chapter, chapterItem);
          result.chapters++;
        }
        await this.delay(500); // Shorter delay for chapters
      } catch (error) {
        this.logger.warn(`Failed to scrape chapter ${chapterItem.id}: ${error}`);
      }
    }
  }

  private parseComic(data: any): ScrapedComic {
    const statusMap: Record<string, ScrapedComic['status']> = {
      'en curso': 'ongoing',
      'activo': 'ongoing',
      'ongoing': 'ongoing',
      'completo': 'completed',
      'completed': 'completed',
      'finalizado': 'completed',
      'pausado': 'hiatus',
      'hiatus': 'hiatus',
      'cancelado': 'cancelled',
      'cancelled': 'cancelled',
    };

    const typeMap: Record<string, ScrapedComic['type']> = {
      'manga': 'manga',
      'manhwa': 'manhwa',
      'manhua': 'manhua',
    };

    const rawStatus = (data.status?.name || '').toLowerCase();
    const rawType = (data.type || '').toLowerCase();

    return {
      id: String(data.id),
      slug: data.slug,
      title: (data.name || '').replace(/\.$/, ''),
      titleAlternative: data.alternativeName,
      description: data.summary,
      author: data.author,
      coverImage: data.cover,
      type: typeMap[rawType] || 'comic',
      status: statusMap[rawStatus] || 'ongoing',
      genres: (data.genres || []).map((g: any) => g.name?.toUpperCase()).filter(Boolean),
      groupScan: data.team ? {
        name: data.team.name,
        id: String(data.team.id),
        cover: data.team.cover,
      } : undefined,
    };
  }

  private async getChapterList(slug: string): Promise<ChapterListItem[]> {
    const allChapters: ChapterListItem[] = [];
    let page = 1;

    while (page <= 100) {
      const url = `${OLYMPUS_API}/series/${slug}/chapters?page=${page}&direction=asc&type=comic`;
      const response = await this.fetchJson<OlympusApiResponse>(url);

      if (!response.data || !Array.isArray(response.data) || response.data.length === 0) {
        break;
      }

      for (const item of response.data) {
        if (!item.name || !item.id) continue;

        allChapters.push({
          id: String(item.id),
          title: item.name,
          number: item.name,
          url: `${OLYMPUS_API}/series/${slug}/chapters/${item.id}`,
          pathname: String(item.id),
          releaseDate: item.published_at ? new Date(item.published_at) : undefined,
        });
      }

      if (!response.links?.next) break;
      page++;
      await this.delay(300);
    }

    return allChapters;
  }

  private async scrapeChapter(slug: string, chapterId: string): Promise<ScrapedChapter> {
    const url = `${OLYMPUS_API}/series/${slug}/chapters/${chapterId}`;
    const response = await this.fetchJson<any>(url);

    const chapter = response.chapter || {};
    const pages = (chapter.pages || []).filter((p: any) => typeof p === 'string');

    return {
      id: chapterId,
      chapterNumber: this.parseChapterNumber(chapter.number || chapter.name || '0'),
      title: chapter.name,
      slug: chapterId,
      pages,
      prevChapterUrl: response.prev_chapter?.id
        ? `${OLYMPUS_API}/series/${slug}/chapters/${response.prev_chapter.id}`
        : undefined,
      nextChapterUrl: response.next_chapter?.id
        ? `${OLYMPUS_API}/series/${slug}/chapters/${response.next_chapter.id}`
        : undefined,
    };
  }

  private async upsertComic(comic: ScrapedComic): Promise<number> {
    // Check if comic exists
    const existing = await this.db.query.comics.findFirst({
      where: eq(comics.slug, comic.slug),
    });

    let comicId: number;

    if (existing) {
      await this.db.update(comics).set({
        title: comic.title,
        titleAlternative: comic.titleAlternative,
        description: comic.description,
        author: comic.author,
        coverImage: comic.coverImage,
        type: comic.type === 'comic' ? 'manga' : comic.type,
        status: comic.status,
        updatedAt: new Date(),
      }).where(eq(comics.id, existing.id));
      comicId = existing.id;
    } else {
      const [created] = await this.db.insert(comics).values({
        title: comic.title,
        slug: comic.slug,
        titleAlternative: comic.titleAlternative,
        description: comic.description,
        author: comic.author,
        coverImage: comic.coverImage,
        type: comic.type === 'comic' ? 'manga' : comic.type,
        status: comic.status,
      }).returning();
      comicId = created.id;
    }

    // Ensure comic scan exists
    await this.ensureComicScan(comicId, comic);

    // Sync genres
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
      externalId: comic.id,
      externalUrl: `${OLYMPUS_ORIGIN}/series/${comic.slug}`,
      language: 'es',
    }).returning();

    return created.id;
  }

  private async syncGenres(comicId: number, genreNames: string[]): Promise<void> {
    // Delete existing
    await this.db.delete(comicGenres).where(eq(comicGenres.comicId, comicId));

    for (const name of genreNames) {
      const slug = this.slugify(name);

      // Get or create genre
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

      // Link to comic
      await this.db.insert(comicGenres).values({
        comicId,
        genreId: genre.id,
      }).onConflictDoNothing();
    }
  }

  private async upsertChapter(
    comicId: number,
    chapter: ScrapedChapter,
    listItem: ChapterListItem,
  ): Promise<void> {
    // Get comic scan
    const comicScan = await this.db.query.comicScans.findFirst({
      where: eq(comicScans.comicId, comicId),
    });

    if (!comicScan) return;

    const existing = await this.db.query.chapters.findFirst({
      where: eq(chapters.slug, chapter.slug),
    });

    if (existing) {
      await this.db.update(chapters).set({
        urlPages: chapter.pages,
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

  private async fetchJson<T>(url: string): Promise<T> {
    const response = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Origin': OLYMPUS_ORIGIN,
        'Referer': OLYMPUS_ORIGIN,
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    return response.json();
  }

  private parseChapterNumber(input: string | number): number {
    if (typeof input === 'number') return input;
    const match = String(input).match(/[\d.]+/);
    return match ? parseFloat(match[0]) : 0;
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
