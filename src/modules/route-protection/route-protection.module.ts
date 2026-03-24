import { Module } from '@nestjs/common';
import { RouteProtectionService } from './route-protection.service';

@Module({
  providers: [RouteProtectionService],
  exports: [RouteProtectionService],
})
export class RouteProtectionModule {}
