import {
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ComicService } from './comic.service';
import { RouteProtectionService } from '@/modules/route-protection/route-protection.service';
import type { FastifyRequest } from 'fastify';

@ApiTags('Comic Scans')
@Controller('datah/comic-scans')
export class ComicScanController {
  constructor(
    private comicService: ComicService,
    private routeProtectionService: RouteProtectionService,
  ) {}

  @Get(':id')
  @ApiOperation({ summary: 'Get comic scan by ID with chapters' })
  async findById(
    @Param('id', ParseIntPipe) id: number,
    @Req() request: FastifyRequest,
  ) {
    const comicScan = await this.comicService.getComicScanById(id);
    await this.routeProtectionService.assertLegacyAccess(comicScan.comic, request.headers);
    return { data: comicScan };
  }
}
