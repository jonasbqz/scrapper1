import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { DatabaseModule } from './database/database.module';
import { RedisCacheModule } from './cache/cache.module';
import { AuthModule } from './modules/auth/auth.module';
import { ProfileModule } from './modules/profile/profile.module';
import { ComicModule } from './modules/comic/comic.module';
import { ChapterModule } from './modules/chapter/chapter.module';
import { BookmarkModule } from './modules/bookmark/bookmark.module';
import { ReadingHistoryModule } from './modules/reading-history/reading-history.module';
import { ScraperModule } from './modules/scraper/scraper.module';
import { LikesModule } from './modules/likes/likes.module';
import { ChapterLikesModule } from './modules/chapter-likes/chapter-likes.module';
import { CommentsModule } from './modules/comments/comments.module';
import { PlaylistsModule } from './modules/playlists/playlists.module';
import { DownloadsModule } from './modules/downloads/downloads.module';
import { PaymentModule } from './modules/payment/payment.module';
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    ScheduleModule.forRoot(),
    DatabaseModule,
    RedisCacheModule,
    AuthModule,
    ProfileModule,
    ComicModule,
    ChapterModule,
    BookmarkModule,
    ReadingHistoryModule,
    ScraperModule,
    LikesModule,
    ChapterLikesModule,
    CommentsModule,
    PlaylistsModule,
    DownloadsModule,
    PaymentModule,
  ],
})
export class AppModule {}
