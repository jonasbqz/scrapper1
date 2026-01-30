import { Controller, All, Req, Res, Get, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiExcludeEndpoint } from '@nestjs/swagger';
import { FastifyRequest, FastifyReply } from 'fastify';
import { auth } from '@/lib/auth';
import { toNodeHandler } from 'better-auth/node';
import { AuthGuard } from './auth.guard';
import { CurrentUser, UserSession } from './current-user.decorator';

@ApiTags('Auth')
@Controller()
export class AuthController {
  private handler = toNodeHandler(auth);

  @All('auth/(.*)')
  @ApiExcludeEndpoint()
  async handleAuth(@Req() req: FastifyRequest, @Res() res: FastifyReply) {
    // Convert Fastify request/response to Node request/response for better-auth
    const nodeReq = this.toNodeRequest(req);
    const nodeRes = this.toNodeResponse(res);

    await this.handler(nodeReq as any, nodeRes as any);
  }

  @Get('auth/session')
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get current session' })
  async getSession(@CurrentUser() user: UserSession) {
    return {
      user: {
        id: user.userId,
        email: user.email,
        name: user.name,
      },
      profileId: user.profileId,
    };
  }

  @Get('me')
  @UseGuards(AuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get current user info' })
  async me(@CurrentUser() user: UserSession) {
    return user;
  }

  private toNodeRequest(req: FastifyRequest) {
    const url = `${req.protocol}://${req.hostname}${req.url}`;
    return {
      method: req.method,
      url,
      headers: req.headers,
      body: req.body,
    };
  }

  private toNodeResponse(res: FastifyReply) {
    return {
      setHeader: (name: string, value: string) => {
        res.header(name, value);
      },
      getHeader: (name: string) => {
        return res.getHeader(name);
      },
      writeHead: (status: number, headers?: Record<string, string>) => {
        res.status(status);
        if (headers) {
          Object.entries(headers).forEach(([key, value]) => {
            res.header(key, value);
          });
        }
      },
      end: (body?: string) => {
        if (body) {
          res.send(body);
        } else {
          res.send();
        }
      },
    };
  }
}
