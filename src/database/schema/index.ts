import {
  pgTable,
  uuid,
  varchar,
  text,
  boolean,
  integer,
  timestamp,
  pgEnum,
  uniqueIndex,
  index,
  jsonb,
  real,
  date,
  customType,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

// Import and re-export auth schema
import { user, session, account, verification } from './auth';
export { user, session, account, verification };

// Enums
export const comicTypeEnum = pgEnum('comic_type', ['manga', 'manhwa', 'manhua']);
export const comicStatusEnum = pgEnum('comic_status', ['ongoing', 'completed', 'hiatus', 'cancelled']);
export const bookmarkStatusEnum = pgEnum('bookmark_status', ['reading', 'completed', 'dropped', 'plan_to_read']);
export const languageEnum = pgEnum('language', ['en', 'es', 'pt']);
export const userPlanEnum = pgEnum('user_plan', ['basic', 'premium']);
// Keep enum order aligned with the existing Postgres type to avoid destructive Drizzle diffs.
export const premiumCycleEnum = pgEnum('premium_cycle', ['1m', '3m', '6m', '1w']);

const tsvector = customType<{ data: string }>({
  dataType() {
    return 'tsvector';
  },
});

// Profiles (linked to better-auth user)
export const profiles = pgTable('profiles', {
  id: uuid('id').primaryKey().defaultRandom(),
  visibleName: varchar('visible_name', { length: 100 }),
  username: varchar('username', { length: 50 }).unique().notNull(),
  bio: text('bio'),
  avatarUrl: varchar('avatar_url', { length: 500 }),
  language: languageEnum('language').default('es'),
  userId: text('user_id').unique().notNull().references(() => user.id, { onDelete: 'cascade' }),
  dateOfBirth: date('date_of_birth'),
  isBanned: boolean('is_banned').default(false),
  isAdultContent: boolean('is_adult_content').default(false),
  plan: userPlanEnum('plan').default('basic'),
  premiumCycle: premiumCycleEnum('premium_cycle'),
  premiumStartedAt: timestamp('premium_started_at'),
  premiumExpireAt: timestamp('premium_expire_at'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
}, (table) => ({
  usernameIdx: uniqueIndex('profiles_username_idx').on(table.username),
  userIdIdx: uniqueIndex('profiles_user_id_idx').on(table.userId),
}));

// Genres
export const genres = pgTable('genres', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  name: varchar('name', { length: 100 }).unique().notNull(),
  slug: varchar('slug', { length: 100 }).unique().notNull(),
  createdAt: timestamp('created_at').defaultNow(),
});

// Scan Groups
export const scanGroups = pgTable('scan_groups', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  name: varchar('name', { length: 255 }).notNull(),
  slug: varchar('slug', { length: 255 }).unique().notNull(),
  website: varchar('website', { length: 500 }),
  createdAt: timestamp('created_at').defaultNow(),
});

// Comics
export const comics = pgTable('comics', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  title: varchar('title', { length: 500 }).notNull(),
  titleAlternative: varchar('title_alternative', { length: 500 }),
  slug: varchar('slug', { length: 500 }).unique().notNull(),
  author: varchar('author', { length: 255 }),
  artist: varchar('artist', { length: 255 }),
  description: text('description'),
  type: comicTypeEnum('type').default('manga'),
  coverImage: varchar('cover_image', { length: 1000 }),
  status: comicStatusEnum('status').default('ongoing'),
  views: integer('views').default(0),
  likes: integer('likes').default(0),
  followers: integer('followers').default(0),
  isNsfw: boolean('is_nsfw').default(false),
  isHentai: boolean('is_hentai').default(false),
  copyrighted: boolean('copyrighted').default(false),
  // Managed by the manual full-text-search trigger created in 0003_fulltext_search.sql.
  searchVector: tsvector('search_vector'),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
}, (table) => ({
  slugIdx: index('comics_slug_idx').on(table.slug),
  searchVectorIdx: index('comics_search_vector_idx').using('gin', table.searchVector.asc().nullsLast().op('tsvector_ops')),
  titleIdx: index('comics_title_idx').on(table.title),
  titleTrgmIdx: index('comics_title_trgm_idx').using('gin', table.title.asc().nullsLast().op('gin_trgm_ops')),
  titleAlternativeTrgmIdx: index('comics_title_alt_trgm_idx').using('gin', table.titleAlternative.asc().nullsLast().op('gin_trgm_ops')),
  statusIdx: index('comics_status_idx').on(table.status),
  isHentaiIdx: index('comics_is_hentai_idx').on(table.isHentai),
}));

// Comic Scans (relation between comics and scan groups)
export const comicScans = pgTable('comic_scans', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  comicId: integer('comic_id').references(() => comics.id, { onDelete: 'cascade' }).notNull(),
  scanGroupId: integer('scan_group_id').references(() => scanGroups.id, { onDelete: 'cascade' }).notNull(),
  externalId: varchar('external_id', { length: 255 }),
  externalUrl: varchar('external_url', { length: 1000 }),
  language: languageEnum('language').default('es'),
  createdAt: timestamp('created_at').defaultNow(),
}, (table) => ({
  comicScanIdx: uniqueIndex('comic_scans_comic_scan_idx').on(table.comicId, table.scanGroupId),
}));

// Comic Genres (many-to-many)
export const comicGenres = pgTable('comic_genres', {
  comicId: integer('comic_id').references(() => comics.id, { onDelete: 'cascade' }).notNull(),
  genreId: integer('genre_id').references(() => genres.id, { onDelete: 'cascade' }).notNull(),
}, (table) => ({
  pk: uniqueIndex('comic_genres_pk').on(table.comicId, table.genreId),
}));

// Chapters
export const chapters = pgTable('chapters', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  comicScanId: integer('comic_scan_id').references(() => comicScans.id, { onDelete: 'cascade' }).notNull(),
  chapterNumber: real('chapter_number').notNull(),
  title: varchar('title', { length: 500 }),
  slug: varchar('slug', { length: 500 }).notNull(),
  releaseDate: timestamp('release_date'),
  urlPages: jsonb('url_pages').$type<string[]>().default([]),
  views: integer('views').default(0),
  likes: integer('likes').default(0),
  copyrighted: boolean('copyrighted').default(false),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
}, (table) => ({
  comicScanIdx: index('chapters_comic_scan_idx').on(table.comicScanId),
  comicChapterIdx: uniqueIndex('chapters_comic_chapter_idx').on(table.comicScanId, table.chapterNumber),
}));

// Bookmarks
export const bookmarks = pgTable('bookmarks', {
  id: uuid('id').primaryKey().defaultRandom(),
  profileId: uuid('profile_id').references(() => profiles.id, { onDelete: 'cascade' }).notNull(),
  comicId: integer('comic_id').references(() => comics.id, { onDelete: 'cascade' }).notNull(),
  status: bookmarkStatusEnum('status').default('plan_to_read'),
  isFavorite: boolean('is_favorite').default(false),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
}, (table) => ({
  profileComicIdx: uniqueIndex('bookmarks_profile_comic_idx').on(table.profileId, table.comicId),
  profileStatusIdx: index('bookmarks_profile_status_idx').on(table.profileId, table.status),
}));

// Reading History
export const readingHistory = pgTable('reading_history', {
  id: uuid('id').primaryKey().defaultRandom(),
  profileId: uuid('profile_id').references(() => profiles.id, { onDelete: 'cascade' }).notNull(),
  comicId: integer('comic_id').references(() => comics.id, { onDelete: 'cascade' }).notNull(),
  chapterId: integer('chapter_id').references(() => chapters.id, { onDelete: 'cascade' }).notNull(),
  progressPercentage: integer('progress_percentage').default(0),
  readAt: timestamp('read_at').defaultNow(),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
}, (table) => ({
  profileComicChapterIdx: uniqueIndex('reading_history_profile_comic_chapter_idx').on(table.profileId, table.comicId, table.chapterId),
  profileIdx: index('reading_history_profile_idx').on(table.profileId),
  readAtIdx: index('reading_history_read_at_idx').on(table.readAt),
}));

// Likes - Para trackear qué usuario dio like a qué comic
export const likes = pgTable('likes', {
  id: uuid('id').primaryKey().defaultRandom(),
  profileId: uuid('profile_id').references(() => profiles.id, { onDelete: 'cascade' }).notNull(),
  comicId: integer('comic_id').references(() => comics.id, { onDelete: 'cascade' }).notNull(),
  createdAt: timestamp('created_at').defaultNow(),
}, (table) => ({
  profileComicIdx: uniqueIndex('likes_profile_comic_idx').on(table.profileId, table.comicId),
  profileIdx: index('likes_profile_idx').on(table.profileId),
  comicIdx: index('likes_comic_idx').on(table.comicId),
}));

// Chapter Likes - Para trackear qué usuario dio like a qué capítulo
export const chapterLikes = pgTable('chapter_likes', {
  id: uuid('id').primaryKey().defaultRandom(),
  profileId: uuid('profile_id').references(() => profiles.id, { onDelete: 'cascade' }).notNull(),
  chapterId: integer('chapter_id').references(() => chapters.id, { onDelete: 'cascade' }).notNull(),
  createdAt: timestamp('created_at').defaultNow(),
}, (table) => ({
  profileChapterIdx: uniqueIndex('chapter_likes_profile_chapter_idx').on(table.profileId, table.chapterId),
  profileIdx: index('chapter_likes_profile_idx').on(table.profileId),
  chapterIdx: index('chapter_likes_chapter_idx').on(table.chapterId),
}));

// Comments - Sistema de comentarios con respuestas anidadas
export const comments = pgTable('comments', {
  id: uuid('id').primaryKey().defaultRandom(),
  profileId: uuid('profile_id').references(() => profiles.id, { onDelete: 'cascade' }).notNull(),
  comicId: integer('comic_id').references(() => comics.id, { onDelete: 'cascade' }).notNull(),
  chapterId: integer('chapter_id').references(() => chapters.id, { onDelete: 'cascade' }),
  parentId: uuid('parent_id'),
  content: text('content').notNull(),
  isEdited: boolean('is_edited').default(false),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
}, (table) => ({
  profileIdx: index('comments_profile_idx').on(table.profileId),
  comicIdx: index('comments_comic_idx').on(table.comicId),
  chapterIdx: index('comments_chapter_idx').on(table.chapterId),
  parentIdx: index('comments_parent_idx').on(table.parentId),
}));

// Playlists - Listas personalizadas de comics
export const playlists = pgTable('playlists', {
  id: uuid('id').primaryKey().defaultRandom(),
  profileId: uuid('profile_id').references(() => profiles.id, { onDelete: 'cascade' }).notNull(),
  name: varchar('name', { length: 100 }).notNull(),
  description: text('description'),
  isPublic: boolean('is_public').default(false),
  coverImage: varchar('cover_image', { length: 500 }),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
}, (table) => ({
  profileIdx: index('playlists_profile_idx').on(table.profileId),
}));

// Playlist Items - Comics dentro de las playlists
export const playlistItems = pgTable('playlist_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  playlistId: uuid('playlist_id').references(() => playlists.id, { onDelete: 'cascade' }).notNull(),
  comicId: integer('comic_id').references(() => comics.id, { onDelete: 'cascade' }).notNull(),
  order: integer('order').default(0),
  addedAt: timestamp('added_at').defaultNow(),
}, (table) => ({
  playlistComicIdx: uniqueIndex('playlist_items_playlist_comic_idx').on(table.playlistId, table.comicId),
  playlistIdx: index('playlist_items_playlist_idx').on(table.playlistId),
}));

// Comic Views History - Historial de vistas diarias
export const comicViewsHistory = pgTable('comic_views_history', {
  id: uuid('id').primaryKey().defaultRandom(),
  comicId: integer('comic_id').references(() => comics.id, { onDelete: 'cascade' }).notNull(),
  views: integer('views').default(0).notNull(),
  date: date('date').notNull(), // Almacena solo la fecha
}, (table) => ({
  comicDateIdx: uniqueIndex('comic_views_history_comic_date_idx').on(table.comicId, table.date),
  dateIdx: index('comic_views_history_date_idx').on(table.date),
}));

// Relations
export const profilesRelations = relations(profiles, ({ many }) => ({
  bookmarks: many(bookmarks),
  readingHistory: many(readingHistory),
  likes: many(likes),
  chapterLikes: many(chapterLikes),
  comments: many(comments),
  playlists: many(playlists),
}));

export const comicsRelations = relations(comics, ({ many }) => ({
  comicScans: many(comicScans),
  comicGenres: many(comicGenres),
  bookmarks: many(bookmarks),
  readingHistory: many(readingHistory),
  likes: many(likes),
  comments: many(comments),
  playlistItems: many(playlistItems),
  viewsHistory: many(comicViewsHistory),
}));

export const comicScansRelations = relations(comicScans, ({ one, many }) => ({
  comic: one(comics, { fields: [comicScans.comicId], references: [comics.id] }),
  scanGroup: one(scanGroups, { fields: [comicScans.scanGroupId], references: [scanGroups.id] }),
  chapters: many(chapters),
}));

export const chaptersRelations = relations(chapters, ({ one, many }) => ({
  comicScan: one(comicScans, { fields: [chapters.comicScanId], references: [comicScans.id] }),
  readingHistory: many(readingHistory),
  comments: many(comments),
  chapterLikes: many(chapterLikes),
}));

export const bookmarksRelations = relations(bookmarks, ({ one }) => ({
  profile: one(profiles, { fields: [bookmarks.profileId], references: [profiles.id] }),
  comic: one(comics, { fields: [bookmarks.comicId], references: [comics.id] }),
}));

export const readingHistoryRelations = relations(readingHistory, ({ one }) => ({
  profile: one(profiles, { fields: [readingHistory.profileId], references: [profiles.id] }),
  comic: one(comics, { fields: [readingHistory.comicId], references: [comics.id] }),
  chapter: one(chapters, { fields: [readingHistory.chapterId], references: [chapters.id] }),
}));

export const genresRelations = relations(genres, ({ many }) => ({
  comicGenres: many(comicGenres),
}));

export const comicGenresRelations = relations(comicGenres, ({ one }) => ({
  comic: one(comics, { fields: [comicGenres.comicId], references: [comics.id] }),
  genre: one(genres, { fields: [comicGenres.genreId], references: [genres.id] }),
}));

export const scanGroupsRelations = relations(scanGroups, ({ many }) => ({
  comicScans: many(comicScans),
}));

// Likes relations
export const likesRelations = relations(likes, ({ one }) => ({
  profile: one(profiles, { fields: [likes.profileId], references: [profiles.id] }),
  comic: one(comics, { fields: [likes.comicId], references: [comics.id] }),
}));

// Chapter Likes relations
export const chapterLikesRelations = relations(chapterLikes, ({ one }) => ({
  profile: one(profiles, { fields: [chapterLikes.profileId], references: [profiles.id] }),
  chapter: one(chapters, { fields: [chapterLikes.chapterId], references: [chapters.id] }),
}));

// Comments relations
export const commentsRelations = relations(comments, ({ one, many }) => ({
  profile: one(profiles, { fields: [comments.profileId], references: [profiles.id] }),
  comic: one(comics, { fields: [comments.comicId], references: [comics.id] }),
  chapter: one(chapters, { fields: [comments.chapterId], references: [chapters.id] }),
  parent: one(comments, { fields: [comments.parentId], references: [comments.id], relationName: 'parentChild' }),
  replies: many(comments, { relationName: 'parentChild' }),
}));

// Playlists relations
export const playlistsRelations = relations(playlists, ({ one, many }) => ({
  profile: one(profiles, { fields: [playlists.profileId], references: [profiles.id] }),
  items: many(playlistItems),
}));

// Playlist Items relations
export const playlistItemsRelations = relations(playlistItems, ({ one }) => ({
  playlist: one(playlists, { fields: [playlistItems.playlistId], references: [playlists.id] }),
  comic: one(comics, { fields: [playlistItems.comicId], references: [comics.id] }),
}));

// Comic Views History relations
export const comicViewsHistoryRelations = relations(comicViewsHistory, ({ one }) => ({
  comic: one(comics, { fields: [comicViewsHistory.comicId], references: [comics.id] }),
}));
