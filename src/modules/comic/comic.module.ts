import { Module } from '@nestjs/common';
import { ComicController } from './comic.controller';
import { ComicScanController } from './comic-scan.controller';
import { ComicService } from './comic.service';
import { RouteProtectionModule } from '../route-protection/route-protection.module';

@Module({
  imports: [RouteProtectionModule],
  controllers: [ComicController, ComicScanController],
  providers: [ComicService],
  exports: [ComicService],
})
export class ComicModule {}
