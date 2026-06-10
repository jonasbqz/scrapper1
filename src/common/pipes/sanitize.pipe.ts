import { PipeTransform, Injectable, ArgumentMetadata } from '@nestjs/common';
import sanitizeHtml from 'sanitize-html';

/**
 * Sanitization options for different content types
 */
const SANITIZE_OPTIONS = {
  // Strict - removes ALL HTML tags (for usernames, names, etc.)
  strict: {
    allowedTags: [],
    allowedAttributes: {},
    disallowedTagsMode: 'discard' as const,
  },
  // Text only - allows basic formatting but no scripts/links
  textOnly: {
    allowedTags: ['b', 'i', 'em', 'strong', 'br'],
    allowedAttributes: {},
    disallowedTagsMode: 'discard' as const,
  },
  // Rich text - allows more formatting (for descriptions, bios)
  richText: {
    allowedTags: ['b', 'i', 'em', 'strong', 'br', 'p', 'ul', 'ol', 'li'],
    allowedAttributes: {},
    disallowedTagsMode: 'discard' as const,
  },
};

/**
 * Sanitizes a string to prevent XSS attacks
 * Removes all HTML tags and dangerous content by default
 */
export function sanitizeString(value: string, mode: keyof typeof SANITIZE_OPTIONS = 'strict'): string {
  if (typeof value !== 'string') return value;

  // First pass: sanitize HTML
  let sanitized = sanitizeHtml(value, SANITIZE_OPTIONS[mode]);

  // Additional sanitization for script injection patterns
  sanitized = sanitized
    // Remove javascript: protocol
    .replace(/javascript:/gi, '')
    // Remove data: protocol (can be used for XSS)
    .replace(/data:/gi, '')
    // Remove vbscript: protocol
    .replace(/vbscript:/gi, '')
    // Remove on* event handlers that might have slipped through
    .replace(/on\w+\s*=/gi, '')
    // Remove expression() CSS hack
    .replace(/expression\s*\(/gi, '')
    // Trim whitespace
    .trim();

  return sanitized;
}

/**
 * Recursively sanitizes all string properties in an object
 */
export function sanitizeObject<T extends object>(obj: T, mode: keyof typeof SANITIZE_OPTIONS = 'strict'): T {
  if (!obj || typeof obj !== 'object') return obj;

  const sanitized = { ...obj };

  for (const key of Object.keys(sanitized)) {
    const value = (sanitized as any)[key];

    if (typeof value === 'string') {
      (sanitized as any)[key] = sanitizeString(value, mode);
    } else if (Array.isArray(value)) {
      (sanitized as any)[key] = value.map(item =>
        typeof item === 'string' ? sanitizeString(item, mode) :
        typeof item === 'object' ? sanitizeObject(item, mode) : item
      );
    } else if (typeof value === 'object' && value !== null) {
      (sanitized as any)[key] = sanitizeObject(value, mode);
    }
  }

  return sanitized;
}

/**
 * NestJS Pipe that sanitizes all string inputs in the request body
 * Use this pipe on controllers that accept user input
 *
 * @example
 * @Post()
 * @UsePipes(SanitizePipe)
 * async create(@Body() dto: CreateDto) { ... }
 */
@Injectable()
export class SanitizePipe implements PipeTransform {
  private mode: keyof typeof SANITIZE_OPTIONS;

  constructor(mode: keyof typeof SANITIZE_OPTIONS = 'strict') {
    this.mode = mode;
  }

  transform(value: any, metadata: ArgumentMetadata) {
    // Only sanitize body and query parameters
    if (metadata.type !== 'body' && metadata.type !== 'query') {
      return value;
    }

    if (typeof value === 'string') {
      return sanitizeString(value, this.mode);
    }

    if (typeof value === 'object' && value !== null) {
      return sanitizeObject(value, this.mode);
    }

    return value;
  }
}

/**
 * Strict sanitization pipe - removes ALL HTML
 */
@Injectable()
export class StrictSanitizePipe extends SanitizePipe {
  constructor() {
    super('strict');
  }
}

/**
 * Text-only sanitization pipe - allows basic formatting
 */
@Injectable()
export class TextSanitizePipe extends SanitizePipe {
  constructor() {
    super('textOnly');
  }
}

/**
 * Rich text sanitization pipe - allows more formatting
 */
@Injectable()
export class RichTextSanitizePipe extends SanitizePipe {
  constructor() {
    super('richText');
  }
}
