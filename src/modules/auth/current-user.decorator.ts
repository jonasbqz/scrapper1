import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export interface UserSession {
  userId: string;
  email: string;
  name: string;
  profileId?: string;
  session: {
    id: string;
    expiresAt: Date;
  };
}

export const CurrentUser = createParamDecorator(
  (data: keyof UserSession | undefined, ctx: ExecutionContext): UserSession | any => {
    const request = ctx.switchToHttp().getRequest();
    const user = request.user as UserSession;

    if (!user) return undefined;
    if (data) return user[data];

    return user;
  },
);
