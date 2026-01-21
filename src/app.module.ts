import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { DatabaseModule } from './database/database.module';
import { AuthModule } from './modules/auth/auth.module';
import { ProfileModule } from './modules/profile/profile.module';
import { ComicModule } from './modules/comic/comic.module';
import { ChapterModule } from './modules/chapter/chapter.module';
import { BookmarkModule } from './modules/bookmark/bookmark.module';
import { ReadingHistoryModule } from './modules/reading-history/reading-history.module';
import { ScraperModule } from './modules/scraper/scraper.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    ScheduleModule.forRoot(),
    DatabaseModule,
    AuthModule,
    ProfileModule,
    ComicModule,
    ChapterModule,
    BookmarkModule,
    ReadingHistoryModule,
    ScraperModule,
  ],
})
export class AppModule {}
