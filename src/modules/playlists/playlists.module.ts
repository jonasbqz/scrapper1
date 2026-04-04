import { Module } from '@nestjs/common';
import { PlaylistsController } from './playlists.controller';
import { PlaylistsService } from './playlists.service';
import { AuthModule } from '@/modules/auth/auth.module';
import { RouteProtectionModule } from '@/modules/route-protection/route-protection.module';

@Module({
  imports: [AuthModule, RouteProtectionModule],
  controllers: [PlaylistsController],
  providers: [PlaylistsService],
  exports: [PlaylistsService],
})
export class PlaylistsModule {}
