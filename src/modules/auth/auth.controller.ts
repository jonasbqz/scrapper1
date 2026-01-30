import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { AuthGuard } from './auth.guard';
import { CurrentUser, UserSession } from './current-user.decorator';

@ApiTags('Auth')
@Controller()
export class AuthController {
  @Get('me')
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get current user info' })
  async me(@CurrentUser() user: UserSession) {
    return user;
  }
}
