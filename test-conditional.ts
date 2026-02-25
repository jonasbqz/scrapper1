import { NestFactory } from '@nestjs/core';
import { AppModule } from './src/app.module';
import { DatabaseService } from './src/database/database.service';
import { ScraperService } from './src/modules/scraper/scraper.service';
import { comics, comicScans, scanGroups } from './src/database/schema';
import { eq } from 'drizzle-orm';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule);
  const db = app.get(DatabaseService).db;
  const scraper = app.get(ScraperService);

  console.log('--- Setting up test comic ---');
  // First make sure Ikigai scan group exists
  let group = await db.query.scanGroups.findFirst({ where: eq(scanGroups.slug, 'ikigai') });
  if (!group) {
    const [c] = await db.insert(scanGroups).values({ name: 'Ikigai Mangas', slug: 'ikigai', website: 'https://ikigaimangas.com' }).returning();
    group = c;
  }

  // Check if test comic exists, or create one
  const testSlug = 'test-conditional-comic';
  let comic = await db.query.comics.findFirst({ where: eq(comics.slug, testSlug) });
  
  if (!comic) {
    const [c] = await db.insert(comics).values({
      title: 'Test Conditional Comic',
      slug: testSlug,
      description: 'This is a short description.',
      coverImage: 'https://httpstat.us/404', // failing image
      type: 'manga',
      status: 'ongoing',
    }).returning();
    comic = c;
  } else {
    // Reset to short description and failing image
    const [c] = await db.update(comics).set({
      description: 'This is a short description.',
      coverImage: 'https://httpstat.us/404',
    }).where(eq(comics.id, comic.id)).returning();
    comic = c;
  }

  // Link to ikigai so it gets processed as existing
  const scanLink = await db.query.comicScans.findFirst({ where: eq(comicScans.comicId, comic.id) });
  if (!scanLink) {
    await db.insert(comicScans).values({
      comicId: comic.id,
      scanGroupId: group.id,
      externalUrl: `https://ikigaimangas.com/series/test-conditional-comic`, // we might need to use a real URL here if Ikigai checks it, but upsertComic gets comic.slug
      language: 'es'
    });
  }

  console.log('Comic state before:', {
    descLength: comic.description?.length,
    cover: comic.coverImage
  });
  
  await app.close();
}
bootstrap();
