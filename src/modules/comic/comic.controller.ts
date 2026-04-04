import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  ParseIntPipe,
  UseGuards,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags, ApiQuery, ApiResponse } from '@nestjs/swagger';
import { ComicService, ComicFilters } from './comic.service';
import { AuthGuard } from '@/modules/auth/auth.guard';
import { AdminGuard } from '@/modules/auth/admin.guard';
import { RouteProtectionService } from '@/modules/route-protection/route-protection.service';
import type { FastifyRequest } from 'fastify';

@ApiTags('Comics')
@Controller('comics')
export class ComicController {
  constructor(
    private comicService: ComicService,
    private routeProtectionService: RouteProtectionService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Get all comics with filters' })
  @ApiQuery({ name: 'search', required: false })
  @ApiQuery({ name: 'type', required: false, enum: ['manga', 'manhwa', 'manhua'] })
  @ApiQuery({ name: 'status', required: false, enum: ['ongoing', 'completed', 'hiatus', 'cancelled'] })
  @ApiQuery({ name: 'genres', required: false, description: 'Comma-separated genre names' })
  @ApiQuery({ name: 'nsfw', required: false, type: Boolean })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'orderBy', required: false, enum: ['recent_chapter', 'created_at', 'views', 'updated_at'] })
  @ApiQuery({ name: 'isDesc', required: false, type: Boolean })
  async findAll(
    @Query('search') search?: string,
    @Query('type') type?: 'manga' | 'manhwa' | 'manhua',
    @Query('status') status?: 'ongoing' | 'completed' | 'hiatus' | 'cancelled',
    @Query('genres') genres?: string,
    @Query('nsfw') nsfw?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('orderBy') orderBy?: string,
    @Query('isDesc') isDesc?: string,
  ) {
    const filters: ComicFilters = {
      search,
      type,
      status,
      genreNames: genres ? genres.split(',').map(g => g.trim()).filter(Boolean) : undefined,
      isNsfw: nsfw === 'false' ? false : nsfw === 'true' ? true : undefined,
      page: page ? parseInt(page, 10) : 1,
      limit: limit ? parseInt(limit, 10) : 20,
      orderBy: (orderBy as ComicFilters['orderBy']) || 'recent_chapter',
      isDesc: isDesc !== 'false',
    };

    return this.comicService.findAll(filters);
  }

  @Get('trending')
  @ApiOperation({ summary: 'Get trending comics' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'nsfw', required: false, type: Boolean, description: 'Filter NSFW content' })
  async getTrending(
    @Query('limit') limit?: string,
    @Query('nsfw') nsfw?: string,
  ) {
    const isNsfw = nsfw === 'false' ? false : nsfw === 'true' ? true : undefined;
    return this.comicService.getTrending(limit ? parseInt(limit, 10) : 10, isNsfw);
  }

  @Get('recent')
  @ApiOperation({ summary: 'Get recently updated comics' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'nsfw', required: false, type: Boolean, description: 'Filter NSFW content' })
  async getRecent(
    @Query('limit') limit?: string,
    @Query('nsfw') nsfw?: string,
  ) {
    const isNsfw = nsfw === 'false' ? false : nsfw === 'true' ? true : undefined;
    return this.comicService.getRecent(limit ? parseInt(limit, 10) : 10, isNsfw);
  }

  @Get('recent-chapters')
  @ApiOperation({ summary: 'Get comics with recent chapters for home page' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'nsfw', required: false, type: Boolean, description: 'Filter NSFW content' })
  async getRecentWithChapters(
    @Query('limit') limit?: string,
    @Query('nsfw') nsfw?: string,
  ) {
    const isNsfw = nsfw === 'false' ? false : nsfw === 'true' ? true : undefined;
    return this.comicService.getRecentWithChapters(limit ? parseInt(limit, 10) : 20, isNsfw);
  }

  @Get('genres')
  @ApiOperation({ summary: 'Get all genres' })
  @ApiQuery({ name: 'nsfw', required: false, type: Boolean, description: 'Include adult genres' })
  async getGenres(
    @Query('nsfw') nsfw?: string,
  ) {
    const includeAdult = nsfw === 'true';
    return this.comicService.getAllGenres(includeAdult);
  }

  @Get('popular')
  @ApiOperation({ summary: 'Get popular comics' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'nsfw', required: false, type: Boolean, description: 'Filter NSFW content' })
  async getPopular(
    @Query('limit') limit?: string,
    @Query('nsfw') nsfw?: string,
  ) {
    const isNsfw = nsfw === 'false' ? false : nsfw === 'true' ? true : undefined;
    return this.comicService.getPopular(limit ? parseInt(limit, 10) : 10, isNsfw);
  }

  @Get('popular-today')
  @ApiOperation({ summary: 'Get most viewed comics for today' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'nsfw', required: false, type: Boolean, description: 'Filter NSFW content' })
  async getPopularToday(
    @Query('limit') limit?: string,
    @Query('nsfw') nsfw?: string,
  ) {
    const isNsfw = nsfw === 'false' ? false : nsfw === 'true' ? true : undefined;
    return this.comicService.getPopularToday(limit ? parseInt(limit, 10) : 10, isNsfw);
  }

  @Get(['id/:id/recommendations', ':id(\\d+)/recommendations'])
  @ApiOperation({ summary: 'Get comic recommendations based on genres' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'nsfw', required: false, type: Boolean, description: 'Filter NSFW content' })
  async getRecommendations(
    @Param('id', ParseIntPipe) id: number,
    @Query('limit') limit?: string,
    @Query('nsfw') nsfw?: string,
  ) {
    const isNsfw = nsfw === 'false' ? false : nsfw === 'true' ? true : undefined;
    return this.comicService.getRecommendations(id, limit ? parseInt(limit, 10) : 10, isNsfw);
  }

  @Get('lookup/route/:segment')
  @ApiOperation({ summary: 'Resolve comic path without incrementing views' })
  async lookupByRouteSegment(@Param('segment') segment: string) {
    return this.comicService.findLookupByRouteSegment(
      decodeURIComponent(segment),
    );
  }

  @Get('lookup/id/:id')
  @ApiOperation({ summary: 'Resolve comic path by id without incrementing views' })
  async lookupById(
    @Param('id', ParseIntPipe) id: number,
    @Req() request: FastifyRequest,
  ) {
    const comic = await this.comicService.findLookupById(id);
    await this.routeProtectionService.assertLegacyAccess(comic, request.headers);
    return comic;
  }

  @Get('route/:segment')
  @ApiOperation({ summary: 'Get comic by protected route segment' })
  async findByRouteSegment(@Param('segment') segment: string) {
    const comic = await this.comicService.findPublicByRouteSegment(decodeURIComponent(segment));
    await this.comicService.incrementViews(comic.id);
    return comic;
  }

  @Get(['id/:id', ':id(\\d+)'])
  @ApiOperation({ summary: 'Get comic by ID' })
  async findById(
    @Param('id', ParseIntPipe) id: number,
    @Req() request: FastifyRequest,
  ) {
    const comic = await this.comicService.findById(id);
    await this.routeProtectionService.assertLegacyAccess(comic, request.headers);
    await this.comicService.incrementViews(id);
    return comic;
  }

  @Get('slug/:slug')
  @ApiOperation({ summary: 'Get comic by slug' })
  async findBySlug(
    @Param('slug') slug: string,
    @Req() request: FastifyRequest,
  ) {
    const comic = await this.comicService.findBySlug(slug);
    await this.routeProtectionService.assertLegacyAccess(comic, request.headers);
    await this.comicService.incrementViews(comic.id);
    return comic;
  }

  @Post('admin/clear-cache')
  @UseGuards(AuthGuard, AdminGuard)
  @ApiOperation({ summary: 'Clear all comic-related caches' })
  @ApiResponse({ status: 200, description: 'Cache cleared successfully' })
  async clearCache() {
    return this.comicService.clearComicCache();
  }

  @Get('sitemap/stats')
  @ApiOperation({ summary: 'Get sitemap statistics (total counts)' })
  async getSitemapStats() {
    return this.comicService.getSitemapStats();
  }

  @Get('sitemap/comics')
  @ApiOperation({ summary: 'Get comics for sitemap (optimized, paginated)' })
  @ApiQuery({ name: 'page', required: false, type: Number, description: 'Page number (default: 1)' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Items per page (default: 1000, max: 5000)' })
  async getSitemapComics(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const pageNum = page ? parseInt(page, 10) : 1;
    const limitNum = Math.min(limit ? parseInt(limit, 10) : 1000, 5000);
    return this.comicService.getSitemapComics(pageNum, limitNum);
  }

  @Get('sitemap/chapters')
  @ApiOperation({ summary: 'Get chapters for sitemap (optimized, paginated)' })
  @ApiQuery({ name: 'page', required: false, type: Number, description: 'Page number (default: 1)' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Items per page (default: 5000, max: 10000)' })
  async getSitemapChapters(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const pageNum = page ? parseInt(page, 10) : 1;
    const limitNum = Math.min(limit ? parseInt(limit, 10) : 5000, 10000);
    return this.comicService.getSitemapChapters(pageNum, limitNum);
  }
}
