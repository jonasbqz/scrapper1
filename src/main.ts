import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import fastifyCookie from '@fastify/cookie';
import fastifyHelmet from '@fastify/helmet';
import { FastifyRequest, FastifyReply } from 'fastify';
import { AppModule } from './app.module';
import { SanitizePipe } from './common/pipes';
import { SanitizeInterceptor } from './common/interceptors';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { auth } from './lib/auth';
import { toNodeHandler } from 'better-auth/node';
import { getRequestClientIp } from './common/network/client-ip';

function parseJsonBody(body: Buffer, done: (error: Error | null, body?: unknown) => void) {
  const rawBody = body.toString('utf8').trim();

  if (!rawBody) {
    done(null, {});
    return;
  }

  try {
    done(null, JSON.parse(rawBody));
  } catch (error) {
    done(error instanceof Error ? error : new Error('Invalid JSON body'));
  }
}

// Helper function to handle better-auth requests using raw Node.js response
async function handleBetterAuth(
  request: FastifyRequest,
  reply: FastifyReply,
  handler: ReturnType<typeof toNodeHandler>,
): Promise<void> {
  // Hijack the reply to take full control
  reply.hijack();

  const clientIp = getRequestClientIp(request);
  const nodeReq = {
    method: request.method,
    url: `${request.protocol}://${request.hostname}${request.url}`,
    headers: {
      ...request.headers,
      ...(clientIp
        ? {
            'x-forwarded-for': clientIp,
            'x-real-ip': clientIp,
            'x-client-ip': clientIp,
            'cf-connecting-ip': clientIp,
            'true-client-ip': clientIp,
          }
        : {}),
    },
    body: request.body,
  };

  // Use raw Node.js response
  const rawRes = reply.raw;

  const nodeRes = {
    setHeader: (name: string, value: string) => rawRes.setHeader(name, value),
    getHeader: (name: string) => rawRes.getHeader(name),
    writeHead: (status: number, headers?: Record<string, string>) => {
      rawRes.writeHead(status, headers);
    },
    end: (body?: string) => {
      rawRes.end(body);
    },
  };

  await handler(nodeReq as any, nodeRes as any);
}

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      trustProxy: true,
      bodyLimit: 10 * 1024 * 1024,
    }),
    { rawBody: true },
  );

  (app.getHttpAdapter() as unknown as FastifyAdapter).useBodyParser(
    'application/json',
    true,
    { bodyLimit: 10 * 1024 * 1024 },
    (_request: FastifyRequest, body: Buffer, done: (error: Error | null, body?: unknown) => void) =>
      parseJsonBody(body, done),
  );

  // Register cookie plugin for better-auth sessions
  const cookieSecret = process.env.COOKIE_SECRET || process.env.BETTER_AUTH_SECRET;
  if (!cookieSecret && process.env.NODE_ENV === 'production') {
    throw new Error('[security] COOKIE_SECRET or BETTER_AUTH_SECRET environment variable is required in production');
  }
  await app.register(fastifyCookie, {
    secret: cookieSecret || crypto.randomUUID(),
  });

  // Security headers via helmet (CSP, HSTS, X-Frame-Options, etc.)
  await app.register(fastifyHelmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'https:'],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  });

  app.enableCors({
    origin: process.env.CORS_ORIGIN?.split(',') || ['https://mangolibreria.com', 'http://localhost:3000'],
    credentials: true,
  });

  // Register better-auth handler for all auth routes using onRequest hook
  const authHandler = toNodeHandler(auth);
  const fastifyInstance = app.getHttpAdapter().getInstance();

  fastifyInstance.addContentTypeParser(
    /^image\/.+$/i,
    { parseAs: 'buffer' },
    (request, body, done) => done(null, body),
  );
  fastifyInstance.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer' },
    (request, body, done) => done(null, body),
  );

  // Use onRequest hook to intercept all /api/auth/* requests before routing
  fastifyInstance.addHook('onRequest', async (request, reply) => {
    // Only handle /api/auth/ routes
    const url = request.url.split('?')[0]; // Remove query string
    if (url.startsWith('/api/auth/')) {
      await handleBetterAuth(request, reply, authHandler);
    }
  });

  // Global interceptor: Sanitize query and path params
  app.useGlobalInterceptors(new SanitizeInterceptor());

  // Global filter: structured error responses with timestamp
  app.useGlobalFilters(new HttpExceptionFilter());

  // Global pipes: Sanitize body first, then validate
  app.useGlobalPipes(
    new SanitizePipe('strict'), // Sanitize all string inputs to prevent XSS
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  app.setGlobalPrefix('api');

  const config = new DocumentBuilder()
    .setTitle('Monline Scraper API')
    .setDescription('Manga scraper and reading tracker API')
    .setVersion('2.0.0')
    .addBearerAuth()
    .build();

  const document = SwaggerModule.createDocument(app, config);
  if (process.env.NODE_ENV === 'development') {
    SwaggerModule.setup('docs', app, document);
  }

  const port = process.env.PORT || 8085;
  await app.listen(port, '0.0.0.0');
  console.log(`Server running on http://localhost:${port}`);
  if (process.env.NODE_ENV === 'development') {
    console.log(`Swagger docs: http://localhost:${port}/docs`);
  }
}

bootstrap();
