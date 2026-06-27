import {
  Body,
  Controller,
  Headers,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminOrApiKeyGuard } from '@/modules/auth/admin-or-api-key.guard';
import { SubscriptionsService } from './subscriptions.service';

@ApiTags('Subscriptions')
@Controller()
export class SubscriptionsController {
  constructor(private readonly subscriptionsService: SubscriptionsService) {}

  @Post('subscriptions/webhook')
  @ApiOperation({ summary: 'Handle Stripe subscription webhooks' })
  async handleStripeWebhook(
    @Req() request: FastifyRequest,
    @Headers('stripe-signature') signature?: string,
  ) {
    await this.subscriptionsService.handleWebhook(
      (request as any).rawBody,
      signature,
    );
    return { received: true };
  }

  @Post('admin/subscriptions/:profileId/resync')
  @UseGuards(AdminOrApiKeyGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Resync a profile subscription from Stripe' })
  async resyncSubscription(@Param('profileId') profileId: string) {
    return this.subscriptionsService.resyncProfileSubscription(profileId);
  }

  @Post('admin/subscriptions/:profileId/cancel')
  @UseGuards(AdminOrApiKeyGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Cancel a profile subscription at period end' })
  async cancelSubscription(@Param('profileId') profileId: string) {
    return this.subscriptionsService.cancelSubscriptionAtPeriodEnd(profileId);
  }

  @Post('admin/subscriptions/:profileId/reactivate')
  @UseGuards(AdminOrApiKeyGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Reactivate a profile subscription before period end' })
  async reactivateSubscription(@Param('profileId') profileId: string) {
    return this.subscriptionsService.reactivateSubscription(profileId);
  }

  @Post('admin/subscriptions/:profileId/takeover')
  @UseGuards(AdminOrApiKeyGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Take over a Stripe-managed subscription and convert it to manual' })
  async takeOverSubscription(@Param('profileId') profileId: string) {
    return this.subscriptionsService.takeOverStripeSubscription(profileId);
  }

  @Get('admin/subscriptions/refund-requests')
  @UseGuards(AdminOrApiKeyGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'List premium refund requests' })
  async listRefundRequests(
    @Query('status') status?: string,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.subscriptionsService.listRefundRequests({
      status,
      search,
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get('admin/subscriptions/refund-requests/:id')
  @UseGuards(AdminOrApiKeyGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get premium refund request detail' })
  async getRefundRequest(@Param('id') id: string) {
    return this.subscriptionsService.getRefundRequestById(id);
  }

  @Patch('admin/subscriptions/refund-requests/:id')
  @UseGuards(AdminOrApiKeyGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update premium refund request status' })
  async updateRefundRequest(
    @Param('id') id: string,
    @Body() body: { status?: string; adminNote?: string },
    @Headers('x-admin-actor-id') actorId?: string,
  ) {
    return this.subscriptionsService.updateRefundRequest(id, {
      status: body?.status,
      adminNote: body?.adminNote,
      actorId: actorId ?? null,
    });
  }
}
