import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { UserSession } from './current-user.decorator';
import { getEmailVerificationRequiredError } from '@/lib/email-verification-policy';

@Injectable()
export class VerifiedEmailGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const user = request.user as UserSession | undefined;

    if (!user?.requiresEmailVerification) {
      return true;
    }

    throw new ForbiddenException(getEmailVerificationRequiredError());
  }
}
