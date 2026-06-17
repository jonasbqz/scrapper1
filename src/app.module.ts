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
import { NotificationsModule } from './modules/notifications/notifications.module';
import { LikesModule } from './modules/likes/likes.module';
import { ChapterLikesModule } from './modules/chapter-likes/chapter-likes.module';
import { CommentsModule } from './modules/comments/comments.module';
import { PlaylistsModule } from './modules/playlists/playlists.module';
import { DownloadsModule } from './modules/downloads/downloads.module';
import { PaymentModule } from './modules/payment/payment.module';
import { EngagementModule } from './modules/engagement/engagement.module';
import { JwtDownloadModule } from './modules/jwt-download/jwt-download.module';
import { SubscriptionsModule } from './modules/subscriptions/subscriptions.module';
import { RouteProtectionModule } from './modules/route-protection/route-protection.module';
import { EntityReactionsModule } from './modules/entity-reactions/entity-reactions.module';
import { MediaModule } from './modules/media/media.module';
import { TrafficEventsModule } from './modules/traffic/traffic-events.module';
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
    NotificationsModule,
    LikesModule,
    ChapterLikesModule,
    CommentsModule,
    PlaylistsModule,
    DownloadsModule,
    PaymentModule,
    EngagementModule,
    JwtDownloadModule,
    SubscriptionsModule,
    RouteProtectionModule,
    EntityReactionsModule,
    MediaModule,
    TrafficEventsModule,
  ],
})
export class AppModule {}
