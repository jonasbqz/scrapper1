import { Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { randomInt } from 'crypto';
import { Cron, CronExpression } from '@nestjs/schedule';
import { CacheService } from '@/cache/cache.service';
import { DATABASE_CONNECTION } from '@/database/database.module';
import { comics } from '@/database/schema';
import type * as schema from '@/database/schema';

const COMIC_SLUG_ROTATION_CRON = '0 0 */3 * *';
const COMIC_SLUG_PREFIX_DIGITS = 3;
const COMIC_SLUG_SUFFIX_DIGITS = 4;
const COMIC_SLUG_RANDOM_MAX_ATTEMPTS = 10;
const UNAVAILABLE_MESSAGE =
  'No fue posible encontrar ese contenido ahora. Puedes volver y buscar otro contenido.';

interface ProtectedComicShape {
  id: number;
  slug: string;
  title?: string | null;
  protectedRouteEnabled?: boolean | null;
}

interface ProtectedChapterShape {
  id: number;
  slug: string;
  comicId?: number;
}

type HeadersLike = Headers | Record<string, unknown> | undefined;

@Injectable()
export class RouteProtectionService {
  private readonly logger = new Logger(RouteProtectionService.name);
  private readonly comicRotationLocks = new Map<number, Promise<string>>();

  constructor(
    private readonly cacheService: CacheService,
    private readonly configService: ConfigService,
    @Inject(DATABASE_CONNECTION)
    private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  isProtected(comic: ProtectedComicShape | null | undefined): boolean {
    return Boolean(comic?.protectedRouteEnabled);
  }

  hasInternalAccess(headers: HeadersLike): boolean {
    const secret = this.configService.get<string>('INTERNAL_ROUTE_SECRET')?.trim();

    if (!secret) {
      return false;
    }

    const provided = this.getHeaderValue(headers, 'x-internal-route-secret');
    return provided === secret;
  }

  createUnavailableException(): ServiceUnavailableException {
    return new ServiceUnavailableException(UNAVAILABLE_MESSAGE);
  }

  async assertLegacyAccess(
    comic: ProtectedComicShape | null | undefined,
    headers: HeadersLike,
  ): Promise<void> {
    if (this.isProtected(comic) && !this.hasInternalAccess(headers)) {
      throw this.createUnavailableException();
    }
  }

  parseComicSegment(segment: string): {
    slug: string;
    hasCode: boolean;
  } {
    if (this.looksLikeProtectedComicSlug(segment)) {
      return { slug: segment, hasCode: true };
    }
    return { slug: segment, hasCode: false };
  }

  parseChapterSegment(segment: string): {
    chapterSlug: string;
    random: string | null;
    hasRandom: boolean;
  } {
    return { chapterSlug: segment, random: null, hasRandom: false };
  }

  async getComicPath(comic: ProtectedComicShape): Promise<string> {
    return `/comics/${comic.slug}`;
  }

  async getChapterPath(
    comic: ProtectedComicShape,
    chapter: ProtectedChapterShape,
    options?: { comicPath?: string },
  ): Promise<string> {
    const comicPath = options?.comicPath || (await this.getComicPath(comic));
    // Unprotected: use numeric chapter ID (clean, SEO-friendly, parseable).
    // Protected: use the opaque slug (hides the chapter ID).
    const identifier = this.isProtected(comic) ? chapter.slug : String(chapter.id);
    return `${comicPath}/chapters/${identifier}`;
  }

  @Cron(COMIC_SLUG_ROTATION_CRON)
  async rotateAllProtectedComicSlugs(): Promise<number> {
    const protectedComics = await this.db
      .select({ id: comics.id, slug: comics.slug, title: comics.title })
      .from(comics)
      .where(eq(comics.protectedRouteEnabled, true));

    let rotated = 0;
    for (const comic of protectedComics) {
      const titleSlug = this.extractTitleSlug(comic.slug, comic.title);
      const next = await this.rotateProtectedComicSlug(comic.id, titleSlug);
      if (next !== comic.slug) {
        rotated += 1;
      }
    }

    if (rotated > 0) {
      this.logger.log(
        `[route-protection] Rotated ${rotated} protected comic slug${rotated === 1 ? '' : 's'}.`,
      );
    }
    return rotated;
  }

  async rotateProtectedComicSlug(
    comicId: number,
    titleSlug: string,
  ): Promise<string> {
    const inFlight = this.comicRotationLocks.get(comicId);
    if (inFlight) {
      return inFlight;
    }

    const promise = (async () => {
      const next = await this.generateUniqueComicSlug(titleSlug);
      await this.db
        .update(comics)
        .set({ slug: next, updatedAt: sql`now()` })
        .where(eq(comics.id, comicId));
      return next;
    })().finally(() => {
      this.comicRotationLocks.delete(comicId);
    });

    this.comicRotationLocks.set(comicId, promise);
    return promise;
  }

  async generateUniqueComicSlug(titleSlug: string): Promise<string> {
    for (let attempt = 0; attempt < COMIC_SLUG_RANDOM_MAX_ATTEMPTS; attempt += 1) {
      const candidate = `${this.generateComicSlugPrefix()}${titleSlug}${this.generateComicSlugSuffix()}`;
      const collision = await this.db
        .select({ id: comics.id })
        .from(comics)
        .where(eq(comics.slug, candidate))
        .limit(1);
      if (collision.length === 0) {
        return candidate;
      }
    }
    throw new Error(
      `Failed to generate a unique protected comic slug for "${titleSlug}" after ${COMIC_SLUG_RANDOM_MAX_ATTEMPTS} attempts`,
    );
  }

  extractTitleSlug(slug: string, title?: string | null): string {
    const stripped = this.stripProtectedDecorations(slug);
    if (stripped) {
      return stripped;
    }
    if (title) {
      return this.slugifyTitle(title);
    }
    return stripped || 'comic';
  }

  private stripProtectedDecorations(slug: string): string {
    if (!this.looksLikeProtectedComicSlug(slug)) {
      return slug;
    }
    const start = COMIC_SLUG_PREFIX_DIGITS;
    const end = slug.length - COMIC_SLUG_SUFFIX_DIGITS;
    if (end <= start) {
      return '';
    }
    return slug.slice(start, end);
  }

  private looksLikeProtectedComicSlug(slug: string): boolean {
    if (slug.length < COMIC_SLUG_PREFIX_DIGITS + COMIC_SLUG_SUFFIX_DIGITS) {
      return false;
    }
    const start = slug.slice(0, COMIC_SLUG_PREFIX_DIGITS);
    const end = slug.slice(slug.length - COMIC_SLUG_SUFFIX_DIGITS);
    return /^\d+$/.test(start) && /^\d+$/.test(end);
  }

  private slugifyTitle(title: string): string {
    return title
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 240);
  }

  private generateComicSlugPrefix(): string {
    const max = 10 ** COMIC_SLUG_PREFIX_DIGITS;
    const min = 10 ** (COMIC_SLUG_PREFIX_DIGITS - 1);
    return randomInt(min, max).toString();
  }

  private generateComicSlugSuffix(): string {
    const max = 10 ** COMIC_SLUG_SUFFIX_DIGITS;
    const min = 10 ** (COMIC_SLUG_SUFFIX_DIGITS - 1);
    return randomInt(min, max).toString();
  }

  private getHeaderValue(headers: HeadersLike, name: string): string {
    if (!headers) {
      return '';
    }

    if (headers instanceof Headers) {
      return headers.get(name) || '';
    }

    const directValue = headers[name];
    if (typeof directValue === 'string') {
      return directValue;
    }

    if (Array.isArray(directValue)) {
      return directValue[0] || '';
    }

    const normalizedKey = Object.keys(headers).find(
      (key) => key.toLowerCase() === name.toLowerCase(),
    );

    if (!normalizedKey) {
      return '';
    }

    const normalizedValue = headers[normalizedKey];
    if (typeof normalizedValue === 'string') {
      return normalizedValue;
    }

    if (Array.isArray(normalizedValue)) {
      return normalizedValue[0] || '';
    }

    return '';
  }
}
