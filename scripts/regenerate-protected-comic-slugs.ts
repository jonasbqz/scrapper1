/**
 * One-shot migration: regenerates the slug of every protected comic into
 * the new format `<3 random><title-slug><4 random>` (e.g. `133naruto2125`).
 *
 * Replaces the old 6-digit code suffix mechanism. The new format bakes the
 * random into the slug itself, and a recurring cron (every 3 days) rotates
 * just the random digits; the title-slug stays stable.
 *
 * Unprotected comics (`protectedRouteEnabled = false`) are NOT touched —
 * their slugs remain plain.
 *
 * The route_protection_codes table is dropped by SQL migration 0018
 * (apply-manual-migrations.ts); this script only deals with comic slugs.
 *
 * Usage:
 *   DATABASE_URL="postgresql://..." bun run scripts/regenerate-protected-comic-slugs.ts
 *   # Preview without writing:
 *   DATABASE_URL="postgresql://..." bun run scripts/regenerate-protected-comic-slugs.ts --dry-run
 */

import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { eq } from 'drizzle-orm';
import { randomInt } from 'crypto';
import * as schema from '../src/database/schema';

const { comics } = schema;

const PREFIX_DIGITS = 3;
const SUFFIX_DIGITS = 4;
const MAX_ATTEMPTS = 10;

function generateRandomPrefix(): string {
  const max = 10 ** PREFIX_DIGITS;
  const min = 10 ** (PREFIX_DIGITS - 1);
  return randomInt(min, max).toString();
}

function generateRandomSuffix(): string {
  const max = 10 ** SUFFIX_DIGITS;
  const min = 10 ** (SUFFIX_DIGITS - 1);
  return randomInt(min, max).toString();
}

function slugifyTitle(title: string): string {
  return title
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 240);
}

function extractTitleSlug(storedSlug: string, title: string | null | undefined): string {
  // If the stored slug already matches the new format, strip the random parts
  // to recover the original title-slug.
  if (storedSlug.length >= PREFIX_DIGITS + SUFFIX_DIGITS) {
    const start = storedSlug.slice(0, PREFIX_DIGITS);
    const end = storedSlug.slice(storedSlug.length - SUFFIX_DIGITS);
    if (/^\d+$/.test(start) && /^\d+$/.test(end)) {
      return storedSlug.slice(PREFIX_DIGITS, storedSlug.length - SUFFIX_DIGITS);
    }
  }
  // Fallback: use the comic's current slug (probably a plain title-slug).
  if (storedSlug) {
    return storedSlug;
  }
  return slugifyTitle(title || 'comic');
}

const isDryRun = process.argv.includes('--dry-run');

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('ERROR: DATABASE_URL environment variable is required');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: databaseUrl });
  const db = drizzle(pool, { schema });

  try {
    const protectedComics = await db
      .select({
        id: comics.id,
        slug: comics.slug,
        title: comics.title,
      })
      .from(comics)
      .where(eq(comics.protectedRouteEnabled, true));

    console.log(
      `[regenerate-protected-slugs] Found ${protectedComics.length} protected comic${protectedComics.length === 1 ? '' : 's'}.`,
    );

    if (protectedComics.length === 0) {
      console.log('[regenerate-protected-slugs] Nothing to do.');
      return;
    }

    let updated = 0;
    let skipped = 0;
    let failed = 0;
    const usedSlugs = new Set<string>();

    // Seed the used set with the existing slugs of protected comics so
    // collision detection is accurate.
    for (const comic of protectedComics) {
      usedSlugs.add(comic.slug);
    }

    for (const comic of protectedComics) {
      const titleSlug = extractTitleSlug(comic.slug, comic.title);

      let nextSlug: string | null = null;
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
        const candidate = `${generateRandomPrefix()}${titleSlug}${generateRandomSuffix()}`;
        if (!usedSlugs.has(candidate)) {
          nextSlug = candidate;
          break;
        }
      }

      if (!nextSlug) {
        console.error(
          `[regenerate-protected-slugs] Failed to generate a unique slug for comic ${comic.id} ("${titleSlug}") after ${MAX_ATTEMPTS} attempts.`,
        );
        failed += 1;
        continue;
      }

      if (nextSlug === comic.slug) {
        skipped += 1;
        continue;
      }

      if (isDryRun) {
        console.log(
          `[regenerate-protected-slugs] [dry-run] ${comic.id}: ${comic.slug} -> ${nextSlug}`,
        );
      } else {
        await db
          .update(comics)
          .set({ slug: nextSlug, updatedAt: new Date() })
          .where(eq(comics.id, comic.id));
        console.log(
          `[regenerate-protected-slugs] ${comic.id}: ${comic.slug} -> ${nextSlug}`,
        );
      }

      usedSlugs.add(nextSlug);
      updated += 1;
    }

    console.log(
      `[regenerate-protected-slugs] Done. updated=${updated} skipped=${skipped} failed=${failed}${isDryRun ? ' (DRY RUN)' : ''}`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('[regenerate-protected-slugs] Unexpected error:', err);
  process.exit(1);
});
