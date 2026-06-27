import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { eq, sql, notInArray } from 'drizzle-orm';
import * as schema from '../src/database/schema';

const { comics, comicScans } = schema;

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('ERROR: DATABASE_URL environment variable is required');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: databaseUrl });
  const db = drizzle(pool, { schema });

  try {
    console.log('Starting DB cleanup of copyrighted and English content...');

    // 1. Delete reported DMCA copyrighted comic
    const targetSlug = 'f75d1f6a-6905-4588-a1d6-04570dbf011f';
    const deletedComics = await db
      .delete(comics)
      .where(eq(comics.slug, targetSlug))
      .returning({ id: comics.id, title: comics.title });

    if (deletedComics.length > 0) {
      for (const c of deletedComics) {
        console.log(`[DMCA] Deleted copyrighted comic: [${c.id}] ${c.title}`);
      }
    } else {
      console.log(`[DMCA] Comic with slug "${targetSlug}" not found or already deleted.`);
    }

    // 2. Delete all English comic scans (triggers cascade delete on chapters, bookmarks, reading history, comments, etc.)
    const deletedScans = await db
      .delete(comicScans)
      .where(eq(comicScans.language, 'en'))
      .returning({ id: comicScans.id, comicId: comicScans.comicId });

    console.log(`[LANG] Deleted ${deletedScans.length} English comic scans and their associated chapters (CASCADE).`);

    // 3. Delete any orphan comics that no longer have any scans (either Spanish or Portuguese)
    const activeComicIdsResult = await db
      .select({ id: comicScans.comicId })
      .from(comicScans);
    
    const activeComicIds = Array.from(new Set(activeComicIdsResult.map((row) => row.id)));

    if (activeComicIds.length > 0) {
      const deletedOrphans = await db
        .delete(comics)
        .where(notInArray(comics.id, activeComicIds))
        .returning({ id: comics.id, title: comics.title });

      if (deletedOrphans.length > 0) {
        console.log(`[CLEANUP] Deleted ${deletedOrphans.length} orphan comics that had no scans remaining:`);
        for (const c of deletedOrphans) {
          console.log(`  - [${c.id}] ${c.title}`);
        }
      }
    } else {
      // If there are no scans in the database at all, delete all comics to prevent stale listings
      const deletedAll = await db.delete(comics).returning({ id: comics.id });
      console.log(`[CLEANUP] Deleted all ${deletedAll.length} comics as no scans exist in the database.`);
    }

    // 4. Delete all chapters that were scraped with 0 pages (empty url_pages array) so they can be re-scraped properly
    const deletedEmptyChapters = await db.execute(sql`
      DELETE FROM chapters
      WHERE url_pages IS NULL 
         OR jsonb_array_length(url_pages) = 0 
         OR url_pages::text = '[]'
    `);
    console.log(`[CLEANUP] Deleted empty chapters (0 pages) to force them to be re-scraped.`);

    console.log('Database cleanup completed successfully.');
  } catch (error) {
    console.error('Error during DB cleanup:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
