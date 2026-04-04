import {
  Controller,
  Get,
  Param,
  Res,
  UseGuards,
  ParseIntPipe,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags, ApiProduces } from '@nestjs/swagger';
import { FastifyReply } from 'fastify';
import { AuthGuard } from '@/modules/auth/auth.guard';
import { ProfileGuard } from '@/modules/auth/profile.guard';
import { VerifiedEmailGuard } from '@/modules/auth/verified-email.guard';
import { DownloadsService } from './downloads.service';

@ApiTags('Downloads')
@Controller('downloads')
export class DownloadsController {
  constructor(private downloadsService: DownloadsService) {}

  @Get('chapter/:chapterId/pdf')
  @UseGuards(AuthGuard, ProfileGuard, VerifiedEmailGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Download a chapter as PDF' })
  @ApiProduces('application/pdf')
  async downloadChapterPdf(
    @Param('chapterId', ParseIntPipe) chapterId: number,
    @Res() reply: FastifyReply,
  ) {
    const { stream, filename } = await this.downloadsService.generateChapterPdf(chapterId);

    reply
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', `attachment; filename="${filename}"`)
      .send(stream);
  }
}
