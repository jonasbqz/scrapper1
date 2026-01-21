import { Module } from '@nestjs/common';
import { ComicController } from './comic.controller';
import { ComicService } from './comic.service';

@Module({
  controllers: [ComicController],
  providers: [ComicService],
  exports: [ComicService],
})
export class ComicModule {}
