import { Logger } from '@nestjs/common';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '@/database/schema';
import { eq, and, desc } from 'drizzle-orm';
import { comics, chapters, comicScans, scanGroups, genres, comicGenres } from '@/database/schema';
import type { ScrapedComic, ScrapedChapter, ChapterListItem, ScraperResult } from '../scraper.types';
import { isAdultGenreSlug } from './base.adapter';

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
    private delayMs: number = 100,
  ) {}

  async scrape(startPage = 1, endPage = 5): Promise<ScraperResult> {
    const result: ScraperResult = { comics: 0, chapters: 0, errors: [] };

    this.logger.log(`Starting Olympus scrape: pages ${startPage}-${endPage}`);

    try {
      // Ensure scan group exists
      await this.ensureScanGroup();
      this.logger.log(`Scan group ensured: ID ${this.scanGroupId}`);

      const startTime = Date.now();
      const comicInfos = await this.getRecentComicUrls(startPage, endPage);
      const duration = ((Date.now() - startTime) / 1000).toFixed(2);
      this.logger.log(`Found ${comicInfos.length} comics to scrape (took ${duration}s)`);

      if (comicInfos.length === 0) {
        this.logger.warn(`No comics found! Check if the API is working: ${OLYMPUS_API}/new-chapters`);
        result.errors.push(`No comics found from Olympus API`);
      }

      for (const { url, olympusId } of comicInfos) {
        try {
          await this.scrapeComic(url, olympusId, result);
          await this.delay();
        } catch (error) {
          const msg = `Failed to scrape comic ${url} (ID: ${olympusId}): ${error}`;
          this.logger.error(msg);
          result.errors.push(msg);
        }
      }
    } catch (error) {
      const msg = `Olympus scraper failed: ${error}`;
      this.logger.error(msg);
      result.errors.push(msg);
    }

    this.logger.log(`Olympus scrape completed: ${result.comics} comics, ${result.chapters} chapters, ${result.errors.length} errors`);
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

  private async getRecentComicUrls(startPage: number, endPage: number): Promise<{ url: string; olympusId: string }[]> {
    const comics: { url: string; olympusId: string }[] = [];
    const seenIds = new Set<string>();

    for (let page = startPage; page <= endPage; page++) {
      try {
        const apiUrl = `${OLYMPUS_API}/new-chapters?page=${page}`;
        this.logger.debug(`Fetching Olympus page ${page}: ${apiUrl}`);

        const response = await this.fetchJson<OlympusApiResponse>(apiUrl);

        if (!response.data || !Array.isArray(response.data)) {
          this.logger.warn(`Page ${page}: No data or invalid response`);
          break;
        }

        this.logger.debug(`Page ${page}: got ${response.data.length} items`);

        let foundOnPage = 0;
        for (const item of response.data) {
          // Skip novels
          if (item.type?.toLowerCase() === 'novel') continue;

          // Use Olympus ID to identify comics (not slug which changes)
          const olympusId = String(item.id);
          const slug = item.slug;

          if (olympusId && slug && !seenIds.has(olympusId)) {
            seenIds.add(olympusId);
            comics.push({
              url: `${OLYMPUS_API}/series/${slug}`,
              olympusId,
            });
            foundOnPage++;
          }
        }

        this.logger.debug(`Page ${page}: found ${foundOnPage} new comics`);
        await this.delay(200); // Shorter delay for update page discovery
      } catch (error) {
        this.logger.error(`Failed to fetch page ${page}: ${error}`);
        break;
      }
    }

    return comics;
  }

  private async scrapeComic(apiUrl: string, olympusId: string, result: ScraperResult): Promise<void> {
    const response = await this.fetchJson<OlympusApiResponse>(apiUrl);
    const data = response.data;

    if (!data?.name || !data?.cover) {
      throw new Error('Incomplete comic data');
    }

    // Ensure the ID from the API matches what we expect
    const actualOlympusId = String(data.id);
    if (actualOlympusId !== olympusId) {
      this.logger.warn(`Olympus ID mismatch: expected ${olympusId}, got ${actualOlympusId}`);
    }

    const comic = this.parseComic(data);
    this.logger.log(`Scraping comic: ${comic.title} (Olympus ID: ${actualOlympusId})`);

    // Upsert comic and get comicScanId
    const { comicId, comicScanId } = await this.upsertComic(comic);
    result.comics++;

    // Get existing chapter numbers from DB first (ONE query)
    const existingChapters = await this.db.query.chapters.findMany({
      where: eq(chapters.comicScanId, comicScanId),
      columns: { chapterNumber: true },
    });
    const existingNumbers = new Set(existingChapters.map(ch => ch.chapterNumber));
    this.logger.log(`Comic has ${existingNumbers.size} chapters in DB`);

    // Collect missing chapters by paginating until all chapters on a page exist
    const missingChapters: ChapterListItem[] = [];
    let page = 1;
    const maxPages = 50; // Safety limit

    while (page <= maxPages) {
      const chaptersUrl = `${OLYMPUS_API}/series/${data.slug}/chapters?page=${page}}&direction=desc&type=comic`;
      const chaptersResponse = await this.fetchJson<OlympusApiResponse>(chaptersUrl);

      if (!chaptersResponse.data || !Array.isArray(chaptersResponse.data) || chaptersResponse.data.length === 0) {
        break; // No more pages
      }

      // Parse chapters from this page
      const pageChapters: ChapterListItem[] = chaptersResponse.data
        .filter((item: any) => item.name && item.id)
        .map((item: any) => ({
          id: String(item.id),
          title: item.name,
          number: item.name,
          url: `${OLYMPUS_API}/series/${data.slug}/chapters/${item.id}`,
          pathname: String(item.id),
          releaseDate: item.published_at ? new Date(item.published_at) : undefined,
        }));

      // Check which chapters from this page are missing
      const pageMissing = pageChapters.filter(ch => {
        const chapterNum = this.parseChapterNumber(ch.number);
        return !existingNumbers.has(chapterNum);
      });

      if (pageMissing.length === 0) {
        // All chapters on this page already exist - we're caught up
        this.logger.log(`Page ${page}: All ${pageChapters.length} chapters exist, stopping pagination`);
        break;
      }

      this.logger.log(`Page ${page}: Found ${pageMissing.length}/${pageChapters.length} missing chapters`);
      missingChapters.push(...pageMissing);

      // Check if there's a next page
      if (!chaptersResponse.links?.next) {
        break;
      }

      page++;
      await this.delay(200); // Short delay between page fetches
    }

    if (missingChapters.length === 0) {
      this.logger.log(`No new chapters for ${comic.title}`);
      return;
    }

    // Revertir para insertar desde el más antiguo al más nuevo
    // missingChapters.reverse();

    this.logger.log(`Total: ${missingChapters.length} new chapters to add for ${comic.title}`);

    // Only fetch pages for missing chapters
    for (const chapterItem of missingChapters) {
      try {
        const chapter = await this.scrapeChapter(data.slug, chapterItem.id);
        if (chapter.pages.length > 0) {
          await this.insertChapter(comicScanId, chapter, chapterItem);
          result.chapters++;
          this.logger.log(`Added chapter ${chapter.chapterNumber} for ${comic.title}`);
        }
        await this.delay(80); // Short delay between chapter page fetches
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

  private async upsertComic(comic: ScrapedComic): Promise<{ comicId: number; comicScanId: number }> {
    const externalUrl = `${OLYMPUS_ORIGIN}/series/${comic.slug}`;

    // First, check if we already have this comic via externalId (Olympus ID) in comicScans
    let existingComicScan = null;
    if (comic.id) {
      existingComicScan = await this.db.query.comicScans.findFirst({
        where: and(
          eq(comicScans.externalId, comic.id),
          eq(comicScans.scanGroupId, this.scanGroupId!),
        ),
        with: { comic: true },
      });
    }

    let comicId: number;
    let comicScanId: number;

    if (existingComicScan?.comic) {
      // Comic already exists via externalId (Olympus ID) - update it
      await this.db.update(comics).set({
        title: comic.title,
        titleAlternative: comic.titleAlternative,
        slug: comic.slug, // Update slug in case it changed
        description: comic.description,
        author: comic.author,
        coverImage: comic.coverImage,
        type: comic.type === 'comic' ? 'manga' : comic.type,
        status: comic.status,
        updatedAt: new Date(),
      }).where(eq(comics.id, existingComicScan.comic.id));

      // Update externalUrl in case slug changed
      await this.db.update(comicScans).set({
        externalUrl,
      }).where(eq(comicScans.id, existingComicScan.id));

      comicId = existingComicScan.comic.id;
      comicScanId = existingComicScan.id;

      this.logger.debug(`Found existing comic by Olympus ID: ${comic.id} -> Comic #${comicId}`);
    } else {
      // No match by Olympus ID - check by title as fallback (to merge possible duplicates)
      const existingByTitle = await this.db.query.comics.findFirst({
        where: eq(comics.title, comic.title),
      });

      if (existingByTitle) {
        await this.db.update(comics).set({
          slug: comic.slug,
          titleAlternative: comic.titleAlternative,
          description: comic.description,
          author: comic.author,
          coverImage: comic.coverImage,
          type: comic.type === 'comic' ? 'manga' : comic.type,
          status: comic.status,
          updatedAt: new Date(),
        }).where(eq(comics.id, existingByTitle.id));
        comicId = existingByTitle.id;
        this.logger.debug(`Found existing comic by title: "${comic.title}" -> Comic #${comicId}`);
      } else {
        // Create new comic
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
        this.logger.log(`Created new comic: "${comic.title}" -> Comic #${comicId}`);
      }

      // Ensure comic scan exists for this scan group (with Olympus ID)
      comicScanId = await this.ensureComicScan(comicId, comic);
    }

    // Sync genres
    await this.syncGenres(comicId, comic.genres);

    return { comicId, comicScanId };
  }

  private async ensureComicScan(comicId: number, comic: ScrapedComic): Promise<number> {
    // Check for existing comic scan for this specific scan group
    const existing = await this.db.query.comicScans.findFirst({
      where: and(
        eq(comicScans.comicId, comicId),
        eq(comicScans.scanGroupId, this.scanGroupId!),
      ),
    });

    if (existing) {
      // Update externalId and externalUrl if needed
      await this.db.update(comicScans).set({
        externalId: comic.id,
        externalUrl: `${OLYMPUS_ORIGIN}/series/${comic.slug}`,
      }).where(eq(comicScans.id, existing.id));
      return existing.id;
    }

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

  private async insertChapter(
    comicScanId: number,
    chapter: ScrapedChapter,
    listItem: ChapterListItem,
  ): Promise<void> {
    // Insert new chapter (we already know it doesn't exist)
    await this.db.insert(chapters).values({
      comicScanId,
      chapterNumber: chapter.chapterNumber,
      title: chapter.title || listItem.title,
      slug: chapter.slug,
      releaseDate: listItem.releaseDate,
      urlPages: chapter.pages,
    }).onConflictDoNothing();
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
