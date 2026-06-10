import { Module } from '@nestjs/common';
import { AuthModule } from '@/modules/auth/auth.module';
import { RouteProtectionModule } from '@/modules/route-protection/route-protection.module';
import { TrafficEventsController } from './traffic-events.controller';
import { TrafficEventsService } from './traffic-events.service';

@Module({
  imports: [AuthModule, RouteProtectionModule],
  controllers: [TrafficEventsController],
  providers: [TrafficEventsService],
  exports: [TrafficEventsService],
})
export class TrafficEventsModule {}
