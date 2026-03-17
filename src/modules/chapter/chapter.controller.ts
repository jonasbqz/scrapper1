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
  UnauthorizedException,
} from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { ChapterService } from './chapter.service';
import { ComicService } from '../comic/comic.service';
import { DATABASE_CONNECTION } from '@/database/database.module';
import { auth } from '@/lib/auth';
import { eq } from 'drizzle-orm';
import { profiles } from '@/database/schema';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '@/database/schema';
import type { FastifyRequest } from 'fastify';
import { Req } from '@nestjs/common';

/** Allowed count values for the bulk next-chapters endpoint */
const ALLOWED_COUNTS = [5, 10, 25, 50] as const;
type AllowedCount = (typeof ALLOWED_COUNTS)[number];

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
  ) {}

  @Get(':id')
  @ApiOperation({ summary: 'Get chapter by ID with navigation' })
  async findById(@Param('id', ParseIntPipe) id: number) {
    await this.chapterService.incrementViews(id);
    const nav = await this.chapterService.getNavigation(id);

    const chapter = nav.current;
    const comic = chapter.comicScan?.comic;

    let recommendations: any[] = [];
    if (comic?.id) {
      try {
        recommendations = await this.comicService.getRecommendations(comic.id, 10);
      } catch (e) {
        // Ignore errors, just return empty recommendations
      }
    }

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
        prev_chapter_id: nav.prev?.id || null,
        next_chapter_id: nav.next?.id || null,
        comic_title: comic?.title || '',
        comic_id: comic?.id || null,
        comic_cover: comic?.coverImage || '',
        copyrighted: chapter.copyrighted || false,
        is_nsfw: comic?.isNsfw || false,
        recommendations: recommendations.map(rec => ({
          id: rec.id,
          name: rec.title,
          state: rec.status?.toUpperCase() || 'ONGOING',
          type: rec.type?.toUpperCase() || 'COMIC',
          urlCover: rec.coverImage,
          url_cover: rec.coverImage,
          slug: rec.slug,
          languageName: 'SPANISH',
          views: rec.views || 0,
        })),
      }
    };
  }

  @Get(':id/pages')
  @ApiOperation({ summary: 'Get chapter pages' })
  async getPages(@Param('id', ParseIntPipe) id: number) {
    const nav = await this.chapterService.getNavigation(id);
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
  ) {
    // --- Validate count value ---
    if (!(ALLOWED_COUNTS as readonly number[]).includes(count)) {
      throw new BadRequestException(
        `Invalid count. Allowed values: ${ALLOWED_COUNTS.join(', ')}`,
      );
    }

    // --- Premium counts require authentication + active premium plan ---
    if ((PREMIUM_COUNTS as number[]).includes(count)) {
      // Resolve session directly via better-auth (supports both cookie & Bearer token)
      const session = await auth.api.getSession({
        headers: request.headers as any,
      }).catch(() => null);

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

      const isPremiumActive =
        profile?.plan === 'premium' &&
        (profile.premiumExpireAt === null ||
          profile.premiumExpireAt > new Date());

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
  async findByComicScan(@Param('comicScanId', ParseIntPipe) comicScanId: number) {
    return this.chapterService.findByComicScan(comicScanId);
  }
}
