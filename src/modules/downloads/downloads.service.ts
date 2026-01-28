import { Injectable, Inject, NotFoundException, BadRequestException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DATABASE_CONNECTION } from '@/database/database.module';
import { chapters } from '@/database/schema';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '@/database/schema';
import PDFDocument from 'pdfkit';
import axios from 'axios';
import { PassThrough } from 'stream';

@Injectable()
export class DownloadsService {
  constructor(
    @Inject(DATABASE_CONNECTION)
    private db: NodePgDatabase<typeof schema>,
  ) {}

  async generateChapterPdf(chapterId: number): Promise<{ stream: PassThrough; filename: string }> {
    // Get chapter with comic info
    const chapter = await this.db.query.chapters.findFirst({
      where: eq(chapters.id, chapterId),
      with: {
        comicScan: {
          with: {
            comic: {
              columns: {
                id: true,
                title: true,
                slug: true,
              },
            },
          },
        },
      },
    });

    if (!chapter) {
      throw new NotFoundException('Chapter not found');
    }

    if (chapter.copyrighted) {
      throw new BadRequestException('This chapter is copyrighted and cannot be downloaded');
    }

    const pages = chapter.urlPages || [];
    if (pages.length === 0) {
      throw new BadRequestException('This chapter has no pages');
    }

    const comicTitle = chapter.comicScan?.comic?.title || 'Comic';
    const chapterNum = chapter.chapterNumber;
    const filename = `${this.sanitizeFilename(comicTitle)}_Cap_${chapterNum}.pdf`;

    // Create PDF document
    const doc = new PDFDocument({
      autoFirstPage: false,
      bufferPages: true,
    });

    const passThrough = new PassThrough();
    doc.pipe(passThrough);

    // Download and add each image to PDF
    for (let i = 0; i < pages.length; i++) {
      const pageUrl = pages[i];
      try {
        const imageBuffer = await this.downloadImage(pageUrl);

        // Get image dimensions (estimate based on buffer size, or use default)
        // For simplicity, we'll use a standard page size
        doc.addPage({
          size: [595.28, 841.89], // A4 size in points
          margin: 0,
        });

        // Fit image to page
        doc.image(imageBuffer, 0, 0, {
          fit: [595.28, 841.89],
          align: 'center',
          valign: 'center',
        });
      } catch (error) {
        console.error(`Failed to download image ${i + 1}: ${pageUrl}`, error);
        // Continue with other pages if one fails
      }
    }

    // Finalize PDF
    doc.end();

    return { stream: passThrough, filename };
  }

  private async downloadImage(url: string): Promise<Buffer> {
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 30000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': url,
      },
    });
    return Buffer.from(response.data);
  }

  private sanitizeFilename(name: string): string {
    return name
      .replace(/[<>:"/\\|?*]/g, '')
      .replace(/\s+/g, '_')
      .substring(0, 100);
  }
}
