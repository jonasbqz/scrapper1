import { Module } from '@nestjs/common';
import { BookmarkController } from './bookmark.controller';
import { BookmarkService } from './bookmark.service';
import { AuthModule } from '@/modules/auth/auth.module';
import { RouteProtectionModule } from '@/modules/route-protection/route-protection.module';

@Module({
  imports: [AuthModule, RouteProtectionModule],
  controllers: [BookmarkController],
  providers: [BookmarkService],
  exports: [BookmarkService],
})
export class BookmarkModule {}
