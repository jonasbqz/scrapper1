import { Module, forwardRef } from '@nestjs/common';
import { JwtDownloadModule } from '../jwt-download/jwt-download.module';
import { ChapterController } from './chapter.controller';
import { ChapterService } from './chapter.service';
import { ComicModule } from '../comic/comic.module';
import { RouteProtectionModule } from '../route-protection/route-protection.module';

@Module({
  imports: [forwardRef(() => ComicModule), JwtDownloadModule, RouteProtectionModule],
  controllers: [ChapterController],
  providers: [ChapterService],
  exports: [ChapterService],
})
export class ChapterModule {}
