import { Body, Controller, Get, Headers, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import { AdminOrApiKeyGuard } from '@/modules/auth/admin-or-api-key.guard';
import { TrafficEventsService } from './traffic-events.service';

@ApiTags('Traffic Events')
@Controller('traffic-events')
@UseGuards(AdminOrApiKeyGuard)
export class TrafficEventsController {
  constructor(private readonly trafficEventsService: TrafficEventsService) {}

  @Get('recent')
  @ApiOperation({ summary: 'Recent traffic learning events' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'minRisk', required: false, type: Number })
  @ApiQuery({ name: 'eventType', required: false, type: String })
  @ApiQuery({ name: 'clientIp', required: false, type: String })
  async recent(
    @Query('limit') limit?: string,
    @Query('minRisk') minRisk?: string,
    @Query('eventType') eventType?: string,
    @Query('clientIp') clientIp?: string,
  ) {
    return this.trafficEventsService.getRecentEvents({
      limit: limit ? Number.parseInt(limit, 10) : undefined,
      minRisk: minRisk ? Number.parseInt(minRisk, 10) : undefined,
      eventType: eventType || undefined,
      clientIp: clientIp || undefined,
    });
  }

  @Get('suspicious')
  @ApiOperation({ summary: 'Aggregate suspicious clients from recent traffic events' })
  @ApiQuery({ name: 'hours', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'minEvents', required: false, type: Number })
  async suspicious(
    @Query('hours') hours?: string,
    @Query('limit') limit?: string,
    @Query('minEvents') minEvents?: string,
  ) {
    return this.trafficEventsService.getSuspiciousSubjects({
      hours: hours ? Number.parseInt(hours, 10) : undefined,
      limit: limit ? Number.parseInt(limit, 10) : undefined,
      minEvents: minEvents ? Number.parseInt(minEvents, 10) : undefined,
    });
  }

  @Get('blocked')
  @ApiOperation({ summary: 'Blocked bot subjects with manual unblock status' })
  @ApiQuery({ name: 'status', required: false, enum: ['active', 'unblocked', 'expired', 'all'] })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'offset', required: false, type: Number })
  @ApiQuery({ name: 'q', required: false, description: 'Search by IPv4/IPv6, subject key, ASN, user-agent, reason, or status' })
  async blocked(
    @Query('status') status?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('q') q?: string,
  ) {
    return this.trafficEventsService.getBlockedSubjects({
      status: status || undefined,
      limit: limit ? Number.parseInt(limit, 10) : undefined,
      offset: offset ? Number.parseInt(offset, 10) : undefined,
      q: q || undefined,
    });
  }

  @Post('blocked/unblock-all')
  @ApiOperation({ summary: 'Unblock all currently active bot blocks' })
  @ApiBody({
    required: false,
    schema: { type: 'object', properties: { reason: { type: 'string' } } },
  })
  async unblockAll(
    @Headers('x-admin-actor-id') actorId?: string,
    @Body() body?: { reason?: string },
  ) {
    return this.trafficEventsService.unblockAllActiveBlockedSubjects({
      actorId,
      reason: body?.reason,
    });
  }

  @Post('blocked/:subjectKey/unblock')
  @ApiOperation({ summary: 'Mark a blocked bot subject as manually unblocked' })
  @ApiParam({ name: 'subjectKey', type: String })
  @ApiBody({ required: false, schema: { type: 'object', properties: { reason: { type: 'string' } } } })
  async unblock(
    @Param('subjectKey') subjectKey: string,
    @Headers('x-admin-actor-id') actorId?: string,
    @Body() body?: { reason?: string },
  ) {
    return this.trafficEventsService.unblockBlockedSubject(subjectKey, {
      actorId,
      reason: body?.reason,
    });
  }
}
