import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '@/modules/auth/auth.guard';
import { ProfileGuard } from '@/modules/auth/profile.guard';
import { CurrentUser, UserSession } from '@/modules/auth/current-user.decorator';
import { MediaService } from './media.service';
import {
  CreateUploadSessionDto,
  ProxyUploadMediaDto,
  RegisterExternalMediaDto,
} from './media.dto';

@ApiTags('Media')
@Controller('media')
@UseGuards(AuthGuard, ProfileGuard)
@ApiBearerAuth()
export class MediaController {
  constructor(private readonly mediaService: MediaService) {}

  @Get('gallery')
  @ApiOperation({ summary: 'List current user reusable media gallery' })
  async getGallery(@CurrentUser() user: UserSession) {
    return this.mediaService.listGallery(user.profileId!);
  }

  @Post('external')
  @ApiOperation({ summary: 'Register an external media URL in gallery' })
  async registerExternal(
    @CurrentUser() user: UserSession,
    @Body() dto: RegisterExternalMediaDto,
  ) {
    return this.mediaService.registerExternal(user.profileId!, dto);
  }

  @Post('upload-session')
  @ApiOperation({ summary: 'Create a presigned upload session for premium users' })
  async createUploadSession(
    @CurrentUser() user: UserSession,
    @Body() dto: CreateUploadSessionDto,
  ) {
    return this.mediaService.createUploadSession(user.profileId!, dto);
  }

  @Post('upload')
  @ApiOperation({ summary: 'Upload media through backend proxy for premium users' })
  async uploadMedia(
    @CurrentUser() user: UserSession,
    @Query() dto: ProxyUploadMediaDto,
    @Req() request: FastifyRequest,
    @Headers('content-type') contentType?: string,
  ) {
    return this.mediaService.uploadViaProxy(
      user.profileId!,
      dto,
      ((request as any).rawBody ?? request.body) as Buffer | undefined,
      contentType,
    );
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a media asset from gallery' })
  async deleteAsset(
    @CurrentUser() user: UserSession,
    @Param('id') id: string,
  ) {
    return this.mediaService.deleteAsset(user.profileId!, id);
  }
}
