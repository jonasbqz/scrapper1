import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '@/modules/auth/auth.guard';
import { ProfileGuard } from '@/modules/auth/profile.guard';
import { CurrentUser, UserSession } from '@/modules/auth/current-user.decorator';
import { ProfileService } from './profile.service';
import { CreateProfileDto, UpdateProfileDto } from './profile.dto';
import { SubscriptionsService } from '@/modules/subscriptions/subscriptions.service';

@ApiTags('Profile')
@Controller('profile')
export class ProfileController {
  constructor(
    private profileService: ProfileService,
    private readonly subscriptionsService: SubscriptionsService,
  ) {}

  @Post()
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a new profile' })
  async create(
    @CurrentUser() user: UserSession,
    @Body() dto: CreateProfileDto,
  ) {
    return this.profileService.create(user.userId, dto);
  }

  @Get('me')
  @UseGuards(AuthGuard, ProfileGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get current user profile' })
  async getMe(@CurrentUser() user: UserSession) {
    const profile = await this.profileService.findById(user.profileId!);
    if (!profile) {
      throw new NotFoundException('Profile not found');
    }
    return this.profileService.toPrivateProfileResponse(profile);
  }

  @Get('me/stats')
  @UseGuards(AuthGuard, ProfileGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get current user statistics' })
  async getMyStats(@CurrentUser() user: UserSession) {
    return this.profileService.getStats(user.profileId!);
  }

  @Get('me/validate-premium')
  @UseGuards(AuthGuard, ProfileGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Validate if current user has premium access' })
  async validatePremium(@CurrentUser() user: UserSession) {
    const summary = await this.subscriptionsService.getProfileSubscriptionSummary(
      user.profileId!,
    );
    const currentPeriodEnd =
      summary.currentPeriodEnd ? new Date(summary.currentPeriodEnd) : null;
    const isPremium =
      summary.plan === 'premium' &&
      !!currentPeriodEnd &&
      Number.isFinite(currentPeriodEnd.getTime()) &&
      currentPeriodEnd.getTime() > Date.now() &&
      ['active', 'canceling', 'past_due'].includes(summary.status);

    return {
      isValid: true,
      isPremium,
      plan: summary.plan,
      premiumExpireAt: summary.currentPeriodEnd,
      subscription: summary,
    };
  }

  @Get('me/subscription')
  @UseGuards(AuthGuard, ProfileGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get current user subscription summary' })
  async getMySubscription(@CurrentUser() user: UserSession) {
    return this.subscriptionsService.getProfileSubscriptionSummary(
      user.profileId!,
    );
  }

  private sanitizeRefundRequestForProfile(
    request:
      | Awaited<ReturnType<SubscriptionsService['getCurrentRefundRequest']>>
      | Awaited<ReturnType<SubscriptionsService['createRefundRequest']>>,
  ) {
    if (!request) {
      return null;
    }

    return {
      ...request,
      adminNote: null,
      resolvedByAdminId: null,
    };
  }

  @Get('me/subscription/refund-request')
  @UseGuards(AuthGuard, ProfileGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get current user refund request for Stripe premium' })
  async getMyRefundRequest(@CurrentUser() user: UserSession) {
    const request = await this.subscriptionsService.getCurrentRefundRequest(
      user.profileId!,
    );
    return this.sanitizeRefundRequestForProfile(request);
  }

  @Post('me/subscription/refund-request')
  @UseGuards(AuthGuard, ProfileGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a refund claim for current Stripe premium subscription' })
  async createMyRefundRequest(
    @CurrentUser() user: UserSession,
    @Body('reason') reason: string,
  ) {
    const request = await this.subscriptionsService.createRefundRequest(
      user.profileId!,
      reason,
    );
    return this.sanitizeRefundRequestForProfile(request);
  }

  @Delete('me/subscription/refund-request')
  @UseGuards(AuthGuard, ProfileGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Cancel current user refund request while it is still open' })
  async cancelMyRefundRequest(@CurrentUser() user: UserSession) {
    return this.subscriptionsService.cancelRefundRequest(user.profileId!);
  }

  @Post('me/subscription/checkout')
  @UseGuards(AuthGuard, ProfileGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a Stripe checkout session for premium' })
  async createMySubscriptionCheckout(
    @CurrentUser() user: UserSession,
    @Body('cycle') cycle: '1w' | '1m' | '3m' | '6m',
  ) {
    return this.subscriptionsService.createCheckoutSession(
      user.profileId!,
      cycle,
    );
  }

  @Post('me/subscription/confirm')
  @UseGuards(AuthGuard, ProfileGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Confirm and sync a Stripe checkout session for premium' })
  async confirmMySubscriptionCheckout(
    @CurrentUser() user: UserSession,
    @Body('sessionId') sessionId: string,
  ) {
    return this.subscriptionsService.confirmCheckoutSession(
      user.profileId!,
      sessionId,
    );
  }

  @Post('me/subscription/cancel')
  @UseGuards(AuthGuard, ProfileGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Cancel current user subscription at period end' })
  async cancelMySubscription(@CurrentUser() user: UserSession) {
    return this.subscriptionsService.cancelSubscriptionAtPeriodEnd(
      user.profileId!,
    );
  }

  @Post('me/subscription/reactivate')
  @UseGuards(AuthGuard, ProfileGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Reactivate current user subscription before period end' })
  async reactivateMySubscription(@CurrentUser() user: UserSession) {
    return this.subscriptionsService.reactivateSubscription(user.profileId!);
  }

  @Put('me')
  @UseGuards(AuthGuard, ProfileGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update current user profile' })
  async updateMe(
    @CurrentUser() user: UserSession,
    @Body() dto: UpdateProfileDto,
  ) {
    return this.profileService.update(user.profileId!, dto);
  }

  @Delete('me')
  @UseGuards(AuthGuard, ProfileGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Delete current user profile' })
  async deleteMe(@CurrentUser() user: UserSession) {
    await this.profileService.delete(user.profileId!);
    return { success: true };
  }

  @Get('username/:username')
  @ApiOperation({ summary: 'Get public profile by username' })
  async getByUsername(@Param('username') username: string) {
    const profile = await this.profileService.findByUsername(username);
    if (!profile) {
      throw new NotFoundException('Profile not found');
    }
    return {
      id: profile.id,
      username: profile.username,
      visibleName: profile.visibleName,
      bio: profile.bio,
      avatarUrl: profile.avatarUrl,
      createdAt: profile.createdAt,
    };
  }

  @Get('user')
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Search profile by user_id' })
  async getByUserId(
    @CurrentUser() user: UserSession,
    @Query('user_id') userId: string,
  ) {
    if (userId && userId !== user.userId) {
      throw new ForbiddenException('You can only access your own profile by user_id');
    }

    const profile = await this.profileService.findByUserId(userId || user.userId);
    if (!profile) {
      throw new NotFoundException('Profile not found');
    }
    return this.profileService.toPrivateProfileResponse(profile);
  }
}
