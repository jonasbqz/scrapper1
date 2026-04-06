import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  ParseIntPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { AuthGuard } from '@/modules/auth/auth.guard';
import { ProfileGuard } from '@/modules/auth/profile.guard';
import { CurrentUser, UserSession } from '@/modules/auth/current-user.decorator';
import { resolveOptionalProfileId } from '@/modules/auth/session-resolver';
import { EntityReactionsService } from './entity-reactions.service';
import { DATABASE_CONNECTION } from '@/database/database.module';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '@/database/schema';

@ApiTags('Entity Reactions')
@Controller('reactions')
export class EntityReactionsController {
  constructor(
    private readonly entityReactionsService: EntityReactionsService,
    @Inject(DATABASE_CONNECTION)
    private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  @Get(':entityType/:entityId')
  @ApiOperation({ summary: 'Get reactions summary for a comic or chapter' })
  async getSummary(
    @Param('entityType') entityType: string,
    @Param('entityId', ParseIntPipe) entityId: number,
    @Req() request: FastifyRequest,
  ) {
    const profileId = await resolveOptionalProfileId(
      this.db,
      request.headers as Record<string, any>,
    );
    return this.entityReactionsService.getSummary(entityType, entityId, profileId);
  }

  @Post(':entityType/:entityId')
  @UseGuards(AuthGuard, ProfileGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Toggle or change reaction for a comic or chapter' })
  async toggleReaction(
    @CurrentUser() user: UserSession,
    @Param('entityType') entityType: string,
    @Param('entityId', ParseIntPipe) entityId: number,
    @Body('reactionType') reactionType: string,
  ) {
    return this.entityReactionsService.toggleReaction(
      user.profileId!,
      entityType,
      entityId,
      reactionType as any,
    );
  }
}
