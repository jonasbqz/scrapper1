import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { ProfileGuard } from './profile.guard';
import { AdminGuard } from './admin.guard';
import { AdminOrApiKeyGuard } from './admin-or-api-key.guard';
import { VerifiedEmailGuard } from './verified-email.guard';
import { AuthCleanupService } from './auth-cleanup.service';

@Module({
  controllers: [AuthController],
  providers: [
    AuthGuard,
    ProfileGuard,
    AdminGuard,
    AdminOrApiKeyGuard,
    VerifiedEmailGuard,
    AuthCleanupService,
  ],
  exports: [
    AuthGuard,
    ProfileGuard,
    AdminGuard,
    AdminOrApiKeyGuard,
    VerifiedEmailGuard,
  ],
})
export class AuthModule {}
