import { pgTable, text, timestamp, foreignKey, uniqueIndex, index, uuid, integer, boolean, varchar, unique, real, jsonb, date, pgEnum } from "drizzle-orm/pg-core"
  import { sql } from "drizzle-orm"

export const bookmarkStatus = pgEnum("bookmark_status", ['reading', 'completed', 'dropped', 'plan_to_read'])
export const comicStatus = pgEnum("comic_status", ['ongoing', 'completed', 'hiatus', 'cancelled'])
export const comicType = pgEnum("comic_type", ['manga', 'manhwa', 'manhua'])
export const language = pgEnum("language", ['en', 'es', 'pt'])
export const premiumCycle = pgEnum("premium_cycle", ['1m', '3m', '6m', '1w'])
export const userPlan = pgEnum("user_plan", ['basic', 'premium'])



export const verification = pgTable("verification", {
	id: text("id").primaryKey().notNull(),
	identifier: text("identifier").notNull(),
	value: text("value").notNull(),
	expiresAt: timestamp("expires_at", { mode: 'string' }).notNull(),
	createdAt: timestamp("created_at", { mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { mode: 'string' }).defaultNow(),
});

export const account = pgTable("account", {
	id: text("id").primaryKey().notNull(),
	accountId: text("account_id").notNull(),
	providerId: text("provider_id").notNull(),
	userId: text("user_id").notNull(),
	accessToken: text("access_token"),
	refreshToken: text("refresh_token"),
	idToken: text("id_token"),
	accessTokenExpiresAt: timestamp("access_token_expires_at", { mode: 'string' }),
	refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { mode: 'string' }),
	scope: text("scope"),
	password: text("password"),
	createdAt: timestamp("created_at", { mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { mode: 'string' }).defaultNow().notNull(),
},
(table) => {
	return {
		accountUserIdUserIdFk: foreignKey({
			columns: [table.userId],
			foreignColumns: [user.id],
			name: "account_user_id_user_id_fk"
		}).onDelete("cascade"),
	}
});

export const bookmarks = pgTable("bookmarks", {
	id: uuid("id").defaultRandom().primaryKey().notNull(),
	profileId: uuid("profile_id").notNull(),
	comicId: integer("comic_id").notNull(),
	status: bookmarkStatus("status").default('plan_to_read'),
	isFavorite: boolean("is_favorite").default(false),
	createdAt: timestamp("created_at", { mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { mode: 'string' }).defaultNow(),
},
(table) => {
	return {
		profileComicIdx: uniqueIndex("bookmarks_profile_comic_idx").using("btree", table.profileId.asc().nullsLast(), table.comicId.asc().nullsLast()),
		profileStatusIdx: index("bookmarks_profile_status_idx").using("btree", table.profileId.asc().nullsLast(), table.status.asc().nullsLast()),
		bookmarksProfileIdProfilesIdFk: foreignKey({
			columns: [table.profileId],
			foreignColumns: [profiles.id],
			name: "bookmarks_profile_id_profiles_id_fk"
		}).onDelete("cascade"),
		bookmarksComicIdComicsIdFk: foreignKey({
			columns: [table.comicId],
			foreignColumns: [comics.id],
			name: "bookmarks_comic_id_comics_id_fk"
		}).onDelete("cascade"),
	}
});

export const comicScans = pgTable("comic_scans", {
	id: integer("id").primaryKey().generatedAlwaysAsIdentity({ name: "comic_scans_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 2147483647, cache: 1 }),
	comicId: integer("comic_id").notNull(),
	scanGroupId: integer("scan_group_id").notNull(),
	externalId: varchar("external_id", { length: 255 }),
	externalUrl: varchar("external_url", { length: 1000 }),
	language: language("language").default('es'),
	createdAt: timestamp("created_at", { mode: 'string' }).defaultNow(),
},
(table) => {
	return {
		comicScanIdx: uniqueIndex("comic_scans_comic_scan_idx").using("btree", table.comicId.asc().nullsLast(), table.scanGroupId.asc().nullsLast()),
		comicScansComicIdComicsIdFk: foreignKey({
			columns: [table.comicId],
			foreignColumns: [comics.id],
			name: "comic_scans_comic_id_comics_id_fk"
		}).onDelete("cascade"),
		comicScansScanGroupIdScanGroupsIdFk: foreignKey({
			columns: [table.scanGroupId],
			foreignColumns: [scanGroups.id],
			name: "comic_scans_scan_group_id_scan_groups_id_fk"
		}).onDelete("cascade"),
	}
});

export const comicGenres = pgTable("comic_genres", {
	comicId: integer("comic_id").notNull(),
	genreId: integer("genre_id").notNull(),
},
(table) => {
	return {
		pk: uniqueIndex("comic_genres_pk").using("btree", table.comicId.asc().nullsLast(), table.genreId.asc().nullsLast()),
		comicGenresComicIdComicsIdFk: foreignKey({
			columns: [table.comicId],
			foreignColumns: [comics.id],
			name: "comic_genres_comic_id_comics_id_fk"
		}).onDelete("cascade"),
		comicGenresGenreIdGenresIdFk: foreignKey({
			columns: [table.genreId],
			foreignColumns: [genres.id],
			name: "comic_genres_genre_id_genres_id_fk"
		}).onDelete("cascade"),
	}
});

export const genres = pgTable("genres", {
	id: integer("id").primaryKey().generatedAlwaysAsIdentity({ name: "genres_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 2147483647, cache: 1 }),
	name: varchar("name", { length: 100 }).notNull(),
	slug: varchar("slug", { length: 100 }).notNull(),
	createdAt: timestamp("created_at", { mode: 'string' }).defaultNow(),
},
(table) => {
	return {
		genresNameUnique: unique("genres_name_unique").on(table.name),
		genresSlugUnique: unique("genres_slug_unique").on(table.slug),
	}
});

export const scanGroups = pgTable("scan_groups", {
	id: integer("id").primaryKey().generatedAlwaysAsIdentity({ name: "scan_groups_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 2147483647, cache: 1 }),
	name: varchar("name", { length: 255 }).notNull(),
	slug: varchar("slug", { length: 255 }).notNull(),
	website: varchar("website", { length: 500 }),
	createdAt: timestamp("created_at", { mode: 'string' }).defaultNow(),
},
(table) => {
	return {
		scanGroupsSlugUnique: unique("scan_groups_slug_unique").on(table.slug),
	}
});

export const comments = pgTable("comments", {
	id: uuid("id").defaultRandom().primaryKey().notNull(),
	profileId: uuid("profile_id").notNull(),
	comicId: integer("comic_id").notNull(),
	chapterId: integer("chapter_id"),
	parentId: uuid("parent_id"),
	content: text("content").notNull(),
	isEdited: boolean("is_edited").default(false),
	createdAt: timestamp("created_at", { mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { mode: 'string' }).defaultNow(),
},
(table) => {
	return {
		chapterIdx: index("comments_chapter_idx").using("btree", table.chapterId.asc().nullsLast()),
		comicIdx: index("comments_comic_idx").using("btree", table.comicId.asc().nullsLast()),
		parentIdx: index("comments_parent_idx").using("btree", table.parentId.asc().nullsLast()),
		profileIdx: index("comments_profile_idx").using("btree", table.profileId.asc().nullsLast()),
		commentsProfileIdProfilesIdFk: foreignKey({
			columns: [table.profileId],
			foreignColumns: [profiles.id],
			name: "comments_profile_id_profiles_id_fk"
		}).onDelete("cascade"),
		commentsComicIdComicsIdFk: foreignKey({
			columns: [table.comicId],
			foreignColumns: [comics.id],
			name: "comments_comic_id_comics_id_fk"
		}).onDelete("cascade"),
		commentsChapterIdChaptersIdFk: foreignKey({
			columns: [table.chapterId],
			foreignColumns: [chapters.id],
			name: "comments_chapter_id_chapters_id_fk"
		}).onDelete("cascade"),
	}
});

export const likes = pgTable("likes", {
	id: uuid("id").defaultRandom().primaryKey().notNull(),
	profileId: uuid("profile_id").notNull(),
	comicId: integer("comic_id").notNull(),
	createdAt: timestamp("created_at", { mode: 'string' }).defaultNow(),
},
(table) => {
	return {
		comicIdx: index("likes_comic_idx").using("btree", table.comicId.asc().nullsLast()),
		profileComicIdx: uniqueIndex("likes_profile_comic_idx").using("btree", table.profileId.asc().nullsLast(), table.comicId.asc().nullsLast()),
		profileIdx: index("likes_profile_idx").using("btree", table.profileId.asc().nullsLast()),
		likesProfileIdProfilesIdFk: foreignKey({
			columns: [table.profileId],
			foreignColumns: [profiles.id],
			name: "likes_profile_id_profiles_id_fk"
		}).onDelete("cascade"),
		likesComicIdComicsIdFk: foreignKey({
			columns: [table.comicId],
			foreignColumns: [comics.id],
			name: "likes_comic_id_comics_id_fk"
		}).onDelete("cascade"),
	}
});

export const playlists = pgTable("playlists", {
	id: uuid("id").defaultRandom().primaryKey().notNull(),
	profileId: uuid("profile_id").notNull(),
	name: varchar("name", { length: 100 }).notNull(),
	description: text("description"),
	isPublic: boolean("is_public").default(false),
	coverImage: varchar("cover_image", { length: 500 }),
	createdAt: timestamp("created_at", { mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { mode: 'string' }).defaultNow(),
},
(table) => {
	return {
		profileIdx: index("playlists_profile_idx").using("btree", table.profileId.asc().nullsLast()),
		playlistsProfileIdProfilesIdFk: foreignKey({
			columns: [table.profileId],
			foreignColumns: [profiles.id],
			name: "playlists_profile_id_profiles_id_fk"
		}).onDelete("cascade"),
	}
});

export const playlistItems = pgTable("playlist_items", {
	id: uuid("id").defaultRandom().primaryKey().notNull(),
	playlistId: uuid("playlist_id").notNull(),
	comicId: integer("comic_id").notNull(),
	order: integer("order").default(0),
	addedAt: timestamp("added_at", { mode: 'string' }).defaultNow(),
},
(table) => {
	return {
		playlistComicIdx: uniqueIndex("playlist_items_playlist_comic_idx").using("btree", table.playlistId.asc().nullsLast(), table.comicId.asc().nullsLast()),
		playlistIdx: index("playlist_items_playlist_idx").using("btree", table.playlistId.asc().nullsLast()),
		playlistItemsPlaylistIdPlaylistsIdFk: foreignKey({
			columns: [table.playlistId],
			foreignColumns: [playlists.id],
			name: "playlist_items_playlist_id_playlists_id_fk"
		}).onDelete("cascade"),
		playlistItemsComicIdComicsIdFk: foreignKey({
			columns: [table.comicId],
			foreignColumns: [comics.id],
			name: "playlist_items_comic_id_comics_id_fk"
		}).onDelete("cascade"),
	}
});

export const readingHistory = pgTable("reading_history", {
	id: uuid("id").defaultRandom().primaryKey().notNull(),
	profileId: uuid("profile_id").notNull(),
	comicId: integer("comic_id").notNull(),
	chapterId: integer("chapter_id").notNull(),
	progressPercentage: integer("progress_percentage").default(0),
	readAt: timestamp("read_at", { mode: 'string' }).defaultNow(),
	createdAt: timestamp("created_at", { mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { mode: 'string' }).defaultNow(),
},
(table) => {
	return {
		profileComicChapterIdx: uniqueIndex("reading_history_profile_comic_chapter_idx").using("btree", table.profileId.asc().nullsLast(), table.comicId.asc().nullsLast(), table.chapterId.asc().nullsLast()),
		profileIdx: index("reading_history_profile_idx").using("btree", table.profileId.asc().nullsLast()),
		readAtIdx: index("reading_history_read_at_idx").using("btree", table.readAt.asc().nullsLast()),
		readingHistoryProfileIdProfilesIdFk: foreignKey({
			columns: [table.profileId],
			foreignColumns: [profiles.id],
			name: "reading_history_profile_id_profiles_id_fk"
		}).onDelete("cascade"),
		readingHistoryComicIdComicsIdFk: foreignKey({
			columns: [table.comicId],
			foreignColumns: [comics.id],
			name: "reading_history_comic_id_comics_id_fk"
		}).onDelete("cascade"),
		readingHistoryChapterIdChaptersIdFk: foreignKey({
			columns: [table.chapterId],
			foreignColumns: [chapters.id],
			name: "reading_history_chapter_id_chapters_id_fk"
		}).onDelete("cascade"),
	}
});

export const session = pgTable("session", {
	id: text("id").primaryKey().notNull(),
	expiresAt: timestamp("expires_at", { mode: 'string' }).notNull(),
	token: text("token").notNull(),
	createdAt: timestamp("created_at", { mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { mode: 'string' }).defaultNow().notNull(),
	ipAddress: text("ip_address"),
	userAgent: text("user_agent"),
	userId: text("user_id").notNull(),
},
(table) => {
	return {
		sessionUserIdUserIdFk: foreignKey({
			columns: [table.userId],
			foreignColumns: [user.id],
			name: "session_user_id_user_id_fk"
		}).onDelete("cascade"),
		sessionTokenUnique: unique("session_token_unique").on(table.token),
	}
});

export const chapters = pgTable("chapters", {
	id: integer("id").primaryKey().generatedAlwaysAsIdentity({ name: "chapters_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 2147483647, cache: 1 }),
	comicScanId: integer("comic_scan_id").notNull(),
	chapterNumber: real("chapter_number").notNull(),
	title: varchar("title", { length: 500 }),
	slug: varchar("slug", { length: 500 }).notNull(),
	releaseDate: timestamp("release_date", { mode: 'string' }),
	urlPages: jsonb("url_pages").default([]),
	views: integer("views").default(0),
	copyrighted: boolean("copyrighted").default(false),
	createdAt: timestamp("created_at", { mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { mode: 'string' }).defaultNow(),
	likes: integer("likes").default(0),
},
(table) => {
	return {
		comicChapterIdx: uniqueIndex("chapters_comic_chapter_idx").using("btree", table.comicScanId.asc().nullsLast(), table.chapterNumber.asc().nullsLast()),
		comicScanIdx: index("chapters_comic_scan_idx").using("btree", table.comicScanId.asc().nullsLast()),
		chaptersComicScanIdComicScansIdFk: foreignKey({
			columns: [table.comicScanId],
			foreignColumns: [comicScans.id],
			name: "chapters_comic_scan_id_comic_scans_id_fk"
		}).onDelete("cascade"),
	}
});

export const comics = pgTable("comics", {
	id: integer("id").primaryKey().generatedAlwaysAsIdentity({ name: "comics_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 2147483647, cache: 1 }),
	title: varchar("title", { length: 500 }).notNull(),
	titleAlternative: varchar("title_alternative", { length: 500 }),
	slug: varchar("slug", { length: 500 }).notNull(),
	author: varchar("author", { length: 255 }),
	artist: varchar("artist", { length: 255 }),
	description: text("description"),
	type: comicType("type").default('manga'),
	coverImage: varchar("cover_image", { length: 1000 }),
	status: comicStatus("status").default('ongoing'),
	views: integer("views").default(0),
	likes: integer("likes").default(0),
	followers: integer("followers").default(0),
	isNsfw: boolean("is_nsfw").default(false),
	copyrighted: boolean("copyrighted").default(false),
	createdAt: timestamp("created_at", { mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { mode: 'string' }).defaultNow(),
	isHentai: boolean("is_hentai").default(false),
	// TODO: failed to parse database type 'tsvector'
	searchVector: unknown("search_vector"),
},
(table) => {
	return {
		isHentaiIdx: index("comics_is_hentai_idx").using("btree", table.isHentai.asc().nullsLast()),
		searchVectorIdx: index("comics_search_vector_idx").using("gin", table.searchVector.asc().nullsLast()),
		slugIdx: index("comics_slug_idx").using("btree", table.slug.asc().nullsLast()),
		statusIdx: index("comics_status_idx").using("btree", table.status.asc().nullsLast()),
		titleAltTrgmIdx: index("comics_title_alt_trgm_idx").using("gin", table.titleAlternative.asc().nullsLast()),
		titleIdx: index("comics_title_idx").using("btree", table.title.asc().nullsLast()),
		titleTrgmIdx: index("comics_title_trgm_idx").using("gin", table.title.asc().nullsLast()),
		comicsSlugUnique: unique("comics_slug_unique").on(table.slug),
	}
});

export const user = pgTable("user", {
	id: text("id").primaryKey().notNull(),
	name: text("name").notNull(),
	email: text("email").notNull(),
	emailVerified: boolean("email_verified").default(false).notNull(),
	image: text("image"),
	createdAt: timestamp("created_at", { mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { mode: 'string' }).defaultNow().notNull(),
	plan: text("plan").default('basic'),
	premiumExpireAt: timestamp("premium_expire_at", { mode: 'string' }),
},
(table) => {
	return {
		userEmailUnique: unique("user_email_unique").on(table.email),
	}
});

export const chapterLikes = pgTable("chapter_likes", {
	id: uuid("id").defaultRandom().primaryKey().notNull(),
	profileId: uuid("profile_id").notNull(),
	chapterId: integer("chapter_id").notNull(),
	createdAt: timestamp("created_at", { mode: 'string' }).defaultNow(),
},
(table) => {
	return {
		chapterIdx: index("chapter_likes_chapter_idx").using("btree", table.chapterId.asc().nullsLast()),
		profileChapterIdx: uniqueIndex("chapter_likes_profile_chapter_idx").using("btree", table.profileId.asc().nullsLast(), table.chapterId.asc().nullsLast()),
		profileIdx: index("chapter_likes_profile_idx").using("btree", table.profileId.asc().nullsLast()),
		chapterLikesProfileIdProfilesIdFk: foreignKey({
			columns: [table.profileId],
			foreignColumns: [profiles.id],
			name: "chapter_likes_profile_id_profiles_id_fk"
		}).onDelete("cascade"),
		chapterLikesChapterIdChaptersIdFk: foreignKey({
			columns: [table.chapterId],
			foreignColumns: [chapters.id],
			name: "chapter_likes_chapter_id_chapters_id_fk"
		}).onDelete("cascade"),
	}
});

export const profiles = pgTable("profiles", {
	id: uuid("id").defaultRandom().primaryKey().notNull(),
	visibleName: varchar("visible_name", { length: 100 }),
	username: varchar("username", { length: 50 }).notNull(),
	bio: text("bio"),
	avatarUrl: varchar("avatar_url", { length: 500 }),
	language: language("language").default('es'),
	userId: text("user_id").notNull(),
	dateOfBirth: date("date_of_birth"),
	isBanned: boolean("is_banned").default(false),
	isAdultContent: boolean("is_adult_content").default(false),
	createdAt: timestamp("created_at", { mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { mode: 'string' }).defaultNow(),
	plan: userPlan("plan").default('basic'),
	premiumExpireAt: timestamp("premium_expire_at", { mode: 'string' }),
	premiumCycle: premiumCycle("premium_cycle"),
	premiumStartedAt: timestamp("premium_started_at", { mode: 'string' }),
},
(table) => {
	return {
		userIdIdx: uniqueIndex("profiles_user_id_idx").using("btree", table.userId.asc().nullsLast()),
		usernameIdx: uniqueIndex("profiles_username_idx").using("btree", table.username.asc().nullsLast()),
		profilesUserIdUserIdFk: foreignKey({
			columns: [table.userId],
			foreignColumns: [user.id],
			name: "profiles_user_id_user_id_fk"
		}).onDelete("cascade"),
		profilesUsernameUnique: unique("profiles_username_unique").on(table.username),
		profilesUserIdUnique: unique("profiles_user_id_unique").on(table.userId),
	}
});