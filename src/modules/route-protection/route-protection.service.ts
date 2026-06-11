import { Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { randomInt } from 'crypto';
import { CacheService } from '@/cache/cache.service';
import { DATABASE_CONNECTION } from '@/database/database.module';
import { routeProtectionCodes } from '@/database/schema';
import type * as schema from '@/database/schema';

const ROUTE_CODE_CACHE_TTL_MS = 16 * 60 * 60 * 1000;
const UNAVAILABLE_MESSAGE =
  'No fue posible encontrar ese contenido ahora. Puedes volver y buscar otro contenido.';

type RouteEntityType = 'comic' | 'chapter';

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
    return this.getOrCreateCode('comic', comicId);
  }

  async getChapterCode(chapterId: number): Promise<string> {
    return this.getOrCreateCode('chapter', chapterId);
  }

  async rotateComicCode(comicId: number): Promise<string> {
    return this.rotateCode('comic', comicId);
  }

  async rotateChapterCode(chapterId: number): Promise<string> {
    return this.rotateCode('chapter', chapterId);
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

  private async getOrCreateCode(
    entityType: RouteEntityType,
    entityId: number,
  ): Promise<string> {
    const cacheKey = this.getCacheKey(entityType, entityId);

    const cached = await this.cacheService.get<string>(cacheKey);
    if (this.isValidCode(cached)) {
      await this.ensurePersistedCode(entityType, entityId, cached);
      return cached;
    }

    const persisted = await this.readPersistedCode(entityType, entityId);
    if (this.isValidCode(persisted)) {
      await this.cacheService.set(cacheKey, persisted, ROUTE_CODE_CACHE_TTL_MS);
      return persisted;
    }

    const code = this.generateCode();
    const stored = await this.insertPersistedCode(entityType, entityId, code);
    await this.cacheService.set(cacheKey, stored, ROUTE_CODE_CACHE_TTL_MS);
    return stored;
  }

  private async rotateCode(
    entityType: RouteEntityType,
    entityId: number,
  ): Promise<string> {
    const code = this.generateCode();
    const cacheKey = this.getCacheKey(entityType, entityId);

    await this.db
      .insert(routeProtectionCodes)
      .values({
        entityType,
        entityId,
        code,
      })
      .onConflictDoUpdate({
        target: [routeProtectionCodes.entityType, routeProtectionCodes.entityId],
        set: {
          code,
          updatedAt: sql`now()`,
        },
      });

    await this.cacheService.set(cacheKey, code, ROUTE_CODE_CACHE_TTL_MS);
    return code;
  }

  private async ensurePersistedCode(
    entityType: RouteEntityType,
    entityId: number,
    code: string,
  ): Promise<void> {
    if (!this.isValidCode(code)) {
      return;
    }

    await this.insertPersistedCode(entityType, entityId, code);
  }

  private async readPersistedCode(
    entityType: RouteEntityType,
    entityId: number,
  ): Promise<string | null> {
    const [row] = await this.db
      .select({ code: routeProtectionCodes.code })
      .from(routeProtectionCodes)
      .where(
        and(
          eq(routeProtectionCodes.entityType, entityType),
          eq(routeProtectionCodes.entityId, entityId),
        ),
      )
      .limit(1);

    return row?.code ?? null;
  }

  private async insertPersistedCode(
    entityType: RouteEntityType,
    entityId: number,
    code: string,
  ): Promise<string> {
    const result = await this.db.execute(sql`
      insert into route_protection_codes (entity_type, entity_id, code)
      values (${entityType}, ${entityId}, ${code})
      on conflict (entity_type, entity_id) do update
        set code = route_protection_codes.code
      returning code as "code"
    `);

    const [row] = Array.isArray(result)
      ? result
      : ((result as { rows?: Array<{ code?: string }> }).rows ?? []);
    if (this.isValidCode(row?.code)) {
      return row.code;
    }

    const existing = await this.readPersistedCode(entityType, entityId);
    if (this.isValidCode(existing)) {
      return existing;
    }

    return code;
  }

  private isValidCode(value: string | null | undefined): value is string {
    return typeof value === 'string' && /^\d{6}$/.test(value);
  }

  private generateCode(): string {
    return randomInt(100000, 1000000).toString();
  }

  private getCacheKey(entityType: RouteEntityType, entityId: number): string {
    return `route:${entityType}:${entityId}`;
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
