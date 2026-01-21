import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import type { UserSession } from './current-user.decorator';

@Injectable()
export class ProfileGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const user = request.user as UserSession;

    if (!user?.profileId) {
      throw new ForbiddenException('Profile required. Create a profile first.');
    }

    return true;
  }
}
