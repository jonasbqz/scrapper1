import { Module } from '@nestjs/common';
import { ProfileController } from './profile.controller';
import { ProfileService } from './profile.service';
import { AuthModule } from '@/modules/auth/auth.module';
import { SubscriptionsModule } from '@/modules/subscriptions/subscriptions.module';
import { MediaModule } from '@/modules/media/media.module';

@Module({
  imports: [AuthModule, SubscriptionsModule, MediaModule],
  controllers: [ProfileController],
  providers: [ProfileService],
  exports: [ProfileService],
})
export class ProfileModule {}
