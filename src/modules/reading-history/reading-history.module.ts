import { Module } from '@nestjs/common';
import { ReadingHistoryController } from './reading-history.controller';
import { ReadingHistoryService } from './reading-history.service';
import { AuthModule } from '@/modules/auth/auth.module';
import { RouteProtectionModule } from '@/modules/route-protection/route-protection.module';

@Module({
  imports: [AuthModule, RouteProtectionModule],
  controllers: [ReadingHistoryController],
  providers: [ReadingHistoryService],
  exports: [ReadingHistoryService],
})
export class ReadingHistoryModule {}
