import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { ProfileGuard } from './profile.guard';

@Module({
  controllers: [AuthController],
  providers: [AuthGuard, ProfileGuard],
  exports: [AuthGuard, ProfileGuard],
})
export class AuthModule {}
