import {
  Controller,
  Get,
  UseGuards,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '@/modules/auth/auth.guard';
import { ProfileGuard } from '@/modules/auth/profile.guard';
import type { FastifyRequest } from 'fastify';
import type { UserSession } from '@/modules/auth/current-user.decorator';
import { NotificationsService } from './notifications.service';
import { NotificationsResponseDto } from './dto/notifications.dto';

@ApiTags('Notifications')
@ApiBearerAuth()
@Controller('notifications')
@UseGuards(AuthGuard, ProfileGuard)
export class NotificationsController {
  constructor(private notificationsService: NotificationsService) {}

  /**
   * GET /api/notifications/updates
   *
   * Returns the per-profile "updates" feed (comics the user is actively
   * `reading` that have unreleased-since-last-read chapters within the
   * 30-day window). Cached server-side for 1h, invalidated by bookmark
   * status transitions and reading-history writes.
   */
  @Get('updates')
  @ApiOperation({ summary: 'List unread-chapter updates for the authenticated profile' })
  async getUpdates(@Req() request: FastifyRequest): Promise<NotificationsResponseDto> {
    const user = (request as unknown as { user: UserSession }).user;
    // AuthGuard + ProfileGuard guarantee profileId is present; the non-null
    // assertion mirrors the existing reading-history.controller.ts pattern.
    const profileId = user.profileId!;
    return this.notificationsService.findUpdates(profileId);
  }
}
