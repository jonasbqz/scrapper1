import { Module } from '@nestjs/common';
import { ComicController } from './comic.controller';
import { ComicScanController } from './comic-scan.controller';
import { ComicService } from './comic.service';
import { SearchAbuseService } from './search-abuse.service';
import { RouteProtectionModule } from '../route-protection/route-protection.module';
import { TrafficEventsModule } from '../traffic/traffic-events.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [RouteProtectionModule, TrafficEventsModule, AuthModule],
  controllers: [ComicController, ComicScanController],
  providers: [ComicService, SearchAbuseService],
  exports: [ComicService],
})
export class ComicModule {}
