import { Controller, Get, NotFoundException, Param, ParseIntPipe } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ChapterService } from './chapter.service';
import { ComicService } from '../comic/comic.service';

@ApiTags('Chapters')
@Controller('chapters')
export class ChapterController {
  constructor(
    private chapterService: ChapterService,
    private comicService: ComicService,
  ) {}

  @Get(':id')
  @ApiOperation({ summary: 'Get chapter by ID with navigation' })
  async findById(@Param('id', ParseIntPipe) id: number) {
    await this.chapterService.incrementViews(id);
    const nav = await this.chapterService.getNavigation(id);

    // Map to frontend expected format
    const chapter = nav.current;
    const comic = chapter.comicScan?.comic;

    // Get recommendations based on comic's genres
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
    }
  }

  @Get('comic-scan/:comicScanId')
  @ApiOperation({ summary: 'Get all chapters by comic scan' })
  async findByComicScan(@Param('comicScanId', ParseIntPipe) comicScanId: number) {
    return this.chapterService.findByComicScan(comicScanId);
  }
}
