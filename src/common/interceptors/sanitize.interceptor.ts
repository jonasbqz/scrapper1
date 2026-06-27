import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { sanitizeString, sanitizeObject } from '@/common/pipes/sanitize.pipe';

/**
 * Interceptor that sanitizes query parameters and path parameters
 * This complements the SanitizePipe which handles body data
 */
@Injectable()
export class SanitizeInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest();

    // Sanitize query parameters
    if (request.query && typeof request.query === 'object') {
      for (const key of Object.keys(request.query)) {
        if (typeof request.query[key] === 'string') {
          request.query[key] = sanitizeString(request.query[key], 'strict');
        }
      }
    }

    // Sanitize path parameters
    if (request.params && typeof request.params === 'object') {
      for (const key of Object.keys(request.params)) {
        if (typeof request.params[key] === 'string') {
          // For path params, only remove dangerous characters, keep the value mostly intact
          request.params[key] = sanitizeString(request.params[key], 'strict');
        }
      }
    }

    return next.handle();
  }
}
