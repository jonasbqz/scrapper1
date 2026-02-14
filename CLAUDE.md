# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Monline API — a manga/comic scraper and reading tracker backend built with NestJS, Drizzle ORM, PostgreSQL, and Redis caching. Uses Fastify as the HTTP adapter (not Express). Authentication via better-auth with email/password and Discord OAuth.

## Commands

```bash
bun install              # Install dependencies
bun run start:dev        # Start dev server (watch mode), runs on port 8085
bun run build            # Build for production (nest build)
bun run start:prod       # Run production build
bun run test             # Run tests with bun
bun run lint             # ESLint with auto-fix
bun run typecheck        # TypeScript type checking (tsc --noEmit)

# Database (Drizzle Kit)
bun run db:push          # Push schema to database (no migrations)
bun run db:generate      # Generate migration files
bun run db:migrate       # Run migrations
bun run db:studio        # Open Drizzle Studio GUI
```

## Architecture

### HTTP & Auth Layer

- **Fastify** adapter, not Express — use `FastifyRequest`/`FastifyReply` types, not `Request`/`Response`
- **better-auth** handles `/api/auth/*` routes via a Fastify `onRequest` hook in `src/main.ts` that hijacks those requests before NestJS routing
- Auth configuration lives in `src/lib/auth.ts` (standalone, not a NestJS provider)
- All other API routes are prefixed with `/api` via `app.setGlobalPrefix('api')`
- Swagger docs available at `/docs` in development only

### Guards & Decorators

- `AuthGuard` — validates better-auth session from request headers, auto-creates a profile if none exists, attaches `UserSession` to `request.user`
- `ProfileGuard` — used after `AuthGuard` to ensure the user has a profile (returns 403 if missing)
- `@CurrentUser()` decorator — extracts the `UserSession` from the request; supports field extraction via `@CurrentUser('profileId')`

### Database

- **Drizzle ORM** with `node-postgres` (`pg` Pool), schema-first approach
- Schema defined in `src/database/schema/index.ts` (single file with all tables, enums, and relations)
- Auth tables (user, session, account, verification) in `src/database/schema/auth.ts`
- `DATABASE_CONNECTION` injection token — inject the Drizzle instance as `@Inject(DATABASE_CONNECTION) db: NodePgDatabase<typeof schema>`
- `DatabaseModule` is `@Global()`, available everywhere without importing

### Caching

- `RedisCacheModule` (`src/cache/`) is `@Global()` — uses Redis if `REDIS_URL` is set, falls back to in-memory
- `CacheService` provides `get/set/del/wrap/delByPattern` methods with predefined TTL tiers (`CACHE_TTL.SHORT` through `CACHE_TTL.STATIC`)
- Cache key constants in `CACHE_KEYS`

### Scraper System

- Adapter pattern: `BaseScraperAdapter` in `src/modules/scraper/adapters/base.adapter.ts` provides shared utilities (delay, slugify, parseChapterNumber, cleanText)
- Concrete adapters: `IkigaiAdapter`, `OlympusAdapter` — each implements scraping logic for a specific manga source using Cheerio
- `ScraperQueue` (`scraper.queue.ts`) — in-memory sequential queue ensuring only one scraper runs at a time
- `ScraperService` — orchestrates scraping with cron schedules (Ikigai hourly, Olympus every 2 hours) and triggers initial scrape on startup
- Types in `scraper.types.ts`: `ScrapedComic`, `ScrapedChapter`, `ChapterListItem`, `ScraperResult`

### Module Pattern

Each feature module follows: `*.module.ts`, `*.controller.ts`, `*.service.ts`, `*.dto.ts` (when needed). Modules: auth, profile, comic, chapter, bookmark, reading-history, scraper, likes, chapter-likes, comments, playlists, downloads.

### Path Aliases

```
@/*        → src/*
@config/*  → src/config/*
@database/* → src/database/*
@modules/* → src/modules/*
@common/*  → src/common/*
```

### Global Pipes & Interceptors

- `SanitizePipe` (strict mode) — sanitizes all string inputs against XSS before validation
- `SanitizeInterceptor` — sanitizes query and path params
- `ValidationPipe` with `whitelist: true`, `forbidNonWhitelisted: true`, `transform: true`

### Key Data Model

Comics are linked to scan groups via `comicScans` (a comic can appear on multiple sources). Chapters belong to a `comicScan`, not directly to a comic. The `chapters.urlPages` column stores page image URLs as a JSONB string array.
