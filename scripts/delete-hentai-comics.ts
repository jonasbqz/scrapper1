/**
 * Script para eliminar todos los comics marcados como hentai de la base de datos.
 *
 * Gracias a ON DELETE CASCADE, al borrar un comic se eliminan automáticamente:
 *   - comic_scans (y sus chapters)
 *   - comic_genres
 *   - bookmarks
 *   - reading_history
 *   - likes
 *   - comments
 *   - playlist_items
 *
 * Uso:
 *   DATABASE_URL="postgresql://..." bun run scripts/delete-hentai-comics.ts
 *   # o con --dry-run para solo ver qué se borraría:
 *   DATABASE_URL="postgresql://..." bun run scripts/delete-hentai-comics.ts --dry-run
 */

import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { eq, sql } from 'drizzle-orm';
import * as schema from '../src/database/schema';

const { comics } = schema;

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
    // 1. Obtener los comics hentai
    const hentaiComics = await db.query.comics.findMany({
      where: eq(comics.isHentai, true),
      columns: { id: true, title: true, slug: true },
    });

    if (hentaiComics.length === 0) {
      console.log('No se encontraron comics hentai en la base de datos.');
      return;
    }

    console.log(`\nSe encontraron ${hentaiComics.length} comics hentai:\n`);
    for (const comic of hentaiComics) {
      console.log(`  [${comic.id}] ${comic.title} (${comic.slug})`);
    }

    if (isDryRun) {
      console.log('\n[DRY RUN] No se eliminó nada. Quita --dry-run para ejecutar la eliminación.');
      return;
    }

    // 2. Contar chapters que se borrarán (para el reporte)
    const chapterCountResult = await db.execute(sql`
      SELECT COUNT(*) as count FROM chapters ch
      INNER JOIN comic_scans cs ON ch.comic_scan_id = cs.id
      INNER JOIN comics c ON cs.comic_id = c.id
      WHERE c.is_hentai = true
    `);
    const chapterCount = Number((chapterCountResult.rows[0] as any)?.count || 0);

    // 3. Eliminar los comics (CASCADE borra todo lo relacionado)
    const deleted = await db.delete(comics).where(eq(comics.isHentai, true)).returning({ id: comics.id });

    console.log(`\nEliminados: ${deleted.length} comics y ~${chapterCount} chapters (+ bookmarks, likes, historial, etc.)`);
    console.log('Limpieza completada.');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
