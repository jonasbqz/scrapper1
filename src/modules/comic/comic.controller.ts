import {
  Controller,
  Get,
  Param,
  Query,
  ParseIntPipe,
} from '@nestjs/common';
import { ApiOperation, ApiTags, ApiQuery } from '@nestjs/swagger';
import { ComicService, ComicFilters } from './comic.service';

@ApiTags('Comics')
@Controller('comics')
export class ComicController {
  constructor(private comicService: ComicService) {}

  @Get()
  @ApiOperation({ summary: 'Get all comics with filters' })
  @ApiQuery({ name: 'search', required: false })
  @ApiQuery({ name: 'type', required: false, enum: ['manga', 'manhwa', 'manhua'] })
  @ApiQuery({ name: 'status', required: false, enum: ['ongoing', 'completed', 'hiatus', 'cancelled'] })
  @ApiQuery({ name: 'genres', required: false, description: 'Comma-separated genre IDs' })
  @ApiQuery({ name: 'nsfw', required: false, type: Boolean })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async findAll(
    @Query('search') search?: string,
    @Query('type') type?: 'manga' | 'manhwa' | 'manhua',
    @Query('status') status?: 'ongoing' | 'completed' | 'hiatus' | 'cancelled',
    @Query('genres') genres?: string,
    @Query('nsfw') nsfw?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const filters: ComicFilters = {
      search,
      type,
      status,
      genreIds: genres ? genres.split(',').map(Number) : undefined,
      isNsfw: nsfw ? nsfw === 'true' : undefined,
      page: page ? parseInt(page, 10) : 1,
      limit: limit ? parseInt(limit, 10) : 20,
    };

    return this.comicService.findAll(filters);
  }

  @Get('trending')
  @ApiOperation({ summary: 'Get trending comics' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async getTrending(@Query('limit') limit?: string) {
    return this.comicService.getTrending(limit ? parseInt(limit, 10) : 10);
  }

  @Get('recent')
  @ApiOperation({ summary: 'Get recently updated comics' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async getRecent(@Query('limit') limit?: string) {
    return this.comicService.getRecent(limit ? parseInt(limit, 10) : 10);
  }

  @Get('genres')
  @ApiOperation({ summary: 'Get all genres' })
  async getGenres() {
    return this.comicService.getAllGenres();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get comic by ID' })
  async findById(@Param('id', ParseIntPipe) id: number) {
    await this.comicService.incrementViews(id);
    return this.comicService.findById(id);
  }

  @Get('slug/:slug')
  @ApiOperation({ summary: 'Get comic by slug' })
  async findBySlug(@Param('slug') slug: string) {
    const comic = await this.comicService.findBySlug(slug);
    await this.comicService.incrementViews(comic.id);
    return comic;
  }
}
