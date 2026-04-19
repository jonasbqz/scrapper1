import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  NotFoundException,
  Param,
  ParseIntPipe,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { ChapterService } from './chapter.service';
import { ComicService } from '../comic/comic.service';
import { DATABASE_CONNECTION } from '@/database/database.module';
import { auth } from '@/lib/auth';
import { eq } from 'drizzle-orm';
import { profiles, session as authSession } from '@/database/schema';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '@/database/schema';
import type { FastifyRequest } from 'fastify';
import { JwtDownloadService } from '../jwt-download/jwt-download.service';
import { RouteProtectionService } from '../route-protection/route-protection.service';

/** Allowed count values for the bulk next-chapters endpoint */
const ALLOWED_COUNTS = [5, 10, 25, 50] as const;
type AllowedCount = (typeof ALLOWED_COUNTS)[number];
const MAX_LOOKUP_BATCH_IDS = 50;

/** Counts that require a valid premium subscription */
const PREMIUM_COUNTS: AllowedCount[] = [25, 50];

@ApiTags('Chapters')
@Controller('chapters')
export class ChapterController {
  constructor(
    private chapterService: ChapterService,
    private comicService: ComicService,
    @Inject(DATABASE_CONNECTION)
    private db: NodePgDatabase<typeof schema>,
    private jwtDownloadService: JwtDownloadService,
    private routeProtectionService: RouteProtectionService,
  ) {}

  private parseBatchIds(ids?: string): number[] {
    if (!ids) {
      return [];
    }

    return Array.from(
      new Set(
        ids
          .split(',')
          .map((value) => Number.parseInt(value.trim(), 10))
          .filter((value) => Number.isInteger(value) && value > 0),
      ),
    ).slice(0, MAX_LOOKUP_BATCH_IDS);
  }

  private async buildChapterResponse(navigation: Awaited<ReturnType<ChapterService['getNavigation']>>) {
    const chapter = navigation.current;
    const comic = chapter.comicScan?.comic;

    let recommendations: any[] = [];
    if (comic?.id) {
      try {
        recommendations = await this.comicService.getRecommendations(comic.id, 10);
      } catch {
        recommendations = [];
      }
    }

    const comicPath = comic
      ? await this.routeProtectionService.getComicPath(comic)
      : null;

    const chapterPath = comic
      ? await this.routeProtectionService.getChapterPath(comic, chapter, {
          comicPath: comicPath || undefined,
        })
      : null;

    const prevChapterPath =
      comic && navigation.prev
        ? await this.routeProtectionService.getChapterPath(comic, navigation.prev, {
            comicPath: comicPath || undefined,
          })
        : null;

    const nextChapterPath =
      comic && navigation.next
        ? await this.routeProtectionService.getChapterPath(comic, navigation.next, {
            comicPath: comicPath || undefined,
          })
        : null;

    return {
      data: {
        id: chapter.id,
        chapter_number: String(chapter.chapterNumber),
        title: chapter.title,
        created_at: chapter.createdAt?.toISOString() || '',
        release_date: chapter.releaseDate?.toISOString() || '',
        url_pages: chapter.urlPages || [],
        url_origin: '',
        pathname: chapter.slug || '',
        views: chapter.views || 0,
        likes: 0,
        prev_chapter_id: navigation.prev?.id || null,
        next_chapter_id: navigation.next?.id || null,
        prev_chapter_path: prevChapterPath,
        next_chapter_path: nextChapterPath,
        chapter_path: chapterPath,
        comic_title: comic?.title || '',
        comic_id: comic?.id || null,
        comic_slug: comic?.slug || '',
        comic_cover: comic?.coverImage || '',
        comic_path: comicPath,
        copyrighted: chapter.copyrighted || false,
        is_nsfw: comic?.isNsfw || false,
        protected_route_enabled: comic?.protectedRouteEnabled || false,
        recommendations: recommendations.map((rec) => ({
          id: rec.id,
          name: rec.title,
          state: rec.status?.toUpperCase() || 'ONGOING',
          type: rec.type?.toUpperCase() || 'COMIC',
          urlCover: rec.coverImage,
          url_cover: rec.coverImage,
          slug: rec.slug,
          comicPath: rec.comicPath,
          languageName: 'SPANISH',
          views: rec.views || 0,
        })),
      },
    };
  }

  private async buildChapterLookupResponse(
    navigation: Awaited<ReturnType<ChapterService['getNavigation']>>,
  ) {
    const chapter = navigation.current;
    const comic = chapter.comicScan?.comic;

    const comicPath = comic
      ? await this.routeProtectionService.getComicPath(comic)
      : null;

    const chapterPath = comic
      ? await this.routeProtectionService.getChapterPath(comic, chapter, {
          comicPath: comicPath || undefined,
        })
      : null;

    return {
      data: {
        id: chapter.id,
        comic_id: comic?.id || null,
        comic_slug: comic?.slug || '',
        protected_route_enabled: comic?.protectedRouteEnabled || false,
        comic_path: comicPath,
        chapter_path: chapterPath,
      },
    };
  }

  @Get('lookup/route/:comicSegment/:chapterSegment')
  @ApiOperation({ summary: 'Resolve chapter path without incrementing views' })
  async lookupByRoute(
    @Param('comicSegment') comicSegment: string,
    @Param('chapterSegment') chapterSegment: string,
  ) {
    const resolved = await this.chapterService.findPublicByRouteSegments(
      decodeURIComponent(comicSegment),
      decodeURIComponent(chapterSegment),
    );

    return this.buildChapterLookupResponse(resolved.navigation);
  }

  @Get('lookup/id/:id')
  @ApiOperation({ summary: 'Resolve chapter path by id without incrementing views' })
  async lookupById(
    @Param('id', ParseIntPipe) id: number,
    @Req() request: FastifyRequest,
  ) {
    const nav = await this.chapterService.getNavigation(id);
    await this.routeProtectionService.assertLegacyAccess(
      nav.current.comicScan?.comic,
      request.headers,
    );
    return this.buildChapterLookupResponse(nav);
  }

  @Get('lookup/batch')
  @ApiOperation({ summary: 'Resolve chapter paths by ids without incrementing views' })
  @ApiQuery({
    name: 'ids',
    required: true,
    description: 'Comma-separated chapter ids',
  })
  async lookupBatch(
    @Query('ids') ids: string,
    @Req() request: FastifyRequest,
  ) {
    const chapterIds = this.parseBatchIds(ids);

    const results = [];
    for (const id of chapterIds) {
        try {
          const navigation = await this.chapterService.getNavigation(id);
          await this.routeProtectionService.assertLegacyAccess(
            navigation.current.comicScan?.comic,
            request.headers,
          );
          const payload = await this.buildChapterLookupResponse(navigation);
          results.push(payload.data);
        } catch {
          // Skip chapters that no longer exist or are not visible for this request.
        }
    }

    return {
      data: results,
    };
  }

  @Get('route/:comicSegment/:chapterSegment')
  @ApiOperation({ summary: 'Get chapter by protected route with navigation' })
  async findByRoute(
    @Param('comicSegment') comicSegment: string,
    @Param('chapterSegment') chapterSegment: string,
  ) {
    const resolved = await this.chapterService.findPublicByRouteSegments(
      decodeURIComponent(comicSegment),
      decodeURIComponent(chapterSegment),
    );

    await this.chapterService.incrementViews(resolved.navigation.current.id);
    return this.buildChapterResponse(resolved.navigation);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get chapter by ID with navigation' })
  async findById(
    @Param('id', ParseIntPipe) id: number,
    @Req() request: FastifyRequest,
  ) {
    const nav = await this.chapterService.getNavigation(id);
    await this.routeProtectionService.assertLegacyAccess(
      nav.current.comicScan?.comic,
      request.headers,
    );
    await this.chapterService.incrementViews(id);
    return this.buildChapterResponse(nav);
  }

  @Get(':id/pages')
  @ApiOperation({ summary: 'Get chapter pages' })
  async getPages(
    @Param('id', ParseIntPipe) id: number,
    @Req() request: FastifyRequest,
  ) {
    const nav = await this.chapterService.getNavigation(id);
    await this.routeProtectionService.assertLegacyAccess(
      nav.current.comicScan?.comic,
      request.headers,
    );
    const chapter = await this.chapterService.getPages(id);
    if (!chapter) {
      throw new NotFoundException('Chapter not found');
    }
    if (chapter.copyrighted) {
      return { pages: [], copyrighted: true };
    }
    return {
      data: {
        id: chapter.id,
        chapter_number: String(chapter.chapterNumber),
        url_pages: chapter.urlPages || [],
        prev_chapter_id: nav.prev?.id || null,
        next_chapter_id: nav.next?.id || null,
      }
    };
  }

  @Get(':id/pages/next')
  @ApiOperation({
    summary: 'Get pages for multiple consecutive chapters (bulk prefetch)',
    description:
      'Returns up to `count` consecutive chapters starting from `:id`. ' +
      'Allowed values: 5, 10 (public) | 25, 50 (requires active premium subscription). ' +
      'For premium counts, send the better-auth session token as: Authorization: Bearer <token>',
  })
  @ApiQuery({
    name: 'count',
    enum: [5, 10, 25, 50],
    description: 'Number of chapters to fetch (5 | 10 | 25 | 50)',
  })
  async getNextPages(
    @Param('id', ParseIntPipe) id: number,
    @Query('count', ParseIntPipe) count: number,
    @Req() request: FastifyRequest,
    @Query('jwtToken') jwtToken?: string,
  ) {
    const nav = await this.chapterService.getNavigation(id);
    await this.routeProtectionService.assertLegacyAccess(
      nav.current.comicScan?.comic,
      request.headers,
    );

    // --- Validate count value ---
    if (!(ALLOWED_COUNTS as readonly number[]).includes(count)) {
      throw new BadRequestException(
        `Invalid count. Allowed values: ${ALLOWED_COUNTS.join(', ')}`,
      );
    }

    // --- Premium counts require authentication + active premium plan ---
    if ((PREMIUM_COUNTS as number[]).includes(count)) {
      let isPremiumActive = false;

      // 1. Try to verify via jwtToken query parameter (from mango-download proxy)
      if (jwtToken) {
        try {
          const payload = await this.jwtDownloadService.verifyToken(jwtToken);
          if (payload.isPremium) {
            isPremiumActive = true;
          }
        } catch (err) {
          // Token invalid or expired, fallback to session check
        }
      }

      // 2. Fallback to session check if JWT was invalid, absent, or not premium
      if (!isPremiumActive) {
        // Resolve session directly via better-auth (supports both cookie & Bearer token)
        let session = await auth.api.getSession({
          headers: request.headers as any,
        }).catch(() => null);

        // Fallback: Si better-auth falla debido a restricciones cross-domain o parseo de cabeceras en Fastify
        if (!session?.user) {
          const authHeader = request.headers.authorization;
          if (
            typeof authHeader === 'string' &&
            authHeader.toLowerCase().startsWith('bearer ')
          ) {
            const tokenStr = authHeader.substring(7).trim();
            const sessionRecord = await this.db.query.session.findFirst({
              where: eq(authSession.token, tokenStr),
            });
            if (sessionRecord && sessionRecord.userId) {
              session = { user: { id: sessionRecord.userId } } as any;
            }
          }
        }

        if (!session?.user) {
          throw new UnauthorizedException(
            'Authentication required to fetch 25 or 50 chapters at once.',
          );
        }

        // Look up the profile to check premium status
        const profile = await this.db.query.profiles.findFirst({
          where: eq(profiles.userId, session.user.id),
          columns: { plan: true, premiumExpireAt: true },
        });

        isPremiumActive =
          profile?.plan === 'premium' &&
          profile.premiumExpireAt !== null &&
          profile.premiumExpireAt > new Date();
      }

      if (!isPremiumActive) {
        throw new ForbiddenException(
          'An active premium subscription is required to fetch 25 or 50 chapters at once.',
        );
      }
    }

    const chapters = await this.chapterService.getNextChaptersPages(id, count);

    return { data: chapters };
  }

  @Get('comic-scan/:comicScanId')
  @ApiOperation({ summary: 'Get all chapters by comic scan' })
  async findByComicScan(
    @Param('comicScanId', ParseIntPipe) comicScanId: number,
    @Req() request: FastifyRequest,
  ) {
    const comicScan = await this.comicService.getComicScanById(comicScanId);
    await this.routeProtectionService.assertLegacyAccess(comicScan.comic, request.headers);
    return this.chapterService.findByComicScan(comicScanId);
  }
}
