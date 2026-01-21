DO $$ BEGIN
 CREATE TYPE "public"."bookmark_status" AS ENUM('reading', 'completed', 'dropped', 'plan_to_read');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."comic_status" AS ENUM('ongoing', 'completed', 'hiatus', 'cancelled');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."comic_type" AS ENUM('manga', 'manhwa', 'manhua');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."language" AS ENUM('en', 'es', 'pt');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "bookmarks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"comic_id" integer NOT NULL,
	"status" "bookmark_status" DEFAULT 'plan_to_read',
	"is_favorite" boolean DEFAULT false,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chapters" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "chapters_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"comic_scan_id" integer NOT NULL,
	"chapter_number" real NOT NULL,
	"title" varchar(500),
	"slug" varchar(500) NOT NULL,
	"release_date" timestamp,
	"url_pages" jsonb DEFAULT '[]'::jsonb,
	"views" integer DEFAULT 0,
	"copyrighted" boolean DEFAULT false,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "comic_genres" (
	"comic_id" integer NOT NULL,
	"genre_id" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "comic_scans" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "comic_scans_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"comic_id" integer NOT NULL,
	"scan_group_id" integer NOT NULL,
	"external_id" varchar(255),
	"external_url" varchar(1000),
	"language" "language" DEFAULT 'es',
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "comics" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "comics_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"title" varchar(500) NOT NULL,
	"title_alternative" varchar(500),
	"slug" varchar(500) NOT NULL,
	"author" varchar(255),
	"artist" varchar(255),
	"description" text,
	"type" "comic_type" DEFAULT 'manga',
	"cover_image" varchar(1000),
	"status" "comic_status" DEFAULT 'ongoing',
	"views" integer DEFAULT 0,
	"likes" integer DEFAULT 0,
	"followers" integer DEFAULT 0,
	"is_nsfw" boolean DEFAULT false,
	"copyrighted" boolean DEFAULT false,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "comics_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "genres" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "genres_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"name" varchar(100) NOT NULL,
	"slug" varchar(100) NOT NULL,
	"created_at" timestamp DEFAULT now(),
	CONSTRAINT "genres_name_unique" UNIQUE("name"),
	CONSTRAINT "genres_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"visible_name" varchar(100),
	"username" varchar(50) NOT NULL,
	"bio" text,
	"avatar_url" varchar(500),
	"language" "language" DEFAULT 'es',
	"user_id" varchar(255) NOT NULL,
	"date_of_birth" date,
	"is_banned" boolean DEFAULT false,
	"is_adult_content" boolean DEFAULT false,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "profiles_username_unique" UNIQUE("username"),
	CONSTRAINT "profiles_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "reading_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"comic_id" integer NOT NULL,
	"chapter_id" integer NOT NULL,
	"progress_percentage" integer DEFAULT 0,
	"read_at" timestamp DEFAULT now(),
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "scan_groups" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "scan_groups_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"name" varchar(255) NOT NULL,
	"slug" varchar(255) NOT NULL,
	"website" varchar(500),
	"created_at" timestamp DEFAULT now(),
	CONSTRAINT "scan_groups_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bookmarks" ADD CONSTRAINT "bookmarks_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bookmarks" ADD CONSTRAINT "bookmarks_comic_id_comics_id_fk" FOREIGN KEY ("comic_id") REFERENCES "public"."comics"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "chapters" ADD CONSTRAINT "chapters_comic_scan_id_comic_scans_id_fk" FOREIGN KEY ("comic_scan_id") REFERENCES "public"."comic_scans"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "comic_genres" ADD CONSTRAINT "comic_genres_comic_id_comics_id_fk" FOREIGN KEY ("comic_id") REFERENCES "public"."comics"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "comic_genres" ADD CONSTRAINT "comic_genres_genre_id_genres_id_fk" FOREIGN KEY ("genre_id") REFERENCES "public"."genres"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "comic_scans" ADD CONSTRAINT "comic_scans_comic_id_comics_id_fk" FOREIGN KEY ("comic_id") REFERENCES "public"."comics"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "comic_scans" ADD CONSTRAINT "comic_scans_scan_group_id_scan_groups_id_fk" FOREIGN KEY ("scan_group_id") REFERENCES "public"."scan_groups"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reading_history" ADD CONSTRAINT "reading_history_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reading_history" ADD CONSTRAINT "reading_history_comic_id_comics_id_fk" FOREIGN KEY ("comic_id") REFERENCES "public"."comics"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reading_history" ADD CONSTRAINT "reading_history_chapter_id_chapters_id_fk" FOREIGN KEY ("chapter_id") REFERENCES "public"."chapters"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "bookmarks_profile_comic_idx" ON "bookmarks" USING btree ("profile_id","comic_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bookmarks_profile_status_idx" ON "bookmarks" USING btree ("profile_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chapters_comic_scan_idx" ON "chapters" USING btree ("comic_scan_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "chapters_comic_chapter_idx" ON "chapters" USING btree ("comic_scan_id","chapter_number");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "comic_genres_pk" ON "comic_genres" USING btree ("comic_id","genre_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "comic_scans_comic_scan_idx" ON "comic_scans" USING btree ("comic_id","scan_group_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "comics_slug_idx" ON "comics" USING btree ("slug");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "comics_title_idx" ON "comics" USING btree ("title");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "comics_status_idx" ON "comics" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "profiles_username_idx" ON "profiles" USING btree ("username");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "profiles_user_id_idx" ON "profiles" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "reading_history_profile_comic_chapter_idx" ON "reading_history" USING btree ("profile_id","comic_id","chapter_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reading_history_profile_idx" ON "reading_history" USING btree ("profile_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reading_history_read_at_idx" ON "reading_history" USING btree ("read_at");