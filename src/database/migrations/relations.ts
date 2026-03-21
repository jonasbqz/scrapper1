import { relations } from "drizzle-orm/relations";
import { user, account, profiles, bookmarks, comics, comicScans, scanGroups, comicGenres, genres, comments, chapters, likes, playlists, playlistItems, readingHistory, session, chapterLikes } from "./schema";

export const accountRelations = relations(account, ({one}) => ({
	user: one(user, {
		fields: [account.userId],
		references: [user.id]
	}),
}));

export const userRelations = relations(user, ({many}) => ({
	accounts: many(account),
	sessions: many(session),
	profiles: many(profiles),
}));

export const bookmarksRelations = relations(bookmarks, ({one}) => ({
	profile: one(profiles, {
		fields: [bookmarks.profileId],
		references: [profiles.id]
	}),
	comic: one(comics, {
		fields: [bookmarks.comicId],
		references: [comics.id]
	}),
}));

export const profilesRelations = relations(profiles, ({one, many}) => ({
	bookmarks: many(bookmarks),
	comments: many(comments),
	likes: many(likes),
	playlists: many(playlists),
	readingHistories: many(readingHistory),
	chapterLikes: many(chapterLikes),
	user: one(user, {
		fields: [profiles.userId],
		references: [user.id]
	}),
}));

export const comicsRelations = relations(comics, ({many}) => ({
	bookmarks: many(bookmarks),
	comicScans: many(comicScans),
	comicGenres: many(comicGenres),
	comments: many(comments),
	likes: many(likes),
	playlistItems: many(playlistItems),
	readingHistories: many(readingHistory),
}));

export const comicScansRelations = relations(comicScans, ({one, many}) => ({
	comic: one(comics, {
		fields: [comicScans.comicId],
		references: [comics.id]
	}),
	scanGroup: one(scanGroups, {
		fields: [comicScans.scanGroupId],
		references: [scanGroups.id]
	}),
	chapters: many(chapters),
}));

export const scanGroupsRelations = relations(scanGroups, ({many}) => ({
	comicScans: many(comicScans),
}));

export const comicGenresRelations = relations(comicGenres, ({one}) => ({
	comic: one(comics, {
		fields: [comicGenres.comicId],
		references: [comics.id]
	}),
	genre: one(genres, {
		fields: [comicGenres.genreId],
		references: [genres.id]
	}),
}));

export const genresRelations = relations(genres, ({many}) => ({
	comicGenres: many(comicGenres),
}));

export const commentsRelations = relations(comments, ({one}) => ({
	profile: one(profiles, {
		fields: [comments.profileId],
		references: [profiles.id]
	}),
	comic: one(comics, {
		fields: [comments.comicId],
		references: [comics.id]
	}),
	chapter: one(chapters, {
		fields: [comments.chapterId],
		references: [chapters.id]
	}),
}));

export const chaptersRelations = relations(chapters, ({one, many}) => ({
	comments: many(comments),
	readingHistories: many(readingHistory),
	comicScan: one(comicScans, {
		fields: [chapters.comicScanId],
		references: [comicScans.id]
	}),
	chapterLikes: many(chapterLikes),
}));

export const likesRelations = relations(likes, ({one}) => ({
	profile: one(profiles, {
		fields: [likes.profileId],
		references: [profiles.id]
	}),
	comic: one(comics, {
		fields: [likes.comicId],
		references: [comics.id]
	}),
}));

export const playlistsRelations = relations(playlists, ({one, many}) => ({
	profile: one(profiles, {
		fields: [playlists.profileId],
		references: [profiles.id]
	}),
	playlistItems: many(playlistItems),
}));

export const playlistItemsRelations = relations(playlistItems, ({one}) => ({
	playlist: one(playlists, {
		fields: [playlistItems.playlistId],
		references: [playlists.id]
	}),
	comic: one(comics, {
		fields: [playlistItems.comicId],
		references: [comics.id]
	}),
}));

export const readingHistoryRelations = relations(readingHistory, ({one}) => ({
	profile: one(profiles, {
		fields: [readingHistory.profileId],
		references: [profiles.id]
	}),
	comic: one(comics, {
		fields: [readingHistory.comicId],
		references: [comics.id]
	}),
	chapter: one(chapters, {
		fields: [readingHistory.chapterId],
		references: [chapters.id]
	}),
}));

export const sessionRelations = relations(session, ({one}) => ({
	user: one(user, {
		fields: [session.userId],
		references: [user.id]
	}),
}));

export const chapterLikesRelations = relations(chapterLikes, ({one}) => ({
	profile: one(profiles, {
		fields: [chapterLikes.profileId],
		references: [profiles.id]
	}),
	chapter: one(chapters, {
		fields: [chapterLikes.chapterId],
		references: [chapters.id]
	}),
}));