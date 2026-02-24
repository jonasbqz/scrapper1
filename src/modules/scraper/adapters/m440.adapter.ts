import { Logger } from '@nestjs/common';
import * as cheerio from 'cheerio';
import * as vm from 'node:vm';
import * as CryptoJS from 'crypto-js';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '@/database/schema';
import { eq, and, inArray } from 'drizzle-orm';
import { comics, chapters, comicScans, scanGroups, genres, comicGenres } from '@/database/schema';
import type { ScrapedComic, ScrapedChapter, ChapterListItem, ScraperResult } from '../scraper.types';
import { isAdultGenreSlug } from './base.adapter';

const M440_ORIGIN = 'https://m440.in';
const M440_IMAGE_CDN = 'https://s1.m440.in';

/** Check if a genre/category name is specifically "hentai" */
function isHentaiCategory(categoryName: string): boolean {
  return categoryName.toLowerCase().trim() === '33';
}

/** Replica del objeto CryptoJSAesJson del sitio */
const CryptoJSAesJson = {
  stringify(cipherParams: any): string {
    const j: any = { ct: cipherParams.ciphertext.toString(CryptoJS.enc.Base64) };
    if (cipherParams.iv) j.iv = cipherParams.iv.toString();
    if (cipherParams.salt) j.s = cipherParams.salt.toString();
    return JSON.stringify(j);
  },
  parse(jsonStr: string): any {
    const j = JSON.parse(jsonStr);
    const cipherParams = CryptoJS.lib.CipherParams.create({
      ciphertext: CryptoJS.enc.Base64.parse(j.ct),
    });
    if (j.iv) cipherParams.iv = CryptoJS.enc.Hex.parse(j.iv);
    if (j.s) cipherParams.salt = CryptoJS.enc.Hex.parse(j.s);
    return cipherParams;
  },
};

interface M440ListingItem {
  manga_name: string;
  manga_slug: string;
  manga_id: string;
  manga_caution: string;
  manga_status_id: string;
  manga_type_id: string;
  manga_chapters: number;
  rating: { avg: number; votes: number };
  timestamp: number;
  categories: string[];
  chapters: {
    chapter_name: string;
    chapter_number: string;
    chapter_slug: string;
    chapter_id: string;
    timestamp: number;
  }[];
}

interface M440ListingResponse {
  data: M440ListingItem[];
  totalPages: number;
}

export class PeerlessAdapter {
  private readonly logger = new Logger(PeerlessAdapter.name);
  private scanGroupId: number | null = null;
  private baseUrl: string;

  constructor(
    private db: NodePgDatabase<typeof schema>,
    private delayMs: number = 400,
    baseUrl?: string,
  ) {
    this.baseUrl = baseUrl || process.env.SCRAPER_PEERLESS_URL || M440_ORIGIN;
  }

  async scrape(startPage = 1, endPage = 10): Promise<ScraperResult> {
    const result: ScraperResult = { comics: 0, chapters: 0, errors: [] };

    this.logger.log(`Starting Peerless scrape: pages ${startPage}-${endPage}`);

    try {
      await this.ensureScanGroup();

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
      const msg = `Peerless scraper failed: ${error}`;
      this.logger.error(msg);
      result.errors.push(msg);
    }

    this.logger.log(`Peerless scrape completed: ${result.comics} comics, ${result.chapters} chapters, ${result.errors.length} errors`);
    return result;
  }

  private async ensureScanGroup(): Promise<void> {
    const existing = await this.db.query.scanGroups.findFirst({
      where: eq(scanGroups.slug, 'peerless-scan'),
    });

    if (existing) {
      this.scanGroupId = existing.id;
      return;
    }

    const [created] = await this.db.insert(scanGroups).values({
      name: 'Peerless Scan',
      slug: 'peerless-scan',
      website: M440_ORIGIN,
    }).returning();

    this.scanGroupId = created.id;
  }

  private async getRecentComicUrls(startPage: number, endPage: number): Promise<string[]> {
    const urls: string[] = [];
    const seen = new Set<string>();

    for (let page = startPage; page <= endPage; page++) {
      try {
        const listUrl = `${this.baseUrl}/lasted?p=${page}`;
        this.logger.debug(`Fetching listing page ${page}: ${listUrl}`);

        const response = await fetch(listUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36',
            'Accept': 'application/json',
          },
        });

        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const json: M440ListingResponse = await response.json();

        for (const item of json.data) {
          if (item.manga_chapters === 0) continue;

          // Skip hentai/adult content based on categories from listing
          const hasHentaiCategory = item.categories?.some(cat => isHentaiCategory(cat));
          if (hasHentaiCategory) {
            this.logger.debug(`Skipping hentai comic from listing: ${item.manga_name} (categories: ${item.categories.join(', ')})`);
            continue;
          }

          const comicUrl = `${this.baseUrl}/manga/${item.manga_slug}`;
          if (!seen.has(comicUrl)) {
            seen.add(comicUrl);
            urls.push(comicUrl);
          }
        }

        this.logger.debug(`Page ${page}: found ${json.data.filter(i => i.manga_chapters > 0).length} comics with chapters`);

        if (page >= json.totalPages) break;
        await this.delay(200);
      } catch (error) {
        this.logger.error(`Failed to fetch listing page ${page}: ${error}`);
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

    // Skip hentai/adult content based on parsed genres
    const hasHentaiGenre = comic.genres.some(g => isHentaiCategory(g));
    if (hasHentaiGenre) {
      this.logger.log(`⛔ Skipping hentai comic: ${comic.title} (genres: ${comic.genres.join(', ')})`);
      return;
    }

    this.logger.log(`Scraping comic: ${comic.title}`);

    const comicId = await this.upsertComic(comic);
    this.logger.log(`Upserted comic: ${comic.title} (id=${comicId})`);
    result.comics++;

    const chapterList = await this.getChapterList($, url, comic.slug);
    this.logger.log(`Found ${chapterList.length} chapters for ${comic.title}`);

    if (chapterList.length === 0) {
      this.logger.warn(`0 chapters found — decryption may have failed for ${comic.title}`);
      return;
    }

    // Get existing chapter slugs from DB to skip already-scraped chapters
    const existingSlugs = await this.getExistingChapterSlugs(comicId);
    const newChapters = chapterList.filter(ch => !existingSlugs.has(ch.id));

    this.logger.log(`${comic.title}: ${newChapters.length} new chapters (${existingSlugs.size} already in DB)`);

    if (newChapters.length === 0) return;

    let savedCount = 0;
    let emptyCount = 0;

    for (const chapterItem of newChapters) {
      try {
        const chapter = await this.scrapeChapter(chapterItem.url, comic.slug, chapterItem.id);
        if (chapter.pages.length > 0) {
          await this.upsertChapter(comicId, chapter, chapterItem);
          result.chapters++;
          savedCount++;
        } else {
          emptyCount++;
        }
        await this.delay(400);
      } catch (error) {
        this.logger.warn(`Failed to scrape chapter ${chapterItem.url}: ${error}`);
      }
    }

    this.logger.log(`${comic.title}: saved ${savedCount} chapters, ${emptyCount} empty pages, ${newChapters.length - savedCount - emptyCount} errors`);
  }

  private parseComicFromHtml($: cheerio.CheerioAPI, url: string): ScrapedComic {
    let jsmangas: any = null;

    $('script').each((_, el) => {
      const content = $(el).html() || '';
      const match = content.match(/const jsmangas\s*=\s*(\{[\s\S]*?\});/);
      if (match) {
        try { jsmangas = JSON.parse(match[1]); } catch { /* ignore */ }
      }
    });

    const slug = this.extractSlugFromUrl(url);

    if (!jsmangas) {
      return {
        slug,
        title: $('h2.widget-title').text().trim() || slug,
        type: 'manga',
        status: 'ongoing',
        genres: [],
      };
    }

    // Status mapping
    const statusMap: Record<string, ScrapedComic['status']> = {
      '1': 'ongoing',
      '2': 'completed',
      '3': 'hiatus',
      '4': 'cancelled',
    };

    // Type mapping
    const typeMap: Record<string, ScrapedComic['type']> = {
      '1': 'manga',
      '2': 'manhwa',
      '3': 'manhua',
    };

    // Categories/genres
    const genresList: string[] = [];
    if (jsmangas.categories) {
      for (const cat of jsmangas.categories) {
        if (cat.name) genresList.push(cat.name.toUpperCase());
      }
    }

    // Check for adult badge: div.manga-name i.adult
    const hasAdultBadge = $('div.manga-name i.adult').length > 0;
    if (hasAdultBadge && !genresList.some(g => g === '+18')) {
      genresList.push('+18');
    }

    // Cover image
    const coverImage = `${M440_ORIGIN}/uploads/manga/${slug}/cover/cover_250x350.jpg`;

    return {
      slug,
      title: jsmangas.name || '',
      titleAlternative: jsmangas.otherNames || undefined,
      description: jsmangas.summary?.replace(/<[^>]*>/g, '').trim() || undefined,
      author: jsmangas.author || undefined,
      artist: jsmangas.artist || undefined,
      coverImage,
      type: typeMap[jsmangas.type_id] || 'manga',
      status: statusMap[jsmangas.status_id] || 'ongoing',
      genres: genresList,
    };
  }

  private async getChapterList($: cheerio.CheerioAPI, comicUrl: string, mangaSlug: string): Promise<ChapterListItem[]> {
    let usaPonchoRaw: string | null = null;
    let obfuscatedScript: string | null = null;

    $('script').each((_, el) => {
      const content = $(el).html() || '';

      if (content.includes('const UsaPoncho =')) {
        const match = content.match(/const UsaPoncho = "(.*?)";/s);
        if (match) {
          try {
            usaPonchoRaw = JSON.parse(`"${match[1]}"`);
          } catch {
            usaPonchoRaw = match[1]?.replace(/\\"/g, '"').replace(/\\\\/g, '\\') || null;
          }
        }
      }

      if (content.includes('ReturnStrg') && content.includes('CryptoJSAesJson')) {
        obfuscatedScript = content;
      }
    });

    if (!usaPonchoRaw) return [];

    const key = this.extractDecryptionKey(obfuscatedScript);
    const chaptersData = this.decryptChapters(usaPonchoRaw, key);

    if (!chaptersData || !Array.isArray(chaptersData)) return [];

    return chaptersData.map((ch: any) => ({
      id: ch.slug,
      title: ch.name || `Chapter ${ch.number}`,
      number: String(ch.number),
      url: `${this.baseUrl}/manga/${mangaSlug}/${ch.slug}`,
      pathname: `/manga/${mangaSlug}/${ch.slug}`,
      releaseDate: ch.created_at ? new Date(ch.created_at) : undefined,
    }));
  }

  private async scrapeChapter(chapterUrl: string, mangaSlug: string, chapterSlug: string): Promise<ScrapedChapter> {
    const html = await this.fetchHtml(chapterUrl);
    const $ = cheerio.load(html);

    const pages: string[] = [];

    // Extract var pages = [...] from script
    $('script').each((_, el) => {
      const content = $(el).html() || '';
      const match = content.match(/var\s+pages\s*=\s*(\[[\s\S]*?\]);/);
      if (match) {
        try {
          const pagesData: { page_image: string; page_slug: string; external: string }[] = JSON.parse(match[1]);
          for (const p of pagesData) {
            if (p.external === '1') {
              // External image: base64-encoded URL, sometimes prefixed with https://
              try {
                let b64 = p.page_image;
                if (b64.startsWith('https://') || b64.startsWith('http://')) {
                  b64 = b64.replace(/^https?:\/\//, '');
                }
                const decoded = decodeURIComponent(atob(b64));
                pages.push(decoded);
              } catch {
                pages.push(p.page_image);
              }
            } else {
              pages.push(`${M440_IMAGE_CDN}/uploads/manga/${mangaSlug}/chapters/${chapterSlug}/${p.page_image}`);
            }
          }
        } catch { /* ignore */ }
      }
    });

    // Extract chapter number: "53_5-kllle" → 53.5, "120-abc" → 120
    const numMatch = chapterSlug.match(/^(\d+(?:[_.]\d+)?)/);
    const chapterNumber = numMatch
      ? parseFloat(numMatch[1].replace('_', '.'))
      : 0;

    return {
      chapterNumber,
      title: $('title').text().trim() || undefined,
      slug: chapterSlug,
      pages,
    };
  }

  private extractDecryptionKey(obfuscatedScript: string | null): string {
    const fallbackKey = 'X^Ib1O*HLVh%3W2t';

    if (!obfuscatedScript) return fallbackKey;

    try {
      const cutoff = obfuscatedScript.indexOf('let jschaptertemp');
      const safeScript = cutoff > 0 ? obfuscatedScript.substring(0, cutoff) : obfuscatedScript;

      const sandbox = {
        CryptoJS: { AES: { decrypt: () => ({ toString: () => '{}' }) }, enc: { Hex: { parse: () => ({}) }, Base64: { parse: () => ({}) }, Utf8: {} }, lib: { CipherParams: { create: () => ({}) } } },
        UsaPoncho: '{}',
        console: { log: () => {}, warn: () => {}, error: () => {} },
      };
      const ctx = vm.createContext(sandbox);
      vm.runInContext(safeScript, ctx, { timeout: 5000 });
      const extracted = vm.runInContext('ReturnStrg()', ctx, { timeout: 5000 });

      if (typeof extracted === 'string' && extracted.length > 0) return extracted;
    } catch { /* ignore */ }

    return fallbackKey;
  }

  private decryptChapters(encrypted: string, key: string): any[] | null {
    try {
      const decrypted = CryptoJS.AES.decrypt(encrypted, key, { format: CryptoJSAesJson });
      const str = decrypted.toString(CryptoJS.enc.Utf8);
      if (!str) {
        this.logger.warn('Decryption produced empty string — CryptoJS import may be broken');
        return null;
      }

      try {
        const result = JSON.parse(JSON.parse(str));
        this.logger.debug(`Decrypted ${Array.isArray(result) ? result.length : 0} chapters`);
        return result;
      } catch {
        const result = JSON.parse(str);
        this.logger.debug(`Decrypted ${Array.isArray(result) ? result.length : 0} chapters (single parse)`);
        return result;
      }
    } catch (err) {
      this.logger.error(`Decryption failed: ${err}`);
      return null;
    }
  }

  private async upsertComic(comic: ScrapedComic): Promise<number> {
    const externalUrl = `${M440_ORIGIN}/manga/${comic.slug}`;

    const existingComicScan = await this.db.query.comicScans.findFirst({
      where: and(
        eq(comicScans.externalUrl, externalUrl),
        eq(comicScans.scanGroupId, this.scanGroupId!),
      ),
      with: { comic: true },
    });

    let comicId: number;

    if (existingComicScan && existingComicScan.comic) {
      await this.db.update(comics).set({
        title: comic.title,
        titleAlternative: comic.titleAlternative,
        description: comic.description,
        author: comic.author,
        artist: comic.artist,
        coverImage: comic.coverImage,
        type: comic.type === 'comic' ? 'manga' : comic.type,
        status: comic.status,
        updatedAt: new Date(),
      }).where(eq(comics.id, existingComicScan.comicId));
      comicId = existingComicScan.comicId;
      this.logger.debug(`Updated existing comic via comicScan: ${comic.title} (id=${comicId})`);
    } else {
      const existingBySlug = await this.db.query.comics.findFirst({
        where: eq(comics.slug, comic.slug),
      });

      if (existingBySlug) {
        await this.db.update(comics).set({
          title: comic.title,
          titleAlternative: comic.titleAlternative,
          description: comic.description,
          author: comic.author,
          artist: comic.artist,
          coverImage: comic.coverImage,
          type: comic.type === 'comic' ? 'manga' : comic.type,
          status: comic.status,
          updatedAt: new Date(),
        }).where(eq(comics.id, existingBySlug.id));
        comicId = existingBySlug.id;
        this.logger.debug(`Updated existing comic via slug: ${comic.title} (id=${comicId})`);
      } else {
        const [created] = await this.db.insert(comics).values({
          title: comic.title,
          slug: comic.slug,
          titleAlternative: comic.titleAlternative,
          description: comic.description,
          author: comic.author,
          artist: comic.artist,
          coverImage: comic.coverImage,
          type: comic.type === 'comic' ? 'manga' : comic.type,
          status: comic.status,
        }).returning();
        comicId = created.id;
        this.logger.debug(`Created new comic: ${comic.title} (id=${comicId})`);
      }
    }

    const scanId = await this.ensureComicScan(comicId, comic);
    this.logger.debug(`ComicScan ensured: comicId=${comicId}, scanId=${scanId}`);
    await this.syncGenres(comicId, comic.genres);

    return comicId;
  }

  private async ensureComicScan(comicId: number, comic: ScrapedComic): Promise<number> {
    const existing = await this.db.query.comicScans.findFirst({
      where: and(
        eq(comicScans.comicId, comicId),
        eq(comicScans.scanGroupId, this.scanGroupId!),
      ),
    });

    if (existing) return existing.id;

    const [created] = await this.db.insert(comicScans).values({
      comicId,
      scanGroupId: this.scanGroupId!,
      externalUrl: `${M440_ORIGIN}/manga/${comic.slug}`,
      language: 'es',
    }).onConflictDoNothing().returning();

    if (!created) {
      // Race condition: re-fetch
      const refetch = await this.db.query.comicScans.findFirst({
        where: and(
          eq(comicScans.comicId, comicId),
          eq(comicScans.scanGroupId, this.scanGroupId!),
        ),
      });
      return refetch!.id;
    }

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

  /** Get all chapter slugs already in DB for this comic+scanGroup */
  private async getExistingChapterSlugs(comicId: number): Promise<Set<string>> {
    const comicScan = await this.db.query.comicScans.findFirst({
      where: and(
        eq(comicScans.comicId, comicId),
        eq(comicScans.scanGroupId, this.scanGroupId!),
      ),
    });

    if (!comicScan) return new Set();

    const existing = await this.db.query.chapters.findMany({
      where: eq(chapters.comicScanId, comicScan.id),
      columns: { slug: true },
    });

    return new Set(existing.map(ch => ch.slug));
  }

  private async upsertChapter(
    comicId: number,
    chapter: ScrapedChapter,
    listItem: ChapterListItem,
  ): Promise<void> {
    const comicScan = await this.db.query.comicScans.findFirst({
      where: and(
        eq(comicScans.comicId, comicId),
        eq(comicScans.scanGroupId, this.scanGroupId!),
      ),
    });

    if (!comicScan) {
      this.logger.warn(`No comicScan found for comicId=${comicId}, scanGroupId=${this.scanGroupId} — skipping chapter ${chapter.slug}`);
      return;
    }

    // Use slug as unique identifier (m440's real chapter ID)
    const existing = await this.db.query.chapters.findFirst({
      where: and(
        eq(chapters.comicScanId, comicScan.id),
        eq(chapters.slug, chapter.slug),
      ),
    });

    if (existing) {
      await this.db.update(chapters).set({
        urlPages: chapter.pages,
        chapterNumber: chapter.chapterNumber,
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
