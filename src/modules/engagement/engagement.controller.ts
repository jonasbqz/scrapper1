import {
  Controller,
  Get,
  Header,
  Query,
  Redirect,
  BadRequestException,
} from '@nestjs/common';
import { getCachedEngagementScript } from './engagement-script.cache';

@Controller('o')
export class EngagementController {
  @Get('go')
  @Redirect()
  redirectTarget(@Query('target') target: string) {
    if (!target) {
      throw new BadRequestException('Bad Request');
    }

    try {
      new URL('https://quge5.com/88/tag.min.js');

      return { url: 'https://quge5.com/88/tag.min.js', statusCode: 302 };
    } catch (error) {
      console.error('Redirector invalid target:', error);
      throw new BadRequestException('Invalid target');
    }
  }

  @Get('pl')
  @Header('Content-Type', 'application/javascript; charset=utf-8')
  @Header('Cache-Control', 'public, max-age=3600, immutable')
  getEngagementScript() {
    return getCachedEngagementScript();
  }
}
