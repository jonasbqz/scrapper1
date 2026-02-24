/**
 * Script para eliminar todos los comics con género "hentai" scrapeados desde m440.in (peerless-scan).
 *
 * Solo se eliminan comics que tengan específicamente el género "hentai".
 * Otros géneros adultos (yaoi, ecchi, etc.) NO se eliminan.
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
 *   DATABASE_URL="postgresql://..." bun run scripts/delete-m440-hentai.ts
 *   # o con --dry-run para solo ver qué se borraría:
 *   DATABASE_URL="postgresql://..." bun run scripts/delete-m440-hentai.ts --dry-run
 */

import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { eq, sql, inArray } from 'drizzle-orm';
import * as schema from '../src/database/schema';

const { comics, comicScans, scanGroups, comicGenres, genres } = schema;

const isDryRun = process.argv.includes('--dry-run');

/** Solo el género "hentai" */
const HENTAI_GENRE_SLUGS = ['hentai'];

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('ERROR: DATABASE_URL environment variable is required');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: databaseUrl });
  const db = drizzle(pool, { schema });

  try {
    // 1. Encontrar el scan group de peerless
    const peerlessGroup = await db.query.scanGroups.findFirst({
      where: eq(scanGroups.slug, 'peerless-scan'),
    });

    if (!peerlessGroup) {
      console.log('No se encontró el grupo "peerless-scan" en la base de datos.');
      return;
    }

    console.log(`Grupo peerless-scan encontrado (id=${peerlessGroup.id})`);

    // 2. Encontrar IDs de géneros hentai/adultos
    const hentaiGenres = await db.query.genres.findMany({
      where: inArray(genres.slug, HENTAI_GENRE_SLUGS),
    });

    if (hentaiGenres.length === 0) {
      console.log('No se encontraron géneros hentai/adultos en la base de datos.');
      return;
    }

    console.log(`Géneros hentai/adultos encontrados: ${hentaiGenres.map(g => `${g.name} (${g.slug})`).join(', ')}`);
    const hentaiGenreIds = hentaiGenres.map(g => g.id);

    // 3. Encontrar comics de peerless-scan que tengan géneros hentai
    const genreIdList = sql.join(hentaiGenreIds.map(id => sql`${id}`), sql`, `);
    const result = await db.execute(sql`
      SELECT DISTINCT c.id, c.title, c.slug
      FROM comics c
      INNER JOIN comic_scans cs ON cs.comic_id = c.id
      INNER JOIN comic_genres cg ON cg.comic_id = c.id
      WHERE cs.scan_group_id = ${peerlessGroup.id}
        AND cg.genre_id IN (${genreIdList})
      ORDER BY c.title
    `);

    const hentaiComics = result.rows as { id: number; title: string; slug: string }[];

    if (hentaiComics.length === 0) {
      console.log('\nNo se encontraron comics hentai de peerless-scan en la base de datos.');
      return;
    }

    console.log(`\n⛔ Se encontraron ${hentaiComics.length} comics hentai/adultos de m440:\n`);
    for (const comic of hentaiComics) {
      console.log(`  [${comic.id}] ${comic.title} (${comic.slug})`);
    }

    if (isDryRun) {
      console.log('\n[DRY RUN] No se eliminó nada. Quita --dry-run para ejecutar la eliminación.');
      return;
    }

    // 4. Contar chapters que se borrarán (para el reporte)
    const comicIds = hentaiComics.map(c => c.id);
    const comicIdList = sql.join(comicIds.map(id => sql`${id}`), sql`, `);
    const chapterCountResult = await db.execute(sql`
      SELECT COUNT(*) as count FROM chapters ch
      INNER JOIN comic_scans cs ON ch.comic_scan_id = cs.id
      WHERE cs.comic_id IN (${comicIdList})
    `);
    const chapterCount = Number((chapterCountResult.rows[0] as any)?.count || 0);

    // 5. Eliminar los comics (CASCADE borra todo lo relacionado)
    const deleted = await db.delete(comics)
      .where(inArray(comics.id, comicIds))
      .returning({ id: comics.id });

    console.log(`\n✅ Eliminados: ${deleted.length} comics y ~${chapterCount} chapters (+ bookmarks, likes, historial, etc.)`);
    console.log('Limpieza completada.');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
