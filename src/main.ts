import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import fastifyCookie from '@fastify/cookie';
import { FastifyRequest, FastifyReply } from 'fastify';
import { AppModule } from './app.module';
import { SanitizePipe } from './common/pipes';
import { SanitizeInterceptor } from './common/interceptors';
import { auth } from './lib/auth';
import { toNodeHandler } from 'better-auth/node';

// Helper function to handle better-auth requests
async function handleBetterAuth(
  request: FastifyRequest,
  reply: FastifyReply,
  handler: ReturnType<typeof toNodeHandler>,
): Promise<boolean> {
  return new Promise((resolve) => {
    const nodeReq = {
      method: request.method,
      url: `${request.protocol}://${request.hostname}${request.url}`,
      headers: request.headers,
      body: request.body,
    };

    const nodeRes = {
      setHeader: (name: string, value: string) => reply.header(name, value),
      getHeader: (name: string) => reply.getHeader(name),
      writeHead: (status: number, headers?: Record<string, string>) => {
        reply.status(status);
        if (headers) {
          Object.entries(headers).forEach(([key, value]) => reply.header(key, value));
        }
      },
      end: (body?: string) => {
        if (body) {
          reply.send(body);
        } else {
          reply.send();
        }
        resolve(true);
      },
    };

    handler(nodeReq as any, nodeRes as any).catch(() => resolve(false));
  });
}

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
  );

  // Register cookie plugin for better-auth sessions
  await app.register(fastifyCookie, {
    secret: process.env.COOKIE_SECRET || 'super-secret-cookie-key',
  });

  app.enableCors({
    origin: process.env.CORS_ORIGIN?.split(',') || ['http://localhost:3000'],
    credentials: true,
  });

  // Register better-auth handler for all auth routes using preHandler hook
  const authHandler = toNodeHandler(auth);
  const fastifyInstance = app.getHttpAdapter().getInstance();

  // Use a hook to intercept all /api/auth/* requests
  fastifyInstance.addHook('preHandler', async (request, reply) => {
    // Only handle /api/auth/ routes
    const url = request.url.split('?')[0]; // Remove query string
    if (url.startsWith('/api/auth/')) {
      await handleBetterAuth(request, reply, authHandler);
      // Prevent further processing
      return;
    }
  });

  // Global interceptor: Sanitize query and path params
  app.useGlobalInterceptors(new SanitizeInterceptor());

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
  SwaggerModule.setup('docs', app, document);

  const port = process.env.PORT || 8085;
  await app.listen(port, '0.0.0.0');
  console.log(`Server running on http://localhost:${port}`);
  console.log(`Swagger docs: http://localhost:${port}/docs`);
}

bootstrap();
