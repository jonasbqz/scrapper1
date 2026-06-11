import { Module } from '@nestjs/common';
import { DatabaseModule } from '@/database/database.module';
import { RouteProtectionService } from './route-protection.service';

@Module({
  imports: [DatabaseModule],
  providers: [RouteProtectionService],
  exports: [RouteProtectionService],
})
export class RouteProtectionModule {}
