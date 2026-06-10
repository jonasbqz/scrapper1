import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CacheService } from '@/cache/cache.service';
import { randomInt } from 'crypto';

const ROUTE_CODE_TTL_MS = 16 * 60 * 60 * 1000;
const UNAVAILABLE_MESSAGE =
  'No fue posible encontrar ese contenido ahora. Puedes volver y buscar otro contenido.';

type HeadersLike = Headers | Record<string, unknown> | undefined;

interface ProtectedComicShape {
  id: number;
  slug: string;
  protectedRouteEnabled?: boolean | null;
}

interface ProtectedChapterShape {
  id: number;
}

@Injectable()
export class RouteProtectionService {
  constructor(
    private readonly cacheService: CacheService,
    private readonly configService: ConfigService,
  ) {}

  isProtected(comic: ProtectedComicShape | null | undefined): boolean {
    return Boolean(comic?.protectedRouteEnabled);
  }

  hasInternalAccess(headers: HeadersLike): boolean {
    const secret = this.configService.get<string>('INTERNAL_ROUTE_SECRET')?.trim();

    if (!secret) {
      if (process.env.NODE_ENV === 'production') {
        return false;
      }
      return false;
    }

    const provided = this.getHeaderValue(headers, 'x-internal-route-secret');
    return provided === secret;
  }

  createUnavailableException(): ServiceUnavailableException {
    return new ServiceUnavailableException(UNAVAILABLE_MESSAGE);
  }

  parseComicSegment(segment: string): {
    slug: string;
    code: string | null;
    hasCode: boolean;
  } {
    const match = segment.match(/^(.*)-(\d{6})$/);
    if (!match || !match[1]) {
      return {
        slug: segment,
        code: null,
        hasCode: false,
      };
    }

    return {
      slug: match[1],
      code: match[2],
      hasCode: true,
    };
  }

  parseChapterSegment(segment: string): {
    chapterId: number | null;
    code: string | null;
    hasCode: boolean;
  } {
    if (/^\d+$/.test(segment)) {
      return {
        chapterId: Number(segment),
        code: null,
        hasCode: false,
      };
    }

    const match = segment.match(/^(\d+)-(\d{6})$/);
    if (!match) {
      return {
        chapterId: null,
        code: null,
        hasCode: false,
      };
    }

    return {
      chapterId: Number(match[1]),
      code: match[2],
      hasCode: true,
    };
  }

  async getComicCode(comicId: number): Promise<string> {
    return this.getOrCreateCode(this.getComicCacheKey(comicId));
  }

  async getChapterCode(chapterId: number): Promise<string> {
    return this.getOrCreateCode(this.getChapterCacheKey(chapterId));
  }

  async getComicPath(comic: ProtectedComicShape): Promise<string> {
    const basePath = `/comics/${comic.slug}`;
    if (!this.isProtected(comic)) {
      return basePath;
    }

    const code = await this.getComicCode(comic.id);
    return `${basePath}-${code}`;
  }

  async getChapterPath(
    comic: ProtectedComicShape,
    chapter: ProtectedChapterShape,
    options?: { comicPath?: string },
  ): Promise<string> {
    const comicPath = options?.comicPath || await this.getComicPath(comic);

    if (!this.isProtected(comic)) {
      return `${comicPath}/chapters/${chapter.id}`;
    }

    const code = await this.getChapterCode(chapter.id);
    return `${comicPath}/chapters/${chapter.id}-${code}`;
  }

  async assertLegacyAccess(
    comic: ProtectedComicShape | null | undefined,
    headers: HeadersLike,
  ): Promise<void> {
    if (this.isProtected(comic) && !this.hasInternalAccess(headers)) {
      throw this.createUnavailableException();
    }
  }

  private async getOrCreateCode(key: string): Promise<string> {
    const existing = await this.cacheService.get<string>(key);
    if (existing && /^\d{6}$/.test(existing)) {
      return existing;
    }

    const code = this.generateCode();
    await this.cacheService.set(key, code, ROUTE_CODE_TTL_MS);
    return code;
  }

  private generateCode(): string {
    return randomInt(100000, 1000000).toString();
  }

  private getComicCacheKey(comicId: number): string {
    return `route:comic:${comicId}`;
  }

  private getChapterCacheKey(chapterId: number): string {
    return `route:chapter:${chapterId}`;
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
